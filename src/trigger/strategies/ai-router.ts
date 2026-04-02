/**
 * AI Router Strategy
 *
 * A pluggable routing strategy that spawns a lightweight Claude session
 * to make routing decisions for trigger events.
 *
 * WARNING: This strategy is expensive — it spawns a Claude session per
 * routing decision. Use sparingly and only for events that genuinely
 * need intelligent routing. For most cases, the built-in "direct",
 * "role", or "head" strategies are sufficient and much cheaper.
 *
 * @module trigger/strategies/ai-router
 */

import type { RoutingStrategy, RoutingContext, RoutingDecision } from "../trigger-system-v2.js";
import type { TriggerEvent } from "../types.js";

export interface AIRouterConfig {
  /** Model to use for routing decisions (currently unused — uses default). */
  model?: string;
  /** Maximum time in ms to wait for the AI routing decision. */
  maxDecisionTimeMs?: number;
  /** Whether to log routing decisions to stderr. */
  enableLogging?: boolean;
}

/**
 * Create an AI router strategy that uses a temporary Claude agent
 * to decide which agent(s) should handle a trigger event.
 *
 * Falls back to "head" strategy (route to root agents) if spawning
 * fails or takes too long.
 */
export function createAIRouterStrategy(config?: AIRouterConfig): RoutingStrategy {
  const maxDecisionTimeMs = config?.maxDecisionTimeMs ?? 30000;
  const enableLogging = config?.enableLogging ?? false;

  function log(msg: string): void {
    if (enableLogging) {
      console.error(`[ai-router] ${msg}`);
    }
  }

  return {
    name: "ai-router",
    description:
      "Spawns a temporary Claude session to make routing decisions. " +
      "Expensive — use only when intelligent routing is required.",

    canHandle(event: TriggerEvent): boolean {
      return event.routing?.target?.type === "ai-router";
    },

    async route(
      event: TriggerEvent,
      context: RoutingContext
    ): Promise<RoutingDecision> {
      // Get list of running agents for context
      const runningAgents = context.agentStore.listAgents({ state: "running" });

      if (runningAgents.length === 0) {
        log("No running agents — deferring");
        return {
          targetAgents: [],
          defer: true,
          deferReason: "No running agents available for AI routing",
        };
      }

      // Build prompt describing the event and available agents
      const agentDescriptions = runningAgents.map((a) =>
        `- ${a.id} (role: ${a.role}, task: "${a.task}"${a.team ? `, team: ${a.team}` : ""})`
      ).join("\n");

      const eventDescription = JSON.stringify({
        id: event.id,
        source: event.source,
        payload: event.payload,
        priority: event.priority,
        wakeMode: event.wakeMode,
      }, null, 2);

      const routingPrompt =
        `You are a routing assistant. Given the following trigger event, decide which agent(s) should handle it.\n\n` +
        `## Event\n${eventDescription}\n\n` +
        `## Available Agents\n${agentDescriptions}\n\n` +
        `Respond with ONLY a JSON array of agent IDs that should handle this event. ` +
        `Example: ["agent-abc", "agent-def"]\n` +
        `If no agent is suitable, respond with an empty array: []`;

      try {
        // Spawn a temporary agent for the routing decision
        log("Spawning temporary routing agent");
        const spawned = await Promise.race([
          context.agentManager.spawn({
            task: routingPrompt,
            role: "worker",
            cwd: process.cwd(),
          }),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error("AI router spawn timeout")),
              maxDecisionTimeMs
            )
          ),
        ]);

        // Wait briefly for the agent to produce output, then terminate
        // The agent's task IS the prompt, so it will respond in its first turn
        await new Promise((resolve) => setTimeout(resolve, 5000));

        // Try to get the agent's output via inbox
        let agentIds: string[] = [];
        try {
          const messages = await context.inboxAdapter.checkInbox(spawned.id);
          for (const msg of messages) {
            const text =
              typeof msg.content === "string"
                ? msg.content
                : (msg.content as { text?: string })?.text ?? "";
            const match = text.match(/\[.*\]/s);
            if (match) {
              const parsed = JSON.parse(match[0]);
              if (Array.isArray(parsed)) {
                agentIds = parsed.filter((id): id is string => typeof id === "string");
                break;
              }
            }
          }
        } catch {
          log("Failed to read routing agent response");
        }

        // Terminate the temporary agent
        try {
          await context.agentManager.terminate(spawned.id, "completed");
        } catch {
          // Best effort
        }

        // Validate agent IDs — only keep IDs that are actually running
        const validIds = new Set(runningAgents.map((a) => a.id));
        const validatedIds = agentIds.filter((id) => validIds.has(id));

        if (validatedIds.length > 0) {
          log(`AI decided: ${validatedIds.join(", ")}`);
          return {
            targetAgents: validatedIds,
            reason: "AI router decision",
          };
        }

        // AI returned no valid agents — fall through to head strategy
        log("AI returned no valid agents, falling back to head strategy");
      } catch (error) {
        log(`AI routing failed: ${error}, falling back to head strategy`);
      }

      // Fallback: route to root agents (head strategy)
      const roots = context.agentStore.listAgents({
        parent_id: null,
        state: "running",
      });
      return {
        targetAgents: roots.map((a) => a.id),
        reason: "AI router fallback to head strategy",
      };
    },
  };
}
