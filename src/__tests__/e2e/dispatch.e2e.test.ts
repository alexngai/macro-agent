/**
 * Task Dispatch E2E Tests (mocked agents)
 *
 * Tests dispatch boot wiring, configuration, and basic dispatch flow
 * using mocked acp-factory and opentasks (no real agents or daemon).
 *
 * REQUIRES: RUN_E2E_TESTS=true
 *
 * Run with:
 *   RUN_E2E_TESTS=true npx vitest run --config vitest.e2e.config.ts src/__tests__/e2e/dispatch.e2e.test.ts
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
// Mocks
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
    `dispatch-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ─────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────

describeFn("Task Dispatch E2E", () => {
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

  // ── Boot with dispatch enabled ─────────────────────────────

  describe("Boot", () => {
    it("boots successfully with dispatch enabled", async () => {
      system = await bootV2({
        cwd: testDir,
        baseDir: testDir,
        inbox: { socketPath: path.join(testDir, "inbox.sock") },
        dispatch: {
          enabled: true,
          pollIntervalMs: 60_000,
          maxConcurrent: 3,
          defaultRole: "worker",
        },
      });

      expect(system).toBeDefined();
      expect(system.taskDispatcher).toBeDefined();
      expect(system.taskDispatcher!.running).toBe(true);
    });

    it("boots successfully with dispatch and reconcile enabled", async () => {
      system = await bootV2({
        cwd: testDir,
        baseDir: testDir,
        inbox: { socketPath: path.join(testDir, "inbox.sock") },
        dispatch: {
          enabled: true,
          pollIntervalMs: 60_000,
          maxConcurrent: 3,
          reconcile: { enabled: true, intervalMs: 120_000 },
        },
      });

      expect(system.taskDispatcher).toBeDefined();
      expect(system.taskDispatcher!.running).toBe(true);
    });

    it("boots without dispatch when not enabled", async () => {
      system = await bootV2({
        cwd: testDir,
        baseDir: testDir,
        inbox: { socketPath: path.join(testDir, "inbox.sock") },
      });

      expect(system.taskDispatcher).toBeUndefined();
    });

    it("exposes tracker for observability", async () => {
      system = await bootV2({
        cwd: testDir,
        baseDir: testDir,
        inbox: { socketPath: path.join(testDir, "inbox.sock") },
        dispatch: {
          enabled: true,
          pollIntervalMs: 60_000,
          maxConcurrent: 3,
        },
      });

      expect(system.taskDispatcher!.tracker).toBeDefined();
      expect(system.taskDispatcher!.tracker.activeCount()).toBe(0);
      expect(system.taskDispatcher!.tracker.listRetries()).toHaveLength(0);
    });
  });

  // ── Dispatch via dispatchNow ───────────────────────────────

  describe("Dispatch", () => {
    it("dispatchNow triggers a dispatch cycle", async () => {
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

      // dispatchNow should not throw even with no ready tasks
      await system.taskDispatcher!.dispatchNow();
      expect(system.taskDispatcher!.tracker.activeCount()).toBe(0);
    });

    it("reconcileNow triggers a reconciliation cycle", async () => {
      system = await bootV2({
        cwd: testDir,
        baseDir: testDir,
        inbox: { socketPath: path.join(testDir, "inbox.sock") },
        dispatch: {
          enabled: true,
          pollIntervalMs: 600_000,
          maxConcurrent: 3,
          reconcile: { enabled: true, intervalMs: 600_000 },
        },
      });

      // reconcileNow should not throw with no active dispatches
      await system.taskDispatcher!.reconcileNow();
    });
  });

  // ── Event subscription ─────────────────────────────────────

  describe("Events", () => {
    it("emits poll events via onEvent", async () => {
      system = await bootV2({
        cwd: testDir,
        baseDir: testDir,
        inbox: { socketPath: path.join(testDir, "inbox.sock") },
        dispatch: {
          enabled: true,
          pollIntervalMs: 600_000,
        },
      });

      const events: any[] = [];
      system.taskDispatcher!.onEvent((e) => events.push(e));

      await system.taskDispatcher!.dispatchNow();

      const poll = events.find((e) => e.type === "poll");
      expect(poll).toBeDefined();
      expect(poll.dispatched).toBe(0);
      expect(poll.active).toBe(0);
    });
  });

  // ── Shutdown ───────────────────────────────────────────────

  describe("Shutdown", () => {
    it("shuts down cleanly with dispatch enabled", async () => {
      system = await bootV2({
        cwd: testDir,
        baseDir: testDir,
        inbox: { socketPath: path.join(testDir, "inbox.sock") },
        dispatch: {
          enabled: true,
          pollIntervalMs: 60_000,
          maxConcurrent: 3,
          reconcile: { enabled: true, intervalMs: 120_000 },
        },
      });

      await system.shutdown();
      system = undefined as any;
    });
  });

  // ── Config Variations ──────────────────────────────────────

  describe("Configuration", () => {
    it("applies custom config values", async () => {
      system = await bootV2({
        cwd: testDir,
        baseDir: testDir,
        inbox: { socketPath: path.join(testDir, "inbox.sock") },
        dispatch: {
          enabled: true,
          pollIntervalMs: 5_000,
          maxConcurrent: 10,
          defaultRole: "security-auditor",
          tags: ["security", "audit"],
          maxRetries: 5,
          retryBaseDelayMs: 5_000,
          retryMaxDelayMs: 120_000,
          reconcile: { enabled: true, intervalMs: 30_000 },
          eligibility: {
            minPriority: 3,
            excludeTags: ["wip"],
            minScore: 0.5,
          },
        },
      });

      expect(system.taskDispatcher).toBeDefined();
      expect(system.taskDispatcher!.running).toBe(true);
    });

    it("boots without reconcile when reconcile.enabled is false", async () => {
      system = await bootV2({
        cwd: testDir,
        baseDir: testDir,
        inbox: { socketPath: path.join(testDir, "inbox.sock") },
        dispatch: {
          enabled: true,
          pollIntervalMs: 60_000,
          reconcile: { enabled: false },
        },
      });

      // Dispatcher should still work — just no reconcile timer
      expect(system.taskDispatcher).toBeDefined();
      expect(system.taskDispatcher!.running).toBe(true);
    });
  });
});
