/**
 * Integration Strategy Types
 *
 * Defines the pluggable strategy interface for integrating worker changes
 * into the integration branch. Strategies determine how completed work
 * is landed (merge queue, direct push, optimistic push).
 *
 * @module workspace/strategies/types
 */

// =============================================================================
// Land Request / Result
// =============================================================================

/**
 * Result status from a land operation
 */
export type LandResultStatus = "landed" | "conflict" | "failed";

/**
 * Request to land changes from a worker branch
 */
export interface LandRequest {
  /** Worker's branch with completed changes */
  sourceBranch: string;

  /** Target integration branch */
  targetBranch: string;

  /** Workspace path where git operations run */
  workspacePath: string;

  /** Agent ID of the worker */
  agentId: string;

  /** Task ID associated with the changes */
  taskId?: string;

  /** Stream ID for the integration stream */
  streamId?: string;

  /** Commit message for the merge/rebase */
  commitMessage?: string;
}

/**
 * Result of a land operation
 */
export interface LandResult {
  /** Whether the landing was successful */
  status: LandResultStatus;

  /** Merge/rebase commit hash if landed */
  commitHash?: string;

  /** Merge request ID if submitted to a queue */
  mergeRequestId?: string;

  /** Files with conflicts if status is "conflict" */
  conflictFiles?: string[];

  /** Action taken on conflict exhaustion */
  action?: "abandoned" | "queued_for_resolution";

  /** Error message if status is "failed" */
  error?: string;

  /** Number of retry attempts made */
  retryCount?: number;
}

// =============================================================================
// Strategy Interface
// =============================================================================

/**
 * Integration strategy interface.
 *
 * Strategies determine how completed worker changes are integrated
 * into the target branch. Different strategies suit different workflows:
 * - queue: Sequential merge via integrator (default, existing behavior)
 * - trunk: Direct push with rebase-and-retry
 * - optimistic: Push immediately, validate later (judge validates)
 */
export interface IntegrationStrategy {
  /** Strategy name */
  readonly name: string;

  /**
   * Land changes from source branch to target branch.
   */
  land(request: LandRequest): Promise<LandResult>;

  /**
   * Optional initialization hook (called on TeamRuntime.initialize()).
   */
  initialize?(): Promise<void>;

  /**
   * Optional cleanup hook (called on TeamRuntime.teardown()).
   */
  close?(): Promise<void>;
}

// =============================================================================
// Strategy Configuration Types
// =============================================================================

/**
 * Configuration for the queue strategy
 */
export interface QueueStrategyConfig {
  /** Priority for submitted merge requests (default: 100) */
  defaultPriority?: number;
}

/**
 * Configuration for the trunk strategy
 */
export interface TrunkStrategyConfig {
  /** Maximum rebase-and-retry attempts on conflict (default: 3) */
  maxRetries?: number;

  /** Action on conflict exhaustion (default: "abandon") */
  conflictAction?: "abandon" | "queued_for_resolution";
}

/**
 * Configuration for the optimistic strategy
 */
export interface OptimisticStrategyConfig {
  /** Maximum rebase-and-retry attempts on conflict (default: 3) */
  maxRetries?: number;
}

// =============================================================================
// Factory
// =============================================================================

/**
 * Factory function signature for creating strategies
 */
export type IntegrationStrategyFactory = (
  config?: Record<string, unknown>
) => IntegrationStrategy;
