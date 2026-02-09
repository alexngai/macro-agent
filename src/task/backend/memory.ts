/**
 * InMemory Task Backend Implementation
 *
 * Implements TaskBackend interface using EventStore for persistence.
 * Provides async interface over synchronous EventStore operations.
 *
 * @module task/backend/memory
 * @implements [[s-8472]] Pluggable Task Backend Integration
 */

import { nanoid } from "nanoid";
import type { EventStore } from "../../store/event-store.js";
import type {
  Task,
  TaskStatus,
  AgentId,
  TaskId,
  AgentHistoryEntry,
} from "../../store/types/index.js";
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
} from "./types.js";

// Valid status transitions (same as TaskManager)
const VALID_STATUS_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  pending: ["assigned", "in_progress", "failed"],
  assigned: ["in_progress", "pending", "failed"],
  in_progress: ["completed", "failed", "pending"],
  completed: [], // Terminal state
  failed: ["pending"], // Can retry
};

/**
 * Error thrown by InMemoryTaskBackend operations
 */
export class TaskBackendError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly taskId?: TaskId
  ) {
    super(message);
    this.name = "TaskBackendError";
  }
}

/**
 * InMemoryTaskBackend implements TaskBackend using EventStore.
 *
 * Key features:
 * - Wraps EventStore for task persistence
 * - Adds dependency/blocker tracking
 * - Computes isBlocked field
 * - Provides async interface
 */
export class InMemoryTaskBackend implements TaskBackend {
  constructor(private readonly eventStore: EventStore) {}

  // ─────────────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ─────────────────────────────────────────────────────────────────────────────

  async create(options: CreateTaskOptions): Promise<ExtendedTask> {
    const taskId = `task_${nanoid(12)}`;

    // Validate parent task exists if specified
    if (options.parent_task) {
      const parent = this.eventStore.getTask(options.parent_task);
      if (!parent) {
        throw new TaskBackendError(
          `Parent task not found: ${options.parent_task}`,
          "PARENT_TASK_NOT_FOUND",
          options.parent_task
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
          tags: options.tags,
        },
      },
    });

    // If this is a subtask, update parent's subtasks array
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
      throw new TaskBackendError(`Task not found: ${id}`, "TASK_NOT_FOUND", id);
    }

    const source = task.assigned_agent ?? task.created_by;

    // Handle status update with validation
    if (updates.status !== undefined) {
      const validTransitions = VALID_STATUS_TRANSITIONS[task.status];
      if (!validTransitions.includes(updates.status)) {
        throw new TaskBackendError(
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

  async delete(_id: TaskId): Promise<void> {
    // Tasks are immutable in event-sourced system - no delete operation
    throw new TaskBackendError(
      "Delete operation not supported - tasks are immutable",
      "NOT_SUPPORTED"
    );
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
      throw new TaskBackendError(`Task not found: ${id}`, "TASK_NOT_FOUND", id);
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
  }

  async unassign(id: TaskId): Promise<void> {
    const task = this.eventStore.getTask(id);
    if (!task) {
      throw new TaskBackendError(`Task not found: ${id}`, "TASK_NOT_FOUND", id);
    }

    if (!task.assigned_agent) {
      throw new TaskBackendError(
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
      throw new TaskBackendError(`Task not found: ${id}`, "TASK_NOT_FOUND", id);
    }

    const validTransitions = VALID_STATUS_TRANSITIONS[task.status];
    if (!validTransitions.includes("in_progress")) {
      throw new TaskBackendError(
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
  }

  async complete(id: TaskId, outputs?: TaskOutputs): Promise<void> {
    const task = this.eventStore.getTask(id);
    if (!task) {
      throw new TaskBackendError(`Task not found: ${id}`, "TASK_NOT_FOUND", id);
    }

    const validTransitions = VALID_STATUS_TRANSITIONS[task.status];
    if (!validTransitions.includes("completed")) {
      throw new TaskBackendError(
        `Invalid status transition: ${task.status} -> completed`,
        "INVALID_STATUS_TRANSITION",
        id
      );
    }

    // Add outputs if provided
    if (outputs) {
      // Merge summary and data into outputs object
      const outputsToStore: Record<string, unknown> = {
        ...(outputs.data ?? {}),
      };
      if (outputs.summary !== undefined) {
        outputsToStore.summary = outputs.summary;
      }

      if (Object.keys(outputsToStore).length > 0) {
        this.eventStore.emit({
          type: "task",
          source: { agent_id: task.assigned_agent ?? task.created_by },
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
  }

  async fail(id: TaskId, error: TaskError): Promise<void> {
    const task = this.eventStore.getTask(id);
    if (!task) {
      throw new TaskBackendError(`Task not found: ${id}`, "TASK_NOT_FOUND", id);
    }

    const validTransitions = VALID_STATUS_TRANSITIONS[task.status];
    if (!validTransitions.includes("failed")) {
      throw new TaskBackendError(
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
      // Filter by status (supports single or array)
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

    // Convert to ExtendedTask and filter blocked if needed
    const extended = tasks.map((t) => this.toExtendedTask(t));

    // By default, exclude blocked tasks unless includeBlocked is true
    if (!filter?.includeBlocked) {
      return extended.filter((t) => !t.isBlocked);
    }

    return extended;
  }

  async listReady(filter?: TaskFilter): Promise<ExtendedTask[]> {
    // Ready tasks are pending/assigned with no incomplete blockers
    const tasks = await this.list({
      ...filter,
      status: filter?.status ?? ["pending", "assigned"],
      includeBlocked: false, // Always exclude blocked for listReady
    });

    return tasks;
  }

  async getChildren(parentId: TaskId): Promise<ExtendedTask[]> {
    const tasks = this.eventStore.listTasks();
    const children = tasks.filter((t) => t.parent_task === parentId);
    return children.map((t) => this.toExtendedTask(t));
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
      throw new TaskBackendError(
        `Task not found: ${taskId}`,
        "TASK_NOT_FOUND",
        taskId
      );
    }

    const blocker = this.eventStore.getTask(blockerId);
    if (!blocker) {
      throw new TaskBackendError(
        `Blocker task not found: ${blockerId}`,
        "TASK_NOT_FOUND",
        blockerId
      );
    }

    this.eventStore.emit({
      type: "task",
      source: { agent_id: task.assigned_agent ?? task.created_by },
      payload: {
        task_id: taskId,
        action: "blocker_added",
        details: { blocker_id: blockerId },
      },
    });
  }

  async removeBlocker(taskId: TaskId, blockerId: TaskId): Promise<void> {
    const task = this.eventStore.getTask(taskId);
    if (!task) {
      throw new TaskBackendError(
        `Task not found: ${taskId}`,
        "TASK_NOT_FOUND",
        taskId
      );
    }

    this.eventStore.emit({
      type: "task",
      source: { agent_id: task.assigned_agent ?? task.created_by },
      payload: {
        task_id: taskId,
        action: "blocker_removed",
        details: { blocker_id: blockerId },
      },
    });
  }

  async getBlockers(taskId: TaskId): Promise<ExtendedTask[]> {
    const task = this.eventStore.getTask(taskId);
    if (!task) {
      throw new TaskBackendError(
        `Task not found: ${taskId}`,
        "TASK_NOT_FOUND",
        taskId
      );
    }

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
      throw new TaskBackendError(
        `Task not found: ${taskId}`,
        "TASK_NOT_FOUND",
        taskId
      );
    }

    // Find all tasks that have this task in their blockers
    const allTasks = this.eventStore.listTasks();
    const blocking = allTasks.filter((t) => t.blockers?.includes(taskId));

    return blocking.map((t) => this.toExtendedTask(t));
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // History
  // ─────────────────────────────────────────────────────────────────────────────

  async getAgentHistory(taskId: TaskId): Promise<AgentHistoryEntry[]> {
    const task = this.eventStore.getTask(taskId);
    if (!task) {
      throw new TaskBackendError(
        `Task not found: ${taskId}`,
        "TASK_NOT_FOUND",
        taskId
      );
    }

    return task.agent_history ?? [];
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Pull Model (Claim/Unclaim)
  // ─────────────────────────────────────────────────────────────────────────────

  async claim(
    agentId: AgentId,
    filter?: ClaimFilter
  ): Promise<ExtendedTask | null> {
    // Find claimable tasks: pending, not blocked, not assigned
    const candidates = await this.listClaimable(filter);

    if (candidates.length === 0) {
      return null;
    }

    // Take the first candidate (oldest pending task by creation time)
    const task = candidates[0];

    // Atomically assign (within the same process, EventStore is synchronous)
    // Re-check status to handle contention
    const current = this.eventStore.getTask(task.id);
    if (!current || current.status !== "pending" || current.assigned_agent) {
      // Task was claimed by another agent between our check and assignment
      return null;
    }

    // Assign to the claiming agent
    this.eventStore.emit({
      type: "task",
      source: { agent_id: agentId },
      payload: {
        task_id: task.id,
        action: "assigned",
        details: {
          agent_id: agentId,
        },
      },
    });

    const assigned = this.eventStore.getTask(task.id)!;
    return this.toExtendedTask(assigned);
  }

  async unclaim(taskId: TaskId): Promise<void> {
    const task = this.eventStore.getTask(taskId);
    if (!task) {
      throw new TaskBackendError(
        `Task not found: ${taskId}`,
        "TASK_NOT_FOUND",
        taskId
      );
    }

    if (!task.assigned_agent) {
      throw new TaskBackendError(
        `Task is not assigned: ${taskId}`,
        "TASK_NOT_ASSIGNED",
        taskId
      );
    }

    // Return to pending status
    this.eventStore.emit({
      type: "task",
      source: { agent_id: task.assigned_agent },
      payload: {
        task_id: taskId,
        action: "unassigned",
        details: {
          agent_id: task.assigned_agent,
        },
      },
    });
  }

  async listClaimable(filter?: ClaimFilter): Promise<ExtendedTask[]> {
    let tasks = this.eventStore.listTasks();

    // Only pending tasks (not assigned, not in_progress, etc.)
    tasks = tasks.filter(
      (t) => t.status === "pending" && !t.assigned_agent
    );

    // Apply claim filter
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
    return tasks
      .map((t) => this.toExtendedTask(t))
      .filter((t) => !t.isBlocked);
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
    // Determine if filtering by taskId
    const filterTaskId =
      typeof callbackOrTaskId === "string" ? callbackOrTaskId : undefined;
    const callback =
      typeof callbackOrTaskId === "function"
        ? callbackOrTaskId
        : maybeCallback!;

    // Track seen task IDs to distinguish "created" from "updated"
    const seenTaskIds = new Set<TaskId>();

    // Wrap EventStore's onTaskChange
    return this.eventStore.onTaskChange((taskId, task) => {
      // If filtering by taskId, skip non-matching events
      if (filterTaskId && taskId !== filterTaskId) {
        return;
      }

      // Determine event type
      let eventType: TaskChangeEvent["type"];
      if (!task) {
        eventType = "deleted";
      } else if (seenTaskIds.has(taskId)) {
        eventType = "updated";
      } else {
        eventType = "created";
        seenTaskIds.add(taskId);
      }

      // Build TaskChangeEvent
      const event: TaskChangeEvent = {
        type: eventType,
        taskId,
        task: task ? this.toExtendedTask(task) : ({} as ExtendedTask),
      };

      callback(event);
    });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Private Helpers
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Convert a Task to ExtendedTask with computed isBlocked field
   */
  private toExtendedTask(task: Task): ExtendedTask {
    const blockerIds = task.blockers ?? [];
    let isBlocked = false;

    // Check if any blocker is not completed
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
    };
  }
}

/**
 * Create an InMemoryTaskBackend instance.
 *
 * @param eventStore - EventStore instance for persistence
 * @returns InMemoryTaskBackend instance
 */
export function createInMemoryTaskBackend(
  eventStore: EventStore
): InMemoryTaskBackend {
  return new InMemoryTaskBackend(eventStore);
}
