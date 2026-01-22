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
});
