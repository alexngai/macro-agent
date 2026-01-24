/**
 * TestHarness - Main orchestrator for multi-agent testing
 *
 * Manages simulators, services, and provides assertions for E2E tests.
 *
 * @see s-1zcx Multi-Agent Orchestration Testing Strategy
 * @see i-7hpt Phase 3: TestHarness Class and Assertions
 */

import { createEventStore, type EventStore } from "../../src/store/event-store.js";
import { createMessageRouter, type MessageRouter } from "../../src/router/message-router.js";
import { createTaskManager, type TaskManager } from "../../src/task/task-manager.js";
import { createTempRepo, type TempRepo, type TempRepoOptions } from "../fixtures/repos/index.js";
import {
  createAgentSimulator,
  type AgentSimulator,
  type SimulatorConfig,
  type SimulatorServices,
  type SimulatedBehavior,
  type AgentRole,
} from "./simulator/index.js";
import { createEventStepper, type EventStepper, type StepAllResult } from "./timing/index.js";
import {
  type AssertionContext,
  assertAgentTerminated,
  assertAgentState,
  assertTaskStatus,
  assertBranchExists,
  assertBranchMerged,
  assertMessagesReceived,
  assertMessageReceived,
  assertFileExists,
  assertFileContains,
  assertCleanWorkingTree,
  assertCommitCount,
  assertSimulatorComplete,
  assertExecutedStep,
} from "./assertions/index.js";

/**
 * Options for creating a test harness
 */
export interface TestHarnessOptions {
  /** Use in-memory EventStore (default: true) */
  inMemory?: boolean;
}

/**
 * Options for spawning a simulator
 */
export interface SpawnSimulatorOptions {
  /** Agent role */
  role: AgentRole;

  /** Behavior script */
  behavior: SimulatedBehavior;

  /** Repository path (uses harness repo if not specified) */
  repoPath?: string;

  /** Task ID to assign */
  taskId?: string;

  /** Parent agent ID */
  parentId?: string;

  /** Stream ID for merge queue isolation */
  streamId?: string;

  /** Custom agent ID */
  agentId?: string;
}

/**
 * TestHarness provides a complete testing environment for multi-agent scenarios
 */
export interface TestHarness {
  // ─────────────────────────────────────────────────────────────────────────
  // Services
  // ─────────────────────────────────────────────────────────────────────────

  /** EventStore for agent and event management */
  readonly eventStore: EventStore;

  /** MessageRouter for inter-agent communication */
  readonly messageRouter: MessageRouter;

  /** TaskManager for task management */
  readonly taskManager: TaskManager;

  /** Services bundle for simulators */
  readonly services: SimulatorServices;

  // ─────────────────────────────────────────────────────────────────────────
  // Repository Management
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Create a temporary repository for testing
   */
  createTempRepo(options?: TempRepoOptions): Promise<TempRepo>;

  /**
   * Get the primary test repository (first one created)
   */
  getRepo(): TempRepo | undefined;

  // ─────────────────────────────────────────────────────────────────────────
  // Simulator Management
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Spawn a new simulator
   */
  spawnSimulator(options: SpawnSimulatorOptions): Promise<AgentSimulator>;

  /**
   * Get a simulator by agent ID
   */
  getSimulator(agentId: string): AgentSimulator | undefined;

  /**
   * Get all registered simulators
   */
  getAllSimulators(): AgentSimulator[];

  /**
   * Get count of registered simulators
   */
  getSimulatorCount(): number;

  // ─────────────────────────────────────────────────────────────────────────
  // Execution Control
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Step all simulators once
   */
  stepAll(): Promise<StepAllResult>;

  /**
   * Run until all simulators are idle (waiting or done)
   */
  runUntilIdle(maxIterations?: number): Promise<StepAllResult>;

  /**
   * Wait for a condition to be met
   */
  waitForCondition(
    condition: () => boolean | Promise<boolean>,
    options?: { timeoutMs?: number; maxIterations?: number }
  ): Promise<void>;

  /**
   * Wait for a specific simulator to complete
   */
  waitForSimulator(
    agentId: string,
    options?: { timeoutMs?: number; maxIterations?: number }
  ): Promise<void>;

  /**
   * Wait for all simulators to complete
   */
  waitForAll(
    options?: { timeoutMs?: number; maxIterations?: number }
  ): Promise<void>;

  // ─────────────────────────────────────────────────────────────────────────
  // Assertions
  // ─────────────────────────────────────────────────────────────────────────

  /** Assert that an agent has terminated */
  assertAgentTerminated(agentId: string): void;

  /** Assert that an agent is in a specific state */
  assertAgentState(agentId: string, state: "running" | "stopped" | "paused"): void;

  /** Assert that a task has a specific status */
  assertTaskStatus(taskId: string, status: "pending" | "assigned" | "in_progress" | "active" | "completed" | "failed"): void;

  /** Assert that a git branch exists */
  assertBranchExists(branch: string): void;

  /** Assert that a branch has been merged */
  assertBranchMerged(source: string, target: string): void;

  /** Assert that an agent has received at least N messages */
  assertMessagesReceived(agentId: string, minCount: number): void;

  /** Assert that an agent has received a specific message */
  assertMessageReceived(agentId: string, contentPattern: string | RegExp): void;

  /** Assert that a file exists */
  assertFileExists(filePath: string): void;

  /** Assert that a file contains content */
  assertFileContains(filePath: string, content: string | RegExp): void;

  /** Assert clean working tree */
  assertCleanWorkingTree(): void;

  /** Assert commit count on branch */
  assertCommitCount(branch: string, count: number): void;

  /** Assert simulator is complete */
  assertSimulatorComplete(agentId: string): void;

  /** Assert simulator executed a step type */
  assertExecutedStep(agentId: string, stepType: string): void;

  // ─────────────────────────────────────────────────────────────────────────
  // Cleanup
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Clean up all resources
   */
  cleanup(): Promise<void>;
}

/**
 * Create a new test harness
 */
export async function createTestHarness(
  options: TestHarnessOptions = {}
): Promise<TestHarness> {
  const { inMemory = true } = options;

  // Initialize services
  const eventStore = await createEventStore({ inMemory });
  const messageRouter = createMessageRouter(eventStore);
  const taskManager = createTaskManager(eventStore);

  const services: SimulatorServices = {
    eventStore,
    messageRouter,
    taskManager,
  };

  // State
  const repos: TempRepo[] = [];
  const simulators = new Map<string, AgentSimulator>();
  const stepper = createEventStepper();

  // Assertion context getter
  const getAssertionContext = (): AssertionContext => ({
    eventStore,
    taskManager,
    messageRouter,
    simulators,
    repoPath: repos[0]?.path || "",
  });

  const harness: TestHarness = {
    // Services
    eventStore,
    messageRouter,
    taskManager,
    services,

    // Repository Management
    async createTempRepo(repoOptions?: TempRepoOptions): Promise<TempRepo> {
      const repo = await createTempRepo(repoOptions);
      repos.push(repo);
      return repo;
    },

    getRepo(): TempRepo | undefined {
      return repos[0];
    },

    // Simulator Management
    async spawnSimulator(opts: SpawnSimulatorOptions): Promise<AgentSimulator> {
      const repoPath = opts.repoPath || repos[0]?.path;
      if (!repoPath) {
        throw new Error("No repository available. Call createTempRepo() first.");
      }

      const config: SimulatorConfig = {
        role: opts.role,
        behavior: opts.behavior,
        repoPath,
        taskId: opts.taskId,
        parentId: opts.parentId,
        streamId: opts.streamId,
        agentId: opts.agentId,
      };

      const simulator = createAgentSimulator(config, services);

      await simulator.start({
        agentId: simulator.agentId,
        role: opts.role,
        workspacePath: repoPath,
        taskId: opts.taskId,
        parentId: opts.parentId,
        streamId: opts.streamId,
        services,
      });

      simulators.set(simulator.agentId, simulator);
      stepper.register(simulator);

      return simulator;
    },

    getSimulator(agentId: string): AgentSimulator | undefined {
      return simulators.get(agentId);
    },

    getAllSimulators(): AgentSimulator[] {
      return Array.from(simulators.values());
    },

    getSimulatorCount(): number {
      return simulators.size;
    },

    // Execution Control
    async stepAll(): Promise<StepAllResult> {
      return stepper.stepAll();
    },

    async runUntilIdle(maxIterations = 1000): Promise<StepAllResult> {
      return stepper.runUntilIdle(maxIterations);
    },

    async waitForCondition(
      condition: () => boolean | Promise<boolean>,
      options?: { timeoutMs?: number; maxIterations?: number }
    ): Promise<void> {
      await stepper.waitForCondition(
        async () => condition(),
        options
      );
    },

    async waitForSimulator(
      agentId: string,
      options?: { timeoutMs?: number; maxIterations?: number }
    ): Promise<void> {
      await stepper.waitForSimulator(agentId, options);
    },

    async waitForAll(
      options?: { timeoutMs?: number; maxIterations?: number }
    ): Promise<void> {
      await stepper.waitForAll(options);
    },

    // Assertions
    assertAgentTerminated(agentId: string): void {
      assertAgentTerminated(getAssertionContext(), agentId);
    },

    assertAgentState(agentId: string, state: "running" | "stopped" | "paused"): void {
      assertAgentState(getAssertionContext(), agentId, state);
    },

    assertTaskStatus(taskId: string, status: "pending" | "assigned" | "in_progress" | "active" | "completed" | "failed"): void {
      assertTaskStatus(getAssertionContext(), taskId, status);
    },

    assertBranchExists(branch: string): void {
      assertBranchExists(getAssertionContext(), branch);
    },

    assertBranchMerged(source: string, target: string): void {
      assertBranchMerged(getAssertionContext(), source, target);
    },

    assertMessagesReceived(agentId: string, minCount: number): void {
      assertMessagesReceived(getAssertionContext(), agentId, minCount);
    },

    assertMessageReceived(agentId: string, contentPattern: string | RegExp): void {
      assertMessageReceived(getAssertionContext(), agentId, contentPattern);
    },

    assertFileExists(filePath: string): void {
      assertFileExists(getAssertionContext(), filePath);
    },

    assertFileContains(filePath: string, content: string | RegExp): void {
      assertFileContains(getAssertionContext(), filePath, content);
    },

    assertCleanWorkingTree(): void {
      assertCleanWorkingTree(getAssertionContext());
    },

    assertCommitCount(branch: string, count: number): void {
      assertCommitCount(getAssertionContext(), branch, count);
    },

    assertSimulatorComplete(agentId: string): void {
      assertSimulatorComplete(getAssertionContext(), agentId);
    },

    assertExecutedStep(agentId: string, stepType: string): void {
      assertExecutedStep(getAssertionContext(), agentId, stepType);
    },

    // Cleanup
    async cleanup(): Promise<void> {
      // Stop all simulators
      for (const simulator of simulators.values()) {
        if (simulator.isRunning()) {
          await simulator.stop();
        }
      }
      simulators.clear();

      // Reset stepper
      stepper.reset();

      // Cleanup repos
      for (const repo of repos) {
        await repo.cleanup();
      }
      repos.length = 0;

      // Close event store
      await eventStore.close();
    },
  };

  return harness;
}
