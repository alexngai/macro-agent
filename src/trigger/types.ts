/**
 * Core Trigger System Types
 *
 * Defines the foundational types for the trigger system including
 * trigger events, sources, payloads, and delivery results.
 *
 * @module trigger/types
 */

import type { AgentId, TaskId } from "../store/types/index.js";

// =============================================================================
// Trigger Sources
// =============================================================================

/**
 * Sources that can generate trigger events
 */
export type TriggerSource =
  | { type: "cron"; jobId: string; jobName: string }
  | { type: "webhook"; endpointId: string; method: string; path: string }
  | { type: "system"; eventType: string }
  | { type: "channel"; channelType: string; channelId: string }
  | { type: "internal"; component: string };

// =============================================================================
// Trigger Payload
// =============================================================================

/**
 * Payload variants for trigger events
 */
export type TriggerPayload =
  | { kind: "text"; content: string }
  | { kind: "json"; data: Record<string, unknown> }
  | { kind: "activity"; activityType: string; details?: Record<string, unknown> };

// =============================================================================
// Wake Mode
// =============================================================================

/**
 * Wake mode determines how the trigger is delivered to the agent
 *
 * - "now": Immediately wake the agent using inject/interrupt chain
 * - "next-prompt": Queue the event to be delivered on agent's next prompt
 */
export type TriggerWakeMode = "now" | "next-prompt";

// =============================================================================
// Routing Hints
// =============================================================================

/**
 * Target specification for trigger routing
 */
export type TriggerTarget =
  | { type: "head" }
  | { type: "agent"; agentId: AgentId }
  | { type: "role"; role: string }
  | { type: "task"; taskId: TaskId }
  | { type: "broadcast"; channel: string }
  | { type: "ai-router" };

/**
 * Routing hints for trigger delivery
 */
export interface TriggerRoutingHint {
  /** Primary target specification */
  target?: TriggerTarget;
  /** Fallback target if primary fails */
  fallbackTarget?: TriggerTarget;
  /** Custom routing strategy name */
  strategyName?: string;
  /** Whether to spawn new agent if target not found */
  spawnIfNotFound?: boolean;
  /** Spawn configuration if spawning is allowed */
  spawnConfig?: {
    task: string;
    role?: string;
    parentId?: AgentId;
  };
}

// =============================================================================
// Trigger Event
// =============================================================================

/**
 * Priority levels for trigger events
 */
export type TriggerPriority = "low" | "normal" | "high" | "urgent";

/**
 * A trigger event to be routed to agents
 */
export interface TriggerEvent {
  /** Unique event ID */
  id: string;
  /** Source of the trigger */
  source: TriggerSource;
  /** Payload content */
  payload: TriggerPayload;
  /** Wake mode for delivery */
  wakeMode: TriggerWakeMode;
  /** Event creation timestamp */
  timestamp: number;
  /** Routing configuration */
  routing?: TriggerRoutingHint;
  /** Priority level */
  priority?: TriggerPriority;
  /** Optional metadata */
  metadata?: Record<string, unknown>;
}

// =============================================================================
// Delivery Result
// =============================================================================

/**
 * Method used to deliver the trigger
 */
export type TriggerDeliveryMethod =
  | "queued"      // Added to system event queue
  | "inject"      // Injected into active session
  | "interrupt"   // Interrupted active session
  | "wake"        // Woke sleeping agent with new prompt
  | "spawn"       // Spawned new agent to handle
  | "broadcast";  // Broadcast to multiple agents

/**
 * Result of trigger delivery attempt
 */
export interface TriggerDeliveryResult {
  /** Whether delivery succeeded */
  success: boolean;
  /** Agent(s) that received the trigger */
  deliveredTo: AgentId[];
  /** Delivery method used */
  method: TriggerDeliveryMethod;
  /** Whether a new agent was spawned */
  spawned?: boolean;
  /** ID of spawned agent if applicable */
  spawnedAgentId?: AgentId;
  /** Error message if failed */
  error?: string;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

// =============================================================================
// Trigger Creation Helpers
// =============================================================================

/**
 * Options for creating a trigger event
 */
export interface CreateTriggerOptions {
  source: TriggerSource;
  payload: TriggerPayload;
  wakeMode?: TriggerWakeMode;
  routing?: TriggerRoutingHint;
  priority?: TriggerPriority;
  metadata?: Record<string, unknown>;
}

/**
 * Create a trigger event with defaults
 */
export function createTriggerEvent(options: CreateTriggerOptions): TriggerEvent {
  return {
    id: `trigger_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`,
    source: options.source,
    payload: options.payload,
    wakeMode: options.wakeMode ?? "now",
    timestamp: Date.now(),
    routing: options.routing,
    priority: options.priority ?? "normal",
    metadata: options.metadata,
  };
}

/**
 * Format a trigger payload as a human-readable string
 */
export function formatTriggerPayload(payload: TriggerPayload): string {
  switch (payload.kind) {
    case "text":
      return payload.content;
    case "json":
      return JSON.stringify(payload.data, null, 2);
    case "activity":
      return payload.details
        ? `[${payload.activityType}] ${JSON.stringify(payload.details)}`
        : `[${payload.activityType}]`;
  }
}

/**
 * Format trigger source as a string
 */
export function formatTriggerSource(source: TriggerSource): string {
  switch (source.type) {
    case "cron":
      return `cron:${source.jobName}`;
    case "webhook":
      return `webhook:${source.endpointId}`;
    case "system":
      return `system:${source.eventType}`;
    case "channel":
      return `channel:${source.channelType}:${source.channelId}`;
    case "internal":
      return `internal:${source.component}`;
  }
}
