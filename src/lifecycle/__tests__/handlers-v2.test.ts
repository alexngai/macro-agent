/**
 * Tests for Lifecycle Handlers V2
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { dispatchDoneV2, type HandlerDepsV2 } from "../handlers-v2.js";
import type { LifecycleContext, CleanupStatus } from "../types.js";
import type { InboxAdapter, TasksAdapter } from "../../adapters/types.js";
import type { AgentManager } from "../../agent/agent-manager.js";

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

    it("should transition task in opentasks on completion", async () => {
      await dispatchDoneV2(
        makeContext(),
        { status: "completed" },
        cleanStatus,
        deps
      );

      expect(tasksAdapter.transitionTask).toHaveBeenCalledWith(
        "task-1",
        "complete"
      );
    });

    it("should transition task to fail on failure", async () => {
      await dispatchDoneV2(
        makeContext(),
        { status: "failed" },
        cleanStatus,
        deps
      );

      expect(tasksAdapter.transitionTask).toHaveBeenCalledWith(
        "task-1",
        "fail"
      );
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
});
