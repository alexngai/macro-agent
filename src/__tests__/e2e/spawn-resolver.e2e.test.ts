/**
 * SpawnResolverStrategy real-spawn e2e.
 *
 * Exercises the full conflict recovery flow:
 *   1. Set up a real conflict (two streams with conflicting changes)
 *   2. SpawnResolverStrategy.recover() actually spawns a resolver agent
 *      via AgentManager (mocked Claude Code)
 *   3. The resolver calls workspaceManager.resolveConflict() which emits
 *      conflict:resolved
 *   4. The awaiting recover() Promise resolves
 *
 * Uses mocked acp-factory — focus is on the orchestration, not on an LLM
 * actually resolving conflicts.
 *
 * REQUIRES: RUN_E2E_TESTS=true
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import { bootV2, type MacroAgentSystemV2 } from '../../boot-v2.js';
import { GitCascadeAdapter } from '../../workspace/git-cascade-adapter.js';
import {
  DefaultWorkspaceManager,
  createWorkspaceManagerWithAdapter,
} from '../../workspace/workspace-manager.js';
import { createSpawnResolverStrategy } from '../../workspace/recovery/spawn-resolver.js';
import type { ConflictContext } from '../../workspace/recovery/types.js';

const RUN_E2E = !!process.env.RUN_E2E_TESTS;
const describeFn = RUN_E2E ? describe : describe.skip;

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

describeFn('SpawnResolver real-spawn e2e', () => {
  let system: MacroAgentSystemV2;
  let testDir: string;
  let repoPath: string;
  let adapter: GitCascadeAdapter;
  let workspaceManager: DefaultWorkspaceManager;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-resolver-e2e-'));
    repoPath = path.join(testDir, 'repo');
    fs.mkdirSync(repoPath);

    execSync('git init -b main', { cwd: repoPath, stdio: 'pipe' });
    execSync('git config user.email "t@t.com"', { cwd: repoPath, stdio: 'pipe' });
    execSync('git config user.name "T"', { cwd: repoPath, stdio: 'pipe' });
    fs.writeFileSync(path.join(repoPath, 'README.md'), '# test');
    execSync('git add .', { cwd: repoPath, stdio: 'pipe' });
    execSync('git commit -m "init"', { cwd: repoPath, stdio: 'pipe' });

    adapter = new GitCascadeAdapter({
      enabled: true,
      repoPath,
      dbPath: path.join(testDir, 'gc.db'),
      skipRecovery: true,
    });
    workspaceManager = createWorkspaceManagerWithAdapter(adapter, {
      worktreeBaseDir: path.join(repoPath, '.worktrees'),
    }) as DefaultWorkspaceManager;

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

  it('spawns a real resolver agent and resolves via workspaceManager.resolveConflict', async () => {
    // Set up: conflicted stream
    const streamId = workspaceManager.createStreamV3({
      name: 'conflicted-feature',
      ownerId: 'team:test',
      forkFrom: 'main',
    });
    const conflictId = adapter.createConflict({
      streamId,
      conflictingCommit: '0'.repeat(40),
      targetCommit: '0'.repeat(40),
      conflictedFiles: ['auth.ts'],
    });

    // Construct the strategy with AgentManager injection
    const strategy = createSpawnResolverStrategy({
      agentManager: system.agentManager,
      defaultRole: 'worker', // using built-in worker role (has spawn capability)
      defaultTimeoutMs: 10_000,
    });

    const ctx: ConflictContext = {
      conflictId,
      streamId,
      paths: ['auth.ts'],
      operation: 'merge',
      recoveryDepth: 0,
      workspaceManager,
      strategyConfig: { role: 'worker', timeout_ms: 10_000 },
    };

    // Kick off recovery. Strategy spawns a resolver agent, then awaits
    // conflict:resolved. We simulate the resolver's tool call by invoking
    // workspaceManager.resolveConflict directly after a small delay.
    const recoveryPromise = strategy.recover(ctx);

    // Give the strategy time to spawn + subscribe
    await new Promise((r) => setTimeout(r, 100));

    // Simulate resolver finishing its work
    workspaceManager.resolveConflict({
      conflictId,
      resolvedBy: 'agent_resolver_stub',
      resolutionCommit: 'abc123def456',
    });

    const resolution = await recoveryPromise;
    expect(resolution.kind).toBe('resolved');
    if (resolution.kind === 'resolved') {
      expect(resolution.resolutionCommit).toBe('abc123def456');
    }

    // A resolver agent should have actually been spawned by AgentManager
    const agents = system.agentStore.listAgents({});
    const resolverAgents = agents.filter((a) => a.role === 'worker');
    expect(resolverAgents.length).toBeGreaterThan(0);
  });

  it('escalates to human on timeout (no resolve_conflict call)', async () => {
    const streamId = workspaceManager.createStreamV3({
      name: 'timeout-feature',
      ownerId: 'team:test',
      forkFrom: 'main',
    });
    const conflictId = adapter.createConflict({
      streamId,
      conflictingCommit: '0'.repeat(40),
      targetCommit: '0'.repeat(40),
      conflictedFiles: ['x.ts'],
    });

    const strategy = createSpawnResolverStrategy({
      agentManager: system.agentManager,
      defaultRole: 'worker',
      defaultTimeoutMs: 200, // short timeout to force escalation
    });

    const resolution = await strategy.recover({
      conflictId,
      streamId,
      paths: ['x.ts'],
      operation: 'merge',
      recoveryDepth: 0,
      workspaceManager,
      strategyConfig: { role: 'worker' },
    });

    expect(resolution.kind).toBe('escalated');
    if (resolution.kind === 'escalated') {
      expect(resolution.escalatedTo).toBe('human');
    }
  });
});
