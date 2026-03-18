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
import type { TriggerRouter } from "./types.js";

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
  readonly wakeManager: TriggerWakeManager;
  readonly cronService: CronService;
  readonly webhookHandler: WebhookHandler;

  start(): Promise<void>;
  stop(): Promise<void>;
  isRunning(): boolean;
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

  // Create a minimal router adapter for cron/webhook sources.
  // These sources need a TriggerRouter to submit events.
  // In V2, we create a thin adapter that queues events for wake delivery
  // instead of routing through EventStore.
  const routerAdapter = createRouterAdapter(deps, queue, wakeManager) as unknown as TriggerRouter;

  // Create cron service (unchanged — uses router + wake)
  const cronService = createCronService(
    {
      triggerRouter: routerAdapter,
      wakeManager,
    },
    config.cron
  );

  // Create webhook handler (unchanged — uses router + wake)
  const webhookHandler = createWebhookHandler(
    {
      triggerRouter: routerAdapter,
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
 * Create a thin router adapter for cron/webhook sources.
 * Maps TriggerRouter interface to V2 queue + wake model.
 */
function createRouterAdapter(
  deps: TriggerSystemV2Deps,
  queue: SystemEventQueue,
  wakeManager: TriggerWakeManager
) {
  // Import the TriggerRouter interface type for compatibility
  return {
    async route(event: any) {
      // Determine target agent(s) from event routing config
      const target = event.routing?.target;
      let targetAgentIds: string[] = [];

      if (target?.type === "agent" && target.agentId) {
        targetAgentIds = [target.agentId];
      } else if (target?.type === "role" && target.role) {
        // Find agents with matching role
        const agents = deps.agentStore.listAgents({
          role: target.role,
          state: "running",
        });
        targetAgentIds = agents.map((a) => a.id);
      } else {
        // Default: route to all running root agents
        const roots = deps.agentStore.listAgents({
          parent_id: null,
          state: "running",
        });
        targetAgentIds = roots.map((a) => a.id);
      }

      // Enqueue for each target
      const content =
        typeof event.payload?.data === "string"
          ? event.payload.data
          : JSON.stringify(event.payload ?? {});

      for (const agentId of targetAgentIds) {
        queue.enqueue(content, {
          agentId,
          priority: event.priority ?? "normal",
          sourceKey: event.sourceKey,
        });
      }

      // Wake targets based on mode
      if (event.wakeMode === "now") {
        for (const agentId of targetAgentIds) {
          wakeManager.requestWakeNow({ reason: "router-delivery", agentId });
        }
      }

      return {
        delivered: targetAgentIds.length > 0,
        targetAgents: targetAgentIds,
        strategy: "v2-adapter",
      };
    },

    registerStrategy() {},
    unregisterStrategy() {},
    getStrategy() { return undefined; },
    listStrategies() { return []; },
    setDefaultStrategy() {},
    getDefaultStrategy() { return "v2-adapter"; },
    async start() {},
    async stop() {},
  };
}
