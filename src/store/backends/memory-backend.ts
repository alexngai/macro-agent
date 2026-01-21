/**
 * In-Memory Storage Backend
 *
 * A simple in-memory implementation of StorageBackend for testing.
 * Data is not persisted and is lost when the process exits.
 */

import type { Event, EventFilter } from '../types/index.js';
import type { StorageBackend } from './types.js';

/**
 * Match an event against a filter
 */
function matchesFilter(event: Event, filter?: EventFilter): boolean {
  if (!filter) return true;

  if (filter.type && event.type !== filter.type) return false;
  if (filter.source_agent_id && event.source.agent_id !== filter.source_agent_id)
    return false;
  if (filter.target_agent_id && event.target?.agent_id !== filter.target_agent_id)
    return false;
  if (filter.after && event.timestamp <= filter.after) return false;
  if (filter.before && event.timestamp >= filter.before) return false;

  return true;
}

/**
 * Match a value against a filter (equality matching)
 */
function matchesValueFilter(
  value: unknown,
  filter?: Record<string, unknown>
): boolean {
  if (!filter) return true;
  if (typeof value !== 'object' || value === null) return false;

  const obj = value as Record<string, unknown>;
  for (const [key, filterValue] of Object.entries(filter)) {
    if (obj[key] !== filterValue) return false;
  }

  return true;
}

/**
 * Create an in-memory storage backend
 */
export function createMemoryBackend(): StorageBackend {
  // Event log
  const events: Event[] = [];
  const eventIds = new Set<string>();

  // Key-value tables
  const tables = new Map<string, Map<string, unknown>>();

  // Change listeners
  const listeners = new Map<string, Set<(key: string, value: unknown | null) => void>>();

  /**
   * Get or create a table
   */
  function getTable(tableName: string): Map<string, unknown> {
    let table = tables.get(tableName);
    if (!table) {
      table = new Map();
      tables.set(tableName, table);
    }
    return table;
  }

  /**
   * Notify listeners of a change
   */
  function notifyChange(table: string, key: string, value: unknown | null): void {
    const tableListeners = listeners.get(table);
    if (tableListeners) {
      for (const callback of tableListeners) {
        callback(key, value);
      }
    }
  }

  const backend: StorageBackend = {
    type: 'memory',
    supportsReactivity: true,

    // ─────────────────────────────────────────────────────────────────────────
    // Event Log Operations
    // ─────────────────────────────────────────────────────────────────────────

    async appendEvent(event: Event): Promise<void> {
      if (eventIds.has(event.id)) {
        // Skip duplicate
        return;
      }
      events.push(event);
      eventIds.add(event.id);
    },

    async queryEvents(filter?: EventFilter): Promise<Event[]> {
      let result = events.filter((e) => matchesFilter(e, filter));

      // Sort by timestamp ascending
      result.sort((a, b) => a.timestamp - b.timestamp);

      // Apply limit
      if (filter?.limit) {
        result = result.slice(0, filter.limit);
      }

      return result;
    },

    async importEvent(event: Event): Promise<void> {
      // Same as append - skip if exists
      if (eventIds.has(event.id)) {
        return;
      }
      events.push(event);
      eventIds.add(event.id);
    },

    async getEventCount(): Promise<number> {
      return events.length;
    },

    async deleteEvents(filter: EventFilter): Promise<number> {
      const toDelete = events.filter((e) => matchesFilter(e, filter));
      const deleteIds = new Set(toDelete.map((e) => e.id));

      // Remove from events array
      let i = events.length;
      while (i--) {
        if (deleteIds.has(events[i].id)) {
          events.splice(i, 1);
        }
      }

      // Remove from ID set
      for (const id of deleteIds) {
        eventIds.delete(id);
      }

      return deleteIds.size;
    },

    // ─────────────────────────────────────────────────────────────────────────
    // Key-Value Operations
    // ─────────────────────────────────────────────────────────────────────────

    async get<T = unknown>(table: string, key: string): Promise<T | null> {
      const t = getTable(table);
      const value = t.get(key);
      return value === undefined ? null : (value as T);
    },

    async set<T = unknown>(table: string, key: string, value: T): Promise<void> {
      const t = getTable(table);
      t.set(key, value);
      notifyChange(table, key, value);
    },

    async setPartial<T = unknown>(
      table: string,
      key: string,
      partial: Partial<T>
    ): Promise<void> {
      const t = getTable(table);
      const existing = t.get(key) as T | undefined;
      const merged = existing ? { ...existing, ...partial } : partial;
      t.set(key, merged);
      notifyChange(table, key, merged);
    },

    async delete(table: string, key: string): Promise<void> {
      const t = getTable(table);
      t.delete(key);
      notifyChange(table, key, null);
    },

    async list<T = unknown>(
      table: string,
      filter?: Record<string, unknown>
    ): Promise<Array<{ key: string; value: T }>> {
      const t = getTable(table);
      const result: Array<{ key: string; value: T }> = [];

      for (const [key, value] of t.entries()) {
        if (matchesValueFilter(value, filter)) {
          result.push({ key, value: value as T });
        }
      }

      return result;
    },

    async keys(table: string): Promise<string[]> {
      const t = getTable(table);
      return Array.from(t.keys());
    },

    async clear(table: string): Promise<void> {
      const t = getTable(table);
      const keys = Array.from(t.keys());
      t.clear();

      // Notify all deletions
      for (const key of keys) {
        notifyChange(table, key, null);
      }
    },

    // ─────────────────────────────────────────────────────────────────────────
    // Reactivity
    // ─────────────────────────────────────────────────────────────────────────

    onChange(
      table: string,
      callback: (key: string, value: unknown | null) => void
    ): () => void {
      let tableListeners = listeners.get(table);
      if (!tableListeners) {
        tableListeners = new Set();
        listeners.set(table, tableListeners);
      }

      tableListeners.add(callback);

      return () => {
        tableListeners!.delete(callback);
        if (tableListeners!.size === 0) {
          listeners.delete(table);
        }
      };
    },

    // ─────────────────────────────────────────────────────────────────────────
    // Lifecycle
    // ─────────────────────────────────────────────────────────────────────────

    async flush(): Promise<void> {
      // No-op for memory backend
    },

    async close(): Promise<void> {
      // Clear all data
      events.length = 0;
      eventIds.clear();
      tables.clear();
      listeners.clear();
    },
  };

  return backend;
}
