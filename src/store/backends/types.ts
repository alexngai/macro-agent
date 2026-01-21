/**
 * Storage Backend Interface
 *
 * Abstract interface for pluggable storage backends.
 * Separates event log operations (append-only) from
 * materialized view operations (key-value).
 */

import type { Event, EventFilter } from '../types/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Standard Table Names
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Standard table names used by the EventStore
 */
export const STORAGE_TABLES = {
  /** Append-only event log */
  EVENTS: 'events',
  /** Materialized agent state */
  AGENTS: 'agents',
  /** Materialized task state */
  TASKS: 'tasks',
  /** Per-agent message queues */
  MESSAGES: 'messages',
  /** Pub/sub subscriptions */
  SUBSCRIPTIONS: 'subscriptions',
  /** Instance metadata */
  META: 'meta',
} as const;

export type StorageTable = (typeof STORAGE_TABLES)[keyof typeof STORAGE_TABLES];

// ─────────────────────────────────────────────────────────────────────────────
// Storage Backend Interface
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Abstract storage backend interface.
 *
 * Implementations must be:
 * - Thread-safe: Handle concurrent reads/writes safely
 * - Atomic: Set operations should be atomic
 * - Durable: flush() must ensure data is persisted
 * - Query-capable: list() with filter must support basic equality matching
 */
export interface StorageBackend {
  // ─────────────────────────────────────────────────────────────────────────
  // Event Log (append-only, source of truth)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Append an event to the log.
   * The event should already have id, version, and timestamp set.
   */
  appendEvent(event: Event): Promise<void>;

  /**
   * Query events with optional filters.
   * Results are sorted by timestamp ascending.
   */
  queryEvents(filter?: EventFilter): Promise<Event[]>;

  /**
   * Import an event from another source (e.g., peer sync, migration).
   * Preserves the original event ID and timestamp.
   * Skips if event with same ID already exists.
   */
  importEvent(event: Event): Promise<void>;

  /**
   * Get total count of events in the log.
   */
  getEventCount(): Promise<number>;

  /**
   * Delete events matching the filter.
   * Used for archival operations.
   */
  deleteEvents(filter: EventFilter): Promise<number>;

  // ─────────────────────────────────────────────────────────────────────────
  // Key-Value Store (for materialized views)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Get a value by table and key.
   * Returns null if not found.
   */
  get<T = unknown>(table: string, key: string): Promise<T | null>;

  /**
   * Set a value. Creates or updates.
   */
  set<T = unknown>(table: string, key: string, value: T): Promise<void>;

  /**
   * Partially update a value. Merges with existing.
   */
  setPartial<T = unknown>(
    table: string,
    key: string,
    partial: Partial<T>
  ): Promise<void>;

  /**
   * Delete a value by table and key.
   */
  delete(table: string, key: string): Promise<void>;

  /**
   * List all values in a table, optionally filtered.
   * Filter uses equality matching on value properties.
   */
  list<T = unknown>(
    table: string,
    filter?: Record<string, unknown>
  ): Promise<Array<{ key: string; value: T }>>;

  /**
   * Get all keys in a table.
   */
  keys(table: string): Promise<string[]>;

  /**
   * Clear all values in a table.
   */
  clear(table: string): Promise<void>;

  // ─────────────────────────────────────────────────────────────────────────
  // Reactivity (optional, for TinyBase-backed implementations)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Subscribe to changes in a table.
   * Returns unsubscribe function.
   * Optional - implementations that don't support reactivity can return a no-op.
   */
  onChange?(
    table: string,
    callback: (key: string, value: unknown | null) => void
  ): () => void;

  // ─────────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Persist any pending changes to durable storage.
   */
  flush(): Promise<void>;

  /**
   * Close the backend and release resources.
   */
  close(): Promise<void>;

  // ─────────────────────────────────────────────────────────────────────────
  // Metadata
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Backend type identifier (e.g., 'sqlite', 'memory', 'json')
   */
  readonly type: string;

  /**
   * Whether the backend supports reactivity (onChange)
   */
  readonly supportsReactivity: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Backend Configuration
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Backend type identifiers
 */
export type BackendType = 'sqlite' | 'memory' | 'json' | 'custom';

/**
 * Configuration for creating a storage backend
 */
export interface StorageBackendConfig {
  /**
   * Backend type to use.
   * - 'sqlite': SQLite via better-sqlite3 (default)
   * - 'memory': In-memory (testing)
   * - 'json': JSON file (legacy compatibility)
   * - 'custom': Custom backend via factory
   */
  type: BackendType;

  /**
   * Backend-specific options.
   * Passed to the backend constructor.
   */
  options?: Record<string, unknown>;

  /**
   * Custom backend factory (required when type is 'custom').
   * Receives the instance path and should return a StorageBackend.
   */
  factory?: (instancePath: string) => StorageBackend | Promise<StorageBackend>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Backend Factory Type
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Factory function for creating storage backends
 */
export type StorageBackendFactory = (
  instancePath: string,
  options?: Record<string, unknown>
) => StorageBackend | Promise<StorageBackend>;

// ─────────────────────────────────────────────────────────────────────────────
// Event Export/Import Types (for sync)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Exported event format for peer sync.
 * Same as Event but explicitly typed for serialization.
 */
export interface ExportedEvent extends Event {
  /** Source instance ID that originally created this event */
  sourceInstance?: string;
}

/**
 * Options for exporting events
 */
export interface ExportOptions extends EventFilter {
  /** Include source instance ID in exported events */
  includeSourceInstance?: boolean;
}

/**
 * Result of importing events
 */
export interface ImportResult {
  /** Number of events imported */
  imported: number;
  /** Number of events skipped (already existed) */
  skipped: number;
  /** IDs of events that failed to import */
  failed: string[];
}
