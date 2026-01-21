/**
 * Tests for Memory Storage Backend
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createMemoryBackend } from '../memory-backend.js';
import type { StorageBackend } from '../types.js';
import type { Event } from '../../types/index.js';

describe('Memory Backend', () => {
  let backend: StorageBackend;

  beforeEach(() => {
    backend = createMemoryBackend();
  });

  describe('metadata', () => {
    it('should have correct type', () => {
      expect(backend.type).toBe('memory');
    });

    it('should support reactivity', () => {
      expect(backend.supportsReactivity).toBe(true);
    });
  });

  describe('event log operations', () => {
    const createEvent = (id: string, type: string = 'test', timestamp: number = Date.now()): Event => ({
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
      expect(events[0]).toEqual(event);
    });

    it('should skip duplicate events', async () => {
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
      expect(events.map(e => e.id)).toEqual(['evt-1', 'evt-3']);
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
      expect(events.map(e => e.id)).toEqual(['evt-1', 'evt-2']);
    });

    it('should sort by timestamp ascending', async () => {
      await backend.appendEvent(createEvent('evt-3', 'test', 3000));
      await backend.appendEvent(createEvent('evt-1', 'test', 1000));
      await backend.appendEvent(createEvent('evt-2', 'test', 2000));

      const events = await backend.queryEvents();
      expect(events.map(e => e.id)).toEqual(['evt-1', 'evt-2', 'evt-3']);
    });

    it('should import events', async () => {
      const event = createEvent('imported-1');
      await backend.importEvent(event);

      const events = await backend.queryEvents();
      expect(events).toHaveLength(1);
      expect(events[0].id).toBe('imported-1');
    });

    it('should skip importing duplicate events', async () => {
      const event = createEvent('evt-1');
      await backend.appendEvent(event);
      await backend.importEvent(event);

      const events = await backend.queryEvents();
      expect(events).toHaveLength(1);
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
      expect(list.map(i => i.key).sort()).toEqual(['agent-1', 'agent-2']);
    });

    it('should filter values in list', async () => {
      await backend.set('agents', 'agent-1', { name: 'Agent 1', status: 'active' });
      await backend.set('agents', 'agent-2', { name: 'Agent 2', status: 'inactive' });
      await backend.set('agents', 'agent-3', { name: 'Agent 3', status: 'active' });

      const list = await backend.list('agents', { status: 'active' });
      expect(list).toHaveLength(2);
      expect(list.map(i => i.key).sort()).toEqual(['agent-1', 'agent-3']);
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
  });

  describe('reactivity', () => {
    it('should notify on set', async () => {
      const changes: Array<{ key: string; value: unknown }> = [];

      backend.onChange!('agents', (key, value) => {
        changes.push({ key, value });
      });

      await backend.set('agents', 'agent-1', { name: 'Test' });

      expect(changes).toHaveLength(1);
      expect(changes[0]).toEqual({
        key: 'agent-1',
        value: { name: 'Test' },
      });
    });

    it('should notify on setPartial', async () => {
      const changes: Array<{ key: string; value: unknown }> = [];

      await backend.set('agents', 'agent-1', { name: 'Test', status: 'active' });

      backend.onChange!('agents', (key, value) => {
        changes.push({ key, value });
      });

      await backend.setPartial('agents', 'agent-1', { status: 'inactive' });

      expect(changes).toHaveLength(1);
      expect(changes[0].value).toEqual({ name: 'Test', status: 'inactive' });
    });

    it('should notify on delete with null value', async () => {
      const changes: Array<{ key: string; value: unknown | null }> = [];

      await backend.set('agents', 'agent-1', { name: 'Test' });

      backend.onChange!('agents', (key, value) => {
        changes.push({ key, value });
      });

      await backend.delete('agents', 'agent-1');

      expect(changes).toHaveLength(1);
      expect(changes[0]).toEqual({ key: 'agent-1', value: null });
    });

    it('should notify on clear with null for each key', async () => {
      const changes: Array<{ key: string; value: unknown | null }> = [];

      await backend.set('agents', 'agent-1', { name: 'Test 1' });
      await backend.set('agents', 'agent-2', { name: 'Test 2' });

      backend.onChange!('agents', (key, value) => {
        changes.push({ key, value });
      });

      await backend.clear('agents');

      expect(changes).toHaveLength(2);
      expect(changes.every(c => c.value === null)).toBe(true);
    });

    it('should unsubscribe', async () => {
      const changes: Array<{ key: string; value: unknown }> = [];

      const unsubscribe = backend.onChange!('agents', (key, value) => {
        changes.push({ key, value });
      });

      await backend.set('agents', 'agent-1', { name: 'Test 1' });
      expect(changes).toHaveLength(1);

      unsubscribe();

      await backend.set('agents', 'agent-2', { name: 'Test 2' });
      expect(changes).toHaveLength(1); // No new change
    });

    it('should only notify for subscribed table', async () => {
      const changes: Array<{ key: string; value: unknown }> = [];

      backend.onChange!('agents', (key, value) => {
        changes.push({ key, value });
      });

      await backend.set('tasks', 'task-1', { name: 'Test' });
      expect(changes).toHaveLength(0);

      await backend.set('agents', 'agent-1', { name: 'Test' });
      expect(changes).toHaveLength(1);
    });
  });

  describe('lifecycle', () => {
    it('should flush without error', async () => {
      await expect(backend.flush()).resolves.toBeUndefined();
    });

    it('should close and clear all data', async () => {
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

      expect(await backend.getEventCount()).toBe(0);
      expect(await backend.list('agents')).toEqual([]);
    });
  });
});
