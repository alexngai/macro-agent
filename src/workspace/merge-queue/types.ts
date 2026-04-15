/**
 * MergeQueue Types
 *
 * Types for the merge queue layer that coordinates parallel worker merges.
 *
 * @module workspace/merge-queue/types
 * @implements [[s-bcqm]] Merge Queue Schema section
 */

/**
 * Merge request status values.
 *
 * - pending: Waiting in queue to be processed
 * - processing: Currently being merged by integrator
 * - merged: Successfully merged into integration branch
 * - conflict: Merge conflicts detected, needs resolution
 * - abandoned: Worker abandoned, merge request cancelled
 */
export type MergeRequestStatus =
  | 'pending'
  | 'processing'
  | 'merged'
  | 'conflict'
  | 'abandoned';

/**
 * Merge request record.
 *
 * Represents a worker's completed work waiting to be merged
 * into the integration branch.
 */
export interface MergeRequest {
  /** Unique identifier for the merge request */
  id: string;

  /** Stream (integration branch) this MR targets */
  streamId: string;

  /** git-cascade task ID this MR completes */
  taskId: string;

  /** Git branch containing the worker's changes */
  workerBranch: string;

  /** Agent ID of the worker that submitted this MR */
  workerAgentId: string;

  /** Current status of the merge request */
  status: MergeRequestStatus;

  /** Priority (lower = higher priority, default 100) */
  priority: number;

  /** Position in queue for manual reordering (null = auto) */
  position: number | null;

  /** Timestamp when MR was submitted */
  submittedAt: number;

  /** Timestamp when processing started */
  startedAt: number | null;

  /** Timestamp when merge completed (or conflict detected) */
  completedAt: number | null;

  /** Commit hash of the merge commit (when merged) */
  mergeCommit: string | null;

  /** Files with conflicts (when status = conflict) */
  conflictFiles: string[] | null;

  /** Task ID of resolver worker (when status = conflict) */
  resolverTaskId: string | null;

  /** Optional metadata */
  metadata: Record<string, unknown>;
}

/**
 * Options for submitting a merge request.
 */
export interface SubmitMergeRequestOptions {
  /** Stream (integration branch) to merge into */
  streamId: string;

  /** git-cascade task ID this completes */
  taskId: string;

  /** Git branch containing the worker's changes */
  workerBranch: string;

  /** Agent ID of the worker submitting */
  workerAgentId: string;

  /** Priority (default: 100) */
  priority?: number;

  /** Optional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Options for listing merge requests.
 */
export interface ListMergeRequestsOptions {
  /** Filter by status */
  status?: MergeRequestStatus;

  /** Limit number of results */
  limit?: number;
}

/**
 * MergeQueue event types.
 */
export type MergeQueueEventType =
  | 'mr:submitted'
  | 'mr:processing'
  | 'mr:merged'
  | 'mr:conflict'
  | 'mr:abandoned'
  | 'mr:resolved';

/**
 * MergeQueue event payload.
 */
export interface MergeQueueEvent {
  type: MergeQueueEventType;
  timestamp: number;
  data: Record<string, unknown>;
}

/**
 * Callback for merge queue events.
 */
export type MergeQueueEventCallback = (event: MergeQueueEvent) => void;

/**
 * MergeQueue interface.
 *
 * Coordinates merging of parallel worker branches into the integration branch.
 * Workers submit completed work; Integrator processes sequentially.
 */
export interface MergeQueueInterface {
  // ─────────────────────────────────────────────────────────────────────────────
  // Submit
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Submit a merge request to the queue.
   *
   * @param options - Submit options
   * @returns Merge request ID
   */
  submit(options: SubmitMergeRequestOptions): string;

  // ─────────────────────────────────────────────────────────────────────────────
  // Processing
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Get the next pending merge request for a stream.
   *
   * Returns the highest priority (lowest number), oldest pending request.
   *
   * @param streamId - Stream ID
   * @returns Next merge request or null if none pending
   */
  getNext(streamId: string): MergeRequest | null;

  /**
   * Mark a merge request as processing.
   *
   * @param mrId - Merge request ID
   */
  markProcessing(mrId: string): void;

  /**
   * Mark a merge request as successfully merged.
   *
   * @param mrId - Merge request ID
   * @param mergeCommit - Commit hash of the merge commit
   */
  markMerged(mrId: string, mergeCommit: string): void;

  /**
   * Mark a merge request as having conflicts.
   *
   * @param mrId - Merge request ID
   * @param conflictFiles - List of files with conflicts
   * @param resolverTaskId - Optional task ID of resolver worker
   */
  markConflict(
    mrId: string,
    conflictFiles: string[],
    resolverTaskId?: string
  ): void;

  /**
   * Mark a merge request as abandoned.
   *
   * @param mrId - Merge request ID
   */
  markAbandoned(mrId: string): void;

  /**
   * Mark a conflicted merge request as resolved and merged.
   *
   * Called after a resolver worker completes and the integrator
   * performs an inline merge of the resolver's branch.
   *
   * @param mrId - Merge request ID (must be in 'conflict' status)
   * @param mergeCommit - Commit hash from the resolver's inline merge
   * @param resolverBranch - Branch the resolver worked on (for audit)
   */
  markResolverComplete(
    mrId: string,
    mergeCommit: string,
    resolverBranch?: string
  ): void;

  // ─────────────────────────────────────────────────────────────────────────────
  // Queries
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Get a merge request by ID.
   *
   * @param mrId - Merge request ID
   * @returns Merge request or null if not found
   */
  get(mrId: string): MergeRequest | null;

  /**
   * Get pending merge requests for a stream.
   *
   * @param streamId - Stream ID
   * @param options - List options
   * @returns List of pending merge requests
   */
  getPending(
    streamId: string,
    options?: ListMergeRequestsOptions
  ): MergeRequest[];

  /**
   * Get merge request by task ID.
   *
   * @param taskId - Task ID
   * @returns Merge request or null if not found
   */
  getByTask(taskId: string): MergeRequest | null;

  /**
   * Get the number of pending merge requests for a stream.
   *
   * @param streamId - Stream ID
   * @returns Queue depth
   */
  getQueueDepth(streamId: string): number;

  // ─────────────────────────────────────────────────────────────────────────────
  // Reordering
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Reposition a merge request in the queue.
   *
   * @param mrId - Merge request ID
   * @param newPosition - New position (1-indexed)
   */
  reposition(mrId: string, newPosition: number): void;

  /**
   * Change the priority of a merge request.
   *
   * @param mrId - Merge request ID
   * @param newPriority - New priority value
   */
  bumpPriority(mrId: string, newPriority: number): void;

  // ─────────────────────────────────────────────────────────────────────────────
  // Events
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Subscribe to merge queue events.
   *
   * @param callback - Event callback
   * @returns Unsubscribe function
   */
  onEvent(callback: MergeQueueEventCallback): () => void;

  // ─────────────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Close the merge queue and release resources.
   */
  close(): void;
}
