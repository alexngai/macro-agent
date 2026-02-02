/**
 * Trigger System Factory
 *
 * Factory function that creates and wires together all
 * trigger system components.
 *
 * @module trigger/trigger-system
 */

import type { EventStore } from "../store/event-store.js";
import type { AgentManager } from "../agent/agent-manager.js";
import type { MessageRouter } from "../router/message-router.js";

import { createSystemEventQueue, type SystemEventQueue } from "./queue/index.js";
import {
  createTriggerRouter,
  createAIRouterStrategy,
  type TriggerRouter,
  type TriggerRouterConfig,
} from "./router/index.js";
import {
  createWakeManager,
  type TriggerWakeManager,
  type WakeManagerConfig,
} from "./wake/index.js";
import {
  createCronService,
  type CronService,
  type CronServiceConfig,
  type CronEvent,
} from "./sources/cron/index.js";
import {
  createWebhookHandler,
  type WebhookHandler,
  type WebhookHandlerConfig,
  type WebhookEvent,
} from "./sources/webhook/index.js";

// =============================================================================
// Trigger System Configuration
// =============================================================================

/**
 * Trigger system configuration
 */
export interface TriggerSystemConfig {
  /** System event queue configuration */
  queue?: {
    maxEventsPerAgent?: number;
  };
  /** Trigger router configuration */
  router?: TriggerRouterConfig;
  /** Wake manager configuration */
  wake?: WakeManagerConfig;
  /** Cron service configuration */
  cron?: CronServiceConfig;
  /** Webhook handler configuration */
  webhook?: WebhookHandlerConfig;
  /** Enable AI routing strategy */
  enableAIRouter?: boolean;
}

/**
 * Dependencies for the trigger system
 */
export interface TriggerSystemDeps {
  eventStore: EventStore;
  agentManager: AgentManager;
  messageRouter: MessageRouter;
}

// =============================================================================
// Trigger System Interface
// =============================================================================

/**
 * Trigger system interface
 *
 * Provides access to all trigger system components.
 */
export interface TriggerSystem {
  /** System event queue */
  readonly queue: SystemEventQueue;
  /** Trigger router */
  readonly router: TriggerRouter;
  /** Wake manager */
  readonly wakeManager: TriggerWakeManager;
  /** Cron service */
  readonly cronService: CronService;
  /** Webhook handler */
  readonly webhookHandler: WebhookHandler;

  /**
   * Start the trigger system
   */
  start(): Promise<void>;

  /**
   * Stop the trigger system
   */
  stop(): Promise<void>;

  /**
   * Check if system is running
   */
  isRunning(): boolean;
}

// =============================================================================
// Trigger System Factory
// =============================================================================

/**
 * Create a trigger system with all components wired together
 */
export function createTriggerSystem(
  deps: TriggerSystemDeps,
  config: TriggerSystemConfig = {}
): TriggerSystem {
  let running = false;

  // Create system event queue
  const queue = createSystemEventQueue({
    maxEventsPerAgent: config.queue?.maxEventsPerAgent,
  });

  // Create trigger router
  const router = createTriggerRouter(
    {
      eventStore: deps.eventStore,
      agentManager: deps.agentManager,
      messageRouter: deps.messageRouter,
      systemEventQueue: queue,
    },
    config.router
  );

  // Create wake manager
  const wakeManager = createWakeManager(
    {
      agentManager: deps.agentManager,
      systemEventQueue: queue,
    },
    config.wake
  );

  // Create cron service
  const cronService = createCronService(
    {
      triggerRouter: router,
      wakeManager,
    },
    config.cron
  );

  // Create webhook handler
  const webhookHandler = createWebhookHandler(
    {
      triggerRouter: router,
      wakeManager,
    },
    config.webhook
  );

  // Register AI router strategy if enabled
  if (config.enableAIRouter) {
    const aiRouterStrategy = createAIRouterStrategy({
      enableLogging: true,
    });
    router.registerStrategy(aiRouterStrategy);
  }

  return {
    queue,
    router,
    wakeManager,
    cronService,
    webhookHandler,

    async start(): Promise<void> {
      if (running) return;

      // Start components in order
      await router.start();
      wakeManager.start();
      await cronService.start();

      running = true;
    },

    async stop(): Promise<void> {
      if (!running) return;

      // Stop components in reverse order
      await cronService.stop();
      wakeManager.stop();
      await router.stop();

      running = false;
    },

    isRunning(): boolean {
      return running;
    },
  };
}
