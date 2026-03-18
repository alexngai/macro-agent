/**
 * Event-related type definitions
 *
 * Core event types used by workspace module and index exports.
 * Message-specific helpers removed in V2 (agent-inbox handles messaging).
 */

import type { AgentId, TaskId, EventId, Timestamp } from "./primitives.js";

// Current event schema version
export const CURRENT_EVENT_VERSION = 1;

// Event types
export type EventType =
  | "spawn"
  | "stop"
  | "status"
  | "message"
  | "task"
  | "subscription"
  | "peer_message"
  | "peer_request"
  | "conversation"
  | "turn"
  | "thread"
  | "session";

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
  peer?: string;
}

// Event target
export interface EventTarget {
  agent_id?: AgentId;
  task_id?: TaskId;
  topic?: string;
  scope?: "subtree" | "branch" | "all";
  delivered?: AgentId[];
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
  version: number;
  timestamp: Timestamp;
  type: EventType;
  source: EventSource;
  target?: EventTarget;
  payload: Record<string, unknown>;
  metadata?: EventMetadata;
}

// Event input (without auto-generated fields)
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
