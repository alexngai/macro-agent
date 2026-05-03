/**
 * Unit tests for createMailInboundConsumer.
 *
 * All dependencies are mocked — no real inbox, agentManager, or sidecar.
 */

import { describe, it, expect, beforeEach, vi, type MockedFunction } from "vitest";
import {
  createMailInboundConsumer,
  type InboxEvents,
  type InboxMessageEvent,
  type MailInboundSidecar,
} from "../mail-inbound-consumer.js";
import type { AgentManager } from "../../agent/agent-manager.js";
import type { AgentStore } from "../../agent/agent-store.js";

// ─────────────────────────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────────────────────────

function makeInboxEvents(): InboxEvents & {
  fire(event: InboxMessageEvent): void;
} {
  let listener: ((e: InboxMessageEvent) => void) | null = null;
  return {
    on(_evt, fn) {
      listener = fn as (e: InboxMessageEvent) => void;
    },
    off(_evt, _fn) {
      listener = null;
    },
    fire(event) {
      listener?.(event);
    },
  };
}

function makeAgentManager(spawnedId = "agent-001"): {
  manager: Partial<AgentManager>;
  spawnFn: MockedFunction<AgentManager["spawn"]>;
  lifecycleListeners: Array<(e: { type: string; agent: { id: string }; reason: string }) => void>;
  fireLifecycle(e: { type: string; agent: { id: string }; reason: string }): void;
} {
  const lifecycleListeners: Array<
    (e: { type: string; agent: { id: string }; reason: string }) => void
  > = [];

  const spawnFn = vi.fn().mockResolvedValue({ id: spawnedId }) as unknown as MockedFunction<
    AgentManager["spawn"]
  >;

  const manager: Partial<AgentManager> = {
    spawn: spawnFn,
    onLifecycleEvent(cb) {
      lifecycleListeners.push(cb as any);
      return () => {
        const idx = lifecycleListeners.indexOf(cb as any);
        if (idx >= 0) lifecycleListeners.splice(idx, 1);
      };
    },
  };

  return {
    manager,
    spawnFn,
    lifecycleListeners,
    fireLifecycle(e) {
      for (const fn of lifecycleListeners) fn(e);
    },
  };
}

function makeAgentStore(summary?: string): Partial<AgentStore> {
  return {
    getAgent: vi.fn().mockReturnValue(
      summary !== undefined
        ? { metadata: { _lastSummary: summary } }
        : { metadata: {} },
    ),
  };
}

function makeSidecar(): MailInboundSidecar & {
  postMailTurn: MockedFunction<NonNullable<MailInboundSidecar["postMailTurn"]>>;
} {
  return {
    postMailTurn: vi.fn().mockResolvedValue(undefined),
  };
}

function workEnvelope(
  taskId: string,
  prompt: string,
  conversationId?: string,
): InboxMessageEvent {
  return {
    agentId: "dispatcher:test",
    message: {
      id: `msg-${taskId}`,
      content: {
        schema: "x-dispatch/work",
        data: { taskId, prompt, role: "worker" },
        ...(conversationId ? { _conversationId: conversationId } : {}),
      },
    },
  };
}

// ─────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────

const DISPATCHER_ID = "dispatcher:test";

describe("createMailInboundConsumer", () => {
  let inboxEvents: ReturnType<typeof makeInboxEvents>;
  let am: ReturnType<typeof makeAgentManager>;
  let store: ReturnType<typeof makeAgentStore>;
  let sidecar: ReturnType<typeof makeSidecar>;

  beforeEach(() => {
    inboxEvents = makeInboxEvents();
    am = makeAgentManager("agent-001");
    store = makeAgentStore();
    sidecar = makeSidecar();
  });

  it("logs ready message on creation", () => {
    const logs: string[] = [];
    createMailInboundConsumer({
      dispatcherAgentId: DISPATCHER_ID,
      inboxEvents,
      agentManager: am.manager as AgentManager,
      agentStore: store as AgentStore,
      getSidecar: () => sidecar,
      log: (m) => logs.push(m),
    });
    expect(logs.some((l) => l.includes("Consumer ready"))).toBe(true);
    expect(logs.some((l) => l.includes(DISPATCHER_ID))).toBe(true);
  });

  it("ignores inbox messages for other agent IDs", async () => {
    createMailInboundConsumer({
      dispatcherAgentId: DISPATCHER_ID,
      inboxEvents,
      agentManager: am.manager as AgentManager,
      agentStore: store as AgentStore,
      getSidecar: () => sidecar,
    });

    // fire an event for a DIFFERENT recipient
    inboxEvents.fire({
      agentId: "some-other-agent",
      message: {
        content: { schema: "x-dispatch/work", data: { taskId: "t1", prompt: "do it" } },
      },
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(am.spawnFn).not.toHaveBeenCalled();
  });

  it("ignores non-x-dispatch/work schema messages", async () => {
    createMailInboundConsumer({
      dispatcherAgentId: DISPATCHER_ID,
      inboxEvents,
      agentManager: am.manager as AgentManager,
      agentStore: store as AgentStore,
      getSidecar: () => sidecar,
    });

    inboxEvents.fire({
      agentId: DISPATCHER_ID,
      message: { content: { schema: "some-other-schema", data: {} } },
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(am.spawnFn).not.toHaveBeenCalled();
  });

  it("spawns a worker agent when x-dispatch/work arrives", async () => {
    createMailInboundConsumer({
      dispatcherAgentId: DISPATCHER_ID,
      inboxEvents,
      agentManager: am.manager as AgentManager,
      agentStore: store as AgentStore,
      getSidecar: () => sidecar,
    });

    inboxEvents.fire(workEnvelope("task-42", "Build the widget", "conv-99"));

    // Allow microtask / spawn promise to settle
    await new Promise((r) => setTimeout(r, 20));

    expect(am.spawnFn).toHaveBeenCalledOnce();
    expect(am.spawnFn).toHaveBeenCalledWith(
      expect.objectContaining({
        task: "Build the widget",
        task_id: "task-42",
        role: "worker",
        parent: null,
      }),
    );
  });

  it("calls postMailTurn with conversationId + summary when worker stops", async () => {
    store = makeAgentStore("WIDGET_SENTINEL_42: done");
    sidecar = makeSidecar();

    createMailInboundConsumer({
      dispatcherAgentId: DISPATCHER_ID,
      inboxEvents,
      agentManager: am.manager as AgentManager,
      agentStore: store as AgentStore,
      getSidecar: () => sidecar,
    });

    inboxEvents.fire(workEnvelope("task-42", "Build widget", "conv-99"));
    await new Promise((r) => setTimeout(r, 20));

    // Simulate agent stopping with "completed"
    am.fireLifecycle({ type: "stopped", agent: { id: "agent-001" }, reason: "completed" });
    await new Promise((r) => setTimeout(r, 20));

    expect(sidecar.postMailTurn).toHaveBeenCalledOnce();
    expect(sidecar.postMailTurn).toHaveBeenCalledWith(
      "conv-99",
      "agent-001",
      "WIDGET_SENTINEL_42: done",
    );
  });

  it("does not call postMailTurn when _lastSummary is missing", async () => {
    store = makeAgentStore(undefined);
    sidecar = makeSidecar();

    createMailInboundConsumer({
      dispatcherAgentId: DISPATCHER_ID,
      inboxEvents,
      agentManager: am.manager as AgentManager,
      agentStore: store as AgentStore,
      getSidecar: () => sidecar,
    });

    inboxEvents.fire(workEnvelope("task-X", "Do work", "conv-X"));
    await new Promise((r) => setTimeout(r, 20));
    am.fireLifecycle({ type: "stopped", agent: { id: "agent-001" }, reason: "completed" });
    await new Promise((r) => setTimeout(r, 10));

    expect(sidecar.postMailTurn).not.toHaveBeenCalled();
  });

  it("does not call postMailTurn when envelope has no conversationId", async () => {
    store = makeAgentStore("some summary");
    sidecar = makeSidecar();

    createMailInboundConsumer({
      dispatcherAgentId: DISPATCHER_ID,
      inboxEvents,
      agentManager: am.manager as AgentManager,
      agentStore: store as AgentStore,
      getSidecar: () => sidecar,
    });

    // No conversationId in this envelope
    inboxEvents.fire(workEnvelope("task-Y", "Do work"));
    await new Promise((r) => setTimeout(r, 20));
    am.fireLifecycle({ type: "stopped", agent: { id: "agent-001" }, reason: "completed" });
    await new Promise((r) => setTimeout(r, 10));

    expect(sidecar.postMailTurn).not.toHaveBeenCalled();
  });

  it("ignores stopped events for agents it did not spawn", async () => {
    createMailInboundConsumer({
      dispatcherAgentId: DISPATCHER_ID,
      inboxEvents,
      agentManager: am.manager as AgentManager,
      agentStore: store as AgentStore,
      getSidecar: () => sidecar,
    });

    // Fire stopped for an unknown agent — should not touch sidecar
    am.fireLifecycle({ type: "stopped", agent: { id: "agent-unknown" }, reason: "completed" });
    await new Promise((r) => setTimeout(r, 10));

    expect(sidecar.postMailTurn).not.toHaveBeenCalled();
  });

  it("stop() detaches inbox listener and lifecycle subscription", async () => {
    const logs: string[] = [];
    const consumer = createMailInboundConsumer({
      dispatcherAgentId: DISPATCHER_ID,
      inboxEvents,
      agentManager: am.manager as AgentManager,
      agentStore: store as AgentStore,
      getSidecar: () => sidecar,
      log: (m) => logs.push(m),
    });

    consumer.stop();

    // After stop, inbox messages should be ignored
    inboxEvents.fire(workEnvelope("task-Z", "after stop", "conv-Z"));
    await new Promise((r) => setTimeout(r, 20));

    expect(am.spawnFn).not.toHaveBeenCalled();
    expect(logs.some((l) => l.includes("Consumer stopped"))).toBe(true);
  });
});
