/**
 * Event-related type definitions
 */

import type { AgentId, TaskId, EventId, Timestamp } from "./primitives.js";
import type { Address, MessagePriority, DeliveryHint } from "../../map/types.js";

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
  /** Peer address for peer events (e.g., "peer-id" or "peer-id/agent-id") */
  peer?: string;
}

// Event target
export interface EventTarget {
  agent_id?: AgentId;
  task_id?: TaskId;
  topic?: string;
  scope?: "subtree" | "branch" | "all";
  /** MAP Address (Phase 2+) - takes precedence over legacy fields when present */
  address?: Address;
  /** Resolved recipient agent IDs (for multicast/broadcast) */
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

// =============================================================================
// Message Event Types (Phase 2+)
// =============================================================================

/**
 * Typed payload for message events.
 * Use this for better type safety when creating/reading message events.
 */
export interface MessagePayload {
  content: string;
  priority?: MessagePriority;
  delivery_hint?: DeliveryHint;
  correlation_id?: string;
}

/**
 * Pattern for querying messages by address type.
 */
export type AddressPattern =
  | { agent: AgentId }
  | { scope: string }
  | { role: string }
  | { hierarchical: true }
  | { broadcast: true }
  | { task: TaskId };

/**
 * Options for querying message events.
 */
export interface MessageQueryOptions {
  /** Filter by sender agent */
  from?: AgentId;
  /** Filter by address pattern */
  to?: AddressPattern;
  /** Filter messages after this timestamp */
  since?: Timestamp;
  /** Filter messages before this timestamp */
  until?: Timestamp;
  /** Maximum number of results */
  limit?: number;
}

/**
 * Helper to check if an event is a message event.
 */
export function isMessageEvent(event: Event): boolean {
  return event.type === "message";
}

/**
 * Helper to get typed message payload from an event.
 * Returns undefined if not a message event or payload is invalid.
 */
export function getMessagePayload(event: Event): MessagePayload | undefined {
  if (event.type !== "message") {
    return undefined;
  }
  const payload = event.payload;
  if (typeof payload.content !== "string") {
    return undefined;
  }
  return payload as unknown as MessagePayload;
}

/**
 * Helper to get the MAP Address from an event target.
 * Returns the address field if present, otherwise constructs from legacy fields.
 */
export function getTargetAddress(target: EventTarget | undefined): Address | undefined {
  if (!target) return undefined;

  // If MAP Address is present, use it
  if (target.address) {
    return target.address;
  }

  // Construct from legacy fields for backward compatibility
  if (target.agent_id) {
    return { agent: target.agent_id };
  }
  if (target.task_id) {
    return { task: target.task_id };
  }
  if (target.topic) {
    return { scope: target.topic };
  }
  if (target.scope === "all") {
    return { broadcast: true };
  }

  return undefined;
}
