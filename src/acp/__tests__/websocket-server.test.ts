/**
 * Tests for WebSocket ACP Server
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { WebSocket } from "ws";
import {
  createWebSocketACPServer,
  type WebSocketACPServer,
  type ACPServices,
} from "../websocket-server.js";

// ─────────────────────────────────────────────────────────────────
// Mock Services
// ─────────────────────────────────────────────────────────────────

function createMockServices(): ACPServices {
  return {
    agentManager: {
      getOrCreateHeadManager: vi.fn().mockResolvedValue({
        id: "agent_test",
        session_id: "session_test",
        state: "running",
        lineage: [],
        created_at: Date.now(),
      }),
      get: vi.fn(),
      list: vi.fn().mockReturnValue([]),
      listHeadManagers: vi.fn().mockReturnValue([]),
      getChildren: vi.fn().mockReturnValue([]),
      getHierarchy: vi.fn(),
      spawn: vi.fn(),
      prompt: vi.fn(),
      resume: vi.fn(),
      close: vi.fn(),
      hasActiveSession: vi.fn().mockReturnValue(false),
    } as any,
    eventStore: {
      append: vi.fn(),
      query: vi.fn().mockReturnValue([]),
      persist: vi.fn(),
      close: vi.fn(),
    } as any,
    taskManager: {
      create: vi.fn(),
      get: vi.fn(),
      list: vi.fn().mockReturnValue([]),
      update: vi.fn(),
    } as any,
  };
}

// ─────────────────────────────────────────────────────────────────
// Test Utilities
// ─────────────────────────────────────────────────────────────────

async function waitForConnection(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) {
      resolve();
      return;
    }
    ws.on("open", () => resolve());
    ws.on("error", reject);
  });
}

async function waitForClose(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) {
      resolve();
      return;
    }
    ws.on("close", () => resolve());
  });
}

function sendJsonRpc(ws: WebSocket, method: string, params: any, id: number): void {
  ws.send(JSON.stringify({
    jsonrpc: "2.0",
    method,
    params,
    id,
  }));
}

async function waitForResponse(ws: WebSocket, id: number): Promise<any> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timeout waiting for response id=${id}`));
    }, 5000);

    const handler = (data: Buffer) => {
      try {
        const message = JSON.parse(data.toString());
        if (message.id === id) {
          clearTimeout(timeout);
          ws.off("message", handler);
          resolve(message);
        }
      } catch {
        // Ignore parse errors
      }
    };

    ws.on("message", handler);
  });
}

// ─────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────

describe("WebSocket ACP Server", () => {
  let server: WebSocketACPServer;
  let services: ACPServices;
  let testPort: number;
  const clients: WebSocket[] = [];

  beforeEach(async () => {
    // Use a random port to avoid conflicts
    testPort = 10000 + Math.floor(Math.random() * 50000);
    services = createMockServices();
    server = createWebSocketACPServer(services, {
      port: testPort,
      host: "localhost",
      path: "/acp",
    });
    await server.start();
  });

  afterEach(async () => {
    // Close all test clients
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.close();
      }
    }
    clients.length = 0;

    // Stop the server
    await server.stop();
  });

  describe("server lifecycle", () => {
    it("should start and accept connections", async () => {
      const ws = new WebSocket(`ws://localhost:${testPort}/acp`);
      clients.push(ws);

      await waitForConnection(ws);

      expect(ws.readyState).toBe(WebSocket.OPEN);
      expect(server.getConnectionCount()).toBe(1);
    });

    it("should return correct URL", () => {
      expect(server.getUrl()).toBe(`ws://localhost:${testPort}/acp`);
    });

    it("should track connection count", async () => {
      expect(server.getConnectionCount()).toBe(0);

      const ws1 = new WebSocket(`ws://localhost:${testPort}/acp`);
      clients.push(ws1);
      await waitForConnection(ws1);
      expect(server.getConnectionCount()).toBe(1);

      const ws2 = new WebSocket(`ws://localhost:${testPort}/acp`);
      clients.push(ws2);
      await waitForConnection(ws2);
      expect(server.getConnectionCount()).toBe(2);

      ws1.close();
      await waitForClose(ws1);
      // Give server time to process close event
      await new Promise((r) => setTimeout(r, 50));
      expect(server.getConnectionCount()).toBe(1);
    });

    it("should close all connections on shutdown", async () => {
      const ws1 = new WebSocket(`ws://localhost:${testPort}/acp`);
      const ws2 = new WebSocket(`ws://localhost:${testPort}/acp`);
      clients.push(ws1, ws2);

      await Promise.all([waitForConnection(ws1), waitForConnection(ws2)]);
      expect(server.getConnectionCount()).toBe(2);

      const closePromises = [waitForClose(ws1), waitForClose(ws2)];

      // Stop the server (afterEach will handle cleanup if this fails)
      await server.stop();

      await Promise.all(closePromises);

      expect(ws1.readyState).toBe(WebSocket.CLOSED);
      expect(ws2.readyState).toBe(WebSocket.CLOSED);

      // Restart server for afterEach cleanup (since we stopped it)
      server = createWebSocketACPServer(services, {
        port: testPort,
        host: "localhost",
        path: "/acp",
      });
      await server.start();
    });
  });

  describe("health check", () => {
    it("should respond to health check endpoint", async () => {
      const response = await fetch(`http://localhost:${testPort}/health`);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.status).toBe("ok");
      expect(data.connections).toBe(0);
      expect(data.timestamp).toBeDefined();
    });

    it("should report correct connection count in health check", async () => {
      const ws = new WebSocket(`ws://localhost:${testPort}/acp`);
      clients.push(ws);
      await waitForConnection(ws);

      const response = await fetch(`http://localhost:${testPort}/health`);
      const data = await response.json();

      expect(data.connections).toBe(1);
    });
  });

  describe("ACP protocol", () => {
    it("should handle initialize request", async () => {
      const ws = new WebSocket(`ws://localhost:${testPort}/acp`);
      clients.push(ws);
      await waitForConnection(ws);

      // Send initialize request
      sendJsonRpc(ws, "initialize", { protocolVersion: 1 }, 1);

      const response = await waitForResponse(ws, 1);

      expect(response.result).toBeDefined();
      expect(response.result.protocolVersion).toBe(1);
    });

    it("should respond to JSON-RPC requests", async () => {
      const ws = new WebSocket(`ws://localhost:${testPort}/acp`);
      clients.push(ws);
      await waitForConnection(ws);

      // Send initialize request and verify we get a valid JSON-RPC response
      sendJsonRpc(ws, "initialize", { protocolVersion: 1 }, 1);

      const response = await waitForResponse(ws, 1);

      // Verify it's a valid JSON-RPC 2.0 response
      expect(response.jsonrpc).toBe("2.0");
      expect(response.id).toBe(1);
      expect(response.result).toBeDefined();
    });

    it("should return error for unknown methods", async () => {
      const ws = new WebSocket(`ws://localhost:${testPort}/acp`);
      clients.push(ws);
      await waitForConnection(ws);

      // Send unknown method
      sendJsonRpc(ws, "unknownMethod", {}, 1);

      const response = await waitForResponse(ws, 1);

      // Should get an error response
      expect(response.jsonrpc).toBe("2.0");
      expect(response.id).toBe(1);
      expect(response.error).toBeDefined();
      expect(response.error.code).toBe(-32601); // Method not found
    });
  });

  describe("multiple connections", () => {
    it("should handle multiple concurrent connections independently", async () => {
      const ws1 = new WebSocket(`ws://localhost:${testPort}/acp`);
      const ws2 = new WebSocket(`ws://localhost:${testPort}/acp`);
      clients.push(ws1, ws2);

      await Promise.all([waitForConnection(ws1), waitForConnection(ws2)]);

      // Both should be able to initialize independently
      sendJsonRpc(ws1, "initialize", { protocolVersion: 1 }, 1);
      sendJsonRpc(ws2, "initialize", { protocolVersion: 1 }, 1);

      const [response1, response2] = await Promise.all([
        waitForResponse(ws1, 1),
        waitForResponse(ws2, 1),
      ]);

      expect(response1.result.protocolVersion).toBe(1);
      expect(response2.result.protocolVersion).toBe(1);
    });

    it("should maintain separate sessions per connection", async () => {
      const ws1 = new WebSocket(`ws://localhost:${testPort}/acp`);
      const ws2 = new WebSocket(`ws://localhost:${testPort}/acp`);
      clients.push(ws1, ws2);

      await Promise.all([waitForConnection(ws1), waitForConnection(ws2)]);

      // Each connection should have its own ACP session
      expect(server.getConnectionCount()).toBe(2);

      // Each can independently send requests
      sendJsonRpc(ws1, "initialize", { protocolVersion: 1 }, 1);
      sendJsonRpc(ws2, "initialize", { protocolVersion: 1 }, 2);

      const [response1, response2] = await Promise.all([
        waitForResponse(ws1, 1),
        waitForResponse(ws2, 2),
      ]);

      // Both should succeed independently
      expect(response1.result).toBeDefined();
      expect(response2.result).toBeDefined();
    });
  });

  describe("connection cleanup", () => {
    it("should clean up when client disconnects", async () => {
      const ws = new WebSocket(`ws://localhost:${testPort}/acp`);
      clients.push(ws);
      await waitForConnection(ws);

      expect(server.getConnectionCount()).toBe(1);

      ws.close();
      await waitForClose(ws);

      // Give server time to process close
      await new Promise((r) => setTimeout(r, 50));

      expect(server.getConnectionCount()).toBe(0);
    });
  });
});
