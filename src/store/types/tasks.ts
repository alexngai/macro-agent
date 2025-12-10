/**
 * Task-related type definitions
 */

import type { AgentId, TaskId, Timestamp } from "./primitives.js";

// Task statuses
export type TaskStatus =
  | "pending"
  | "assigned"
  | "in_progress"
  | "completed"
  | "failed";

// Task actions
export type TaskAction =
  | "created"
  | "assigned"
  | "unassigned"
  | "status_change"
  | "completed"
  | "failed";

// Artifact reference
export interface ArtifactRef {
  type: "file" | "commit" | "url";
  ref: string;
  description?: string;
}

// Task record in materialized view
export interface Task {
  id: TaskId;
  description: string;
  status: TaskStatus;
  assigned_agent?: AgentId;
  parent_task?: TaskId;
  created_at: Timestamp;
  started_at?: Timestamp;
  completed_at?: Timestamp;
  created_by: AgentId;
  inputs?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  artifacts?: ArtifactRef[];
}
