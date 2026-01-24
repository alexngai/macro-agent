/**
 * Multi-Coordinator Integration Tests
 *
 * Tests for concurrent coordinators with independent streams,
 * stream isolation, and sequential worker dependencies.
 *
 * @see s-1zcx Multi-Agent Orchestration Testing Strategy
 * @see i-41aw Phase 2e: Multi-Coordinator E2E Tests
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";

import {
  createTestHarness,
  type TestHarness,
} from "../../../test_fixtures/harness/test-harness.js";
import type { SimulatedBehavior } from "../../../test_fixtures/harness/simulator/types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Test Behaviors
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a worker that writes to a specific file and submits a merge request
 */
function createFileWorker(
  filename: string,
  content: string
): SimulatedBehavior {
  return {
    onStart: [
      { type: "log", message: `Writing ${filename}` },
      { type: "write_file", path: filename, content },
      { type: "commit", message: `Add ${filename}` },
      { type: "done", status: "completed", summary: `Created ${filename}` },
    ],
  };
}

/**
 * Create a coordinator that waits for a signal before finishing
 */
function createWaitingCoordinator(signalName: string): SimulatedBehavior {
  return {
    onStart: [
      { type: "log", message: "Coordinator started, waiting for signal" },
      { type: "wait_for_event", event: signalName },
      { type: "done", status: "completed", summary: "Coordination complete" },
    ],
  };
}

/**
 * Create a coordinator that completes immediately
 */
function createQuickCoordinator(): SimulatedBehavior {
  return {
    onStart: [
      { type: "log", message: "Quick coordinator" },
      { type: "done", status: "completed", summary: "Quick coordination" },
    ],
  };
}

/**
 * Create a worker that edits a specific section of a file (by line range)
 */
function createSectionEditor(
  filename: string,
  section: string,
  content: string
): SimulatedBehavior {
  return {
    onStart: [
      { type: "log", message: `Editing section ${section} of ${filename}` },
      // Read current content, append to section
      { type: "write_file", path: filename, content },
      { type: "commit", message: `Update ${section} in ${filename}` },
      { type: "done", status: "completed", summary: `Updated ${section}` },
    ],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 4a: Independent Parallel Coordinators
// ─────────────────────────────────────────────────────────────────────────────

describe("Multi-Coordinator Integration", () => {
  describe("Scenario 4a: Independent Parallel Coordinators", () => {
    let harness: TestHarness;

    beforeEach(async () => {
      harness = await createTestHarness({
        withMergeQueue: true,
        withWorkspaces: true,
      });
      await harness.createTempRepo({
        initialFiles: {
          "src/index.ts": "export const version = '1.0.0';",
          "package.json": '{ "name": "multi-coord-test" }',
        },
      });
    });

    afterEach(async () => {
      await harness.cleanup();
    });

    it("should run two coordinators in parallel with separate streams", async () => {
      // Coordinator A with stream-a
      const coordA = await harness.spawnSimulator({
        role: "coordinator",
        streamId: "stream-a",
        agentId: "coord-a",
        behavior: createWaitingCoordinator("ALL_A_DONE"),
      });

      // Coordinator B with stream-b
      const coordB = await harness.spawnSimulator({
        role: "coordinator",
        streamId: "stream-b",
        agentId: "coord-b",
        behavior: createWaitingCoordinator("ALL_B_DONE"),
      });

      // Workers for stream-a
      const wt_a1 = harness.createWorktreeForAgent(
        "worker-a1",
        "feature/task-a1",
        { baseBranch: "main", streamId: "stream-a" }
      );
      const wt_a2 = harness.createWorktreeForAgent(
        "worker-a2",
        "feature/task-a2",
        { baseBranch: "main", streamId: "stream-a" }
      );

      const workerA1 = await harness.spawnSimulator({
        role: "worker",
        streamId: "stream-a",
        parentId: coordA.agentId,
        agentId: "worker-a1",
        repoPath: wt_a1,
        behavior: createFileWorker("feature-a1.txt", "Feature A1 content"),
      });

      const workerA2 = await harness.spawnSimulator({
        role: "worker",
        streamId: "stream-a",
        parentId: coordA.agentId,
        agentId: "worker-a2",
        repoPath: wt_a2,
        behavior: createFileWorker("feature-a2.txt", "Feature A2 content"),
      });

      // Workers for stream-b
      const wt_b1 = harness.createWorktreeForAgent(
        "worker-b1",
        "feature/task-b1",
        { baseBranch: "main", streamId: "stream-b" }
      );
      const wt_b2 = harness.createWorktreeForAgent(
        "worker-b2",
        "feature/task-b2",
        { baseBranch: "main", streamId: "stream-b" }
      );

      const workerB1 = await harness.spawnSimulator({
        role: "worker",
        streamId: "stream-b",
        parentId: coordB.agentId,
        agentId: "worker-b1",
        repoPath: wt_b1,
        behavior: createFileWorker("feature-b1.txt", "Feature B1 content"),
      });

      const workerB2 = await harness.spawnSimulator({
        role: "worker",
        streamId: "stream-b",
        parentId: coordB.agentId,
        agentId: "worker-b2",
        repoPath: wt_b2,
        behavior: createFileWorker("feature-b2.txt", "Feature B2 content"),
      });

      // Run all workers to completion
      await harness.waitForSimulator(workerA1.agentId, { maxIterations: 50 });
      await harness.waitForSimulator(workerA2.agentId, { maxIterations: 50 });
      await harness.waitForSimulator(workerB1.agentId, { maxIterations: 50 });
      await harness.waitForSimulator(workerB2.agentId, { maxIterations: 50 });

      // Verify all workers completed
      harness.assertSimulatorComplete(workerA1.agentId);
      harness.assertSimulatorComplete(workerA2.agentId);
      harness.assertSimulatorComplete(workerB1.agentId);
      harness.assertSimulatorComplete(workerB2.agentId);

      // Verify separate worktrees
      harness.assertAgentHasWorktree("worker-a1");
      harness.assertAgentHasWorktree("worker-a2");
      harness.assertAgentHasWorktree("worker-b1");
      harness.assertAgentHasWorktree("worker-b2");

      // Verify separate branches
      harness.assertWorktreeBranch(wt_a1, "feature/task-a1");
      harness.assertWorktreeBranch(wt_a2, "feature/task-a2");
      harness.assertWorktreeBranch(wt_b1, "feature/task-b1");
      harness.assertWorktreeBranch(wt_b2, "feature/task-b2");

      // Verify files exist in correct worktrees
      harness.assertWorktreeFileExists(wt_a1, "feature-a1.txt");
      harness.assertWorktreeFileExists(wt_a2, "feature-a2.txt");
      harness.assertWorktreeFileExists(wt_b1, "feature-b1.txt");
      harness.assertWorktreeFileExists(wt_b2, "feature-b2.txt");
    });

    it("should maintain separate merge queues per stream", async () => {
      // Submit merge requests for stream-a
      const mrA1 = harness.submitMergeRequest({
        streamId: "stream-a",
        taskId: "task-a1",
        workerBranch: "feature/task-a1",
        workerAgentId: "worker-a1",
      });

      const mrA2 = harness.submitMergeRequest({
        streamId: "stream-a",
        taskId: "task-a2",
        workerBranch: "feature/task-a2",
        workerAgentId: "worker-a2",
      });

      // Submit merge requests for stream-b
      const mrB1 = harness.submitMergeRequest({
        streamId: "stream-b",
        taskId: "task-b1",
        workerBranch: "feature/task-b1",
        workerAgentId: "worker-b1",
      });

      const mrB2 = harness.submitMergeRequest({
        streamId: "stream-b",
        taskId: "task-b2",
        workerBranch: "feature/task-b2",
        workerAgentId: "worker-b2",
      });

      // Verify separate queue depths
      harness.assertMergeQueueDepth("stream-a", 2);
      harness.assertMergeQueueDepth("stream-b", 2);

      // Process stream-a merge requests only
      harness.processAllMergeRequests("stream-a");

      // Stream-a should be empty, stream-b unchanged
      harness.assertMergeQueueDepth("stream-a", 0);
      harness.assertMergeQueueDepth("stream-b", 2);

      // Verify merge status
      harness.assertMergeRequestMerged(mrA1);
      harness.assertMergeRequestMerged(mrA2);
      harness.assertMergeRequestStatus(mrB1, "pending");
      harness.assertMergeRequestStatus(mrB2, "pending");

      // Now process stream-b
      harness.processAllMergeRequests("stream-b");

      harness.assertMergeQueueDepth("stream-b", 0);
      harness.assertMergeRequestMerged(mrB1);
      harness.assertMergeRequestMerged(mrB2);
    });

    it("should not have cross-stream interference", async () => {
      // Two coordinators, each with one worker
      const coordA = await harness.spawnSimulator({
        role: "coordinator",
        streamId: "stream-a",
        agentId: "coord-a",
        behavior: createQuickCoordinator(),
      });

      const coordB = await harness.spawnSimulator({
        role: "coordinator",
        streamId: "stream-b",
        agentId: "coord-b",
        behavior: createQuickCoordinator(),
      });

      // Workers
      const wt_a = harness.createWorktreeForAgent(
        "worker-a",
        "feature/task-a",
        { baseBranch: "main" }
      );
      const wt_b = harness.createWorktreeForAgent(
        "worker-b",
        "feature/task-b",
        { baseBranch: "main" }
      );

      const workerA = await harness.spawnSimulator({
        role: "worker",
        streamId: "stream-a",
        parentId: coordA.agentId,
        agentId: "worker-a",
        repoPath: wt_a,
        behavior: createFileWorker("stream-a-only.txt", "Stream A only"),
      });

      const workerB = await harness.spawnSimulator({
        role: "worker",
        streamId: "stream-b",
        parentId: coordB.agentId,
        agentId: "worker-b",
        repoPath: wt_b,
        behavior: createFileWorker("stream-b-only.txt", "Stream B only"),
      });

      // Run workers - they auto-submit merge requests when completed
      await harness.waitForSimulator(workerA.agentId, { maxIterations: 50 });
      await harness.waitForSimulator(workerB.agentId, { maxIterations: 50 });

      // Verify files only exist in their respective worktrees
      harness.assertWorktreeFileExists(wt_a, "stream-a-only.txt");
      harness.assertWorktreeFileExists(wt_b, "stream-b-only.txt");

      // Files should NOT exist in the wrong worktrees
      expect(fs.existsSync(path.join(wt_a, "stream-b-only.txt"))).toBe(false);
      expect(fs.existsSync(path.join(wt_b, "stream-a-only.txt"))).toBe(false);

      // Each merge queue is independent (workers auto-submitted)
      harness.assertMergeQueueDepth("stream-a", 1);
      harness.assertMergeQueueDepth("stream-b", 1);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Scenario 4b: Shared File, Different Parts
  // ─────────────────────────────────────────────────────────────────────────────

  describe("Scenario 4b: Shared File, Different Parts", () => {
    let harness: TestHarness;

    beforeEach(async () => {
      harness = await createTestHarness({
        withMergeQueue: true,
        withWorkspaces: true,
      });
      // Create a repo with a multi-section file
      await harness.createTempRepo({
        initialFiles: {
          "src/shared.ts": [
            "// SECTION: Header",
            "export const APP_NAME = 'test';",
            "",
            "// SECTION: Utils",
            "export function helper() {}",
            "",
            "// SECTION: Footer",
            "export const VERSION = '1.0.0';",
          ].join("\n"),
        },
      });
    });

    afterEach(async () => {
      await harness.cleanup();
    });

    it("should merge non-overlapping edits without conflict", async () => {
      // Two workers editing different parts of the same conceptual file
      // In practice, each worktree has its own copy
      const wt_a = harness.createWorktreeForAgent(
        "worker-a",
        "feature/header-update",
        { baseBranch: "main" }
      );
      const wt_b = harness.createWorktreeForAgent(
        "worker-b",
        "feature/footer-update",
        { baseBranch: "main" }
      );

      // Worker A edits the header section
      const workerA = await harness.spawnSimulator({
        role: "worker",
        streamId: "stream-main",
        agentId: "worker-a",
        repoPath: wt_a,
        behavior: {
          onStart: [
            { type: "log", message: "Updating header section" },
            {
              type: "write_file",
              path: "src/shared.ts",
              content: [
                "// SECTION: Header",
                "export const APP_NAME = 'updated-app';", // Changed
                "",
                "// SECTION: Utils",
                "export function helper() {}",
                "",
                "// SECTION: Footer",
                "export const VERSION = '1.0.0';",
              ].join("\n"),
            },
            { type: "commit", message: "Update header section" },
            { type: "done", status: "completed" },
          ],
        },
      });

      // Worker B edits the footer section
      const workerB = await harness.spawnSimulator({
        role: "worker",
        streamId: "stream-main",
        agentId: "worker-b",
        repoPath: wt_b,
        behavior: {
          onStart: [
            { type: "log", message: "Updating footer section" },
            {
              type: "write_file",
              path: "src/shared.ts",
              content: [
                "// SECTION: Header",
                "export const APP_NAME = 'test';",
                "",
                "// SECTION: Utils",
                "export function helper() {}",
                "",
                "// SECTION: Footer",
                "export const VERSION = '2.0.0';", // Changed
              ].join("\n"),
            },
            { type: "commit", message: "Update footer section" },
            { type: "done", status: "completed" },
          ],
        },
      });

      // Run both workers
      await harness.waitForSimulator(workerA.agentId, { maxIterations: 50 });
      await harness.waitForSimulator(workerB.agentId, { maxIterations: 50 });

      // Both should complete
      harness.assertSimulatorComplete(workerA.agentId);
      harness.assertSimulatorComplete(workerB.agentId);

      // Submit merge requests
      const mrA = harness.submitMergeRequest({
        streamId: "stream-main",
        taskId: "task-a",
        workerBranch: "feature/header-update",
        workerAgentId: "worker-a",
      });

      const mrB = harness.submitMergeRequest({
        streamId: "stream-main",
        taskId: "task-b",
        workerBranch: "feature/footer-update",
        workerAgentId: "worker-b",
      });

      // Process merge requests - both should succeed (no simulated conflict)
      harness.processAllMergeRequests("stream-main");

      harness.assertMergeRequestMerged(mrA);
      harness.assertMergeRequestMerged(mrB);
      harness.assertMergeQueueDepth("stream-main", 0);
    });

    it("should detect conflict when edits overlap", async () => {
      // Two workers editing the same section
      const wt_a = harness.createWorktreeForAgent(
        "worker-a",
        "feature/version-update-a",
        { baseBranch: "main" }
      );
      const wt_b = harness.createWorktreeForAgent(
        "worker-b",
        "feature/version-update-b",
        { baseBranch: "main" }
      );

      const workerA = await harness.spawnSimulator({
        role: "worker",
        streamId: "stream-main",
        agentId: "worker-a",
        repoPath: wt_a,
        behavior: {
          onStart: [
            {
              type: "write_file",
              path: "src/shared.ts",
              content: [
                "// SECTION: Header",
                "export const APP_NAME = 'test';",
                "",
                "// SECTION: Utils",
                "export function helper() {}",
                "",
                "// SECTION: Footer",
                "export const VERSION = '2.0.0';", // Worker A version
              ].join("\n"),
            },
            { type: "commit", message: "Update version to 2.0.0" },
            { type: "done", status: "completed" },
          ],
        },
      });

      const workerB = await harness.spawnSimulator({
        role: "worker",
        streamId: "stream-main",
        agentId: "worker-b",
        repoPath: wt_b,
        behavior: {
          onStart: [
            {
              type: "write_file",
              path: "src/shared.ts",
              content: [
                "// SECTION: Header",
                "export const APP_NAME = 'test';",
                "",
                "// SECTION: Utils",
                "export function helper() {}",
                "",
                "// SECTION: Footer",
                "export const VERSION = '3.0.0';", // Worker B version - CONFLICT
              ].join("\n"),
            },
            { type: "commit", message: "Update version to 3.0.0" },
            { type: "done", status: "completed" },
          ],
        },
      });

      await harness.waitForSimulator(workerA.agentId, { maxIterations: 50 });
      await harness.waitForSimulator(workerB.agentId, { maxIterations: 50 });

      // Submit merge requests
      const mrA = harness.submitMergeRequest({
        streamId: "stream-main",
        taskId: "task-a",
        workerBranch: "feature/version-update-a",
        workerAgentId: "worker-a",
      });

      const mrB = harness.submitMergeRequest({
        streamId: "stream-main",
        taskId: "task-b",
        workerBranch: "feature/version-update-b",
        workerAgentId: "worker-b",
      });

      // Process - first succeeds, second conflicts
      const conflicts = new Map<string, string[]>();
      conflicts.set(mrB, ["src/shared.ts"]);

      harness.processAllMergeRequests("stream-main", {
        simulateConflicts: conflicts,
      });

      harness.assertMergeRequestMerged(mrA);
      harness.assertMergeRequestConflict(mrB, ["src/shared.ts"]);
    });

    it("should handle different files from different workers", async () => {
      const wt_a = harness.createWorktreeForAgent(
        "worker-a",
        "feature/add-utils",
        { baseBranch: "main" }
      );
      const wt_b = harness.createWorktreeForAgent(
        "worker-b",
        "feature/add-helpers",
        { baseBranch: "main" }
      );

      const workerA = await harness.spawnSimulator({
        role: "worker",
        streamId: "stream-main",
        agentId: "worker-a",
        repoPath: wt_a,
        behavior: createFileWorker("src/utils.ts", "export const utils = {};"),
      });

      const workerB = await harness.spawnSimulator({
        role: "worker",
        streamId: "stream-main",
        agentId: "worker-b",
        repoPath: wt_b,
        behavior: createFileWorker(
          "src/helpers.ts",
          "export const helpers = {};"
        ),
      });

      await harness.waitForSimulator(workerA.agentId, { maxIterations: 50 });
      await harness.waitForSimulator(workerB.agentId, { maxIterations: 50 });

      // Different files should never conflict
      const mrA = harness.submitMergeRequest({
        streamId: "stream-main",
        taskId: "task-a",
        workerBranch: "feature/add-utils",
        workerAgentId: "worker-a",
      });

      const mrB = harness.submitMergeRequest({
        streamId: "stream-main",
        taskId: "task-b",
        workerBranch: "feature/add-helpers",
        workerAgentId: "worker-b",
      });

      harness.processAllMergeRequests("stream-main");

      harness.assertMergeRequestMerged(mrA);
      harness.assertMergeRequestMerged(mrB);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Scenario 4c: Sequential Dependency (Worker A → Worker B)
  // ─────────────────────────────────────────────────────────────────────────────

  describe("Scenario 4c: Sequential Dependency", () => {
    let harness: TestHarness;

    beforeEach(async () => {
      harness = await createTestHarness({
        withMergeQueue: true,
        withWorkspaces: true,
      });
      await harness.createTempRepo({
        initialFiles: {
          "src/index.ts": "// Initial",
        },
      });
    });

    afterEach(async () => {
      await harness.cleanup();
    });

    it("should wait for worker A to complete before spawning worker B", async () => {
      const events: string[] = [];

      // Coordinator that waits for worker A then spawns worker B
      const coordinator = await harness.spawnSimulator({
        role: "coordinator",
        streamId: "stream-seq",
        agentId: "coord",
        behavior: {
          onStart: [
            { type: "log", message: "Coordinator started" },
            { type: "wait_for_event", event: "WORKER_A_DONE" },
            { type: "log", message: "Worker A done, spawning B" },
            { type: "wait_for_event", event: "WORKER_B_DONE" },
            { type: "done", status: "completed" },
          ],
        },
      });

      // Worker A - first task
      const wt_a = harness.createWorktreeForAgent(
        "worker-a",
        "feature/task-a",
        { baseBranch: "main" }
      );
      const workerA = await harness.spawnSimulator({
        role: "worker",
        streamId: "stream-seq",
        parentId: coordinator.agentId,
        agentId: "worker-a",
        repoPath: wt_a,
        behavior: {
          onStart: [
            {
              type: "log",
              message: "Worker A starting",
            },
            {
              type: "write_file",
              path: "src/feature-a.ts",
              content: "export const featureA = true;",
            },
            { type: "commit", message: "Add feature A" },
            { type: "done", status: "completed", summary: "Feature A done" },
          ],
        },
      });

      // Run worker A to completion
      await harness.waitForSimulator(workerA.agentId, { maxIterations: 50 });
      harness.assertSimulatorComplete(workerA.agentId);
      events.push("worker_a_complete");

      // Signal coordinator that A is done
      coordinator.injectEvent({
        type: "WORKER_A_DONE",
        payload: { workerId: workerA.agentId },
        timestamp: Date.now(),
      });

      // Step coordinator to process event
      await harness.stepAll();
      await harness.stepAll();
      events.push("coordinator_received_a_done");

      // Now coordinator can spawn worker B
      // Worker B depends on Worker A's output
      const wt_b = harness.createWorktreeForAgent(
        "worker-b",
        "feature/task-b",
        { baseBranch: "feature/task-a" } // Based on A's branch
      );
      const workerB = await harness.spawnSimulator({
        role: "worker",
        streamId: "stream-seq",
        parentId: coordinator.agentId,
        agentId: "worker-b",
        repoPath: wt_b,
        behavior: {
          onStart: [
            { type: "log", message: "Worker B starting" },
            // Worker B can read A's file (if it was based on A's branch)
            {
              type: "write_file",
              path: "src/feature-b.ts",
              content:
                "import { featureA } from './feature-a';\nexport const featureB = true;",
            },
            { type: "commit", message: "Add feature B using A" },
            { type: "done", status: "completed", summary: "Feature B done" },
          ],
        },
      });
      events.push("worker_b_spawned");

      // Run worker B
      await harness.waitForSimulator(workerB.agentId, { maxIterations: 50 });
      harness.assertSimulatorComplete(workerB.agentId);
      events.push("worker_b_complete");

      // Signal coordinator
      coordinator.injectEvent({
        type: "WORKER_B_DONE",
        payload: { workerId: workerB.agentId },
        timestamp: Date.now(),
      });

      await harness.waitForSimulator(coordinator.agentId, { maxIterations: 50 });
      events.push("coordinator_complete");

      // Verify order
      expect(events).toEqual([
        "worker_a_complete",
        "coordinator_received_a_done",
        "worker_b_spawned",
        "worker_b_complete",
        "coordinator_complete",
      ]);

      // Verify worker B has access to A's file (since based on A's branch)
      harness.assertWorktreeFileExists(wt_b, "src/feature-a.ts");
      harness.assertWorktreeFileExists(wt_b, "src/feature-b.ts");
    });

    it("should not spawn B until A's merge request is processed", async () => {
      // Worker A completes and auto-submits merge request
      const wt_a = harness.createWorktreeForAgent(
        "worker-a",
        "feature/prereq",
        { baseBranch: "main" }
      );
      const workerA = await harness.spawnSimulator({
        role: "worker",
        streamId: "stream-seq",
        agentId: "worker-a",
        repoPath: wt_a,
        behavior: createFileWorker(
          "src/prereq.ts",
          "export const prereq = true;"
        ),
      });

      await harness.waitForSimulator(workerA.agentId, { maxIterations: 50 });

      // Worker auto-submitted merge request on completion
      harness.assertMergeQueueDepth("stream-seq", 1);

      // Process A's merge request
      harness.processNextMergeRequest("stream-seq");
      harness.assertMergeQueueDepth("stream-seq", 0);

      // Now B can be spawned (A is merged)
      const wt_b = harness.createWorktreeForAgent(
        "worker-b",
        "feature/dependent",
        { baseBranch: "main" } // Now main includes A's changes
      );
      const workerB = await harness.spawnSimulator({
        role: "worker",
        streamId: "stream-seq",
        agentId: "worker-b",
        repoPath: wt_b,
        behavior: createFileWorker(
          "src/dependent.ts",
          "import { prereq } from './prereq';"
        ),
      });

      await harness.waitForSimulator(workerB.agentId, { maxIterations: 50 });

      // Worker B auto-submitted merge request
      harness.assertMergeQueueDepth("stream-seq", 1);

      harness.processNextMergeRequest("stream-seq");

      // Both should be merged now
      harness.assertMergeQueueDepth("stream-seq", 0);
    });

    it("should handle chain of 3+ sequential workers", async () => {
      const chainOrder: string[] = [];

      // Create a chain: A → B → C
      // Workers auto-submit merge requests when completed
      for (const id of ["a", "b", "c"]) {
        const baseBranch = id === "a" ? "main" : `feature/task-${String.fromCharCode(id.charCodeAt(0) - 1)}`;
        const wt = harness.createWorktreeForAgent(
          `worker-${id}`,
          `feature/task-${id}`,
          { baseBranch }
        );

        const worker = await harness.spawnSimulator({
          role: "worker",
          streamId: "stream-chain",
          agentId: `worker-${id}`,
          repoPath: wt,
          behavior: createFileWorker(
            `src/step-${id}.ts`,
            `export const step${id.toUpperCase()} = true;`
          ),
        });

        await harness.waitForSimulator(worker.agentId, { maxIterations: 50 });
        chainOrder.push(worker.agentId);

        // Worker auto-submitted merge request on completion
        // Process it before spawning next worker
        harness.assertMergeQueueDepth("stream-chain", 1);
        harness.processNextMergeRequest("stream-chain");
        harness.assertMergeQueueDepth("stream-chain", 0);
      }

      // Verify order
      expect(chainOrder).toEqual(["worker-a", "worker-b", "worker-c"]);

      // All merged
      harness.assertMergeQueueDepth("stream-chain", 0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Edge Cases and Error Handling
  // ─────────────────────────────────────────────────────────────────────────────

  describe("Edge Cases", () => {
    let harness: TestHarness;

    beforeEach(async () => {
      harness = await createTestHarness({
        withMergeQueue: true,
        withWorkspaces: true,
      });
      await harness.createTempRepo({
        initialFiles: {
          "README.md": "# Test",
        },
      });
    });

    afterEach(async () => {
      await harness.cleanup();
    });

    it("should handle coordinator termination with pending workers", async () => {
      const coordinator = await harness.spawnSimulator({
        role: "coordinator",
        streamId: "stream-early-term",
        agentId: "coord",
        behavior: {
          onStart: [
            { type: "log", message: "Coordinator starting" },
            { type: "sleep", ms: 10 },
            { type: "done", status: "completed" },
          ],
        },
      });

      // Worker that takes longer
      const wt = harness.createWorktreeForAgent(
        "slow-worker",
        "feature/slow",
        { baseBranch: "main" }
      );
      const worker = await harness.spawnSimulator({
        role: "worker",
        streamId: "stream-early-term",
        parentId: coordinator.agentId,
        agentId: "slow-worker",
        repoPath: wt,
        behavior: {
          onStart: [
            { type: "log", message: "Slow worker" },
            { type: "wait_for_event", event: "NEVER_COMING" },
            { type: "done", status: "completed" },
          ],
        },
      });

      // Step worker to start waiting
      await harness.stepAll();
      await harness.stepAll();

      // Coordinator finishes quickly
      await harness.waitForSimulator(coordinator.agentId, { maxIterations: 50 });
      harness.assertSimulatorComplete(coordinator.agentId);

      // Worker is still running
      expect(worker.isRunning()).toBe(true);

      // Merge queue should be empty (worker hasn't submitted yet)
      harness.assertMergeQueueDepth("stream-early-term", 0);
    });

    it("should handle empty streams correctly", async () => {
      // No workers, just coordinators
      const coordA = await harness.spawnSimulator({
        role: "coordinator",
        streamId: "stream-empty-a",
        agentId: "coord-a",
        behavior: createQuickCoordinator(),
      });

      const coordB = await harness.spawnSimulator({
        role: "coordinator",
        streamId: "stream-empty-b",
        agentId: "coord-b",
        behavior: createQuickCoordinator(),
      });

      await harness.waitForSimulator(coordA.agentId, { maxIterations: 50 });
      await harness.waitForSimulator(coordB.agentId, { maxIterations: 50 });

      // Both streams should have empty queues
      harness.assertMergeQueueDepth("stream-empty-a", 0);
      harness.assertMergeQueueDepth("stream-empty-b", 0);

      // Processing empty queue should return no results
      const processed = harness.processAllMergeRequests("stream-empty-a");
      expect(processed).toHaveLength(0);
    });

    it("should handle rapid sequential spawns", async () => {
      // Quickly spawn and complete multiple workers in sequence
      // Workers auto-submit merge requests when completed
      for (let i = 1; i <= 5; i++) {
        const wt = harness.createWorktreeForAgent(
          `rapid-worker-${i}`,
          `feature/rapid-${i}`,
          { baseBranch: "main" }
        );

        const worker = await harness.spawnSimulator({
          role: "worker",
          streamId: "stream-rapid",
          agentId: `rapid-worker-${i}`,
          repoPath: wt,
          behavior: createFileWorker(`file-${i}.txt`, `Content ${i}`),
        });

        await harness.waitForSimulator(worker.agentId, { maxIterations: 50 });
        // Worker auto-submits merge request on completion
      }

      // All 5 should be queued (auto-submitted by workers)
      harness.assertMergeQueueDepth("stream-rapid", 5);

      // Process all
      const processed = harness.processAllMergeRequests("stream-rapid");
      expect(processed).toHaveLength(5);

      harness.assertMergeQueueDepth("stream-rapid", 0);
    });
  });
});
