/**
 * TestHarness and Assertions Tests
 *
 * Tests for the main test harness orchestration and built-in assertions.
 *
 * @see s-1zcx Multi-Agent Orchestration Testing Strategy
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
  createTestHarness,
  type TestHarness,
  HarnessAssertionError,
} from "../index.js";

describe("TestHarness and Assertions", () => {
  // ─────────────────────────────────────────────────────────────────────────
  // TestHarness Basic Tests
  // ─────────────────────────────────────────────────────────────────────────

  describe("TestHarness", () => {
    let harness: TestHarness;

    beforeEach(async () => {
      harness = await createTestHarness();
    });

    afterEach(async () => {
      await harness.cleanup();
    });

    it("should create harness with all services", () => {
      expect(harness.eventStore).toBeDefined();
      expect(harness.messageRouter).toBeDefined();
      expect(harness.taskManager).toBeDefined();
      expect(harness.services).toBeDefined();
    });

    it("should create and manage temp repos", async () => {
      const repo1 = await harness.createTempRepo();
      expect(repo1.path).toBeDefined();
      expect(harness.getRepo()).toBe(repo1);

      const repo2 = await harness.createTempRepo({
        initialFiles: { "test.txt": "content" },
      });
      expect(repo2.path).toBeDefined();
      expect(repo2.fileExists("test.txt")).toBe(true);

      // First repo is still primary
      expect(harness.getRepo()).toBe(repo1);
    });

    it("should spawn and manage simulators", async () => {
      await harness.createTempRepo();

      const sim1 = await harness.spawnSimulator({
        role: "worker",
        behavior: { onStart: [{ type: "log", message: "Worker 1" }] },
      });

      const sim2 = await harness.spawnSimulator({
        role: "coordinator",
        behavior: { onStart: [{ type: "log", message: "Coordinator" }] },
      });

      expect(harness.getSimulatorCount()).toBe(2);
      expect(harness.getSimulator(sim1.agentId)).toBe(sim1);
      expect(harness.getSimulator(sim2.agentId)).toBe(sim2);
      expect(harness.getAllSimulators()).toContain(sim1);
      expect(harness.getAllSimulators()).toContain(sim2);
    });

    it("should step all simulators", async () => {
      await harness.createTempRepo();

      await harness.spawnSimulator({
        role: "worker",
        behavior: {
          onStart: [
            { type: "log", message: "Step 1" },
            { type: "log", message: "Step 2" },
          ],
        },
      });

      await harness.spawnSimulator({
        role: "worker",
        behavior: {
          onStart: [{ type: "log", message: "Only step" }],
        },
      });

      const result1 = await harness.stepAll();
      expect(result1.steppedCount).toBe(2);

      const result2 = await harness.stepAll();
      expect(result2.steppedCount).toBe(1);

      const result3 = await harness.stepAll();
      expect(result3.allIdle).toBe(true);
    });

    it("should run until idle", async () => {
      await harness.createTempRepo();

      await harness.spawnSimulator({
        role: "worker",
        behavior: {
          onStart: [
            { type: "log", message: "Step 1" },
            { type: "log", message: "Step 2" },
            { type: "log", message: "Step 3" },
          ],
        },
      });

      const result = await harness.runUntilIdle();
      expect(result.allIdle).toBe(true);
    });

    it("should wait for condition", async () => {
      await harness.createTempRepo();

      const sim = await harness.spawnSimulator({
        role: "worker",
        behavior: {
          onStart: [
            { type: "write_file", path: "output.txt", content: "done" },
            { type: "done", status: "completed" },
          ],
        },
      });

      await harness.waitForCondition(
        () => !sim.isRunning(),
        { maxIterations: 100 }
      );

      expect(sim.isRunning()).toBe(false);
    });

    it("should wait for specific simulator", async () => {
      await harness.createTempRepo();

      const sim = await harness.spawnSimulator({
        role: "worker",
        behavior: {
          onStart: [
            { type: "log", message: "Working" },
            { type: "done", status: "completed" },
          ],
        },
      });

      await harness.waitForSimulator(sim.agentId, { maxIterations: 100 });
      expect(sim.isRunning()).toBe(false);
    });

    it("should wait for all simulators", async () => {
      await harness.createTempRepo();

      const sim1 = await harness.spawnSimulator({
        role: "worker",
        behavior: {
          onStart: [{ type: "done", status: "completed" }],
        },
      });

      const sim2 = await harness.spawnSimulator({
        role: "worker",
        behavior: {
          onStart: [
            { type: "log", message: "Working" },
            { type: "done", status: "completed" },
          ],
        },
      });

      await harness.waitForAll({ maxIterations: 100 });

      expect(sim1.isRunning()).toBe(false);
      expect(sim2.isRunning()).toBe(false);
    });

    it("should properly cleanup", async () => {
      const repo = await harness.createTempRepo();
      const repoPath = repo.path;

      const sim = await harness.spawnSimulator({
        role: "worker",
        behavior: { onStart: [{ type: "log", message: "Test" }] },
      });
      const agentId = sim.agentId;

      await harness.cleanup();

      expect(harness.getSimulatorCount()).toBe(0);
      expect(harness.getSimulator(agentId)).toBeUndefined();
      expect(harness.getRepo()).toBeUndefined();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Assertions Tests
  // ─────────────────────────────────────────────────────────────────────────

  describe("Assertions", () => {
    let harness: TestHarness;

    beforeEach(async () => {
      harness = await createTestHarness();
      await harness.createTempRepo({
        initialFiles: {
          "src/index.ts": "export const version = '1.0.0';",
        },
      });
    });

    afterEach(async () => {
      await harness.cleanup();
    });

    it("should assert agent terminated", async () => {
      const sim = await harness.spawnSimulator({
        role: "worker",
        behavior: {
          onStart: [{ type: "done", status: "completed" }],
        },
      });

      await harness.waitForSimulator(sim.agentId);

      // Should not throw
      harness.assertAgentTerminated(sim.agentId);
    });

    it("should fail assertAgentTerminated when agent is running", async () => {
      const sim = await harness.spawnSimulator({
        role: "worker",
        behavior: {
          onStart: [
            { type: "wait_for_event", event: "NEVER_COMING" },
          ],
        },
      });

      await harness.stepAll(); // Start waiting

      expect(() => harness.assertAgentTerminated(sim.agentId)).toThrow(
        HarnessAssertionError
      );
    });

    it("should assert agent state", async () => {
      const sim = await harness.spawnSimulator({
        role: "worker",
        behavior: {
          onStart: [{ type: "log", message: "test" }],
        },
      });

      harness.assertAgentState(sim.agentId, "running");

      await harness.runUntilIdle();

      // After completion, still running until done() called
      // Let's test with done()
      const sim2 = await harness.spawnSimulator({
        role: "worker",
        behavior: {
          onStart: [{ type: "done", status: "completed" }],
        },
      });

      await harness.waitForSimulator(sim2.agentId);
      harness.assertAgentState(sim2.agentId, "stopped");
    });

    it("should assert task status", async () => {
      const task = harness.taskManager.create({
        description: "Test task",
        created_by: "test",
      });

      harness.assertTaskStatus(task.id, "pending");

      // Follow proper status transitions: pending -> assigned -> in_progress -> completed
      harness.taskManager.assign(task.id, "worker_1");
      harness.assertTaskStatus(task.id, "assigned");

      harness.taskManager.updateStatus(task.id, "in_progress");
      harness.assertTaskStatus(task.id, "in_progress");

      harness.taskManager.updateStatus(task.id, "completed");
      harness.assertTaskStatus(task.id, "completed");
    });

    it("should assert branch exists", async () => {
      harness.assertBranchExists("main");

      expect(() => harness.assertBranchExists("nonexistent")).toThrow(
        HarnessAssertionError
      );
    });

    it("should assert file exists", async () => {
      harness.assertFileExists("src/index.ts");

      expect(() => harness.assertFileExists("nonexistent.ts")).toThrow(
        HarnessAssertionError
      );
    });

    it("should assert file contains", async () => {
      harness.assertFileContains("src/index.ts", "version");
      harness.assertFileContains("src/index.ts", /export const/);

      expect(() =>
        harness.assertFileContains("src/index.ts", "notfound")
      ).toThrow(HarnessAssertionError);
    });

    it("should assert clean working tree", async () => {
      // Initially clean
      harness.assertCleanWorkingTree();

      // Create uncommitted file
      const repo = harness.getRepo()!;
      repo.writeFile("uncommitted.txt", "test");

      expect(() => harness.assertCleanWorkingTree()).toThrow(
        HarnessAssertionError
      );

      // Commit it
      repo.commit("Add file");
      harness.assertCleanWorkingTree();
    });

    it("should assert simulator complete", async () => {
      const sim = await harness.spawnSimulator({
        role: "worker",
        behavior: {
          onStart: [{ type: "done", status: "completed" }],
        },
      });

      await harness.waitForSimulator(sim.agentId);
      harness.assertSimulatorComplete(sim.agentId);
    });

    it("should assert executed step", async () => {
      const sim = await harness.spawnSimulator({
        role: "worker",
        behavior: {
          onStart: [
            { type: "log", message: "Hello" },
            { type: "write_file", path: "test.txt", content: "test" },
          ],
        },
      });

      await harness.runUntilIdle();

      harness.assertExecutedStep(sim.agentId, "log");
      harness.assertExecutedStep(sim.agentId, "write_file");

      expect(() => harness.assertExecutedStep(sim.agentId, "commit")).toThrow(
        HarnessAssertionError
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Multi-Simulator Coordination Tests
  // ─────────────────────────────────────────────────────────────────────────

  describe("Multi-Simulator Coordination", () => {
    let harness: TestHarness;

    beforeEach(async () => {
      harness = await createTestHarness();
      await harness.createTempRepo({
        initialFiles: {
          "src/index.ts": "export const version = '1.0.0';",
        },
      });
    });

    afterEach(async () => {
      await harness.cleanup();
    });

    it("should coordinate multiple workers", async () => {
      // Simple coordination test - both workers do work and complete
      const worker1 = await harness.spawnSimulator({
        role: "worker",
        behavior: {
          onStart: [
            { type: "log", message: "Worker 1 starting" },
            { type: "write_file", path: "worker1.txt", content: "w1" },
            { type: "log", message: "Worker 1 done" },
            { type: "done", status: "completed" },
          ],
        },
      });

      const worker2 = await harness.spawnSimulator({
        role: "worker",
        behavior: {
          onStart: [
            { type: "log", message: "Worker 2 starting" },
            { type: "write_file", path: "worker2.txt", content: "w2" },
            { type: "log", message: "Worker 2 done" },
            { type: "done", status: "completed" },
          ],
        },
      });

      await harness.waitForAll({ maxIterations: 100 });

      harness.assertAgentTerminated(worker1.agentId);
      harness.assertAgentTerminated(worker2.agentId);
      harness.assertFileExists("worker1.txt");
      harness.assertFileExists("worker2.txt");
    });

    it("should handle parent-child relationship", async () => {
      const coordinator = await harness.spawnSimulator({
        role: "coordinator",
        behavior: {
          onStart: [
            { type: "log", message: "Coordinator starting" },
            {
              type: "spawn_child",
              role: "worker",
              behavior: {
                onStart: [
                  { type: "log", message: "Child worker" },
                  { type: "done", status: "completed" },
                ],
              },
            },
            { type: "done", status: "completed" },
          ],
        },
      });

      await harness.waitForSimulator(coordinator.agentId, { maxIterations: 100 });

      // Coordinator should have spawned a child
      const context = coordinator.getContext();
      expect(context.children.length).toBe(1);

      // Child should also complete (use direct check since child is not registered with harness)
      const child = context.children[0];

      // Run child until it completes
      while (child.isRunning() && child.hasPendingSteps()) {
        await child.stepOnce();
      }

      harness.assertAgentTerminated(coordinator.agentId);
      expect(child.isRunning()).toBe(false);
    });

    it("should handle cross-simulator communication", async () => {
      const receiver = await harness.spawnSimulator({
        role: "worker",
        behavior: {
          onStart: [
            { type: "log", message: "Receiver waiting" },
            { type: "wait_for_event", event: "DATA_READY" },
            { type: "log", message: "Receiver got data" },
            { type: "done", status: "completed" },
          ],
        },
      });

      const sender = await harness.spawnSimulator({
        role: "worker",
        behavior: {
          onStart: [
            { type: "log", message: "Sender sending" },
            { type: "done", status: "completed" },
          ],
        },
      });

      // Step both - first step is log for both
      await harness.stepAll();

      // Second step - receiver starts waiting, sender completes
      await harness.stepAll();

      // At this point receiver should be waiting for event
      // Inject event to receiver
      receiver.injectEvent({
        type: "DATA_READY",
        payload: { from: sender.agentId },
        timestamp: Date.now(),
      });

      // Now receiver can proceed - step to pick up the event
      await harness.stepAll(); // Receiver completes wait_for_event

      // Step to log and done
      await harness.stepAll(); // Receiver logs
      await harness.stepAll(); // Receiver done

      harness.assertAgentTerminated(receiver.agentId);
      harness.assertAgentTerminated(sender.agentId);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Integration Tests
  // ─────────────────────────────────────────────────────────────────────────

  describe("Integration", () => {
    let harness: TestHarness;

    beforeEach(async () => {
      harness = await createTestHarness();
    });

    afterEach(async () => {
      await harness.cleanup();
    });

    it("should complete full worker flow with assertions", async () => {
      await harness.createTempRepo({
        initialFiles: {
          "src/index.ts": "// placeholder",
        },
      });

      const worker = await harness.spawnSimulator({
        role: "worker",
        behavior: {
          onStart: [
            { type: "log", message: "Starting implementation" },
            {
              type: "write_file",
              path: "src/feature.ts",
              content: "export function feature() { return 42; }",
            },
            { type: "commit", message: "Implement feature" },
            { type: "done", status: "completed", summary: "Feature complete" },
          ],
        },
      });

      await harness.waitForAll({ maxIterations: 100 });

      // Verify all aspects
      harness.assertAgentTerminated(worker.agentId);
      harness.assertSimulatorComplete(worker.agentId);
      harness.assertExecutedStep(worker.agentId, "write_file");
      harness.assertExecutedStep(worker.agentId, "commit");
      harness.assertFileExists("src/feature.ts");
      harness.assertFileContains("src/feature.ts", "return 42");
      harness.assertCleanWorkingTree();
    });
  });
});
