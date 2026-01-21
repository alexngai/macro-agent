/**
 * Enhanced Channel Types
 *
 * Extended channel types for agent communication including
 * broadcast and role-based addressing.
 *
 * @module router/channels
 * @see s-9rld In-Flight Steering spec section 3.2
 */

import type { AgentId, TaskId } from "../store/types/index.js";

// =============================================================================
// Channel Types
// =============================================================================

/**
 * All supported channel types
 */
export type ChannelType =
  | "agent" // Direct to specific agent
  | "task" // To task's assigned agent
  | "lineage" // Parent/child chain
  | "subtree" // All descendants
  | "topic" // Topic-based pub/sub
  | "broadcast" // Fan-out to all subscribers
  | "role"; // Dynamic resolution by role

// =============================================================================
// Channel Specifications
// =============================================================================

/**
 * Direct agent channel
 */
export interface AgentChannel {
  type: "agent";
  id: AgentId;
}

/**
 * Task channel - routes to task's assigned agent
 */
export interface TaskChannel {
  type: "task";
  id: TaskId;
}

/**
 * Lineage channel - messages from ancestors
 */
export interface LineageChannel {
  type: "lineage";
  agentId: AgentId;
}

/**
 * Subtree channel - events from descendants
 */
export interface SubtreeChannel {
  type: "subtree";
  agentId: AgentId;
}

/**
 * Topic channel - topic-based pub/sub
 */
export interface TopicChannel {
  type: "topic";
  topic: string;
}

/**
 * Broadcast channel - fan-out to all subscribers
 */
export interface BroadcastChannel {
  type: "broadcast";
  /** Optional scope for targeted broadcasts */
  scope?: "all" | "coordinators" | "workers" | "monitors";
}

/**
 * Role channel - dynamic resolution by agent role
 * Uses @role syntax (e.g., @workers, @integrator)
 */
export interface RoleChannel {
  type: "role";
  /** Role name to target (e.g., "worker", "integrator", "monitor") */
  role: string;
  /** Optional scope to specific coordinator's agents */
  coordinatorId?: AgentId;
}

/**
 * Union of all channel specifications
 */
export type Channel =
  | AgentChannel
  | TaskChannel
  | LineageChannel
  | SubtreeChannel
  | TopicChannel
  | BroadcastChannel
  | RoleChannel;

// =============================================================================
// Message Priority
// =============================================================================

/**
 * Message priority levels
 */
export type MessagePriority = "low" | "normal" | "high" | "urgent";

/**
 * Priority level numeric values for ordering
 */
export const PRIORITY_VALUES: Record<MessagePriority, number> = {
  low: 0,
  normal: 1,
  high: 2,
  urgent: 3,
};

/**
 * Compare two priorities (higher priority = larger value)
 */
export function comparePriority(
  a: MessagePriority,
  b: MessagePriority
): number {
  return PRIORITY_VALUES[a] - PRIORITY_VALUES[b];
}

// =============================================================================
// Delivery Modes
// =============================================================================

/**
 * Message delivery mode
 */
export type DeliveryMode =
  | "queue" // Add to recipient's queue (default)
  | "interrupt"; // Attempt immediate delivery (future: mid-turn)

// =============================================================================
// Group Resolution
// =============================================================================

/**
 * Group resolution strategy
 */
export type GroupResolution =
  | "send-time" // Snapshot of current agents when message sent (default)
  | "receive-time"; // Resolve on each delivery attempt

// =============================================================================
// Channel Helpers
// =============================================================================

/**
 * Create an agent channel
 */
export function agentChannel(id: AgentId): AgentChannel {
  return { type: "agent", id };
}

/**
 * Create a task channel
 */
export function taskChannel(id: TaskId): TaskChannel {
  return { type: "task", id };
}

/**
 * Create a topic channel
 */
export function topicChannel(topic: string): TopicChannel {
  return { type: "topic", topic };
}

/**
 * Create a broadcast channel
 */
export function broadcastChannel(
  scope?: BroadcastChannel["scope"]
): BroadcastChannel {
  return { type: "broadcast", scope };
}

/**
 * Create a role channel
 */
export function roleChannel(
  role: string,
  coordinatorId?: AgentId
): RoleChannel {
  return { type: "role", role, coordinatorId };
}

/**
 * Create a lineage channel
 */
export function lineageChannel(agentId: AgentId): LineageChannel {
  return { type: "lineage", agentId };
}

/**
 * Create a subtree channel
 */
export function subtreeChannel(agentId: AgentId): SubtreeChannel {
  return { type: "subtree", agentId };
}

/**
 * Parse @role syntax to role channel
 * Examples: @workers, @integrator, @monitor
 */
export function parseRoleSyntax(
  syntax: string,
  coordinatorId?: AgentId
): RoleChannel | null {
  if (!syntax.startsWith("@")) {
    return null;
  }
  const role = syntax.slice(1);
  if (!role) {
    return null;
  }
  return roleChannel(role, coordinatorId);
}

// =============================================================================
// Channel Type Guards
// =============================================================================

/**
 * Check if channel is an agent channel
 */
export function isAgentChannel(channel: Channel): channel is AgentChannel {
  return channel.type === "agent";
}

/**
 * Check if channel is a task channel
 */
export function isTaskChannel(channel: Channel): channel is TaskChannel {
  return channel.type === "task";
}

/**
 * Check if channel is a topic channel
 */
export function isTopicChannel(channel: Channel): channel is TopicChannel {
  return channel.type === "topic";
}

/**
 * Check if channel is a broadcast channel
 */
export function isBroadcastChannel(
  channel: Channel
): channel is BroadcastChannel {
  return channel.type === "broadcast";
}

/**
 * Check if channel is a role channel
 */
export function isRoleChannel(channel: Channel): channel is RoleChannel {
  return channel.type === "role";
}

/**
 * Check if channel targets multiple recipients
 */
export function isMulticastChannel(channel: Channel): boolean {
  return (
    channel.type === "broadcast" ||
    channel.type === "role" ||
    channel.type === "topic" ||
    channel.type === "subtree"
  );
}
