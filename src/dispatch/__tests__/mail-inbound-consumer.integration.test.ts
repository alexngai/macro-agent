/**
 * Integration tests for the mail-bridge → mail-inbound-consumer chain.
 *
 * What these tests verify that the mocked unit tests cannot:
 *   - The real `setupMailBridge` fires `inboxAdapter.send` with the correct
 *     shape (type:"data", schema, _conversationId) when a hub notification arrives.
 *   - That send() outcome flows into the real `createMailInboundConsumer`'s
 *     inbox.message listener — i.e. the two modules compose correctly.
 *   - Deduplication across N re-deliveries of the same taskId.
 *   - The "type: data missing" regression: if a future maintainer removes the
 *     explicit `type: "data"` field from mail-bridge, the consumer's schema
 *     check still classifies because the bridge restores it before send().
 *
 * Real modules used:
 *   - setupMailBridge (map/mail-bridge.ts)
 *   - createMailInboundConsumer (dispatch/mail-inbound-consumer.ts)
 *
 * Everything else is faked via minimal in-process objects — no SQLite, no
 * IPC sockets, no subprocesses.
 */

import { describe, it, expect, beforeEach, vi, type MockedFunction } from "vitest";
import { setupMailBridge, type MailBridgeConnection } from "../../map/mail-bridge.js";
import {
  createMailInboundConsumer,
  type InboxEvents,
  type InboxMessageEvent,
  type MailInboundSidecar,
} from "../mail-inbound-consumer.js";
import type { AgentManager } from "../../agent/agent-manager.js";
import type { AgentStore } from "../../agent/agent-store.js";

// ─────────────────────────────────────────────────────────────────
// Fake InboxAdapter that acts as the glue between bridge and consumer.
//
// The bridge calls inboxAdapter.send(from, to, content, opts).
// The consumer listens on inboxEvents (which is inboxAdapter.getInbox().events).
//
// In production, DefaultInboxAdapter routes the send() call through
// agent-inbox's router, which then fires inbox.events("inbox.message").
// Here we short-circuit that: our fake send() directly fires the event
// so we don't need SQLite or IPC.
// ─────────────────────────────────────────────────────────────────

type MessageListener = (event: InboxMessageEvent) => void;

function buildFakeInboxAdapter(dispatcherAgentId: string) {
  const listeners = new Set<MessageListener>();

  // InboxEvents interface for the consumer
  const inboxEvents: InboxEvents = {
    on(_evt: string, fn: MessageListener) {
      listeners.add(fn);
    },
    off(_evt: string, fn: MessageListener) {
      listeners.delete(fn);
    },
  };

  const sendSpy = vi.fn(
    async (
      from: string,
      to: string,
      content: Record<string, unknown>,
      _opts?: unknown,
    ): Promise<string> => {
      // Short-circuit: fire the inbox.message event directly so the consumer
      // receives what the bridge sends — this is the key integration coupling.
      const event: InboxMessageEvent = {
        agentId: to,
        message: {
          id: `synthetic-${Math.random()}`,
          content,
          sender_id: from,
        },
      };
      for (const fn of listeners) fn(event);
      return "msg-synthetic";
    },
  );

  const registerAgentSpy = vi.fn().mockResolvedValue(undefined);

  const inboxAdapter = {
    registerAgent: registerAgentSpy,
    send: sendSpy,
  };

  return { inboxAdapter, inboxEvents, sendSpy, registerAgentSpy };
}

// ─────────────────────────────────────────────────────────────────
// Fake MAP connection — captures notifications and lets tests fire them
// ─────────────────────────────────────────────────────────────────

function buildFakeConnection(): MailBridgeConnection & {
  sendNotification: MockedFunction<(method: string, params: unknown) => void>;
  _fire: (params: unknown) => Promise<void>;
  offNotification: ReturnType<typeof vi.fn>;
} {
  let mailTurnHandler: ((params: unknown) => void | Promise<void>) | null = null;

  const sendNotification = vi.fn();
  const offNotification = vi.fn();

  return {
    onNotification(method: string, handler: (params: unknown) => void | Promise<void>) {
      if (method === "mail/turn.received") mailTurnHandler = handler;
    },
    offNotification,
    sendNotification,
    async _fire(params: unknown) {
      if (mailTurnHandler) await mailTurnHandler(params);
    },
  };
}

// ─────────────────────────────────────────────────────────────────
// Fake AgentManager — captures spawns and exposes lifecycle firing
// ─────────────────────────────────────────────────────────────────

function buildFakeAgentManager(spawnedId = "agent-001") {
  const lifecycleListeners: Array<(e: { type: string; agent: { id: string }; reason: string }) => void> = [];

  const spawnFn = vi.fn().mockResolvedValue({ id: spawnedId });

  const manager: Partial<AgentManager> = {
    spawn: spawnFn as unknown as AgentManager["spawn"],
    onLifecycleEvent(cb) {
      lifecycleListeners.push(cb as never);
      return () => {
        const idx = lifecycleListeners.indexOf(cb as never);
        if (idx >= 0) lifecycleListeners.splice(idx, 1);
      };
    },
  };

  function fireLifecycle(e: { type: string; agent: { id: string }; reason: string }) {
    for (const fn of lifecycleListeners) fn(e);
  }

  return { manager, spawnFn, fireLifecycle };
}

// ─────────────────────────────────────────────────────────────────
// Fake AgentStore
// ─────────────────────────────────────────────────────────────────

function buildFakeAgentStore(summary?: string): Partial<AgentStore> {
  return {
    getAgent: vi.fn().mockReturnValue(
      summary !== undefined
        ? { metadata: { _lastSummary: summary } }
        : { metadata: {} },
    ),
  };
}

// ─────────────────────────────────────────────────────────────────
// Fake sidecar
// ─────────────────────────────────────────────────────────────────

function buildFakeSidecar(): MailInboundSidecar & {
  postMailTurn: MockedFunction<NonNullable<MailInboundSidecar["postMailTurn"]>>;
} {
  return { postMailTurn: vi.fn().mockResolvedValue(undefined) };
}

// ─────────────────────────────────────────────────────────────────
// Helper: build a hub envelope matching what OpenHive sends
// ─────────────────────────────────────────────────────────────────

function hubNotification(opts: {
  conversationId: string;
  taskId: string;
  prompt: string;
  participantId?: string;
}) {
  return {
    conversation_id: opts.conversationId,
    turn_id: `turn-${Math.random().toString(36).slice(2)}`,
    participant_id: opts.participantId ?? "openhive:dispatcher",
    content_type: "application/json",
    content: JSON.stringify({
      type: "x-dispatch/work",
      body: {
        taskId: opts.taskId,
        prompt: opts.prompt,
        role: "worker",
      },
    }),
  };
}

// ─────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────

const DISPATCHER_ID = "dispatcher:integration-test:1234:abc";

// ─────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────

describe("mail-bridge → mail-inbound-consumer integration", () => {
  let conn: ReturnType<typeof buildFakeConnection>;
  let inboxAdapter: ReturnType<typeof buildFakeInboxAdapter>["inboxAdapter"];
  let inboxEvents: InboxEvents;
  let sendSpy: ReturnType<typeof buildFakeInboxAdapter>["sendSpy"];
  let am: ReturnType<typeof buildFakeAgentManager>;
  let store: Partial<AgentStore>;
  let sidecar: ReturnType<typeof buildFakeSidecar>;

  beforeEach(() => {
    conn = buildFakeConnection();
    const fake = buildFakeInboxAdapter(DISPATCHER_ID);
    inboxAdapter = fake.inboxAdapter;
    inboxEvents = fake.inboxEvents;
    sendSpy = fake.sendSpy;
    am = buildFakeAgentManager("agent-001");
    store = buildFakeAgentStore("WIDGET_SENTINEL_42 hello");
    sidecar = buildFakeSidecar();
  });

  // ── Test 1: Happy path end-to-end ─────────────────────────────
  it(
    "drives hub notification through bridge into consumer: spawn then postMailTurn",
    async () => {
      // Wire the real bridge
      await setupMailBridge({
        connection: conn,
        inboxAdapter: inboxAdapter as never,
        dispatcherAgentId: DISPATCHER_ID,
      });

      // Wire the real consumer
      createMailInboundConsumer({
        dispatcherAgentId: DISPATCHER_ID,
        inboxEvents,
        agentManager: am.manager as AgentManager,
        agentStore: store as AgentStore,
        getSidecar: () => sidecar,
      });

      const CONV_ID = "conv-integration-001";
      const TASK_ID = "task-widget-42";

      // Fire the hub notification — this is what OpenHive sends over MAP
      await conn._fire(hubNotification({ conversationId: CONV_ID, taskId: TASK_ID, prompt: "Build widget" }));

      // 1. Bridge must have called inboxAdapter.send once
      expect(sendSpy).toHaveBeenCalledOnce();

      const [from, to, content, opts] = sendSpy.mock.calls[0];
      expect(from).toBe("openhive:dispatcher");
      expect(to).toBe(DISPATCHER_ID);

      // 2. Content must have type:"data", correct schema, _conversationId
      expect(content).toMatchObject({
        type: "data",
        schema: "x-dispatch/work",
        data: {
          taskId: TASK_ID,
          prompt: "Build widget",
          role: "worker",
        },
        _conversationId: CONV_ID,
      });
      // Verify legacy 'body' key is NOT present (bridge translated it)
      expect(content).not.toHaveProperty("body");

      // 3. Allow the async spawn to settle
      await new Promise((r) => setTimeout(r, 20));

      // 4. Consumer must have spawned one worker with correct params
      expect(am.spawnFn).toHaveBeenCalledOnce();
      expect(am.spawnFn).toHaveBeenCalledWith(
        expect.objectContaining({
          task: "Build widget",
          task_id: TASK_ID,
          role: "worker",
          parent: null,
        }),
      );

      // 5. Fire lifecycle stopped for the spawned agent
      am.fireLifecycle({ type: "stopped", agent: { id: "agent-001" }, reason: "completed" });
      await new Promise((r) => setTimeout(r, 20));

      // 6. Consumer must have called postMailTurn with original convId + sentinel
      expect(sidecar.postMailTurn).toHaveBeenCalledOnce();
      expect(sidecar.postMailTurn).toHaveBeenCalledWith(
        CONV_ID,
        "agent-001",
        "WIDGET_SENTINEL_42 hello",
      );
    },
  );

  // ── Test 2: Deduplication under N re-deliveries ───────────────
  it(
    "deduplicates 50 re-deliveries of the same taskId: spawn and postMailTurn called only once",
    async () => {
      await setupMailBridge({
        connection: conn,
        inboxAdapter: inboxAdapter as never,
        dispatcherAgentId: DISPATCHER_ID,
      });

      createMailInboundConsumer({
        dispatcherAgentId: DISPATCHER_ID,
        inboxEvents,
        agentManager: am.manager as AgentManager,
        agentStore: store as AgentStore,
        getSidecar: () => sidecar,
      });

      const CONV_ID = "conv-dedup-test";
      const TASK_ID = "task-dedup-99";
      const notification = hubNotification({ conversationId: CONV_ID, taskId: TASK_ID, prompt: "Dedup me" });

      // Fire 50 identical notifications (same taskId)
      const fires: Promise<void>[] = [];
      for (let i = 0; i < 50; i++) {
        fires.push(conn._fire(notification));
      }
      await Promise.all(fires);
      await new Promise((r) => setTimeout(r, 50));

      // Bridge sends 50 times (it's not the bridge's job to dedup — that's the consumer)
      expect(sendSpy).toHaveBeenCalledTimes(50);

      // Consumer dedupes: spawn called exactly once
      expect(am.spawnFn).toHaveBeenCalledTimes(1);

      // Fire stopped for the single spawned agent
      am.fireLifecycle({ type: "stopped", agent: { id: "agent-001" }, reason: "completed" });
      await new Promise((r) => setTimeout(r, 20));

      // postMailTurn called exactly once
      expect(sidecar.postMailTurn).toHaveBeenCalledTimes(1);
    },
  );

  // ── Test 3: Regression guard — type:"data" must be present ────
  it(
    "bridge always adds type:'data' so consumer classifies the schema correctly",
    async () => {
      // This test guards the bug described in the mail-bridge comment:
      //   "Without `type: "data"`, agent-inbox's normalizeContent wraps the
      //   object as { type:"data", data: original }, burying `schema` one
      //   level deeper and breaking createMailInboundConsumer's filter."
      //
      // We verify: even if someone sends a payload WITHOUT `type` (e.g., a
      // hub that sends canonical {schema, data} already), the bridge still
      // produces a content object with top-level `type: "data"` so
      // normalizeContent passes it through without re-wrapping.

      await setupMailBridge({
        connection: conn,
        inboxAdapter: inboxAdapter as never,
        dispatcherAgentId: DISPATCHER_ID,
      });

      createMailInboundConsumer({
        dispatcherAgentId: DISPATCHER_ID,
        inboxEvents,
        agentManager: am.manager as AgentManager,
        agentStore: store as AgentStore,
        getSidecar: () => sidecar,
      });

      // Send a payload that already uses the canonical {schema, data} shape
      // (no 'type' key, no 'body' key) — this is the "pass-through" path in
      // setupMailBridge (hubType is undefined, falls through to raw).
      await conn._fire({
        conversation_id: "conv-regression-001",
        turn_id: "turn-regression-001",
        participant_id: "openhive:dispatcher",
        content_type: "application/json",
        content: JSON.stringify({
          schema: "x-dispatch/work",
          data: { taskId: "task-regression-001", prompt: "Regression check", role: "worker" },
        }),
      });

      await new Promise((r) => setTimeout(r, 20));

      // Bridge must have sent with type:"data" present at the top level
      expect(sendSpy).toHaveBeenCalledOnce();
      const [, , content] = sendSpy.mock.calls[0];
      expect(content).toHaveProperty("type", "data");
      expect(content).toHaveProperty("schema", "x-dispatch/work");
      // schema must be at top level, NOT buried under data
      expect((content as Record<string, unknown>).data).not.toHaveProperty("schema");

      // Consumer must have spawned (proves schema was accessible at top level)
      expect(am.spawnFn).toHaveBeenCalledOnce();
      expect(am.spawnFn).toHaveBeenCalledWith(
        expect.objectContaining({
          task: "Regression check",
          task_id: "task-regression-001",
        }),
      );
    },
  );

  it(
    "echo-loop containment: when the worker's reply turn is echoed back via mail/turn.received, the bridge drops it without spawning a second worker",
    async () => {
      // Reproduces the runaway-spawn scenario the hub-side echo would
      // create absent the bridge's plain-text drop:
      //   1. Worker A processes dispatch, calls done() with summary.
      //   2. Consumer posts the summary back via mapSidecar.postMailTurn.
      //   3. Hub fires mail.turn.added → forwardTurnToSwarms re-fires the
      //      same conversation back to the swarm as mail/turn.received.
      //   4. Bridge MUST classify the plain-text content as non-JSON and
      //      drop it; the consumer MUST NOT see it as a new dispatch and
      //      spawn worker B.
      const { inboxAdapter, inboxEvents, sendSpy } = buildFakeInboxAdapter("dispatcher-echo");
      const conn = buildFakeConnection();
      const am = buildFakeAgentManager("agent-echo");
      const store = buildFakeAgentStore();
      const sidecar = buildFakeSidecar();

      await setupMailBridge({
        connection: conn,
        inboxAdapter: inboxAdapter as never,
        dispatcherAgentId: "dispatcher-echo",
      });
      createMailInboundConsumer({
        dispatcherAgentId: "dispatcher-echo",
        inboxEvents,
        agentManager: am.manager as AgentManager,
        agentStore: store as AgentStore,
        getSidecar: () => sidecar,
      });

      // First, deliver a real dispatch so we have a non-zero baseline.
      await conn._fire({
        conversation_id: "conv-echo-001",
        turn_id: "turn-echo-001",
        participant_id: "openhive:dispatcher",
        content_type: "application/json",
        content: JSON.stringify({
          type: "x-dispatch/work",
          body: { taskId: "task-echo-001", prompt: "do thing", role: "worker" },
        }),
      });
      await new Promise((r) => setTimeout(r, 10));
      expect(am.spawnFn).toHaveBeenCalledTimes(1);

      // Now simulate the echo: hub re-fires mail/turn.received with the
      // worker's plain-text reply. content_type matches what postMailTurn
      // sets; content is a plain string starting with the SENTINEL prefix.
      await conn._fire({
        conversation_id: "conv-echo-001",
        turn_id: "turn-echo-002-reply",
        participant_id: "agent-echo",
        content_type: "text/plain",
        content: "WIDGET_SENTINEL_42 Hello! Worker task acknowledged and completed.",
      });
      await new Promise((r) => setTimeout(r, 10));

      // Bridge dropped the echo: inbox.send was NOT called for the reply.
      // (sendSpy was called once for the original dispatch envelope, not
      // again for the echoed text reply.)
      expect(sendSpy).toHaveBeenCalledTimes(1);

      // Consumer MUST NOT have spawned a second worker.
      expect(am.spawnFn).toHaveBeenCalledTimes(1);
    },
  );

  it(
    "echo-loop containment: a malformed JSON payload (looks like JSON but isn't a dispatch envelope) does not spawn a worker",
    async () => {
      // Defensive: even if the echoed content happens to be JSON-shaped
      // (e.g. an agent that wraps its reply as a JSON message), the
      // consumer must reject it because schema !== "x-dispatch/work".
      const { inboxAdapter, inboxEvents, sendSpy } = buildFakeInboxAdapter("dispatcher-echo-2");
      const conn = buildFakeConnection();
      const am = buildFakeAgentManager("agent-echo-2");
      const store = buildFakeAgentStore();
      const sidecar = buildFakeSidecar();

      await setupMailBridge({
        connection: conn,
        inboxAdapter: inboxAdapter as never,
        dispatcherAgentId: "dispatcher-echo-2",
      });
      createMailInboundConsumer({
        dispatcherAgentId: "dispatcher-echo-2",
        inboxEvents,
        agentManager: am.manager as AgentManager,
        agentStore: store as AgentStore,
        getSidecar: () => sidecar,
      });

      // Echo containing a JSON payload but with a different schema.
      await conn._fire({
        conversation_id: "conv-fake-echo",
        turn_id: "turn-fake-echo",
        participant_id: "agent-echo-2",
        content_type: "application/json",
        content: JSON.stringify({
          schema: "x-agent/reply",
          data: { text: "WIDGET_SENTINEL_42 some reply" },
        }),
      });
      await new Promise((r) => setTimeout(r, 10));

      // Bridge forwarded once (it doesn't classify by schema), but the
      // consumer's onMessage filter (schema === "x-dispatch/work") rejects.
      expect(sendSpy).toHaveBeenCalledOnce();
      expect(am.spawnFn).not.toHaveBeenCalled();
    },
  );
});
