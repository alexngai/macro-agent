/**
 * Worktree Pool Types
 *
 * Types for the shared worktree pool that manages allocation and
 * recycling of git worktrees across agents.
 *
 * @module workspace/pool/types
 */

import type { AgentId, WorkspaceRole } from '../types.js';

/**
 * Strategy for handling allocation when pool is exhausted.
 *
 * - `reject`: Immediately reject the request (default)
 * - `queue`: Wait for a worktree to become available
 * - `steal`: Forcibly take a worktree from another agent
 */
export type AllocationStrategy = 'reject' | 'queue' | 'steal';

/**
 * State of a pooled worktree slot.
 */
export type WorktreeState = 'available' | 'allocated' | 'cleaning' | 'error';

/**
 * A worktree managed by the pool.
 */
export interface PooledWorktree {
  /** Unique slot identifier (e.g., "slot-01", "slot-02") */
  slotId: string;

  /** Filesystem path to the worktree */
  path: string;

  /** Current state of the worktree */
  state: WorktreeState;

  /** Agent currently using this worktree (if allocated) */
  allocatedTo?: AgentId;

  /** Role of the allocated agent */
  allocatedRole?: WorkspaceRole;

  /** Timestamp when the worktree was allocated */
  allocatedAt?: number;

  /** Timestamp when the worktree was last released */
  lastReleasedAt?: number;

  /** Error message if state is 'error' */
  error?: string;
}

/**
 * Result of an allocation attempt.
 */
export interface AllocationResult {
  /** Whether allocation succeeded */
  success: boolean;

  /** The allocated worktree (if success is true) */
  worktree?: PooledWorktree;

  /** Error message (if success is false) */
  error?: string;

  /** Whether the request was queued for later (if strategy is 'queue') */
  queued?: boolean;
}

/**
 * Options for acquiring a worktree from the pool.
 */
export interface AcquireOptions {
  /** Agent requesting the worktree */
  agentId: AgentId;

  /** Role of the requesting agent */
  role: WorkspaceRole;

  /** Strategy to use if pool is exhausted (default: 'reject') */
  strategy?: AllocationStrategy;

  /** Timeout in milliseconds for 'queue' strategy */
  timeout?: number;

  /** Preferred slot ID (if available) */
  preferredSlot?: string;
}

/**
 * Options for releasing a worktree back to the pool.
 */
export interface ReleaseOptions {
  /** Whether to clean the worktree (reset state, delete branches) */
  clean?: boolean;

  /** Whether to force release even if worktree has uncommitted changes */
  force?: boolean;
}

/**
 * Configuration for the worktree pool.
 */
export interface WorktreePoolConfig {
  /** Base directory for worktrees */
  worktreeBaseDir: string;

  /** Maximum number of worktrees in the pool */
  maxSize: number;

  /** Whether to use themed names (e.g., "alpha", "beta") instead of numbers */
  useThemedNames?: boolean;

  /** Custom themed names for slots */
  themedNames?: string[];

  /** Whether to recover orphaned worktrees on startup */
  recoverOrphans?: boolean;

  /** Default allocation strategy when pool is exhausted */
  defaultStrategy?: AllocationStrategy;
}

/**
 * Statistics about the worktree pool.
 */
export interface PoolStats {
  /** Total number of slots in the pool */
  totalSlots: number;

  /** Number of available slots */
  availableSlots: number;

  /** Number of allocated slots */
  allocatedSlots: number;

  /** Number of slots being cleaned */
  cleaningSlots: number;

  /** Number of slots in error state */
  errorSlots: number;

  /** Breakdown by role */
  byRole: {
    worker: number;
    integrator: number;
    coordinator: number;
    v3: number;
  };
}

/**
 * Queued allocation request (for 'queue' strategy).
 */
export interface QueuedRequest {
  /** Agent requesting the worktree */
  agentId: AgentId;

  /** Role of the requesting agent */
  role: WorkspaceRole;

  /** Timestamp when the request was queued */
  queuedAt: number;

  /** Timeout timestamp */
  timeoutAt: number;

  /** Promise resolve function */
  resolve: (result: AllocationResult) => void;

  /** Promise reject function */
  reject: (error: Error) => void;
}

/**
 * Recovery result from orphaned worktree cleanup.
 */
export interface RecoveryResult {
  /** Number of orphaned worktrees found */
  orphansFound: number;

  /** Number of orphaned worktrees successfully cleaned */
  orphansCleaned: number;

  /** Errors encountered during recovery */
  errors: Array<{ slotId: string; error: string }>;

  /** Slots recovered and made available */
  recoveredSlots: string[];
}

/**
 * Events emitted by the worktree pool.
 */
export type PoolEventType =
  | 'pool:initialized'
  | 'worktree:acquired'
  | 'worktree:released'
  | 'worktree:cleaned'
  | 'worktree:error'
  | 'pool:exhausted'
  | 'pool:recovered';

/**
 * Pool event payload.
 */
export interface PoolEvent {
  type: PoolEventType;
  timestamp: number;
  data: Record<string, unknown>;
}

/**
 * Callback for pool events.
 */
export type PoolEventCallback = (event: PoolEvent) => void;

/**
 * Interface for the worktree pool.
 */
export interface WorktreePoolInterface {
  /**
   * Acquire a worktree from the pool.
   *
   * @param options - Acquisition options
   * @returns Allocation result
   */
  acquire(options: AcquireOptions): Promise<AllocationResult>;

  /**
   * Release a worktree back to the pool.
   *
   * @param agentId - Agent releasing the worktree
   * @param options - Release options
   */
  release(agentId: AgentId, options?: ReleaseOptions): Promise<void>;

  /**
   * Get the worktree allocated to an agent.
   *
   * @param agentId - Agent ID
   * @returns Pooled worktree or null
   */
  getWorktree(agentId: AgentId): PooledWorktree | null;

  /**
   * Get pool statistics.
   *
   * @returns Pool stats
   */
  getStats(): PoolStats;

  /**
   * Recover orphaned worktrees.
   *
   * Called automatically on initialization if recoverOrphans is true.
   *
   * @returns Recovery result
   */
  recoverOrphans(): Promise<RecoveryResult>;

  /**
   * Subscribe to pool events.
   *
   * @param callback - Event callback
   * @returns Unsubscribe function
   */
  onEvent(callback: PoolEventCallback): () => void;

  /**
   * Close the pool and release all resources.
   */
  close(): Promise<void>;
}
