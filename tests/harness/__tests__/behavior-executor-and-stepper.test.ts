/**
 * BehaviorExecutor and EventStepper Tests
 *
 * Tests for behavior step execution and multi-simulator timing control.
 *
 * @see s-1zcx Multi-Agent Orchestration Testing Strategy
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { createTempRepo, type TempRepo } from "../../fixtures/repos/index.js";
import {
  createAgentSimulator,
  createBehaviorExecutor,
  type AgentSimulator,
  type SimulatedBehavior,
  type SimulatorServices,
  type BehaviorExecutorConfig,
  type SimulatorContext,
} from "../simulator/index.js";
import {
  createEventStepper,
  type EventStepper,
} from "../timing/index.js";
import { createEventStore, type EventStore } from "../../../src/store/event-store.js";
import {
  createMessageRouter,
  type MessageRouter,
} from "../../../src/router/message-router.js";
import { createTaskManager, type TaskManager } from "../../../src/task/task-manager.js";

describe("BehaviorExecutor and EventStepper", () => {
  // ─────────────────────────────────────────────────────────────────────────
  // BehaviorExecutor Tests
  // ─────────────────────────────────────────────────────────────────────────

  describe("BehaviorExecutor", () => {
    let repo: TempRepo | null = null;
    let eventStore: EventStore;
    let messageRouter: MessageRouter;
    let taskManager: TaskManager;
    let services: SimulatorServices;

    beforeEach(async () => {
      repo = await createTempRepo({
        initialFiles: {
          "src/index.ts": "export const version = '1.0.0';",
        },
      });

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

    it("should execute all step types", async () => {
      let doneWasCalled = false;
      let doneArgs: { status: string; summary?: string } | null = null;

      const config: BehaviorExecutorConfig = {
        agentId: "test-agent",
        services,
        spawnChild: async () => {
          throw new Error("Not implemented");
        },
        onDone: async (status, summary) => {
          doneWasCalled = true;
          doneArgs = { status, summary };
        },
      };

      const executor = createBehaviorExecutor(config, [
        { type: "log", message: "Step 1" },
        { type: "write_file", path: "test.txt", content: "hello" },
        { type: "read_file", path: "test.txt", into: "fileContent" },
        { type: "done", status: "completed", summary: "Test complete" },
      ]);

      const context: SimulatorContext = {
        agentId: "test-agent",
        role: "worker",
        workspacePath: repo!.path,
        variables: new Map(),
        events: [],
        children: [],
        stuckAgents: [],
        stepCount: 0,
        startedAt: Date.now(),
        services,
      };

      const behavior: SimulatedBehavior = {
        onStart: [],
      };

      // Execute steps
      const result1 = await executor.executeStep(context, behavior);
      expect(result1.status).toBe("completed");
      expect(result1.step.type).toBe("log");

      const result2 = await executor.executeStep(context, behavior);
      expect(result2.status).toBe("completed");
      expect(result2.step.type).toBe("write_file");
      expect(repo!.fileExists("test.txt")).toBe(true);

      const result3 = await executor.executeStep(context, behavior);
      expect(result3.status).toBe("completed");
      expect(result3.step.type).toBe("read_file");
      expect(context.variables.get("fileContent")).toBe("hello");

      const result4 = await executor.executeStep(context, behavior);
      expect(result4.status).toBe("done");
      expect(doneWasCalled).toBe(true);
      expect(doneArgs?.status).toBe("completed");
    });

    it("should handle conditional branching", async () => {
      const config: BehaviorExecutorConfig = {
        agentId: "test-agent",
        services,
        spawnChild: async () => {
          throw new Error("Not implemented");
        },
        onDone: async () => {},
      };

      const executor = createBehaviorExecutor(config, [
        {
          type: "conditional",
          if: (ctx) => ctx.variables.get("flag") === true,
          then: [{ type: "log", message: "Flag is true" }],
          else: [{ type: "log", message: "Flag is false" }],
        },
      ]);

      const context: SimulatorContext = {
        agentId: "test-agent",
        role: "worker",
        workspacePath: repo!.path,
        variables: new Map([["flag", false]]),
        events: [],
        children: [],
        stuckAgents: [],
        stepCount: 0,
        startedAt: Date.now(),
        services,
      };

      const behavior: SimulatedBehavior = { onStart: [] };

      // Execute conditional
      const result1 = await executor.executeStep(context, behavior);
      expect(result1.status).toBe("completed");
      expect(result1.step.type).toBe("conditional");

      // Should have inserted the else branch
      const result2 = await executor.executeStep(context, behavior);
      expect(result2.status).toBe("completed");
      expect(result2.step.type).toBe("log");
      expect((result2.step as { message: string }).message).toBe("Flag is false");
    });

    it("should handle storeResult for call_tool", async () => {
      const config: BehaviorExecutorConfig = {
        agentId: "test-agent",
        services,
        spawnChild: async () => {
          throw new Error("Not implemented");
        },
        onDone: async () => {},
      };

      const executor = createBehaviorExecutor(config, [
        {
          type: "call_tool",
          tool: "create_task",
          params: { description: "Test task" },
          storeResult: "createdTask",
        },
      ]);

      const context: SimulatorContext = {
        agentId: "test-agent",
        role: "worker",
        workspacePath: repo!.path,
        variables: new Map(),
        events: [],
        children: [],
        stuckAgents: [],
        stepCount: 0,
        startedAt: Date.now(),
        services,
      };

      const behavior: SimulatedBehavior = { onStart: [] };

      const result = await executor.executeStep(context, behavior);
      expect(result.status).toBe("completed");
      expect(context.variables.has("createdTask")).toBe(true);
      expect(context.variables.get("createdTask")).toBeDefined();
    });

    it("should dispatch onEvent handlers", async () => {
      const config: BehaviorExecutorConfig = {
        agentId: "test-agent",
        services,
        spawnChild: async () => {
          throw new Error("Not implemented");
        },
        onDone: async () => {},
      };

      const executor = createBehaviorExecutor(config, [
        { type: "log", message: "Initial step" },
      ]);

      const context: SimulatorContext = {
        agentId: "test-agent",
        role: "worker",
        workspacePath: repo!.path,
        variables: new Map(),
        events: [],
        children: [],
        stuckAgents: [],
        stepCount: 0,
        startedAt: Date.now(),
        services,
      };

      const behavior: SimulatedBehavior = {
        onStart: [],
        onEvent: {
          WORK_ASSIGNED: [
            { type: "log", message: "Work assigned handler" },
          ],
        },
      };

      // Execute initial step
      await executor.executeStep(context, behavior);

      // Inject event
      executor.injectEvent({
        type: "WORK_ASSIGNED",
        payload: { taskId: "task-1" },
        timestamp: Date.now(),
      });

      // Execute again - should process event handler
      const result = await executor.executeStep(context, behavior);
      expect(result.status).toBe("completed");
      expect(result.step.type).toBe("log");
      expect((result.step as { message: string }).message).toBe("Work assigned handler");

      // Verify event was added to context
      expect(context.events.length).toBe(1);
      expect(context.events[0].type).toBe("WORK_ASSIGNED");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // EventStepper Tests
  // ─────────────────────────────────────────────────────────────────────────

  describe("EventStepper", () => {
    let repo: TempRepo | null = null;
    let eventStore: EventStore;
    let messageRouter: MessageRouter;
    let taskManager: TaskManager;
    let services: SimulatorServices;
    let stepper: EventStepper;

    beforeEach(async () => {
      repo = await createTempRepo();
      eventStore = await createEventStore({ inMemory: true });
      messageRouter = createMessageRouter(eventStore);
      taskManager = createTaskManager(eventStore);

      services = {
        eventStore,
        messageRouter,
        taskManager,
      };

      stepper = createEventStepper();
    });

    afterEach(async () => {
      stepper.reset();
      await eventStore?.close();
      if (repo) {
        await repo.cleanup();
        repo = null;
      }
    });

    it("should register and manage simulators", async () => {
      const simulator = createAgentSimulator(
        {
          role: "worker",
          behavior: { onStart: [{ type: "log", message: "Test" }] },
          repoPath: repo!.path,
        },
        services
      );

      await simulator.start({
        agentId: simulator.agentId,
        role: "worker",
        workspacePath: repo!.path,
        services,
      });

      stepper.register(simulator);

      expect(stepper.count).toBe(1);
      expect(stepper.get(simulator.agentId)).toBe(simulator);
      expect(stepper.getAll()).toContain(simulator);

      stepper.unregister(simulator.agentId);
      expect(stepper.count).toBe(0);
    });

    it("should step all simulators", async () => {
      const sim1 = createAgentSimulator(
        {
          role: "worker",
          behavior: {
            onStart: [
              { type: "log", message: "Sim1 step 1" },
              { type: "log", message: "Sim1 step 2" },
            ],
          },
          repoPath: repo!.path,
        },
        services
      );

      const sim2 = createAgentSimulator(
        {
          role: "worker",
          behavior: {
            onStart: [
              { type: "log", message: "Sim2 step 1" },
            ],
          },
          repoPath: repo!.path,
        },
        services
      );

      await sim1.start({
        agentId: sim1.agentId,
        role: "worker",
        workspacePath: repo!.path,
        services,
      });

      await sim2.start({
        agentId: sim2.agentId,
        role: "worker",
        workspacePath: repo!.path,
        services,
      });

      stepper.register(sim1);
      stepper.register(sim2);

      // First stepAll - both should execute one step
      const result1 = await stepper.stepAll();
      expect(result1.steppedCount).toBe(2);
      expect(result1.results.has(sim1.agentId)).toBe(true);
      expect(result1.results.has(sim2.agentId)).toBe(true);

      // Second stepAll - sim1 has another step, sim2 is done
      const result2 = await stepper.stepAll();
      expect(result2.steppedCount).toBe(1);
      expect(result2.results.has(sim1.agentId)).toBe(true);

      // Third stepAll - both done
      const result3 = await stepper.stepAll();
      expect(result3.allIdle).toBe(true);
    });

    it("should run until idle", async () => {
      const simulator = createAgentSimulator(
        {
          role: "worker",
          behavior: {
            onStart: [
              { type: "log", message: "Step 1" },
              { type: "log", message: "Step 2" },
              { type: "log", message: "Step 3" },
            ],
          },
          repoPath: repo!.path,
        },
        services
      );

      await simulator.start({
        agentId: simulator.agentId,
        role: "worker",
        workspacePath: repo!.path,
        services,
      });

      stepper.register(simulator);

      const result = await stepper.runUntilIdle();
      expect(result.allIdle).toBe(true);
      expect(stepper.totalSteps).toBe(3);
    });

    it("should wait for condition", async () => {
      let counter = 0;

      const simulator = createAgentSimulator(
        {
          role: "worker",
          behavior: {
            onStart: [
              { type: "log", message: "Step 1" },
              { type: "log", message: "Step 2" },
              { type: "log", message: "Step 3" },
            ],
          },
          repoPath: repo!.path,
        },
        services
      );

      await simulator.start({
        agentId: simulator.agentId,
        role: "worker",
        workspacePath: repo!.path,
        services,
      });

      stepper.register(simulator);

      // Wait until 2 steps executed
      await stepper.waitForCondition(
        () => {
          counter++;
          return stepper.totalSteps >= 2;
        },
        { maxIterations: 100 }
      );

      expect(stepper.totalSteps).toBeGreaterThanOrEqual(2);
    });

    it("should wait for simulator to complete", async () => {
      const simulator = createAgentSimulator(
        {
          role: "worker",
          behavior: {
            onStart: [
              { type: "log", message: "Working..." },
              { type: "done", status: "completed", summary: "Done" },
            ],
          },
          repoPath: repo!.path,
        },
        services
      );

      await simulator.start({
        agentId: simulator.agentId,
        role: "worker",
        workspacePath: repo!.path,
        services,
      });

      stepper.register(simulator);

      await stepper.waitForSimulator(simulator.agentId, { maxIterations: 100 });

      expect(simulator.isRunning()).toBe(false);
    });

    it("should wait for all simulators to complete", async () => {
      const sim1 = createAgentSimulator(
        {
          role: "worker",
          behavior: {
            onStart: [
              { type: "log", message: "Sim1" },
              { type: "done", status: "completed" },
            ],
          },
          repoPath: repo!.path,
        },
        services
      );

      const sim2 = createAgentSimulator(
        {
          role: "worker",
          behavior: {
            onStart: [
              { type: "log", message: "Sim2 step 1" },
              { type: "log", message: "Sim2 step 2" },
              { type: "done", status: "completed" },
            ],
          },
          repoPath: repo!.path,
        },
        services
      );

      await sim1.start({
        agentId: sim1.agentId,
        role: "worker",
        workspacePath: repo!.path,
        services,
      });

      await sim2.start({
        agentId: sim2.agentId,
        role: "worker",
        workspacePath: repo!.path,
        services,
      });

      stepper.register(sim1);
      stepper.register(sim2);

      await stepper.waitForAll({ maxIterations: 100 });

      expect(sim1.isRunning()).toBe(false);
      expect(sim2.isRunning()).toBe(false);
    });

    it("should handle cross-simulator events", async () => {
      // Coordinator spawns work, worker waits for it
      const worker = createAgentSimulator(
        {
          role: "worker",
          behavior: {
            onStart: [
              { type: "log", message: "Worker waiting for work" },
              { type: "wait_for_event", event: "WORK_READY" },
              { type: "log", message: "Worker received work" },
              { type: "done", status: "completed" },
            ],
          },
          repoPath: repo!.path,
        },
        services
      );

      await worker.start({
        agentId: worker.agentId,
        role: "worker",
        workspacePath: repo!.path,
        services,
      });

      stepper.register(worker);

      // Step worker until waiting
      await stepper.stepOne(worker.agentId); // log
      const waitResult = await stepper.stepOne(worker.agentId); // wait_for_event
      expect(waitResult?.status).toBe("waiting");

      // Inject event from "coordinator"
      worker.injectEvent({
        type: "WORK_READY",
        payload: { taskId: "task-1" },
        source: { agentId: "coordinator" },
        timestamp: Date.now(),
      });

      // Step worker - should complete wait
      const afterEvent = await stepper.stepOne(worker.agentId);
      expect(afterEvent?.status).toBe("completed");

      // Finish worker
      await stepper.runUntilIdle();
      expect(worker.isRunning()).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Integration Tests
  // ─────────────────────────────────────────────────────────────────────────

  describe("Integration", () => {
    let repo: TempRepo | null = null;
    let eventStore: EventStore;
    let messageRouter: MessageRouter;
    let taskManager: TaskManager;
    let services: SimulatorServices;
    let stepper: EventStepper;

    beforeEach(async () => {
      repo = await createTempRepo({
        initialFiles: {
          "src/index.ts": "export const version = '1.0.0';",
        },
      });

      eventStore = await createEventStore({ inMemory: true });
      messageRouter = createMessageRouter(eventStore);
      taskManager = createTaskManager(eventStore);

      services = {
        eventStore,
        messageRouter,
        taskManager,
      };

      stepper = createEventStepper();
    });

    afterEach(async () => {
      stepper.reset();
      await eventStore?.close();
      if (repo) {
        await repo.cleanup();
        repo = null;
      }
    });

    it("should execute complete worker flow", async () => {
      const worker = createAgentSimulator(
        {
          role: "worker",
          behavior: {
            onStart: [
              { type: "log", message: "Starting work" },
              { type: "write_file", path: "output.ts", content: "export const result = 42;" },
              { type: "commit", message: "Add output" },
              { type: "done", status: "completed", summary: "Work complete" },
            ],
          },
          repoPath: repo!.path,
        },
        services
      );

      await worker.start({
        agentId: worker.agentId,
        role: "worker",
        workspacePath: repo!.path,
        services,
      });

      stepper.register(worker);
      await stepper.waitForAll({ maxIterations: 100 });

      // Verify file was created and committed
      expect(repo!.fileExists("output.ts")).toBe(true);
      expect(repo!.hasUncommittedChanges()).toBe(false);

      // Verify agent completed
      expect(worker.isRunning()).toBe(false);
      const agent = eventStore.getAgent(worker.agentId);
      expect(agent?.state).toBe("stopped");
    });

    it("should handle failure injection with stepper", async () => {
      const worker = createAgentSimulator(
        {
          role: "worker",
          behavior: {
            onStart: [
              { type: "log", message: "Step 1" },
              { type: "log", message: "Step 2" },
              { type: "log", message: "Step 3" },
            ],
            failAfter: 2,
            failWith: "Injected failure",
          },
          repoPath: repo!.path,
        },
        services
      );

      await worker.start({
        agentId: worker.agentId,
        role: "worker",
        workspacePath: repo!.path,
        services,
      });

      stepper.register(worker);

      // Step through
      await stepper.stepOne(worker.agentId); // Step 1 - stepCount becomes 1
      await stepper.stepOne(worker.agentId); // Step 2 - stepCount becomes 2
      const result = await stepper.stepOne(worker.agentId); // Step 3 - should fail

      expect(result?.status).toBe("failed");
      expect(result?.error?.message).toContain("Injected failure");
    });
  });
});
