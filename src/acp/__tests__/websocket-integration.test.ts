/**
 * Integration Tests for Multi-Client WebSocket ACP
 *
 * Tests the complete flow of multiple clients connecting via WebSocket
 * and interacting with the server. These tests focus on connection
 * management, protocol handling, and multi-client scenarios.
 *
 * Note: Full ACP session lifecycle tests (newSession, prompt, etc.) are
 * in the macro-agent.test.ts and integration.test.ts files. These tests
 * focus specifically on the WebSocket transport layer.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { WebSocket } from "ws";
import {
  createWebSocketACPServer,
  type WebSocketACPServer,
  type ACPServices,
} from "../websocket-server.js";

// ─────────────────────────────────────────────────────────────────
// Test Utilities
// ─────────────────────────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
  id: number;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/**
 * Simple WebSocket ACP client for testing
 */
class TestACPClient {
  private ws: WebSocket;
  private waiters: Map<number, (response: JsonRpcResponse) => void> = new Map();
  private nextId = 1;
  private _connected = false;
  private closePromise: Promise<void>;
  private closeResolve!: () => void;

  constructor(private url: string) {
    this.ws = new WebSocket(url);
    this.closePromise = new Promise((resolve) => {
      this.closeResolve = resolve;
    });
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws.on("open", () => {
        this._connected = true;
        resolve();
      });
      this.ws.on("error", reject);
      this.ws.on("message", (data: Buffer) => {
        try {
          const message = JSON.parse(data.toString()) as JsonRpcResponse;
          const waiter = this.waiters.get(message.id);
          if (waiter) {
            this.waiters.delete(message.id);
            waiter(message);
          }
        } catch {
          // Ignore parse errors
        }
      });
      this.ws.on("close", () => {
        this._connected = false;
        this.closeResolve();
      });
    });
  }

  async send(method: string, params?: unknown): Promise<JsonRpcResponse> {
    const id = this.nextId++;
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      method,
      params,
      id,
    };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.waiters.delete(id);
        reject(new Error(`Timeout waiting for response to ${method}`));
      }, 5000);

      this.waiters.set(id, (response) => {
        clearTimeout(timeout);
        resolve(response);
      });

      this.ws.send(JSON.stringify(request));
    });
  }

  async initialize(): Promise<JsonRpcResponse> {
    return this.send("initialize", { protocolVersion: 1 });
  }

  close(): void {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.close();
    }
  }

  async waitForClose(): Promise<void> {
    return this.closePromise;
  }

  get isConnected(): boolean {
    return this._connected && this.ws.readyState === WebSocket.OPEN;
  }
}

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
// Integration Tests
// ─────────────────────────────────────────────────────────────────

describe("WebSocket ACP Integration", () => {
  let server: WebSocketACPServer;
  let services: ACPServices;
  let testPort: number;
  const clients: TestACPClient[] = [];

  beforeEach(async () => {
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
      client.close();
    }
    clients.length = 0;

    // Stop the server
    await server.stop();
  });

  describe("Multi-Client Connection Management", () => {
    it("should accept multiple simultaneous connections", async () => {
      const client1 = new TestACPClient(`ws://localhost:${testPort}/acp`);
      const client2 = new TestACPClient(`ws://localhost:${testPort}/acp`);
      const client3 = new TestACPClient(`ws://localhost:${testPort}/acp`);
      clients.push(client1, client2, client3);

      await Promise.all([
        client1.connect(),
        client2.connect(),
        client3.connect(),
      ]);

      expect(client1.isConnected).toBe(true);
      expect(client2.isConnected).toBe(true);
      expect(client3.isConnected).toBe(true);
      expect(server.getConnectionCount()).toBe(3);
    });

    it("should track connections accurately as clients join and leave", async () => {
      expect(server.getConnectionCount()).toBe(0);

      const client1 = new TestACPClient(`ws://localhost:${testPort}/acp`);
      clients.push(client1);
      await client1.connect();
      expect(server.getConnectionCount()).toBe(1);

      const client2 = new TestACPClient(`ws://localhost:${testPort}/acp`);
      clients.push(client2);
      await client2.connect();
      expect(server.getConnectionCount()).toBe(2);

      client1.close();
      await new Promise((r) => setTimeout(r, 50));
      expect(server.getConnectionCount()).toBe(1);

      client2.close();
      await new Promise((r) => setTimeout(r, 50));
      expect(server.getConnectionCount()).toBe(0);
    });

    it("should handle rapid connect/disconnect cycles", async () => {
      for (let i = 0; i < 5; i++) {
        const client = new TestACPClient(`ws://localhost:${testPort}/acp`);
        await client.connect();
        expect(client.isConnected).toBe(true);
        client.close();
        await client.waitForClose();
      }

      // Allow time for server to process the last close event
      await new Promise((r) => setTimeout(r, 50));
      expect(server.getConnectionCount()).toBe(0);
    });
  });

  describe("Independent Client Sessions", () => {
    it("should allow each client to initialize independently", async () => {
      const client1 = new TestACPClient(`ws://localhost:${testPort}/acp`);
      const client2 = new TestACPClient(`ws://localhost:${testPort}/acp`);
      clients.push(client1, client2);

      await Promise.all([client1.connect(), client2.connect()]);

      const [init1, init2] = await Promise.all([
        client1.initialize(),
        client2.initialize(),
      ]);

      expect(init1.result).toBeDefined();
      expect(init2.result).toBeDefined();
      expect((init1.result as any).protocolVersion).toBe(1);
      expect((init2.result as any).protocolVersion).toBe(1);
    });

    it("should route responses to correct clients", async () => {
      const client1 = new TestACPClient(`ws://localhost:${testPort}/acp`);
      const client2 = new TestACPClient(`ws://localhost:${testPort}/acp`);
      clients.push(client1, client2);

      await Promise.all([client1.connect(), client2.connect()]);

      // Send requests with different IDs
      const [response1, response2] = await Promise.all([
        client1.send("initialize", { protocolVersion: 1 }),
        client2.send("initialize", { protocolVersion: 1 }),
      ]);

      // Each client should get their own response
      expect(response1.id).toBeDefined();
      expect(response2.id).toBeDefined();
      expect(response1.result).toBeDefined();
      expect(response2.result).toBeDefined();
    });

    it("should isolate errors to the requesting client", async () => {
      const client1 = new TestACPClient(`ws://localhost:${testPort}/acp`);
      const client2 = new TestACPClient(`ws://localhost:${testPort}/acp`);
      clients.push(client1, client2);

      await Promise.all([client1.connect(), client2.connect()]);

      // Client 1 sends invalid method, client 2 sends valid method
      const [errorResponse, successResponse] = await Promise.all([
        client1.send("unknownMethod", {}),
        client2.send("initialize", { protocolVersion: 1 }),
      ]);

      // Client 1 should get error
      expect(errorResponse.error).toBeDefined();
      expect(errorResponse.error?.code).toBe(-32601);

      // Client 2 should still succeed
      expect(successResponse.result).toBeDefined();
    });
  });

  describe("Protocol Compatibility", () => {
    it("should handle valid JSON-RPC 2.0 requests", async () => {
      const client = new TestACPClient(`ws://localhost:${testPort}/acp`);
      clients.push(client);
      await client.connect();

      const response = await client.initialize();

      expect(response.jsonrpc).toBe("2.0");
      expect(response.id).toBeDefined();
      expect(response.result).toBeDefined();
    });

    it("should return method not found for unknown methods", async () => {
      const client = new TestACPClient(`ws://localhost:${testPort}/acp`);
      clients.push(client);
      await client.connect();

      const response = await client.send("nonExistentMethod", {});

      expect(response.error).toBeDefined();
      expect(response.error?.code).toBe(-32601);
      expect(response.error?.message).toContain("Method not found");
    });

    it("should handle extension method format", async () => {
      const client = new TestACPClient(`ws://localhost:${testPort}/acp`);
      clients.push(client);
      await client.connect();

      // Extension methods are routed through extMethod
      const response = await client.send("extMethod", {
        method: "_macro/getHierarchy",
        params: {},
      });

      // Should get a response (may be error if not initialized, but proves routing works)
      expect(response.jsonrpc).toBe("2.0");
      expect(response.id).toBeDefined();
    });
  });

  describe("Concurrent Request Handling", () => {
    it("should handle concurrent requests from same client", async () => {
      const client = new TestACPClient(`ws://localhost:${testPort}/acp`);
      clients.push(client);
      await client.connect();

      // Send multiple requests concurrently
      const responses = await Promise.all([
        client.send("initialize", { protocolVersion: 1 }),
        client.send("initialize", { protocolVersion: 1 }),
        client.send("initialize", { protocolVersion: 1 }),
      ]);

      // All should get responses with correct IDs
      expect(responses.length).toBe(3);
      const ids = new Set(responses.map((r) => r.id));
      expect(ids.size).toBe(3); // All different IDs
    });

    it("should handle concurrent requests from multiple clients", async () => {
      const numClients = 5;
      const clientList: TestACPClient[] = [];

      for (let i = 0; i < numClients; i++) {
        const client = new TestACPClient(`ws://localhost:${testPort}/acp`);
        clientList.push(client);
        clients.push(client);
      }

      await Promise.all(clientList.map((c) => c.connect()));

      // All clients send initialize concurrently
      const responses = await Promise.all(
        clientList.map((c) => c.initialize())
      );

      // All should succeed
      expect(responses.length).toBe(numClients);
      for (const response of responses) {
        expect(response.result).toBeDefined();
        expect((response.result as any).protocolVersion).toBe(1);
      }
    });
  });

  describe("Graceful Shutdown", () => {
    it("should close all connections on server stop", async () => {
      const client1 = new TestACPClient(`ws://localhost:${testPort}/acp`);
      const client2 = new TestACPClient(`ws://localhost:${testPort}/acp`);
      clients.push(client1, client2);

      await Promise.all([client1.connect(), client2.connect()]);
      expect(server.getConnectionCount()).toBe(2);

      const closePromises = [client1.waitForClose(), client2.waitForClose()];

      await server.stop();
      await Promise.all(closePromises);

      expect(client1.isConnected).toBe(false);
      expect(client2.isConnected).toBe(false);

      // Restart for afterEach cleanup
      server = createWebSocketACPServer(services, {
        port: testPort,
        host: "localhost",
        path: "/acp",
      });
      await server.start();
    });

    it("should handle client disconnect gracefully", async () => {
      const client = new TestACPClient(`ws://localhost:${testPort}/acp`);
      clients.push(client);
      await client.connect();

      // Initialize successfully
      const response = await client.initialize();
      expect(response.result).toBeDefined();

      // Now disconnect
      client.close();
      await new Promise((r) => setTimeout(r, 50));

      // Server should still be healthy
      expect(server.getConnectionCount()).toBe(0);

      // New client should be able to connect
      const newClient = new TestACPClient(`ws://localhost:${testPort}/acp`);
      clients.push(newClient);
      await newClient.connect();
      expect(newClient.isConnected).toBe(true);
    });
  });

  describe("Health Check Endpoint", () => {
    it("should report accurate connection count", async () => {
      // Wait a moment to ensure clean state
      await new Promise((r) => setTimeout(r, 50));

      // Verify starting with no connections
      let response = await fetch(`http://localhost:${testPort}/health`);
      let data = await response.json();
      const initialConnections = data.connections;

      const client1 = new TestACPClient(`ws://localhost:${testPort}/acp`);
      const client2 = new TestACPClient(`ws://localhost:${testPort}/acp`);
      clients.push(client1, client2);

      // Connect clients
      await Promise.all([client1.connect(), client2.connect()]);

      // Check health after connections
      response = await fetch(`http://localhost:${testPort}/health`);
      data = await response.json();
      expect(data.connections).toBe(2);

      // Disconnect one client
      client1.close();
      await new Promise((r) => setTimeout(r, 50));

      // Check health again
      response = await fetch(`http://localhost:${testPort}/health`);
      data = await response.json();
      expect(data.connections).toBe(1);
    });
  });
});
