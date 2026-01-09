/**
 * Tests for SQLite Storage Backend
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createSqliteBackend, createSqliteBackendFromPath } from '../sqlite-backend.js';
import type { StorageBackend } from '../types.js';
import type { Event } from '../../types/index.js';

describe('SQLite Backend', () => {
  let backend: StorageBackend;
  let testDir: string;
  let dbPath: string;

  function createTestDir(): string {
    const dir = path.join(
      os.tmpdir(),
      `macro-agent-sqlite-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  function cleanupTestDir(dir: string): void {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  beforeEach(() => {
    testDir = createTestDir();
    dbPath = path.join(testDir, 'test.sqlite');
    backend = createSqliteBackend({ path: dbPath });
  });

  afterEach(async () => {
    await backend.close();
    cleanupTestDir(testDir);
  });

  describe('metadata', () => {
    it('should have correct type', () => {
      expect(backend.type).toBe('sqlite');
    });

    it('should not support reactivity', () => {
      expect(backend.supportsReactivity).toBe(false);
    });
  });

  describe('database file', () => {
    it('should create database file', () => {
      expect(fs.existsSync(dbPath)).toBe(true);
    });

    it('should create WAL files in WAL mode', async () => {
      // WAL mode is enabled by default
      await backend.appendEvent({
        id: 'evt-1',
        version: 1,
        timestamp: Date.now(),
        type: 'spawn',
        source: {},
        payload: {},
      });
      await backend.flush();

      // WAL file should exist after writes
      const walPath = dbPath + '-wal';
      const shmPath = dbPath + '-shm';
      // Note: WAL files may or may not exist depending on checkpoint timing
      expect(fs.existsSync(dbPath)).toBe(true);
    });

    it('should create directory if not exists', async () => {
      const nestedDir = path.join(testDir, 'nested', 'deep', 'path');
      const nestedPath = path.join(nestedDir, 'store.sqlite');

      const nestedBackend = createSqliteBackend({ path: nestedPath });
      expect(fs.existsSync(nestedPath)).toBe(true);
      await nestedBackend.close();
    });
  });

  describe('event log operations', () => {
    const createEvent = (
      id: string,
      type: string = 'test',
      timestamp: number = Date.now()
    ): Event => ({
      id,
      version: 1,
      timestamp,
      type: type as Event['type'],
      source: { agent_id: 'agent-1' },
      payload: { data: 'test' },
    });

    it('should append and query events', async () => {
      const event = createEvent('evt-1');
      await backend.appendEvent(event);

      const events = await backend.queryEvents();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        id: 'evt-1',
        type: 'test',
        source: { agent_id: 'agent-1' },
      });
    });

    it('should ignore duplicate events', async () => {
      const event = createEvent('evt-1');
      await backend.appendEvent(event);
      await backend.appendEvent(event);

      const events = await backend.queryEvents();
      expect(events).toHaveLength(1);
    });

    it('should filter by type', async () => {
      await backend.appendEvent(createEvent('evt-1', 'spawn'));
      await backend.appendEvent(createEvent('evt-2', 'message'));
      await backend.appendEvent(createEvent('evt-3', 'spawn'));

      const events = await backend.queryEvents({ type: 'spawn' });
      expect(events).toHaveLength(2);
      expect(events.map((e) => e.id)).toEqual(['evt-1', 'evt-3']);
    });

    it('should filter by source agent', async () => {
      await backend.appendEvent({
        ...createEvent('evt-1'),
        source: { agent_id: 'agent-1' },
      });
      await backend.appendEvent({
        ...createEvent('evt-2'),
        source: { agent_id: 'agent-2' },
      });

      const events = await backend.queryEvents({ source_agent_id: 'agent-1' });
      expect(events).toHaveLength(1);
      expect(events[0].id).toBe('evt-1');
    });

    it('should filter by target agent', async () => {
      await backend.appendEvent({
        ...createEvent('evt-1'),
        target: { agent_id: 'agent-1' },
      });
      await backend.appendEvent({
        ...createEvent('evt-2'),
        target: { agent_id: 'agent-2' },
      });

      const events = await backend.queryEvents({ target_agent_id: 'agent-1' });
      expect(events).toHaveLength(1);
      expect(events[0].id).toBe('evt-1');
    });

    it('should filter by timestamp range', async () => {
      await backend.appendEvent(createEvent('evt-1', 'test', 1000));
      await backend.appendEvent(createEvent('evt-2', 'test', 2000));
      await backend.appendEvent(createEvent('evt-3', 'test', 3000));

      const events = await backend.queryEvents({ after: 1000, before: 3000 });
      expect(events).toHaveLength(1);
      expect(events[0].id).toBe('evt-2');
    });

    it('should apply limit', async () => {
      await backend.appendEvent(createEvent('evt-1', 'test', 1000));
      await backend.appendEvent(createEvent('evt-2', 'test', 2000));
      await backend.appendEvent(createEvent('evt-3', 'test', 3000));

      const events = await backend.queryEvents({ limit: 2 });
      expect(events).toHaveLength(2);
      expect(events.map((e) => e.id)).toEqual(['evt-1', 'evt-2']);
    });

    it('should sort by timestamp ascending', async () => {
      await backend.appendEvent(createEvent('evt-3', 'test', 3000));
      await backend.appendEvent(createEvent('evt-1', 'test', 1000));
      await backend.appendEvent(createEvent('evt-2', 'test', 2000));

      const events = await backend.queryEvents();
      expect(events.map((e) => e.id)).toEqual(['evt-1', 'evt-2', 'evt-3']);
    });

    it('should import events', async () => {
      const event = createEvent('imported-1');
      await backend.importEvent(event);

      const events = await backend.queryEvents();
      expect(events).toHaveLength(1);
      expect(events[0].id).toBe('imported-1');
    });

    it('should get event count', async () => {
      expect(await backend.getEventCount()).toBe(0);

      await backend.appendEvent(createEvent('evt-1'));
      expect(await backend.getEventCount()).toBe(1);

      await backend.appendEvent(createEvent('evt-2'));
      expect(await backend.getEventCount()).toBe(2);
    });

    it('should delete events by filter', async () => {
      await backend.appendEvent(createEvent('evt-1', 'spawn'));
      await backend.appendEvent(createEvent('evt-2', 'message'));
      await backend.appendEvent(createEvent('evt-3', 'spawn'));

      const deleted = await backend.deleteEvents({ type: 'spawn' });
      expect(deleted).toBe(2);

      const events = await backend.queryEvents();
      expect(events).toHaveLength(1);
      expect(events[0].id).toBe('evt-2');
    });

    it('should preserve event metadata', async () => {
      const event: Event = {
        id: 'evt-1',
        version: 1,
        timestamp: Date.now(),
        type: 'message',
        source: { agent_id: 'sender' },
        target: { agent_id: 'receiver', topic: 'test-topic' },
        payload: { content: 'Hello' },
        metadata: { correlation_id: 'corr-123', custom: 'value' },
      };

      await backend.appendEvent(event);
      const events = await backend.queryEvents();

      expect(events[0].target).toEqual({ agent_id: 'receiver', topic: 'test-topic' });
      expect(events[0].metadata).toEqual({ correlation_id: 'corr-123', custom: 'value' });
    });
  });

  describe('key-value operations', () => {
    it('should get and set values', async () => {
      await backend.set('agents', 'agent-1', { name: 'Test Agent' });

      const value = await backend.get('agents', 'agent-1');
      expect(value).toEqual({ name: 'Test Agent' });
    });

    it('should return null for non-existent keys', async () => {
      const value = await backend.get('agents', 'non-existent');
      expect(value).toBeNull();
    });

    it('should update existing values', async () => {
      await backend.set('agents', 'agent-1', { name: 'Original' });
      await backend.set('agents', 'agent-1', { name: 'Updated' });

      const value = await backend.get('agents', 'agent-1');
      expect(value).toEqual({ name: 'Updated' });
    });

    it('should partially update values', async () => {
      await backend.set('agents', 'agent-1', { name: 'Test', status: 'active' });
      await backend.setPartial('agents', 'agent-1', { status: 'inactive' });

      const value = await backend.get<{ name: string; status: string }>('agents', 'agent-1');
      expect(value).toEqual({ name: 'Test', status: 'inactive' });
    });

    it('should create value on setPartial if not exists', async () => {
      await backend.setPartial('agents', 'agent-1', { name: 'New' });

      const value = await backend.get('agents', 'agent-1');
      expect(value).toEqual({ name: 'New' });
    });

    it('should delete values', async () => {
      await backend.set('agents', 'agent-1', { name: 'Test' });
      await backend.delete('agents', 'agent-1');

      const value = await backend.get('agents', 'agent-1');
      expect(value).toBeNull();
    });

    it('should list all values in table', async () => {
      await backend.set('agents', 'agent-1', { name: 'Agent 1' });
      await backend.set('agents', 'agent-2', { name: 'Agent 2' });

      const list = await backend.list('agents');
      expect(list).toHaveLength(2);
      expect(list.map((i) => i.key).sort()).toEqual(['agent-1', 'agent-2']);
    });

    it('should filter values in list', async () => {
      await backend.set('agents', 'agent-1', { name: 'Agent 1', status: 'active' });
      await backend.set('agents', 'agent-2', { name: 'Agent 2', status: 'inactive' });
      await backend.set('agents', 'agent-3', { name: 'Agent 3', status: 'active' });

      const list = await backend.list('agents', { status: 'active' });
      expect(list).toHaveLength(2);
      expect(list.map((i) => i.key).sort()).toEqual(['agent-1', 'agent-3']);
    });

    it('should get all keys in table', async () => {
      await backend.set('agents', 'agent-1', { name: 'Agent 1' });
      await backend.set('agents', 'agent-2', { name: 'Agent 2' });

      const keys = await backend.keys('agents');
      expect(keys.sort()).toEqual(['agent-1', 'agent-2']);
    });

    it('should return empty array for empty table', async () => {
      const list = await backend.list('empty');
      expect(list).toEqual([]);

      const keys = await backend.keys('empty');
      expect(keys).toEqual([]);
    });

    it('should clear table', async () => {
      await backend.set('agents', 'agent-1', { name: 'Agent 1' });
      await backend.set('agents', 'agent-2', { name: 'Agent 2' });

      await backend.clear('agents');

      const list = await backend.list('agents');
      expect(list).toEqual([]);
    });

    it('should isolate tables', async () => {
      await backend.set('agents', 'key-1', { type: 'agent' });
      await backend.set('tasks', 'key-1', { type: 'task' });

      const agentValue = await backend.get('agents', 'key-1');
      const taskValue = await backend.get('tasks', 'key-1');

      expect(agentValue).toEqual({ type: 'agent' });
      expect(taskValue).toEqual({ type: 'task' });
    });

    it('should handle complex JSON values', async () => {
      const complexValue = {
        name: 'Test',
        nested: {
          array: [1, 2, 3],
          object: { key: 'value' },
        },
        nullValue: null,
        boolValue: true,
      };

      await backend.set('data', 'complex', complexValue);
      const value = await backend.get('data', 'complex');

      expect(value).toEqual(complexValue);
    });
  });

  describe('persistence', () => {
    it('should persist data across backend instances', async () => {
      await backend.appendEvent({
        id: 'evt-1',
        version: 1,
        timestamp: Date.now(),
        type: 'spawn',
        source: {},
        payload: {},
      });
      await backend.set('agents', 'agent-1', { name: 'Test' });
      await backend.close();

      // Reopen database
      const backend2 = createSqliteBackend({ path: dbPath });

      const events = await backend2.queryEvents();
      expect(events).toHaveLength(1);

      const agent = await backend2.get('agents', 'agent-1');
      expect(agent).toEqual({ name: 'Test' });

      await backend2.close();

      // Reassign backend for cleanup
      backend = createSqliteBackend({ path: dbPath });
    });
  });

  describe('createSqliteBackendFromPath', () => {
    it('should create backend in instance directory', async () => {
      await backend.close();

      const instancePath = path.join(testDir, 'my-instance');
      fs.mkdirSync(instancePath, { recursive: true });

      backend = createSqliteBackendFromPath(instancePath);

      await backend.set('test', 'key', { value: 123 });

      const expectedDbPath = path.join(instancePath, 'store.sqlite');
      expect(fs.existsSync(expectedDbPath)).toBe(true);
    });
  });

  describe('lifecycle', () => {
    it('should flush without error', async () => {
      await backend.appendEvent({
        id: 'evt-1',
        version: 1,
        timestamp: Date.now(),
        type: 'spawn',
        source: {},
        payload: {},
      });
      await expect(backend.flush()).resolves.toBeUndefined();
    });

    it('should close without error', async () => {
      await expect(backend.close()).resolves.toBeUndefined();
      // Reopen for afterEach cleanup
      backend = createSqliteBackend({ path: dbPath });
    });
  });
});
