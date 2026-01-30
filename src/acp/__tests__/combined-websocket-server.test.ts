/**
 * Tests for Combined WebSocket Server (ACP + MAP)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { WebSocket } from "ws";
import {
  createCombinedWebSocketServer,
  type ACPServices,
  type CombinedWebSocketServer,
} from "../websocket-server.js";
import { createMAPAdapter, type MAPAdapterServices } from "../../map/adapter/map-adapter.js";
import type { MAPAdapter } from "../../map/adapter/interface.js";
import type { AgentManager } from "../../agent/agent-manager.js";
import type { EventStore } from "../../store/event-store.js";
import type { TaskManager } from "../../task/task-manager.js";

// Use a random port for each test to avoid conflicts
function getRandomPort(): number {
  return 10000 + Math.floor(Math.random() * 50000);
}

describe("createCombinedWebSocketServer", () => {
  let server: CombinedWebSocketServer;
  let acpServices: ACPServices;
  let mapAdapter: MAPAdapter;
  let port: number;

  beforeEach(async () => {
    port = getRandomPort();

    // Create mock ACP services
    acpServices = {
      agentManager: {
        createAgent: vi.fn(),
        getAgent: vi.fn(),
        listAgents: vi.fn().mockReturnValue([]),
      } as unknown as AgentManager,
      eventStore: {
        append: vi.fn(),
        query: vi.fn().mockResolvedValue([]),
      } as unknown as EventStore,
      taskManager: {
        createTask: vi.fn(),
        getTask: vi.fn(),
        listTasks: vi.fn().mockReturnValue([]),
      } as unknown as TaskManager,
    };

    // Create MAP services and adapter
    const mapServices: MAPAdapterServices = {
      getAgent: vi.fn(),
      listAgents: vi.fn().mockReturnValue([]),
      sendMessage: vi.fn().mockResolvedValue({ delivered: [] }),
      getAncestors: vi.fn().mockReturnValue([]),
      getDescendants: vi.fn().mockReturnValue([]),
    };

    mapAdapter = createMAPAdapter(
      {
        name: "test-adapter",
        version: "1.0.0",
      },
      mapServices
    );

    server = createCombinedWebSocketServer(acpServices, mapAdapter, { port });
  });

  afterEach(async () => {
    if (server) {
      await server.stop().catch(() => {});
    }
  });

  describe("lifecycle", () => {
    it("starts and stops", async () => {
      await server.start();

      expect(server.getACPUrl()).toBe(`ws://localhost:${port}/acp`);
      expect(server.getMAPUrl()).toBe(`ws://localhost:${port}/map`);

      await server.stop();
    });

    it("auto-starts MAPAdapter if not running", async () => {
      expect(mapAdapter.isRunning()).toBe(false);

      await server.start();

      expect(mapAdapter.isRunning()).toBe(true);

      await server.stop();
    });

    it("stops MAPAdapter on shutdown", async () => {
      await server.start();
      expect(mapAdapter.isRunning()).toBe(true);

      await server.stop();

      expect(mapAdapter.isRunning()).toBe(false);
    });
  });

  describe("connection counts", () => {
    it("tracks no connections initially", async () => {
      await server.start();

      expect(server.getACPConnectionCount()).toBe(0);
      expect(server.getMAPConnectionCount()).toBe(0);
      expect(server.getConnectionCount()).toBe(0);

      await server.stop();
    });
  });

  describe("URLs", () => {
    it("uses default paths", () => {
      expect(server.getACPUrl()).toBe(`ws://localhost:${port}/acp`);
      expect(server.getMAPUrl()).toBe(`ws://localhost:${port}/map`);
    });

    it("uses custom paths", () => {
      const customServer = createCombinedWebSocketServer(acpServices, mapAdapter, {
        port,
        acpPath: "/custom-acp",
        mapPath: "/custom-map",
      });

      expect(customServer.getACPUrl()).toBe(`ws://localhost:${port}/custom-acp`);
      expect(customServer.getMAPUrl()).toBe(`ws://localhost:${port}/custom-map`);
    });

    it("uses custom host", () => {
      const customServer = createCombinedWebSocketServer(acpServices, mapAdapter, {
        port,
        host: "0.0.0.0",
      });

      expect(customServer.getACPUrl()).toBe(`ws://0.0.0.0:${port}/acp`);
      expect(customServer.getMAPUrl()).toBe(`ws://0.0.0.0:${port}/map`);
    });
  });

  describe("health endpoint", () => {
    it("returns health status", async () => {
      await server.start();

      const response = await fetch(`http://localhost:${port}/health`);
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.status).toBe("ok");
      expect(data.acpConnections).toBe(0);
      expect(data.mapConnections).toBe(0);
      expect(typeof data.timestamp).toBe("number");

      await server.stop();
    });
  });

  describe("non-WebSocket requests", () => {
    it("returns 426 for non-WebSocket requests", async () => {
      await server.start();

      const response = await fetch(`http://localhost:${port}/acp`);
      expect(response.status).toBe(426);

      const text = await response.text();
      expect(text).toContain("Upgrade Required");

      await server.stop();
    });
  });

  describe("path routing", () => {
    it("accepts MAP connections on /map", async () => {
      await server.start();

      const ws = new WebSocket(`ws://localhost:${port}/map`);

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Connection timeout")), 2000);
        ws.on("open", () => {
          clearTimeout(timeout);
          resolve();
        });
        ws.on("error", (err) => {
          clearTimeout(timeout);
          reject(err);
        });
      });

      // Wait a bit for connection to be tracked
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(server.getMAPConnectionCount()).toBe(1);

      ws.close();
      await server.stop();
    }, 5000);

    it("accepts ACP connections on /acp", async () => {
      await server.start();

      const ws = new WebSocket(`ws://localhost:${port}/acp`);

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Connection timeout")), 2000);
        ws.on("open", () => {
          clearTimeout(timeout);
          resolve();
        });
        ws.on("error", (err) => {
          clearTimeout(timeout);
          reject(err);
        });
      });

      // Wait a bit for connection to be tracked
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(server.getACPConnectionCount()).toBe(1);

      ws.close();
      await server.stop();
    }, 5000);

    it("rejects connections on unknown paths", async () => {
      await server.start();

      const ws = new WebSocket(`ws://localhost:${port}/unknown`);

      await new Promise<void>((resolve) => {
        ws.on("error", () => resolve());
        ws.on("close", () => resolve());
      });

      expect(server.getConnectionCount()).toBe(0);

      await server.stop();
    }, 5000);
  });

  describe("server properties", () => {
    it("exposes httpServer", () => {
      expect(server.httpServer).toBeDefined();
    });

    it("exposes wss", () => {
      expect(server.wss).toBeDefined();
    });

    it("exposes mapHandler", () => {
      expect(server.mapHandler).toBeDefined();
      expect(typeof server.mapHandler.getConnectionCount).toBe("function");
    });
  });
});
