/**
 * WorkspaceManager V3 surface tests (Phase 1).
 *
 * Covers the stream-first methods added alongside the legacy role-shaped API.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import { createGitCascadeAdapter, type GitCascadeAdapter } from '../git-cascade-adapter.js';
import {
  DefaultWorkspaceManager,
  createWorkspaceManagerWithAdapter,
} from '../workspace-manager.js';

describe('WorkspaceManager V3 surface', () => {
  let tempDir: string;
  let repoPath: string;
  let dbPath: string;
  let adapter: GitCascadeAdapter;
  let manager: DefaultWorkspaceManager;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-v3-test-'));
    repoPath = path.join(tempDir, 'repo');
    dbPath = path.join(tempDir, 'test.db');
    fs.mkdirSync(repoPath);

    execSync('git init -b main', { cwd: repoPath, stdio: 'pipe' });
    execSync('git config user.email "test@test.com"', { cwd: repoPath, stdio: 'pipe' });
    execSync('git config user.name "Test User"', { cwd: repoPath, stdio: 'pipe' });
    fs.writeFileSync(path.join(repoPath, 'README.md'), '# Test');
    execSync('git add .', { cwd: repoPath, stdio: 'pipe' });
    execSync('git commit -m "init"', { cwd: repoPath, stdio: 'pipe' });

    adapter = createGitCascadeAdapter({
      enabled: true,
      repoPath,
      dbPath,
      skipRecovery: true,
    });
    manager = createWorkspaceManagerWithAdapter(adapter, {
      worktreeBaseDir: path.join(tempDir, 'worktrees'),
    }) as DefaultWorkspaceManager;
  });

  afterEach(() => {
    manager.close();
    adapter.close();
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('streams', () => {
    it('creates a stream with a pseudo-principal owner', () => {
      const streamId = manager.createStreamV3({
        name: 'team-root',
        ownerId: 'team:peer-swarm',
        forkFrom: 'main',
      });
      expect(streamId).toBeDefined();
    });

    it('forks a child stream off a parent', () => {
      const parent = manager.createStreamV3({
        name: 'parent',
        ownerId: 'team:solo-stack',
      });
      const child = manager.forkStream({
        parentStreamId: parent,
        name: 'child',
        ownerId: 'agent-1',
      });
      const childStream = adapter.getStream(child);
      expect(childStream?.parentStream).toBe(parent);
    });

    it('emits stream:created and stream:forked events', () => {
      const events: string[] = [];
      manager.onEvent((e) => events.push(e.type));

      const parent = manager.createStreamV3({ name: 'parent', ownerId: 'team:x' });
      manager.forkStream({ parentStreamId: parent, name: 'child', ownerId: 'agent-1' });

      expect(events).toContain('stream:created');
      expect(events).toContain('stream:forked');
    });

    it('pauses and resumes a stream with events', () => {
      const streamId = manager.createStreamV3({ name: 'x', ownerId: 'agent-1' });
      const events: string[] = [];
      manager.onEvent((e) => events.push(e.type));

      manager.pauseStream(streamId, 'manual');
      expect(adapter.getStream(streamId)?.status).toBe('paused');
      expect(events).toContain('stream:paused');

      manager.resumeStream(streamId);
      expect(adapter.getStream(streamId)?.status).toBe('active');
      expect(events).toContain('stream:resumed');
    });

    it('lists streams by owner', () => {
      manager.createStreamV3({ name: 'a', ownerId: 'agent-1' });
      manager.createStreamV3({ name: 'b', ownerId: 'agent-2' });
      const owned = manager.listStreams({ ownerId: 'agent-1' });
      expect(owned.length).toBe(1);
      expect(owned[0].name).toBe('a');
    });
  });

  describe('worktree allocation', () => {
    it('allocates a worktree attached to a stream', () => {
      const streamId = manager.createStreamV3({ name: 'feat', ownerId: 'agent-1' });
      const wt = manager.allocateWorktree({
        agentId: 'agent-1',
        streamId,
      });
      expect(wt.path).toContain('agent-1');
      expect(wt.agentId).toBe('agent-1');
    });

    it('shares a worktree between two agents (ref-counted)', () => {
      const streamId = manager.createStreamV3({ name: 'feat', ownerId: 'agent-1' });
      const primary = manager.allocateWorktree({ agentId: 'agent-1', streamId });

      const shared = manager.allocateWorktree({
        agentId: 'agent-2',
        sharedWithAgent: 'agent-1',
      });

      expect(shared.path).toBe(primary.path);
    });

    it('throws when sharing from an unallocated agent', () => {
      expect(() =>
        manager.allocateWorktree({ agentId: 'agent-x', sharedWithAgent: 'nonexistent' })
      ).toThrow(/has no allocated worktree/);
    });

    it('emits worktree:allocated and worktree:shared events', () => {
      const streamId = manager.createStreamV3({ name: 'feat', ownerId: 'agent-1' });
      const events: string[] = [];
      manager.onEvent((e) => events.push(e.type));

      manager.allocateWorktree({ agentId: 'agent-1', streamId });
      manager.allocateWorktree({ agentId: 'agent-2', sharedWithAgent: 'agent-1' });

      expect(events).toContain('worktree:allocated');
      expect(events).toContain('worktree:shared');
    });
  });

  describe('changes (Change-Id tracking)', () => {
    it('commits via commitChanges and assigns a Change-Id', () => {
      const streamId = manager.createStreamV3({ name: 'feat', ownerId: 'agent-1' });
      const wt = manager.allocateWorktree({ agentId: 'agent-1', streamId });

      fs.writeFileSync(path.join(wt.path, 'hello.txt'), 'hi');

      const result = manager.commitChanges({
        agentId: 'agent-1',
        streamId,
        worktree: wt.path,
        message: 'add hello',
      });

      expect(result.commit).toBeDefined();
      expect(result.changeId).toBeDefined();
      expect(result.changeId.startsWith('c-')).toBe(true);

      const change = manager.getChangeByCommit(result.commit);
      expect(change?.id).toBe(result.changeId);
    });

    it('emits stream:committed event on commit', () => {
      const streamId = manager.createStreamV3({ name: 'feat', ownerId: 'agent-1' });
      const wt = manager.allocateWorktree({ agentId: 'agent-1', streamId });

      fs.writeFileSync(path.join(wt.path, 'x.txt'), 'x');

      const events: Array<{ type: string; data: Record<string, unknown> }> = [];
      manager.onEvent((e) => events.push(e));

      manager.commitChanges({
        agentId: 'agent-1',
        streamId,
        worktree: wt.path,
        message: 'x',
      });

      const committed = events.find((e) => e.type === 'stream:committed');
      expect(committed).toBeDefined();
      expect(committed?.data.streamId).toBe(streamId);
    });

    it('marks changes merged and emits events', () => {
      const streamId = manager.createStreamV3({ name: 'feat', ownerId: 'agent-1' });
      const wt = manager.allocateWorktree({ agentId: 'agent-1', streamId });
      fs.writeFileSync(path.join(wt.path, 'x.txt'), 'x');
      const { changeId } = manager.commitChanges({
        agentId: 'agent-1',
        streamId,
        worktree: wt.path,
        message: 'x',
      });

      const events: string[] = [];
      manager.onEvent((e) => events.push(e.type));

      manager.markChangesMerged([changeId]);
      expect(events).toContain('change:merged');
    });
  });

  describe('landing strategy registry', () => {
    it('registers landing strategies', () => {
      const mockStrategy = {
        name: 'test-strategy',
        async land() {
          return { success: true };
        },
      };
      manager.registerLandingStrategy(mockStrategy);
      // Registration is internal; successful if no throw. Full integration
      // covered in Phase 5.
      expect(true).toBe(true);
    });
  });

  describe('reconcileV3', () => {
    it('returns a MacroReconcileResult with zero issues on a clean db', () => {
      manager.createStreamV3({ name: 'a', ownerId: 'agent-1' });
      const result = manager.reconcileV3();

      expect(result).toBeDefined();
      expect(result.errors.length).toBe(0);
      // Fresh streams are in sync → no fixes needed
      expect(result.worktreesOrphaned).toBe(0);
    });
  });
});
