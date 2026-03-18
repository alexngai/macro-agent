/**
 * Trigger System V2 Factory
 *
 * Rewired to use InboxAdapter instead of EventStore/MessageRouter.
 * Connects inbox delivery events to WakeManager for agent wake decisions.
 *
 * Key changes from V1:
 * - InboxAdapter.onDelivery → WakeManager delivery chain
 * - RoutingContext uses AgentStore instead of EventStore
 * - RoutingContext uses InboxAdapter instead of MessageRouter
 * - WakeManager unchanged (only depends on AgentManager interface)
 * - SystemEventQueue unchanged (no external deps)
 * - CronService/WebhookHandler unchanged (only depend on router + wake)
 *
 * @module trigger/trigger-system-v2
 */

import type { AgentManager } from "../agent/agent-manager.js";
import type { AgentStore } from "../agent/agent-store.js";
import type { InboxAdapter, InboxDeliveryEvent } from "../adapters/types.js";
import type { TriggerRouter, TriggerEvent, TriggerDeliveryResult } from "./types.js";

import { createSystemEventQueue, type SystemEventQueue } from "./queue/index.js";
import {
  createWakeManager,
  type TriggerWakeManager,
  type WakeManagerConfig,
} from "./wake/index.js";
import {
  createCronService,
  type CronService,
  type CronServiceConfig,
} from "./sources/cron/index.js";
import {
  createWebhookHandler,
  type WebhookHandler,
  type WebhookHandlerConfig,
} from "./sources/webhook/index.js";

// =============================================================================
// Configuration
// =============================================================================

export interface TriggerSystemV2Config {
  queue?: { maxEventsPerAgent?: number };
  wake?: WakeManagerConfig;
  cron?: CronServiceConfig;
  webhook?: WebhookHandlerConfig;
}

export interface TriggerSystemV2Deps {
  agentManager: AgentManager;
  agentStore: AgentStore;
  inboxAdapter: InboxAdapter;
}

// =============================================================================
// Interface
// =============================================================================

export interface TriggerSystemV2 {
  readonly queue: SystemEventQueue;
  readonly router: TriggerRouterV2;
  readonly wakeManager: TriggerWakeManager;
  readonly cronService: CronService;
  readonly webhookHandler: WebhookHandler;

  start(): Promise<void>;
  stop(): Promise<void>;
  isRunning(): boolean;
}

// =============================================================================
// Routing Strategy (restored from V1)
// =============================================================================

/**
 * Context provided to routing strategies for making decisions.
 * V2 version uses AgentStore + InboxAdapter instead of EventStore + MessageRouter.
 */
export interface RoutingContext {
  agentStore: AgentStore;
  agentManager: AgentManager;
  inboxAdapter: InboxAdapter;
  systemEventQueue: SystemEventQueue;
}

/**
 * Routing decision returned by a strategy.
 */
export interface RoutingDecision {
  targetAgents: string[];
  spawnNew?: { task: string; role?: string; parentId?: string };
  additionalContext?: string;
  wakeModeOverride?: "now" | "next-prompt";
  reason?: string;
  defer?: boolean;
  deferReason?: string;
}

/**
 * Pluggable routing strategy interface.
 * Implement this to create custom routing strategies for trigger delivery.
 */
export interface RoutingStrategy {
  readonly name: string;
  readonly description?: string;

  /** Determine routing for a trigger event. */
  route(event: TriggerEvent, context: RoutingContext): Promise<RoutingDecision>;

  /** Check if this strategy can handle the event (optional). */
  canHandle?(event: TriggerEvent): boolean;

  /** Initialize the strategy (optional). */
  initialize?(context: RoutingContext): Promise<void>;

  /** Cleanup the strategy (optional). */
  cleanup?(): Promise<void>;
}

/**
 * V2 Trigger Router with pluggable strategy support.
 */
export interface TriggerRouterV2 extends TriggerRouter {
  registerStrategy(strategy: RoutingStrategy): void;
  unregisterStrategy(name: string): void;
  getStrategy(name: string): RoutingStrategy | undefined;
  listStrategies(): string[];
  setDefaultStrategy(name: string): void;
  getDefaultStrategy(): string;
}

// =============================================================================
// Importance → Wake Action Mapping
// =============================================================================

type WakeAction = "interrupt" | "inject" | "wake" | "queue";

function mapImportanceToWakeAction(
  importance: string | undefined,
  hasActiveSession: boolean
): WakeAction {
  switch (importance) {
    case "urgent":
      return hasActiveSession ? "interrupt" : "wake";
    case "high":
      return hasActiveSession ? "inject" : "wake";
    case "normal":
      return hasActiveSession ? "queue" : "wake";
    case "low":
      return "queue";
    default:
      return hasActiveSession ? "queue" : "wake";
  }
}

// =============================================================================
// Factory
// =============================================================================

/**
 * Create a V2 trigger system that connects inbox delivery events
 * to the WakeManager's delivery chain.
 */
export function createTriggerSystemV2(
  deps: TriggerSystemV2Deps,
  config: TriggerSystemV2Config = {}
): TriggerSystemV2 {
  let running = false;

  // Create system event queue (unchanged)
  const queue = createSystemEventQueue({
    maxEventsPerAgent: config.queue?.maxEventsPerAgent,
  });

  // Create wake manager (uses AgentManager interface — unchanged)
  const wakeManager = createWakeManager(
    {
      agentManager: deps.agentManager,
      systemEventQueue: queue,
    },
    config.wake
  );

  // Create the V2 router with pluggable strategy support
  const router = createTriggerRouterV2(deps, queue, wakeManager);

  // Create cron service (unchanged — uses router + wake)
  const cronService = createCronService(
    {
      triggerRouter: router,
      wakeManager,
    },
    config.cron
  );

  // Create webhook handler (unchanged — uses router + wake)
  const webhookHandler = createWebhookHandler(
    {
      triggerRouter: router,
      wakeManager,
    },
    config.webhook
  );

  // The key V2 integration: connect inbox delivery events to wake decisions
  const deliveryHandler = (event: InboxDeliveryEvent) => {
    const { agentId, message } = event;
    const hasSession = deps.agentManager.hasActiveSession(agentId);
    const action = mapImportanceToWakeAction(message.importance, hasSession);

    // Format message content for delivery
    const content = formatMessageForDelivery(message);

    switch (action) {
      case "interrupt":
      case "inject":
      case "wake":
        // Enqueue for immediate wake delivery
        queue.enqueue(content, {
          agentId,
          priority: message.importance === "urgent" ? "high" : "normal",
          sourceKey: `inbox:${message.id}`,
        });
        // Request immediate wake
        wakeManager.requestWakeNow({ reason: "inbox-delivery", agentId });
        break;
      case "queue":
        // Just enqueue — will be picked up on next heartbeat or prompt
        queue.enqueue(content, {
          agentId,
          priority: "normal",
          sourceKey: `inbox:${message.id}`,
        });
        break;
    }
  };

  return {
    queue,
    router,
    wakeManager,
    cronService,
    webhookHandler,

    async start(): Promise<void> {
      if (running) return;

      // Connect inbox delivery events
      deps.inboxAdapter.onDelivery(deliveryHandler);

      // Start components
      wakeManager.start();
      await cronService.start();

      running = true;
    },

    async stop(): Promise<void> {
      if (!running) return;

      // Disconnect inbox delivery events
      deps.inboxAdapter.offDelivery(deliveryHandler);

      // Stop components in reverse
      await cronService.stop();
      wakeManager.stop();

      running = false;
    },

    isRunning(): boolean {
      return running;
    },
  };
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Format an inbox message for agent delivery (as text content).
 */
function formatMessageForDelivery(message: {
  sender_id: string;
  content: any;
  subject?: string;
  importance?: string;
}): string {
  const parts: string[] = [];

  if (message.subject) {
    parts.push(`**${message.subject}**`);
  }

  parts.push(`From: ${message.sender_id}`);

  if (message.importance && message.importance !== "normal") {
    parts.push(`Priority: ${message.importance}`);
  }

  const content = message.content;
  if (typeof content === "string") {
    parts.push(content);
  } else if (content?.type === "text") {
    parts.push(content.text);
  } else if (content?.type === "event") {
    parts.push(`Event: ${content.event}`);
    if (content.data) {
      parts.push(`Data: ${JSON.stringify(content.data)}`);
    }
  } else if (content) {
    parts.push(JSON.stringify(content));
  }

  return parts.join("\n");
}

/**
 * Create a V2 trigger router with pluggable strategy support.
 *
 * Built-in strategies:
 * - "direct": Route to a specific agent by ID
 * - "role": Route to all agents with a given role
 * - "head": Route to root agents (default)
 *
 * Custom strategies can be registered via registerStrategy().
 */
function createTriggerRouterV2(
  deps: TriggerSystemV2Deps,
  queue: SystemEventQueue,
  wakeManager: TriggerWakeManager
): TriggerRouterV2 {
  const strategies = new Map<string, RoutingStrategy>();
  let defaultStrategyName = "head";

  const context: RoutingContext = {
    agentStore: deps.agentStore,
    agentManager: deps.agentManager,
    inboxAdapter: deps.inboxAdapter,
    systemEventQueue: queue,
  };

  // ── Built-in strategies ──────────────────────────────────────

  const directStrategy: RoutingStrategy = {
    name: "direct",
    description: "Route to a specific agent by ID",
    canHandle(event) {
      return event.routing?.target?.type === "agent";
    },
    async route(event) {
      const target = event.routing?.target;
      if (target?.type === "agent" && target.agentId) {
        return { targetAgents: [target.agentId], reason: "direct agent target" };
      }
      return { targetAgents: [], reason: "no agent ID in target" };
    },
  };

  const roleStrategy: RoutingStrategy = {
    name: "role",
    description: "Route to all agents with a given role",
    canHandle(event) {
      return event.routing?.target?.type === "role";
    },
    async route(event) {
      const target = event.routing?.target;
      if (target?.type === "role" && target.role) {
        const agents = deps.agentStore.listAgents({
          role: target.role,
          state: "running",
        });
        return {
          targetAgents: agents.map((a) => a.id),
          reason: `role '${target.role}' matched ${agents.length} agent(s)`,
        };
      }
      return { targetAgents: [], reason: "no role in target" };
    },
  };

  const headStrategy: RoutingStrategy = {
    name: "head",
    description: "Route to all running root agents (default)",
    async route() {
      const roots = deps.agentStore.listAgents({
        parent_id: null,
        state: "running",
      });
      return {
        targetAgents: roots.map((a) => a.id),
        reason: `${roots.length} root agent(s)`,
      };
    },
  };

  // Register built-in strategies
  strategies.set("direct", directStrategy);
  strategies.set("role", roleStrategy);
  strategies.set("head", headStrategy);

  // ── Route implementation ─────────────────────────────────────

  async function route(event: TriggerEvent): Promise<TriggerDeliveryResult> {
    let decision: RoutingDecision;

    // 1. Check if event specifies a strategy by name
    const preferredName = event.routing?.strategyName;
    if (preferredName && strategies.has(preferredName)) {
      decision = await strategies.get(preferredName)!.route(event, context);
    } else {
      // 2. Find first strategy that canHandle the event
      let matched = false;
      decision = { targetAgents: [] };

      for (const strategy of strategies.values()) {
        if (strategy.canHandle?.(event)) {
          decision = await strategy.route(event, context);
          matched = true;
          break;
        }
      }

      // 3. Fall back to default strategy
      if (!matched) {
        const defaultStrategy = strategies.get(defaultStrategyName);
        if (defaultStrategy) {
          decision = await defaultStrategy.route(event, context);
        }
      }
    }

    // Handle deferred decisions
    if (decision.defer) {
      return {
        success: false,
        deliveredTo: [],
        method: "queued",
        error: decision.deferReason ?? "Routing deferred",
      };
    }

    // Format payload for delivery
    const payload = event.payload as Record<string, unknown>;
    const content =
      decision.additionalContext ??
      (payload?.kind === "text" && typeof (payload as any).content === "string"
        ? (payload as any).content
        : payload?.kind === "json"
          ? JSON.stringify((payload as any).data ?? {})
          : JSON.stringify(payload ?? {}));

    // Enqueue for each target
    for (const agentId of decision.targetAgents) {
      queue.enqueue(content, {
        agentId,
        priority: event.priority ?? "normal",
        sourceKey: `trigger:${event.id}`,
      });
    }

    // Wake targets based on mode
    const wakeMode = decision.wakeModeOverride ?? event.wakeMode;
    if (wakeMode === "now") {
      for (const agentId of decision.targetAgents) {
        wakeManager.requestWakeNow({ reason: "router-delivery", agentId });
      }
    }

    return {
      success: decision.targetAgents.length > 0,
      deliveredTo: decision.targetAgents,
      method: decision.targetAgents.length > 1 ? "broadcast" : "queued",
    };
  }

  return {
    route,

    registerStrategy(strategy: RoutingStrategy) {
      strategies.set(strategy.name, strategy);
      strategy.initialize?.(context);
    },

    unregisterStrategy(name: string) {
      const strategy = strategies.get(name);
      strategy?.cleanup?.();
      strategies.delete(name);
    },

    getStrategy(name: string) {
      return strategies.get(name);
    },

    listStrategies() {
      return [...strategies.keys()];
    },

    setDefaultStrategy(name: string) {
      defaultStrategyName = name;
    },

    getDefaultStrategy() {
      return defaultStrategyName;
    },
  };
}
