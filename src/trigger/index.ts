/**
 * Trigger System
 *
 * External and internal event triggers for agent activation.
 *
 * The trigger system provides:
 * - System event queue for per-agent ephemeral events
 * - Trigger router with pluggable routing strategies
 * - Wake manager for delivering events to agents
 * - Cron service for time-based triggers
 * - Webhook handler for HTTP triggers
 *
 * @module trigger
 */

// Main trigger system V2 factory
export {
  createTriggerSystemV2,
  type TriggerSystemV2,
  type TriggerSystemV2Config,
  type TriggerSystemV2Deps,
  type TriggerRouterV2,
  type RoutingStrategy,
  type RoutingContext,
  type RoutingDecision,
} from "./trigger-system-v2.js";

// Core types
export {
  createTriggerEvent,
  formatTriggerPayload,
  formatTriggerSource,
  type TriggerEvent,
  type TriggerSource,
  type TriggerPayload,
  type TriggerWakeMode,
  type TriggerTarget,
  type TriggerRoutingHint,
  type TriggerPriority,
  type TriggerDeliveryResult,
  type TriggerDeliveryMethod,
  type CreateTriggerOptions,
} from "./types.js";

// Queue
export {
  createSystemEventQueue,
  formatQueuedEventsAsSystemMessage,
  formatQueuedTextsAsBlock,
  type SystemEventQueue,
  type QueuedSystemEvent,
  type EnqueueOptions,
  type DrainOptions,
} from "./queue/index.js";

// Wake
export {
  createWakeManager,
  type TriggerWakeManager,
  type WakeManagerConfig,
  type WakeManagerDeps,
  type WakeRequest,
  type WakeResult,
  type WakeCycleResult,
  type AgentDrainResult,
} from "./wake/index.js";

// Cron
export {
  createCronService,
  computeNextRunTime,
  computeJobNextRunTime,
  findNextJob,
  findDueJobs,
  validateSchedule,
  formatSchedule,
  type CronService,
  type CronServiceConfig,
  type CronServiceDeps,
  type CronJob,
  type CronJobCreate,
  type CronJobPatch,
  type CronJobFilter,
  type CronSchedule,
  type CronJobPayload,
  type CronJobState,
  type CronSessionTarget,
  type CronEvent,
} from "./sources/cron/index.js";

// Strategies
export {
  createAIRouterStrategy,
  type AIRouterConfig,
} from "./strategies/ai-router.js";

// Webhook
export {
  createWebhookHandler,
  type WebhookHandler,
  type WebhookHandlerConfig,
  type WebhookHandlerDeps,
  type WebhookEndpoint,
  type WebhookEndpointCreate,
  type WebhookEndpointPatch,
  type WebhookRequest,
  type WebhookHandleResult,
  type WebhookMethod,
  type WebhookEvent,
} from "./sources/webhook/index.js";
