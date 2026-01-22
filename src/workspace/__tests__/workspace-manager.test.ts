/**
 * WorkspaceManager Tests
 *
 * Tests for the WorkspaceManager implementation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import {
  DefaultWorkspaceManager,
  createWorkspaceManager,
  createWorkspaceManagerWithAdapter,
} from '../workspace-manager.js';
import { createDataplaneAdapter } from '../dataplane-adapter.js';

describe('WorkspaceManager', () => {
  let tempDir: string;
  let repoPath: string;
  let dbPath: string;
  let manager: DefaultWorkspaceManager | null = null;

  beforeEach(() => {
    // Create temp directory
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-manager-test-'));
    repoPath = path.join(tempDir, 'repo');
    dbPath = path.join(tempDir, 'test.db');
    fs.mkdirSync(repoPath);

    // Initialize git repo
    execSync('git init', { cwd: repoPath, stdio: 'pipe' });
    execSync('git config user.email "test@test.com"', {
      cwd: repoPath,
      stdio: 'pipe',
    });
    execSync('git config user.name "Test User"', {
      cwd: repoPath,
      stdio: 'pipe',
    });

    // Create initial commit
    fs.writeFileSync(path.join(repoPath, 'README.md'), '# Test Repo');
    execSync('git add .', { cwd: repoPath, stdio: 'pipe' });
    execSync('git commit -m "Initial commit"', { cwd: repoPath, stdio: 'pipe' });
  });

  afterEach(() => {
    // Close manager if open
    if (manager) {
      manager.close();
      manager = null;
    }

    // Clean up temp directory
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('initialization', () => {
    it('should create manager with createWorkspaceManager', () => {
      manager = createWorkspaceManager({
        enabled: true,
        repoPath,
        dbPath,
        skipRecovery: true,
      });

      expect(manager).toBeDefined();
      expect(manager.rawAdapter.enabled).toBe(true);
    });

    it('should create manager with existing adapter', () => {
      const adapter = createDataplaneAdapter({
        enabled: true,
        repoPath,
        dbPath,
        skipRecovery: true,
      });

      manager = createWorkspaceManagerWithAdapter(adapter);

      expect(manager).toBeDefined();
      expect(manager.rawAdapter).toBe(adapter);

      adapter.close();
    });
  });

  describe('stream management', () => {
    beforeEach(() => {
      manager = createWorkspaceManager({
        enabled: true,
        repoPath,
        dbPath,
        skipRecovery: true,
      });
    });

    it('should create an integration stream', () => {
      const streamId = manager!.createIntegrationStream('coordinator-1', {
        name: 'feature/auth',
      });

      expect(streamId).toBeDefined();
      expect(typeof streamId).toBe('string');

      const stream = manager!.getStream(streamId);
      expect(stream).not.toBeNull();
      expect(stream!.name).toBe('feature/auth');
      expect(stream!.agentId).toBe('coordinator-1');
    });

    it('should create stream with custom forkFrom', () => {
      // Create a new branch first
      execSync('git checkout -b develop', { cwd: repoPath, stdio: 'pipe' });
      execSync('git checkout main', { cwd: repoPath, stdio: 'pipe' });

      const streamId = manager!.createIntegrationStream('coordinator-1', {
        name: 'feature/new',
        forkFrom: 'develop',
      });

      const stream = manager!.getStream(streamId);
      expect(stream).not.toBeNull();
    });

    it('should track agent to stream mapping', () => {
      const streamId = manager!.createIntegrationStream('coordinator-1', {
        name: 'feature/auth',
      });

      const foundStreamId = manager!.getStreamForAgent('coordinator-1');
      expect(foundStreamId).toBe(streamId);
    });
  });

  describe('task management', () => {
    let streamId: string;

    beforeEach(() => {
      manager = createWorkspaceManager({
        enabled: true,
        repoPath,
        dbPath,
        skipRecovery: true,
      });

      streamId = manager!.createIntegrationStream('coordinator-1', {
        name: 'feature/tasks',
      });
    });

    it('should create a task', () => {
      const taskId = manager!.createTask(streamId, {
        title: 'Implement feature X',
        priority: 10,
      });

      expect(taskId).toBeDefined();
      expect(typeof taskId).toBe('string');
    });

    it('should get next task', () => {
      manager!.createTask(streamId, {
        title: 'Task 1',
        priority: 20,
      });
      manager!.createTask(streamId, {
        title: 'Task 2',
        priority: 10, // Higher priority (lower number)
      });

      const nextTask = manager!.getNextTask(streamId);
      expect(nextTask).not.toBeNull();
      expect(nextTask!.title).toBe('Task 2'); // Higher priority first
    });

    it('should return null when no tasks available', () => {
      const nextTask = manager!.getNextTask(streamId);
      expect(nextTask).toBeNull();
    });
  });

  describe('workspace queries', () => {
    beforeEach(() => {
      manager = createWorkspaceManager({
        enabled: true,
        repoPath,
        dbPath,
        skipRecovery: true,
      });
    });

    it('should return null for unknown agent', () => {
      const workspace = manager!.getWorkspace('unknown-agent');
      expect(workspace).toBeNull();
    });

    it('should return null for unknown agent stream', () => {
      const streamId = manager!.getStreamForAgent('unknown-agent');
      expect(streamId).toBeNull();
    });
  });

  describe('event subscription', () => {
    beforeEach(() => {
      manager = createWorkspaceManager({
        enabled: true,
        repoPath,
        dbPath,
        skipRecovery: true,
      });
    });

    it('should allow subscribing to events', () => {
      const events: Array<{ type: string }> = [];
      const unsubscribe = manager!.onEvent((event) => events.push(event));

      // Creating a stream doesn't emit workspace events
      // But we can verify subscription works
      expect(typeof unsubscribe).toBe('function');

      unsubscribe();
    });

    it('should allow unsubscribing from events', () => {
      const events: Array<{ type: string }> = [];
      const unsubscribe = manager!.onEvent((event) => events.push(event));

      unsubscribe();

      // Event would have been added if still subscribed
      expect(events.length).toBe(0);
    });
  });

  describe('child workspace registration', () => {
    let streamId: string;

    beforeEach(() => {
      manager = createWorkspaceManager({
        enabled: true,
        repoPath,
        dbPath,
        skipRecovery: true,
        worktreeBaseDir: path.join(tempDir, '.worktrees'),
      });

      streamId = manager!.createIntegrationStream('coordinator-1', {
        name: 'feature/registration',
      });
    });

    it('should throw when registering child for non-coordinator', () => {
      expect(() => {
        manager!.registerChildWorkspace(
          'unknown-coordinator',
          'child-1',
          '/path/to/child'
        );
      }).toThrow('No coordinator workspace found');
    });
  });

  describe('cleanup', () => {
    it('should clean up on close', () => {
      manager = createWorkspaceManager({
        enabled: true,
        repoPath,
        dbPath,
        skipRecovery: true,
      });

      manager!.createIntegrationStream('coordinator-1', {
        name: 'feature/cleanup',
      });

      // Close should not throw
      expect(() => manager!.close()).not.toThrow();

      // After close, queries should return null/empty
      expect(manager!.getStreamForAgent('coordinator-1')).toBeNull();
    });
  });

  describe('merge queue', () => {
    beforeEach(() => {
      manager = createWorkspaceManager({
        enabled: true,
        repoPath,
        dbPath,
        skipRecovery: true,
      });
    });

    it('should provide merge queue via getMergeQueue()', () => {
      const mergeQueue = manager!.getMergeQueue();

      expect(mergeQueue).toBeDefined();
      expect(typeof mergeQueue.submit).toBe('function');
      expect(typeof mergeQueue.getNext).toBe('function');
      expect(typeof mergeQueue.getQueueDepth).toBe('function');
    });

    it('should return the same merge queue instance on multiple calls', () => {
      const queue1 = manager!.getMergeQueue();
      const queue2 = manager!.getMergeQueue();

      expect(queue1).toBe(queue2);
    });

    it('should allow submitting merge requests through the queue', () => {
      const streamId = manager!.createIntegrationStream('coordinator-1', {
        name: 'feature/merge-test',
      });

      const mergeQueue = manager!.getMergeQueue();

      const mrId = mergeQueue.submit({
        streamId,
        taskId: 'task-1',
        workerBranch: 'worker/test-branch',
        workerAgentId: 'worker-1',
      });

      expect(mrId).toBeDefined();
      expect(typeof mrId).toBe('string');
      expect(mrId.startsWith('mr-')).toBe(true);

      // Verify we can retrieve the merge request
      const mr = mergeQueue.get(mrId);
      expect(mr).not.toBeNull();
      expect(mr!.streamId).toBe(streamId);
      expect(mr!.taskId).toBe('task-1');
      expect(mr!.status).toBe('pending');
    });

    it('should track queue depth correctly', () => {
      const streamId = manager!.createIntegrationStream('coordinator-1', {
        name: 'feature/queue-depth',
      });

      const mergeQueue = manager!.getMergeQueue();

      expect(mergeQueue.getQueueDepth(streamId)).toBe(0);

      mergeQueue.submit({
        streamId,
        taskId: 'task-1',
        workerBranch: 'worker/branch-1',
        workerAgentId: 'worker-1',
      });

      expect(mergeQueue.getQueueDepth(streamId)).toBe(1);

      mergeQueue.submit({
        streamId,
        taskId: 'task-2',
        workerBranch: 'worker/branch-2',
        workerAgentId: 'worker-2',
      });

      expect(mergeQueue.getQueueDepth(streamId)).toBe(2);
    });

    it('should close merge queue on manager close', () => {
      const mergeQueue = manager!.getMergeQueue();
      const streamId = manager!.createIntegrationStream('coordinator-1', {
        name: 'feature/close-test',
      });

      // Submit a merge request
      mergeQueue.submit({
        streamId,
        taskId: 'task-1',
        workerBranch: 'worker/branch-1',
        workerAgentId: 'worker-1',
      });

      // Close the manager
      manager!.close();

      // Getting merge queue again should create a new instance
      const newQueue = manager!.getMergeQueue();
      expect(newQueue).not.toBe(mergeQueue);
    });
  });
});
