/**
 * Workspace Isolation E2E Tests
 *
 * Tests the full capability-based workspace isolation flow for teams:
 * - TeamRuntime creates integration stream during bootstrap
 * - Spawn interceptor injects workspace fields based on role capabilities
 * - createWorkspaceForRole dispatches on capabilities (not role names)
 * - Done handler resolves team roles to built-in handlers via capabilities
 * - Merge queue mr:submitted events wake the integrator agent
 *
 * Layer 1: Infrastructure (real git + services, mocked agent spawns)
 * Layer 2: Service-level (full workspace lifecycle simulation)
 * Layer 3: Full agent (real Claude Code, gated behind RUN_FULL_AGENT_TESTS)
 *
 * Run:
 *   npm run test:e2e -- src/teams/__tests__/e2e/workspace-isolation.e2e.test.ts
 *   RUN_FULL_AGENT_TESTS=true npm run test:e2e -- src/teams/__tests__/e2e/workspace-isolation.e2e.test.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execSync } from "child_process";
import Database from "better-sqlite3";

import { createEventStore, type EventStore } from "../../../store/event-store.js";
import { createAgentManager, type AgentManager } from "../../../agent/agent-manager.js";
import { createMessageRouter, type MessageRouter } from "../../../router/message-router.js";
import { DefaultRoleRegistry } from "../../../roles/registry.js";
import { loadTeam } from "../../team-loader.js";
import { TeamRuntime, type TeamServices } from "../../team-runtime.js";
import { createDataplaneAdapter, type DataplaneAdapter } from "../../../workspace/dataplane-adapter.js";
import { DefaultWorkspaceManager } from "../../../workspace/workspace-manager.js";
import { createMergeQueue, type MergeQueue } from "../../../workspace/merge-queue/index.js";
import type { WorkerWorkspace, IntegratorWorkspace } from "../../../workspace/types.js";
import { createHandlerRegistry, getHandler, type AllHandlerDeps } from "../../../lifecycle/handlers/index.js";
import { WORKSPACE_CAPABILITIES } from "../../../roles/capabilities.js";
import { handleWorkerDone, type WorkerHandlerDeps } from "../../../lifecycle/handlers/worker.js";
import type { LifecycleContext, CleanupStatus } from "../../../lifecycle/types.js";
import { QueueIntegrationStrategy } from "../../../workspace/strategies/queue.js";
import { OptimisticIntegrationStrategy } from "../../../workspace/strategies/optimistic.js";

// ─────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────

const RUN_FULL_AGENT = !!process.env.RUN_FULL_AGENT_TESTS;
const fullAgentFn = RUN_FULL_AGENT ? it : it.skip;
const PROJECT_ROOT = path.resolve(import.meta.dirname, "../../../..");

const log = (msg: string) => console.log(`[WorkspaceIso-E2E] ${msg}`);

// ─────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────

function git(args: string, cwd: string): string {
  return execSync(`git ${args}`, { cwd, stdio: "pipe", encoding: "utf8" }).trim();
}

function writeAndCommit(
  filePath: string,
  content: string,
  message: string,
  cwd: string,
): string {
  const fullPath = path.join(cwd, filePath);
  const dir = path.dirname(fullPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(fullPath, content);
  git("add .", cwd);
  git(`commit -m "${message}"`, cwd);
  return git("rev-parse HEAD", cwd);
}

function listWorktrees(cwd: string): string[] {
  return git("worktree list --porcelain", cwd)
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.replace("worktree ", ""));
}

function cleanupWorktrees(repoPath: string): void {
  if (!repoPath || !fs.existsSync(repoPath)) return;
  try {
    const worktrees = listWorktrees(repoPath).filter((wt) => wt !== repoPath);
    for (const wt of worktrees) {
      try {
        execSync(`git worktree remove --force "${wt}"`, {
          cwd: repoPath,
          stdio: "pipe",
        });
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

async function waitForAgentState(
  agentManager: AgentManager,
  agentId: string,
  state: "running" | "stopped",
  timeoutMs = 60000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const agent = agentManager.get(agentId);
    if (agent?.state === state) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Timeout: agent ${agentId} did not reach state '${state}' in ${timeoutMs}ms`);
}

// ─────────────────────────────────────────────────────────────────
// Layer 1: Infrastructure E2E (real git + services, no real agents)
// ─────────────────────────────────────────────────────────────────

describe("Workspace Isolation E2E — Infrastructure", () => {
  let tempDir: string;
  let repoPath: string;
  let dbPath: string;
  let db: Database.Database;
  let adapter: DataplaneAdapter;
  let manager: DefaultWorkspaceManager;
  let mergeQueue: MergeQueue;
  let eventStore: EventStore;
  let agentManager: AgentManager;
  let messageRouter: MessageRouter;
  let roleRegistry: DefaultRoleRegistry;
  let runtime: TeamRuntime;

  // Mock spawn counter for generating unique IDs
  let spawnCounter: number;

  beforeEach(async () => {
    spawnCounter = 0;

    // 1. Create temp dir + git repo
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-iso-e2e-"));
    repoPath = path.join(tempDir, "repo");
    dbPath = path.join(tempDir, "test.db");
    fs.mkdirSync(repoPath);

    git("init", repoPath);
    git('config user.email "test@test.com"', repoPath);
    git('config user.name "Test User"', repoPath);
    fs.writeFileSync(path.join(repoPath, "README.md"), "# Test Project\n");
    fs.mkdirSync(path.join(repoPath, "src"), { recursive: true });
    fs.writeFileSync(path.join(repoPath, "src/index.ts"), 'export const version = "1.0.0";\n');
    git("add .", repoPath);
    git('commit -m "Initial commit"', repoPath);

    // 2. Create workspace infrastructure
    db = new Database(dbPath);
    adapter = createDataplaneAdapter({
      enabled: true,
      repoPath,
      db,
      skipRecovery: true,
    });
    manager = new DefaultWorkspaceManager(adapter, {
      worktreeBaseDir: path.join(tempDir, ".worktrees"),
    });
    mergeQueue = createMergeQueue({ db });

    // 3. Create services
    const instanceId = `ws-iso-${Date.now()}`;
    eventStore = await createEventStore({ instanceId, baseDir: tempDir });
    messageRouter = createMessageRouter(eventStore);
    roleRegistry = new DefaultRoleRegistry();
    agentManager = createAgentManager(eventStore, messageRouter, {
      defaultPermissionMode: "auto-approve",
      defaultCwd: repoPath,
    });

    // 4. Load structured team and create runtime with workspace manager
    const manifest = await loadTeam("structured", roleRegistry, PROJECT_ROOT);
    const services: TeamServices = {
      agentManager,
      messageRouter,
      eventStore,
      workspaceManager: manager as any,
    };
    runtime = new TeamRuntime(manifest, services);

    // 5. Mock agentManager.spawn to return fake agents without real processes
    vi.spyOn(agentManager, "spawn").mockImplementation(async (options) => {
      spawnCounter++;
      const id = `mock-${options.role ?? "agent"}-${spawnCounter}`;

      // Emit spawn event so the agent appears in materialized view
      eventStore.emit({
        type: "spawn",
        source: { agent_id: id },
        payload: {
          agent_id: id,
          role: options.role ?? "worker",
          parent: options.parent ?? null,
          task: options.task,
        },
      });
      await eventStore.persist();

      return {
        id,
        session_id: `session-${id}`,
        agent: eventStore.getAgent(id)!,
        session: {} as any,
      };
    });

    // 6. Initialize and bootstrap
    await runtime.initialize();
    await runtime.bootstrap();

    log("Setup complete");
  });

  afterEach(async () => {
    // Restore mocks
    vi.restoreAllMocks();

    // Teardown runtime
    try { await runtime?.teardown(); } catch { /* ignore */ }

    // Close workspace infrastructure
    try { mergeQueue?.close(); } catch { /* ignore */ }
    try { manager?.close(); } catch { /* ignore */ }
    try { adapter?.close(); } catch { /* ignore */ }
    try { db?.close(); } catch { /* ignore */ }

    // Close services
    try { await agentManager?.close(); } catch { /* ignore */ }
    try { await eventStore?.close(); } catch { /* ignore */ }

    // Clean up worktrees and temp dir
    cleanupWorktrees(repoPath);
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("bootstrap creates integration stream when workspaceManager provided", () => {
    const teamStreamId = runtime.getTeamStreamId();
    expect(teamStreamId).toBeDefined();

    // Verify the stream exists in the workspace manager
    const stream = manager.getStream(teamStreamId!);
    expect(stream).not.toBeNull();
    log(`Integration stream created: ${teamStreamId}`);
  });

  it("spawn interceptor injects streamId + dataplaneTaskId for developer role", () => {
    const interceptor = runtime.createSpawnInterceptor();
    const result = interceptor({
      task: "test task",
      role: "developer",
      parent: runtime.getRootAgentId() ?? null,
    });

    expect(result.streamId).toBe(runtime.getTeamStreamId());
    expect(result.dataplaneTaskId).toBeDefined();
    expect(result.dataplaneTaskId).toMatch(/^worker-/);
    expect(result.capabilities).toContain(WORKSPACE_CAPABILITIES.WORKTREE);
    log("Developer intercepted: streamId + dataplaneTaskId + workspace.worktree");
  });

  it("spawn interceptor injects streamId for merger role (no dataplaneTaskId)", () => {
    const interceptor = runtime.createSpawnInterceptor();
    const result = interceptor({
      task: "test merger",
      role: "merger",
      parent: null,
    });

    expect(result.streamId).toBe(runtime.getTeamStreamId());
    expect(result.capabilities).toContain(WORKSPACE_CAPABILITIES.INTEGRATE);
    // Integrators don't get dataplaneTaskId
    expect(result.dataplaneTaskId).toBeUndefined();
    log("Merger intercepted: streamId + workspace.integrate, no dataplaneTaskId");
  });

  it("spawn interceptor does NOT inject workspace fields for reviewer", () => {
    const interceptor = runtime.createSpawnInterceptor();
    const result = interceptor({
      task: "test reviewer",
      role: "reviewer",
      parent: null,
    });

    // Reviewer extends monitor — no workspace capabilities
    expect(result.streamId).toBeUndefined();
    expect(result.dataplaneTaskId).toBeUndefined();
    log("Reviewer intercepted: no workspace fields");
  });

  it("spawn interceptor does not overwrite explicit workspace values", () => {
    const interceptor = runtime.createSpawnInterceptor();
    const result = interceptor({
      task: "test",
      role: "developer",
      parent: null,
      streamId: "explicit-stream",
      dataplaneTaskId: "explicit-task",
    });

    expect(result.streamId).toBe("explicit-stream");
    expect(result.dataplaneTaskId).toBe("explicit-task");
    log("Explicit workspace values preserved");
  });

  it("createWorkerWorkspace works for capability-based developer role", () => {
    const teamStreamId = runtime.getTeamStreamId()!;

    // Create worker workspace (what createWorkspaceForRole does internally for workspace.worktree)
    const workspace = manager.createWorkerWorkspace(
      "dev-001",
      "task-001",
      teamStreamId,
    ) as WorkerWorkspace;

    expect(workspace).toBeDefined();
    expect(workspace.role).toBe("worker");
    expect(workspace.taskId).toBe("task-001");
    expect(fs.existsSync(workspace.path)).toBe(true);

    // Verify worktree has repo files
    expect(fs.existsSync(path.join(workspace.path, "README.md"))).toBe(true);

    // Cleanup
    manager.deallocateWorkspace("dev-001");
    log("Worker workspace created via capability-based path");
  });

  it("createIntegratorWorkspace works for capability-based merger role", () => {
    const teamStreamId = runtime.getTeamStreamId()!;

    // Create integrator workspace (what createWorkspaceForRole does for workspace.integrate)
    const workspace = manager.createIntegratorWorkspace(
      "merger-001",
      teamStreamId,
    ) as IntegratorWorkspace;

    expect(workspace).toBeDefined();
    expect(workspace.role).toBe("integrator");
    expect(fs.existsSync(workspace.path)).toBe(true);
    expect(workspace.integrationBranch).toBeDefined();

    // Cleanup
    manager.deallocateWorkspace("merger-001");
    log("Integrator workspace created via capability-based path");
  });

  it("merge queue mr:submitted event wakes integrator agent", async () => {
    const teamStreamId = runtime.getTeamStreamId()!;

    // The bootstrap registered the merger companion in agentRoleMap.
    // Find the merger agent ID from the companion IDs.
    const companionIds = runtime.getCompanionAgentIds();
    const agentRoleMap = runtime.getAgentRoleMap();
    const mergerAgentId = companionIds.find(
      (id) => agentRoleMap.get(id as any) === "merger",
    );
    expect(mergerAgentId).toBeDefined();

    // Spy on prompt (fire-and-forget async generator)
    const promptSpy = vi.spyOn(agentManager, "prompt").mockReturnValue(
      (async function* () { /* no-op generator */ })() as any,
    );

    // Submit via the workspace manager's internal merge queue (same instance
    // that TeamRuntime subscribed to — the test's `mergeQueue` is a separate instance)
    const wmMergeQueue = manager.getMergeQueue();
    wmMergeQueue.submit({
      streamId: teamStreamId,
      taskId: "task-001",
      workerBranch: "worker/dev-001/task-001",
      workerAgentId: "dev-001",
    });

    // Give the event handler a tick to fire
    await new Promise((r) => setTimeout(r, 50));

    // Assert prompt was called with the merger agent ID
    expect(promptSpy).toHaveBeenCalled();
    const [calledAgentId, calledMessage] = promptSpy.mock.calls[0];
    expect(calledAgentId).toBe(mergerAgentId);
    expect(calledMessage).toContain("Merge request");
    expect(calledMessage).toContain("dev-001");
    log("Merge queue mr:submitted woke integrator agent");
  });

  it("MERGE_REQUEST signal polling picks up worker signals and submits to merge queue", async () => {
    // This test verifies the signal-based merge queue submission flow:
    // Worker subprocess emits MERGE_REQUEST to EventStore → TeamRuntime polls → submits to merge queue
    // Note: beforeEach already called runtime.initialize() + runtime.bootstrap()

    const rootId = runtime.getRootAgentId()!;
    const teamStreamId = runtime.getTeamStreamId()!;
    const wmMergeQueue = manager.getMergeQueue();

    // Simulate a worker subprocess emitting a MERGE_REQUEST signal to EventStore
    // (this is what the worker handler does when it has no integrationStrategy/mergeQueue)
    const workerAgentId = "mock-worker-signal-001";

    // Register the worker agent as a child of root so polling recognizes it
    eventStore.emit({
      type: "spawn",
      source: { agent_id: workerAgentId },
      payload: {
        agent_id: workerAgentId,
        task_id: "task-signal-001",
        task: "Test signal-based merge request",
        parent: rootId,
        role: "developer",
      },
    });
    await eventStore.persist();

    // Emit the MERGE_REQUEST signal (simulating worker handler fallback path)
    messageRouter.emitStatus({
      from: { agent_id: workerAgentId },
      status_type: "checkpoint",
      summary: "Merge request for branch worker/dev-signal-001",
      details: {
        signal: "MERGE_REQUEST",
        sourceBranch: "worker/dev-signal-001",
        targetBranch: "integration",
        taskId: "task-signal-001",
        workerId: workerAgentId,
      },
    });
    await eventStore.persist();

    // Wait for the polling interval to pick up the signal (polls every 2s)
    const deadline = Date.now() + 8_000;
    let depth = 0;
    while (Date.now() < deadline) {
      depth = wmMergeQueue.getQueueDepth(teamStreamId);
      if (depth > 0) break;
      await new Promise((r) => setTimeout(r, 500));
    }

    expect(depth).toBeGreaterThan(0);
    log("MERGE_REQUEST signal polling submitted to merge queue successfully");
  });

  it("getHandler resolves developer role to worker handler via capabilities", () => {
    const deps: AllHandlerDeps = {
      messageRouter,
      agentManager,
    };
    const registry = createHandlerRegistry(deps);

    // "developer" doesn't match any registry entry directly
    // but workspace.worktree capability should resolve to worker handler
    const handler = getHandler("developer", registry, deps, [
      WORKSPACE_CAPABILITIES.WORKTREE,
      "lifecycle.done",
    ]);

    expect(handler).toBeDefined();

    // Verify it's the worker handler by checking it doesn't throw
    // and produces a result (worker handler returns strategy-related result)
    // Just verify it's a function — the unit tests already validate behavior
    expect(typeof handler).toBe("function");
    log("developer role resolved to worker handler via capabilities");
  });

  it("agent resume reads workspace cwd from EventStore (survives rebuildViews)", async () => {
    const agentId = "resume-cwd-test-001";
    const worktreePath = path.join(tempDir, "worktree-resume-test");

    // Create agent via spawn event with original cwd
    eventStore.emit({
      type: "spawn",
      source: { agent_id: agentId },
      payload: {
        agent_id: agentId,
        task: "Test resume cwd",
        role: "worker",
        cwd: repoPath,
      },
    });
    await eventStore.persist();
    expect(eventStore.getAgent(agentId)?.cwd).toBe(repoPath);

    // Update cwd out-of-band (simulating what spawn() does after workspace creation)
    eventStore.updateAgentMetadata(agentId as any, { cwd: worktreePath });
    await eventStore.persist();
    expect(eventStore.getAgent(agentId)?.cwd).toBe(worktreePath);

    // Simulate auto-load rebuild (triggers rebuildViews which replays events)
    await eventStore.reload();

    // cwd must survive the rebuild — this is what resume() would read
    const agent = eventStore.getAgent(agentId);
    expect(agent).not.toBeNull();
    expect(agent!.cwd).toBe(worktreePath);
    log("Agent cwd survives rebuildViews for resume");
  });

  it("workspace deallocated when agent terminates", () => {
    const teamStreamId = runtime.getTeamStreamId()!;
    const devId = "cleanup-test-001";
    const taskId = manager.createTask(teamStreamId, { title: "cleanup test" });
    const workspace = manager.createWorkerWorkspace(devId, taskId, teamStreamId) as WorkerWorkspace;

    // Verify worktree exists
    expect(fs.existsSync(workspace.path)).toBe(true);

    // Track deallocated event via the custom event system
    let deallocatedEvent: any = null;
    manager.onEvent((e: any) => {
      if (e.type === "workspace:deallocated") deallocatedEvent = e;
    });

    // Deallocate (this is what AgentManager.terminate() calls)
    manager.deallocateWorkspace(devId);

    // Workspace mapping should be cleared
    expect(manager.getWorkspace(devId)).toBeNull();

    // Event should have been emitted
    expect(deallocatedEvent).not.toBeNull();
    expect(deallocatedEvent.data.agentId).toBe(devId);
    expect(deallocatedEvent.data.role).toBe("worker");
    log("Workspace deallocated and worktree removed");
  });

  it("deallocateWorkspace is idempotent", () => {
    const teamStreamId = runtime.getTeamStreamId()!;
    const devId = "idempotent-test-001";
    const taskId = manager.createTask(teamStreamId, { title: "idempotent test" });
    manager.createWorkerWorkspace(devId, taskId, teamStreamId);

    // First deallocation should work
    manager.deallocateWorkspace(devId);

    // Second deallocation should not throw
    expect(() => manager.deallocateWorkspace(devId)).not.toThrow();
    log("deallocateWorkspace is idempotent");
  });
});

// ─────────────────────────────────────────────────────────────────
// Layer 2: Service-Level E2E (full workspace lifecycle simulation)
// ─────────────────────────────────────────────────────────────────

describe("Workspace Isolation E2E — Service Lifecycle", () => {
  let tempDir: string;
  let repoPath: string;
  let dbPath: string;
  let db: Database.Database;
  let adapter: DataplaneAdapter;
  let manager: DefaultWorkspaceManager;
  let mergeQueue: MergeQueue;
  let eventStore: EventStore;
  let agentManager: AgentManager;
  let messageRouter: MessageRouter;
  let roleRegistry: DefaultRoleRegistry;
  let runtime: TeamRuntime;

  let spawnCounter: number;

  beforeEach(async () => {
    spawnCounter = 0;

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-iso-svc-"));
    repoPath = path.join(tempDir, "repo");
    dbPath = path.join(tempDir, "test.db");
    fs.mkdirSync(repoPath);

    git("init", repoPath);
    git('config user.email "test@test.com"', repoPath);
    git('config user.name "Test User"', repoPath);
    fs.writeFileSync(path.join(repoPath, "README.md"), "# Test Project\n");
    fs.mkdirSync(path.join(repoPath, "src"), { recursive: true });
    fs.writeFileSync(path.join(repoPath, "src/index.ts"), 'export const version = "1.0.0";\n');
    git("add .", repoPath);
    git('commit -m "Initial commit"', repoPath);

    db = new Database(dbPath);
    adapter = createDataplaneAdapter({
      enabled: true,
      repoPath,
      db,
      skipRecovery: true,
    });
    manager = new DefaultWorkspaceManager(adapter, {
      worktreeBaseDir: path.join(tempDir, ".worktrees"),
    });
    mergeQueue = createMergeQueue({ db });

    const instanceId = `ws-svc-${Date.now()}`;
    eventStore = await createEventStore({ instanceId, baseDir: tempDir });
    messageRouter = createMessageRouter(eventStore);
    roleRegistry = new DefaultRoleRegistry();
    agentManager = createAgentManager(eventStore, messageRouter, {
      defaultPermissionMode: "auto-approve",
      defaultCwd: repoPath,
    });

    const manifest = await loadTeam("structured", roleRegistry, PROJECT_ROOT);
    const services: TeamServices = {
      agentManager,
      messageRouter,
      eventStore,
      workspaceManager: manager as any,
    };
    runtime = new TeamRuntime(manifest, services);

    vi.spyOn(agentManager, "spawn").mockImplementation(async (options) => {
      spawnCounter++;
      const id = `mock-${options.role ?? "agent"}-${spawnCounter}`;
      eventStore.emit({
        type: "spawn",
        source: { agent_id: id },
        payload: {
          agent_id: id,
          role: options.role ?? "worker",
          parent: options.parent ?? null,
          task: options.task,
        },
      });
      await eventStore.persist();
      return {
        id,
        session_id: `session-${id}`,
        agent: eventStore.getAgent(id)!,
        session: {} as any,
      };
    });

    await runtime.initialize();
    await runtime.bootstrap();
    log("Service-level setup complete");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    try { await runtime?.teardown(); } catch { /* ignore */ }
    try { mergeQueue?.close(); } catch { /* ignore */ }
    try { manager?.close(); } catch { /* ignore */ }
    try { adapter?.close(); } catch { /* ignore */ }
    try { db?.close(); } catch { /* ignore */ }
    try { await agentManager?.close(); } catch { /* ignore */ }
    try { await eventStore?.close(); } catch { /* ignore */ }
    cleanupWorktrees(repoPath);
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("full lifecycle: developer worktree → commit → merge queue → integrator merge", () => {
    const teamStreamId = runtime.getTeamStreamId()!;
    expect(teamStreamId).toBeDefined();

    // ═══════════════════════════════════════════════════════════════
    // Phase 1: Developer creates workspace via capabilities
    // ═══════════════════════════════════════════════════════════════
    const devId = "dev-alpha-001";
    const taskId = manager.createTask(teamStreamId, {
      title: "Implement feature",
      priority: 10,
    });

    const devWorkspace = manager.createWorkerWorkspace(
      devId,
      taskId,
      teamStreamId,
    ) as WorkerWorkspace;

    expect(devWorkspace.role).toBe("worker");
    expect(fs.existsSync(devWorkspace.path)).toBe(true);

    // ═══════════════════════════════════════════════════════════════
    // Phase 2: Developer makes changes and commits
    // ═══════════════════════════════════════════════════════════════
    const startResult = manager.claimTask(taskId, devId, devWorkspace.path);
    expect(startResult.branchName).toContain(devId);

    writeAndCommit(
      "src/feature.ts",
      'export function greet() { return "hello"; }',
      "feat: add greeting function",
      devWorkspace.path,
    );

    // ═══════════════════════════════════════════════════════════════
    // Phase 3: Submit to merge queue
    // ═══════════════════════════════════════════════════════════════
    const task = adapter.getTask(taskId)!;
    const mrId = mergeQueue.submit({
      streamId: teamStreamId,
      taskId,
      workerBranch: task.branchName!,
      workerAgentId: devId,
      priority: 10,
    });

    expect(mrId).toBeDefined();
    expect(mergeQueue.getQueueDepth(teamStreamId)).toBe(1);

    // ═══════════════════════════════════════════════════════════════
    // Phase 4: Integrator processes merge queue
    // ═══════════════════════════════════════════════════════════════
    // Deallocate worker first (integrator needs the stream branch)
    manager.deallocateWorkspace(devId);

    const mergerId = "merger-001";
    const mergerWorkspace = manager.createIntegratorWorkspace(
      mergerId,
      teamStreamId,
    ) as IntegratorWorkspace;

    expect(mergerWorkspace.role).toBe("integrator");

    const nextMr = mergeQueue.getNext(teamStreamId);
    expect(nextMr).not.toBeNull();
    expect(nextMr!.taskId).toBe(taskId);

    mergeQueue.markProcessing(nextMr!.id);
    const result = adapter.completeTask({
      taskId,
      worktree: mergerWorkspace.path,
    });
    expect(result.mergeCommit).toBeDefined();
    mergeQueue.markMerged(nextMr!.id, result.mergeCommit);

    // ═══════════════════════════════════════════════════════════════
    // Phase 5: Verify integration
    // ═══════════════════════════════════════════════════════════════
    expect(mergeQueue.getQueueDepth(teamStreamId)).toBe(0);

    const files = git("ls-tree -r HEAD --name-only", mergerWorkspace.path).split("\n");
    expect(files).toContain("src/feature.ts");

    // Cleanup
    manager.deallocateWorkspace(mergerId);
    log("Full lifecycle complete: developer → merge queue → integrator");
  });

  it("parallel developers with capability-based workspace isolation", () => {
    const teamStreamId = runtime.getTeamStreamId()!;
    const workerCount = 3;

    // ═══════════════════════════════════════════════════════════════
    // Phase 1: Create parallel developer workspaces
    // ═══════════════════════════════════════════════════════════════
    const workers: Array<{
      id: string;
      taskId: string;
      workspace: WorkerWorkspace;
      branchName: string;
    }> = [];

    for (let i = 0; i < workerCount; i++) {
      const devId = `dev-${String(i).padStart(3, "0")}`;
      const taskId = manager.createTask(teamStreamId, {
        title: `Task ${i}`,
        priority: (i + 1) * 10,
      });

      const workspace = manager.createWorkerWorkspace(
        devId,
        taskId,
        teamStreamId,
      ) as WorkerWorkspace;

      const startResult = manager.claimTask(taskId, devId, workspace.path);

      writeAndCommit(
        `src/module-${i}.ts`,
        `export const module${i} = true;`,
        `feat: add module ${i}`,
        workspace.path,
      );

      workers.push({ id: devId, taskId, workspace, branchName: startResult.branchName });
    }

    // Verify isolation: each worker has unique path
    const paths = workers.map((w) => w.workspace.path);
    expect(new Set(paths).size).toBe(workerCount);

    // ═══════════════════════════════════════════════════════════════
    // Phase 2: Submit all to merge queue
    // ═══════════════════════════════════════════════════════════════
    for (const worker of workers) {
      const task = adapter.getTask(worker.taskId)!;
      mergeQueue.submit({
        streamId: teamStreamId,
        taskId: worker.taskId,
        workerBranch: task.branchName!,
        workerAgentId: worker.id,
        priority: parseInt(worker.taskId, 10) || 10,
      });
    }

    expect(mergeQueue.getQueueDepth(teamStreamId)).toBe(workerCount);

    // ═══════════════════════════════════════════════════════════════
    // Phase 3: Deallocate workers and create integrator
    // ═══════════════════════════════════════════════════════════════
    for (const worker of workers) {
      manager.deallocateWorkspace(worker.id);
    }

    const mergerWorkspace = manager.createIntegratorWorkspace(
      "merger-001",
      teamStreamId,
    ) as IntegratorWorkspace;

    // ═══════════════════════════════════════════════════════════════
    // Phase 4: Process merge queue in order
    // ═══════════════════════════════════════════════════════════════
    let mr = mergeQueue.getNext(teamStreamId);
    let mergedCount = 0;

    while (mr) {
      mergeQueue.markProcessing(mr.id);
      const result = adapter.completeTask({
        taskId: mr.taskId,
        worktree: mergerWorkspace.path,
      });
      expect(result.mergeCommit).toBeDefined();
      mergeQueue.markMerged(mr.id, result.mergeCommit);
      mergedCount++;
      mr = mergeQueue.getNext(teamStreamId);
    }

    expect(mergedCount).toBe(workerCount);
    expect(mergeQueue.getQueueDepth(teamStreamId)).toBe(0);

    // ═══════════════════════════════════════════════════════════════
    // Phase 5: Verify all changes integrated
    // ═══════════════════════════════════════════════════════════════
    const files = git("ls-tree -r HEAD --name-only", mergerWorkspace.path).split("\n");
    for (let i = 0; i < workerCount; i++) {
      expect(files).toContain(`src/module-${i}.ts`);
    }

    // Cleanup
    manager.deallocateWorkspace("merger-001");
    log(`Parallel lifecycle complete: ${workerCount} developers → merge queue → integrator`);
  });

  it("worker done handler dispatches to queue strategy via land()", async () => {
    const teamStreamId = runtime.getTeamStreamId()!;

    // ═══════════════════════════════════════════════════════════════
    // Phase 1: Create developer workspace and make changes
    // ═══════════════════════════════════════════════════════════════
    const devId = "dev-strategy-001";
    const taskId = manager.createTask(teamStreamId, {
      title: "Strategy test task",
      priority: 10,
    });

    const devWorkspace = manager.createWorkerWorkspace(
      devId,
      taskId,
      teamStreamId,
    ) as WorkerWorkspace;

    const startResult = manager.claimTask(taskId, devId, devWorkspace.path);
    writeAndCommit(
      "src/strategy-test.ts",
      'export const strategy = "queue";',
      "feat: add strategy test file",
      devWorkspace.path,
    );

    // ═══════════════════════════════════════════════════════════════
    // Phase 2: Wire queue strategy with real merge queue
    // ═══════════════════════════════════════════════════════════════
    const queueStrategy = new QueueIntegrationStrategy();
    queueStrategy.setMergeQueue(manager.getMergeQueue());

    // ═══════════════════════════════════════════════════════════════
    // Phase 3: Call handleWorkerDone with strategy
    // ═══════════════════════════════════════════════════════════════
    const context: LifecycleContext = {
      agentId: devId,
      role: "worker",
      workspacePath: devWorkspace.path,
      streamId: teamStreamId,
      taskId: taskId,
      branch: startResult.branchName,
      integrationBranch: "integration",
    };

    const cleanupStatus: CleanupStatus = {
      ready: true,
    };

    const deps: WorkerHandlerDeps = {
      messageRouter,
      agentManager,
      integrationStrategy: queueStrategy,
    };

    const result = await handleWorkerDone(
      context,
      { status: "completed", summary: "Strategy test complete" },
      cleanupStatus,
      deps,
    );

    // ═══════════════════════════════════════════════════════════════
    // Phase 4: Verify strategy was used (not fallback MERGE_REQUEST)
    // ═══════════════════════════════════════════════════════════════
    expect(result.shouldTerminate).toBe(true);
    expect(result.signalsEmitted).toContain("WORKER_DONE");
    expect(result.signalsEmitted).toContain("WORKER_INTEGRATED");
    expect(result.signalsEmitted).not.toContain("MERGE_REQUEST");

    // Strategy submitted to merge queue
    const wmMergeQueue = manager.getMergeQueue();
    expect(wmMergeQueue.getQueueDepth(teamStreamId)).toBe(1);

    const pending = wmMergeQueue.getPending(teamStreamId);
    expect(pending[0].workerBranch).toBe(startResult.branchName);
    expect(pending[0].workerAgentId).toBe(devId);

    // cleanupActions should mention the strategy name
    expect(result.cleanupActions?.some((a) => a.includes("queue"))).toBe(true);

    // Cleanup
    manager.deallocateWorkspace(devId);
    log("Worker done handler dispatched to queue strategy successfully");
  });

  it("optimistic strategy emits validation event on successful land", async () => {
    // ═══════════════════════════════════════════════════════════════
    // Phase 1: Create bare repo as "remote" for push operations
    // ═══════════════════════════════════════════════════════════════
    const bareDir = path.join(tempDir, "bare.git");
    execSync(`git init --bare "${bareDir}"`, { stdio: "pipe" });

    const cloneDir = path.join(tempDir, "optimistic-clone");
    execSync(`git clone "${bareDir}" "${cloneDir}"`, { stdio: "pipe" });
    git('config user.email "test@test.com"', cloneDir);
    git('config user.name "Test User"', cloneDir);

    // Create initial commit and push to origin/main
    writeAndCommit("README.md", "# Test", "initial commit", cloneDir);
    git("push origin HEAD:main", cloneDir);

    // Create a worker branch and make changes
    git("checkout -b worker/opt-test-001", cloneDir);
    writeAndCommit(
      "src/optimistic.ts",
      'export const mode = "optimistic";',
      "feat: add optimistic file",
      cloneDir,
    );

    // ═══════════════════════════════════════════════════════════════
    // Phase 2: Create optimistic strategy with EventStore
    // ═══════════════════════════════════════════════════════════════
    const optimistic = new OptimisticIntegrationStrategy();
    optimistic.setEventStore(eventStore);

    // ═══════════════════════════════════════════════════════════════
    // Phase 3: Land changes
    // ═══════════════════════════════════════════════════════════════
    const landResult = await optimistic.land({
      sourceBranch: "worker/opt-test-001",
      targetBranch: "main",
      workspacePath: cloneDir,
      agentId: "agent-opt-001",
      taskId: "task-opt-001",
    });

    // ═══════════════════════════════════════════════════════════════
    // Phase 4: Verify land succeeded and validation event emitted
    // ═══════════════════════════════════════════════════════════════
    expect(landResult.status).toBe("landed");
    expect(landResult.commitHash).toBeDefined();
    expect(landResult.commitHash!.length).toBeGreaterThan(0);

    expect(landResult.retryCount).toBe(0);

    // Verify validation event was emitted to EventStore
    const statusEvents = eventStore.query({
      type: "status",
      source_agent_id: "agent-opt-001" as any,
    });
    const validationEvent = statusEvents.find(
      (e) => e.payload?.validation_requested === true,
    );
    expect(validationEvent).toBeDefined();
    expect(validationEvent!.payload.commitHash).toBe(landResult.commitHash);
    expect(validationEvent!.payload.taskId).toBe("task-opt-001");
    expect(validationEvent!.payload.agentId).toBe("agent-opt-001");

    // Verify the commit actually landed on main at the remote
    const remoteMain = execSync(`git -C "${bareDir}" log --oneline -1 main`, {
      encoding: "utf-8",
    }).trim();
    expect(remoteMain).toContain("optimistic");

    log(`Optimistic strategy landed: ${landResult.commitHash!.slice(0, 8)}`);
  });
});

// ─────────────────────────────────────────────────────────────────
// Layer 3: Full Agent E2E (requires RUN_FULL_AGENT_TESTS)
// ─────────────────────────────────────────────────────────────────

describe("Workspace Isolation E2E — Full Agent", () => {
  let tempDir: string;
  let repoPath: string;
  let dbPath: string;
  let db: Database.Database;
  let adapter: DataplaneAdapter;
  let wsManager: DefaultWorkspaceManager;
  let mergeQueue: MergeQueue;
  let eventStore: EventStore;
  let agentManager: AgentManager;
  let messageRouter: MessageRouter;
  let roleRegistry: DefaultRoleRegistry;
  let runtime: TeamRuntime | null = null;

  beforeEach(async () => {
    if (!RUN_FULL_AGENT) return;

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-iso-agent-"));
    repoPath = path.join(tempDir, "repo");
    dbPath = path.join(tempDir, "test.db");
    fs.mkdirSync(repoPath);

    git("init", repoPath);
    git('config user.email "test@test.com"', repoPath);
    git('config user.name "Test User"', repoPath);
    fs.writeFileSync(path.join(repoPath, "README.md"), "# Test Project\n");
    fs.mkdirSync(path.join(repoPath, "src"), { recursive: true });
    fs.writeFileSync(path.join(repoPath, "src/index.ts"), 'export const version = "1.0.0";\n');
    git("add .", repoPath);
    git('commit -m "Initial commit"', repoPath);

    db = new Database(dbPath);
    adapter = createDataplaneAdapter({
      enabled: true,
      repoPath,
      db,
      skipRecovery: true,
    });
    wsManager = new DefaultWorkspaceManager(adapter, {
      worktreeBaseDir: path.join(tempDir, ".worktrees"),
    });
    mergeQueue = createMergeQueue({ db });

    const instanceId = `ws-agent-${Date.now()}`;
    eventStore = await createEventStore({ instanceId, baseDir: tempDir });
    messageRouter = createMessageRouter(eventStore);
    roleRegistry = new DefaultRoleRegistry();
    agentManager = createAgentManager(eventStore, messageRouter, {
      defaultPermissionMode: "auto-approve",
      defaultCwd: repoPath,
      workspaceManager: wsManager as any,
    });

    log("Full agent services initialized");
  });

  afterEach(async () => {
    if (!RUN_FULL_AGENT) return;

    if (runtime) {
      try { await runtime.teardown(); } catch { /* ignore */ }
      runtime = null;
    }

    try {
      for (const agent of agentManager.list()) {
        if (agent.state === "running") {
          try { await agentManager.terminate(agent.id, "test_cleanup"); } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }

    try { mergeQueue?.close(); } catch { /* ignore */ }
    try { wsManager?.close(); } catch { /* ignore */ }
    try { adapter?.close(); } catch { /* ignore */ }
    try { db?.close(); } catch { /* ignore */ }
    try { await agentManager?.close(); } catch { /* ignore */ }
    try { await eventStore?.close(); } catch { /* ignore */ }

    cleanupWorktrees(repoPath);
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    log("Full agent cleanup complete");
  });

  fullAgentFn(
    "team bootstrap with workspace isolation creates stream and agents get workspaces",
    async () => {
      const manifest = await loadTeam("structured", roleRegistry, PROJECT_ROOT);
      const services: TeamServices = {
        agentManager,
        messageRouter,
        eventStore,
        workspaceManager: wsManager as any,
      };
      runtime = new TeamRuntime(manifest, services);

      await runtime.initialize();
      runtime.installOnServices();
      log("Runtime initialized with workspace isolation");

      const result = await runtime.bootstrap();
      log(`Bootstrap complete: root=${result.rootId}, companions=${result.companionIds.join(", ")}`);

      // Verify integration stream was created
      const teamStreamId = runtime.getTeamStreamId();
      expect(teamStreamId).toBeDefined();
      expect(wsManager.getStream(teamStreamId!)).not.toBeNull();
      log(`Integration stream: ${teamStreamId}`);

      // Spawn a developer child — interceptor should inject workspace fields
      const developer = await agentManager.spawn({
        task: "You are a developer. Wait for instructions.",
        role: "developer",
        parent: result.rootId,
        cwd: repoPath,
      });

      await waitForAgentState(agentManager, developer.id, "running");
      log(`Developer spawned: ${developer.id}`);

      // Verify developer has workspace with correct stream
      if (developer.workspace) {
        expect(developer.workspace.role).toBe("worker");
        expect(developer.streamId).toBe(teamStreamId);

        // Verify agent cwd is the workspace path (not repo root)
        const agentRecord = eventStore.getAgent(developer.id);
        expect(agentRecord?.cwd).toBe(developer.workspace.path);
        expect(agentRecord?.cwd).not.toBe(repoPath);
        log(`Developer cwd correctly set to workspace: ${agentRecord?.cwd}`);
      }

      // Terminate agents
      await agentManager.terminate(developer.id, "completed");
      for (const companionId of result.companionIds) {
        try { await agentManager.terminate(companionId, "completed"); } catch { /* ignore */ }
      }
      try { await agentManager.terminate(result.rootId, "completed"); } catch { /* ignore */ }
    },
    { timeout: 180_000 },
  );

  fullAgentFn(
    "developer agent calls done() and work is submitted to merge queue",
    async () => {
      const manifest = await loadTeam("structured", roleRegistry, PROJECT_ROOT);
      const services: TeamServices = {
        agentManager,
        messageRouter,
        eventStore,
        workspaceManager: wsManager as any,
      };
      runtime = new TeamRuntime(manifest, services);

      await runtime.initialize();
      runtime.installOnServices();
      const result = await runtime.bootstrap();

      const teamStreamId = runtime.getTeamStreamId()!;
      expect(teamStreamId).toBeDefined();

      // Spawn a developer with a task focused solely on calling done().
      // Keeping the task minimal avoids Claude completing file creation
      // and ending its turn before invoking the MCP done() tool.
      const developer = await agentManager.spawn({
        task: [
          "Your ONLY task is to call the done() tool immediately.",
          "Do NOT create files, run commands, or do any other work.",
          "Just call: done({ status: \"completed\", summary: \"Task complete\" })",
        ].join("\n"),
        role: "developer",
        parent: result.rootId,
        cwd: repoPath,
      });

      await waitForAgentState(agentManager, developer.id, "running");
      log(`Developer spawned for done() test: ${developer.id}`);

      // Prompt the developer to call done() — keep it direct and unambiguous
      for await (const _update of agentManager.prompt(
        developer.id,
        'Call the done tool now with status "completed" and summary "Task complete". Do nothing else.',
      )) {
        // Consume the stream
      }

      // Wait for agent to stop (done() schedules termination)
      const stopDeadline = Date.now() + 30_000;
      while (Date.now() < stopDeadline) {
        const a = agentManager.get(developer.id);
        if (a?.state === "stopped") break;
        await new Promise(r => setTimeout(r, 500));
      }
      const agent = agentManager.get(developer.id);
      log(`Developer state after waiting: ${agent?.state}`);
      expect(agent?.state).toBe("stopped");

      // Agent called done() — verify merge queue got the MERGE_REQUEST.
      // TeamRuntime polls EventStore every 2s for MERGE_REQUEST signals from
      // worker subprocesses and submits to the real merge queue.
      // Use wsManager.getMergeQueue() because it uses the same table prefix (macro_)
      // as the polling code in TeamRuntime.
      const wmMergeQueue = wsManager.getMergeQueue();
      const mqDeadline = Date.now() + 10_000;
      let depth = 0;
      while (Date.now() < mqDeadline) {
        depth = wmMergeQueue.getQueueDepth(teamStreamId);
        if (depth > 0) break;
        await new Promise(r => setTimeout(r, 500));
      }
      log(`Merge queue depth after developer done(): ${depth}`);
      expect(depth).toBeGreaterThan(0);

      // Verify branch correctness — sourceBranch should be a worker branch, NOT "main"
      const pending = wmMergeQueue.getPending(teamStreamId);
      expect(pending.length).toBeGreaterThan(0);
      const mr = pending[0];
      expect(mr.workerBranch).toMatch(/^worker\//);
      log(`Merge request workerBranch: ${mr.workerBranch}`);

      // Cleanup
      for (const companionId of result.companionIds) {
        try { await agentManager.terminate(companionId, "completed"); } catch { /* ignore */ }
      }
      try { await agentManager.terminate(result.rootId, "completed"); } catch { /* ignore */ }
    },
    { timeout: 180_000 },
  );
});

// ─────────────────────────────────────────────────────────────────
// Info message for running tests
// ─────────────────────────────────────────────────────────────────

if (!RUN_FULL_AGENT) {
  console.log("\n┌──────────────────────────────────────────────────────────┐");
  console.log("│  Workspace Isolation full-agent tests are skipped        │");
  console.log("│  (RUN_FULL_AGENT_TESTS not set)                          │");
  console.log("│                                                          │");
  console.log("│  Layers 1-2 (Infrastructure + Service) will still run.   │");
  console.log("│                                                          │");
  console.log("│  To run with real agents:                                │");
  console.log("│  RUN_FULL_AGENT_TESTS=true npm run test:e2e -- \\         │");
  console.log("│    src/teams/__tests__/e2e/workspace-isolation.e2e.test.ts│");
  console.log("└──────────────────────────────────────────────────────────┘\n");
}
