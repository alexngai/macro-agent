/**
 * Fixtures Library Tests
 *
 * Tests for project fixtures and behavior fixtures.
 */

import { describe, it, expect, afterEach } from "vitest";

import {
  createTestHarness,
  type TestHarness,
} from "../index.js";
import {
  // Project fixtures
  TYPESCRIPT_PROJECT,
  PROJECT_WITH_BRANCHES,
  MINIMAL_PROJECT,
  PROJECT_WITH_SPECS,
  createTypescriptProjectOptions,
  // Behavior fixtures
  SUCCESSFUL_WORKER,
  FAILING_WORKER,
  IMPLEMENT_FUNCTION_WORKER,
  WAITING_WORKER,
  SIMPLE_COORDINATOR,
  createMultiWorkerCoordinator,
  SIMPLE_INTEGRATOR,
  SIMPLE_MONITOR,
  createWorker,
} from "../../fixtures/index.js";

describe("Fixtures Library", () => {
  // ─────────────────────────────────────────────────────────────────────────
  // Project Fixtures
  // ─────────────────────────────────────────────────────────────────────────

  describe("Project Fixtures", () => {
    let harness: TestHarness;

    afterEach(async () => {
      if (harness) {
        await harness.cleanup();
      }
    });

    it("should create TypeScript project", async () => {
      harness = await createTestHarness();
      const repo = await harness.createTempRepo({
        initialFiles: TYPESCRIPT_PROJECT,
      });

      expect(repo.fileExists("package.json")).toBe(true);
      expect(repo.fileExists("tsconfig.json")).toBe(true);
      expect(repo.fileExists("src/index.ts")).toBe(true);
      expect(repo.fileExists("src/utils.ts")).toBe(true);
      expect(repo.fileExists("tests/index.test.ts")).toBe(true);
      expect(repo.fileExists("README.md")).toBe(true);

      // Verify package.json content
      const packageJson = JSON.parse(repo.readFile("package.json"));
      expect(packageJson.name).toBe("test-project");
      expect(packageJson.scripts.build).toBe("tsc");
    });

    it("should create project with branches", async () => {
      harness = await createTestHarness();
      const repo = await harness.createTempRepo({
        initialFiles: PROJECT_WITH_BRANCHES.initialFiles,
        branches: PROJECT_WITH_BRANCHES.branches,
      });

      const branches = repo.getBranches();
      expect(branches).toContain("main");
      expect(branches).toContain("feature/existing");
      expect(branches).toContain("feature/wip");

      // Verify branch content
      repo.checkout("feature/existing");
      expect(repo.fileExists("src/feature.ts")).toBe(true);
    });

    it("should create minimal project", async () => {
      harness = await createTestHarness();
      const repo = await harness.createTempRepo({
        initialFiles: MINIMAL_PROJECT,
      });

      expect(repo.fileExists("index.ts")).toBe(true);
      expect(repo.readFile("index.ts")).toContain("version");
    });

    it("should create project with dataplane", async () => {
      harness = await createTestHarness();
      const repo = await harness.createTempRepo(PROJECT_WITH_SPECS);

      expect(repo.db).toBeDefined();

      // Verify dataplane tables exist
      const tables = repo.db!
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'dataplane_%'"
        )
        .all() as Array<{ name: string }>;
      expect(tables.length).toBeGreaterThan(0);
    });

    it("should create custom TypeScript project options", async () => {
      harness = await createTestHarness();
      const options = createTypescriptProjectOptions({
        withDataplane: true,
      });

      const repo = await harness.createTempRepo(options);
      expect(repo.fileExists("package.json")).toBe(true);
      expect(repo.db).toBeDefined();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Behavior Fixtures
  // ─────────────────────────────────────────────────────────────────────────

  describe("Behavior Fixtures", () => {
    let harness: TestHarness;

    afterEach(async () => {
      if (harness) {
        await harness.cleanup();
      }
    });

    it("should execute SUCCESSFUL_WORKER", async () => {
      harness = await createTestHarness();
      await harness.createTempRepo({ initialFiles: MINIMAL_PROJECT });

      const worker = await harness.spawnSimulator({
        role: "worker",
        behavior: SUCCESSFUL_WORKER,
      });

      await harness.waitForSimulator(worker.agentId, { maxIterations: 100 });

      harness.assertAgentTerminated(worker.agentId);
      harness.assertFileExists("output.txt");
      harness.assertCleanWorkingTree();
    });

    it("should fail FAILING_WORKER after 2 steps", async () => {
      harness = await createTestHarness();
      await harness.createTempRepo({ initialFiles: MINIMAL_PROJECT });

      // FAILING_WORKER has failAfter: 2, which means it fails on step 3
      // It only has 2 steps, so we create a custom behavior with more steps
      const failingBehavior = createWorker(
        [
          { type: "log", message: "Step 1" },
          { type: "log", message: "Step 2" },
          { type: "log", message: "Step 3 - should fail" },
        ],
        { failAfter: 2, failWith: "Simulated failure" }
      );

      const worker = await harness.spawnSimulator({
        role: "worker",
        behavior: failingBehavior,
      });

      // Step through
      await harness.stepAll(); // Step 1 - stepCount becomes 1
      await harness.stepAll(); // Step 2 - stepCount becomes 2
      const result = await harness.stepAll(); // Step 3 - should fail (stepCount >= failAfter)

      expect(result.results.get(worker.agentId)?.status).toBe("failed");
    });

    it("should execute IMPLEMENT_FUNCTION_WORKER", async () => {
      harness = await createTestHarness();
      await harness.createTempRepo({ initialFiles: TYPESCRIPT_PROJECT });

      const worker = await harness.spawnSimulator({
        role: "worker",
        behavior: IMPLEMENT_FUNCTION_WORKER,
      });

      await harness.waitForSimulator(worker.agentId, { maxIterations: 100 });

      harness.assertAgentTerminated(worker.agentId);
      harness.assertFileExists("src/feature.ts");
      harness.assertFileContains("src/feature.ts", "newFeature");
    });

    it("should make WAITING_WORKER wait for event", async () => {
      harness = await createTestHarness();
      await harness.createTempRepo({ initialFiles: MINIMAL_PROJECT });

      const worker = await harness.spawnSimulator({
        role: "worker",
        behavior: WAITING_WORKER,
      });

      // Step until waiting
      await harness.stepAll(); // log
      await harness.stepAll(); // wait_for_event

      // Should be waiting
      expect(worker.hasPendingSteps()).toBe(false);

      // Inject event
      worker.injectEvent({
        type: "WORK_ASSIGNED",
        payload: {},
        timestamp: Date.now(),
      });

      // Should complete
      await harness.waitForSimulator(worker.agentId, { maxIterations: 100 });
      harness.assertAgentTerminated(worker.agentId);
    });

    it("should execute SIMPLE_COORDINATOR", async () => {
      harness = await createTestHarness();
      await harness.createTempRepo({ initialFiles: MINIMAL_PROJECT });

      const coordinator = await harness.spawnSimulator({
        role: "coordinator",
        behavior: SIMPLE_COORDINATOR,
      });

      await harness.waitForSimulator(coordinator.agentId, { maxIterations: 100 });
      harness.assertAgentTerminated(coordinator.agentId);
    });

    it("should create multi-worker coordinator", async () => {
      harness = await createTestHarness();
      await harness.createTempRepo({ initialFiles: MINIMAL_PROJECT });

      const behavior = createMultiWorkerCoordinator(3);
      expect(behavior.onStart.length).toBeGreaterThan(3); // spawn steps + log + done

      const coordinator = await harness.spawnSimulator({
        role: "coordinator",
        behavior,
      });

      await harness.waitForSimulator(coordinator.agentId, { maxIterations: 100 });

      // Should have spawned 3 children
      const context = coordinator.getContext();
      expect(context.children.length).toBe(3);
    });

    it("should execute SIMPLE_INTEGRATOR", async () => {
      harness = await createTestHarness();
      await harness.createTempRepo({ initialFiles: MINIMAL_PROJECT });

      const integrator = await harness.spawnSimulator({
        role: "integrator",
        behavior: SIMPLE_INTEGRATOR,
      });

      await harness.waitForSimulator(integrator.agentId, { maxIterations: 100 });
      harness.assertAgentTerminated(integrator.agentId);
    });

    it("should execute SIMPLE_MONITOR", async () => {
      harness = await createTestHarness();
      await harness.createTempRepo({ initialFiles: MINIMAL_PROJECT });

      const monitor = await harness.spawnSimulator({
        role: "monitor",
        behavior: SIMPLE_MONITOR,
      });

      await harness.waitForSimulator(monitor.agentId, { maxIterations: 100 });
      harness.assertAgentTerminated(monitor.agentId);
    });

    it("should create custom worker", async () => {
      harness = await createTestHarness();
      await harness.createTempRepo({ initialFiles: MINIMAL_PROJECT });

      const customBehavior = createWorker([
        { type: "log", message: "Custom step 1" },
        { type: "log", message: "Custom step 2" },
        { type: "done", status: "completed" },
      ]);

      const worker = await harness.spawnSimulator({
        role: "worker",
        behavior: customBehavior,
      });

      await harness.waitForSimulator(worker.agentId, { maxIterations: 100 });
      harness.assertAgentTerminated(worker.agentId);
      harness.assertExecutedStep(worker.agentId, "log");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Integration Tests
  // ─────────────────────────────────────────────────────────────────────────

  describe("Integration", () => {
    let harness: TestHarness;

    afterEach(async () => {
      if (harness) {
        await harness.cleanup();
      }
    });

    it("should run complete workflow with fixtures", async () => {
      harness = await createTestHarness();

      // Create project
      await harness.createTempRepo({
        initialFiles: TYPESCRIPT_PROJECT,
        withDataplane: true,
      });

      // Spawn coordinator that spawns worker
      const coordinator = await harness.spawnSimulator({
        role: "coordinator",
        behavior: {
          onStart: [
            { type: "log", message: "Starting coordination" },
            {
              type: "spawn_child",
              role: "worker",
              behavior: SUCCESSFUL_WORKER,
            },
            { type: "done", status: "completed" },
          ],
        },
      });

      await harness.waitForSimulator(coordinator.agentId, { maxIterations: 100 });

      // Verify coordinator completed
      harness.assertAgentTerminated(coordinator.agentId);

      // Verify worker was spawned
      const context = coordinator.getContext();
      expect(context.children.length).toBe(1);
    });
  });
});
