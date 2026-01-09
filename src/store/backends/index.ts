/**
 * Storage Backends Module
 *
 * Provides pluggable storage backends for the EventStore.
 */

// Types and interfaces
export {
  // Interface
  type StorageBackend,

  // Configuration types
  type StorageBackendConfig,
  type StorageBackendFactory,
  type BackendType,

  // Table constants
  STORAGE_TABLES,
  type StorageTable,

  // Export/Import types
  type ExportedEvent,
  type ExportOptions,
  type ImportResult,
} from './types.js';

// Backend implementations
export { createMemoryBackend } from './memory-backend.js';
export {
  createSqliteBackend,
  createSqliteBackendFromPath,
  type SqliteBackendOptions,
} from './sqlite-backend.js';
export {
  createJsonBackend,
  createJsonBackendFromPath,
  type JsonBackendOptions,
} from './json-backend.js';
export {
  createTinyBaseBackend,
  type TinyBaseBackendOptions,
} from './tinybase-backend.js';
