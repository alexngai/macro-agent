/**
 * Task Dispatch Phase 2 E2E Tests (mocked agents)
 *
 * Tests dispatch boot wiring for Phase 2 ports: MessagePort (agent-inbox),
 * AgentRoster (inbox agent listing), dispatch mode selection, snapshot,
 * and mail routing configuration.
 *
 * Uses the same mock strategy as dispatch.e2e.test.ts — mocked acp-factory
 * and opentasks (no real agents or daemon).
 *
 * REQUIRES: RUN_E2E_TESTS=true
 *
 * Run with:
 *   RUN_E2E_TESTS=true npx vitest run --config vitest.e2e.config.ts src/__tests__/e2e/dispatch-phase2.e2e.test.ts
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
import { bootV2, type MacroAgentSystemV2 } from "../../boot-v2.js";

// ─────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────

const RUN_E2E = !!process.env.RUN_E2E_TESTS;
const describeFn = RUN_E2E ? describe : describe.skip;

// ─────────────────────────────────────────────────────────────────
// Mocks (same as dispatch.e2e.test.ts)
// ─────────────────────────────────────────────────────────────────

vi.mock("acp-factory", () => ({
  AgentFactory: {
    spawn: vi.fn().mockResolvedValue({
      createSession: vi.fn().mockResolvedValue({
        id: `session-${Date.now()}`,
        prompt: vi.fn().mockReturnValue({
          [Symbol.asyncIterator]: () => ({
            next: () => Promise.resolve({ done: true, value: undefined }),
          }),
        }),
        forkWithFlush: vi.fn().mockResolvedValue({ id: `forked-${Date.now()}` }),
      }),
      loadSession: vi.fn().mockResolvedValue({ id: `loaded-${Date.now()}` }),
      close: vi.fn().mockResolvedValue(undefined),
      isRunning: vi.fn().mockReturnValue(true),
    }),
  },
}));

vi.mock("opentasks", () => ({
  OpenTasksClient: vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockRejectedValue(new Error("No daemon")),
    disconnect: vi.fn(),
    query: vi.fn().mockResolvedValue({ items: [] }),
    link: vi.fn().mockResolvedValue({ success: true }),
    task: vi.fn().mockResolvedValue({ id: "t-1" }),
  })),
}));

// ─────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────

function createTestDir(): string {
  const dir = path.join(
    os.tmpdir(),
    `dispatch-p2-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ─────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────

describeFn("Task Dispatch Phase 2 E2E", () => {
  let system: MacroAgentSystemV2;
  let testDir: string;

  beforeEach(async () => {
    testDir = createTestDir();
  });

  afterEach(async () => {
    if (system) {
      try {
        const running = system.agentManager.list({ state: "running" } as any);
        for (const agent of running) {
          await system.agentManager.terminate(agent.id, "cancelled");
        }
      } catch { /* best effort */ }
      await system.shutdown();
    }
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  // ── Phase 2 boot wiring ───────────────────────────────────

  describe("Phase 2 Boot", () => {
    it("boots with mail routing and roster enabled by default", async () => {
      system = await bootV2({
        cwd: testDir,
        baseDir: testDir,
        inbox: { socketPath: path.join(testDir, "inbox.sock") },
        dispatch: {
          enabled: true,
          pollIntervalMs: 600_000,
          maxConcurrent: 3,
        },
      });

      expect(system.taskDispatcher).toBeDefined();
      expect(system.taskDispatcher!.running).toBe(true);
    });

    it("boots with mail routing explicitly disabled", async () => {
      system = await bootV2({
        cwd: testDir,
        baseDir: testDir,
        inbox: { socketPath: path.join(testDir, "inbox.sock") },
        dispatch: {
          enabled: true,
          pollIntervalMs: 600_000,
          enableMailRouting: false,
        },
      });

      expect(system.taskDispatcher).toBeDefined();
      expect(system.taskDispatcher!.running).toBe(true);
    });

    it("boots with roster explicitly disabled", async () => {
      system = await bootV2({
        cwd: testDir,
        baseDir: testDir,
        inbox: { socketPath: path.join(testDir, "inbox.sock") },
        dispatch: {
          enabled: true,
          pollIntervalMs: 600_000,
          enableRoster: false,
        },
      });

      expect(system.taskDispatcher).toBeDefined();
      expect(system.taskDispatcher!.running).toBe(true);
    });

    it("boots with custom dispatchMode override", async () => {
      system = await bootV2({
        cwd: testDir,
        baseDir: testDir,
        inbox: { socketPath: path.join(testDir, "inbox.sock") },
        dispatch: {
          enabled: true,
          pollIntervalMs: 600_000,
          dispatchMode: "spawn-only",
        },
      });

      expect(system.taskDispatcher).toBeDefined();
      expect(system.taskDispatcher!.running).toBe(true);
    });

    it("boots with route-only mode", async () => {
      system = await bootV2({
        cwd: testDir,
        baseDir: testDir,
        inbox: { socketPath: path.join(testDir, "inbox.sock") },
        dispatch: {
          enabled: true,
          pollIntervalMs: 600_000,
          dispatchMode: "route-only",
        },
      });

      expect(system.taskDispatcher).toBeDefined();
      expect(system.taskDispatcher!.running).toBe(true);
    });

    it("boots with continuation config", async () => {
      system = await bootV2({
        cwd: testDir,
        baseDir: testDir,
        inbox: { socketPath: path.join(testDir, "inbox.sock") },
        dispatch: {
          enabled: true,
          pollIntervalMs: 600_000,
          continuation: { delayMs: 2_000, maxTurns: 10 },
        },
      });

      expect(system.taskDispatcher).toBeDefined();
      expect(system.taskDispatcher!.running).toBe(true);
    });

    it("boots with stall timeout configured", async () => {
      system = await bootV2({
        cwd: testDir,
        baseDir: testDir,
        inbox: { socketPath: path.join(testDir, "inbox.sock") },
        dispatch: {
          enabled: true,
          pollIntervalMs: 600_000,
          reconcile: { enabled: true, intervalMs: 60_000, stallTimeoutMs: 120_000 },
        },
      });

      expect(system.taskDispatcher).toBeDefined();
      expect(system.taskDispatcher!.running).toBe(true);
    });
  });

  // ── Snapshot ──────────────────────────────────────────────

  describe("Snapshot", () => {
    it("snapshot returns Phase 2 fields", async () => {
      system = await bootV2({
        cwd: testDir,
        baseDir: testDir,
        inbox: { socketPath: path.join(testDir, "inbox.sock") },
        dispatch: {
          enabled: true,
          pollIntervalMs: 600_000,
          maxConcurrent: 3,
        },
      });

      const snap = system.taskDispatcher!.snapshot();
      expect(snap).toBeDefined();
      expect(snap.generatedAt).toBeTruthy();
      expect(snap.counts).toMatchObject({
        running: 0,
        retryQueued: 0,
        continuing: 0,
        claimed: 0,
      });
      expect(snap.running).toHaveLength(0);
      expect(snap.retryQueued).toHaveLength(0);
      expect(snap.subscriberErrorCount).toBe(0);
      // Phase 2: totals are present (even if zero)
      expect(snap.totals).toBeDefined();
      expect(snap.totals!.tokens).toMatchObject({
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      });
      expect(snap.totals!.agentSeconds).toBeGreaterThanOrEqual(0);
    });
  });

  // ── Dispatch + Reconcile ──────────────────────────────────

  describe("Dispatch with Phase 2 ports", () => {
    it("dispatchNow works with mail routing enabled", async () => {
      system = await bootV2({
        cwd: testDir,
        baseDir: testDir,
        inbox: { socketPath: path.join(testDir, "inbox.sock") },
        dispatch: {
          enabled: true,
          pollIntervalMs: 600_000,
          maxConcurrent: 5,
        },
      });

      // No tasks ready — should complete cleanly.
      await system.taskDispatcher!.dispatchNow();
      expect(system.taskDispatcher!.tracker.activeCount()).toBe(0);
    });

    it("reconcileNow works with stall detection configured", async () => {
      system = await bootV2({
        cwd: testDir,
        baseDir: testDir,
        inbox: { socketPath: path.join(testDir, "inbox.sock") },
        dispatch: {
          enabled: true,
          pollIntervalMs: 600_000,
          maxConcurrent: 3,
          reconcile: { enabled: true, intervalMs: 600_000, stallTimeoutMs: 10_000 },
        },
      });

      // No active dispatches — reconcile should complete cleanly.
      await system.taskDispatcher!.reconcileNow();
    });

    it("emits poll events with Phase 2 config", async () => {
      system = await bootV2({
        cwd: testDir,
        baseDir: testDir,
        inbox: { socketPath: path.join(testDir, "inbox.sock") },
        dispatch: {
          enabled: true,
          pollIntervalMs: 600_000,
          dispatchMode: "prefer-route",
        },
      });

      const events: any[] = [];
      system.taskDispatcher!.onEvent((e) => events.push(e));
      await system.taskDispatcher!.dispatchNow();

      const poll = events.find((e: any) => e.type === "poll");
      expect(poll).toBeDefined();
      expect(poll.dispatched).toBe(0);
      expect(poll.active).toBe(0);
    });

    it("emits reconciled events with stall/cancelled counts", async () => {
      system = await bootV2({
        cwd: testDir,
        baseDir: testDir,
        inbox: { socketPath: path.join(testDir, "inbox.sock") },
        dispatch: {
          enabled: true,
          pollIntervalMs: 600_000,
          reconcile: { enabled: true, intervalMs: 600_000, stallTimeoutMs: 10_000 },
        },
      });

      const events: any[] = [];
      system.taskDispatcher!.onEvent((e) => events.push(e));
      await system.taskDispatcher!.reconcileNow();

      const reconciled = events.find((e: any) => e.type === "reconciled");
      expect(reconciled).toBeDefined();
      expect(reconciled.checked).toBe(0);
      expect(reconciled.cancelled).toBe(0);
      expect(reconciled.stalled).toBe(0);
    });
  });

  // ── Shutdown ──────────────────────────────────────────────

  describe("Shutdown with Phase 2 ports", () => {
    it("shuts down cleanly with all Phase 2 ports enabled", async () => {
      system = await bootV2({
        cwd: testDir,
        baseDir: testDir,
        inbox: { socketPath: path.join(testDir, "inbox.sock") },
        dispatch: {
          enabled: true,
          pollIntervalMs: 60_000,
          maxConcurrent: 3,
          dispatchMode: "prefer-route",
          continuation: { delayMs: 1_000, maxTurns: 5 },
          reconcile: { enabled: true, intervalMs: 120_000, stallTimeoutMs: 300_000 },
        },
      });

      expect(system.taskDispatcher!.running).toBe(true);
      await system.shutdown();
      system = undefined as any;
    });

    it("shuts down cleanly with route-only mode", async () => {
      system = await bootV2({
        cwd: testDir,
        baseDir: testDir,
        inbox: { socketPath: path.join(testDir, "inbox.sock") },
        dispatch: {
          enabled: true,
          pollIntervalMs: 60_000,
          dispatchMode: "route-only",
        },
      });

      await system.shutdown();
      system = undefined as any;
    });
  });
});
