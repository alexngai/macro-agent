/**
 * E2E test: Spawned Agent Session Streaming
 *
 * Verifies that when an agent is spawned via the MCP bridge (`_macro/mcp/spawn_agent`),
 * the fire-and-forget prompt emits MAP events that TUI clients can subscribe to:
 * - session_user_message (before prompt starts)
 * - session_update (for each streaming update during the prompt)
 * - session_prompt_done (after the prompt completes)
 *
 * Also verifies that turns are recorded in EventStore for history persistence.
 *
 * REQUIRES: RUN_FULL_AGENT_TESTS=true environment variable (and authenticated Claude Code)
 *
 * Run with:
 *   RUN_FULL_AGENT_TESTS=true npx vitest run src/__tests__/e2e/spawn-session-streaming.e2e.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { WebSocket } from "ws";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
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
  createCombinedServer,
  type CombinedServer,
  type CombinedServerServices,
} from "../../server/combined-server.js";
import { mapCall } from "../../mcp/map-client.js";

// =============================================================================
// Test Configuration
// =============================================================================

const RUN_FULL_AGENT = !!process.env.RUN_FULL_AGENT_TESTS;
const testFn = RUN_FULL_AGENT ? it : it.skip;

const TIMEOUT = {
  SPAWN_AND_PROMPT: 120_000, // Agent spawn + prompt completion
  EVENT_WAIT: 60_000, // Waiting for individual MAP events
};

const log = (msg: string) => {
  if (RUN_FULL_AGENT) {
    console.log(`[SpawnStreamE2E] ${msg}`);
  }
};

// No event type filter needed — the TUI worker subscribes to ALL events
// by calling client.subscribe() without a filter. The e2e test mirrors this.

// =============================================================================
// Helpers
// =============================================================================

function getRandomPort(): number {
  return 10000 + Math.floor(Math.random() * 50000);
}

interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/**
 * WebSocket MAP client for subscribing to events.
 */
class MAPTestClient {
  private ws!: WebSocket;
  private waiters: Map<
    number,
    { resolve: (r: JsonRpcMessage) => void; reject: (e: Error) => void }
  > = new Map();
  private nextId = 1;
  private url: string;

  readonly notifications: JsonRpcMessage[] = [];

  private notificationWaiters: Array<{
    check: (msg: JsonRpcMessage) => boolean;
    resolve: (msg: JsonRpcMessage) => void;
    reject: (e: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  }> = [];

  constructor(url: string) {
    this.url = url;
  }

  async connect(): Promise<void> {
    this.ws = new WebSocket(this.url);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Connection timeout")),
        5000,
      );
      this.ws.on("open", () => {
        clearTimeout(timeout);
        resolve();
      });
      this.ws.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
      this.ws.on("message", (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString()) as JsonRpcMessage;
          if (msg.id != null) {
            const waiter = this.waiters.get(msg.id);
            if (waiter) {
              this.waiters.delete(msg.id);
              waiter.resolve(msg);
            }
          } else if (msg.method) {
            this.notifications.push(msg);
            for (let i = this.notificationWaiters.length - 1; i >= 0; i--) {
              const w = this.notificationWaiters[i];
              if (w.check(msg)) {
                clearTimeout(w.timeout);
                this.notificationWaiters.splice(i, 1);
                w.resolve(msg);
              }
            }
          }
        } catch {
          // ignore
        }
      });
    });
  }

  async request(method: string, params?: unknown): Promise<JsonRpcMessage> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.waiters.delete(id);
        reject(new Error(`Request timeout: ${method}`));
      }, 30000);
      this.waiters.set(id, {
        resolve: (r) => {
          clearTimeout(timeout);
          resolve(r);
        },
        reject: (e) => {
          clearTimeout(timeout);
          reject(e);
        },
      });
      this.ws.send(JSON.stringify({ jsonrpc: "2.0", method, params, id }));
    });
  }

  waitForNotification(
    check: (msg: JsonRpcMessage) => boolean,
    timeoutMs = 15000,
  ): Promise<JsonRpcMessage> {
    const existing = this.notifications.find(check);
    if (existing) return Promise.resolve(existing);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const idx = this.notificationWaiters.findIndex(
          (w) => w.resolve === resolve,
        );
        if (idx >= 0) this.notificationWaiters.splice(idx, 1);
        reject(
          new Error(
            `Timeout waiting for notification. Received ${this.notifications.length} notifications:\n` +
              this.notifications
                .map((n) => {
                  const p = n.params as Record<string, unknown> | undefined;
                  const evt = p?.event as Record<string, unknown> | undefined;
                  return `  ${n.method} → type=${evt?.type}, agentId=${(evt?.data as Record<string, unknown> | undefined)?.agentId}`;
                })
                .join("\n"),
          ),
        );
      }, timeoutMs);
      this.notificationWaiters.push({ check, resolve, reject, timeout });
    });
  }

  /**
   * Collect all notifications matching a predicate that have arrived so far.
   */
  collectNotifications(check: (msg: JsonRpcMessage) => boolean): JsonRpcMessage[] {
    return this.notifications.filter(check);
  }

  close(): void {
    for (const w of this.notificationWaiters) {
      clearTimeout(w.timeout);
    }
    this.notificationWaiters.length = 0;
    try {
      this.ws?.close();
    } catch {
      // ignore
    }
  }
}

function isEventOfType(type: string) {
  return (msg: JsonRpcMessage) => {
    if (msg.method !== "map/event") return false;
    const params = msg.params as Record<string, unknown> | undefined;
    const event = params?.event as Record<string, unknown> | undefined;
    return event?.type === type;
  };
}

function isEventForAgent(type: string, agentId: string) {
  return (msg: JsonRpcMessage) => {
    if (msg.method !== "map/event") return false;
    const params = msg.params as Record<string, unknown> | undefined;
    const event = params?.event as Record<string, unknown> | undefined;
    if (event?.type !== type) return false;
    const data = event?.data as Record<string, unknown> | undefined;
    return data?.agentId === agentId;
  };
}

function getEventData(msg: JsonRpcMessage): Record<string, unknown> {
  const params = msg.params as Record<string, unknown>;
  const event = params.event as Record<string, unknown>;
  return event.data as Record<string, unknown>;
}

// =============================================================================
// Tests
// =============================================================================

describe("Spawned Agent Session Streaming E2E", () => {
  let eventStore: EventStore;
  let agentManager: AgentManager;
  let taskManager: TaskManager;
  let messageRouter: MessageRouter;
  let server: CombinedServer;
  let port: number;
  let serverUrl: string;
  let tmpDir: string;
  const clients: MAPTestClient[] = [];

  beforeEach(async () => {
    if (!RUN_FULL_AGENT) return;

    port = getRandomPort();
    serverUrl = `http://localhost:${port}`;

    // File-based EventStore so the Claude Code subprocess can access the same DB
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "spawn-stream-e2e-"));
    const instanceId = `test-spawn-stream-${Date.now()}`;
    log(`EventStore baseDir: ${tmpDir}, instanceId: ${instanceId}`);

    eventStore = await createEventStore({ instanceId, baseDir: tmpDir });
    messageRouter = createMessageRouter(eventStore);
    agentManager = createAgentManager(eventStore, messageRouter, {
      defaultPermissionMode: "auto-approve",
      defaultCwd: process.cwd(),
    });
    taskManager = createTaskManager(eventStore);

    const services: CombinedServerServices = {
      eventStore,
      agentManager,
      taskManager,
      messageRouter,
    };

    server = createCombinedServer(services, { port, host: "localhost" });
    await server.start();
    log(`Server started on port ${port}`);
  });

  afterEach(async () => {
    if (!RUN_FULL_AGENT) return;

    for (const c of clients) {
      c.close();
    }
    clients.length = 0;

    // Terminate any running agents
    try {
      for (const agent of agentManager.list()) {
        if (agent.state === "running") {
          try {
            await agentManager.terminate(agent.id, "test_cleanup");
          } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }

    await server.stop().catch(() => {});
    await agentManager.close();
    await eventStore.close();

    // Clean up temp dir
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch { /* ignore */ }

    log("Cleanup complete");
  });

  function createClient(): MAPTestClient {
    const client = new MAPTestClient(`ws://localhost:${port}/map`);
    clients.push(client);
    return client;
  }

  // ─────────────────────────────────────────────────────────────────
  // Core: MAP event streaming during spawned agent prompt
  // ─────────────────────────────────────────────────────────────────

  testFn(
    "subscriber receives session_user_message, session_update, and session_prompt_done when agent is spawned",
    { timeout: TIMEOUT.SPAWN_AND_PROMPT },
    async () => {
      // Step 1: Subscribe to ALL events (no filter) — same as the real TUI worker
      const subscriber = createClient();
      await subscriber.connect();
      const subRes = await subscriber.request("map/subscribe", {});
      expect(subRes.error).toBeUndefined();
      log("Subscriber connected and subscribed (no filter)");

      // Step 2: Seed a root agent (the "caller" that spawns children)
      eventStore.emit({
        type: "spawn",
        source: { agent_id: "system" },
        payload: {
          agent_id: "agent_caller",
          session_id: "sess_caller",
          task: "Root caller agent",
          task_id: "task_caller",
          parent: null,
          config: {},
          cwd: process.cwd(),
        },
      });
      log("Root agent seeded");

      // Step 3: Spawn a real agent via the MCP bridge
      // Give it a simple task so it completes quickly
      let spawnResult: { agent_id: string; session_id: string; task_id: string };
      try {
        spawnResult = await mapCall<{
          agent_id: string;
          session_id: string;
          task_id: string;
        }>(serverUrl, "_macro/mcp/spawn_agent", {
          context: {
            agent_id: "agent_caller",
            session_id: "sess_caller",
            task_id: "task_caller",
            lineage: [],
            cwd: process.cwd(),
          },
          task: "Say exactly: 'Hello from spawned agent'. Do not use any tools. Just respond with that text.",
        });
        log(`Agent spawned: ${spawnResult.agent_id} (session: ${spawnResult.session_id})`);
      } catch (err) {
        throw new Error(`spawn_agent failed: ${(err as Error).message}`);
      }

      const agentId = spawnResult.agent_id;

      // Step 4: Wait for session_user_message
      log("Waiting for session_user_message...");
      const userMsg = await subscriber.waitForNotification(
        isEventForAgent("session_user_message", agentId),
        TIMEOUT.EVENT_WAIT,
      );
      const userMsgData = getEventData(userMsg);
      log(`Got session_user_message: content=${JSON.stringify(userMsgData.content).slice(0, 80)}...`);

      expect(userMsgData.agentId).toBe(agentId);
      expect(userMsgData.sessionId).toBe(spawnResult.session_id);
      expect(userMsgData.content).toContain("Hello from spawned agent");

      // Step 5: Wait for session_prompt_done (agent should finish quickly)
      log("Waiting for session_prompt_done...");
      const promptDone = await subscriber.waitForNotification(
        isEventForAgent("session_prompt_done", agentId),
        TIMEOUT.EVENT_WAIT,
      );
      const promptDoneData = getEventData(promptDone);
      log(`Got session_prompt_done: stopReason=${promptDoneData.stopReason}`);

      expect(promptDoneData.agentId).toBe(agentId);
      expect(promptDoneData.stopReason).toBe("end_turn");

      // Step 6: Verify session_update events were received (at least one)
      const sessionUpdates = subscriber.collectNotifications(
        isEventForAgent("session_update", agentId),
      );
      log(`Got ${sessionUpdates.length} session_update events`);
      expect(sessionUpdates.length).toBeGreaterThan(0);

      // Verify at least one update contains an agent_message_chunk
      const hasTextChunk = sessionUpdates.some((msg) => {
        const data = getEventData(msg);
        const update = data.update as Record<string, unknown> | undefined;
        return update?.sessionUpdate === "agent_message_chunk";
      });
      log(`Has text chunk in updates: ${hasTextChunk}`);
      expect(hasTextChunk).toBe(true);

      // Step 7: Verify event ordering: user_message → updates → prompt_done
      const allSessionEvents = subscriber.collectNotifications((msg) => {
        if (msg.method !== "map/event") return false;
        const params = msg.params as Record<string, unknown> | undefined;
        const event = params?.event as Record<string, unknown> | undefined;
        const data = event?.data as Record<string, unknown> | undefined;
        if (data?.agentId !== agentId) return false;
        const type = event?.type as string;
        return type === "session_user_message" || type === "session_update" || type === "session_prompt_done";
      });

      const eventTypes = allSessionEvents.map((msg) => {
        const params = msg.params as Record<string, unknown>;
        const event = params.event as Record<string, unknown>;
        return event.type;
      });
      log(`Event order: ${eventTypes.join(" → ")}`);

      // First event should be user_message, last should be prompt_done
      expect(eventTypes[0]).toBe("session_user_message");
      expect(eventTypes[eventTypes.length - 1]).toBe("session_prompt_done");

      // Step 8: Verify turns were recorded in EventStore for history persistence
      // Wait a moment for the async turn recording to complete
      await new Promise((r) => setTimeout(r, 2000));

      const turnEvents = eventStore.query({
        type: "turn",
        source_agent_id: agentId,
      });
      log(`Turn events recorded: ${turnEvents.length}`);

      // Should have at least a user turn and an assistant turn
      const userTurns = turnEvents.filter(
        (e) => (e.payload as Record<string, unknown>).participant === "user",
      );
      const assistantTurns = turnEvents.filter(
        (e) => (e.payload as Record<string, unknown>).participant === agentId,
      );

      log(`User turns: ${userTurns.length}, Assistant turns: ${assistantTurns.length}`);
      expect(userTurns.length).toBeGreaterThanOrEqual(1);
      expect(assistantTurns.length).toBeGreaterThanOrEqual(1);

      // Verify the user turn contains the task prompt
      const userTurnPayload = userTurns[0].payload as Record<string, unknown>;
      expect(userTurnPayload.content).toContain("Hello from spawned agent");
      expect(userTurnPayload.conversation_id).toBe(spawnResult.session_id);

      // Verify the assistant turn has content
      const assistantPayload = assistantTurns[0].payload as Record<string, unknown>;
      expect(assistantPayload.content_type).toBe("assistant_response");
      const content = assistantPayload.content as { parts: Array<Record<string, unknown>> };
      expect(content.parts.length).toBeGreaterThan(0);
      expect(content.parts[0].type).toBe("text");
      log(`Assistant response: ${JSON.stringify(content.parts[0].text).slice(0, 100)}...`);

      log("All assertions passed!");
    },
  );

  testFn(
    "multiple subscribers each receive spawned agent session events",
    { timeout: TIMEOUT.SPAWN_AND_PROMPT },
    async () => {
      // Connect two subscribers
      const sub1 = createClient();
      const sub2 = createClient();
      await sub1.connect();
      await sub2.connect();

      await sub1.request("map/subscribe", {});
      await sub2.request("map/subscribe", {});
      log("Two subscribers connected");

      // Seed root agent
      eventStore.emit({
        type: "spawn",
        source: { agent_id: "system" },
        payload: {
          agent_id: "agent_multi_caller",
          session_id: "sess_multi_caller",
          task: "Multi-subscriber test caller",
          task_id: "task_multi_caller",
          parent: null,
          config: {},
          cwd: process.cwd(),
        },
      });

      // Spawn agent
      const spawnResult = await mapCall<{
        agent_id: string;
        session_id: string;
        task_id: string;
      }>(serverUrl, "_macro/mcp/spawn_agent", {
        context: {
          agent_id: "agent_multi_caller",
          session_id: "sess_multi_caller",
          task_id: "task_multi_caller",
          lineage: [],
          cwd: process.cwd(),
        },
        task: "Say exactly: 'test'. Do not use any tools.",
      });
      log(`Agent spawned: ${spawnResult.agent_id}`);

      const agentId = spawnResult.agent_id;

      // Both subscribers should receive session_prompt_done
      const [done1, done2] = await Promise.all([
        sub1.waitForNotification(
          isEventForAgent("session_prompt_done", agentId),
          TIMEOUT.EVENT_WAIT,
        ),
        sub2.waitForNotification(
          isEventForAgent("session_prompt_done", agentId),
          TIMEOUT.EVENT_WAIT,
        ),
      ]);

      expect(getEventData(done1).stopReason).toBe("end_turn");
      expect(getEventData(done2).stopReason).toBe("end_turn");

      // Both should have received session_user_message
      const userMsg1 = sub1.collectNotifications(isEventForAgent("session_user_message", agentId));
      const userMsg2 = sub2.collectNotifications(isEventForAgent("session_user_message", agentId));
      expect(userMsg1.length).toBe(1);
      expect(userMsg2.length).toBe(1);

      // Both should have received session_update events
      const updates1 = sub1.collectNotifications(isEventForAgent("session_update", agentId));
      const updates2 = sub2.collectNotifications(isEventForAgent("session_update", agentId));
      expect(updates1.length).toBeGreaterThan(0);
      expect(updates2.length).toBeGreaterThan(0);
      expect(updates1.length).toBe(updates2.length);

      log(`Both subscribers received ${updates1.length} session_update events`);
      log("Multi-subscriber test passed!");
    },
  );
});
