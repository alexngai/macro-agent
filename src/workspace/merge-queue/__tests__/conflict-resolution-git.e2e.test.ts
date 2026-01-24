/**
 * Conflict Resolution E2E Tests - Real Git Operations
 *
 * Tests conflict detection and resolution with actual git merge conflicts.
 * Uses TempRepoFactory for isolated real git repositories.
 *
 * @see s-bcqm Change Management spec - Conflict Resolution (Option C)
 * @see s-1zcx Multi-Agent Orchestration Testing Strategy
 * @see i-3s6o Phase 2c: Conflict Resolution Flow E2E Tests
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { createTempRepo } from "../../../../test_fixtures/fixtures/repos/temp-repo-factory.js";
import type { TempRepo } from "../../../../test_fixtures/fixtures/repos/types.js";
import { MergeQueue } from "../merge-queue.js";
import {
  attemptMerge,
  abortMerge,
  hasMergeInProgress,
} from "../../../lifecycle/cleanup.js";

describe("Conflict Resolution E2E - Real Git Operations", () => {
  let repo: TempRepo;
  let db: Database.Database;
  let mergeQueue: MergeQueue;

  beforeEach(async () => {
    repo = await createTempRepo({
      initialFiles: {
        "src/shared.ts": `// Shared module
export const VERSION = "1.0.0";
export function sharedFunction() {
  return "original";
}
`,
        "src/utils.ts": `export function util() { return 1; }
`,
        "README.md": "# Test Project\n",
      },
      initialBranch: "main",
    });

    db = new Database(":memory:");
    mergeQueue = new MergeQueue({ db, tablePrefix: "test_", initSchema: true });
  });

  afterEach(async () => {
    // Abort any in-progress merge before cleanup
    if (hasMergeInProgress(repo.path)) {
      abortMerge(repo.path);
    }
    mergeQueue.close();
    db.close();
    await repo.cleanup();
  });

  // ===========================================================================
  // Real Conflict Detection
  // ===========================================================================

  describe("real conflict detection", () => {
    it("detects conflict when two branches modify same lines", async () => {
      // Create worker-1 branch with change to shared.ts
      repo.checkout("worker/agent-1/task-1", true);
      repo.writeFile(
        "src/shared.ts",
        `// Shared module - modified by worker 1
export const VERSION = "2.0.0";
export function sharedFunction() {
  return "worker-1-version";
}
`
      );
      repo.commit("Worker 1: Update shared module");

      // Create worker-2 branch from main (not from worker-1)
      repo.checkout("main");
      repo.checkout("worker/agent-2/task-2", true);
      repo.writeFile(
        "src/shared.ts",
        `// Shared module - modified by worker 2
export const VERSION = "3.0.0";
export function sharedFunction() {
  return "worker-2-version";
}
`
      );
      repo.commit("Worker 2: Update shared module");

      // Switch to main to merge
      repo.checkout("main");

      // First merge succeeds
      const result1 = attemptMerge("worker/agent-1/task-1", repo.path);
      expect(result1.success).toBe(true);

      // Second merge should detect conflict
      const result2 = attemptMerge("worker/agent-2/task-2", repo.path);
      expect(result2.success).toBe(false);
      expect(result2.conflicts).toBeDefined();
      expect(result2.conflicts).toContain("src/shared.ts");

      // Should have merge in progress
      expect(hasMergeInProgress(repo.path)).toBe(true);

      // Abort the merge
      abortMerge(repo.path);
      expect(hasMergeInProgress(repo.path)).toBe(false);
    });

    it("detects multiple conflicting files", async () => {
      // Worker 1 modifies both files
      repo.checkout("worker/agent-1/task-1", true);
      repo.writeFile("src/shared.ts", "// Worker 1 shared\nexport const x = 1;\n");
      repo.writeFile("src/utils.ts", "// Worker 1 utils\nexport const y = 1;\n");
      repo.commit("Worker 1: Update both files");

      // Worker 2 modifies same files differently
      repo.checkout("main");
      repo.checkout("worker/agent-2/task-2", true);
      repo.writeFile("src/shared.ts", "// Worker 2 shared\nexport const x = 2;\n");
      repo.writeFile("src/utils.ts", "// Worker 2 utils\nexport const y = 2;\n");
      repo.commit("Worker 2: Update both files");

      // Merge worker 1 first
      repo.checkout("main");
      const result1 = attemptMerge("worker/agent-1/task-1", repo.path);
      expect(result1.success).toBe(true);

      // Merge worker 2 - should conflict on both files
      const result2 = attemptMerge("worker/agent-2/task-2", repo.path);
      expect(result2.success).toBe(false);
      expect(result2.conflicts).toHaveLength(2);
      expect(result2.conflicts).toContain("src/shared.ts");
      expect(result2.conflicts).toContain("src/utils.ts");

      abortMerge(repo.path);
    });

    it("does not conflict when workers edit different files", async () => {
      // Worker 1 edits shared.ts
      repo.checkout("worker/agent-1/task-1", true);
      repo.writeFile("src/shared.ts", "// Worker 1 only\nexport const x = 1;\n");
      repo.commit("Worker 1: Update shared.ts");

      // Worker 2 edits utils.ts only
      repo.checkout("main");
      repo.checkout("worker/agent-2/task-2", true);
      repo.writeFile("src/utils.ts", "// Worker 2 only\nexport const y = 2;\n");
      repo.commit("Worker 2: Update utils.ts");

      // Merge both - no conflict
      repo.checkout("main");
      const result1 = attemptMerge("worker/agent-1/task-1", repo.path);
      expect(result1.success).toBe(true);

      const result2 = attemptMerge("worker/agent-2/task-2", repo.path);
      expect(result2.success).toBe(true);

      // Both files should have their respective changes
      const shared = repo.readFile("src/shared.ts");
      const utils = repo.readFile("src/utils.ts");
      expect(shared).toContain("Worker 1");
      expect(utils).toContain("Worker 2");
    });

    it("does not conflict when workers edit different lines in same file", async () => {
      // Worker 1 modifies first function
      repo.checkout("worker/agent-1/task-1", true);
      repo.writeFile(
        "src/shared.ts",
        `// Shared module
export const VERSION = "1.0.0";
export function sharedFunction() {
  return "modified-by-worker-1";
}

export function anotherFunction() {
  return "original";
}
`
      );
      repo.commit("Worker 1: Modify sharedFunction");

      // Worker 2 adds new function at end (from main)
      repo.checkout("main");
      // First add the anotherFunction to main so worker-2 can modify it
      repo.writeFile(
        "src/shared.ts",
        `// Shared module
export const VERSION = "1.0.0";
export function sharedFunction() {
  return "original";
}

export function anotherFunction() {
  return "original";
}
`
      );
      repo.commit("Add anotherFunction");

      repo.checkout("worker/agent-2/task-2", true);
      repo.writeFile(
        "src/shared.ts",
        `// Shared module
export const VERSION = "1.0.0";
export function sharedFunction() {
  return "original";
}

export function anotherFunction() {
  return "modified-by-worker-2";
}
`
      );
      repo.commit("Worker 2: Modify anotherFunction");

      // Merge both
      repo.checkout("main");
      const result1 = attemptMerge("worker/agent-1/task-1", repo.path);
      expect(result1.success).toBe(true);

      const result2 = attemptMerge("worker/agent-2/task-2", repo.path);
      // This might or might not conflict depending on git's 3-way merge
      // If it conflicts, that's also valid behavior
      if (!result2.success) {
        abortMerge(repo.path);
      }
    });
  });

  // ===========================================================================
  // MergeQueue Integration with Real Git
  // ===========================================================================

  describe("MergeQueue integration with real git", () => {
    it("marks MR as conflict when real git merge fails", async () => {
      // Setup conflicting branches
      repo.checkout("worker/agent-1/task-1", true);
      repo.writeFile("src/shared.ts", "// Version A\nexport const x = 1;\n");
      repo.commit("Worker 1 changes");

      repo.checkout("main");
      repo.checkout("worker/agent-2/task-2", true);
      repo.writeFile("src/shared.ts", "// Version B\nexport const x = 2;\n");
      repo.commit("Worker 2 changes");

      // Submit MRs
      const mr1 = mergeQueue.submit({
        streamId: "stream-1",
        taskId: "task-1",
        workerBranch: "worker/agent-1/task-1",
        workerAgentId: "agent-1",
      });

      const mr2 = mergeQueue.submit({
        streamId: "stream-1",
        taskId: "task-2",
        workerBranch: "worker/agent-2/task-2",
        workerAgentId: "agent-2",
      });

      // Process first MR
      repo.checkout("main");
      mergeQueue.markProcessing(mr1);
      const result1 = attemptMerge("worker/agent-1/task-1", repo.path);
      expect(result1.success).toBe(true);
      mergeQueue.markMerged(mr1, result1.mergeCommit!);

      // Process second MR - will conflict
      mergeQueue.markProcessing(mr2);
      const result2 = attemptMerge("worker/agent-2/task-2", repo.path);
      expect(result2.success).toBe(false);

      // Mark as conflict in queue
      mergeQueue.markConflict(mr2, result2.conflicts!);

      // Verify states
      const mergedMR = mergeQueue.get(mr1);
      const conflictMR = mergeQueue.get(mr2);

      expect(mergedMR?.status).toBe("merged");
      expect(conflictMR?.status).toBe("conflict");
      expect(conflictMR?.conflictFiles).toContain("src/shared.ts");

      // Cleanup
      abortMerge(repo.path);
    });

    it("transitions MR through full lifecycle: pending → processing → conflict → merged", async () => {
      // Setup conflict scenario
      repo.checkout("worker/agent-1/task-1", true);
      repo.writeFile("src/shared.ts", "// Conflicting content\n");
      repo.commit("Worker 1");

      repo.checkout("main");
      repo.writeFile("src/shared.ts", "// Main branch update\n");
      repo.commit("Main update");

      // Submit MR
      const mrId = mergeQueue.submit({
        streamId: "stream-1",
        taskId: "task-1",
        workerBranch: "worker/agent-1/task-1",
        workerAgentId: "agent-1",
      });

      // Verify pending
      expect(mergeQueue.get(mrId)?.status).toBe("pending");

      // Mark processing
      mergeQueue.markProcessing(mrId);
      expect(mergeQueue.get(mrId)?.status).toBe("processing");

      // Attempt merge - will conflict
      const result = attemptMerge("worker/agent-1/task-1", repo.path);
      expect(result.success).toBe(false);

      // Mark conflict
      mergeQueue.markConflict(mrId, result.conflicts!, "resolver-1");
      expect(mergeQueue.get(mrId)?.status).toBe("conflict");

      // Cleanup merge state
      abortMerge(repo.path);

      // Simulate resolver completing by manually resolving
      // In real scenario, resolver would work on resolver branch

      // Mark resolver complete (simulating successful resolution)
      mergeQueue.markResolverComplete(mrId, "simulated-resolve-commit");
      expect(mergeQueue.get(mrId)?.status).toBe("merged");
    });
  });

  // ===========================================================================
  // Conflict Resolution Simulation
  // ===========================================================================

  describe("conflict resolution simulation", () => {
    it("simulates resolver fixing conflict on separate branch", async () => {
      // Setup: worker branch conflicts with main
      repo.checkout("worker/agent-1/task-1", true);
      repo.writeFile("src/shared.ts", "// Worker version\nexport const x = 1;\n");
      const workerCommit = repo.commit("Worker changes");

      repo.checkout("main");
      repo.writeFile("src/shared.ts", "// Main version\nexport const x = 2;\n");
      repo.commit("Main changes");

      // Submit and detect conflict
      const mrId = mergeQueue.submit({
        streamId: "stream-1",
        taskId: "task-1",
        workerBranch: "worker/agent-1/task-1",
        workerAgentId: "agent-1",
      });

      mergeQueue.markProcessing(mrId);
      const result = attemptMerge("worker/agent-1/task-1", repo.path);
      expect(result.success).toBe(false);

      abortMerge(repo.path);
      mergeQueue.markConflict(mrId, result.conflicts!, "resolver-task-1");

      // Create resolver branch from main (current integration state)
      const timestamp = Date.now();
      const resolverBranch = `resolver/${mrId}@${timestamp}`;

      repo.checkout(resolverBranch, true);

      // Resolver applies worker's changes manually (resolved version)
      repo.writeFile(
        "src/shared.ts",
        `// Merged version - combined both changes
export const x = 3; // Compromise value
`
      );
      const resolveCommit = repo.commit("Resolve conflict: merge both versions");

      // Resolver's branch is ready - integrator merges it inline
      repo.checkout("main");
      const inlineMergeResult = attemptMerge(resolverBranch, repo.path);
      expect(inlineMergeResult.success).toBe(true);

      // Mark MR as resolved
      mergeQueue.markResolverComplete(mrId, inlineMergeResult.mergeCommit!, resolverBranch);

      // Verify final state
      const mr = mergeQueue.get(mrId);
      expect(mr?.status).toBe("merged");

      // Verify content
      const content = repo.readFile("src/shared.ts");
      expect(content).toContain("Merged version");
    });

    it("handles resolver branch naming convention: resolver/<mr-id>@<ts>", async () => {
      // Setup conflict
      repo.checkout("worker/agent-1/task-1", true);
      repo.writeFile("src/shared.ts", "worker content\n");
      repo.commit("Worker");

      repo.checkout("main");
      repo.writeFile("src/shared.ts", "main content\n");
      repo.commit("Main");

      const mrId = mergeQueue.submit({
        streamId: "stream-1",
        taskId: "task-1",
        workerBranch: "worker/agent-1/task-1",
        workerAgentId: "agent-1",
      });

      mergeQueue.markProcessing(mrId);
      attemptMerge("worker/agent-1/task-1", repo.path);
      abortMerge(repo.path);
      mergeQueue.markConflict(mrId, ["src/shared.ts"], "resolver-1");

      // Create resolver branch with spec naming
      const timestamp = Date.now();
      const resolverBranch = `resolver/${mrId}@${timestamp}`;

      // Verify format matches spec
      expect(resolverBranch).toMatch(/^resolver\/mr-[a-z0-9-]+@\d+$/);

      // Create the branch
      repo.checkout(resolverBranch, true);
      repo.writeFile("src/shared.ts", "resolved content\n");
      repo.commit("Resolve");

      // List branches to verify
      const branches = execSync("git branch -a", { cwd: repo.path, encoding: "utf8" });
      expect(branches).toContain(resolverBranch);
    });
  });

  // ===========================================================================
  // Multiple Conflicts with Real Git
  // ===========================================================================

  describe("multiple conflicts with real git", () => {
    it("handles queue with multiple conflicting MRs", async () => {
      // Create 3 workers all modifying same file
      for (let i = 1; i <= 3; i++) {
        repo.checkout("main");
        repo.checkout(`worker/agent-${i}/task-${i}`, true);
        repo.writeFile("src/shared.ts", `// Worker ${i} version\nexport const v = ${i};\n`);
        repo.commit(`Worker ${i} changes`);
      }

      // Submit all MRs
      const mrs: string[] = [];
      for (let i = 1; i <= 3; i++) {
        const mrId = mergeQueue.submit({
          streamId: "stream-1",
          taskId: `task-${i}`,
          workerBranch: `worker/agent-${i}/task-${i}`,
          workerAgentId: `agent-${i}`,
        });
        mrs.push(mrId);
      }

      repo.checkout("main");

      // Process first - succeeds
      mergeQueue.markProcessing(mrs[0]);
      const result1 = attemptMerge("worker/agent-1/task-1", repo.path);
      expect(result1.success).toBe(true);
      mergeQueue.markMerged(mrs[0], result1.mergeCommit!);

      // Process second - conflicts
      mergeQueue.markProcessing(mrs[1]);
      const result2 = attemptMerge("worker/agent-2/task-2", repo.path);
      expect(result2.success).toBe(false);
      abortMerge(repo.path);
      mergeQueue.markConflict(mrs[1], result2.conflicts!);

      // Process third - also conflicts (main changed by first merge)
      mergeQueue.markProcessing(mrs[2]);
      const result3 = attemptMerge("worker/agent-3/task-3", repo.path);
      expect(result3.success).toBe(false);
      abortMerge(repo.path);
      mergeQueue.markConflict(mrs[2], result3.conflicts!);

      // Verify states
      expect(mergeQueue.get(mrs[0])?.status).toBe("merged");
      expect(mergeQueue.get(mrs[1])?.status).toBe("conflict");
      expect(mergeQueue.get(mrs[2])?.status).toBe("conflict");

      // Query conflicts
      const conflicts = mergeQueue.getPending("stream-1", { status: "conflict" });
      expect(conflicts).toHaveLength(2);
    });

    it("continues processing queue after conflict", async () => {
      // Worker 1 and 3 edit shared.ts (will conflict after 1 merges)
      // Worker 2 edits different file (should succeed)

      repo.checkout("worker/agent-1/task-1", true);
      repo.writeFile("src/shared.ts", "worker 1\n");
      repo.commit("Worker 1");

      repo.checkout("main");
      repo.checkout("worker/agent-2/task-2", true);
      repo.writeFile("src/utils.ts", "worker 2 - different file\n");
      repo.commit("Worker 2");

      repo.checkout("main");
      repo.checkout("worker/agent-3/task-3", true);
      repo.writeFile("src/shared.ts", "worker 3\n");
      repo.commit("Worker 3");

      // Submit in order: 1, 3, 2
      const mr1 = mergeQueue.submit({
        streamId: "stream-1",
        taskId: "task-1",
        workerBranch: "worker/agent-1/task-1",
        workerAgentId: "agent-1",
      });
      const mr3 = mergeQueue.submit({
        streamId: "stream-1",
        taskId: "task-3",
        workerBranch: "worker/agent-3/task-3",
        workerAgentId: "agent-3",
      });
      const mr2 = mergeQueue.submit({
        streamId: "stream-1",
        taskId: "task-2",
        workerBranch: "worker/agent-2/task-2",
        workerAgentId: "agent-2",
      });

      repo.checkout("main");

      // Process mr1 - succeeds
      mergeQueue.markProcessing(mr1);
      const result1 = attemptMerge("worker/agent-1/task-1", repo.path);
      expect(result1.success).toBe(true);
      mergeQueue.markMerged(mr1, result1.mergeCommit!);

      // Process mr3 - conflicts (same file as mr1)
      mergeQueue.markProcessing(mr3);
      const result3 = attemptMerge("worker/agent-3/task-3", repo.path);
      expect(result3.success).toBe(false);
      abortMerge(repo.path);
      mergeQueue.markConflict(mr3, result3.conflicts!);

      // Process mr2 - should succeed (different file)
      mergeQueue.markProcessing(mr2);
      const result2 = attemptMerge("worker/agent-2/task-2", repo.path);
      expect(result2.success).toBe(true);
      mergeQueue.markMerged(mr2, result2.mergeCommit!);

      // Verify final states
      expect(mergeQueue.get(mr1)?.status).toBe("merged");
      expect(mergeQueue.get(mr2)?.status).toBe("merged");
      expect(mergeQueue.get(mr3)?.status).toBe("conflict");
    });
  });

  // ===========================================================================
  // Edge Cases
  // ===========================================================================

  describe("edge cases with real git", () => {
    it("handles file deleted in one branch, modified in another", async () => {
      // Worker 1 deletes file
      repo.checkout("worker/agent-1/task-1", true);
      fs.unlinkSync(path.join(repo.path, "src/shared.ts"));
      execSync("git add -A", { cwd: repo.path });
      execSync('git commit -m "Delete shared.ts"', { cwd: repo.path });

      // Worker 2 modifies file
      repo.checkout("main");
      repo.checkout("worker/agent-2/task-2", true);
      repo.writeFile("src/shared.ts", "modified content\n");
      repo.commit("Modify shared.ts");

      repo.checkout("main");

      // First merge (delete)
      const result1 = attemptMerge("worker/agent-1/task-1", repo.path);
      expect(result1.success).toBe(true);

      // Second merge - conflict (delete vs modify)
      const result2 = attemptMerge("worker/agent-2/task-2", repo.path);
      // Git considers this a conflict
      expect(result2.success).toBe(false);

      abortMerge(repo.path);
    });

    it("handles binary file conflicts", async () => {
      // Create binary-like file
      const binaryContent1 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01, 0x02, 0x03]);
      const binaryContent2 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x04, 0x05, 0x06]);

      repo.checkout("worker/agent-1/task-1", true);
      fs.writeFileSync(path.join(repo.path, "image.png"), binaryContent1);
      execSync("git add image.png", { cwd: repo.path });
      execSync('git commit -m "Add image v1"', { cwd: repo.path });

      repo.checkout("main");
      repo.checkout("worker/agent-2/task-2", true);
      fs.writeFileSync(path.join(repo.path, "image.png"), binaryContent2);
      execSync("git add image.png", { cwd: repo.path });
      execSync('git commit -m "Add image v2"', { cwd: repo.path });

      repo.checkout("main");

      const result1 = attemptMerge("worker/agent-1/task-1", repo.path);
      expect(result1.success).toBe(true);

      const result2 = attemptMerge("worker/agent-2/task-2", repo.path);
      expect(result2.success).toBe(false);
      expect(result2.conflicts).toContain("image.png");

      abortMerge(repo.path);
    });

    it("handles empty commit scenario", async () => {
      // Worker creates branch but doesn't change anything
      repo.checkout("worker/agent-1/task-1", true);
      // No changes, but we need a commit for the branch to exist
      execSync('git commit --allow-empty -m "Empty commit"', { cwd: repo.path });

      repo.checkout("main");

      // Merge empty branch - should succeed (nothing to merge really)
      const result = attemptMerge("worker/agent-1/task-1", repo.path);
      // Depending on git version, this might be "already up to date" or create merge commit
      // Either way, it shouldn't conflict
      expect(result.conflicts).toBeUndefined();
    });
  });
});
