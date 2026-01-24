/**
 * Activity Types and Subscriptions
 *
 * Types for the activity waking system that allows agents to wake
 * on relevant events.
 *
 * @module activity/types
 * @see s-9rld In-Flight Steering spec section 3.4
 */

import type { AgentId, TaskId, Timestamp, EventId } from "../store/types/index.js";
import type { MessagePriority } from "../router/types.js";

// =============================================================================
// Activity Types
// =============================================================================

/**
 * Event types that can trigger activity waking
 */
export type ActivityEventType =
  // Agent lifecycle
  | "agent_spawned"
  | "agent_started"
  | "agent_terminated"
  | "agent_stopped"
  // Task lifecycle
  | "task_created"
  | "task_assigned"
  | "task_completed"
  | "task_failed"
  | "task_blocked"
  // Messages
  | "message_received"
  | "status_emitted"
  // Signals (from s-9rld)
  | "WORKER_DONE"
  | "TASK_DONE"
  | "MERGE_REQUEST"
  | "MERGE_COMPLETE"
  | "LAND_COMPLETE"
  | "CONFLICT_DETECTED"
  | "HELP"
  | "HELP_CLAIMED"
  | "HANDOFF"
  | "HEALTH_CHECK"
  | "HEALTH_CHECK_TIMER"
  | "STALE_AGENT"
  | "PRIORITY_CHANGE"
  | "FORCE_TERMINATE_REQUEST"
  | "WORKER_SPAWNED"
  | "INTEGRATOR_DONE"
  | "AGENT_TIMEOUT"
  | "ASSIGNMENT_EXPIRED";

/**
 * Activity source information
 */
export interface ActivitySource {
  /** Agent that generated the activity */
  agent_id?: AgentId;
  /** Task associated with the activity */
  task_id?: TaskId;
  /** Role of the source agent */
  role?: string;
}

/**
 * Activity target information
 */
export interface ActivityTarget {
  /** Target type */
  type: "agent" | "task" | "role" | "topic" | "broadcast";
  /** Target ID or name */
  target?: string;
  /** Role name if type is 'role' */
  role?: string;
}

/**
 * Activity event that can trigger waking
 */
export interface Activity {
  /** Unique event ID */
  id: EventId;
  /** Event type */
  type: ActivityEventType | string;
  /** Event source */
  source: ActivitySource;
  /** Event target (if applicable) */
  target?: ActivityTarget;
  /** Timestamp of the event */
  timestamp: Timestamp;
  /** Additional event details */
  details?: Record<string, unknown>;
  /** Priority for wake decisions */
  priority?: MessagePriority;
}

// =============================================================================
// Event Subscriptions
// =============================================================================

/**
 * Scope filter for event subscriptions
 */
export interface EventSubscriptionScope {
  /** Only events from this agent's subtree */
  subtree?: AgentId;
  /** Only events from agents with this role */
  role?: string;
  /** Only events targeting this agent */
  targetAgent?: AgentId;
}

/**
 * Event subscription for an agent
 */
export interface EventSubscription {
  /** Agent receiving the events */
  agentId: AgentId;
  /** Event types to subscribe to (empty = all) */
  eventTypes: ActivityEventType[];
  /** Optional scope filter */
  scope?: EventSubscriptionScope;
  /** Priority for wake decisions (default: normal) */
  priority?: MessagePriority;
}

/**
 * Subscription registry interface
 */
export interface SubscriptionRegistry {
  /** Add a subscription */
  subscribe(subscription: EventSubscription): void;
  /** Remove a subscription */
  unsubscribe(agentId: AgentId, eventTypes?: ActivityEventType[]): void;
  /** Get all subscriptions for an agent */
  getSubscriptions(agentId: AgentId): EventSubscription[];
  /** Get all agents subscribed to an event type */
  getSubscribers(eventType: ActivityEventType): EventSubscription[];
  /** Check if agent is subscribed to event type */
  isSubscribed(agentId: AgentId, eventType: ActivityEventType): boolean;
}

// =============================================================================
// Wake Results
// =============================================================================

/**
 * Method used to wake an agent
 */
export type WakeMethod = "wake" | "inject" | "interrupt" | "queued";

/**
 * Result of attempting to wake an agent
 */
export interface WakeResult {
  /** Whether the wake attempt was successful */
  success: boolean;
  /** Method used to wake the agent */
  method?: WakeMethod;
  /** Reason for failure if not successful */
  reason?: "no_session" | "agent_stopped" | "inject_failed" | "error";
  /** Error message if applicable */
  error?: string;
}

// =============================================================================
// Relevance Rules
// =============================================================================

/**
 * Custom relevance rule function
 */
export type RelevanceRule = (activity: Activity) => AgentId[];

/**
 * Built-in relevance rule types
 */
export type RelevanceRuleType =
  | "lineage"      // Wake ancestors
  | "role"         // Wake agents by role
  | "subscription" // Wake subscribed agents
  | "target"       // Wake targeted agent
  | "custom";      // Custom rule

// =============================================================================
// Activity Watcher Configuration
// =============================================================================

/**
 * Configuration for the activity watcher
 */
export interface ActivityWatcherConfig {
  /** Event types to watch (empty = all) */
  eventTypes?: ActivityEventType[];
  /** Default priority for wake decisions */
  defaultPriority?: MessagePriority;
  /** Whether to enable deduplication */
  enableDeduplication?: boolean;
  /** Deduplication window in milliseconds */
  deduplicationWindowMs?: number;
}

/**
 * Default activity watcher configuration
 */
export const DEFAULT_ACTIVITY_WATCHER_CONFIG: ActivityWatcherConfig = {
  eventTypes: [],
  defaultPriority: "normal",
  enableDeduplication: true,
  deduplicationWindowMs: 5000,
};

// =============================================================================
// wait_for_activity Tool Types
// =============================================================================

/**
 * Arguments for wait_for_activity tool
 */
export interface WaitForActivityArgs {
  /** Event types to wait for (empty = all) */
  event_types?: ActivityEventType[];
  /** Timeout in milliseconds */
  timeout_ms?: number;
  /** Scope filter */
  scope?: EventSubscriptionScope;
}

/**
 * Result from wait_for_activity tool
 */
export interface WaitForActivityResult {
  /** Whether an activity triggered the return */
  triggered: boolean;
  /** The triggering activity (if triggered) */
  activity?: {
    type: string;
    source: ActivitySource;
    timestamp: Timestamp;
    details?: Record<string, unknown>;
  };
  /** Whether the timeout was reached */
  timeout?: boolean;
}

// =============================================================================
// Monitor Default Subscriptions
// =============================================================================

/**
 * Default event types for Monitor role
 */
export const MONITOR_DEFAULT_EVENT_TYPES: ActivityEventType[] = [
  "agent_terminated",
  "task_failed",
  "HEALTH_CHECK_TIMER",
  "STALE_AGENT",
  "AGENT_TIMEOUT",
  "CONFLICT_DETECTED",
];
