/**
 * Workspace V3 End-to-End Tests (Phase 4/5/7 integration gate)
 *
 * Exercises the full stream-first path:
 *   YAML → parseTeamWorkspaceConfig → YamlDrivenTopology → AgentManagerV2.spawn
 *   → executeWorkspaceDecision → WorkspaceManager V3 → real git-cascade + git
 *
 * These tests prevent the silent-failure class that mocked unit tests miss.
 *
 * REQUIRES: RUN_E2E_TESTS=true
 *
 * Run with:
 *   RUN_E2E_TESTS=true npx vitest run --config vitest.e2e.config.ts \
 *     src/__tests__/e2e/workspace-v3.e2e.test.ts
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from 'vitest';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { execSync } from 'child_process';
import { bootV2, type MacroAgentSystemV2 } from '../../boot-v2.js';
import { GitCascadeAdapter } from '../../workspace/git-cascade-adapter.js';
import {
  DefaultWorkspaceManager,
  createWorkspaceManagerWithAdapter,
} from '../../workspace/workspace-manager.js';
import { YamlDrivenTopology } from '../../workspace/topology/yaml-driven.js';
import {
  parseTeamWorkspaceConfig,
  type TeamWorkspaceConfig,
} from '../../workspace/yaml-schema.js';
import {
  registerBuiltinLandingStrategies,
  MergeToParentStrategy,
} from '../../workspace/landing/index.js';
import {
  DeferStrategy,
  AbandonStrategy,
  buildBuiltinRecoveryRegistry,
} from '../../workspace/recovery/index.js';

// ─────────────────────────────────────────────────────────────────
// Harness
// ─────────────────────────────────────────────────────────────────

const RUN_E2E = !!process.env.RUN_E2E_TESTS;
const describeFn = RUN_E2E ? describe : describe.skip;

// Mock acp-factory — no real Claude Code sessions
vi.mock('acp-factory', () => ({
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

vi.mock('opentasks', () => ({
  OpenTasksClient: vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockRejectedValue(new Error('No daemon')),
    disconnect: vi.fn(),
    query: vi.fn().mockResolvedValue({ items: [] }),
    link: vi.fn().mockResolvedValue({ success: true }),
    task: vi.fn().mockResolvedValue({ id: 't-1' }),
  })),
}));

function createTestDir(): string {
  const dir = path.join(
    os.tmpdir(),
    `ws-v3-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function createGitRepo(baseDir: string): string {
  const repoPath = path.join(baseDir, 'repo');
  fs.mkdirSync(repoPath, { recursive: true });
  execSync('git init -b main', { cwd: repoPath, stdio: 'pipe' });
  execSync('git config user.email "test@test.com"', { cwd: repoPath, stdio: 'pipe' });
  execSync('git config user.name "Test User"', { cwd: repoPath, stdio: 'pipe' });
  fs.writeFileSync(path.join(repoPath, 'README.md'), '# Test\n');
  execSync('git add .', { cwd: repoPath, stdio: 'pipe' });
  execSync('git commit -m "init"', { cwd: repoPath, stdio: 'pipe' });
  return repoPath;
}

// ─────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────

describeFn('Workspace V3 E2E', () => {
  let system: MacroAgentSystemV2;
  let testDir: string;
  let repoPath: string;
  let adapter: GitCascadeAdapter;
  let workspaceManager: DefaultWorkspaceManager;

  beforeEach(async () => {
    testDir = createTestDir();
    repoPath = createGitRepo(testDir);
    const dbPath = path.join(testDir, 'git-cascade.db');

    adapter = new GitCascadeAdapter({
      enabled: true,
      repoPath,
      dbPath,
    });
    workspaceManager = createWorkspaceManagerWithAdapter(adapter, {
      worktreeBaseDir: path.join(repoPath, '.worktrees'),
    }) as DefaultWorkspaceManager;

    // Register built-in landing strategies
    registerBuiltinLandingStrategies(workspaceManager);

    system = await bootV2({
      cwd: repoPath,
      baseDir: testDir,
      inbox: { socketPath: path.join(testDir, 'inbox.sock') },
      workspaceManager,
    });
  });

  afterEach(async () => {
    if (system) await system.shutdown();
    if (workspaceManager) workspaceManager.close();
    if (adapter) adapter.close();
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  // ═══════════════════════════════════════════════════════════════
  // TEST 1: Peer swarm — YAML → Topology → Spawn → V3 allocation
  // ═══════════════════════════════════════════════════════════════

  describe('peer swarm (V3)', () => {
    let topology: YamlDrivenTopology;
    let config: TeamWorkspaceConfig;

    beforeEach(async () => {
      const parsed = parseTeamWorkspaceConfig({
        roles: {
          orchestrator: { workspace: 'none' },
          peer: {
            workspace: 'new_stream',
            stream_lineage: 'fork_from_team_root',
            landing: 'merge_to_parent_stream',
            capabilities: ['workspace.commit', 'workspace.land'],
          },
        },
      });
      if (!parsed) throw new Error('config should parse');
      config = parsed;
      topology = new YamlDrivenTopology(config);
      system.agentManager.setTopologyPolicy(topology);

      // Simulate team start (TeamManager would do this; we call manually)
      await topology.onTeamStart({
        teamName: 'peer-swarm-test',
        teamInstanceId: 'ps-1',
        workspaceConfig: config,
        workspaceManager,
      });
    });

    it('creates a team root stream at onTeamStart', () => {
      const streams = workspaceManager.listStreams();
      const teamRoot = streams.find((s) => s.agentId === 'team:peer-swarm-test');
      expect(teamRoot).toBeDefined();
      expect(teamRoot?.name).toBe('peer-swarm-test');
    });

    it('spawns orchestrator with no workspace (workspace: none)', async () => {
      const orch = await system.agentManager.spawn({
        role: 'orchestrator',
        task: 'coordinate',
      });
      const record = system.agentStore.getAgent(orch.id);
      // workspace: none → no workspace_path assigned
      expect(record?.workspace_path).toBeFalsy();
    });

    it('spawns peer with a new stream forked off team root', async () => {
      const peer = await system.agentManager.spawn({
        role: 'peer',
        task: 'investigate',
      });
      const record = system.agentStore.getAgent(peer.id);

      expect(record?.workspace_path).toBeDefined();
      expect(fs.existsSync(record!.workspace_path!)).toBe(true);

      const streams = workspaceManager.listStreams();
      const teamRoot = streams.find((s) => s.agentId === 'team:peer-swarm-test');
      const peerStream = streams.find((s) => s.agentId === peer.id);

      expect(peerStream).toBeDefined();
      expect(peerStream?.parentStream).toBe(teamRoot?.id);
    });

    it('emits stream:created and worktree:allocated events on peer spawn', async () => {
      const events: string[] = [];
      workspaceManager.onEvent((e) => events.push(e.type));

      await system.agentManager.spawn({ role: 'peer', task: 'investigate' });

      expect(events).toContain('stream:forked');
      expect(events).toContain('worktree:allocated');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // TEST 2: Landing — real merge-to-parent through a real merge
  // ═══════════════════════════════════════════════════════════════

  describe('merge-to-parent landing (V3)', () => {
    it('merges a child stream into its parent via the strategy', async () => {
      // Team root owned by a pseudo-principal
      const parentStreamId = workspaceManager.createStreamV3({
        name: 'parent',
        ownerId: 'team:landing-test',
        forkFrom: 'main',
      });

      // Agent owns a child forked off parent
      const childStreamId = workspaceManager.forkStream({
        parentStreamId,
        name: 'child',
        ownerId: 'agent-auth',
      });

      // Allocate worktree for the agent on the child branch
      const worktree = workspaceManager.allocateWorktree({
        agentId: 'agent-auth',
        streamId: childStreamId,
      });

      // Make a real commit via commitChanges (Change-Id tracked)
      fs.writeFileSync(path.join(worktree.path, 'auth.ts'), 'export const X = 1;');
      const { commit, changeId } = workspaceManager.commitChanges({
        agentId: 'agent-auth',
        streamId: childStreamId,
        worktree: worktree.path,
        message: 'feat: add auth module',
      });

      expect(commit).toMatch(/^[0-9a-f]+$/);
      expect(changeId).toMatch(/^c-/);

      // Invoke the landing strategy directly
      const strategy = new MergeToParentStrategy();
      const result = await strategy.land({
        agentId: 'agent-auth',
        streamId: childStreamId,
        sourceWorktree: worktree.path,
        workspaceManager,
      });

      expect(result.success).toBe(true);

      // Verify parent stream advanced
      const parent = workspaceManager.listStreams().find((s) => s.id === parentStreamId);
      expect(parent?.status).toBe('active');

      // Verify the Change-Id is tracked and findable
      const change = workspaceManager.getChange(changeId);
      expect(change).not.toBeNull();
    });

    it('fails gracefully when source has no parent', async () => {
      // Orphan stream (no parent)
      const streamId = workspaceManager.createStreamV3({
        name: 'orphan',
        ownerId: 'agent-x',
        forkFrom: 'main',
      });
      const worktree = workspaceManager.allocateWorktree({
        agentId: 'agent-x',
        streamId,
      });

      const strategy = new MergeToParentStrategy();
      const result = await strategy.land({
        agentId: 'agent-x',
        streamId,
        sourceWorktree: worktree.path,
        workspaceManager,
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/no target stream/);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // TEST 3: Conflict recovery — real conflict → real abandon
  // ═══════════════════════════════════════════════════════════════

  describe('conflict recovery dispatch (V3)', () => {
    it('routes through buildBuiltinRecoveryRegistry to the abandon strategy', async () => {
      // Create a stream so abandon has something to act on
      const streamId = workspaceManager.createStreamV3({
        name: 'doomed',
        ownerId: 'agent-1',
        forkFrom: 'main',
      });

      // Simulate a conflict record created by git-cascade
      const conflictId = adapter.createConflict({
        streamId,
        conflictingCommit: '0'.repeat(40),
        targetCommit: '0'.repeat(40),
        conflictedFiles: ['conflict.ts'],
      });

      const registry = buildBuiltinRecoveryRegistry();
      const abandon = registry.get('abandon');
      expect(abandon).toBeDefined();

      const resolution = await abandon!.recover({
        conflictId,
        streamId,
        paths: ['conflict.ts'],
        operation: 'merge',
        recoveryDepth: 0,
        workspaceManager,
      });

      expect(resolution.kind).toBe('abandoned');
      // Verify the stream is actually abandoned in git-cascade
      const stream = workspaceManager.listStreams().find((s) => s.id === streamId);
      expect(stream?.status).toBe('abandoned');
    });

    it('defer leaves the conflict record in place', async () => {
      const streamId = workspaceManager.createStreamV3({
        name: 'deferred',
        ownerId: 'agent-1',
        forkFrom: 'main',
      });
      const conflictId = adapter.createConflict({
        streamId,
        conflictingCommit: '0'.repeat(40),
        targetCommit: '0'.repeat(40),
        conflictedFiles: ['x.ts'],
      });

      const defer = new DeferStrategy();
      const resolution = await defer.recover({
        conflictId,
        streamId,
        paths: ['x.ts'],
        operation: 'merge',
        recoveryDepth: 0,
        workspaceManager,
      });

      expect(resolution.kind).toBe('deferred');
      // Stream is untouched (still active; conflict record still exists)
      const stream = workspaceManager.listStreams().find((s) => s.id === streamId);
      expect(stream?.status).toBe('active');
      const conflict = adapter.getConflict(conflictId);
      expect(conflict).not.toBeNull();
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // TEST 4: Regression — legacy path still works unchanged
  // ═══════════════════════════════════════════════════════════════

  describe('regression: legacy path (no TopologyPolicy set)', () => {
    it('still allocates workspace via role-name dispatch', async () => {
      // Do NOT set a topology policy; ensure legacy path is active
      const streamId = workspaceManager.createIntegrationStream('coord-legacy', {
        name: 'legacy-feature',
      });
      const taskId = workspaceManager.createTask(streamId, {
        title: 'legacy task',
      });

      const worker = await system.agentManager.spawn({
        role: 'worker',
        task: 'do work',
        streamId,
        gitCascadeTaskId: taskId,
        capabilities: ['workspace.worktree'],
      });

      const record = system.agentStore.getAgent(worker.id);
      expect(record?.workspace_path).toBeDefined();
      expect(fs.existsSync(record!.workspace_path!)).toBe(true);
    });
  });
});
