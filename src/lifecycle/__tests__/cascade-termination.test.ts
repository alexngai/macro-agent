/**
 * Cascade Termination Integration Tests
 *
 * Tests hierarchical agent termination with change consolidation
 * using the TestHarness and AgentSimulator infrastructure.
 *
 * @see s-1zcx Multi-Agent Orchestration Testing Strategy
 * @see i-60v8 Phase 2d: Cascade Termination E2E Tests
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
  createTestHarness,
  type TestHarness,
} from "../../../test_fixtures/harness/test-harness.js";
import {
  createUniqueFileWorker,
} from "../../../test_fixtures/fixtures/behaviors/workers.js";
import type { SimulatedBehavior } from "../../../test_fixtures/harness/simulator/types.js";
import {
  cascadeTerminateChildren,
  getAllDescendants,
  needsCascadeTermination,
  type CascadeAgentManager,
  type CascadeAgent,
} from "../cascade.js";

// ─────────────────────────────────────────────────────────────────────────────
// Test Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create an adapter from TestHarness to CascadeAgentManager
 */
function createCascadeAdapter(harness: TestHarness): CascadeAgentManager {
  return {
    getChildren(agentId: string): CascadeAgent[] {
      const allSimulators = harness.getAllSimulators();
      return allSimulators
        .filter((sim) => {
          // Skip stopped simulators (their context is null)
          if (!sim.isRunning()) {
            // Check EventStore for parent relationship
            const agent = harness.eventStore.getAgent(sim.agentId);
            return agent?.parent === agentId;
          }
          try {
            return sim.getContext().parentId === agentId;
          } catch {
            return false;
          }
        })
        .map((sim) => ({
          id: sim.agentId,
          state: sim.isRunning() ? "running" : "stopped",
          parent: (() => {
            if (!sim.isRunning()) {
              const agent = harness.eventStore.getAgent(sim.agentId);
              return agent?.parent ?? undefined;
            }
            try {
              return sim.getContext().parentId;
            } catch {
              return undefined;
            }
          })(),
        }));
    },
    async terminate(agentId: string, reason: string): Promise<void> {
      const simulator = harness.getSimulator(agentId);
      if (simulator && simulator.isRunning()) {
        await simulator.stop();
      }
      // Update agent state in EventStore
      harness.eventStore.emit({
        type: "stop",
        source: { agent_id: agentId },
        payload: { agent_id: agentId, reason },
      });
    },
  };
}

/**
 * Create a worker that does work but doesn't call done() immediately
 * (for testing cascade during active work)
 */
function createActiveWorker(
  filename: string,
  content: string
): SimulatedBehavior {
  return {
    onStart: [
      { type: "log", message: "Starting active work" },
      { type: "write_file", path: filename, content },
      // Don't commit yet - simulates uncommitted work
      { type: "wait_for_event", event: "CONTINUE_WORK" },
      { type: "commit", message: `Add ${filename}` },
      { type: "done", status: "completed" },
    ],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 3a: Coordinator + 2 Workers Cascade
// ─────────────────────────────────────────────────────────────────────────────

describe("Cascade Termination Integration", () => {
  const STREAM_ID = "cascade-test-stream";

  describe("Scenario 3a: Coordinator + 2 Workers Cascade", () => {
    let harness: TestHarness;

    beforeEach(async () => {
      harness = await createTestHarness({
        withMergeQueue: true,
        withWorkspaces: true,
      });
      await harness.createTempRepo({
        initialFiles: {
          "src/index.ts": "export const version = '1.0.0';",
          "package.json": '{ "name": "cascade-test" }',
        },
      });
    });

    afterEach(async () => {
      await harness.cleanup();
    });

    it("should cascade terminate children when coordinator terminates", async () => {
      // Spawn coordinator
      const coordinator = await harness.spawnSimulator({
        role: "coordinator",
        streamId: STREAM_ID,
        behavior: {
          onStart: [
            { type: "log", message: "Coordinator started" },
            { type: "wait_for_event", event: "ALL_WORK_DONE" },
            { type: "done", status: "completed", summary: "Coordinated work" },
          ],
        },
      });

      // Create worktrees for workers
      const worktree1 = harness.createWorktreeForAgent(
        "worker-1",
        "feature/task-1",
        { baseBranch: "main", streamId: STREAM_ID }
      );
      const worktree2 = harness.createWorktreeForAgent(
        "worker-2",
        "feature/task-2",
        { baseBranch: "main", streamId: STREAM_ID }
      );

      // Spawn workers as children of coordinator
      const worker1 = await harness.spawnSimulator({
        role: "worker",
        streamId: STREAM_ID,
        parentId: coordinator.agentId,
        repoPath: worktree1,
        behavior: createUniqueFileWorker("worker1-output.txt", "Worker 1 output"),
      });

      const worker2 = await harness.spawnSimulator({
        role: "worker",
        streamId: STREAM_ID,
        parentId: coordinator.agentId,
        repoPath: worktree2,
        behavior: createUniqueFileWorker("worker2-output.txt", "Worker 2 output"),
      });

      // Run workers until they complete
      await harness.waitForSimulator(worker1.agentId, { maxIterations: 50 });
      await harness.waitForSimulator(worker2.agentId, { maxIterations: 50 });

      // Verify workers completed
      harness.assertSimulatorComplete(worker1.agentId);
      harness.assertSimulatorComplete(worker2.agentId);

      // Create cascade adapter
      const cascadeAdapter = createCascadeAdapter(harness);

      // Verify cascade is needed (workers should be stopped but let's check)
      const descendants = getAllDescendants(coordinator.agentId, cascadeAdapter);
      expect(descendants.length).toBe(2);

      // Signal coordinator and wait for it to complete
      coordinator.injectEvent({
        type: "ALL_WORK_DONE",
        payload: {},
        timestamp: Date.now(),
      });
      await harness.waitForSimulator(coordinator.agentId, { maxIterations: 50 });

      // Verify all terminated
      harness.assertSimulatorComplete(coordinator.agentId);
      harness.assertAgentTerminated(worker1.agentId);
      harness.assertAgentTerminated(worker2.agentId);

      // Verify merge requests were submitted
      harness.assertMergeQueueDepth(STREAM_ID, 2);
    });

    it("should cascade terminate running children when parent stops", async () => {
      // Spawn coordinator
      const coordinator = await harness.spawnSimulator({
        role: "coordinator",
        streamId: STREAM_ID,
        behavior: {
          onStart: [
            { type: "log", message: "Coordinator started" },
            { type: "sleep", ms: 10 },
            { type: "done", status: "completed", summary: "Quick exit" },
          ],
        },
      });

      // Create worktree for worker
      const worktree = harness.createWorktreeForAgent(
        "slow-worker",
        "feature/slow-task",
        { baseBranch: "main", streamId: STREAM_ID }
      );

      // Spawn a slow worker
      const slowWorker = await harness.spawnSimulator({
        role: "worker",
        streamId: STREAM_ID,
        parentId: coordinator.agentId,
        repoPath: worktree,
        behavior: {
          onStart: [
            { type: "log", message: "Starting slow work" },
            { type: "wait_for_event", event: "NEVER_COMING" },
            { type: "done", status: "completed" },
          ],
        },
      });

      // Run coordinator until complete (it will finish before worker)
      await harness.waitForSimulator(coordinator.agentId, { maxIterations: 50 });
      harness.assertSimulatorComplete(coordinator.agentId);

      // Worker should still be running (waiting for event)
      expect(slowWorker.isRunning()).toBe(true);

      // Trigger cascade termination
      const cascadeAdapter = createCascadeAdapter(harness);
      const result = await cascadeTerminateChildren(
        coordinator.agentId,
        cascadeAdapter,
        { reason: "parent_completed" }
      );

      // Verify cascade result
      expect(result.childrenTerminated).toBe(1);
      expect(result.terminatedIds).toContain(slowWorker.agentId);
      expect(result.errors).toBeUndefined();

      // Verify worker is terminated
      expect(slowWorker.isRunning()).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Scenario 3b: Deep Hierarchy (3+ Levels)
  // ─────────────────────────────────────────────────────────────────────────────

  describe("Scenario 3b: Deep Hierarchy (3+ Levels)", () => {
    let harness: TestHarness;

    beforeEach(async () => {
      harness = await createTestHarness({
        withMergeQueue: true,
        withWorkspaces: true,
      });
      await harness.createTempRepo({
        initialFiles: {
          "README.md": "# Deep Hierarchy Test",
        },
      });
    });

    afterEach(async () => {
      await harness.cleanup();
    });

    it("should terminate in depth-first order (grandchildren before children)", async () => {
      const terminationOrder: string[] = [];

      // Level 0: Coordinator
      const coordinator = await harness.spawnSimulator({
        role: "coordinator",
        streamId: STREAM_ID,
        agentId: "coord-level-0",
        behavior: {
          onStart: [
            { type: "log", message: "Level 0 coordinator" },
            { type: "wait_for_event", event: "STOP" },
            { type: "done", status: "completed" },
          ],
        },
      });

      // Level 1: Worker (child of coordinator)
      const worktree1 = harness.createWorktreeForAgent(
        "worker-level-1",
        "feature/level-1",
        { baseBranch: "main" }
      );
      const worker1 = await harness.spawnSimulator({
        role: "worker",
        streamId: STREAM_ID,
        parentId: coordinator.agentId,
        agentId: "worker-level-1",
        repoPath: worktree1,
        behavior: {
          onStart: [
            { type: "log", message: "Level 1 worker" },
            { type: "wait_for_event", event: "STOP" },
            { type: "done", status: "completed" },
          ],
        },
      });

      // Level 2: Sub-worker (child of worker1)
      const worktree2 = harness.createWorktreeForAgent(
        "worker-level-2",
        "feature/level-2",
        { baseBranch: "main" }
      );
      const worker2 = await harness.spawnSimulator({
        role: "worker",
        streamId: STREAM_ID,
        parentId: worker1.agentId,
        agentId: "worker-level-2",
        repoPath: worktree2,
        behavior: {
          onStart: [
            { type: "log", message: "Level 2 worker" },
            { type: "wait_for_event", event: "STOP" },
            { type: "done", status: "completed" },
          ],
        },
      });

      // Level 3: Sub-sub-worker (child of worker2)
      const worktree3 = harness.createWorktreeForAgent(
        "worker-level-3",
        "feature/level-3",
        { baseBranch: "main" }
      );
      const worker3 = await harness.spawnSimulator({
        role: "worker",
        streamId: STREAM_ID,
        parentId: worker2.agentId,
        agentId: "worker-level-3",
        repoPath: worktree3,
        behavior: {
          onStart: [
            { type: "log", message: "Level 3 worker" },
            { type: "wait_for_event", event: "STOP" },
            { type: "done", status: "completed" },
          ],
        },
      });

      // Step all to start
      await harness.stepAll();
      await harness.stepAll();

      // Verify all running
      expect(coordinator.isRunning()).toBe(true);
      expect(worker1.isRunning()).toBe(true);
      expect(worker2.isRunning()).toBe(true);
      expect(worker3.isRunning()).toBe(true);

      // Create cascade adapter that tracks termination order
      const cascadeAdapter: CascadeAgentManager = {
        getChildren(agentId: string): CascadeAgent[] {
          const allSimulators = harness.getAllSimulators();
          return allSimulators
            .filter((sim) => sim.getContext().parentId === agentId)
            .map((sim) => ({
              id: sim.agentId,
              state: sim.isRunning() ? "running" : "stopped",
              parent: sim.getContext().parentId,
            }));
        },
        async terminate(agentId: string, reason: string): Promise<void> {
          terminationOrder.push(agentId);
          const simulator = harness.getSimulator(agentId);
          if (simulator && simulator.isRunning()) {
            await simulator.stop();
          }
        },
      };

      // Trigger cascade from coordinator
      const result = await cascadeTerminateChildren(
        coordinator.agentId,
        cascadeAdapter,
        { reason: "parent_stopped" }
      );

      // Verify depth-first order: level 3 → level 2 → level 1
      expect(terminationOrder).toEqual([
        "worker-level-3",
        "worker-level-2",
        "worker-level-1",
      ]);

      expect(result.childrenTerminated).toBe(3);
      expect(result.errors).toBeUndefined();

      // Verify all stopped
      expect(worker1.isRunning()).toBe(false);
      expect(worker2.isRunning()).toBe(false);
      expect(worker3.isRunning()).toBe(false);
    });

    it("should handle wide hierarchies (multiple children at each level)", async () => {
      // Coordinator with 3 children, each with 2 grandchildren
      const coordinator = await harness.spawnSimulator({
        role: "coordinator",
        streamId: STREAM_ID,
        agentId: "coord",
        behavior: {
          onStart: [
            { type: "log", message: "Coordinator" },
            { type: "wait_for_event", event: "STOP" },
          ],
        },
      });

      const children: string[] = [];
      const grandchildren: string[] = [];

      // Create 3 children
      for (let i = 1; i <= 3; i++) {
        const childId = `worker-${i}`;
        const worktree = harness.createWorktreeForAgent(
          childId,
          `feature/worker-${i}`,
          { baseBranch: "main" }
        );
        await harness.spawnSimulator({
          role: "worker",
          streamId: STREAM_ID,
          parentId: coordinator.agentId,
          agentId: childId,
          repoPath: worktree,
          behavior: {
            onStart: [
              { type: "log", message: `Worker ${i}` },
              { type: "wait_for_event", event: "STOP" },
            ],
          },
        });
        children.push(childId);

        // Create 2 grandchildren per child
        for (let j = 1; j <= 2; j++) {
          const grandchildId = `worker-${i}-sub-${j}`;
          const gcWorktree = harness.createWorktreeForAgent(
            grandchildId,
            `feature/worker-${i}-sub-${j}`,
            { baseBranch: "main" }
          );
          await harness.spawnSimulator({
            role: "worker",
            streamId: STREAM_ID,
            parentId: childId,
            agentId: grandchildId,
            repoPath: gcWorktree,
            behavior: {
              onStart: [
                { type: "log", message: `Worker ${i} Sub ${j}` },
                { type: "wait_for_event", event: "STOP" },
              ],
            },
          });
          grandchildren.push(grandchildId);
        }
      }

      await harness.stepAll();

      // Verify all created: 1 coord + 3 children + 6 grandchildren = 10
      expect(harness.getSimulatorCount()).toBe(10);

      // Get all descendants
      const cascadeAdapter = createCascadeAdapter(harness);
      const descendants = getAllDescendants(coordinator.agentId, cascadeAdapter);
      expect(descendants.length).toBe(9); // 3 children + 6 grandchildren

      // Trigger cascade
      const result = await cascadeTerminateChildren(
        coordinator.agentId,
        cascadeAdapter,
        { reason: "parent_stopped" }
      );

      expect(result.childrenTerminated).toBe(9);
      expect(result.errors).toBeUndefined();

      // Verify all descendants terminated
      for (const child of children) {
        expect(harness.getSimulator(child)?.isRunning()).toBe(false);
      }
      for (const grandchild of grandchildren) {
        expect(harness.getSimulator(grandchild)?.isRunning()).toBe(false);
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Scenario 3c: Cascade During Active Work
  // ─────────────────────────────────────────────────────────────────────────────

  describe("Scenario 3c: Cascade During Active Work", () => {
    let harness: TestHarness;

    beforeEach(async () => {
      harness = await createTestHarness({
        withMergeQueue: true,
        withWorkspaces: true,
      });
      await harness.createTempRepo({
        initialFiles: {
          "src/index.ts": "// Active work test",
        },
      });
    });

    afterEach(async () => {
      await harness.cleanup();
    });

    it("should handle workers with uncommitted changes", async () => {
      // Coordinator
      const coordinator = await harness.spawnSimulator({
        role: "coordinator",
        streamId: STREAM_ID,
        behavior: {
          onStart: [
            { type: "log", message: "Coordinator" },
            { type: "sleep", ms: 10 },
            { type: "done", status: "completed" },
          ],
        },
      });

      // Worker that writes but doesn't commit
      const worktree = harness.createWorktreeForAgent(
        "uncommitted-worker",
        "feature/uncommitted",
        { baseBranch: "main" }
      );
      const worker = await harness.spawnSimulator({
        role: "worker",
        streamId: STREAM_ID,
        parentId: coordinator.agentId,
        repoPath: worktree,
        behavior: createActiveWorker("uncommitted.txt", "Uncommitted content"),
      });

      // Step worker to write file but not commit
      await harness.stepAll(); // log
      await harness.stepAll(); // write_file

      // Verify file exists but is uncommitted
      harness.assertWorktreeFileExists(worktree, "uncommitted.txt");

      // Get git state - should have uncommitted changes
      const gitState = worker.getGitState();
      expect(gitState.uncommittedFiles.length).toBeGreaterThan(0);

      // Run coordinator to completion
      await harness.waitForSimulator(coordinator.agentId, { maxIterations: 50 });

      // Cascade terminate
      const cascadeAdapter = createCascadeAdapter(harness);
      const result = await cascadeTerminateChildren(
        coordinator.agentId,
        cascadeAdapter,
        { reason: "parent_completed" }
      );

      // Worker should be terminated even with uncommitted changes
      expect(result.childrenTerminated).toBe(1);
      expect(worker.isRunning()).toBe(false);

      // File should still exist in worktree (even if uncommitted)
      harness.assertWorktreeFileExists(worktree, "uncommitted.txt");
    });

    it("should preserve work in progress during cascade", async () => {
      const coordinator = await harness.spawnSimulator({
        role: "coordinator",
        streamId: STREAM_ID,
        behavior: {
          onStart: [
            { type: "log", message: "Quick coordinator" },
            { type: "done", status: "completed" },
          ],
        },
      });

      // Worker that creates multiple files
      const worktree = harness.createWorktreeForAgent(
        "multi-file-worker",
        "feature/multi-file",
        { baseBranch: "main" }
      );
      const worker = await harness.spawnSimulator({
        role: "worker",
        streamId: STREAM_ID,
        parentId: coordinator.agentId,
        repoPath: worktree,
        behavior: {
          onStart: [
            { type: "write_file", path: "file1.txt", content: "Content 1" },
            { type: "commit", message: "Add file1" },
            { type: "write_file", path: "file2.txt", content: "Content 2" },
            { type: "commit", message: "Add file2" },
            { type: "write_file", path: "file3.txt", content: "Content 3" },
            // No commit for file3
            { type: "wait_for_event", event: "CONTINUE" },
            { type: "commit", message: "Add file3" },
            { type: "done", status: "completed" },
          ],
        },
      });

      // Step worker to create 2 committed files and 1 uncommitted
      for (let i = 0; i < 5; i++) {
        await harness.stepAll();
      }

      // Verify files 1 and 2 committed, file 3 exists but uncommitted
      const gitState = worker.getGitState();
      expect(gitState.uncommittedFiles).toContain("file3.txt");

      // Coordinator finishes immediately
      await harness.waitForSimulator(coordinator.agentId, { maxIterations: 10 });

      // Cascade
      const cascadeAdapter = createCascadeAdapter(harness);
      await cascadeTerminateChildren(
        coordinator.agentId,
        cascadeAdapter,
        { reason: "parent_completed" }
      );

      // All files should still exist
      harness.assertWorktreeFileExists(worktree, "file1.txt");
      harness.assertWorktreeFileExists(worktree, "file2.txt");
      harness.assertWorktreeFileExists(worktree, "file3.txt");

      // Committed work should be preserved (2 commits + initial)
      harness.assertCommitCount("feature/multi-file", 3);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Scenario 3d: Partial Cascade
  // ─────────────────────────────────────────────────────────────────────────────

  describe("Scenario 3d: Partial Cascade", () => {
    let harness: TestHarness;

    beforeEach(async () => {
      harness = await createTestHarness({
        withMergeQueue: true,
        withWorkspaces: true,
      });
      await harness.createTempRepo({
        initialFiles: {
          "README.md": "# Partial Cascade Test",
        },
      });
    });

    afterEach(async () => {
      await harness.cleanup();
    });

    it("should skip already-stopped workers during cascade", async () => {
      const coordinator = await harness.spawnSimulator({
        role: "coordinator",
        streamId: STREAM_ID,
        behavior: {
          onStart: [
            { type: "log", message: "Coordinator" },
            { type: "wait_for_event", event: "STOP" },
            { type: "done", status: "completed" },
          ],
        },
      });

      // Fast worker - completes quickly
      const fastWorktree = harness.createWorktreeForAgent(
        "fast-worker",
        "feature/fast",
        { baseBranch: "main" }
      );
      const fastWorker = await harness.spawnSimulator({
        role: "worker",
        streamId: STREAM_ID,
        parentId: coordinator.agentId,
        repoPath: fastWorktree,
        behavior: {
          onStart: [
            { type: "log", message: "Fast worker" },
            { type: "write_file", path: "fast.txt", content: "Fast" },
            { type: "commit", message: "Fast commit" },
            { type: "done", status: "completed", summary: "Done fast" },
          ],
        },
      });

      // Slow worker - waits for event
      const slowWorktree = harness.createWorktreeForAgent(
        "slow-worker",
        "feature/slow",
        { baseBranch: "main" }
      );
      const slowWorker = await harness.spawnSimulator({
        role: "worker",
        streamId: STREAM_ID,
        parentId: coordinator.agentId,
        repoPath: slowWorktree,
        behavior: {
          onStart: [
            { type: "log", message: "Slow worker" },
            { type: "wait_for_event", event: "NEVER_COMING" },
            { type: "done", status: "completed" },
          ],
        },
      });

      // Run fast worker to completion
      await harness.waitForSimulator(fastWorker.agentId, { maxIterations: 50 });
      harness.assertSimulatorComplete(fastWorker.agentId);

      // Step slow worker to start (it will be waiting)
      await harness.stepAll();
      await harness.stepAll();

      // Verify fast is done, slow is running
      expect(fastWorker.isRunning()).toBe(false);
      expect(slowWorker.isRunning()).toBe(true);

      // Cascade - should only terminate slow worker
      const cascadeAdapter = createCascadeAdapter(harness);
      const result = await cascadeTerminateChildren(
        coordinator.agentId,
        cascadeAdapter,
        { reason: "parent_stopped" }
      );

      // Only slow worker should be terminated (fast was already stopped)
      expect(result.childrenTerminated).toBe(1);
      expect(result.terminatedIds).toContain(slowWorker.agentId);
      expect(result.terminatedIds).not.toContain(fastWorker.agentId);
    });

    it("should handle mixed states in hierarchy", async () => {
      const coordinator = await harness.spawnSimulator({
        role: "coordinator",
        streamId: STREAM_ID,
        agentId: "coord",
        behavior: {
          onStart: [
            { type: "log", message: "Coordinator" },
            { type: "wait_for_event", event: "STOP" },
          ],
        },
      });

      // Worker 1: Completed
      const w1 = harness.createWorktreeForAgent("w1", "feature/w1", { baseBranch: "main" });
      const worker1 = await harness.spawnSimulator({
        role: "worker",
        streamId: STREAM_ID,
        parentId: coordinator.agentId,
        agentId: "worker-1",
        repoPath: w1,
        behavior: {
          onStart: [
            { type: "log", message: "Worker 1" },
            { type: "done", status: "completed" },
          ],
        },
      });

      // Worker 2: Running (waiting)
      const w2 = harness.createWorktreeForAgent("w2", "feature/w2", { baseBranch: "main" });
      const worker2 = await harness.spawnSimulator({
        role: "worker",
        streamId: STREAM_ID,
        parentId: coordinator.agentId,
        agentId: "worker-2",
        repoPath: w2,
        behavior: {
          onStart: [
            { type: "log", message: "Worker 2" },
            { type: "wait_for_event", event: "NEVER" },
          ],
        },
      });

      // Worker 3: Completed
      const w3 = harness.createWorktreeForAgent("w3", "feature/w3", { baseBranch: "main" });
      const worker3 = await harness.spawnSimulator({
        role: "worker",
        streamId: STREAM_ID,
        parentId: coordinator.agentId,
        agentId: "worker-3",
        repoPath: w3,
        behavior: {
          onStart: [
            { type: "log", message: "Worker 3" },
            { type: "done", status: "completed" },
          ],
        },
      });

      // Run workers 1 and 3 to completion
      await harness.waitForSimulator(worker1.agentId, { maxIterations: 20 });
      await harness.waitForSimulator(worker3.agentId, { maxIterations: 20 });

      // Step worker 2 to start waiting
      await harness.stepAll();
      await harness.stepAll();

      // Verify states
      expect(worker1.isRunning()).toBe(false); // Completed
      expect(worker2.isRunning()).toBe(true);  // Running
      expect(worker3.isRunning()).toBe(false); // Completed

      // Check if cascade needed
      const cascadeAdapter = createCascadeAdapter(harness);
      expect(needsCascadeTermination(coordinator.agentId, cascadeAdapter)).toBe(true);

      // Cascade
      const result = await cascadeTerminateChildren(
        coordinator.agentId,
        cascadeAdapter,
        { reason: "parent_stopped" }
      );

      // Only worker 2 (the running one) should be terminated
      expect(result.childrenTerminated).toBe(1);
      expect(result.terminatedIds).toEqual(["worker-2"]);

      // All should now be stopped
      expect(worker2.isRunning()).toBe(false);
    });

    it("should report no cascade needed when all children completed", async () => {
      const coordinator = await harness.spawnSimulator({
        role: "coordinator",
        streamId: STREAM_ID,
        behavior: {
          onStart: [
            { type: "log", message: "Coordinator" },
            { type: "wait_for_event", event: "STOP" },
          ],
        },
      });

      // Two workers that complete immediately
      const w1 = harness.createWorktreeForAgent("w1", "feature/w1", { baseBranch: "main" });
      const worker1 = await harness.spawnSimulator({
        role: "worker",
        streamId: STREAM_ID,
        parentId: coordinator.agentId,
        repoPath: w1,
        behavior: {
          onStart: [{ type: "done", status: "completed" }],
        },
      });

      const w2 = harness.createWorktreeForAgent("w2", "feature/w2", { baseBranch: "main" });
      const worker2 = await harness.spawnSimulator({
        role: "worker",
        streamId: STREAM_ID,
        parentId: coordinator.agentId,
        repoPath: w2,
        behavior: {
          onStart: [{ type: "done", status: "completed" }],
        },
      });

      // Run all to completion
      await harness.waitForSimulator(worker1.agentId, { maxIterations: 10 });
      await harness.waitForSimulator(worker2.agentId, { maxIterations: 10 });

      // Check cascade needed
      const cascadeAdapter = createCascadeAdapter(harness);
      expect(needsCascadeTermination(coordinator.agentId, cascadeAdapter)).toBe(false);

      // Cascade should be a no-op
      const result = await cascadeTerminateChildren(
        coordinator.agentId,
        cascadeAdapter,
        { reason: "parent_stopped" }
      );

      expect(result.childrenTerminated).toBe(0);
      expect(result.terminatedIds).toEqual([]);
    });
  });
});
