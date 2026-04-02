/**
 * Tests for Lifecycle Handlers V2
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { dispatchDoneV2, type HandlerDepsV2 } from "../handlers-v2.js";
import type { LifecycleContext, CleanupStatus } from "../types.js";
import type { InboxAdapter, TasksAdapter } from "../../adapters/types.js";
import type { AgentManager } from "../../agent/agent-manager.js";
import type { MergeQueueInterface, MergeRequest } from "../../workspace/merge-queue/types.js";
import * as cleanup from "../cleanup.js";

// =============================================================================
// Module Mocks
// =============================================================================

vi.mock("../cleanup.js", async (importOriginal) => {
  const actual = await importOriginal<typeof cleanup>();
  return {
    ...actual,
    attemptMerge: vi.fn(),
    abortMerge: vi.fn().mockReturnValue(true),
  };
});

// =============================================================================
// Mocks
// =============================================================================

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
    socketPath: "/tmp/test.sock",
    stop: vi.fn().mockResolvedValue(undefined),
  } as unknown as InboxAdapter;
}

function createMockTasksAdapter(): TasksAdapter {
  return {
    createTask: vi.fn().mockResolvedValue("t-1"),
    assignTask: vi.fn().mockResolvedValue(undefined),
    transitionTask: vi.fn().mockResolvedValue(undefined),
    getTask: vi.fn().mockResolvedValue({ id: "t-1", status: "open" }),
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

function createMockAgentManager(): AgentManager {
  return {
    getChildren: vi.fn().mockReturnValue([]),
    spawn: vi.fn(),
    terminate: vi.fn(),
    get: vi.fn(),
    list: vi.fn().mockReturnValue([]),
  } as unknown as AgentManager;
}

function createMockMergeQueue(): MergeQueueInterface {
  return {
    submit: vi.fn().mockReturnValue("mr-1"),
    getNext: vi.fn().mockReturnValue(null),
    markProcessing: vi.fn(),
    markMerged: vi.fn(),
    markConflict: vi.fn(),
    markAbandoned: vi.fn(),
    markResolverComplete: vi.fn(),
    get: vi.fn().mockReturnValue(null),
    getPending: vi.fn().mockReturnValue([]),
    getByTask: vi.fn().mockReturnValue(null),
    getQueueDepth: vi.fn().mockReturnValue(0),
    reposition: vi.fn(),
    bumpPriority: vi.fn(),
    onEvent: vi.fn().mockReturnValue(() => {}),
    close: vi.fn(),
  };
}

function makeMergeRequest(overrides: Partial<MergeRequest> = {}): MergeRequest {
  return {
    id: "mr-1",
    streamId: "stream-1",
    taskId: "task-1",
    workerBranch: "worker/feature-1",
    workerAgentId: "worker-1",
    status: "pending",
    priority: 100,
    position: null,
    submittedAt: Date.now(),
    startedAt: null,
    completedAt: null,
    mergeCommit: null,
    conflictFiles: null,
    resolverTaskId: null,
    metadata: {},
    ...overrides,
  };
}

function makeContext(overrides: Partial<LifecycleContext> = {}): LifecycleContext {
  return {
    agentId: "worker-1",
    role: "worker",
    taskId: "task-1",
    parentId: "coordinator-1",
    workspacePath: "/tmp/workspace",
    ...overrides,
  };
}

const cleanStatus: CleanupStatus = { ready: true };

// =============================================================================
// Tests
// =============================================================================

describe("Lifecycle Handlers V2", () => {
  let inboxAdapter: InboxAdapter;
  let tasksAdapter: TasksAdapter;
  let agentManager: AgentManager;
  let deps: HandlerDepsV2;

  beforeEach(() => {
    inboxAdapter = createMockInboxAdapter();
    tasksAdapter = createMockTasksAdapter();
    agentManager = createMockAgentManager();
    deps = { inboxAdapter, tasksAdapter, agentManager };
  });

  // ── Worker Handler ─────────────────────────────────────────

  describe("worker done", () => {
    it("should emit WORKER_DONE and return shouldTerminate=true", async () => {
      const result = await dispatchDoneV2(
        makeContext(),
        { status: "completed", summary: "Done" },
        cleanStatus,
        deps
      );

      expect(result.shouldTerminate).toBe(true);
      expect(result.signalsEmitted).toContain("WORKER_DONE");
    });

    it("should send WORKER_DONE via inbox to parent", async () => {
      await dispatchDoneV2(
        makeContext(),
        { status: "completed" },
        cleanStatus,
        deps
      );

      expect(inboxAdapter.send).toHaveBeenCalledWith(
        "worker-1",
        "coordinator-1",
        expect.objectContaining({
          type: "event",
          event: "WORKER_DONE",
        }),
        expect.any(Object)
      );
    });

    it("should NOT transition task (handled by AgentManagerV2.terminate)", async () => {
      await dispatchDoneV2(
        makeContext(),
        { status: "completed" },
        cleanStatus,
        deps
      );

      expect(tasksAdapter.transitionTask).not.toHaveBeenCalled();
    });

    it("should NOT transition task on failure (handled by AgentManagerV2.terminate)", async () => {
      await dispatchDoneV2(
        makeContext(),
        { status: "failed" },
        cleanStatus,
        deps
      );

      expect(tasksAdapter.transitionTask).not.toHaveBeenCalled();
    });

    it("should NOT terminate on blocked status", async () => {
      const result = await dispatchDoneV2(
        makeContext(),
        { status: "blocked", summary: "Need help" },
        cleanStatus,
        deps
      );

      expect(result.shouldTerminate).toBe(false);
      expect(result.signalsEmitted).toContain("HELP_NEEDED");
    });

    it("should NOT terminate on deferred status", async () => {
      const result = await dispatchDoneV2(
        makeContext(),
        { status: "deferred" },
        cleanStatus,
        deps
      );

      expect(result.shouldTerminate).toBe(false);
      expect(result.signalsEmitted).toContain("WORKER_DEFERRED");
    });

    it("should NOT terminate in pull mode on completion", async () => {
      const result = await dispatchDoneV2(
        makeContext(),
        { status: "completed" },
        cleanStatus,
        { ...deps, taskMode: "pull" }
      );

      expect(result.shouldTerminate).toBe(false);
    });

    it("should terminate in pull mode on failure", async () => {
      const result = await dispatchDoneV2(
        makeContext(),
        { status: "failed" },
        cleanStatus,
        { ...deps, taskMode: "pull" }
      );

      expect(result.shouldTerminate).toBe(true);
    });

    it("should NOT construct merge requests (system handles this)", async () => {
      const result = await dispatchDoneV2(
        makeContext(),
        { status: "completed" },
        cleanStatus,
        deps
      );

      // No MERGE_REQUEST signal — handled by AgentManagerV2.terminate
      expect(result.signalsEmitted).not.toContain("MERGE_REQUEST");

      // Verify inbox was NOT called with MERGE_REQUEST
      const sendCalls = vi.mocked(inboxAdapter.send).mock.calls;
      const mergeRequests = sendCalls.filter(
        (call) => (call[2] as any)?.event === "MERGE_REQUEST"
      );
      expect(mergeRequests).toHaveLength(0);
    });

    it("should handle no parent gracefully", async () => {
      const result = await dispatchDoneV2(
        makeContext({ parentId: undefined }),
        { status: "completed" },
        cleanStatus,
        deps
      );

      expect(result.shouldTerminate).toBe(true);
      // Send should not be called (no parent to send to)
      // But WORKER_DONE still in signalsEmitted from the attempt
    });
  });

  // ── Integrator Handler ─────────────────────────────────────

  describe("integrator done", () => {
    it("should emit INTEGRATOR_DONE and terminate", async () => {
      const result = await dispatchDoneV2(
        makeContext({ role: "integrator" }),
        { status: "completed" },
        cleanStatus,
        deps
      );

      expect(result.shouldTerminate).toBe(true);
      expect(result.signalsEmitted).toContain("INTEGRATOR_DONE");
    });
  });

  // ── Monitor Handler ────────────────────────────────────────

  describe("monitor done", () => {
    it("should emit MONITOR_DONE and terminate", async () => {
      const result = await dispatchDoneV2(
        makeContext({ role: "monitor" }),
        { status: "completed" },
        cleanStatus,
        deps
      );

      expect(result.shouldTerminate).toBe(true);
      expect(result.signalsEmitted).toContain("MONITOR_DONE");
    });
  });

  // ── Generic Handler ────────────────────────────────────────

  describe("generic done", () => {
    it("should handle unknown roles with generic handler", async () => {
      const result = await dispatchDoneV2(
        makeContext({ role: "custom_role" }),
        { status: "completed" },
        cleanStatus,
        deps
      );

      expect(result.shouldTerminate).toBe(true);
      expect(result.signalsEmitted).toContain("AGENT_COMPLETED");
    });

    it("should emit AGENT_FAILED for failed status", async () => {
      const result = await dispatchDoneV2(
        makeContext({ role: "custom_role" }),
        { status: "failed" },
        cleanStatus,
        deps
      );

      expect(result.signalsEmitted).toContain("AGENT_FAILED");
    });
  });

  // ── Role Dispatch ──────────────────────────────────────────

  describe("role dispatch", () => {
    it("should dispatch worker.resolver to worker handler", async () => {
      const result = await dispatchDoneV2(
        makeContext({ role: "worker.resolver" }),
        { status: "completed" },
        cleanStatus,
        deps
      );

      expect(result.signalsEmitted).toContain("WORKER_DONE");
    });

    it("should dispatch by capability (workspace.worktree → worker)", async () => {
      const result = await dispatchDoneV2(
        makeContext({
          role: "grinder",
          capabilities: ["workspace.worktree", "file.read"],
        }),
        { status: "completed" },
        cleanStatus,
        deps
      );

      expect(result.signalsEmitted).toContain("WORKER_DONE");
    });

    it("should dispatch by capability (workspace.integrate → integrator)", async () => {
      const result = await dispatchDoneV2(
        makeContext({
          role: "merger",
          capabilities: ["workspace.integrate"],
        }),
        { status: "completed" },
        cleanStatus,
        deps
      );

      expect(result.signalsEmitted).toContain("INTEGRATOR_DONE");
    });
  });

  // ── Integrator Done with Merge Queue ─────────────────────────

  describe("integrator done with merge queue", () => {
    let mergeQueue: MergeQueueInterface;

    beforeEach(() => {
      mergeQueue = createMockMergeQueue();
      vi.mocked(cleanup.attemptMerge).mockReset();
      vi.mocked(cleanup.abortMerge).mockReset().mockReturnValue(true);
    });

    it("should process successful merge and terminate", async () => {
      const mr = makeMergeRequest();
      vi.mocked(mergeQueue.getNext)
        .mockReturnValueOnce(mr)
        .mockReturnValueOnce(null);
      vi.mocked(cleanup.attemptMerge).mockReturnValue({
        success: true,
        mergeCommit: "abc12345def",
      });

      const result = await dispatchDoneV2(
        makeContext({ role: "integrator", streamId: "stream-1" }),
        { status: "completed" },
        cleanStatus,
        { ...deps, mergeQueue }
      );

      expect(mergeQueue.markProcessing).toHaveBeenCalledWith("mr-1");
      expect(mergeQueue.markMerged).toHaveBeenCalledWith("mr-1", "abc12345def");
      expect(result.shouldTerminate).toBe(true);
      expect(result.signalsEmitted).toContain("MERGE_COMPLETE");
      expect(result.signalsEmitted).toContain("INTEGRATOR_DONE");
      expect(result.cleanupActions).toEqual(
        expect.arrayContaining([expect.stringContaining("Merged worker/feature-1")])
      );
    });

    it("should spawn resolver on conflict and stay alive", async () => {
      const mr = makeMergeRequest();
      vi.mocked(mergeQueue.getNext)
        .mockReturnValueOnce(mr)
        .mockReturnValueOnce(null);
      vi.mocked(cleanup.attemptMerge).mockReturnValue({
        success: false,
        conflicts: ["src/file1.ts", "src/file2.ts"],
      });
      vi.mocked(agentManager.spawn).mockResolvedValue({
        id: "resolver-1",
        session_id: "sess-1",
        agent: {} as any,
        session: {} as any,
      });

      const result = await dispatchDoneV2(
        makeContext({ role: "integrator", streamId: "stream-1" }),
        { status: "completed" },
        cleanStatus,
        { ...deps, mergeQueue }
      );

      expect(cleanup.abortMerge).toHaveBeenCalledWith("/tmp/workspace");
      expect(agentManager.spawn).toHaveBeenCalledWith(
        expect.objectContaining({
          parent: "worker-1",
          role: "worker.resolver",
          task: expect.stringContaining("worker/feature-1"),
        })
      );
      expect(mergeQueue.markConflict).toHaveBeenCalledWith(
        "mr-1",
        ["src/file1.ts", "src/file2.ts"],
        "resolver-1"
      );
      expect(result.shouldTerminate).toBe(false);
      expect(result.signalsEmitted).toContain("INTEGRATOR_DONE");
    });

    it("should process multiple MRs (first succeeds, second conflicts)", async () => {
      const mr1 = makeMergeRequest({ id: "mr-1", workerBranch: "worker/feat-a" });
      const mr2 = makeMergeRequest({ id: "mr-2", workerBranch: "worker/feat-b" });
      vi.mocked(mergeQueue.getNext)
        .mockReturnValueOnce(mr1)
        .mockReturnValueOnce(mr2)
        .mockReturnValueOnce(null);
      vi.mocked(cleanup.attemptMerge)
        .mockReturnValueOnce({ success: true, mergeCommit: "commit1" })
        .mockReturnValueOnce({ success: false, conflicts: ["README.md"] });
      vi.mocked(agentManager.spawn).mockResolvedValue({
        id: "resolver-2",
        session_id: "sess-2",
        agent: {} as any,
        session: {} as any,
      });

      const result = await dispatchDoneV2(
        makeContext({ role: "integrator", streamId: "stream-1" }),
        { status: "completed" },
        cleanStatus,
        { ...deps, mergeQueue }
      );

      expect(mergeQueue.markMerged).toHaveBeenCalledWith("mr-1", "commit1");
      expect(mergeQueue.markConflict).toHaveBeenCalledWith(
        "mr-2",
        ["README.md"],
        "resolver-2"
      );
      expect(result.shouldTerminate).toBe(false);
      expect(result.signalsEmitted).toContain("MERGE_COMPLETE");
      expect(result.signalsEmitted).toContain("INTEGRATOR_DONE");
    });

    it("should terminate when queue is empty", async () => {
      vi.mocked(mergeQueue.getNext).mockReturnValue(null);

      const result = await dispatchDoneV2(
        makeContext({ role: "integrator", streamId: "stream-1" }),
        { status: "completed" },
        cleanStatus,
        { ...deps, mergeQueue }
      );

      expect(result.shouldTerminate).toBe(true);
      expect(result.signalsEmitted).toContain("INTEGRATOR_DONE");
      expect(cleanup.attemptMerge).not.toHaveBeenCalled();
    });

    it("should terminate when no merge queue is provided", async () => {
      const result = await dispatchDoneV2(
        makeContext({ role: "integrator", streamId: "stream-1" }),
        { status: "completed" },
        cleanStatus,
        deps // no mergeQueue
      );

      expect(result.shouldTerminate).toBe(true);
      expect(result.signalsEmitted).toContain("INTEGRATOR_DONE");
    });

    it("should skip queue processing on non-completed status", async () => {
      vi.mocked(mergeQueue.getNext).mockReturnValue(
        makeMergeRequest()
      );

      const result = await dispatchDoneV2(
        makeContext({ role: "integrator", streamId: "stream-1" }),
        { status: "failed" },
        cleanStatus,
        { ...deps, mergeQueue }
      );

      expect(mergeQueue.getNext).not.toHaveBeenCalled();
      expect(result.shouldTerminate).toBe(true);
      expect(result.signalsEmitted).toContain("INTEGRATOR_DONE");
    });

    it("should warn on non-conflict merge failure", async () => {
      const mr = makeMergeRequest();
      vi.mocked(mergeQueue.getNext)
        .mockReturnValueOnce(mr)
        .mockReturnValueOnce(null);
      vi.mocked(cleanup.attemptMerge).mockReturnValue({
        success: false,
        error: "branch not found",
      });

      const result = await dispatchDoneV2(
        makeContext({ role: "integrator", streamId: "stream-1" }),
        { status: "completed" },
        cleanStatus,
        { ...deps, mergeQueue }
      );

      expect(result.warnings).toEqual(
        expect.arrayContaining([
          expect.stringContaining("Merge failed for worker/feature-1"),
        ])
      );
      expect(result.shouldTerminate).toBe(true);
    });
  });
});
