/**
 * Agent-related type definitions
 */

import type { AgentId, SessionId, TaskId, Timestamp } from "./primitives.js";

// Agent states
export type AgentState = "spawning" | "running" | "stopped";

export type StopReason =
  | "completed"
  | "failed"
  | "stopped"
  | "timeout"
  | "cancelled";

// Agent configuration
export interface AgentConfig {
  model?: string;
  timeout?: number;
  resource_limits?: {
    max_tokens?: number;
    max_children?: number;
    [key: string]: unknown;
  };
}

// Agent record in materialized view
export interface Agent {
  id: AgentId;
  session_id: SessionId;
  parent: AgentId | null;
  lineage: AgentId[];
  state: AgentState;
  stop_reason?: StopReason;
  task: string;
  task_id?: TaskId;
  config: AgentConfig;
  cwd: string;
  created_at: Timestamp;
  started_at?: Timestamp;
  stopped_at?: Timestamp;
}
