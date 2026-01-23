/**
 * Status Mapping Utilities for Sudocode Integration
 *
 * Maps between sudocode issue statuses and macro-agent task statuses.
 *
 * @module task/backend/sudocode/mapping
 * @see s-8472 Pluggable Task Backend Integration with Sudocode
 */

import type { TaskStatus } from "../../../store/types/index.js";
import type { IssueStatus } from "./client.js";

/**
 * Map sudocode issue status to macro-agent task status.
 *
 * Sudocode statuses:
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
export function mapSudocodeStatus(sudocodeStatus: IssueStatus): TaskStatus {
  switch (sudocodeStatus) {
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
 * Map macro-agent task status to sudocode issue status.
 *
 * Note: Some task statuses don't have direct sudocode equivalents:
 * - assigned: No equivalent in sudocode (maps to in_progress)
 * - failed: No equivalent in sudocode (maps to closed with error flag)
 */
export function mapTaskStatus(taskStatus: TaskStatus): IssueStatus {
  switch (taskStatus) {
    case "pending":
      return "open";
    case "assigned":
      // Assigned tasks are considered in_progress in sudocode
      return "in_progress";
    case "in_progress":
      return "in_progress";
    case "completed":
      return "closed";
    case "failed":
      // Failed tasks are closed in sudocode (failure tracked in outputs)
      return "closed";
    default:
      return "open";
  }
}

/**
 * Map issue priority to numeric priority.
 * Sudocode uses 0 (highest) to 4 (lowest).
 * This matches the TaskBackend convention.
 */
export function mapIssuePriority(priority: number): number {
  return Math.max(0, Math.min(4, priority));
}

/**
 * Check if a sudocode issue status indicates completion.
 */
export function isIssueComplete(status: IssueStatus): boolean {
  return status === "closed";
}

/**
 * Check if a sudocode issue is blocked.
 * Note: This is explicit 'blocked' status, not dependency-based blocking.
 */
export function isIssueBlocked(status: IssueStatus): boolean {
  return status === "blocked";
}
