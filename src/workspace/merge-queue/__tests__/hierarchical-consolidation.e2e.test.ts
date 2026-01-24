/**
 * Merge Queue E2E Tests - Hierarchical Work Consolidation
 *
 * Tests the parent/child worker branch merging flow where child work
 * is consolidated into parent branch before parent merges to integration.
 *
 * @see s-bcqm Change Management and Merge Queue
 * @see s-32xs Self-Cleaning Workers
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { createTempRepo } from "../../../../test_fixtures/fixtures/repos/temp-repo-factory.js";
import type { TempRepo } from "../../../../test_fixtures/fixtures/repos/types.js";
import { MergeQueue } from "../merge-queue.js";
import {
  attemptMerge,
  abortMerge,
  getCurrentBranch,
} from "../../../lifecycle/cleanup.js";

describe("Merge Queue E2E - Hierarchical Consolidation", () => {
  let repo: TempRepo;
  let db: Database.Database;
  let mergeQueue: MergeQueue;

  beforeEach(async () => {
    repo = await createTempRepo({
      initialFiles: {
        "src/index.ts": "// Main entry\n",
        "package.json": '{"name": "test-project"}\n',
      },
      initialBranch: "main",
    });

    db = new Database(":memory:");
    mergeQueue = new MergeQueue({ db, tablePrefix: "test_", initSchema: true });
  });

  afterEach(async () => {
    mergeQueue.close();
    db.close();
    await repo.cleanup();
  });

  // =============================================================================
  // MQ-HIER-01: Parent spawns child, child merges to parent
  // =============================================================================

  describe("MQ-HIER-01: Child to parent consolidation", () => {
    it("should merge child branch into parent branch", async () => {
      // Parent worker creates branch
      repo.checkout("worker/parent-1/task-parent", true);
      repo.writeFile("src/parent-work.ts", "export const PARENT = 1;\n");
      repo.commit("Parent initial work");

      // Child worker branches from parent
      repo.checkout("worker/child-1/task-child", true);
      repo.writeFile("src/child-work.ts", "export const CHILD = 1;\n");
      repo.commit("Child work");

      // Child completes, merge child into parent
      repo.checkout("worker/parent-1/task-parent");
      const childMerge = attemptMerge("worker/child-1/task-child", repo.path);

      expect(childMerge.success).toBe(true);
      expect(repo.fileExists("src/child-work.ts")).toBe(true);
      expect(repo.fileExists("src/parent-work.ts")).toBe(true);

      // Parent now has both commits
      const log = repo.getCommitLog(5);
      expect(log.some(c => c.message.includes("Child work"))).toBe(true);
      expect(log.some(c => c.message.includes("Parent initial work"))).toBe(true);
    });

    it("should maintain commit history from child in parent", async () => {
      // Parent work
      repo.checkout("worker/parent-1/task-1", true);
      repo.writeFile("a.ts", "A\n");
      repo.commit("Parent commit 1");

      // Child with multiple commits
      repo.checkout("worker/child-1/subtask-1", true);
      repo.writeFile("b.ts", "B\n");
      repo.commit("Child commit 1");
      repo.writeFile("c.ts", "C\n");
      repo.commit("Child commit 2");

      // Merge child to parent
      repo.checkout("worker/parent-1/task-1");
      attemptMerge("worker/child-1/subtask-1", repo.path);

      // Verify all commits are in history
      const log = repo.getCommitLog(10);
      const messages = log.map(c => c.message);

      expect(messages).toContain("Child commit 1");
      expect(messages).toContain("Child commit 2");
      expect(messages).toContain("Parent commit 1");
    });
  });

  // =============================================================================
  // MQ-HIER-02: Multiple children merging to parent
  // =============================================================================

  describe("MQ-HIER-02: Multiple children to parent", () => {
    it("should merge multiple children into parent sequentially", async () => {
      // Parent work
      repo.checkout("worker/parent-1/task-main", true);
      repo.writeFile("src/main.ts", "// Main feature\n");
      repo.commit("Parent setup");

      // Child 1: adds feature A
      repo.checkout("worker/child-1/subtask-a", true);
      repo.writeFile("src/feature-a.ts", "export const A = 1;\n");
      repo.commit("Add feature A");

      // Child 2: adds feature B (branches from parent, not child 1)
      repo.checkout("worker/parent-1/task-main");
      repo.checkout("worker/child-2/subtask-b", true);
      repo.writeFile("src/feature-b.ts", "export const B = 2;\n");
      repo.commit("Add feature B");

      // Merge child 1 to parent
      repo.checkout("worker/parent-1/task-main");
      const merge1 = attemptMerge("worker/child-1/subtask-a", repo.path);
      expect(merge1.success).toBe(true);

      // Merge child 2 to parent (should work, different files)
      const merge2 = attemptMerge("worker/child-2/subtask-b", repo.path);
      expect(merge2.success).toBe(true);

      // Parent has both features
      expect(repo.fileExists("src/feature-a.ts")).toBe(true);
      expect(repo.fileExists("src/feature-b.ts")).toBe(true);
    });

    it("should detect conflicts between child branches in parent", async () => {
      // Parent
      repo.checkout("worker/parent-1/task-main", true);
      repo.writeFile("src/shared.ts", "export const VERSION = 1;\n");
      repo.commit("Parent with shared file");

      // Child 1: modifies shared file
      repo.checkout("worker/child-1/subtask-a", true);
      repo.writeFile("src/shared.ts", "export const VERSION = 2;\n");
      repo.commit("Child 1 update");

      // Child 2: also modifies shared file differently
      repo.checkout("worker/parent-1/task-main");
      repo.checkout("worker/child-2/subtask-b", true);
      repo.writeFile("src/shared.ts", "export const VERSION = 3;\n");
      repo.commit("Child 2 update");

      // Merge child 1 to parent - should succeed
      repo.checkout("worker/parent-1/task-main");
      const merge1 = attemptMerge("worker/child-1/subtask-a", repo.path);
      expect(merge1.success).toBe(true);

      // Merge child 2 to parent - should conflict
      const merge2 = attemptMerge("worker/child-2/subtask-b", repo.path);
      expect(merge2.success).toBe(false);
      expect(merge2.conflicts).toContain("src/shared.ts");

      abortMerge(repo.path);
    });
  });

  // =============================================================================
  // MQ-HIER-03: Parent merges to integration after children consolidated
  // =============================================================================

  describe("MQ-HIER-03: Full hierarchy to integration", () => {
    it("should merge consolidated parent to integration branch", async () => {
      // Create integration branch
      repo.checkout("integration/stream-1", true);
      repo.writeFile("README.md", "# Integration Branch\n");
      repo.commit("Init integration");

      // Parent worker
      repo.checkout("worker/parent-1/task-1", true);
      repo.writeFile("src/parent.ts", "// Parent\n");
      repo.commit("Parent work");

      // Child worker
      repo.checkout("worker/child-1/subtask-1", true);
      repo.writeFile("src/child.ts", "// Child\n");
      repo.commit("Child work");

      // 1. Merge child to parent
      repo.checkout("worker/parent-1/task-1");
      const childMerge = attemptMerge("worker/child-1/subtask-1", repo.path);
      expect(childMerge.success).toBe(true);

      // 2. Parent adds final work after consolidation
      repo.writeFile("src/final.ts", "// Final work\n");
      repo.commit("Parent final work");

      // 3. Submit parent to merge queue
      const mrId = mergeQueue.submit({
        streamId: "stream-1",
        taskId: "task-1",
        workerBranch: "worker/parent-1/task-1",
        workerAgentId: "parent-1",
      });

      // 4. Process queue - merge parent to integration
      repo.checkout("integration/stream-1");
      mergeQueue.markProcessing(mrId);

      const result = attemptMerge("worker/parent-1/task-1", repo.path);
      expect(result.success).toBe(true);

      mergeQueue.markMerged(mrId, result.mergeCommit!);

      // Verify integration has all files
      expect(repo.fileExists("src/parent.ts")).toBe(true);
      expect(repo.fileExists("src/child.ts")).toBe(true);
      expect(repo.fileExists("src/final.ts")).toBe(true);

      // Verify full commit history preserved
      const log = repo.getCommitLog(10);
      expect(log.some(c => c.message.includes("Parent work"))).toBe(true);
      expect(log.some(c => c.message.includes("Child work"))).toBe(true);
      expect(log.some(c => c.message.includes("Parent final work"))).toBe(true);
    });

    it("should handle multiple parents with children merging to integration", async () => {
      // Integration branch
      repo.checkout("integration/feature-x", true);
      repo.writeFile("INTEGRATION.md", "# Integration Branch\n");
      repo.commit("Init integration");

      // Parent 1 with child
      repo.checkout("worker/parent-1/task-1", true);
      repo.writeFile("p1.ts", "// P1\n");
      repo.commit("Parent 1");

      repo.checkout("worker/child-1/sub-1", true);
      repo.writeFile("c1.ts", "// C1\n");
      repo.commit("Child 1");

      repo.checkout("worker/parent-1/task-1");
      attemptMerge("worker/child-1/sub-1", repo.path);

      // Parent 2 with child (from integration)
      repo.checkout("integration/feature-x");
      repo.checkout("worker/parent-2/task-2", true);
      repo.writeFile("p2.ts", "// P2\n");
      repo.commit("Parent 2");

      repo.checkout("worker/child-2/sub-2", true);
      repo.writeFile("c2.ts", "// C2\n");
      repo.commit("Child 2");

      repo.checkout("worker/parent-2/task-2");
      attemptMerge("worker/child-2/sub-2", repo.path);

      // Submit both parents to queue
      mergeQueue.submit({
        streamId: "stream-1",
        taskId: "task-1",
        workerBranch: "worker/parent-1/task-1",
        workerAgentId: "parent-1",
      });

      mergeQueue.submit({
        streamId: "stream-1",
        taskId: "task-2",
        workerBranch: "worker/parent-2/task-2",
        workerAgentId: "parent-2",
      });

      // Process queue
      repo.checkout("integration/feature-x");

      let mr = mergeQueue.getNext("stream-1");
      while (mr) {
        mergeQueue.markProcessing(mr.id);
        const result = attemptMerge(mr.workerBranch, repo.path);
        expect(result.success).toBe(true);
        mergeQueue.markMerged(mr.id, result.mergeCommit!);
        mr = mergeQueue.getNext("stream-1");
      }

      // All files present in integration
      expect(repo.fileExists("p1.ts")).toBe(true);
      expect(repo.fileExists("c1.ts")).toBe(true);
      expect(repo.fileExists("p2.ts")).toBe(true);
      expect(repo.fileExists("c2.ts")).toBe(true);
    });
  });

  // =============================================================================
  // MQ-HIER-04: Deep hierarchy (grandchildren)
  // =============================================================================

  describe("MQ-HIER-04: Deep hierarchy", () => {
    it("should support grandchild merging through parent chain", async () => {
      // Grandparent
      repo.checkout("worker/grandparent/task-gp", true);
      repo.writeFile("gp.ts", "// Grandparent\n");
      repo.commit("Grandparent work");

      // Parent
      repo.checkout("worker/parent/task-p", true);
      repo.writeFile("p.ts", "// Parent\n");
      repo.commit("Parent work");

      // Child (grandchild of grandparent)
      repo.checkout("worker/child/task-c", true);
      repo.writeFile("c.ts", "// Child\n");
      repo.commit("Child work");

      // Merge child → parent
      repo.checkout("worker/parent/task-p");
      const childMerge = attemptMerge("worker/child/task-c", repo.path);
      expect(childMerge.success).toBe(true);

      // Merge parent → grandparent
      repo.checkout("worker/grandparent/task-gp");
      const parentMerge = attemptMerge("worker/parent/task-p", repo.path);
      expect(parentMerge.success).toBe(true);

      // Grandparent has all files
      expect(repo.fileExists("gp.ts")).toBe(true);
      expect(repo.fileExists("p.ts")).toBe(true);
      expect(repo.fileExists("c.ts")).toBe(true);

      // Full history preserved
      const log = repo.getCommitLog(10);
      expect(log.some(c => c.message.includes("Grandparent"))).toBe(true);
      expect(log.some(c => c.message.includes("Parent"))).toBe(true);
      expect(log.some(c => c.message.includes("Child"))).toBe(true);
    });
  });

  // =============================================================================
  // MQ-HIER-05: Cascade termination consolidation
  // =============================================================================

  describe("MQ-HIER-05: Cascade termination pattern", () => {
    it("should simulate cascade termination with consolidation", async () => {
      // This simulates the terminateWithChangeConsolidation flow
      // Parent with 2 children

      repo.checkout("worker/parent/main-task", true);
      repo.writeFile("main.ts", "// Main task\n");
      repo.commit("Main task setup");

      // Child A
      repo.checkout("worker/child-a/subtask-a", true);
      repo.writeFile("a.ts", "// A\n");
      repo.commit("Subtask A");

      // Child B (from parent, not child A)
      repo.checkout("worker/parent/main-task");
      repo.checkout("worker/child-b/subtask-b", true);
      repo.writeFile("b.ts", "// B\n");
      repo.commit("Subtask B");

      // Simulate cascade termination: depth-first
      // Terminate child A first - consolidate to parent
      repo.checkout("worker/parent/main-task");
      const mergeA = attemptMerge("worker/child-a/subtask-a", repo.path);
      expect(mergeA.success).toBe(true);
      // (would delete child A branch in real scenario)

      // Terminate child B - consolidate to parent
      const mergeB = attemptMerge("worker/child-b/subtask-b", repo.path);
      expect(mergeB.success).toBe(true);
      // (would delete child B branch in real scenario)

      // Now parent can submit to queue with consolidated work
      repo.writeFile("done.ts", "// Done marker\n");
      repo.commit("Parent complete");

      // Verify parent has everything
      expect(repo.fileExists("main.ts")).toBe(true);
      expect(repo.fileExists("a.ts")).toBe(true);
      expect(repo.fileExists("b.ts")).toBe(true);
      expect(repo.fileExists("done.ts")).toBe(true);
    });

    it("should handle failed child consolidation gracefully", async () => {
      // Parent
      repo.checkout("worker/parent/task", true);
      repo.writeFile("shared.ts", "export const X = 1;\n");
      repo.commit("Parent");

      // Child modifies same file
      repo.checkout("worker/child/subtask", true);
      repo.writeFile("shared.ts", "export const X = 2;\n");
      repo.commit("Child");

      // Parent also modifies same file (will conflict)
      repo.checkout("worker/parent/task");
      repo.writeFile("shared.ts", "export const X = 3;\n");
      repo.commit("Parent update");

      // Try to consolidate - should conflict
      const merge = attemptMerge("worker/child/subtask", repo.path);
      expect(merge.success).toBe(false);
      expect(merge.conflicts).toContain("shared.ts");

      // Abort and parent continues without child's changes
      abortMerge(repo.path);

      // Parent can still proceed (with conflict flag in real scenario)
      expect(getCurrentBranch(repo.path)).toBe("worker/parent/task");
    });
  });
});
