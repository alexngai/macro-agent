/**
 * Task Dispatch Phase 2 Live Agent E2E Tests
 *
 * Tests the Phase 2 dispatch orchestrator with REAL Claude Code agents.
 * Constructs the orchestrator manually (like dispatch-live.e2e.test.ts)
 * with Phase 2 ports to verify:
 * - createOrchestrator with MessagePort + AgentRoster
 * - Snapshot includes Phase 2 fields during live execution
 * - Event emission with Phase 2 event types (dispatched.via)
 * - Dispatch mode prefer-route falls back to spawn (no roster agents)
 * - Lifecycle events tracked through Phase 2 orchestrator
 *
 * REQUIRES: RUN_FULL_AGENT_TESTS=true
 *
 * Run with:
 *   RUN_FULL_AGENT_TESTS=true npx vitest run --config vitest.e2e.config.ts src/__tests__/e2e/dispatch-phase2-live.e2e.test.ts
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
  createOrchestrator,
  type Orchestrator,
  type DispatchAgentRuntime,
  type DispatchTaskSource,
  type DispatchEvent,
  type Snapshot,
  type AgentRoster,
  type AgentRef,
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
    path.join(os.tmpdir(), `dispatch-p2-live-${prefix}-`)
  );
  const repoPath = path.join(tmpDir, "test-repo");
  fs.mkdirSync(repoPath);
  execSync("git init", { cwd: repoPath, stdio: "pipe" });
  execSync('git config user.email "test@test.com"', { cwd: repoPath, stdio: "pipe" });
  execSync('git config user.name "Test User"', { cwd: repoPath, stdio: "pipe" });
  fs.writeFileSync(path.join(repoPath, "README.md"), "# Test Repo\n");
  execSync("git add -A", { cwd: repoPath, stdio: "pipe" });
  execSync('git commit -m "Initial commit"', { cwd: repoPath, stdio: "pipe" });
  return {
    path: repoPath,
    cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }),
  };
}

function log(msg: string): void {
  console.log(`[DISPATCH-P2-LIVE] ${msg}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createSourceAdapter(tasksAdapter: any): DispatchTaskSource {
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
    isStillActive: async (taskId) => {
      try {
        const t = await tasksAdapter.getTask(taskId);
        return t.status === "open";
      } catch { return false; }
    },
    listInProgress: async () => tasksAdapter.listTasks({ status: "in_progress" }),
  };
}

function createRuntimeAdapter(agentManager: any): DispatchAgentRuntime {
  return {
    spawn: async (opts) => {
      const spawned = await agentManager.spawn({
        task: opts.prompt, task_id: opts.taskId, role: opts.role, parent: null,
      });
      return { id: spawned.id };
    },
    terminate: async (agentId, reason) => agentManager.terminate(agentId, reason ?? "cancelled"),
    onStopped: (cb) => agentManager.onLifecycleEvent((event: any) => {
      if (event.type === "stopped") cb(event.agent.id, event.reason);
    }),
  };
}

function createEmptyRoster(): AgentRoster {
  return {
    async findAvailable() { return []; },
  };
}

// ─────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────

describeFn("Task Dispatch Phase 2 Live Agent E2E", () => {
  let system: MacroAgentSystemV2;
  let testRepo: { path: string; cleanup: () => void };
  let baseDir: string;
  let orchestrator: Orchestrator;

  beforeEach(async () => {
    testRepo = createTestRepo("p2");
    baseDir = path.join(testRepo.path, ".macro-agent");
    fs.mkdirSync(baseDir, { recursive: true });

    system = await bootV2({
      cwd: testRepo.path,
      baseDir,
      defaultPermissionMode: "auto-approve",
      inbox: { socketPath: path.join(baseDir, "inbox.sock") },
    });
    log("System booted");
  });

  afterEach(async () => {
    if (orchestrator) await orchestrator.stop();
    if (system) {
      try {
        const running = system.agentManager.list({ state: "running" });
        for (const agent of running) {
          try { await system.agentManager.terminate(agent.id, "cancelled"); } catch {}
        }
        await system.shutdown();
      } catch {}
    }
    testRepo?.cleanup();
    log("Cleanup complete");
  });

  function mockTasksAdapter(tasks: TaskRecord[]): void {
    const tasksAdapter = system.tasksAdapter;
    const taskMap = new Map(tasks.map((t) => [t.id, t]));
    (tasksAdapter as any).queryReady = vi.fn()
      .mockResolvedValueOnce(tasks)
      .mockResolvedValue([]);
    (tasksAdapter as any).assignTask = vi.fn().mockResolvedValue(undefined);
    (tasksAdapter as any).transitionTask = vi.fn().mockResolvedValue(undefined);
    (tasksAdapter as any).unclaimTask = vi.fn().mockResolvedValue(undefined);
    (tasksAdapter as any).getTask = vi.fn().mockImplementation(
      async (id: string) => taskMap.get(id) ?? { id, title: "Unknown", status: "open" }
    );
    (tasksAdapter as any).listTasks = vi.fn().mockResolvedValue([]);
  }

  // ── createOrchestrator with Phase 2 ports ──────────────────

  it(
    "dispatches via createOrchestrator with Phase 2 config (prefer-route → spawn fallback)",
    async () => {
      const task: TaskRecord = {
        id: "p2-live-1",
        title: "Create hello file",
        content:
          'Create a file called hello.txt with the text "hello from phase 2". ' +
          'Then call the "done" MCP tool with status="completed" and summary="Created hello.txt".',
        status: "open",
        tags: ["auto"],
        priority: 3,
      };
      mockTasksAdapter([task]);

      const events: DispatchEvent[] = [];
      orchestrator = createOrchestrator(
        createSourceAdapter(system.tasksAdapter),
        createRuntimeAdapter(system.agentManager),
        {
          claimantId: `test:${process.pid}:p2-live`,
          pollIntervalMs: 600_000,
          defaultRole: "worker",
          concurrency: { global: 3 },
          retry: { maxRetries: 3, baseDelayMs: 1_000, maxDelayMs: 60_000 },
          reconcile: { enabled: true, intervalMs: 600_000 },
          roster: createEmptyRoster(),
          dispatchMode: "prefer-route",
        }
      );
      orchestrator.onEvent((e) => events.push(e));
      await orchestrator.start();

      log("Triggering dispatch (prefer-route, empty roster → spawn fallback)...");
      await orchestrator.dispatchNow();
      await sleep(2_000);

      log(`Tracker active: ${orchestrator.tracker.activeCount()}`);
      expect(orchestrator.tracker.activeCount()).toBe(1);

      const dispatched = events.find(
        (e): e is Extract<DispatchEvent, { type: "dispatched" }> => e.type === "dispatched"
      );
      expect(dispatched).toBeDefined();
      expect(dispatched!.via).toBe("spawn");
      log(`Dispatched via: ${dispatched!.via}`);

      const agentId = dispatched!.agentId;
      const agentRecord = system.agentStore.getAgent(agentId);
      expect(agentRecord).not.toBeNull();
      expect(agentRecord!.state).toBe("running");
      expect(agentRecord!.parent_id).toBeNull();

      // Prompt agent to complete
      log("Prompting agent to complete...");
      const result = await system.agentManager.promptUntilDone(
        agentId,
        'Create hello.txt with "hello from phase 2", then call done(status="completed", summary="Created hello.txt").',
        { maxFollowUps: 3 }
      );
      log(`Done result: doneCalled=${result.doneCalled}, status=${result.doneStatus}`);
      await sleep(3_000);

      if (result.doneCalled && result.doneStatus === "completed") {
        const helloPath = path.join(testRepo.path, "hello.txt");
        if (fs.existsSync(helloPath)) {
          expect(fs.readFileSync(helloPath, "utf-8")).toContain("hello from phase 2");
          log("hello.txt verified");
        }
      }
    },
    TIMEOUT.MULTI
  );

  // ── Snapshot during live execution ─────────────────────────

  it(
    "snapshot includes Phase 2 fields during live execution",
    async () => {
      const task: TaskRecord = {
        id: "snap-1",
        title: "Snapshot test",
        content: "Wait for instructions. Do not call done().",
        status: "open",
      };
      mockTasksAdapter([task]);

      orchestrator = createOrchestrator(
        createSourceAdapter(system.tasksAdapter),
        createRuntimeAdapter(system.agentManager),
        {
          claimantId: `test:${process.pid}:snap`,
          pollIntervalMs: 600_000,
          defaultRole: "worker",
          concurrency: { global: 5 },
          retry: { maxRetries: 3, baseDelayMs: 1_000, maxDelayMs: 60_000 },
          reconcile: { enabled: true, intervalMs: 600_000 },
        }
      );
      await orchestrator.start();
      await orchestrator.dispatchNow();
      await sleep(2_000);

      const snap: Snapshot = orchestrator.snapshot();
      log(`Snapshot counts: ${JSON.stringify(snap.counts)}`);

      expect(snap.generatedAt).toBeTruthy();
      expect(snap.counts.running).toBe(1);
      expect(snap.running).toHaveLength(1);
      expect(snap.subscriberErrorCount).toBe(0);

      // Phase 2 fields
      expect(snap.totals).toBeDefined();
      expect(snap.totals!.tokens).toBeDefined();
      expect(snap.totals!.agentSeconds).toBeGreaterThanOrEqual(0);

      const entry = snap.running[0];
      expect(entry.taskId).toBe("snap-1");
      expect(entry.agentId).toBeTruthy();
      expect(entry.state).toBe("Running");
      expect(entry.origin).toBe("source");
      log(`Entry: taskId=${entry.taskId}, origin=${entry.origin}, agentSeconds=${snap.totals!.agentSeconds!.toFixed(1)}`);
    },
    TIMEOUT.DISPATCH
  );

  // ── Event types ────────────────────────────────────────────

  it(
    "emits Phase 2 event types during dispatch + reconcile",
    async () => {
      orchestrator = createOrchestrator(
        createSourceAdapter(system.tasksAdapter),
        createRuntimeAdapter(system.agentManager),
        {
          claimantId: `test:${process.pid}:events`,
          pollIntervalMs: 600_000,
          defaultRole: "worker",
          concurrency: { global: 3 },
          retry: { maxRetries: 3, baseDelayMs: 1_000, maxDelayMs: 60_000 },
          reconcile: { enabled: true, intervalMs: 600_000, stallTimeoutMs: 120_000 },
        }
      );

      const events: DispatchEvent[] = [];
      orchestrator.onEvent((e) => events.push(e));
      await orchestrator.start();

      // Empty dispatch → poll event
      await orchestrator.dispatchNow();
      const poll = events.find((e) => e.type === "poll");
      expect(poll).toBeDefined();

      // Empty reconcile → reconciled event
      await orchestrator.reconcileNow();
      const reconciled = events.find(
        (e): e is Extract<DispatchEvent, { type: "reconciled" }> => e.type === "reconciled"
      );
      expect(reconciled).toBeDefined();
      expect(reconciled!.stalled).toBe(0);
      log(`Events: poll + reconciled verified`);
    },
    TIMEOUT.SPAWN
  );

  // ── Lifecycle tracks termination ───────────────────────────

  it(
    "tracks agent termination and queues retry",
    async () => {
      const task: TaskRecord = {
        id: "term-1",
        title: "Terminate test",
        content: "Wait for instructions.",
        status: "open",
      };
      mockTasksAdapter([task]);

      const events: DispatchEvent[] = [];
      orchestrator = createOrchestrator(
        createSourceAdapter(system.tasksAdapter),
        createRuntimeAdapter(system.agentManager),
        {
          claimantId: `test:${process.pid}:term`,
          pollIntervalMs: 600_000,
          defaultRole: "worker",
          concurrency: { global: 3 },
          retry: { maxRetries: 3, baseDelayMs: 1_000, maxDelayMs: 60_000 },
          reconcile: { enabled: true, intervalMs: 600_000 },
        }
      );
      orchestrator.onEvent((e) => events.push(e));
      await orchestrator.start();
      await orchestrator.dispatchNow();
      await sleep(2_000);

      expect(orchestrator.tracker.activeCount()).toBe(1);
      const agentId = orchestrator.tracker.listActive()[0].agentId;
      log(`Agent: ${agentId}`);

      // Externally terminate
      await system.agentManager.terminate(agentId, "cancelled");
      await sleep(3_000);

      log(`Active: ${orchestrator.tracker.activeCount()}, Retries: ${orchestrator.tracker.listRetries().length}`);
      expect(orchestrator.tracker.isTracked("term-1")).toBe(true);

      const retrying = events.find((e) => e.type === "retrying");
      expect(retrying).toBeDefined();
      log(`Retrying event found: attempt=${(retrying as any)?.attempt}`);
    },
    TIMEOUT.DISPATCH
  );

  // ── Reconciliation with Phase 2 orchestrator ───────────────

  it(
    "reconciliation detects closed task and terminates agent",
    async () => {
      const task: TaskRecord = {
        id: "reconcile-p2",
        title: "Reconcile test",
        content: "Wait for instructions.",
        status: "open",
      };
      mockTasksAdapter([task]);

      const events: DispatchEvent[] = [];
      orchestrator = createOrchestrator(
        createSourceAdapter(system.tasksAdapter),
        createRuntimeAdapter(system.agentManager),
        {
          claimantId: `test:${process.pid}:reconcile`,
          pollIntervalMs: 600_000,
          defaultRole: "worker",
          concurrency: { global: 3 },
          retry: { maxRetries: 3, baseDelayMs: 1_000, maxDelayMs: 60_000 },
          reconcile: { enabled: true, intervalMs: 600_000 },
        }
      );
      orchestrator.onEvent((e) => events.push(e));
      await orchestrator.start();
      await orchestrator.dispatchNow();
      await sleep(2_000);

      expect(orchestrator.tracker.activeCount()).toBe(1);
      const agentId = orchestrator.tracker.listActive()[0].agentId;

      // Close the task externally
      (system.tasksAdapter as any).getTask = vi.fn().mockResolvedValue({
        ...task,
        status: "closed",
      });

      log("Triggering reconcile (task now closed)...");
      await orchestrator.reconcileNow();
      await sleep(3_000);

      expect(orchestrator.tracker.isTracked("reconcile-p2")).toBe(false);
      expect(orchestrator.tracker.activeCount()).toBe(0);

      const cancelled = events.find((e) => e.type === "cancelled");
      expect(cancelled).toBeDefined();
      log("Reconciliation cancelled the agent correctly");

      const finalRecord = system.agentStore.getAgent(agentId);
      expect(finalRecord?.state).toBe("stopped");
    },
    TIMEOUT.DISPATCH
  );
});
