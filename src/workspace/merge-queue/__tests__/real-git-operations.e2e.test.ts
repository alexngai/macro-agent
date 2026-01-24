/**
 * Merge Queue E2E Tests - Real Git Operations
 *
 * Tests the merge queue with actual git repositories, real merges,
 * and real conflict detection. Uses TempRepoFactory for isolated repos.
 *
 * @see s-bcqm Change Management and Merge Queue
 * @see s-1zcx Multi-Agent Orchestration Testing Strategy
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { createTempRepo } from "../../../../test_fixtures/fixtures/repos/temp-repo-factory.js";
import type { TempRepo } from "../../../../test_fixtures/fixtures/repos/types.js";
import { MergeQueue } from "../merge-queue.js";
import {
  attemptMerge,
  abortMerge,
  hasMergeInProgress,
  getCurrentBranch,
} from "../../../lifecycle/cleanup.js";

describe("Merge Queue E2E - Real Git Operations", () => {
  let repo: TempRepo;
  let db: Database.Database;
  let mergeQueue: MergeQueue;

  beforeEach(async () => {
    // Create temp repo with initial file
    repo = await createTempRepo({
      initialFiles: {
        "src/index.ts": 'export const VERSION = "1.0.0";\n',
        "README.md": "# Test Project\n",
      },
      initialBranch: "main",
    });

    // Create in-memory database for merge queue
    db = new Database(":memory:");
    mergeQueue = new MergeQueue({ db, tablePrefix: "test_", initSchema: true });
  });

  afterEach(async () => {
    mergeQueue.close();
    db.close();
    await repo.cleanup();
  });

  // =============================================================================
  // MQ-GIT-01: Basic merge with real git
  // =============================================================================

  describe("MQ-GIT-01: Basic merge operations", () => {
    it("should successfully merge a worker branch with no conflicts", async () => {
      // Create worker branch with new file
      repo.checkout("worker/agent-1/task-1", true);
      repo.writeFile("src/feature.ts", 'export function feature() { return "new"; }\n');
      const workerCommit = repo.commit("Add feature");

      // Switch back to main
      repo.checkout("main");

      // Submit to queue
      const mrId = mergeQueue.submit({
        streamId: "stream-1",
        taskId: "task-1",
        workerBranch: "worker/agent-1/task-1",
        workerAgentId: "agent-1",
      });

      // Process the merge
      mergeQueue.markProcessing(mrId);

      const result = attemptMerge("worker/agent-1/task-1", repo.path);

      expect(result.success).toBe(true);
      expect(result.mergeCommit).toBeDefined();
      expect(result.conflicts).toBeUndefined();

      // Verify file exists after merge
      expect(repo.fileExists("src/feature.ts")).toBe(true);

      // Mark as merged
      mergeQueue.markMerged(mrId, result.mergeCommit!);

      const mr = mergeQueue.get(mrId);
      expect(mr?.status).toBe("merged");
      expect(mr?.mergeCommit).toBe(result.mergeCommit);
    });

    it("should create merge commit with --no-ff", async () => {
      // Create worker branch
      repo.checkout("worker/agent-1/task-1", true);
      repo.writeFile("src/feature.ts", "export const X = 1;\n");
      repo.commit("Add X");

      repo.checkout("main");

      const result = attemptMerge("worker/agent-1/task-1", repo.path);

      expect(result.success).toBe(true);

      // Verify it's a merge commit (has 2 parents)
      const parents = repo.git("rev-list --parents -n 1 HEAD").split(" ");
      expect(parents.length).toBe(3); // commit hash + 2 parent hashes
    });
  });

  // =============================================================================
  // MQ-GIT-02: Conflict detection with real git
  // =============================================================================

  describe("MQ-GIT-02: Conflict detection", () => {
    it("should detect conflicts when same file modified differently", async () => {
      // Create first worker branch
      repo.checkout("worker/agent-1/task-1", true);
      repo.writeFile("src/index.ts", 'export const VERSION = "2.0.0";\n');
      repo.commit("Update version to 2.0.0");

      // Create second worker branch from main
      repo.checkout("main");
      repo.checkout("worker/agent-2/task-2", true);
      repo.writeFile("src/index.ts", 'export const VERSION = "3.0.0";\n');
      repo.commit("Update version to 3.0.0");

      // Merge first worker to main
      repo.checkout("main");
      const result1 = attemptMerge("worker/agent-1/task-1", repo.path);
      expect(result1.success).toBe(true);

      // Try to merge second worker - should conflict
      const result2 = attemptMerge("worker/agent-2/task-2", repo.path);

      expect(result2.success).toBe(false);
      expect(result2.conflicts).toBeDefined();
      expect(result2.conflicts).toContain("src/index.ts");

      // Verify merge is in progress
      expect(hasMergeInProgress(repo.path)).toBe(true);

      // Abort the merge
      expect(abortMerge(repo.path)).toBe(true);
      expect(hasMergeInProgress(repo.path)).toBe(false);
    });

    it("should detect multiple conflicting files", async () => {
      // Create worker branch with multiple changes
      repo.checkout("worker/agent-1/task-1", true);
      repo.writeFile("src/index.ts", 'export const A = "worker1";\n');
      repo.writeFile("README.md", "# Worker 1 Changes\n");
      repo.commit("Worker 1 changes");

      // Create conflicting worker branch
      repo.checkout("main");
      repo.checkout("worker/agent-2/task-2", true);
      repo.writeFile("src/index.ts", 'export const A = "worker2";\n');
      repo.writeFile("README.md", "# Worker 2 Changes\n");
      repo.commit("Worker 2 changes");

      // Merge first worker
      repo.checkout("main");
      attemptMerge("worker/agent-1/task-1", repo.path);

      // Try to merge second worker
      const result = attemptMerge("worker/agent-2/task-2", repo.path);

      expect(result.success).toBe(false);
      expect(result.conflicts).toHaveLength(2);
      expect(result.conflicts).toContain("src/index.ts");
      expect(result.conflicts).toContain("README.md");

      abortMerge(repo.path);
    });

    it("should mark MR as conflict with file list", async () => {
      // Setup conflicting branches
      repo.checkout("worker/agent-1/task-1", true);
      repo.writeFile("src/index.ts", 'export const X = 1;\n');
      repo.commit("Worker 1");

      repo.checkout("main");
      repo.checkout("worker/agent-2/task-2", true);
      repo.writeFile("src/index.ts", 'export const X = 2;\n');
      repo.commit("Worker 2");

      // Merge first
      repo.checkout("main");
      attemptMerge("worker/agent-1/task-1", repo.path);

      // Submit second to queue
      const mrId = mergeQueue.submit({
        streamId: "stream-1",
        taskId: "task-2",
        workerBranch: "worker/agent-2/task-2",
        workerAgentId: "agent-2",
      });

      mergeQueue.markProcessing(mrId);

      const result = attemptMerge("worker/agent-2/task-2", repo.path);
      expect(result.success).toBe(false);

      abortMerge(repo.path);

      // Mark conflict with files
      mergeQueue.markConflict(mrId, result.conflicts || []);

      const mr = mergeQueue.get(mrId);
      expect(mr?.status).toBe("conflict");
      expect(mr?.conflictFiles).toContain("src/index.ts");
    });
  });

  // =============================================================================
  // MQ-GIT-03: Multiple workers merging sequentially
  // =============================================================================

  describe("MQ-GIT-03: Sequential worker merges", () => {
    it("should merge multiple non-conflicting workers in order", async () => {
      // Create 3 workers with different files
      for (let i = 1; i <= 3; i++) {
        repo.checkout("main");
        repo.checkout(`worker/agent-${i}/task-${i}`, true);
        repo.writeFile(`src/feature${i}.ts`, `export const F${i} = ${i};\n`);
        repo.commit(`Add feature ${i}`);

        mergeQueue.submit({
          streamId: "stream-1",
          taskId: `task-${i}`,
          workerBranch: `worker/agent-${i}/task-${i}`,
          workerAgentId: `agent-${i}`,
        });
      }

      repo.checkout("main");

      // Process queue in order
      const mergeResults: string[] = [];
      let mr = mergeQueue.getNext("stream-1");

      while (mr) {
        mergeQueue.markProcessing(mr.id);

        const result = attemptMerge(mr.workerBranch, repo.path);
        expect(result.success).toBe(true);

        mergeQueue.markMerged(mr.id, result.mergeCommit!);
        mergeResults.push(mr.workerBranch);

        mr = mergeQueue.getNext("stream-1");
      }

      // Verify all 3 were processed in FIFO order
      expect(mergeResults).toEqual([
        "worker/agent-1/task-1",
        "worker/agent-2/task-2",
        "worker/agent-3/task-3",
      ]);

      // Verify all files exist
      expect(repo.fileExists("src/feature1.ts")).toBe(true);
      expect(repo.fileExists("src/feature2.ts")).toBe(true);
      expect(repo.fileExists("src/feature3.ts")).toBe(true);

      // Verify queue is empty
      expect(mergeQueue.getQueueDepth("stream-1")).toBe(0);
    });

    it("should process high priority merges first", async () => {
      // Create workers
      repo.checkout("worker/agent-1/task-1", true);
      repo.writeFile("src/a.ts", "// A\n");
      repo.commit("Add A");

      repo.checkout("main");
      repo.checkout("worker/agent-2/task-2", true);
      repo.writeFile("src/b.ts", "// B\n");
      repo.commit("Add B");

      repo.checkout("main");

      // Submit with different priorities
      mergeQueue.submit({
        streamId: "stream-1",
        taskId: "task-1",
        workerBranch: "worker/agent-1/task-1",
        workerAgentId: "agent-1",
        priority: 100, // Low priority
      });

      mergeQueue.submit({
        streamId: "stream-1",
        taskId: "task-2",
        workerBranch: "worker/agent-2/task-2",
        workerAgentId: "agent-2",
        priority: 10, // High priority
      });

      // Process queue
      const mr1 = mergeQueue.getNext("stream-1");
      expect(mr1?.taskId).toBe("task-2"); // High priority first

      mergeQueue.markProcessing(mr1!.id);
      const result1 = attemptMerge(mr1!.workerBranch, repo.path);
      mergeQueue.markMerged(mr1!.id, result1.mergeCommit!);

      const mr2 = mergeQueue.getNext("stream-1");
      expect(mr2?.taskId).toBe("task-1"); // Low priority second
    });
  });

  // =============================================================================
  // MQ-GIT-04: Continue processing after conflict
  // =============================================================================

  describe("MQ-GIT-04: Continue after conflict", () => {
    it("should continue processing queue after encountering conflict", async () => {
      // Worker 1: modifies existing file
      repo.checkout("worker/agent-1/task-1", true);
      repo.writeFile("src/index.ts", 'export const V = "A";\n');
      repo.commit("Worker 1 changes");

      // Worker 2: also modifies existing file (will conflict after worker 1)
      repo.checkout("main");
      repo.checkout("worker/agent-2/task-2", true);
      repo.writeFile("src/index.ts", 'export const V = "B";\n');
      repo.commit("Worker 2 changes");

      // Worker 3: adds new file (no conflict)
      repo.checkout("main");
      repo.checkout("worker/agent-3/task-3", true);
      repo.writeFile("src/new.ts", "export const NEW = true;\n");
      repo.commit("Worker 3 changes");

      repo.checkout("main");

      // Submit all to queue
      for (let i = 1; i <= 3; i++) {
        mergeQueue.submit({
          streamId: "stream-1",
          taskId: `task-${i}`,
          workerBranch: `worker/agent-${i}/task-${i}`,
          workerAgentId: `agent-${i}`,
        });
      }

      // Process queue
      const results: { taskId: string; status: "merged" | "conflict" }[] = [];

      let mr = mergeQueue.getNext("stream-1");
      while (mr) {
        mergeQueue.markProcessing(mr.id);

        const result = attemptMerge(mr.workerBranch, repo.path);

        if (result.success) {
          mergeQueue.markMerged(mr.id, result.mergeCommit!);
          results.push({ taskId: mr.taskId, status: "merged" });
        } else {
          abortMerge(repo.path);
          mergeQueue.markConflict(mr.id, result.conflicts || []);
          results.push({ taskId: mr.taskId, status: "conflict" });
        }

        mr = mergeQueue.getNext("stream-1");
      }

      // Verify results
      expect(results).toHaveLength(3);
      expect(results[0]).toEqual({ taskId: "task-1", status: "merged" });
      expect(results[1]).toEqual({ taskId: "task-2", status: "conflict" });
      expect(results[2]).toEqual({ taskId: "task-3", status: "merged" });

      // Verify worker 3's file was merged despite worker 2 conflict
      expect(repo.fileExists("src/new.ts")).toBe(true);
    });
  });

  // =============================================================================
  // MQ-GIT-05: Branch state verification
  // =============================================================================

  describe("MQ-GIT-05: Branch state verification", () => {
    it("should stay on integration branch after merge", async () => {
      repo.checkout("integration", true);
      repo.writeFile("README.md", "# Integration Branch\n");
      repo.commit("Init integration");

      // Create worker branch from integration
      repo.checkout("worker/agent-1/task-1", true);
      repo.writeFile("src/feature.ts", "export const F = 1;\n");
      repo.commit("Add feature");

      // Switch to integration for merge
      repo.checkout("integration");

      const result = attemptMerge("worker/agent-1/task-1", repo.path);

      expect(result.success).toBe(true);
      expect(getCurrentBranch(repo.path)).toBe("integration");
    });

    it("should preserve branch history after merge", async () => {
      repo.checkout("worker/agent-1/task-1", true);
      repo.writeFile("a.txt", "A\n");
      repo.commit("Commit A");
      repo.writeFile("b.txt", "B\n");
      repo.commit("Commit B");

      repo.checkout("main");
      const beforeLog = repo.getCommitLog(10);
      const beforeCount = beforeLog.length;

      attemptMerge("worker/agent-1/task-1", repo.path);

      const afterLog = repo.getCommitLog(10);
      // Should have: merge commit + 2 worker commits + original commits
      expect(afterLog.length).toBeGreaterThan(beforeCount);

      // Verify merge commit message
      expect(afterLog[0].message).toContain("Merge branch");
    });
  });

  // =============================================================================
  // MQ-GIT-06: Stream isolation with real merges
  // =============================================================================

  describe("MQ-GIT-06: Stream isolation", () => {
    it("should isolate merges between different streams", async () => {
      // Create workers for stream 1
      repo.checkout("stream-1/integration", true);
      repo.writeFile("stream1.txt", "Stream 1 integration\n");
      repo.commit("Init stream 1");

      repo.checkout("worker/s1-agent/task-1", true);
      repo.writeFile("feature-s1.ts", "export const S1 = 1;\n");
      repo.commit("Stream 1 feature");

      // Create workers for stream 2
      repo.checkout("main");
      repo.checkout("stream-2/integration", true);
      repo.writeFile("stream2.txt", "Stream 2 integration\n");
      repo.commit("Init stream 2");

      repo.checkout("worker/s2-agent/task-2", true);
      repo.writeFile("feature-s2.ts", "export const S2 = 2;\n");
      repo.commit("Stream 2 feature");

      // Submit to different streams
      mergeQueue.submit({
        streamId: "stream-1",
        taskId: "task-1",
        workerBranch: "worker/s1-agent/task-1",
        workerAgentId: "s1-agent",
      });

      mergeQueue.submit({
        streamId: "stream-2",
        taskId: "task-2",
        workerBranch: "worker/s2-agent/task-2",
        workerAgentId: "s2-agent",
      });

      // Process stream 1 only
      repo.checkout("stream-1/integration");
      const mr1 = mergeQueue.getNext("stream-1");
      expect(mr1).not.toBeNull();

      mergeQueue.markProcessing(mr1!.id);
      const result1 = attemptMerge(mr1!.workerBranch, repo.path);
      mergeQueue.markMerged(mr1!.id, result1.mergeCommit!);

      // Stream 2 should still have pending
      expect(mergeQueue.getQueueDepth("stream-1")).toBe(0);
      expect(mergeQueue.getQueueDepth("stream-2")).toBe(1);

      // Verify stream 1 has feature, current branch doesn't have stream 2 feature
      expect(repo.fileExists("feature-s1.ts")).toBe(true);
      expect(repo.fileExists("feature-s2.ts")).toBe(false);
    });
  });

  // =============================================================================
  // MQ-GIT-07: Edge cases
  // =============================================================================

  describe("MQ-GIT-07: Edge cases", () => {
    it("should handle merge when branch does not exist", async () => {
      const result = attemptMerge("nonexistent-branch", repo.path);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.conflicts).toBeUndefined();
    });

    it("should handle merge when already up-to-date", async () => {
      // Create and merge a branch
      repo.checkout("worker/agent-1/task-1", true);
      repo.writeFile("new.txt", "New file\n");
      repo.commit("Add file");

      repo.checkout("main");
      const firstMerge = attemptMerge("worker/agent-1/task-1", repo.path);
      expect(firstMerge.success).toBe(true);

      // Try to merge again - git handles this gracefully
      // It either succeeds (already up to date = no-op) or returns an error
      const result = attemptMerge("worker/agent-1/task-1", repo.path);

      // Git merge with --no-ff on an already-merged branch may create
      // another merge commit or return "already up to date"
      // Either way, no conflicts should occur
      expect(result.conflicts).toBeUndefined();
    });

    it("should handle empty working tree correctly", async () => {
      // Create branch with no new changes (branch at same commit as main)
      repo.checkout("empty-branch", true);
      // Don't make any commits - branch points to same commit as main

      repo.checkout("main");

      // Try to merge a branch that has no new commits
      const result = attemptMerge("empty-branch", repo.path);

      // Git may either succeed (no-op) or return error for "already up to date"
      // Either way, there should be no conflicts
      expect(result.conflicts).toBeUndefined();
    });

    it("should abort merge cleanly after conflict", async () => {
      // Create conflicting branches
      repo.checkout("worker/agent-1/task-1", true);
      repo.writeFile("conflict.txt", "Content A\n");
      repo.commit("A");

      repo.checkout("main");
      repo.writeFile("conflict.txt", "Content B\n");
      repo.commit("B");

      // Attempt merge - will conflict
      attemptMerge("worker/agent-1/task-1", repo.path);

      expect(hasMergeInProgress(repo.path)).toBe(true);

      // Abort
      const aborted = abortMerge(repo.path);
      expect(aborted).toBe(true);
      expect(hasMergeInProgress(repo.path)).toBe(false);

      // Working tree should be clean
      expect(repo.hasUncommittedChanges()).toBe(false);
    });
  });
});
