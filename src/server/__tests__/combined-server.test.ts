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

const TEST_TOKEN = "test-server-token-for-unit-tests";

/** Build a WebSocket URL with auth token query param */
function wsUrl(port: number, path: string): string {
  return `ws://localhost:${port}${path}?token=${TEST_TOKEN}`;
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
        onLifecycleEvent: vi.fn(),
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
      server = createCombinedServer(services, { port, serverToken: TEST_TOKEN });
      await server.start();

      expect(server.mapAdapter).toBeDefined();
      expect(server.mapAdapter?.isRunning()).toBe(true);
    });

    it("accepts MAP connections on /map", async () => {
      server = createCombinedServer(services, { port, serverToken: TEST_TOKEN });
      await server.start();

      const ws = new WebSocket(wsUrl(port, "/map"));

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
      server = createCombinedServer(services, { port, mapPath: "/custom-map", serverToken: TEST_TOKEN });
      await server.start();

      const ws = new WebSocket(wsUrl(port, "/custom-map"));

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
      server = createCombinedServer(services, { port, disableMap: true, serverToken: TEST_TOKEN });
      await server.start();

      expect(server.mapAdapter).toBeUndefined();
      expect(server.getMAPConnectionCount()).toBe(0);

      // Connection to /map should fail (either 401 without token or 404)
      const ws = new WebSocket(wsUrl(port, "/map"));

      await new Promise<void>((resolve) => {
        ws.on("error", () => resolve());
        ws.on("close", () => resolve());
      });

      expect(server.getMAPConnectionCount()).toBe(0);
    }, 5000);

    it("stops MAP adapter on shutdown", async () => {
      server = createCombinedServer(services, { port, serverToken: TEST_TOKEN });
      await server.start();

      expect(server.mapAdapter?.isRunning()).toBe(true);

      await server.stop();

      expect(server.mapAdapter?.isRunning()).toBe(false);
    });
  });

  describe("health endpoint", () => {
    it("includes map_connections in health response", async () => {
      server = createCombinedServer(services, { port, serverToken: TEST_TOKEN });
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
      server = createCombinedServer(services, { port, disableMap: true, serverToken: TEST_TOKEN });
      await server.start();

      const response = await fetch(`http://localhost:${port}/health`);
      const data = await response.json();

      expect(data.map_connections).toBe(0);
    });
  });

  describe("authentication", () => {
    it("rejects WebSocket connections without token", async () => {
      server = createCombinedServer(services, { port, serverToken: TEST_TOKEN });
      await server.start();

      const ws = new WebSocket(`ws://localhost:${port}/map`);

      await new Promise<void>((resolve) => {
        ws.on("error", () => resolve());
        ws.on("close", () => resolve());
      });

      expect(server.getMAPConnectionCount()).toBe(0);
    }, 5000);

    it("rejects WebSocket connections with wrong token", async () => {
      server = createCombinedServer(services, { port, serverToken: TEST_TOKEN });
      await server.start();

      const ws = new WebSocket(`ws://localhost:${port}/map?token=wrong-token`);

      await new Promise<void>((resolve) => {
        ws.on("error", () => resolve());
        ws.on("close", () => resolve());
      });

      expect(server.getMAPConnectionCount()).toBe(0);
    }, 5000);

    it("exposes serverToken on the server object", () => {
      server = createCombinedServer(services, { port, serverToken: TEST_TOKEN });
      expect(server.serverToken).toBe(TEST_TOKEN);
    });

    it("has no serverToken when not provided (auth disabled by default)", () => {
      server = createCombinedServer(services, { port });
      expect(server.serverToken).toBeUndefined();
    });

    it("allows connections without token when noAuth is true", async () => {
      server = createCombinedServer(services, { port, noAuth: true });
      await server.start();

      expect(server.serverToken).toBeUndefined();

      // Should connect without any token
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

      expect(server.getMAPConnectionCount()).toBe(1);
      ws.close();
    }, 5000);
  });

  describe("connection counts", () => {
    it("tracks MAP connections separately", async () => {
      server = createCombinedServer(services, { port, serverToken: TEST_TOKEN });
      await server.start();

      expect(server.getACPConnectionCount()).toBe(0);
      expect(server.getMAPConnectionCount()).toBe(0);

      // Open MAP connection
      const mapWs = new WebSocket(wsUrl(port, "/map"));
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
      server = createCombinedServer(services, { port, serverToken: TEST_TOKEN });
      await server.start();

      const ws = new WebSocket(wsUrl(port, "/acp"));

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
      server = createCombinedServer(services, { port, serverToken: TEST_TOKEN });
      await server.start();

      const ws = new WebSocket(wsUrl(port, "/api/ws"));

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
      server = createCombinedServer(services, { port, serverToken: TEST_TOKEN });
      await server.start();

      const ws = new WebSocket(wsUrl(port, "/unknown"));

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
      server = createCombinedServer(services, { port, serverToken: TEST_TOKEN });
      expect(server.mapAdapter).toBeDefined();
    });

    it("mapAdapter is undefined when disabled", () => {
      server = createCombinedServer(services, { port, disableMap: true, serverToken: TEST_TOKEN });
      expect(server.mapAdapter).toBeUndefined();
    });
  });
});
