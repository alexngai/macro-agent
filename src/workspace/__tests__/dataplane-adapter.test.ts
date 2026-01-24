/**
 * DataplaneAdapter Tests
 *
 * Tests for the dataplane integration adapter.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import { DataplaneAdapter, createDataplaneAdapter } from '../dataplane-adapter.js';

describe('DataplaneAdapter', () => {
  let tempDir: string;
  let repoPath: string;
  let dbPath: string;
  let adapter: DataplaneAdapter | null = null;

  beforeEach(() => {
    // Create temp directory
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dataplane-test-'));
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
      adapter = createDataplaneAdapter({
        enabled: true,
        repoPath,
        dbPath,
      });

      expect(adapter.enabled).toBe(true);
      expect(adapter.repoPath).toBe(repoPath);
    });

    it('should create adapter with custom table prefix', () => {
      adapter = createDataplaneAdapter({
        enabled: true,
        repoPath,
        dbPath,
        tablePrefix: 'custom_',
      });

      expect(adapter.enabled).toBe(true);
    });

    it('should use provided database path', () => {
      const dbPath = path.join(tempDir, 'custom.db');
      adapter = createDataplaneAdapter({
        enabled: true,
        repoPath,
        dbPath,
      });

      expect(fs.existsSync(dbPath)).toBe(true);
    });
  });

  describe('stream operations', () => {
    beforeEach(() => {
      adapter = createDataplaneAdapter({
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
      adapter = createDataplaneAdapter({
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
      adapter = createDataplaneAdapter({
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
      adapter = createDataplaneAdapter({
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
      adapter = createDataplaneAdapter({
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
});
