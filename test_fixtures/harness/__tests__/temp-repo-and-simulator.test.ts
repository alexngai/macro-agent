/**
 * TempRepoFactory and AgentSimulator Tests
 *
 * Tests for temporary git repository creation and basic agent simulation.
 *
 * @see s-1zcx Multi-Agent Orchestration Testing Strategy
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { createTempRepo, type TempRepo } from "../../fixtures/repos/index.js";
import {
  createAgentSimulator,
  type AgentSimulator,
  type SimulatedBehavior,
  type SimulatorServices,
} from "../simulator/index.js";
import { createEventStore, type EventStore } from "../../../src/store/event-store.js";
import {
  createMessageRouter,
  type MessageRouter,
} from "../../../src/router/message-router.js";
import { createTaskManager, type TaskManager } from "../../../src/task/task-manager.js";

describe("TempRepoFactory and AgentSimulator", () => {
  // ─────────────────────────────────────────────────────────────────────────
  // TempRepoFactory Tests
  // ─────────────────────────────────────────────────────────────────────────

  describe("TempRepoFactory", () => {
    let repo: TempRepo | null = null;

    afterEach(async () => {
      if (repo) {
        await repo.cleanup();
        repo = null;
      }
    });

    it("should create a basic temp repo with initial commit", async () => {
      repo = await createTempRepo();

      expect(repo.path).toBeDefined();
      expect(repo.gitDir).toBeDefined();
      expect(repo.fileExists("README.md")).toBe(true);
      expect(repo.getCurrentBranch()).toBe("main");

      const commits = repo.getCommitLog();
      expect(commits.length).toBeGreaterThan(0);
      expect(commits[0].message).toBe("Initial commit");
    });

    it("should create repo with custom initial files", async () => {
      repo = await createTempRepo({
        initialFiles: {
          "package.json": '{"name": "test"}',
          "src/index.ts": "export const x = 1;",
        },
      });

      expect(repo.fileExists("package.json")).toBe(true);
      expect(repo.fileExists("src/index.ts")).toBe(true);
      expect(repo.readFile("package.json")).toBe('{"name": "test"}');
    });

    it("should create additional branches", async () => {
      repo = await createTempRepo({
        branches: [
          {
            name: "feature/test",
            files: { "feature.ts": "export const feature = true;" },
            commit: "Add feature",
          },
        ],
      });

      const branches = repo.getBranches();
      expect(branches).toContain("main");
      expect(branches).toContain("feature/test");

      // Should be on main branch after creation
      expect(repo.getCurrentBranch()).toBe("main");
    });

    it("should support git helper operations", async () => {
      repo = await createTempRepo();

      // Write and commit
      repo.writeFile("new-file.txt", "content");
      expect(repo.hasUncommittedChanges()).toBe(true);

      const hash = repo.commit("Add new file");
      expect(hash).toHaveLength(40);
      expect(repo.hasUncommittedChanges()).toBe(false);
    });

    it("should create repo with dataplane schema", async () => {
      repo = await createTempRepo({
        withDataplane: true,
      });

      expect(repo.db).toBeDefined();
      expect(repo.dbPath).toBeDefined();

      // Verify tables exist
      const tables = repo.db!
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'dataplane_%'"
        )
        .all();
      expect(tables.length).toBeGreaterThan(0);
    });

    it("should create repo with sudocode schema and fixtures", async () => {
      repo = await createTempRepo({
        withDataplane: true,
        withSudocode: true,
        sudocodeSpecs: [
          { id: "s-test", title: "Test Spec", description: "Test description" },
        ],
        sudocodeIssues: [
          { id: "i-test", title: "Test Issue", implements: "s-test" },
        ],
      });

      // Verify spec was created
      const spec = repo.db!
        .prepare("SELECT * FROM sudocode_specs WHERE id = ?")
        .get("s-test") as { title: string } | undefined;
      expect(spec).toBeDefined();
      expect(spec!.title).toBe("Test Spec");

      // Verify issue was created
      const issue = repo.db!
        .prepare("SELECT * FROM sudocode_issues WHERE id = ?")
        .get("i-test") as { title: string } | undefined;
      expect(issue).toBeDefined();
      expect(issue!.title).toBe("Test Issue");

      // Verify link was created
      const link = repo.db!
        .prepare("SELECT * FROM sudocode_links WHERE from_id = ? AND to_id = ?")
        .get("i-test", "s-test") as { type: string } | undefined;
      expect(link).toBeDefined();
      expect(link!.type).toBe("implements");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // AgentSimulator Tests
  // ─────────────────────────────────────────────────────────────────────────

  describe("AgentSimulator", () => {
    let repo: TempRepo | null = null;
    let eventStore: EventStore;
    let messageRouter: MessageRouter;
    let taskManager: TaskManager;
    let services: SimulatorServices;

    beforeEach(async () => {
      // Create temp repo
      repo = await createTempRepo({
        initialFiles: {
          "src/index.ts": "export const version = '1.0.0';",
        },
      });

      // Create services
      eventStore = await createEventStore({ inMemory: true });
      messageRouter = createMessageRouter(eventStore);
      taskManager = createTaskManager(eventStore);

      services = {
        eventStore,
        messageRouter,
        taskManager,
      };
    });

    afterEach(async () => {
      await eventStore?.close();
      if (repo) {
        await repo.cleanup();
        repo = null;
      }
    });

    it("should create and start a simulator", async () => {
      const behavior: SimulatedBehavior = {
        onStart: [{ type: "log", message: "Hello from simulator" }],
      };

      const simulator = createAgentSimulator(
        {
          role: "worker",
          behavior,
          repoPath: repo!.path,
        },
        services
      );

      expect(simulator.agentId).toBeDefined();
      expect(simulator.role).toBe("worker");

      await simulator.start({
        agentId: simulator.agentId,
        role: "worker",
        workspacePath: repo!.path,
        services,
      });

      expect(simulator.isRunning()).toBe(true);

      // Verify agent was registered in EventStore
      const agent = eventStore.getAgent(simulator.agentId);
      expect(agent).toBeDefined();
      expect(agent!.state).toBe("running");
      expect(agent!.role).toBe("worker");
    });

    it("should execute log steps", async () => {
      const behavior: SimulatedBehavior = {
        onStart: [
          { type: "log", message: "Step 1" },
          { type: "log", message: "Step 2" },
        ],
      };

      const simulator = createAgentSimulator(
        { role: "worker", behavior, repoPath: repo!.path },
        services
      );

      await simulator.start({
        agentId: simulator.agentId,
        role: "worker",
        workspacePath: repo!.path,
        services,
      });

      // Execute steps
      const result1 = await simulator.stepOnce();
      expect(result1.status).toBe("completed");

      const result2 = await simulator.stepOnce();
      expect(result2.status).toBe("completed");

      // No more steps
      const result3 = await simulator.stepOnce();
      expect(result3.status).toBe("done");
    });

    it("should execute write_file and commit steps", async () => {
      const behavior: SimulatedBehavior = {
        onStart: [
          { type: "write_file", path: "output.txt", content: "test content" },
          { type: "commit", message: "Add output file" },
        ],
      };

      const simulator = createAgentSimulator(
        { role: "worker", behavior, repoPath: repo!.path },
        services
      );

      await simulator.start({
        agentId: simulator.agentId,
        role: "worker",
        workspacePath: repo!.path,
        services,
      });

      // Execute write_file
      const result1 = await simulator.stepOnce();
      expect(result1.status).toBe("completed");
      expect(repo!.fileExists("output.txt")).toBe(true);

      // Execute commit
      const result2 = await simulator.stepOnce();
      expect(result2.status).toBe("completed");
      expect(repo!.hasUncommittedChanges()).toBe(false);
    });

    it("should execute done() and terminate", async () => {
      const behavior: SimulatedBehavior = {
        onStart: [
          { type: "log", message: "Starting work" },
          { type: "done", status: "completed", summary: "Work done" },
        ],
      };

      const simulator = createAgentSimulator(
        { role: "worker", behavior, repoPath: repo!.path },
        services
      );

      await simulator.start({
        agentId: simulator.agentId,
        role: "worker",
        workspacePath: repo!.path,
        services,
      });

      // Execute log
      await simulator.stepOnce();

      // Execute done
      const result = await simulator.stepOnce();
      expect(result.status).toBe("done");
      expect(simulator.isRunning()).toBe(false);

      // Verify agent was terminated in EventStore
      const agent = eventStore.getAgent(simulator.agentId);
      expect(agent!.state).toBe("stopped");
    });

    it("should handle failure injection", async () => {
      const behavior: SimulatedBehavior = {
        onStart: [
          { type: "log", message: "Step 1" },
          { type: "log", message: "Step 2" },
          { type: "log", message: "Step 3" },
        ],
        failAfter: 2,
        failWith: "Simulated failure at step 2",
      };

      const simulator = createAgentSimulator(
        { role: "worker", behavior, repoPath: repo!.path },
        services
      );

      await simulator.start({
        agentId: simulator.agentId,
        role: "worker",
        workspacePath: repo!.path,
        services,
      });

      // Execute first step (stepCount = 0 -> 1)
      const result1 = await simulator.stepOnce();
      expect(result1.status).toBe("completed");

      // Execute second step (stepCount = 1 -> 2, triggers failure)
      const result2 = await simulator.stepOnce();
      expect(result2.status).toBe("completed");

      // Third step should fail
      const result3 = await simulator.stepOnce();
      expect(result3.status).toBe("failed");
      expect(result3.error?.message).toContain("Simulated failure");
    });

    it("should inject and process events", async () => {
      const behavior: SimulatedBehavior = {
        onStart: [
          { type: "log", message: "Waiting for event" },
          { type: "wait_for_event", event: "WORK_READY" },
          { type: "log", message: "Event received" },
        ],
      };

      const simulator = createAgentSimulator(
        { role: "worker", behavior, repoPath: repo!.path },
        services
      );

      await simulator.start({
        agentId: simulator.agentId,
        role: "worker",
        workspacePath: repo!.path,
        services,
      });

      // Execute first step
      await simulator.stepOnce();

      // Execute wait_for_event - should be waiting
      const waitResult = await simulator.stepOnce();
      expect(waitResult.status).toBe("waiting");
      expect(waitResult.step.type).toBe("wait_for_event");

      // Inject the event
      simulator.injectEvent({
        type: "WORK_READY",
        payload: { data: "test" },
        timestamp: Date.now(),
      });

      // Execute again - should complete the wait since event is now available
      const afterEventResult = await simulator.stepOnce();
      expect(afterEventResult.status).toBe("completed");
      expect(afterEventResult.step.type).toBe("wait_for_event");
    });

    it("should provide workspace and git state", async () => {
      const behavior: SimulatedBehavior = {
        onStart: [{ type: "log", message: "Check state" }],
      };

      const simulator = createAgentSimulator(
        { role: "worker", behavior, repoPath: repo!.path },
        services
      );

      await simulator.start({
        agentId: simulator.agentId,
        role: "worker",
        workspacePath: repo!.path,
        services,
      });

      const workspaceState = simulator.getWorkspaceState();
      expect(workspaceState.path).toBe(repo!.path);
      expect(workspaceState.branch).toBe("main");
      expect(workspaceState.hasUncommittedChanges).toBe(false);

      const gitState = simulator.getGitState();
      expect(gitState.currentBranch).toBe("main");
      expect(gitState.branches).toContain("main");
      expect(gitState.lastCommit).toBeDefined();
    });

    it("should track execution log", async () => {
      const behavior: SimulatedBehavior = {
        onStart: [
          { type: "log", message: "Step 1" },
          { type: "log", message: "Step 2" },
        ],
      };

      const simulator = createAgentSimulator(
        { role: "worker", behavior, repoPath: repo!.path },
        services
      );

      await simulator.start({
        agentId: simulator.agentId,
        role: "worker",
        workspacePath: repo!.path,
        services,
      });

      await simulator.stepOnce();
      await simulator.stepOnce();

      const log = simulator.getExecutionLog();
      expect(log.length).toBe(2);
      expect(log[0].step.type).toBe("log");
      expect(log[1].step.type).toBe("log");
      expect(log[0].result.status).toBe("completed");
      expect(log[1].result.status).toBe("completed");
    });
  });
});
