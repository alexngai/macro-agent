/**
 * Workspace Lifecycle E2E Tests — LEGACY capability-dispatch path.
 *
 * These tests exercise the programmatic/capability-based spawn flow:
 * callers pass `capabilities: ["workspace.worktree"|"workspace.stream"|
 * "workspace.integrate"]` + `streamId`/`streamConfig` to `agentManager.spawn`,
 * and AgentManagerV2's `legacyCapabilityDispatch` allocates workspaces via
 * `WorkspaceManager.createWorkerWorkspace` / `createIntegratorWorkspace` /
 * `createCoordinatorWorkspace`.
 *
 * This path remains supported for programmatic callers that don't use team
 * YAML (e.g., tools, libraries). The V3 YAML-driven path is covered by
 * `workspace-v3.e2e.test.ts`.
 *
 * Scenarios verified:
 * - Boot with WorkspaceManager wired correctly
 * - Worker spawn creates worktree (capability-based)
 * - Cascade terminate cleans up child worktrees
 * - Coordinator creates integration stream via `workspace.stream` capability
 *
 * REQUIRES: RUN_E2E_TESTS=true (no real Claude Code agents)
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
import { GitCascadeAdapter } from "../../workspace/git-cascade-adapter.js";
import {
  DefaultWorkspaceManager,
  createWorkspaceManagerWithAdapter,
} from "../../workspace/workspace-manager.js";

// ─────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────

const RUN_E2E = !!process.env.RUN_E2E_TESTS;
const describeFn = RUN_E2E ? describe : describe.skip;

// Mock acp-factory (no real agents in CI)
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
        forkWithFlush: vi.fn().mockResolvedValue({
          id: `forked-${Date.now()}`,
        }),
      }),
      loadSession: vi.fn().mockResolvedValue({
        id: `loaded-${Date.now()}`,
      }),
      close: vi.fn().mockResolvedValue(undefined),
      isRunning: vi.fn().mockReturnValue(true),
    }),
  },
}));

// Mock opentasks (daemon not available in CI)
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
    `workspace-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Create a temp git repo with an initial commit.
 * Returns the repo path.
 */
function createGitRepo(baseDir: string): string {
  const repoPath = path.join(baseDir, "repo");
  fs.mkdirSync(repoPath, { recursive: true });
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
  execSync("git add .", { cwd: repoPath, stdio: "pipe" });
  execSync('git commit -m "Initial commit"', {
    cwd: repoPath,
    stdio: "pipe",
  });
  return repoPath;
}

// ─────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────

describeFn("Workspace Lifecycle E2E", () => {
  let system: MacroAgentSystemV2;
  let testDir: string;
  let repoPath: string;
  let adapter: GitCascadeAdapter;
  let workspaceManager: DefaultWorkspaceManager;

  beforeEach(async () => {
    testDir = createTestDir();
    repoPath = createGitRepo(testDir);

    const dbPath = path.join(testDir, "git-cascade.db");

    // Create GitCascadeAdapter and WorkspaceManager
    adapter = new GitCascadeAdapter({
      enabled: true,
      repoPath,
      dbPath,
    });

    workspaceManager = createWorkspaceManagerWithAdapter(adapter, {
      worktreeBaseDir: path.join(repoPath, ".worktrees"),
    });

    // Boot system with workspaceManager
    system = await bootV2({
      cwd: repoPath,
      baseDir: testDir,
      inbox: {
        socketPath: path.join(testDir, "inbox.sock"),
      },
      workspaceManager,
    });
  });

  afterEach(async () => {
    if (system) {
      await system.shutdown();
    }
    if (workspaceManager) {
      workspaceManager.close();
    }
    if (adapter) {
      adapter.close();
    }
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  // ── Test 1: Boot with WorkspaceManager ──────────────────────

  describe("BOOT: Boot with WorkspaceManager", () => {
    it("should wire workspaceManager correctly via bootV2", () => {
      // The system booted without errors — verify agents can be spawned
      expect(system.agentManager).toBeDefined();
      expect(system.agentStore).toBeDefined();
      // WorkspaceManager should be accessible (passed through)
      expect(workspaceManager).toBeDefined();
      expect(workspaceManager.getWorkspace("nonexistent")).toBeNull();
    });
  });

  // ── Test 2: Worker spawn creates worktree ───────────────────

  describe("WORKTREE: Worker spawn creates worktree", () => {
    it("should create a worktree when spawning a worker with streamId", async () => {
      // First create a coordinator with a stream
      const coordId = "coord-test-1";
      const streamId = workspaceManager.createIntegrationStream(coordId, {
        name: "test-feature",
      });
      expect(streamId).toBeDefined();

      // Pre-create a git-cascade task so the claimTask call can find it
      const dpTaskId = workspaceManager.createTask(streamId, {
        title: "Implement feature",
      });

      // Spawn a worker with the streamId and gitCascadeTaskId
      const worker = await system.agentManager.spawn({
        task: "Implement feature",
        role: "worker",
        streamId,
        gitCascadeTaskId: dpTaskId,
        capabilities: ["workspace.worktree"],
      });

      expect(worker.id).toBeDefined();

      // Verify agent record has workspace_path
      const record = system.agentStore.getAgent(worker.id);
      expect(record).not.toBeNull();
      expect(record!.workspace_path).toBeDefined();
      expect(record!.workspace_path).toBeTruthy();

      // Verify the worktree directory exists on disk
      expect(fs.existsSync(record!.workspace_path!)).toBe(true);

      // Verify workspace is tracked in the manager
      const ws = workspaceManager.getWorkspace(worker.id);
      expect(ws).not.toBeNull();
      expect(ws!.role).toBe("worker");
      expect(ws!.path).toBe(record!.workspace_path);
    });
  });

  // ── Test 4: Cascade terminate cleans up worktrees ───────────

  describe("CASCADE: Cascade terminate cleans up worktrees", () => {
    it("should deallocate child worktrees on cascade termination", async () => {
      // Spawn coordinator (parent)
      const coordinator = await system.agentManager.spawn({
        task: "Coordinate cascade test",
        role: "coordinator",
      });

      // Create stream for the coordinator
      const streamId = workspaceManager.createIntegrationStream(
        coordinator.id,
        { name: "cascade-feature" }
      );

      // Pre-create git-cascade tasks
      const dpTaskId1 = workspaceManager.createTask(streamId, {
        title: "Child 1",
      });
      const dpTaskId2 = workspaceManager.createTask(streamId, {
        title: "Child 2",
      });

      // Spawn child workers with worktrees
      const child1 = await system.agentManager.spawn({
        task: "Child 1",
        role: "worker",
        parent: coordinator.id,
        streamId,
        gitCascadeTaskId: dpTaskId1,
        capabilities: ["workspace.worktree"],
      });
      const child2 = await system.agentManager.spawn({
        task: "Child 2",
        role: "worker",
        parent: coordinator.id,
        streamId,
        gitCascadeTaskId: dpTaskId2,
        capabilities: ["workspace.worktree"],
      });

      // Verify worktrees exist
      const ws1 = workspaceManager.getWorkspace(child1.id);
      const ws2 = workspaceManager.getWorkspace(child2.id);
      expect(ws1).not.toBeNull();
      expect(ws2).not.toBeNull();
      expect(fs.existsSync(ws1!.path)).toBe(true);
      expect(fs.existsSync(ws2!.path)).toBe(true);

      // Terminate parent — should cascade to children
      await system.agentManager.terminate(coordinator.id, "completed");

      // Children should be stopped
      expect(system.agentStore.getAgent(child1.id)!.state).toBe("stopped");
      expect(system.agentStore.getAgent(child2.id)!.state).toBe("stopped");

      // Worktrees should be deallocated from workspace manager
      expect(workspaceManager.getWorkspace(child1.id)).toBeNull();
      expect(workspaceManager.getWorkspace(child2.id)).toBeNull();
    });
  });

  // ── Test 5: Coordinator creates integration stream ──────────

  describe("STREAM: Coordinator creates integration stream", () => {
    it("should create an integration stream when spawning coordinator with streamConfig", async () => {
      const coordinator = await system.agentManager.spawn({
        task: "Lead the feature",
        role: "coordinator",
        streamConfig: {
          name: "new-feature",
        },
        capabilities: ["workspace.stream"],
      });

      expect(coordinator.id).toBeDefined();

      // Verify agent record has workspace info
      const record = system.agentStore.getAgent(coordinator.id);
      expect(record).not.toBeNull();
      expect(record!.workspace_path).toBeDefined();

      // Verify workspace in manager
      const ws = workspaceManager.getWorkspace(coordinator.id);
      expect(ws).not.toBeNull();
      expect(ws!.role).toBe("coordinator");
      expect(ws!.streamId).toBeDefined();

      // Verify the stream exists
      const stream = workspaceManager.getStream(ws!.streamId);
      expect(stream).not.toBeNull();
    });
  });
});
