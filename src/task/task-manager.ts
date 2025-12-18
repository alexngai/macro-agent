/**
 * TaskManager - Service for managing task lifecycle
 *
 * Handles task creation, assignment, status updates, and hierarchical decomposition.
 */

import { nanoid } from "nanoid";
import type { EventStore } from "../store/event-store.js";
import type {
  Task,
  TaskId,
  TaskStatus,
  AgentId,
  ArtifactRef,
} from "../store/types/index.js";
import type {
  CreateTaskOptions,
  UpdateTaskOptions,
  TaskFilter,
  SubtaskStatus,
} from "./types.js";
import { TaskManagerError, VALID_STATUS_TRANSITIONS } from "./types.js";

// ─────────────────────────────────────────────────────────────────
// TaskManager Interface
// ─────────────────────────────────────────────────────────────────

export interface TaskManager {
  // ── Creation ───────────────────────────────────────────────────

  /**
   * Create a new task.
   */
  create(options: CreateTaskOptions): Task;

  /**
   * Create a subtask under a parent task.
   */
  createSubtask(
    parentTaskId: TaskId,
    options: Omit<CreateTaskOptions, "parent_task">,
  ): Task;

  // ── Retrieval ──────────────────────────────────────────────────

  /**
   * Get task by ID.
   */
  get(taskId: TaskId): Task | null;

  /**
   * List tasks with optional filters.
   */
  list(filter?: TaskFilter): Task[];

  /**
   * Get subtasks of a task.
   */
  getSubtasks(taskId: TaskId): Task[];

  /**
   * Get aggregate status of subtasks.
   */
  getSubtaskStatus(taskId: TaskId): SubtaskStatus;

  // ── Assignment ─────────────────────────────────────────────────

  /**
   * Assign an agent to a task.
   */
  assign(taskId: TaskId, agentId: AgentId, role?: string): void;

  /**
   * Unassign the current agent from a task.
   */
  unassign(taskId: TaskId): void;

  // ── Status Updates ─────────────────────────────────────────────

  /**
   * Update task status with validation.
   */
  updateStatus(taskId: TaskId, status: TaskStatus): void;

  // ── Metadata Updates ───────────────────────────────────────────

  /**
   * Update task metadata (outputs, artifacts, description).
   */
  update(taskId: TaskId, updates: UpdateTaskOptions): void;
}

// ─────────────────────────────────────────────────────────────────
// TaskManager Implementation
// ─────────────────────────────────────────────────────────────────

export function createTaskManager(eventStore: EventStore): TaskManager {
  // ─────────────────────────────────────────────────────────────────
  // Creation
  // ─────────────────────────────────────────────────────────────────

  function create(options: CreateTaskOptions): Task {
    const { description, created_by, parent_task, inputs } = options;

    const taskId = `task_${nanoid(12)}`;

    // Validate parent task exists if specified
    if (parent_task) {
      const parent = eventStore.getTask(parent_task);
      if (!parent) {
        throw new TaskManagerError(
          `Parent task not found: ${parent_task}`,
          "PARENT_TASK_NOT_FOUND",
          parent_task,
        );
      }
    }

    // Emit task created event
    eventStore.emit({
      type: "task",
      source: { agent_id: created_by },
      payload: {
        task_id: taskId,
        action: "created",
        details: {
          description,
          parent_task,
          inputs,
        },
      },
    });

    // If this is a subtask, update parent's subtasks array
    if (parent_task) {
      eventStore.emit({
        type: "task",
        source: { agent_id: created_by },
        payload: {
          task_id: parent_task,
          action: "status_change",
          details: {
            subtask_added: taskId,
          },
        },
      });
    }

    return eventStore.getTask(taskId)!;
  }

  function createSubtask(
    parentTaskId: TaskId,
    options: Omit<CreateTaskOptions, "parent_task">,
  ): Task {
    return create({
      ...options,
      parent_task: parentTaskId,
    });
  }

  // ─────────────────────────────────────────────────────────────────
  // Retrieval
  // ─────────────────────────────────────────────────────────────────

  function get(taskId: TaskId): Task | null {
    return eventStore.getTask(taskId);
  }

  function list(filter?: TaskFilter): Task[] {
    let tasks = eventStore.listTasks();

    if (filter) {
      if (filter.status) {
        tasks = tasks.filter((t) => t.status === filter.status);
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

    return tasks;
  }

  function getSubtasks(taskId: TaskId): Task[] {
    return list({ parent_task: taskId });
  }

  function getSubtaskStatus(taskId: TaskId): SubtaskStatus {
    const subtasks = getSubtasks(taskId);

    const status: SubtaskStatus = {
      total: subtasks.length,
      pending: 0,
      assigned: 0,
      in_progress: 0,
      completed: 0,
      failed: 0,
      allCompleted: false,
      anyFailed: false,
    };

    for (const task of subtasks) {
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

    status.allCompleted = status.total > 0 && status.completed === status.total;
    status.anyFailed = status.failed > 0;

    return status;
  }

  // ─────────────────────────────────────────────────────────────────
  // Assignment
  // ─────────────────────────────────────────────────────────────────

  function assign(taskId: TaskId, agentId: AgentId, role?: string): void {
    const task = eventStore.getTask(taskId);
    if (!task) {
      throw new TaskManagerError(
        `Task not found: ${taskId}`,
        "TASK_NOT_FOUND",
        taskId,
      );
    }

    // Emit assigned event
    eventStore.emit({
      type: "task",
      source: { agent_id: agentId },
      payload: {
        task_id: taskId,
        action: "assigned",
        details: {
          agent_id: agentId,
          role,
        },
      },
    });
  }

  function unassign(taskId: TaskId): void {
    const task = eventStore.getTask(taskId);
    if (!task) {
      throw new TaskManagerError(
        `Task not found: ${taskId}`,
        "TASK_NOT_FOUND",
        taskId,
      );
    }

    if (!task.assigned_agent) {
      throw new TaskManagerError(
        `Task is not assigned: ${taskId}`,
        "TASK_NOT_ASSIGNED",
        taskId,
      );
    }

    // Emit unassigned event
    eventStore.emit({
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

  // ─────────────────────────────────────────────────────────────────
  // Status Updates
  // ─────────────────────────────────────────────────────────────────

  function updateStatus(taskId: TaskId, newStatus: TaskStatus): void {
    const task = eventStore.getTask(taskId);
    if (!task) {
      throw new TaskManagerError(
        `Task not found: ${taskId}`,
        "TASK_NOT_FOUND",
        taskId,
      );
    }

    // Validate transition
    const validTransitions = VALID_STATUS_TRANSITIONS[task.status];
    if (!validTransitions.includes(newStatus)) {
      throw new TaskManagerError(
        `Invalid status transition: ${task.status} -> ${newStatus}`,
        "INVALID_STATUS_TRANSITION",
        taskId,
      );
    }

    // Determine action based on new status
    let action: string;
    if (newStatus === "completed") {
      action = "completed";
    } else if (newStatus === "failed") {
      action = "failed";
    } else {
      action = "status_change";
    }

    // Emit status change event
    eventStore.emit({
      type: "task",
      source: { agent_id: task.assigned_agent ?? task.created_by },
      payload: {
        task_id: taskId,
        action,
        details: {
          status: newStatus,
        },
      },
    });
  }

  // ─────────────────────────────────────────────────────────────────
  // Metadata Updates
  // ─────────────────────────────────────────────────────────────────

  function update(taskId: TaskId, updates: UpdateTaskOptions): void {
    const task = eventStore.getTask(taskId);
    if (!task) {
      throw new TaskManagerError(
        `Task not found: ${taskId}`,
        "TASK_NOT_FOUND",
        taskId,
      );
    }

    // Emit update event for each type of update
    if (updates.outputs !== undefined) {
      eventStore.emit({
        type: "task",
        source: { agent_id: task.assigned_agent ?? task.created_by },
        payload: {
          task_id: taskId,
          action: "status_change",
          details: {
            outputs: updates.outputs,
          },
        },
      });
    }

    if (updates.artifacts !== undefined) {
      eventStore.emit({
        type: "task",
        source: { agent_id: task.assigned_agent ?? task.created_by },
        payload: {
          task_id: taskId,
          action: "status_change",
          details: {
            artifacts: updates.artifacts,
          },
        },
      });
    }

    if (updates.description !== undefined) {
      eventStore.emit({
        type: "task",
        source: { agent_id: task.assigned_agent ?? task.created_by },
        payload: {
          task_id: taskId,
          action: "status_change",
          details: {
            description: updates.description,
          },
        },
      });
    }
  }

  return {
    create,
    createSubtask,
    get,
    list,
    getSubtasks,
    getSubtaskStatus,
    assign,
    unassign,
    updateStatus,
    update,
  };
}
