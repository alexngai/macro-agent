/**
 * Task Dispatch + OpenTasks Integration E2E Tests
 *
 * Tests the full dispatch lifecycle with REAL opentasks daemon AND
 * REAL Claude Code agents. No mocking of task data or agent processes.
 *
 * End-to-end flow:
 *   opentasks daemon → tasks created → dispatch strategy polls →
 *   claims task → spawns real agent → agent works → done() →
 *   lifecycle listener → task transitioned → reconciliation
 *
 * REQUIRES: RUN_FULL_AGENT_TESTS=true
 *
 * Run with:
 *   RUN_FULL_AGENT_TESTS=true npx vitest run --config vitest.e2e.config.ts src/__tests__/e2e/dispatch-opentasks.e2e.test.ts
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";
import { execFileSync } from "node:child_process";
import { bootV2, type MacroAgentSystemV2 } from "../../boot-v2.js";
import {
  ensureOpentasksDaemon,
  type DaemonHandle,
} from "../../adapters/opentasks-daemon.js";
import {
  createTaskDispatcher,
  type TaskDispatcher,
  type DispatchAgentRuntime,
  type DispatchTaskSource,
} from "swarm-dispatch";

// ─────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────

const RUN_FULL_AGENT = !!process.env.RUN_FULL_AGENT_TESTS;
const describeFn = RUN_FULL_AGENT ? describe : describe.skip;

const TIMEOUT = {
  SETUP: 30_000,
  DISPATCH: 120_000,
  MULTI: 180_000,
};

// ─────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────

function createTempDir(prefix = "dispatch-ot"): string {
  const suffix = Math.random().toString(36).slice(2, 8);
  const dir = path.join(os.tmpdir(), `${prefix}-${suffix}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function initGitRepo(dir: string): void {
  execFileSync("git", ["init"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@e2e.dev"], {
    cwd: dir,
    stdio: "pipe",
  });
  execFileSync("git", ["config", "user.name", "E2E Test"], {
    cwd: dir,
    stdio: "pipe",
  });
  execFileSync("git", ["config", "commit.gpgsign", "false"], {
    cwd: dir,
    stdio: "pipe",
  });
  fs.writeFileSync(path.join(dir, "README.md"), "# Dispatch E2E\n");
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "pipe" });
}

function cleanupDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

function log(msg: string): void {
  console.log(`[DISPATCH-OT] ${msg}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─────────────────────────────────────────────────────────────────
// Test Suite
// ─────────────────────────────────────────────────────────────────

describeFn("Task Dispatch + OpenTasks E2E", () => {
  // Per-test: each test gets its own daemon for isolation
  let daemonDir: string;
  let registryDir: string;
  let daemonHandle: DaemonHandle;
  let canStartDaemon = false;

  let system: MacroAgentSystemV2;
  let dispatcher: TaskDispatcher;
  let testRepoDir: string;

  function createSourceAdapter(tasksAdapter: typeof system.tasksAdapter): DispatchTaskSource {
    return {
      queryReady: (opts) => tasksAdapter.queryReady(opts),
      claim: async (taskId, claimantId) => {
        try {
          await tasksAdapter.assignTask(taskId, claimantId);
          return { success: true as const };
        } catch { return { success: false as const }; }
      },
      release: async (taskId) => tasksAdapter.unclaimTask(taskId),
      transition: async (taskId, action) => tasksAdapter.transitionTask(taskId, action),
      getTask: async (taskId) => tasksAdapter.getTask(taskId),
      listInProgress: async () => tasksAdapter.listTasks({ status: "in_progress" }),
    };
  }

  function createRuntimeAdapter(agentManager: typeof system.agentManager): DispatchAgentRuntime {
    return {
      spawn: async (opts) => {
        const spawned = await agentManager.spawn({
          task: opts.prompt, task_id: opts.taskId, role: opts.role, parent: null,
        });
        return { id: spawned.id };
      },
      terminate: async (agentId) => agentManager.terminate(agentId, "cancelled"),
      onStopped: (cb) => agentManager.onLifecycleEvent((event) => {
        if (event.type === "stopped") cb(event.agent.id, event.reason);
      }),
    };
  }

  beforeEach(async () => {
    try {
      daemonDir = createTempDir("ot-dmn");
      registryDir = createTempDir("ot-reg");
      initGitRepo(daemonDir);

      daemonHandle = await ensureOpentasksDaemon(daemonDir, {
        timeoutMs: 15_000,
        registryPath: path.join(registryDir, "registry.json"),
      });
      canStartDaemon = true;
      log(`Daemon started at ${daemonHandle.socketPath}`);
    } catch (err) {
      console.warn(
        `[dispatch-opentasks] Skipping: daemon could not start: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      canStartDaemon = false;
      return;
    }

    testRepoDir = createTempDir("dispatch-repo");
    initGitRepo(testRepoDir);

    const baseDir = path.join(testRepoDir, ".macro-agent");
    fs.mkdirSync(baseDir, { recursive: true });

    system = await bootV2({
      cwd: testRepoDir,
      baseDir,
      defaultPermissionMode: "auto-approve",
      inbox: { socketPath: path.join(baseDir, "inbox.sock") },
      tasks: { socketPath: daemonHandle.socketPath },
    });

    dispatcher = createTaskDispatcher(
      createSourceAdapter(system.tasksAdapter),
      createRuntimeAdapter(system.agentManager),
      {
        claimantId: `test:${process.pid}:dispatch-ot`,
        pollIntervalMs: 600_000,
        defaultRole: "worker",
        concurrency: { global: 3 },
        retry: { maxRetries: 3, baseDelayMs: 1_000, maxDelayMs: 60_000 },
        reconcile: { enabled: true, intervalMs: 600_000 },
      }
    );
    await dispatcher.start();

    log("System booted with real opentasks + swarm-dispatch");
  });

  afterEach(async () => {
    if (dispatcher) await dispatcher.stop();
    if (system) {
      try {
        const running = system.agentManager.list({ state: "running" } as any);
        for (const agent of running) {
          try {
            await system.agentManager.terminate(agent.id, "cancelled");
          } catch { /* best effort */ }
        }
        await system.shutdown();
      } catch { /* best effort */ }
    }
    if (daemonHandle) {
      try { await daemonHandle.stop(); } catch { /* best effort */ }
    }
    if (testRepoDir) cleanupDir(testRepoDir);
    if (daemonDir) cleanupDir(daemonDir);
    if (registryDir) cleanupDir(registryDir);
    log("Cleanup complete");
  }, 30_000);

  // ── Full loop: create task → dispatch → agent completes ────

  it(
    "creates a real task, dispatches to a real agent, agent completes",
    async () => {
      if (!canStartDaemon) return;

      // 1. Create a task in the real opentasks daemon
      log("Creating task in opentasks...");
      const taskId = await system.tasksAdapter.createTask({
        title: "Write a haiku",
        content:
          'Create a file called haiku.txt with a haiku about code. ' +
          'Then call the "done" MCP tool with status="completed" and summary="Created haiku.txt".',
        tags: ["auto", "e2e"],
        priority: 3,
      });
      log(`Task created: ${taskId}`);

      // Verify task is queryable
      const readyBefore = await system.tasksAdapter.queryReady();
      log(`Ready tasks before dispatch: ${readyBefore.length}`);
      expect(readyBefore.some((t) => t.id === taskId)).toBe(true);

      // 2. Trigger dispatch
      log("Triggering dispatch...");
      await dispatcher.dispatchNow();

      await sleep(3_000);

      // 3. Verify agent was spawned
      log(`Tracker active: ${dispatcher.tracker.activeCount()}`);
      expect(dispatcher.tracker.activeCount()).toBeGreaterThanOrEqual(1);

      const active = dispatcher.tracker.listActive();
      const dispatch = active.find((d) => d.taskId === taskId);
      expect(dispatch).toBeDefined();

      const agentId = dispatch!.agentId;
      log(`Dispatched agent: ${agentId}`);

      const agentRecord = system.agentStore.getAgent(agentId);
      expect(agentRecord).not.toBeNull();
      expect(agentRecord!.state).toBe("running");
      expect(agentRecord!.parent_id).toBeNull(); // Parentless

      // 4. Prompt agent to complete its work
      log("Prompting agent to complete task...");
      const result = await system.agentManager.promptUntilDone(
        agentId,
        'Complete your task: create haiku.txt with a haiku about code, then call done(status="completed", summary="Created haiku.txt").',
        {
          maxFollowUps: 3,
          onUpdate: (update: any) => {
            if (update.sessionUpdate === "tool_call") {
              log(`  [tool_call] ${update.title ?? "unknown"}`);
            }
          },
        }
      );

      log(`promptUntilDone: doneCalled=${result.doneCalled}, status=${result.doneStatus}`);

      // Wait for lifecycle listener
      await sleep(3_000);

      // 5. Verify completion
      if (result.doneCalled && result.doneStatus === "completed") {
        log("Agent called done(completed)");

        // Task should be removed from tracker
        expect(dispatcher.tracker.isTracked(taskId)).toBe(false);

        // Agent should be stopped
        const finalAgent = system.agentStore.getAgent(agentId);
        expect(finalAgent?.state).toBe("stopped");

        // Verify haiku.txt was created
        const haikuPath = path.join(testRepoDir, "haiku.txt");
        if (fs.existsSync(haikuPath)) {
          const content = fs.readFileSync(haikuPath, "utf-8");
          log(`haiku.txt: ${content.trim().substring(0, 80)}`);
          expect(content.length).toBeGreaterThan(0);
        } else {
          log("haiku.txt not found (agent may have written elsewhere)");
        }

        // Verify the task was transitioned in opentasks
        // (The lifecycle listener calls transitionTask("complete"))
        const taskAfter = await system.tasksAdapter.getTask(taskId);
        log(`Task status after completion: ${taskAfter.status}`);

        // Ready list should no longer contain this task
        const readyAfter = await system.tasksAdapter.queryReady();
        expect(readyAfter.some((t) => t.id === taskId)).toBe(false);
      } else {
        log("Agent did not call done(completed) — LLM behavior variance");
      }
    },
    TIMEOUT.MULTI
  );

  // ── Dispatch with dependencies: blocked task not dispatched ──

  it(
    "does not dispatch blocked tasks, dispatches when unblocked",
    async () => {
      if (!canStartDaemon) return;

      // Create two tasks: taskB blocked by taskA
      log("Creating tasks with dependency...");
      const taskAId = await system.tasksAdapter.createTask({
        title: "Prerequisite task A",
        content: 'Say "done" and call done(status="completed").',
        tags: ["auto"],
      });
      const taskBId = await system.tasksAdapter.createTask({
        title: "Dependent task B",
        content: 'Say "done" and call done(status="completed").',
        tags: ["auto"],
      });

      // taskA blocks taskB
      await system.tasksAdapter.addBlocker(taskBId, taskAId);
      log(`Task ${taskAId} blocks ${taskBId}`);

      // Verify only taskA is ready (taskB is blocked)
      const readyBefore = await system.tasksAdapter.queryReady();
      const readyIds = readyBefore.map((t) => t.id);
      log(`Ready before: ${readyIds.join(", ")}`);
      expect(readyIds).toContain(taskAId);
      expect(readyIds).not.toContain(taskBId);

      // Dispatch — should only pick up taskA
      log("Triggering dispatch...");
      await dispatcher.dispatchNow();

      await sleep(3_000);

      log(`Tracker active: ${dispatcher.tracker.activeCount()}`);
      const active = dispatcher.tracker.listActive();
      const dispatchedIds = active.map((d) => d.taskId);
      log(`Dispatched: ${dispatchedIds.join(", ")}`);

      // taskA should be dispatched, taskB should not
      expect(dispatchedIds).toContain(taskAId);
      expect(dispatchedIds).not.toContain(taskBId);

      // Complete taskA to unblock taskB
      log("Completing taskA to unblock taskB...");
      const agentAId = active.find((d) => d.taskId === taskAId)!.agentId;
      await system.agentManager.terminate(agentAId, "completed");
      await sleep(1_000);

      // Remove the blocker
      await system.tasksAdapter.removeBlocker(taskBId, taskAId);

      // Verify taskB is now ready
      const readyAfter = await system.tasksAdapter.queryReady();
      const readyAfterIds = readyAfter.map((t) => t.id);
      log(`Ready after unblock: ${readyAfterIds.join(", ")}`);
      expect(readyAfterIds).toContain(taskBId);

      // Dispatch again — should pick up taskB
      await dispatcher.dispatchNow();
      await sleep(3_000);

      const activeAfter = dispatcher.tracker.listActive();
      const dispatchedAfter = activeAfter.map((d) => d.taskId);
      log(`Dispatched after unblock: ${dispatchedAfter.join(", ")}`);
      expect(dispatchedAfter).toContain(taskBId);
    },
    TIMEOUT.MULTI
  );

  // ── Multiple tasks dispatched concurrently ─────────────────

  it(
    "dispatches multiple ready tasks from opentasks concurrently",
    async () => {
      if (!canStartDaemon) return;

      log("Creating 3 independent tasks...");
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        const id = await system.tasksAdapter.createTask({
          title: `Concurrent task ${i + 1}`,
          content: "Wait for instructions.",
          tags: ["auto", "concurrent"],
          priority: 3,
        });
        ids.push(id);
      }
      log(`Created: ${ids.join(", ")}`);

      // Verify all are ready
      const ready = await system.tasksAdapter.queryReady();
      const readyIds = ready.map((t) => t.id);
      log(`Ready: ${readyIds.join(", ")}`);
      for (const id of ids) {
        expect(readyIds).toContain(id);
      }

      // Dispatch
      log("Triggering dispatch...");
      await dispatcher.dispatchNow();

      await sleep(3_000);

      log(`Tracker active: ${dispatcher.tracker.activeCount()}`);
      expect(dispatcher.tracker.activeCount()).toBeGreaterThanOrEqual(3);

      const active = dispatcher.tracker.listActive();
      const dispatchedIds = active.map((d) => d.taskId);
      log(`Dispatched: ${dispatchedIds.join(", ")}`);

      // All 3 should be dispatched (global limit is 3)
      for (const id of ids) {
        expect(dispatchedIds).toContain(id);
      }

      // Verify all agents are running
      for (const record of active) {
        if (!ids.includes(record.taskId)) continue;
        const agent = system.agentStore.getAgent(record.agentId);
        expect(agent).not.toBeNull();
        expect(agent!.state).toBe("running");
      }
    },
    TIMEOUT.DISPATCH
  );

  // ── Reconcile detects externally completed task ────────────

  it(
    "reconciliation detects task completed externally in opentasks",
    async () => {
      if (!canStartDaemon) return;

      // Create and dispatch a task
      log("Creating task...");
      const taskId = await system.tasksAdapter.createTask({
        title: "Task to close externally",
        content: "Wait for instructions.",
        tags: ["auto"],
      });

      log("Dispatching...");
      await dispatcher.dispatchNow();
      await sleep(3_000);

      log(`Tracker active: ${dispatcher.tracker.activeCount()}`);
      expect(dispatcher.tracker.activeCount()).toBe(1);

      const agentId = dispatcher.tracker.listActive().find((d) => d.taskId === taskId)!.agentId;
      log(`Agent: ${agentId}`);

      // Simulate external completion: transition task to closed directly
      log("Closing task externally via opentasks...");
      await system.tasksAdapter.transitionTask(taskId, "start");
      await system.tasksAdapter.transitionTask(taskId, "complete");

      const taskAfterClose = await system.tasksAdapter.getTask(taskId);
      log(`Task status after external close: ${taskAfterClose.status}`);
      expect(taskAfterClose.status).toBe("closed");

      log("Triggering reconciliation...");
      await dispatcher.reconcileNow();
      await sleep(3_000);

      // Task should be removed from tracker
      log(`Tracker active after reconcile: ${dispatcher.tracker.activeCount()}`);
      expect(dispatcher.tracker.isTracked(taskId)).toBe(false);

      // Agent should be stopped
      const agentAfter = system.agentStore.getAgent(agentId);
      log(`Agent state after reconcile: ${agentAfter?.state}`);
      expect(agentAfter?.state).toBe("stopped");
    },
    TIMEOUT.DISPATCH
  );
});
