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
  assertMergeRequestStatus,
  assertTaskMergeRequestStatus,
  assertMergeQueueDepth,
  assertMergeRequestMerged,
  assertMergeRequestConflict,
  assertWorktreeExists,
  assertAgentHasWorktree,
  assertWorktreeBranch,
  assertWorktreeClean,
  assertWorktreeFileExists,
  assertWorktreeFileContains,
} from "./assertions/index.js";
import { MergeQueue, type MergeQueueConfig } from "../../src/workspace/merge-queue/merge-queue.js";
import type { MergeQueueInterface, MergeRequestStatus, SubmitMergeRequestOptions } from "../../src/workspace/merge-queue/types.js";
import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";

/**
 * Options for creating a test harness
 */
export interface TestHarnessOptions {
  /** Use in-memory EventStore (default: true) */
  inMemory?: boolean;

  /** Enable merge queue support (default: false) */
  withMergeQueue?: boolean;

  /** Enable workspace/worktree tracking (default: false) */
  withWorkspaces?: boolean;
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

  /** MergeQueue for coordinating worker merges (if enabled) */
  readonly mergeQueue: MergeQueueInterface | null;

  /** Map of agent IDs to worktree paths (if enabled) */
  readonly worktrees: Map<string, string>;

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
  // Worktree Management
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Create a worktree for an agent from a bare repo
   * Requires withWorkspaces option and a bare repo
   */
  createWorktreeForAgent(
    agentId: string,
    branch: string,
    options?: { baseBranch?: string; streamId?: string }
  ): string;

  /**
   * Remove a worktree for an agent
   */
  removeWorktree(agentId: string): void;

  /**
   * Get worktree path for an agent
   */
  getWorktreePath(agentId: string): string | undefined;

  // ─────────────────────────────────────────────────────────────────────────
  // Merge Queue Operations
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Submit a merge request to the queue
   * Requires withMergeQueue option
   */
  submitMergeRequest(options: SubmitMergeRequestOptions): string;

  /**
   * Process the next merge request in queue for a stream
   * Returns the merge request ID if one was processed
   */
  processNextMergeRequest(
    streamId: string,
    options?: { simulateConflict?: boolean; conflictFiles?: string[] }
  ): string | null;

  /**
   * Process all pending merge requests for a stream
   */
  processAllMergeRequests(
    streamId: string,
    options?: { simulateConflicts?: Map<string, string[]> }
  ): string[];

  /**
   * Get merge queue depth for a stream
   */
  getMergeQueueDepth(streamId: string): number;

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
  // Merge Queue Assertions
  // ─────────────────────────────────────────────────────────────────────────

  /** Assert merge request status */
  assertMergeRequestStatus(mrId: string, status: MergeRequestStatus): void;

  /** Assert merge request for task has specific status */
  assertTaskMergeRequestStatus(taskId: string, status: MergeRequestStatus): void;

  /** Assert merge queue depth for a stream */
  assertMergeQueueDepth(streamId: string, depth: number): void;

  /** Assert merge request is merged */
  assertMergeRequestMerged(mrId: string): void;

  /** Assert merge request has conflicts */
  assertMergeRequestConflict(mrId: string, expectedFiles?: string[]): void;

  // ─────────────────────────────────────────────────────────────────────────
  // Worktree Assertions
  // ─────────────────────────────────────────────────────────────────────────

  /** Assert worktree exists at path */
  assertWorktreeExists(worktreePath: string): void;

  /** Assert agent has a worktree */
  assertAgentHasWorktree(agentId: string): void;

  /** Assert worktree is on specific branch */
  assertWorktreeBranch(worktreePath: string, branch: string): void;

  /** Assert worktree has clean working tree */
  assertWorktreeClean(worktreePath: string): void;

  /** Assert file exists in worktree */
  assertWorktreeFileExists(worktreePath: string, filePath: string): void;

  /** Assert file in worktree contains content */
  assertWorktreeFileContains(worktreePath: string, filePath: string, content: string | RegExp): void;

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
  const { inMemory = true, withMergeQueue = false, withWorkspaces = false } = options;

  // Initialize services
  const eventStore = await createEventStore({ inMemory });
  const messageRouter = createMessageRouter(eventStore);
  const taskManager = createTaskManager(eventStore);

  // State
  const repos: TempRepo[] = [];
  const simulators = new Map<string, AgentSimulator>();
  const stepper = createEventStepper();
  const worktrees = new Map<string, string>();

  // MergeQueue (initialized lazily when withMergeQueue is true)
  let mergeQueue: MergeQueue | null = null;
  let mergeQueueDb: Database.Database | null = null;

  if (withMergeQueue) {
    // Create in-memory database for merge queue
    mergeQueueDb = new Database(":memory:");
    mergeQueue = new MergeQueue({
      db: mergeQueueDb,
      tablePrefix: "test_",
      initSchema: true,
    });
  }

  const services: SimulatorServices = {
    eventStore,
    messageRouter,
    taskManager,
    mergeQueue: mergeQueue ?? undefined,
  };

  // Assertion context getter
  const getAssertionContext = (): AssertionContext => ({
    eventStore,
    taskManager,
    messageRouter,
    simulators,
    repoPath: repos[0]?.path || "",
    mergeQueue: mergeQueue ?? undefined,
    worktrees: withWorkspaces ? worktrees : undefined,
  });

  const harness: TestHarness = {
    // Services
    eventStore,
    messageRouter,
    taskManager,
    services,
    mergeQueue,
    worktrees,

    // Repository Management
    async createTempRepo(repoOptions?: TempRepoOptions): Promise<TempRepo> {
      const repo = await createTempRepo(repoOptions);
      repos.push(repo);
      return repo;
    },

    getRepo(): TempRepo | undefined {
      return repos[0];
    },

    // Worktree Management
    createWorktreeForAgent(
      agentId: string,
      branch: string,
      opts?: { baseBranch?: string; streamId?: string }
    ): string {
      if (!withWorkspaces) {
        throw new Error("Worktree support not enabled. Create harness with withWorkspaces: true");
      }

      const repo = repos[0];
      if (!repo) {
        throw new Error("No repository available. Call createTempRepo() first.");
      }

      const baseBranch = opts?.baseBranch || "main";

      // Create worktree directory
      const worktreePath = path.join(path.dirname(repo.path), "worktrees", agentId);
      fs.mkdirSync(path.dirname(worktreePath), { recursive: true });

      // Create the worktree
      try {
        repo.git(`worktree add ${worktreePath} -b ${branch} ${baseBranch}`);
      } catch (error) {
        // Branch might already exist, try without -b
        repo.git(`worktree add ${worktreePath} ${branch}`);
      }

      worktrees.set(agentId, worktreePath);
      return worktreePath;
    },

    removeWorktree(agentId: string): void {
      if (!withWorkspaces) {
        throw new Error("Worktree support not enabled. Create harness with withWorkspaces: true");
      }

      const worktreePath = worktrees.get(agentId);
      if (!worktreePath) {
        throw new Error(`No worktree found for agent ${agentId}`);
      }

      const repo = repos[0];
      if (repo) {
        try {
          repo.git(`worktree remove ${worktreePath} --force`);
        } catch {
          // Ignore errors during cleanup
        }
      }

      worktrees.delete(agentId);
    },

    getWorktreePath(agentId: string): string | undefined {
      return worktrees.get(agentId);
    },

    // Merge Queue Operations
    submitMergeRequest(opts: SubmitMergeRequestOptions): string {
      if (!mergeQueue) {
        throw new Error("Merge queue not enabled. Create harness with withMergeQueue: true");
      }
      return mergeQueue.submit(opts);
    },

    processNextMergeRequest(
      streamId: string,
      opts?: { simulateConflict?: boolean; conflictFiles?: string[] }
    ): string | null {
      if (!mergeQueue) {
        throw new Error("Merge queue not enabled. Create harness with withMergeQueue: true");
      }

      const mr = mergeQueue.getNext(streamId);
      if (!mr) {
        return null;
      }

      mergeQueue.markProcessing(mr.id);

      if (opts?.simulateConflict) {
        mergeQueue.markConflict(mr.id, opts.conflictFiles || ["conflicting-file.txt"]);
      } else {
        // Simulate successful merge with a fake commit hash
        const fakeCommit = `merge-${mr.id}-${Date.now().toString(36)}`;
        mergeQueue.markMerged(mr.id, fakeCommit);
      }

      return mr.id;
    },

    processAllMergeRequests(
      streamId: string,
      opts?: { simulateConflicts?: Map<string, string[]> }
    ): string[] {
      if (!mergeQueue) {
        throw new Error("Merge queue not enabled. Create harness with withMergeQueue: true");
      }

      const processed: string[] = [];
      let mr = mergeQueue.getNext(streamId);

      while (mr) {
        mergeQueue.markProcessing(mr.id);

        const conflictFiles = opts?.simulateConflicts?.get(mr.id);
        if (conflictFiles) {
          mergeQueue.markConflict(mr.id, conflictFiles);
        } else {
          const fakeCommit = `merge-${mr.id}-${Date.now().toString(36)}`;
          mergeQueue.markMerged(mr.id, fakeCommit);
        }

        processed.push(mr.id);
        mr = mergeQueue.getNext(streamId);
      }

      return processed;
    },

    getMergeQueueDepth(streamId: string): number {
      if (!mergeQueue) {
        throw new Error("Merge queue not enabled. Create harness with withMergeQueue: true");
      }
      return mergeQueue.getQueueDepth(streamId);
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

    // Merge Queue Assertions
    assertMergeRequestStatus(mrId: string, status: MergeRequestStatus): void {
      assertMergeRequestStatus(getAssertionContext(), mrId, status);
    },

    assertTaskMergeRequestStatus(taskId: string, status: MergeRequestStatus): void {
      assertTaskMergeRequestStatus(getAssertionContext(), taskId, status);
    },

    assertMergeQueueDepth(streamId: string, depth: number): void {
      assertMergeQueueDepth(getAssertionContext(), streamId, depth);
    },

    assertMergeRequestMerged(mrId: string): void {
      assertMergeRequestMerged(getAssertionContext(), mrId);
    },

    assertMergeRequestConflict(mrId: string, expectedFiles?: string[]): void {
      assertMergeRequestConflict(getAssertionContext(), mrId, expectedFiles);
    },

    // Worktree Assertions
    assertWorktreeExists(worktreePath: string): void {
      assertWorktreeExists(getAssertionContext(), worktreePath);
    },

    assertAgentHasWorktree(agentId: string): void {
      assertAgentHasWorktree(getAssertionContext(), agentId);
    },

    assertWorktreeBranch(worktreePath: string, branch: string): void {
      assertWorktreeBranch(getAssertionContext(), worktreePath, branch);
    },

    assertWorktreeClean(worktreePath: string): void {
      assertWorktreeClean(getAssertionContext(), worktreePath);
    },

    assertWorktreeFileExists(worktreePath: string, filePath: string): void {
      assertWorktreeFileExists(getAssertionContext(), worktreePath, filePath);
    },

    assertWorktreeFileContains(worktreePath: string, filePath: string, content: string | RegExp): void {
      assertWorktreeFileContains(getAssertionContext(), worktreePath, filePath, content);
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

      // Cleanup worktrees before repos
      if (withWorkspaces && repos[0]) {
        for (const [agentId, worktreePath] of worktrees) {
          try {
            repos[0].git(`worktree remove ${worktreePath} --force`);
          } catch {
            // Ignore errors during cleanup
          }
        }
        worktrees.clear();
      }

      // Close merge queue
      if (mergeQueue) {
        mergeQueue.close();
      }
      if (mergeQueueDb) {
        mergeQueueDb.close();
      }

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
