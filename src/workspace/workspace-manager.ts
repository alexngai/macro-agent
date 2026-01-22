/**
 * WorkspaceManager Implementation
 *
 * Bridges macro-agent roles to dataplane streams and worktrees.
 * Provides a higher-level API for workspace management.
 *
 * @module workspace/workspace-manager
 * @implements [[s-7ktd]] WorkspaceManager API section
 */

import type { Stream, WorkerTask, StartTaskResult, AgentWorktree, CleanupWorkerBranchesOptions, CleanupResult } from 'dataplane';
import { DataplaneAdapter } from './dataplane-adapter.js';
import type { DataplaneConfig } from './config.js';
import type {
  AgentId,
  StreamId,
  TaskId,
  Workspace,
  WorkerWorkspace,
  IntegratorWorkspace,
  CoordinatorWorkspace,
  WorkspaceManager,
  StreamConfig,
  CreateTaskOptions,
  WorkspaceEvent,
  WorkspaceEventCallback,
} from './types.js';
import type { MergeQueueInterface } from './merge-queue/types.js';
import { MergeQueue } from './merge-queue/merge-queue.js';

/**
 * Configuration options for DefaultWorkspaceManager.
 */
export interface WorkspaceManagerConfig extends DataplaneConfig {
  /**
   * Base directory for worktrees.
   * Defaults to `<repoPath>/.worktrees`.
   */
  worktreeBaseDir?: string;
}

/**
 * DefaultWorkspaceManager implements the WorkspaceManager interface.
 *
 * Responsibilities:
 * - Wraps DataplaneAdapter for stream/worktree operations
 * - Maintains agentId → workspace mappings
 * - Emits events on workspace lifecycle changes
 *
 * @see [[s-7ktd]] WorkspaceManager section
 */
export class DefaultWorkspaceManager implements WorkspaceManager {
  private readonly adapter: DataplaneAdapter;
  private readonly config: Required<Pick<WorkspaceManagerConfig, 'worktreeBaseDir'>>;
  private readonly workspaces: Map<AgentId, Workspace> = new Map();
  private readonly agentToStream: Map<AgentId, StreamId> = new Map();
  private readonly eventListeners: Set<WorkspaceEventCallback> = new Set();
  private mergeQueue: MergeQueue | null = null;

  /**
   * Create a new DefaultWorkspaceManager.
   *
   * @param adapter - DataplaneAdapter instance
   * @param config - Configuration options
   */
  constructor(adapter: DataplaneAdapter, config?: Partial<WorkspaceManagerConfig>) {
    this.adapter = adapter;
    this.config = {
      worktreeBaseDir: config?.worktreeBaseDir ?? `${adapter.repoPath}/.worktrees`,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Event System
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Subscribe to workspace events.
   *
   * @param callback - Function called when events occur
   * @returns Unsubscribe function
   */
  onEvent(callback: WorkspaceEventCallback): () => void {
    this.eventListeners.add(callback);
    return () => this.eventListeners.delete(callback);
  }

  /**
   * Emit an event to all listeners.
   */
  private emit(
    type: WorkspaceEvent['type'],
    data: Record<string, unknown>
  ): void {
    const event: WorkspaceEvent = {
      type,
      timestamp: Date.now(),
      data,
    };
    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch (error) {
        console.error('[WorkspaceManager] Event listener error:', error);
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Stream Management
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Create an integration stream for a coordinator.
   *
   * @param coordinatorId - ID of the coordinator agent
   * @param config - Stream configuration
   * @returns Stream ID
   */
  createIntegrationStream(coordinatorId: AgentId, config: StreamConfig): StreamId {
    const streamId = this.adapter.createStream({
      name: config.name,
      agentId: coordinatorId,
      base: config.forkFrom ?? 'main',
      metadata: config.metadata,
    });

    // Track agent → stream mapping
    this.agentToStream.set(coordinatorId, streamId);

    return streamId;
  }

  /**
   * Get a stream by ID.
   *
   * @param streamId - Stream ID
   * @returns Stream or null if not found
   */
  getStream(streamId: StreamId): Stream | null {
    return this.adapter.getStream(streamId);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Worktree Management
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Create a workspace for a worker agent.
   *
   * Workers get isolated worktrees with task-specific branches.
   * Branch format: worker/<agentId>/<taskId>@<timestamp>
   *
   * @param workerId - ID of the worker agent
   * @param taskId - ID of the task to work on
   * @param streamId - ID of the integration stream
   * @returns Worker workspace
   */
  createWorkerWorkspace(
    workerId: AgentId,
    taskId: TaskId,
    streamId: StreamId
  ): WorkerWorkspace {
    const stream = this.adapter.getStream(streamId);
    if (!stream) {
      throw new Error(`Stream ${streamId} not found`);
    }

    // Build worktree path
    const worktreePath = this.buildWorktreePath('worker', workerId);

    // Create worktree at the stream's base commit
    const worktree = this.adapter.createWorktree({
      agentId: workerId,
      path: worktreePath,
      branch: this.adapter.getStreamBranchName(streamId),
    });

    // Create workspace record
    const workspace: WorkerWorkspace = {
      agentId: workerId,
      path: worktree.path,
      branch: worktree.currentStream
        ? `stream/${worktree.currentStream}`
        : 'unknown',
      streamId,
      role: 'worker',
      createdAt: worktree.createdAt,
      taskId,
      baseBranch: stream.baseCommit,
    };

    // Store workspace
    this.workspaces.set(workerId, workspace);
    this.agentToStream.set(workerId, streamId);

    // Emit event
    this.emit('workspace:created', {
      agentId: workerId,
      role: 'worker',
      streamId,
      taskId,
      path: worktreePath,
    });

    return workspace;
  }

  /**
   * Create a workspace for an integrator agent.
   *
   * Integrators get worktrees on a merge branch for processing the merge queue.
   * Branch format: integrator/<coordinatorId>@<timestamp>
   *
   * @param integratorId - ID of the integrator agent
   * @param streamId - ID of the integration stream
   * @returns Integrator workspace
   */
  createIntegratorWorkspace(
    integratorId: AgentId,
    streamId: StreamId
  ): IntegratorWorkspace {
    const stream = this.adapter.getStream(streamId);
    if (!stream) {
      throw new Error(`Stream ${streamId} not found`);
    }

    // Build worktree path
    const worktreePath = this.buildWorktreePath('integrator', integratorId);

    // Integrator works on the stream branch directly
    const worktree = this.adapter.createWorktree({
      agentId: integratorId,
      path: worktreePath,
      branch: this.adapter.getStreamBranchName(streamId),
    });

    // Create workspace record
    const workspace: IntegratorWorkspace = {
      agentId: integratorId,
      path: worktree.path,
      branch: this.adapter.getStreamBranchName(streamId),
      streamId,
      role: 'integrator',
      createdAt: worktree.createdAt,
      coordinatorId: stream.agentId,
      integrationBranch: this.adapter.getStreamBranchName(streamId),
    };

    // Store workspace
    this.workspaces.set(integratorId, workspace);
    this.agentToStream.set(integratorId, streamId);

    // Emit event
    this.emit('workspace:created', {
      agentId: integratorId,
      role: 'integrator',
      streamId,
      coordinatorId: stream.agentId,
      path: worktreePath,
    });

    return workspace;
  }

  /**
   * Create a workspace for a coordinator agent.
   *
   * Coordinators get worktrees on the integration branch.
   * Branch format: feature/<name>-<coordinatorId> (via stream)
   *
   * @param coordinatorId - ID of the coordinator agent
   * @param streamId - ID of the integration stream
   * @returns Coordinator workspace
   */
  createCoordinatorWorkspace(
    coordinatorId: AgentId,
    streamId: StreamId
  ): CoordinatorWorkspace {
    const stream = this.adapter.getStream(streamId);
    if (!stream) {
      throw new Error(`Stream ${streamId} not found`);
    }

    // Build worktree path
    const worktreePath = this.buildWorktreePath('coordinator', coordinatorId);

    // Coordinator works on the stream branch
    const worktree = this.adapter.createWorktree({
      agentId: coordinatorId,
      path: worktreePath,
      branch: this.adapter.getStreamBranchName(streamId),
    });

    // Create workspace record
    const workspace: CoordinatorWorkspace = {
      agentId: coordinatorId,
      path: worktree.path,
      branch: this.adapter.getStreamBranchName(streamId),
      streamId,
      role: 'coordinator',
      createdAt: worktree.createdAt,
      childWorkspacePaths: new Map(),
    };

    // Store workspace
    this.workspaces.set(coordinatorId, workspace);
    this.agentToStream.set(coordinatorId, streamId);

    // Emit event
    this.emit('workspace:created', {
      agentId: coordinatorId,
      role: 'coordinator',
      streamId,
      path: worktreePath,
    });

    return workspace;
  }

  /**
   * Deallocate a workspace and release resources.
   *
   * @param agentId - ID of the agent whose workspace to deallocate
   */
  deallocateWorkspace(agentId: AgentId): void {
    const workspace = this.workspaces.get(agentId);
    if (!workspace) {
      return; // Already deallocated
    }

    // Remove from coordinator's child workspace map if this is a child
    if (workspace.role === 'worker' || workspace.role === 'integrator') {
      const streamId = workspace.streamId;
      const stream = this.adapter.getStream(streamId);
      if (stream) {
        const coordinatorWorkspace = this.workspaces.get(
          stream.agentId
        ) as CoordinatorWorkspace | undefined;
        coordinatorWorkspace?.childWorkspacePaths?.delete(agentId);
      }
    }

    // Deallocate via dataplane
    this.adapter.deallocateWorktree(agentId);

    // Clean up mappings
    this.workspaces.delete(agentId);
    this.agentToStream.delete(agentId);

    // Emit event
    this.emit('workspace:deallocated', {
      agentId,
      role: workspace.role,
      streamId: workspace.streamId,
    });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Task Management
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Create a task under a stream.
   *
   * @param streamId - ID of the integration stream
   * @param options - Task creation options
   * @returns Task ID
   */
  createTask(streamId: StreamId, options: CreateTaskOptions): TaskId {
    return this.adapter.createTask({
      streamId,
      title: options.title,
      priority: options.priority,
      metadata: options.metadata,
    });
  }

  /**
   * Claim a task for a worker.
   *
   * Starts the task - creates worker branch and checks it out.
   *
   * @param taskId - ID of the task to claim
   * @param workerId - ID of the worker agent
   * @param worktree - Path to the worker's worktree
   * @returns Start task result with branch info
   */
  claimTask(
    taskId: TaskId,
    workerId: AgentId,
    worktree: string
  ): StartTaskResult {
    return this.adapter.startTask({
      taskId,
      agentId: workerId,
      worktree,
    });
  }

  /**
   * Get the next available task for a stream.
   *
   * Returns the highest priority (lowest number), oldest task with status 'open'.
   *
   * @param streamId - ID of the integration stream
   * @returns Next task or null if none available
   */
  getNextTask(streamId: StreamId): WorkerTask | null {
    const tasks = this.adapter.listTasks(streamId, { status: 'open' });
    return tasks.length > 0 ? tasks[0] : null;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Queries
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Get workspace for an agent.
   *
   * @param agentId - ID of the agent
   * @returns Workspace or null if not found
   */
  getWorkspace(agentId: AgentId): Workspace | null {
    return this.workspaces.get(agentId) ?? null;
  }

  /**
   * Get the stream ID for an agent.
   *
   * @param agentId - ID of the agent
   * @returns Stream ID or null if not found
   */
  getStreamForAgent(agentId: AgentId): StreamId | null {
    return this.agentToStream.get(agentId) ?? null;
  }

  /**
   * Register a child workspace path with a coordinator.
   *
   * @param coordinatorId - ID of the coordinator
   * @param childId - ID of the child agent
   * @param childPath - Filesystem path to child's workspace
   */
  registerChildWorkspace(
    coordinatorId: AgentId,
    childId: AgentId,
    childPath: string
  ): void {
    const workspace = this.workspaces.get(coordinatorId) as
      | CoordinatorWorkspace
      | undefined;
    if (!workspace || workspace.role !== 'coordinator') {
      throw new Error(`No coordinator workspace found for ${coordinatorId}`);
    }

    workspace.childWorkspacePaths.set(childId, childPath);

    // Emit event
    this.emit('child:registered', {
      coordinatorId,
      childId,
      childPath,
    });
  }

  /**
   * Get the underlying DataplaneAdapter.
   *
   * Use with caution - prefer manager methods for operations.
   */
  get rawAdapter(): DataplaneAdapter {
    return this.adapter;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Merge Queue
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Get the merge queue for coordinating worker merges.
   *
   * The merge queue is lazily initialized on first access and uses
   * the same database as the dataplane adapter.
   *
   * @returns MergeQueue instance
   */
  getMergeQueue(): MergeQueueInterface {
    if (!this.mergeQueue) {
      this.mergeQueue = new MergeQueue({
        db: this.adapter.db,
        tablePrefix: 'macro_',  // Use different prefix from dataplane tables
        initSchema: true,
      });
    }
    return this.mergeQueue;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Maintenance / Cleanup
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
    const result = this.adapter.cleanupWorkerBranches(options);

    // Emit event if any branches were deleted
    if (result.deleted.length > 0) {
      this.emit('branches:cleaned', {
        deleted: result.deleted,
        errors: result.errors,
      });
    }

    return result;
  }

  /**
   * Delete a specific worker branch.
   *
   * Useful for immediate cleanup after task completion.
   *
   * @param branchName - Branch name to delete
   * @returns true if deleted, false if branch didn't exist
   */
  deleteWorkerBranch(branchName: string): boolean {
    const result = this.adapter.deleteWorkerBranch(branchName);

    if (result) {
      this.emit('branch:deleted', { branchName });
    }

    return result;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Close the workspace manager and release resources.
   */
  close(): void {
    this.eventListeners.clear();
    this.workspaces.clear();
    this.agentToStream.clear();
    // Close merge queue if it was initialized
    if (this.mergeQueue) {
      this.mergeQueue.close();
      this.mergeQueue = null;
    }
    // Note: We don't close the adapter here since it may be shared
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Private Helpers
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Build a worktree path for an agent.
   *
   * @param role - Agent role
   * @param agentId - Agent ID
   * @returns Worktree path
   */
  private buildWorktreePath(
    role: 'worker' | 'integrator' | 'coordinator',
    agentId: AgentId
  ): string {
    // Use a short identifier to keep paths manageable
    const shortId = agentId.slice(0, 8);
    return `${this.config.worktreeBaseDir}/${role}-${shortId}`;
  }
}

/**
 * Create a WorkspaceManager instance.
 *
 * @param config - Configuration options
 * @returns WorkspaceManager instance
 */
export function createWorkspaceManager(
  config: WorkspaceManagerConfig
): DefaultWorkspaceManager {
  const adapter = new DataplaneAdapter(config);
  return new DefaultWorkspaceManager(adapter, config);
}

/**
 * Create a WorkspaceManager with an existing DataplaneAdapter.
 *
 * @param adapter - DataplaneAdapter instance
 * @param config - Configuration options
 * @returns WorkspaceManager instance
 */
export function createWorkspaceManagerWithAdapter(
  adapter: DataplaneAdapter,
  config?: Partial<WorkspaceManagerConfig>
): DefaultWorkspaceManager {
  return new DefaultWorkspaceManager(adapter, config);
}
