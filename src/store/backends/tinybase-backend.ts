/**
 * TinyBase Storage Backend
 *
 * Wraps a TinyBase Store as a StorageBackend interface.
 * Useful for exposing internal TinyBase stores or wrapping custom persisters.
 */

import type { Store } from 'tinybase';
import type { Event, EventFilter } from '../types/index.js';
import type { StorageBackend } from './types.js';

/**
 * Options for creating a TinyBase backend
 */
export interface TinyBaseBackendOptions {
  /** Optional flush callback (called on flush/close) */
  onFlush?: () => Promise<void>;
  /** Optional close callback */
  onClose?: () => Promise<void>;
}

/**
 * Create a StorageBackend wrapper around a TinyBase Store
 */
export function createTinyBaseBackend(
  store: Store,
  options?: TinyBaseBackendOptions
): StorageBackend {
  // Change listeners for reactivity
  const listeners = new Map<
    string,
    Set<(key: string, value: unknown | null) => void>
  >();

  /**
   * Notify listeners of a change
   */
  function notifyChange(
    table: string,
    key: string,
    value: unknown | null
  ): void {
    const tableListeners = listeners.get(table);
    if (tableListeners) {
      for (const callback of tableListeners) {
        callback(key, value);
      }
    }
  }

  /**
   * Parse an event from a TinyBase row
   */
  function parseEventRow(row: Record<string, unknown>): Event {
    return {
      id: row.id as string,
      version: (row.version as number) ?? 1,
      timestamp: row.timestamp as number,
      type: row.type as Event['type'],
      source: JSON.parse(row.source as string),
      target: row.target ? JSON.parse(row.target as string) : undefined,
      payload: JSON.parse(row.payload as string),
      metadata: row.metadata ? JSON.parse(row.metadata as string) : undefined,
    };
  }

  /**
   * Match an event against a filter
   */
  function matchesFilter(event: Event, filter?: EventFilter): boolean {
    if (!filter) return true;

    if (filter.type && event.type !== filter.type) return false;
    if (
      filter.source_agent_id &&
      event.source.agent_id !== filter.source_agent_id
    )
      return false;
    if (
      filter.target_agent_id &&
      event.target?.agent_id !== filter.target_agent_id
    )
      return false;
    if (filter.after && event.timestamp <= filter.after) return false;
    if (filter.before && event.timestamp >= filter.before) return false;

    return true;
  }

  const backend: StorageBackend = {
    type: 'tinybase',
    supportsReactivity: true,

    // ─────────────────────────────────────────────────────────────────────────
    // Event Log Operations
    // ─────────────────────────────────────────────────────────────────────────

    async appendEvent(event: Event): Promise<void> {
      // Check for duplicate
      const existing = store.getRow('events', event.id);
      if (existing.id) return;

      store.setRow('events', event.id, {
        id: event.id,
        version: event.version,
        timestamp: event.timestamp,
        type: event.type,
        source: JSON.stringify(event.source),
        target: event.target ? JSON.stringify(event.target) : '',
        payload: JSON.stringify(event.payload),
        metadata: event.metadata ? JSON.stringify(event.metadata) : '',
      });
    },

    async queryEvents(filter?: EventFilter): Promise<Event[]> {
      const events: Event[] = [];
      const rowIds = store.getRowIds('events');

      for (const rowId of rowIds) {
        const row = store.getRow('events', rowId);
        if (!row.id) continue;

        const event = parseEventRow(row);

        if (matchesFilter(event, filter)) {
          events.push(event);
        }
      }

      // Sort by timestamp ascending
      events.sort((a, b) => a.timestamp - b.timestamp);

      // Apply limit
      if (filter?.limit) {
        return events.slice(0, filter.limit);
      }

      return events;
    },

    async importEvent(event: Event): Promise<void> {
      await backend.appendEvent(event);
    },

    async getEventCount(): Promise<number> {
      return store.getRowIds('events').length;
    },

    async deleteEvents(filter: EventFilter): Promise<number> {
      const events = await backend.queryEvents(filter);
      for (const event of events) {
        store.delRow('events', event.id);
      }
      return events.length;
    },

    // ─────────────────────────────────────────────────────────────────────────
    // Key-Value Operations
    // ─────────────────────────────────────────────────────────────────────────

    async get<T = unknown>(table: string, key: string): Promise<T | null> {
      const row = store.getRow(table, key);
      if (!row._value) return null;
      return JSON.parse(row._value as string) as T;
    },

    async set<T = unknown>(
      table: string,
      key: string,
      value: T
    ): Promise<void> {
      store.setRow(table, key, { _value: JSON.stringify(value) });
      notifyChange(table, key, value);
    },

    async setPartial<T = unknown>(
      table: string,
      key: string,
      partial: Partial<T>
    ): Promise<void> {
      const existing = await backend.get<T>(table, key);
      const merged = existing ? { ...existing, ...partial } : partial;
      await backend.set(table, key, merged);
    },

    async delete(table: string, key: string): Promise<void> {
      store.delRow(table, key);
      notifyChange(table, key, null);
    },

    async list<T = unknown>(
      table: string,
      filter?: Record<string, unknown>
    ): Promise<Array<{ key: string; value: T }>> {
      const results: Array<{ key: string; value: T }> = [];
      const rowIds = store.getRowIds(table);

      for (const key of rowIds) {
        const row = store.getRow(table, key);
        if (!row._value) continue;

        const value = JSON.parse(row._value as string) as T;

        // Apply filter
        if (filter) {
          let matches = true;
          for (const [filterKey, filterValue] of Object.entries(filter)) {
            if ((value as Record<string, unknown>)[filterKey] !== filterValue) {
              matches = false;
              break;
            }
          }
          if (!matches) continue;
        }

        results.push({ key, value });
      }

      return results;
    },

    async keys(table: string): Promise<string[]> {
      return store.getRowIds(table);
    },

    async clear(table: string): Promise<void> {
      const keys = store.getRowIds(table);
      for (const key of keys) {
        store.delRow(table, key);
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
      if (options?.onFlush) {
        await options.onFlush();
      }
    },

    async close(): Promise<void> {
      if (options?.onClose) {
        await options.onClose();
      }
    },
  };

  return backend;
}
