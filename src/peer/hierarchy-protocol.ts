/**
 * HierarchyProtocol - Wire protocol for distributed hierarchy operations
 *
 * Defines message formats and routing for all hierarchy patterns:
 * - Task delegation (task/*)
 * - Federated hierarchy (federation/*)
 * - Transparent encapsulation (encapsulation/*)
 *
 * Built on top of the existing peer transport layer.
 */

import type { PeerAddress, PeerResponse } from "./types.js";

// ─────────────────────────────────────────────────────────────────
// Protocol Version
// ─────────────────────────────────────────────────────────────────

export const HIERARCHY_PROTOCOL_VERSION = "1.0";

// ─────────────────────────────────────────────────────────────────
// Message Types
// ─────────────────────────────────────────────────────────────────

/**
 * Hierarchy request (expects response)
 */
export interface HierarchyRequest {
  /** Method name (e.g., "task/delegate", "federation/establish") */
  method: HierarchyMethod;
  /** Request parameters */
  params: Record<string, unknown>;
  /** Optional per-request timeout in ms */
  timeout?: number;
}

/**
 * Hierarchy response
 */
export interface HierarchyResponse {
  /** Success result */
  result?: unknown;
  /** Error if request failed */
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

/**
 * Hierarchy push message (fire-and-forget, no response expected)
 */
export interface HierarchyPushMessage {
  /** Message type (e.g., "task/progress", "federation/status") */
  type: HierarchyPushType;
  /** Message payload */
  payload: Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────────
// Method and Type Definitions
// ─────────────────────────────────────────────────────────────────

/**
 * Task delegation methods
 */
export type TaskDelegationMethod = "task/delegate";

/**
 * Task delegation push message types
 */
export type TaskDelegationPushType = "task/progress" | "task/complete";

/**
 * Federation methods
 */
export type FederationMethod =
  | "federation/establish"
  | "federation/terminate"
  | "federation/getHierarchy"
  | "federation/mount";

/**
 * Federation push message types
 */
export type FederationPushType = "federation/status";

/**
 * Encapsulation methods
 */
export type EncapsulationMethod =
  | "encapsulation/register"
  | "encapsulation/unregister"
  | "encapsulation/task";

/**
 * Encapsulation push message types
 */
export type EncapsulationPushType =
  | "encapsulation/status"
  | "encapsulation/result";

/**
 * All hierarchy request methods
 */
export type HierarchyMethod =
  | TaskDelegationMethod
  | FederationMethod
  | EncapsulationMethod;

/**
 * All hierarchy push message types
 */
export type HierarchyPushType =
  | TaskDelegationPushType
  | FederationPushType
  | EncapsulationPushType;

/**
 * Method prefix for routing
 */
export type HierarchyMethodPrefix = "task" | "federation" | "encapsulation";

// ─────────────────────────────────────────────────────────────────
// Handler Interface
// ─────────────────────────────────────────────────────────────────

/**
 * Handler for hierarchy protocol messages
 */
export interface HierarchyHandler {
  /**
   * Handle an incoming hierarchy request
   * @param from - Source peer address
   * @param request - The hierarchy request
   * @returns Response to send back
   */
  handleHierarchyRequest(
    from: PeerAddress,
    request: HierarchyRequest
  ): Promise<HierarchyResponse>;

  /**
   * Handle an incoming push message
   * @param from - Source peer address
   * @param message - The push message
   */
  handleHierarchyMessage(
    from: PeerAddress,
    message: HierarchyPushMessage
  ): void;
}

/**
 * Pattern-specific handler interface
 */
export interface PatternHandler {
  /**
   * Handle a request for this pattern
   */
  handleRequest(
    from: PeerAddress,
    method: string,
    params: Record<string, unknown>
  ): Promise<HierarchyResponse>;

  /**
   * Handle a push message for this pattern
   */
  handleMessage(
    from: PeerAddress,
    type: string,
    payload: Record<string, unknown>
  ): void;
}

// ─────────────────────────────────────────────────────────────────
// Routing Utilities
// ─────────────────────────────────────────────────────────────────

/**
 * Extract the pattern prefix from a method or type string
 */
export function getMethodPrefix(method: string): HierarchyMethodPrefix | null {
  const slashIndex = method.indexOf("/");
  if (slashIndex === -1) {
    return null;
  }
  const prefix = method.substring(0, slashIndex);
  if (prefix === "task" || prefix === "federation" || prefix === "encapsulation") {
    return prefix;
  }
  return null;
}

/**
 * Check if a method belongs to a specific pattern
 */
export function isMethodOfPattern(
  method: string,
  pattern: HierarchyMethodPrefix
): boolean {
  return getMethodPrefix(method) === pattern;
}

/**
 * Validate that a method is a known hierarchy method
 */
export function isValidHierarchyMethod(method: string): method is HierarchyMethod {
  const validMethods: HierarchyMethod[] = [
    "task/delegate",
    "federation/establish",
    "federation/terminate",
    "federation/getHierarchy",
    "federation/mount",
    "encapsulation/register",
    "encapsulation/unregister",
    "encapsulation/task",
  ];
  return validMethods.includes(method as HierarchyMethod);
}

/**
 * Validate that a type is a known hierarchy push type
 */
export function isValidHierarchyPushType(type: string): type is HierarchyPushType {
  const validTypes: HierarchyPushType[] = [
    "task/progress",
    "task/complete",
    "federation/status",
    "encapsulation/status",
    "encapsulation/result",
  ];
  return validTypes.includes(type as HierarchyPushType);
}

// ─────────────────────────────────────────────────────────────────
// Protocol Router
// ─────────────────────────────────────────────────────────────────

/**
 * Routes hierarchy messages to pattern-specific handlers
 */
export class HierarchyRouter implements HierarchyHandler {
  private handlers: Map<HierarchyMethodPrefix, PatternHandler> = new Map();

  /**
   * Register a handler for a specific pattern
   */
  registerHandler(pattern: HierarchyMethodPrefix, handler: PatternHandler): void {
    this.handlers.set(pattern, handler);
  }

  /**
   * Unregister a handler for a pattern
   */
  unregisterHandler(pattern: HierarchyMethodPrefix): void {
    this.handlers.delete(pattern);
  }

  /**
   * Check if a handler is registered for a pattern
   */
  hasHandler(pattern: HierarchyMethodPrefix): boolean {
    return this.handlers.has(pattern);
  }

  /**
   * Handle an incoming hierarchy request by routing to the appropriate handler
   */
  async handleHierarchyRequest(
    from: PeerAddress,
    request: HierarchyRequest
  ): Promise<HierarchyResponse> {
    const prefix = getMethodPrefix(request.method);
    if (!prefix) {
      return {
        error: {
          code: 4005,
          message: "INVALID_REQUEST",
          data: { method: request.method, reason: "Unknown method prefix" },
        },
      };
    }

    const handler = this.handlers.get(prefix);
    if (!handler) {
      return {
        error: {
          code: 4005,
          message: "INVALID_REQUEST",
          data: { method: request.method, reason: `No handler for ${prefix} pattern` },
        },
      };
    }

    return handler.handleRequest(from, request.method, request.params);
  }

  /**
   * Handle an incoming push message by routing to the appropriate handler
   */
  handleHierarchyMessage(
    from: PeerAddress,
    message: HierarchyPushMessage
  ): void {
    const prefix = getMethodPrefix(message.type);
    if (!prefix) {
      console.error(`Unknown message type prefix: ${message.type}`);
      return;
    }

    const handler = this.handlers.get(prefix);
    if (!handler) {
      console.error(`No handler for ${prefix} pattern`);
      return;
    }

    handler.handleMessage(from, message.type, message.payload);
  }
}

/**
 * Create a new HierarchyRouter instance
 */
export function createHierarchyRouter(): HierarchyRouter {
  return new HierarchyRouter();
}
