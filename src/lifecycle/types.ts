/**
 * Lifecycle Module Types
 *
 * Types for agent lifecycle management including done() signaling,
 * cleanup status detection, and role-specific handlers.
 *
 * @module lifecycle/types
 * @see s-32xs Self-Cleaning Workers spec
 */

import type { AgentId, TaskId } from "../store/types/index.js";
import type { TaskRef } from "git-cascade/events";

// =============================================================================
// Done Status Types
// =============================================================================

/**
 * Status values for done() signaling
 */
export type DoneStatus = "completed" | "failed" | "blocked" | "deferred";

/**
 * Cleanup status indicating workspace readiness
 */
export interface CleanupStatus {
  /** Whether the workspace is ready for cleanup */
  ready: boolean;

  /** Reason if not ready for cleanup */
  reason?: string;

  /** Uncommitted files if any */
  uncommittedFiles?: string[];

  /** Pending message count if any */
  pendingMessages?: number;
}

// =============================================================================
// Done Arguments and Results
// =============================================================================

/**
 * Arguments for the done() MCP tool
 */
export interface DoneArgs {
  /** Completion status */
  status: DoneStatus;

  /** Summary of work completed */
  summary?: string;

  /** Additional details */
  details?: Record<string, unknown>;

  /** Explicit cleanup status (auto-detected if not provided) */
  cleanupStatus?: CleanupStatus;

  /** Task ID to update (optional, uses agent's bound task if not specified) */
  taskId?: TaskId;
}

/**
 * Result from the done() MCP tool
 */
export interface DoneResult {
  /** Whether the done operation was successful */
  success: boolean;

  /** Whether the agent should terminate after this call */
  shouldTerminate: boolean;

  /** Status that was recorded */
  status: DoneStatus;

  /** Cleanup status that was detected/used */
  cleanupStatus: CleanupStatus;

  /** Any warnings during processing */
  warnings?: string[];

  /** Error message if success is false */
  error?: string;
}

// =============================================================================
// Handler Context and Types
// =============================================================================

/**
 * Context provided to lifecycle handlers
 */
export interface LifecycleContext {
  /** ID of the agent calling done() */
  agentId: AgentId;

  /** Role name of the agent */
  role: string;

  /** Task ID if agent is bound to a task */
  taskId?: TaskId;

  /** Parent agent ID if any */
  parentId?: AgentId;

  /** Workspace path for the agent */
  workspacePath?: string;

  /** Branch name for the agent's workspace */
  branch?: string;

  /** Integration branch for merge requests (target branch) */
  integrationBranch?: string;

  /** Stream ID for the agent's workspace (used by integrators for merge queue) */
  streamId?: string;

  /** Merge request ID (for resolver workers to track which MR they're resolving) */
  mrId?: string;

  /** Resolved capabilities for the agent's role (for capability-based handler dispatch) */
  capabilities?: string[];

  /**
   * Optional reference to an external task this agent is working on. When
   * present, threaded into commit metadata so cascade events carry the
   * binding (enabling task↔stream queries on the OpenHive hub).
   *
   * Sourced from `SpawnAgentOptions.taskRef` at spawn time and propagated
   * via the agent manager. Late-binding (mid-session pull-mode claim) can
   * mutate this on the live context.
   */
  taskRef?: TaskRef;
}

/**
 * Handler function signature for role-specific done() processing
 */
export type DoneHandler = (
  context: LifecycleContext,
  args: DoneArgs,
  cleanupStatus: CleanupStatus
) => Promise<DoneHandlerResult>;

/**
 * Result from a role-specific done handler
 */
export interface DoneHandlerResult {
  /** Whether to terminate the agent */
  shouldTerminate: boolean;

  /** Any signals that were emitted */
  signalsEmitted?: string[];

  /** Any cleanup actions performed */
  cleanupActions?: string[];

  /** Warnings from the handler */
  warnings?: string[];
}

// =============================================================================
// Handler Registry Types
// =============================================================================

/**
 * Map of role names to their done handlers
 */
export type DoneHandlerRegistry = Map<string, DoneHandler>;

/**
 * Configuration for the lifecycle module
 */
export interface LifecycleConfig {
  /** Whether to auto-commit uncommitted changes on done() */
  autoCommitOnDone?: boolean;

  /** Whether to auto-detect cleanup status */
  autoDetectCleanupStatus?: boolean;

  /** Default timeout for cleanup operations (ms) */
  cleanupTimeoutMs?: number;
}

/**
 * Default lifecycle configuration
 */
export const DEFAULT_LIFECYCLE_CONFIG: LifecycleConfig = {
  autoCommitOnDone: false,
  autoDetectCleanupStatus: true,
  cleanupTimeoutMs: 30000,
};

// =============================================================================
// Cascade Types
// =============================================================================

/**
 * Options for cascade termination
 */
export interface CascadeOptions {
  /** Reason for termination */
  reason: "parent_stopped" | "self_cleanup" | "forced";

  /** Whether to consolidate changes before terminating children */
  consolidateChanges?: boolean;

  /** Timeout for the cascade operation (ms) */
  timeoutMs?: number;
}

/**
 * Result of cascade termination
 */
export interface CascadeResult {
  /** Number of children terminated */
  childrenTerminated: number;

  /** IDs of children that were terminated */
  terminatedIds: AgentId[];

  /** Any errors during cascade */
  errors?: Array<{ agentId: AgentId; error: string }>;
}

// =============================================================================
// Change Consolidation Types (Phase 6)
// =============================================================================

/**
 * Result of change consolidation during termination
 */
export interface ConsolidationResult {
  /** Whether the consolidation was successful */
  success: boolean;

  /** Whether changes were actually merged */
  merged: boolean;

  /** Merge commit hash if merge was performed */
  mergeCommit?: string;

  /** List of conflicting files if merge failed */
  conflicts?: string[];

  /** Error message if consolidation failed */
  error?: string;
}

/**
 * Options for change consolidation
 */
export interface ConsolidationOptions {
  /** Whether to emit CONFLICT_DETECTED signal on merge failure */
  emitConflictSignal?: boolean;

  /** Custom merge commit message */
  mergeMessage?: string;
}
