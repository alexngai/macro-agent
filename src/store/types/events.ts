/**
 * Event-related type definitions
 */

import type { AgentId, TaskId, EventId, Timestamp } from "./primitives.js";

// Current event schema version
export const CURRENT_EVENT_VERSION = 1;

// Event types
export type EventType =
  | "spawn"
  | "terminate"
  | "status"
  | "message"
  | "task"
  | "subscription"
  | "peer_message"
  | "peer_request";

// Status types for status events
export type StatusType =
  | "started"
  | "checkpoint"
  | "blocked"
  | "discovery"
  | "completed"
  | "failed";

// Event source
export interface EventSource {
  agent_id?: AgentId;
  task_id?: TaskId;
  lineage?: AgentId[];
  /** Peer address for peer events (e.g., "peer-id" or "peer-id/agent-id") */
  peer?: string;
}

// Event target
export interface EventTarget {
  agent_id?: AgentId;
  task_id?: TaskId;
  topic?: string;
  scope?: "subtree" | "branch" | "all";
}

// Event metadata
export interface EventMetadata {
  correlation_id?: string;
  ttl?: number;
  requires_ack?: boolean;
  [key: string]: unknown;
}

// Base event structure
export interface Event {
  id: EventId;
  version: number; // Schema version for migrations
  timestamp: Timestamp;
  type: EventType;
  source: EventSource;
  target?: EventTarget;
  payload: Record<string, unknown>;
  metadata?: EventMetadata;
}

// Event input (without id, version, and timestamp - these are auto-generated)
export interface EventInput {
  type: EventType;
  source: EventSource;
  target?: EventTarget;
  payload: Record<string, unknown>;
  metadata?: EventMetadata;
}

// Event query filter
export interface EventFilter {
  type?: EventType;
  source_agent_id?: AgentId;
  target_agent_id?: AgentId;
  after?: Timestamp;
  before?: Timestamp;
  limit?: number;
}
