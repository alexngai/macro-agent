/**
 * Webhook Types
 *
 * Types for the webhook trigger source that handles
 * incoming HTTP requests.
 *
 * @module trigger/sources/webhook/types
 */

import type { TriggerWakeMode, TriggerRoutingHint } from "../../types.js";

// =============================================================================
// Webhook Endpoint Types
// =============================================================================

/**
 * HTTP methods supported for webhooks
 */
export type WebhookMethod = "POST" | "PUT" | "PATCH" | "GET" | "DELETE";

/**
 * Webhook endpoint configuration
 */
export interface WebhookEndpoint {
  /** Unique endpoint ID */
  id: string;
  /** Human-readable name */
  name: string;
  /** Optional description */
  description?: string;
  /** Allowed HTTP methods */
  methods: WebhookMethod[];
  /** Path pattern (e.g., "/hooks/github") */
  path: string;
  /** Whether endpoint is enabled */
  enabled: boolean;
  /** Secret for signature validation */
  secret?: string;
  /** Wake mode for triggers */
  wakeMode: TriggerWakeMode;
  /** Default routing hints */
  routing?: TriggerRoutingHint;
  /** Creation timestamp */
  createdAtMs: number;
  /** Last update timestamp */
  updatedAtMs: number;
  /** Optional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Input for creating a webhook endpoint
 */
export type WebhookEndpointCreate = Omit<
  WebhookEndpoint,
  "id" | "createdAtMs" | "updatedAtMs"
>;

/**
 * Input for updating a webhook endpoint
 */
export type WebhookEndpointPatch = Partial<
  Omit<WebhookEndpoint, "id" | "createdAtMs">
>;

// =============================================================================
// Webhook Request Types
// =============================================================================

/**
 * Parsed webhook request
 */
export interface WebhookRequest {
  /** Endpoint that matched */
  endpointId: string;
  /** HTTP method */
  method: WebhookMethod;
  /** Request path */
  path: string;
  /** Query parameters */
  query: Record<string, string | string[]>;
  /** Request headers */
  headers: Record<string, string | string[] | undefined>;
  /** Request body (parsed JSON or raw string) */
  body: unknown;
  /** Raw body for signature validation */
  rawBody?: string;
  /** Timestamp of request */
  timestamp: number;
  /** Client IP address */
  clientIp?: string;
}

/**
 * Webhook validation result
 */
export interface WebhookValidationResult {
  valid: boolean;
  error?: string;
  code?: "INVALID_SIGNATURE" | "METHOD_NOT_ALLOWED" | "ENDPOINT_DISABLED" | "ENDPOINT_NOT_FOUND";
}

// =============================================================================
// Webhook Event Types
// =============================================================================

/**
 * Event when webhook is received
 */
export interface WebhookReceivedEvent {
  action: "received";
  endpointId: string;
  method: WebhookMethod;
  path: string;
  timestamp: number;
}

/**
 * Event when webhook is processed
 */
export interface WebhookProcessedEvent {
  action: "processed";
  endpointId: string;
  success: boolean;
  error?: string;
  durationMs: number;
}

/**
 * Union of webhook events
 */
export type WebhookEvent = WebhookReceivedEvent | WebhookProcessedEvent;

// =============================================================================
// Webhook Handler Interface
// =============================================================================

/**
 * Webhook handler configuration
 */
export interface WebhookHandlerConfig {
  /** Default secret for signature validation */
  defaultSecret?: string;
  /** Event callback */
  onEvent?: (event: WebhookEvent) => void;
}

/**
 * Webhook handler interface
 */
export interface WebhookHandler {
  /**
   * List all registered endpoints
   */
  listEndpoints(): Promise<WebhookEndpoint[]>;

  /**
   * Get an endpoint by ID
   */
  getEndpoint(id: string): Promise<WebhookEndpoint | null>;

  /**
   * Register a new endpoint
   */
  registerEndpoint(input: WebhookEndpointCreate): Promise<WebhookEndpoint>;

  /**
   * Update an endpoint
   */
  updateEndpoint(id: string, patch: WebhookEndpointPatch): Promise<WebhookEndpoint>;

  /**
   * Remove an endpoint
   */
  removeEndpoint(id: string): Promise<void>;

  /**
   * Handle an incoming webhook request
   */
  handleRequest(request: WebhookRequest): Promise<WebhookHandleResult>;

  /**
   * Validate a webhook signature
   */
  validateSignature(
    endpointId: string,
    signature: string,
    body: string
  ): Promise<boolean>;
}

/**
 * Result of handling a webhook request
 */
export interface WebhookHandleResult {
  success: boolean;
  /** Trigger ID if created */
  triggerId?: string;
  /** Error message if failed */
  error?: string;
  /** HTTP status code to return */
  statusCode: number;
  /** Response body */
  responseBody?: unknown;
}
