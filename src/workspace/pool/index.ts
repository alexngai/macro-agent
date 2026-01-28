/**
 * Worktree Pool Module
 *
 * Exports the shared worktree pool for managing git worktrees
 * across multiple agents.
 *
 * @module workspace/pool
 */

export { WorktreePool } from './worktree-pool.js';
export type {
  AllocationResult,
  AllocationStrategy,
  AcquireOptions,
  ReleaseOptions,
  PooledWorktree,
  PoolEvent,
  PoolEventCallback,
  PoolEventType,
  PoolStats,
  QueuedRequest,
  RecoveryResult,
  WorktreePoolConfig,
  WorktreePoolInterface,
  WorktreeState,
} from './types.js';
