/**
 * EncapsulationManager - Transparent encapsulation pattern for distributed macro-agents
 *
 * A remote macro-agent (B) registers with a parent macro-agent (A) and appears
 * as a single child agent within A's hierarchy. B's entire internal hierarchy
 * is hidden behind a facade - A only sees a "proxy agent" representing B.
 *
 * Features:
 * - Child-initiated registration with facade configuration
 * - Status aggregation (consolidated status, not per-internal-agent)
 * - Configurable error detail levels (opaque/summary/full)
 * - Task routing through proxy agents
 */

import { nanoid } from "nanoid";
import type { PeerAddress, ErrorDetailLevel, FacadeConfig } from "./types.js";
import type { PatternHandler, HierarchyResponse } from "./hierarchy-protocol.js";
import {
  capabilityDenied,
  registrationRejected,
  proxyNotFound,
  alreadyRegistered,
  notRegistered,
  invalidRequest,
} from "./hierarchy-errors.js";
import type { CapabilityManager } from "./capability-manager.js";

// ─────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────

/**
 * Encapsulated agent status
 */
export type EncapsulatedStatus = "idle" | "running" | "completed" | "failed";

/**
 * Encapsulated child state (from parent's perspective)
 */
export interface EncapsulatedChild {
  /** Proxy agent ID in parent's namespace */
  proxyAgentId: string;
  /** Remote peer ID */
  peerId: string;
  /** Facade configuration */
  facadeConfig: FacadeConfig;
  /** Current status */
  status: EncapsulatedStatus;
  /** When registered */
  registeredAt: number;
}

/**
 * Parent registration (from child's perspective)
 */
export interface ParentRegistration {
  /** Parent peer ID */
  parentPeerId: string;
  /** Our proxy agent ID in parent's namespace */
  proxyAgentId: string;
  /** Our facade configuration */
  facadeConfig: FacadeConfig;
  /** When registered */
  registeredAt: number;
}

/**
 * Task sent to encapsulated agent
 */
export interface EncapsulatedTask {
  /** Task ID for tracking */
  taskId: string;
  /** Proxy agent ID */
  proxyAgentId: string;
  /** Task description */
  task: string;
  /** Additional context */
  context?: Record<string, unknown>;
}

/**
 * Task result from encapsulated agent
 */
export interface EncapsulatedResult {
  /** Proxy agent ID */
  proxyAgentId: string;
  /** Task ID */
  taskId: string;
  /** Result status */
  status: "completed" | "failed";
  /** Result if completed */
  result?: unknown;
  /** Error if failed */
  error?: {
    code: number;
    message: string;
    details?: unknown;
  };
}

/**
 * Status update from encapsulated agent
 */
export interface EncapsulatedStatusPayload {
  /** Proxy agent ID */
  proxyAgentId: string;
  /** Current status */
  status: EncapsulatedStatus;
  /** Optional message */
  message?: string;
}

/**
 * Callbacks for encapsulation events
 */
export interface EncapsulationCallbacks {
  /** Called when a child wants to register (as parent) */
  onRegistrationRequested?: (
    peerId: string,
    config: FacadeConfig
  ) => Promise<{ accepted: boolean; reason?: string }>;
  /** Called when a task is received (as child) */
  onTaskReceived?: (task: EncapsulatedTask) => Promise<void>;
  /** Called when status update is received (as parent) */
  onStatusUpdate?: (payload: EncapsulatedStatusPayload) => void;
  /** Called when result is received (as parent) */
  onResultReceived?: (result: EncapsulatedResult) => void;
  /** Called when a child is created to add to store (as parent) */
  onChildCreated?: (child: EncapsulatedChild) => void;
  /** Called when a child is removed (as parent) */
  onChildRemoved?: (proxyAgentId: string) => void;
}

// ─────────────────────────────────────────────────────────────────
// EncapsulationManager Interface
// ─────────────────────────────────────────────────────────────────

export interface EncapsulationManagerConfig {
  /** Capability manager for permission checks */
  capabilityManager?: CapabilityManager;
  /** Callbacks for encapsulation events */
  callbacks?: EncapsulationCallbacks;
  /** Maximum encapsulated children (optional) */
  maxChildren?: number;
}

export interface EncapsulationManager {
  /**
   * Get the pattern handler for routing
   */
  getHandler(): PatternHandler;

  // ─────────────────────────────────────────────────────────────────
  // Parent-side operations
  // ─────────────────────────────────────────────────────────────────

  /**
   * Accept a registration from a child (called internally by handler)
   */
  acceptRegistration(peerId: string, config: FacadeConfig): Promise<string>;

  /**
   * Remove an encapsulated child
   */
  removeChild(proxyAgentId: string): void;

  /**
   * Send a task to an encapsulated agent
   */
  sendTask(
    proxyAgentId: string,
    task: string,
    context?: Record<string, unknown>
  ): Promise<{ accepted: boolean; taskId: string }>;

  /**
   * Get an encapsulated child by proxy agent ID
   */
  getChild(proxyAgentId: string): EncapsulatedChild | undefined;

  /**
   * List all encapsulated children
   */
  listChildren(): EncapsulatedChild[];

  // ─────────────────────────────────────────────────────────────────
  // Child-side operations
  // ─────────────────────────────────────────────────────────────────

  /**
   * Register with a parent as an encapsulated child
   */
  registerWithParent(
    parentPeerId: string,
    config: FacadeConfig
  ): Promise<{ proxyAgentId: string; accepted: boolean; reason?: string }>;

  /**
   * Unregister from a parent
   */
  unregisterFromParent(parentPeerId: string): Promise<{ unregistered: boolean }>;

  /**
   * Report status to parent
   */
  reportStatus(status: EncapsulatedStatus, message?: string): void;

  /**
   * Report task result to parent
   */
  reportResult(taskId: string, result: Omit<EncapsulatedResult, "proxyAgentId" | "taskId">): void;

  /**
   * Get our parent registration (if registered)
   */
  getParentRegistration(): ParentRegistration | undefined;

  /**
   * Set the send functions (injected by PeerManager)
   */
  setSendFunctions(fns: {
    sendRequest: (to: PeerAddress, method: string, params: unknown) => Promise<HierarchyResponse>;
    sendMessage: (to: PeerAddress, type: string, payload: unknown) => Promise<void>;
  }): void;
}

/**
 * Create an EncapsulationManager
 */
export function createEncapsulationManager(
  config: EncapsulationManagerConfig = {}
): EncapsulationManager {
  const { capabilityManager, callbacks = {}, maxChildren } = config;

  // Encapsulated children (as parent)
  const children = new Map<string, EncapsulatedChild>();

  // Peer to proxy ID mapping
  const peerToProxy = new Map<string, string>();

  // Our parent registration (as child) - only one parent at a time
  let parentRegistration: ParentRegistration | undefined;

  // Pending tasks (as child)
  const pendingTasks = new Map<string, EncapsulatedTask>();

  // Send functions
  let sendRequest: ((to: PeerAddress, method: string, params: unknown) => Promise<HierarchyResponse>) | null = null;
  let sendMessage: ((to: PeerAddress, type: string, payload: unknown) => Promise<void>) | null = null;

  /**
   * Set send functions
   */
  function setSendFunctions(fns: {
    sendRequest: (to: PeerAddress, method: string, params: unknown) => Promise<HierarchyResponse>;
    sendMessage: (to: PeerAddress, type: string, payload: unknown) => Promise<void>;
  }): void {
    sendRequest = fns.sendRequest;
    sendMessage = fns.sendMessage;
  }

  /**
   * Extract peer ID from address
   */
  function extractPeerId(address: PeerAddress): string {
    const slashIndex = address.indexOf("/");
    return slashIndex === -1 ? address : address.substring(0, slashIndex);
  }

  /**
   * Check if peer has encapsulation capability
   */
  function checkCapability(peerId: string, asChild: boolean): boolean {
    if (!capabilityManager) {
      return true;
    }

    const caps = capabilityManager.getCapabilities(peerId);
    if (!caps) {
      return false;
    }

    const encapCap = caps.grants.find((g) => g.type === "encapsulation");
    if (!encapCap || encapCap.type !== "encapsulation") {
      return false;
    }

    return asChild ? encapCap.canActAsChild : encapCap.canActAsParent;
  }

  /**
   * Generate a proxy agent ID
   */
  function generateProxyAgentId(): string {
    return `proxy_${nanoid(12)}`;
  }

  /**
   * Generate a task ID
   */
  function generateTaskId(): string {
    return `enc_task_${nanoid(12)}`;
  }

  /**
   * Apply error detail level to error
   */
  function applyErrorDetailLevel(
    error: { code: number; message: string; details?: unknown },
    level: ErrorDetailLevel
  ): { code: number; message: string; details?: unknown } {
    switch (level) {
      case "opaque":
        return { code: 500, message: "Operation failed" };
      case "summary":
        return { code: error.code, message: error.message };
      case "full":
        return error;
      default:
        return { code: error.code, message: error.message };
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // Inbound Request Handlers
  // ─────────────────────────────────────────────────────────────────

  /**
   * Handle incoming encapsulation/register request (as parent)
   */
  async function handleRegisterRequest(
    from: PeerAddress,
    params: Record<string, unknown>
  ): Promise<HierarchyResponse> {
    const peerId = extractPeerId(from);

    // Check capability
    if (!checkCapability(peerId, true)) {
      return {
        error: capabilityDenied("encapsulation (child)", peerId).toResponseError(),
      };
    }

    // Check if already registered
    if (peerToProxy.has(peerId)) {
      return {
        error: alreadyRegistered(peerId).toResponseError(),
      };
    }

    // Check children limit
    if (maxChildren !== undefined && children.size >= maxChildren) {
      return {
        error: registrationRejected(peerId, "Maximum children reached").toResponseError(),
      };
    }

    const facadeConfig = (params.facadeConfig || {}) as FacadeConfig;

    // Ask callback if we should accept
    if (callbacks.onRegistrationRequested) {
      try {
        const result = await callbacks.onRegistrationRequested(peerId, facadeConfig);
        if (!result.accepted) {
          return {
            error: registrationRejected(peerId, result.reason).toResponseError(),
          };
        }
      } catch (err) {
        return {
          error: registrationRejected(peerId, err instanceof Error ? err.message : "Registration rejected").toResponseError(),
        };
      }
    }

    // Create proxy agent
    const proxyAgentId = generateProxyAgentId();
    const child: EncapsulatedChild = {
      proxyAgentId,
      peerId,
      facadeConfig,
      status: "idle",
      registeredAt: Date.now(),
    };

    children.set(proxyAgentId, child);
    peerToProxy.set(peerId, proxyAgentId);

    // Notify callback
    if (callbacks.onChildCreated) {
      callbacks.onChildCreated(child);
    }

    return {
      result: {
        proxyAgentId,
        accepted: true,
      },
    };
  }

  /**
   * Handle incoming encapsulation/unregister request (as parent)
   */
  async function handleUnregisterRequest(
    from: PeerAddress,
    params: Record<string, unknown>
  ): Promise<HierarchyResponse> {
    const peerId = extractPeerId(from);
    const { proxyAgentId } = params as { proxyAgentId: string };

    const child = children.get(proxyAgentId);
    if (!child) {
      return {
        error: proxyNotFound(proxyAgentId).toResponseError(),
      };
    }

    // Verify request is from the correct peer
    if (child.peerId !== peerId) {
      return {
        error: proxyNotFound(proxyAgentId).toResponseError(),
      };
    }

    // Remove child
    children.delete(proxyAgentId);
    peerToProxy.delete(peerId);

    // Notify callback
    if (callbacks.onChildRemoved) {
      callbacks.onChildRemoved(proxyAgentId);
    }

    return {
      result: { unregistered: true },
    };
  }

  /**
   * Handle incoming encapsulation/task request (as child)
   */
  async function handleTaskRequest(
    from: PeerAddress,
    params: Record<string, unknown>
  ): Promise<HierarchyResponse> {
    const peerId = extractPeerId(from);

    // Verify this is from our parent
    if (!parentRegistration || parentRegistration.parentPeerId !== peerId) {
      return {
        error: notRegistered(peerId).toResponseError(),
      };
    }

    const { proxyAgentId, task, context } = params as {
      proxyAgentId: string;
      task: string;
      context?: Record<string, unknown>;
    };

    // Verify proxy ID matches
    if (proxyAgentId !== parentRegistration.proxyAgentId) {
      return {
        error: proxyNotFound(proxyAgentId).toResponseError(),
      };
    }

    if (!task) {
      return {
        error: invalidRequest("task is required").toResponseError(),
      };
    }

    const taskId = generateTaskId();
    const encTask: EncapsulatedTask = {
      taskId,
      proxyAgentId,
      task,
      context,
    };

    pendingTasks.set(taskId, encTask);

    // Notify callback
    if (callbacks.onTaskReceived) {
      try {
        await callbacks.onTaskReceived(encTask);
      } catch {
        // Task callback failed, but we still accepted it
      }
    }

    return {
      result: {
        accepted: true,
        taskId,
      },
    };
  }

  /**
   * Handle incoming encapsulation/status message (as parent)
   */
  function handleStatusMessage(
    from: PeerAddress,
    payload: Record<string, unknown>
  ): void {
    const statusPayload = payload as unknown as EncapsulatedStatusPayload;

    const child = children.get(statusPayload.proxyAgentId);
    if (child) {
      child.status = statusPayload.status;
    }

    if (callbacks.onStatusUpdate) {
      callbacks.onStatusUpdate(statusPayload);
    }
  }

  /**
   * Handle incoming encapsulation/result message (as parent)
   */
  function handleResultMessage(
    from: PeerAddress,
    payload: Record<string, unknown>
  ): void {
    const resultPayload = payload as unknown as EncapsulatedResult;

    if (callbacks.onResultReceived) {
      callbacks.onResultReceived(resultPayload);
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // Parent-side Operations
  // ─────────────────────────────────────────────────────────────────

  /**
   * Accept a registration (called by handler, exposed for testing)
   */
  async function acceptRegistration(peerId: string, config: FacadeConfig): Promise<string> {
    const proxyAgentId = generateProxyAgentId();
    const child: EncapsulatedChild = {
      proxyAgentId,
      peerId,
      facadeConfig: config,
      status: "idle",
      registeredAt: Date.now(),
    };

    children.set(proxyAgentId, child);
    peerToProxy.set(peerId, proxyAgentId);

    if (callbacks.onChildCreated) {
      callbacks.onChildCreated(child);
    }

    return proxyAgentId;
  }

  /**
   * Remove an encapsulated child
   */
  function removeChild(proxyAgentId: string): void {
    const child = children.get(proxyAgentId);
    if (child) {
      children.delete(proxyAgentId);
      peerToProxy.delete(child.peerId);

      if (callbacks.onChildRemoved) {
        callbacks.onChildRemoved(proxyAgentId);
      }
    }
  }

  /**
   * Send a task to an encapsulated agent
   */
  async function sendTask(
    proxyAgentId: string,
    task: string,
    context?: Record<string, unknown>
  ): Promise<{ accepted: boolean; taskId: string }> {
    if (!sendRequest) {
      throw new Error("EncapsulationManager not connected to PeerManager");
    }

    const child = children.get(proxyAgentId);
    if (!child) {
      throw proxyNotFound(proxyAgentId);
    }

    const response = await sendRequest(child.peerId, "encapsulation/task", {
      proxyAgentId,
      task,
      context,
    });

    if (response.error) {
      return { accepted: false, taskId: "" };
    }

    return response.result as { accepted: boolean; taskId: string };
  }

  /**
   * Get an encapsulated child
   */
  function getChild(proxyAgentId: string): EncapsulatedChild | undefined {
    return children.get(proxyAgentId);
  }

  /**
   * List all encapsulated children
   */
  function listChildren(): EncapsulatedChild[] {
    return Array.from(children.values());
  }

  // ─────────────────────────────────────────────────────────────────
  // Child-side Operations
  // ─────────────────────────────────────────────────────────────────

  /**
   * Register with a parent as an encapsulated child
   */
  async function registerWithParent(
    parentPeerId: string,
    config: FacadeConfig
  ): Promise<{ proxyAgentId: string; accepted: boolean; reason?: string }> {
    if (!sendRequest) {
      throw new Error("EncapsulationManager not connected to PeerManager");
    }

    // Check if already registered
    if (parentRegistration) {
      return {
        proxyAgentId: parentRegistration.proxyAgentId,
        accepted: false,
        reason: "Already registered with a parent",
      };
    }

    const response = await sendRequest(parentPeerId, "encapsulation/register", {
      facadeConfig: config,
    });

    if (response.error) {
      return {
        proxyAgentId: "",
        accepted: false,
        reason: response.error.message,
      };
    }

    const result = response.result as { proxyAgentId: string; accepted: boolean; reason?: string };

    if (result.accepted) {
      parentRegistration = {
        parentPeerId,
        proxyAgentId: result.proxyAgentId,
        facadeConfig: config,
        registeredAt: Date.now(),
      };
    }

    return result;
  }

  /**
   * Unregister from a parent
   */
  async function unregisterFromParent(parentPeerId: string): Promise<{ unregistered: boolean }> {
    if (!sendRequest) {
      throw new Error("EncapsulationManager not connected to PeerManager");
    }

    if (!parentRegistration || parentRegistration.parentPeerId !== parentPeerId) {
      return { unregistered: false };
    }

    const response = await sendRequest(parentPeerId, "encapsulation/unregister", {
      proxyAgentId: parentRegistration.proxyAgentId,
    });

    // Clear registration regardless of response
    parentRegistration = undefined;

    if (response.error) {
      return { unregistered: false };
    }

    return response.result as { unregistered: boolean };
  }

  /**
   * Report status to parent
   */
  function reportStatus(status: EncapsulatedStatus, message?: string): void {
    if (!sendMessage || !parentRegistration) {
      return;
    }

    const payload: EncapsulatedStatusPayload = {
      proxyAgentId: parentRegistration.proxyAgentId,
      status,
      message,
    };

    sendMessage(parentRegistration.parentPeerId, "encapsulation/status", payload);
  }

  /**
   * Report task result to parent
   */
  function reportResult(
    taskId: string,
    result: Omit<EncapsulatedResult, "proxyAgentId" | "taskId">
  ): void {
    if (!sendMessage || !parentRegistration) {
      return;
    }

    // Apply error detail level if there's an error
    let processedError = result.error;
    if (processedError) {
      processedError = applyErrorDetailLevel(
        processedError,
        parentRegistration.facadeConfig.errorDetail
      );
    }

    const payload: EncapsulatedResult = {
      proxyAgentId: parentRegistration.proxyAgentId,
      taskId,
      status: result.status,
      result: result.result,
      error: processedError,
    };

    sendMessage(parentRegistration.parentPeerId, "encapsulation/result", payload);

    // Remove from pending tasks
    pendingTasks.delete(taskId);
  }

  /**
   * Get our parent registration
   */
  function getParentRegistration(): ParentRegistration | undefined {
    return parentRegistration;
  }

  // ─────────────────────────────────────────────────────────────────
  // Pattern Handler
  // ─────────────────────────────────────────────────────────────────

  const handler: PatternHandler = {
    async handleRequest(
      from: PeerAddress,
      method: string,
      params: Record<string, unknown>
    ): Promise<HierarchyResponse> {
      switch (method) {
        case "encapsulation/register":
          return handleRegisterRequest(from, params);
        case "encapsulation/unregister":
          return handleUnregisterRequest(from, params);
        case "encapsulation/task":
          return handleTaskRequest(from, params);
        default:
          return {
            error: {
              code: 4005,
              message: "INVALID_REQUEST",
              data: { method, reason: "Unknown encapsulation method" },
            },
          };
      }
    },

    handleMessage(
      from: PeerAddress,
      type: string,
      payload: Record<string, unknown>
    ): void {
      switch (type) {
        case "encapsulation/status":
          handleStatusMessage(from, payload);
          break;
        case "encapsulation/result":
          handleResultMessage(from, payload);
          break;
      }
    },
  };

  function getHandler(): PatternHandler {
    return handler;
  }

  return {
    getHandler,
    // Parent-side
    acceptRegistration,
    removeChild,
    sendTask,
    getChild,
    listChildren,
    // Child-side
    registerWithParent,
    unregisterFromParent,
    reportStatus,
    reportResult,
    getParentRegistration,
    // Setup
    setSendFunctions,
  };
}

// ─────────────────────────────────────────────────────────────────
// Utility Functions
// ─────────────────────────────────────────────────────────────────

/**
 * Generate a proxy agent ID
 */
export function generateProxyAgentId(): string {
  return `proxy_${nanoid(12)}`;
}
