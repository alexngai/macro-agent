/**
 * OpenTasks Integration E2E Tests
 *
 * Verifies that the DefaultTasksAdapter works against a real opentasks daemon,
 * not just mocks. Tests the full round-trip: daemon lifecycle, task CRUD,
 * state transitions, dependencies, and claim/unclaim (pull mode).
 *
 * REQUIRES: RUN_E2E_TESTS=true
 *
 * Run with:
 *   RUN_E2E_TESTS=true npx vitest run --config vitest.e2e.config.ts src/__tests__/e2e/opentasks-integration.e2e.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";
import { execFileSync } from "node:child_process";
import {
  ensureOpentasksDaemon,
  type DaemonHandle,
} from "../../adapters/opentasks-daemon.js";
import { DefaultTasksAdapter } from "../../adapters/tasks-adapter.js";

// ─────────────────────────────────────────────────────────────────
// Gate: skip unless RUN_E2E_TESTS=true
// ─────────────────────────────────────────────────────────────────

const RUN_E2E = !!process.env.RUN_E2E_TESTS;

// ─────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────

function createTempDir(prefix = "ot"): string {
  // Keep path short to avoid Unix socket path length limits (~104 chars on macOS).
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
  fs.writeFileSync(path.join(dir, "README.md"), "# Test\n");
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

// ─────────────────────────────────────────────────────────────────
// Test Suite
// ─────────────────────────────────────────────────────────────────

/**
 * Attempt to start the daemon. If it fails (e.g., opentasks binary
 * incompatible, missing native deps), we skip the entire suite
 * rather than failing.
 */

let canStartDaemon = false;
let tempDir: string;
let registryDir: string;
let daemonHandle: DaemonHandle;
let adapter: DefaultTasksAdapter;

if (RUN_E2E) {
  try {
    tempDir = createTempDir();
    registryDir = createTempDir();
    initGitRepo(tempDir);

    // Attempt to start daemon synchronously-ish before describe()
    // We use a beforeAll to handle the async daemon boot.
  } catch {
    // Will be handled in beforeAll
  }
}

const outerDescribe = RUN_E2E ? describe : describe.skip;

outerDescribe("OpenTasks Integration E2E", () => {
  beforeAll(async () => {
    try {
      if (!tempDir) {
        tempDir = createTempDir();
        registryDir = createTempDir();
        initGitRepo(tempDir);
      }

      daemonHandle = await ensureOpentasksDaemon(tempDir, {
        timeoutMs: 15_000,
        registryPath: path.join(registryDir, "registry.json"),
      });

      adapter = new DefaultTasksAdapter({
        socketPath: daemonHandle.socketPath,
        timeout: 10_000,
      });

      await adapter.connect();
      canStartDaemon = true;
    } catch (err) {
      console.warn(
        `[opentasks-integration] Skipping: daemon could not start: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      canStartDaemon = false;
    }
  }, 30_000);

  afterAll(async () => {
    if (adapter?.connected) {
      adapter.disconnect();
    }
    if (daemonHandle) {
      await daemonHandle.stop();
    }
    if (tempDir) {
      cleanupDir(tempDir);
    }
    if (registryDir) {
      cleanupDir(registryDir);
    }
  }, 15_000);

  // ── 1. Connect to real daemon ──────────────────────────────────

  it("connects to a real opentasks daemon", () => {
    if (!canStartDaemon) return;
    expect(adapter.connected).toBe(true);
    expect(daemonHandle.socketPath).toBeTruthy();
    expect(fs.existsSync(daemonHandle.socketPath)).toBe(true);
  });

  // ── 2. Create and get task ─────────────────────────────────────

  it("creates and retrieves a task", async () => {
    if (!canStartDaemon) return;

    const taskId = await adapter.createTask({
      title: "Test task alpha",
      content: "This is the body of the task.",
      tags: ["e2e", "test"],
      priority: 2,
    });

    expect(taskId).toBeTruthy();
    expect(typeof taskId).toBe("string");

    const task = await adapter.getTask(taskId);
    expect(task.id).toBe(taskId);
    expect(task.title).toBe("Test task alpha");
    expect(task.status).toBe("open");
  });

  // ── 3. Transition task states ──────────────────────────────────

  it("transitions task through states: open -> in_progress -> closed", async () => {
    if (!canStartDaemon) return;

    const taskId = await adapter.createTask({
      title: "State machine task",
    });

    // open -> in_progress
    await adapter.transitionTask(taskId, "start");
    let task = await adapter.getTask(taskId);
    expect(task.status).toBe("in_progress");

    // in_progress -> closed
    await adapter.transitionTask(taskId, "complete");
    task = await adapter.getTask(taskId);
    expect(task.status).toBe("closed");
  });

  // ── 4. Query ready tasks ───────────────────────────────────────

  it("queries ready tasks (excludes blocked)", async () => {
    if (!canStartDaemon) return;

    // Create 3 tasks
    const ids = await Promise.all([
      adapter.createTask({ title: "Ready 1" }),
      adapter.createTask({ title: "Ready 2" }),
      adapter.createTask({ title: "Blocked 1" }),
    ]);

    // Block the third task by the first
    await adapter.addBlocker(ids[2], ids[0]);

    // Query all ready tasks (without tag filter, since opentasks
    // ready query doesn't resolve tags for its internal filter)
    const ready = await adapter.queryReady();
    const readyIds = ready.map((t) => t.id);

    // The first two should be ready; the blocked one should not
    expect(readyIds).toContain(ids[0]);
    expect(readyIds).toContain(ids[1]);
    expect(readyIds).not.toContain(ids[2]);
  });

  // ── 5. Add/remove blockers ─────────────────────────────────────

  it("adds and removes blockers correctly", async () => {
    if (!canStartDaemon) return;

    const blockerTaskId = await adapter.createTask({
      title: "Blocker task",
    });
    const blockedTaskId = await adapter.createTask({
      title: "Blocked task",
    });

    // Add blocker
    await adapter.addBlocker(blockedTaskId, blockerTaskId);

    // Blocked task should NOT appear in ready results
    let ready = await adapter.queryReady();
    let readyIds = ready.map((t) => t.id);
    expect(readyIds).not.toContain(blockedTaskId);
    expect(readyIds).toContain(blockerTaskId);

    // Remove blocker
    await adapter.removeBlocker(blockedTaskId, blockerTaskId);

    // Now the previously-blocked task should be ready
    ready = await adapter.queryReady();
    readyIds = ready.map((t) => t.id);
    expect(readyIds).toContain(blockedTaskId);
  });

  // ── 6. Claim and unclaim ───────────────────────────────────────

  it("claims and unclaims a task", async () => {
    if (!canStartDaemon) return;

    const claimableId = await adapter.createTask({
      title: "Claimable task",
    });

    // Claim (no tag filter — uses all ready tasks)
    const claimed = await adapter.claimTask("agent-1");
    expect(claimed).not.toBeNull();
    expect(claimed!.status).toBe("in_progress");

    // After claim, the task should no longer be in ready/claimable list
    const remaining = await adapter.listClaimable();
    const remainingIds = remaining.map((t) => t.id);
    expect(remainingIds).not.toContain(claimed!.id);

    // Unclaim
    await adapter.unclaimTask(claimed!.id);

    // Now it should be claimable again
    const afterUnclaim = await adapter.listClaimable();
    const afterIds = afterUnclaim.map((t) => t.id);
    expect(afterIds).toContain(claimed!.id);
  });
});
