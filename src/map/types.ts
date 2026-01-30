/**
 * MAP (Multi-Agent Protocol) Core Types
 *
 * This module defines the core addressing and messaging types for MAP integration.
 * These types replace the channel-based addressing in MessageRouter with
 * MAP-native hierarchical addressing.
 *
 * @see specs/s-5qir_map_integration_for_macro_agent.md
 */

import type { AgentId, TaskId } from "../store/types/index.js";

// =============================================================================
// ID Types
// =============================================================================

/**
 * Scope identifier for MAP scopes (equivalent to topics/channels).
 * Scopes are explicitly created containers for agent communication.
 */
export type ScopeId = string;

// =============================================================================
// Address Types
// =============================================================================

/**
 * Direct address targeting a single agent.
 */
export interface AgentAddress {
  agent: AgentId;
}

/**
 * Direct address targeting multiple agents.
 */
export interface AgentsAddress {
  agents: AgentId[];
}

/**
 * Scope-based address targeting all members of a scope.
 */
export interface ScopeAddress {
  scope: ScopeId;
}

/**
 * Role-based address targeting agents by role.
 * Optionally scoped to a specific scope.
 */
export interface RoleAddress {
  role: string;
  /** Optional scope to limit role resolution */
  within?: ScopeId;
}

/**
 * Address targeting the sender's parent agent.
 */
export interface ParentAddress {
  parent: true;
}

/**
 * Address targeting the sender's direct children.
 */
export interface ChildrenAddress {
  children: true;
  /** Max depth (1 = direct children only, default: 1) */
  depth?: number;
}

/**
 * Address targeting the sender's ancestors (parent, grandparent, etc.).
 */
export interface AncestorsAddress {
  ancestors: true;
  /** Max depth (default: Infinity) */
  depth?: number;
}

/**
 * Address targeting the sender's descendants (children, grandchildren, etc.).
 */
export interface DescendantsAddress {
  descendants: true;
  /** Max depth (default: Infinity) */
  depth?: number;
}

/**
 * Address targeting the sender's siblings (agents with same parent).
 */
export interface SiblingsAddress {
  siblings: true;
}

/**
 * Broadcast address targeting all agents in the system.
 */
export interface BroadcastAddress {
  broadcast: true;
}

/**
 * Task-based address (macro-agent extension).
 * Routes to the agent assigned to the specified task.
 */
export interface TaskAddress {
  task: TaskId;
}

/**
 * Union of all hierarchical address types.
 */
export type HierarchicalAddress =
  | ParentAddress
  | ChildrenAddress
  | AncestorsAddress
  | DescendantsAddress
  | SiblingsAddress;

/**
 * MAP Address type for message routing.
 *
 * Addresses specify where messages should be delivered. They replace
 * the channel-based addressing in the legacy MessageRouter.
 *
 * Address types:
 * - Direct: { agent } or { agents } - target specific agent(s)
 * - Structural: { scope } or { role } - target by scope or role
 * - Hierarchical: { parent }, { children }, { ancestors }, { descendants }, { siblings }
 * - Broadcast: { broadcast: true } - all agents
 * - Extension: { task } - macro-agent specific task addressing
 */
export type Address =
  // Direct addressing
  | AgentAddress
  | AgentsAddress
  // Structural addressing
  | ScopeAddress
  | RoleAddress
  // Hierarchical addressing (relative to sender)
  | HierarchicalAddress
  // Broadcast
  | BroadcastAddress
  // Extension (macro-agent specific)
  | TaskAddress;

// =============================================================================
// Type Guards
// =============================================================================

/**
 * Check if address targets a single agent.
 */
export function isAgentAddress(addr: Address): addr is AgentAddress {
  return "agent" in addr;
}

/**
 * Check if address targets multiple agents.
 */
export function isAgentsAddress(addr: Address): addr is AgentsAddress {
  return "agents" in addr;
}

/**
 * Check if address targets a scope.
 */
export function isScopeAddress(addr: Address): addr is ScopeAddress {
  return "scope" in addr;
}

/**
 * Check if address targets by role.
 */
export function isRoleAddress(addr: Address): addr is RoleAddress {
  return "role" in addr;
}

/**
 * Check if address targets parent.
 */
export function isParentAddress(addr: Address): addr is ParentAddress {
  return "parent" in addr;
}

/**
 * Check if address targets children.
 */
export function isChildrenAddress(addr: Address): addr is ChildrenAddress {
  return "children" in addr;
}

/**
 * Check if address targets ancestors.
 */
export function isAncestorsAddress(addr: Address): addr is AncestorsAddress {
  return "ancestors" in addr;
}

/**
 * Check if address targets descendants.
 */
export function isDescendantsAddress(
  addr: Address
): addr is DescendantsAddress {
  return "descendants" in addr;
}

/**
 * Check if address targets siblings.
 */
export function isSiblingsAddress(addr: Address): addr is SiblingsAddress {
  return "siblings" in addr;
}

/**
 * Check if address is hierarchical (relative to sender).
 */
export function isHierarchicalAddress(
  addr: Address
): addr is HierarchicalAddress {
  return (
    isParentAddress(addr) ||
    isChildrenAddress(addr) ||
    isAncestorsAddress(addr) ||
    isDescendantsAddress(addr) ||
    isSiblingsAddress(addr)
  );
}

/**
 * Check if address is a broadcast.
 */
export function isBroadcastAddress(addr: Address): addr is BroadcastAddress {
  return "broadcast" in addr;
}

/**
 * Check if address targets a task (macro-agent extension).
 */
export function isTaskAddress(addr: Address): addr is TaskAddress {
  return "task" in addr;
}

/**
 * Check if address is a direct address (agent or agents).
 */
export function isDirectAddress(
  addr: Address
): addr is AgentAddress | AgentsAddress {
  return isAgentAddress(addr) || isAgentsAddress(addr);
}

/**
 * Check if address is structural (scope or role).
 */
export function isStructuralAddress(
  addr: Address
): addr is ScopeAddress | RoleAddress {
  return isScopeAddress(addr) || isRoleAddress(addr);
}

// =============================================================================
// Message Options
// =============================================================================

/**
 * Message priority levels.
 * Higher priority messages may wake sleeping agents.
 */
export type MessagePriority = "low" | "normal" | "high" | "urgent";

/**
 * Delivery hint for message routing.
 *
 * - queue: Add to recipient's message queue (default)
 * - inject: Attempt to inject into active session
 * - interrupt: Interrupt current activity to deliver
 */
export type DeliveryHint = "queue" | "inject" | "interrupt";

/**
 * Options for sending messages.
 */
export interface SendOptions {
  /** Message priority (default: 'normal') */
  priority?: MessagePriority;

  /** Delivery hint for the router (default: 'queue') */
  delivery?: DeliveryHint;

  /** Correlation ID for request/response tracking */
  correlationId?: string;

  /** Optional timeout in milliseconds */
  timeoutMs?: number;
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Get a human-readable description of an address.
 */
export function describeAddress(addr: Address): string {
  if (isAgentAddress(addr)) return `agent:${addr.agent}`;
  if (isAgentsAddress(addr)) return `agents:[${addr.agents.join(", ")}]`;
  if (isScopeAddress(addr)) return `scope:${addr.scope}`;
  if (isRoleAddress(addr))
    return addr.within ? `role:${addr.role}@${addr.within}` : `role:${addr.role}`;
  if (isParentAddress(addr)) return "parent";
  if (isChildrenAddress(addr))
    return addr.depth ? `children(depth=${addr.depth})` : "children";
  if (isAncestorsAddress(addr))
    return addr.depth ? `ancestors(depth=${addr.depth})` : "ancestors";
  if (isDescendantsAddress(addr))
    return addr.depth ? `descendants(depth=${addr.depth})` : "descendants";
  if (isSiblingsAddress(addr)) return "siblings";
  if (isBroadcastAddress(addr)) return "broadcast";
  if (isTaskAddress(addr)) return `task:${addr.task}`;
  return "unknown";
}

/**
 * Normalize an address by applying default values.
 */
export function normalizeAddress<T extends Address>(addr: T): T {
  if (isChildrenAddress(addr) && addr.depth === undefined) {
    return { ...addr, depth: 1 } as T;
  }
  if (isDescendantsAddress(addr) && addr.depth === undefined) {
    return { ...addr, depth: Infinity } as T;
  }
  if (isAncestorsAddress(addr) && addr.depth === undefined) {
    return { ...addr, depth: Infinity } as T;
  }
  return addr;
}
