/**
 * FederationHandler - MAP Federation Implementation
 *
 * Wraps the existing PeerManager infrastructure with MAP semantics,
 * providing cross-system communication capabilities.
 *
 * @see specs/s-5qir_map_integration_for_macro_agent.md
 */

import type { PeerManager } from "../../peer/peer-manager.js";
import type { PeerTransport, PeerMessage, PeerRequest, PeerResponse } from "../../peer/types.js";
import type { SystemId, FederatedAddress } from "../types.js";
import { isFederatedAgentAddress, isFederatedScopeAddress } from "../types.js";
import type {
  FederationHandler,
  MAPFederationConfig,
  MAPPeerConfig,
  FederationCapabilities,
  ConnectedPeer,
  PeerConnectionStatus,
  FederationEvent,
  FederationEventHandler,
} from "./types.js";
import { FederationError } from "./types.js";
import { wrapMessage, unwrapMessage, isEnvelope, type FederationEnvelope } from "./envelope.js";

// =============================================================================
// Constants
// =============================================================================

/** Protocol method for capability exchange */
const CAPABILITY_EXCHANGE_METHOD = "_federation/capabilities";

/** Protocol method for federated messages */
const FEDERATED_MESSAGE_TYPE = "_federation/message";

// =============================================================================
// Implementation
// =============================================================================

/**
 * Create a FederationHandler instance.
 *
 * @param peerManager - The PeerManager to use for transport
 * @param config - Federation configuration
 * @returns FederationHandler instance
 */
export function createFederationHandler(
  peerManager: PeerManager,
  config: MAPFederationConfig
): FederationHandler {
  // State
  const peers = new Map<SystemId, ConnectedPeer>();
  const eventHandlers = new Set<FederationEventHandler>();

  // Build local capabilities from config
  const localCapabilities: FederationCapabilities = {
    systemId: config.systemId,
    systemInfo: config.systemInfo,
    messaging: { canSend: true, canReceive: true },
    lifecycle: { canSpawn: false, canStop: false },
    query: { canListAgents: true, canGetAgent: true, canQueryHierarchy: true },
    extensions: ["_macro/task/*", "_macro/wake", "_macro/workspace/info"],
  };

  // ==========================================================================
  // Event Emission
  // ==========================================================================

  function emit(event: FederationEvent): void {
    for (const handler of eventHandlers) {
      try {
        handler(event);
      } catch (err) {
        console.error("[federation] Event handler error:", err);
      }
    }
  }

  // ==========================================================================
  // Peer Management
  // ==========================================================================

  function updatePeerStatus(systemId: SystemId, status: PeerConnectionStatus, error?: string): void {
    const peer = peers.get(systemId);
    if (peer) {
      peer.status = status;
      peer.lastActivityAt = Date.now();
      if (error) {
        peer.error = error;
      } else {
        delete peer.error;
      }
    }
  }

  // ==========================================================================
  // FederationHandler Implementation
  // ==========================================================================

  async function connect(peerConfig: MAPPeerConfig): Promise<FederationCapabilities> {
    if (!config.enabled) {
      throw new FederationError(
        "Federation is not enabled",
        "FEDERATION_DISABLED"
      );
    }

    const { systemId } = peerConfig;

    // Check if already connected
    const existing = peers.get(systemId);
    if (existing && existing.status === "connected") {
      throw new FederationError(
        `Already connected to ${systemId}`,
        "PEER_ALREADY_CONNECTED",
        systemId
      );
    }

    // Emit connecting event
    emit({
      type: "peer:connecting",
      systemId,
      timestamp: Date.now(),
    });

    // Create initial peer state
    const peer: ConnectedPeer = {
      systemId,
      capabilities: {
        systemId,
        messaging: { canSend: false, canReceive: false },
        lifecycle: { canSpawn: false, canStop: false },
        query: { canListAgents: false, canGetAgent: false, canQueryHierarchy: false },
        extensions: [],
      },
      status: "connecting",
      connectedAt: Date.now(),
      lastActivityAt: Date.now(),
    };
    peers.set(systemId, peer);

    try {
      // Exchange capabilities with peer
      const response = await peerManager.sendRequest(
        config.systemId as string,
        systemId,
        {
          method: CAPABILITY_EXCHANGE_METHOD,
          params: localCapabilities,
        }
      );

      if (response.error) {
        throw new FederationError(
          response.error.message,
          "CONNECTION_FAILED",
          systemId
        );
      }

      // Parse peer capabilities from response
      const peerCapabilities = response.result as FederationCapabilities;

      // Update peer state
      peer.capabilities = peerCapabilities;
      peer.status = "connected";
      peer.lastActivityAt = Date.now();

      // Emit connected event
      emit({
        type: "peer:connected",
        systemId,
        timestamp: Date.now(),
        capabilities: peerCapabilities,
      });

      return peerCapabilities;
    } catch (err) {
      // Update peer state on error
      updatePeerStatus(systemId, "error", err instanceof Error ? err.message : "Unknown error");

      // Emit error event
      emit({
        type: "peer:error",
        systemId,
        timestamp: Date.now(),
        error: err instanceof Error ? err.message : "Unknown error",
      });

      // Clean up on failure
      peers.delete(systemId);

      if (err instanceof FederationError) {
        throw err;
      }

      throw new FederationError(
        `Failed to connect to ${systemId}: ${err instanceof Error ? err.message : "Unknown error"}`,
        "CONNECTION_FAILED",
        systemId
      );
    }
  }

  async function disconnect(systemId: SystemId): Promise<void> {
    const peer = peers.get(systemId);
    if (!peer) {
      throw new FederationError(
        `Not connected to ${systemId}`,
        "PEER_NOT_FOUND",
        systemId
      );
    }

    // Update status
    updatePeerStatus(systemId, "disconnecting");

    // Remove peer
    peers.delete(systemId);

    // Emit disconnected event
    emit({
      type: "peer:disconnected",
      systemId,
      timestamp: Date.now(),
      reason: "Manual disconnect",
    });
  }

  function getPeer(systemId: SystemId): ConnectedPeer | undefined {
    return peers.get(systemId);
  }

  function listPeers(): ConnectedPeer[] {
    return Array.from(peers.values());
  }

  function getCapabilities(systemId: SystemId): FederationCapabilities | undefined {
    const peer = peers.get(systemId);
    return peer?.capabilities;
  }

  function isConnected(systemId: SystemId): boolean {
    const peer = peers.get(systemId);
    return peer?.status === "connected";
  }

  async function sendMessage(systemId: SystemId, message: unknown): Promise<void> {
    if (!config.enabled) {
      throw new FederationError(
        "Federation is not enabled",
        "FEDERATION_DISABLED"
      );
    }

    const peer = peers.get(systemId);
    if (!peer) {
      throw new FederationError(
        `Not connected to ${systemId}`,
        "PEER_NOT_FOUND",
        systemId
      );
    }

    if (peer.status !== "connected") {
      throw new FederationError(
        `Peer ${systemId} is not connected (status: ${peer.status})`,
        "PEER_NOT_CONNECTED",
        systemId
      );
    }

    // Wrap message in federation envelope
    const envelope = wrapMessage(message, config.systemId, systemId);

    // Send via PeerManager
    await peerManager.sendMessage(
      config.systemId as string,
      systemId,
      {
        type: FEDERATED_MESSAGE_TYPE,
        payload: envelope,
      }
    );

    // Update activity timestamp
    peer.lastActivityAt = Date.now();
  }

  async function sendRequest(
    systemId: SystemId,
    method: string,
    params?: unknown
  ): Promise<unknown> {
    if (!config.enabled) {
      throw new FederationError(
        "Federation is not enabled",
        "FEDERATION_DISABLED"
      );
    }

    const peer = peers.get(systemId);
    if (!peer) {
      throw new FederationError(
        `Not connected to ${systemId}`,
        "PEER_NOT_FOUND",
        systemId
      );
    }

    if (peer.status !== "connected") {
      throw new FederationError(
        `Peer ${systemId} is not connected (status: ${peer.status})`,
        "PEER_NOT_CONNECTED",
        systemId
      );
    }

    // Send request via PeerManager
    const response = await peerManager.sendRequest(
      config.systemId as string,
      systemId,
      { method, params }
    );

    // Update activity timestamp
    peer.lastActivityAt = Date.now();

    if (response.error) {
      throw new FederationError(
        response.error.message,
        "CAPABILITY_DENIED",
        systemId
      );
    }

    return response.result;
  }

  function on(handler: FederationEventHandler): () => void {
    eventHandlers.add(handler);
    return () => {
      eventHandlers.delete(handler);
    };
  }

  function getConfig(): MAPFederationConfig {
    return config;
  }

  function getLocalCapabilities(): FederationCapabilities {
    return localCapabilities;
  }

  // ==========================================================================
  // Return Handler
  // ==========================================================================

  return {
    connect,
    disconnect,
    getPeer,
    listPeers,
    getCapabilities,
    isConnected,
    sendMessage,
    sendRequest,
    on,
    getConfig,
    getLocalCapabilities,
  };
}

// =============================================================================
// Address Utilities
// =============================================================================

/**
 * Convert a federated address to a peer address.
 *
 * @param address - The federated address
 * @returns The peer address string
 */
export function federatedAddressToPeerAddress(address: FederatedAddress): string {
  if (isFederatedAgentAddress(address)) {
    return `${address.system}/${address.agent}`;
  }
  if (isFederatedScopeAddress(address)) {
    // For scope addresses, route to the system root
    return address.system;
  }
  return address.system;
}

/**
 * Extract the system ID from a federated address.
 *
 * @param address - The federated address
 * @returns The system ID
 */
export function getSystemFromAddress(address: FederatedAddress): SystemId {
  return address.system;
}

// =============================================================================
// Message Handling Utilities
// =============================================================================

/**
 * Create a capability exchange request handler.
 * This should be registered with PeerManager to handle incoming capability requests.
 *
 * @param localCapabilities - This system's capabilities
 * @returns Handler function
 */
export function createCapabilityExchangeHandler(
  localCapabilities: FederationCapabilities
): (request: PeerRequest) => PeerResponse {
  return (request: PeerRequest): PeerResponse => {
    if (request.method === CAPABILITY_EXCHANGE_METHOD) {
      return { result: localCapabilities };
    }
    return { error: { code: -32601, message: "Method not found" } };
  };
}

/**
 * Unwrap a federated message from a peer message.
 *
 * @param message - The peer message
 * @returns The unwrapped message or null if not a federated message
 */
export function unwrapFederatedMessage(message: PeerMessage): unknown | null {
  if (message.type !== FEDERATED_MESSAGE_TYPE) {
    return null;
  }

  if (!isEnvelope(message.payload)) {
    return null;
  }

  return unwrapMessage(message.payload as FederationEnvelope);
}
