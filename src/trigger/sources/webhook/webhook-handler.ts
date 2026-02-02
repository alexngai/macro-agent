/**
 * Webhook Handler Implementation
 *
 * Handles incoming webhook requests and converts them to triggers.
 *
 * @module trigger/sources/webhook/webhook-handler
 */

import crypto from "crypto";
import type { TriggerRouter } from "../../router/types.js";
import type { TriggerWakeManager } from "../../wake/types.js";
import { createTriggerEvent, type TriggerPayload } from "../../types.js";
import type {
  WebhookHandler,
  WebhookHandlerConfig,
  WebhookEndpoint,
  WebhookEndpointCreate,
  WebhookEndpointPatch,
  WebhookRequest,
  WebhookHandleResult,
  WebhookEvent,
} from "./types.js";

// =============================================================================
// Webhook Handler Dependencies
// =============================================================================

/**
 * Dependencies for the webhook handler
 */
export interface WebhookHandlerDeps {
  /** Trigger router for delivery */
  triggerRouter: TriggerRouter;
  /** Wake manager for immediate wakes */
  wakeManager: TriggerWakeManager;
}

// =============================================================================
// In-Memory Endpoint Store
// =============================================================================

class EndpointStore {
  private endpoints: Map<string, WebhookEndpoint> = new Map();

  async list(): Promise<WebhookEndpoint[]> {
    return Array.from(this.endpoints.values());
  }

  async get(id: string): Promise<WebhookEndpoint | null> {
    return this.endpoints.get(id) ?? null;
  }

  async getByPath(path: string): Promise<WebhookEndpoint | null> {
    for (const endpoint of this.endpoints.values()) {
      if (endpoint.path === path) {
        return endpoint;
      }
    }
    return null;
  }

  async save(endpoint: WebhookEndpoint): Promise<void> {
    this.endpoints.set(endpoint.id, endpoint);
  }

  async delete(id: string): Promise<void> {
    this.endpoints.delete(id);
  }
}

// =============================================================================
// Signature Validation
// =============================================================================

/**
 * Compute HMAC-SHA256 signature
 */
function computeSignature(secret: string, body: string): string {
  const hmac = crypto.createHmac("sha256", secret);
  hmac.update(body, "utf8");
  return `sha256=${hmac.digest("hex")}`;
}

/**
 * Constant-time string comparison
 */
function secureCompare(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }

  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);

  return crypto.timingSafeEqual(bufA, bufB);
}

// =============================================================================
// Webhook Handler Implementation
// =============================================================================

/**
 * Create a webhook handler
 */
export function createWebhookHandler(
  deps: WebhookHandlerDeps,
  config: WebhookHandlerConfig = {}
): WebhookHandler {
  const { defaultSecret, onEvent } = config;

  const store = new EndpointStore();

  /**
   * Emit a webhook event
   */
  function emit(event: WebhookEvent): void {
    try {
      onEvent?.(event);
    } catch {
      // Ignore event handler errors
    }
  }

  /**
   * Generate a unique endpoint ID
   */
  function generateId(): string {
    return `webhook_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  }

  /**
   * Format webhook body as trigger payload
   */
  function formatPayload(request: WebhookRequest): TriggerPayload {
    const body = request.body;

    // Handle JSON body
    if (body && typeof body === "object") {
      return {
        kind: "json",
        data: body as Record<string, unknown>,
      };
    }

    // Handle string body
    if (typeof body === "string") {
      // Try to parse as JSON
      try {
        const parsed = JSON.parse(body);
        if (typeof parsed === "object" && parsed !== null) {
          return { kind: "json", data: parsed };
        }
      } catch {
        // Not JSON
      }

      return { kind: "text", content: body };
    }

    // Empty body
    return {
      kind: "json",
      data: {
        method: request.method,
        path: request.path,
        query: request.query,
        timestamp: request.timestamp,
      },
    };
  }

  return {
    async listEndpoints(): Promise<WebhookEndpoint[]> {
      return store.list();
    },

    async getEndpoint(id: string): Promise<WebhookEndpoint | null> {
      return store.get(id);
    },

    async registerEndpoint(input: WebhookEndpointCreate): Promise<WebhookEndpoint> {
      const now = Date.now();

      const endpoint: WebhookEndpoint = {
        id: generateId(),
        name: input.name,
        description: input.description,
        methods: input.methods,
        path: input.path,
        enabled: input.enabled,
        secret: input.secret,
        wakeMode: input.wakeMode,
        routing: input.routing,
        createdAtMs: now,
        updatedAtMs: now,
        metadata: input.metadata,
      };

      await store.save(endpoint);
      return endpoint;
    },

    async updateEndpoint(
      id: string,
      patch: WebhookEndpointPatch
    ): Promise<WebhookEndpoint> {
      const endpoint = await store.get(id);
      if (!endpoint) {
        throw new Error(`Endpoint not found: ${id}`);
      }

      const now = Date.now();

      // Apply patch
      if (patch.name !== undefined) endpoint.name = patch.name;
      if (patch.description !== undefined) endpoint.description = patch.description;
      if (patch.methods !== undefined) endpoint.methods = patch.methods;
      if (patch.path !== undefined) endpoint.path = patch.path;
      if (patch.enabled !== undefined) endpoint.enabled = patch.enabled;
      if (patch.secret !== undefined) endpoint.secret = patch.secret;
      if (patch.wakeMode !== undefined) endpoint.wakeMode = patch.wakeMode;
      if (patch.routing !== undefined) endpoint.routing = patch.routing;
      if (patch.metadata !== undefined) endpoint.metadata = patch.metadata;

      endpoint.updatedAtMs = now;

      await store.save(endpoint);
      return endpoint;
    },

    async removeEndpoint(id: string): Promise<void> {
      const endpoint = await store.get(id);
      if (!endpoint) {
        throw new Error(`Endpoint not found: ${id}`);
      }

      await store.delete(id);
    },

    async handleRequest(request: WebhookRequest): Promise<WebhookHandleResult> {
      const startTime = Date.now();

      emit({
        action: "received",
        endpointId: request.endpointId,
        method: request.method,
        path: request.path,
        timestamp: request.timestamp,
      });

      try {
        // Find endpoint
        const endpoint = await store.get(request.endpointId);

        if (!endpoint) {
          return {
            success: false,
            error: "Endpoint not found",
            statusCode: 404,
            responseBody: { error: "Endpoint not found" },
          };
        }

        // Check if enabled
        if (!endpoint.enabled) {
          return {
            success: false,
            error: "Endpoint is disabled",
            statusCode: 503,
            responseBody: { error: "Endpoint is disabled" },
          };
        }

        // Check method
        if (!endpoint.methods.includes(request.method)) {
          return {
            success: false,
            error: "Method not allowed",
            statusCode: 405,
            responseBody: { error: "Method not allowed" },
          };
        }

        // Create trigger event
        const trigger = createTriggerEvent({
          source: {
            type: "webhook",
            endpointId: endpoint.id,
            method: request.method,
            path: request.path,
          },
          payload: formatPayload(request),
          wakeMode: endpoint.wakeMode,
          routing: endpoint.routing ?? { target: { type: "head" } },
          metadata: {
            clientIp: request.clientIp,
            query: request.query,
            headers: filterHeaders(request.headers),
          },
        });

        // Route the trigger
        const result = await deps.triggerRouter.route(trigger);

        // Request wake if immediate mode
        if (endpoint.wakeMode === "now") {
          deps.wakeManager.requestWakeNow({
            reason: `webhook:${endpoint.id}`,
            source: "webhook",
          });
        }

        const durationMs = Date.now() - startTime;

        emit({
          action: "processed",
          endpointId: endpoint.id,
          success: result.success,
          durationMs,
        });

        if (result.success) {
          return {
            success: true,
            triggerId: trigger.id,
            statusCode: 200,
            responseBody: {
              success: true,
              triggerId: trigger.id,
              deliveredTo: result.deliveredTo,
            },
          };
        } else {
          return {
            success: false,
            error: result.error,
            statusCode: 500,
            responseBody: {
              success: false,
              error: result.error,
            },
          };
        }
      } catch (error) {
        const durationMs = Date.now() - startTime;

        emit({
          action: "processed",
          endpointId: request.endpointId,
          success: false,
          error: error instanceof Error ? error.message : String(error),
          durationMs,
        });

        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
          statusCode: 500,
          responseBody: { error: "Internal error" },
        };
      }
    },

    async validateSignature(
      endpointId: string,
      signature: string,
      body: string
    ): Promise<boolean> {
      const endpoint = await store.get(endpointId);

      // Use endpoint secret or default
      const secret = endpoint?.secret ?? defaultSecret;

      if (!secret) {
        // No secret configured - signature validation disabled
        return true;
      }

      const expected = computeSignature(secret, body);

      return secureCompare(signature, expected);
    },
  };
}

/**
 * Filter sensitive headers
 */
function filterHeaders(
  headers: Record<string, string | string[] | undefined>
): Record<string, string | string[]> {
  const filtered: Record<string, string | string[]> = {};
  const sensitivePatterns = [
    /^authorization$/i,
    /^cookie$/i,
    /^x-api-key$/i,
    /^x-auth/i,
  ];

  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;

    const isSensitive = sensitivePatterns.some((p) => p.test(key));
    if (!isSensitive) {
      filtered[key] = value;
    }
  }

  return filtered;
}
