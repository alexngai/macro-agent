/**
 * Broadcast Channel Resolution
 *
 * Handles fan-out delivery for broadcast channels with scope filtering.
 *
 * @module router/broadcast
 * @see s-9rld In-Flight Steering spec section 3.2
 */

import type { AgentId } from "../store/types/index.js";
import type { BroadcastScope } from "./types.js";

// =============================================================================
// Types
// =============================================================================

/**
 * Agent info required for broadcast resolution
 */
export interface BroadcastAgentInfo {
  id: AgentId;
  state: string;
  role?: string;
}

/**
 * Agent source for broadcast resolution
 */
export interface BroadcastAgentSource {
  listAgents(): BroadcastAgentInfo[];
}

// =============================================================================
// Scope Matching
// =============================================================================

/**
 * Check if a role matches a broadcast scope.
 *
 * Scope mappings:
 * - 'all': matches all agents
 * - 'coordinators': matches 'coordinator' role and any 'coordinator.*' subroles
 * - 'workers': matches 'worker' role and any 'worker.*' subroles
 * - 'monitors': matches 'monitor' role and any 'monitor.*' subroles
 */
export function matchesBroadcastScope(
  role: string | undefined,
  scope: BroadcastScope
): boolean {
  if (scope === "all") {
    return true;
  }

  if (!role) {
    // Agents without a role default to worker behavior
    return scope === "workers";
  }

  // Map scope to role prefix
  const scopeToRolePrefix: Record<BroadcastScope, string> = {
    all: "", // Already handled above
    coordinators: "coordinator",
    workers: "worker",
    monitors: "monitor",
  };

  const rolePrefix = scopeToRolePrefix[scope];

  // Match exact role or subrole (e.g., "worker" or "worker.resolver")
  return role === rolePrefix || role.startsWith(`${rolePrefix}.`);
}

// =============================================================================
// Broadcast Resolution
// =============================================================================

/**
 * Get all agents that should receive a broadcast message.
 *
 * @param agentSource - Source for listing agents
 * @param scope - Optional scope filter (default: 'all')
 * @returns Array of agent IDs to deliver message to
 */
export function getBroadcastRecipients(
  agentSource: BroadcastAgentSource,
  scope?: BroadcastScope
): AgentId[] {
  const effectiveScope = scope ?? "all";
  const agents = agentSource.listAgents();

  // Filter to running agents that match the scope
  return agents
    .filter((agent) => {
      // Only include running agents
      if (agent.state !== "running") {
        return false;
      }

      // Check scope match
      return matchesBroadcastScope(agent.role, effectiveScope);
    })
    .map((agent) => agent.id);
}

/**
 * Resolve a broadcast target to recipient agent IDs.
 *
 * @param agentSource - Source for listing agents
 * @param target - Broadcast target with optional scope
 * @returns Array of agent IDs for fan-out delivery
 */
export function resolveBroadcastTarget(
  agentSource: BroadcastAgentSource,
  target: { scope?: BroadcastScope }
): AgentId[] {
  return getBroadcastRecipients(agentSource, target.scope);
}
