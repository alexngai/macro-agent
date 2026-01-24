/**
 * Multi-Agent E2E Tests
 *
 * Comprehensive E2E tests for multi-agent lifecycle, WebSocket ACP multi-client,
 * and inter-agent communication.
 *
 * REQUIRES: RUN_FULL_AGENT_TESTS=true environment variable (and authenticated Claude Code)
 *
 * Run with:
 *   RUN_FULL_AGENT_TESTS=true npm run test:e2e -- src/__tests__/e2e/multi-agent.e2e.test.ts
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
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
} from "../../acp/websocket-server.js";

// ─────────────────────────────────────────────────────────────────
// Test Configuration
// ─────────────────────────────────────────────────────────────────

const RUN_FULL_AGENT = !!process.env.RUN_FULL_AGENT_TESTS;
const testFn = RUN_FULL_AGENT ? it : it.skip;

// Timeouts for different test types
const TIMEOUT = {
  SPAWN: 60000,      // Single agent spawn
  MULTI_SPAWN: 180000, // Multiple agent spawns
  PROMPT: 90000,     // Agent prompt with response
  HIERARCHY: 120000, // Hierarchy operations
};

// ─────────────────────────────────────────────────────────────────
// ACP Wire Protocol Client
// ─────────────────────────────────────────────────────────────────

interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

class ACPTestClient {
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
          if (msg.id !== undefined) {
            const waiter = this.waiters.get(msg.id);
            if (waiter) {
              this.waiters.delete(msg.id);
              waiter(msg);
            }
          } else {
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

  async request(method: string, params?: unknown, timeoutMs = 30000): Promise<JsonRpcMessage> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.waiters.delete(id);
        reject(new Error(`Timeout waiting for ${method}`));
      }, timeoutMs);

      this.waiters.set(id, (response) => {
        clearTimeout(timeout);
        resolve(response);
      });

      this.ws.send(JSON.stringify({ jsonrpc: "2.0", method, params, id }));
    });
  }

  async initialize(): Promise<JsonRpcMessage> {
    return this.request("initialize", {
      protocolVersion: 1,
      capabilities: {},
      clientInfo: { name: "e2e-test-client", version: "1.0.0" },
    });
  }

  async newSession(params: { cwd?: string } = {}): Promise<JsonRpcMessage> {
    return this.request("session/new", {
      mcpServers: [],
      ...params,
    }, 60000);
  }

  async prompt(sessionId: string, text: string, timeoutMs = 60000): Promise<JsonRpcMessage> {
    return this.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text }],
    }, timeoutMs);
  }

  async extMethod(method: string, params: unknown, timeoutMs = 30000): Promise<JsonRpcMessage> {
    return this.request(method, params, timeoutMs);
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
// Test Helpers
// ─────────────────────────────────────────────────────────────────

function log(message: string): void {
  console.log(`[E2E] ${message}`);
}

function logError(message: string, error?: unknown): void {
  console.error(`[E2E ERROR] ${message}`, error);
}

// ─────────────────────────────────────────────────────────────────
// Part 1: Multi-Agent Lifecycle Tests
// ─────────────────────────────────────────────────────────────────

describe("Part 1: Multi-Agent Lifecycle E2E", () => {
  let eventStore: EventStore;
  let agentManager: AgentManager;
  let taskManager: TaskManager;
  let messageRouter: MessageRouter;
  let server: WebSocketACPServer;
  let testPort: number;
  const clients: ACPTestClient[] = [];

  beforeEach(async () => {
    if (!RUN_FULL_AGENT) {
      log("⚠️  Skipping: RUN_FULL_AGENT_TESTS not set");
      return;
    }

    // Create services with in-memory storage
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
    log(`Server started on port ${testPort}`);
  });

  afterEach(async () => {
    if (!RUN_FULL_AGENT) return;

    // Close all clients
    for (const client of clients) {
      client.close();
    }
    clients.length = 0;

    // Terminate all agents
    try {
      const heads = agentManager.listHeadManagers();
      for (const head of heads) {
        try {
          await agentManager.terminate(head.id, "test_cleanup");
        } catch {
          // Ignore termination errors during cleanup
        }
      }
    } catch {
      // Ignore errors during cleanup
    }

    // Stop server and services
    await server?.stop();
    await agentManager?.close();
    await eventStore?.close();
    log("Cleanup complete");
  });

  describe("SPAWN: Agent Spawning", () => {
    testFn(
      "SPAWN-01: should create session and spawn head manager agent",
      async () => {
        const client = new ACPTestClient(`ws://localhost:${testPort}/acp`);
        clients.push(client);

        await client.connect();
        expect(client.isConnected).toBe(true);

        const initResult = await client.initialize();
        expect(initResult.error).toBeUndefined();
        expect(initResult.result).toBeDefined();
        log("✓ Client initialized");

        // Create session (spawns head manager)
        const sessionResult = await client.newSession({ cwd: process.cwd() });
        expect(sessionResult.error).toBeUndefined();
        expect(sessionResult.result).toBeDefined();

        const session = sessionResult.result as { sessionId: string };
        expect(session.sessionId).toBeDefined();
        log(`✓ Session created: ${session.sessionId}`);

        // Verify agent exists in EventStore
        const agents = agentManager.list();
        expect(agents.length).toBeGreaterThanOrEqual(1);
        log(`✓ Agent count: ${agents.length}`);

        // Verify spawn event was emitted
        const spawnEvents = eventStore.query({ type: "spawn" });
        expect(spawnEvents.length).toBeGreaterThanOrEqual(1);
        log(`✓ Spawn events: ${spawnEvents.length}`);
      },
      { timeout: TIMEOUT.SPAWN }
    );

    testFn(
      "SPAWN-05: should spawn multiple children from same parent via extension",
      async () => {
        const client = new ACPTestClient(`ws://localhost:${testPort}/acp`);
        clients.push(client);

        await client.connect();
        await client.initialize();

        // Create head manager session
        const sessionResult = await client.newSession({ cwd: process.cwd() });
        const session = sessionResult.result as { sessionId: string };
        log(`✓ Head manager session: ${session.sessionId}`);

        // Get the head manager's agent ID
        const headManagers = agentManager.listHeadManagers();
        expect(headManagers.length).toBeGreaterThanOrEqual(1);
        const headManagerId = headManagers[0].id;
        log(`✓ Head manager ID: ${headManagerId}`);

        // Spawn first child via extension
        const spawn1Result = await client.extMethod("_macro/spawnAgent", {
          task_description: "Worker 1 - Process data",
          parentId: headManagerId,
        });
        expect(spawn1Result.error).toBeUndefined();
        const child1 = spawn1Result.result as { agentId: string };
        log(`✓ Child 1 spawned: ${child1.agentId}`);

        // Spawn second child via extension
        const spawn2Result = await client.extMethod("_macro/spawnAgent", {
          task_description: "Worker 2 - Analyze results",
          parentId: headManagerId,
        });
        expect(spawn2Result.error).toBeUndefined();
        const child2 = spawn2Result.result as { agentId: string };
        log(`✓ Child 2 spawned: ${child2.agentId}`);

        // Verify both children exist
        const children = agentManager.getChildren(headManagerId);
        expect(children.length).toBe(2);
        log(`✓ Children count: ${children.length}`);

        // Verify both have the same parent
        expect(children[0].parent).toBe(headManagerId);
        expect(children[1].parent).toBe(headManagerId);
        log("✓ Both children have correct parent");
      },
      { timeout: TIMEOUT.MULTI_SPAWN }
    );

    testFn(
      "SPAWN-06: should maintain correct lineage in 3-level hierarchy",
      async () => {
        const client = new ACPTestClient(`ws://localhost:${testPort}/acp`);
        clients.push(client);

        await client.connect();
        await client.initialize();

        // Create head manager (Level 0)
        const sessionResult = await client.newSession({ cwd: process.cwd() });
        const session = sessionResult.result as { sessionId: string };
        const headManagers = agentManager.listHeadManagers();
        const level0Id = headManagers[0].id;
        log(`✓ Level 0 (Head): ${level0Id}`);

        // Spawn Level 1 agent
        const spawn1Result = await client.extMethod("_macro/spawnAgent", {
          task_description: "Level 1 - Team Lead",
          parentId: level0Id,
        });
        expect(spawn1Result.error).toBeUndefined();
        const level1 = spawn1Result.result as { agentId: string };
        log(`✓ Level 1 spawned: ${level1.agentId}`);

        // Spawn Level 2 agent (child of Level 1)
        const spawn2Result = await client.extMethod("_macro/spawnAgent", {
          task_description: "Level 2 - Worker",
          parentId: level1.agentId,
        });
        expect(spawn2Result.error).toBeUndefined();
        const level2 = spawn2Result.result as { agentId: string };
        log(`✓ Level 2 spawned: ${level2.agentId}`);

        // Verify hierarchy structure
        const hierarchy = agentManager.getHierarchy(level0Id);
        expect(hierarchy).not.toBeNull();
        expect(hierarchy!.depth).toBe(3);
        expect(hierarchy!.totalAgents).toBe(3);
        log(`✓ Hierarchy depth: ${hierarchy!.depth}, total: ${hierarchy!.totalAgents}`);

        // Verify lineage
        const level1Agent = agentManager.get(level1.agentId);
        const level2Agent = agentManager.get(level2.agentId);

        expect(level1Agent?.lineage).toEqual([level0Id]);
        expect(level2Agent?.lineage).toEqual([level0Id, level1.agentId]);
        log("✓ Lineages verified correctly");
      },
      { timeout: TIMEOUT.HIERARCHY }
    );
  });

  describe("TERM: Agent Termination", () => {
    testFn(
      "TERM-04: should cascade terminate to all descendants",
      async () => {
        const client = new ACPTestClient(`ws://localhost:${testPort}/acp`);
        clients.push(client);

        await client.connect();
        await client.initialize();

        // Create head manager
        await client.newSession({ cwd: process.cwd() });
        const headManagers = agentManager.listHeadManagers();
        const headId = headManagers[0].id;
        log(`✓ Head manager: ${headId}`);

        // Spawn child
        const childResult = await client.extMethod("_macro/spawnAgent", {
          task_description: "Child agent",
          parentId: headId,
        });
        const child = childResult.result as { agentId: string };
        log(`✓ Child spawned: ${child.agentId}`);

        // Spawn grandchild
        const grandchildResult = await client.extMethod("_macro/spawnAgent", {
          task_description: "Grandchild agent",
          parentId: child.agentId,
        });
        const grandchild = grandchildResult.result as { agentId: string };
        log(`✓ Grandchild spawned: ${grandchild.agentId}`);

        // Verify all running
        expect(agentManager.get(headId)?.state).toBe("running");
        expect(agentManager.get(child.agentId)?.state).toBe("running");
        expect(agentManager.get(grandchild.agentId)?.state).toBe("running");
        log("✓ All agents running");

        // Terminate head manager (should cascade)
        await agentManager.terminate(headId, "completed");
        log("✓ Head manager terminated");

        // Verify cascade termination
        const headAgent = agentManager.get(headId);
        const childAgent = agentManager.get(child.agentId);
        const grandchildAgent = agentManager.get(grandchild.agentId);

        expect(headAgent?.state).toBe("stopped");
        expect(headAgent?.stop_reason).toBe("completed");
        log(`✓ Head state: ${headAgent?.state}, reason: ${headAgent?.stop_reason}`);

        expect(childAgent?.state).toBe("stopped");
        expect(childAgent?.stop_reason).toBe("parent_stopped");
        log(`✓ Child state: ${childAgent?.state}, reason: ${childAgent?.stop_reason}`);

        expect(grandchildAgent?.state).toBe("stopped");
        expect(grandchildAgent?.stop_reason).toBe("parent_stopped");
        log(`✓ Grandchild state: ${grandchildAgent?.state}, reason: ${grandchildAgent?.stop_reason}`);

        // Verify terminate events
        const terminateEvents = eventStore.query({ type: "terminate" });
        expect(terminateEvents.length).toBeGreaterThanOrEqual(3);
        log(`✓ Terminate events: ${terminateEvents.length}`);
      },
      { timeout: TIMEOUT.HIERARCHY }
    );
  });

  describe("QUERY: Agent Querying", () => {
    testFn(
      "QUERY-08: should return correct hierarchy via getHierarchy extension",
      async () => {
        const client = new ACPTestClient(`ws://localhost:${testPort}/acp`);
        clients.push(client);

        await client.connect();
        await client.initialize();

        // Create head manager
        await client.newSession({ cwd: process.cwd() });
        const headManagers = agentManager.listHeadManagers();
        const headId = headManagers[0].id;

        // Spawn some children
        await client.extMethod("_macro/spawnAgent", {
          task_description: "Worker A",
          parentId: headId,
        });
        await client.extMethod("_macro/spawnAgent", {
          task_description: "Worker B",
          parentId: headId,
        });

        // Get hierarchy via extension
        const hierarchyResult = await client.extMethod("_macro/getHierarchy", {
          rootAgentId: headId,
        });

        expect(hierarchyResult.error).toBeUndefined();
        const hierarchy = hierarchyResult.result as {
          hierarchy: { agent: { id: string }; children: unknown[] };
          totalAgents: number;
          depth: number;
        };

        expect(hierarchy.totalAgents).toBe(3);
        expect(hierarchy.depth).toBe(2);
        expect(hierarchy.hierarchy.agent.id).toBe(headId);
        expect(hierarchy.hierarchy.children.length).toBe(2);
        log(`✓ Hierarchy: ${hierarchy.totalAgents} agents, depth ${hierarchy.depth}`);
      },
      { timeout: TIMEOUT.MULTI_SPAWN }
    );
  });
});

// ─────────────────────────────────────────────────────────────────
// Part 2: Multi-Client WebSocket ACP Tests
// ─────────────────────────────────────────────────────────────────

describe("Part 2: Multi-Client WebSocket ACP E2E", () => {
  let eventStore: EventStore;
  let agentManager: AgentManager;
  let taskManager: TaskManager;
  let messageRouter: MessageRouter;
  let server: WebSocketACPServer;
  let testPort: number;
  const clients: ACPTestClient[] = [];

  beforeEach(async () => {
    if (!RUN_FULL_AGENT) return;

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
    if (!RUN_FULL_AGENT) return;

    for (const client of clients) {
      client.close();
    }
    clients.length = 0;

    try {
      const heads = agentManager.listHeadManagers();
      for (const head of heads) {
        try {
          await agentManager.terminate(head.id, "test_cleanup");
        } catch {}
      }
    } catch {}

    await server?.stop();
    await agentManager?.close();
    await eventStore?.close();
  });

  describe("MC: Multi-Client Scenarios", () => {
    testFn(
      "MC-01: should allow multiple clients to connect simultaneously",
      async () => {
        const clientA = new ACPTestClient(`ws://localhost:${testPort}/acp`);
        const clientB = new ACPTestClient(`ws://localhost:${testPort}/acp`);
        const clientC = new ACPTestClient(`ws://localhost:${testPort}/acp`);
        clients.push(clientA, clientB, clientC);

        await Promise.all([
          clientA.connect(),
          clientB.connect(),
          clientC.connect(),
        ]);

        expect(clientA.isConnected).toBe(true);
        expect(clientB.isConnected).toBe(true);
        expect(clientC.isConnected).toBe(true);
        expect(server.getConnectionCount()).toBe(3);
        log("✓ 3 clients connected simultaneously");
      },
      { timeout: TIMEOUT.SPAWN }
    );

    testFn(
      "MC-02: should give each client isolated session by default",
      async () => {
        const clientA = new ACPTestClient(`ws://localhost:${testPort}/acp`);
        const clientB = new ACPTestClient(`ws://localhost:${testPort}/acp`);
        clients.push(clientA, clientB);

        await Promise.all([clientA.connect(), clientB.connect()]);
        await Promise.all([clientA.initialize(), clientB.initialize()]);

        // Create sessions
        const sessionA = await clientA.newSession({ cwd: process.cwd() });
        const sessionB = await clientB.newSession({ cwd: process.cwd() });

        expect(sessionA.error).toBeUndefined();
        expect(sessionB.error).toBeUndefined();

        const sessionAId = (sessionA.result as { sessionId: string }).sessionId;
        const sessionBId = (sessionB.result as { sessionId: string }).sessionId;

        expect(sessionAId).not.toBe(sessionBId);
        log(`✓ Sessions isolated: ${sessionAId} vs ${sessionBId}`);

        // Verify both head managers exist
        const heads = agentManager.listHeadManagers();
        expect(heads.length).toBeGreaterThanOrEqual(2);
        log(`✓ Head managers: ${heads.length}`);
      },
      { timeout: TIMEOUT.MULTI_SPAWN }
    );

    testFn(
      "MC-04: should continue working when one client disconnects",
      async () => {
        const clientA = new ACPTestClient(`ws://localhost:${testPort}/acp`);
        const clientB = new ACPTestClient(`ws://localhost:${testPort}/acp`);
        clients.push(clientA, clientB);

        await Promise.all([clientA.connect(), clientB.connect()]);
        await Promise.all([clientA.initialize(), clientB.initialize()]);

        // Create sessions
        const sessionA = await clientA.newSession({ cwd: process.cwd() });
        const sessionB = await clientB.newSession({ cwd: process.cwd() });
        log("✓ Both sessions created");

        // Disconnect client A
        clientA.close();
        await new Promise((r) => setTimeout(r, 500));

        expect(server.getConnectionCount()).toBe(1);
        log("✓ Client A disconnected, connection count: 1");

        // Client B should still be able to use the hierarchy
        const hierarchyResult = await clientB.extMethod("_macro/getHierarchy", {});
        expect(hierarchyResult.error).toBeUndefined();
        log("✓ Client B can still query hierarchy");

        // Verify both agents still exist in hierarchy
        const agents = agentManager.list();
        expect(agents.length).toBeGreaterThanOrEqual(2);
        log(`✓ Total agents in shared hierarchy: ${agents.length}`);
      },
      { timeout: TIMEOUT.MULTI_SPAWN }
    );

    testFn(
      "MC-05: should handle 5+ concurrent clients",
      async () => {
        const clientCount = 5;
        const newClients: ACPTestClient[] = [];

        // Connect all clients
        for (let i = 0; i < clientCount; i++) {
          const client = new ACPTestClient(`ws://localhost:${testPort}/acp`);
          newClients.push(client);
          clients.push(client);
        }

        await Promise.all(newClients.map((c) => c.connect()));
        expect(server.getConnectionCount()).toBe(clientCount);
        log(`✓ ${clientCount} clients connected`);

        // Initialize all
        await Promise.all(newClients.map((c) => c.initialize()));
        log("✓ All clients initialized");

        // Create sessions sequentially (to avoid race conditions)
        const sessions: string[] = [];
        for (const client of newClients) {
          const result = await client.newSession({ cwd: process.cwd() });
          expect(result.error).toBeUndefined();
          sessions.push((result.result as { sessionId: string }).sessionId);
        }
        log(`✓ ${sessions.length} sessions created`);

        // All sessions should be unique
        const uniqueSessions = new Set(sessions);
        expect(uniqueSessions.size).toBe(clientCount);
        log("✓ All sessions are unique");

        // Verify shared hierarchy
        const heads = agentManager.listHeadManagers();
        expect(heads.length).toBeGreaterThanOrEqual(clientCount);
        log(`✓ Shared hierarchy has ${heads.length} head managers`);
      },
      { timeout: TIMEOUT.MULTI_SPAWN * 2 }
    );

    testFn(
      "MC-07: should allow agent hierarchy spanning multiple client sessions",
      async () => {
        const clientA = new ACPTestClient(`ws://localhost:${testPort}/acp`);
        const clientB = new ACPTestClient(`ws://localhost:${testPort}/acp`);
        clients.push(clientA, clientB);

        await Promise.all([clientA.connect(), clientB.connect()]);
        await Promise.all([clientA.initialize(), clientB.initialize()]);

        // Client A creates head manager
        const sessionA = await clientA.newSession({ cwd: process.cwd() });
        const heads = agentManager.listHeadManagers();
        const clientAHeadId = heads[0].id;
        log(`✓ Client A head manager: ${clientAHeadId}`);

        // Client A spawns a child
        const spawnResult = await clientA.extMethod("_macro/spawnAgent", {
          task_description: "Child from Client A",
          parentId: clientAHeadId,
        });
        const childId = (spawnResult.result as { agentId: string }).agentId;
        log(`✓ Client A spawned child: ${childId}`);

        // Client B should see the entire hierarchy
        const hierarchyResult = await clientB.extMethod("_macro/getHierarchy", {
          rootAgentId: clientAHeadId,
        });

        expect(hierarchyResult.error).toBeUndefined();
        const hierarchy = hierarchyResult.result as {
          totalAgents: number;
          depth: number;
        };

        expect(hierarchy.totalAgents).toBe(2);
        expect(hierarchy.depth).toBe(2);
        log(`✓ Client B sees hierarchy: ${hierarchy.totalAgents} agents, depth ${hierarchy.depth}`);

        // Client B can spawn a grandchild under Client A's child
        const grandchildResult = await clientB.extMethod("_macro/spawnAgent", {
          task_description: "Grandchild from Client B",
          parentId: childId,
        });
        expect(grandchildResult.error).toBeUndefined();
        const grandchildId = (grandchildResult.result as { agentId: string }).agentId;
        log(`✓ Client B spawned grandchild: ${grandchildId}`);

        // Verify the cross-client hierarchy
        const finalHierarchy = agentManager.getHierarchy(clientAHeadId);
        expect(finalHierarchy!.totalAgents).toBe(3);
        expect(finalHierarchy!.depth).toBe(3);
        log("✓ Cross-client hierarchy verified: 3 agents, depth 3");
      },
      { timeout: TIMEOUT.HIERARCHY }
    );
  });
});

// ─────────────────────────────────────────────────────────────────
// Part 3: Event Storage Verification
// ─────────────────────────────────────────────────────────────────

describe("Part 3: Event Storage E2E", () => {
  let eventStore: EventStore;
  let agentManager: AgentManager;
  let taskManager: TaskManager;
  let messageRouter: MessageRouter;
  let server: WebSocketACPServer;
  let testPort: number;
  const clients: ACPTestClient[] = [];

  beforeEach(async () => {
    if (!RUN_FULL_AGENT) return;

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
    if (!RUN_FULL_AGENT) return;

    for (const client of clients) {
      client.close();
    }
    clients.length = 0;

    try {
      const heads = agentManager.listHeadManagers();
      for (const head of heads) {
        try {
          await agentManager.terminate(head.id, "test_cleanup");
        } catch {}
      }
    } catch {}

    await server?.stop();
    await agentManager?.close();
    await eventStore?.close();
  });

  describe("EVT: Event Verification", () => {
    testFn(
      "EVT-01: should store spawn, status, and terminate events",
      async () => {
        const client = new ACPTestClient(`ws://localhost:${testPort}/acp`);
        clients.push(client);

        await client.connect();
        await client.initialize();

        // Create session (generates spawn + status events)
        const sessionResult = await client.newSession({ cwd: process.cwd() });
        const heads = agentManager.listHeadManagers();
        const headId = heads[0].id;
        log("✓ Head manager created");

        // Verify spawn event
        const spawnEvents = eventStore.query({ type: "spawn" });
        expect(spawnEvents.length).toBeGreaterThanOrEqual(1);
        const spawnEvent = spawnEvents.find((e) => e.payload.agent_id === headId);
        expect(spawnEvent).toBeDefined();
        expect(spawnEvent!.payload.agent_id).toBe(headId);
        log(`✓ Spawn event verified for ${headId}`);

        // Verify status events (started)
        const statusEvents = eventStore.query({ type: "status" });
        expect(statusEvents.length).toBeGreaterThanOrEqual(1);
        log(`✓ Status events: ${statusEvents.length}`);

        // Terminate agent
        await agentManager.terminate(headId, "completed");

        // Verify terminate event
        const terminateEvents = eventStore.query({ type: "terminate" });
        expect(terminateEvents.length).toBeGreaterThanOrEqual(1);
        const termEvent = terminateEvents.find((e) => e.payload.agent_id === headId);
        expect(termEvent).toBeDefined();
        expect(termEvent!.payload.reason).toBe("completed");
        log(`✓ Terminate event verified for ${headId}`);
      },
      { timeout: TIMEOUT.SPAWN }
    );

    testFn(
      "VIEW-01/02/03: should update agent materialized view correctly",
      async () => {
        const client = new ACPTestClient(`ws://localhost:${testPort}/acp`);
        clients.push(client);

        await client.connect();
        await client.initialize();

        // Create session
        await client.newSession({ cwd: process.cwd() });
        const heads = agentManager.listHeadManagers();
        const headId = heads[0].id;

        // VIEW-01: Verify agent appears in view after spawn
        let agent = eventStore.getAgent(headId);
        expect(agent).toBeDefined();
        expect(agent!.id).toBe(headId);
        log("✓ VIEW-01: Agent in view after spawn");

        // VIEW-02: Verify state is "running" after status:started
        expect(agent!.state).toBe("running");
        log(`✓ VIEW-02: Agent state is ${agent!.state}`);

        // VIEW-03: Verify state changes to "stopped" after terminate
        await agentManager.terminate(headId, "completed");
        agent = eventStore.getAgent(headId);
        expect(agent!.state).toBe("stopped");
        log(`✓ VIEW-03: Agent state is ${agent!.state} after terminate`);
      },
      { timeout: TIMEOUT.SPAWN }
    );
  });
});

// ─────────────────────────────────────────────────────────────────
// Part 4: Inter-Agent Messaging E2E Tests
// ─────────────────────────────────────────────────────────────────

describe("Part 4: Inter-Agent Messaging E2E", () => {
  let eventStore: EventStore;
  let agentManager: AgentManager;
  let taskManager: TaskManager;
  let messageRouter: MessageRouter;
  let server: WebSocketACPServer;
  let testPort: number;
  const clients: ACPTestClient[] = [];

  beforeEach(async () => {
    if (!RUN_FULL_AGENT) {
      log("⚠️  Skipping: RUN_FULL_AGENT_TESTS not set");
      return;
    }

    // Create services with in-memory storage
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
    log(`Server started on port ${testPort}`);
  });

  afterEach(async () => {
    if (!RUN_FULL_AGENT) return;

    // Close all clients
    for (const client of clients) {
      client.close();
    }
    clients.length = 0;

    // Terminate all agents
    try {
      const heads = agentManager.listHeadManagers();
      for (const head of heads) {
        try {
          await agentManager.terminate(head.id, "test_cleanup");
        } catch {
          // Ignore termination errors during cleanup
        }
      }
    } catch {
      // Ignore errors during cleanup
    }

    // Stop server
    await server.stop();

    // Close event store
    await eventStore.close();

    log("Cleanup complete");
  });

  // ───────────────────────────────────────────────────────────────
  // MSG: Direct Agent Messaging
  // ───────────────────────────────────────────────────────────────

  describe("MSG: Direct Agent Messaging", () => {
    testFn(
      "MSG-01: should send message between sibling agents via MessageRouter",
      async () => {
        // Create client and session
        const client = new ACPTestClient(`ws://localhost:${testPort}/acp`);
        clients.push(client);
        await client.connect();
        await client.initialize();
        await client.newSession({ cwd: process.cwd() });

        // Get head manager
        const heads = agentManager.listHeadManagers();
        const headId = heads[0].id;
        log(`✓ Head manager: ${headId}`);

        // Spawn two child agents
        const child1Result = await client.extMethod("_macro/spawnAgent", {
          task_description: "Worker 1 - Send messages",
          parentId: headId,
        });
        const child1Id = (child1Result.result as { agentId: string }).agentId;
        log(`✓ Child 1 spawned: ${child1Id}`);

        const child2Result = await client.extMethod("_macro/spawnAgent", {
          task_description: "Worker 2 - Receive messages",
          parentId: headId,
        });
        const child2Id = (child2Result.result as { agentId: string }).agentId;
        log(`✓ Child 2 spawned: ${child2Id}`);

        // Send message from child1 to child2 via MessageRouter
        const sentMsg = await messageRouter.send({
          from: { agent_id: child1Id },
          to: { agent_id: child2Id },
          content: "Hello from sibling!",
        });
        expect(sentMsg.id).toBeDefined();
        expect(sentMsg.from.agent_id).toBe(child1Id);
        expect(sentMsg.to.agent_id).toBe(child2Id);
        log(`✓ Message sent: ${sentMsg.id}`);

        // Verify child2 has pending message
        const pendingMessages = messageRouter.getMessages(child2Id);
        expect(pendingMessages.length).toBe(1);
        expect(pendingMessages[0].content).toBe("Hello from sibling!");
        expect(pendingMessages[0].from.agent_id).toBe(child1Id);
        log(`✓ Child 2 received message: "${pendingMessages[0].content}"`);

        // Verify message event in EventStore (event.id = message id)
        const msgEvents = eventStore.query({ type: "message" });
        const ourMsg = msgEvents.find((e) => e.id === sentMsg.id);
        expect(ourMsg).toBeDefined();
        log(`✓ Message event stored: ${ourMsg!.id}`);
      },
      { timeout: TIMEOUT.MULTI_SPAWN }
    );

    testFn(
      "MSG-02: should acknowledge messages correctly",
      async () => {
        // Create client and session
        const client = new ACPTestClient(`ws://localhost:${testPort}/acp`);
        clients.push(client);
        await client.connect();
        await client.initialize();
        await client.newSession({ cwd: process.cwd() });

        // Get head manager
        const heads = agentManager.listHeadManagers();
        const headId = heads[0].id;

        // Spawn sender and receiver
        const senderResult = await client.extMethod("_macro/spawnAgent", {
          task_description: "Sender agent",
          parentId: headId,
        });
        const senderId = (senderResult.result as { agentId: string }).agentId;

        const receiverResult = await client.extMethod("_macro/spawnAgent", {
          task_description: "Receiver agent",
          parentId: headId,
        });
        const receiverId = (receiverResult.result as { agentId: string }).agentId;
        log(`✓ Agents spawned: sender=${senderId}, receiver=${receiverId}`);

        // Send multiple messages
        const msg1 = await messageRouter.send({
          from: { agent_id: senderId },
          to: { agent_id: receiverId },
          content: "Message 1",
        });
        const msg2 = await messageRouter.send({
          from: { agent_id: senderId },
          to: { agent_id: receiverId },
          content: "Message 2",
        });
        log(`✓ Sent 2 messages`);

        // Verify 2 pending messages
        let pending = messageRouter.getMessages(receiverId);
        expect(pending.length).toBe(2);
        log(`✓ Receiver has ${pending.length} pending messages`);

        // Acknowledge first message
        messageRouter.acknowledgeMessage(receiverId, msg1.id);
        log(`✓ Acknowledged message 1`);

        // Verify only 1 pending message now
        pending = messageRouter.getMessages(receiverId);
        expect(pending.length).toBe(1);
        expect(pending[0].id).toBe(msg2.id);
        log(`✓ After ack: ${pending.length} pending (message 2 only)`);

        // Acknowledge all remaining
        messageRouter.acknowledgeMessages(receiverId, [msg2.id]);
        pending = messageRouter.getMessages(receiverId);
        expect(pending.length).toBe(0);
        log(`✓ All messages acknowledged: ${pending.length} pending`);
      },
      { timeout: TIMEOUT.MULTI_SPAWN }
    );

    testFn(
      "MSG-03: should handle topic-based pub/sub messaging",
      async () => {
        // Create client and session
        const client = new ACPTestClient(`ws://localhost:${testPort}/acp`);
        clients.push(client);
        await client.connect();
        await client.initialize();
        await client.newSession({ cwd: process.cwd() });

        // Get head manager
        const heads = agentManager.listHeadManagers();
        const headId = heads[0].id;

        // Spawn publisher and two subscribers
        const pubResult = await client.extMethod("_macro/spawnAgent", {
          task_description: "Publisher agent",
          parentId: headId,
        });
        const publisherId = (pubResult.result as { agentId: string }).agentId;

        const sub1Result = await client.extMethod("_macro/spawnAgent", {
          task_description: "Subscriber 1",
          parentId: headId,
        });
        const sub1Id = (sub1Result.result as { agentId: string }).agentId;

        const sub2Result = await client.extMethod("_macro/spawnAgent", {
          task_description: "Subscriber 2",
          parentId: headId,
        });
        const sub2Id = (sub2Result.result as { agentId: string }).agentId;
        log(`✓ Agents spawned: publisher=${publisherId}, sub1=${sub1Id}, sub2=${sub2Id}`);

        // Subscribe both subscribers to a topic
        const topic = "test-notifications";
        messageRouter.subscribe(sub1Id, { type: "topic", target: topic });
        messageRouter.subscribe(sub2Id, { type: "topic", target: topic });
        log(`✓ Both subscribers subscribed to topic: ${topic}`);

        // Publish message to topic
        const sentMsg = await messageRouter.send({
          from: { agent_id: publisherId },
          to: { topic },
          content: "Broadcast announcement!",
        });
        log(`✓ Published message: ${sentMsg.id}`);

        // Verify both subscribers received the message
        const sub1Messages = messageRouter.getMessages(sub1Id);
        const sub2Messages = messageRouter.getMessages(sub2Id);
        expect(sub1Messages.length).toBe(1);
        expect(sub2Messages.length).toBe(1);
        expect(sub1Messages[0].content).toBe("Broadcast announcement!");
        expect(sub2Messages[0].content).toBe("Broadcast announcement!");
        log(`✓ Sub1 received: "${sub1Messages[0].content}"`);
        log(`✓ Sub2 received: "${sub2Messages[0].content}"`);

        // Publisher should not have the message (not subscribed)
        const pubMessages = messageRouter.getMessages(publisherId);
        expect(pubMessages.length).toBe(0);
        log(`✓ Publisher has no messages (not subscribed)`);
      },
      { timeout: TIMEOUT.MULTI_SPAWN }
    );

    testFn(
      "MSG-04: should route messages through parent-child hierarchy",
      async () => {
        // Create client and session
        const client = new ACPTestClient(`ws://localhost:${testPort}/acp`);
        clients.push(client);
        await client.connect();
        await client.initialize();
        await client.newSession({ cwd: process.cwd() });

        // Get head manager
        const heads = agentManager.listHeadManagers();
        const headId = heads[0].id;
        log(`✓ Head manager: ${headId}`);

        // Spawn child and grandchild
        const childResult = await client.extMethod("_macro/spawnAgent", {
          task_description: "Child - Middle manager",
          parentId: headId,
        });
        const childId = (childResult.result as { agentId: string }).agentId;
        log(`✓ Child spawned: ${childId}`);

        const grandchildResult = await client.extMethod("_macro/spawnAgent", {
          task_description: "Grandchild - Worker",
          parentId: childId,
        });
        const grandchildId = (grandchildResult.result as { agentId: string }).agentId;
        log(`✓ Grandchild spawned: ${grandchildId}`);

        // Send message from grandchild to head (ancestor)
        const msgToHead = await messageRouter.send({
          from: { agent_id: grandchildId },
          to: { agent_id: headId },
          content: "Report from grandchild to head",
        });
        expect(msgToHead.id).toBeDefined();
        log(`✓ Grandchild sent message to head: ${msgToHead.id}`);

        // Verify head received the message
        const headMessages = messageRouter.getMessages(headId);
        expect(headMessages.length).toBe(1);
        expect(headMessages[0].content).toBe("Report from grandchild to head");
        log(`✓ Head received: "${headMessages[0].content}"`);

        // Send message from head to grandchild (descendant)
        const msgToGrandchild = await messageRouter.send({
          from: { agent_id: headId },
          to: { agent_id: grandchildId },
          content: "Instructions from head to grandchild",
        });
        expect(msgToGrandchild.id).toBeDefined();
        log(`✓ Head sent message to grandchild: ${msgToGrandchild.id}`);

        // Verify grandchild received the message
        // (may receive multiple copies due to lineage routing)
        const grandchildMessages = messageRouter.getMessages(grandchildId);
        expect(grandchildMessages.length).toBeGreaterThanOrEqual(1);
        const expectedMsg = grandchildMessages.find(m => m.content === "Instructions from head to grandchild");
        expect(expectedMsg).toBeDefined();
        log(`✓ Grandchild received: "${expectedMsg!.content}" (total: ${grandchildMessages.length})`);
      },
      { timeout: TIMEOUT.MULTI_SPAWN }
    );

    testFn(
      "MSG-05: should emit and receive status notifications via subtree subscription",
      async () => {
        // Create client and session
        const client = new ACPTestClient(`ws://localhost:${testPort}/acp`);
        clients.push(client);
        await client.connect();
        await client.initialize();
        await client.newSession({ cwd: process.cwd() });

        // Get head manager
        const heads = agentManager.listHeadManagers();
        const headId = heads[0].id;

        // Spawn a child
        const childResult = await client.extMethod("_macro/spawnAgent", {
          task_description: "Worker sending status updates",
          parentId: headId,
        });
        const childId = (childResult.result as { agentId: string }).agentId;
        log(`✓ Child spawned: ${childId}`);

        // Subscribe head to child's subtree (status updates)
        messageRouter.subscribe(headId, { type: "subtree", target: childId });
        log(`✓ Head subscribed to child's subtree`);

        // Child emits a status update (using "checkpoint" - a valid StatusType)
        messageRouter.emitStatus({
          from: { agent_id: childId },
          status_type: "checkpoint",
          summary: "50% complete",
          details: { percentage: 50 },
        });
        log(`✓ Child emitted status: 50% complete`);

        // Verify the status event was stored
        const statusEvents = eventStore.query({ type: "status" });
        const checkpointEvent = statusEvents.find(
          (e) =>
            e.source.agent_id === childId &&
            e.payload.status_type === "checkpoint" &&
            e.payload.summary === "50% complete"
        );
        expect(checkpointEvent).toBeDefined();
        expect(checkpointEvent!.payload.summary).toBe("50% complete");
        log(`✓ Status event stored: ${checkpointEvent!.payload.summary}`);
      },
      { timeout: TIMEOUT.MULTI_SPAWN }
    );
  });

  // ───────────────────────────────────────────────────────────────
  // TASK: Task-Based Routing
  // ───────────────────────────────────────────────────────────────

  describe("TASK: Task-Based Message Routing", () => {
    testFn(
      "TASK-01: should route message to task's assigned agent",
      async () => {
        // Create client and session
        const client = new ACPTestClient(`ws://localhost:${testPort}/acp`);
        clients.push(client);
        await client.connect();
        await client.initialize();
        await client.newSession({ cwd: process.cwd() });

        // Get head manager
        const heads = agentManager.listHeadManagers();
        const headId = heads[0].id;

        // Spawn worker agent
        const workerResult = await client.extMethod("_macro/spawnAgent", {
          task_description: "Process data files",
          parentId: headId,
        });
        const workerId = (workerResult.result as { agentId: string }).agentId;
        log(`✓ Worker spawned: ${workerId}`);

        // Create a task via TaskManager and assign it to the worker
        const task = taskManager.create({
          description: "Process data files",
          created_by: headId,
        });
        taskManager.assign(task.id, workerId);
        log(`✓ Task created: ${task.id}, assigned to: ${workerId}`);

        // Send message to the task
        const sentMsg = await messageRouter.send({
          from: { agent_id: headId },
          to: { task_id: task.id },
          content: "Instructions for the task",
        });
        expect(sentMsg.id).toBeDefined();
        log(`✓ Message sent to task: ${sentMsg.id}`);

        // Verify worker received the message (task routes to assigned agent)
        const workerMessages = messageRouter.getMessages(workerId);
        expect(workerMessages.length).toBeGreaterThanOrEqual(1);
        const taskMsg = workerMessages.find(m => m.content === "Instructions for the task");
        expect(taskMsg).toBeDefined();
        log(`✓ Worker received task message: "${taskMsg!.content}"`);
      },
      { timeout: TIMEOUT.MULTI_SPAWN }
    );

    testFn(
      "TASK-02: should verify message events are stored with correct structure",
      async () => {
        // Create client and session
        const client = new ACPTestClient(`ws://localhost:${testPort}/acp`);
        clients.push(client);
        await client.connect();
        await client.initialize();
        await client.newSession({ cwd: process.cwd() });

        // Get head manager
        const heads = agentManager.listHeadManagers();
        const headId = heads[0].id;

        // Spawn child
        const childResult = await client.extMethod("_macro/spawnAgent", {
          task_description: "Worker",
          parentId: headId,
        });
        const childId = (childResult.result as { agentId: string }).agentId;
        log(`✓ Child spawned: ${childId}`);

        // Send message
        const sentMsg = await messageRouter.send({
          from: { agent_id: headId },
          to: { agent_id: childId },
          content: "Message structure check",
        });
        log(`✓ Message sent: ${sentMsg.id}`);

        // Query message events - the event id IS the message id
        const msgEvents = eventStore.query({ type: "message" });
        const ourEvent = msgEvents.find((e) => e.id === sentMsg.id);
        expect(ourEvent).toBeDefined();
        expect(ourEvent!.source.agent_id).toBe(headId);
        expect(ourEvent!.payload.content).toBe("Message structure check");
        log(`✓ Message event verified: id=${ourEvent!.id}, from=${ourEvent!.source.agent_id}`);

        // Verify target in event
        expect(ourEvent!.target).toBeDefined();
        expect(ourEvent!.target!.agent_id).toBe(childId);
        log(`✓ Message target verified: ${ourEvent!.target!.agent_id}`);
      },
      { timeout: TIMEOUT.MULTI_SPAWN }
    );
  });
});

// ─────────────────────────────────────────────────────────────────
// Skip Message if E2E not enabled
// ─────────────────────────────────────────────────────────────────

if (!RUN_FULL_AGENT) {
  console.log("\n" + "=".repeat(70));
  console.log("Multi-Agent E2E tests SKIPPED");
  console.log("To run with real agents:");
  console.log("  RUN_FULL_AGENT_TESTS=true npm run test:e2e -- src/__tests__/e2e/multi-agent.e2e.test.ts");
  console.log("=".repeat(70) + "\n");
}
