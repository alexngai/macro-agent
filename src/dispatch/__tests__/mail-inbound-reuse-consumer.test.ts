/**
 * Unit tests for createMailInboundReuseConsumer.
 *
 * Mirrors mail-inbound-consumer.test.ts shape but exercises the reuse
 * semantics: drives an existing agent's session via `agentManager.prompt()`
 * (not `spawn` + `promptUntilDone`), tracks `inflightDispatches`, rejects
 * concurrent dispatches with `recipient_busy`, captures done() summary
 * inline from the update stream.
 */

import { describe, it, expect, beforeEach, vi, type MockedFunction } from "vitest";
import {
  createMailInboundReuseConsumer,
} from "../mail-inbound-reuse-consumer.js";
import type {
  InboxEvents,
  InboxMessageEvent,
  MailInboundSidecar,
} from "../mail-inbound-consumer.js";
import type { AgentManager } from "../../agent/agent-manager.js";
import type { AgentStore } from "../../agent/agent-store.js";

// ─────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────

const SIDECAR_ID = "dispatcher:test";
const TARGET_AGENT_ID = "worker-001";

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

/**
 * Builds an async-iterable mock for `agentManager.prompt()`. The caller
 * supplies the updates and they're yielded one at a time in order.
 */
function makePromptIterable(updates: unknown[]): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const u of updates) yield u;
    },
  };
}

function makeAgentManager(opts: {
  promptUpdates?: unknown[];
  promptError?: Error;
  /** When set, prompt() returns a never-ending iterable so we can race it. */
  hangPrompt?: boolean;
}): {
  manager: Partial<AgentManager>;
  promptFn: MockedFunction<AgentManager["prompt"]>;
} {
  let resolveHang: (() => void) | null = null;
  const promptFn = vi.fn() as unknown as MockedFunction<AgentManager["prompt"]>;
  promptFn.mockImplementation(((_id: string, _msg: string) => {
    if (opts.promptError) {
      // Throw at iteration start.
      return {
        async *[Symbol.asyncIterator]() {
          throw opts.promptError;
        },
      } as unknown as AsyncIterable<any>;
    }
    if (opts.hangPrompt) {
      const hangPromise = new Promise<void>((r) => {
        resolveHang = r;
      });
      return {
        async *[Symbol.asyncIterator]() {
          await hangPromise;
        },
      } as unknown as AsyncIterable<any>;
    }
    return makePromptIterable(opts.promptUpdates ?? []) as unknown as AsyncIterable<any>;
  }) as any);

  const manager: Partial<AgentManager> = {
    prompt: promptFn,
  };

  // Expose unblock to caller via mock metadata.
  (manager as any)._releaseHang = () => resolveHang?.();

  return { manager, promptFn };
}

function makeAgentStore(opts: {
  state?: string;
  notFound?: boolean;
} = {}): Partial<AgentStore> {
  return {
    getAgent: vi.fn().mockImplementation((id: string) => {
      if (opts.notFound) return null;
      return {
        id,
        state: opts.state ?? "running",
        metadata: {},
      };
    }) as unknown as AgentStore["getAgent"],
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
  targetAgentId: string,
  conversationId?: string,
): InboxMessageEvent {
  return {
    agentId: targetAgentId,
    message: {
      id: `msg-${taskId}`,
      content: {
        schema: "x-dispatch/work",
        data: { taskId, prompt: "do the thing", role: "worker" },
        ...(conversationId ? { _conversationId: conversationId } : {}),
      },
    },
  };
}

/** A done() tool_call update that captureDoneCall should pick up. */
function doneUpdate(args: { status: string; summary: string }) {
  return {
    sessionUpdate: "tool_call",
    title: "mcp__macro-agent__done",
    rawInput: args,
  };
}

/**
 * Wait for queued microtasks + a tick. The consumer dispatches via void
 * driveDispatch(...) — tests need to let the awaited prompt iterable run.
 */
async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

// ─────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────

describe("createMailInboundReuseConsumer", () => {
  let inboxEvents: ReturnType<typeof makeInboxEvents>;

  beforeEach(() => {
    inboxEvents = makeInboxEvents();
  });

  it("ignores envelopes addressed to the sidecar (those are owned by mail-inbound-consumer)", async () => {
    const { manager, promptFn } = makeAgentManager({});
    const consumer = createMailInboundReuseConsumer({
      dispatcherAgentId: SIDECAR_ID,
      inboxEvents,
      agentManager: manager as AgentManager,
      agentStore: makeAgentStore() as AgentStore,
      getSidecar: () => makeSidecar(),
      log: () => {},
    });

    inboxEvents.fire({
      agentId: SIDECAR_ID,
      message: {
        content: {
          schema: "x-dispatch/work",
          data: { taskId: "t-1", prompt: "x" },
          _conversationId: "conv-1",
        },
      },
    });
    await flushMicrotasks();

    expect(promptFn).not.toHaveBeenCalled();
    consumer.stop();
  });

  it("ignores non-x-dispatch/work envelopes", async () => {
    const { manager, promptFn } = makeAgentManager({});
    const consumer = createMailInboundReuseConsumer({
      dispatcherAgentId: SIDECAR_ID,
      inboxEvents,
      agentManager: manager as AgentManager,
      agentStore: makeAgentStore() as AgentStore,
      getSidecar: () => makeSidecar(),
      log: () => {},
    });

    inboxEvents.fire({
      agentId: TARGET_AGENT_ID,
      message: {
        content: { schema: "x-dispatch/cancel", data: { taskId: "t-2" } },
      },
    });
    await flushMicrotasks();

    expect(promptFn).not.toHaveBeenCalled();
    consumer.stop();
  });

  it("drives prompt() on the target agent and posts the done() summary back", async () => {
    const { manager, promptFn } = makeAgentManager({
      promptUpdates: [doneUpdate({ status: "completed", summary: "did the thing" })],
    });
    const sidecar = makeSidecar();
    const consumer = createMailInboundReuseConsumer({
      dispatcherAgentId: SIDECAR_ID,
      inboxEvents,
      agentManager: manager as AgentManager,
      agentStore: makeAgentStore() as AgentStore,
      getSidecar: () => sidecar,
      log: () => {},
    });

    inboxEvents.fire(workEnvelope("t-3", TARGET_AGENT_ID, "conv-3"));
    await flushMicrotasks();
    await flushMicrotasks();

    expect(promptFn).toHaveBeenCalledTimes(1);
    expect(promptFn).toHaveBeenCalledWith(TARGET_AGENT_ID, "do the thing");
    expect(sidecar.postMailTurn).toHaveBeenCalledWith(
      "conv-3",
      TARGET_AGENT_ID,
      "did the thing",
    );
    consumer.stop();
  });

  it("rejects a second dispatch on the same agent with recipient_busy", async () => {
    const { manager, promptFn } = makeAgentManager({ hangPrompt: true });
    const sidecar = makeSidecar();
    const consumer = createMailInboundReuseConsumer({
      dispatcherAgentId: SIDECAR_ID,
      inboxEvents,
      agentManager: manager as AgentManager,
      agentStore: makeAgentStore() as AgentStore,
      getSidecar: () => sidecar,
      log: () => {},
    });

    // First dispatch — hangs in the prompt iterable.
    inboxEvents.fire(workEnvelope("t-A", TARGET_AGENT_ID, "conv-A"));
    await flushMicrotasks();

    // Second dispatch arrives while the first is in-flight.
    inboxEvents.fire(workEnvelope("t-B", TARGET_AGENT_ID, "conv-B"));
    await flushMicrotasks();

    // Only the first prompt was kicked off.
    expect(promptFn).toHaveBeenCalledTimes(1);
    // The second got a recipient_busy reply turn on its conversation.
    const busyCall = sidecar.postMailTurn.mock.calls.find(
      ([conv]) => conv === "conv-B",
    );
    expect(busyCall).toBeDefined();
    expect(busyCall![2]).toContain("recipient_busy");
    expect(busyCall![2]).toContain("t-A");

    // Stats reflect the busy reject.
    expect(consumer.stats().busyRejects).toBe(1);
    expect(consumer.stats().inflightCount).toBe(1);

    // Unblock the first prompt so the test cleans up.
    (manager as any)._releaseHang();
    consumer.stop();
  });

  it("posts agent_unavailable when target is not registered", async () => {
    const { manager, promptFn } = makeAgentManager({});
    const sidecar = makeSidecar();
    const consumer = createMailInboundReuseConsumer({
      dispatcherAgentId: SIDECAR_ID,
      inboxEvents,
      agentManager: manager as AgentManager,
      agentStore: makeAgentStore({ notFound: true }) as AgentStore,
      getSidecar: () => sidecar,
      log: () => {},
    });

    inboxEvents.fire(workEnvelope("t-4", TARGET_AGENT_ID, "conv-4"));
    await flushMicrotasks();

    expect(promptFn).not.toHaveBeenCalled();
    expect(sidecar.postMailTurn).toHaveBeenCalledWith(
      "conv-4",
      TARGET_AGENT_ID,
      expect.stringContaining("agent_unavailable"),
    );
    consumer.stop();
  });

  it("posts agent_unavailable when target state is stopped", async () => {
    const { manager, promptFn } = makeAgentManager({});
    const sidecar = makeSidecar();
    const consumer = createMailInboundReuseConsumer({
      dispatcherAgentId: SIDECAR_ID,
      inboxEvents,
      agentManager: manager as AgentManager,
      agentStore: makeAgentStore({ state: "stopped" }) as AgentStore,
      getSidecar: () => sidecar,
      log: () => {},
    });

    inboxEvents.fire(workEnvelope("t-5", TARGET_AGENT_ID, "conv-5"));
    await flushMicrotasks();

    expect(promptFn).not.toHaveBeenCalled();
    expect(sidecar.postMailTurn).toHaveBeenCalledWith(
      "conv-5",
      TARGET_AGENT_ID,
      expect.stringContaining("agent_unavailable"),
    );
    consumer.stop();
  });

  it("posts incomplete reply when prompt cycle ends without a done() call", async () => {
    const { manager, promptFn } = makeAgentManager({
      promptUpdates: [
        { sessionUpdate: "agent_message_chunk", text: "thinking..." },
      ],
    });
    const sidecar = makeSidecar();
    const consumer = createMailInboundReuseConsumer({
      dispatcherAgentId: SIDECAR_ID,
      inboxEvents,
      agentManager: manager as AgentManager,
      agentStore: makeAgentStore() as AgentStore,
      getSidecar: () => sidecar,
      log: () => {},
    });

    inboxEvents.fire(workEnvelope("t-6", TARGET_AGENT_ID, "conv-6"));
    await flushMicrotasks();
    await flushMicrotasks();

    expect(promptFn).toHaveBeenCalledTimes(1);
    expect(sidecar.postMailTurn).toHaveBeenCalledWith(
      "conv-6",
      TARGET_AGENT_ID,
      expect.stringContaining("incomplete"),
    );
    consumer.stop();
  });

  it("dedups re-deliveries of the same taskId within the TTL window", async () => {
    const { manager, promptFn } = makeAgentManager({
      promptUpdates: [doneUpdate({ status: "completed", summary: "ok" })],
    });
    const sidecar = makeSidecar();
    const consumer = createMailInboundReuseConsumer({
      dispatcherAgentId: SIDECAR_ID,
      inboxEvents,
      agentManager: manager as AgentManager,
      agentStore: makeAgentStore() as AgentStore,
      getSidecar: () => sidecar,
      log: () => {},
    });

    inboxEvents.fire(workEnvelope("t-7", TARGET_AGENT_ID, "conv-7"));
    await flushMicrotasks();
    await flushMicrotasks();
    inboxEvents.fire(workEnvelope("t-7", TARGET_AGENT_ID, "conv-7"));
    await flushMicrotasks();

    expect(promptFn).toHaveBeenCalledTimes(1);
    consumer.stop();
  });

  it("releases the inflight slot when prompt() throws", async () => {
    const { manager } = makeAgentManager({
      promptError: new Error("transport gone"),
    });
    const sidecar = makeSidecar();
    const consumer = createMailInboundReuseConsumer({
      dispatcherAgentId: SIDECAR_ID,
      inboxEvents,
      agentManager: manager as AgentManager,
      agentStore: makeAgentStore() as AgentStore,
      getSidecar: () => sidecar,
      log: () => {},
    });

    inboxEvents.fire(workEnvelope("t-8", TARGET_AGENT_ID, "conv-8"));
    await flushMicrotasks();
    await flushMicrotasks();

    expect(consumer.stats().inflightCount).toBe(0);
    // failed reply posted
    expect(sidecar.postMailTurn).toHaveBeenCalledWith(
      "conv-8",
      TARGET_AGENT_ID,
      expect.stringContaining("failed"),
    );
    consumer.stop();
  });
});
