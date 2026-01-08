/**
 * FederationManager - Federated hierarchy pattern for distributed macro-agents
 *
 * Establishes explicit parent-child relationships between macro-agents.
 * Parents can query children's agent trees, mount remote agents into local
 * namespace, and receive status updates.
 *
 * Features:
 * - Explicit federation establishment with bidirectional agreement
 * - Role-based operations (parent vs child)
 * - Optional status subscription for real-time updates
 * - Agent mounting for seamless remote agent integration
 */

import { nanoid } from "nanoid";
import type { PeerAddress } from "./types.js";
import type { PatternHandler, HierarchyResponse } from "./hierarchy-protocol.js";
import {
  capabilityDenied,
  federationRejected,
  federationNotFound,
  remoteAgentNotFound,
  mountDenied,
  alreadyFederated,
  invalidRequest,
} from "./hierarchy-errors.js";
import type { CapabilityManager } from "./capability-manager.js";

// ─────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────

/**
 * Role in a federation relationship
 */
export type FederationRole = "parent" | "child";

/**
 * Agent status in hierarchy
 */
export type AgentStatus = "idle" | "running" | "completed" | "failed" | "paused";

/**
 * Parameters for establishing a federation
 */
export interface EstablishFederationParams {
  /** Role in the federation */
  role: FederationRole;
  /** Parent agent ID to register under (required if role is "child") */
  parentAgentId?: string;
  /** Whether to subscribe to status updates */
  subscribeToStatus: boolean;
}

/**
 * Result of establishing a federation
 */
export interface EstablishFederationResult {
  /** Unique federation ID */
  federationId: string;
  /** Whether the federation was accepted */
  accepted: boolean;
  /** Reason if not accepted */
  reason?: string;
}

/**
 * Parameters for querying hierarchy
 */
export interface HierarchyQueryParams {
  /** Root agent ID to query from (defaults to federation root) */
  rootAgentId?: string;
  /** How deep to traverse (default 1) */
  depth?: number;
}

/**
 * Agent info in hierarchy response
 */
export interface HierarchyAgent {
  /** Agent ID */
  id: string;
  /** Agent name */
  name?: string;
  /** Current status */
  status: AgentStatus;
  /** Number of child agents */
  childCount: number;
}

/**
 * Parent-child relationship in hierarchy
 */
export interface HierarchyRelationship {
  /** Parent agent ID */
  parentId: string;
  /** Child agent ID */
  childId: string;
}

/**
 * Result of hierarchy query
 */
export interface HierarchyResult {
  /** Agents in the hierarchy */
  agents: HierarchyAgent[];
  /** Parent-child relationships */
  relationships: HierarchyRelationship[];
}

/**
 * Parameters for mounting a remote agent
 */
export interface MountParams {
  /** Agent ID in the child's hierarchy */
  targetAgentId: string;
}

/**
 * Result of mounting a remote agent
 */
export interface MountResult {
  /** Local alias for the mounted agent */
  mountedAs: string;
  /** Available capabilities/operations */
  capabilities: string[];
}

/**
 * Status update payload (push message)
 */
export interface FederationStatusPayload {
  /** Federation ID */
  federationId: string;
  /** Agent ID that changed */
  agentId: string;
  /** New status */
  status: AgentStatus;
  /** Optional message */
  message?: string;
  /** Timestamp of change */
  timestamp: number;
}

/**
 * Federation state
 */
export interface Federation {
  /** Unique federation ID */
  id: string;
  /** Remote peer ID */
  peerId: string;
  /** Our role in the federation */
  role: FederationRole;
  /** Parent agent ID (if we're child) */
  parentAgentId?: string;
  /** Whether subscribed to status updates */
  subscribedToStatus: boolean;
  /** Mounted agents: localAlias -> remoteAgentId */
  mountedAgents: Map<string, string>;
  /** When federation was established */
  createdAt: number;
}

/**
 * Callback for federation events
 */
export interface FederationCallbacks {
  /** Called when a federation is requested */
  onFederationRequested?: (
    peerId: string,
    params: EstablishFederationParams
  ) => Promise<{ accepted: boolean; reason?: string }>;
  /** Called when a hierarchy query is received */
  onHierarchyQuery?: (
    federationId: string,
    params: HierarchyQueryParams
  ) => Promise<HierarchyResult>;
  /** Called when a mount is requested */
  onMountRequested?: (
    federationId: string,
    targetAgentId: string
  ) => Promise<MountResult | { denied: true; reason: string }>;
  /** Called when a status update is received */
  onStatusUpdate?: (payload: FederationStatusPayload) => void;
}

// ─────────────────────────────────────────────────────────────────
// FederationManager Interface
// ─────────────────────────────────────────────────────────────────

export interface FederationManagerConfig {
  /** Capability manager for permission checks */
  capabilityManager?: CapabilityManager;
  /** Callbacks for federation events */
  callbacks?: FederationCallbacks;
  /** Maximum concurrent federations (optional) */
  maxFederations?: number;
}

export interface FederationManager {
  /**
   * Get the pattern handler for routing
   */
  getHandler(): PatternHandler;

  /**
   * Establish a federation with a peer
   */
  establish(
    peerId: string,
    params: EstablishFederationParams
  ): Promise<EstablishFederationResult>;

  /**
   * Terminate a federation
   */
  terminate(federationId: string): Promise<{ terminated: boolean }>;

  /**
   * Query hierarchy through a federation
   */
  getHierarchy(
    federationId: string,
    params: HierarchyQueryParams
  ): Promise<HierarchyResult>;

  /**
   * Mount a remote agent locally
   */
  mount(federationId: string, targetAgentId: string): Promise<MountResult>;

  /**
   * Unmount a previously mounted agent
   */
  unmount(federationId: string, localAlias: string): void;

  /**
   * Get a federation by ID
   */
  getFederation(federationId: string): Federation | undefined;

  /**
   * List all active federations
   */
  listFederations(): Federation[];

  /**
   * Get federation by peer ID
   */
  getFederationByPeer(peerId: string): Federation | undefined;

  /**
   * Push status update to subscribed federations
   */
  pushStatusUpdate(agentId: string, status: AgentStatus, message?: string): void;

  /**
   * Set the send functions (injected by PeerManager)
   */
  setSendFunctions(fns: {
    sendRequest: (to: PeerAddress, method: string, params: unknown) => Promise<HierarchyResponse>;
    sendMessage: (to: PeerAddress, type: string, payload: unknown) => Promise<void>;
  }): void;
}

/**
 * Create a FederationManager
 */
export function createFederationManager(
  config: FederationManagerConfig = {}
): FederationManager {
  const { capabilityManager, callbacks = {}, maxFederations } = config;

  // Active federations
  const federations = new Map<string, Federation>();

  // Peer ID to federation ID mapping (for quick lookup)
  const peerToFederation = new Map<string, string>();

  // Send functions (injected by PeerManager)
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
   * Check if peer has federation capability
   */
  function checkCapability(peerId: string, operation: "query" | "mount" | "status"): boolean {
    if (!capabilityManager) {
      return true;
    }

    const caps = capabilityManager.getCapabilities(peerId);
    if (!caps) {
      return false;
    }

    const federationCap = caps.grants.find((g) => g.type === "federated-hierarchy");
    if (!federationCap || federationCap.type !== "federated-hierarchy") {
      return false;
    }

    switch (operation) {
      case "query":
        return federationCap.canQueryAgents;
      case "mount":
        return federationCap.canMount;
      case "status":
        return federationCap.canSubscribeStatus;
      default:
        return false;
    }
  }

  /**
   * Generate a unique federation ID
   */
  function generateFederationId(): string {
    return `fed_${nanoid(12)}`;
  }

  /**
   * Generate local alias for mounted agent
   */
  function generateMountAlias(federationId: string, agentId: string): string {
    return `remote:${agentId}`;
  }

  // ─────────────────────────────────────────────────────────────────
  // Inbound Request Handlers
  // ─────────────────────────────────────────────────────────────────

  /**
   * Handle incoming federation/establish request
   */
  async function handleEstablishRequest(
    from: PeerAddress,
    params: Record<string, unknown>
  ): Promise<HierarchyResponse> {
    const peerId = extractPeerId(from);
    const establishParams = params as unknown as EstablishFederationParams;

    // Check if already federated with this peer
    if (peerToFederation.has(peerId)) {
      return {
        error: alreadyFederated(peerId).toResponseError(),
      };
    }

    // Check federation limit
    if (maxFederations !== undefined && federations.size >= maxFederations) {
      return {
        error: federationRejected(peerId, "Maximum federations reached").toResponseError(),
      };
    }

    // Validate params
    if (!establishParams.role || !["parent", "child"].includes(establishParams.role)) {
      return {
        error: invalidRequest("role must be 'parent' or 'child'").toResponseError(),
      };
    }

    if (establishParams.role === "child" && !establishParams.parentAgentId) {
      return {
        error: invalidRequest("parentAgentId required when role is 'child'").toResponseError(),
      };
    }

    // Check capability for status subscription
    if (establishParams.subscribeToStatus && capabilityManager) {
      if (!checkCapability(peerId, "status")) {
        return {
          error: capabilityDenied("federated-hierarchy (status)", peerId).toResponseError(),
        };
      }
    }

    // Ask callback if we should accept
    if (callbacks.onFederationRequested) {
      try {
        const result = await callbacks.onFederationRequested(peerId, establishParams);
        if (!result.accepted) {
          return {
            error: federationRejected(peerId, result.reason).toResponseError(),
          };
        }
      } catch (err) {
        return {
          error: federationRejected(peerId, err instanceof Error ? err.message : "Federation rejected").toResponseError(),
        };
      }
    }

    // Create federation
    const federation: Federation = {
      id: generateFederationId(),
      peerId,
      // If they are child, we are parent (and vice versa)
      role: establishParams.role === "child" ? "parent" : "child",
      parentAgentId: establishParams.parentAgentId,
      subscribedToStatus: establishParams.subscribeToStatus,
      mountedAgents: new Map(),
      createdAt: Date.now(),
    };

    federations.set(federation.id, federation);
    peerToFederation.set(peerId, federation.id);

    return {
      result: {
        federationId: federation.id,
        accepted: true,
      },
    };
  }

  /**
   * Handle incoming federation/terminate request
   */
  async function handleTerminateRequest(
    from: PeerAddress,
    params: Record<string, unknown>
  ): Promise<HierarchyResponse> {
    const peerId = extractPeerId(from);
    const { federationId } = params as { federationId: string };

    const federation = federations.get(federationId);
    if (!federation) {
      return {
        error: federationNotFound(federationId).toResponseError(),
      };
    }

    // Verify the request is from the correct peer
    if (federation.peerId !== peerId) {
      return {
        error: federationNotFound(federationId).toResponseError(),
      };
    }

    // Clean up
    federations.delete(federationId);
    peerToFederation.delete(peerId);

    return {
      result: { terminated: true },
    };
  }

  /**
   * Handle incoming federation/getHierarchy request
   */
  async function handleGetHierarchyRequest(
    from: PeerAddress,
    params: Record<string, unknown>
  ): Promise<HierarchyResponse> {
    const peerId = extractPeerId(from);

    // Check capability
    if (!checkCapability(peerId, "query")) {
      return {
        error: capabilityDenied("federated-hierarchy (query)", peerId).toResponseError(),
      };
    }

    // Find federation for this peer
    const federationId = peerToFederation.get(peerId);
    if (!federationId) {
      return {
        error: federationNotFound("unknown").toResponseError(),
      };
    }

    const federation = federations.get(federationId);
    if (!federation) {
      return {
        error: federationNotFound(federationId).toResponseError(),
      };
    }

    // Only parents can query hierarchy
    if (federation.role !== "child") {
      return {
        error: capabilityDenied("federated-hierarchy (query)", peerId).toResponseError(),
      };
    }

    const queryParams = params as unknown as HierarchyQueryParams;

    // Ask callback for hierarchy data
    if (callbacks.onHierarchyQuery) {
      try {
        const result = await callbacks.onHierarchyQuery(federationId, queryParams);
        return { result };
      } catch (err) {
        return {
          error: {
            code: 4006,
            message: "INTERNAL_ERROR",
            data: { error: err instanceof Error ? err.message : String(err) },
          },
        };
      }
    }

    // No callback - return empty hierarchy
    return {
      result: {
        agents: [],
        relationships: [],
      },
    };
  }

  /**
   * Handle incoming federation/mount request
   */
  async function handleMountRequest(
    from: PeerAddress,
    params: Record<string, unknown>
  ): Promise<HierarchyResponse> {
    const peerId = extractPeerId(from);

    // Check capability
    if (!checkCapability(peerId, "mount")) {
      return {
        error: capabilityDenied("federated-hierarchy (mount)", peerId).toResponseError(),
      };
    }

    // Find federation for this peer
    const federationId = peerToFederation.get(peerId);
    if (!federationId) {
      return {
        error: federationNotFound("unknown").toResponseError(),
      };
    }

    const federation = federations.get(federationId);
    if (!federation) {
      return {
        error: federationNotFound(federationId).toResponseError(),
      };
    }

    // Only parents can mount agents
    if (federation.role !== "child") {
      return {
        error: capabilityDenied("federated-hierarchy (mount)", peerId).toResponseError(),
      };
    }

    const mountParams = params as unknown as MountParams;
    if (!mountParams.targetAgentId) {
      return {
        error: invalidRequest("targetAgentId is required").toResponseError(),
      };
    }

    // Ask callback if mount is allowed
    if (callbacks.onMountRequested) {
      try {
        const result = await callbacks.onMountRequested(federationId, mountParams.targetAgentId);
        if ("denied" in result && result.denied) {
          return {
            error: mountDenied(mountParams.targetAgentId, result.reason).toResponseError(),
          };
        }
        return { result };
      } catch (err) {
        return {
          error: mountDenied(mountParams.targetAgentId, err instanceof Error ? err.message : "Mount denied").toResponseError(),
        };
      }
    }

    // Default: allow mount
    const alias = generateMountAlias(federationId, mountParams.targetAgentId);
    return {
      result: {
        mountedAs: alias,
        capabilities: ["message", "query"],
      },
    };
  }

  /**
   * Handle incoming federation/status message
   */
  function handleStatusMessage(
    from: PeerAddress,
    payload: Record<string, unknown>
  ): void {
    const statusPayload = payload as unknown as FederationStatusPayload;

    if (callbacks.onStatusUpdate) {
      callbacks.onStatusUpdate(statusPayload);
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // Outbound Operations
  // ─────────────────────────────────────────────────────────────────

  /**
   * Establish a federation with a peer
   */
  async function establish(
    peerId: string,
    params: EstablishFederationParams
  ): Promise<EstablishFederationResult> {
    if (!sendRequest) {
      throw new Error("FederationManager not connected to PeerManager");
    }

    // Check if already federated
    if (peerToFederation.has(peerId)) {
      return {
        federationId: peerToFederation.get(peerId)!,
        accepted: false,
        reason: "Already federated with this peer",
      };
    }

    // Send establish request
    const response = await sendRequest(peerId, "federation/establish", params);

    if (response.error) {
      return {
        federationId: "",
        accepted: false,
        reason: response.error.message,
      };
    }

    const result = response.result as { federationId: string; accepted: boolean; reason?: string };

    if (result.accepted) {
      // Store federation locally
      const federation: Federation = {
        id: result.federationId,
        peerId,
        role: params.role,
        parentAgentId: params.parentAgentId,
        subscribedToStatus: params.subscribeToStatus,
        mountedAgents: new Map(),
        createdAt: Date.now(),
      };

      federations.set(federation.id, federation);
      peerToFederation.set(peerId, federation.id);
    }

    return result;
  }

  /**
   * Terminate a federation
   */
  async function terminate(federationId: string): Promise<{ terminated: boolean }> {
    if (!sendRequest) {
      throw new Error("FederationManager not connected to PeerManager");
    }

    const federation = federations.get(federationId);
    if (!federation) {
      return { terminated: false };
    }

    // Send terminate request
    const response = await sendRequest(federation.peerId, "federation/terminate", {
      federationId,
    });

    // Clean up locally regardless of response
    federations.delete(federationId);
    peerToFederation.delete(federation.peerId);

    if (response.error) {
      return { terminated: false };
    }

    return response.result as { terminated: boolean };
  }

  /**
   * Query hierarchy through a federation
   */
  async function getHierarchy(
    federationId: string,
    params: HierarchyQueryParams
  ): Promise<HierarchyResult> {
    if (!sendRequest) {
      throw new Error("FederationManager not connected to PeerManager");
    }

    const federation = federations.get(federationId);
    if (!federation) {
      throw federationNotFound(federationId);
    }

    // Only parents can query hierarchy
    if (federation.role !== "parent") {
      throw capabilityDenied("federated-hierarchy (query)", federation.peerId);
    }

    const response = await sendRequest(federation.peerId, "federation/getHierarchy", params);

    if (response.error) {
      throw new Error(response.error.message);
    }

    return response.result as HierarchyResult;
  }

  /**
   * Mount a remote agent locally
   */
  async function mount(federationId: string, targetAgentId: string): Promise<MountResult> {
    if (!sendRequest) {
      throw new Error("FederationManager not connected to PeerManager");
    }

    const federation = federations.get(federationId);
    if (!federation) {
      throw federationNotFound(federationId);
    }

    // Only parents can mount
    if (federation.role !== "parent") {
      throw capabilityDenied("federated-hierarchy (mount)", federation.peerId);
    }

    const response = await sendRequest(federation.peerId, "federation/mount", {
      targetAgentId,
    });

    if (response.error) {
      throw new Error(response.error.message);
    }

    const result = response.result as MountResult;

    // Track the mounted agent
    federation.mountedAgents.set(result.mountedAs, targetAgentId);

    return result;
  }

  /**
   * Unmount a previously mounted agent
   */
  function unmount(federationId: string, localAlias: string): void {
    const federation = federations.get(federationId);
    if (federation) {
      federation.mountedAgents.delete(localAlias);
    }
  }

  /**
   * Get a federation by ID
   */
  function getFederation(federationId: string): Federation | undefined {
    return federations.get(federationId);
  }

  /**
   * List all active federations
   */
  function listFederations(): Federation[] {
    return Array.from(federations.values());
  }

  /**
   * Get federation by peer ID
   */
  function getFederationByPeer(peerId: string): Federation | undefined {
    const federationId = peerToFederation.get(peerId);
    return federationId ? federations.get(federationId) : undefined;
  }

  /**
   * Push status update to subscribed federations
   */
  function pushStatusUpdate(agentId: string, status: AgentStatus, message?: string): void {
    if (!sendMessage) {
      return;
    }

    // Find federations where we are child and peer is subscribed
    for (const federation of federations.values()) {
      if (federation.role === "child" && federation.subscribedToStatus) {
        const payload: FederationStatusPayload = {
          federationId: federation.id,
          agentId,
          status,
          message,
          timestamp: Date.now(),
        };

        sendMessage(federation.peerId, "federation/status", payload);
      }
    }
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
        case "federation/establish":
          return handleEstablishRequest(from, params);
        case "federation/terminate":
          return handleTerminateRequest(from, params);
        case "federation/getHierarchy":
          return handleGetHierarchyRequest(from, params);
        case "federation/mount":
          return handleMountRequest(from, params);
        default:
          return {
            error: {
              code: 4005,
              message: "INVALID_REQUEST",
              data: { method, reason: "Unknown federation method" },
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
        case "federation/status":
          handleStatusMessage(from, payload);
          break;
      }
    },
  };

  function getHandler(): PatternHandler {
    return handler;
  }

  return {
    getHandler,
    establish,
    terminate,
    getHierarchy,
    mount,
    unmount,
    getFederation,
    listFederations,
    getFederationByPeer,
    pushStatusUpdate,
    setSendFunctions,
  };
}

// ─────────────────────────────────────────────────────────────────
// Utility Functions
// ─────────────────────────────────────────────────────────────────

/**
 * Generate a unique federation ID
 */
export function generateFederationId(): string {
  return `fed_${nanoid(12)}`;
}
