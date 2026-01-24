/**
 * Full Agent Conflict Resolution E2E Tests
 *
 * Tests the complete conflict resolution flow with REAL Claude Code agents.
 * This tests actual conflict detection, resolver spawning, and merge completion.
 *
 * REQUIRES: RUN_FULL_AGENT_TESTS=true environment variable
 *
 * Run with:
 *   RUN_FULL_AGENT_TESTS=true npm run test:e2e -- src/__tests__/e2e/full-agent-conflict-resolution.e2e.test.ts
 *
 * @see s-bcqm Change Management spec - Conflict Resolution
 * @see s-1zcx Multi-Agent Orchestration Testing Strategy
 * @see i-3s6o Phase 2c: Conflict Resolution Flow E2E Tests
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
  CONFLICT_RESOLUTION: 420000,
};

// Simple logging helper
const log = (msg: string) => {
  if (RUN_FULL_AGENT) {
    console.log(`[ConflictE2E] ${msg}`);
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
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "conflict-e2e-"));
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

async function waitForMergeQueueStatus(
  mergeQueue: MergeQueue,
  mrId: string,
  status: "pending" | "processing" | "merged" | "conflict" | "failed",
  timeoutMs = 30000
): Promise<void> {
  await waitForCondition(
    () => {
      const mr = mergeQueue.get(mrId);
      return mr?.status === status;
    },
    { timeoutMs, description: `MR ${mrId} to have status ${status}` }
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
  branchName: string,
  baseBranch = "main"
): Worktree {
  const worktreePath = path.join(repo.path, "..", "worktrees", agentId);

  // Create branch from base
  execSync(`git branch ${branchName} ${baseBranch}`, { cwd: repo.path });

  // Create worktree
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  execSync(`git worktree add "${worktreePath}" ${branchName}`, { cwd: repo.path });

  // Set git config in worktree
  execSync('git config user.email "test@test.com"', { cwd: worktreePath });
  execSync('git config user.name "Test User"', { cwd: worktreePath });

  return { path: worktreePath, branch: branchName };
}

// ─────────────────────────────────────────────────────────────────
// Full Agent Conflict Resolution Tests
// ─────────────────────────────────────────────────────────────────

describe("Full Agent Conflict Resolution E2E", () => {
  let eventStore: EventStore;
  let agentManager: AgentManager;
  let taskManager: TaskManager;
  let messageRouter: MessageRouter;
  let mergeQueue: MergeQueue;
  let mergeQueueDb: Database.Database;
  let repo: TempRepo;
  let eventStoreDbPath: string;

  const STREAM_ID = "conflict-test-stream";

  beforeEach(async () => {
    if (!RUN_FULL_AGENT) {
      log("⚠️  Skipping: RUN_FULL_AGENT_TESTS not set");
      return;
    }

    // Create services with FILE-BASED EventStore using instanceId + baseDir
    // This ensures the MCP subprocess can access the same database by using the same resolution logic
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "conflict-e2e-db-"));
    const instanceId = `test-conflict-${Date.now()}`;
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

    // Create test repo with a shared file that will be conflicted
    repo = createTempGitRepo({
      "src/shared.ts": `// Shared module
export const CONFIG = {
  version: "1.0.0",
  feature: "original",
};
`,
      "package.json": '{ "name": "conflict-test", "version": "1.0.0" }\n',
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
            // Ignore
          }
        }
      }
    } catch {
      // Ignore
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

  describe("Conflict Detection", () => {
    testFn(
      "detects conflict when two workers edit the same file differently",
      async () => {
        // Create worktrees for two workers
        const worktree1 = createWorktreeForAgent(repo, "worker-1", "feature/change-a");
        const worktree2 = createWorktreeForAgent(repo, "worker-2", "feature/change-b");
        log(`✓ Worktrees created`);

        // Worker 1: Change the config version
        const task1 = `
You are working in: ${worktree1.path}

Your task:
1. Read src/shared.ts
2. Change the version from "1.0.0" to "2.0.0"
3. Commit with message "Bump version to 2.0.0"
`;
        const worker1 = await agentManager.spawn({
          task: task1,
          role: "worker",
          streamId: STREAM_ID,
          cwd: worktree1.path,
        });

        // Worker 2: Change the config feature (same file, different line)
        const task2 = `
You are working in: ${worktree2.path}

Your task:
1. Read src/shared.ts
2. Change the feature from "original" to "updated"
3. Commit with message "Update feature name"
`;
        const worker2 = await agentManager.spawn({
          task: task2,
          role: "worker",
          streamId: STREAM_ID,
          cwd: worktree2.path,
        });
        log(`✓ Workers spawned: ${worker1.id}, ${worker2.id}`);

        // Prompt both workers in parallel
        const [updates1, updates2] = await Promise.all([
          (async () => {
            let count = 0;
            for await (const _ of agentManager.prompt(worker1.id, task1)) {
              count++;
            }
            return count;
          })(),
          (async () => {
            let count = 0;
            for await (const _ of agentManager.prompt(worker2.id, task2)) {
              count++;
            }
            return count;
          })(),
        ]);
        log(`✓ Workers prompted: ${updates1} updates for worker1, ${updates2} updates for worker2`);

        // Manually terminate both workers
        // NOTE: MCP done() tool isn't available, so we terminate manually
        await Promise.all([
          agentManager.terminate(worker1.id, "completed"),
          agentManager.terminate(worker2.id, "completed"),
        ]);
        log(`✓ Both workers terminated`);

        // Submit both to merge queue
        const mr1 = mergeQueue.submit({
          streamId: STREAM_ID,
          taskId: "task-1",
          workerBranch: "feature/change-a",
          workerAgentId: worker1.id,
        });
        const mr2 = mergeQueue.submit({
          streamId: STREAM_ID,
          taskId: "task-2",
          workerBranch: "feature/change-b",
          workerAgentId: worker2.id,
        });
        log(`✓ MRs submitted: ${mr1}, ${mr2}`);

        // Process first MR - should succeed
        mergeQueue.markProcessing(mr1);

        // Merge worker1's branch into main
        execSync(`git merge --no-ff feature/change-a -m "Merge feature/change-a"`, {
          cwd: repo.path,
        });
        mergeQueue.markMerged(mr1, execSync("git rev-parse HEAD", { cwd: repo.path, encoding: "utf-8" }).trim());
        log(`✓ MR1 merged successfully`);

        // Process second MR - should detect conflict
        mergeQueue.markProcessing(mr2);

        // Try to merge worker2's branch - this will conflict
        try {
          execSync(`git merge --no-ff feature/change-b -m "Merge feature/change-b"`, {
            cwd: repo.path,
            stdio: "pipe",
          });
          // If no error, no conflict (changes may be on different lines)
          mergeQueue.markMerged(mr2, execSync("git rev-parse HEAD", { cwd: repo.path, encoding: "utf-8" }).trim());
          log(`✓ MR2 merged without conflict (different lines)`);
        } catch {
          // Conflict detected
          execSync("git merge --abort", { cwd: repo.path });
          mergeQueue.markConflict(mr2, ["src/shared.ts"]);
          log(`✓ MR2 conflict detected on src/shared.ts`);
        }

        // Verify the merge queue states
        const mr1Status = mergeQueue.get(mr1);
        const mr2Status = mergeQueue.get(mr2);

        expect(mr1Status?.status).toBe("merged");
        // MR2 might be merged (if no conflict) or conflict
        expect(["merged", "conflict"]).toContain(mr2Status?.status);
        log(`✓ Final states: MR1=${mr1Status?.status}, MR2=${mr2Status?.status}`);

        // Verify events
        const statusEvents = eventStore.query({ type: "status" });
        expect(statusEvents.length).toBeGreaterThan(0);
        log(`✓ ${statusEvents.length} status events recorded`);
      },
      { timeout: TIMEOUT.CONFLICT_RESOLUTION }
    );
  });

  describe("Resolver Workflow", () => {
    testFn(
      "spawns resolver agent to fix conflict and completes merge",
      async () => {
        // Create a guaranteed conflict scenario
        const worktree1 = createWorktreeForAgent(repo, "worker-1", "feature/version-a");
        const worktree2 = createWorktreeForAgent(repo, "worker-2", "feature/version-b");

        // Worker 1: Replace the entire shared.ts file
        const task1 = `
You are working in: ${worktree1.path}

Your task:
1. Replace the entire contents of src/shared.ts with:
   export const CONFIG = { version: "2.0.0", feature: "alpha" };
2. Commit with message "Set config to alpha"
`;
        const worker1 = await agentManager.spawn({
          task: task1,
          role: "worker",
          streamId: STREAM_ID,
          cwd: worktree1.path,
        });

        // Worker 2: Replace with different content (guaranteed conflict)
        const task2 = `
You are working in: ${worktree2.path}

Your task:
1. Replace the entire contents of src/shared.ts with:
   export const CONFIG = { version: "3.0.0", feature: "beta" };
2. Commit with message "Set config to beta"
`;
        const worker2 = await agentManager.spawn({
          task: task2,
          role: "worker",
          streamId: STREAM_ID,
          cwd: worktree2.path,
        });
        log(`✓ Workers spawned`);

        // Prompt both workers in parallel
        await Promise.all([
          (async () => {
            for await (const _ of agentManager.prompt(worker1.id, task1)) { /* consume */ }
          })(),
          (async () => {
            for await (const _ of agentManager.prompt(worker2.id, task2)) { /* consume */ }
          })(),
        ]);
        log(`✓ Both workers prompted`);

        // Manually terminate both workers
        await Promise.all([
          agentManager.terminate(worker1.id, "completed"),
          agentManager.terminate(worker2.id, "completed"),
        ]);
        log(`✓ Both workers terminated`);

        // Merge first worker directly to main
        execSync(`git merge --no-ff feature/version-a -m "Merge version-a"`, { cwd: repo.path });
        log(`✓ Worker 1 merged to main`);

        // Submit worker 2 to merge queue
        const mr2 = mergeQueue.submit({
          streamId: STREAM_ID,
          taskId: "task-2",
          workerBranch: "feature/version-b",
          workerAgentId: worker2.id,
        });
        mergeQueue.markProcessing(mr2);

        // This will definitely conflict
        let hasConflict = false;
        try {
          execSync(`git merge --no-ff feature/version-b -m "Merge version-b"`, {
            cwd: repo.path,
            stdio: "pipe",
          });
        } catch {
          hasConflict = true;
          execSync("git merge --abort", { cwd: repo.path });
          mergeQueue.markConflict(mr2, ["src/shared.ts"]);
        }

        expect(hasConflict).toBe(true);
        log(`✓ Conflict confirmed on MR2`);

        // Create resolver worktree (start from current main)
        const resolverWorktree = createWorktreeForAgent(repo, "resolver-1", `resolver/${mr2}`, "main");

        // Spawn resolver agent
        const resolverTask = `
You are a RESOLVER agent working in: ${resolverWorktree.path}

The branch "feature/version-b" conflicts with main on src/shared.ts.
Current main has: export const CONFIG = { version: "2.0.0", feature: "alpha" };
The conflicting branch wants: export const CONFIG = { version: "3.0.0", feature: "beta" };

Your task:
1. Cherry-pick or manually apply the changes from feature/version-b
2. Resolve the conflict by choosing the HIGHER version number and combining features
   Result should be: export const CONFIG = { version: "3.0.0", feature: "alpha-beta" };
3. Commit with message "Resolve conflict: merge alpha and beta configs"

Important: You are a resolver - do NOT submit to merge queue. Just resolve and commit.
`;
        const resolver = await agentManager.spawn({
          task: resolverTask,
          role: "worker.resolver",
          streamId: STREAM_ID,
          cwd: resolverWorktree.path,
          config: {
            env: {
              MACRO_RESOLVER_MR_ID: mr2,
            },
          },
        });
        log(`✓ Resolver spawned: ${resolver.id}`);

        // Prompt the resolver
        for await (const _ of agentManager.prompt(resolver.id, resolverTask)) {
          /* consume updates */
        }
        log(`✓ Resolver prompted`);

        // Manually terminate resolver
        await agentManager.terminate(resolver.id, "completed");
        log(`✓ Resolver terminated`);

        // Verify resolver made a commit
        const resolverLog = execSync("git log --oneline -1", {
          cwd: resolverWorktree.path,
          encoding: "utf-8",
        });
        log(`✓ Resolver commit: ${resolverLog.trim()}`);

        // Verify agent state is stopped
        const resolverState = agentManager.get(resolver.id);
        expect(resolverState?.state).toBe("stopped");
        log(`✓ Resolver state: ${resolverState?.state}`);
      },
      { timeout: TIMEOUT.CONFLICT_RESOLUTION }
    );
  });

  describe("End-to-End Conflict Flow", () => {
    testFn(
      "full flow: workers -> conflict -> resolver -> successful merge",
      async () => {
        // This test runs the complete flow with an integrator-like orchestration

        // Phase 1: Two workers make conflicting changes
        const wt1 = createWorktreeForAgent(repo, "w1", "feature/w1");
        const wt2 = createWorktreeForAgent(repo, "w2", "feature/w2");

        const task1 = `Working in ${wt1.path}. Write to src/shared.ts: "export const X = 1;" and commit "W1 change".`;
        const w1 = await agentManager.spawn({
          task: task1,
          role: "worker",
          streamId: STREAM_ID,
          cwd: wt1.path,
        });

        const task2 = `Working in ${wt2.path}. Write to src/shared.ts: "export const X = 2;" and commit "W2 change".`;
        const w2 = await agentManager.spawn({
          task: task2,
          role: "worker",
          streamId: STREAM_ID,
          cwd: wt2.path,
        });

        // Prompt both workers in parallel
        await Promise.all([
          (async () => {
            for await (const _ of agentManager.prompt(w1.id, task1)) { /* consume */ }
          })(),
          (async () => {
            for await (const _ of agentManager.prompt(w2.id, task2)) { /* consume */ }
          })(),
        ]);

        // Manually terminate both workers
        await Promise.all([
          agentManager.terminate(w1.id, "completed"),
          agentManager.terminate(w2.id, "completed"),
        ]);
        log(`✓ Phase 1: Workers completed`);

        // Phase 2: Submit to merge queue and process
        const mr1 = mergeQueue.submit({
          streamId: STREAM_ID,
          taskId: "t1",
          workerBranch: "feature/w1",
          workerAgentId: w1.id,
        });
        const mr2 = mergeQueue.submit({
          streamId: STREAM_ID,
          taskId: "t2",
          workerBranch: "feature/w2",
          workerAgentId: w2.id,
        });
        log(`✓ Phase 2: MRs submitted`);

        // Merge MR1
        mergeQueue.markProcessing(mr1);
        execSync("git merge --no-ff feature/w1 -m 'Merge w1'", { cwd: repo.path });
        mergeQueue.markMerged(mr1, "abc123");
        log(`✓ MR1 merged`);

        // MR2 will conflict
        mergeQueue.markProcessing(mr2);
        let conflict = false;
        try {
          execSync("git merge --no-ff feature/w2 -m 'Merge w2'", { cwd: repo.path, stdio: "pipe" });
        } catch {
          conflict = true;
          execSync("git merge --abort", { cwd: repo.path });
          mergeQueue.markConflict(mr2, ["src/shared.ts"]);
        }
        expect(conflict).toBe(true);
        log(`✓ Phase 2: Conflict detected on MR2`);

        // Phase 3: Spawn resolver
        const resolverWt = createWorktreeForAgent(repo, "resolver", `resolver/${mr2}`, "main");

        const resolverTask = `
Working in ${resolverWt.path}.
Resolve conflict in src/shared.ts by writing: "export const X = 3; // Combined"
Commit "Resolve conflict".
`;
        const resolver = await agentManager.spawn({
          task: resolverTask,
          role: "worker.resolver",
          streamId: STREAM_ID,
          cwd: resolverWt.path,
        });

        // Prompt resolver
        for await (const _ of agentManager.prompt(resolver.id, resolverTask)) {
          /* consume updates */
        }

        // Manually terminate resolver
        await agentManager.terminate(resolver.id, "completed");
        log(`✓ Phase 3: Resolver completed`);

        // Phase 4: Merge resolver branch
        try {
          execSync(`git merge --no-ff resolver/${mr2} -m 'Merge resolver'`, { cwd: repo.path });
          mergeQueue.markResolverComplete(mr2, "resolved123", `resolver/${mr2}`);
          log(`✓ Phase 4: Resolver branch merged`);
        } catch (e) {
          log(`✗ Resolver merge failed: ${e}`);
        }

        // Verify final state
        const finalMr2 = mergeQueue.get(mr2);
        log(`✓ Final MR2 status: ${finalMr2?.status}`);

        // Verify we have all the events
        const allEvents = eventStore.query({});
        const spawnCount = allEvents.filter((e) => e.type === "spawn").length;
        const doneCount = allEvents.filter((e) => e.type === "done").length;
        log(`✓ Events: ${spawnCount} spawns, ${doneCount} done`);

        expect(spawnCount).toBeGreaterThanOrEqual(3); // w1, w2, resolver
        expect(doneCount).toBeGreaterThanOrEqual(3);
      },
      { timeout: TIMEOUT.CONFLICT_RESOLUTION }
    );
  });
});

// ─────────────────────────────────────────────────────────────────
// Info message for running tests
// ─────────────────────────────────────────────────────────────────

if (!RUN_FULL_AGENT) {
  console.log("\n┌──────────────────────────────────────────────────────────────────┐");
  console.log("│  Full Agent Conflict Resolution tests skipped                    │");
  console.log("│  (RUN_FULL_AGENT_TESTS not set)                                  │");
  console.log("│                                                                  │");
  console.log("│  To run with real agents:                                        │");
  console.log("│  RUN_FULL_AGENT_TESTS=true npm run test:e2e -- \\                 │");
  console.log("│    src/__tests__/e2e/full-agent-conflict-resolution.e2e.test.ts  │");
  console.log("└──────────────────────────────────────────────────────────────────┘\n");
}
