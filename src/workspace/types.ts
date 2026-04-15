/**
 * Workspace Types
 *
 * Types for workspace management, including Workspace, StreamConfig,
 * and related interfaces for the WorkspaceManager.
 *
 * @module workspace/types
 * @implements [[s-7ktd]] Workspace types section
 */

import type { Stream, WorkerTask, StartTaskResult } from 'git-cascade';
import type { MergeQueueInterface } from './merge-queue/types.js';

/**
 * Agent identifier type
 */
export type AgentId = string;

/**
 * Stream identifier type
 */
export type StreamId = string;

/**
 * Task identifier type
 */
export type TaskId = string;

/**
 * Agent role types that require workspaces
 */
export type WorkspaceRole = 'worker' | 'integrator' | 'coordinator' | 'v3';

/**
 * Workspace represents an isolated git worktree assigned to an agent.
 *
 * @see [[s-7ktd]] Workspace by Role section
 */
export interface Workspace {
  /** Agent that owns this workspace */
  agentId: AgentId;

  /** Filesystem path to the worktree */
  path: string;

  /** Branch name in the worktree */
  branch: string;

  /** Stream (integration branch) this workspace belongs to */
  streamId: StreamId;

  /** Role of the agent using this workspace */
  role: WorkspaceRole;

  /** Timestamp when workspace was created */
  createdAt: number;
}

/**
 * Worker-specific workspace with task information.
 *
 * @see [[s-7ktd]] Worker Workspace section
 */
export interface WorkerWorkspace extends Workspace {
  role: 'worker';

  /** Task assigned to this worker */
  taskId: TaskId;

  /** Base branch the worker branched from */
  baseBranch: string;
}

/**
 * Integrator-specific workspace for merge processing.
 *
 * @see [[s-7ktd]] Integrator Workspace section
 */
export interface IntegratorWorkspace extends Workspace {
  role: 'integrator';

  /** Coordinator this integrator serves */
  coordinatorId: AgentId;

  /** Target integration branch for merges */
  integrationBranch: string;
}

/**
 * Coordinator-specific workspace on the integration branch.
 *
 * @see [[s-7ktd]] Coordinator Workspace section
 */
export interface CoordinatorWorkspace extends Workspace {
  role: 'coordinator';

  /** Paths to child workspaces for visibility */
  childWorkspacePaths: Map<AgentId, string>;
}

/**
 * Configuration for creating an integration stream.
 */
export interface StreamConfig {
  /** Name for the stream (used in branch naming) */
  name: string;

  /** Branch to fork from (default: 'main') */
  forkFrom?: string;

  /** Optional metadata to attach to the stream */
  metadata?: Record<string, unknown>;
}

/**
 * Options for creating a task.
 */
export interface CreateTaskOptions {
  /** Title/description of the task */
  title: string;

  /** Priority level (lower = higher priority) */
  priority?: number;

  /** Optional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Workspace status for cleanup readiness checks.
 *
 * @see [[s-7ktd]] Workspace Status section
 */
export interface WorkspaceStatus {
  /** Current branch name */
  branch: string;

  /** Whether workspace is ready for cleanup */
  cleanupStatus: CleanupStatus;

  /** List of uncommitted files */
  uncommittedFiles: string[];

  /** Number of commits not pushed */
  unpushedCommits: number;

  /** Last activity timestamp */
  lastActivityAt: Date;
}

/**
 * Cleanup status for a workspace.
 */
export interface CleanupStatus {
  /** Whether the workspace is ready for cleanup */
  ready: boolean;

  /** Reason if not ready for cleanup */
  reason?: string;
}

/**
 * WorkspaceManager interface for managing agent workspaces.
 *
 * Bridges macro-agent roles to git-cascade streams and worktrees.
 *
 * @see [[s-7ktd]] WorkspaceManager API section
 */
export interface WorkspaceManager {
  // ─────────────────────────────────────────────────────────────────────────────
  // Stream Management (role-shaped; coexists with V3 stream-first surface below)
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Create an integration stream for a coordinator.
   *
   * Role-shaped convenience method. For stream-first semantics (fork from
   * another stream, pseudo-principal ownership, richer metadata), prefer
   * `createStreamV3({ name, ownerId, forkFrom, parent?, metadata? })`.
   *
   * @param coordinatorId - ID of the coordinator agent
   * @param config - Stream configuration
   * @returns Stream ID
   */
  createIntegrationStream(coordinatorId: AgentId, config: StreamConfig): StreamId;

  /**
   * Get a stream by ID.
   *
   * @param streamId - Stream ID
   * @returns Stream or null if not found
   */
  getStream(streamId: StreamId): Stream | null;

  // ─────────────────────────────────────────────────────────────────────────────
  // Worktree Management (role-shaped; V3 `allocateWorktree` is role-neutral)
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Create a workspace for a worker agent.
   *
   * Role-shaped convenience. For role-neutral allocation, prefer
   * `allocateWorktree({ agentId, streamId })`.
   */
  createWorkerWorkspace(
    workerId: AgentId,
    taskId: TaskId,
    streamId: StreamId
  ): WorkerWorkspace;

  /**
   * Create a workspace for an integrator agent.
   *
   * Role-shaped convenience. For role-neutral allocation, prefer
   * `allocateWorktree({ agentId, streamId })`.
   */
  createIntegratorWorkspace(
    integratorId: AgentId,
    streamId: StreamId
  ): IntegratorWorkspace;

  /**
   * Create a workspace for a coordinator agent.
   *
   * Role-shaped convenience. For role-neutral allocation, prefer
   * `allocateWorktree({ agentId, streamId })`.
   */
  createCoordinatorWorkspace(
    coordinatorId: AgentId,
    streamId: StreamId
  ): CoordinatorWorkspace;

  /**
   * Deallocate a workspace and release resources.
   *
   * @param agentId - ID of the agent whose workspace to deallocate
   */
  deallocateWorkspace(agentId: AgentId): void;

  // ─────────────────────────────────────────────────────────────────────────────
  // Task Management (LEGACY — git-cascade task semantics; not used by V3)
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Create a task under a stream.
   *
   * @deprecated V3 does not use git-cascade's `workerTasks` layer for
   *   task tracking; use opentasks via `TasksAdapter` instead. This method
   *   exists only for the legacy capability-based dispatch path.
   * @param streamId - ID of the integration stream
   * @param options - Task creation options
   * @returns Task ID
   */
  createTask(streamId: StreamId, options: CreateTaskOptions): TaskId;

  /**
   * Claim a task for a worker.
   *
   * @deprecated See `createTask` — V3 uses opentasks. This method cuts the
   *   git-cascade worker branch via `startTask`; V3 equivalent is
   *   `allocateWorktree({ agentId, streamId })` + `commitChanges` on the
   *   stream branch directly.
   * @param taskId - ID of the task to claim
   * @param workerId - ID of the worker agent
   * @param worktree - Path to the worker's worktree
   * @returns Start task result with branch info
   */
  claimTask(taskId: TaskId, workerId: AgentId, worktree: string): StartTaskResult;

  /**
   * Get the next available task for a stream.
   *
   * @deprecated Use opentasks for task queueing; git-cascade's worker task
   *   layer is redundant in V3.
   * @param streamId - ID of the integration stream
   * @returns Next task or null if none available
   */
  getNextTask(streamId: StreamId): WorkerTask | null;

  // ─────────────────────────────────────────────────────────────────────────────
  // Queries
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Get workspace for an agent.
   *
   * @param agentId - ID of the agent
   * @returns Workspace or null if not found
   */
  getWorkspace(agentId: AgentId): Workspace | null;

  /**
   * Get the stream ID for an agent.
   *
   * @param agentId - ID of the agent
   * @returns Stream ID or null if not found
   */
  getStreamForAgent(agentId: AgentId): StreamId | null;

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
  ): void;

  // ─────────────────────────────────────────────────────────────────────────────
  // Merge Queue
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Get the merge queue for coordinating worker merges.
   *
   * @deprecated Use git-cascade's built-in queue via the V3 surface —
   *   `workspaceManager.addToMergeQueue` (when exposed) or the
   *   `queue-to-branch` `LandingStrategy`. This method returns the legacy
   *   macro-agent MergeQueue that duplicates git-cascade's schema; kept for
   *   legacy callers until teams migrate to `macro_agent.workspace` YAML.
   *
   * @returns Legacy MergeQueue instance (duplicate of git-cascade's queue)
   */
  getMergeQueue(): MergeQueueInterface;

  // ─────────────────────────────────────────────────────────────────────────────
  // V3 — Stream-first surface (additive; coexists with role-shaped methods above)
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Create a new stream. Stream-first equivalent of `createIntegrationStream`;
   * does not require a coordinator owner — any `Principal` (including pseudo
   * principals like `team:<name>`) can own.
   *
   * @see docs/workspace-interfaces.md §5
   */
  createStreamV3(spec: import('./types-v3.js').StreamSpec): StreamId;

  /**
   * Fork a child stream from a parent. Enables stacking workflows (solo stack,
   * long-lived feature + subtasks).
   */
  forkStream(opts: {
    parentStreamId: StreamId;
    name: string;
    ownerId: import('./types-v3.js').Principal;
    metadata?: Record<string, unknown>;
  }): StreamId;

  /**
   * Merge a source stream into a target stream.
   */
  mergeStream(opts: {
    sourceStreamId: StreamId;
    targetStreamId: StreamId;
    agentId: import('./types-v3.js').Principal;
    worktree: string;
  }): import('./types-v3.js').MergeResult;

  /**
   * Rebase a stream onto its parent.
   */
  syncWithParent(opts: {
    streamId: StreamId;
    agentId: import('./types-v3.js').Principal;
    worktree: string;
    onConflict?: import('./types-v3.js').ConflictStrategy;
  }): import('./types-v3.js').RebaseResult;

  /**
   * Lifecycle transitions for streams.
   */
  abandonStream(streamId: StreamId, opts?: { cascade?: boolean; reason?: string }): void;
  pauseStream(streamId: StreamId, reason?: string): void;
  resumeStream(streamId: StreamId): void;

  /**
   * Stream queries.
   */
  listStreams(filter?: {
    ownerId?: import('./types-v3.js').Principal;
    status?: import('./types-v3.js').Stream['status'];
  }): import('./types-v3.js').Stream[];

  /**
   * Commit with Change-Id tracking. Use this instead of raw `git commit` when
   * committing on behalf of a streamed agent.
   */
  commitChanges(opts: {
    agentId: import('./types-v3.js').Principal;
    streamId: StreamId;
    worktree: string;
    message: string;
  }): { commit: string; changeId: import('./types-v3.js').ChangeId };

  /**
   * Mark a set of changes as merged (e.g., after a landing strategy completes).
   */
  markChangesMerged(changeIds: import('./types-v3.js').ChangeId[]): void;

  getChange(changeId: import('./types-v3.js').ChangeId): import('./types-v3.js').Change | null;
  getChangeByCommit(commit: string): import('./types-v3.js').Change | null;

  /**
   * Allocate a worktree for an agent, optionally attached to a stream.
   * Stream-first equivalent of `createWorker/Integrator/CoordinatorWorkspace`.
   */
  allocateWorktree(opts: import('./types-v3.js').AllocateWorktreeOpts): import('./types-v3.js').Worktree;

  /**
   * Get the worktree owned by a principal (if any).
   */
  getWorktreeForAgent(agentId: import('./types-v3.js').Principal): import('./types-v3.js').Worktree | null;

  /**
   * Register a landing strategy. Registered strategies can be referenced by
   * name from role YAML (see Phase 5 — `LandingStrategy` integration).
   */
  registerLandingStrategy(strategy: import('./types-v3.js').LandingStrategy): void;

  /**
   * Run macro-level reconciliation:
   * - Delegates to git-cascade's `reconcile()` for stream↔git sync.
   * - Cleans up orphan worktrees and stale pool entries.
   * Intended to be called once on boot.
   */
  reconcileV3(): import('./types-v3.js').MacroReconcileResult;

  /**
   * Resolve a conflict record (typically called by a resolver agent via the
   * `resolve_conflict` MCP tool after it fixes conflict markers and commits).
   * Emits `conflict:resolved` event.
   */
  resolveConflict(opts: {
    conflictId: string;
    resolvedBy: import('./types-v3.js').Principal;
    resolutionCommit?: string;
    /** How the conflict was resolved. Default 'agent'. */
    method?:
      | 'ours'
      | 'theirs'
      | 'manual'
      | 'agent'
      | 'auto-resolve'
      | 'spawn-resolver'
      | 'abandoned';
    /** Human-readable resolution summary. */
    summary?: string;
  }): void;

  /**
   * Subscribe to workspace events. Returns an unsubscribe function.
   */
  onEvent(callback: WorkspaceEventCallback): () => void;

  // ─────────────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Close the workspace manager and release resources.
   */
  close(): void;
}

/**
 * Events emitted by WorkspaceManager.
 *
 * Legacy events (`workspace:*`, `child:*`, `branches:*`, `branch:*`) drive the
 * existing role-shaped lifecycle. V3 events (`stream:*`, `worktree:*`,
 * `change:*`, `conflict:*`, `landing:*`, `cascade:*`, `mergeQueue:*`) drive the
 * stream-first redesign and are re-emitted from the underlying git-cascade
 * adapter. Consumers narrow on the type string.
 */
export type WorkspaceEventType =
  | 'workspace:created'
  | 'workspace:deallocated'
  | 'child:registered'
  | 'branches:cleaned'
  | 'branch:deleted'
  // V3 additions — stream-first lifecycle
  | 'stream:created'
  | 'stream:forked'
  | 'stream:committed'
  | 'stream:merged'
  | 'stream:conflicted'
  | 'stream:abandoned'
  | 'stream:paused'
  | 'stream:resumed'
  | 'worktree:allocated'
  | 'worktree:shared'
  | 'worktree:released'
  | 'change:merged'
  | 'change:dropped'
  | 'conflict:created'
  | 'conflict:resolved'
  | 'landing:started'
  | 'landing:completed'
  | 'cascade:completed'
  | 'mergeQueue:added'
  | 'mergeQueue:ready'
  | 'mergeQueue:cancelled'
  | 'mergeQueue:removed';

/**
 * Event payload for workspace events
 */
export interface WorkspaceEvent {
  type: WorkspaceEventType;
  timestamp: number;
  data: Record<string, unknown>;
}

/**
 * Callback for workspace events
 */
export type WorkspaceEventCallback = (event: WorkspaceEvent) => void;
