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
import type {
  Address,
  SendOptions,
  DeliveryHint,
  MessagePriority as MAPMessagePriority,
} from "../map/types.js";

// Message target - where to route messages
export interface MessageTarget {
  agent_id?: AgentId; // Direct to agent
  task_id?: TaskId; // To task's assigned agent
  topic?: string; // To topic subscribers
  // Extended channel types (Phase 5)
  broadcast?: BroadcastTarget; // Fan-out to all or scoped agents
  role?: RoleTarget; // Fan-out to agents by role
}

// Broadcast target configuration
export interface BroadcastTarget {
  /** Scope of broadcast: 'all', 'coordinators', 'workers', 'monitors' */
  scope?: BroadcastScope;
}

// Broadcast scope options
export type BroadcastScope = "all" | "coordinators" | "workers" | "monitors";

// Role target configuration
export interface RoleTarget {
  /** Role name to target (e.g., "worker", "integrator", "monitor") */
  role: string;
  /** Optional: scope to specific coordinator's agents */
  coordinatorId?: AgentId;
}

// Message sender identification
export interface MessageSender {
  agent_id: AgentId;
  task_id?: TaskId; // Optional task context
}

// Message priority levels
export type MessagePriority = "low" | "normal" | "high" | "urgent";

// Wake action determined by priority
// "skip" is returned when agent is stopped/terminated and shouldn't be woken
export type WakeAction = "wake" | "inject" | "interrupt" | "queue" | "skip";

// Send message request
export interface SendMessageRequest {
  from: MessageSender;
  to: MessageTarget;
  content: string;
  correlation_id?: string; // For threading/reply tracking
  priority?: MessagePriority; // Default: 'normal'
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
  | "broadcast" // System-wide broadcasts
  | "role"; // Role-based pub/sub (Phase 5)

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
  /** Agent's role for auto-subscription to role channel */
  role?: string;
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
  | "SPAWN_FAILED" // Failed to spawn agent for unassigned task
  | "TOPIC_NO_SUBSCRIBERS"; // Topic has no subscribers (warning, not error)

/**
 * Result from spawning an agent for an unassigned task.
 */
export interface SpawnedAgentResult {
  agent_id: AgentId;
  session_id: string;
}

/**
 * Callback to spawn an agent for a task.
 * Used when a message is routed to a task with no assigned agent.
 */
export type AgentSpawner = (
  taskId: TaskId,
  taskDescription: string
) => Promise<SpawnedAgentResult>;

/**
 * Callback to check if an agent has an active session.
 */
export type AgentSessionChecker = (agentId: AgentId) => boolean;

// =============================================================================
// MAP Address-based Send Types
// =============================================================================

/**
 * Request to send a message using MAP Address.
 * This is the new MAP-native interface that will eventually replace
 * the channel-based SendMessageRequest.
 */
export interface SendToAddressRequest {
  /** Sending agent ID */
  from: AgentId;
  /** Target address */
  to: Address;
  /** Message content */
  content: string;
  /** Send options (priority, delivery hint, etc.) */
  options?: SendOptions;
}

/**
 * Result of sending a message via Address-based routing.
 * Includes delivery confirmation for each resolved recipient.
 */
export interface AddressSendResult {
  /** Message ID */
  id: EventId;
  /** Sending agent */
  from: AgentId;
  /** Original target address */
  to: Address;
  /** Message content */
  content: string;
  /** When the message was sent */
  timestamp: Timestamp;
  /** Agent IDs the message was delivered to */
  delivered: AgentId[];
  /** Correlation ID for threading (if provided) */
  correlationId?: string;
}

/**
 * Error codes for MAP address routing failures.
 */
export type AddressRoutingErrorCode =
  | "ADDRESS_NOT_SUPPORTED" // Address type not yet implemented
  | "NO_RECIPIENTS" // Address resolved to zero recipients
  | "AGENT_NOT_FOUND" // Target agent doesn't exist
  | "TASK_NOT_FOUND" // Target task doesn't exist
  | "TASK_UNASSIGNED" // Task has no assigned agent
  | "SCOPE_NOT_FOUND" // Target scope doesn't exist
  | "PARTIAL_DELIVERY" // Some recipients failed
  | "FEDERATION_NOT_AVAILABLE"; // Federation not configured for cross-system addressing

/**
 * Error for MAP address routing failures.
 */
export class AddressRoutingError extends Error {
  constructor(
    message: string,
    public readonly code: AddressRoutingErrorCode,
    public readonly address?: Address,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "AddressRoutingError";
  }
}

// Re-export Address and related types for convenience
export type { Address, SendOptions, DeliveryHint };
export { MAPMessagePriority };
