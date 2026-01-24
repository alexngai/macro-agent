/**
 * Task-related type definitions
 */

import type { AgentId, TaskId, Timestamp } from "./primitives.js";

// Task statuses
export type TaskStatus =
  | "pending"
  | "assigned"
  | "in_progress"
  | "completed"
  | "failed";

// Task actions
export type TaskAction =
  | "created"
  | "assigned"
  | "unassigned"
  | "status_change"
  | "completed"
  | "failed"
  | "blocker_added"
  | "blocker_removed";

// Artifact reference
export interface ArtifactRef {
  type: "file" | "commit" | "url";
  ref: string;
  description?: string;
}

// =============================================================================
// Retry Policy Types
// =============================================================================

/**
 * Configuration for task retry behavior
 */
export interface RetryPolicy {
  /**
   * Maximum number of retry attempts
   * Default: 0 (no retry)
   */
  maxRetries: number;

  /**
   * Which conditions trigger a retry
   * - 'failed': Task explicitly failed
   * - 'stalled': Agent became unresponsive
   */
  retryOn: ("failed" | "stalled")[];

  /**
   * Initial backoff delay in milliseconds
   * Default: 1000 (1 second)
   */
  backoffMs: number;

  /**
   * Multiplier for exponential backoff
   * Default: 2
   */
  backoffMultiplier: number;

  /**
   * Maximum backoff delay in milliseconds
   * Default: 60000 (1 minute)
   */
  maxBackoffMs: number;
}

/**
 * Current state of retry attempts for a task
 */
export interface RetryState {
  /** Number of retry attempts made */
  attemptCount: number;

  /** When the last attempt was made */
  lastAttemptAt: Timestamp;

  /** Error from the last failed attempt */
  lastError?: string;

  /** When the next retry is scheduled (if waiting) */
  nextRetryAt?: Timestamp;
}

// Agent assignment history entry
export interface AgentHistoryEntry {
  agent_id: AgentId;
  role?: string;
  assigned_at: Timestamp;
  ended_at?: Timestamp;
}

// Task record in materialized view
export interface Task {
  id: TaskId;
  description: string;
  status: TaskStatus;
  assigned_agent?: AgentId;
  parent_task?: TaskId;
  subtasks?: TaskId[];
  blockers?: TaskId[];
  created_at: Timestamp;
  started_at?: Timestamp;
  completed_at?: Timestamp;
  created_by: AgentId;
  inputs?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  artifacts?: ArtifactRef[];
  agent_history?: AgentHistoryEntry[];

  /** Retry policy for this task */
  retryPolicy?: RetryPolicy;

  /** Current retry state */
  retryState?: RetryState;
}
