/**
 * S1 (completion-detection) unit tests for promptUntilDone's optional
 * `isComplete` predicate.
 *
 * The macro `promptUntilDone` normally completes ONLY when the agent calls the
 * macro done() tool; otherwise it re-prompts "call done()" up to maxFollowUps
 * times (each a slow full turn). The τ agent calls τ's `finish`, not macro
 * done(), so without an external completion predicate the loop exhausts
 * maxFollowUps and Atlas.solve() hangs until the rollout backstop.
 *
 * These tests drive promptUntilDone with a MOCKED acp session `prompt` stream
 * (no live agent) and assert:
 *   - an `isComplete` that flips true after the first streamed update breaks the
 *     loop on attempt 0, calls terminate(agentId, "completed"), returns
 *     completedExternally:true, and does NOT exhaust maxFollowUps;
 *   - back-compat: with NO predicate the existing done()-detection is unchanged.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createAgentManagerV2 } from "../agent-manager-v2.js";
import { AgentStore } from "../agent-store.js";
import type { AgentManager } from "../agent-manager.js";
import type { InboxAdapter, TasksAdapter } from "../../adapters/types.js";

// ── Mock acp-factory: a controllable per-spawn session.prompt stream ───────
// `promptStreamFactory` is reassigned per test to control what each prompt
// attempt yields. `promptCallCount` lets us assert how many attempts ran.
let promptStreamFactory: () => AsyncIterable<unknown>;
let promptCallCount = 0;
// Invoked when the agent handle is closed (i.e. terminate() tears down the
// session). The silent-stream repro registers a hook here so that ONLY a real
// terminate() can end its otherwise-forever-blocked stream — faithfully
// modelling the live "stream ends/throws on teardown" behavior. On the old
// reactive-only code terminate() is never called mid-stream, so the stream
// never ends → the for-await hangs (red).
let onHandleClose: (() => void) | null = null;

vi.mock("acp-factory", () => ({
  AgentFactory: {
    spawn: vi.fn().mockResolvedValue({
      createSession: vi.fn().mockResolvedValue({
        id: "provider-session-1",
        prompt: vi.fn().mockImplementation(() => {
          promptCallCount++;
          return promptStreamFactory();
        }),
        forkWithFlush: vi.fn().mockResolvedValue({ id: "forked-session-1" }),
      }),
      loadSession: vi.fn().mockResolvedValue({ id: "loaded-session-1" }),
      close: vi.fn().mockImplementation(async () => {
        onHandleClose?.();
      }),
      isRunning: vi.fn().mockReturnValue(true),
    }),
  },
}));

function createMockInboxAdapter(): InboxAdapter {
  return {
    registerAgent: vi.fn().mockResolvedValue(undefined),
    deregisterAgent: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue("msg-1"),
    onDelivery: vi.fn(),
    offDelivery: vi.fn(),
    checkInbox: vi.fn().mockResolvedValue([]),
    readThread: vi.fn().mockResolvedValue([]),
    setSignalFilter: vi.fn(),
    setEmissionValidator: vi.fn(),
    socketPath: "/tmp/test-inbox.sock",
    stop: vi.fn().mockResolvedValue(undefined),
  } as unknown as InboxAdapter;
}

// A single benign streamed update (an agent message chunk — NOT a done() tool
// call), used to trigger the isComplete check mid-stream.
function* oneMessageUpdate(): Generator<unknown> {
  yield {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "working" },
  };
}

// A stream that emits a macro done() tool-call update (title ends with __done),
// for the back-compat path.
function* doneToolUpdate(): Generator<unknown> {
  yield {
    sessionUpdate: "tool_call",
    title: "mcp__macro-agent__done",
    rawInput: { status: "completed" },
  };
}

async function* asAsync(gen: Iterable<unknown>): AsyncIterable<unknown> {
  for (const u of gen) yield u;
}

// Reproduces the live τ hang: the agent runs the whole episode in ONE prompt()
// call, yields a couple of updates, then the stream goes SILENT but does NOT
// close — the async iterator just blocks forever. With only the reactive
// per-update / per-attempt checks, isComplete is never re-evaluated and the
// for-await never unblocks.
//
// The ONLY way out is terminate(): it tears down the session (calls
// handle.close()), which we wire to release the dangling await — faithfully
// modelling the live "stream ends on teardown" behavior. So on the old
// reactive-only code (terminate never called mid-stream) the stream NEVER ends
// → hang (red); the concurrent poller calls terminate → close → release →
// stream ends → completion (green).
function silentThenHangStream(): () => AsyncIterable<unknown> {
  let release: () => void = () => {};
  const hang = new Promise<void>((resolve) => {
    release = resolve;
  });
  // terminate() → handle.close() → release the blocked stream.
  onHandleClose = () => release();
  async function* gen(): AsyncIterable<unknown> {
    yield {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "working 1" },
    };
    yield {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "working 2" },
    };
    // Silent-but-open: block forever until terminate() releases it — exactly
    // the live failure mode (silent, non-closing iterator).
    await hang;
  }
  return gen;
}

function createMockTasksAdapter(): TasksAdapter {
  return {
    createTask: vi.fn().mockResolvedValue("ot-task-1"),
    assignTask: vi.fn().mockResolvedValue(undefined),
    transitionTask: vi.fn().mockResolvedValue(undefined),
    getTask: vi.fn().mockResolvedValue(null),
    queryReady: vi.fn().mockResolvedValue([]),
    listTasks: vi.fn().mockResolvedValue([]),
    addBlocker: vi.fn().mockResolvedValue(undefined),
    removeBlocker: vi.fn().mockResolvedValue(undefined),
    claimTask: vi.fn().mockResolvedValue(null),
    unclaimTask: vi.fn().mockResolvedValue(undefined),
    listClaimable: vi.fn().mockResolvedValue([]),
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
    connected: true,
  } as unknown as TasksAdapter;
}

describe("promptUntilDone — S1 external completion predicate", () => {
  let agentStore: AgentStore;
  let inboxAdapter: InboxAdapter;
  let manager: AgentManager;

  beforeEach(() => {
    promptCallCount = 0;
    onHandleClose = null;
    agentStore = new AgentStore(":memory:");
    inboxAdapter = createMockInboxAdapter();
    manager = createAgentManagerV2(agentStore, inboxAdapter, createMockTasksAdapter(), {
      defaultCwd: "/tmp/test",
    });
  });

  afterEach(async () => {
    await manager.close();
    agentStore.close();
  });

  it("breaks on attempt 0 when isComplete flips true after the first update; terminates 'completed'; completedExternally:true; does NOT exhaust maxFollowUps", async () => {
    promptStreamFactory = () => asAsync(oneMessageUpdate());

    const spawned = await manager.spawn({ task: "tau episode", role: "worker" });
    expect(manager.hasActiveSession(spawned.id)).toBe(true);

    // Flip true after the first update is observed.
    let updates = 0;
    const isComplete = vi.fn(() => {
      updates++;
      return updates >= 1; // true from the first check on
    });

    const maxFollowUps = 16;
    const result = await manager.promptUntilDone(spawned.id, "go", {
      maxFollowUps,
      isComplete,
    });

    expect(result.completedExternally).toBe(true);
    expect(result.doneCalled).toBe(false);
    // Only the initial attempt ran — no "please call done()" re-prompts.
    expect(promptCallCount).toBe(1);
    expect(isComplete).toHaveBeenCalled();
    // Mirrors the done() path: the agent is terminated (its active session is
    // torn down + the store record transitions to "stopped"). terminate() is an
    // internal closure call, so we observe its EFFECT rather than spy on it.
    expect(manager.hasActiveSession(spawned.id)).toBe(false);
    expect(agentStore.getAgent(spawned.id)!.state).toBe("stopped");
  });

  it("REPRO (live hang): silent-but-open stream + poll-only isComplete → concurrent poller terminates and returns bounded (completedExternally:true, promptCallCount===1)", async () => {
    // The stream yields 2 updates then blocks forever without closing. The
    // predicate is true from the start but can ONLY be observed via the
    // concurrent poller, because no further updates arrive to drive the
    // reactive per-update check, and the per-attempt check never runs (the
    // for-await never ends on its own). On the OLD reactive-only code this
    // test HANGS until the vitest timeout (red). With the concurrent poller it
    // returns within a few poll intervals (green).
    promptStreamFactory = silentThenHangStream();

    const spawned = await manager.spawn({ task: "tau episode (silent)", role: "worker" });
    expect(manager.hasActiveSession(spawned.id)).toBe(true);

    // FALSE during the streamed updates (so the reactive per-update check
    // (a) does NOT catch it), then TRUE once the episode has externally
    // completed. After the 2 updates the stream goes silent forever, so the
    // reactive checks never run again — ONLY the concurrent poller can observe
    // the flip. (The 2 per-update reactive checks consume the first 2 false
    // returns; everything after — i.e. the poller — sees true.)
    let checks = 0;
    const isComplete = vi.fn(() => {
      checks++;
      return checks > 2;
    });

    const pollIntervalMs = 20;
    const maxFollowUps = 16;

    const start = Date.now();
    const result = await manager.promptUntilDone(spawned.id, "go", {
      maxFollowUps,
      isComplete,
      pollIntervalMs,
    });
    const elapsed = Date.now() - start;

    // Bounded return — NOT a hang, NOT maxFollowUps exhaustion.
    expect(elapsed).toBeLessThan(2000);
    expect(result.completedExternally).toBe(true);
    expect(result.doneCalled).toBe(false);
    // The whole episode is one prompt() call; no re-prompts.
    expect(promptCallCount).toBe(1);
    expect(isComplete).toHaveBeenCalled();
    // terminate('completed') was effected: session torn down + store stopped.
    expect(manager.hasActiveSession(spawned.id)).toBe(false);
    expect(agentStore.getAgent(spawned.id)!.state).toBe("stopped");
  });

  it("back-compat: with NO predicate, done()-detection is unchanged (doneCalled true, completedExternally false, terminate 'completed')", async () => {
    promptStreamFactory = () => asAsync(doneToolUpdate());

    const spawned = await manager.spawn({ task: "normal agent", role: "worker" });

    const result = await manager.promptUntilDone(spawned.id, "go", {
      maxFollowUps: 2,
    });

    expect(result.doneCalled).toBe(true);
    expect(result.doneStatus).toBe("completed");
    expect(result.completedExternally).toBe(false);
    expect(promptCallCount).toBe(1);
    // done()-detection still terminates the agent (unchanged behavior).
    expect(manager.hasActiveSession(spawned.id)).toBe(false);
    expect(agentStore.getAgent(spawned.id)!.state).toBe("stopped");
  });

  it("no predicate + no done(): exhausts maxFollowUps (unchanged re-prompt behavior)", async () => {
    // Empty stream each attempt — agent never calls done(), no predicate.
    promptStreamFactory = () => asAsync([]);

    const spawned = await manager.spawn({ task: "silent agent", role: "worker" });

    const maxFollowUps = 3;
    const result = await manager.promptUntilDone(spawned.id, "go", {
      maxFollowUps,
    });

    expect(result.doneCalled).toBe(false);
    expect(result.completedExternally).toBe(false);
    // Initial attempt + maxFollowUps re-prompts = maxFollowUps + 1 prompt calls.
    expect(promptCallCount).toBe(maxFollowUps + 1);
  });
});
