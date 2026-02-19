/**
 * OpenTasksTaskBackend Implementation
 *
 * Implements TaskBackend using OpenTasks as the source of truth for task storage,
 * with EventStore for local event tracking and subscriptions.
 *
 * Tasks are stored as OpenTasks issues. Blocking dependencies use OpenTasks
 * 'blocks' edges. The pull model uses OpenTasks' ready query and claimed_by field.
 *
 * @module task/backend/opentasks/backend
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
  ClaimFilter,
  TaskChangeCallback,
  TaskChangeEvent,
  Unsubscribe,
} from "../types.js";
import type { OpenTasksClient, OpenTasksIssue } from "./client.js";
import { mapOpenTasksStatus, mapTaskStatus, isIssueComplete } from "./mapping.js";

// Valid status transitions
const VALID_STATUS_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  pending: ["assigned", "in_progress", "failed"],
  assigned: ["in_progress", "pending", "failed"],
  in_progress: ["completed", "failed", "pending"],
  completed: [],
  failed: ["pending"],
};

/**
 * Error thrown by OpenTasksTaskBackend operations
 */
export class OpenTasksBackendError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly taskId?: TaskId
  ) {
    super(message);
    this.name = "OpenTasksBackendError";
  }
}

/**
 * Configuration for OpenTasksTaskBackend
 */
export interface OpenTasksBackendConfig {
  /** Path to daemon socket (auto-discovered if not set) */
  socketPath?: string;

  /** Whether to sync status changes to OpenTasks (default: true) */
  syncStatus?: boolean;

  /** Source identifier for issues created by this backend (default: "macro-agent") */
  sourceLabel?: string;
}

const DEFAULT_CONFIG: Required<OpenTasksBackendConfig> = {
  socketPath: "",
  syncStatus: true,
  sourceLabel: "macro-agent",
};

/**
 * OpenTasksTaskBackend implements TaskBackend using:
 * - OpenTasks daemon for issue storage and graph relationships
 * - EventStore for local event tracking and subscriptions
 *
 * Key features:
 * - Tasks are stored as OpenTasks issues with macro-agent metadata
 * - Blocking dependencies use OpenTasks 'blocks' edges
 * - Pull model uses OpenTasks ready query and claimed_by
 * - Bidirectional ID mapping (task_id <-> issue_id) via metadata
 */
export class OpenTasksTaskBackend implements TaskBackend {
  private readonly config: Required<OpenTasksBackendConfig>;
  private closed = false;

  /** Map from macro-agent task ID to OpenTasks issue ID */
  private readonly taskToIssue = new Map<TaskId, string>();

  /** Map from OpenTasks issue ID to macro-agent task ID */
  private readonly issueToTask = new Map<string, TaskId>();

  constructor(
    private readonly eventStore: EventStore,
    private readonly client: OpenTasksClient,
    config?: Partial<OpenTasksBackendConfig>
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Throw if the backend has been closed.
   */
  private ensureOpen(): void {
    if (this.closed) {
      throw new OpenTasksBackendError("Backend is closed", "BACKEND_CLOSED");
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ─────────────────────────────────────────────────────────────────────────────

  async close(): Promise<void> {
    this.closed = true;
  }

  async create(options: CreateTaskOptions): Promise<ExtendedTask> {
    this.ensureOpen();
    const taskId = `task_${nanoid(12)}`;

    // Resolve parent issue ID if parent task specified
    let parentIssueId: string | undefined;
    if (options.parent_task) {
      parentIssueId = this.taskToIssue.get(options.parent_task);
      if (!parentIssueId) {
        // Check EventStore as fallback
        const parent = this.eventStore.getTask(options.parent_task);
        if (!parent) {
          throw new OpenTasksBackendError(
            `Parent task not found: ${options.parent_task}`,
            "PARENT_TASK_NOT_FOUND",
            options.parent_task
          );
        }
      }
    }

    // Create issue in OpenTasks
    const issue = await this.client.createIssue({
      title: options.description,
      status: "open",
      tags: options.tags,
      parent_id: parentIssueId,
      metadata: {
        macro_agent_task_id: taskId,
        created_by: options.created_by,
        source: this.config.sourceLabel,
      },
    });

    // Store bidirectional mapping
    this.taskToIssue.set(taskId, issue.id);
    this.issueToTask.set(issue.id, taskId);

    // Emit to EventStore for local tracking
    this.eventStore.emit({
      type: "task",
      source: { agent_id: options.created_by },
      payload: {
        task_id: taskId,
        action: "created",
        details: {
          description: options.description,
          parent_task: options.parent_task,
          tags: options.tags,
          external_id: issue.id,
        },
      },
    });

    // Update parent subtasks in EventStore
    if (options.parent_task) {
      this.eventStore.emit({
        type: "task",
        source: { agent_id: options.created_by },
        payload: {
          task_id: options.parent_task,
          action: "status_change",
          details: { subtask_added: taskId },
        },
      });
    }

    // Return from EventStore (which has the canonical local state)
    const task = this.eventStore.getTask(taskId)!;
    return this.toExtendedTask(task);
  }

  async get(id: TaskId): Promise<ExtendedTask | null> {
    // EventStore is the local mirror with richer state
    // (assigned status, outputs, agent_history, etc.)
    const task = this.eventStore.getTask(id);
    if (!task) return null;
    return this.toExtendedTask(task);
  }

  async update(id: TaskId, updates: UpdateTaskOptions): Promise<ExtendedTask> {
    this.ensureOpen();
    const task = this.eventStore.getTask(id);
    if (!task) {
      throw new OpenTasksBackendError(
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
        throw new OpenTasksBackendError(
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

      // Sync to OpenTasks
      await this.syncStatusToOpenTasks(id, updates.status);
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

      // Sync description to OpenTasks
      const issueId = this.taskToIssue.get(id);
      if (issueId) {
        await this.client.updateIssue(issueId, {
          title: updates.description,
        });
      }
    }

    const updated = this.eventStore.getTask(id)!;
    return this.toExtendedTask(updated);
  }

  async delete(id: TaskId): Promise<void> {
    this.ensureOpen();
    const issueId = this.taskToIssue.get(id);
    if (issueId) {
      await this.client.deleteIssue(issueId);
      this.taskToIssue.delete(id);
      this.issueToTask.delete(issueId);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Status Transitions
  // ─────────────────────────────────────────────────────────────────────────────

  async assign(
    id: TaskId,
    agentId: AgentId,
    options?: AssignOptions
  ): Promise<void> {
    this.ensureOpen();
    const task = this.eventStore.getTask(id);
    if (!task) {
      throw new OpenTasksBackendError(
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

    // Sync assignee to OpenTasks
    const issueId = this.taskToIssue.get(id);
    if (issueId) {
      await this.client.updateIssue(issueId, {
        assignee: agentId,
        metadata: { claimed_by: agentId },
      });
    }
  }

  async unassign(id: TaskId): Promise<void> {
    this.ensureOpen();
    const task = this.eventStore.getTask(id);
    if (!task) {
      throw new OpenTasksBackendError(
        `Task not found: ${id}`,
        "TASK_NOT_FOUND",
        id
      );
    }

    if (!task.assigned_agent) {
      throw new OpenTasksBackendError(
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
        details: { agent_id: task.assigned_agent },
      },
    });

    // Clear assignee in OpenTasks
    const issueId = this.taskToIssue.get(id);
    if (issueId) {
      await this.client.updateIssue(issueId, {
        assignee: null,
        metadata: { claimed_by: null },
      });
    }
  }

  async start(id: TaskId): Promise<void> {
    this.ensureOpen();
    const task = this.eventStore.getTask(id);
    if (!task) {
      throw new OpenTasksBackendError(
        `Task not found: ${id}`,
        "TASK_NOT_FOUND",
        id
      );
    }

    const validTransitions = VALID_STATUS_TRANSITIONS[task.status];
    if (!validTransitions.includes("in_progress")) {
      throw new OpenTasksBackendError(
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

    await this.syncStatusToOpenTasks(id, "in_progress");
  }

  async complete(id: TaskId, outputs?: TaskOutputs): Promise<void> {
    this.ensureOpen();
    const task = this.eventStore.getTask(id);
    if (!task) {
      throw new OpenTasksBackendError(
        `Task not found: ${id}`,
        "TASK_NOT_FOUND",
        id
      );
    }

    const validTransitions = VALID_STATUS_TRANSITIONS[task.status];
    if (!validTransitions.includes("completed")) {
      throw new OpenTasksBackendError(
        `Invalid status transition: ${task.status} -> completed`,
        "INVALID_STATUS_TRANSITION",
        id
      );
    }

    const agent = task.assigned_agent ?? task.created_by;

    // Store outputs
    if (outputs) {
      const outputsToStore: Record<string, unknown> = {
        ...(outputs.data ?? {}),
      };
      if (outputs.summary !== undefined) {
        outputsToStore.summary = outputs.summary;
      }
      if (Object.keys(outputsToStore).length > 0) {
        this.eventStore.emit({
          type: "task",
          source: { agent_id: agent },
          payload: {
            task_id: id,
            action: "status_change",
            details: { outputs: outputsToStore },
          },
        });
      }
      if (outputs.artifacts) {
        this.eventStore.emit({
          type: "task",
          source: { agent_id: agent },
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
      source: { agent_id: agent },
      payload: {
        task_id: id,
        action: "completed",
        details: {},
      },
    });

    // Close the issue in OpenTasks
    await this.syncStatusToOpenTasks(id, "completed");
  }

  async fail(id: TaskId, error: TaskError): Promise<void> {
    this.ensureOpen();
    const task = this.eventStore.getTask(id);
    if (!task) {
      throw new OpenTasksBackendError(
        `Task not found: ${id}`,
        "TASK_NOT_FOUND",
        id
      );
    }

    const validTransitions = VALID_STATUS_TRANSITIONS[task.status];
    if (!validTransitions.includes("failed")) {
      throw new OpenTasksBackendError(
        `Invalid status transition: ${task.status} -> failed`,
        "INVALID_STATUS_TRANSITION",
        id
      );
    }

    const agent = task.assigned_agent ?? task.created_by;

    // Store error in outputs
    this.eventStore.emit({
      type: "task",
      source: { agent_id: agent },
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
      source: { agent_id: agent },
      payload: {
        task_id: id,
        action: "failed",
        details: {},
      },
    });

    // Close in OpenTasks with error metadata
    const issueId = this.taskToIssue.get(id);
    if (issueId) {
      await this.client.updateIssue(issueId, {
        status: "closed",
        metadata: {
          macro_agent_failed: true,
          macro_agent_error: error.message,
        },
      });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Queries
  // ─────────────────────────────────────────────────────────────────────────────

  async list(filter?: TaskFilter): Promise<ExtendedTask[]> {
    let tasks = this.eventStore.listTasks();

    if (filter) {
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

      if (filter.tags && filter.tags.length > 0) {
        const filterTags = new Set(filter.tags);
        tasks = tasks.filter(
          (t) => t.tags?.some((tag) => filterTags.has(tag))
        );
      }
    }

    // Compute isBlocked using OpenTasks graph for mapped tasks,
    // EventStore blockers for unmapped tasks
    const extended = await Promise.all(
      tasks.map((t) => this.toExtendedTaskAsync(t))
    );

    if (!filter?.includeBlocked) {
      return extended.filter((t) => !t.isBlocked);
    }

    return extended;
  }

  async listReady(filter?: TaskFilter): Promise<ExtendedTask[]> {
    return this.list({
      ...filter,
      status: filter?.status ?? ["pending", "assigned"],
      includeBlocked: false,
    });
  }

  async getChildren(parentId: TaskId): Promise<ExtendedTask[]> {
    const tasks = this.eventStore.listTasks();
    const children = tasks.filter((t) => t.parent_task === parentId);
    return Promise.all(children.map((t) => this.toExtendedTaskAsync(t)));
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
  // Dependencies (via OpenTasks edges)
  // ─────────────────────────────────────────────────────────────────────────────

  async addBlocker(taskId: TaskId, blockerId: TaskId): Promise<void> {
    this.ensureOpen();
    const task = this.eventStore.getTask(taskId);
    if (!task) {
      throw new OpenTasksBackendError(
        `Task not found: ${taskId}`,
        "TASK_NOT_FOUND",
        taskId
      );
    }

    const blocker = this.eventStore.getTask(blockerId);
    if (!blocker) {
      throw new OpenTasksBackendError(
        `Blocker task not found: ${blockerId}`,
        "TASK_NOT_FOUND",
        blockerId
      );
    }

    // Record in EventStore
    this.eventStore.emit({
      type: "task",
      source: { agent_id: task.assigned_agent ?? task.created_by },
      payload: {
        task_id: taskId,
        action: "blocker_added",
        details: { blocker_id: blockerId },
      },
    });

    // Create 'blocks' edge in OpenTasks if both tasks are mapped
    const blockerIssueId = this.taskToIssue.get(blockerId);
    const taskIssueId = this.taskToIssue.get(taskId);
    if (blockerIssueId && taskIssueId) {
      await this.client.createEdge(blockerIssueId, taskIssueId, "blocks");
    }
  }

  async removeBlocker(taskId: TaskId, blockerId: TaskId): Promise<void> {
    this.ensureOpen();
    const task = this.eventStore.getTask(taskId);
    if (!task) {
      throw new OpenTasksBackendError(
        `Task not found: ${taskId}`,
        "TASK_NOT_FOUND",
        taskId
      );
    }

    // Record in EventStore
    this.eventStore.emit({
      type: "task",
      source: { agent_id: task.assigned_agent ?? task.created_by },
      payload: {
        task_id: taskId,
        action: "blocker_removed",
        details: { blocker_id: blockerId },
      },
    });

    // Remove 'blocks' edge in OpenTasks if both are mapped
    const blockerIssueId = this.taskToIssue.get(blockerId);
    const taskIssueId = this.taskToIssue.get(taskId);
    if (blockerIssueId && taskIssueId) {
      await this.client.removeEdge(blockerIssueId, taskIssueId, "blocks");
    }
  }

  async getBlockers(taskId: TaskId): Promise<ExtendedTask[]> {
    const task = this.eventStore.getTask(taskId);
    if (!task) {
      throw new OpenTasksBackendError(
        `Task not found: ${taskId}`,
        "TASK_NOT_FOUND",
        taskId
      );
    }

    // Try OpenTasks first for mapped tasks
    const issueId = this.taskToIssue.get(taskId);
    if (issueId) {
      try {
        const blockerSummaries = await this.client.getBlockers(issueId);
        const blockers: ExtendedTask[] = [];
        for (const summary of blockerSummaries) {
          const blockerTaskId = this.issueToTask.get(summary.id);
          if (blockerTaskId) {
            const blockerTask = this.eventStore.getTask(blockerTaskId);
            if (blockerTask) {
              blockers.push(this.toExtendedTask(blockerTask));
            }
          }
        }
        return blockers;
      } catch {
        // Fall through to EventStore
      }
    }

    // Fallback: use EventStore blockers
    const blockerIds = task.blockers ?? [];
    const blockers: ExtendedTask[] = [];
    for (const blockerId of blockerIds) {
      const blocker = this.eventStore.getTask(blockerId);
      if (blocker) {
        blockers.push(this.toExtendedTask(blocker));
      }
    }
    return blockers;
  }

  async getBlocking(taskId: TaskId): Promise<ExtendedTask[]> {
    const task = this.eventStore.getTask(taskId);
    if (!task) {
      throw new OpenTasksBackendError(
        `Task not found: ${taskId}`,
        "TASK_NOT_FOUND",
        taskId
      );
    }

    // Try OpenTasks first for mapped tasks
    const issueId = this.taskToIssue.get(taskId);
    if (issueId) {
      try {
        const blockingSummaries = await this.client.getBlocking(issueId);
        const blocking: ExtendedTask[] = [];
        for (const summary of blockingSummaries) {
          const blockedTaskId = this.issueToTask.get(summary.id);
          if (blockedTaskId) {
            const blockedTask = this.eventStore.getTask(blockedTaskId);
            if (blockedTask) {
              blocking.push(this.toExtendedTask(blockedTask));
            }
          }
        }
        return blocking;
      } catch {
        // Fall through to EventStore
      }
    }

    // Fallback: scan EventStore
    const allTasks = this.eventStore.listTasks();
    const blocking = allTasks.filter((t) => t.blockers?.includes(taskId));
    return blocking.map((t) => this.toExtendedTask(t));
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Pull Model (Claim/Unclaim)
  // ─────────────────────────────────────────────────────────────────────────────

  async claim(
    agentId: AgentId,
    filter?: ClaimFilter
  ): Promise<ExtendedTask | null> {
    this.ensureOpen();
    const candidates = await this.listClaimable(filter);

    if (candidates.length === 0) {
      return null;
    }

    const task = candidates[0];

    // Re-check for contention
    const current = this.eventStore.getTask(task.id);
    if (!current || current.status !== "pending" || current.assigned_agent) {
      return null;
    }

    // Assign locally
    this.eventStore.emit({
      type: "task",
      source: { agent_id: agentId },
      payload: {
        task_id: task.id,
        action: "assigned",
        details: { agent_id: agentId },
      },
    });

    // Claim in OpenTasks
    const issueId = this.taskToIssue.get(task.id);
    if (issueId) {
      await this.client.updateIssue(issueId, {
        assignee: agentId,
        metadata: { claimed_by: agentId },
      });
    }

    const assigned = this.eventStore.getTask(task.id)!;
    return this.toExtendedTask(assigned);
  }

  async unclaim(taskId: TaskId): Promise<void> {
    this.ensureOpen();
    const task = this.eventStore.getTask(taskId);
    if (!task) {
      throw new OpenTasksBackendError(
        `Task not found: ${taskId}`,
        "TASK_NOT_FOUND",
        taskId
      );
    }

    if (!task.assigned_agent) {
      throw new OpenTasksBackendError(
        `Task is not assigned: ${taskId}`,
        "TASK_NOT_ASSIGNED",
        taskId
      );
    }

    this.eventStore.emit({
      type: "task",
      source: { agent_id: task.assigned_agent },
      payload: {
        task_id: taskId,
        action: "unassigned",
        details: { agent_id: task.assigned_agent },
      },
    });

    // Unclaim in OpenTasks
    const issueId = this.taskToIssue.get(taskId);
    if (issueId) {
      await this.client.updateIssue(issueId, {
        assignee: null,
        metadata: { claimed_by: null },
      });
    }
  }

  async listClaimable(filter?: ClaimFilter): Promise<ExtendedTask[]> {
    let tasks = this.eventStore.listTasks();

    // Only pending, unassigned tasks
    tasks = tasks.filter(
      (t) => t.status === "pending" && !t.assigned_agent
    );

    if (filter) {
      if (filter.tags && filter.tags.length > 0) {
        const filterTags = new Set(filter.tags);
        tasks = tasks.filter(
          (t) => t.tags?.some((tag) => filterTags.has(tag))
        );
      }

      if (filter.rootTasksOnly) {
        tasks = tasks.filter((t) => !t.parent_task);
      }

      if (filter.created_by) {
        tasks = tasks.filter((t) => t.created_by === filter.created_by);
      }
    }

    // Filter out blocked tasks
    const extended = await Promise.all(
      tasks.map((t) => this.toExtendedTaskAsync(t))
    );
    return extended.filter((t) => !t.isBlocked);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // History
  // ─────────────────────────────────────────────────────────────────────────────

  async getAgentHistory(taskId: TaskId): Promise<AgentHistoryEntry[]> {
    const task = this.eventStore.getTask(taskId);
    if (!task) {
      throw new OpenTasksBackendError(
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

    const seenTaskIds = new Set<TaskId>();

    return this.eventStore.onTaskChange((taskId, task) => {
      if (filterTaskId && taskId !== filterTaskId) return;

      let eventType: TaskChangeEvent["type"];
      if (!task) {
        eventType = "deleted";
      } else if (seenTaskIds.has(taskId)) {
        eventType = "updated";
      } else {
        eventType = "created";
        seenTaskIds.add(taskId);
      }

      const event: TaskChangeEvent = {
        type: eventType,
        taskId,
        task: task ? this.toExtendedTask(task) : ({} as ExtendedTask),
      };

      callback(event);
    });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Public Utility Methods
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Get the OpenTasks issue ID for a macro-agent task.
   * Returns undefined if the task is not mapped to an issue.
   */
  getIssueForTask(taskId: TaskId): string | undefined {
    return this.taskToIssue.get(taskId);
  }

  /**
   * Get the macro-agent task ID for an OpenTasks issue.
   * Returns undefined if the issue is not mapped to a task.
   */
  getTaskForIssue(issueId: string): TaskId | undefined {
    return this.issueToTask.get(issueId);
  }

  /**
   * Import an existing OpenTasks issue as a macro-agent task.
   * This is useful for pulling tasks from OpenTasks into macro-agent.
   */
  async importIssue(
    issueId: string,
    createdBy: AgentId
  ): Promise<ExtendedTask> {
    this.ensureOpen();
    // Check if already imported
    const existingTaskId = this.issueToTask.get(issueId);
    if (existingTaskId) {
      const existing = await this.get(existingTaskId);
      if (existing) return existing;
    }

    const issue = await this.client.getIssue(issueId);
    if (!issue) {
      throw new OpenTasksBackendError(
        `OpenTasks issue not found: ${issueId}`,
        "NOT_FOUND"
      );
    }

    const taskId = `task_${nanoid(12)}`;

    // Store mapping
    this.taskToIssue.set(taskId, issueId);
    this.issueToTask.set(issueId, taskId);

    // Determine task status from issue
    const taskStatus = mapOpenTasksStatus(issue.status);

    // Create in EventStore
    this.eventStore.emit({
      type: "task",
      source: { agent_id: createdBy },
      payload: {
        task_id: taskId,
        action: "created",
        details: {
          description: issue.title,
          tags: issue.tags,
          external_id: issueId,
        },
      },
    });

    // If issue is not open/pending, transition to the right status
    if (taskStatus === "in_progress") {
      this.eventStore.emit({
        type: "task",
        source: { agent_id: createdBy },
        payload: {
          task_id: taskId,
          action: "status_change",
          details: { status: "in_progress" },
        },
      });
    } else if (taskStatus === "completed") {
      this.eventStore.emit({
        type: "task",
        source: { agent_id: createdBy },
        payload: {
          task_id: taskId,
          action: "completed",
          details: {},
        },
      });
    }

    // If issue has an assignee, assign
    if (issue.assignee) {
      this.eventStore.emit({
        type: "task",
        source: { agent_id: issue.assignee },
        payload: {
          task_id: taskId,
          action: "assigned",
          details: { agent_id: issue.assignee },
        },
      });
    }

    return this.issueToExtendedTask(issue, taskId);
  }

  /**
   * Bulk import all open issues from OpenTasks as tasks.
   */
  async importOpenIssues(createdBy: AgentId): Promise<ExtendedTask[]> {
    this.ensureOpen();
    const issues = await this.client.listIssues({
      status: ["open", "in_progress"],
      archived: false,
    });

    const tasks: ExtendedTask[] = [];
    for (const issue of issues) {
      // Skip already-imported issues
      if (this.issueToTask.has(issue.id)) continue;

      // Skip issues not created by macro-agent (unless they have no source)
      // This allows importing issues from other sources too
      const task = await this.importIssue(issue.id, createdBy);
      tasks.push(task);
    }

    return tasks;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Private Helpers
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Sync a task status change to OpenTasks.
   */
  private async syncStatusToOpenTasks(
    taskId: TaskId,
    status: TaskStatus
  ): Promise<void> {
    if (!this.config.syncStatus) return;

    const issueId = this.taskToIssue.get(taskId);
    if (!issueId) return;

    const openTasksStatus = mapTaskStatus(status);
    try {
      await this.client.updateIssue(issueId, {
        status: openTasksStatus,
      });
    } catch (error) {
      // Log but don't fail - sync is best-effort
      console.warn(
        `Failed to sync status to OpenTasks for ${taskId} (${issueId}): ${error}`
      );
    }
  }

  /**
   * Convert an EventStore Task to ExtendedTask with isBlocked computed
   * from local blockers.
   */
  private toExtendedTask(task: Task): ExtendedTask {
    const blockerIds = task.blockers ?? [];
    let isBlocked = false;

    for (const blockerId of blockerIds) {
      const blocker = this.eventStore.getTask(blockerId);
      if (blocker && blocker.status !== "completed") {
        isBlocked = true;
        break;
      }
    }

    return {
      ...task,
      isBlocked,
      external_id: this.taskToIssue.get(task.id),
    };
  }

  /**
   * Convert an EventStore Task to ExtendedTask with isBlocked computed
   * from OpenTasks graph (async, checks remote blockers).
   */
  private async toExtendedTaskAsync(task: Task): Promise<ExtendedTask> {
    const issueId = this.taskToIssue.get(task.id);

    // If mapped to OpenTasks, use graph-based blocking
    if (issueId) {
      try {
        const blockers = await this.client.getBlockers(issueId);
        const hasActiveBlockers = blockers.some(
          (b) => b.status && !isIssueComplete(b.status)
        );
        return {
          ...task,
          isBlocked: hasActiveBlockers,
          external_id: issueId,
        };
      } catch {
        // Fall through to local check
      }
    }

    return this.toExtendedTask(task);
  }

  /**
   * Convert an OpenTasks issue to an ExtendedTask.
   */
  private issueToExtendedTask(
    issue: OpenTasksIssue,
    taskId: TaskId
  ): ExtendedTask {
    const taskStatus = mapOpenTasksStatus(issue.status);

    return {
      id: taskId,
      description: issue.title,
      status: taskStatus,
      assigned_agent: issue.assignee,
      parent_task: undefined, // Resolved separately if needed
      subtasks: undefined,
      blockers: undefined,
      created_at: new Date(issue.created_at).getTime(),
      started_at: taskStatus === "in_progress"
        ? new Date(issue.updated_at).getTime()
        : undefined,
      completed_at: issue.closed_at
        ? new Date(issue.closed_at).getTime()
        : undefined,
      created_by: (issue.metadata?.created_by as string) ?? "unknown",
      tags: issue.tags,
      isBlocked: issue.status === "blocked",
      external_id: issue.id,
    };
  }
}

/**
 * Create an OpenTasksTaskBackend instance.
 */
export function createOpenTasksTaskBackend(
  eventStore: EventStore,
  client: OpenTasksClient,
  config?: Partial<OpenTasksBackendConfig>
): OpenTasksTaskBackend {
  return new OpenTasksTaskBackend(eventStore, client, config);
}
