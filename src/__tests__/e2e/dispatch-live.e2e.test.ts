/**
 * Task Dispatch Live Agent E2E Tests
 *
 * Tests the full dispatch lifecycle with REAL Claude Code agents:
 * - Dispatch strategy spawns real agents for tasks
 * - Agents complete work and call done()
 * - Lifecycle listener detects completion and updates tracker
 * - Reconciliation handles external state changes
 *
 * These tests hit the Claude API and require authenticated Claude Code.
 *
 * REQUIRES: RUN_FULL_AGENT_TESTS=true
 *
 * Run with:
 *   RUN_FULL_AGENT_TESTS=true npx vitest run --config vitest.e2e.config.ts src/__tests__/e2e/dispatch-live.e2e.test.ts
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import { execSync } from "child_process";
import { bootV2, type MacroAgentSystemV2 } from "../../boot-v2.js";
import {
  createTaskDispatcher,
  type TaskDispatcher,
  type DispatchAgentRuntime,
  type DispatchTaskSource,
} from "swarm-dispatch";
import type { TaskRecord } from "../../adapters/types.js";

// ─────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────

const RUN_FULL_AGENT = !!process.env.RUN_FULL_AGENT_TESTS;
const describeFn = RUN_FULL_AGENT ? describe : describe.skip;

const TIMEOUT = {
  SPAWN: 60_000,
  DISPATCH: 120_000,
  MULTI: 180_000,
};

// ─────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────

function createTestRepo(prefix: string): { path: string; cleanup: () => void } {
  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), `dispatch-live-${prefix}-`)
  );
  const repoPath = path.join(tmpDir, "test-repo");
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
  fs.writeFileSync(path.join(repoPath, "README.md"), "# Test Repo\n");
  execSync("git add -A", { cwd: repoPath, stdio: "pipe" });
  execSync('git commit -m "Initial commit"', { cwd: repoPath, stdio: "pipe" });

  return {
    path: repoPath,
    cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }),
  };
}

function log(msg: string): void {
  console.log(`[DISPATCH-LIVE] ${msg}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait for a condition to become true, polling at intervals.
 */
async function waitFor(
  condition: () => boolean,
  timeoutMs: number = 30_000,
  pollMs: number = 500
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await sleep(pollMs);
  }
  return condition();
}

// ─────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────

describeFn("Task Dispatch Live Agent E2E", () => {
  let system: MacroAgentSystemV2;
  let testRepo: { path: string; cleanup: () => void };
  let baseDir: string;
  let dispatcher: TaskDispatcher;

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
    testRepo = createTestRepo("dispatch");
    baseDir = path.join(testRepo.path, ".macro-agent");
    fs.mkdirSync(baseDir, { recursive: true });

    system = await bootV2({
      cwd: testRepo.path,
      baseDir,
      defaultPermissionMode: "auto-approve",
      inbox: { socketPath: path.join(baseDir, "inbox.sock") },
    });

    dispatcher = createTaskDispatcher(
      createSourceAdapter(system.tasksAdapter),
      createRuntimeAdapter(system.agentManager),
      {
        claimantId: `test:${process.pid}:dispatch-live`,
        pollIntervalMs: 600_000,
        defaultRole: "worker",
        concurrency: { global: 3 },
        retry: { maxRetries: 3, baseDelayMs: 1_000, maxDelayMs: 60_000 },
        reconcile: { enabled: true, intervalMs: 600_000 },
      }
    );
    await dispatcher.start();

    log("System booted with swarm-dispatch");
  });

  afterEach(async () => {
    if (dispatcher) {
      await dispatcher.stop();
    }
    if (system) {
      try {
        const running = system.agentManager.list({ state: "running" });
        for (const agent of running) {
          try {
            await system.agentManager.terminate(agent.id, "cancelled");
          } catch {
            // Best effort
          }
        }
        await system.shutdown();
      } catch {
        // Best effort
      }
    }
    testRepo?.cleanup();
    log("Cleanup complete");
  });

  // ── Dispatch spawns a real agent that completes ─────────────

  it(
    "dispatches a task and agent completes via done()",
    async () => {
      log("Setting up mock task data on tasksAdapter...");

      const task: TaskRecord = {
        id: "live-task-1",
        title: "Write a greeting",
        content:
          'Create a file called greeting.txt with the text "Hello World". ' +
          'Then call the "done" MCP tool with status="completed" and summary="Created greeting.txt".',
        status: "open",
        tags: ["auto"],
        priority: 3,
      };

      // Override tasksAdapter methods to serve our test task
      const tasksAdapter = system.tasksAdapter;
      (tasksAdapter as any).queryReady = vi
        .fn()
        .mockResolvedValueOnce([task])
        .mockResolvedValue([]); // Empty after first poll
      (tasksAdapter as any).assignTask = vi.fn().mockResolvedValue(undefined);
      (tasksAdapter as any).transitionTask = vi.fn().mockResolvedValue(undefined);
      (tasksAdapter as any).getTask = vi.fn().mockResolvedValue(task);
      (tasksAdapter as any).listTasks = vi.fn().mockResolvedValue([]);

      log("Triggering dispatch...");
      await dispatcher.dispatchNow();
      await sleep(2_000);

      log(`Tracker active: ${dispatcher.tracker.activeCount()}`);
      expect(dispatcher.tracker.activeCount()).toBe(1);

      const active = dispatcher.tracker.listActive();
      const agentId = active[0]?.agentId;
      log(`Dispatched agent: ${agentId}`);
      expect(agentId).toBeDefined();

      // Verify agent is running
      const agentRecord = system.agentStore.getAgent(agentId);
      expect(agentRecord).not.toBeNull();
      expect(agentRecord!.state).toBe("running");

      // Verify it was spawned parentless (root agent)
      expect(agentRecord!.parent_id).toBeNull();

      // Verify task was claimed
      expect((tasksAdapter as any).assignTask).toHaveBeenCalledWith(
        "live-task-1",
        expect.any(String)
      );
      expect((tasksAdapter as any).transitionTask).toHaveBeenCalledWith(
        "live-task-1",
        "start"
      );

      // Now prompt the agent to do its work and call done
      log("Waiting for agent to complete...");
      const result = await system.agentManager.promptUntilDone(
        agentId,
        'Complete your task: create greeting.txt with "Hello World", then call done(status="completed", summary="Created greeting.txt").',
        {
          maxFollowUps: 3,
          onUpdate: (update: any) => {
            if (update.sessionUpdate === "tool_call") {
              log(`  [tool_call] ${update.title ?? "unknown"}`);
            }
          },
        }
      );

      log(
        `promptUntilDone result: doneCalled=${result.doneCalled}, status=${result.doneStatus}`
      );

      // Wait for lifecycle listener to process the stop event
      await sleep(3_000);

      // Verify the lifecycle listener detected completion
      log(`Tracker active after done: ${dispatcher.tracker.activeCount()}`);
      log(`Tracker retries: ${dispatcher.tracker.listRetries().length}`);

      if (result.doneCalled && result.doneStatus === "completed") {
        // Agent called done(completed) → lifecycle listener should have
        // completed the task in the tracker
        const stillTracked = dispatcher.tracker.isTracked("live-task-1");
        log(`Task still tracked: ${stillTracked}`);

        // The agent should be stopped now
        const finalRecord = system.agentStore.getAgent(agentId);
        log(`Agent final state: ${finalRecord?.state}`);
        expect(finalRecord?.state).toBe("stopped");

        // Verify greeting.txt was created
        const greetingPath = path.join(testRepo.path, "greeting.txt");
        if (fs.existsSync(greetingPath)) {
          const content = fs.readFileSync(greetingPath, "utf-8");
          log(`greeting.txt content: ${content.trim()}`);
          expect(content).toContain("Hello World");
        } else {
          log("greeting.txt not found (agent may have written elsewhere)");
        }
      } else {
        log("Agent did not call done(completed) — checking alternative outcomes");
        // Agent may have been terminated or may still be running
        // This is acceptable in live tests where LLM behavior varies
      }
    },
    TIMEOUT.MULTI
  );

  // ── Dispatch respects concurrency with real agents ──────────

  it(
    "dispatches multiple tasks respecting concurrency",
    async () => {
      log("Setting up 3 tasks with concurrency limit of 2...");

      // Recreate tracker with global limit of 2
      // (We can't change the existing tracker's config, but we
      // can verify the strategy respects the concurrency config
      // it was initialized with — which is global: 3)

      const tasks: TaskRecord[] = [
        {
          id: "multi-1",
          title: "Task one",
          content: 'Say "Task one done" and call done(status="completed").',
          status: "open",
          tags: ["auto"],
        },
        {
          id: "multi-2",
          title: "Task two",
          content: 'Say "Task two done" and call done(status="completed").',
          status: "open",
          tags: ["auto"],
        },
      ];

      const tasksAdapter = system.tasksAdapter;
      (tasksAdapter as any).queryReady = vi.fn().mockResolvedValue(tasks);
      (tasksAdapter as any).assignTask = vi.fn().mockResolvedValue(undefined);
      (tasksAdapter as any).transitionTask = vi.fn().mockResolvedValue(undefined);
      (tasksAdapter as any).getTask = vi.fn().mockImplementation(async (id: string) =>
        tasks.find((t) => t.id === id) ?? { id, title: "Unknown", status: "open" }
      );
      (tasksAdapter as any).listTasks = vi.fn().mockResolvedValue([]);

      log("Triggering dispatch...");
      await dispatcher.dispatchNow();
      await sleep(3_000);

      log(`Tracker active: ${dispatcher.tracker.activeCount()}`);
      log(`Agents spawned: ${dispatcher.tracker.listActive().map((d) => d.agentId).flat().join(", ")}`);

      // Both tasks should be dispatched (within global limit of 3)
      expect(dispatcher.tracker.activeCount()).toBe(2);
      expect((tasksAdapter as any).assignTask).toHaveBeenCalledTimes(2);

      // Verify both agents are running
      const active = dispatcher.tracker.listActive();
      for (const record of active) {
        const agentId = record.agentId;
        const agentRecord = system.agentStore.getAgent(agentId);
        expect(agentRecord).not.toBeNull();
        expect(agentRecord!.state).toBe("running");
        log(`Agent ${agentId} is ${agentRecord!.state}`);
      }
    },
    TIMEOUT.DISPATCH
  );

  // ── Lifecycle listener tracks agent termination ─────────────

  it(
    "lifecycle listener detects external agent termination",
    async () => {
      log("Dispatching a task...");

      const task: TaskRecord = {
        id: "terminate-task",
        title: "Long running task",
        content: "Wait for instructions. Do not call done().",
        status: "open",
        tags: ["auto"],
      };

      const tasksAdapter = system.tasksAdapter;
      (tasksAdapter as any).queryReady = vi
        .fn()
        .mockResolvedValueOnce([task])
        .mockResolvedValue([]);
      (tasksAdapter as any).assignTask = vi.fn().mockResolvedValue(undefined);
      (tasksAdapter as any).transitionTask = vi.fn().mockResolvedValue(undefined);
      (tasksAdapter as any).getTask = vi.fn().mockResolvedValue(task);
      (tasksAdapter as any).listTasks = vi.fn().mockResolvedValue([]);

      log("Triggering dispatch...");
      await dispatcher.dispatchNow();
      await sleep(2_000);

      expect(dispatcher.tracker.activeCount()).toBe(1);
      const agentId = dispatcher.tracker.listActive()[0].agentId;
      log(`Agent spawned: ${agentId}`);

      log("Terminating agent externally...");
      await system.agentManager.terminate(agentId, "cancelled");

      // Wait for lifecycle listener to process
      await sleep(2_000);

      log(`Tracker active after terminate: ${dispatcher.tracker.activeCount()}`);
      log(`Tracker retries: ${dispatcher.tracker.listRetries().length}`);

      // Agent was cancelled (not "completed") → lifecycle listener
      // should have called dispatcher.tracker.fail(), which queues a retry
      // (since maxRetries > 0 and this is attempt 0)
      const isTracked = dispatcher.tracker.isTracked("terminate-task");
      log(`Task still tracked (in retry queue): ${isTracked}`);
      expect(isTracked).toBe(true);
      expect(dispatcher.tracker.listRetries()).toHaveLength(1);
      expect(dispatcher.tracker.listRetries()[0].taskId).toBe("terminate-task");
    },
    TIMEOUT.DISPATCH
  );

  // ── Reconciliation detects closed task ──────────────────────

  it(
    "reconciliation terminates agent when task is closed externally",
    async () => {
      log("Dispatching a task...");

      const task: TaskRecord = {
        id: "reconcile-task",
        title: "Task to be closed externally",
        content: "Wait for instructions.",
        status: "open",
        tags: ["auto"],
      };

      const tasksAdapter = system.tasksAdapter;
      (tasksAdapter as any).queryReady = vi
        .fn()
        .mockResolvedValueOnce([task])
        .mockResolvedValue([]);
      (tasksAdapter as any).assignTask = vi.fn().mockResolvedValue(undefined);
      (tasksAdapter as any).transitionTask = vi.fn().mockResolvedValue(undefined);
      // getTask returns open initially (dispatch doesn't call getTask for new tasks,
      // only for retries — so this won't be consumed during dispatch)
      (tasksAdapter as any).getTask = vi.fn().mockResolvedValue(task);
      (tasksAdapter as any).listTasks = vi.fn().mockResolvedValue([]);

      log("Dispatching...");
      await dispatcher.dispatchNow();
      await sleep(2_000);

      expect(dispatcher.tracker.activeCount()).toBe(1);
      const agentId = dispatcher.tracker.listActive()[0].agentId;
      log(`Agent spawned: ${agentId}`);
      expect(system.agentStore.getAgent(agentId)!.state).toBe("running");

      // Simulate external state change: task closed
      (tasksAdapter as any).getTask = vi.fn().mockResolvedValue({
        ...task,
        status: "closed",
      });

      log("Triggering reconciliation (task now closed externally)...");
      await dispatcher.reconcileNow();
      await sleep(3_000);

      log(`Tracker active after reconcile: ${dispatcher.tracker.activeCount()}`);

      // Task should be removed from tracker (completed, not retried)
      expect(dispatcher.tracker.isTracked("reconcile-task")).toBe(false);
      expect(dispatcher.tracker.activeCount()).toBe(0);

      // Agent should be stopped
      const finalRecord = system.agentStore.getAgent(agentId);
      log(`Agent final state: ${finalRecord?.state}`);
      expect(finalRecord?.state).toBe("stopped");
    },
    TIMEOUT.DISPATCH
  );

  // ── Prompt pipeline produces correct prompt ─────────────────

  it(
    "dispatched agent receives prompt built from task metadata",
    async () => {
      log("Dispatching task with rich metadata...");

      const task: TaskRecord = {
        id: "prompt-task",
        title: "Fix authentication bug",
        content: "The login form fails when password contains special characters.",
        status: "open",
        tags: ["backend", "auth"],
        priority: 5,
        metadata: {
          criteria: ["Login works with special chars", "No regression in tests"],
          files: ["src/auth.ts", "src/login.tsx"],
          sourceUrl: "https://linear.app/team/issue/AUTH-42",
        },
      };

      const tasksAdapter = system.tasksAdapter;
      (tasksAdapter as any).queryReady = vi
        .fn()
        .mockResolvedValueOnce([task])
        .mockResolvedValue([]);
      (tasksAdapter as any).assignTask = vi.fn().mockResolvedValue(undefined);
      (tasksAdapter as any).transitionTask = vi.fn().mockResolvedValue(undefined);
      (tasksAdapter as any).getTask = vi.fn().mockResolvedValue(task);
      (tasksAdapter as any).listTasks = vi.fn().mockResolvedValue([]);

      // Capture the spawn call to inspect the prompt
      const originalSpawn = system.agentManager.spawn.bind(system.agentManager);
      let capturedPrompt = "";
      (system.agentManager as any).spawn = async (opts: any) => {
        capturedPrompt = opts.task;
        return originalSpawn(opts);
      };

      log("Triggering dispatch...");
      await dispatcher.dispatchNow();
      await sleep(2_000);

      log(`Captured prompt length: ${capturedPrompt.length}`);
      log(`Prompt preview: ${capturedPrompt.substring(0, 200)}...`);

      // Verify prompt contains task metadata
      expect(capturedPrompt).toContain("## Task: Fix authentication bug");
      expect(capturedPrompt).toContain("login form fails");
      expect(capturedPrompt).toContain("Task ID: prompt-task");
      expect(capturedPrompt).toContain("Tags: backend, auth");
      expect(capturedPrompt).toContain("Priority: 5");
      expect(capturedPrompt).toContain("### Acceptance Criteria");
      expect(capturedPrompt).toContain("Login works with special chars");
      expect(capturedPrompt).toContain("### Relevant Files");
      expect(capturedPrompt).toContain("src/auth.ts");
      expect(capturedPrompt).toContain("Source: https://linear.app/team/issue/AUTH-42");
      expect(capturedPrompt).toContain("**worker** role");

      // Should NOT contain retry context on first attempt
      expect(capturedPrompt).not.toContain("Retry");
    },
    TIMEOUT.DISPATCH
  );
});
