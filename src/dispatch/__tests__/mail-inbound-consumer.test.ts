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

  // ── Failure-mode coverage ─────────────────────────────────────────

  it("forwards summary unchanged when it lacks the expected sentinel — consumer is not a content validator", async () => {
    // The consumer's job is mechanical relay: whatever the worker put in
    // _lastSummary is what gets posted back. Content-level checks (e.g.,
    // "must start with WIDGET_SENTINEL_42") belong to the dispatch
    // initiator's verifier, not to the consumer.
    store = makeAgentStore("plain reply with no sentinel");
    sidecar = makeSidecar();

    createMailInboundConsumer({
      dispatcherAgentId: DISPATCHER_ID,
      inboxEvents,
      agentManager: am.manager as AgentManager,
      agentStore: store as AgentStore,
      getSidecar: () => sidecar,
    });

    inboxEvents.fire(workEnvelope("task-no-sentinel", "go", "conv-no-sentinel"));
    await new Promise((r) => setTimeout(r, 20));
    am.fireLifecycle({ type: "stopped", agent: { id: "agent-001" }, reason: "completed" });
    await new Promise((r) => setTimeout(r, 10));

    expect(sidecar.postMailTurn).toHaveBeenCalledOnce();
    expect(sidecar.postMailTurn).toHaveBeenCalledWith(
      "conv-no-sentinel",
      "agent-001",
      "plain reply with no sentinel",
    );
  });

  it("agentManager.spawn() rejecting does not crash the consumer — error is logged", async () => {
    const logs: string[] = [];
    am.spawnFn.mockRejectedValueOnce(new Error("acp-factory: handshake timeout"));

    createMailInboundConsumer({
      dispatcherAgentId: DISPATCHER_ID,
      inboxEvents,
      agentManager: am.manager as AgentManager,
      agentStore: store as AgentStore,
      getSidecar: () => sidecar,
      log: (m) => logs.push(m),
    });

    inboxEvents.fire(workEnvelope("task-spawn-fails", "go", "conv-X"));
    await new Promise((r) => setTimeout(r, 20));

    // Spawn was attempted, failed, was logged, and the consumer is still alive.
    expect(am.spawnFn).toHaveBeenCalledOnce();
    expect(logs.some((l) => l.includes("Spawn failed for taskId=task-spawn-fails"))).toBe(true);
    expect(logs.some((l) => l.includes("handshake timeout"))).toBe(true);

    // No reply posted, since no agent ever stopped (we never fired lifecycle).
    expect(sidecar.postMailTurn).not.toHaveBeenCalled();

    // Consumer still functional — a subsequent dispatch goes through.
    am.spawnFn.mockResolvedValueOnce({ id: "agent-after-fail" } as never);
    inboxEvents.fire(workEnvelope("task-after-fail", "go", "conv-Y"));
    await new Promise((r) => setTimeout(r, 10));
    expect(am.spawnFn).toHaveBeenCalledTimes(2);
  });

  it("clears _lastSummary on the agent record after successful postMailTurn", async () => {
    // Prevents a stale summary from re-firing if the same agentId is ever
    // reused for another dispatch (defensive — the manager normally mints
    // fresh ids, but this is cheap insurance).
    store = makeAgentStore("WIDGET_SENTINEL_42 done");
    const updateAgentSpy = vi.fn();
    (store as { updateAgent?: typeof updateAgentSpy }).updateAgent = updateAgentSpy;
    sidecar = makeSidecar();

    createMailInboundConsumer({
      dispatcherAgentId: DISPATCHER_ID,
      inboxEvents,
      agentManager: am.manager as AgentManager,
      agentStore: store as AgentStore,
      getSidecar: () => sidecar,
    });

    inboxEvents.fire(workEnvelope("task-clear", "go", "conv-clear"));
    await new Promise((r) => setTimeout(r, 20));
    am.fireLifecycle({ type: "stopped", agent: { id: "agent-001" }, reason: "completed" });
    await new Promise((r) => setTimeout(r, 20));

    expect(sidecar.postMailTurn).toHaveBeenCalledOnce();
    expect(updateAgentSpy).toHaveBeenCalledWith(
      "agent-001",
      { metadata: expect.not.objectContaining({ _lastSummary: expect.anything() }) },
    );
  });

  it("dedup TTL: a re-delivered taskId can spawn again after the dedup window expires", async () => {
    vi.useFakeTimers();
    try {
      createMailInboundConsumer({
        dispatcherAgentId: DISPATCHER_ID,
        inboxEvents,
        agentManager: am.manager as AgentManager,
        agentStore: store as AgentStore,
        getSidecar: () => sidecar,
      });

      inboxEvents.fire(workEnvelope("task-ttl", "go", "conv-ttl"));
      await Promise.resolve();
      expect(am.spawnFn).toHaveBeenCalledTimes(1);

      // Same taskId within the dedup window → drop
      inboxEvents.fire(workEnvelope("task-ttl", "go", "conv-ttl"));
      await Promise.resolve();
      expect(am.spawnFn).toHaveBeenCalledTimes(1);

      // Past the TTL (1h)
      vi.advanceTimersByTime(60 * 60 * 1000 + 1_000);

      // Re-fire — now allowed because the dedup entry expired
      inboxEvents.fire(workEnvelope("task-ttl", "go", "conv-ttl"));
      await Promise.resolve();
      expect(am.spawnFn).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  // ── Loadout / permission coverage ────────────────────────────────

  describe("loadout permissions wiring", () => {
    function envelopeWith(
      taskId: string,
      data: Record<string, unknown>,
      conversationId = "conv-loadout",
    ): InboxMessageEvent {
      return {
        agentId: DISPATCHER_ID,
        message: {
          id: `msg-${taskId}`,
          content: {
            schema: "x-dispatch/work",
            data: { taskId, prompt: "go", role: "worker", ...data },
            _conversationId: conversationId,
          },
        },
      };
    }

    it("data.loadout (canonical) → spawn called with permissions + fullAutonomous: true", async () => {
      createMailInboundConsumer({
        dispatcherAgentId: DISPATCHER_ID,
        inboxEvents,
        agentManager: am.manager as AgentManager,
        agentStore: store as AgentStore,
        getSidecar: () => sidecar,
      });

      inboxEvents.fire(
        envelopeWith("task-loadout-1", {
          loadout: { permissions: { deny: ["Bash(rm -rf:*)"] } },
        }),
      );
      await new Promise((r) => setTimeout(r, 20));

      expect(am.spawnFn).toHaveBeenCalledOnce();
      const args = am.spawnFn.mock.calls[0][0];
      expect(args.permissions).toEqual({
        allow: [],
        deny: ["Bash(rm -rf:*)"],
        ask: [],
      });
      expect(args.fullAutonomous).toBe(true);
    });

    it("legacy data.metadata.permissions (no data.loadout) → spawn called with permissions + fullAutonomous: true", async () => {
      createMailInboundConsumer({
        dispatcherAgentId: DISPATCHER_ID,
        inboxEvents,
        agentManager: am.manager as AgentManager,
        agentStore: store as AgentStore,
        getSidecar: () => sidecar,
      });

      inboxEvents.fire(
        envelopeWith("task-legacy-1", {
          metadata: { permissions: { deny: ["Bash(rm -rf:*)"] } },
        }),
      );
      await new Promise((r) => setTimeout(r, 20));

      expect(am.spawnFn).toHaveBeenCalledOnce();
      const args = am.spawnFn.mock.calls[0][0];
      expect(args.permissions).toEqual({
        allow: [],
        deny: ["Bash(rm -rf:*)"],
        ask: [],
      });
      expect(args.fullAutonomous).toBe(true);
    });

    it("data.loadout wins over data.metadata.permissions when both are present", async () => {
      createMailInboundConsumer({
        dispatcherAgentId: DISPATCHER_ID,
        inboxEvents,
        agentManager: am.manager as AgentManager,
        agentStore: store as AgentStore,
        getSidecar: () => sidecar,
      });

      inboxEvents.fire(
        envelopeWith("task-both-1", {
          // canonical
          loadout: { permissions: { deny: ["Bash(canonical:*)"] } },
          // legacy — should be ignored because canonical is present
          metadata: { permissions: { deny: ["Bash(legacy:*)"] } },
        }),
      );
      await new Promise((r) => setTimeout(r, 20));

      expect(am.spawnFn).toHaveBeenCalledOnce();
      const args = am.spawnFn.mock.calls[0][0];
      expect(args.permissions).toEqual({
        allow: [],
        deny: ["Bash(canonical:*)"],
        ask: [],
      });
      expect(args.fullAutonomous).toBe(true);
    });

    it("envelope with neither data.loadout nor data.metadata.permissions → spawn called WITHOUT permissions", async () => {
      createMailInboundConsumer({
        dispatcherAgentId: DISPATCHER_ID,
        inboxEvents,
        agentManager: am.manager as AgentManager,
        agentStore: store as AgentStore,
        getSidecar: () => sidecar,
      });

      inboxEvents.fire(envelopeWith("task-bare", {}));
      await new Promise((r) => setTimeout(r, 20));

      expect(am.spawnFn).toHaveBeenCalledOnce();
      const args = am.spawnFn.mock.calls[0][0];
      expect(args.permissions).toBeUndefined();
      expect(args.fullAutonomous).toBeUndefined();
    });
  });

  it("stats(): malformed-envelope counter increments and seenTaskIds reflects current state", async () => {
    const consumer = createMailInboundConsumer({
      dispatcherAgentId: DISPATCHER_ID,
      inboxEvents,
      agentManager: am.manager as AgentManager,
      agentStore: store as AgentStore,
      getSidecar: () => sidecar,
    });

    expect(consumer.stats()).toEqual({ droppedMalformed: 0, seenTaskIds: 0 });

    // Malformed: schema is x-dispatch/work but data has no taskId
    inboxEvents.fire({
      agentId: DISPATCHER_ID,
      message: {
        id: "malformed-1",
        content: { schema: "x-dispatch/work", data: { prompt: "no id" } },
      },
    });
    inboxEvents.fire({
      agentId: DISPATCHER_ID,
      message: {
        id: "malformed-2",
        content: { schema: "x-dispatch/work", data: {} },
      },
    });
    expect(consumer.stats()).toEqual({ droppedMalformed: 2, seenTaskIds: 0 });

    // Well-formed envelope adds to seenTaskIds
    inboxEvents.fire(workEnvelope("task-stats", "go", "conv-stats"));
    await Promise.resolve();
    expect(consumer.stats().seenTaskIds).toBe(1);
    expect(consumer.stats().droppedMalformed).toBe(2);
  });

  // ── Pre-spawn repo mount ──────────────────────────────────────────

  describe("pre-spawn repo mount", () => {
    function workEnvelopeWithRepo(
      taskId: string,
      prompt: string,
      repoMeta: Record<string, unknown>,
      conversationId?: string,
    ): InboxMessageEvent {
      return {
        agentId: DISPATCHER_ID,
        message: {
          id: `msg-${taskId}`,
          content: {
            schema: "x-dispatch/work",
            data: {
              taskId,
              prompt,
              role: "worker",
              metadata: repoMeta,
            },
            ...(conversationId ? { _conversationId: conversationId } : {}),
          },
        },
      };
    }

    function makeRepoManager(existingRepos: Array<{ canonicalUrl: string; localPath: string }> = []) {
      const attached: Array<{ remoteUrl: string; localPath: string }> = [];
      return {
        manager: {
          list: () =>
            [
              ...existingRepos.map((r) => ({
                identity: { canonicalUrl: r.canonicalUrl },
                localPath: r.localPath,
              })),
              ...attached.map((r) => ({
                identity: { canonicalUrl: r.remoteUrl },
                localPath: r.localPath,
              })),
            ],
          attach: vi.fn(async (config: { remoteUrl: string; localPath: string }) => {
            attached.push(config);
            return { localPath: config.localPath };
          }),
        },
        attached,
      };
    }

    it("passes cwd from already-attached repo to spawn", async () => {
      const repo = makeRepoManager([
        { canonicalUrl: "https://github.com/org/repo.git", localPath: "/repos/repo" },
      ]);
      const logs: string[] = [];

      createMailInboundConsumer({
        dispatcherAgentId: DISPATCHER_ID,
        inboxEvents,
        agentManager: am.manager as AgentManager,
        agentStore: store as AgentStore,
        getSidecar: () => sidecar,
        getRepoManager: () => repo.manager,
        log: (m) => logs.push(m),
      });

      inboxEvents.fire(
        workEnvelopeWithRepo("task-repo-1", "work on repo", {
          repo_id: "repo_abc",
          canonical_url: "https://github.com/org/repo.git",
        }),
      );

      await new Promise((r) => setTimeout(r, 30));

      expect(am.spawnFn).toHaveBeenCalledOnce();
      expect(am.spawnFn).toHaveBeenCalledWith(
        expect.objectContaining({ cwd: "/repos/repo" }),
      );
      expect(logs.some((l) => l.includes("already attached"))).toBe(true);
    });

    it("spawns without cwd when clone_policy is not 'allowed' and repo not attached", async () => {
      const repo = makeRepoManager([]);
      const logs: string[] = [];

      createMailInboundConsumer({
        dispatcherAgentId: DISPATCHER_ID,
        inboxEvents,
        agentManager: am.manager as AgentManager,
        agentStore: store as AgentStore,
        getSidecar: () => sidecar,
        getRepoManager: () => repo.manager,
        log: (m) => logs.push(m),
      });

      inboxEvents.fire(
        workEnvelopeWithRepo("task-repo-2", "work", {
          repo_id: "repo_xyz",
          canonical_url: "https://github.com/org/other.git",
        }),
      );

      await new Promise((r) => setTimeout(r, 30));

      expect(am.spawnFn).toHaveBeenCalledOnce();
      // No cwd passed — clone_policy defaults to 'none'
      const spawnArgs = am.spawnFn.mock.calls[0]![0] as Record<string, unknown>;
      expect(spawnArgs.cwd).toBeUndefined();
      expect(logs.some((l) => l.includes("skipping mount"))).toBe(true);
    });

    it("spawns without cwd when no repo metadata in envelope", async () => {
      const repo = makeRepoManager([]);

      createMailInboundConsumer({
        dispatcherAgentId: DISPATCHER_ID,
        inboxEvents,
        agentManager: am.manager as AgentManager,
        agentStore: store as AgentStore,
        getSidecar: () => sidecar,
        getRepoManager: () => repo.manager,
      });

      // Standard envelope without repo metadata
      inboxEvents.fire(workEnvelope("task-no-repo", "plain work"));

      await new Promise((r) => setTimeout(r, 30));

      expect(am.spawnFn).toHaveBeenCalledOnce();
      const spawnArgs = am.spawnFn.mock.calls[0]![0] as Record<string, unknown>;
      expect(spawnArgs.cwd).toBeUndefined();
    });

    it("spawns without cwd when getRepoManager is not provided", async () => {
      createMailInboundConsumer({
        dispatcherAgentId: DISPATCHER_ID,
        inboxEvents,
        agentManager: am.manager as AgentManager,
        agentStore: store as AgentStore,
        getSidecar: () => sidecar,
        // no getRepoManager
      });

      inboxEvents.fire(
        workEnvelopeWithRepo("task-no-mgr", "work", {
          repo_id: "repo_abc",
          canonical_url: "https://github.com/org/repo.git",
          clone_policy: "allowed",
        }),
      );

      await new Promise((r) => setTimeout(r, 30));

      expect(am.spawnFn).toHaveBeenCalledOnce();
      const spawnArgs = am.spawnFn.mock.calls[0]![0] as Record<string, unknown>;
      expect(spawnArgs.cwd).toBeUndefined();
    });

    it("spawns without cwd when canonical_url is missing from repo metadata", async () => {
      const repo = makeRepoManager([]);

      createMailInboundConsumer({
        dispatcherAgentId: DISPATCHER_ID,
        inboxEvents,
        agentManager: am.manager as AgentManager,
        agentStore: store as AgentStore,
        getSidecar: () => sidecar,
        getRepoManager: () => repo.manager,
      });

      inboxEvents.fire(
        workEnvelopeWithRepo("task-no-url", "work", {
          repo_id: "repo_abc",
          // no canonical_url
        }),
      );

      await new Promise((r) => setTimeout(r, 30));

      expect(am.spawnFn).toHaveBeenCalledOnce();
      const spawnArgs = am.spawnFn.mock.calls[0]![0] as Record<string, unknown>;
      expect(spawnArgs.cwd).toBeUndefined();
    });

    it("logs repo_id in the received message log line", async () => {
      const logs: string[] = [];

      createMailInboundConsumer({
        dispatcherAgentId: DISPATCHER_ID,
        inboxEvents,
        agentManager: am.manager as AgentManager,
        agentStore: store as AgentStore,
        getSidecar: () => sidecar,
        log: (m) => logs.push(m),
      });

      inboxEvents.fire(
        workEnvelopeWithRepo("task-log", "work", {
          repo_id: "repo_visible",
          canonical_url: "https://github.com/org/visible.git",
        }),
      );

      await new Promise((r) => setTimeout(r, 20));

      expect(logs.some((l) => l.includes("repo=repo_visible"))).toBe(true);
    });
  });
});
