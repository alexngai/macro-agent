/**
 * Direct Routing Strategy
 *
 * Routes triggers directly to a specified agent ID.
 * Validates agent exists and optionally spawns if not found.
 *
 * @module trigger/router/strategies/direct-strategy
 */

import type { AgentId } from "../../../store/types/index.js";
import type { TriggerEvent } from "../../types.js";
import type { RoutingStrategy, RoutingContext, RoutingDecision } from "../types.js";

// =============================================================================
// Direct Strategy Implementation
// =============================================================================

/**
 * Direct routing strategy options
 */
export interface DirectStrategyOptions {
  /** Whether to validate agent exists before routing */
  validateAgent?: boolean;
  /** Whether to allow spawning if agent not found */
  allowSpawn?: boolean;
}

/**
 * Create a direct routing strategy
 *
 * Routes triggers to explicitly specified agent IDs in the
 * routing hints.
 */
export function createDirectStrategy(
  options: DirectStrategyOptions = {}
): RoutingStrategy {
  const { validateAgent = true, allowSpawn = false } = options;

  return {
    name: "direct",
    description: "Routes triggers directly to specified agent IDs",

    canHandle(event: TriggerEvent): boolean {
      // Can handle if target is specified as an agent ID
      const target = event.routing?.target;
      return target?.type === "agent" && Boolean(target.agentId);
    },

    async route(
      event: TriggerEvent,
      context: RoutingContext
    ): Promise<RoutingDecision> {
      const target = event.routing?.target;

      // Ensure we have an agent target
      if (target?.type !== "agent" || !target.agentId) {
        return {
          targetAgents: [],
          defer: true,
          deferReason: "No agent ID specified in routing target",
        };
      }

      const targetAgentId = target.agentId;

      // Validate agent exists if configured
      if (validateAgent) {
        const agent = context.agentManager.get(targetAgentId);

        if (!agent) {
          // Agent doesn't exist - check spawn config
          if (allowSpawn && event.routing?.spawnIfNotFound) {
            const spawnConfig = event.routing.spawnConfig;
            if (spawnConfig) {
              return {
                targetAgents: [],
                spawnNew: {
                  task: spawnConfig.task,
                  role: spawnConfig.role,
                  parentId: spawnConfig.parentId,
                },
                reason: `Agent ${targetAgentId} not found, spawning new agent`,
              };
            }
          }

          // Check fallback target
          if (event.routing?.fallbackTarget) {
            return {
              targetAgents: [],
              defer: true,
              deferReason: `Agent ${targetAgentId} not found, fallback to other strategy`,
            };
          }

          return {
            targetAgents: [],
            defer: true,
            deferReason: `Agent ${targetAgentId} not found`,
          };
        }

        // Agent exists but is stopped
        if (agent.state === "stopped") {
          return {
            targetAgents: [targetAgentId],
            reason: `Agent ${targetAgentId} is stopped, will attempt to wake`,
          };
        }
      }

      // Route to the specified agent
      return {
        targetAgents: [targetAgentId],
        reason: `Direct routing to agent ${targetAgentId}`,
      };
    },
  };
}

// =============================================================================
// Head Manager Strategy
// =============================================================================

/**
 * Create a head manager routing strategy
 *
 * Always routes to the head manager (coordinator).
 */
export function createHeadStrategy(): RoutingStrategy {
  return {
    name: "head",
    description: "Routes all triggers to the head manager",

    canHandle(event: TriggerEvent): boolean {
      const target = event.routing?.target;
      return target?.type === "head" || !target;
    },

    async route(
      _event: TriggerEvent,
      context: RoutingContext
    ): Promise<RoutingDecision> {
      // Get head manager ID
      const agents = context.agentManager.list();
      const headManager = agents.find((a) => !a.parent);

      if (!headManager) {
        return {
          targetAgents: [],
          defer: true,
          deferReason: "No head manager found",
        };
      }

      return {
        targetAgents: [headManager.id as AgentId],
        reason: "Routing to head manager",
      };
    },
  };
}
