/**
 * TaskManager type definitions
 */

import type {
  AgentId,
  TaskId,
  Task,
  TaskStatus,
  ArtifactRef,
} from "../store/types/index.js";

// ─────────────────────────────────────────────────────────────────
// Create Task Options
// ─────────────────────────────────────────────────────────────────

/**
 * Options for creating a new task
 */
export interface CreateTaskOptions {
  /** Task description */
  description: string;

  /** Agent creating the task */
  created_by: AgentId;

  /** Optional parent task for subtask hierarchy */
  parent_task?: TaskId;

  /** Optional input data for the task */
  inputs?: Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────────
// Update Options
// ─────────────────────────────────────────────────────────────────

/**
 * Options for updating task metadata
 */
export interface UpdateTaskOptions {
  /** Update task outputs */
  outputs?: Record<string, unknown>;

  /** Add artifacts to task */
  artifacts?: ArtifactRef[];

  /** Update description */
  description?: string;
}

// ─────────────────────────────────────────────────────────────────
// Query Options
// ─────────────────────────────────────────────────────────────────

/**
 * Filter options for listing tasks
 */
export interface TaskFilter {
  /** Filter by status */
  status?: TaskStatus;

  /** Filter by assigned agent */
  assigned_agent?: AgentId;

  /** Filter by parent task */
  parent_task?: TaskId;

  /** Filter by creator */
  created_by?: AgentId;

  /** Only root tasks (no parent) */
  rootTasksOnly?: boolean;
}

// ─────────────────────────────────────────────────────────────────
// Subtask Status
// ─────────────────────────────────────────────────────────────────

/**
 * Aggregate status of subtasks
 */
export interface SubtaskStatus {
  total: number;
  pending: number;
  assigned: number;
  in_progress: number;
  completed: number;
  failed: number;
  allCompleted: boolean;
  anyFailed: boolean;
}

// ─────────────────────────────────────────────────────────────────
// Valid Status Transitions
// ─────────────────────────────────────────────────────────────────

/**
 * Valid status transitions map
 */
export const VALID_STATUS_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  pending: ["assigned", "in_progress", "failed"],
  assigned: ["in_progress", "pending", "failed"],
  in_progress: ["completed", "failed", "pending"],
  completed: [], // Terminal state
  failed: ["pending"], // Can retry
};

// ─────────────────────────────────────────────────────────────────
// Error Types
// ─────────────────────────────────────────────────────────────────

/**
 * Task manager error
 */
export class TaskManagerError extends Error {
  constructor(
    message: string,
    public readonly code: TaskManagerErrorCode,
    public readonly taskId?: TaskId,
  ) {
    super(message);
    this.name = "TaskManagerError";
  }
}

export type TaskManagerErrorCode =
  | "TASK_NOT_FOUND"
  | "INVALID_STATUS_TRANSITION"
  | "TASK_ALREADY_ASSIGNED"
  | "TASK_NOT_ASSIGNED"
  | "PARENT_TASK_NOT_FOUND";
