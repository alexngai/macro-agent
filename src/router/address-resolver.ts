/**
 * Address Resolver
 *
 * Resolves MAP addresses to concrete agent IDs, with special handling
 * for hierarchical addresses (parent, children, ancestors, descendants, siblings)
 * that are relative to the sender.
 *
 * @module router/address-resolver
 * @see specs/s-5qir_map_integration_for_macro_agent.md
 */

import type { AgentId } from "../store/types/index.js";
import type {
  Address,
  HierarchicalAddress,
  ParentAddress,
  ChildrenAddress,
  AncestorsAddress,
  DescendantsAddress,
  SiblingsAddress,
} from "../map/types.js";
import {
  isAgentAddress,
  isAgentsAddress,
  isScopeAddress,
  isRoleAddress,
  isTaskAddress,
  isBroadcastAddress,
  isParentAddress,
  isChildrenAddress,
  isAncestorsAddress,
  isDescendantsAddress,
  isSiblingsAddress,
  isHierarchicalAddress,
} from "../map/types.js";

// =============================================================================
// Types
// =============================================================================

/**
 * Agent info required for hierarchy resolution.
 */
export interface HierarchyAgentInfo {
  id: AgentId;
  parent?: AgentId | null;
  lineage: AgentId[];
  state: string;
}

/**
 * Source for agent hierarchy information.
 */
export interface HierarchySource {
  getAgent(id: AgentId): HierarchyAgentInfo | undefined;
  listAgents(): HierarchyAgentInfo[];
}

/**
 * Result of resolving an address.
 */
export interface ResolvedAddress {
  /** Resolved agent IDs */
  agentIds: AgentId[];
  /** Type of resolution performed */
  type: "direct" | "hierarchical" | "structural" | "broadcast" | "task";
  /** Original address for reference */
  originalAddress: Address;
}

// =============================================================================
// Hierarchical Resolution Functions
// =============================================================================

/**
 * Resolve parent address to sender's parent agent.
 *
 * @param senderId - The agent sending the message
 * @param hierarchy - Source for hierarchy information
 * @returns Array containing parent ID, or empty if no parent
 */
export function resolveParent(
  senderId: AgentId,
  hierarchy: HierarchySource
): AgentId[] {
  const sender = hierarchy.getAgent(senderId);
  if (!sender?.parent) {
    return [];
  }

  // Verify parent exists and is running
  const parent = hierarchy.getAgent(sender.parent);
  if (!parent || parent.state !== "running") {
    return [];
  }

  return [sender.parent];
}

/**
 * Resolve children address to sender's child agents.
 *
 * @param senderId - The agent sending the message
 * @param depth - Maximum depth (1 = direct children only)
 * @param hierarchy - Source for hierarchy information
 * @returns Array of child agent IDs
 */
export function resolveChildren(
  senderId: AgentId,
  depth: number = 1,
  hierarchy: HierarchySource
): AgentId[] {
  const agents = hierarchy.listAgents();

  return agents
    .filter((agent) => {
      // Only include running agents
      if (agent.state !== "running") {
        return false;
      }

      // For depth 1, only direct children (parent === senderId)
      if (depth === 1) {
        return agent.parent === senderId;
      }

      // For depth > 1, check lineage position
      // EventStore lineage is ordered root-to-parent (oldest to newest)
      // The depth from sender to agent is (lineage.length - lineageIndex)
      const lineageIndex = agent.lineage.indexOf(senderId);
      if (lineageIndex === -1) {
        return false;
      }

      const agentDepth = agent.lineage.length - lineageIndex;
      return agentDepth <= depth;
    })
    .map((agent) => agent.id);
}

/**
 * Resolve ancestors address to sender's ancestor agents.
 *
 * @param senderId - The agent sending the message
 * @param depth - Maximum depth (Infinity = all ancestors)
 * @param hierarchy - Source for hierarchy information
 * @returns Array of ancestor agent IDs (closest first)
 */
export function resolveAncestors(
  senderId: AgentId,
  depth: number = Infinity,
  hierarchy: HierarchySource
): AgentId[] {
  const sender = hierarchy.getAgent(senderId);
  if (!sender || sender.lineage.length === 0) {
    return [];
  }

  // EventStore lineage is ordered from root to parent (oldest to newest)
  // For depth=1, we want just the direct parent (last element)
  // For depth=2, we want parent and grandparent (last 2 elements)
  // We reverse to get closest ancestors first
  const reversedLineage = [...sender.lineage].reverse();
  const ancestorsToCheck =
    depth === Infinity ? reversedLineage : reversedLineage.slice(0, depth);

  // Filter to only running ancestors
  return ancestorsToCheck.filter((ancestorId) => {
    const ancestor = hierarchy.getAgent(ancestorId);
    return ancestor && ancestor.state === "running";
  });
}

/**
 * Resolve descendants address to all agents descended from sender.
 *
 * @param senderId - The agent sending the message
 * @param depth - Maximum depth (Infinity = all descendants)
 * @param hierarchy - Source for hierarchy information
 * @returns Array of descendant agent IDs
 */
export function resolveDescendants(
  senderId: AgentId,
  depth: number = Infinity,
  hierarchy: HierarchySource
): AgentId[] {
  const agents = hierarchy.listAgents();

  return agents
    .filter((agent) => {
      // Only include running agents
      if (agent.state !== "running") {
        return false;
      }

      // Check if senderId is in this agent's lineage
      const lineageIndex = agent.lineage.indexOf(senderId);
      if (lineageIndex === -1) {
        return false;
      }

      // EventStore lineage is ordered root-to-parent (oldest to newest)
      // The depth from sender to agent is (lineage.length - lineageIndex)
      // Example: lineage [root, parent], sender=root, lineageIndex=0
      //   depth = 2 - 0 = 2 (grandchild of root)
      // Example: lineage [root], sender=root, lineageIndex=0
      //   depth = 1 - 0 = 1 (direct child of root)
      const agentDepth = agent.lineage.length - lineageIndex;
      return depth === Infinity || agentDepth <= depth;
    })
    .map((agent) => agent.id);
}

/**
 * Resolve siblings address to agents sharing the same parent as sender.
 *
 * @param senderId - The agent sending the message
 * @param hierarchy - Source for hierarchy information
 * @returns Array of sibling agent IDs (excludes sender)
 */
export function resolveSiblings(
  senderId: AgentId,
  hierarchy: HierarchySource
): AgentId[] {
  const sender = hierarchy.getAgent(senderId);
  if (!sender?.parent) {
    // Root agents have no siblings (no parent)
    return [];
  }

  const agents = hierarchy.listAgents();

  return agents
    .filter((agent) => {
      // Only include running agents
      if (agent.state !== "running") {
        return false;
      }

      // Same parent, but not the sender
      return agent.parent === sender.parent && agent.id !== senderId;
    })
    .map((agent) => agent.id);
}

// =============================================================================
// Main Resolution Function
// =============================================================================

/**
 * Resolve a hierarchical address to concrete agent IDs.
 *
 * @param address - The hierarchical address to resolve
 * @param senderId - The agent sending the message
 * @param hierarchy - Source for hierarchy information
 * @returns Resolved address with agent IDs
 */
export function resolveHierarchicalAddress(
  address: HierarchicalAddress,
  senderId: AgentId,
  hierarchy: HierarchySource
): ResolvedAddress {
  let agentIds: AgentId[] = [];

  if (isParentAddress(address)) {
    agentIds = resolveParent(senderId, hierarchy);
  } else if (isChildrenAddress(address)) {
    const depth = address.depth ?? 1;
    agentIds = resolveChildren(senderId, depth, hierarchy);
  } else if (isAncestorsAddress(address)) {
    const depth = address.depth ?? Infinity;
    agentIds = resolveAncestors(senderId, depth, hierarchy);
  } else if (isDescendantsAddress(address)) {
    const depth = address.depth ?? Infinity;
    agentIds = resolveDescendants(senderId, depth, hierarchy);
  } else if (isSiblingsAddress(address)) {
    agentIds = resolveSiblings(senderId, hierarchy);
  }

  return {
    agentIds,
    type: "hierarchical",
    originalAddress: address,
  };
}

/**
 * Check if a hierarchical address will resolve to any agents.
 * Useful for validation before sending.
 *
 * @param address - The hierarchical address to check
 * @param senderId - The agent sending the message
 * @param hierarchy - Source for hierarchy information
 * @returns True if address resolves to at least one agent
 */
export function hasRecipients(
  address: HierarchicalAddress,
  senderId: AgentId,
  hierarchy: HierarchySource
): boolean {
  const resolved = resolveHierarchicalAddress(address, senderId, hierarchy);
  return resolved.agentIds.length > 0;
}
