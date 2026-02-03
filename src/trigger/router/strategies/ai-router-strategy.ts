/**
 * AI Router Strategy
 *
 * Intelligent routing strategy that uses an AI agent to
 * decide how to route triggers based on system state.
 *
 * @module trigger/router/strategies/ai-router-strategy
 */

import type { AgentId } from "../../../store/types/index.js";
import type { TriggerEvent } from "../../types.js";
import { formatTriggerPayload, formatTriggerSource } from "../../types.js";
import type {
  RoutingStrategy,
  RoutingContext,
  RoutingDecision,
  ExtendedRoutingContext,
  AgentSummary,
  TaskSummary,
} from "../types.js";

// =============================================================================
// AI Router Configuration
// =============================================================================

/**
 * AI router strategy options
 */
export interface AIRouterStrategyOptions {
  /** Maximum time to wait for AI decision (ms) */
  maxDecisionTimeMs?: number;
  /** Custom system prompt for router agent */
  systemPrompt?: string;
  /** Fallback strategy if AI fails */
  fallbackStrategy?: string;
  /** Enable debug logging */
  enableLogging?: boolean;
}

/**
 * Default system prompt for the router agent
 */
const DEFAULT_ROUTER_SYSTEM_PROMPT = `You are a routing agent for a multi-agent system. Your task is to decide how to route incoming triggers to the most appropriate agent.

Given information about:
1. The trigger event (source, payload, priority)
2. Currently active agents (their roles, states, and tasks)
3. Pending tasks

You must decide ONE of the following actions:
- ROUTE: Route to an existing agent by ID
- ROLE: Route to all agents with a specific role
- SPAWN: Create a new agent for this trigger
- HEAD: Route to the head manager/coordinator
- DEFER: Cannot route now, will retry later

Respond with a JSON object in this exact format:
{
  "action": "ROUTE" | "ROLE" | "SPAWN" | "HEAD" | "DEFER",
  "agentId": "agent_id_here",  // Required for ROUTE
  "role": "role_name",          // Required for ROLE
  "spawnTask": "task description", // Required for SPAWN
  "spawnRole": "optional_role",    // Optional for SPAWN
  "reason": "Brief explanation of your decision"
}`;

// =============================================================================
// Context Building
// =============================================================================

/**
 * Build extended routing context with agent/task summaries
 */
function buildExtendedContext(
  context: RoutingContext
): ExtendedRoutingContext {
  // Get active agents
  const allAgents = context.agentManager.list();
  const activeAgents: AgentSummary[] = allAgents.map((agent) => ({
    id: agent.id as AgentId,
    role: (agent.config as Record<string, unknown>)?.role as string | undefined,
    state: agent.state as "running" | "stopped" | "sleeping",
    currentTask: agent.task ?? undefined,
    parentId: agent.parent as AgentId | null | undefined,
  }));

  // Get pending tasks from event store
  const pendingTasks: TaskSummary[] = [];
  const tasks = context.eventStore.listTasks?.() ?? [];
  for (const task of tasks) {
    if (task.status === "pending" || task.status === "in_progress") {
      pendingTasks.push({
        id: task.id,
        description: task.description,
        status: task.status,
        assignedAgent: task.assigned_agent as AgentId | undefined,
      });
    }
  }

  return {
    ...context,
    activeAgents,
    pendingTasks,
  };
}

/**
 * Format context as a prompt for the router agent
 */
function formatContextForAgent(
  event: TriggerEvent,
  context: ExtendedRoutingContext
): string {
  const lines: string[] = [];

  // Trigger info
  lines.push("## Trigger Event");
  lines.push(`Source: ${formatTriggerSource(event.source)}`);
  lines.push(`Priority: ${event.priority ?? "normal"}`);
  lines.push(`Wake Mode: ${event.wakeMode}`);
  lines.push(`Payload:`);
  lines.push("```");
  lines.push(formatTriggerPayload(event.payload));
  lines.push("```");
  lines.push("");

  // Active agents
  lines.push("## Active Agents");
  if (context.activeAgents.length === 0) {
    lines.push("No active agents");
  } else {
    for (const agent of context.activeAgents) {
      const role = agent.role ? ` [${agent.role}]` : "";
      const task = agent.currentTask ? ` - "${agent.currentTask}"` : "";
      const parent = agent.parentId ? ` (parent: ${agent.parentId})` : " (root)";
      lines.push(`- ${agent.id}${role}: ${agent.state}${task}${parent}`);
    }
  }
  lines.push("");

  // Pending tasks
  lines.push("## Pending Tasks");
  if (context.pendingTasks.length === 0) {
    lines.push("No pending tasks");
  } else {
    for (const task of context.pendingTasks) {
      const assigned = task.assignedAgent ? ` → ${task.assignedAgent}` : "";
      lines.push(`- [${task.status}] ${task.description}${assigned}`);
    }
  }
  lines.push("");

  // Request
  lines.push("## Your Task");
  lines.push("Decide how to route this trigger. Respond with a JSON object as described in your system prompt.");

  return lines.join("\n");
}

// =============================================================================
// Response Parsing
// =============================================================================

/**
 * AI router decision from JSON response
 */
interface AIRouterDecision {
  action: "ROUTE" | "ROLE" | "SPAWN" | "HEAD" | "DEFER";
  agentId?: string;
  role?: string;
  spawnTask?: string;
  spawnRole?: string;
  reason?: string;
}

/**
 * Parse AI response to extract routing decision
 */
function parseAIResponse(response: string): AIRouterDecision | null {
  // Try to extract JSON from response
  const jsonMatch = response.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return null;
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]);

    // Validate action
    const validActions = ["ROUTE", "ROLE", "SPAWN", "HEAD", "DEFER"];
    if (!validActions.includes(parsed.action)) {
      return null;
    }

    return {
      action: parsed.action,
      agentId: parsed.agentId,
      role: parsed.role,
      spawnTask: parsed.spawnTask,
      spawnRole: parsed.spawnRole,
      reason: parsed.reason,
    };
  } catch {
    return null;
  }
}

/**
 * Convert AI decision to routing decision
 */
function convertToRoutingDecision(
  aiDecision: AIRouterDecision,
  context: ExtendedRoutingContext
): RoutingDecision {
  switch (aiDecision.action) {
    case "ROUTE": {
      if (!aiDecision.agentId) {
        return {
          targetAgents: [],
          defer: true,
          deferReason: "AI specified ROUTE but no agentId provided",
        };
      }

      // Verify agent exists
      const agent = context.agentManager.get(aiDecision.agentId);
      if (!agent) {
        return {
          targetAgents: [],
          defer: true,
          deferReason: `Agent ${aiDecision.agentId} not found`,
        };
      }

      return {
        targetAgents: [aiDecision.agentId as AgentId],
        reason: aiDecision.reason ?? `AI routed to ${aiDecision.agentId}`,
      };
    }

    case "ROLE": {
      if (!aiDecision.role) {
        return {
          targetAgents: [],
          defer: true,
          deferReason: "AI specified ROLE but no role provided",
        };
      }

      // Find agents with role
      const agentsWithRole = context.activeAgents.filter(
        (a) => a.role?.toLowerCase() === aiDecision.role?.toLowerCase()
      );

      if (agentsWithRole.length === 0) {
        return {
          targetAgents: [],
          defer: true,
          deferReason: `No agents with role ${aiDecision.role}`,
        };
      }

      return {
        targetAgents: agentsWithRole.map((a) => a.id),
        reason: aiDecision.reason ?? `AI routed to role ${aiDecision.role}`,
      };
    }

    case "SPAWN": {
      const task = aiDecision.spawnTask ?? "Handle trigger";

      return {
        targetAgents: [],
        spawnNew: {
          task,
          role: aiDecision.spawnRole,
        },
        reason: aiDecision.reason ?? `AI decided to spawn new agent for: ${task}`,
      };
    }

    case "HEAD": {
      // Find head manager
      const headManager = context.activeAgents.find((a) => !a.parentId);
      if (!headManager) {
        return {
          targetAgents: [],
          defer: true,
          deferReason: "No head manager found",
        };
      }

      return {
        targetAgents: [headManager.id],
        reason: aiDecision.reason ?? "AI routed to head manager",
      };
    }

    case "DEFER": {
      return {
        targetAgents: [],
        defer: true,
        deferReason: aiDecision.reason ?? "AI decided to defer",
      };
    }
  }
}

// =============================================================================
// AI Router Strategy Implementation
// =============================================================================

/**
 * Create an AI router strategy
 *
 * This strategy uses an AI agent to intelligently decide
 * how to route triggers based on system state.
 */
export function createAIRouterStrategy(
  options: AIRouterStrategyOptions = {}
): RoutingStrategy {
  const {
    maxDecisionTimeMs = 30_000,
    systemPrompt = DEFAULT_ROUTER_SYSTEM_PROMPT,
    fallbackStrategy = "head",
    enableLogging = false,
  } = options;

  function log(message: string, ...args: unknown[]): void {
    if (enableLogging) {
      console.log(`[ai-router] ${message}`, ...args);
    }
  }

  return {
    name: "ai-router",
    description: "Uses AI to intelligently route triggers based on system state",

    canHandle(event: TriggerEvent): boolean {
      // Check if event explicitly requests AI routing
      return event.routing?.target?.type === "ai-router";
    },

    async route(
      event: TriggerEvent,
      context: RoutingContext
    ): Promise<RoutingDecision> {
      log("Starting AI routing for event:", event.id);

      // Build extended context
      const extendedContext = buildExtendedContext(context);

      // Check if we have any agents to route to
      if (extendedContext.activeAgents.length === 0) {
        log("No active agents, deferring");
        return {
          targetAgents: [],
          defer: true,
          deferReason: "No active agents in system",
        };
      }

      // Format prompt for router agent
      const prompt = formatContextForAgent(event, extendedContext);

      try {
        // Find head manager to use as router
        const headManager = extendedContext.activeAgents.find((a) => !a.parentId);

        if (!headManager) {
          log("No head manager for AI routing, falling back");
          return {
            targetAgents: [],
            defer: true,
            deferReason: "No head manager available for AI routing",
          };
        }

        // Create a timeout promise
        const timeoutPromise = new Promise<string>((_, reject) => {
          setTimeout(() => reject(new Error("AI decision timeout")), maxDecisionTimeMs);
        });

        // Prompt the agent for routing decision
        // We use the head manager's session for this
        const session = context.agentManager.getSession(headManager.id);

        if (!session) {
          log("No session for head manager, falling back");
          return {
            targetAgents: [],
            defer: true,
            deferReason: "No active session for routing decision",
          };
        }

        // Inject the routing request
        // Note: In a real implementation, you might fork a dedicated session
        // For now, we use inject to add context and wait for a response
        const routingPrompt = `[ROUTING REQUEST]\n${prompt}\n\nPlease provide your routing decision in JSON format.`;

        // Collect response
        let response = "";

        const responsePromise = (async () => {
          try {
            for await (const update of context.agentManager.prompt(
              headManager.id,
              routingPrompt
            )) {
              if (
                "sessionUpdate" in update &&
                update.sessionUpdate === "agent_message_chunk"
              ) {
                const chunk = update as { content: { type: string; text?: string } };
                if (chunk.content.type === "text" && chunk.content.text) {
                  response += chunk.content.text;
                }
              }
            }
          } catch (error) {
            log("Error getting AI response:", error);
          }
          return response;
        })();

        // Race against timeout
        response = await Promise.race([responsePromise, timeoutPromise]);

        log("AI response:", response.slice(0, 200));

        // Parse response
        const aiDecision = parseAIResponse(response);

        if (!aiDecision) {
          log("Could not parse AI response, falling back");
          return {
            targetAgents: [],
            defer: true,
            deferReason: "Could not parse AI routing decision",
          };
        }

        log("AI decision:", aiDecision);

        // Convert to routing decision
        return convertToRoutingDecision(aiDecision, extendedContext);
      } catch (error) {
        log("AI routing error:", error);

        // On error, try fallback to head manager
        const headManager = extendedContext.activeAgents.find((a) => !a.parentId);

        if (headManager) {
          return {
            targetAgents: [headManager.id],
            reason: `AI routing failed, falling back to head manager: ${
              error instanceof Error ? error.message : String(error)
            }`,
          };
        }

        return {
          targetAgents: [],
          defer: true,
          deferReason: `AI routing failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
    },
  };
}

/**
 * Get the default router system prompt
 */
export function getDefaultRouterSystemPrompt(): string {
  return DEFAULT_ROUTER_SYSTEM_PROMPT;
}
