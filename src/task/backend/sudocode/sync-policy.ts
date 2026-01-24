/**
 * Sync Policy Engine for Sudocode Integration
 *
 * Handles bidirectional sync between tasks and issues based on configurable policies.
 *
 * @module task/backend/sudocode/sync-policy
 * @see s-8472 Pluggable Task Backend Integration with Sudocode
 * @see i-1udw 7B.3: Implement sync policy engine
 */

import type { TaskId } from "../../../store/types/index.js";
import type { IssueChangeEvent } from "./client.js";

// =============================================================================
// Sync Policy Types
// =============================================================================

/**
 * Policy for handling external issue closure
 */
export type IssueClosed = "complete_task" | "fail_task" | "notify_only";

/**
 * Policy for handling description changes
 */
export type DescriptionChanged = "snapshot" | "propagate";

/**
 * Policy for handling blocker changes
 */
export type BlockerChanged = "update_blocked" | "notify_only";

/**
 * Policy for updating issue on task completion
 */
export type UpdateIssueOnComplete = "never" | "if_all_complete" | "always";

/**
 * Sync policy configuration
 */
export interface SyncPolicy {
  /** How to handle external issue closure */
  onIssueClosed: IssueClosed;

  /** How to handle description changes (default: 'snapshot') */
  onDescriptionChanged: DescriptionChanged;

  /** How to handle blocker changes */
  onBlockerChanged: BlockerChanged;

  /** Whether to update issue status on task start */
  updateIssueOnStart: boolean;

  /** Whether to update issue status on task complete */
  updateIssueOnComplete: UpdateIssueOnComplete;
}

/**
 * Default sync policy
 */
export const defaultSyncPolicy: SyncPolicy = {
  onIssueClosed: "notify_only",
  onDescriptionChanged: "snapshot",
  onBlockerChanged: "update_blocked",
  updateIssueOnStart: true,
  updateIssueOnComplete: "never",
};

// =============================================================================
// Sync Event Types
// =============================================================================

/**
 * Base sync event
 */
export interface BaseSyncEvent {
  type: string;
  taskId: TaskId;
  issueId: string;
}

/**
 * Issue closed event
 */
export interface IssueClosedSyncEvent extends BaseSyncEvent {
  type: "issue_closed";
}

/**
 * Issue deleted event
 */
export interface IssueDeletedSyncEvent extends BaseSyncEvent {
  type: "issue_deleted";
}

/**
 * Blocker added event
 */
export interface BlockerAddedSyncEvent extends BaseSyncEvent {
  type: "blocker_added";
  blockerIssueId?: string;
}

/**
 * Blocker removed event
 */
export interface BlockerRemovedSyncEvent extends BaseSyncEvent {
  type: "blocker_removed";
  blockerIssueId?: string;
}

/**
 * Description changed event
 */
export interface DescriptionChangedSyncEvent extends BaseSyncEvent {
  type: "description_changed";
  oldDescription?: string;
  newDescription?: string;
}

/**
 * Union of all sync events
 */
export type SyncEvent =
  | IssueClosedSyncEvent
  | IssueDeletedSyncEvent
  | BlockerAddedSyncEvent
  | BlockerRemovedSyncEvent
  | DescriptionChangedSyncEvent;

/**
 * Callback for sync events
 */
export type SyncEventCallback = (event: SyncEvent) => void;

// =============================================================================
// Task Backend Interface (for engine to use)
// =============================================================================

/**
 * Interface for the task operations the sync engine needs
 */
export interface SyncableTaskBackend {
  getTasksByIssue(issueId: string): TaskId[];
  get(taskId: TaskId): Promise<{ status: string } | null>;
  complete(taskId: TaskId, outputs?: { summary?: string }): Promise<void>;
  fail(taskId: TaskId, error: { code: string; message: string }): Promise<void>;
  update(taskId: TaskId, updates: { description?: string }): Promise<unknown>;
}

// =============================================================================
// Sync Policy Engine
// =============================================================================

/**
 * SyncPolicyEngine handles bidirectional sync between tasks and issues
 * based on configurable policies.
 */
export class SyncPolicyEngine {
  private readonly callbacks: SyncEventCallback[] = [];

  constructor(
    private readonly policy: SyncPolicy,
    private readonly backend: SyncableTaskBackend
  ) {}

  /**
   * Subscribe to sync events
   */
  onSyncEvent(callback: SyncEventCallback): () => void {
    this.callbacks.push(callback);
    return () => {
      const idx = this.callbacks.indexOf(callback);
      if (idx >= 0) this.callbacks.splice(idx, 1);
    };
  }

  /**
   * Emit a sync event to all subscribers
   */
  private emit(event: SyncEvent): void {
    for (const callback of this.callbacks) {
      try {
        callback(event);
      } catch {
        // Ignore callback errors
      }
    }
  }

  /**
   * Handle an issue change event
   */
  async handleIssueChange(event: IssueChangeEvent): Promise<void> {
    const boundTasks = this.backend.getTasksByIssue(event.issueId);
    if (boundTasks.length === 0) return;

    switch (event.type) {
      case "deleted":
        await this.handleIssueDeleted(boundTasks, event);
        break;

      case "status_changed":
        if (event.issue?.status === "closed") {
          await this.handleIssueClosed(boundTasks, event);
        }
        break;

      case "blocked":
        await this.handleBlockerAdded(boundTasks, event);
        break;

      case "unblocked":
        await this.handleBlockerRemoved(boundTasks, event);
        break;

      case "updated":
        await this.handleIssueUpdated(boundTasks, event);
        break;
    }
  }

  /**
   * Handle issue closed
   */
  private async handleIssueClosed(
    taskIds: TaskId[],
    event: IssueChangeEvent
  ): Promise<void> {
    for (const taskId of taskIds) {
      const task = await this.backend.get(taskId);
      if (!task || task.status === "completed" || task.status === "failed") {
        continue;
      }

      switch (this.policy.onIssueClosed) {
        case "complete_task":
          await this.backend.complete(taskId, {
            summary: "Issue closed externally",
          });
          break;

        case "fail_task":
          await this.backend.fail(taskId, {
            code: "ISSUE_CLOSED",
            message: "Bound issue was closed externally",
          });
          break;

        case "notify_only":
          this.emit({
            type: "issue_closed",
            taskId,
            issueId: event.issueId,
          });
          break;
      }
    }
  }

  /**
   * Handle issue deleted - always fails orphaned tasks
   */
  private async handleIssueDeleted(
    taskIds: TaskId[],
    event: IssueChangeEvent
  ): Promise<void> {
    for (const taskId of taskIds) {
      const task = await this.backend.get(taskId);
      if (!task || task.status === "completed" || task.status === "failed") {
        continue;
      }

      await this.backend.fail(taskId, {
        code: "ISSUE_DELETED",
        message: `Bound issue ${event.issueId} was deleted`,
      });

      this.emit({
        type: "issue_deleted",
        taskId,
        issueId: event.issueId,
      });
    }
  }

  /**
   * Handle blocker added to issue
   */
  private async handleBlockerAdded(
    taskIds: TaskId[],
    event: IssueChangeEvent
  ): Promise<void> {
    if (this.policy.onBlockerChanged === "update_blocked") {
      // isBlocked will be recomputed on next get()
      // Emit notification for bound tasks
      for (const taskId of taskIds) {
        this.emit({
          type: "blocker_added",
          taskId,
          issueId: event.issueId,
        });
      }
    } else {
      // notify_only - just emit events
      for (const taskId of taskIds) {
        this.emit({
          type: "blocker_added",
          taskId,
          issueId: event.issueId,
        });
      }
    }
  }

  /**
   * Handle blocker removed from issue
   */
  private async handleBlockerRemoved(
    taskIds: TaskId[],
    event: IssueChangeEvent
  ): Promise<void> {
    // Emit notification for bound tasks
    for (const taskId of taskIds) {
      this.emit({
        type: "blocker_removed",
        taskId,
        issueId: event.issueId,
      });
    }
  }

  /**
   * Handle issue updated (e.g., description changed)
   */
  private async handleIssueUpdated(
    taskIds: TaskId[],
    event: IssueChangeEvent
  ): Promise<void> {
    // Check if description changed
    const oldDescription = event.previousIssue?.content;
    const newDescription = event.issue?.content;

    if (oldDescription !== newDescription && newDescription !== undefined) {
      if (this.policy.onDescriptionChanged === "propagate") {
        // Update task descriptions
        for (const taskId of taskIds) {
          await this.backend.update(taskId, {
            description: newDescription,
          });
        }
      }

      // Always emit event for tracking
      for (const taskId of taskIds) {
        this.emit({
          type: "description_changed",
          taskId,
          issueId: event.issueId,
          oldDescription,
          newDescription,
        });
      }
    }
  }

  /**
   * Get the current sync policy
   */
  getPolicy(): SyncPolicy {
    return { ...this.policy };
  }
}

/**
 * Create a sync policy engine
 */
export function createSyncPolicyEngine(
  policy: Partial<SyncPolicy>,
  backend: SyncableTaskBackend
): SyncPolicyEngine {
  const fullPolicy: SyncPolicy = {
    ...defaultSyncPolicy,
    ...policy,
  };
  return new SyncPolicyEngine(fullPolicy, backend);
}
