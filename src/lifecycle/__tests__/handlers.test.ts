/**
 * Tests for lifecycle handlers
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleWorkerDone } from "../handlers/worker.js";
import { handleIntegratorDone, handleResolverDone } from "../handlers/integrator.js";
import { handleMonitorDone } from "../handlers/monitor.js";
import { handleGenericDone } from "../handlers/generic.js";
import {
  createHandlerRegistry,
  getHandler,
  dispatchDone,
} from "../handlers/index.js";
import type { LifecycleContext, DoneArgs, CleanupStatus } from "../types.js";

// Mock cleanup module
vi.mock("../cleanup.js", () => ({
  commitChanges: vi.fn(),
  getCurrentBranch: vi.fn(),
  attemptMerge: vi.fn(),
  abortMerge: vi.fn(),
}));

import {
  commitChanges,
  getCurrentBranch,
  attemptMerge,
  abortMerge,
} from "../cleanup.js";

const mockCommitChanges = vi.mocked(commitChanges);
const mockGetCurrentBranch = vi.mocked(getCurrentBranch);
const mockAttemptMerge = vi.mocked(attemptMerge);
const mockAbortMerge = vi.mocked(abortMerge);

// Create mock dependencies
function createMockDeps() {
  return {
    messageRouter: {
      emitStatus: vi.fn(),
      getSubscriptions: vi.fn().mockReturnValue([]),
      unsubscribe: vi.fn(),
    },
    agentManager: {
      getChildren: vi.fn().mockReturnValue([]),
    },
  };
}

describe("handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Worker Handler
  // ─────────────────────────────────────────────────────────────────────────────

  describe("handleWorkerDone", () => {
    it("should emit WORKER_DONE signal", async () => {
      const deps = createMockDeps();
      const context: LifecycleContext = {
        agentId: "worker-1",
        role: "worker",
        taskId: "task-1",
        workspacePath: "/path/to/workspace",
      };
      const args: DoneArgs = {
        status: "completed",
        summary: "Work done",
      };
      const cleanupStatus: CleanupStatus = { ready: true };

      const result = await handleWorkerDone(
        context,
        args,
        cleanupStatus,
        deps as any,
      );

      expect(result.shouldTerminate).toBe(true);
      expect(result.signalsEmitted).toContain("WORKER_DONE");
      expect(deps.messageRouter.emitStatus).toHaveBeenCalledWith(
        expect.objectContaining({
          from: { agent_id: "worker-1" },
          status_type: "completed",
        }),
      );
    });

    it("should emit MERGE_REQUEST when completed", async () => {
      mockGetCurrentBranch.mockReturnValue("feature/test");

      const deps = createMockDeps();
      const context: LifecycleContext = {
        agentId: "worker-1",
        role: "worker",
        workspacePath: "/path/to/workspace",
      };
      const args: DoneArgs = { status: "completed" };
      const cleanupStatus: CleanupStatus = { ready: true };

      const result = await handleWorkerDone(
        context,
        args,
        cleanupStatus,
        deps as any,
      );

      expect(result.signalsEmitted).toContain("MERGE_REQUEST");
    });

    it("should not emit MERGE_REQUEST when failed", async () => {
      const deps = createMockDeps();
      const context: LifecycleContext = {
        agentId: "worker-1",
        role: "worker",
        workspacePath: "/path/to/workspace",
      };
      const args: DoneArgs = { status: "failed" };
      const cleanupStatus: CleanupStatus = { ready: true };

      const result = await handleWorkerDone(
        context,
        args,
        cleanupStatus,
        deps as any,
      );

      expect(result.signalsEmitted).not.toContain("MERGE_REQUEST");
    });

    it("should commit changes when cleanup not ready", async () => {
      mockCommitChanges.mockReturnValue("abc123");

      const deps = createMockDeps();
      const context: LifecycleContext = {
        agentId: "worker-1",
        role: "worker",
        workspacePath: "/path/to/workspace",
      };
      const args: DoneArgs = {
        status: "completed",
        summary: "Work done",
      };
      const cleanupStatus: CleanupStatus = {
        ready: false,
        uncommittedFiles: ["file1.ts", "file2.ts"],
      };

      const result = await handleWorkerDone(
        context,
        args,
        cleanupStatus,
        deps as any,
      );

      expect(mockCommitChanges).toHaveBeenCalledWith(
        "/path/to/workspace",
        "WIP: Work done",
      );
      expect(result.cleanupActions).toEqual(
        expect.arrayContaining([expect.stringContaining("Committed")]),
      );
    });

    it("should signal children to terminate", async () => {
      const deps = createMockDeps();
      // Mock getChildren to return children only for the parent, not for the children
      deps.agentManager.getChildren.mockImplementation((agentId: string) => {
        if (agentId === "worker-1") {
          return [
            { id: "child-1", state: "running" },
            { id: "child-2", state: "running" },
          ];
        }
        return [];
      });

      const context: LifecycleContext = {
        agentId: "worker-1",
        role: "worker",
      };
      const args: DoneArgs = { status: "completed" };
      const cleanupStatus: CleanupStatus = { ready: true };

      const result = await handleWorkerDone(
        context,
        args,
        cleanupStatus,
        deps as any,
      );

      expect(result.cleanupActions).toEqual(
        expect.arrayContaining([expect.stringContaining("descendant")]),
      );
      // Should emit termination signal for each descendant
      expect(deps.messageRouter.emitStatus).toHaveBeenCalledTimes(3); // WORKER_DONE + 2 descendants
    });

    it("should create checkpoints when dataplane is provided", async () => {
      const mockDataplane = {
        createCheckpointsForTask: vi.fn().mockReturnValue([
          { id: "cp-1", streamId: "stream-1", commitSha: "abc123" },
          { id: "cp-2", streamId: "stream-1", commitSha: "def456" },
        ]),
      };

      const deps = {
        ...createMockDeps(),
        dataplane: mockDataplane,
      };
      const context: LifecycleContext = {
        agentId: "worker-1",
        role: "worker",
        taskId: "task-1",
        workspacePath: "/path/to/workspace",
      };
      const args: DoneArgs = { status: "completed" };
      const cleanupStatus: CleanupStatus = { ready: true };

      const result = await handleWorkerDone(
        context,
        args,
        cleanupStatus,
        deps as any,
      );

      expect(mockDataplane.createCheckpointsForTask).toHaveBeenCalledWith(
        "task-1",
        "worker-1",
      );
      expect(result.cleanupActions).toEqual(
        expect.arrayContaining([expect.stringContaining("checkpoint")]),
      );
    });

    it("should not create checkpoints when dataplane is not provided", async () => {
      const deps = createMockDeps();
      const context: LifecycleContext = {
        agentId: "worker-1",
        role: "worker",
        taskId: "task-1",
        workspacePath: "/path/to/workspace",
      };
      const args: DoneArgs = { status: "completed" };
      const cleanupStatus: CleanupStatus = { ready: true };

      const result = await handleWorkerDone(
        context,
        args,
        cleanupStatus,
        deps as any,
      );

      // Should not have checkpoint-related cleanup actions
      const hasCheckpointAction = result.cleanupActions?.some((action) =>
        action.toLowerCase().includes("checkpoint"),
      );
      expect(hasCheckpointAction).toBeFalsy();
    });

    it("should not create checkpoints when taskId is not provided", async () => {
      const mockDataplane = {
        createCheckpointsForTask: vi.fn(),
      };

      const deps = {
        ...createMockDeps(),
        dataplane: mockDataplane,
      };
      const context: LifecycleContext = {
        agentId: "worker-1",
        role: "worker",
        // No taskId
        workspacePath: "/path/to/workspace",
      };
      const args: DoneArgs = { status: "completed" };
      const cleanupStatus: CleanupStatus = { ready: true };

      await handleWorkerDone(context, args, cleanupStatus, deps as any);

      expect(mockDataplane.createCheckpointsForTask).not.toHaveBeenCalled();
    });

    it("should handle checkpoint creation errors gracefully", async () => {
      const mockDataplane = {
        createCheckpointsForTask: vi.fn().mockImplementation(() => {
          throw new Error("Checkpoint creation failed");
        }),
      };

      const deps = {
        ...createMockDeps(),
        dataplane: mockDataplane,
      };
      const context: LifecycleContext = {
        agentId: "worker-1",
        role: "worker",
        taskId: "task-1",
        workspacePath: "/path/to/workspace",
      };
      const args: DoneArgs = { status: "completed" };
      const cleanupStatus: CleanupStatus = { ready: true };

      const result = await handleWorkerDone(
        context,
        args,
        cleanupStatus,
        deps as any,
      );

      // Should complete without throwing, with warning
      expect(result.shouldTerminate).toBe(true);
      expect(result.warnings).toEqual(
        expect.arrayContaining([expect.stringContaining("checkpoint")]),
      );
    });

    // ─────────────────────────────────────────────────────────────────────────────
    // Merge Queue Submission Tests
    // ─────────────────────────────────────────────────────────────────────────────

    it("should submit to merge queue when completed with all required context", async () => {
      mockGetCurrentBranch.mockReturnValue("feature/test");

      const mockMergeQueue = {
        submit: vi.fn().mockReturnValue("mr-123"),
      };

      const deps = {
        ...createMockDeps(),
        mergeQueue: mockMergeQueue,
      };
      const context: LifecycleContext = {
        agentId: "worker-1",
        role: "worker",
        taskId: "task-1",
        streamId: "stream-1",
        workspacePath: "/path/to/workspace",
        integrationBranch: "integration",
      };
      const args: DoneArgs = { status: "completed" };
      const cleanupStatus: CleanupStatus = { ready: true };

      const result = await handleWorkerDone(
        context,
        args,
        cleanupStatus,
        deps as any,
      );

      expect(mockMergeQueue.submit).toHaveBeenCalledWith({
        streamId: "stream-1",
        taskId: "task-1",
        workerBranch: "feature/test",
        workerAgentId: "worker-1",
      });
      expect(result.cleanupActions).toEqual(
        expect.arrayContaining([expect.stringContaining("mr-123")]),
      );
    });

    it("should skip queue submission when no merge queue is configured", async () => {
      mockGetCurrentBranch.mockReturnValue("feature/test");

      const deps = createMockDeps();
      const context: LifecycleContext = {
        agentId: "worker-1",
        role: "worker",
        taskId: "task-1",
        streamId: "stream-1",
        workspacePath: "/path/to/workspace",
      };
      const args: DoneArgs = { status: "completed" };
      const cleanupStatus: CleanupStatus = { ready: true };

      const result = await handleWorkerDone(
        context,
        args,
        cleanupStatus,
        deps as any,
      );

      // Should still emit MERGE_REQUEST signal
      expect(result.signalsEmitted).toContain("MERGE_REQUEST");
      // Should note no queue configured
      expect(result.cleanupActions).toEqual(
        expect.arrayContaining([
          expect.stringContaining("no queue configured"),
        ]),
      );
    });

    it("should skip queue submission when no streamId", async () => {
      mockGetCurrentBranch.mockReturnValue("feature/test");

      const mockMergeQueue = {
        submit: vi.fn(),
      };

      const deps = {
        ...createMockDeps(),
        mergeQueue: mockMergeQueue,
      };
      const context: LifecycleContext = {
        agentId: "worker-1",
        role: "worker",
        taskId: "task-1",
        // No streamId
        workspacePath: "/path/to/workspace",
      };
      const args: DoneArgs = { status: "completed" };
      const cleanupStatus: CleanupStatus = { ready: true };

      const result = await handleWorkerDone(
        context,
        args,
        cleanupStatus,
        deps as any,
      );

      expect(mockMergeQueue.submit).not.toHaveBeenCalled();
      expect(result.cleanupActions).toEqual(
        expect.arrayContaining([expect.stringContaining("no streamId")]),
      );
    });

    it("should skip queue submission when no taskId", async () => {
      mockGetCurrentBranch.mockReturnValue("feature/test");

      const mockMergeQueue = {
        submit: vi.fn(),
      };

      const deps = {
        ...createMockDeps(),
        mergeQueue: mockMergeQueue,
      };
      const context: LifecycleContext = {
        agentId: "worker-1",
        role: "worker",
        // No taskId
        streamId: "stream-1",
        workspacePath: "/path/to/workspace",
      };
      const args: DoneArgs = { status: "completed" };
      const cleanupStatus: CleanupStatus = { ready: true };

      const result = await handleWorkerDone(
        context,
        args,
        cleanupStatus,
        deps as any,
      );

      expect(mockMergeQueue.submit).not.toHaveBeenCalled();
      expect(result.cleanupActions).toEqual(
        expect.arrayContaining([expect.stringContaining("no taskId")]),
      );
    });

    it("should handle queue submission errors gracefully", async () => {
      mockGetCurrentBranch.mockReturnValue("feature/test");

      const mockMergeQueue = {
        submit: vi.fn().mockImplementation(() => {
          throw new Error("Queue submission failed");
        }),
      };

      const deps = {
        ...createMockDeps(),
        mergeQueue: mockMergeQueue,
      };
      const context: LifecycleContext = {
        agentId: "worker-1",
        role: "worker",
        taskId: "task-1",
        streamId: "stream-1",
        workspacePath: "/path/to/workspace",
      };
      const args: DoneArgs = { status: "completed" };
      const cleanupStatus: CleanupStatus = { ready: true };

      const result = await handleWorkerDone(
        context,
        args,
        cleanupStatus,
        deps as any,
      );

      // Should complete without throwing
      expect(result.shouldTerminate).toBe(true);
      // Should have warning about queue submission failure
      expect(result.warnings).toEqual(
        expect.arrayContaining([expect.stringContaining("merge queue")]),
      );
      // Should indicate submission failed
      expect(result.cleanupActions).toEqual(
        expect.arrayContaining([
          expect.stringContaining("queue submission failed"),
        ]),
      );
    });

    it("should not submit to queue when status is failed", async () => {
      const mockMergeQueue = {
        submit: vi.fn(),
      };

      const deps = {
        ...createMockDeps(),
        mergeQueue: mockMergeQueue,
      };
      const context: LifecycleContext = {
        agentId: "worker-1",
        role: "worker",
        taskId: "task-1",
        streamId: "stream-1",
        workspacePath: "/path/to/workspace",
      };
      const args: DoneArgs = { status: "failed" };
      const cleanupStatus: CleanupStatus = { ready: true };

      await handleWorkerDone(context, args, cleanupStatus, deps as any);

      expect(mockMergeQueue.submit).not.toHaveBeenCalled();
    });

    // ─────────────────────────────────────────────────────────────────────────────
    // Blocked Status Tests (s-32xs: "Needs help, don't auto-terminate")
    // ─────────────────────────────────────────────────────────────────────────────

    it("should NOT terminate when status is blocked - agent needs help", async () => {
      const deps = createMockDeps();
      const context: LifecycleContext = {
        agentId: "worker-1",
        role: "worker",
        taskId: "task-1",
        parentId: "coordinator-1",
        workspacePath: "/path/to/workspace",
      };
      const args: DoneArgs = {
        status: "blocked",
        summary: "Need help with merge conflict",
      };
      const cleanupStatus: CleanupStatus = { ready: false, reason: "blocked" };

      const result = await handleWorkerDone(
        context,
        args,
        cleanupStatus,
        deps as any,
      );

      // Per s-32xs spec: "Agent explicitly blocked → Self-report + wait → Needs help, don't auto-terminate"
      expect(result.shouldTerminate).toBe(false);
    });

    it("should emit HELP_NEEDED signal when blocked", async () => {
      const deps = createMockDeps();
      const context: LifecycleContext = {
        agentId: "worker-1",
        role: "worker",
        taskId: "task-1",
        parentId: "coordinator-1",
        workspacePath: "/path/to/workspace",
      };
      const args: DoneArgs = {
        status: "blocked",
        summary: "Need help with merge conflict",
        details: { conflictFiles: ["file1.ts"] },
      };
      const cleanupStatus: CleanupStatus = { ready: false };

      const result = await handleWorkerDone(
        context,
        args,
        cleanupStatus,
        deps as any,
      );

      // Should emit HELP_NEEDED signal to parent
      expect(result.signalsEmitted).toContain("HELP_NEEDED");
      expect(deps.messageRouter.emitStatus).toHaveBeenCalledWith(
        expect.objectContaining({
          status_type: "blocked",
          details: expect.objectContaining({
            signal: "HELP_NEEDED",
            parentId: "coordinator-1",
          }),
        }),
      );
    });

    it("should not emit MERGE_REQUEST when blocked", async () => {
      const deps = createMockDeps();
      const context: LifecycleContext = {
        agentId: "worker-1",
        role: "worker",
        taskId: "task-1",
        streamId: "stream-1",
        workspacePath: "/path/to/workspace",
      };
      const args: DoneArgs = { status: "blocked" };
      const cleanupStatus: CleanupStatus = { ready: false };

      const result = await handleWorkerDone(
        context,
        args,
        cleanupStatus,
        deps as any,
      );

      expect(result.signalsEmitted).not.toContain("MERGE_REQUEST");
    });

    it("should NOT terminate when status is deferred", async () => {
      const deps = createMockDeps();
      const context: LifecycleContext = {
        agentId: "worker-1",
        role: "worker",
        taskId: "task-1",
        workspacePath: "/path/to/workspace",
      };
      const args: DoneArgs = {
        status: "deferred",
        summary: "Work deferred for later",
      };
      const cleanupStatus: CleanupStatus = { ready: false };

      const result = await handleWorkerDone(
        context,
        args,
        cleanupStatus,
        deps as any,
      );

      // Deferred status should also not terminate
      expect(result.shouldTerminate).toBe(false);
    });

    // ─────────────────────────────────────────────────────────────────────────────
    // Resolver Worker Tests (worker.resolver role)
    // ─────────────────────────────────────────────────────────────────────────────

    it("should emit RESOLVER_DONE instead of MERGE_REQUEST for resolver workers", async () => {
      mockGetCurrentBranch.mockReturnValue("resolver/mr-123@1700000000");

      const mockMergeQueue = {
        submit: vi.fn(),
      };

      const deps = {
        ...createMockDeps(),
        mergeQueue: mockMergeQueue,
      };
      const context: LifecycleContext = {
        agentId: "resolver-1",
        role: "worker.resolver", // Resolver role
        taskId: "task-1",
        streamId: "stream-1",
        workspacePath: "/path/to/workspace",
        mrId: "mr-123", // MR being resolved
      };
      const args: DoneArgs = { status: "completed" };
      const cleanupStatus: CleanupStatus = { ready: true };

      const result = await handleWorkerDone(
        context,
        args,
        cleanupStatus,
        deps as any,
      );

      // Should emit RESOLVER_DONE, not MERGE_REQUEST
      expect(result.signalsEmitted).toContain("RESOLVER_DONE");
      expect(result.signalsEmitted).not.toContain("MERGE_REQUEST");

      // Should NOT submit to merge queue
      expect(mockMergeQueue.submit).not.toHaveBeenCalled();

      // Verify RESOLVER_DONE signal details
      expect(deps.messageRouter.emitStatus).toHaveBeenCalledWith(
        expect.objectContaining({
          status_type: "completed",
          details: expect.objectContaining({
            signal: "RESOLVER_DONE",
            mrId: "mr-123",
            resolverBranch: "resolver/mr-123@1700000000",
            resolverId: "resolver-1",
          }),
        }),
      );
    });

    it("should not emit RESOLVER_DONE for regular workers", async () => {
      mockGetCurrentBranch.mockReturnValue("worker/agent-1/task-1@123");

      const mockMergeQueue = {
        submit: vi.fn().mockReturnValue("mr-456"),
      };

      const deps = {
        ...createMockDeps(),
        mergeQueue: mockMergeQueue,
      };
      const context: LifecycleContext = {
        agentId: "worker-1",
        role: "worker", // Regular worker role
        taskId: "task-1",
        streamId: "stream-1",
        workspacePath: "/path/to/workspace",
      };
      const args: DoneArgs = { status: "completed" };
      const cleanupStatus: CleanupStatus = { ready: true };

      const result = await handleWorkerDone(
        context,
        args,
        cleanupStatus,
        deps as any,
      );

      // Should emit MERGE_REQUEST, not RESOLVER_DONE
      expect(result.signalsEmitted).toContain("MERGE_REQUEST");
      expect(result.signalsEmitted).not.toContain("RESOLVER_DONE");

      // Should submit to merge queue
      expect(mockMergeQueue.submit).toHaveBeenCalled();
    });

    it("should handle resolver without mrId gracefully", async () => {
      mockGetCurrentBranch.mockReturnValue("resolver/mr-123@1700000000");

      const deps = createMockDeps();
      const context: LifecycleContext = {
        agentId: "resolver-1",
        role: "worker.resolver",
        taskId: "task-1",
        workspacePath: "/path/to/workspace",
        // No mrId - edge case
      };
      const args: DoneArgs = { status: "completed" };
      const cleanupStatus: CleanupStatus = { ready: true };

      const result = await handleWorkerDone(
        context,
        args,
        cleanupStatus,
        deps as any,
      );

      // Should still emit RESOLVER_DONE
      expect(result.signalsEmitted).toContain("RESOLVER_DONE");
      // Should complete without error
      expect(result.shouldTerminate).toBe(true);
    });

    it("should perform inline merge when resolver completes with mrId and parentId", async () => {
      mockGetCurrentBranch.mockReturnValue("resolver/mr-123@1700000000");

      // Mock merge queue for the inline merge
      const mockMergeQueue = {
        submit: vi.fn(),
        get: vi.fn().mockReturnValue({
          id: "mr-123",
          status: "conflict",
        }),
        markResolverComplete: vi.fn(),
      };

      // Mock successful merge
      mockAttemptMerge.mockReturnValue({
        success: true,
        mergeCommit: "abc123",
      });

      const deps = {
        ...createMockDeps(),
        mergeQueue: mockMergeQueue,
        getWorkspacePath: vi.fn().mockReturnValue("/path/to/integrator"),
      };
      const context: LifecycleContext = {
        agentId: "resolver-1",
        role: "worker.resolver",
        taskId: "task-1",
        streamId: "stream-1",
        workspacePath: "/path/to/resolver",
        mrId: "mr-123", // MR being resolved
        parentId: "integrator-1", // Parent integrator
        integrationBranch: "integration",
      };
      const args: DoneArgs = { status: "completed" };
      const cleanupStatus: CleanupStatus = { ready: true };

      const result = await handleWorkerDone(
        context,
        args,
        cleanupStatus,
        deps as any,
      );

      // Should emit RESOLVER_DONE
      expect(result.signalsEmitted).toContain("RESOLVER_DONE");
      expect(result.signalsEmitted).not.toContain("MERGE_REQUEST");

      // Should call getWorkspacePath for the parent integrator
      expect(deps.getWorkspacePath).toHaveBeenCalledWith("integrator-1");

      // Should call markResolverComplete after successful inline merge
      expect(mockMergeQueue.markResolverComplete).toHaveBeenCalledWith(
        "mr-123",
        "abc123",
        "resolver/mr-123@1700000000",
      );

      // Should include inline merge action in cleanupActions
      expect(result.cleanupActions).toEqual(
        expect.arrayContaining([expect.stringContaining("Inline merge completed")]),
      );
    });

    it("should handle inline merge failure gracefully", async () => {
      mockGetCurrentBranch.mockReturnValue("resolver/mr-123@1700000000");

      const mockMergeQueue = {
        submit: vi.fn(),
        get: vi.fn().mockReturnValue({
          id: "mr-123",
          status: "conflict",
        }),
      };

      // Mock merge failure with nested conflict
      mockAttemptMerge.mockReturnValue({
        success: false,
        conflicts: ["file.ts"],
      });
      mockAbortMerge.mockReturnValue(true);

      const deps = {
        ...createMockDeps(),
        mergeQueue: mockMergeQueue,
        getWorkspacePath: vi.fn().mockReturnValue("/path/to/integrator"),
      };
      const context: LifecycleContext = {
        agentId: "resolver-1",
        role: "worker.resolver",
        taskId: "task-1",
        streamId: "stream-1",
        workspacePath: "/path/to/resolver",
        mrId: "mr-123",
        parentId: "integrator-1",
      };
      const args: DoneArgs = { status: "completed" };
      const cleanupStatus: CleanupStatus = { ready: true };

      const result = await handleWorkerDone(
        context,
        args,
        cleanupStatus,
        deps as any,
      );

      // Should still emit RESOLVER_DONE
      expect(result.signalsEmitted).toContain("RESOLVER_DONE");

      // Should have warning about nested conflict
      expect(result.warnings).toEqual(
        expect.arrayContaining([expect.stringContaining("Nested conflict")]),
      );
    });

    it("should warn when integrator workspace not found for inline merge", async () => {
      mockGetCurrentBranch.mockReturnValue("resolver/mr-123@1700000000");

      const deps = {
        ...createMockDeps(),
        getWorkspacePath: vi.fn().mockReturnValue(null), // No workspace found
      };
      const context: LifecycleContext = {
        agentId: "resolver-1",
        role: "worker.resolver",
        taskId: "task-1",
        workspacePath: "/path/to/resolver",
        mrId: "mr-123",
        parentId: "integrator-1",
      };
      const args: DoneArgs = { status: "completed" };
      const cleanupStatus: CleanupStatus = { ready: true };

      const result = await handleWorkerDone(
        context,
        args,
        cleanupStatus,
        deps as any,
      );

      // Should still emit RESOLVER_DONE
      expect(result.signalsEmitted).toContain("RESOLVER_DONE");

      // Should have warning about missing workspace
      expect(result.warnings).toEqual(
        expect.arrayContaining([expect.stringContaining("workspace not found")]),
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Integrator Handler
  // ─────────────────────────────────────────────────────────────────────────────

  describe("handleIntegratorDone", () => {
    it("should emit INTEGRATOR_DONE signal", async () => {
      const deps = createMockDeps();
      const context: LifecycleContext = {
        agentId: "integrator-1",
        role: "integrator",
        branch: "integration",
      };
      const args: DoneArgs = {
        status: "completed",
        summary: "Integration complete",
      };
      const cleanupStatus: CleanupStatus = { ready: true };

      const result = await handleIntegratorDone(
        context,
        args,
        cleanupStatus,
        deps as any,
      );

      expect(result.shouldTerminate).toBe(true);
      expect(result.signalsEmitted).toContain("INTEGRATOR_DONE");
      expect(deps.messageRouter.emitStatus).toHaveBeenCalledWith(
        expect.objectContaining({
          from: { agent_id: "integrator-1" },
          status_type: "completed",
          details: expect.objectContaining({
            signal: "INTEGRATOR_DONE",
            queueEmpty: true,
          }),
        }),
      );
    });

    it("should include merge queue status in cleanup actions", async () => {
      const deps = createMockDeps();
      const context: LifecycleContext = {
        agentId: "integrator-1",
        role: "integrator",
      };
      const args: DoneArgs = { status: "completed" };
      const cleanupStatus: CleanupStatus = { ready: true };

      const result = await handleIntegratorDone(
        context,
        args,
        cleanupStatus,
        deps as any,
      );

      expect(result.cleanupActions).toEqual(
        expect.arrayContaining([expect.stringContaining("Merge queue")]),
      );
    });

    it("should check actual merge queue when provided", async () => {
      const mockMergeQueue = {
        getQueueDepth: vi.fn().mockReturnValue(0),
        getNext: vi.fn().mockReturnValue(null),
      };
      const deps = {
        ...createMockDeps(),
        mergeQueue: mockMergeQueue,
      };
      const context: LifecycleContext = {
        agentId: "integrator-1",
        role: "integrator",
        streamId: "stream-1",
      };
      const args: DoneArgs = { status: "completed" };
      const cleanupStatus: CleanupStatus = { ready: true };

      const result = await handleIntegratorDone(
        context,
        args,
        cleanupStatus,
        deps as any,
      );

      expect(mockMergeQueue.getQueueDepth).toHaveBeenCalledWith("stream-1");
      expect(result.shouldTerminate).toBe(true);
    });

    it("should process pending merge requests before termination", async () => {
      // Mock a merge queue with one pending request
      const mockMergeQueue = {
        getQueueDepth: vi
          .fn()
          .mockReturnValueOnce(1) // First call: 1 pending
          .mockReturnValue(0), // After processing: 0 pending
        getNext: vi
          .fn()
          .mockReturnValueOnce({
            id: "mr-1",
            streamId: "stream-1",
            workerBranch: "feature/test",
            status: "pending",
          })
          .mockReturnValue(null), // No more items
        markProcessing: vi.fn(),
        markMerged: vi.fn(),
      };

      // Mock getCurrentBranch to return expected branch (for branch verification)
      mockGetCurrentBranch.mockReturnValue("integration");

      // Mock successful merge
      mockAttemptMerge.mockReturnValue({
        success: true,
        mergeCommit: "abc123",
      });

      const deps = {
        ...createMockDeps(),
        mergeQueue: mockMergeQueue,
        workspacePath: "/path/to/workspace",
      };
      const context: LifecycleContext = {
        agentId: "integrator-1",
        role: "integrator",
        streamId: "stream-1",
        branch: "integration",
      };
      const args: DoneArgs = { status: "completed" };
      const cleanupStatus: CleanupStatus = { ready: true };

      const result = await handleIntegratorDone(
        context,
        args,
        cleanupStatus,
        deps as any,
      );

      expect(mockGetCurrentBranch).toHaveBeenCalledWith("/path/to/workspace");
      expect(mockMergeQueue.markProcessing).toHaveBeenCalledWith("mr-1");
      expect(mockMergeQueue.markMerged).toHaveBeenCalledWith("mr-1", "abc123");
      expect(result.cleanupActions).toEqual(
        expect.arrayContaining([
          expect.stringContaining("Processed 1 merge request"),
        ]),
      );
    });

    it("should handle merge conflicts during queue processing", async () => {
      const mockMergeQueue = {
        getQueueDepth: vi.fn().mockReturnValueOnce(1).mockReturnValue(0),
        getNext: vi
          .fn()
          .mockReturnValueOnce({
            id: "mr-1",
            streamId: "stream-1",
            workerBranch: "feature/conflict",
            status: "pending",
          })
          .mockReturnValue(null),
        markProcessing: vi.fn(),
        markConflict: vi.fn(),
      };

      // Mock getCurrentBranch to return expected branch (for branch verification)
      mockGetCurrentBranch.mockReturnValue("integration");

      // Mock merge with conflicts
      mockAttemptMerge.mockReturnValue({
        success: false,
        conflicts: ["file1.ts", "file2.ts"],
      });
      mockAbortMerge.mockReturnValue(true);

      const deps = {
        ...createMockDeps(),
        mergeQueue: mockMergeQueue,
        workspacePath: "/path/to/workspace",
      };
      const context: LifecycleContext = {
        agentId: "integrator-1",
        role: "integrator",
        streamId: "stream-1",
        branch: "integration",
      };
      const args: DoneArgs = { status: "completed" };
      const cleanupStatus: CleanupStatus = { ready: true };

      const result = await handleIntegratorDone(
        context,
        args,
        cleanupStatus,
        deps as any,
      );

      expect(mockMergeQueue.markConflict).toHaveBeenCalledWith("mr-1", [
        "file1.ts",
        "file2.ts",
      ]);
      expect(result.warnings).toEqual(
        expect.arrayContaining([expect.stringContaining("conflict")]),
      );
    });

    it("should warn when queue not empty after termination", async () => {
      const mockMergeQueue = {
        getQueueDepth: vi.fn().mockReturnValue(2), // Queue not empty
        getNext: vi.fn().mockReturnValue(null), // But no items to process (race condition)
      };
      const deps = {
        ...createMockDeps(),
        mergeQueue: mockMergeQueue,
        workspacePath: "/path/to/workspace",
      };
      const context: LifecycleContext = {
        agentId: "integrator-1",
        role: "integrator",
        streamId: "stream-1",
      };
      const args: DoneArgs = { status: "completed" };
      const cleanupStatus: CleanupStatus = { ready: true };

      const result = await handleIntegratorDone(
        context,
        args,
        cleanupStatus,
        deps as any,
      );

      expect(result.warnings).toEqual(
        expect.arrayContaining([expect.stringContaining("pending request")]),
      );
    });

    it("should skip queue processing when no stream ID", async () => {
      const mockMergeQueue = {
        getQueueDepth: vi.fn(),
        getNext: vi.fn(),
      };
      const deps = {
        ...createMockDeps(),
        mergeQueue: mockMergeQueue,
      };
      const context: LifecycleContext = {
        agentId: "integrator-1",
        role: "integrator",
        // No streamId
      };
      const args: DoneArgs = { status: "completed" };
      const cleanupStatus: CleanupStatus = { ready: true };

      const result = await handleIntegratorDone(
        context,
        args,
        cleanupStatus,
        deps as any,
      );

      expect(mockMergeQueue.getQueueDepth).not.toHaveBeenCalled();
      expect(result.cleanupActions).toEqual(
        expect.arrayContaining([expect.stringContaining("No stream ID")]),
      );
    });

    it("should include streamId in INTEGRATOR_DONE signal", async () => {
      const deps = createMockDeps();
      const context: LifecycleContext = {
        agentId: "integrator-1",
        role: "integrator",
        streamId: "stream-123",
      };
      const args: DoneArgs = { status: "completed" };
      const cleanupStatus: CleanupStatus = { ready: true };

      await handleIntegratorDone(context, args, cleanupStatus, deps as any);

      expect(deps.messageRouter.emitStatus).toHaveBeenCalledWith(
        expect.objectContaining({
          details: expect.objectContaining({
            streamId: "stream-123",
          }),
        }),
      );
    });

    // ─────────────────────────────────────────────────────────────────────────────
    // Resolver Spawning Tests (spawnResolverWorker via handleIntegratorDone)
    // ─────────────────────────────────────────────────────────────────────────────

    it("should spawn resolver worker when merge conflicts occur", async () => {
      const mockMergeQueue = {
        getQueueDepth: vi.fn().mockReturnValueOnce(1).mockReturnValue(0),
        getNext: vi
          .fn()
          .mockReturnValueOnce({
            id: "mr-1",
            streamId: "stream-1",
            workerBranch: "feature/conflict",
            workerAgentId: "worker-1",
            taskId: "task-1",
            status: "pending",
          })
          .mockReturnValue(null),
        markProcessing: vi.fn(),
        markConflict: vi.fn(),
      };

      // Mock agentManager with spawn capability
      const mockAgentManager = {
        getChildren: vi.fn().mockReturnValue([]),
        spawn: vi.fn().mockResolvedValue({ id: "resolver-1" }),
      };

      mockGetCurrentBranch.mockReturnValue("integration");
      mockAttemptMerge.mockReturnValue({
        success: false,
        conflicts: ["file1.ts", "file2.ts"],
      });
      mockAbortMerge.mockReturnValue(true);

      const deps = {
        messageRouter: {
          emitStatus: vi.fn(),
          getSubscriptions: vi.fn().mockReturnValue([]),
          unsubscribe: vi.fn(),
        },
        agentManager: mockAgentManager,
        mergeQueue: mockMergeQueue,
        workspacePath: "/path/to/workspace",
      };
      const context: LifecycleContext = {
        agentId: "integrator-1",
        role: "integrator",
        streamId: "stream-1",
        branch: "integration",
      };
      const args: DoneArgs = { status: "completed" };
      const cleanupStatus: CleanupStatus = { ready: true };

      await handleIntegratorDone(context, args, cleanupStatus, deps as any);

      // Verify spawn was called with correct parameters
      expect(mockAgentManager.spawn).toHaveBeenCalledWith(
        expect.objectContaining({
          role: "worker.resolver",
          parent: "integrator-1",
          streamId: "stream-1",
        }),
      );

      // Verify resolver was passed to markConflict
      expect(mockMergeQueue.markConflict).toHaveBeenCalledWith(
        "mr-1",
        ["file1.ts", "file2.ts"],
        "resolver-1",
      );

      // Verify CONFLICT_DETECTED signal includes resolver info
      expect(deps.messageRouter.emitStatus).toHaveBeenCalledWith(
        expect.objectContaining({
          details: expect.objectContaining({
            signal: "CONFLICT_DETECTED",
            resolverSpawned: true,
            resolverId: "resolver-1",
          }),
        }),
      );
    });

    it("should handle conflict without resolver when agentManager.spawn fails", async () => {
      const mockMergeQueue = {
        getQueueDepth: vi.fn().mockReturnValueOnce(1).mockReturnValue(0),
        getNext: vi
          .fn()
          .mockReturnValueOnce({
            id: "mr-1",
            streamId: "stream-1",
            workerBranch: "feature/conflict",
            workerAgentId: "worker-1",
            taskId: "task-1",
            status: "pending",
          })
          .mockReturnValue(null),
        markProcessing: vi.fn(),
        markConflict: vi.fn(),
      };

      // Mock agentManager with spawn that throws
      const mockAgentManager = {
        getChildren: vi.fn().mockReturnValue([]),
        spawn: vi.fn().mockRejectedValue(new Error("Spawn failed")),
      };

      mockGetCurrentBranch.mockReturnValue("integration");
      mockAttemptMerge.mockReturnValue({
        success: false,
        conflicts: ["file1.ts"],
      });
      mockAbortMerge.mockReturnValue(true);

      const deps = {
        messageRouter: {
          emitStatus: vi.fn(),
          getSubscriptions: vi.fn().mockReturnValue([]),
          unsubscribe: vi.fn(),
        },
        agentManager: mockAgentManager,
        mergeQueue: mockMergeQueue,
        workspacePath: "/path/to/workspace",
      };
      const context: LifecycleContext = {
        agentId: "integrator-1",
        role: "integrator",
        streamId: "stream-1",
        branch: "integration",
      };
      const args: DoneArgs = { status: "completed" };
      const cleanupStatus: CleanupStatus = { ready: true };

      await handleIntegratorDone(context, args, cleanupStatus, deps as any);

      // Verify markConflict called without resolver ID
      expect(mockMergeQueue.markConflict).toHaveBeenCalledWith("mr-1", [
        "file1.ts",
      ]);

      // Verify CONFLICT_DETECTED signal indicates no resolver
      expect(deps.messageRouter.emitStatus).toHaveBeenCalledWith(
        expect.objectContaining({
          details: expect.objectContaining({
            signal: "CONFLICT_DETECTED",
            resolverSpawned: false,
          }),
        }),
      );
    });

    it("should handle conflict without resolver when no agentManager", async () => {
      const mockMergeQueue = {
        getQueueDepth: vi.fn().mockReturnValueOnce(1).mockReturnValue(0),
        getNext: vi
          .fn()
          .mockReturnValueOnce({
            id: "mr-1",
            streamId: "stream-1",
            workerBranch: "feature/conflict",
            status: "pending",
          })
          .mockReturnValue(null),
        markProcessing: vi.fn(),
        markConflict: vi.fn(),
      };

      mockGetCurrentBranch.mockReturnValue("integration");
      mockAttemptMerge.mockReturnValue({
        success: false,
        conflicts: ["file1.ts"],
      });
      mockAbortMerge.mockReturnValue(true);

      const deps = {
        messageRouter: {
          emitStatus: vi.fn(),
          getSubscriptions: vi.fn().mockReturnValue([]),
          unsubscribe: vi.fn(),
        },
        // No agentManager
        mergeQueue: mockMergeQueue,
        workspacePath: "/path/to/workspace",
      };
      const context: LifecycleContext = {
        agentId: "integrator-1",
        role: "integrator",
        streamId: "stream-1",
        branch: "integration",
      };
      const args: DoneArgs = { status: "completed" };
      const cleanupStatus: CleanupStatus = { ready: true };

      await handleIntegratorDone(context, args, cleanupStatus, deps as any);

      // Should still mark conflict, just without resolver
      expect(mockMergeQueue.markConflict).toHaveBeenCalledWith("mr-1", [
        "file1.ts",
      ]);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // handleResolverDone Tests
  // ─────────────────────────────────────────────────────────────────────────────

  describe("handleResolverDone", () => {
    it("should merge resolver branch and mark MR as resolved", async () => {
      const mockMergeQueue = {
        get: vi.fn().mockReturnValue({
          id: "mr-1",
          status: "conflict",
        }),
        markResolverComplete: vi.fn(),
      };

      mockAttemptMerge.mockReturnValue({
        success: true,
        mergeCommit: "abc123",
      });

      const deps = {
        messageRouter: {
          emitStatus: vi.fn(),
        },
        mergeQueue: mockMergeQueue,
        workspacePath: "/path/to/workspace",
      };
      const context: LifecycleContext = {
        agentId: "integrator-1",
        role: "integrator",
      };

      const result = await handleResolverDone(
        "mr-1",
        "resolver/mr-1@12345",
        context,
        deps as any,
      );

      expect(result.success).toBe(true);
      expect(result.mergeCommit).toBe("abc123");
      expect(mockMergeQueue.markResolverComplete).toHaveBeenCalledWith(
        "mr-1",
        "abc123",
        "resolver/mr-1@12345",
      );
      expect(deps.messageRouter.emitStatus).toHaveBeenCalledWith(
        expect.objectContaining({
          status_type: "completed",
          details: expect.objectContaining({
            signal: "MERGE_COMPLETE",
            mrId: "mr-1",
            resolvedVia: "resolver",
          }),
        }),
      );
    });

    it("should return error when MR not found", async () => {
      const mockMergeQueue = {
        get: vi.fn().mockReturnValue(null),
      };

      const deps = {
        messageRouter: { emitStatus: vi.fn() },
        mergeQueue: mockMergeQueue,
        workspacePath: "/path/to/workspace",
      };
      const context: LifecycleContext = {
        agentId: "integrator-1",
        role: "integrator",
      };

      const result = await handleResolverDone(
        "mr-nonexistent",
        "resolver/mr-nonexistent@12345",
        context,
        deps as any,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("not found");
    });

    it("should return error when MR not in conflict state", async () => {
      const mockMergeQueue = {
        get: vi.fn().mockReturnValue({
          id: "mr-1",
          status: "pending", // Not in conflict state
        }),
      };

      const deps = {
        messageRouter: { emitStatus: vi.fn() },
        mergeQueue: mockMergeQueue,
        workspacePath: "/path/to/workspace",
      };
      const context: LifecycleContext = {
        agentId: "integrator-1",
        role: "integrator",
      };

      const result = await handleResolverDone(
        "mr-1",
        "resolver/mr-1@12345",
        context,
        deps as any,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("not in conflict state");
    });

    it("should handle nested conflicts (resolver also conflicts)", async () => {
      const mockMergeQueue = {
        get: vi.fn().mockReturnValue({
          id: "mr-1",
          status: "conflict",
        }),
      };

      mockAttemptMerge.mockReturnValue({
        success: false,
        conflicts: ["file1.ts", "file2.ts"],
      });
      mockAbortMerge.mockReturnValue(true);

      const deps = {
        messageRouter: {
          emitStatus: vi.fn(),
        },
        mergeQueue: mockMergeQueue,
        workspacePath: "/path/to/workspace",
      };
      const context: LifecycleContext = {
        agentId: "integrator-1",
        role: "integrator",
      };

      const result = await handleResolverDone(
        "mr-1",
        "resolver/mr-1@12345",
        context,
        deps as any,
      );

      expect(result.success).toBe(false);
      expect(result.nestedConflict).toBe(true);
      expect(result.conflictFiles).toEqual(["file1.ts", "file2.ts"]);

      // Should emit CONFLICT_UNRESOLVED for escalation
      expect(deps.messageRouter.emitStatus).toHaveBeenCalledWith(
        expect.objectContaining({
          status_type: "failed",
          details: expect.objectContaining({
            signal: "CONFLICT_UNRESOLVED",
            reason: "resolver_conflict",
          }),
        }),
      );
    });

    it("should return error when mergeQueue is not provided", async () => {
      const deps = {
        messageRouter: { emitStatus: vi.fn() },
        // No mergeQueue
        workspacePath: "/path/to/workspace",
      };
      const context: LifecycleContext = {
        agentId: "integrator-1",
        role: "integrator",
      };

      const result = await handleResolverDone(
        "mr-1",
        "resolver/mr-1@12345",
        context,
        deps as any,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("Missing");
    });

    it("should return error when workspacePath is not provided", async () => {
      const deps = {
        messageRouter: { emitStatus: vi.fn() },
        mergeQueue: { get: vi.fn() },
        // No workspacePath
      };
      const context: LifecycleContext = {
        agentId: "integrator-1",
        role: "integrator",
      };

      const result = await handleResolverDone(
        "mr-1",
        "resolver/mr-1@12345",
        context,
        deps as any,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("Missing");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Monitor Handler
  // ─────────────────────────────────────────────────────────────────────────────

  describe("handleMonitorDone", () => {
    it("should unsubscribe from all channels", async () => {
      const deps = createMockDeps();
      deps.messageRouter.getSubscriptions.mockReturnValue([
        { type: "topic", target: "events" },
        { type: "subtree", target: "parent-1" },
      ]);

      const context: LifecycleContext = {
        agentId: "monitor-1",
        role: "monitor",
      };
      const args: DoneArgs = { status: "completed" };
      const cleanupStatus: CleanupStatus = { ready: true };

      const result = await handleMonitorDone(
        context,
        args,
        cleanupStatus,
        deps as any,
      );

      expect(result.shouldTerminate).toBe(true);
      expect(deps.messageRouter.unsubscribe).toHaveBeenCalledTimes(2);
      expect(result.cleanupActions).toEqual(
        expect.arrayContaining([expect.stringContaining("Unsubscribed")]),
      );
    });

    it("should handle no subscriptions gracefully", async () => {
      const deps = createMockDeps();
      deps.messageRouter.getSubscriptions.mockReturnValue([]);

      const context: LifecycleContext = {
        agentId: "monitor-1",
        role: "monitor",
      };
      const args: DoneArgs = { status: "completed" };
      const cleanupStatus: CleanupStatus = { ready: true };

      const result = await handleMonitorDone(
        context,
        args,
        cleanupStatus,
        deps as any,
      );

      expect(result.cleanupActions).toContain("No subscriptions to clean up");
    });

    it("should emit STATUS signal", async () => {
      const deps = createMockDeps();
      const context: LifecycleContext = {
        agentId: "monitor-1",
        role: "monitor",
      };
      const args: DoneArgs = { status: "completed" };
      const cleanupStatus: CleanupStatus = { ready: true };

      const result = await handleMonitorDone(
        context,
        args,
        cleanupStatus,
        deps as any,
      );

      expect(result.signalsEmitted).toContain("STATUS");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Generic Handler
  // ─────────────────────────────────────────────────────────────────────────────

  describe("handleGenericDone", () => {
    it("should emit STATUS signal with role info", async () => {
      const deps = createMockDeps();
      const context: LifecycleContext = {
        agentId: "agent-1",
        role: "custom-role",
      };
      const args: DoneArgs = { status: "completed" };
      const cleanupStatus: CleanupStatus = { ready: true };

      const result = await handleGenericDone(
        context,
        args,
        cleanupStatus,
        deps as any,
      );

      expect(result.shouldTerminate).toBe(true);
      expect(result.signalsEmitted).toContain("STATUS");
      expect(deps.messageRouter.emitStatus).toHaveBeenCalledWith(
        expect.objectContaining({
          details: expect.objectContaining({
            role: "custom-role",
          }),
        }),
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Handler Registry
  // ─────────────────────────────────────────────────────────────────────────────

  describe("createHandlerRegistry", () => {
    it("should create registry with built-in handlers", () => {
      const deps = createMockDeps();
      const registry = createHandlerRegistry(deps as any);

      expect(registry.has("worker")).toBe(true);
      expect(registry.has("integrator")).toBe(true);
      expect(registry.has("monitor")).toBe(true);
    });
  });

  describe("getHandler", () => {
    it("should return exact match handler", () => {
      const deps = createMockDeps();
      const registry = createHandlerRegistry(deps as any);

      const handler = getHandler("worker", registry, deps as any);

      expect(handler).toBeDefined();
    });

    it("should return base role handler for dot-notation roles", () => {
      const deps = createMockDeps();
      const registry = createHandlerRegistry(deps as any);

      const handler = getHandler("worker.resolver", registry, deps as any);

      expect(handler).toBeDefined();
    });

    it("should return generic handler for unknown roles", () => {
      const deps = createMockDeps();
      const registry = createHandlerRegistry(deps as any);

      const handler = getHandler("custom-role", registry, deps as any);

      expect(handler).toBeDefined();
    });
  });

  describe("dispatchDone", () => {
    it("should dispatch to correct handler based on role", async () => {
      const deps = createMockDeps();
      const context: LifecycleContext = {
        agentId: "worker-1",
        role: "worker",
      };
      const args: DoneArgs = { status: "completed" };
      const cleanupStatus: CleanupStatus = { ready: true };

      const result = await dispatchDone(
        context,
        args,
        cleanupStatus,
        deps as any,
      );

      expect(result.shouldTerminate).toBe(true);
      expect(result.signalsEmitted).toContain("WORKER_DONE");
    });

    it("should use generic handler for unknown roles", async () => {
      const deps = createMockDeps();
      const context: LifecycleContext = {
        agentId: "agent-1",
        role: "unknown-role",
      };
      const args: DoneArgs = { status: "completed" };
      const cleanupStatus: CleanupStatus = { ready: true };

      const result = await dispatchDone(
        context,
        args,
        cleanupStatus,
        deps as any,
      );

      expect(result.shouldTerminate).toBe(true);
      expect(result.signalsEmitted).toContain("STATUS");
    });

    it("should use custom registry when provided", async () => {
      const deps = createMockDeps();
      const customHandler = vi.fn().mockResolvedValue({
        shouldTerminate: false,
        signalsEmitted: ["CUSTOM"],
      });
      const customRegistry = new Map([["custom", customHandler]]);

      const context: LifecycleContext = {
        agentId: "agent-1",
        role: "custom",
      };
      const args: DoneArgs = { status: "completed" };
      const cleanupStatus: CleanupStatus = { ready: true };

      const result = await dispatchDone(
        context,
        args,
        cleanupStatus,
        deps as any,
        customRegistry,
      );

      expect(customHandler).toHaveBeenCalled();
      expect(result.shouldTerminate).toBe(false);
      expect(result.signalsEmitted).toContain("CUSTOM");
    });
  });
});
