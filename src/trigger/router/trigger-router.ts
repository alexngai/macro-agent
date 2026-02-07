/**
 * TriggerRouter - External Event Routing
 *
 * ## Routing Architecture Role
 *
 * TriggerRouter handles **external system events** (webhooks, cron, etc.)
 * and routes them to appropriate agents using pluggable strategies.
 *
 * ```
 * External Events → TriggerRouter → SystemEventQueue → WakeManager → Agent
 * (webhooks, cron)   (this)         (queueing)         (delivery)
 * ```
 *
 * **Responsibilities:**
 * - Route external events to target agents via configurable strategies
 * - Queue events for deferred delivery (SystemEventQueue)
 * - Support multiple routing strategies (direct, head, role-based, etc.)
 * - Trigger wake cycles for sleeping agents
 *
 * **Routing Strategies:**
 * - direct: Route to specific agent ID
 * - head: Route to coordinator/head of hierarchy
 * - role: Route to agents by role
 * - broadcast: Fan-out to multiple agents
 *
 * **Differs from MessageRouter:**
 * - TriggerRouter: External events → agents (one-way, queued)
 * - MessageRouter: Agent ↔ agent communication (bidirectional, immediate)
 *
 * **Differs from MAPAdapter:**
 * - TriggerRouter: System events (webhooks, cron, internal signals)
 * - MAPAdapter: MAP protocol clients (external agents, UIs)
 *
 * @module trigger/router/trigger-router
 */

import type { AgentId } from "../../store/types/index.js";
import type { EventStore } from "../../store/event-store.js";
import type { AgentManager } from "../../agent/agent-manager.js";
import type { MessageRouter } from "../../router/message-router.js";
import type { SystemEventQueue } from "../queue/types.js";
import type {
  TriggerEvent,
  TriggerDeliveryResult,
  TriggerDeliveryMethod,
} from "../types.js";
import { formatTriggerPayload, formatTriggerSource } from "../types.js";
import type {
  TriggerRouter,
  TriggerRouterConfig,
  RoutingStrategy,
  RoutingContext,
  RoutingDecision,
} from "./types.js";
import {
  createDirectStrategy,
  createHeadStrategy,
  createRoleStrategy,
  createBroadcastStrategy,
  createTaskStrategy,
} from "./strategies/index.js";

// =============================================================================
// Trigger Router Implementation
// =============================================================================

/**
 * Dependencies for creating a trigger router
 */
export interface TriggerRouterDeps {
  eventStore: EventStore;
  agentManager: AgentManager;
  messageRouter: MessageRouter;
  systemEventQueue: SystemEventQueue;
}

/**
 * Create a trigger router
 */
export function createTriggerRouter(
  deps: TriggerRouterDeps,
  config: TriggerRouterConfig = {}
): TriggerRouter {
  const strategies = new Map<string, RoutingStrategy>();
  let defaultStrategyName = config.defaultStrategy ?? "head";
  let started = false;

  // Create routing context
  const routingContext: RoutingContext = {
    eventStore: deps.eventStore,
    agentManager: deps.agentManager,
    messageRouter: deps.messageRouter,
    systemEventQueue: deps.systemEventQueue,
  };

  /**
   * Select the appropriate strategy for an event
   */
  function selectStrategy(event: TriggerEvent): RoutingStrategy | null {
    // Check for explicit strategy in routing hints
    const preferredName = event.routing?.strategyName;
    if (preferredName) {
      const preferred = strategies.get(preferredName);
      if (preferred) return preferred;
    }

    // Check target type and find matching strategy
    const target = event.routing?.target;
    if (target) {
      // Find strategy that can handle this target type
      for (const strategy of strategies.values()) {
        if (strategy.canHandle?.(event)) {
          return strategy;
        }
      }
    }

    // Fall back to default strategy
    return strategies.get(defaultStrategyName) ?? null;
  }

  /**
   * Deliver trigger to a single agent
   */
  async function deliverToAgent(
    agentId: AgentId,
    event: TriggerEvent,
    additionalContext?: string
  ): Promise<{ success: boolean; method: TriggerDeliveryMethod }> {
    const content = formatTriggerForDelivery(event, additionalContext);

    if (event.wakeMode === "next-prompt") {
      // Queue for next prompt
      deps.systemEventQueue.enqueue(content, {
        agentId,
        sourceKey: `${event.source.type}:${event.id}`,
        priority: event.priority,
      });
      return { success: true, method: "queued" };
    }

    // Immediate wake mode - try inject/interrupt chain
    const session = deps.agentManager.getSession(agentId);

    if (session) {
      // Agent has active session - try inject first
      if (session.supportsInject()) {
        try {
          const result = await session.inject(content);
          if (result.success) {
            return { success: true, method: "inject" };
          }
        } catch {
          // Fall through to interrupt
        }
      }

      // Try interrupt
      try {
        // Start the interrupt (fire and forget the iteration)
        const iterable = session.interruptWith(content);
        const iterator = iterable[Symbol.asyncIterator]();
        await iterator.next(); // Drive first update
        return { success: true, method: "interrupt" };
      } catch {
        // Fall through to queue
      }
    }

    // No session or inject/interrupt failed - try wake via prompt
    const agent = deps.agentManager.get(agentId);
    if (agent && agent.state !== "stopped") {
      try {
        // Fire and forget prompt
        const promptIterable = deps.agentManager.prompt(agentId, content);
        (async () => {
          try {
            for await (const _ of promptIterable) {
              break; // Just drive first update
            }
          } catch {
            // Ignore background errors
          }
        })();
        return { success: true, method: "wake" };
      } catch {
        // Fall through to queue
      }
    }

    // Final fallback - queue for when agent becomes available
    deps.systemEventQueue.enqueue(content, {
      agentId,
      sourceKey: `${event.source.type}:${event.id}`,
      priority: event.priority,
    });
    return { success: true, method: "queued" };
  }

  /**
   * Format trigger for delivery to agent
   */
  function formatTriggerForDelivery(
    event: TriggerEvent,
    additionalContext?: string
  ): string {
    const lines: string[] = [];

    lines.push(`[Trigger: ${formatTriggerSource(event.source)}]`);

    if (event.priority && event.priority !== "normal") {
      lines.push(`Priority: ${event.priority.toUpperCase()}`);
    }

    lines.push(`Time: ${new Date(event.timestamp).toISOString()}`);
    lines.push("");
    lines.push(formatTriggerPayload(event.payload));

    if (additionalContext) {
      lines.push("");
      lines.push(`Context: ${additionalContext}`);
    }

    return lines.join("\n");
  }

  /**
   * Spawn a new agent for handling the trigger
   */
  async function spawnAgent(
    event: TriggerEvent,
    decision: RoutingDecision
  ): Promise<AgentId | null> {
    if (!decision.spawnNew) return null;

    const { task, role, parentId } = decision.spawnNew;

    try {
      // Find parent agent for spawning
      let parent: AgentId | undefined;

      if (parentId) {
        parent = parentId;
      } else {
        // Default to head manager
        const agents = deps.agentManager.list();
        const headManager = agents.find((a) => !a.parent);
        parent = headManager?.id as AgentId | undefined;
      }

      if (!parent) {
        console.error("[trigger-router] Cannot spawn: no parent agent found");
        return null;
      }

      // Spawn via prompting parent to spawn
      // This is a simplified approach - in practice you might
      // use a direct spawn API
      const spawnRequest = `Spawn a new ${role ?? "worker"} agent to: ${task}`;

      const spawnPrompt = deps.agentManager.prompt(parent, spawnRequest);
      for await (const _ of spawnPrompt) {
        // Drive to completion
      }

      // Try to find the newly spawned agent
      const agents = deps.agentManager.list();
      const newAgent = agents.find(
        (a) => a.parent === parent && a.task?.includes(task.slice(0, 20))
      );

      return (newAgent?.id as AgentId) ?? null;
    } catch (error) {
      console.error("[trigger-router] Failed to spawn agent:", error);
      return null;
    }
  }

  // =============================================================================
  // Router Interface
  // =============================================================================

  const router: TriggerRouter = {
    async route(event: TriggerEvent): Promise<TriggerDeliveryResult> {
      if (!started) {
        return {
          success: false,
          deliveredTo: [],
          method: "queued",
          error: "Trigger router not started",
        };
      }

      // Select routing strategy
      const strategy = selectStrategy(event);

      if (!strategy) {
        return {
          success: false,
          deliveredTo: [],
          method: "queued",
          error: `No routing strategy available for event`,
        };
      }

      // Get routing decision
      let decision: RoutingDecision;
      try {
        decision = await strategy.route(event, routingContext);
      } catch (error) {
        return {
          success: false,
          deliveredTo: [],
          method: "queued",
          error: `Strategy error: ${error instanceof Error ? error.message : String(error)}`,
        };
      }

      // Check for defer
      if (decision.defer) {
        // Try fallback target if available
        if (event.routing?.fallbackTarget) {
          const fallbackEvent: TriggerEvent = {
            ...event,
            routing: {
              ...event.routing,
              target: event.routing.fallbackTarget,
              fallbackTarget: undefined,
            },
          };
          return this.route(fallbackEvent);
        }

        return {
          success: false,
          deliveredTo: [],
          method: "queued",
          error: decision.deferReason ?? "Routing deferred",
        };
      }

      // Handle spawn if needed
      let spawnedAgentId: AgentId | undefined;
      if (decision.spawnNew) {
        const newAgentId = await spawnAgent(event, decision);
        if (newAgentId) {
          spawnedAgentId = newAgentId;
          decision.targetAgents = [newAgentId];
        }
      }

      // No targets
      if (decision.targetAgents.length === 0) {
        return {
          success: false,
          deliveredTo: [],
          method: "queued",
          error: "No target agents found",
        };
      }

      // Apply wake mode override
      const effectiveEvent: TriggerEvent = decision.wakeModeOverride
        ? { ...event, wakeMode: decision.wakeModeOverride }
        : event;

      // Deliver to all target agents
      const results: Array<{ agentId: AgentId; success: boolean; method: TriggerDeliveryMethod }> = [];

      for (const agentId of decision.targetAgents) {
        const result = await deliverToAgent(
          agentId,
          effectiveEvent,
          decision.additionalContext
        );
        results.push({ agentId, ...result });
      }

      // Aggregate results
      const deliveredTo = results
        .filter((r) => r.success)
        .map((r) => r.agentId);

      const primaryMethod = results[0]?.method ?? "queued";

      return {
        success: deliveredTo.length > 0,
        deliveredTo,
        method: deliveredTo.length > 1 ? "broadcast" : primaryMethod,
        spawned: Boolean(spawnedAgentId),
        spawnedAgentId,
        metadata: {
          strategy: strategy.name,
          reason: decision.reason,
          totalTargets: decision.targetAgents.length,
          successfulDeliveries: deliveredTo.length,
        },
      };
    },

    registerStrategy(strategy: RoutingStrategy): void {
      strategies.set(strategy.name, strategy);
    },

    unregisterStrategy(name: string): void {
      strategies.delete(name);
    },

    getStrategy(name: string): RoutingStrategy | undefined {
      return strategies.get(name);
    },

    listStrategies(): string[] {
      return Array.from(strategies.keys());
    },

    setDefaultStrategy(name: string): void {
      if (!strategies.has(name)) {
        throw new Error(`Strategy not found: ${name}`);
      }
      defaultStrategyName = name;
    },

    getDefaultStrategy(): string {
      return defaultStrategyName;
    },

    async start(): Promise<void> {
      if (started) return;

      // Register built-in strategies
      router.registerStrategy(createHeadStrategy());
      router.registerStrategy(createDirectStrategy());
      router.registerStrategy(createRoleStrategy({ allowSpawn: true }));
      router.registerStrategy(createBroadcastStrategy());
      router.registerStrategy(createTaskStrategy());

      // Initialize strategies
      for (const strategy of strategies.values()) {
        if (strategy.initialize) {
          await strategy.initialize(routingContext);
        }
      }

      started = true;
    },

    async stop(): Promise<void> {
      if (!started) return;

      // Cleanup strategies
      for (const strategy of strategies.values()) {
        if (strategy.cleanup) {
          await strategy.cleanup();
        }
      }

      started = false;
    },
  };

  return router;
}
