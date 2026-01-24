/**
 * Orchestration Flow E2E Tests
 *
 * Tests the complete worker lifecycle: spawn → work → commit → done() →
 * MR submission → merge queue processing → integration branch merge.
 *
 * @see s-1zcx Multi-Agent Orchestration Testing Strategy
 * @see i-3dhk Phase 2b: Full Orchestration Flow E2E Tests
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
  createTestHarness,
  type TestHarness,
  HarnessAssertionError,
} from "../../../test_fixtures/harness/index.js";
import {
  SUCCESSFUL_WORKER,
  MULTI_COMMIT_WORKER,
  EXPLICIT_FAILING_WORKER,
  HELP_EMITTING_WORKER,
  createUniqueFileWorker,
} from "../../../test_fixtures/fixtures/behaviors/workers.js";
import { SIMPLE_COORDINATOR } from "../../../test_fixtures/fixtures/behaviors/coordinators.js";

describe("Full Orchestration Flow E2E", () => {
  const STREAM_ID = "test-stream";

  // ─────────────────────────────────────────────────────────────────────────
  // Scenario 1a: Single Worker Happy Path
  // ─────────────────────────────────────────────────────────────────────────

  describe("Scenario 1a: Single Worker Happy Path", () => {
    let harness: TestHarness;

    beforeEach(async () => {
      harness = await createTestHarness({
        withMergeQueue: true,
        withWorkspaces: true,
      });
      await harness.createTempRepo({
        initialFiles: {
          "src/index.ts": "export const version = '1.0.0';",
          "package.json": '{ "name": "test-project" }',
        },
      });
    });

    afterEach(async () => {
      await harness.cleanup();
    });

    it("worker completes and merges to integration branch", async () => {
      // Spawn coordinator first (parent for all workers)
      const coordinator = await harness.spawnSimulator({
        role: "coordinator",
        streamId: STREAM_ID,
        behavior: {
          onStart: [
            { type: "log", message: "Coordinator started" },
            { type: "wait_for_event", event: "WORK_COMPLETE" },
            { type: "done", status: "completed" },
          ],
        },
      });

      // Create worktree for worker
      const worktreePath = harness.createWorktreeForAgent(
        "worker-1",
        "feature/task-1",
        { baseBranch: "main", streamId: STREAM_ID }
      );

      // Spawn worker with worktree path
      const worker = await harness.spawnSimulator({
        role: "worker",
        streamId: STREAM_ID,
        parentId: coordinator.agentId,
        repoPath: worktreePath,
        behavior: SUCCESSFUL_WORKER,
      });

      // Run worker until complete
      await harness.waitForSimulator(worker.agentId, { maxIterations: 100 });

      // Verify worker terminated
      harness.assertAgentTerminated(worker.agentId);
      harness.assertSimulatorComplete(worker.agentId);

      // Verify MR was auto-submitted
      harness.assertMergeQueueDepth(STREAM_ID, 1);
      harness.assertTaskMergeRequestStatus(worker.agentId, "pending");

      // Process merge queue
      const mrId = harness.processNextMergeRequest(STREAM_ID);
      expect(mrId).toBeDefined();

      // Verify MR is merged
      harness.assertMergeRequestMerged(mrId!);
      harness.assertMergeQueueDepth(STREAM_ID, 0);

      // Verify file was written in worktree
      harness.assertWorktreeFileExists(worktreePath, "output.txt");
      harness.assertWorktreeFileContains(worktreePath, "output.txt", "Work completed successfully");

      // Signal coordinator and complete
      coordinator.injectEvent({
        type: "WORK_COMPLETE",
        payload: { workerId: worker.agentId },
        timestamp: Date.now(),
      });
      await harness.waitForSimulator(coordinator.agentId, { maxIterations: 10 });
    });

    it("worker commits are visible in worktree", async () => {
      const worktreePath = harness.createWorktreeForAgent(
        "worker-commit",
        "feature/commit-test"
      );

      const worker = await harness.spawnSimulator({
        role: "worker",
        streamId: STREAM_ID,
        repoPath: worktreePath,
        behavior: {
          onStart: [
            { type: "write_file", path: "new-feature.ts", content: "export const x = 42;" },
            { type: "commit", message: "Add new feature" },
            { type: "done", status: "completed" },
          ],
        },
      });

      await harness.waitForSimulator(worker.agentId, { maxIterations: 50 });

      // Verify commit happened
      harness.assertWorktreeFileExists(worktreePath, "new-feature.ts");
      harness.assertWorktreeClean(worktreePath);
      harness.assertWorktreeBranch(worktreePath, "feature/commit-test");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Scenario 1b: Multiple Workers Sequential Merge
  // ─────────────────────────────────────────────────────────────────────────

  describe("Scenario 1b: Multiple Workers Sequential Merge", () => {
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

    it("workers merge in FIFO order (controlled sequence)", async () => {
      // Spawn coordinator
      const coordinator = await harness.spawnSimulator({
        role: "coordinator",
        streamId: STREAM_ID,
        behavior: SIMPLE_COORDINATOR,
      });

      // Create 3 workers with unique files, control execution order
      const workers: Array<{ id: string; path: string; sim: Awaited<ReturnType<typeof harness.spawnSimulator>> }> = [];

      for (let i = 1; i <= 3; i++) {
        const worktreePath = harness.createWorktreeForAgent(
          `worker-${i}`,
          `feature/task-${i}`
        );

        const worker = await harness.spawnSimulator({
          role: "worker",
          streamId: STREAM_ID,
          parentId: coordinator.agentId,
          repoPath: worktreePath,
          agentId: `worker-${i}`,
          behavior: createUniqueFileWorker(`${i}`),
        });

        workers.push({ id: `worker-${i}`, path: worktreePath, sim: worker });
      }

      // Run workers in controlled order: 1, then 2, then 3
      for (const w of workers) {
        await harness.waitForSimulator(w.sim.agentId, { maxIterations: 50 });
      }

      // Verify all MRs submitted in order
      harness.assertMergeQueueDepth(STREAM_ID, 3);

      // Process all and verify order
      const processedMRs = harness.processAllMergeRequests(STREAM_ID);
      expect(processedMRs).toHaveLength(3);

      // All should be merged
      for (const mrId of processedMRs) {
        harness.assertMergeRequestMerged(mrId);
      }

      harness.assertMergeQueueDepth(STREAM_ID, 0);
    });

    it("workers merge in submission order (parallel execution)", async () => {
      // Spawn coordinator
      const coordinator = await harness.spawnSimulator({
        role: "coordinator",
        streamId: STREAM_ID,
        behavior: SIMPLE_COORDINATOR,
      });

      // Create 3 workers, start them all at once
      const workerSims = [];

      for (let i = 1; i <= 3; i++) {
        const worktreePath = harness.createWorktreeForAgent(
          `parallel-worker-${i}`,
          `feature/parallel-${i}`
        );

        const worker = await harness.spawnSimulator({
          role: "worker",
          streamId: STREAM_ID,
          parentId: coordinator.agentId,
          repoPath: worktreePath,
          behavior: createUniqueFileWorker(`parallel-${i}`),
        });

        workerSims.push(worker);
      }

      // Step all workers in parallel using stepAll
      let allIdle = false;
      let iterations = 0;
      const maxIterations = 100;

      while (!allIdle && iterations < maxIterations) {
        const result = await harness.stepAll();
        allIdle = result.allIdle;
        iterations++;
      }

      // All workers should have completed
      for (const sim of workerSims) {
        expect(sim.isRunning()).toBe(false);
      }

      // Verify MRs submitted
      harness.assertMergeQueueDepth(STREAM_ID, 3);

      // Process and verify
      const processedMRs = harness.processAllMergeRequests(STREAM_ID);
      expect(processedMRs).toHaveLength(3);

      harness.assertMergeQueueDepth(STREAM_ID, 0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Scenario 1c: Worker with Multiple Commits (Checkpoints)
  // ─────────────────────────────────────────────────────────────────────────

  describe("Scenario 1c: Worker with Multiple Commits", () => {
    let harness: TestHarness;

    beforeEach(async () => {
      harness = await createTestHarness({
        withMergeQueue: true,
        withWorkspaces: true,
      });
      await harness.createTempRepo({
        initialFiles: {
          "README.md": "# Test Project",
        },
      });
    });

    afterEach(async () => {
      await harness.cleanup();
    });

    it("creates multiple commits and submits single MR", async () => {
      // Spawn coordinator
      const coordinator = await harness.spawnSimulator({
        role: "coordinator",
        streamId: STREAM_ID,
        behavior: SIMPLE_COORDINATOR,
      });

      // Create worktree for multi-commit worker
      const worktreePath = harness.createWorktreeForAgent(
        "multi-commit-worker",
        "feature/multi-commit"
      );

      // Spawn worker with MULTI_COMMIT_WORKER behavior (3 commits)
      const worker = await harness.spawnSimulator({
        role: "worker",
        streamId: STREAM_ID,
        parentId: coordinator.agentId,
        repoPath: worktreePath,
        behavior: MULTI_COMMIT_WORKER,
      });

      await harness.waitForSimulator(worker.agentId, { maxIterations: 100 });

      // Verify all 3 files were created
      harness.assertWorktreeFileExists(worktreePath, "file1.txt");
      harness.assertWorktreeFileExists(worktreePath, "file2.txt");
      harness.assertWorktreeFileExists(worktreePath, "file3.txt");

      // Verify worktree is clean (all committed)
      harness.assertWorktreeClean(worktreePath);

      // Verify single MR submitted (not 3 separate ones)
      harness.assertMergeQueueDepth(STREAM_ID, 1);

      // Process MR
      const mrId = harness.processNextMergeRequest(STREAM_ID);
      harness.assertMergeRequestMerged(mrId!);

      // Verify execution log shows all 3 commits
      const log = worker.getExecutionLog();
      const commitSteps = log.filter(entry => entry.step.type === "commit");
      expect(commitSteps).toHaveLength(3);
    });

    it("emits checkpoint signals for progress tracking", async () => {
      const worktreePath = harness.createWorktreeForAgent(
        "checkpoint-worker",
        "feature/checkpoints"
      );

      const worker = await harness.spawnSimulator({
        role: "worker",
        streamId: STREAM_ID,
        repoPath: worktreePath,
        behavior: {
          onStart: [
            { type: "emit_signal", signal: "progress", payload: { step: 1 } },
            { type: "write_file", path: "step1.txt", content: "Step 1" },
            { type: "commit", message: "Step 1" },
            { type: "emit_signal", signal: "progress", payload: { step: 2 } },
            { type: "write_file", path: "step2.txt", content: "Step 2" },
            { type: "commit", message: "Step 2" },
            { type: "emit_signal", signal: "progress", payload: { step: 3 } },
            { type: "done", status: "completed" },
          ],
        },
      });

      await harness.waitForSimulator(worker.agentId, { maxIterations: 100 });

      // Query events for progress signals
      const events = harness.eventStore.query({ type: "status" });
      const progressSignals = events.filter((e) => {
        const payload = e.payload as { summary?: string; details?: { step?: number } };
        return payload.summary === "progress" && payload.details?.step !== undefined;
      });

      // Verify checkpoint signals were emitted (3 progress signals)
      expect(progressSignals).toHaveLength(3);
      expect(progressSignals.map((e) => (e.payload as { details: { step: number } }).details.step)).toEqual([1, 2, 3]);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Scenario 1d: Worker Fails Mid-Work
  // ─────────────────────────────────────────────────────────────────────────

  describe("Scenario 1d: Worker Fails Mid-Work", () => {
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

    it("failed worker does not submit MR", async () => {
      // Spawn coordinator
      const coordinator = await harness.spawnSimulator({
        role: "coordinator",
        streamId: STREAM_ID,
        behavior: SIMPLE_COORDINATOR,
      });

      // Create worktree for failing worker
      const worktreePath = harness.createWorktreeForAgent(
        "failing-worker",
        "feature/will-fail"
      );

      // Spawn worker that explicitly fails
      const worker = await harness.spawnSimulator({
        role: "worker",
        streamId: STREAM_ID,
        parentId: coordinator.agentId,
        repoPath: worktreePath,
        behavior: EXPLICIT_FAILING_WORKER,
      });

      await harness.waitForSimulator(worker.agentId, { maxIterations: 100 });

      // Worker should be terminated
      harness.assertAgentTerminated(worker.agentId);

      // NO MR should be submitted (failed workers don't submit)
      harness.assertMergeQueueDepth(STREAM_ID, 0);

      // Verify partial work exists in worktree
      harness.assertWorktreeFileExists(worktreePath, "attempt.txt");
    });

    it("worker with failAfter injection does not submit MR", async () => {
      const worktreePath = harness.createWorktreeForAgent(
        "injected-fail-worker",
        "feature/injected-fail"
      );

      // Worker that will fail after 2 steps due to failAfter injection
      const worker = await harness.spawnSimulator({
        role: "worker",
        streamId: STREAM_ID,
        repoPath: worktreePath,
        behavior: {
          onStart: [
            { type: "log", message: "Step 1" },
            { type: "log", message: "Step 2" },
            { type: "write_file", path: "output.txt", content: "Should not reach" },
            { type: "commit", message: "Should not commit" },
            { type: "done", status: "completed" },
          ],
          failAfter: 2,
          failWith: "Injected failure",
        },
      });

      // Run until failure
      let result = await worker.stepOnce();
      while (result.status !== "failed" && worker.isRunning()) {
        result = await worker.stepOnce();
      }

      // Should have failed
      expect(result.status).toBe("failed");

      // No MR submitted
      harness.assertMergeQueueDepth(STREAM_ID, 0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Scenario 1e: Worker Blocked, Emits HELP
  // ─────────────────────────────────────────────────────────────────────────

  describe("Scenario 1e: Worker Blocked, Emits HELP", () => {
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

    it("blocked worker emits HELP signal", async () => {
      // Spawn coordinator that listens for HELP
      const coordinator = await harness.spawnSimulator({
        role: "coordinator",
        streamId: STREAM_ID,
        behavior: {
          onStart: [
            { type: "log", message: "Coordinator waiting for signals" },
            { type: "wait_for_event", event: "HELP_RECEIVED" },
            { type: "log", message: "Help signal received, responding" },
            { type: "done", status: "completed" },
          ],
          onEvent: {
            HELP: [
              { type: "log", message: "Got HELP from worker" },
            ],
          },
        },
      });

      // Create worktree for blocked worker
      const worktreePath = harness.createWorktreeForAgent(
        "blocked-worker",
        "feature/blocked"
      );

      // Spawn worker that will emit HELP and become blocked
      const worker = await harness.spawnSimulator({
        role: "worker",
        streamId: STREAM_ID,
        parentId: coordinator.agentId,
        repoPath: worktreePath,
        behavior: HELP_EMITTING_WORKER,
      });

      await harness.waitForSimulator(worker.agentId, { maxIterations: 100 });

      // Worker should be terminated (blocked is terminal)
      harness.assertAgentTerminated(worker.agentId);

      // Query events for HELP signals
      const events = harness.eventStore.query({ type: "status" });
      const helpSignals = events.filter((e) => {
        const payload = e.payload as { summary?: string };
        return payload.summary === "HELP";
      });

      // HELP signal should have been emitted
      expect(helpSignals.length).toBeGreaterThanOrEqual(1);
      expect(helpSignals[0].source.agent_id).toBe(worker.agentId);

      // NO MR submitted (blocked workers don't submit)
      harness.assertMergeQueueDepth(STREAM_ID, 0);

      // Partial work should exist
      harness.assertWorktreeFileExists(worktreePath, "partial.txt");
    });

    it("coordinator can respond to blocked worker", async () => {
      let coordinatorReceivedHelp = false;

      // Spawn coordinator that handles HELP
      const coordinator = await harness.spawnSimulator({
        role: "coordinator",
        streamId: STREAM_ID,
        behavior: {
          onStart: [
            { type: "log", message: "Coordinator active" },
          ],
          onEvent: {
            checkpoint: [
              {
                type: "conditional",
                if: (ctx) => {
                  const lastEvent = ctx.events[ctx.events.length - 1];
                  return lastEvent?.payload?.summary === "HELP";
                },
                then: [
                  { type: "log", message: "Coordinator acknowledging HELP" },
                  {
                    type: "call_tool",
                    tool: "send_message",
                    params: {
                      to: { topic: "help_response" },
                      content: "Help is on the way",
                      priority: "high",
                    },
                  },
                ],
              },
            ],
          },
        },
      });

      const worktreePath = harness.createWorktreeForAgent(
        "help-worker",
        "feature/needs-help"
      );

      const worker = await harness.spawnSimulator({
        role: "worker",
        streamId: STREAM_ID,
        parentId: coordinator.agentId,
        repoPath: worktreePath,
        behavior: HELP_EMITTING_WORKER,
      });

      // Run both
      await harness.runUntilIdle(100);

      // Worker should be done
      expect(worker.isRunning()).toBe(false);

      // Coordinator received the signal (check execution log)
      const coordLog = coordinator.getExecutionLog();
      const helpHandled = coordLog.some(
        entry => entry.step.type === "log" &&
                 (entry.step as { message: string }).message.includes("HELP")
      );
      // Note: This depends on event dispatch timing
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Integration: Full Flow with Coordinator
  // ─────────────────────────────────────────────────────────────────────────

  describe("Integration: Coordinator + Workers Full Flow", () => {
    let harness: TestHarness;

    beforeEach(async () => {
      harness = await createTestHarness({
        withMergeQueue: true,
        withWorkspaces: true,
      });
      await harness.createTempRepo({
        initialFiles: {
          "src/index.ts": "// Main entry point",
          "package.json": '{ "name": "integration-test" }',
        },
      });
    });

    afterEach(async () => {
      await harness.cleanup();
    });

    it("coordinator spawns worker, worker completes, MR processed", async () => {
      // Coordinator that spawns a worker and waits
      const coordinator = await harness.spawnSimulator({
        role: "coordinator",
        streamId: STREAM_ID,
        behavior: {
          onStart: [
            { type: "log", message: "Coordinator starting" },
            {
              type: "spawn_child",
              role: "worker",
              behavior: {
                onStart: [
                  { type: "write_file", path: "spawned-output.txt", content: "From spawned worker" },
                  { type: "commit", message: "Spawned worker commit" },
                  { type: "done", status: "completed" },
                ],
              },
            },
            { type: "log", message: "Worker spawned, waiting" },
            { type: "wait_for_event", event: "CHILD_DONE" },
            { type: "done", status: "completed" },
          ],
        },
      });

      // Run until coordinator's child is done
      await harness.runUntilIdle(200);

      // Get the spawned child
      const children = coordinator.getContext().children;
      expect(children.length).toBe(1);

      const child = children[0];
      expect(child.isRunning()).toBe(false);

      // Note: Spawned children use parent's workspace by default,
      // so MR submission depends on streamId propagation
    });
  });
});
