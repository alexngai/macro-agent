/**
 * MergeQueue Implementation
 *
 * Coordinates merging of parallel worker branches into the integration branch.
 * Workers submit completed work; Integrator processes sequentially.
 *
 * @module workspace/merge-queue/merge-queue
 * @implements [[s-bcqm]] Merge Queue section
 */

import type Database from 'better-sqlite3';
import type {
  MergeRequest,
  MergeRequestStatus,
  SubmitMergeRequestOptions,
  ListMergeRequestsOptions,
  MergeQueueInterface,
  MergeQueueEvent,
  MergeQueueEventType,
  MergeQueueEventCallback,
} from './types.js';
import {
  getMergeRequestsTableName,
  initMergeQueueSchema,
  mergeQueueTableExists,
} from './schema.js';

/**
 * Error thrown when merge request is not found.
 */
export class MergeRequestNotFoundError extends Error {
  constructor(mrId: string) {
    super(`Merge request ${mrId} not found`);
    this.name = 'MergeRequestNotFoundError';
  }
}

/**
 * Error thrown when merge request status transition is invalid.
 */
export class MergeRequestStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MergeRequestStateError';
  }
}

/**
 * Generate a unique merge request ID.
 */
function generateMergeRequestId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 6);
  return `mr-${timestamp}-${random}`;
}

/**
 * Convert database row to MergeRequest object.
 */
function rowToMergeRequest(row: Record<string, unknown>): MergeRequest {
  return {
    id: row.id as string,
    streamId: row.stream_id as string,
    taskId: row.task_id as string,
    workerBranch: row.worker_branch as string,
    workerAgentId: row.worker_agent_id as string,
    status: row.status as MergeRequestStatus,
    priority: row.priority as number,
    position: row.position as number | null,
    submittedAt: row.submitted_at as number,
    startedAt: row.started_at as number | null,
    completedAt: row.completed_at as number | null,
    mergeCommit: row.merge_commit as string | null,
    conflictFiles: row.conflict_files
      ? JSON.parse(row.conflict_files as string)
      : null,
    resolverTaskId: row.resolver_task_id as string | null,
    metadata: JSON.parse((row.metadata as string) || '{}'),
  };
}

/**
 * Configuration options for MergeQueue.
 */
export interface MergeQueueConfig {
  /** SQLite database connection */
  db: Database.Database;

  /** Table name prefix (default: '') */
  tablePrefix?: string;

  /** Initialize schema on construction (default: true) */
  initSchema?: boolean;
}

/**
 * MergeQueue implementation.
 *
 * Manages merge requests for coordinating parallel worker merges.
 */
export class MergeQueue implements MergeQueueInterface {
  private readonly db: Database.Database;
  private readonly tableName: string;
  private readonly eventListeners: Set<MergeQueueEventCallback> = new Set();

  /**
   * Create a new MergeQueue.
   *
   * @param config - Configuration options
   */
  constructor(config: MergeQueueConfig) {
    this.db = config.db;
    this.tableName = getMergeRequestsTableName(config.tablePrefix ?? '');

    // Initialize schema if needed
    if (config.initSchema !== false) {
      if (!mergeQueueTableExists(this.db, config.tablePrefix ?? '')) {
        initMergeQueueSchema(this.db, config.tablePrefix ?? '');
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Event System
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Subscribe to merge queue events.
   *
   * @param callback - Event callback
   * @returns Unsubscribe function
   */
  onEvent(callback: MergeQueueEventCallback): () => void {
    this.eventListeners.add(callback);
    return () => this.eventListeners.delete(callback);
  }

  /**
   * Emit an event to all listeners.
   */
  private emit(
    type: MergeQueueEventType,
    data: Record<string, unknown>
  ): void {
    const event: MergeQueueEvent = {
      type,
      timestamp: Date.now(),
      data,
    };
    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch (error) {
        console.error('[MergeQueue] Event listener error:', error);
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Submit
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Submit a merge request to the queue.
   *
   * @param options - Submit options
   * @returns Merge request ID
   */
  submit(options: SubmitMergeRequestOptions): string {
    const id = generateMergeRequestId();
    const now = Date.now();

    this.db
      .prepare(
        `INSERT INTO ${this.tableName} (
          id, stream_id, task_id, worker_branch, worker_agent_id,
          status, priority, submitted_at, metadata
        ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`
      )
      .run(
        id,
        options.streamId,
        options.taskId,
        options.workerBranch,
        options.workerAgentId,
        options.priority ?? 100,
        now,
        JSON.stringify(options.metadata ?? {})
      );

    this.emit('mr:submitted', {
      mrId: id,
      streamId: options.streamId,
      taskId: options.taskId,
      workerBranch: options.workerBranch,
      workerAgentId: options.workerAgentId,
    });

    return id;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Processing
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Get the next pending merge request for a stream.
   *
   * Returns the highest priority (lowest number), oldest pending request.
   * If position is set, uses position for ordering instead.
   *
   * @param streamId - Stream ID
   * @returns Next merge request or null if none pending
   */
  getNext(streamId: string): MergeRequest | null {
    // Order by: position first (if set), then priority, then submitted_at
    const row = this.db
      .prepare(
        `SELECT * FROM ${this.tableName}
         WHERE stream_id = ? AND status = 'pending'
         ORDER BY
           CASE WHEN position IS NOT NULL THEN 0 ELSE 1 END,
           position ASC,
           priority ASC,
           submitted_at ASC
         LIMIT 1`
      )
      .get(streamId) as Record<string, unknown> | undefined;

    return row ? rowToMergeRequest(row) : null;
  }

  /**
   * Mark a merge request as processing.
   *
   * @param mrId - Merge request ID
   */
  markProcessing(mrId: string): void {
    const mr = this.getOrThrow(mrId);

    if (mr.status !== 'pending') {
      throw new MergeRequestStateError(
        `Cannot mark MR ${mrId} as processing: status is '${mr.status}' (must be 'pending')`
      );
    }

    const now = Date.now();
    this.db
      .prepare(
        `UPDATE ${this.tableName}
         SET status = 'processing', started_at = ?
         WHERE id = ?`
      )
      .run(now, mrId);

    this.emit('mr:processing', {
      mrId,
      streamId: mr.streamId,
      taskId: mr.taskId,
    });
  }

  /**
   * Mark a merge request as successfully merged.
   *
   * @param mrId - Merge request ID
   * @param mergeCommit - Commit hash of the merge commit
   */
  markMerged(mrId: string, mergeCommit: string): void {
    const mr = this.getOrThrow(mrId);

    if (mr.status !== 'processing') {
      throw new MergeRequestStateError(
        `Cannot mark MR ${mrId} as merged: status is '${mr.status}' (must be 'processing')`
      );
    }

    const now = Date.now();
    this.db
      .prepare(
        `UPDATE ${this.tableName}
         SET status = 'merged', completed_at = ?, merge_commit = ?
         WHERE id = ?`
      )
      .run(now, mergeCommit, mrId);

    this.emit('mr:merged', {
      mrId,
      streamId: mr.streamId,
      taskId: mr.taskId,
      mergeCommit,
    });
  }

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
  ): void {
    const mr = this.getOrThrow(mrId);

    if (mr.status !== 'processing') {
      throw new MergeRequestStateError(
        `Cannot mark MR ${mrId} as conflict: status is '${mr.status}' (must be 'processing')`
      );
    }

    const now = Date.now();
    this.db
      .prepare(
        `UPDATE ${this.tableName}
         SET status = 'conflict', completed_at = ?, conflict_files = ?, resolver_task_id = ?
         WHERE id = ?`
      )
      .run(now, JSON.stringify(conflictFiles), resolverTaskId ?? null, mrId);

    this.emit('mr:conflict', {
      mrId,
      streamId: mr.streamId,
      taskId: mr.taskId,
      conflictFiles,
      resolverTaskId,
    });
  }

  /**
   * Mark a merge request as abandoned.
   *
   * @param mrId - Merge request ID
   */
  markAbandoned(mrId: string): void {
    const mr = this.getOrThrow(mrId);

    // Only pending and processing MRs can be abandoned
    // Terminal states (merged, abandoned, conflict) cannot be abandoned
    if (mr.status !== 'pending' && mr.status !== 'processing') {
      throw new MergeRequestStateError(
        `Cannot abandon MR ${mrId}: status is '${mr.status}' (must be 'pending' or 'processing')`
      );
    }

    const now = Date.now();
    this.db
      .prepare(
        `UPDATE ${this.tableName}
         SET status = 'abandoned', completed_at = ?
         WHERE id = ?`
      )
      .run(now, mrId);

    this.emit('mr:abandoned', {
      mrId,
      streamId: mr.streamId,
      taskId: mr.taskId,
    });
  }

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
  ): void {
    const mr = this.getOrThrow(mrId);

    if (mr.status !== 'conflict') {
      throw new MergeRequestStateError(
        `Cannot mark MR ${mrId} as resolved: status is '${mr.status}' (must be 'conflict')`
      );
    }

    const now = Date.now();
    this.db
      .prepare(
        `UPDATE ${this.tableName}
         SET status = 'merged', completed_at = ?, merge_commit = ?
         WHERE id = ?`
      )
      .run(now, mergeCommit, mrId);

    this.emit('mr:resolved', {
      mrId,
      streamId: mr.streamId,
      taskId: mr.taskId,
      mergeCommit,
      resolverTaskId: mr.resolverTaskId,
      resolverBranch,
    });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Queries
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Get a merge request by ID.
   *
   * @param mrId - Merge request ID
   * @returns Merge request or null if not found
   */
  get(mrId: string): MergeRequest | null {
    const row = this.db
      .prepare(`SELECT * FROM ${this.tableName} WHERE id = ?`)
      .get(mrId) as Record<string, unknown> | undefined;

    return row ? rowToMergeRequest(row) : null;
  }

  /**
   * Get a merge request by ID, throwing if not found.
   */
  private getOrThrow(mrId: string): MergeRequest {
    const mr = this.get(mrId);
    if (!mr) {
      throw new MergeRequestNotFoundError(mrId);
    }
    return mr;
  }

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
  ): MergeRequest[] {
    let query = `SELECT * FROM ${this.tableName} WHERE stream_id = ?`;
    const params: unknown[] = [streamId];

    if (options?.status) {
      query += ` AND status = ?`;
      params.push(options.status);
    } else {
      query += ` AND status = 'pending'`;
    }

    query += ` ORDER BY
      CASE WHEN position IS NOT NULL THEN 0 ELSE 1 END,
      position ASC,
      priority ASC,
      submitted_at ASC`;

    if (options?.limit) {
      query += ` LIMIT ?`;
      params.push(options.limit);
    }

    const rows = this.db.prepare(query).all(...params) as Record<
      string,
      unknown
    >[];
    return rows.map(rowToMergeRequest);
  }

  /**
   * Get merge request by task ID.
   *
   * @param taskId - Task ID
   * @returns Merge request or null if not found
   */
  getByTask(taskId: string): MergeRequest | null {
    const row = this.db
      .prepare(`SELECT * FROM ${this.tableName} WHERE task_id = ?`)
      .get(taskId) as Record<string, unknown> | undefined;

    return row ? rowToMergeRequest(row) : null;
  }

  /**
   * Get the number of pending merge requests for a stream.
   *
   * @param streamId - Stream ID
   * @returns Queue depth
   */
  getQueueDepth(streamId: string): number {
    const result = this.db
      .prepare(
        `SELECT COUNT(*) as count FROM ${this.tableName}
         WHERE stream_id = ? AND status = 'pending'`
      )
      .get(streamId) as { count: number };

    return result.count;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Reordering
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Reposition a merge request in the queue.
   *
   * Sets the position field for manual ordering.
   *
   * @param mrId - Merge request ID
   * @param newPosition - New position (1-indexed)
   */
  reposition(mrId: string, newPosition: number): void {
    const mr = this.getOrThrow(mrId);

    if (mr.status !== 'pending') {
      throw new MergeRequestStateError(
        `Cannot reposition MR ${mrId}: status is '${mr.status}' (must be 'pending')`
      );
    }

    this.db
      .prepare(`UPDATE ${this.tableName} SET position = ? WHERE id = ?`)
      .run(newPosition, mrId);
  }

  /**
   * Change the priority of a merge request.
   *
   * @param mrId - Merge request ID
   * @param newPriority - New priority value
   */
  bumpPriority(mrId: string, newPriority: number): void {
    const mr = this.getOrThrow(mrId);

    if (mr.status !== 'pending') {
      throw new MergeRequestStateError(
        `Cannot change priority of MR ${mrId}: status is '${mr.status}' (must be 'pending')`
      );
    }

    this.db
      .prepare(`UPDATE ${this.tableName} SET priority = ? WHERE id = ?`)
      .run(newPriority, mrId);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Close the merge queue and release resources.
   */
  close(): void {
    this.eventListeners.clear();
    // Note: We don't close the database here since it may be shared
  }
}

/**
 * Create a MergeQueue instance.
 *
 * @param config - Configuration options
 * @returns MergeQueue instance
 */
export function createMergeQueue(config: MergeQueueConfig): MergeQueue {
  return new MergeQueue(config);
}
