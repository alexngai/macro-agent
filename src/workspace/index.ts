/**
 * Workspace Module
 *
 * Provides workspace isolation for agents using dataplane for git management.
 * Implements [[s-7ktd]] Structured Workspace Isolation.
 *
 * @module workspace
 */

// Configuration types
export {
  type DataplaneConfig,
  type WorkspaceDirectoryConfig,
  DEFAULT_DATAPLANE_CONFIG,
  DEFAULT_WORKSPACE_DIR_CONFIG,
} from './config.js';

// Dataplane adapter
export {
  DataplaneAdapter,
  createDataplaneAdapter,
  type DataplaneEvent,
  type DataplaneEventType,
  type DataplaneEventCallback,
} from './dataplane-adapter.js';

// Workspace types
export type {
  AgentId,
  StreamId,
  TaskId,
  WorkspaceRole,
  Workspace,
  WorkerWorkspace,
  IntegratorWorkspace,
  CoordinatorWorkspace,
  StreamConfig,
  CreateTaskOptions as WorkspaceCreateTaskOptions,
  WorkspaceStatus,
  CleanupStatus,
  WorkspaceManager,
  WorkspaceEvent,
  WorkspaceEventType,
  WorkspaceEventCallback,
} from './types.js';

// Workspace manager
export {
  DefaultWorkspaceManager,
  createWorkspaceManager,
  createWorkspaceManagerWithAdapter,
  type WorkspaceManagerConfig,
} from './workspace-manager.js';

// Merge queue
export {
  MergeQueue,
  createMergeQueue,
  MergeRequestNotFoundError,
  MergeRequestStateError,
  initMergeQueueSchema,
  mergeQueueTableExists,
  type MergeQueueConfig,
  type MergeRequest,
  type MergeRequestStatus,
  type SubmitMergeRequestOptions,
  type ListMergeRequestsOptions,
  type MergeQueueInterface,
  type MergeQueueEvent,
  type MergeQueueEventType,
  type MergeQueueEventCallback,
} from './merge-queue/index.js';

// Re-export key types from dataplane for convenience
export type {
  Stream,
  StreamStatus,
  CreateStreamOptions,
  AgentWorktree,
  CreateWorktreeOptions,
  WorkerTask,
  CreateTaskOptions,
  StartTaskOptions,
  CompleteTaskOptions,
  StartTaskResult,
  CompleteTaskResult,
  ListTasksOptions,
  CleanupWorkerBranchesOptions,
  CleanupResult,
} from 'dataplane';
