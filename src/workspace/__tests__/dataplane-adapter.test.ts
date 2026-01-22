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
});
