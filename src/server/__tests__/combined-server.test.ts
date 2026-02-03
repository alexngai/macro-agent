/**
 * Tests for Combined Server with MAP integration
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { WebSocket } from "ws";
import {
  createCombinedServer,
  type CombinedServerServices,
  type CombinedServer,
} from "../combined-server.js";
import type { AgentManager } from "../../agent/agent-manager.js";
import type { EventStore } from "../../store/event-store.js";
import type { TaskManager } from "../../task/task-manager.js";
import type { MessageRouter } from "../../router/message-router.js";

// Use a random port for each test to avoid conflicts
function getRandomPort(): number {
  return 10000 + Math.floor(Math.random() * 50000);
}

describe("createCombinedServer with MAP", () => {
  let server: CombinedServer;
  let services: CombinedServerServices;
  let port: number;

  beforeEach(async () => {
    port = getRandomPort();

    // Create mock services
    services = {
      agentManager: {
        get: vi.fn().mockReturnValue(null),
        list: vi.fn().mockReturnValue([]),
        getChildren: vi.fn().mockReturnValue([]),
      } as unknown as AgentManager,
      eventStore: {
        append: vi.fn(),
        query: vi.fn().mockResolvedValue([]),
        onAgentChange: vi.fn(),
        onTaskChange: vi.fn(),
        onMessageChange: vi.fn(),
        getAgent: vi.fn().mockReturnValue(null),
        listAgents: vi.fn().mockReturnValue([]),
        getTask: vi.fn().mockReturnValue(null),
        listTasks: vi.fn().mockReturnValue([]),
      } as unknown as EventStore,
      taskManager: {
        createTask: vi.fn(),
        getTask: vi.fn(),
        listTasks: vi.fn().mockReturnValue([]),
      } as unknown as TaskManager,
      messageRouter: {
        sendToAddress: vi.fn().mockResolvedValue({ delivered: [] }),
      } as unknown as MessageRouter,
    };
  });

  afterEach(async () => {
    if (server) {
      await server.stop().catch(() => {});
    }
  });

  describe("MAP protocol integration", () => {
    it("starts with MAP adapter enabled by default", async () => {
      server = createCombinedServer(services, { port });
      await server.start();

      expect(server.mapAdapter).toBeDefined();
      expect(server.mapAdapter?.isRunning()).toBe(true);
    });

    it("accepts MAP connections on /map", async () => {
      server = createCombinedServer(services, { port });
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
    }, 5000);

    it("uses custom MAP path", async () => {
      server = createCombinedServer(services, { port, mapPath: "/custom-map" });
      await server.start();

      const ws = new WebSocket(`ws://localhost:${port}/custom-map`);

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
    }, 5000);

    it("can disable MAP protocol", async () => {
      server = createCombinedServer(services, { port, disableMap: true });
      await server.start();

      expect(server.mapAdapter).toBeUndefined();
      expect(server.getMAPConnectionCount()).toBe(0);

      // Connection to /map should fail
      const ws = new WebSocket(`ws://localhost:${port}/map`);

      await new Promise<void>((resolve) => {
        ws.on("error", () => resolve());
        ws.on("close", () => resolve());
      });

      expect(server.getMAPConnectionCount()).toBe(0);
    }, 5000);

    it("stops MAP adapter on shutdown", async () => {
      server = createCombinedServer(services, { port });
      await server.start();

      expect(server.mapAdapter?.isRunning()).toBe(true);

      await server.stop();

      expect(server.mapAdapter?.isRunning()).toBe(false);
    });
  });

  describe("health endpoint", () => {
    it("includes map_connections in health response", async () => {
      server = createCombinedServer(services, { port });
      await server.start();

      const response = await fetch(`http://localhost:${port}/health`);
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.status).toBe("ok");
      expect(data.acp_connections).toBe(0);
      expect(data.map_connections).toBe(0);
      expect(typeof data.timestamp).toBe("number");
    });

    it("shows 0 map_connections when MAP is disabled", async () => {
      server = createCombinedServer(services, { port, disableMap: true });
      await server.start();

      const response = await fetch(`http://localhost:${port}/health`);
      const data = await response.json();

      expect(data.map_connections).toBe(0);
    });
  });

  describe("connection counts", () => {
    it("tracks MAP connections separately", async () => {
      server = createCombinedServer(services, { port });
      await server.start();

      expect(server.getACPConnectionCount()).toBe(0);
      expect(server.getMAPConnectionCount()).toBe(0);

      // Open MAP connection
      const mapWs = new WebSocket(`ws://localhost:${port}/map`);
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Timeout")), 2000);
        mapWs.on("open", () => {
          clearTimeout(timeout);
          resolve();
        });
        mapWs.on("error", (err) => {
          clearTimeout(timeout);
          reject(err);
        });
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(server.getACPConnectionCount()).toBe(0);
      expect(server.getMAPConnectionCount()).toBe(1);

      mapWs.close();
    }, 5000);
  });

  describe("existing functionality preserved", () => {
    it("accepts ACP connections on /acp", async () => {
      server = createCombinedServer(services, { port });
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

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(server.getACPConnectionCount()).toBe(1);

      ws.close();
    }, 5000);

    it("accepts API WebSocket connections on /api/ws", async () => {
      server = createCombinedServer(services, { port });
      await server.start();

      const ws = new WebSocket(`ws://localhost:${port}/api/ws`);

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

      ws.close();
    }, 5000);

    it("rejects connections on unknown paths", async () => {
      server = createCombinedServer(services, { port });
      await server.start();

      const ws = new WebSocket(`ws://localhost:${port}/unknown`);

      await new Promise<void>((resolve) => {
        ws.on("error", () => resolve());
        ws.on("close", () => resolve());
      });

      expect(server.getACPConnectionCount()).toBe(0);
      expect(server.getMAPConnectionCount()).toBe(0);
    }, 5000);
  });

  describe("server properties", () => {
    it("exposes mapAdapter when enabled", () => {
      server = createCombinedServer(services, { port });
      expect(server.mapAdapter).toBeDefined();
    });

    it("mapAdapter is undefined when disabled", () => {
      server = createCombinedServer(services, { port, disableMap: true });
      expect(server.mapAdapter).toBeUndefined();
    });
  });
});
