/**
 * Merge Queue and Worktree Tests
 *
 * Tests for the extended TestHarness merge queue and worktree features.
 *
 * @see s-1zcx Multi-Agent Orchestration Testing Strategy
 * @see i-89vr Phase 2a: Extend TestHarness
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";

import {
  createTestHarness,
  type TestHarness,
  HarnessAssertionError,
} from "../index.js";

describe("Merge Queue and Worktree Extensions", () => {
  // ─────────────────────────────────────────────────────────────────────────
  // Merge Queue Tests
  // ─────────────────────────────────────────────────────────────────────────

  describe("MergeQueue", () => {
    let harness: TestHarness;

    beforeEach(async () => {
      harness = await createTestHarness({ withMergeQueue: true });
    });

    afterEach(async () => {
      await harness.cleanup();
    });

    it("should create harness with merge queue", () => {
      expect(harness.mergeQueue).toBeDefined();
      expect(harness.mergeQueue).not.toBeNull();
    });

    it("should submit merge requests", () => {
      const mrId = harness.submitMergeRequest({
        streamId: "stream-1",
        taskId: "task-1",
        workerBranch: "worker/task-1",
        workerAgentId: "worker-1",
      });

      expect(mrId).toBeDefined();
      expect(mrId).toMatch(/^mr-/);

      harness.assertMergeRequestStatus(mrId, "pending");
    });

    it("should track merge queue depth", () => {
      harness.assertMergeQueueDepth("stream-1", 0);

      harness.submitMergeRequest({
        streamId: "stream-1",
        taskId: "task-1",
        workerBranch: "worker/task-1",
        workerAgentId: "worker-1",
      });

      harness.assertMergeQueueDepth("stream-1", 1);

      harness.submitMergeRequest({
        streamId: "stream-1",
        taskId: "task-2",
        workerBranch: "worker/task-2",
        workerAgentId: "worker-2",
      });

      harness.assertMergeQueueDepth("stream-1", 2);
    });

    it("should process merge requests successfully", () => {
      const mrId = harness.submitMergeRequest({
        streamId: "stream-1",
        taskId: "task-1",
        workerBranch: "worker/task-1",
        workerAgentId: "worker-1",
      });

      const processedId = harness.processNextMergeRequest("stream-1");
      expect(processedId).toBe(mrId);

      harness.assertMergeRequestMerged(mrId);
      harness.assertMergeQueueDepth("stream-1", 0);
    });

    it("should simulate merge conflicts", () => {
      const mrId = harness.submitMergeRequest({
        streamId: "stream-1",
        taskId: "task-1",
        workerBranch: "worker/task-1",
        workerAgentId: "worker-1",
      });

      harness.processNextMergeRequest("stream-1", {
        simulateConflict: true,
        conflictFiles: ["src/shared.ts", "src/utils.ts"],
      });

      harness.assertMergeRequestConflict(mrId, ["src/shared.ts", "src/utils.ts"]);
    });

    it("should process all merge requests", () => {
      const mr1 = harness.submitMergeRequest({
        streamId: "stream-1",
        taskId: "task-1",
        workerBranch: "worker/task-1",
        workerAgentId: "worker-1",
      });

      const mr2 = harness.submitMergeRequest({
        streamId: "stream-1",
        taskId: "task-2",
        workerBranch: "worker/task-2",
        workerAgentId: "worker-2",
      });

      const processed = harness.processAllMergeRequests("stream-1");
      expect(processed).toHaveLength(2);
      expect(processed).toContain(mr1);
      expect(processed).toContain(mr2);

      harness.assertMergeRequestMerged(mr1);
      harness.assertMergeRequestMerged(mr2);
      harness.assertMergeQueueDepth("stream-1", 0);
    });

    it("should process with selective conflicts", () => {
      const mr1 = harness.submitMergeRequest({
        streamId: "stream-1",
        taskId: "task-1",
        workerBranch: "worker/task-1",
        workerAgentId: "worker-1",
      });

      const mr2 = harness.submitMergeRequest({
        streamId: "stream-1",
        taskId: "task-2",
        workerBranch: "worker/task-2",
        workerAgentId: "worker-2",
      });

      const conflicts = new Map<string, string[]>();
      conflicts.set(mr2, ["conflict.ts"]);

      harness.processAllMergeRequests("stream-1", { simulateConflicts: conflicts });

      harness.assertMergeRequestMerged(mr1);
      harness.assertMergeRequestConflict(mr2);
    });

    it("should assert task merge request status", () => {
      harness.submitMergeRequest({
        streamId: "stream-1",
        taskId: "task-1",
        workerBranch: "worker/task-1",
        workerAgentId: "worker-1",
      });

      harness.assertTaskMergeRequestStatus("task-1", "pending");

      harness.processNextMergeRequest("stream-1");

      harness.assertTaskMergeRequestStatus("task-1", "merged");
    });

    it("should isolate streams", () => {
      harness.submitMergeRequest({
        streamId: "stream-1",
        taskId: "task-1",
        workerBranch: "worker/task-1",
        workerAgentId: "worker-1",
      });

      harness.submitMergeRequest({
        streamId: "stream-2",
        taskId: "task-2",
        workerBranch: "worker/task-2",
        workerAgentId: "worker-2",
      });

      harness.assertMergeQueueDepth("stream-1", 1);
      harness.assertMergeQueueDepth("stream-2", 1);

      harness.processAllMergeRequests("stream-1");

      harness.assertMergeQueueDepth("stream-1", 0);
      harness.assertMergeQueueDepth("stream-2", 1);
    });

    it("should throw when merge queue not enabled", async () => {
      const harnessWithoutMQ = await createTestHarness({ withMergeQueue: false });

      expect(() => harnessWithoutMQ.submitMergeRequest({
        streamId: "stream-1",
        taskId: "task-1",
        workerBranch: "worker/task-1",
        workerAgentId: "worker-1",
      })).toThrow("Merge queue not enabled");

      await harnessWithoutMQ.cleanup();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Worktree Tests
  // ─────────────────────────────────────────────────────────────────────────

  describe("Worktrees", () => {
    let harness: TestHarness;

    beforeEach(async () => {
      harness = await createTestHarness({ withWorkspaces: true });
      await harness.createTempRepo({
        initialFiles: {
          "src/index.ts": "export const version = '1.0.0';",
        },
      });
    });

    afterEach(async () => {
      await harness.cleanup();
    });

    it("should create worktree for agent", () => {
      const worktreePath = harness.createWorktreeForAgent("worker-1", "feature/task-1");

      expect(worktreePath).toBeDefined();
      expect(fs.existsSync(worktreePath)).toBe(true);
      expect(fs.existsSync(path.join(worktreePath, ".git"))).toBe(true);

      harness.assertWorktreeExists(worktreePath);
      harness.assertAgentHasWorktree("worker-1");
    });

    it("should track worktree paths", () => {
      const worktreePath = harness.createWorktreeForAgent("worker-1", "feature/task-1");

      expect(harness.worktrees.get("worker-1")).toBe(worktreePath);
      expect(harness.getWorktreePath("worker-1")).toBe(worktreePath);
    });

    it("should create worktree on correct branch", () => {
      const worktreePath = harness.createWorktreeForAgent("worker-1", "feature/task-1");

      harness.assertWorktreeBranch(worktreePath, "feature/task-1");
    });

    it("should have clean working tree after creation", () => {
      const worktreePath = harness.createWorktreeForAgent("worker-1", "feature/task-1");

      harness.assertWorktreeClean(worktreePath);
    });

    it("should inherit files from base branch", () => {
      const worktreePath = harness.createWorktreeForAgent("worker-1", "feature/task-1");

      harness.assertWorktreeFileExists(worktreePath, "src/index.ts");
      harness.assertWorktreeFileContains(worktreePath, "src/index.ts", "version");
    });

    it("should remove worktree", () => {
      const worktreePath = harness.createWorktreeForAgent("worker-1", "feature/task-1");

      harness.removeWorktree("worker-1");

      expect(harness.getWorktreePath("worker-1")).toBeUndefined();
      expect(harness.worktrees.has("worker-1")).toBe(false);
    });

    it("should create multiple worktrees", () => {
      const wt1 = harness.createWorktreeForAgent("worker-1", "feature/task-1");
      const wt2 = harness.createWorktreeForAgent("worker-2", "feature/task-2");

      expect(wt1).not.toBe(wt2);

      harness.assertWorktreeExists(wt1);
      harness.assertWorktreeExists(wt2);
      harness.assertWorktreeBranch(wt1, "feature/task-1");
      harness.assertWorktreeBranch(wt2, "feature/task-2");
    });

    it("should throw when workspaces not enabled", async () => {
      const harnessWithoutWS = await createTestHarness({ withWorkspaces: false });
      await harnessWithoutWS.createTempRepo();

      expect(() => harnessWithoutWS.createWorktreeForAgent("worker-1", "feature/task-1"))
        .toThrow("Worktree support not enabled");

      await harnessWithoutWS.cleanup();
    });

    it("should throw when no repo available", async () => {
      const harnessNoRepo = await createTestHarness({ withWorkspaces: true });

      expect(() => harnessNoRepo.createWorktreeForAgent("worker-1", "feature/task-1"))
        .toThrow("No repository available");

      await harnessNoRepo.cleanup();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Assertion Error Tests
  // ─────────────────────────────────────────────────────────────────────────

  describe("Assertion Errors", () => {
    let harness: TestHarness;

    beforeEach(async () => {
      harness = await createTestHarness({ withMergeQueue: true, withWorkspaces: true });
      await harness.createTempRepo();
    });

    afterEach(async () => {
      await harness.cleanup();
    });

    it("should fail assertMergeRequestStatus for non-existent MR", () => {
      expect(() => harness.assertMergeRequestStatus("nonexistent", "pending"))
        .toThrow(HarnessAssertionError);
    });

    it("should fail assertMergeRequestStatus for wrong status", () => {
      const mrId = harness.submitMergeRequest({
        streamId: "stream-1",
        taskId: "task-1",
        workerBranch: "worker/task-1",
        workerAgentId: "worker-1",
      });

      expect(() => harness.assertMergeRequestStatus(mrId, "merged"))
        .toThrow(HarnessAssertionError);
    });

    it("should fail assertMergeQueueDepth for wrong depth", () => {
      harness.submitMergeRequest({
        streamId: "stream-1",
        taskId: "task-1",
        workerBranch: "worker/task-1",
        workerAgentId: "worker-1",
      });

      expect(() => harness.assertMergeQueueDepth("stream-1", 0))
        .toThrow(HarnessAssertionError);
    });

    it("should fail assertWorktreeExists for non-existent path", () => {
      expect(() => harness.assertWorktreeExists("/nonexistent/path"))
        .toThrow(HarnessAssertionError);
    });

    it("should fail assertAgentHasWorktree for agent without worktree", () => {
      expect(() => harness.assertAgentHasWorktree("nonexistent-agent"))
        .toThrow(HarnessAssertionError);
    });

    it("should fail assertWorktreeBranch for wrong branch", () => {
      const worktreePath = harness.createWorktreeForAgent("worker-1", "feature/task-1");

      expect(() => harness.assertWorktreeBranch(worktreePath, "wrong-branch"))
        .toThrow(HarnessAssertionError);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Combined Usage Tests
  // ─────────────────────────────────────────────────────────────────────────

  describe("Combined MergeQueue and Worktree Usage", () => {
    let harness: TestHarness;

    beforeEach(async () => {
      harness = await createTestHarness({
        withMergeQueue: true,
        withWorkspaces: true,
      });
      await harness.createTempRepo({
        initialFiles: {
          "src/index.ts": "export const version = '1.0.0';",
        },
      });
    });

    afterEach(async () => {
      await harness.cleanup();
    });

    it("should simulate worker flow with worktree and merge request", () => {
      // Create worktree for worker
      const worktreePath = harness.createWorktreeForAgent("worker-1", "feature/task-1");

      harness.assertAgentHasWorktree("worker-1");
      harness.assertWorktreeBranch(worktreePath, "feature/task-1");

      // Submit merge request when work is done
      const mrId = harness.submitMergeRequest({
        streamId: "stream-1",
        taskId: "task-1",
        workerBranch: "feature/task-1",
        workerAgentId: "worker-1",
      });

      harness.assertMergeRequestStatus(mrId, "pending");
      harness.assertMergeQueueDepth("stream-1", 1);

      // Process merge request
      harness.processNextMergeRequest("stream-1");

      harness.assertMergeRequestMerged(mrId);
      harness.assertMergeQueueDepth("stream-1", 0);

      // Cleanup worktree
      harness.removeWorktree("worker-1");
      expect(harness.getWorktreePath("worker-1")).toBeUndefined();
    });

    it("should handle multiple workers with merge queue", () => {
      // Create worktrees for multiple workers
      const wt1 = harness.createWorktreeForAgent("worker-1", "feature/task-1");
      const wt2 = harness.createWorktreeForAgent("worker-2", "feature/task-2");

      // Both submit merge requests
      const mr1 = harness.submitMergeRequest({
        streamId: "stream-1",
        taskId: "task-1",
        workerBranch: "feature/task-1",
        workerAgentId: "worker-1",
      });

      const mr2 = harness.submitMergeRequest({
        streamId: "stream-1",
        taskId: "task-2",
        workerBranch: "feature/task-2",
        workerAgentId: "worker-2",
      });

      harness.assertMergeQueueDepth("stream-1", 2);

      // Process all
      harness.processAllMergeRequests("stream-1");

      harness.assertMergeRequestMerged(mr1);
      harness.assertMergeRequestMerged(mr2);
    });
  });
});
