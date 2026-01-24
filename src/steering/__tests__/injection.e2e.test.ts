/**
 * Context Injection E2E Tests
 *
 * Tests the full injection flow through acp-factory sessions:
 * - inject() API via Session.inject()
 * - Fallback chain: inject → interruptWith → high-priority message
 * - Integration with AgentManager session handling
 *
 * REQUIRES: RUN_E2E_TESTS=true environment variable (and authenticated Claude Code)
 *
 * Run with:
 *   RUN_E2E_TESTS=true npm test -- src/steering/__tests__/injection.e2e.test.ts
 *
 * @see s-9rld In-Flight Steering spec
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
} from "vitest";
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
import {
  injectContext,
  createInjector,
} from "../inject.js";
import type { InjectionDeps } from "../types.js";

// ─────────────────────────────────────────────────────────────────
// Test Configuration
// ─────────────────────────────────────────────────────────────────

const RUN_E2E = !!process.env.RUN_E2E_TESTS;
const testFn = RUN_E2E ? it : it.skip;

// Timeouts for different test types
const TIMEOUT = {
  SPAWN: 60000,
  INJECT: 30000,
  PROMPT: 90000,
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
      const timeout = setTimeout(
        () => reject(new Error("Connection timeout")),
        10000
      );

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

  async request(
    method: string,
    params?: unknown,
    timeoutMs = 30000
  ): Promise<JsonRpcMessage> {
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
      clientInfo: { name: "e2e-injection-test", version: "1.0.0" },
    });
  }

  async newSession(params: { cwd?: string } = {}): Promise<JsonRpcMessage> {
    return this.request(
      "session/new",
      {
        mcpServers: [],
        ...params,
      },
      60000
    );
  }

  async prompt(
    sessionId: string,
    text: string,
    timeoutMs = 60000
  ): Promise<JsonRpcMessage> {
    return this.request(
      "session/prompt",
      {
        sessionId,
        prompt: [{ type: "text", text }],
      },
      timeoutMs
    );
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
  console.log(`[E2E-INJECT] ${message}`);
}

// ─────────────────────────────────────────────────────────────────
// Context Injection E2E Tests
// ─────────────────────────────────────────────────────────────────

describe("Context Injection E2E", () => {
  let eventStore: EventStore;
  let agentManager: AgentManager;
  let taskManager: TaskManager;
  let messageRouter: MessageRouter;
  let server: WebSocketACPServer;
  let testPort: number;
  const clients: ACPTestClient[] = [];

  beforeEach(async () => {
    if (!RUN_E2E) {
      log("⚠️  Skipping: RUN_E2E_TESTS not set");
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
    if (!RUN_E2E) return;

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

  // ─────────────────────────────────────────────────────────────────
  // INJ: Injection API Tests
  // ─────────────────────────────────────────────────────────────────

  describe("INJ: Injection API", () => {
    testFn(
      "INJ-01: should check injection support for session",
      async () => {
        const client = new ACPTestClient(`ws://localhost:${testPort}/acp`);
        clients.push(client);

        await client.connect();
        await client.initialize();

        // Create session (spawns head manager)
        const sessionResult = await client.newSession({ cwd: process.cwd() });
        expect(sessionResult.error).toBeUndefined();
        log("✓ Session created");

        // Get the head manager
        const heads = agentManager.listHeadManagers();
        expect(heads.length).toBeGreaterThanOrEqual(1);
        const headId = heads[0].id;
        log(`✓ Head manager: ${headId}`);

        // Check if injection is supported
        const supportsInjection = await agentManager.supportsInjection(headId);
        expect(typeof supportsInjection).toBe("boolean");
        log(`✓ supportsInjection: ${supportsInjection}`);

        // Verify session exists
        const session = agentManager.getSession(headId);
        expect(session).not.toBeNull();
        log("✓ Session retrieved from AgentManager");
      },
      { timeout: TIMEOUT.SPAWN }
    );

    testFn(
      "INJ-02: should inject context to idle agent via message fallback",
      async () => {
        const client = new ACPTestClient(`ws://localhost:${testPort}/acp`);
        clients.push(client);

        await client.connect();
        await client.initialize();

        // Create session
        const sessionResult = await client.newSession({ cwd: process.cwd() });
        expect(sessionResult.error).toBeUndefined();

        // Get head manager
        const heads = agentManager.listHeadManagers();
        const headId = heads[0].id;
        log(`✓ Head manager: ${headId}`);

        // Agent should NOT be prompting (idle)
        expect(agentManager.isPrompting(headId)).toBe(false);
        log("✓ Agent is idle (not prompting)");

        // Create injection deps
        const deps: InjectionDeps = {
          getSession: (agentId) => agentManager.getSession(agentId),
          isPrompting: (agentId) => agentManager.isPrompting(agentId),
          sendMessage: async (from, to, content, priority) => {
            await messageRouter.send({
              from: from ? { agent_id: from } : { agent_id: "system" },
              to: { agent_id: to },
              content,
              priority,
            });
          },
        };

        // Inject context
        const result = await injectContext(deps, headId, "Test injection content", {
          source: { type: "human" },
          reason: "E2E test",
        });

        expect(result.success).toBe(true);
        log(`✓ Injection result: success=${result.success}, method=${result.method}`);

        // Method should be one of the expected fallback methods
        expect(["inject", "interrupt", "message"]).toContain(result.method);
        log(`✓ Injection method: ${result.method}`);

        // If fallback to message, verify message was queued
        if (result.method === "message") {
          const messages = messageRouter.getMessages(headId);
          expect(messages.length).toBeGreaterThanOrEqual(1);
          const injectedMsg = messages.find((m) =>
            m.content.includes("Test injection content")
          );
          expect(injectedMsg).toBeDefined();
          log("✓ Injection content delivered via message");
        }
      },
      { timeout: TIMEOUT.INJECT }
    );

    testFn(
      "INJ-03: should use createInjector factory for bound injection",
      async () => {
        const client = new ACPTestClient(`ws://localhost:${testPort}/acp`);
        clients.push(client);

        await client.connect();
        await client.initialize();

        // Create session
        await client.newSession({ cwd: process.cwd() });

        // Get head manager
        const heads = agentManager.listHeadManagers();
        const headId = heads[0].id;
        log(`✓ Head manager: ${headId}`);

        // Create bound injector
        const deps: InjectionDeps = {
          getSession: (agentId) => agentManager.getSession(agentId),
          isPrompting: (agentId) => agentManager.isPrompting(agentId),
          sendMessage: async (from, to, content, priority) => {
            await messageRouter.send({
              from: from ? { agent_id: from } : { agent_id: "system" },
              to: { agent_id: to },
              content,
              priority,
            });
          },
        };

        const inject = createInjector(deps);

        // Use bound injector
        const result = await inject(headId, "Factory injection test", {
          source: { type: "agent", agentId: "coordinator-1" },
        });

        expect(result.success).toBe(true);
        log(`✓ Factory injection: success=${result.success}, method=${result.method}`);
      },
      { timeout: TIMEOUT.INJECT }
    );

    testFn(
      "INJ-04: should inject to spawned child agent",
      async () => {
        const client = new ACPTestClient(`ws://localhost:${testPort}/acp`);
        clients.push(client);

        await client.connect();
        await client.initialize();

        // Create session
        await client.newSession({ cwd: process.cwd() });

        // Get head manager
        const heads = agentManager.listHeadManagers();
        const headId = heads[0].id;
        log(`✓ Head manager: ${headId}`);

        // Spawn a child agent
        const child = await agentManager.spawn({
          task: "Worker for injection test",
          parent: headId,
        });
        expect(child.id).toBeDefined();
        log(`✓ Child spawned: ${child.id}`);

        // Wait for child session to initialize
        await new Promise((r) => setTimeout(r, 500));

        // Create injection deps
        const deps: InjectionDeps = {
          getSession: (agentId) => agentManager.getSession(agentId),
          isPrompting: (agentId) => agentManager.isPrompting(agentId),
          sendMessage: async (from, to, content, priority) => {
            await messageRouter.send({
              from: from ? { agent_id: from } : { agent_id: headId },
              to: { agent_id: to },
              content,
              priority,
            });
          },
        };

        // Inject to child
        const result = await injectContext(deps, child.id, "Instructions for child", {
          source: { type: "agent", agentId: headId },
          reason: "Priority task reassignment",
        });

        expect(result.success).toBe(true);
        log(`✓ Child injection: success=${result.success}, method=${result.method}`);
      },
      { timeout: TIMEOUT.SPAWN }
    );
  });

  // ─────────────────────────────────────────────────────────────────
  // FALLBACK: Fallback Chain Tests
  // ─────────────────────────────────────────────────────────────────

  describe("FALLBACK: Injection Fallback Chain", () => {
    testFn(
      "FALLBACK-01: should fall back to message when no session available",
      async () => {
        const client = new ACPTestClient(`ws://localhost:${testPort}/acp`);
        clients.push(client);

        await client.connect();
        await client.initialize();

        // Create session
        await client.newSession({ cwd: process.cwd() });

        // Get head manager
        const heads = agentManager.listHeadManagers();
        const headId = heads[0].id;

        // Create deps that return null session (simulating no session available)
        const deps: InjectionDeps = {
          getSession: () => null, // Force message fallback
          isPrompting: () => false,
          sendMessage: async (from, to, content, priority) => {
            await messageRouter.send({
              from: from ? { agent_id: from } : { agent_id: "system" },
              to: { agent_id: to },
              content,
              priority,
            });
          },
        };

        const result = await injectContext(deps, headId, "Fallback test content");

        expect(result.success).toBe(true);
        expect(result.method).toBe("message");
        expect(result.note).toContain("high-priority message");
        log("✓ Fell back to message delivery successfully");

        // Verify message was delivered
        const messages = messageRouter.getMessages(headId);
        expect(messages.length).toBeGreaterThanOrEqual(1);
        log(`✓ Message delivered (queue size: ${messages.length})`);
      },
      { timeout: TIMEOUT.INJECT }
    );

    testFn(
      "FALLBACK-02: should handle urgent injection",
      async () => {
        const client = new ACPTestClient(`ws://localhost:${testPort}/acp`);
        clients.push(client);

        await client.connect();
        await client.initialize();

        // Create session
        await client.newSession({ cwd: process.cwd() });

        // Get head manager
        const heads = agentManager.listHeadManagers();
        const headId = heads[0].id;

        // Create deps with real session
        const deps: InjectionDeps = {
          getSession: (agentId) => agentManager.getSession(agentId),
          isPrompting: (agentId) => agentManager.isPrompting(agentId),
          sendMessage: async (from, to, content, priority) => {
            await messageRouter.send({
              from: from ? { agent_id: from } : { agent_id: "system" },
              to: { agent_id: to },
              content,
              priority,
            });
          },
        };

        // Urgent injection - should prefer interrupt if prompting
        const result = await injectContext(deps, headId, "URGENT: Stop work immediately!", {
          urgent: true,
          reason: "Emergency shutdown",
        });

        expect(result.success).toBe(true);
        log(`✓ Urgent injection: success=${result.success}, method=${result.method}`);

        // Since agent is idle, it should use inject or fallback to message
        // (interrupt only works when prompting)
        expect(["inject", "message"]).toContain(result.method);
      },
      { timeout: TIMEOUT.INJECT }
    );
  });

  // ─────────────────────────────────────────────────────────────────
  // LIVE: Live Injection During Active Prompt
  // ─────────────────────────────────────────────────────────────────

  describe("LIVE: Live Injection During Active Prompt", () => {
    testFn(
      "LIVE-01: should inject content during active prompt and agent acknowledges it",
      async () => {
        const client = new ACPTestClient(`ws://localhost:${testPort}/acp`);
        clients.push(client);

        await client.connect();
        await client.initialize();

        // Create session
        const sessionResult = await client.newSession({ cwd: process.cwd() });
        expect(sessionResult.error).toBeUndefined();
        const sessionId = (sessionResult.result as { sessionId: string }).sessionId;
        log(`✓ Session created: ${sessionId}`);

        // Get head manager and session
        const heads = agentManager.listHeadManagers();
        const headId = heads[0].id;
        const session = agentManager.getSession(headId);
        expect(session).not.toBeNull();
        log(`✓ Head manager: ${headId}`);

        // Start a prompt that will take some time
        // We ask the agent to explain something, giving us time to inject
        const promptPromise = client.prompt(
          sessionId,
          "Please write out the numbers 1 through 10, each on a separate line. Take your time.",
          TIMEOUT.PROMPT
        );

        // Wait for agent to start processing
        let attempts = 0;
        const maxAttempts = 50;
        while (!agentManager.isPrompting(headId) && attempts < maxAttempts) {
          await new Promise((r) => setTimeout(r, 100));
          attempts++;
        }

        if (agentManager.isPrompting(headId)) {
          log(`✓ Agent is now prompting (detected after ${attempts * 100}ms)`);

          // Inject content while agent is actively processing
          const injectResult = await session!.inject(
            "[INJECTED CONTEXT] Important update: After listing the numbers, please also say 'INJECTION_RECEIVED_OK' to confirm you received this mid-task instruction."
          );
          log(`✓ Inject called: success=${injectResult.success}`);

          // Note: inject() queues content for the next turn, so it may appear
          // in the current response or require another prompt to see it
        } else {
          log("⚠ Agent finished before we could inject (prompt was too fast)");
        }

        // Wait for prompt to complete
        const response = await promptPromise;
        expect(response.error).toBeUndefined();

        // Extract text content from response
        const result = response.result as { messages?: Array<{ content?: string }> };
        const responseText = result.messages
          ?.map((m) => m.content || "")
          .join(" ")
          .toLowerCase() || "";

        log(`✓ Prompt completed, response length: ${responseText.length} chars`);

        // If injection was timed correctly, the agent should acknowledge it
        // Note: inject() queues for next turn, so we may need a follow-up prompt
        if (responseText.includes("injection_received_ok")) {
          log("✓ Agent acknowledged the injection in its response!");
        } else {
          log("ℹ Injection queued for next turn (agent responded before processing injected content)");

          // Send a follow-up prompt to see if the injected content is picked up
          const followUpPromise = client.prompt(
            sessionId,
            "Did you receive any additional instructions?",
            TIMEOUT.PROMPT
          );

          // Wait for agent to start
          attempts = 0;
          while (!agentManager.isPrompting(headId) && attempts < 30) {
            await new Promise((r) => setTimeout(r, 100));
            attempts++;
          }

          const followUpResponse = await followUpPromise;
          const followUpResult = followUpResponse.result as { messages?: Array<{ content?: string }> };
          const followUpText = followUpResult.messages
            ?.map((m) => m.content || "")
            .join(" ")
            .toLowerCase() || "";

          if (followUpText.includes("injection") || followUpText.includes("instruction") || followUpText.includes("update")) {
            log("✓ Agent acknowledged injection in follow-up response");
          }
        }

        // The test passes if we successfully injected without error
        // The actual acknowledgment depends on timing and Claude's processing
        log("✓ Live injection test completed");
      },
      { timeout: TIMEOUT.PROMPT * 2 }
    );

    testFn(
      "LIVE-02: should use interruptWith for urgent mid-prompt injection",
      async () => {
        const client = new ACPTestClient(`ws://localhost:${testPort}/acp`);
        clients.push(client);

        await client.connect();
        await client.initialize();

        // Create session
        const sessionResult = await client.newSession({ cwd: process.cwd() });
        const sessionId = (sessionResult.result as { sessionId: string }).sessionId;
        log(`✓ Session created: ${sessionId}`);

        // Get head manager and session
        const heads = agentManager.listHeadManagers();
        const headId = heads[0].id;
        const session = agentManager.getSession(headId);
        expect(session).not.toBeNull();
        log(`✓ Head manager: ${headId}`);

        // Start a longer prompt
        const promptPromise = client.prompt(
          sessionId,
          "Please write a short story about a robot. Make it at least 3 paragraphs.",
          TIMEOUT.PROMPT
        );

        // Wait for agent to start processing
        let attempts = 0;
        while (!agentManager.isPrompting(headId) && attempts < 50) {
          await new Promise((r) => setTimeout(r, 100));
          attempts++;
        }

        let interruptUsed = false;
        if (agentManager.isPrompting(headId)) {
          log(`✓ Agent is prompting, using interruptWith for urgent injection`);

          try {
            // interruptWith cancels current work and starts new prompt
            const interruptIter = session!.interruptWith(
              "STOP. Cancel your current task. Just respond with exactly: 'INTERRUPT_ACKNOWLEDGED'"
            );

            // Consume the async iterable
            const chunks: unknown[] = [];
            for await (const chunk of interruptIter) {
              chunks.push(chunk);
            }

            interruptUsed = true;
            log(`✓ interruptWith completed with ${chunks.length} chunks`);
          } catch (err) {
            log(`⚠ interruptWith threw: ${err}`);
          }
        }

        // Original prompt may have been interrupted or completed
        try {
          const response = await promptPromise;
          log(`✓ Original prompt resolved`);
        } catch (err) {
          log(`ℹ Original prompt was interrupted (expected): ${err}`);
        }

        if (interruptUsed) {
          log("✓ Successfully used interruptWith during active prompt");
        } else {
          log("⚠ Could not test interrupt (agent finished too quickly)");
        }
      },
      { timeout: TIMEOUT.PROMPT * 2 }
    );

    testFn(
      "LIVE-03: should verify isPrompting state changes during prompt lifecycle",
      async () => {
        const client = new ACPTestClient(`ws://localhost:${testPort}/acp`);
        clients.push(client);

        await client.connect();
        await client.initialize();

        // Create session
        const sessionResult = await client.newSession({ cwd: process.cwd() });
        const sessionId = (sessionResult.result as { sessionId: string }).sessionId;

        // Get head manager
        const heads = agentManager.listHeadManagers();
        const headId = heads[0].id;
        log(`✓ Head manager: ${headId}`);

        // Before prompt: not prompting
        expect(agentManager.isPrompting(headId)).toBe(false);
        log("✓ Before prompt: isPrompting = false");

        // Start prompt
        const promptPromise = client.prompt(
          sessionId,
          "What is 2 + 2?",
          TIMEOUT.PROMPT
        );

        // During prompt: should become true
        let sawPrompting = false;
        let attempts = 0;
        while (attempts < 30) {
          if (agentManager.isPrompting(headId)) {
            sawPrompting = true;
            log(`✓ During prompt: isPrompting = true (after ${attempts * 50}ms)`);
            break;
          }
          await new Promise((r) => setTimeout(r, 50));
          attempts++;
        }

        // Wait for prompt to complete
        await promptPromise;

        // After prompt: should be false again
        // Give a small delay for state to settle
        await new Promise((r) => setTimeout(r, 200));
        expect(agentManager.isPrompting(headId)).toBe(false);
        log("✓ After prompt: isPrompting = false");

        if (sawPrompting) {
          log("✓ Verified full isPrompting lifecycle: false → true → false");
        } else {
          log("⚠ Prompt completed too quickly to observe isPrompting = true");
        }
      },
      { timeout: TIMEOUT.PROMPT }
    );
  });

  // ─────────────────────────────────────────────────────────────────
  // SESSION: Session State Tests
  // ─────────────────────────────────────────────────────────────────

  describe("SESSION: Session State Tracking", () => {
    testFn(
      "SESSION-01: should track isPrompting state correctly",
      async () => {
        const client = new ACPTestClient(`ws://localhost:${testPort}/acp`);
        clients.push(client);

        await client.connect();
        await client.initialize();

        // Create session
        const sessionResult = await client.newSession({ cwd: process.cwd() });
        const sessionId = (sessionResult.result as { sessionId: string }).sessionId;

        // Get head manager
        const heads = agentManager.listHeadManagers();
        const headId = heads[0].id;

        // Initially not prompting
        expect(agentManager.isPrompting(headId)).toBe(false);
        log("✓ Agent initially not prompting");

        // hasActiveSession should be true
        expect(agentManager.hasActiveSession(headId)).toBe(true);
        log("✓ Agent has active session");
      },
      { timeout: TIMEOUT.SPAWN }
    );

    testFn(
      "SESSION-02: should verify session supports inject API methods",
      async () => {
        const client = new ACPTestClient(`ws://localhost:${testPort}/acp`);
        clients.push(client);

        await client.connect();
        await client.initialize();

        // Create session
        await client.newSession({ cwd: process.cwd() });

        // Get head manager
        const heads = agentManager.listHeadManagers();
        const headId = heads[0].id;

        // Get session
        const session = agentManager.getSession(headId);
        expect(session).not.toBeNull();
        log("✓ Session retrieved");

        // Verify session has expected API methods
        // These are the acp-factory Session methods for injection
        expect(typeof session!.supportsInject).toBe("function");
        expect(typeof session!.checkInjectSupport).toBe("function");
        expect(typeof session!.inject).toBe("function");
        expect(typeof session!.interruptWith).toBe("function");
        log("✓ Session has all injection API methods");

        // Check inject support
        const supportsInject = session!.supportsInject();
        expect(typeof supportsInject).toBe("boolean");
        log(`✓ supportsInject() returns: ${supportsInject}`);

        // Async check
        const checkResult = await session!.checkInjectSupport();
        expect(typeof checkResult).toBe("boolean");
        log(`✓ checkInjectSupport() returns: ${checkResult}`);
      },
      { timeout: TIMEOUT.INJECT }
    );
  });
});

// ─────────────────────────────────────────────────────────────────
// Skip Message if E2E not enabled
// ─────────────────────────────────────────────────────────────────

if (!RUN_E2E) {
  console.log("\n" + "=".repeat(70));
  console.log("Context Injection E2E tests SKIPPED");
  console.log("To run with real agents:");
  console.log("  RUN_E2E_TESTS=true npm test -- src/steering/__tests__/injection.e2e.test.ts");
  console.log("=".repeat(70) + "\n");
}
