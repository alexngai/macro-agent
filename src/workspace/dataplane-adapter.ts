/**
 * Dataplane Adapter
 *
 * Wraps MultiAgentRepoTracker to integrate with macro-agent's event system
 * and provide a simplified interface for workspace management.
 *
 * @module workspace/dataplane-adapter
 * @implements [[s-7ktd]] Dataplane Integration section
 */

import Database from 'better-sqlite3';
import {
  MultiAgentRepoTracker,
  type TrackerOptions,
  type Stream,
  type StreamStatus,
  type CreateStreamOptions,
  type AgentWorktree,
  type CreateWorktreeOptions,
  type WorkerTask,
  type CreateTaskOptions,
  type StartTaskOptions,
  type CompleteTaskOptions,
  type StartTaskResult,
  type CompleteTaskResult,
  type ListTasksOptions,
  type CleanupWorkerBranchesOptions,
  type CleanupResult,
  type Checkpoint,
  workerTasks,
  diffStacks,
} from 'dataplane';
import type { DataplaneConfig } from './config.js';
import { DEFAULT_DATAPLANE_CONFIG } from './config.js';

/**
 * Event types emitted by DataplaneAdapter
 */
export type DataplaneEventType =
  | 'stream:created'
  | 'stream:updated'
  | 'stream:abandoned'
  | 'worktree:created'
  | 'worktree:deallocated'
  | 'task:created'
  | 'task:started'
  | 'task:completed'
  | 'task:abandoned';

/**
 * Event payload for dataplane events
 */
export interface DataplaneEvent {
  type: DataplaneEventType;
  timestamp: number;
  data: Record<string, unknown>;
}

/**
 * Callback for dataplane events
 */
export type DataplaneEventCallback = (event: DataplaneEvent) => void;

/**
 * DataplaneAdapter wraps MultiAgentRepoTracker for macro-agent integration.
 *
 * Key responsibilities:
 * - Initialize dataplane with shared or dedicated database
 * - Emit events on dataplane operations
 * - Provide simplified API for workspace management
 */
export class DataplaneAdapter {
  private readonly tracker: MultiAgentRepoTracker;
  private readonly config: Required<
    Pick<DataplaneConfig, 'enabled' | 'tablePrefix' | 'verbose' | 'skipRecovery'>
  > & { repoPath: string };
  private readonly eventListeners: Set<DataplaneEventCallback> = new Set();
  private readonly ownsDb: boolean;

  /**
   * Create a new DataplaneAdapter.
   *
   * @param config - Dataplane configuration
   */
  constructor(config: DataplaneConfig) {
    const mergedConfig = {
      ...DEFAULT_DATAPLANE_CONFIG,
      ...config,
      repoPath: config.repoPath ?? process.cwd(),
    };

    this.config = {
      enabled: mergedConfig.enabled ?? true,
      repoPath: mergedConfig.repoPath,
      tablePrefix: mergedConfig.tablePrefix ?? 'dataplane_',
      verbose: mergedConfig.verbose ?? false,
      skipRecovery: mergedConfig.skipRecovery ?? false,
    };

    // Determine if we own the database connection
    this.ownsDb = !config.db;

    const trackerOptions: TrackerOptions = {
      repoPath: this.config.repoPath,
      tablePrefix: this.config.tablePrefix,
      verbose: this.config.verbose,
      skipRecovery: this.config.skipRecovery,
    };

    if (config.db) {
      trackerOptions.db = config.db;
    } else if (config.dbPath) {
      trackerOptions.dbPath = config.dbPath;
    }
    // If neither db nor dbPath provided, tracker uses default path

    this.tracker = new MultiAgentRepoTracker(trackerOptions);
  }

  /**
   * Get whether dataplane is enabled.
   */
  get enabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Get the repository path.
   */
  get repoPath(): string {
    return this.config.repoPath;
  }

  /**
   * Get the underlying database connection.
   * Use with caution - prefer adapter methods for operations.
   */
  get db(): Database.Database {
    return this.tracker.db;
  }

  /**
   * Get the underlying tracker.
   * Use with caution - prefer adapter methods for operations.
   */
  get rawTracker(): MultiAgentRepoTracker {
    return this.tracker;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Event System
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Subscribe to dataplane events.
   *
   * @param callback - Function called when events occur
   * @returns Unsubscribe function
   */
  onEvent(callback: DataplaneEventCallback): () => void {
    this.eventListeners.add(callback);
    return () => this.eventListeners.delete(callback);
  }

  /**
   * Emit an event to all listeners.
   */
  private emit(type: DataplaneEventType, data: Record<string, unknown>): void {
    const event: DataplaneEvent = {
      type,
      timestamp: Date.now(),
      data,
    };
    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch (error) {
        console.error('[DataplaneAdapter] Event listener error:', error);
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Stream Operations
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Create a new stream (integration branch).
   *
   * @param options - Stream creation options
   * @returns Stream ID
   */
  createStream(options: CreateStreamOptions): string {
    const streamId = this.tracker.createStream(options);
    this.emit('stream:created', { streamId, ...options });
    return streamId;
  }

  /**
   * Get a stream by ID.
   */
  getStream(streamId: string): Stream | null {
    return this.tracker.getStream(streamId);
  }

  /**
   * List streams with optional filters.
   */
  listStreams(options?: { agentId?: string; status?: StreamStatus }): Stream[] {
    return this.tracker.listStreams(options);
  }

  /**
   * Update a stream.
   */
  updateStream(
    streamId: string,
    updates: Partial<Pick<Stream, 'name' | 'status' | 'metadata'>>
  ): void {
    this.tracker.updateStream(streamId, updates);
    this.emit('stream:updated', { streamId, updates });
  }

  /**
   * Abandon a stream.
   */
  abandonStream(
    streamId: string,
    options?: { reason?: string; cascade?: boolean }
  ): void {
    this.tracker.abandonStream(streamId, options);
    this.emit('stream:abandoned', { streamId, ...options });
  }

  /**
   * Get the git branch name for a stream.
   */
  getStreamBranchName(streamId: string): string {
    return this.tracker.getStreamBranchName(streamId);
  }

  /**
   * Get the HEAD commit of a stream.
   */
  getStreamHead(streamId: string): string {
    return this.tracker.getStreamHead(streamId);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Worktree Operations
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Create a worktree for an agent.
   *
   * @param options - Worktree creation options
   * @returns Created worktree info
   */
  createWorktree(options: CreateWorktreeOptions): AgentWorktree {
    const worktree = this.tracker.createWorktree(options);
    this.emit('worktree:created', { ...worktree });
    return worktree;
  }

  /**
   * Get a worktree by agent ID.
   */
  getWorktree(agentId: string): AgentWorktree | null {
    return this.tracker.getWorktree(agentId);
  }

  /**
   * List all worktrees.
   */
  listWorktrees(): AgentWorktree[] {
    return this.tracker.listWorktrees();
  }

  /**
   * Update the stream associated with a worktree.
   */
  updateWorktreeStream(agentId: string, streamId: string | null): void {
    this.tracker.updateWorktreeStream(agentId, streamId);
  }

  /**
   * Deallocate a worktree.
   */
  deallocateWorktree(agentId: string): void {
    this.tracker.deallocateWorktree(agentId);
    this.emit('worktree:deallocated', { agentId });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Worker Task Operations
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Create a worker task under a stream.
   *
   * @param options - Task creation options
   * @returns Task ID
   */
  createTask(options: CreateTaskOptions): string {
    const taskId = this.tracker.createTask(options);
    this.emit('task:created', { taskId, ...options });
    return taskId;
  }

  /**
   * Get a task by ID.
   */
  getTask(taskId: string): WorkerTask | null {
    return this.tracker.getTask(taskId);
  }

  /**
   * List tasks for a stream.
   */
  listTasks(streamId: string, options?: ListTasksOptions): WorkerTask[] {
    return this.tracker.listTasks(streamId, options);
  }

  /**
   * Start a task - assigns agent and creates worker branch.
   *
   * @param options - Start task options
   * @returns Branch name and start commit
   */
  startTask(options: StartTaskOptions): StartTaskResult {
    const result = this.tracker.startTask(options);
    this.emit('task:started', {
      taskId: options.taskId,
      agentId: options.agentId,
      branchName: result.branchName,
      startCommit: result.startCommit,
    });
    return result;
  }

  /**
   * Complete a task - merges worker branch to stream.
   *
   * @param options - Complete task options
   * @returns Merge result
   */
  completeTask(options: CompleteTaskOptions): CompleteTaskResult {
    const result = this.tracker.completeTask(options);
    this.emit('task:completed', { taskId: options.taskId, ...result });
    return result;
  }

  /**
   * Abandon a task.
   *
   * @param taskId - Task ID
   * @param options - Options
   */
  abandonTask(taskId: string, options?: { deleteBranch?: boolean }): void {
    this.tracker.abandonTask(taskId, options);
    this.emit('task:abandoned', { taskId, ...options });
  }

  /**
   * Release a task back to 'open' status.
   */
  releaseTask(taskId: string): void {
    this.tracker.releaseTask(taskId);
  }

  /**
   * Detect conflicts for a task before completing.
   *
   * @param taskId - Task ID
   * @param worktree - Worktree path
   * @returns Array of conflicting file paths, empty if no conflicts
   */
  detectTaskConflicts(taskId: string, worktree: string): string[] {
    return workerTasks.detectTaskConflicts(
      this.tracker.db,
      this.config.repoPath,
      taskId,
      worktree
    );
  }

  /**
   * Recover stale tasks that have been in_progress too long.
   *
   * @param thresholdMs - Tasks older than this are considered stale
   * @returns Result with released task IDs
   */
  recoverStaleTasks(thresholdMs: number = 60 * 60 * 1000): { released: string[] } {
    return workerTasks.recoverStaleTasks(this.tracker.db, thresholdMs);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Checkpoint Operations
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Create checkpoints for commits made during a task.
   *
   * Creates a checkpoint for each commit between the task's startCommit and
   * the current HEAD of the task's stream. This captures the work done during
   * the task for future review and merge workflows.
   *
   * @param taskId - Task ID to create checkpoints for
   * @param agentId - Agent ID (used as createdBy)
   * @returns Array of created checkpoints
   */
  createCheckpointsForTask(taskId: string, agentId: string): Checkpoint[] {
    const task = this.getTask(taskId);
    if (!task) {
      console.warn(`[DataplaneAdapter] Task not found: ${taskId}`);
      return [];
    }

    if (!task.streamId) {
      console.warn(`[DataplaneAdapter] Task ${taskId} has no streamId`);
      return [];
    }

    if (!task.startCommit) {
      console.warn(`[DataplaneAdapter] Task ${taskId} has no startCommit`);
      return [];
    }

    try {
      // Create checkpoints from task's startCommit to stream's current HEAD
      const checkpoints = diffStacks.createCheckpointsFromStream(
        this.tracker.db,
        this.config.repoPath,
        task.streamId,
        {
          from: task.startCommit,
          createdBy: agentId,
        }
      );

      return checkpoints;
    } catch (error) {
      console.error(
        `[DataplaneAdapter] Failed to create checkpoints for task ${taskId}:`,
        error
      );
      return [];
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Commit Operations
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Commit changes in a worktree with Change tracking.
   *
   * @param options - Commit options
   * @returns Commit hash and change ID
   */
  commitChanges(options: {
    streamId: string;
    agentId: string;
    worktree: string;
    message: string;
  }): { commit: string; changeId: string } {
    return this.tracker.commitChanges(options);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Maintenance Operations
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Clean up old worker branches.
   *
   * Deletes branches for:
   * - Completed tasks older than threshold (default 24h)
   * - Abandoned tasks
   * - Orphaned branches (no task record)
   *
   * @param options - Cleanup options
   * @returns Deleted branches and any errors
   */
  cleanupWorkerBranches(options?: CleanupWorkerBranchesOptions): CleanupResult {
    return workerTasks.cleanupWorkerBranches(
      this.tracker.db,
      this.config.repoPath,
      options
    );
  }

  /**
   * Delete a specific worker branch.
   *
   * @param branchName - Branch name to delete
   * @returns true if deleted, false if branch didn't exist
   */
  deleteWorkerBranch(branchName: string): boolean {
    try {
      const { execSync } = require('child_process');
      execSync(`git branch -D "${branchName}"`, {
        cwd: this.config.repoPath,
        stdio: 'pipe',
      });
      return true;
    } catch {
      return false;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Health & Recovery
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Check system health.
   */
  healthCheck(): ReturnType<MultiAgentRepoTracker['healthCheck']> {
    return this.tracker.healthCheck();
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Close the adapter and release resources.
   *
   * Only closes the database if we created it (not if using shared DB).
   */
  close(): void {
    this.eventListeners.clear();
    this.tracker.close();
  }
}

/**
 * Create a DataplaneAdapter instance.
 *
 * @param config - Configuration options
 * @returns DataplaneAdapter instance
 */
export function createDataplaneAdapter(config: DataplaneConfig): DataplaneAdapter {
  return new DataplaneAdapter(config);
}
