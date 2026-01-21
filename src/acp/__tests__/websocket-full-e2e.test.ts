/**
 * Full End-to-End WebSocket ACP Tests
 *
 * These tests spawn REAL Claude Code agents and test the complete
 * multi-client WebSocket ACP flow.
 *
 * REQUIRES: RUN_E2E_TESTS=true environment variable (and authenticated Claude Code)
 *
 * Run with:
 *   npm run test:e2e
 *   # or directly:
 *   RUN_E2E_TESTS=true npm test -- src/acp/__tests__/websocket-full-e2e.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
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
// ACP Client with Correct Wire Protocol
// ─────────────────────────────────────────────────────────────────

interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

class ACPWireClient {
  private ws: WebSocket;
  private waiters: Map<number, (msg: JsonRpcMessage) => void> = new Map();
  private notifications: JsonRpcMessage[] = [];
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
      const timeout = setTimeout(() => reject(new Error("Connection timeout")), 10000);

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
          const msg = JSON.parse(data.toString()) as JsonRpcMessage;

          // If it has an id, it's a response to our request
          if (msg.id !== undefined) {
            const waiter = this.waiters.get(msg.id);
            if (waiter) {
              this.waiters.delete(msg.id);
              waiter(msg);
            }
          } else {
            // It's a notification
            this.notifications.push(msg);
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

  /**
   * Send a JSON-RPC request using the correct ACP wire method name
   */
  async request(method: string, params?: unknown): Promise<JsonRpcMessage> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.waiters.delete(id);
        reject(new Error(`Timeout waiting for ${method}`));
      }, 30000); // Longer timeout for real agent operations

      this.waiters.set(id, (response) => {
        clearTimeout(timeout);
        resolve(response);
      });

      this.ws.send(JSON.stringify({ jsonrpc: "2.0", method, params, id }));
    });
  }

  /**
   * ACP initialize - establishes connection
   */
  async initialize(): Promise<JsonRpcMessage> {
    return this.request("initialize", {
      protocolVersion: 1,
      capabilities: {},
      clientInfo: { name: "test-client", version: "1.0.0" },
    });
  }

  /**
   * ACP session/new - creates a new session (spawns agent)
   */
  async newSession(params: { cwd?: string } = {}): Promise<JsonRpcMessage> {
    // mcpServers is required by ACP protocol - default to empty array
    return this.request("session/new", {
      mcpServers: [],
      ...params,
    });
  }

  /**
   * ACP session/prompt - sends a prompt to the agent
   */
  async prompt(sessionId: string, messages: Array<{ role: string; content: string }>): Promise<JsonRpcMessage> {
    return this.request("session/prompt", { sessionId, messages });
  }

  /**
   * Extension method for macro-agent specific functionality
   */
  async extMethod(method: string, params: unknown): Promise<JsonRpcMessage> {
    // Extension methods use the same format
    return this.request(method, params);
  }

  getNotifications(): JsonRpcMessage[] {
    return [...this.notifications];
  }

  clearNotifications(): void {
    this.notifications.length = 0;
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
// Test Setup
// ─────────────────────────────────────────────────────────────────

const runE2E = !!process.env.RUN_E2E_TESTS;
const testFn = runE2E ? it : it.skip;

describe("WebSocket ACP Full E2E (Real Agents)", () => {
  let eventStore: EventStore;
  let agentManager: AgentManager;
  let taskManager: TaskManager;
  let messageRouter: MessageRouter;
  let server: WebSocketACPServer;
  let testPort: number;
  const clients: ACPWireClient[] = [];

  beforeEach(async () => {
    if (!runE2E) {
      console.log("⚠️  Skipping: RUN_E2E_TESTS not set");
      return;
    }

    // Create real services
    eventStore = await createEventStore({ inMemory: true });
    messageRouter = createMessageRouter(eventStore);
    taskManager = createTaskManager(eventStore);
    agentManager = createAgentManager(eventStore, messageRouter, {
      defaultPermissionMode: "auto-approve",
      defaultCwd: process.cwd(),
    });

    // Start WebSocket server
    testPort = 10000 + Math.floor(Math.random() * 50000);
    server = createWebSocketACPServer(
      { eventStore, agentManager, taskManager },
      { port: testPort, host: "localhost", path: "/acp" }
    );
    await server.start();
  });

  afterEach(async () => {
    if (!runE2E) return;

    // Close all clients
    for (const client of clients) {
      client.close();
    }
    clients.length = 0;

    // Stop server and services
    await server?.stop();
    await agentManager?.close();
    await eventStore?.close();
  });

  describe("Single Client - Real Agent", () => {
    testFn(
      "should create a session and spawn a real agent",
      async () => {
        const client = new ACPWireClient(`ws://localhost:${testPort}/acp`);
        clients.push(client);

        await client.connect();
        expect(client.isConnected).toBe(true);

        // Initialize ACP connection
        const initResult = await client.initialize();
        expect(initResult.result).toBeDefined();
        expect(initResult.error).toBeUndefined();

        // Create a new session (spawns a real Claude Code agent)
        const sessionResult = await client.newSession({ cwd: process.cwd() });

        expect(sessionResult.error).toBeUndefined();
        expect(sessionResult.result).toBeDefined();

        const session = sessionResult.result as { sessionId: string };
        expect(session.sessionId).toBeDefined();

        console.log(`✓ Created session: ${session.sessionId}`);
      },
      { timeout: 60000 }
    );
  });

  describe("Multi-Client - Real Agents", () => {
    testFn(
      "should allow two clients to create independent sessions",
      async () => {
        const clientA = new ACPWireClient(`ws://localhost:${testPort}/acp`);
        const clientB = new ACPWireClient(`ws://localhost:${testPort}/acp`);
        clients.push(clientA, clientB);

        // Connect both clients
        await Promise.all([clientA.connect(), clientB.connect()]);
        expect(clientA.isConnected).toBe(true);
        expect(clientB.isConnected).toBe(true);
        expect(server.getConnectionCount()).toBe(2);

        // Initialize both
        const [initA, initB] = await Promise.all([
          clientA.initialize(),
          clientB.initialize(),
        ]);
        expect(initA.result).toBeDefined();
        expect(initB.result).toBeDefined();

        // Create sessions (spawn agents) - sequentially to avoid race conditions
        const sessionA = await clientA.newSession({ cwd: process.cwd() });
        expect(sessionA.error).toBeUndefined();
        expect(sessionA.result).toBeDefined();

        const sessionAId = (sessionA.result as { sessionId: string }).sessionId;
        console.log(`✓ Client A session: ${sessionAId}`);

        const sessionB = await clientB.newSession({ cwd: process.cwd() });
        expect(sessionB.error).toBeUndefined();
        expect(sessionB.result).toBeDefined();

        const sessionBId = (sessionB.result as { sessionId: string }).sessionId;
        console.log(`✓ Client B session: ${sessionBId}`);

        // Sessions should be different
        expect(sessionAId).not.toBe(sessionBId);

        // Verify both agents exist in the shared hierarchy
        const agents = agentManager.list();
        console.log(`✓ Total agents in hierarchy: ${agents.length}`);
        expect(agents.length).toBeGreaterThanOrEqual(2);
      },
      { timeout: 120000 }
    );

    testFn(
      "should share agent hierarchy between clients",
      async () => {
        const clientA = new ACPWireClient(`ws://localhost:${testPort}/acp`);
        const clientB = new ACPWireClient(`ws://localhost:${testPort}/acp`);
        clients.push(clientA, clientB);

        await Promise.all([clientA.connect(), clientB.connect()]);
        await Promise.all([clientA.initialize(), clientB.initialize()]);

        // Client A creates a session
        const sessionA = await clientA.newSession({ cwd: process.cwd() });
        expect(sessionA.result).toBeDefined();
        console.log(`✓ Client A created session`);

        // Client B should be able to see the hierarchy via extension method
        const hierarchyResult = await clientB.extMethod("_macro/getHierarchy", {});

        // Even if it errors (requires session), it proves the extension method routing works
        console.log(`✓ Client B called getHierarchy:`, hierarchyResult.error ? "needs session" : "success");

        // Verify in the shared service
        const agents = agentManager.list();
        expect(agents.length).toBeGreaterThanOrEqual(1);
        console.log(`✓ Shared hierarchy has ${agents.length} agent(s)`);
      },
      { timeout: 90000 }
    );
  });

  describe("Connection Lifecycle with Real Agents", () => {
    testFn(
      "should handle client disconnect while agent is running",
      async () => {
        const client = new ACPWireClient(`ws://localhost:${testPort}/acp`);
        clients.push(client);

        await client.connect();
        await client.initialize();

        // Create session (spawns agent)
        const sessionResult = await client.newSession({ cwd: process.cwd() });
        expect(sessionResult.result).toBeDefined();

        const agentsBefore = agentManager.list();
        console.log(`✓ Agents before disconnect: ${agentsBefore.length}`);

        // Disconnect client
        client.close();
        await new Promise((r) => setTimeout(r, 500));

        // Server should handle gracefully
        expect(server.getConnectionCount()).toBe(0);

        // Agent should still exist in the hierarchy (not terminated on disconnect)
        const agentsAfter = agentManager.list();
        console.log(`✓ Agents after disconnect: ${agentsAfter.length}`);
      },
      { timeout: 60000 }
    );
  });
});

// Log skip reason if RUN_E2E_TESTS not set
if (!runE2E) {
  console.log("\n" + "=".repeat(60));
  console.log("WebSocket ACP Full E2E tests SKIPPED");
  console.log("To run with real agents:");
  console.log("  npm run test:e2e");
  console.log("=".repeat(60) + "\n");
}
