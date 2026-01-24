/**
 * Merge Queue E2E Tests
 *
 * Integration tests verifying the full worker → queue → integrator flow
 * using real MergeQueue instances.
 *
 * @see s-bcqm Change Management spec
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { handleWorkerDone } from "../handlers/worker.js";
import { handleIntegratorDone } from "../handlers/integrator.js";
import { MergeQueue } from "../../workspace/merge-queue/merge-queue.js";
import type { LifecycleContext, CleanupStatus } from "../types.js";
import type { WorkerHandlerDeps } from "../handlers/worker.js";
import type { IntegratorHandlerDeps } from "../handlers/integrator.js";

// Mock cleanup module for git operations
vi.mock("../cleanup.js", () => ({
  commitChanges: vi.fn(),
  getCurrentBranch: vi.fn(),
  attemptMerge: vi.fn(),
  abortMerge: vi.fn(),
}));

import { getCurrentBranch, attemptMerge, abortMerge } from "../cleanup.js";

const mockGetCurrentBranch = vi.mocked(getCurrentBranch);
const mockAttemptMerge = vi.mocked(attemptMerge);
const mockAbortMerge = vi.mocked(abortMerge);

// Create mock dependencies
function createMockMessageRouter() {
  return {
    emitStatus: vi.fn(),
    getSubscriptions: vi.fn().mockReturnValue([]),
    unsubscribe: vi.fn(),
  };
}

function createMockAgentManager() {
  return {
    getChildren: vi.fn().mockReturnValue([]),
  };
}

describe("Merge Queue E2E", () => {
  let db: Database.Database;
  let mergeQueue: MergeQueue;

  beforeEach(() => {
    // Set up real instances (in-memory SQLite)
    db = new Database(":memory:");
    mergeQueue = new MergeQueue({ db, tablePrefix: "test_", initSchema: true });

    // Reset mocks
    vi.clearAllMocks();

    // Default mock for getCurrentBranch - tests can override as needed
    // This prevents infinite loops when processAllPendingMerges checks branch
    mockGetCurrentBranch.mockReturnValue("integration");
  });

  afterEach(() => {
    mergeQueue.close();
    db.close();
  });

  // =============================================================================
  // Worker → Queue → Integrator flow
  // =============================================================================

  describe("Worker → Queue → Integrator flow", () => {
    it("should submit merge request when worker completes", async () => {
      mockGetCurrentBranch.mockReturnValue("feature/test");

      const messageRouter = createMockMessageRouter();
      const context: LifecycleContext = {
        agentId: "worker-1",
        role: "worker",
        streamId: "stream-1",
        taskId: "task-1",
        workspacePath: "/tmp/test-workspace",
        branch: "feature/test",
      };

      const deps: WorkerHandlerDeps = {
        messageRouter: messageRouter as any,
        agentManager: createMockAgentManager() as any,
        mergeQueue,
      };

      // Call worker done
      const result = await handleWorkerDone(
        context,
        { status: "completed" },
        { ready: true },
        deps
      );

      // Verify result
      expect(result.shouldTerminate).toBe(true);
      expect(result.signalsEmitted).toContain("MERGE_REQUEST");

      // Verify queue has the merge request
      const pending = mergeQueue.getPending("stream-1");
      expect(pending).toHaveLength(1);
      expect(pending[0].workerBranch).toBe("feature/test");
      expect(pending[0].taskId).toBe("task-1");
      expect(pending[0].workerAgentId).toBe("worker-1");
      expect(pending[0].status).toBe("pending");
    });

    it("should process queue when integrator completes", async () => {
      // Pre-populate queue
      mergeQueue.submit({
        streamId: "stream-1",
        taskId: "task-1",
        workerBranch: "feature/test",
        workerAgentId: "worker-1",
      });

      // Mock successful merge
      mockAttemptMerge.mockReturnValue({
        success: true,
        mergeCommit: "abc123def",
      });

      const messageRouter = createMockMessageRouter();
      const context: LifecycleContext = {
        agentId: "integrator-1",
        role: "integrator",
        streamId: "stream-1",
      };

      const deps: IntegratorHandlerDeps = {
        messageRouter: messageRouter as any,
        mergeQueue,
        workspacePath: "/tmp/test-workspace",
      };

      // Call integrator done
      const result = await handleIntegratorDone(
        context,
        { status: "completed" },
        { ready: true },
        deps
      );

      // Verify result
      expect(result.shouldTerminate).toBe(true);
      expect(result.signalsEmitted).toContain("INTEGRATOR_DONE");
      expect(result.cleanupActions).toEqual(
        expect.arrayContaining([expect.stringContaining("Processed 1")])
      );

      // Verify queue is now empty
      expect(mergeQueue.getQueueDepth("stream-1")).toBe(0);

      // Verify MR was marked as merged
      const mr = mergeQueue.getByTask("task-1");
      expect(mr?.status).toBe("merged");
      expect(mr?.mergeCommit).toBe("abc123def");
    });

    it("should handle full worker→integrator flow", async () => {
      mockGetCurrentBranch.mockReturnValue("feature/full-flow");

      const messageRouter = createMockMessageRouter();

      // Step 1: Worker completes and submits to queue
      const workerContext: LifecycleContext = {
        agentId: "worker-1",
        role: "worker",
        streamId: "stream-1",
        taskId: "task-full",
        workspacePath: "/tmp/worker-workspace",
        branch: "feature/full-flow",
        integrationBranch: "integration",
      };

      const workerDeps: WorkerHandlerDeps = {
        messageRouter: messageRouter as any,
        agentManager: createMockAgentManager() as any,
        mergeQueue,
      };

      await handleWorkerDone(
        workerContext,
        { status: "completed", summary: "Feature implemented" },
        { ready: true },
        workerDeps
      );

      // Verify queue received the request
      expect(mergeQueue.getQueueDepth("stream-1")).toBe(1);

      // Step 2: Integrator processes queue
      // Integrator is on the integration branch, not the worker branch
      mockGetCurrentBranch.mockReturnValue("integration");
      mockAttemptMerge.mockReturnValue({
        success: true,
        mergeCommit: "merge-commit-123",
      });

      const integratorContext: LifecycleContext = {
        agentId: "integrator-1",
        role: "integrator",
        streamId: "stream-1",
        branch: "integration",
      };

      const integratorDeps: IntegratorHandlerDeps = {
        messageRouter: messageRouter as any,
        mergeQueue,
        workspacePath: "/tmp/integrator-workspace",
      };

      const result = await handleIntegratorDone(
        integratorContext,
        { status: "completed" },
        { ready: true },
        integratorDeps
      );

      // Verify full flow completed
      expect(mergeQueue.getQueueDepth("stream-1")).toBe(0);
      const mr = mergeQueue.getByTask("task-full");
      expect(mr?.status).toBe("merged");
      expect(result.cleanupActions).toEqual(
        expect.arrayContaining([expect.stringContaining("1 merged")])
      );
    });
  });

  // =============================================================================
  // Multiple workers
  // =============================================================================

  describe("Multiple workers", () => {
    it("should process multiple merge requests in FIFO order", async () => {
      // Submit multiple requests with different timestamps
      mergeQueue.submit({
        streamId: "stream-1",
        taskId: "task-1",
        workerBranch: "feature/a",
        workerAgentId: "worker-1",
      });
      mergeQueue.submit({
        streamId: "stream-1",
        taskId: "task-2",
        workerBranch: "feature/b",
        workerAgentId: "worker-2",
      });
      mergeQueue.submit({
        streamId: "stream-1",
        taskId: "task-3",
        workerBranch: "feature/c",
        workerAgentId: "worker-3",
      });

      // Track merge order
      const mergeOrder: string[] = [];
      mockAttemptMerge.mockImplementation((branch: string) => {
        mergeOrder.push(branch);
        return { success: true, mergeCommit: `commit-${branch}` };
      });

      const messageRouter = createMockMessageRouter();
      const deps: IntegratorHandlerDeps = {
        messageRouter: messageRouter as any,
        mergeQueue,
        workspacePath: "/tmp/test-workspace",
      };

      await handleIntegratorDone(
        { agentId: "integrator-1", role: "integrator", streamId: "stream-1" },
        { status: "completed" },
        { ready: true },
        deps
      );

      // Verify FIFO order
      expect(mergeOrder).toEqual(["feature/a", "feature/b", "feature/c"]);

      // Verify all processed
      expect(mergeQueue.getQueueDepth("stream-1")).toBe(0);
      expect(mergeQueue.getByTask("task-1")?.status).toBe("merged");
      expect(mergeQueue.getByTask("task-2")?.status).toBe("merged");
      expect(mergeQueue.getByTask("task-3")?.status).toBe("merged");
    });

    it("should process priority requests before lower priority", async () => {
      // Submit requests with different priorities
      mergeQueue.submit({
        streamId: "stream-1",
        taskId: "task-low",
        workerBranch: "feature/low",
        workerAgentId: "worker-1",
        priority: 100, // Default/low priority
      });
      mergeQueue.submit({
        streamId: "stream-1",
        taskId: "task-high",
        workerBranch: "feature/high",
        workerAgentId: "worker-2",
        priority: 10, // High priority
      });

      const mergeOrder: string[] = [];
      mockAttemptMerge.mockImplementation((branch: string) => {
        mergeOrder.push(branch);
        return { success: true, mergeCommit: `commit-${branch}` };
      });

      const messageRouter = createMockMessageRouter();
      const deps: IntegratorHandlerDeps = {
        messageRouter: messageRouter as any,
        mergeQueue,
        workspacePath: "/tmp/test-workspace",
      };

      await handleIntegratorDone(
        { agentId: "integrator-1", role: "integrator", streamId: "stream-1" },
        { status: "completed" },
        { ready: true },
        deps
      );

      // High priority should be processed first
      expect(mergeOrder).toEqual(["feature/high", "feature/low"]);
    });

    it("should isolate streams - only process requests for specific stream", async () => {
      // Submit to different streams
      mergeQueue.submit({
        streamId: "stream-1",
        taskId: "task-s1",
        workerBranch: "feature/s1",
        workerAgentId: "worker-1",
      });
      mergeQueue.submit({
        streamId: "stream-2",
        taskId: "task-s2",
        workerBranch: "feature/s2",
        workerAgentId: "worker-2",
      });

      mockAttemptMerge.mockReturnValue({
        success: true,
        mergeCommit: "abc123",
      });

      const messageRouter = createMockMessageRouter();
      const deps: IntegratorHandlerDeps = {
        messageRouter: messageRouter as any,
        mergeQueue,
        workspacePath: "/tmp/test-workspace",
      };

      // Process only stream-1
      await handleIntegratorDone(
        { agentId: "integrator-1", role: "integrator", streamId: "stream-1" },
        { status: "completed" },
        { ready: true },
        deps
      );

      // stream-1 processed, stream-2 untouched
      expect(mergeQueue.getQueueDepth("stream-1")).toBe(0);
      expect(mergeQueue.getQueueDepth("stream-2")).toBe(1);
      expect(mergeQueue.getByTask("task-s1")?.status).toBe("merged");
      expect(mergeQueue.getByTask("task-s2")?.status).toBe("pending");
    });
  });

  // =============================================================================
  // Conflict handling
  // =============================================================================

  describe("Conflict handling", () => {
    it("should mark conflicting requests and continue processing others", async () => {
      // Submit two requests
      mergeQueue.submit({
        streamId: "stream-1",
        taskId: "task-1",
        workerBranch: "feature/a",
        workerAgentId: "worker-1",
      });
      mergeQueue.submit({
        streamId: "stream-1",
        taskId: "task-2",
        workerBranch: "feature/b",
        workerAgentId: "worker-2",
      });

      // First succeeds, second conflicts
      mockAttemptMerge
        .mockReturnValueOnce({ success: true, mergeCommit: "commit-a" })
        .mockReturnValueOnce({ success: false, conflicts: ["file.ts"] });
      mockAbortMerge.mockReturnValue(true);

      const messageRouter = createMockMessageRouter();
      const deps: IntegratorHandlerDeps = {
        messageRouter: messageRouter as any,
        mergeQueue,
        workspacePath: "/tmp/test-workspace",
      };

      const result = await handleIntegratorDone(
        { agentId: "integrator-1", role: "integrator", streamId: "stream-1" },
        { status: "completed" },
        { ready: true },
        deps
      );

      // Verify both were processed
      expect(result.cleanupActions).toEqual(
        expect.arrayContaining([expect.stringContaining("1 merged")])
      );
      expect(result.cleanupActions).toEqual(
        expect.arrayContaining([expect.stringContaining("1 conflict")])
      );

      // Verify statuses
      expect(mergeQueue.getByTask("task-1")?.status).toBe("merged");
      expect(mergeQueue.getByTask("task-2")?.status).toBe("conflict");
      expect(mergeQueue.getByTask("task-2")?.conflictFiles).toEqual(["file.ts"]);

      // Verify abort was called for the conflict
      expect(mockAbortMerge).toHaveBeenCalledTimes(1);
    });

    it("should handle all conflicts gracefully", async () => {
      mergeQueue.submit({
        streamId: "stream-1",
        taskId: "task-1",
        workerBranch: "feature/conflict1",
        workerAgentId: "worker-1",
      });
      mergeQueue.submit({
        streamId: "stream-1",
        taskId: "task-2",
        workerBranch: "feature/conflict2",
        workerAgentId: "worker-2",
      });

      // Both conflict
      mockAttemptMerge.mockReturnValue({
        success: false,
        conflicts: ["shared.ts"],
      });
      mockAbortMerge.mockReturnValue(true);

      const messageRouter = createMockMessageRouter();
      const deps: IntegratorHandlerDeps = {
        messageRouter: messageRouter as any,
        mergeQueue,
        workspacePath: "/tmp/test-workspace",
      };

      const result = await handleIntegratorDone(
        { agentId: "integrator-1", role: "integrator", streamId: "stream-1" },
        { status: "completed" },
        { ready: true },
        deps
      );

      // Should complete without error
      expect(result.shouldTerminate).toBe(true);
      expect(result.cleanupActions).toEqual(
        expect.arrayContaining([expect.stringContaining("2 conflicts")])
      );
      expect(result.warnings).toEqual(
        expect.arrayContaining([expect.stringContaining("conflict")])
      );

      // All should be marked as conflict
      expect(mergeQueue.getByTask("task-1")?.status).toBe("conflict");
      expect(mergeQueue.getByTask("task-2")?.status).toBe("conflict");
    });

    it("should handle merge errors (not conflicts) gracefully", async () => {
      mergeQueue.submit({
        streamId: "stream-1",
        taskId: "task-1",
        workerBranch: "feature/error",
        workerAgentId: "worker-1",
      });

      // Merge fails without conflicts (e.g., branch not found)
      mockAttemptMerge.mockReturnValue({
        success: false,
        error: "Branch not found",
      });
      mockAbortMerge.mockReturnValue(true);

      const messageRouter = createMockMessageRouter();
      const deps: IntegratorHandlerDeps = {
        messageRouter: messageRouter as any,
        mergeQueue,
        workspacePath: "/tmp/test-workspace",
      };

      const result = await handleIntegratorDone(
        { agentId: "integrator-1", role: "integrator", streamId: "stream-1" },
        { status: "completed" },
        { ready: true },
        deps
      );

      // Should complete without crashing
      expect(result.shouldTerminate).toBe(true);

      // Should be marked as conflict (generic error handling)
      expect(mergeQueue.getByTask("task-1")?.status).toBe("conflict");
    });
  });

  // =============================================================================
  // Edge cases
  // =============================================================================

  describe("Edge cases", () => {
    it("should handle empty queue gracefully", async () => {
      const messageRouter = createMockMessageRouter();
      const deps: IntegratorHandlerDeps = {
        messageRouter: messageRouter as any,
        mergeQueue,
        workspacePath: "/tmp/test-workspace",
      };

      const result = await handleIntegratorDone(
        { agentId: "integrator-1", role: "integrator", streamId: "stream-1" },
        { status: "completed" },
        { ready: true },
        deps
      );

      // Should complete successfully with no warnings
      expect(result.shouldTerminate).toBe(true);
      expect(result.cleanupActions).toEqual(
        expect.arrayContaining([expect.stringContaining("Merge queue final status: empty")])
      );
      // No processing should have happened
      expect(mockAttemptMerge).not.toHaveBeenCalled();
    });

    it("should not submit if worker fails", async () => {
      mockGetCurrentBranch.mockReturnValue("feature/failed");

      const messageRouter = createMockMessageRouter();
      const deps: WorkerHandlerDeps = {
        messageRouter: messageRouter as any,
        agentManager: createMockAgentManager() as any,
        mergeQueue,
      };

      await handleWorkerDone(
        {
          agentId: "worker-1",
          role: "worker",
          streamId: "stream-1",
          taskId: "task-failed",
          workspacePath: "/tmp/workspace",
        },
        { status: "failed" },
        { ready: true },
        deps
      );

      // Queue should be empty
      expect(mergeQueue.getQueueDepth("stream-1")).toBe(0);
    });

    it("should not submit if worker is blocked", async () => {
      const messageRouter = createMockMessageRouter();
      const deps: WorkerHandlerDeps = {
        messageRouter: messageRouter as any,
        agentManager: createMockAgentManager() as any,
        mergeQueue,
      };

      await handleWorkerDone(
        {
          agentId: "worker-1",
          role: "worker",
          streamId: "stream-1",
          taskId: "task-blocked",
          workspacePath: "/tmp/workspace",
        },
        { status: "blocked" },
        { ready: true },
        deps
      );

      // Queue should be empty
      expect(mergeQueue.getQueueDepth("stream-1")).toBe(0);
    });
  });
});
