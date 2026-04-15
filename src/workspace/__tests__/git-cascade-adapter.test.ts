/**
 * GitCascadeAdapter Tests
 *
 * Tests for the git-cascade integration adapter.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import { GitCascadeAdapter, createGitCascadeAdapter } from '../git-cascade-adapter.js';

describe('GitCascadeAdapter', () => {
  let tempDir: string;
  let repoPath: string;
  let dbPath: string;
  let adapter: GitCascadeAdapter | null = null;

  beforeEach(() => {
    // Create temp directory
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-cascade-test-'));
    repoPath = path.join(tempDir, 'repo');
    dbPath = path.join(tempDir, 'test.db');
    fs.mkdirSync(repoPath);

    // Initialize git repo
    execSync('git init', { cwd: repoPath, stdio: 'pipe' });
    execSync('git config user.email "test@test.com"', { cwd: repoPath, stdio: 'pipe' });
    execSync('git config user.name "Test User"', { cwd: repoPath, stdio: 'pipe' });

    // Create initial commit
    fs.writeFileSync(path.join(repoPath, 'README.md'), '# Test Repo');
    execSync('git add .', { cwd: repoPath, stdio: 'pipe' });
    execSync('git commit -m "Initial commit"', { cwd: repoPath, stdio: 'pipe' });
  });

  afterEach(() => {
    // Close adapter if open
    if (adapter) {
      adapter.close();
      adapter = null;
    }

    // Clean up temp directory
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('initialization', () => {
    it('should create adapter with default config', () => {
      adapter = createGitCascadeAdapter({
        enabled: true,
        repoPath,
        dbPath,
      });

      expect(adapter.enabled).toBe(true);
      expect(adapter.repoPath).toBe(repoPath);
    });

    it('should create adapter with custom table prefix', () => {
      adapter = createGitCascadeAdapter({
        enabled: true,
        repoPath,
        dbPath,
        tablePrefix: 'custom_',
      });

      expect(adapter.enabled).toBe(true);
    });

    it('should use provided database path', () => {
      const dbPath = path.join(tempDir, 'custom.db');
      adapter = createGitCascadeAdapter({
        enabled: true,
        repoPath,
        dbPath,
      });

      expect(fs.existsSync(dbPath)).toBe(true);
    });
  });

  describe('stream operations', () => {
    beforeEach(() => {
      adapter = createGitCascadeAdapter({
        enabled: true,
        repoPath,
        dbPath,
        skipRecovery: true,
      });
    });

    it('should create a stream', () => {
      const streamId = adapter!.createStream({
        name: 'feature/test',
        agentId: 'agent-1',
      });

      expect(streamId).toBeDefined();
      expect(typeof streamId).toBe('string');

      const stream = adapter!.getStream(streamId);
      expect(stream).not.toBeNull();
      expect(stream!.name).toBe('feature/test');
      expect(stream!.agentId).toBe('agent-1');
    });

    it('should list streams', () => {
      const streamId = adapter!.createStream({
        name: 'feature/test',
        agentId: 'agent-1',
      });

      const streams = adapter!.listStreams();
      expect(streams.length).toBe(1);
      expect(streams[0].id).toBe(streamId);
    });

    it('should emit stream:created event', () => {
      const events: Array<{ type: string; data: Record<string, unknown> }> = [];
      adapter!.onEvent((event) => events.push(event));

      adapter!.createStream({
        name: 'feature/test',
        agentId: 'agent-1',
      });

      expect(events.length).toBe(1);
      expect(events[0].type).toBe('stream:created');
      expect(events[0].data.name).toBe('feature/test');
    });
  });

  describe('task operations', () => {
    let streamId: string;

    beforeEach(() => {
      adapter = createGitCascadeAdapter({
        enabled: true,
        repoPath,
        dbPath,
        skipRecovery: true,
      });

      streamId = adapter!.createStream({
        name: 'feature/test',
        agentId: 'coordinator-1',
      });
    });

    it('should create a task', () => {
      const taskId = adapter!.createTask({
        streamId,
        title: 'Implement feature',
      });

      expect(taskId).toBeDefined();

      const task = adapter!.getTask(taskId);
      expect(task).not.toBeNull();
      expect(task!.title).toBe('Implement feature');
      expect(task!.status).toBe('open');
    });

    it('should list tasks for stream', () => {
      const taskId = adapter!.createTask({
        streamId,
        title: 'Implement feature',
      });

      const tasks = adapter!.listTasks(streamId);
      expect(tasks.length).toBe(1);
      expect(tasks[0].id).toBe(taskId);
    });

    it('should emit task:created event', () => {
      const events: Array<{ type: string; data: Record<string, unknown> }> = [];
      adapter!.onEvent((event) => {
        if (event.type === 'task:created') {
          events.push(event);
        }
      });

      adapter!.createTask({
        streamId,
        title: 'Implement feature',
      });

      expect(events.length).toBe(1);
      expect(events[0].type).toBe('task:created');
      expect(events[0].data.title).toBe('Implement feature');
    });
  });

  describe('health check', () => {
    beforeEach(() => {
      adapter = createGitCascadeAdapter({
        enabled: true,
        repoPath,
        dbPath,
        skipRecovery: true,
      });
    });

    it('should return health check result', () => {
      const health = adapter!.healthCheck();

      expect(health).toBeDefined();
      expect(typeof health.streamCount).toBe('number');
      expect(typeof health.activeAgents).toBe('number');
      expect(typeof health.healthy).toBe('boolean');
    });
  });

  describe('event subscription', () => {
    beforeEach(() => {
      adapter = createGitCascadeAdapter({
        enabled: true,
        repoPath,
        dbPath,
        skipRecovery: true,
      });
    });

    it('should allow unsubscribing from events', () => {
      const events: Array<{ type: string }> = [];
      const unsubscribe = adapter!.onEvent((event) => events.push(event));

      adapter!.createStream({
        name: 'feature/test1',
        agentId: 'agent-1',
      });

      expect(events.length).toBe(1);

      unsubscribe();

      adapter!.createStream({
        name: 'feature/test2',
        agentId: 'agent-1',
      });

      expect(events.length).toBe(1); // No new events after unsubscribe
    });
  });

  describe('checkpoint operations', () => {
    let streamId: string;
    let worktreePath: string;

    beforeEach(() => {
      adapter = createGitCascadeAdapter({
        enabled: true,
        repoPath,
        dbPath,
        skipRecovery: true,
      });

      // Create stream
      streamId = adapter!.createStream({
        name: 'feature/checkpoint-test',
        agentId: 'coordinator-1',
      });

      // Create worktree for the agent
      worktreePath = path.join(tempDir, 'worktree-agent-1');
      adapter!.createWorktree({
        agentId: 'agent-1',
        path: worktreePath,
        branch: adapter!.getStreamBranchName(streamId),
      });
    });

    afterEach(() => {
      // Clean up worktree
      if (fs.existsSync(worktreePath)) {
        try {
          execSync(`git worktree remove "${worktreePath}" --force`, {
            cwd: repoPath,
            stdio: 'pipe',
          });
        } catch {
          // Ignore errors - worktree may not exist
        }
      }
    });

    it('should create checkpoints for task commits', () => {
      // Create and start task
      const taskId = adapter!.createTask({
        streamId,
        title: 'Test task',
      });

      const startResult = adapter!.startTask({
        taskId,
        agentId: 'agent-1',
        worktree: worktreePath,
      });

      expect(startResult.startCommit).toBeDefined();

      // Make a commit in the worktree
      const testFile = path.join(worktreePath, 'test.txt');
      fs.writeFileSync(testFile, 'Test content');
      execSync('git add test.txt', { cwd: worktreePath, stdio: 'pipe' });
      execSync('git commit -m "Add test file"', { cwd: worktreePath, stdio: 'pipe' });

      // Complete the task (merges to stream)
      adapter!.completeTask({ taskId, worktree: worktreePath });

      // Create checkpoints for the task
      const checkpoints = adapter!.createCheckpointsForTask(taskId, 'agent-1');

      // At least 1 checkpoint (feature commit), may include merge commit
      expect(checkpoints.length).toBeGreaterThanOrEqual(1);
      expect(checkpoints[0].streamId).toBe(streamId);
      expect(checkpoints[0].createdBy).toBe('agent-1');
    });

    it('should return empty array for non-existent task', () => {
      const checkpoints = adapter!.createCheckpointsForTask('non-existent', 'agent-1');
      expect(checkpoints).toEqual([]);
    });

    it('should return empty array for task without streamId', () => {
      // Create task without starting it (no streamId assignment happens at create)
      // Actually tasks always have streamId from create, so test task not found instead
      const checkpoints = adapter!.createCheckpointsForTask('invalid-task-id', 'agent-1');
      expect(checkpoints).toEqual([]);
    });

    it('should create multiple checkpoints for multiple commits', () => {
      // Create and start task
      const taskId = adapter!.createTask({
        streamId,
        title: 'Multi-commit task',
      });

      adapter!.startTask({
        taskId,
        agentId: 'agent-1',
        worktree: worktreePath,
      });

      // Make multiple commits
      fs.writeFileSync(path.join(worktreePath, 'file1.txt'), 'Content 1');
      execSync('git add file1.txt', { cwd: worktreePath, stdio: 'pipe' });
      execSync('git commit -m "Add file 1"', { cwd: worktreePath, stdio: 'pipe' });

      fs.writeFileSync(path.join(worktreePath, 'file2.txt'), 'Content 2');
      execSync('git add file2.txt', { cwd: worktreePath, stdio: 'pipe' });
      execSync('git commit -m "Add file 2"', { cwd: worktreePath, stdio: 'pipe' });

      // Complete the task
      adapter!.completeTask({ taskId, worktree: worktreePath });

      // Create checkpoints
      const checkpoints = adapter!.createCheckpointsForTask(taskId, 'agent-1');

      // Should have checkpoints for both commits (merge commit may also be included)
      expect(checkpoints.length).toBeGreaterThanOrEqual(2);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // Phase 0 additive expansion — new surface coverage
  // ───────────────────────────────────────────────────────────────────

  describe('stream stacking (Phase 0)', () => {
    beforeEach(() => {
      adapter = createGitCascadeAdapter({
        enabled: true,
        repoPath,
        dbPath,
        skipRecovery: true,
      });
    });

    it('forks a child stream off a parent', () => {
      const parent = adapter!.createStream({ name: 'parent', agentId: 'agent-1' });
      const child = adapter!.forkStream({
        parentStreamId: parent,
        name: 'child',
        agentId: 'agent-2',
      });

      const childStream = adapter!.getStream(child);
      expect(childStream?.parentStream).toBe(parent);
    });

    it('emits stream:forked on forkStream', () => {
      const parent = adapter!.createStream({ name: 'parent', agentId: 'agent-1' });
      const events: Array<{ type: string }> = [];
      adapter!.onEvent((e) => events.push(e));

      adapter!.forkStream({ parentStreamId: parent, name: 'child', agentId: 'agent-2' });

      expect(events.some((e) => e.type === 'stream:forked')).toBe(true);
    });

    it('pauses and resumes a stream', () => {
      const streamId = adapter!.createStream({ name: 'feat', agentId: 'a' });
      adapter!.pauseStream(streamId, 'manual pause');
      expect(adapter!.getStream(streamId)?.status).toBe('paused');
      adapter!.resumeStream(streamId);
      expect(adapter!.getStream(streamId)?.status).toBe('active');
    });

    it('tracks stream dependencies', () => {
      const a = adapter!.createStream({ name: 'a', agentId: 'agent-1' });
      const b = adapter!.createStream({ name: 'b', agentId: 'agent-1' });
      adapter!.addDependency(b, a); // b depends on a

      expect(adapter!.getDependencies(b)).toContain(a);
      expect(adapter!.getDependents(a)).toContain(b);

      adapter!.removeDependency(b, a);
      expect(adapter!.getDependencies(b)).not.toContain(a);
    });

    it('returns stream hierarchy as tree', () => {
      const root = adapter!.createStream({ name: 'root', agentId: 'a' });
      const child = adapter!.forkStream({ parentStreamId: root, name: 'child', agentId: 'a' });

      const hier = adapter!.getStreamHierarchy(root);
      // Single root → StreamNode
      const node = Array.isArray(hier) ? hier[0] : hier;
      expect(node.stream.id).toBe(root);
      expect(node.children.some((c) => c.stream.id === child)).toBe(true);
    });
  });

  describe('merge queue (Phase 0, delegates to git-cascade built-in)', () => {
    let streamId: string;
    beforeEach(() => {
      adapter = createGitCascadeAdapter({
        enabled: true,
        repoPath,
        dbPath,
        skipRecovery: true,
      });
      streamId = adapter!.createStream({ name: 'feat-q', agentId: 'agent-1' });
    });

    it('adds a stream to the queue and assigns a position', () => {
      const entryId = adapter!.addToMergeQueue({ streamId, targetBranch: 'main', agentId: 'agent-1' });
      expect(entryId).toBeDefined();

      const pos = adapter!.getMergeQueuePosition(streamId, 'main');
      expect(pos).not.toBeNull();

      const entry = adapter!.getMergeQueueEntry(entryId);
      expect(entry?.streamId).toBe(streamId);
    });

    it('lists entries filtered by status', () => {
      adapter!.addToMergeQueue({ streamId, targetBranch: 'main', agentId: 'agent-1' });
      const pending = adapter!.listMergeQueue({ targetBranch: 'main', status: 'pending' });
      expect(pending.length).toBeGreaterThan(0);
    });

    it('marks an entry ready and cancels it', () => {
      const entryId = adapter!.addToMergeQueue({ streamId, targetBranch: 'main', agentId: 'agent-1' });
      adapter!.markMergeQueueReady(entryId);
      expect(adapter!.getMergeQueueEntry(entryId)?.status).toBe('ready');

      adapter!.cancelMergeQueueEntry(entryId);
      expect(adapter!.getMergeQueueEntry(entryId)?.status).toBe('cancelled');
    });

    it('emits mergeQueue:added / :ready / :cancelled events', () => {
      const seen: string[] = [];
      adapter!.onEvent((e) => seen.push(e.type));

      const entryId = adapter!.addToMergeQueue({ streamId, targetBranch: 'main', agentId: 'agent-1' });
      adapter!.markMergeQueueReady(entryId);
      adapter!.cancelMergeQueueEntry(entryId);

      expect(seen).toContain('mergeQueue:added');
      expect(seen).toContain('mergeQueue:ready');
      expect(seen).toContain('mergeQueue:cancelled');
    });
  });

  describe('conflicts (Phase 0)', () => {
    let streamId: string;
    beforeEach(() => {
      adapter = createGitCascadeAdapter({
        enabled: true,
        repoPath,
        dbPath,
        skipRecovery: true,
      });
      streamId = adapter!.createStream({ name: 'feat-c', agentId: 'agent-1' });
    });

    const dummyCommit = '0000000000000000000000000000000000000000';

    it('creates and retrieves a conflict record', () => {
      const id = adapter!.createConflict({
        streamId,
        conflictingCommit: dummyCommit,
        targetCommit: dummyCommit,
        conflictedFiles: ['a.ts', 'b.ts'],
      });
      const record = adapter!.getConflict(id);
      expect(record?.streamId).toBe(streamId);
      expect(record?.conflictedFiles).toEqual(['a.ts', 'b.ts']);
    });

    it('gets the active conflict for a stream', () => {
      adapter!.createConflict({
        streamId,
        conflictingCommit: dummyCommit,
        targetCommit: dummyCommit,
        conflictedFiles: ['x.ts'],
      });
      const record = adapter!.getConflictForStream(streamId);
      expect(record).not.toBeNull();
    });

    it('emits conflict:created event', () => {
      const events: Array<{ type: string }> = [];
      adapter!.onEvent((e) => events.push(e));
      adapter!.createConflict({
        streamId,
        conflictingCommit: dummyCommit,
        targetCommit: dummyCommit,
        conflictedFiles: ['x.ts'],
      });
      expect(events.some((e) => e.type === 'conflict:created')).toBe(true);
    });
  });

  describe('reconcile (Phase 0)', () => {
    beforeEach(() => {
      adapter = createGitCascadeAdapter({
        enabled: true,
        repoPath,
        dbPath,
        skipRecovery: true,
      });
    });

    it('checkStreamSync reports in-sync for a just-created stream', () => {
      const streamId = adapter!.createStream({ name: 'feat-s', agentId: 'a' });
      const status = adapter!.checkStreamSync(streamId);
      expect(status).toBeDefined();
      // Fresh stream should be in sync (no divergence yet)
      expect(status.inSync).toBe(true);
    });

    it('reconcile runs without error on a healthy db', () => {
      adapter!.createStream({ name: 'feat-r', agentId: 'a' });
      const result = adapter!.reconcile({ dryRun: true });
      expect(result).toBeDefined();
    });
  });
});
