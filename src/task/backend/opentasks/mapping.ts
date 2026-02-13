/**
 * Status Mapping Utilities for OpenTasks Integration
 *
 * Maps between OpenTasks issue statuses and macro-agent task statuses.
 *
 * @module task/backend/opentasks/mapping
 */

import type { TaskStatus } from "../../../store/types/index.js";

/**
 * OpenTasks issue status values.
 * These are the canonical statuses used by OpenTasks issues.
 */
export type OpenTasksIssueStatus =
  | "open"
  | "in_progress"
  | "blocked"
  | "closed";

/**
 * Map OpenTasks issue status to macro-agent task status.
 *
 * OpenTasks statuses:
 * - open: Not started
 * - in_progress: Currently being worked on
 * - blocked: Blocked by dependencies (handled via isBlocked flag)
 * - closed: Completed
 *
 * Macro-agent statuses:
 * - pending: Not started
 * - assigned: Assigned to an agent but not started
 * - in_progress: Currently executing
 * - completed: Finished successfully
 * - failed: Finished with error
 */
export function mapOpenTasksStatus(
  openTasksStatus: string
): TaskStatus {
  switch (openTasksStatus) {
    case "open":
      return "pending";
    case "in_progress":
      return "in_progress";
    case "blocked":
      // Blocked issues map to pending - the isBlocked flag handles blocking
      return "pending";
    case "closed":
      return "completed";
    default:
      return "pending";
  }
}

/**
 * Map macro-agent task status to OpenTasks issue status.
 *
 * Note: Some task statuses don't have direct OpenTasks equivalents:
 * - assigned: No direct equivalent (maps to open, assignee set separately)
 * - failed: No direct equivalent (maps to closed with error in metadata)
 */
export function mapTaskStatus(taskStatus: TaskStatus): OpenTasksIssueStatus {
  switch (taskStatus) {
    case "pending":
      return "open";
    case "assigned":
      // Assigned tasks remain open in OpenTasks; assignee field handles assignment
      return "open";
    case "in_progress":
      return "in_progress";
    case "completed":
      return "closed";
    case "failed":
      // Failed tasks are closed in OpenTasks (failure tracked in metadata)
      return "closed";
    default:
      return "open";
  }
}

/**
 * Check if an OpenTasks issue status indicates completion.
 */
export function isIssueComplete(status: string): boolean {
  return status === "closed";
}

/**
 * Check if an OpenTasks issue has an explicit blocked status.
 * Note: This is the explicit 'blocked' status, not dependency-based blocking.
 */
export function isIssueBlocked(status: string): boolean {
  return status === "blocked";
}
