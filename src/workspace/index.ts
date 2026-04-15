/**
 * Workspace Module
 *
 * Provides workspace isolation for agents using git-cascade for stream and worktree management.
 * Implements [[s-7ktd]] Structured Workspace Isolation.
 *
 * @module workspace
 */

// Configuration types
export {
  type GitCascadeConfig,
  type WorkspaceDirectoryConfig,
  type WorktreePoolConfig,
  type AllocationStrategy,
  DEFAULT_GIT_CASCADE_CONFIG,
  DEFAULT_WORKSPACE_DIR_CONFIG,
  DEFAULT_POOL_CONFIG,
} from './config.js';

// git-cascade adapter
export {
  GitCascadeAdapter,
  createGitCascadeAdapter,
  type GitCascadeEvent,
  type GitCascadeEventType,
  type GitCascadeEventCallback,
} from './git-cascade-adapter.js';

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

// Worktree pool
export {
  WorktreePool,
  type AllocationResult,
  type AcquireOptions,
  type ReleaseOptions,
  type PooledWorktree,
  type PoolEvent,
  type PoolEventCallback,
  type PoolEventType,
  type PoolStats,
  type QueuedRequest,
  type RecoveryResult,
  type WorktreePoolInterface,
  type WorktreeState,
} from './pool/index.js';

// Re-export key types from git-cascade adapter for convenience
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
} from 'git-cascade';
