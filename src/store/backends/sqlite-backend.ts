/**
 * SQLite Storage Backend
 *
 * Default storage backend using better-sqlite3 for persistence.
 * Provides file locking, ACID transactions, and good query performance.
 */

import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import type { Event, EventFilter } from '../types/index.js';
import type { StorageBackend } from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────────────────────────────────────

const SCHEMA_SQL = `
-- Event log (source of truth)
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  type TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  source TEXT NOT NULL,
  target TEXT,
  payload TEXT NOT NULL,
  metadata TEXT
);

CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);
CREATE INDEX IF NOT EXISTS idx_events_source_agent ON events(json_extract(source, '$.agent_id'));

-- Key-value tables (for materialized views)
CREATE TABLE IF NOT EXISTS kv_store (
  table_name TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (table_name, key)
);

CREATE INDEX IF NOT EXISTS idx_kv_table ON kv_store(table_name);
`;

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

export interface SqliteBackendOptions {
  /** Database file path */
  path: string;

  /** Enable WAL mode for better concurrency (default: true) */
  walMode?: boolean;

  /** Busy timeout in ms (default: 5000) */
  busyTimeout?: number;

  /** Enable foreign keys (default: false) */
  foreignKeys?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Implementation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a SQLite storage backend
 */
export function createSqliteBackend(options: SqliteBackendOptions): StorageBackend {
  // Ensure directory exists
  const dbDir = path.dirname(options.path);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  // Open database
  const db = new Database(options.path);

  // Configure database
  if (options.walMode !== false) {
    db.pragma('journal_mode = WAL');
  }
  db.pragma(`busy_timeout = ${options.busyTimeout ?? 5000}`);
  if (options.foreignKeys) {
    db.pragma('foreign_keys = ON');
  }

  // Initialize schema
  db.exec(SCHEMA_SQL);

  // Prepare statements for better performance
  const stmts = {
    // Event operations
    insertEvent: db.prepare(`
      INSERT OR IGNORE INTO events (id, version, type, timestamp, source, target, payload, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `),
    countEvents: db.prepare('SELECT COUNT(*) as count FROM events'),
    deleteEvent: db.prepare('DELETE FROM events WHERE id = ?'),

    // KV operations
    getKV: db.prepare('SELECT value FROM kv_store WHERE table_name = ? AND key = ?'),
    setKV: db.prepare(`
      INSERT INTO kv_store (table_name, key, value)
      VALUES (?, ?, ?)
      ON CONFLICT(table_name, key) DO UPDATE SET value = excluded.value
    `),
    deleteKV: db.prepare('DELETE FROM kv_store WHERE table_name = ? AND key = ?'),
    listKV: db.prepare('SELECT key, value FROM kv_store WHERE table_name = ?'),
    keysKV: db.prepare('SELECT key FROM kv_store WHERE table_name = ?'),
    clearKV: db.prepare('DELETE FROM kv_store WHERE table_name = ?'),
  };

  /**
   * Parse an event row from the database
   */
  function parseEventRow(row: {
    id: string;
    version: number;
    type: string;
    timestamp: number;
    source: string;
    target: string | null;
    payload: string;
    metadata: string | null;
  }): Event {
    return {
      id: row.id,
      version: row.version,
      type: row.type as Event['type'],
      timestamp: row.timestamp,
      source: JSON.parse(row.source),
      target: row.target ? JSON.parse(row.target) : undefined,
      payload: JSON.parse(row.payload),
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    };
  }

  /**
   * Build WHERE clause for event filtering
   */
  function buildEventFilter(filter?: EventFilter): { sql: string; params: unknown[] } {
    const conditions: string[] = ['1=1'];
    const params: unknown[] = [];

    if (filter?.type) {
      conditions.push('type = ?');
      params.push(filter.type);
    }

    if (filter?.source_agent_id) {
      conditions.push("json_extract(source, '$.agent_id') = ?");
      params.push(filter.source_agent_id);
    }

    if (filter?.target_agent_id) {
      conditions.push("json_extract(target, '$.agent_id') = ?");
      params.push(filter.target_agent_id);
    }

    if (filter?.after !== undefined) {
      conditions.push('timestamp > ?');
      params.push(filter.after);
    }

    if (filter?.before !== undefined) {
      conditions.push('timestamp < ?');
      params.push(filter.before);
    }

    return { sql: conditions.join(' AND '), params };
  }

  const backend: StorageBackend = {
    type: 'sqlite',
    supportsReactivity: false,

    // ─────────────────────────────────────────────────────────────────────────
    // Event Log Operations
    // ─────────────────────────────────────────────────────────────────────────

    async appendEvent(event: Event): Promise<void> {
      stmts.insertEvent.run(
        event.id,
        event.version,
        event.type,
        event.timestamp,
        JSON.stringify(event.source),
        event.target ? JSON.stringify(event.target) : null,
        JSON.stringify(event.payload),
        event.metadata ? JSON.stringify(event.metadata) : null
      );
    },

    async queryEvents(filter?: EventFilter): Promise<Event[]> {
      const { sql, params } = buildEventFilter(filter);
      let query = `SELECT * FROM events WHERE ${sql} ORDER BY timestamp ASC`;

      if (filter?.limit) {
        query += ` LIMIT ${filter.limit}`;
      }

      const stmt = db.prepare(query);
      const rows = stmt.all(...params) as Array<{
        id: string;
        version: number;
        type: string;
        timestamp: number;
        source: string;
        target: string | null;
        payload: string;
        metadata: string | null;
      }>;

      return rows.map(parseEventRow);
    },

    async importEvent(event: Event): Promise<void> {
      // Same as append - OR IGNORE handles duplicates
      stmts.insertEvent.run(
        event.id,
        event.version,
        event.type,
        event.timestamp,
        JSON.stringify(event.source),
        event.target ? JSON.stringify(event.target) : null,
        JSON.stringify(event.payload),
        event.metadata ? JSON.stringify(event.metadata) : null
      );
    },

    async getEventCount(): Promise<number> {
      const row = stmts.countEvents.get() as { count: number };
      return row.count;
    },

    async deleteEvents(filter: EventFilter): Promise<number> {
      const { sql, params } = buildEventFilter(filter);
      const stmt = db.prepare(`DELETE FROM events WHERE ${sql}`);
      const result = stmt.run(...params);
      return result.changes;
    },

    // ─────────────────────────────────────────────────────────────────────────
    // Key-Value Operations
    // ─────────────────────────────────────────────────────────────────────────

    async get<T = unknown>(table: string, key: string): Promise<T | null> {
      const row = stmts.getKV.get(table, key) as { value: string } | undefined;
      if (!row) return null;
      return JSON.parse(row.value) as T;
    },

    async set<T = unknown>(table: string, key: string, value: T): Promise<void> {
      stmts.setKV.run(table, key, JSON.stringify(value));
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
      stmts.deleteKV.run(table, key);
    },

    async list<T = unknown>(
      table: string,
      filter?: Record<string, unknown>
    ): Promise<Array<{ key: string; value: T }>> {
      const rows = stmts.listKV.all(table) as Array<{ key: string; value: string }>;

      const results: Array<{ key: string; value: T }> = [];

      for (const row of rows) {
        const value = JSON.parse(row.value) as T;

        // Apply filter if provided
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

        results.push({ key: row.key, value });
      }

      return results;
    },

    async keys(table: string): Promise<string[]> {
      const rows = stmts.keysKV.all(table) as Array<{ key: string }>;
      return rows.map((r) => r.key);
    },

    async clear(table: string): Promise<void> {
      stmts.clearKV.run(table);
    },

    // ─────────────────────────────────────────────────────────────────────────
    // Lifecycle
    // ─────────────────────────────────────────────────────────────────────────

    async flush(): Promise<void> {
      // SQLite writes are synchronous, so no-op
      // But we can checkpoint the WAL
      db.pragma('wal_checkpoint(PASSIVE)');
    },

    async close(): Promise<void> {
      db.close();
    },
  };

  return backend;
}

/**
 * Create a SQLite backend from an instance path
 * Convenience function that creates the database in the instance directory
 */
export function createSqliteBackendFromPath(instancePath: string): StorageBackend {
  const dbPath = path.join(instancePath, 'store.sqlite');
  return createSqliteBackend({ path: dbPath });
}
