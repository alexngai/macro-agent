/**
 * Tests for RPCHandler
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  RPCHandler,
  createRPCHandler,
  RPCError,
  JSON_RPC_ERRORS,
  MAP_ERRORS,
  isRequest,
  isNotification,
  isResponse,
  isErrorResponse,
  createSuccessResponse,
  createErrorResponse,
  createNotification,
  createLoggingMiddleware,
  createCapabilityMiddleware,
  type HandlerContext,
  type HandlerRegistry,
  type JsonRpcRequest,
  type JsonRpcNotification,
} from "../rpc-handler.js";
import type { ParticipantId, ParticipantCapabilities } from "../types.js";
import { createParticipantId } from "../types.js";

describe("RPCHandler", () => {
  let handler: RPCHandler;
  let participantId: ParticipantId;
  let defaultContext: Omit<HandlerContext, "requestId">;

  const defaultCapabilities: ParticipantCapabilities = {
    canQuery: true,
    canSubscribe: true,
    canMessage: true,
    canSpawn: false,
  };

  beforeEach(() => {
    participantId = createParticipantId("p-test");
    defaultContext = {
      participantId,
      capabilities: defaultCapabilities,
    };
  });

  describe("message type detection", () => {
    it("identifies requests", () => {
      const request: JsonRpcRequest = {
        jsonrpc: "2.0",
        id: 1,
        method: "test",
        params: {},
      };
      expect(isRequest(request)).toBe(true);
      expect(isNotification(request)).toBe(false);
      expect(isResponse(request)).toBe(false);
    });

    it("identifies notifications", () => {
      const notification: JsonRpcNotification = {
        jsonrpc: "2.0",
        method: "test",
        params: {},
      };
      expect(isRequest(notification)).toBe(false);
      expect(isNotification(notification)).toBe(true);
      expect(isResponse(notification)).toBe(false);
    });

    it("identifies responses", () => {
      const successResponse = { jsonrpc: "2.0" as const, id: 1, result: {} };
      const errorResponse = {
        jsonrpc: "2.0" as const,
        id: 1,
        error: { code: -1, message: "error" },
      };

      expect(isResponse(successResponse)).toBe(true);
      expect(isResponse(errorResponse)).toBe(true);
      expect(isErrorResponse(errorResponse)).toBe(true);
      expect(isErrorResponse(successResponse)).toBe(false);
    });

    it("handles invalid messages", () => {
      expect(isRequest(null)).toBe(false);
      expect(isRequest({})).toBe(false);
      expect(isRequest({ jsonrpc: "1.0", id: 1, method: "test" })).toBe(false);
    });
  });

  describe("message creation helpers", () => {
    it("creates success response", () => {
      const response = createSuccessResponse(1, { data: "test" });

      expect(response).toEqual({
        jsonrpc: "2.0",
        id: 1,
        result: { data: "test" },
      });
    });

    it("creates error response", () => {
      const response = createErrorResponse(1, -32600, "Invalid request", {
        details: "missing field",
      });

      expect(response).toEqual({
        jsonrpc: "2.0",
        id: 1,
        error: {
          code: -32600,
          message: "Invalid request",
          data: { details: "missing field" },
        },
      });
    });

    it("creates notification", () => {
      const notification = createNotification("event", { type: "test" });

      expect(notification).toEqual({
        jsonrpc: "2.0",
        method: "event",
        params: { type: "test" },
      });
    });
  });

  describe("request handling", () => {
    it("dispatches to registered handler", async () => {
      const handlers: HandlerRegistry = {
        "test/method": vi.fn().mockResolvedValue({ success: true }),
      };
      handler = createRPCHandler({ handlers });

      const request: JsonRpcRequest = {
        jsonrpc: "2.0",
        id: 1,
        method: "test/method",
        params: { arg: "value" },
      };

      const result = await handler.process(request, defaultContext);

      expect(result.type).toBe("response");
      if (result.type === "response") {
        expect(result.response).toEqual({
          jsonrpc: "2.0",
          id: 1,
          result: { success: true },
        });
      }
      expect(handlers["test/method"]).toHaveBeenCalledWith(
        { arg: "value" },
        expect.objectContaining({
          participantId,
          requestId: 1,
        })
      );
    });

    it("returns method not found for unregistered method", async () => {
      handler = createRPCHandler({ handlers: {} });

      const request: JsonRpcRequest = {
        jsonrpc: "2.0",
        id: 1,
        method: "unknown/method",
      };

      const result = await handler.process(request, defaultContext);

      expect(result.type).toBe("response");
      if (result.type === "response") {
        expect(isErrorResponse(result.response)).toBe(true);
        if (isErrorResponse(result.response)) {
          expect(result.response.error.code).toBe(JSON_RPC_ERRORS.METHOD_NOT_FOUND);
          expect(result.response.error.message).toContain("unknown/method");
        }
      }
    });

    it("converts RPCError to error response", async () => {
      const handlers: HandlerRegistry = {
        "test/method": vi.fn().mockRejectedValue(
          new RPCError(MAP_ERRORS.AGENT_NOT_FOUND, "Agent not found", {
            agentId: "agent-1",
          })
        ),
      };
      handler = createRPCHandler({ handlers });

      const request: JsonRpcRequest = {
        jsonrpc: "2.0",
        id: 1,
        method: "test/method",
      };

      const result = await handler.process(request, defaultContext);

      expect(result.type).toBe("response");
      if (result.type === "response" && isErrorResponse(result.response)) {
        expect(result.response.error.code).toBe(MAP_ERRORS.AGENT_NOT_FOUND);
        expect(result.response.error.message).toBe("Agent not found");
        expect(result.response.error.data).toEqual({ agentId: "agent-1" });
      }
    });

    it("converts generic Error to internal error", async () => {
      const handlers: HandlerRegistry = {
        "test/method": vi.fn().mockRejectedValue(new Error("Something broke")),
      };
      handler = createRPCHandler({ handlers });

      const request: JsonRpcRequest = {
        jsonrpc: "2.0",
        id: 1,
        method: "test/method",
      };

      const result = await handler.process(request, defaultContext);

      expect(result.type).toBe("response");
      if (result.type === "response" && isErrorResponse(result.response)) {
        expect(result.response.error.code).toBe(JSON_RPC_ERRORS.INTERNAL_ERROR);
        expect(result.response.error.message).toBe("Something broke");
      }
    });

    it("handles null result as null", async () => {
      const handlers: HandlerRegistry = {
        "test/method": vi.fn().mockResolvedValue(null),
      };
      handler = createRPCHandler({ handlers });

      const request: JsonRpcRequest = {
        jsonrpc: "2.0",
        id: 1,
        method: "test/method",
      };

      const result = await handler.process(request, defaultContext);

      expect(result.type).toBe("response");
      if (result.type === "response" && !isErrorResponse(result.response)) {
        expect(result.response.result).toBeNull();
      }
    });

    it("handles undefined result as null", async () => {
      const handlers: HandlerRegistry = {
        "test/method": vi.fn().mockResolvedValue(undefined),
      };
      handler = createRPCHandler({ handlers });

      const request: JsonRpcRequest = {
        jsonrpc: "2.0",
        id: 1,
        method: "test/method",
      };

      const result = await handler.process(request, defaultContext);

      expect(result.type).toBe("response");
      if (result.type === "response" && !isErrorResponse(result.response)) {
        expect(result.response.result).toBeNull();
      }
    });
  });

  describe("notification handling", () => {
    it("calls notification handler", async () => {
      const notificationHandler = vi.fn().mockResolvedValue(undefined);
      handler = createRPCHandler({
        handlers: {},
        notificationHandler,
      });

      const notification: JsonRpcNotification = {
        jsonrpc: "2.0",
        method: "event/test",
        params: { data: "test" },
      };

      const result = await handler.process(notification, defaultContext);

      expect(result.type).toBe("notification");
      if (result.type === "notification") {
        expect(result.handled).toBe(true);
      }
      expect(notificationHandler).toHaveBeenCalledWith("event/test", {
        data: "test",
      });
    });

    it("returns handled=false when no notification handler", async () => {
      handler = createRPCHandler({ handlers: {} });

      const notification: JsonRpcNotification = {
        jsonrpc: "2.0",
        method: "event/test",
      };

      const result = await handler.process(notification, defaultContext);

      expect(result.type).toBe("notification");
      if (result.type === "notification") {
        expect(result.handled).toBe(false);
      }
    });

    it("handles notification handler errors gracefully", async () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const notificationHandler = vi
        .fn()
        .mockRejectedValue(new Error("Handler error"));
      handler = createRPCHandler({
        handlers: {},
        notificationHandler,
      });

      const notification: JsonRpcNotification = {
        jsonrpc: "2.0",
        method: "event/test",
      };

      const result = await handler.process(notification, defaultContext);

      expect(result.type).toBe("notification");
      if (result.type === "notification") {
        expect(result.handled).toBe(false);
      }

      consoleSpy.mockRestore();
    });
  });

  describe("middleware", () => {
    it("executes middleware in order", async () => {
      const order: string[] = [];

      const middleware1 = vi.fn(async (method, params, ctx, next) => {
        order.push("m1-before");
        const result = await next();
        order.push("m1-after");
        return result;
      });

      const middleware2 = vi.fn(async (method, params, ctx, next) => {
        order.push("m2-before");
        const result = await next();
        order.push("m2-after");
        return result;
      });

      const handlers: HandlerRegistry = {
        "test/method": vi.fn(async () => {
          order.push("handler");
          return { success: true };
        }),
      };

      handler = createRPCHandler({
        handlers,
        middleware: [middleware1, middleware2],
      });

      const request: JsonRpcRequest = {
        jsonrpc: "2.0",
        id: 1,
        method: "test/method",
      };

      await handler.process(request, defaultContext);

      expect(order).toEqual([
        "m1-before",
        "m2-before",
        "handler",
        "m2-after",
        "m1-after",
      ]);
    });

    it("middleware can short-circuit", async () => {
      const middleware = vi.fn(async () => {
        throw RPCError.permissionDenied("Access denied");
      });

      const handlers: HandlerRegistry = {
        "test/method": vi.fn(),
      };

      handler = createRPCHandler({
        handlers,
        middleware: [middleware],
      });

      const request: JsonRpcRequest = {
        jsonrpc: "2.0",
        id: 1,
        method: "test/method",
      };

      const result = await handler.process(request, defaultContext);

      expect(handlers["test/method"]).not.toHaveBeenCalled();
      expect(result.type).toBe("response");
      if (result.type === "response" && isErrorResponse(result.response)) {
        expect(result.response.error.code).toBe(MAP_ERRORS.PERMISSION_DENIED);
      }
    });

    it("middleware can modify result", async () => {
      const middleware = vi.fn(async (method, params, ctx, next) => {
        const result = await next();
        return { ...result as object, modified: true };
      });

      const handlers: HandlerRegistry = {
        "test/method": vi.fn().mockResolvedValue({ original: true }),
      };

      handler = createRPCHandler({
        handlers,
        middleware: [middleware],
      });

      const request: JsonRpcRequest = {
        jsonrpc: "2.0",
        id: 1,
        method: "test/method",
      };

      const result = await handler.process(request, defaultContext);

      if (result.type === "response" && !isErrorResponse(result.response)) {
        expect(result.response.result).toEqual({
          original: true,
          modified: true,
        });
      }
    });
  });

  describe("capability middleware", () => {
    it("allows method when capability is present", async () => {
      const handlers: HandlerRegistry = {
        "test/method": vi.fn().mockResolvedValue({ success: true }),
      };

      handler = createRPCHandler({
        handlers,
        middleware: [
          createCapabilityMiddleware({
            "test/method": "canQuery",
          }),
        ],
      });

      const request: JsonRpcRequest = {
        jsonrpc: "2.0",
        id: 1,
        method: "test/method",
      };

      const result = await handler.process(request, defaultContext);

      expect(result.type).toBe("response");
      if (result.type === "response") {
        expect(isErrorResponse(result.response)).toBe(false);
      }
    });

    it("denies method when capability is missing", async () => {
      const handlers: HandlerRegistry = {
        "test/method": vi.fn().mockResolvedValue({ success: true }),
      };

      handler = createRPCHandler({
        handlers,
        middleware: [
          createCapabilityMiddleware({
            "test/method": "canSpawn", // defaultCapabilities.canSpawn = false
          }),
        ],
      });

      const request: JsonRpcRequest = {
        jsonrpc: "2.0",
        id: 1,
        method: "test/method",
      };

      const result = await handler.process(request, defaultContext);

      expect(result.type).toBe("response");
      if (result.type === "response" && isErrorResponse(result.response)) {
        expect(result.response.error.code).toBe(MAP_ERRORS.PERMISSION_DENIED);
        expect(result.response.error.message).toContain("canSpawn");
      }
    });

    it("allows methods without capability requirement", async () => {
      const handlers: HandlerRegistry = {
        "test/method": vi.fn().mockResolvedValue({ success: true }),
      };

      handler = createRPCHandler({
        handlers,
        middleware: [
          createCapabilityMiddleware({
            // No requirement for test/method
          }),
        ],
      });

      const request: JsonRpcRequest = {
        jsonrpc: "2.0",
        id: 1,
        method: "test/method",
      };

      const result = await handler.process(request, defaultContext);

      expect(result.type).toBe("response");
      if (result.type === "response") {
        expect(isErrorResponse(result.response)).toBe(false);
      }
    });
  });

  describe("handler management", () => {
    it("hasMethod returns true for registered methods", () => {
      handler = createRPCHandler({
        handlers: { "test/method": vi.fn() },
      });

      expect(handler.hasMethod("test/method")).toBe(true);
      expect(handler.hasMethod("unknown")).toBe(false);
    });

    it("getMethods returns all registered methods", () => {
      handler = createRPCHandler({
        handlers: {
          "method/a": vi.fn(),
          "method/b": vi.fn(),
        },
      });

      expect(handler.getMethods()).toEqual(["method/a", "method/b"]);
    });

    it("addHandler registers new method", () => {
      handler = createRPCHandler({ handlers: {} });
      expect(handler.hasMethod("new/method")).toBe(false);

      handler.addHandler("new/method", vi.fn());

      expect(handler.hasMethod("new/method")).toBe(true);
    });

    it("removeHandler unregisters method", () => {
      handler = createRPCHandler({
        handlers: { "test/method": vi.fn() },
      });
      expect(handler.hasMethod("test/method")).toBe(true);

      handler.removeHandler("test/method");

      expect(handler.hasMethod("test/method")).toBe(false);
    });
  });

  describe("RPCError", () => {
    it("methodNotFound creates correct error", () => {
      const error = RPCError.methodNotFound("test/method");

      expect(error.errorCode).toBe(JSON_RPC_ERRORS.METHOD_NOT_FOUND);
      expect(error.message).toContain("test/method");
    });

    it("invalidParams creates correct error", () => {
      const error = RPCError.invalidParams("Missing required field");

      expect(error.errorCode).toBe(JSON_RPC_ERRORS.INVALID_PARAMS);
      expect(error.message).toBe("Missing required field");
    });

    it("permissionDenied creates correct error", () => {
      const error = RPCError.permissionDenied("Access denied");

      expect(error.errorCode).toBe(MAP_ERRORS.PERMISSION_DENIED);
    });

    it("notFound creates correct error for each type", () => {
      expect(RPCError.notFound("agent", "a1").errorCode).toBe(MAP_ERRORS.AGENT_NOT_FOUND);
      expect(RPCError.notFound("scope", "s1").errorCode).toBe(MAP_ERRORS.SCOPE_NOT_FOUND);
      expect(RPCError.notFound("subscription", "sub1").errorCode).toBe(
        MAP_ERRORS.SUBSCRIPTION_NOT_FOUND
      );
      expect(RPCError.notFound("participant", "p1").errorCode).toBe(
        MAP_ERRORS.PARTICIPANT_NOT_FOUND
      );
    });

    it("toJsonRpcError includes data", () => {
      const error = new RPCError(-32000, "Test error", { extra: "data" });

      expect(error.toJsonRpcError()).toEqual({
        code: -32000,
        message: "Test error",
        data: { extra: "data" },
      });
    });
  });

  describe("ignored messages", () => {
    it("ignores responses", async () => {
      handler = createRPCHandler({ handlers: {} });

      const response = {
        jsonrpc: "2.0" as const,
        id: 1,
        result: {},
      };

      const result = await handler.process(response, defaultContext);

      expect(result.type).toBe("ignored");
    });

    it("ignores malformed messages", async () => {
      handler = createRPCHandler({ handlers: {} });

      const result = await handler.process({ foo: "bar" }, defaultContext);

      expect(result.type).toBe("ignored");
    });
  });
});
