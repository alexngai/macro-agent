/**
 * MessageRouter type definitions
 */

import type {
  AgentId,
  TaskId,
  EventId,
  Timestamp,
  EventSource,
} from "../store/types/index.js";

// Message target - where to route messages
export interface MessageTarget {
  agent_id?: AgentId; // Direct to agent
  task_id?: TaskId; // To task's assigned agent
  topic?: string; // To topic subscribers
}

// Message sender identification
export interface MessageSender {
  agent_id: AgentId;
  task_id?: TaskId; // Optional task context
}

// Send message request
export interface SendMessageRequest {
  from: MessageSender;
  to: MessageTarget;
  content: string;
  correlation_id?: string; // For threading/reply tracking
}

// Sent message result
export interface SentMessage {
  id: EventId;
  from: MessageSender;
  to: MessageTarget;
  content: string;
  timestamp: Timestamp;
  correlation_id?: string;
}

// Message in recipient queue
export interface ReceivedMessage {
  id: EventId;
  from: EventSource;
  content: string;
  timestamp: Timestamp;
  truncated: boolean;
  correlation_id?: string;
}

// Get messages options
export interface GetMessagesOptions {
  limit?: number;
  includeAcknowledged?: boolean; // Default false
}

// Subscription channel types
export type ChannelType =
  | "agent" // Direct messages to agent
  | "task" // Messages to task's assigned agent
  | "lineage" // Messages from ancestors (child subscribes to receive from parents)
  | "subtree" // Events from descendants (parent subscribes to receive from children)
  | "topic" // Topic-based pub/sub
  | "broadcast"; // System-wide broadcasts

// Channel specification
export interface Channel {
  type: ChannelType;
  target: string; // agent_id, task_id, or topic name
}

// Default subscription setup options
export interface DefaultSubscriptionOptions {
  agent_id: AgentId;
  parent_id?: AgentId | null;
  task_id?: TaskId;
  subscribe_parent?: boolean; // Default true - parent subscribes to child's subtree
  additional_topics?: string[];
}

// Status types for agent lifecycle
export type StatusType =
  | "started"
  | "checkpoint"
  | "blocked"
  | "discovery"
  | "completed"
  | "failed";

// Emit status request
export interface EmitStatusRequest {
  from: MessageSender;
  status_type: StatusType;
  summary: string;
  details?: Record<string, unknown>;
}

// Status event routed to subscribers
export interface StatusNotification {
  agent_id: AgentId;
  task_id?: TaskId;
  status_type: StatusType;
  summary: string;
  details?: Record<string, unknown>;
  timestamp: Timestamp;
}

// Message truncation config
export interface TruncationConfig {
  maxLength: number; // Max content length before truncation
}

// Default truncation settings
export const DEFAULT_TRUNCATION_CONFIG: TruncationConfig = {
  maxLength: 1000,
};

// Error types for routing failures
export class RoutingError extends Error {
  constructor(
    message: string,
    public readonly code: RoutingErrorCode,
    public readonly target?: MessageTarget
  ) {
    super(message);
    this.name = "RoutingError";
  }
}

export type RoutingErrorCode =
  | "NO_TARGET" // No target specified
  | "AGENT_NOT_FOUND" // Target agent doesn't exist
  | "TASK_NOT_FOUND" // Target task doesn't exist
  | "TASK_UNASSIGNED" // Task has no assigned agent
  | "TOPIC_NO_SUBSCRIBERS"; // Topic has no subscribers (warning, not error)
