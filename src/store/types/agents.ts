/**
 * Agent-related type definitions
 */

import type { AgentId, SessionId, TaskId, Timestamp } from "./primitives.js";

// Agent states
export type AgentState = "spawning" | "running" | "stopped" | "failed";

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
  /** Optional display name (set via rename, not derived from events) */
  name?: string;
  session_id: SessionId;
  /** Session ID from the underlying agent provider (e.g., Claude Code UUID for --resume) */
  provider_session_id?: string;
  parent: AgentId | null;
  lineage: AgentId[];
  state: AgentState;
  stop_reason?: StopReason;
  task: string;
  task_id?: TaskId;
  role?: string;
  /** Team instance ID this agent belongs to (set by TeamManager) */
  team_instance?: string;
  config: AgentConfig;
  cwd: string;
  plan: Array<{ content: string; priority: string; status: string }>;
  /** Arbitrary metadata (persisted out-of-band, not derived from events) */
  metadata?: Record<string, unknown>;
  created_at: Timestamp;
  started_at?: Timestamp;
  stopped_at?: Timestamp;
  /** Last time this agent emitted an event (for health monitoring) */
  last_activity_at?: Timestamp;
}

/**
 * Partial update for agent metadata fields.
 * All fields are optional — only provided fields are updated.
 * `metadata` is merged (shallow) with existing metadata.
 */
export interface AgentMetadataUpdate {
  name?: string;
  plan?: Array<{ content: string; priority: string; status: string }>;
  metadata?: Record<string, unknown>;
  team_instance?: string;
}
