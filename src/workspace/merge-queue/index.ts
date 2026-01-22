/**
 * MergeQueue Module
 *
 * Provides merge queue functionality for coordinating parallel worker merges.
 *
 * @module workspace/merge-queue
 * @implements [[s-bcqm]] Merge Queue section
 */

// Types
export type {
  MergeRequest,
  MergeRequestStatus,
  SubmitMergeRequestOptions,
  ListMergeRequestsOptions,
  MergeQueueInterface,
  MergeQueueEvent,
  MergeQueueEventType,
  MergeQueueEventCallback,
} from './types.js';

// Schema
export {
  getMergeRequestsTableName,
  getCreateTableSQL,
  getCreateIndexesSQL,
  initMergeQueueSchema,
  mergeQueueTableExists,
} from './schema.js';

// Implementation
export {
  MergeQueue,
  createMergeQueue,
  MergeRequestNotFoundError,
  MergeRequestStateError,
  type MergeQueueConfig,
} from './merge-queue.js';
