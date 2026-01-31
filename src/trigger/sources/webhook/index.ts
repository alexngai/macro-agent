/**
 * Webhook Handler
 *
 * HTTP webhook trigger source for external integrations.
 *
 * @module trigger/sources/webhook
 */

export {
  createWebhookHandler,
  type WebhookHandlerDeps,
} from "./webhook-handler.js";

export type {
  WebhookHandler,
  WebhookHandlerConfig,
  WebhookEndpoint,
  WebhookEndpointCreate,
  WebhookEndpointPatch,
  WebhookRequest,
  WebhookHandleResult,
  WebhookValidationResult,
  WebhookMethod,
  WebhookEvent,
} from "./types.js";
