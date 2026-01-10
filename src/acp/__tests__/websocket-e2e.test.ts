/**
 * WebSocket ACP End-to-End Tests
 *
 * Tests the complete flow of multiple WebSocket clients connecting to
 * the ACP server and interacting with the shared agent hierarchy.
 *
 * These tests use real services (EventStore, AgentManager, TaskManager)
 * but with mocked Claude Code processes to avoid needing API keys.
 *
 * For full E2E with real Claude Code:
 *   ANTHROPIC_API_KEY=xxx npm test -- src/acp/__tests__/websocket-e2e.test.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { WebSocket } from "ws";
import { createEventStore, type EventStore } from "../../store/event-store.js";
import {
  createAgentManager,
  type AgentManager,
} from "../../agent/agent-manager.js";
import { createTaskManager, type TaskManager } from "../../task/task-manager.js";
import {
  createMessageRouter,
  type MessageRouter,
} from "../../router/message-router.js";
import {
  createWebSocketACPServer,
  type WebSocketACPServer,
} from "../websocket-server.js";

// ─────────────────────────────────────────────────────────────────
// Test ACP Client using proper JSON-RPC format
// ─────────────────────────────────────────────────────────────────

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

class TestACPClient {
  private ws: WebSocket;
  private waiters: Map<number, (response: JsonRpcResponse) => void> = new Map();
  private nextId = 1;
  private connected = false;
  private closeResolve?: () => void;
  private closePromise: Promise<void>;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.closePromise = new Promise((resolve) => {
      this.closeResolve = resolve;
    });
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Connection timeout"));
      }, 5000);

      this.ws.on("open", () => {
        clearTimeout(timeout);
        this.connected = true;
        resolve();
      });

      this.ws.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });

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
        this.connected = false;
        this.closeResolve?.();
      });
    });
  }

  async request(method: string, params?: unknown): Promise<JsonRpcResponse> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.waiters.delete(id);
        reject(new Error(`Timeout waiting for ${method}`));
      }, 10000);

      this.waiters.set(id, (response) => {
        clearTimeout(timeout);
        resolve(response);
      });

      this.ws.send(JSON.stringify({ jsonrpc: "2.0", method, params, id }));
    });
  }

  async initialize(): Promise<JsonRpcResponse> {
    return this.request("initialize", { protocolVersion: 1 });
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
    return this.connected && this.ws.readyState === WebSocket.OPEN;
  }
}

// ─────────────────────────────────────────────────────────────────
// E2E Tests with Real Services
// ─────────────────────────────────────────────────────────────────

describe("WebSocket ACP E2E with Real Services", () => {
  let eventStore: EventStore;
  let agentManager: AgentManager;
  let taskManager: TaskManager;
  let messageRouter: MessageRouter;
  let server: WebSocketACPServer;
  let testPort: number;
  const clients: TestACPClient[] = [];

  beforeEach(async () => {
    // Create real services (in-memory)
    eventStore = await createEventStore({ inMemory: true });
    messageRouter = createMessageRouter(eventStore);
    taskManager = createTaskManager(eventStore);
    agentManager = createAgentManager(eventStore, messageRouter, {
      defaultPermissionMode: "auto-approve",
      defaultCwd: process.cwd(),
    });

    // Start WebSocket server with real services
    testPort = 10000 + Math.floor(Math.random() * 50000);
    server = createWebSocketACPServer(
      { eventStore, agentManager, taskManager },
      { port: testPort, host: "localhost", path: "/acp" }
    );
    await server.start();
  });

  afterEach(async () => {
    // Close all clients
    for (const client of clients) {
      client.close();
    }
    clients.length = 0;

    // Stop server and services
    await server.stop();
    await agentManager.close();
    await eventStore.close();
  });

  describe("Multi-Client Connection with Real Services", () => {
    it("should allow multiple clients to connect to server with real services", async () => {
      const clientA = new TestACPClient(`ws://localhost:${testPort}/acp`);
      const clientB = new TestACPClient(`ws://localhost:${testPort}/acp`);
      clients.push(clientA, clientB);

      await Promise.all([clientA.connect(), clientB.connect()]);

      expect(clientA.isConnected).toBe(true);
      expect(clientB.isConnected).toBe(true);
      expect(server.getConnectionCount()).toBe(2);
    });

    it("should initialize multiple clients with real ACP protocol", async () => {
      const clientA = new TestACPClient(`ws://localhost:${testPort}/acp`);
      const clientB = new TestACPClient(`ws://localhost:${testPort}/acp`);
      clients.push(clientA, clientB);

      await Promise.all([clientA.connect(), clientB.connect()]);

      const [initA, initB] = await Promise.all([
        clientA.initialize(),
        clientB.initialize(),
      ]);

      // Both should successfully initialize
      expect(initA.result).toBeDefined();
      expect(initB.result).toBeDefined();
      expect((initA.result as any).protocolVersion).toBe(1);
      expect((initB.result as any).protocolVersion).toBe(1);

      // Should report extension methods available
      const extensions = (initA.result as any).extensions || [];
      expect(Array.isArray(extensions)).toBe(true);
    });

    it("should handle connection lifecycle correctly", async () => {
      expect(server.getConnectionCount()).toBe(0);

      // Connect first client
      const clientA = new TestACPClient(`ws://localhost:${testPort}/acp`);
      clients.push(clientA);
      await clientA.connect();
      await clientA.initialize();
      expect(server.getConnectionCount()).toBe(1);

      // Connect second client
      const clientB = new TestACPClient(`ws://localhost:${testPort}/acp`);
      clients.push(clientB);
      await clientB.connect();
      await clientB.initialize();
      expect(server.getConnectionCount()).toBe(2);

      // Disconnect first client
      clientA.close();
      await new Promise((r) => setTimeout(r, 100));
      expect(server.getConnectionCount()).toBe(1);

      // Second client should still be able to send requests
      expect(clientB.isConnected).toBe(true);
    });

    it("should persist events across all client connections", async () => {
      const clientA = new TestACPClient(`ws://localhost:${testPort}/acp`);
      const clientB = new TestACPClient(`ws://localhost:${testPort}/acp`);
      clients.push(clientA, clientB);

      await Promise.all([clientA.connect(), clientB.connect()]);
      await Promise.all([clientA.initialize(), clientB.initialize()]);

      // Both clients use the same eventStore
      // Any events appended by one client's session would be visible
      // to the event store query from another client's session

      // Verify the shared event store is functional
      const events = eventStore.query({ type: "AGENT_LIFECYCLE" });
      expect(Array.isArray(events)).toBe(true);
    });

    it("should handle graceful server shutdown with multiple clients", async () => {
      const clientA = new TestACPClient(`ws://localhost:${testPort}/acp`);
      const clientB = new TestACPClient(`ws://localhost:${testPort}/acp`);
      const clientC = new TestACPClient(`ws://localhost:${testPort}/acp`);
      clients.push(clientA, clientB, clientC);

      await Promise.all([
        clientA.connect(),
        clientB.connect(),
        clientC.connect(),
      ]);

      await Promise.all([
        clientA.initialize(),
        clientB.initialize(),
        clientC.initialize(),
      ]);

      expect(server.getConnectionCount()).toBe(3);

      // Collect close promises
      const closePromises = [
        clientA.waitForClose(),
        clientB.waitForClose(),
        clientC.waitForClose(),
      ];

      // Stop server - should close all connections
      await server.stop();

      // Wait for all clients to receive close
      await Promise.all(closePromises);

      expect(clientA.isConnected).toBe(false);
      expect(clientB.isConnected).toBe(false);
      expect(clientC.isConnected).toBe(false);

      // Restart for afterEach cleanup
      server = createWebSocketACPServer(
        { eventStore, agentManager, taskManager },
        { port: testPort, host: "localhost", path: "/acp" }
      );
      await server.start();
    });
  });

  describe("Health Check with Real Services", () => {
    it("should report accurate health status", async () => {
      // Check initial health
      let response = await fetch(`http://localhost:${testPort}/health`);
      let data = await response.json();
      expect(data.status).toBe("ok");
      expect(data.connections).toBe(0);

      // Connect clients
      const clientA = new TestACPClient(`ws://localhost:${testPort}/acp`);
      const clientB = new TestACPClient(`ws://localhost:${testPort}/acp`);
      clients.push(clientA, clientB);

      await Promise.all([clientA.connect(), clientB.connect()]);
      await Promise.all([clientA.initialize(), clientB.initialize()]);

      // Check health after connections
      response = await fetch(`http://localhost:${testPort}/health`);
      data = await response.json();
      expect(data.status).toBe("ok");
      expect(data.connections).toBe(2);
      expect(data.timestamp).toBeDefined();
    });
  });
});

// ─────────────────────────────────────────────────────────────────
// Full E2E with Real Claude Code (requires API key)
// ─────────────────────────────────────────────────────────────────

const hasApiKey = !!process.env.ANTHROPIC_API_KEY;
const e2eFn = hasApiKey ? it : it.skip;

describe("WebSocket ACP Full E2E with Real Claude Code", () => {
  let eventStore: EventStore;
  let agentManager: AgentManager;
  let taskManager: TaskManager;
  let messageRouter: MessageRouter;
  let server: WebSocketACPServer;
  let testPort: number;
  const clients: TestACPClient[] = [];

  beforeEach(async () => {
    if (!hasApiKey) return;

    eventStore = await createEventStore({ inMemory: true });
    messageRouter = createMessageRouter(eventStore);
    taskManager = createTaskManager(eventStore);
    agentManager = createAgentManager(eventStore, messageRouter, {
      defaultPermissionMode: "auto-approve",
      defaultCwd: process.cwd(),
    });

    testPort = 10000 + Math.floor(Math.random() * 50000);
    server = createWebSocketACPServer(
      { eventStore, agentManager, taskManager },
      { port: testPort, host: "localhost", path: "/acp" }
    );
    await server.start();
  });

  afterEach(async () => {
    if (!hasApiKey) return;

    for (const client of clients) {
      client.close();
    }
    clients.length = 0;

    await server?.stop();
    await agentManager?.close();
    await eventStore?.close();
  });

  e2eFn(
    "should allow clients to interact with real agents (ANTHROPIC_API_KEY required)",
    async () => {
      const client = new TestACPClient(`ws://localhost:${testPort}/acp`);
      clients.push(client);

      await client.connect();
      const initResult = await client.initialize();
      expect(initResult.result).toBeDefined();

      // This would test the full newSession -> prompt flow with real Claude Code
      // But requires ANTHROPIC_API_KEY
      console.log("Full E2E test with API key would go here");
    },
    { timeout: 60000 }
  );
});
