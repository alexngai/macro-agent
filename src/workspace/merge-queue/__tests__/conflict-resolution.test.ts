/**
 * Conflict Resolution Unit Tests
 *
 * Exhaustive tests for MergeQueue conflict handling APIs.
 * Tests state transitions, events, and edge cases for the conflict lifecycle.
 *
 * @see s-bcqm Change Management spec - Conflict Resolution (Option C)
 * @see s-1zcx Multi-Agent Orchestration Testing Strategy
 * @see i-3s6o Phase 2c: Conflict Resolution Flow E2E Tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import {
  MergeQueue,
  createMergeQueue,
  MergeRequestStateError,
  MergeRequestNotFoundError,
} from "../merge-queue.js";
import type { MergeQueueEvent, MergeRequest } from "../types.js";

describe("Conflict Resolution - MergeQueue API", () => {
  let db: Database.Database;
  let queue: MergeQueue;
  let events: MergeQueueEvent[];

  beforeEach(() => {
    db = new Database(":memory:");
    queue = createMergeQueue({ db });
    events = [];
    queue.onEvent((event) => events.push(event));
  });

  afterEach(() => {
    queue.close();
    db.close();
  });

  // ===========================================================================
  // State Transitions: pending → processing → conflict
  // ===========================================================================

  describe("state transition: pending → processing → conflict", () => {
    it("should mark processing MR as conflict with file list", () => {
      const mrId = queue.submit({
        streamId: "stream-1",
        taskId: "task-1",
        workerBranch: "worker/task-1",
        workerAgentId: "agent-1",
      });

      queue.markProcessing(mrId);
      queue.markConflict(mrId, ["src/index.ts", "src/utils.ts"]);

      const mr = queue.get(mrId);
      expect(mr?.status).toBe("conflict");
      expect(mr?.conflictFiles).toEqual(["src/index.ts", "src/utils.ts"]);
      expect(mr?.completedAt).toBeDefined();
    });

    it("should mark conflict with resolver task ID", () => {
      const mrId = queue.submit({
        streamId: "stream-1",
        taskId: "task-1",
        workerBranch: "worker/task-1",
        workerAgentId: "agent-1",
      });

      queue.markProcessing(mrId);
      queue.markConflict(mrId, ["file.ts"], "resolver-task-123");

      const mr = queue.get(mrId);
      expect(mr?.status).toBe("conflict");
      expect(mr?.resolverTaskId).toBe("resolver-task-123");
    });

    it("should reject markConflict on pending MR", () => {
      const mrId = queue.submit({
        streamId: "stream-1",
        taskId: "task-1",
        workerBranch: "worker/task-1",
        workerAgentId: "agent-1",
      });

      expect(() => queue.markConflict(mrId, ["file.ts"])).toThrow(
        MergeRequestStateError
      );
    });

    it("should reject markConflict on already merged MR", () => {
      const mrId = queue.submit({
        streamId: "stream-1",
        taskId: "task-1",
        workerBranch: "worker/task-1",
        workerAgentId: "agent-1",
      });

      queue.markProcessing(mrId);
      queue.markMerged(mrId, "commit-abc");

      expect(() => queue.markConflict(mrId, ["file.ts"])).toThrow(
        MergeRequestStateError
      );
    });

    it("should reject markConflict on abandoned MR", () => {
      const mrId = queue.submit({
        streamId: "stream-1",
        taskId: "task-1",
        workerBranch: "worker/task-1",
        workerAgentId: "agent-1",
      });

      queue.markAbandoned(mrId);

      expect(() => queue.markConflict(mrId, ["file.ts"])).toThrow(
        MergeRequestStateError
      );
    });

    it("should reject markConflict on nonexistent MR", () => {
      expect(() => queue.markConflict("nonexistent", ["file.ts"])).toThrow(
        MergeRequestNotFoundError
      );
    });
  });

  // ===========================================================================
  // State Transitions: conflict → merged (via markResolverComplete)
  // ===========================================================================

  describe("state transition: conflict → merged (resolver complete)", () => {
    it("should transition conflict to merged via markResolverComplete", () => {
      const mrId = queue.submit({
        streamId: "stream-1",
        taskId: "task-1",
        workerBranch: "worker/task-1",
        workerAgentId: "agent-1",
      });

      queue.markProcessing(mrId);
      queue.markConflict(mrId, ["file.ts"], "resolver-task-1");

      queue.markResolverComplete(mrId, "resolved-commit-abc", "resolver/mr-123@1700000000");

      const mr = queue.get(mrId);
      expect(mr?.status).toBe("merged");
      expect(mr?.mergeCommit).toBe("resolved-commit-abc");
    });

    it("should reject markResolverComplete on pending MR", () => {
      const mrId = queue.submit({
        streamId: "stream-1",
        taskId: "task-1",
        workerBranch: "worker/task-1",
        workerAgentId: "agent-1",
      });

      expect(() => queue.markResolverComplete(mrId, "commit")).toThrow(
        /must be 'conflict'/
      );
    });

    it("should reject markResolverComplete on processing MR", () => {
      const mrId = queue.submit({
        streamId: "stream-1",
        taskId: "task-1",
        workerBranch: "worker/task-1",
        workerAgentId: "agent-1",
      });

      queue.markProcessing(mrId);

      expect(() => queue.markResolverComplete(mrId, "commit")).toThrow(
        /must be 'conflict'/
      );
    });

    it("should reject markResolverComplete on already merged MR", () => {
      const mrId = queue.submit({
        streamId: "stream-1",
        taskId: "task-1",
        workerBranch: "worker/task-1",
        workerAgentId: "agent-1",
      });

      queue.markProcessing(mrId);
      queue.markMerged(mrId, "commit-1");

      expect(() => queue.markResolverComplete(mrId, "commit-2")).toThrow(
        /must be 'conflict'/
      );
    });

    it("should reject regular markMerged on conflict MR", () => {
      const mrId = queue.submit({
        streamId: "stream-1",
        taskId: "task-1",
        workerBranch: "worker/task-1",
        workerAgentId: "agent-1",
      });

      queue.markProcessing(mrId);
      queue.markConflict(mrId, ["file.ts"]);

      // Regular markMerged should fail on conflict state
      expect(() => queue.markMerged(mrId, "commit")).toThrow(MergeRequestStateError);
    });
  });

  // ===========================================================================
  // Event Emissions
  // ===========================================================================

  describe("event emissions", () => {
    it("should emit mr:conflict event with conflict details", () => {
      const mrId = queue.submit({
        streamId: "stream-1",
        taskId: "task-1",
        workerBranch: "worker/task-1",
        workerAgentId: "agent-1",
      });

      queue.markProcessing(mrId);
      queue.markConflict(mrId, ["src/a.ts", "src/b.ts"], "resolver-123");

      const conflictEvent = events.find((e) => e.type === "mr:conflict");
      expect(conflictEvent).toBeDefined();
      expect(conflictEvent!.data).toMatchObject({
        mrId,
        streamId: "stream-1",
        taskId: "task-1",
        conflictFiles: ["src/a.ts", "src/b.ts"],
        resolverTaskId: "resolver-123",
      });
    });

    it("should emit mr:resolved event when resolver completes", () => {
      const mrId = queue.submit({
        streamId: "stream-1",
        taskId: "task-1",
        workerBranch: "worker/task-1",
        workerAgentId: "agent-1",
      });

      queue.markProcessing(mrId);
      queue.markConflict(mrId, ["file.ts"], "resolver-task-1");
      queue.markResolverComplete(mrId, "resolved-commit", "resolver/mr-xyz@123");

      const resolvedEvent = events.find((e) => e.type === "mr:resolved");
      expect(resolvedEvent).toBeDefined();
      expect(resolvedEvent!.data).toMatchObject({
        mrId,
        mergeCommit: "resolved-commit",
        resolverTaskId: "resolver-task-1",
        resolverBranch: "resolver/mr-xyz@123",
      });
    });

    it("should emit full event lifecycle for conflict resolution", () => {
      const mrId = queue.submit({
        streamId: "stream-1",
        taskId: "task-1",
        workerBranch: "worker/task-1",
        workerAgentId: "agent-1",
      });

      queue.markProcessing(mrId);
      queue.markConflict(mrId, ["file.ts"], "resolver-1");
      queue.markResolverComplete(mrId, "commit-abc", "resolver/branch");

      expect(events.map((e) => e.type)).toEqual([
        "mr:submitted",
        "mr:processing",
        "mr:conflict",
        "mr:resolved",
      ]);
    });
  });

  // ===========================================================================
  // Querying Conflicts
  // ===========================================================================

  describe("querying conflicts", () => {
    it("should query MRs in conflict state", () => {
      // Submit multiple MRs
      const mr1 = queue.submit({
        streamId: "stream-1",
        taskId: "task-1",
        workerBranch: "branch-1",
        workerAgentId: "agent-1",
      });
      const mr2 = queue.submit({
        streamId: "stream-1",
        taskId: "task-2",
        workerBranch: "branch-2",
        workerAgentId: "agent-2",
      });
      const mr3 = queue.submit({
        streamId: "stream-1",
        taskId: "task-3",
        workerBranch: "branch-3",
        workerAgentId: "agent-3",
      });

      // Process and mark some as conflict
      queue.markProcessing(mr1);
      queue.markConflict(mr1, ["file1.ts"]);

      queue.markProcessing(mr2);
      queue.markMerged(mr2, "commit-2");

      queue.markProcessing(mr3);
      queue.markConflict(mr3, ["file3.ts"], "resolver-3");

      // Query conflicts
      const conflicts = queue.getPending("stream-1", { status: "conflict" });
      expect(conflicts).toHaveLength(2);
      expect(conflicts.map((mr) => mr.id)).toContain(mr1);
      expect(conflicts.map((mr) => mr.id)).toContain(mr3);
    });

    it("should filter conflicts with vs without resolver", () => {
      const mr1 = queue.submit({
        streamId: "stream-1",
        taskId: "task-1",
        workerBranch: "branch-1",
        workerAgentId: "agent-1",
      });
      const mr2 = queue.submit({
        streamId: "stream-1",
        taskId: "task-2",
        workerBranch: "branch-2",
        workerAgentId: "agent-2",
      });

      queue.markProcessing(mr1);
      queue.markConflict(mr1, ["file1.ts"], "resolver-1"); // Has resolver

      queue.markProcessing(mr2);
      queue.markConflict(mr2, ["file2.ts"]); // No resolver

      const conflicts = queue.getPending("stream-1", { status: "conflict" });

      const withResolver = conflicts.filter((mr) => mr.resolverTaskId !== null);
      const withoutResolver = conflicts.filter((mr) => mr.resolverTaskId === null);

      expect(withResolver).toHaveLength(1);
      expect(withResolver[0].id).toBe(mr1);

      expect(withoutResolver).toHaveLength(1);
      expect(withoutResolver[0].id).toBe(mr2);
    });

    it("should return empty array for stream with no conflicts", () => {
      const mrId = queue.submit({
        streamId: "stream-1",
        taskId: "task-1",
        workerBranch: "branch-1",
        workerAgentId: "agent-1",
      });

      queue.markProcessing(mrId);
      queue.markMerged(mrId, "commit");

      const conflicts = queue.getPending("stream-1", { status: "conflict" });
      expect(conflicts).toHaveLength(0);
    });

    it("should isolate conflicts by stream", () => {
      const mr1 = queue.submit({
        streamId: "stream-1",
        taskId: "task-1",
        workerBranch: "branch-1",
        workerAgentId: "agent-1",
      });
      const mr2 = queue.submit({
        streamId: "stream-2",
        taskId: "task-2",
        workerBranch: "branch-2",
        workerAgentId: "agent-2",
      });

      queue.markProcessing(mr1);
      queue.markConflict(mr1, ["file1.ts"]);

      queue.markProcessing(mr2);
      queue.markConflict(mr2, ["file2.ts"]);

      const stream1Conflicts = queue.getPending("stream-1", { status: "conflict" });
      const stream2Conflicts = queue.getPending("stream-2", { status: "conflict" });

      expect(stream1Conflicts).toHaveLength(1);
      expect(stream1Conflicts[0].id).toBe(mr1);

      expect(stream2Conflicts).toHaveLength(1);
      expect(stream2Conflicts[0].id).toBe(mr2);
    });
  });

  // ===========================================================================
  // Multiple Conflicts in Queue
  // ===========================================================================

  describe("multiple conflicts in queue", () => {
    it("should handle multiple sequential conflicts", () => {
      const mrs: string[] = [];

      // Submit and process 5 MRs, all conflict
      for (let i = 0; i < 5; i++) {
        const mrId = queue.submit({
          streamId: "stream-1",
          taskId: `task-${i}`,
          workerBranch: `branch-${i}`,
          workerAgentId: `agent-${i}`,
        });
        mrs.push(mrId);
        queue.markProcessing(mrId);
        queue.markConflict(mrId, [`file-${i}.ts`], `resolver-${i}`);
      }

      // All should be in conflict state
      const conflicts = queue.getPending("stream-1", { status: "conflict" });
      expect(conflicts).toHaveLength(5);

      // Resolve them one by one
      for (let i = 0; i < 5; i++) {
        queue.markResolverComplete(mrs[i], `commit-${i}`, `resolver/branch-${i}`);
      }

      // All should be merged now
      const remainingConflicts = queue.getPending("stream-1", { status: "conflict" });
      expect(remainingConflicts).toHaveLength(0);

      // Verify all merged
      for (let i = 0; i < 5; i++) {
        const mr = queue.get(mrs[i]);
        expect(mr?.status).toBe("merged");
      }
    });

    it("should maintain queue depth correctly with conflicts", () => {
      const mr1 = queue.submit({
        streamId: "stream-1",
        taskId: "task-1",
        workerBranch: "branch-1",
        workerAgentId: "agent-1",
      });
      const mr2 = queue.submit({
        streamId: "stream-1",
        taskId: "task-2",
        workerBranch: "branch-2",
        workerAgentId: "agent-2",
      });

      // Initial depth
      expect(queue.getQueueDepth("stream-1")).toBe(2);

      // Process first - conflict
      queue.markProcessing(mr1);
      queue.markConflict(mr1, ["file.ts"]);

      // Conflict counts toward depth (still needs resolution)
      // Actually, let's check what the current behavior is
      // getPending typically returns pending items, so conflicts might not count
      const pending = queue.getPending("stream-1");
      expect(pending).toHaveLength(1); // Only mr2 is pending
      expect(pending[0].id).toBe(mr2);
    });

    it("should process remaining queue after conflict", () => {
      const mr1 = queue.submit({
        streamId: "stream-1",
        taskId: "task-1",
        workerBranch: "branch-1",
        workerAgentId: "agent-1",
      });
      const mr2 = queue.submit({
        streamId: "stream-1",
        taskId: "task-2",
        workerBranch: "branch-2",
        workerAgentId: "agent-2",
      });
      const mr3 = queue.submit({
        streamId: "stream-1",
        taskId: "task-3",
        workerBranch: "branch-3",
        workerAgentId: "agent-3",
      });

      // First conflicts
      queue.markProcessing(mr1);
      queue.markConflict(mr1, ["shared.ts"]);

      // Can still process next in queue
      const next = queue.getNext("stream-1");
      expect(next?.id).toBe(mr2);

      queue.markProcessing(mr2);
      queue.markMerged(mr2, "commit-2");

      // And the next
      const next2 = queue.getNext("stream-1");
      expect(next2?.id).toBe(mr3);
    });
  });

  // ===========================================================================
  // Conflict File Tracking
  // ===========================================================================

  describe("conflict file tracking", () => {
    it("should store single conflict file", () => {
      const mrId = queue.submit({
        streamId: "stream-1",
        taskId: "task-1",
        workerBranch: "branch-1",
        workerAgentId: "agent-1",
      });

      queue.markProcessing(mrId);
      queue.markConflict(mrId, ["src/index.ts"]);

      const mr = queue.get(mrId);
      expect(mr?.conflictFiles).toEqual(["src/index.ts"]);
    });

    it("should store multiple conflict files", () => {
      const mrId = queue.submit({
        streamId: "stream-1",
        taskId: "task-1",
        workerBranch: "branch-1",
        workerAgentId: "agent-1",
      });

      queue.markProcessing(mrId);
      queue.markConflict(mrId, [
        "src/index.ts",
        "src/utils.ts",
        "src/helpers/format.ts",
        "package.json",
      ]);

      const mr = queue.get(mrId);
      expect(mr?.conflictFiles).toHaveLength(4);
      expect(mr?.conflictFiles).toContain("src/index.ts");
      expect(mr?.conflictFiles).toContain("package.json");
    });

    it("should handle empty conflict file list", () => {
      const mrId = queue.submit({
        streamId: "stream-1",
        taskId: "task-1",
        workerBranch: "branch-1",
        workerAgentId: "agent-1",
      });

      queue.markProcessing(mrId);
      queue.markConflict(mrId, []);

      const mr = queue.get(mrId);
      expect(mr?.status).toBe("conflict");
      expect(mr?.conflictFiles).toEqual([]);
    });

    it("should preserve conflict files after resolution", () => {
      const mrId = queue.submit({
        streamId: "stream-1",
        taskId: "task-1",
        workerBranch: "branch-1",
        workerAgentId: "agent-1",
      });

      queue.markProcessing(mrId);
      queue.markConflict(mrId, ["src/index.ts", "src/utils.ts"], "resolver-1");
      queue.markResolverComplete(mrId, "commit-abc", "resolver/branch");

      const mr = queue.get(mrId);
      expect(mr?.status).toBe("merged");
      // Conflict files should still be recorded for history
      expect(mr?.conflictFiles).toEqual(["src/index.ts", "src/utils.ts"]);
    });
  });

  // ===========================================================================
  // Edge Cases
  // ===========================================================================

  describe("edge cases", () => {
    it("should handle conflict on same MR twice (idempotent update)", () => {
      const mrId = queue.submit({
        streamId: "stream-1",
        taskId: "task-1",
        workerBranch: "branch-1",
        workerAgentId: "agent-1",
      });

      queue.markProcessing(mrId);
      queue.markConflict(mrId, ["file1.ts"]);

      // Trying to mark conflict again should fail (already in conflict state)
      expect(() => queue.markConflict(mrId, ["file2.ts"])).toThrow(
        MergeRequestStateError
      );
    });

    it("should handle resolver complete without resolver task ID", () => {
      const mrId = queue.submit({
        streamId: "stream-1",
        taskId: "task-1",
        workerBranch: "branch-1",
        workerAgentId: "agent-1",
      });

      queue.markProcessing(mrId);
      queue.markConflict(mrId, ["file.ts"]); // No resolver task ID

      // Should still be able to mark as resolved
      queue.markResolverComplete(mrId, "commit-abc");

      const mr = queue.get(mrId);
      expect(mr?.status).toBe("merged");
    });

    it("should handle special characters in conflict file paths", () => {
      const mrId = queue.submit({
        streamId: "stream-1",
        taskId: "task-1",
        workerBranch: "branch-1",
        workerAgentId: "agent-1",
      });

      queue.markProcessing(mrId);
      queue.markConflict(mrId, [
        "src/file with spaces.ts",
        "src/file'with'quotes.ts",
        'src/file"with"doublequotes.ts',
        "src/文件.ts", // Unicode
      ]);

      const mr = queue.get(mrId);
      expect(mr?.conflictFiles).toHaveLength(4);
      expect(mr?.conflictFiles).toContain("src/file with spaces.ts");
      expect(mr?.conflictFiles).toContain("src/文件.ts");
    });

    it("should handle very long conflict file list", () => {
      const mrId = queue.submit({
        streamId: "stream-1",
        taskId: "task-1",
        workerBranch: "branch-1",
        workerAgentId: "agent-1",
      });

      const manyFiles = Array.from({ length: 100 }, (_, i) => `src/file-${i}.ts`);

      queue.markProcessing(mrId);
      queue.markConflict(mrId, manyFiles);

      const mr = queue.get(mrId);
      expect(mr?.conflictFiles).toHaveLength(100);
    });
  });

  // ===========================================================================
  // Resolver Branch Naming
  // ===========================================================================

  describe("resolver branch naming convention", () => {
    it("should accept valid resolver branch format", () => {
      const mrId = queue.submit({
        streamId: "stream-1",
        taskId: "task-1",
        workerBranch: "branch-1",
        workerAgentId: "agent-1",
      });

      queue.markProcessing(mrId);
      queue.markConflict(mrId, ["file.ts"], "resolver-task-1");

      const timestamp = Date.now();
      const resolverBranch = `resolver/${mrId}@${timestamp}`;

      queue.markResolverComplete(mrId, "commit-abc", resolverBranch);

      const mr = queue.get(mrId);
      expect(mr?.status).toBe("merged");
    });

    it("should track resolver branch in resolved event", () => {
      const mrId = queue.submit({
        streamId: "stream-1",
        taskId: "task-1",
        workerBranch: "branch-1",
        workerAgentId: "agent-1",
      });

      queue.markProcessing(mrId);
      queue.markConflict(mrId, ["file.ts"], "resolver-task-1");
      queue.markResolverComplete(mrId, "commit-abc", "resolver/mr-123@1700000000");

      const resolvedEvent = events.find((e) => e.type === "mr:resolved");
      expect(resolvedEvent!.data.resolverBranch).toBe("resolver/mr-123@1700000000");
    });
  });
});
