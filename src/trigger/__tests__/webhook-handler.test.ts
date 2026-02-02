/**
 * Webhook Handler Tests
 *
 * Tests for the webhook endpoint handling.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createWebhookHandler } from "../sources/webhook/webhook-handler.js";
import type { WebhookEndpointCreate, WebhookRequest, WebhookEvent } from "../sources/webhook/types.js";

describe("WebhookHandler", () => {
  let mockDeps: ReturnType<typeof createMockDeps>;
  let webhookHandler: ReturnType<typeof createWebhookHandler>;
  let capturedEvents: WebhookEvent[];

  beforeEach(() => {
    mockDeps = createMockDeps();
    capturedEvents = [];

    webhookHandler = createWebhookHandler(mockDeps, {
      onEvent: (event) => capturedEvents.push(event),
    });
  });

  describe("endpoint management", () => {
    it("should register an endpoint", async () => {
      const input: WebhookEndpointCreate = {
        name: "Test Endpoint",
        methods: ["POST"],
        path: "/webhooks/test",
        enabled: true,
        wakeMode: "now",
      };

      const endpoint = await webhookHandler.registerEndpoint(input);

      expect(endpoint.id).toBeDefined();
      expect(endpoint.name).toBe("Test Endpoint");
      expect(endpoint.methods).toEqual(["POST"]);
      expect(endpoint.path).toBe("/webhooks/test");
      expect(endpoint.enabled).toBe(true);
    });

    it("should list endpoints", async () => {
      await webhookHandler.registerEndpoint({
        name: "Endpoint 1",
        methods: ["GET"],
        path: "/webhooks/1",
        enabled: true,
        wakeMode: "now",
      });

      await webhookHandler.registerEndpoint({
        name: "Endpoint 2",
        methods: ["POST"],
        path: "/webhooks/2",
        enabled: true,
        wakeMode: "now",
      });

      const endpoints = await webhookHandler.listEndpoints();

      expect(endpoints).toHaveLength(2);
      expect(endpoints.map((e) => e.name)).toContain("Endpoint 1");
      expect(endpoints.map((e) => e.name)).toContain("Endpoint 2");
    });

    it("should get an endpoint by ID", async () => {
      const endpoint = await webhookHandler.registerEndpoint({
        name: "Test Endpoint",
        methods: ["POST"],
        path: "/webhooks/test",
        enabled: true,
        wakeMode: "now",
      });

      const fetched = await webhookHandler.getEndpoint(endpoint.id);
      expect(fetched).toEqual(endpoint);
    });

    it("should return null for non-existent endpoint", async () => {
      const fetched = await webhookHandler.getEndpoint("nonexistent");
      expect(fetched).toBeNull();
    });

    it("should update an endpoint", async () => {
      const endpoint = await webhookHandler.registerEndpoint({
        name: "Test Endpoint",
        methods: ["POST"],
        path: "/webhooks/test",
        enabled: true,
        wakeMode: "now",
      });

      const updated = await webhookHandler.updateEndpoint(endpoint.id, {
        name: "Updated Endpoint",
        methods: ["POST", "PUT"],
        enabled: false,
      });

      expect(updated.name).toBe("Updated Endpoint");
      expect(updated.methods).toEqual(["POST", "PUT"]);
      expect(updated.enabled).toBe(false);
    });

    it("should throw when updating non-existent endpoint", async () => {
      await expect(
        webhookHandler.updateEndpoint("nonexistent", { name: "New Name" })
      ).rejects.toThrow("Endpoint not found");
    });

    it("should remove an endpoint", async () => {
      const endpoint = await webhookHandler.registerEndpoint({
        name: "Test Endpoint",
        methods: ["POST"],
        path: "/webhooks/test",
        enabled: true,
        wakeMode: "now",
      });

      await webhookHandler.removeEndpoint(endpoint.id);

      const fetched = await webhookHandler.getEndpoint(endpoint.id);
      expect(fetched).toBeNull();
    });

    it("should throw when removing non-existent endpoint", async () => {
      await expect(webhookHandler.removeEndpoint("nonexistent")).rejects.toThrow(
        "Endpoint not found"
      );
    });
  });

  describe("request handling", () => {
    it("should handle valid request", async () => {
      mockDeps.triggerRouter.route = vi.fn().mockResolvedValue({
        success: true,
        deliveredTo: ["agent_1"],
      });

      const endpoint = await webhookHandler.registerEndpoint({
        name: "Test Endpoint",
        methods: ["POST"],
        path: "/webhooks/test",
        enabled: true,
        wakeMode: "now",
      });

      const request: WebhookRequest = {
        endpointId: endpoint.id,
        method: "POST",
        path: "/webhooks/test",
        headers: { "content-type": "application/json" },
        body: { message: "Hello" },
        timestamp: Date.now(),
      };

      const result = await webhookHandler.handleRequest(request);

      expect(result.success).toBe(true);
      expect(result.statusCode).toBe(200);
      expect(result.triggerId).toBeDefined();
      expect(mockDeps.triggerRouter.route).toHaveBeenCalled();
    });

    it("should return 404 for non-existent endpoint", async () => {
      const request: WebhookRequest = {
        endpointId: "nonexistent",
        method: "POST",
        path: "/webhooks/test",
        headers: {},
        timestamp: Date.now(),
      };

      const result = await webhookHandler.handleRequest(request);

      expect(result.success).toBe(false);
      expect(result.statusCode).toBe(404);
      expect(result.error).toContain("not found");
    });

    it("should return 503 for disabled endpoint", async () => {
      const endpoint = await webhookHandler.registerEndpoint({
        name: "Disabled Endpoint",
        methods: ["POST"],
        path: "/webhooks/disabled",
        enabled: false,
        wakeMode: "now",
      });

      const request: WebhookRequest = {
        endpointId: endpoint.id,
        method: "POST",
        path: "/webhooks/disabled",
        headers: {},
        timestamp: Date.now(),
      };

      const result = await webhookHandler.handleRequest(request);

      expect(result.success).toBe(false);
      expect(result.statusCode).toBe(503);
      expect(result.error).toContain("disabled");
    });

    it("should return 405 for disallowed method", async () => {
      const endpoint = await webhookHandler.registerEndpoint({
        name: "POST Only",
        methods: ["POST"],
        path: "/webhooks/post-only",
        enabled: true,
        wakeMode: "now",
      });

      const request: WebhookRequest = {
        endpointId: endpoint.id,
        method: "GET",
        path: "/webhooks/post-only",
        headers: {},
        timestamp: Date.now(),
      };

      const result = await webhookHandler.handleRequest(request);

      expect(result.success).toBe(false);
      expect(result.statusCode).toBe(405);
      expect(result.error).toContain("Method not allowed");
    });

    it("should request wake for immediate mode endpoints", async () => {
      mockDeps.triggerRouter.route = vi.fn().mockResolvedValue({
        success: true,
        deliveredTo: ["agent_1"],
      });

      const endpoint = await webhookHandler.registerEndpoint({
        name: "Immediate Endpoint",
        methods: ["POST"],
        path: "/webhooks/immediate",
        enabled: true,
        wakeMode: "now",
      });

      const request: WebhookRequest = {
        endpointId: endpoint.id,
        method: "POST",
        path: "/webhooks/immediate",
        headers: {},
        body: { test: true },
        timestamp: Date.now(),
      };

      await webhookHandler.handleRequest(request);

      expect(mockDeps.wakeManager.requestWakeNow).toHaveBeenCalled();
    });

    it("should not request wake for next-prompt mode", async () => {
      mockDeps.triggerRouter.route = vi.fn().mockResolvedValue({
        success: true,
        deliveredTo: ["agent_1"],
      });

      const endpoint = await webhookHandler.registerEndpoint({
        name: "Queue Endpoint",
        methods: ["POST"],
        path: "/webhooks/queue",
        enabled: true,
        wakeMode: "next-prompt",
      });

      const request: WebhookRequest = {
        endpointId: endpoint.id,
        method: "POST",
        path: "/webhooks/queue",
        headers: {},
        body: { test: true },
        timestamp: Date.now(),
      };

      await webhookHandler.handleRequest(request);

      expect(mockDeps.wakeManager.requestWakeNow).not.toHaveBeenCalled();
    });

    it("should handle routing failure", async () => {
      mockDeps.triggerRouter.route = vi.fn().mockResolvedValue({
        success: false,
        error: "No agents available",
        deliveredTo: [],
      });

      const endpoint = await webhookHandler.registerEndpoint({
        name: "Fail Endpoint",
        methods: ["POST"],
        path: "/webhooks/fail",
        enabled: true,
        wakeMode: "now",
      });

      const request: WebhookRequest = {
        endpointId: endpoint.id,
        method: "POST",
        path: "/webhooks/fail",
        headers: {},
        timestamp: Date.now(),
      };

      const result = await webhookHandler.handleRequest(request);

      expect(result.success).toBe(false);
      expect(result.statusCode).toBe(500);
    });

    it("should handle JSON body", async () => {
      mockDeps.triggerRouter.route = vi.fn().mockResolvedValue({
        success: true,
        deliveredTo: ["agent_1"],
      });

      const endpoint = await webhookHandler.registerEndpoint({
        name: "JSON Endpoint",
        methods: ["POST"],
        path: "/webhooks/json",
        enabled: true,
        wakeMode: "now",
      });

      const request: WebhookRequest = {
        endpointId: endpoint.id,
        method: "POST",
        path: "/webhooks/json",
        headers: { "content-type": "application/json" },
        body: { nested: { value: 123 } },
        timestamp: Date.now(),
      };

      await webhookHandler.handleRequest(request);

      const routeCall = mockDeps.triggerRouter.route.mock.calls[0][0];
      expect(routeCall.payload.kind).toBe("json");
      expect(routeCall.payload.data).toEqual({ nested: { value: 123 } });
    });

    it("should handle string body", async () => {
      mockDeps.triggerRouter.route = vi.fn().mockResolvedValue({
        success: true,
        deliveredTo: ["agent_1"],
      });

      const endpoint = await webhookHandler.registerEndpoint({
        name: "Text Endpoint",
        methods: ["POST"],
        path: "/webhooks/text",
        enabled: true,
        wakeMode: "now",
      });

      const request: WebhookRequest = {
        endpointId: endpoint.id,
        method: "POST",
        path: "/webhooks/text",
        headers: { "content-type": "text/plain" },
        body: "Plain text body",
        timestamp: Date.now(),
      };

      await webhookHandler.handleRequest(request);

      const routeCall = mockDeps.triggerRouter.route.mock.calls[0][0];
      expect(routeCall.payload.kind).toBe("text");
      expect(routeCall.payload.content).toBe("Plain text body");
    });

    it("should emit events", async () => {
      mockDeps.triggerRouter.route = vi.fn().mockResolvedValue({
        success: true,
        deliveredTo: ["agent_1"],
      });

      const endpoint = await webhookHandler.registerEndpoint({
        name: "Event Endpoint",
        methods: ["POST"],
        path: "/webhooks/event",
        enabled: true,
        wakeMode: "now",
      });

      const request: WebhookRequest = {
        endpointId: endpoint.id,
        method: "POST",
        path: "/webhooks/event",
        headers: {},
        timestamp: Date.now(),
      };

      await webhookHandler.handleRequest(request);

      expect(capturedEvents).toContainEqual(
        expect.objectContaining({
          action: "received",
          endpointId: endpoint.id,
          method: "POST",
        })
      );
      expect(capturedEvents).toContainEqual(
        expect.objectContaining({
          action: "processed",
          endpointId: endpoint.id,
          success: true,
        })
      );
    });
  });

  describe("signature validation", () => {
    it("should pass validation when no secret configured", async () => {
      const endpoint = await webhookHandler.registerEndpoint({
        name: "No Secret",
        methods: ["POST"],
        path: "/webhooks/no-secret",
        enabled: true,
        wakeMode: "now",
      });

      const isValid = await webhookHandler.validateSignature(
        endpoint.id,
        "any-signature",
        "any-body"
      );

      expect(isValid).toBe(true);
    });

    it("should validate signature with endpoint secret", async () => {
      const endpoint = await webhookHandler.registerEndpoint({
        name: "Secret Endpoint",
        methods: ["POST"],
        path: "/webhooks/secret",
        enabled: true,
        secret: "test-secret",
        wakeMode: "now",
      });

      // Compute expected signature
      const crypto = await import("crypto");
      const hmac = crypto.createHmac("sha256", "test-secret");
      hmac.update("request-body", "utf8");
      const expectedSignature = `sha256=${hmac.digest("hex")}`;

      const isValid = await webhookHandler.validateSignature(
        endpoint.id,
        expectedSignature,
        "request-body"
      );

      expect(isValid).toBe(true);
    });

    it("should reject invalid signature", async () => {
      const endpoint = await webhookHandler.registerEndpoint({
        name: "Secret Endpoint",
        methods: ["POST"],
        path: "/webhooks/secret",
        enabled: true,
        secret: "test-secret",
        wakeMode: "now",
      });

      const isValid = await webhookHandler.validateSignature(
        endpoint.id,
        "sha256=invalid",
        "request-body"
      );

      expect(isValid).toBe(false);
    });

    it("should use default secret when endpoint has none", async () => {
      webhookHandler = createWebhookHandler(mockDeps, {
        defaultSecret: "default-secret",
      });

      const endpoint = await webhookHandler.registerEndpoint({
        name: "Default Secret",
        methods: ["POST"],
        path: "/webhooks/default",
        enabled: true,
        wakeMode: "now",
      });

      // Compute expected signature with default secret
      const crypto = await import("crypto");
      const hmac = crypto.createHmac("sha256", "default-secret");
      hmac.update("request-body", "utf8");
      const expectedSignature = `sha256=${hmac.digest("hex")}`;

      const isValid = await webhookHandler.validateSignature(
        endpoint.id,
        expectedSignature,
        "request-body"
      );

      expect(isValid).toBe(true);
    });
  });

  describe("header filtering", () => {
    it("should filter sensitive headers", async () => {
      mockDeps.triggerRouter.route = vi.fn().mockResolvedValue({
        success: true,
        deliveredTo: ["agent_1"],
      });

      const endpoint = await webhookHandler.registerEndpoint({
        name: "Header Endpoint",
        methods: ["POST"],
        path: "/webhooks/headers",
        enabled: true,
        wakeMode: "now",
      });

      const request: WebhookRequest = {
        endpointId: endpoint.id,
        method: "POST",
        path: "/webhooks/headers",
        headers: {
          "content-type": "application/json",
          "authorization": "Bearer secret-token",
          "cookie": "session=abc123",
          "x-api-key": "api-key-value",
          "x-custom-header": "custom-value",
        },
        timestamp: Date.now(),
      };

      await webhookHandler.handleRequest(request);

      const routeCall = mockDeps.triggerRouter.route.mock.calls[0][0];
      const metadata = routeCall.metadata;

      expect(metadata.headers["content-type"]).toBe("application/json");
      expect(metadata.headers["x-custom-header"]).toBe("custom-value");
      expect(metadata.headers["authorization"]).toBeUndefined();
      expect(metadata.headers["cookie"]).toBeUndefined();
      expect(metadata.headers["x-api-key"]).toBeUndefined();
    });
  });
});

// =============================================================================
// Test Helpers
// =============================================================================

function createMockDeps() {
  return {
    triggerRouter: {
      route: vi.fn().mockResolvedValue({
        success: true,
        deliveredTo: [],
      }),
    } as any,
    wakeManager: {
      requestWakeNow: vi.fn(),
    } as any,
  };
}
