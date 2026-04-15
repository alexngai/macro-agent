/**
 * git-cascade Adapter
 *
 * Wraps git-cascade's MultiAgentRepoTracker to integrate with macro-agent's
 * event system and provide a simplified interface for workspace management.
 *
 * @module workspace/git-cascade-adapter
 */

import Database from 'better-sqlite3';
import {
  MultiAgentRepoTracker,
  type TrackerOptions,
  type Stream,
  type StreamStatus,
  type StreamNode,
  type CreateStreamOptions,
  type ForkStreamOptions,
  type MergeStreamOptions,
  type MergeResult,
  type RebaseOntoStreamOptions,
  type RebaseResult,
  type ConflictStrategy,
  type ConflictRecord,
  type CreateConflictOptions,
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
  type Change,
  type ChangeStatus,
  workerTasks,
  diffStacks,
  mergeQueue as mergeQueueModule,
  reconcile as reconcileModule,
  cascade as cascadeModule,
  matchCascadeSuffix,
  type StreamOpenedParams,
  type StreamCommittedParams,
  type StreamMergedParams,
  type StreamConflictedParams,
  type StreamAbandonedParams,
  type CascadeRebasedParams,
  type CascadeCompletedParams,
} from 'git-cascade';
// git-cascade 0.0.3+ exposes both events (via `emit` callback) and the
// `cascade` namespace for cascadeRebase. All v3 primitives are now reachable.
import type { GitCascadeConfig } from './config.js';
import { DEFAULT_GIT_CASCADE_CONFIG } from './config.js';

/**
 * Event types emitted by GitCascadeAdapter.
 *
 * Grouped by source:
 * - `stream:*` — from git-cascade `x-cascade/stream.*` events + local emits
 * - `worktree:*`, `task:*` — local emits (macro-agent-only concepts)
 * - `change:*` — change-id lifecycle from git-cascade
 * - `cascade:*` — cascadeRebase completion
 * - `conflict:*` — conflict lifecycle
 * - `mergeQueue:*` — built-in merge queue lifecycle
 */
export type GitCascadeEventType =
  | 'stream:created'        // mapped from git-cascade stream.opened
  | 'stream:updated'        // local (updateStream)
  | 'stream:forked'         // local (forkStream)
  | 'stream:committed'      // mapped from git-cascade stream.committed
  | 'stream:merged'         // mapped from git-cascade stream.merged
  | 'stream:conflicted'     // mapped from git-cascade stream.conflicted
  | 'stream:abandoned'      // mapped from git-cascade stream.abandoned
  | 'stream:paused'         // local (pauseStream)
  | 'stream:resumed'        // local (resumeStream)
  | 'worktree:created'
  | 'worktree:deallocated'
  | 'task:created'
  | 'task:started'
  | 'task:completed'
  | 'task:abandoned'
  | 'change:merged'
  | 'change:dropped'
  | 'cascade:rebased'       // mapped from git-cascade cascade.rebased
  | 'cascade:completed'     // mapped from git-cascade cascade.completed
  | 'conflict:created'
  | 'conflict:resolved'
  | 'mergeQueue:added'
  | 'mergeQueue:ready'
  | 'mergeQueue:cancelled'
  | 'mergeQueue:removed';

/**
 * Event payload for git-cascade events
 */
export interface GitCascadeEvent {
  type: GitCascadeEventType;
  timestamp: number;
  data: Record<string, unknown>;
}

/**
 * Callback for git-cascade events
 */
export type GitCascadeEventCallback = (event: GitCascadeEvent) => void;

/**
 * GitCascadeAdapter wraps MultiAgentRepoTracker for macro-agent integration.
 *
 * Key responsibilities:
 * - Initialize tracker with shared or dedicated database
 * - Emit events on tracker operations
 * - Provide simplified API for workspace management
 */
export class GitCascadeAdapter {
  private readonly tracker: MultiAgentRepoTracker;
  private readonly config: Required<
    Pick<GitCascadeConfig, 'enabled' | 'tablePrefix' | 'verbose' | 'skipRecovery'>
  > & { repoPath: string };
  private readonly eventListeners: Set<GitCascadeEventCallback> = new Set();
  private readonly ownsDb: boolean;

  /**
   * Create a new GitCascadeAdapter.
   *
   * @param config - git-cascade configuration
   */
  constructor(config: GitCascadeConfig) {
    const mergedConfig = {
      ...DEFAULT_GIT_CASCADE_CONFIG,
      ...config,
      repoPath: config.repoPath ?? process.cwd(),
    };

    this.config = {
      enabled: mergedConfig.enabled ?? true,
      repoPath: mergedConfig.repoPath,
      tablePrefix: mergedConfig.tablePrefix ?? 'git_cascade_',
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
      // Wire git-cascade's native event emitter (0.0.2+) so stream lifecycle
      // events are re-published through our own onEvent channel.
      emit: (method: string, params: unknown) => this.forwardCascadeEvent(method, params),
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
   * Get whether the adapter is enabled.
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
   * Subscribe to git-cascade events.
   *
   * @param callback - Function called when events occur
   * @returns Unsubscribe function
   */
  onEvent(callback: GitCascadeEventCallback): () => void {
    this.eventListeners.add(callback);
    return () => this.eventListeners.delete(callback);
  }

  /**
   * Emit an event to all listeners.
   */
  private emit(type: GitCascadeEventType, data: Record<string, unknown>): void {
    const event: GitCascadeEvent = {
      type,
      timestamp: Date.now(),
      data,
    };
    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch (error) {
        console.error('[GitCascadeAdapter] Event listener error:', error);
      }
    }
  }

  /**
   * Forward events emitted by git-cascade (`x-cascade/stream.*`) into our
   * structured `GitCascadeEvent` stream. Called via the `emit` callback wired
   * into the tracker constructor.
   *
   * Note: `stream.opened` is mapped to `stream:created`. The local
   * wrapper methods still emit their own events so consumers don't miss out
   * on operations that don't round-trip through git-cascade's emit (e.g.,
   * updateStream, pauseStream, mergeQueue events).
   */
  private forwardCascadeEvent(method: string, params: unknown): void {
    const suffix = matchCascadeSuffix(method);
    if (!suffix) return;

    switch (suffix) {
      case 'stream.opened': {
        const p = params as StreamOpenedParams;
        this.emit('stream:created', {
          streamId: p.stream_id,
          name: p.name,
          agentId: p.agent_id,
          baseCommit: p.base_commit,
          parentStream: p.parent_stream,
          branchName: p.branch_name,
          metadata: p.metadata,
        });
        break;
      }
      case 'stream.committed': {
        const p = params as StreamCommittedParams;
        this.emit('stream:committed', {
          streamId: p.stream_id,
          commit: p.commit_hash,
          changeId: p.change_id,
          agentId: p.agent_id,
          messageSummary: p.message_summary,
          filesTouched: p.files_touched,
          parentCommit: p.parent_commit,
          metadata: p.metadata,
        });
        break;
      }
      case 'stream.merged': {
        const p = params as StreamMergedParams;
        this.emit('stream:merged', {
          sourceStreamId: p.source_stream_id,
          targetStreamId: p.target_stream_id,
          mergeCommit: p.merge_commit,
          agentId: p.agent_id,
          strategy: p.strategy,
          sourceCommit: p.source_commit,
          metadata: p.metadata,
        });
        break;
      }
      case 'stream.conflicted': {
        const p = params as StreamConflictedParams;
        this.emit('stream:conflicted', {
          streamId: p.stream_id,
          conflictId: p.conflict_id,
          conflictedFiles: p.conflicted_files,
          agentId: p.agent_id,
          conflictingCommit: p.conflicting_commit,
          targetCommit: p.target_commit,
          source: p.source,
          metadata: p.metadata,
        });
        break;
      }
      case 'stream.abandoned': {
        const p = params as StreamAbandonedParams;
        this.emit('stream:abandoned', {
          streamId: p.stream_id,
          reason: p.reason,
          cascade: p.cascade,
          metadata: p.metadata,
        });
        break;
      }
      case 'cascade.rebased': {
        const p = params as CascadeRebasedParams;
        this.emit('cascade:rebased', {
          streamId: p.stream_id,
          agentId: p.agent_id,
          triggeredByStreamId: p.triggered_by_stream_id,
          triggeredByAgentId: p.triggered_by_agent_id,
          newBaseCommit: p.new_base_commit,
          newHead: p.new_head,
          newCommits: p.new_commits,
          metadata: p.metadata,
        });
        break;
      }
      case 'cascade.completed': {
        const p = params as CascadeCompletedParams;
        this.emit('cascade:completed', {
          rootStreamId: p.root_stream_id,
          agentId: p.agent_id,
          strategy: p.strategy,
          updatedStreams: p.updated_streams,
          failedStreams: p.failed_streams,
          skippedStreams: p.skipped_streams,
          deferredStreams: p.deferred_streams,
          metadata: p.metadata,
        });
        break;
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Stream Operations
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Create a new stream (integration branch).
   *
   * Note: `stream:created` is emitted by the cascade event forwarder via
   * git-cascade's `x-cascade/stream.opened`. We don't double-emit here.
   *
   * @param options - Stream creation options
   * @returns Stream ID
   */
  createStream(options: CreateStreamOptions): string {
    return this.tracker.createStream(options);
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
   *
   * Note: `stream:abandoned` is emitted by the cascade event forwarder.
   */
  abandonStream(
    streamId: string,
    options?: { reason?: string; cascade?: boolean }
  ): void {
    this.tracker.abandonStream(streamId, options);
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

  /**
   * Fork a child stream off a parent.
   */
  forkStream(options: ForkStreamOptions): string {
    const streamId = this.tracker.forkStream(options);
    this.emit('stream:forked', {
      streamId,
      parentStreamId: options.parentStreamId,
      name: options.name,
      agentId: options.agentId,
    });
    return streamId;
  }

  /**
   * Merge source stream into target stream.
   *
   * Note: `stream:merged` is emitted by the cascade event forwarder on success.
   * On conflict, `stream:conflicted` is also forwarded.
   */
  mergeStream(options: MergeStreamOptions): MergeResult {
    return this.tracker.mergeStream(options);
  }

  /**
   * Rebase a stream onto its parent to pick up new commits.
   */
  syncWithParent(
    streamId: string,
    agentId: string,
    worktree: string,
    onConflict?: ConflictStrategy
  ): RebaseResult {
    return this.tracker.syncWithParent(streamId, agentId, worktree, onConflict);
  }

  /**
   * Rebase a stream onto a specific target stream.
   */
  rebaseOntoStream(options: RebaseOntoStreamOptions): RebaseResult {
    return this.tracker.rebaseOntoStream(options);
  }

  /**
   * Async version of rebaseOntoStream — supports async conflict handlers.
   */
  rebaseOntoStreamAsync(options: RebaseOntoStreamOptions): Promise<RebaseResult> {
    return this.tracker.rebaseOntoStreamAsync(options);
  }

  /**
   * Pause a stream (halt work without abandoning).
   */
  pauseStream(streamId: string, reason?: string): void {
    this.tracker.pauseStream(streamId, reason);
    this.emit('stream:paused', { streamId, reason });
  }

  /**
   * Resume a paused stream.
   */
  resumeStream(streamId: string): void {
    this.tracker.resumeStream(streamId);
    this.emit('stream:resumed', { streamId });
  }

  /**
   * Track an existing branch as a stream (local mode — no new `stream/<id>` branch).
   */
  trackExistingBranch(options: Parameters<MultiAgentRepoTracker['trackExistingBranch']>[0]): string {
    return this.tracker.trackExistingBranch(options);
  }

  /**
   * Get stream hierarchy as a tree.
   */
  getStreamHierarchy(rootStreamId?: string): StreamNode | StreamNode[] {
    return this.tracker.getStreamHierarchy(rootStreamId);
  }

  /**
   * Get child streams (direct children only).
   */
  getChildStreams(streamId: string): Stream[] {
    return this.tracker.getChildStreams(streamId);
  }

  /**
   * Find the common ancestor of two streams.
   */
  findCommonAncestor(streamIdA: string, streamIdB: string): string {
    return this.tracker.findCommonAncestor(streamIdA, streamIdB);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Stream Dependencies
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Declare that one stream depends on another.
   */
  addDependency(streamId: string, dependsOnId: string): void {
    this.tracker.addDependency(streamId, dependsOnId);
  }

  /**
   * Remove a dependency declaration.
   */
  removeDependency(streamId: string, dependsOnId: string): void {
    this.tracker.removeDependency(streamId, dependsOnId);
  }

  /**
   * Get direct dependencies of a stream.
   */
  getDependencies(streamId: string): string[] {
    return this.tracker.getDependencies(streamId);
  }

  /**
   * Get direct dependents of a stream.
   */
  getDependents(streamId: string): string[] {
    return this.tracker.getDependents(streamId);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Cascade Rebase (git-cascade 0.0.3+)
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Cascade-rebase all dependents of a root stream.
   *
   * Propagates rebases through the dependency graph. Uses a callback-based
   * worktree provider so not every dependent needs a pre-allocated worktree.
   *
   * @param options - Cascade options including root stream, agent id, and worktree provider
   * @returns CascadeResult with updated/failed/skipped stream lists
   */
  cascadeRebase(
    options: cascadeModule.CascadeRebaseOptions
  ): ReturnType<typeof cascadeModule.cascadeRebase> {
    // Use tracker.cascadeRebase which threads the tracker's emit + eventPrefix
    // into the cascade walk so `cascade.rebased` (per dependent) and
    // `cascade.completed` (at end) both round-trip through our
    // forwardCascadeEvent. No manual emit needed — events are driven by
    // git-cascade 0.0.4+ from inside the walk.
    return this.tracker.cascadeRebase(options);
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
      console.warn(`[GitCascadeAdapter] Task not found: ${taskId}`);
      return [];
    }

    if (!task.streamId) {
      console.warn(`[GitCascadeAdapter] Task ${taskId} has no streamId`);
      return [];
    }

    if (!task.startCommit) {
      console.warn(`[GitCascadeAdapter] Task ${taskId} has no startCommit`);
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
        `[GitCascadeAdapter] Failed to create checkpoints for task ${taskId}:`,
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
    /**
     * Optional metadata threaded verbatim to git-cascade's
     * `x-cascade/stream.committed` event. Use `{ task_ref: { resource_id,
     * node_id } }` to bind this commit to an external task (see
     * `SpawnAgentOptions.taskRef`). Each commit can carry a distinct ref —
     * useful for workers handling multiple sub-tasks within one session.
     */
    metadata?: Record<string, unknown>;
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
  // Change Operations (Change-Id tracking)
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Get a change by ID.
   */
  getChange(changeId: string): Change | null {
    return this.tracker.getChange(changeId);
  }

  /**
   * Get a change by its current commit hash.
   */
  getChangeByCommit(commit: string): Change | null {
    return this.tracker.getChangeByCommit(commit);
  }

  /**
   * Get a change by any of its historical commit hashes (survives rebases).
   */
  getChangeByHistoricalCommit(commit: string): Change | null {
    return this.tracker.getChangeByHistoricalCommit(commit);
  }

  /**
   * List changes for a stream, optionally filtered by status.
   */
  getChangesForStream(
    streamId: string,
    options?: { status?: ChangeStatus }
  ): Change[] {
    return this.tracker.getChangesForStream(streamId, options);
  }

  /**
   * Mark changes as merged.
   */
  markChangesMerged(changeIds: string[]): void {
    this.tracker.markChangesMerged(changeIds);
    for (const id of changeIds) {
      this.emit('change:merged', { changeId: id });
    }
  }

  /**
   * Mark a single change as dropped.
   */
  markChangeDropped(changeId: string): void {
    this.tracker.markChangeDropped(changeId);
    this.emit('change:dropped', { changeId });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Merge Queue (git-cascade built-in)
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Add a stream to the merge queue.
   */
  addToMergeQueue(options: mergeQueueModule.AddToQueueOptions): string {
    const entryId = this.tracker.addToMergeQueue(options);
    this.emit('mergeQueue:added', {
      entryId,
      streamId: options.streamId,
      targetBranch: options.targetBranch ?? 'main',
    });
    return entryId;
  }

  /**
   * Get a merge queue entry by id.
   */
  getMergeQueueEntry(entryId: string): mergeQueueModule.MergeQueueEntry | null {
    return this.tracker.getMergeQueueEntry(entryId);
  }

  /**
   * List merge queue entries with optional filters.
   */
  listMergeQueue(
    options?: {
      targetBranch?: string;
      status?: mergeQueueModule.MergeQueueStatus | mergeQueueModule.MergeQueueStatus[];
    }
  ): mergeQueueModule.MergeQueueEntry[] {
    return this.tracker.getMergeQueue(options);
  }

  /**
   * Mark a queue entry as ready to merge.
   */
  markMergeQueueReady(entryId: string): void {
    this.tracker.markMergeQueueReady(entryId);
    this.emit('mergeQueue:ready', { entryId });
  }

  /**
   * Cancel a queue entry.
   */
  cancelMergeQueueEntry(entryId: string): void {
    this.tracker.cancelMergeQueueEntry(entryId);
    this.emit('mergeQueue:cancelled', { entryId });
  }

  /**
   * Remove a queue entry.
   */
  removeFromMergeQueue(entryId: string): void {
    this.tracker.removeFromMergeQueue(entryId);
    this.emit('mergeQueue:removed', { entryId });
  }

  /**
   * Get the next entry to process for a target branch.
   */
  getNextToMerge(targetBranch?: string): mergeQueueModule.MergeQueueEntry | null {
    return this.tracker.getNextToMerge(targetBranch);
  }

  /**
   * Process the merge queue — drains ready entries per provided handler.
   */
  processMergeQueue(
    options: mergeQueueModule.ProcessQueueOptions
  ): mergeQueueModule.ProcessQueueResult {
    return this.tracker.processMergeQueue(options);
  }

  /**
   * Get a stream's position in the queue (lower = sooner).
   */
  getMergeQueuePosition(streamId: string, targetBranch?: string): number | null {
    return this.tracker.getMergeQueuePosition(streamId, targetBranch);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Conflict Operations
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Create a conflict record.
   *
   * Usually conflicts are created implicitly by merge/rebase operations.
   * This is for explicit creation (e.g., an external process detected a
   * conflict that git-cascade didn't).
   */
  createConflict(options: CreateConflictOptions): string {
    const id = this.tracker.createConflict(options);
    this.emit('conflict:created', {
      conflictId: id,
      streamId: options.streamId,
    });
    return id;
  }

  /**
   * Get a conflict record by id.
   */
  getConflict(conflictId: string): ConflictRecord | null {
    return this.tracker.getConflict(conflictId);
  }

  /**
   * Get the active conflict record for a stream, if any.
   */
  getConflictForStream(streamId: string): ConflictRecord | null {
    return this.tracker.getConflictForStream(streamId);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Reconciliation
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Check if a stream's database state is in sync with its git branch.
   */
  checkStreamSync(streamId: string): reconcileModule.StreamSyncStatus {
    return this.tracker.checkStreamSync(streamId);
  }

  /**
   * Check all active streams for sync status.
   */
  checkAllStreamsSync(
    options?: { streamIds?: string[] }
  ): reconcileModule.ReconcileCheckResult {
    return this.tracker.checkAllStreamsSync(options);
  }

  /**
   * Reconcile database state with git state. Fixes missing branches, resets
   * diverged HEAD (per options), etc. Does NOT handle orphan worktrees — the
   * macro-agent-level reconcile wrapper covers that.
   */
  reconcile(
    options?: reconcileModule.ReconcileOptions
  ): reconcileModule.ReconcileResult {
    return this.tracker.reconcile(options);
  }

  /**
   * Ensure a stream is in sync before performing an operation.
   * @throws DesyncError if out of sync unless `force: true`.
   */
  ensureStreamInSync(streamId: string, options?: { force?: boolean }): void {
    this.tracker.ensureStreamInSync(streamId, options);
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
 * Create a GitCascadeAdapter instance.
 *
 * @param config - Configuration options
 * @returns GitCascadeAdapter instance
 */
export function createGitCascadeAdapter(config: GitCascadeConfig): GitCascadeAdapter {
  return new GitCascadeAdapter(config);
}
