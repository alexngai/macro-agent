/**
 * SudocodeTaskBackend Implementation
 *
 * Implements TaskBackend using EventStore for local task storage and
 * SudocodeClient for external issue data and dependency tracking.
 *
 * @module task/backend/sudocode/backend
 * @see s-8472 Pluggable Task Backend Integration with Sudocode
 * @see i-2gwa 7A.5: Implement SudocodeTaskBackend core
 */

import { nanoid } from "nanoid";
import type { EventStore } from "../../../store/event-store.js";
import type {
  Task,
  TaskStatus,
  AgentId,
  TaskId,
  AgentHistoryEntry,
} from "../../../store/types/index.js";
import type {
  TaskBackend,
  ExtendedTask,
  CreateTaskOptions,
  UpdateTaskOptions,
  TaskFilter,
  TaskOutputs,
  TaskError,
  SubtaskStatus,
  AssignOptions,
  TaskChangeCallback,
  TaskChangeEvent,
  Unsubscribe,
} from "../types.js";
import type { SudocodeClient, IssueChangeCallback } from "./client.js";
import { mapSudocodeStatus, isIssueComplete } from "./mapping.js";
import type { SyncPolicy, SyncEventCallback, SyncEvent } from "./sync-policy.js";
import {
  SyncPolicyEngine,
  defaultSyncPolicy,
  createSyncPolicyEngine,
} from "./sync-policy.js";

// Valid status transitions
const VALID_STATUS_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  pending: ["assigned", "in_progress", "failed"],
  assigned: ["in_progress", "pending", "failed"],
  in_progress: ["completed", "failed", "pending"],
  completed: [],
  failed: ["pending"],
};

/**
 * Error thrown by SudocodeTaskBackend operations
 */
export class SudocodeTaskBackendError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly taskId?: TaskId
  ) {
    super(message);
    this.name = "SudocodeTaskBackendError";
  }
}

/**
 * SudocodeTaskBackend Configuration
 */
export interface SudocodeTaskBackendConfig {
  /** Path to sudocode project root */
  projectPath?: string;

  /** Whether to sync task status with issue status */
  syncStatus?: boolean;

  /** Whether to auto-close issues when tasks complete */
  autoCloseIssues?: boolean;

  /** Sync policy configuration */
  syncPolicy?: Partial<SyncPolicy>;
}

const DEFAULT_CONFIG: Required<Omit<SudocodeTaskBackendConfig, "syncPolicy">> = {
  projectPath: process.cwd(),
  syncStatus: true,
  autoCloseIssues: false,
};

/**
 * SudocodeTaskBackend implements TaskBackend using:
 * - EventStore for local task storage and events
 * - SudocodeClient for issue data and dependency tracking
 *
 * Key features:
 * - Tasks can be bound to sudocode issues via external_id
 * - isBlocked computed from sudocode's issue blockers
 * - listReady uses sudocode's ready issues API
 * - Status changes can optionally sync to issues
 */
export class SudocodeTaskBackend implements TaskBackend {
  private readonly config: Required<Omit<SudocodeTaskBackendConfig, "syncPolicy">>;
  private readonly tasksByIssue: Map<string, Set<TaskId>> = new Map();
  private readonly issueByTask: Map<TaskId, string> = new Map();
  private readonly syncEngine: SyncPolicyEngine;
  private issueChangeUnsubscribe?: Unsubscribe;

  constructor(
    private readonly eventStore: EventStore,
    private readonly client: SudocodeClient,
    config?: SudocodeTaskBackendConfig
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.syncEngine = createSyncPolicyEngine(
      config?.syncPolicy ?? {},
      this
    );
    this.rebuildIndex();
    this.subscribeToIssueChanges();
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Index Management
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Rebuild the task-by-issue index from existing tasks
   */
  private rebuildIndex(): void {
    this.tasksByIssue.clear();
    this.issueByTask.clear();
    const tasks = this.eventStore.listTasks();

    for (const task of tasks) {
      const externalId = this.getTaskExternalId(task);
      if (externalId) {
        this.addToIndex(externalId, task.id);
      }
    }
  }

  /**
   * Add a task to the issue index
   */
  private addToIndex(issueId: string, taskId: TaskId): void {
    // Update issue -> tasks map
    if (!this.tasksByIssue.has(issueId)) {
      this.tasksByIssue.set(issueId, new Set());
    }
    this.tasksByIssue.get(issueId)!.add(taskId);

    // Update task -> issue map
    this.issueByTask.set(taskId, issueId);
  }

  /**
   * Remove a task from the issue index
   */
  private removeFromIndex(issueId: string, taskId: TaskId): void {
    // Update issue -> tasks map
    const tasks = this.tasksByIssue.get(issueId);
    if (tasks) {
      tasks.delete(taskId);
      if (tasks.size === 0) {
        this.tasksByIssue.delete(issueId);
      }
    }

    // Update task -> issue map
    this.issueByTask.delete(taskId);
  }

  /**
   * Get tasks bound to an issue
   */
  getTasksByIssue(issueId: string): TaskId[] {
    return Array.from(this.tasksByIssue.get(issueId) ?? []);
  }

  /**
   * Get the issue a task is bound to
   */
  getIssueForTask(taskId: TaskId): string | undefined {
    return this.issueByTask.get(taskId);
  }

  /**
   * Bind a task to a sudocode issue.
   * @param taskId Task ID to bind
   * @param issueId Issue ID to bind to
   * @throws If task or issue not found
   */
  async bindToIssue(taskId: TaskId, issueId: string): Promise<void> {
    const task = this.eventStore.getTask(taskId);
    if (!task) {
      throw new SudocodeTaskBackendError(
        `Task not found: ${taskId}`,
        "TASK_NOT_FOUND",
        taskId
      );
    }

    // Verify issue exists
    const issue = await this.client.getIssue(issueId);
    if (!issue) {
      throw new SudocodeTaskBackendError(
        `Issue not found: ${issueId}`,
        "ISSUE_NOT_FOUND"
      );
    }

    // Check if already bound to a different issue
    const currentIssue = this.getIssueForTask(taskId);
    if (currentIssue && currentIssue !== issueId) {
      // Remove from old index
      this.removeFromIndex(currentIssue, taskId);
    }

    // Update task with external_id
    this.eventStore.emit({
      type: "task",
      source: { agent_id: task.assigned_agent ?? task.created_by },
      payload: {
        task_id: taskId,
        action: "status_change",
        details: {
          outputs: { external_id: issueId },
        },
      },
    });

    // Update index
    this.addToIndex(issueId, taskId);
  }

  /**
   * Unbind a task from its current issue.
   * @param taskId Task ID to unbind
   * @throws If task not found
   */
  async unbindFromIssue(taskId: TaskId): Promise<void> {
    const task = this.eventStore.getTask(taskId);
    if (!task) {
      throw new SudocodeTaskBackendError(
        `Task not found: ${taskId}`,
        "TASK_NOT_FOUND",
        taskId
      );
    }

    const issueId = this.getIssueForTask(taskId);
    if (!issueId) {
      // Not bound, nothing to do
      return;
    }

    // Clear external_id in task outputs
    this.eventStore.emit({
      type: "task",
      source: { agent_id: task.assigned_agent ?? task.created_by },
      payload: {
        task_id: taskId,
        action: "status_change",
        details: {
          outputs: { external_id: null },
        },
      },
    });

    // Remove from index
    this.removeFromIndex(issueId, taskId);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Issue Change Subscription
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Subscribe to sudocode issue changes for status sync
   */
  private subscribeToIssueChanges(): void {
    if (!this.config.syncStatus) return;

    const callback: IssueChangeCallback = (event) => {
      // Handle via sync policy engine
      this.syncEngine.handleIssueChange(event).catch(() => {
        // Ignore errors from sync engine
      });

      // Additionally handle status mapping for non-closed status changes
      // (closed status is handled by the sync engine based on policy)
      if (
        event.type === "status_changed" &&
        event.issue &&
        event.issue.status !== "closed"
      ) {
        const taskIds = this.getTasksByIssue(event.issueId);
        const newStatus = mapSudocodeStatus(event.issue.status);

        for (const taskId of taskIds) {
          const task = this.eventStore.getTask(taskId);
          if (task && task.status !== newStatus) {
            // Only update if the task isn't in a terminal state
            if (
              task.status !== "completed" &&
              task.status !== "failed"
            ) {
              // Emit status change event
              this.eventStore.emit({
                type: "task",
                source: { agent_id: task.assigned_agent ?? task.created_by },
                payload: {
                  task_id: taskId,
                  action: "status_change",
                  details: { status: newStatus },
                },
              });
            }
          }
        }
      }
    };

    this.issueChangeUnsubscribe = this.client.onIssueChange(callback);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ─────────────────────────────────────────────────────────────────────────────

  async create(options: CreateTaskOptions): Promise<ExtendedTask> {
    const taskId = `task_${nanoid(12)}`;

    // Validate parent task exists if specified
    if (options.parent_task) {
      const parent = this.eventStore.getTask(options.parent_task);
      if (!parent) {
        throw new SudocodeTaskBackendError(
          `Parent task not found: ${options.parent_task}`,
          "PARENT_TASK_NOT_FOUND",
          options.parent_task
        );
      }
    }

    // Validate external_id (issue) exists if specified
    if (options.external_id) {
      const issue = await this.client.getIssue(options.external_id);
      if (!issue) {
        throw new SudocodeTaskBackendError(
          `Issue not found: ${options.external_id}`,
          "ISSUE_NOT_FOUND"
        );
      }
    }

    // Emit task created event
    this.eventStore.emit({
      type: "task",
      source: { agent_id: options.created_by },
      payload: {
        task_id: taskId,
        action: "created",
        details: {
          description: options.description,
          parent_task: options.parent_task,
          external_id: options.external_id,
        },
      },
    });

    // Update parent's subtasks array if this is a subtask
    if (options.parent_task) {
      this.eventStore.emit({
        type: "task",
        source: { agent_id: options.created_by },
        payload: {
          task_id: options.parent_task,
          action: "status_change",
          details: {
            subtask_added: taskId,
          },
        },
      });
    }

    // Add to issue index if bound
    if (options.external_id) {
      this.addToIndex(options.external_id, taskId);
    }

    const task = this.eventStore.getTask(taskId)!;
    return this.toExtendedTask(task);
  }

  async get(id: TaskId): Promise<ExtendedTask | null> {
    const task = this.eventStore.getTask(id);
    if (!task) return null;
    return this.toExtendedTask(task);
  }

  async update(id: TaskId, updates: UpdateTaskOptions): Promise<ExtendedTask> {
    const task = this.eventStore.getTask(id);
    if (!task) {
      throw new SudocodeTaskBackendError(
        `Task not found: ${id}`,
        "TASK_NOT_FOUND",
        id
      );
    }

    const source = task.assigned_agent ?? task.created_by;

    // Handle status update with validation
    if (updates.status !== undefined) {
      const validTransitions = VALID_STATUS_TRANSITIONS[task.status];
      if (!validTransitions.includes(updates.status)) {
        throw new SudocodeTaskBackendError(
          `Invalid status transition: ${task.status} -> ${updates.status}`,
          "INVALID_STATUS_TRANSITION",
          id
        );
      }

      this.eventStore.emit({
        type: "task",
        source: { agent_id: source },
        payload: {
          task_id: id,
          action: "status_change",
          details: { status: updates.status },
        },
      });
    }

    // Handle other updates
    if (updates.outputs !== undefined) {
      this.eventStore.emit({
        type: "task",
        source: { agent_id: source },
        payload: {
          task_id: id,
          action: "status_change",
          details: { outputs: updates.outputs },
        },
      });
    }

    if (updates.artifacts !== undefined) {
      this.eventStore.emit({
        type: "task",
        source: { agent_id: source },
        payload: {
          task_id: id,
          action: "status_change",
          details: { artifacts: updates.artifacts },
        },
      });
    }

    if (updates.description !== undefined) {
      this.eventStore.emit({
        type: "task",
        source: { agent_id: source },
        payload: {
          task_id: id,
          action: "status_change",
          details: { description: updates.description },
        },
      });
    }

    const updated = this.eventStore.getTask(id)!;
    return this.toExtendedTask(updated);
  }

  async delete(id: TaskId): Promise<void> {
    const task = this.eventStore.getTask(id);
    if (!task) {
      throw new SudocodeTaskBackendError(
        `Task not found: ${id}`,
        "TASK_NOT_FOUND",
        id
      );
    }

    // Remove from index if bound to an issue
    const issueId = this.getIssueForTask(id);
    if (issueId) {
      this.removeFromIndex(issueId, id);
    }

    // Emit deleted event (soft delete - task remains in EventStore but marked deleted)
    this.eventStore.emit({
      type: "task",
      source: { agent_id: task.assigned_agent ?? task.created_by },
      payload: {
        task_id: id,
        action: "status_change",
        details: { status: "failed", deleted: true },
      },
    });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Status Transitions
  // ─────────────────────────────────────────────────────────────────────────────

  async assign(
    id: TaskId,
    agentId: AgentId,
    options?: AssignOptions
  ): Promise<void> {
    const task = this.eventStore.getTask(id);
    if (!task) {
      throw new SudocodeTaskBackendError(
        `Task not found: ${id}`,
        "TASK_NOT_FOUND",
        id
      );
    }

    this.eventStore.emit({
      type: "task",
      source: { agent_id: agentId },
      payload: {
        task_id: id,
        action: "assigned",
        details: {
          agent_id: agentId,
          role: options?.role,
        },
      },
    });

    // Optionally update issue status
    const externalId = this.getTaskExternalId(task);
    if (externalId && this.config.syncStatus) {
      try {
        await this.client.updateIssue(externalId, { status: "in_progress" });
      } catch {
        // Ignore errors syncing to sudocode
      }
    }
  }

  async unassign(id: TaskId): Promise<void> {
    const task = this.eventStore.getTask(id);
    if (!task) {
      throw new SudocodeTaskBackendError(
        `Task not found: ${id}`,
        "TASK_NOT_FOUND",
        id
      );
    }

    if (!task.assigned_agent) {
      throw new SudocodeTaskBackendError(
        `Task is not assigned: ${id}`,
        "TASK_NOT_ASSIGNED",
        id
      );
    }

    this.eventStore.emit({
      type: "task",
      source: { agent_id: task.assigned_agent },
      payload: {
        task_id: id,
        action: "unassigned",
        details: {
          agent_id: task.assigned_agent,
        },
      },
    });
  }

  async start(id: TaskId): Promise<void> {
    const task = this.eventStore.getTask(id);
    if (!task) {
      throw new SudocodeTaskBackendError(
        `Task not found: ${id}`,
        "TASK_NOT_FOUND",
        id
      );
    }

    const validTransitions = VALID_STATUS_TRANSITIONS[task.status];
    if (!validTransitions.includes("in_progress")) {
      throw new SudocodeTaskBackendError(
        `Invalid status transition: ${task.status} -> in_progress`,
        "INVALID_STATUS_TRANSITION",
        id
      );
    }

    this.eventStore.emit({
      type: "task",
      source: { agent_id: task.assigned_agent ?? task.created_by },
      payload: {
        task_id: id,
        action: "status_change",
        details: { status: "in_progress" },
      },
    });

    // Update issue status
    const externalId = this.getTaskExternalId(task);
    if (externalId && this.config.syncStatus) {
      try {
        await this.client.updateIssue(externalId, { status: "in_progress" });
      } catch {
        // Ignore errors syncing to sudocode
      }
    }
  }

  async complete(id: TaskId, outputs?: TaskOutputs): Promise<void> {
    const task = this.eventStore.getTask(id);
    if (!task) {
      throw new SudocodeTaskBackendError(
        `Task not found: ${id}`,
        "TASK_NOT_FOUND",
        id
      );
    }

    const validTransitions = VALID_STATUS_TRANSITIONS[task.status];
    if (!validTransitions.includes("completed")) {
      throw new SudocodeTaskBackendError(
        `Invalid status transition: ${task.status} -> completed`,
        "INVALID_STATUS_TRANSITION",
        id
      );
    }

    // Add outputs if provided
    if (outputs) {
      if (outputs.data) {
        this.eventStore.emit({
          type: "task",
          source: { agent_id: task.assigned_agent ?? task.created_by },
          payload: {
            task_id: id,
            action: "status_change",
            details: { outputs: outputs.data },
          },
        });
      }
      if (outputs.artifacts) {
        this.eventStore.emit({
          type: "task",
          source: { agent_id: task.assigned_agent ?? task.created_by },
          payload: {
            task_id: id,
            action: "status_change",
            details: { artifacts: outputs.artifacts },
          },
        });
      }
    }

    this.eventStore.emit({
      type: "task",
      source: { agent_id: task.assigned_agent ?? task.created_by },
      payload: {
        task_id: id,
        action: "completed",
        details: {},
      },
    });

    // Optionally close the issue
    const externalId = this.getTaskExternalId(task);
    if (externalId && this.config.autoCloseIssues) {
      try {
        await this.client.updateIssue(externalId, { status: "closed" });
      } catch {
        // Ignore errors syncing to sudocode
      }
    }
  }

  async fail(id: TaskId, error: TaskError): Promise<void> {
    const task = this.eventStore.getTask(id);
    if (!task) {
      throw new SudocodeTaskBackendError(
        `Task not found: ${id}`,
        "TASK_NOT_FOUND",
        id
      );
    }

    const validTransitions = VALID_STATUS_TRANSITIONS[task.status];
    if (!validTransitions.includes("failed")) {
      throw new SudocodeTaskBackendError(
        `Invalid status transition: ${task.status} -> failed`,
        "INVALID_STATUS_TRANSITION",
        id
      );
    }

    // Store error info in outputs
    this.eventStore.emit({
      type: "task",
      source: { agent_id: task.assigned_agent ?? task.created_by },
      payload: {
        task_id: id,
        action: "status_change",
        details: {
          outputs: {
            error: {
              message: error.message,
              code: error.code,
              details: error.details,
            },
          },
        },
      },
    });

    this.eventStore.emit({
      type: "task",
      source: { agent_id: task.assigned_agent ?? task.created_by },
      payload: {
        task_id: id,
        action: "failed",
        details: {},
      },
    });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Queries
  // ─────────────────────────────────────────────────────────────────────────────

  async list(filter?: TaskFilter): Promise<ExtendedTask[]> {
    let tasks = this.eventStore.listTasks();

    if (filter) {
      // Filter by status
      if (filter.status) {
        const statuses = Array.isArray(filter.status)
          ? filter.status
          : [filter.status];
        tasks = tasks.filter((t) => statuses.includes(t.status));
      }

      if (filter.assigned_agent) {
        tasks = tasks.filter((t) => t.assigned_agent === filter.assigned_agent);
      }

      if (filter.parent_task) {
        tasks = tasks.filter((t) => t.parent_task === filter.parent_task);
      }

      if (filter.created_by) {
        tasks = tasks.filter((t) => t.created_by === filter.created_by);
      }

      if (filter.rootTasksOnly) {
        tasks = tasks.filter((t) => !t.parent_task);
      }
    }

    // Convert to ExtendedTask (async because of issue lookups)
    const extended = await Promise.all(
      tasks.map((t) => this.toExtendedTask(t))
    );

    // Filter blocked if needed
    if (!filter?.includeBlocked) {
      return extended.filter((t) => !t.isBlocked);
    }

    return extended;
  }

  async listReady(filter?: TaskFilter): Promise<ExtendedTask[]> {
    // Get ready issues from sudocode (no blocking dependencies)
    const readyIssues = await this.client.getReadyIssues();
    const readyIssueIds = new Set(readyIssues.map((i) => i.id));

    // Get pending/assigned tasks
    const tasks = await this.list({
      ...filter,
      status: filter?.status ?? ["pending", "assigned"],
      includeBlocked: true, // We'll filter manually
    });

    // A task is ready if:
    // 1. It has no external_id (not bound to an issue), OR
    // 2. Its bound issue is in the ready set
    return tasks.filter((t) => {
      if (!t.external_id) {
        // Unbound task - check local blockers only
        return !t.isBlocked;
      }
      // Bound task - must be in ready issues
      return readyIssueIds.has(t.external_id);
    });
  }

  async getChildren(parentId: TaskId): Promise<ExtendedTask[]> {
    const tasks = this.eventStore.listTasks();
    const children = tasks.filter((t) => t.parent_task === parentId);
    return Promise.all(children.map((t) => this.toExtendedTask(t)));
  }

  async getSubtaskStatus(parentId: TaskId): Promise<SubtaskStatus> {
    const children = await this.getChildren(parentId);

    const status: SubtaskStatus = {
      total: children.length,
      pending: 0,
      assigned: 0,
      in_progress: 0,
      completed: 0,
      failed: 0,
      allCompleted: false,
      anyFailed: false,
    };

    for (const task of children) {
      switch (task.status) {
        case "pending":
          status.pending++;
          break;
        case "assigned":
          status.assigned++;
          break;
        case "in_progress":
          status.in_progress++;
          break;
        case "completed":
          status.completed++;
          break;
        case "failed":
          status.failed++;
          break;
      }
    }

    status.allCompleted =
      status.total > 0 && status.completed === status.total;
    status.anyFailed = status.failed > 0;

    return status;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Hierarchy
  // ─────────────────────────────────────────────────────────────────────────────

  async createSubtask(
    parentId: TaskId,
    options: CreateTaskOptions
  ): Promise<ExtendedTask> {
    return this.create({
      ...options,
      parent_task: parentId,
    });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Dependencies
  // ─────────────────────────────────────────────────────────────────────────────

  async addBlocker(taskId: TaskId, blockerId: TaskId): Promise<void> {
    const task = this.eventStore.getTask(taskId);
    if (!task) {
      throw new SudocodeTaskBackendError(
        `Task not found: ${taskId}`,
        "TASK_NOT_FOUND",
        taskId
      );
    }

    const blocker = this.eventStore.getTask(blockerId);
    if (!blocker) {
      throw new SudocodeTaskBackendError(
        `Blocker task not found: ${blockerId}`,
        "TASK_NOT_FOUND",
        blockerId
      );
    }

    // Always track locally via EventStore
    this.eventStore.emit({
      type: "task",
      source: { agent_id: task.assigned_agent ?? task.created_by },
      payload: {
        task_id: taskId,
        action: "blocker_added",
        details: { blocker_id: blockerId },
      },
    });

    // If both tasks are bound to sudocode issues, create a sudocode relationship
    const taskIssueId = this.getIssueForTask(taskId);
    const blockerIssueId = this.getIssueForTask(blockerId);
    if (taskIssueId && blockerIssueId) {
      try {
        // In sudocode, "A blocks B" means A must complete before B
        // So we create: blockerIssue blocks taskIssue
        await this.client.createLink(blockerIssueId, taskIssueId, "blocks");
      } catch {
        // Log but don't fail - local tracking is the source of truth
      }
    }
  }

  async removeBlocker(taskId: TaskId, blockerId: TaskId): Promise<void> {
    const task = this.eventStore.getTask(taskId);
    if (!task) {
      throw new SudocodeTaskBackendError(
        `Task not found: ${taskId}`,
        "TASK_NOT_FOUND",
        taskId
      );
    }

    // Always update local EventStore tracking
    this.eventStore.emit({
      type: "task",
      source: { agent_id: task.assigned_agent ?? task.created_by },
      payload: {
        task_id: taskId,
        action: "blocker_removed",
        details: { blocker_id: blockerId },
      },
    });

    // If both tasks are bound to sudocode issues, remove the sudocode relationship
    const taskIssueId = this.getIssueForTask(taskId);
    const blockerIssueId = this.getIssueForTask(blockerId);
    if (taskIssueId && blockerIssueId) {
      try {
        await this.client.removeLink(blockerIssueId, taskIssueId, "blocks");
      } catch {
        // Log but don't fail - local tracking is the source of truth
      }
    }
  }

  async getBlockers(taskId: TaskId): Promise<ExtendedTask[]> {
    const task = this.eventStore.getTask(taskId);
    if (!task) {
      throw new SudocodeTaskBackendError(
        `Task not found: ${taskId}`,
        "TASK_NOT_FOUND",
        taskId
      );
    }

    // Track blockers by ID to avoid duplicates
    const blockerMap = new Map<TaskId, ExtendedTask>();

    // Get local task blockers
    const localBlockerIds = task.blockers ?? [];
    for (const blockerId of localBlockerIds) {
      const blocker = this.eventStore.getTask(blockerId);
      if (blocker && !blockerMap.has(blockerId)) {
        blockerMap.set(blockerId, await this.toExtendedTask(blocker));
      }
    }

    // If task is bound to an issue, also get sudocode blockers
    const taskIssueId = this.getIssueForTask(taskId);
    if (taskIssueId) {
      try {
        const issueBlockers = await this.client.getBlockers(taskIssueId);
        for (const issueBlocker of issueBlockers) {
          // Find tasks bound to this blocking issue
          const blockerTaskIds = this.getTasksByIssue(issueBlocker.id);
          for (const blockerTaskId of blockerTaskIds) {
            if (!blockerMap.has(blockerTaskId)) {
              const blockerTask = this.eventStore.getTask(blockerTaskId);
              if (blockerTask) {
                blockerMap.set(
                  blockerTaskId,
                  await this.toExtendedTask(blockerTask)
                );
              }
            }
          }
        }
      } catch {
        // Ignore errors fetching sudocode blockers - local is source of truth
      }
    }

    return Array.from(blockerMap.values());
  }

  async getBlocking(taskId: TaskId): Promise<ExtendedTask[]> {
    const task = this.eventStore.getTask(taskId);
    if (!task) {
      throw new SudocodeTaskBackendError(
        `Task not found: ${taskId}`,
        "TASK_NOT_FOUND",
        taskId
      );
    }

    // Track blocked tasks by ID to avoid duplicates
    const blockingMap = new Map<TaskId, ExtendedTask>();

    // Find all local tasks that have this task in their blockers
    const allTasks = this.eventStore.listTasks();
    const localBlocking = allTasks.filter((t) => t.blockers?.includes(taskId));
    for (const blockedTask of localBlocking) {
      if (!blockingMap.has(blockedTask.id)) {
        blockingMap.set(blockedTask.id, await this.toExtendedTask(blockedTask));
      }
    }

    // If task is bound to an issue, also get sudocode blocking
    const taskIssueId = this.getIssueForTask(taskId);
    if (taskIssueId) {
      try {
        const issueBlocking = await this.client.getBlocking(taskIssueId);
        for (const blockedIssue of issueBlocking) {
          // Find tasks bound to this blocked issue
          const blockedTaskIds = this.getTasksByIssue(blockedIssue.id);
          for (const blockedTaskId of blockedTaskIds) {
            if (!blockingMap.has(blockedTaskId)) {
              const blockedTask = this.eventStore.getTask(blockedTaskId);
              if (blockedTask) {
                blockingMap.set(
                  blockedTaskId,
                  await this.toExtendedTask(blockedTask)
                );
              }
            }
          }
        }
      } catch {
        // Ignore errors fetching sudocode blocking - local is source of truth
      }
    }

    return Array.from(blockingMap.values());
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // History
  // ─────────────────────────────────────────────────────────────────────────────

  async getAgentHistory(taskId: TaskId): Promise<AgentHistoryEntry[]> {
    const task = this.eventStore.getTask(taskId);
    if (!task) {
      throw new SudocodeTaskBackendError(
        `Task not found: ${taskId}`,
        "TASK_NOT_FOUND",
        taskId
      );
    }

    return task.agent_history ?? [];
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Event Subscriptions
  // ─────────────────────────────────────────────────────────────────────────────

  onTaskChange(callback: TaskChangeCallback): Unsubscribe;
  onTaskChange(taskId: TaskId, callback: TaskChangeCallback): Unsubscribe;
  onTaskChange(
    callbackOrTaskId: TaskChangeCallback | TaskId,
    maybeCallback?: TaskChangeCallback
  ): Unsubscribe {
    const filterTaskId =
      typeof callbackOrTaskId === "string" ? callbackOrTaskId : undefined;
    const callback =
      typeof callbackOrTaskId === "function"
        ? callbackOrTaskId
        : maybeCallback!;

    // Wrap EventStore's onTaskChange
    return this.eventStore.onTaskChange((taskId, task) => {
      if (filterTaskId && taskId !== filterTaskId) {
        return;
      }

      // Build TaskChangeEvent (async enrichment handled differently)
      const event: TaskChangeEvent = {
        type: task ? "updated" : "deleted",
        taskId,
        task: task
          ? { ...task, isBlocked: false } // Will be enriched asynchronously
          : ({} as ExtendedTask),
      };

      callback(event);
    });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Sync Policy
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Get the current sync policy
   */
  getSyncPolicy(): SyncPolicy {
    return this.syncEngine.getPolicy();
  }

  /**
   * Subscribe to sync events from the policy engine
   */
  onSyncEvent(callback: SyncEventCallback): Unsubscribe {
    return this.syncEngine.onSyncEvent(callback);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Cleanup
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Close the backend and release resources
   */
  close(): void {
    if (this.issueChangeUnsubscribe) {
      this.issueChangeUnsubscribe();
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Private Helpers
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Get the external_id from a task (if stored in outputs)
   */
  private getTaskExternalId(task: Task): string | undefined {
    // Check if external_id is stored in task outputs (where we put it on creation)
    const outputs = task.outputs as Record<string, unknown> | undefined;
    if (outputs?.external_id && typeof outputs.external_id === "string") {
      return outputs.external_id;
    }
    return undefined;
  }

  /**
   * Convert a Task to ExtendedTask with computed isBlocked field.
   * Checks both local blockers and sudocode issue blockers.
   */
  private async toExtendedTask(task: Task): Promise<ExtendedTask> {
    let isBlocked = false;

    // Check local blockers first
    const localBlockerIds = task.blockers ?? [];
    for (const blockerId of localBlockerIds) {
      const blocker = this.eventStore.getTask(blockerId);
      if (blocker && blocker.status !== "completed") {
        isBlocked = true;
        break;
      }
    }

    // Check sudocode issue blockers if task is bound
    if (!isBlocked) {
      const externalId = this.getTaskExternalId(task);
      if (externalId) {
        try {
          const issueBlockers = await this.client.getBlockers(externalId);
          for (const blocker of issueBlockers) {
            if (!isIssueComplete(blocker.status)) {
              isBlocked = true;
              break;
            }
          }
        } catch {
          // If we can't fetch blockers, assume not blocked
        }
      }
    }

    return {
      ...task,
      isBlocked,
      external_id: this.getTaskExternalId(task),
    };
  }
}

/**
 * Create a SudocodeTaskBackend instance.
 *
 * @param eventStore - EventStore for local task storage
 * @param client - SudocodeClient for issue access
 * @param config - Optional configuration
 */
export function createSudocodeTaskBackend(
  eventStore: EventStore,
  client: SudocodeClient,
  config?: SudocodeTaskBackendConfig
): SudocodeTaskBackend {
  return new SudocodeTaskBackend(eventStore, client, config);
}
