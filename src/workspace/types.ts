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
export type WorkspaceRole = 'worker' | 'integrator' | 'coordinator';

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
 * Bridges macro-agent roles to dataplane streams and worktrees.
 *
 * @see [[s-7ktd]] WorkspaceManager API section
 */
export interface WorkspaceManager {
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
  createIntegrationStream(coordinatorId: AgentId, config: StreamConfig): StreamId;

  /**
   * Get a stream by ID.
   *
   * @param streamId - Stream ID
   * @returns Stream or null if not found
   */
  getStream(streamId: StreamId): Stream | null;

  // ─────────────────────────────────────────────────────────────────────────────
  // Worktree Management
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Create a workspace for a worker agent.
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
  ): WorkerWorkspace;

  /**
   * Create a workspace for an integrator agent.
   *
   * @param integratorId - ID of the integrator agent
   * @param streamId - ID of the integration stream
   * @returns Integrator workspace
   */
  createIntegratorWorkspace(
    integratorId: AgentId,
    streamId: StreamId
  ): IntegratorWorkspace;

  /**
   * Create a workspace for a coordinator agent.
   *
   * @param coordinatorId - ID of the coordinator agent
   * @param streamId - ID of the integration stream
   * @returns Coordinator workspace
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
  // Task Management
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Create a task under a stream.
   *
   * @param streamId - ID of the integration stream
   * @param options - Task creation options
   * @returns Task ID
   */
  createTask(streamId: StreamId, options: CreateTaskOptions): TaskId;

  /**
   * Claim a task for a worker.
   *
   * @param taskId - ID of the task to claim
   * @param workerId - ID of the worker agent
   * @param worktree - Path to the worker's worktree
   * @returns Start task result with branch info
   */
  claimTask(taskId: TaskId, workerId: AgentId, worktree: string): StartTaskResult;

  /**
   * Get the next available task for a stream.
   *
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
   * The merge queue is shared across all streams and uses the same
   * database as the dataplane adapter.
   *
   * @returns MergeQueue instance
   */
  getMergeQueue(): MergeQueueInterface;

  // ─────────────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Close the workspace manager and release resources.
   */
  close(): void;
}

/**
 * Events emitted by WorkspaceManager
 */
export type WorkspaceEventType =
  | 'workspace:created'
  | 'workspace:deallocated'
  | 'child:registered'
  | 'branches:cleaned'
  | 'branch:deleted';

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
