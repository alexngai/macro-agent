/**
 * Workspace Configuration Types
 *
 * Configuration for dataplane integration and workspace management.
 *
 * @module workspace/config
 */

import type Database from 'better-sqlite3';

/**
 * Configuration for dataplane integration
 */
export interface DataplaneConfig {
  /**
   * Whether dataplane is enabled.
   * When disabled, workspace operations are no-ops.
   */
  enabled: boolean;

  /**
   * Path to the git repository.
   * Defaults to current working directory.
   */
  repoPath?: string;

  /**
   * Table prefix for dataplane tables in shared SQLite database.
   * Defaults to 'dataplane_'.
   */
  tablePrefix?: string;

  /**
   * Path to SQLite database file.
   * If not provided and db is not provided, creates database at
   * `<repoPath>/.dataplane/tracker.db`.
   */
  dbPath?: string;

  /**
   * Existing database connection to share.
   * If provided, dataplane will use this connection instead of creating its own.
   * The caller is responsible for closing this connection.
   */
  db?: Database.Database;

  /**
   * Enable verbose logging for debugging.
   */
  verbose?: boolean;

  /**
   * Skip recovery process on startup.
   * Useful for testing or when recovery is handled externally.
   */
  skipRecovery?: boolean;
}

/**
 * Default dataplane configuration
 */
export const DEFAULT_DATAPLANE_CONFIG: Partial<DataplaneConfig> = {
  enabled: true,
  tablePrefix: 'dataplane_',
  verbose: false,
  skipRecovery: false,
};

/**
 * Workspace directory configuration
 */
export interface WorkspaceDirectoryConfig {
  /**
   * Base directory for worktrees.
   * Defaults to `<repoPath>/.worktrees`.
   */
  worktreeDir?: string;

  /**
   * Maximum number of concurrent worktrees.
   * Defaults to 50.
   */
  maxWorktrees?: number;

  /**
   * Use themed names for worktree directories.
   * If false, uses numeric slots (worker-01, worker-02, etc.).
   */
  useThemedNames?: boolean;

  /**
   * Custom themed names for worktree directories.
   * Only used if useThemedNames is true.
   */
  themedNames?: string[];
}

/**
 * Strategy for handling allocation when pool is exhausted.
 *
 * - `reject`: Immediately reject the request (default)
 * - `queue`: Wait for a worktree to become available
 * - `steal`: Forcibly take a worktree from another agent
 */
export type AllocationStrategy = 'reject' | 'queue' | 'steal';

/**
 * Configuration for the shared worktree pool.
 */
export interface WorktreePoolConfig {
  /**
   * Whether to use the shared worktree pool.
   * When enabled, worktrees are managed by the pool and reused.
   * Defaults to false for backward compatibility.
   */
  enabled: boolean;

  /**
   * Maximum number of worktrees in the pool.
   * Defaults to 50.
   */
  maxSize?: number;

  /**
   * Default strategy when pool is exhausted.
   * Defaults to 'reject'.
   */
  defaultStrategy?: AllocationStrategy;

  /**
   * Whether to recover orphaned worktrees on startup.
   * Defaults to true.
   */
  recoverOrphans?: boolean;

  /**
   * Use themed names for pool slots.
   * Defaults to false.
   */
  useThemedNames?: boolean;

  /**
   * Custom themed names for pool slots.
   */
  themedNames?: string[];
}

/**
 * Default worktree pool configuration.
 */
export const DEFAULT_POOL_CONFIG: WorktreePoolConfig = {
  enabled: false,
  maxSize: 50,
  defaultStrategy: 'reject',
  recoverOrphans: true,
  useThemedNames: false,
};

/**
 * Default workspace directory configuration
 */
export const DEFAULT_WORKSPACE_DIR_CONFIG: WorkspaceDirectoryConfig = {
  maxWorktrees: 50,
  useThemedNames: false,
};
