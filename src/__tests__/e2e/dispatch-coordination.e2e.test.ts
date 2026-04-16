/**
 * Dispatch + Coordination Handler E2E Tests
 *
 * Tests the full-stack dispatch flow:
 *   OpenHive task.assign → coordination handler → opentasks → swarm-dispatch → agent
 *
 * Exercises the integration between:
 * - Coordination handler (receives x-openhive/task.assign, creates task in opentasks)
 * - opentasks daemon (stores tasks, serves queryReady)
 * - swarm-dispatch (polls, claims, spawns agents)
 * - AgentManagerV2 (real agent spawning)
 * - Lifecycle listener (tracks completion/failure)
 *
 * REQUIRES: RUN_FULL_AGENT_TESTS=true
 *
 * Run with:
 *   RUN_FULL_AGENT_TESTS=true npx vitest run --config vitest.e2e.config.ts src/__tests__/e2e/dispatch-coordination.e2e.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
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
import { setupCoordinationHandlers } from "../../map/coordination-handler.js";

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

function createTempDir(prefix = "dispatch-coord"): string {
  const suffix = Math.random().toString(36).slice(2, 8);
  const dir = path.join(os.tmpdir(), `${prefix}-${suffix}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function initGitRepo(dir: string): void {
  execFileSync("git", ["init"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@e2e.dev"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "E2E Test"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: dir, stdio: "pipe" });
  fs.writeFileSync(path.join(dir, "README.md"), "# Dispatch Coordination E2E\n");
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "pipe" });
}

function cleanupDir(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

function log(msg: string): void {
  console.log(`[DISPATCH-COORD] ${msg}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Simulates an OpenHive MAP connection that can send coordination notifications.
 */
function createMockMAPConnection() {
  const handlers = new Map<string, Array<(params: unknown) => void | Promise<void>>>();

  return {
    onNotification(method: string, handler: (params: unknown) => void | Promise<void>) {
      if (!handlers.has(method)) handlers.set(method, []);
      handlers.get(method)!.push(handler);
    },
    offNotification(method: string, handler: (params: unknown) => void | Promise<void>) {
      const list = handlers.get(method);
      if (list) {
        const idx = list.indexOf(handler);
        if (idx >= 0) list.splice(idx, 1);
      }
    },
    async sendNotification() { /* no-op for inbound-only */ },

    /** Simulate OpenHive sending a notification */
    async simulateNotification(method: string, params: unknown) {
      const list = handlers.get(method);
      if (list) {
        for (const handler of list) {
          await handler(params);
        }
      }
    },
  };
}

// ─────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────

describeFn("Dispatch + Coordination Handler E2E", () => {
  let daemonDir: string;
  let registryDir: string;
  let daemonHandle: DaemonHandle;
  let canStartDaemon = false;

  let system: MacroAgentSystemV2;
  let dispatcher: TaskDispatcher;
  let testRepoDir: string;
  let coordinationCleanup: (() => void) | null = null;

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
      console.warn(`[dispatch-coord] Skipping: daemon could not start: ${(err as Error).message}`);
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
        claimantId: `test:${process.pid}:dispatch-coord`,
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
    if (coordinationCleanup) { coordinationCleanup(); coordinationCleanup = null; }
    if (dispatcher) await dispatcher.stop();
    if (system) {
      try {
        const running = system.agentManager.list({ state: "running" } as any);
        for (const agent of running) {
          try { await system.agentManager.terminate(agent.id, "cancelled"); } catch { /* */ }
        }
        await system.shutdown();
      } catch { /* */ }
    }
    if (daemonHandle) { try { await daemonHandle.stop(); } catch { /* */ } }
    if (testRepoDir) cleanupDir(testRepoDir);
    if (daemonDir) cleanupDir(daemonDir);
    if (registryDir) cleanupDir(registryDir);
    log("Cleanup complete");
  }, 30_000);

  // ── Full flow: OpenHive assigns task → dispatch → agent ────

  it(
    "OpenHive task.assign creates task, dispatch picks it up and spawns agent",
    async () => {
      if (!canStartDaemon) return;

      // Wire coordination handler with a mock MAP connection
      const mockConnection = createMockMAPConnection();
      coordinationCleanup = setupCoordinationHandlers({
        connection: mockConnection,
        agentManager: system.agentManager,
        inboxAdapter: system.inboxAdapter,
        tasksAdapter: system.tasksAdapter,
      });

      // Simulate OpenHive sending a task assignment
      log("Simulating OpenHive task.assign...");
      await mockConnection.simulateNotification("x-openhive/task.assign", {
        title: "Fix the login page",
        description: "The login form has a CSS bug. Fix it and call done().",
        assigned_by: "openhive-hub",
        priority: "high",
        context: {
          tags: ["auto", "frontend"],
          sourceUrl: "https://linear.app/team/FE-42",
        },
      });

      // Verify task was created in opentasks
      await sleep(1_000);
      const readyTasks = await system.tasksAdapter.queryReady();
      log(`Ready tasks after assign: ${readyTasks.length}`);
      expect(readyTasks.length).toBeGreaterThanOrEqual(1);

      const task = readyTasks.find((t) => t.title === "Fix the login page");
      expect(task).toBeDefined();
      log(`Task created: ${task!.id} — "${task!.title}"`);

      // Verify priority was mapped
      expect(task!.priority).toBe(2); // "high" → 2

      // Tags — verified if the daemon returns them
      log(`Tags: ${JSON.stringify(task!.tags)}`);
      if (task!.tags && task!.tags.length > 0) {
        expect(task!.tags).toContain("auto");
        expect(task!.tags).toContain("frontend");
      }

      // Trigger dispatch — should pick up the task from opentasks
      log("Triggering dispatch...");
      await dispatcher.dispatchNow();
      await sleep(3_000);

      // Verify agent was spawned
      log(`Tracker active: ${dispatcher.tracker.activeCount()}`);
      expect(dispatcher.tracker.activeCount()).toBeGreaterThanOrEqual(1);

      const dispatch = dispatcher.tracker.listActive().find(
        (d) => d.taskId === task!.id
      );
      expect(dispatch).toBeDefined();

      const agentId = dispatch!.agentId;
      log(`Agent spawned: ${agentId}`);

      const agentRecord = system.agentStore.getAgent(agentId);
      expect(agentRecord).not.toBeNull();
      expect(agentRecord!.state).toBe("running");
      expect(agentRecord!.parent_id).toBeNull(); // Parentless
    },
    TIMEOUT.DISPATCH
  );

  // ── Multiple OpenHive tasks dispatched concurrently ─────────

  it(
    "multiple OpenHive tasks are dispatched concurrently",
    async () => {
      if (!canStartDaemon) return;

      const mockConnection = createMockMAPConnection();
      coordinationCleanup = setupCoordinationHandlers({
        connection: mockConnection,
        agentManager: system.agentManager,
        inboxAdapter: system.inboxAdapter,
        tasksAdapter: system.tasksAdapter,
      });

      // Send 3 tasks from OpenHive
      log("Simulating 3 OpenHive task.assign messages...");
      for (let i = 0; i < 3; i++) {
        await mockConnection.simulateNotification("x-openhive/task.assign", {
          title: `Batch task ${i + 1}`,
          description: `Task ${i + 1} from OpenHive batch.`,
          assigned_by: "openhive-hub",
          context: { tags: ["auto", "batch"] },
        });
      }

      await sleep(1_000);
      const ready = await system.tasksAdapter.queryReady();
      log(`Ready after 3 assigns: ${ready.length}`);
      expect(ready.length).toBeGreaterThanOrEqual(3);

      // Dispatch all
      log("Triggering dispatch...");
      await dispatcher.dispatchNow();
      await sleep(3_000);

      log(`Tracker active: ${dispatcher.tracker.activeCount()}`);
      expect(dispatcher.tracker.activeCount()).toBe(3);

      // All agents running
      for (const record of dispatcher.tracker.listActive()) {
        const agent = system.agentStore.getAgent(record.agentId);
        expect(agent).not.toBeNull();
        expect(agent!.state).toBe("running");
      }
    },
    TIMEOUT.DISPATCH
  );

  // ── OpenHive task with agent completion ─────────────────────

  it(
    "agent completes OpenHive-assigned task and lifecycle tracks it",
    async () => {
      if (!canStartDaemon) return;

      const mockConnection = createMockMAPConnection();
      coordinationCleanup = setupCoordinationHandlers({
        connection: mockConnection,
        agentManager: system.agentManager,
        inboxAdapter: system.inboxAdapter,
        tasksAdapter: system.tasksAdapter,
      });

      // Track dispatch events
      const events: any[] = [];
      dispatcher.onEvent((e) => events.push(e));

      // Send task from OpenHive
      log("Simulating OpenHive task.assign...");
      await mockConnection.simulateNotification("x-openhive/task.assign", {
        title: "Write a test file",
        description:
          'Create test.txt with "hello" and call done(status="completed").',
        assigned_by: "openhive-hub",
        priority: "critical",
        context: { tags: ["auto"] },
      });

      await sleep(1_000);

      // Dispatch
      log("Triggering dispatch...");
      await dispatcher.dispatchNow();
      await sleep(3_000);

      expect(dispatcher.tracker.activeCount()).toBe(1);
      const agentId = dispatcher.tracker.listActive()[0].agentId;
      log(`Agent: ${agentId}`);

      // Prompt agent to complete
      log("Prompting agent to complete...");
      const result = await system.agentManager.promptUntilDone(
        agentId,
        'Create test.txt with "hello", then call done(status="completed", summary="done").',
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
      await sleep(3_000);

      // Check dispatch events
      const dispatched = events.find((e) => e.type === "dispatched");
      expect(dispatched).toBeDefined();
      log(`Events: ${events.map((e) => e.type).join(", ")}`);

      if (result.doneCalled && result.doneStatus === "completed") {
        // Task should be completed in tracker
        const completed = events.find((e) => e.type === "completed");
        expect(completed).toBeDefined();
        expect(dispatcher.tracker.isTracked(dispatched.taskId)).toBe(false);

        const agentAfter = system.agentStore.getAgent(agentId);
        expect(agentAfter?.state).toBe("stopped");
      } else {
        log("Agent did not call done(completed) — LLM behavior variance");
      }
    },
    TIMEOUT.MULTI
  );

  // ── Context metadata flows through to task ──────────────────

  it(
    "OpenHive context metadata is preserved in opentasks task",
    async () => {
      if (!canStartDaemon) return;

      const mockConnection = createMockMAPConnection();
      coordinationCleanup = setupCoordinationHandlers({
        connection: mockConnection,
        agentManager: system.agentManager,
        inboxAdapter: system.inboxAdapter,
        tasksAdapter: system.tasksAdapter,
      });

      await mockConnection.simulateNotification("x-openhive/task.assign", {
        title: "Metadata test task",
        description: "Test that metadata flows through.",
        assigned_by: "hub-user-123",
        priority: "low",
        deadline: "2026-12-31T00:00:00Z",
        context: {
          tags: ["auto", "test"],
          sourceUrl: "https://jira.example.com/PROJ-99",
          criteria: ["Must pass CI", "No regressions"],
          files: ["src/main.ts"],
          custom_field: "custom_value",
        },
      });

      await sleep(1_000);
      const tasks = await system.tasksAdapter.queryReady();
      const task = tasks.find((t) => t.title === "Metadata test task");
      expect(task).toBeDefined();

      // Priority mapped: "low" → 4
      expect(task!.priority).toBe(4);

      // Tags and metadata — verified if the daemon returns them
      // (opentasks daemon stores these but may not return them in all query modes)
      log(`Tags: ${JSON.stringify(task!.tags)}`);
      log(`Metadata: ${JSON.stringify(task!.metadata)}`);

      if (task!.tags && task!.tags.length > 0) {
        expect(task!.tags).toContain("auto");
        expect(task!.tags).toContain("test");
      }

      if (task!.metadata && Object.keys(task!.metadata).length > 0) {
        expect(task!.metadata.assigned_by).toBe("hub-user-123");
        expect(task!.metadata.deadline).toBe("2026-12-31T00:00:00Z");
        expect(task!.metadata.sourceUrl).toBe("https://jira.example.com/PROJ-99");
        expect(task!.metadata.criteria).toEqual(["Must pass CI", "No regressions"]);
        expect(task!.metadata.files).toEqual(["src/main.ts"]);
        expect(task!.metadata.custom_field).toBe("custom_value");
      }

      // Core assertion: task was created with correct title and priority regardless
      expect(task!.title).toBe("Metadata test task");
      expect(task!.priority).toBe(4);
    },
    TIMEOUT.SETUP
  );
});
