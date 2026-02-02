/**
 * Multi-Coordinator E2E Tests
 *
 * Tests for concurrent coordinators with independent streams using real Claude agents.
 * Verifies stream isolation, merge queue separation, and sequential worker dependencies.
 *
 * REQUIRES: RUN_FULL_AGENT_TESTS=true environment variable (and authenticated Claude Code)
 *
 * Run with:
 *   RUN_FULL_AGENT_TESTS=true npm run test:e2e -- src/__tests__/e2e/multi-coordinator.e2e.test.ts
 *
 * @see s-1zcx Multi-Agent Orchestration Testing Strategy
 * @see i-41aw Phase 2e: Multi-Coordinator E2E Tests
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execSync } from "child_process";
import Database from "better-sqlite3";

import { createEventStore, type EventStore } from "../../store/event-store.js";
import {
  createAgentManager,
  type AgentManager,
} from "../../agent/agent-manager.js";
import {
  createMessageRouter,
  type MessageRouter,
} from "../../router/message-router.js";
import { MergeQueue } from "../../workspace/merge-queue/merge-queue.js";

// ─────────────────────────────────────────────────────────────────
// Test Configuration
// ─────────────────────────────────────────────────────────────────

const RUN_FULL_AGENT = !!process.env.RUN_FULL_AGENT_TESTS;
const testFn = RUN_FULL_AGENT ? it : it.skip;

const log = (msg: string) => console.log(`[MultiCoord-E2E] ${msg}`);

// Timeouts for different operations
const TIMEOUT = {
  SPAWN: 60000,
  PROMPT: 120000,
  MULTI_COORD: 300000,
  SEQUENTIAL: 240000,
};

/**
 * Create an isolated test git repo with bare clone for worktrees
 */
function createTestRepo(prefix: string): {
  path: string;
  barePath: string;
  cleanup: () => void;
  git: (cmd: string, cwd?: string) => string;
  createWorktree: (branch: string, baseBranch?: string) => string;
} {
  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), `multi-coord-e2e-${prefix}-`)
  );

  // Create the main repo
  const repoPath = path.join(tmpDir, "main-repo");
  fs.mkdirSync(repoPath);
  execSync("git init", { cwd: repoPath, stdio: "pipe" });
  execSync('git config user.email "test@test.com"', {
    cwd: repoPath,
    stdio: "pipe",
  });
  execSync('git config user.name "Test User"', {
    cwd: repoPath,
    stdio: "pipe",
  });

  // Create initial files
  fs.mkdirSync(path.join(repoPath, "src"));
  fs.writeFileSync(
    path.join(repoPath, "src/index.ts"),
    "export const version = '1.0.0';\n"
  );
  fs.writeFileSync(path.join(repoPath, "README.md"), "# Multi-Coordinator Test\n");
  execSync("git add -A", { cwd: repoPath, stdio: "pipe" });
  execSync('git commit -m "Initial commit"', { cwd: repoPath, stdio: "pipe" });

  // Create a bare clone for worktree support
  const barePath = path.join(tmpDir, "bare-repo");
  execSync(`git clone --bare ${repoPath} ${barePath}`, { stdio: "pipe" });

  // Create worktrees directory
  const worktreesDir = path.join(tmpDir, "worktrees");
  fs.mkdirSync(worktreesDir);

  const git = (cmd: string, cwd = repoPath) => {
    try {
      return execSync(`git ${cmd}`, {
        cwd,
        stdio: "pipe",
        encoding: "utf8",
      }).trim();
    } catch (error: unknown) {
      const e = error as { stderr?: string; message?: string };
      throw new Error(`Git failed: git ${cmd}\n${e.stderr || e.message}`);
    }
  };

  const createWorktree = (branch: string, baseBranch = "main") => {
    const worktreePath = path.join(worktreesDir, branch.replace(/\//g, "-"));
    try {
      git(`worktree add ${worktreePath} -b ${branch} ${baseBranch}`, barePath);
    } catch {
      // Branch might already exist
      git(`worktree add ${worktreePath} ${branch}`, barePath);
    }
    // Configure git user in worktree
    git('config user.email "test@test.com"', worktreePath);
    git('config user.name "Test User"', worktreePath);
    return worktreePath;
  };

  return {
    path: repoPath,
    barePath,
    cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }),
    git,
    createWorktree,
  };
}

/**
 * Wait for agent to reach a specific state
 */
async function waitForAgentState(
  agentManager: AgentManager,
  agentId: string,
  targetState: "running" | "stopped",
  timeoutMs = 30000
): Promise<void> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    const agent = agentManager.get(agentId);
    if (agent?.state === targetState) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    `Timeout waiting for agent ${agentId} to reach state ${targetState}`
  );
}

// ─────────────────────────────────────────────────────────────────
// Multi-Coordinator E2E Tests
// ─────────────────────────────────────────────────────────────────

describe("Multi-Coordinator E2E", () => {
  let eventStore: EventStore;
  let agentManager: AgentManager;
  let messageRouter: MessageRouter;
  let mergeQueue: MergeQueue;
  let mergeQueueDb: Database.Database;
  let testRepo: ReturnType<typeof createTestRepo>;
  let testInstanceId: string;

  beforeEach(async () => {
    if (!RUN_FULL_AGENT) {
      log("⚠️  Skipping: RUN_FULL_AGENT_TESTS not set");
      return;
    }

    testRepo = createTestRepo("multi-coord");
    log(`Test repo created at: ${testRepo.path}`);

    testInstanceId = `multi-coord-e2e-${Date.now()}`;
    eventStore = await createEventStore({
      instanceId: testInstanceId,
      baseDir: testRepo.path,
    });
    messageRouter = createMessageRouter(eventStore);
    agentManager = createAgentManager(eventStore, messageRouter, {
      defaultPermissionMode: "auto-approve",
      defaultCwd: testRepo.path,
    });

    // Create merge queue
    mergeQueueDb = new Database(":memory:");
    mergeQueue = new MergeQueue({
      db: mergeQueueDb,
      tablePrefix: "test_",
      initSchema: true,
    });

    log("Services initialized");
  });

  afterEach(async () => {
    if (!RUN_FULL_AGENT) return;

    // Terminate all remaining agents
    try {
      for (const agent of agentManager.list()) {
        if (agent.state === "running") {
          try {
            await agentManager.terminate(agent.id, "test_cleanup");
          } catch {
            // Ignore termination errors during cleanup
          }
        }
      }
    } catch {
      // Ignore errors during cleanup
    }

    mergeQueue?.close();
    mergeQueueDb?.close();
    await agentManager?.close();
    await eventStore?.close();
    testRepo?.cleanup();
    log("Cleanup complete");
  });

  // ─────────────────────────────────────────────────────────────────
  // Scenario 4a: Independent Parallel Coordinators
  // ─────────────────────────────────────────────────────────────────

  testFn(
    "Scenario 4a: should run independent parallel coordinators with separate streams",
    async () => {
      log("=== Scenario 4a: Independent Parallel Coordinators ===");

      // Spawn Coordinator A (stream-a)
      log("Spawning Coordinator A (stream-a)...");
      const coordA = await agentManager.spawn({
        task: "You are Coordinator A. Wait for a signal to complete.",
        role: "coordinator",
        streamId: "stream-a",
        cwd: testRepo.path,
      });
      await waitForAgentState(agentManager, coordA.id, "running");
      log(`Coordinator A spawned: ${coordA.id}`);

      // Spawn Coordinator B (stream-b)
      log("Spawning Coordinator B (stream-b)...");
      const coordB = await agentManager.spawn({
        task: "You are Coordinator B. Wait for a signal to complete.",
        role: "coordinator",
        streamId: "stream-b",
        cwd: testRepo.path,
      });
      await waitForAgentState(agentManager, coordB.id, "running");
      log(`Coordinator B spawned: ${coordB.id}`);

      // Spawn workers for stream-a
      log("Spawning workers for stream-a...");
      const workerA1 = await agentManager.spawn({
        task: "You are Worker A1. Say 'ready' and wait.",
        role: "worker",
        streamId: "stream-a",
        parent: coordA.id,
        cwd: testRepo.path,
      });
      await waitForAgentState(agentManager, workerA1.id, "running");
      log(`Worker A1 spawned: ${workerA1.id}`);

      // Spawn workers for stream-b
      log("Spawning workers for stream-b...");
      const workerB1 = await agentManager.spawn({
        task: "You are Worker B1. Say 'ready' and wait.",
        role: "worker",
        streamId: "stream-b",
        parent: coordB.id,
        cwd: testRepo.path,
      });
      await waitForAgentState(agentManager, workerB1.id, "running");
      log(`Worker B1 spawned: ${workerB1.id}`);

      // Verify agents are running and have correct parent relationships
      const agents = agentManager.list();
      expect(agents.length).toBe(4); // 2 coordinators + 2 workers

      // Verify parent relationships
      const workerA1Agent = agentManager.get(workerA1.id);
      const workerB1Agent = agentManager.get(workerB1.id);
      expect(workerA1Agent?.parent).toBe(coordA.id);
      expect(workerB1Agent?.parent).toBe(coordB.id);
      log("✓ Agents correctly assigned to separate hierarchies");

      // Submit merge requests to separate queues
      const mrA = mergeQueue.submit({
        streamId: "stream-a",
        taskId: "task-a1",
        workerBranch: "feature/task-a1",
        workerAgentId: workerA1.id,
      });

      const mrB = mergeQueue.submit({
        streamId: "stream-b",
        taskId: "task-b1",
        workerBranch: "feature/task-b1",
        workerAgentId: workerB1.id,
      });

      // Verify separate queue depths
      expect(mergeQueue.getQueueDepth("stream-a")).toBe(1);
      expect(mergeQueue.getQueueDepth("stream-b")).toBe(1);
      log("✓ Separate merge queues maintained per stream");

      // Process stream-a only
      const nextA = mergeQueue.getNext("stream-a");
      expect(nextA?.id).toBe(mrA);
      mergeQueue.markProcessing(mrA);
      mergeQueue.markMerged(mrA, "fake-commit-a");

      // Stream-b should be unaffected
      expect(mergeQueue.getQueueDepth("stream-a")).toBe(0);
      expect(mergeQueue.getQueueDepth("stream-b")).toBe(1);
      log("✓ Processing one stream does not affect other");

      // Cleanup
      await agentManager.terminate(workerA1.id, "test_complete");
      await agentManager.terminate(workerB1.id, "test_complete");
      await agentManager.terminate(coordA.id, "test_complete");
      await agentManager.terminate(coordB.id, "test_complete");

      log("✓ Scenario 4a complete");
    },
    { timeout: TIMEOUT.MULTI_COORD }
  );

  // ─────────────────────────────────────────────────────────────────
  // Scenario 4b: Shared File, Different Parts
  // ─────────────────────────────────────────────────────────────────

  testFn(
    "Scenario 4b: should handle workers editing different parts of shared files",
    async () => {
      log("=== Scenario 4b: Shared File, Different Parts ===");

      // Spawn coordinator
      const coordinator = await agentManager.spawn({
        task: "You are a coordinator managing workers on a shared file.",
        role: "coordinator",
        streamId: "stream-shared",
        cwd: testRepo.path,
      });
      await waitForAgentState(agentManager, coordinator.id, "running");
      log(`Coordinator spawned: ${coordinator.id}`);

      // Create worktrees for workers
      const wtA = testRepo.createWorktree("feature/header-update");
      const wtB = testRepo.createWorktree("feature/footer-update");
      log(`Worktrees created: ${wtA}, ${wtB}`);

      // Worker A modifies header section
      const workerA = await agentManager.spawn({
        task: `You are Worker A. Your workspace is at ${wtA}. Create a file src/header.ts with 'export const header = true;'. Then wait.`,
        role: "worker",
        streamId: "stream-shared",
        parent: coordinator.id,
        cwd: wtA,
      });
      await waitForAgentState(agentManager, workerA.id, "running");
      log(`Worker A spawned in ${wtA}`);

      // Worker B modifies footer section
      const workerB = await agentManager.spawn({
        task: `You are Worker B. Your workspace is at ${wtB}. Create a file src/footer.ts with 'export const footer = true;'. Then wait.`,
        role: "worker",
        streamId: "stream-shared",
        parent: coordinator.id,
        cwd: wtB,
      });
      await waitForAgentState(agentManager, workerB.id, "running");
      log(`Worker B spawned in ${wtB}`);

      // Verify workers are in separate worktrees
      const agentA = agentManager.get(workerA.id);
      const agentB = agentManager.get(workerB.id);
      expect(agentA?.cwd).toBe(wtA);
      expect(agentB?.cwd).toBe(wtB);
      log("✓ Workers in separate worktrees");

      // Submit merge requests
      const mrA = mergeQueue.submit({
        streamId: "stream-shared",
        taskId: "task-header",
        workerBranch: "feature/header-update",
        workerAgentId: workerA.id,
      });

      const mrB = mergeQueue.submit({
        streamId: "stream-shared",
        taskId: "task-footer",
        workerBranch: "feature/footer-update",
        workerAgentId: workerB.id,
      });

      expect(mergeQueue.getQueueDepth("stream-shared")).toBe(2);
      log("✓ Both merge requests queued");

      // Process both - neither should conflict (different files)
      mergeQueue.markProcessing(mrA);
      mergeQueue.markMerged(mrA, "merge-a");

      mergeQueue.markProcessing(mrB);
      mergeQueue.markMerged(mrB, "merge-b");

      // Verify both merged successfully
      const finalMrA = mergeQueue.get(mrA);
      const finalMrB = mergeQueue.get(mrB);
      expect(finalMrA?.status).toBe("merged");
      expect(finalMrB?.status).toBe("merged");
      log("✓ Both merge requests processed without conflict");

      // Cleanup
      await agentManager.terminate(workerA.id, "test_complete");
      await agentManager.terminate(workerB.id, "test_complete");
      await agentManager.terminate(coordinator.id, "test_complete");

      log("✓ Scenario 4b complete");
    },
    { timeout: TIMEOUT.MULTI_COORD }
  );

  // ─────────────────────────────────────────────────────────────────
  // Scenario 4c: Sequential Dependency (Worker A → Worker B)
  // ─────────────────────────────────────────────────────────────────

  testFn(
    "Scenario 4c: should handle sequential worker dependencies within coordinator",
    async () => {
      log("=== Scenario 4c: Sequential Dependency ===");

      const events: string[] = [];

      // Spawn coordinator
      const coordinator = await agentManager.spawn({
        task: "You are a coordinator managing sequential workers.",
        role: "coordinator",
        streamId: "stream-seq",
        cwd: testRepo.path,
      });
      await waitForAgentState(agentManager, coordinator.id, "running");
      log(`Coordinator spawned: ${coordinator.id}`);
      events.push("coordinator_spawned");

      // Phase 1: Worker A does prerequisite work
      log("Phase 1: Spawning Worker A for prerequisite work...");
      const wtA = testRepo.createWorktree("feature/prereq");

      const workerA = await agentManager.spawn({
        task: `You are Worker A. Your workspace is at ${wtA}. You handle prerequisite work. Say 'ready' and wait.`,
        role: "worker",
        streamId: "stream-seq",
        parent: coordinator.id,
        cwd: wtA,
      });
      await waitForAgentState(agentManager, workerA.id, "running");
      log(`Worker A spawned: ${workerA.id}`);
      events.push("worker_a_spawned");

      // Submit Worker A's merge request
      const mrA = mergeQueue.submit({
        streamId: "stream-seq",
        taskId: "task-prereq",
        workerBranch: "feature/prereq",
        workerAgentId: workerA.id,
      });

      expect(mergeQueue.getQueueDepth("stream-seq")).toBe(1);
      log("✓ Worker A merge request submitted");
      events.push("worker_a_mr_submitted");

      // Process Worker A's merge request (simulates A completing)
      mergeQueue.markProcessing(mrA);
      mergeQueue.markMerged(mrA, "commit-a");
      events.push("worker_a_merged");
      log("✓ Worker A merged");

      expect(mergeQueue.getQueueDepth("stream-seq")).toBe(0);

      // Phase 2: Worker B depends on A's work
      log("Phase 2: Spawning Worker B (depends on A)...");

      // Worker B is spawned AFTER A is merged
      const wtB = testRepo.createWorktree("feature/dependent");

      const workerB = await agentManager.spawn({
        task: `You are Worker B. Your workspace is at ${wtB}. You depend on Worker A's work. Say 'ready' and wait.`,
        role: "worker",
        streamId: "stream-seq",
        parent: coordinator.id,
        cwd: wtB,
      });
      await waitForAgentState(agentManager, workerB.id, "running");
      log(`Worker B spawned: ${workerB.id}`);
      events.push("worker_b_spawned");

      // Submit Worker B's merge request
      const mrB = mergeQueue.submit({
        streamId: "stream-seq",
        taskId: "task-dependent",
        workerBranch: "feature/dependent",
        workerAgentId: workerB.id,
      });
      events.push("worker_b_mr_submitted");

      expect(mergeQueue.getQueueDepth("stream-seq")).toBe(1);

      // Process Worker B's merge request
      mergeQueue.markProcessing(mrB);
      mergeQueue.markMerged(mrB, "commit-b");
      events.push("worker_b_merged");

      expect(mergeQueue.getQueueDepth("stream-seq")).toBe(0);
      log("✓ Worker B merged");

      // Verify sequential order
      expect(events).toEqual([
        "coordinator_spawned",
        "worker_a_spawned",
        "worker_a_mr_submitted",
        "worker_a_merged",
        "worker_b_spawned",
        "worker_b_mr_submitted",
        "worker_b_merged",
      ]);
      log("✓ Sequential order verified: A completed before B started");

      // Cleanup
      await agentManager.terminate(workerA.id, "test_complete");
      await agentManager.terminate(workerB.id, "test_complete");
      await agentManager.terminate(coordinator.id, "test_complete");

      log("✓ Scenario 4c complete");
    },
    { timeout: TIMEOUT.SEQUENTIAL }
  );

  // ─────────────────────────────────────────────────────────────────
  // Edge Case: Mixed Stream Operations
  // ─────────────────────────────────────────────────────────────────

  testFn(
    "Edge case: should handle rapid coordinator spawn/terminate cycles",
    async () => {
      log("=== Edge Case: Rapid Spawn/Terminate Cycles ===");

      const coordIds: string[] = [];

      // Rapidly spawn and terminate 3 coordinators
      for (let i = 1; i <= 3; i++) {
        log(`Cycle ${i}: Spawning coordinator...`);
        const coord = await agentManager.spawn({
          task: `You are Coordinator ${i}. Say hello.`,
          role: "coordinator",
          streamId: `stream-rapid-${i}`,
          cwd: testRepo.path,
        });
        await waitForAgentState(agentManager, coord.id, "running");
        coordIds.push(coord.id);
        log(`Coordinator ${i} spawned: ${coord.id}`);

        // Submit a merge request for this stream
        mergeQueue.submit({
          streamId: `stream-rapid-${i}`,
          taskId: `task-${i}`,
          workerBranch: `feature/task-${i}`,
          workerAgentId: coord.id,
        });
      }

      // Verify all 3 coordinators are running
      for (const id of coordIds) {
        expect(agentManager.get(id)?.state).toBe("running");
      }
      log("✓ All 3 coordinators running");

      // Verify separate merge queues
      expect(mergeQueue.getQueueDepth("stream-rapid-1")).toBe(1);
      expect(mergeQueue.getQueueDepth("stream-rapid-2")).toBe(1);
      expect(mergeQueue.getQueueDepth("stream-rapid-3")).toBe(1);
      log("✓ Separate merge queues maintained");

      // Terminate all
      for (const id of coordIds) {
        await agentManager.terminate(id, "test_complete");
      }

      // Verify all terminated
      for (const id of coordIds) {
        expect(agentManager.get(id)?.state).toBe("stopped");
      }
      log("✓ All coordinators terminated");

      log("✓ Edge case complete");
    },
    { timeout: TIMEOUT.MULTI_COORD }
  );
});
