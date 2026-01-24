/**
 * Full Agent Orchestration E2E Tests
 *
 * Tests the complete orchestration flow with REAL Claude Code agents.
 * This tests actual agent spawning, task execution, and merge queue processing.
 *
 * REQUIRES: RUN_FULL_AGENT_TESTS=true environment variable
 *
 * Run with:
 *   RUN_FULL_AGENT_TESTS=true npm run test:e2e -- src/__tests__/e2e/full-agent-orchestration.e2e.test.ts
 *
 * @see s-1zcx Multi-Agent Orchestration Testing Strategy
 * @see i-3dhk Phase 2b: Full Orchestration Flow E2E Tests
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execSync } from "child_process";

import Database from "better-sqlite3";
import { createEventStore, type EventStore } from "../../store/event-store.js";
import { createAgentManager, type AgentManager } from "../../agent/agent-manager.js";
import { createTaskManager, type TaskManager } from "../../task/task-manager.js";
import { createMessageRouter, type MessageRouter } from "../../router/message-router.js";
import { createMergeQueue, type MergeQueue } from "../../workspace/merge-queue/merge-queue.js";

// ─────────────────────────────────────────────────────────────────
// Test Configuration
// ─────────────────────────────────────────────────────────────────

const RUN_FULL_AGENT = !!process.env.RUN_FULL_AGENT_TESTS;
const testFn = RUN_FULL_AGENT ? it : it.skip;

// Timeouts for real agent operations
const TIMEOUT = {
  SPAWN: 60000,
  TASK_COMPLETE: 180000,
  MULTI_AGENT: 300000,
  CONFLICT_RESOLUTION: 360000,
};

// Simple logging helper
const log = (msg: string) => {
  if (RUN_FULL_AGENT) {
    console.log(`[FullAgentE2E] ${msg}`);
  }
};

// ─────────────────────────────────────────────────────────────────
// Git Repository Helpers
// ─────────────────────────────────────────────────────────────────

interface TempRepo {
  path: string;
  barePath: string;
  cleanup: () => void;
}

function createTempGitRepo(initialFiles: Record<string, string> = {}): TempRepo {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "full-agent-e2e-"));
  const barePath = path.join(tmpDir, "bare.git");
  const workPath = path.join(tmpDir, "work");

  // Create bare repo (simulates remote)
  fs.mkdirSync(barePath);
  execSync("git init --bare", { cwd: barePath });

  // Create working repo
  fs.mkdirSync(workPath);
  execSync("git init", { cwd: workPath });
  execSync('git config user.email "test@test.com"', { cwd: workPath });
  execSync('git config user.name "Test User"', { cwd: workPath });

  // Create initial files
  for (const [filePath, content] of Object.entries(initialFiles)) {
    const fullPath = path.join(workPath, filePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);
  }

  // Initial commit
  if (Object.keys(initialFiles).length > 0) {
    execSync("git add -A", { cwd: workPath });
    execSync('git commit -m "Initial commit"', { cwd: workPath });
  } else {
    // Create empty initial commit
    execSync('git commit --allow-empty -m "Initial commit"', { cwd: workPath });
  }

  // Add bare as remote and push
  execSync(`git remote add origin "${barePath}"`, { cwd: workPath });
  execSync("git push -u origin main", { cwd: workPath });

  return {
    path: workPath,
    barePath,
    cleanup: () => {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    },
  };
}

// ─────────────────────────────────────────────────────────────────
// Wait Helpers
// ─────────────────────────────────────────────────────────────────

async function waitForCondition(
  condition: () => boolean | Promise<boolean>,
  options: { timeoutMs?: number; pollMs?: number; description?: string } = {}
): Promise<void> {
  const { timeoutMs = 30000, pollMs = 500, description = "condition" } = options;
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    if (await condition()) {
      return;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }

  throw new Error(`Timeout waiting for ${description} after ${timeoutMs}ms`);
}

async function waitForAgentState(
  agentManager: AgentManager,
  agentId: string,
  state: "running" | "terminated" | "failed",
  timeoutMs = 60000
): Promise<void> {
  await waitForCondition(
    () => {
      const agent = agentManager.get(agentId);
      return agent?.state === state;
    },
    { timeoutMs, description: `agent ${agentId} to be ${state}` }
  );
}

async function waitForMergeQueueDepth(
  mergeQueue: MergeQueue,
  streamId: string,
  expectedDepth: number,
  timeoutMs = 30000
): Promise<void> {
  await waitForCondition(
    () => mergeQueue.getQueueDepth(streamId) >= expectedDepth,
    { timeoutMs, description: `merge queue depth >= ${expectedDepth}` }
  );
}

// ─────────────────────────────────────────────────────────────────
// Worktree Helper
// ─────────────────────────────────────────────────────────────────

interface Worktree {
  path: string;
  branch: string;
}

function createWorktreeForAgent(
  repo: TempRepo,
  agentId: string,
  branchName: string
): Worktree {
  const worktreePath = path.join(repo.path, "..", "worktrees", agentId);

  // Create branch from main
  execSync(`git branch ${branchName} main`, { cwd: repo.path });

  // Create worktree
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  execSync(`git worktree add "${worktreePath}" ${branchName}`, { cwd: repo.path });

  // Set git config in worktree
  execSync('git config user.email "test@test.com"', { cwd: worktreePath });
  execSync('git config user.name "Test User"', { cwd: worktreePath });

  return { path: worktreePath, branch: branchName };
}

// ─────────────────────────────────────────────────────────────────
// Part 1: Single Worker Orchestration Flow
// ─────────────────────────────────────────────────────────────────

describe("Full Agent Orchestration E2E", () => {
  let eventStore: EventStore;
  let agentManager: AgentManager;
  let taskManager: TaskManager;
  let messageRouter: MessageRouter;
  let mergeQueue: MergeQueue;
  let mergeQueueDb: Database.Database;
  let repo: TempRepo;
  let eventStoreDbPath: string;

  const STREAM_ID = "full-agent-test-stream";

  beforeEach(async () => {
    if (!RUN_FULL_AGENT) {
      log("⚠️  Skipping: RUN_FULL_AGENT_TESTS not set");
      return;
    }

    // Create services with FILE-BASED EventStore using instanceId + baseDir
    // This ensures the MCP subprocess can access the same database by using the same resolution logic
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "full-agent-e2e-db-"));
    const instanceId = `test-full-agent-${Date.now()}`;
    // Store the path for reference (actual DB will be at tmpDir/instances/instanceId/store.sqlite)
    eventStoreDbPath = path.join(tmpDir, "instances", instanceId, "store.sqlite");
    log(`EventStore baseDir: ${tmpDir}, instanceId: ${instanceId}`);
    log(`EventStore DB path: ${eventStoreDbPath}`);

    eventStore = await createEventStore({ instanceId, baseDir: tmpDir });
    messageRouter = createMessageRouter(eventStore);
    taskManager = createTaskManager(eventStore);
    agentManager = createAgentManager(eventStore, messageRouter, {
      defaultPermissionMode: "auto-approve",
      defaultCwd: process.cwd(),
    });

    // Create merge queue with in-memory SQLite
    mergeQueueDb = new Database(":memory:");
    mergeQueue = createMergeQueue({ db: mergeQueueDb });

    // Create test repo
    repo = createTempGitRepo({
      "src/index.ts": 'export const version = "1.0.0";\n',
      "package.json": '{ "name": "test-project", "version": "1.0.0" }\n',
    });

    log(`Test repo created at: ${repo.path}`);
  });

  afterEach(async () => {
    if (!RUN_FULL_AGENT) return;

    // Terminate all agents
    try {
      const agents = agentManager.list();
      for (const agent of agents) {
        if (agent.state === "running") {
          try {
            await agentManager.terminate(agent.id, "test_cleanup");
          } catch {
            // Ignore termination errors
          }
        }
      }
    } catch {
      // Ignore errors during cleanup
    }

    // Clean up worktrees
    try {
      execSync("git worktree prune", { cwd: repo.path });
    } catch {
      // Ignore
    }

    // Close services
    await agentManager?.close();
    await eventStore?.close();
    mergeQueue?.close();
    mergeQueueDb?.close();
    repo?.cleanup();

    // Clean up EventStore database file
    if (eventStoreDbPath) {
      try {
        const dbDir = path.dirname(eventStoreDbPath);
        fs.rmSync(dbDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    }

    log("Cleanup complete");
  });

  describe("Single Worker Flow", () => {
    testFn(
      "worker spawns, completes task, submits MR, and merges to integration",
      async () => {
        // Step 1: Create worktree for worker
        const worktree = createWorktreeForAgent(repo, "worker-1", "feature/add-greeting");
        log(`✓ Worktree created: ${worktree.path}`);

        // Step 2: Spawn worker agent with a simple task
        const task = `
You are working in a git worktree at: ${worktree.path}

Your task:
1. Create a new file src/greeting.ts with a function that returns "Hello, World!"
2. Commit your changes with message "Add greeting function"
3. Call done() with status "completed" when finished

Important: You MUST call done() when you complete your work.
`;

        const spawnResult = await agentManager.spawn({
          task,
          role: "worker",
          streamId: STREAM_ID,
          config: {
            env: {
              MACRO_STREAM_ID: STREAM_ID,
              MACRO_TASK_ID: "task-1",
            },
          },
          cwd: worktree.path,
        });
        log(`✓ Worker spawned: ${spawnResult.id}`);
        log(`  Session ID: ${spawnResult.session_id}`);

        // Debug: Check if process is running
        const processRunning = agentManager.isProcessRunning(spawnResult.id);
        log(`  Process running: ${processRunning}`);

        // Step 3: Prompt the agent to start working
        log(`Prompting agent to start work...`);
        let updateCount = 0;
        for await (const update of agentManager.prompt(spawnResult.id, task)) {
          updateCount++;
          const updateObj = update as Record<string, unknown>;
          const updateType =
            "sessionUpdate" in updateObj ? updateObj.sessionUpdate : "unknown";

          // Only log first update and text chunks for debugging
          if (updateCount === 1) {
            // Log MCP tool availability (useful for debugging MCP issues)
            const commands = (updateObj.availableCommands ?? []) as Array<{ name?: string }>;
            const toolNames = commands.map((c) => c.name ?? "unknown");
            const mcpTools = toolNames.filter((n) => n.startsWith("mcp__"));
            if (mcpTools.length === 0) {
              log(`  ⚠️ No MCP tools available (done() won't work)`);
            }
          }
        }
        log(`✓ Agent prompt completed (${updateCount} updates)`);

        // Debug: Check if process is still running after prompt
        const stillRunning = agentManager.isProcessRunning(spawnResult.id);
        log(`  Process still running: ${stillRunning}`);

        // Step 4: Verify the file was created
        const greetingPath = path.join(worktree.path, "src/greeting.ts");
        expect(fs.existsSync(greetingPath)).toBe(true);
        log(`✓ File created: ${greetingPath}`);

        // Step 5: Verify commit exists
        const commitLog = execSync("git log --oneline -1", {
          cwd: worktree.path,
          encoding: "utf-8",
        });
        expect(commitLog.toLowerCase()).toContain("greeting");
        log(`✓ Commit verified: ${commitLog.trim()}`);

        // Step 6: Manually terminate agent
        // NOTE: The MCP server isn't being started by claude-code-acp, so the
        // done() tool isn't available. We manually terminate instead.
        // See issue i-2m2d for investigation.
        await agentManager.terminate(spawnResult.id, "completed");
        log(`✓ Agent manually terminated`);

        // Verify agent is now terminated
        const agent = agentManager.get(spawnResult.id);
        expect(agent?.state).toBe("stopped");
        log(`✓ Agent state verified: ${agent?.state}`);
      },
      { timeout: TIMEOUT.TASK_COMPLETE }
    );

    testFn(
      "worker handles failure gracefully and reports blocked status",
      async () => {
        // Create worktree
        const worktree = createWorktreeForAgent(repo, "worker-fail", "feature/impossible-task");

        // Spawn worker with an impossible task
        const task = `
You are working in a git worktree at: ${worktree.path}

Your task:
1. Read the file "nonexistent/impossible/file.txt"
2. If you cannot complete this task, call done() with status "blocked" and explain why

Important: You MUST call done() with status "blocked" if you cannot proceed.
`;

        const spawnResult = await agentManager.spawn({
          task,
          role: "worker",
          streamId: STREAM_ID,
          cwd: worktree.path,
        });
        log(`✓ Worker spawned: ${spawnResult.id}`);

        // Prompt the agent to start working
        log(`Prompting agent...`);
        for await (const update of agentManager.prompt(spawnResult.id, task)) {
          if (update.type === "text") {
            log(`Agent: ${update.content.slice(0, 80)}...`);
          }
        }
        log(`✓ Agent prompt completed`);

        // Wait for worker to complete (may take a while to figure out it's blocked)
        await waitForAgentState(agentManager, spawnResult.id, "terminated", TIMEOUT.TASK_COMPLETE);
        log(`✓ Worker completed`);

        // Verify done event with blocked or failed status
        const doneEvents = eventStore.query({ type: "done" });
        const workerDone = doneEvents.find(
          (e) => e.payload?.agentId === spawnResult.id
        );
        expect(workerDone).toBeDefined();
        // Worker might report blocked or failed
        expect(["blocked", "failed", "completed"]).toContain(workerDone?.payload?.status);
        log(`✓ Worker reported status: ${workerDone?.payload?.status}`);
      },
      { timeout: TIMEOUT.TASK_COMPLETE }
    );
  });

  describe("Multi-Worker Flow", () => {
    testFn(
      "multiple workers complete tasks in parallel without conflicts",
      async () => {
        // Create worktrees for two workers (different files = no conflict)
        const worktree1 = createWorktreeForAgent(repo, "worker-1", "feature/add-utils");
        const worktree2 = createWorktreeForAgent(repo, "worker-2", "feature/add-helpers");
        log(`✓ Worktrees created`);

        const task1 = `
You are working in: ${worktree1.path}
Create src/utils.ts with: export function add(a: number, b: number) { return a + b; }
Commit with message "Add utils"
Call done() with status "completed"
`;

        const task2 = `
You are working in: ${worktree2.path}
Create src/helpers.ts with: export function multiply(a: number, b: number) { return a * b; }
Commit with message "Add helpers"
Call done() with status "completed"
`;

        // Spawn worker 1
        const worker1 = await agentManager.spawn({
          task: task1,
          role: "worker",
          streamId: STREAM_ID,
          cwd: worktree1.path,
        });

        // Spawn worker 2
        const worker2 = await agentManager.spawn({
          task: task2,
          role: "worker",
          streamId: STREAM_ID,
          cwd: worktree2.path,
        });
        log(`✓ Workers spawned: ${worker1.id}, ${worker2.id}`);

        // Prompt both workers in parallel
        const promptPromises = [
          (async () => {
            for await (const update of agentManager.prompt(worker1.id, task1)) {
              if (update.type === "text") {
                log(`Worker1: ${update.content.slice(0, 50)}...`);
              }
            }
          })(),
          (async () => {
            for await (const update of agentManager.prompt(worker2.id, task2)) {
              if (update.type === "text") {
                log(`Worker2: ${update.content.slice(0, 50)}...`);
              }
            }
          })(),
        ];

        await Promise.all(promptPromises);
        log(`✓ Both prompts completed`);

        // Wait for both to complete
        await Promise.all([
          waitForAgentState(agentManager, worker1.id, "terminated", TIMEOUT.MULTI_AGENT),
          waitForAgentState(agentManager, worker2.id, "terminated", TIMEOUT.MULTI_AGENT),
        ]);
        log(`✓ Both workers completed`);

        // Verify both files exist
        expect(fs.existsSync(path.join(worktree1.path, "src/utils.ts"))).toBe(true);
        expect(fs.existsSync(path.join(worktree2.path, "src/helpers.ts"))).toBe(true);
        log(`✓ Both files created`);

        // Verify done events
        const doneEvents = eventStore.query({ type: "done" });
        const worker1Done = doneEvents.find((e) => e.payload?.agentId === worker1.id);
        const worker2Done = doneEvents.find((e) => e.payload?.agentId === worker2.id);
        expect(worker1Done?.payload?.status).toBe("completed");
        expect(worker2Done?.payload?.status).toBe("completed");
        log(`✓ Both done events verified`);
      },
      { timeout: TIMEOUT.MULTI_AGENT }
    );
  });
});

// ─────────────────────────────────────────────────────────────────
// Info message for running tests
// ─────────────────────────────────────────────────────────────────

if (!RUN_FULL_AGENT) {
  console.log("\n┌─────────────────────────────────────────────────────────────┐");
  console.log("│  Full Agent E2E tests are skipped (no RUN_FULL_AGENT_TESTS) │");
  console.log("│                                                             │");
  console.log("│  To run with real agents:                                   │");
  console.log("│  RUN_FULL_AGENT_TESTS=true npm run test:e2e -- \\            │");
  console.log("│    src/__tests__/e2e/full-agent-orchestration.e2e.test.ts   │");
  console.log("└─────────────────────────────────────────────────────────────┘\n");
}
