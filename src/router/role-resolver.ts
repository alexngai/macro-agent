/**
 * Role Channel Resolution
 *
 * Handles send-time resolution for role-based channels (@workers, @integrator, etc).
 * Supports optional coordinator scoping to target only agents within a coordinator's subtree.
 *
 * @module router/role-resolver
 * @see s-9rld In-Flight Steering spec section 3.2
 */

import type { AgentId } from "../store/types/index.js";
import type { RoleTarget } from "./types.js";

// =============================================================================
// Types
// =============================================================================

/**
 * Agent info required for role resolution
 */
export interface RoleAgentInfo {
  id: AgentId;
  state: string;
  role?: string;
  lineage: AgentId[];
}

/**
 * Agent source for role resolution
 */
export interface RoleAgentSource {
  listAgents(): RoleAgentInfo[];
  getAgent(agentId: AgentId): RoleAgentInfo | null;
}

// =============================================================================
// Role Matching
// =============================================================================

/**
 * Check if an agent's role matches a target role.
 *
 * Matching rules:
 * - Exact match: "worker" matches "worker"
 * - Prefix match: "worker" matches "worker.resolver"
 * - No match: "integrator" does not match "worker"
 */
export function matchesRole(
  agentRole: string | undefined,
  targetRole: string
): boolean {
  if (!agentRole) {
    // Agents without a role default to "worker"
    return targetRole === "worker";
  }

  // Exact match or prefix match (e.g., "worker.resolver" matches target "worker")
  return agentRole === targetRole || agentRole.startsWith(`${targetRole}.`);
}

// =============================================================================
// Subtree Resolution
// =============================================================================

/**
 * Get all agent IDs in a coordinator's subtree (including the coordinator).
 * Uses lineage to determine which agents are descendants.
 */
export function getSubtreeIds(
  coordinatorId: AgentId,
  agentSource: RoleAgentSource
): Set<AgentId> {
  const subtreeIds = new Set<AgentId>([coordinatorId]);
  const agents = agentSource.listAgents();

  for (const agent of agents) {
    // An agent is in the subtree if the coordinator is in their lineage
    if (agent.lineage.includes(coordinatorId)) {
      subtreeIds.add(agent.id);
    }
  }

  return subtreeIds;
}

// =============================================================================
// Role Channel Resolution
// =============================================================================

/**
 * Resolve a role channel to recipient agent IDs.
 *
 * @param agentSource - Source for listing/getting agents
 * @param target - Role target with role name and optional coordinator scope
 * @returns Array of agent IDs for fan-out delivery
 */
export function resolveRoleTarget(
  agentSource: RoleAgentSource,
  target: RoleTarget
): AgentId[] {
  const agents = agentSource.listAgents();

  // Get subtree IDs if coordinator scoping is requested
  let subtreeIds: Set<AgentId> | null = null;
  if (target.coordinatorId) {
    subtreeIds = getSubtreeIds(target.coordinatorId, agentSource);
  }

  return agents
    .filter((agent) => {
      // Only include running agents
      if (agent.state !== "running") {
        return false;
      }

      // Check role match
      if (!matchesRole(agent.role, target.role)) {
        return false;
      }

      // If coordinator scoping, check if agent is in subtree
      if (subtreeIds && !subtreeIds.has(agent.id)) {
        return false;
      }

      return true;
    })
    .map((agent) => agent.id);
}

/**
 * Get all agents with a specific role.
 *
 * @param agentSource - Source for listing agents
 * @param role - Role name to match
 * @returns Array of agent IDs matching the role
 */
export function getAgentsByRole(
  agentSource: RoleAgentSource,
  role: string
): AgentId[] {
  return resolveRoleTarget(agentSource, { role });
}
