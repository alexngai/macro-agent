/**
 * Event Migration Tests
 */

import { describe, it, expect } from 'vitest';
import { migrateEvent, needsMigration, getCurrentVersion } from '../migrations.js';
import { CURRENT_EVENT_VERSION } from '../types/events.js';

describe('Event Migrations', () => {
  describe('getCurrentVersion', () => {
    it('should return the current event version', () => {
      expect(getCurrentVersion()).toBe(CURRENT_EVENT_VERSION);
      expect(getCurrentVersion()).toBe(1);
    });
  });

  describe('needsMigration', () => {
    it('should return true for events without version', () => {
      const event = {
        id: 'evt_123',
        timestamp: Date.now(),
        type: 'spawn',
        source: {},
        payload: {},
      };
      expect(needsMigration(event)).toBe(true);
    });

    it('should return true for events with old version', () => {
      const event = {
        id: 'evt_123',
        version: 0,
        timestamp: Date.now(),
        type: 'spawn',
        source: {},
        payload: {},
      };
      expect(needsMigration(event)).toBe(true);
    });

    it('should return false for events at current version', () => {
      const event = {
        id: 'evt_123',
        version: CURRENT_EVENT_VERSION,
        timestamp: Date.now(),
        type: 'spawn',
        source: {},
        payload: {},
      };
      expect(needsMigration(event)).toBe(false);
    });
  });

  describe('migrateEvent', () => {
    it('should migrate unversioned event to v1', () => {
      const rawEvent = {
        id: 'evt_123',
        timestamp: 1234567890,
        type: 'spawn',
        source: { agent_id: 'agent_1' },
        payload: { task: 'do work' },
      };

      const migrated = migrateEvent(rawEvent);

      expect(migrated.version).toBe(1);
      expect(migrated.id).toBe('evt_123');
      expect(migrated.timestamp).toBe(1234567890);
      expect(migrated.type).toBe('spawn');
      expect(migrated.source.agent_id).toBe('agent_1');
    });

    it('should not modify events already at current version', () => {
      const event = {
        id: 'evt_456',
        version: CURRENT_EVENT_VERSION,
        timestamp: 1234567890,
        type: 'status',
        source: { agent_id: 'agent_1' },
        payload: { status_type: 'started' },
      };

      const migrated = migrateEvent(event);

      expect(migrated).toEqual(event);
    });

    it('should preserve all event fields during migration', () => {
      const rawEvent = {
        id: 'evt_789',
        timestamp: 1234567890,
        type: 'message',
        source: { agent_id: 'sender', task_id: 'task_1' },
        target: { agent_id: 'recipient', topic: 'updates' },
        payload: { content: 'Hello world' },
        metadata: { correlation_id: 'corr_123', ttl: 3600 },
      };

      const migrated = migrateEvent(rawEvent);

      expect(migrated.version).toBe(1);
      expect(migrated.id).toBe('evt_789');
      expect(migrated.source).toEqual({ agent_id: 'sender', task_id: 'task_1' });
      expect(migrated.target).toEqual({ agent_id: 'recipient', topic: 'updates' });
      expect(migrated.payload).toEqual({ content: 'Hello world' });
      expect(migrated.metadata).toEqual({ correlation_id: 'corr_123', ttl: 3600 });
    });
  });
});
