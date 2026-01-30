/**
 * JSON-RPC Handler for MAP Protocol
 *
 * Handles JSON-RPC 2.0 message parsing, method dispatch, request/response
 * correlation, and error formatting for the MAP adapter.
 *
 * Adapted from MAP SDK patterns (RouterConnectionImpl) but simplified
 * for macro-agent's needs.
 *
 * @see specs/s-5qir_map_integration_for_macro_agent.md
 */

import type { ParticipantId, ParticipantCapabilities } from "./types.js";

// =============================================================================
// JSON-RPC Types
// =============================================================================

/**
 * JSON-RPC 2.0 request ID.
 */
export type RequestId = string | number;

/**
 * JSON-RPC 2.0 request.
 */
export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: RequestId;
  method: string;
  params?: unknown;
}

/**
 * JSON-RPC 2.0 notification (no response expected).
 */
export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

/**
 * JSON-RPC 2.0 error object.
 */
export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

/**
 * JSON-RPC 2.0 success response.
 */
export interface JsonRpcSuccessResponse {
  jsonrpc: "2.0";
  id: RequestId;
  result: unknown;
}

/**
 * JSON-RPC 2.0 error response.
 */
export interface JsonRpcErrorResponse {
  jsonrpc: "2.0";
  id: RequestId;
  error: JsonRpcError;
}

/**
 * JSON-RPC 2.0 response (success or error).
 */
export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;

/**
 * Any JSON-RPC message.
 */
export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcNotification
  | JsonRpcResponse;

// =============================================================================
// Standard JSON-RPC Error Codes
// =============================================================================

export const JSON_RPC_ERRORS = {
  /** Invalid JSON was received. */
  PARSE_ERROR: -32700,
  /** The JSON sent is not a valid Request object. */
  INVALID_REQUEST: -32600,
  /** The method does not exist / is not available. */
  METHOD_NOT_FOUND: -32601,
  /** Invalid method parameter(s). */
  INVALID_PARAMS: -32602,
  /** Internal JSON-RPC error. */
  INTERNAL_ERROR: -32603,
} as const;

// =============================================================================
// MAP-specific Error Codes (custom range: -32000 to -32099)
// =============================================================================

export const MAP_ERRORS = {
  /** Participant not found. */
  PARTICIPANT_NOT_FOUND: -32001,
  /** Agent not found. */
  AGENT_NOT_FOUND: -32002,
  /** Scope not found. */
  SCOPE_NOT_FOUND: -32003,
  /** Subscription not found. */
  SUBSCRIPTION_NOT_FOUND: -32004,
  /** Permission denied. */
  PERMISSION_DENIED: -32010,
  /** Rate limit exceeded. */
  RATE_LIMIT_EXCEEDED: -32011,
  /** Resource limit exceeded. */
  RESOURCE_LIMIT_EXCEEDED: -32012,
  /** Invalid address. */
  INVALID_ADDRESS: -32020,
  /** Routing failed. */
  ROUTING_FAILED: -32021,
  /** Connection not established. */
  NOT_CONNECTED: -32030,
  /** Already connected. */
  ALREADY_CONNECTED: -32031,
} as const;

// =============================================================================
// Handler Types
// =============================================================================

/**
 * Context provided to method handlers.
 */
export interface HandlerContext {
  /** The participant making the request */
  participantId: ParticipantId;
  /** Participant's capabilities */
  capabilities: ParticipantCapabilities;
  /** Request ID for correlation */
  requestId: RequestId;
  /** Abort signal for cancellation */
  signal?: AbortSignal;
}

/**
 * Method handler function.
 */
export type MethodHandler = (
  params: unknown,
  context: HandlerContext
) => Promise<unknown>;

/**
 * Registry of method handlers.
 */
export type HandlerRegistry = Record<string, MethodHandler>;

/**
 * Middleware function.
 */
export type Middleware = (
  method: string,
  params: unknown,
  context: HandlerContext,
  next: () => Promise<unknown>
) => Promise<unknown>;

// =============================================================================
// Message Helpers
// =============================================================================

/**
 * Check if a message is a JSON-RPC request.
 */
export function isRequest(message: unknown): message is JsonRpcRequest {
  return (
    typeof message === "object" &&
    message !== null &&
    "jsonrpc" in message &&
    (message as JsonRpcRequest).jsonrpc === "2.0" &&
    "id" in message &&
    "method" in message
  );
}

/**
 * Check if a message is a JSON-RPC notification.
 */
export function isNotification(message: unknown): message is JsonRpcNotification {
  return (
    typeof message === "object" &&
    message !== null &&
    "jsonrpc" in message &&
    (message as JsonRpcNotification).jsonrpc === "2.0" &&
    "method" in message &&
    !("id" in message)
  );
}

/**
 * Check if a message is a JSON-RPC response.
 */
export function isResponse(message: unknown): message is JsonRpcResponse {
  return (
    typeof message === "object" &&
    message !== null &&
    "jsonrpc" in message &&
    (message as JsonRpcResponse).jsonrpc === "2.0" &&
    "id" in message &&
    ("result" in message || "error" in message)
  );
}

/**
 * Check if a response is an error response.
 */
export function isErrorResponse(
  response: JsonRpcResponse
): response is JsonRpcErrorResponse {
  return "error" in response;
}

/**
 * Create a success response.
 */
export function createSuccessResponse(
  id: RequestId,
  result: unknown
): JsonRpcSuccessResponse {
  return {
    jsonrpc: "2.0",
    id,
    result,
  };
}

/**
 * Create an error response.
 */
export function createErrorResponse(
  id: RequestId,
  code: number,
  message: string,
  data?: unknown
): JsonRpcErrorResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message, data },
  };
}

/**
 * Create a notification.
 */
export function createNotification(
  method: string,
  params?: unknown
): JsonRpcNotification {
  return {
    jsonrpc: "2.0",
    method,
    params,
  };
}

// =============================================================================
// RPC Error Class
// =============================================================================

/**
 * Error that can be converted to JSON-RPC error response.
 */
export class RPCError extends Error {
  readonly errorCode: number;
  readonly data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "RPCError";
    this.errorCode = code;
    this.data = data;
  }

  toJsonRpcError(): JsonRpcError {
    return {
      code: this.errorCode,
      message: this.message,
      data: this.data,
    };
  }

  static methodNotFound(method: string): RPCError {
    return new RPCError(
      JSON_RPC_ERRORS.METHOD_NOT_FOUND,
      `Method not found: ${method}`
    );
  }

  static invalidParams(message: string): RPCError {
    return new RPCError(JSON_RPC_ERRORS.INVALID_PARAMS, message);
  }

  static internalError(message: string): RPCError {
    return new RPCError(JSON_RPC_ERRORS.INTERNAL_ERROR, message);
  }

  static permissionDenied(message: string): RPCError {
    return new RPCError(MAP_ERRORS.PERMISSION_DENIED, message);
  }

  static notFound(type: "agent" | "scope" | "subscription" | "participant", id: string): RPCError {
    const codes = {
      agent: MAP_ERRORS.AGENT_NOT_FOUND,
      scope: MAP_ERRORS.SCOPE_NOT_FOUND,
      subscription: MAP_ERRORS.SUBSCRIPTION_NOT_FOUND,
      participant: MAP_ERRORS.PARTICIPANT_NOT_FOUND,
    };
    return new RPCError(codes[type], `${type} not found: ${id}`);
  }

  static resourceLimitExceeded(message: string): RPCError {
    return new RPCError(MAP_ERRORS.RESOURCE_LIMIT_EXCEEDED, message);
  }

  static invalidAddress(message: string): RPCError {
    return new RPCError(MAP_ERRORS.INVALID_ADDRESS, message);
  }

  static routingFailed(message: string): RPCError {
    return new RPCError(MAP_ERRORS.ROUTING_FAILED, message);
  }
}

// =============================================================================
// RPC Handler
// =============================================================================

/**
 * Configuration for RPCHandler.
 */
export interface RPCHandlerConfig {
  /** Method handlers */
  handlers: HandlerRegistry;
  /** Middleware chain (executed in order) */
  middleware?: Middleware[];
  /** Handler for notifications (fire-and-forget) */
  notificationHandler?: (method: string, params: unknown) => Promise<void>;
}

/**
 * Result of processing a message.
 */
export type ProcessResult =
  | { type: "response"; response: JsonRpcResponse }
  | { type: "notification"; handled: boolean }
  | { type: "ignored" };

/**
 * RPC Handler class.
 *
 * Processes JSON-RPC messages, dispatches to handlers, and formats responses.
 */
export class RPCHandler {
  private readonly handlers: HandlerRegistry;
  private readonly middleware: Middleware[];
  private readonly notificationHandler?: (
    method: string,
    params: unknown
  ) => Promise<void>;

  constructor(config: RPCHandlerConfig) {
    this.handlers = config.handlers;
    this.middleware = config.middleware ?? [];
    this.notificationHandler = config.notificationHandler;
  }

  /**
   * Process an incoming JSON-RPC message.
   *
   * @param message - The parsed JSON-RPC message
   * @param context - Handler context
   * @returns Processing result
   */
  async process(
    message: unknown,
    context: Omit<HandlerContext, "requestId">
  ): Promise<ProcessResult> {
    // Handle requests
    if (isRequest(message)) {
      const response = await this.handleRequest(message, {
        ...context,
        requestId: message.id,
      });
      return { type: "response", response };
    }

    // Handle notifications
    if (isNotification(message)) {
      const handled = await this.handleNotification(message);
      return { type: "notification", handled };
    }

    // Ignore responses (we don't make outgoing requests from handler)
    if (isResponse(message)) {
      return { type: "ignored" };
    }

    // Unknown message type - could be malformed
    return { type: "ignored" };
  }

  /**
   * Handle a JSON-RPC request.
   */
  private async handleRequest(
    request: JsonRpcRequest,
    context: HandlerContext
  ): Promise<JsonRpcResponse> {
    const { id, method, params } = request;

    try {
      // Find handler
      const handler = this.handlers[method];
      if (!handler) {
        throw RPCError.methodNotFound(method);
      }

      // Execute through middleware chain
      const result = await this.executeWithMiddleware(
        method,
        params,
        context,
        handler
      );

      return createSuccessResponse(id, result ?? null);
    } catch (error) {
      return this.errorToResponse(id, error);
    }
  }

  /**
   * Handle a JSON-RPC notification.
   */
  private async handleNotification(
    notification: JsonRpcNotification
  ): Promise<boolean> {
    if (!this.notificationHandler) {
      return false;
    }

    try {
      await this.notificationHandler(notification.method, notification.params);
      return true;
    } catch (error) {
      console.error("[RPCHandler] Notification handler error:", error);
      return false;
    }
  }

  /**
   * Execute handler with middleware chain.
   */
  private async executeWithMiddleware(
    method: string,
    params: unknown,
    context: HandlerContext,
    handler: MethodHandler
  ): Promise<unknown> {
    let index = 0;

    const next = async (): Promise<unknown> => {
      if (index < this.middleware.length) {
        const middleware = this.middleware[index++];
        return middleware(method, params, context, next);
      } else {
        return handler(params, context);
      }
    };

    return next();
  }

  /**
   * Convert an error to a JSON-RPC error response.
   */
  private errorToResponse(id: RequestId, error: unknown): JsonRpcErrorResponse {
    if (error instanceof RPCError) {
      return createErrorResponse(id, error.errorCode, error.message, error.data);
    }

    if (error instanceof Error) {
      return createErrorResponse(
        id,
        JSON_RPC_ERRORS.INTERNAL_ERROR,
        error.message
      );
    }

    return createErrorResponse(
      id,
      JSON_RPC_ERRORS.INTERNAL_ERROR,
      "Unknown error"
    );
  }

  /**
   * Check if a method is registered.
   */
  hasMethod(method: string): boolean {
    return method in this.handlers;
  }

  /**
   * Get list of registered methods.
   */
  getMethods(): string[] {
    return Object.keys(this.handlers);
  }

  /**
   * Add a handler for a method.
   */
  addHandler(method: string, handler: MethodHandler): void {
    this.handlers[method] = handler;
  }

  /**
   * Remove a handler for a method.
   */
  removeHandler(method: string): void {
    delete this.handlers[method];
  }
}

// =============================================================================
// Factory
// =============================================================================

/**
 * Create an RPCHandler instance.
 */
export function createRPCHandler(config: RPCHandlerConfig): RPCHandler {
  return new RPCHandler(config);
}

// =============================================================================
// Common Middleware
// =============================================================================

/**
 * Create a logging middleware.
 */
export function createLoggingMiddleware(
  prefix: string = "[RPC]"
): Middleware {
  return async (method, params, context, next) => {
    const start = Date.now();
    try {
      const result = await next();
      const duration = Date.now() - start;
      console.log(`${prefix} ${method} - ${duration}ms`);
      return result;
    } catch (error) {
      const duration = Date.now() - start;
      console.error(`${prefix} ${method} FAILED - ${duration}ms`, error);
      throw error;
    }
  };
}

/**
 * Create a capability check middleware.
 *
 * @param requirements - Map of method to required capability
 */
export function createCapabilityMiddleware(
  requirements: Record<string, keyof ParticipantCapabilities>
): Middleware {
  return async (method, params, context, next) => {
    const requiredCapability = requirements[method];
    if (requiredCapability && !context.capabilities[requiredCapability]) {
      throw RPCError.permissionDenied(
        `Requires capability: ${requiredCapability}`
      );
    }
    return next();
  };
}
