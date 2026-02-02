/**
 * Role-Based Routing Strategy
 *
 * Routes triggers to agents based on their assigned roles.
 * Supports single-agent and broadcast modes.
 *
 * @module trigger/router/strategies/role-strategy
 */

import type { AgentId } from "../../../store/types/index.js";
import type { TriggerEvent } from "../../types.js";
import type { RoutingStrategy, RoutingContext, RoutingDecision } from "../types.js";

// =============================================================================
// Role Strategy Implementation
// =============================================================================

/**
 * Role routing strategy options
 */
export interface RoleStrategyOptions {
  /** Route to all agents with role (broadcast) or just first */
  mode?: "first" | "all";
  /** Prefer running agents over stopped */
  preferRunning?: boolean;
  /** Allow spawning if no agent with role exists */
  allowSpawn?: boolean;
}

/**
 * Create a role-based routing strategy
 *
 * Routes triggers to agents that have a specific role assigned.
 */
export function createRoleStrategy(
  options: RoleStrategyOptions = {}
): RoutingStrategy {
  const { mode = "first", preferRunning = true, allowSpawn = false } = options;

  return {
    name: "role",
    description: "Routes triggers to agents by role",

    canHandle(event: TriggerEvent): boolean {
      const target = event.routing?.target;
      return target?.type === "role" && Boolean(target.role);
    },

    async route(
      event: TriggerEvent,
      context: RoutingContext
    ): Promise<RoutingDecision> {
      const target = event.routing?.target;

      // Ensure we have a role target
      if (target?.type !== "role" || !target.role) {
        return {
          targetAgents: [],
          defer: true,
          deferReason: "No role specified in routing target",
        };
      }

      const targetRole = target.role;

      // Find agents with the specified role
      const allAgents = context.agentManager.list();

      // Filter by role - check config.role or task for role hint
      const agentsWithRole = allAgents.filter((agent) => {
        const config = agent.config as Record<string, unknown> | undefined;
        const agentRole = config?.role as string | undefined;

        // Check explicit role in config
        if (agentRole && agentRole.toLowerCase() === targetRole.toLowerCase()) {
          return true;
        }

        // Check if task mentions the role (fallback heuristic)
        if (agent.task?.toLowerCase().includes(targetRole.toLowerCase())) {
          return true;
        }

        return false;
      });

      if (agentsWithRole.length === 0) {
        // No agents with role - check spawn config
        if (allowSpawn && event.routing?.spawnIfNotFound) {
          const spawnConfig = event.routing.spawnConfig;
          return {
            targetAgents: [],
            spawnNew: {
              task: spawnConfig?.task ?? `Handle ${targetRole} tasks`,
              role: targetRole,
              parentId: spawnConfig?.parentId,
            },
            reason: `No agent with role ${targetRole}, spawning new agent`,
          };
        }

        return {
          targetAgents: [],
          defer: true,
          deferReason: `No agents found with role: ${targetRole}`,
        };
      }

      // Sort by preference
      let candidates = [...agentsWithRole];

      if (preferRunning) {
        candidates.sort((a, b) => {
          // Running agents first
          if (a.state === "running" && b.state !== "running") return -1;
          if (b.state === "running" && a.state !== "running") return 1;
          // Then by creation time (newer first for freshness)
          return (b.created_at ?? 0) - (a.created_at ?? 0);
        });
      }

      // Select targets based on mode
      if (mode === "all") {
        return {
          targetAgents: candidates.map((a) => a.id as AgentId),
          reason: `Broadcasting to ${candidates.length} agents with role ${targetRole}`,
        };
      }

      // First mode - return first matching agent
      const selected = candidates[0];
      return {
        targetAgents: [selected.id as AgentId],
        reason: `Routing to agent ${selected.id} with role ${targetRole}`,
      };
    },
  };
}

// =============================================================================
// Broadcast Strategy
// =============================================================================

/**
 * Create a broadcast routing strategy
 *
 * Routes triggers to all agents in a broadcast channel.
 */
export function createBroadcastStrategy(): RoutingStrategy {
  return {
    name: "broadcast",
    description: "Broadcasts triggers to all agents in a channel",

    canHandle(event: TriggerEvent): boolean {
      const target = event.routing?.target;
      return target?.type === "broadcast";
    },

    async route(
      event: TriggerEvent,
      context: RoutingContext
    ): Promise<RoutingDecision> {
      const target = event.routing?.target;

      if (target?.type !== "broadcast") {
        return {
          targetAgents: [],
          defer: true,
          deferReason: "No broadcast channel specified",
        };
      }

      const channel = target.channel;

      // For now, broadcast channels map to roles
      // In the future, this could use explicit channel subscriptions
      const allAgents = context.agentManager.list();

      // Filter running agents that might be interested in this channel
      const subscribers = allAgents.filter((agent) => {
        if (agent.state !== "running") return false;

        const config = agent.config as Record<string, unknown> | undefined;
        const agentRole = config?.role as string | undefined;

        // Check if agent role matches channel
        if (agentRole && agentRole.toLowerCase() === channel.toLowerCase()) {
          return true;
        }

        // Check subscribed channels in config
        const channels = config?.channels as string[] | undefined;
        if (channels?.includes(channel)) {
          return true;
        }

        return false;
      });

      if (subscribers.length === 0) {
        return {
          targetAgents: [],
          reason: `No subscribers for broadcast channel: ${channel}`,
        };
      }

      return {
        targetAgents: subscribers.map((a) => a.id as AgentId),
        reason: `Broadcasting to ${subscribers.length} agents on channel ${channel}`,
      };
    },
  };
}

// =============================================================================
// Task Strategy
// =============================================================================

/**
 * Create a task-based routing strategy
 *
 * Routes triggers to the agent assigned to a specific task.
 */
export function createTaskStrategy(): RoutingStrategy {
  return {
    name: "task",
    description: "Routes triggers to agents by task assignment",

    canHandle(event: TriggerEvent): boolean {
      const target = event.routing?.target;
      return target?.type === "task" && Boolean(target.taskId);
    },

    async route(
      event: TriggerEvent,
      context: RoutingContext
    ): Promise<RoutingDecision> {
      const target = event.routing?.target;

      if (target?.type !== "task" || !target.taskId) {
        return {
          targetAgents: [],
          defer: true,
          deferReason: "No task ID specified",
        };
      }

      const taskId = target.taskId;

      // Find agent assigned to this task
      const allAgents = context.agentManager.list();
      const assignedAgent = allAgents.find((agent) => {
        return agent.task_id === taskId;
      });

      if (!assignedAgent) {
        return {
          targetAgents: [],
          defer: true,
          deferReason: `No agent assigned to task: ${taskId}`,
        };
      }

      return {
        targetAgents: [assignedAgent.id as AgentId],
        reason: `Routing to agent ${assignedAgent.id} assigned to task ${taskId}`,
      };
    },
  };
}
