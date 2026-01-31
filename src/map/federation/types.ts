/**
 * MAP Federation Types
 *
 * Types for cross-system federation between MAP-compliant systems.
 * Federation enables macro-agent instances to communicate with each other
 * and with other MAP systems.
 *
 * @see specs/s-5qir_map_integration_for_macro_agent.md
 */

import type { SystemId } from "../types.js";

// =============================================================================
// Federation Configuration
// =============================================================================

/**
 * Configuration for a federated peer system.
 */
export interface MAPPeerConfig {
  /** System identifier of the peer */
  systemId: SystemId;

  /** WebSocket endpoint URL for the peer */
  endpoint: string;

  /** Whether to connect automatically on startup (default: false) */
  autoConnect?: boolean;

  /** Authentication configuration */
  auth?: {
    method: "bearer" | "api-key" | "mutual-tls";
    credentials: unknown;
  };
}

/**
 * Configuration for MAP federation.
 */
export interface MAPFederationConfig {
  /** Whether federation is enabled */
  enabled: boolean;

  /** This system's identifier (e.g., "example.com/macro-agent/prod-east") */
  systemId: SystemId;

  /** System metadata for capability advertisement */
  systemInfo?: {
    /** Human-readable system name */
    name?: string;
    /** System version */
    version?: string;
  };

  /** Pre-configured peer systems */
  peers?: MAPPeerConfig[];
}

// =============================================================================
// Capability Advertisement
// =============================================================================

/**
 * Messaging capabilities advertised by a system.
 */
export interface MessagingCapabilities {
  /** Can send messages to this system */
  canSend: boolean;
  /** Can receive messages from this system */
  canReceive: boolean;
}

/**
 * Lifecycle capabilities advertised by a system.
 */
export interface LifecycleCapabilities {
  /** Can spawn agents in this system */
  canSpawn: boolean;
  /** Can stop agents in this system */
  canStop: boolean;
}

/**
 * Query capabilities advertised by a system.
 */
export interface QueryCapabilities {
  /** Can list agents in this system */
  canListAgents: boolean;
  /** Can query agent details */
  canGetAgent: boolean;
  /** Can query hierarchy */
  canQueryHierarchy: boolean;
}

/**
 * Capabilities advertised by a federated system.
 * Exchanged during federation connection establishment.
 */
export interface FederationCapabilities {
  /** System identifier */
  systemId: SystemId;

  /** System metadata */
  systemInfo?: {
    name?: string;
    version?: string;
  };

  /** Messaging capabilities */
  messaging: MessagingCapabilities;

  /** Agent lifecycle capabilities */
  lifecycle: LifecycleCapabilities;

  /** Query capabilities */
  query: QueryCapabilities;

  /** Supported extension methods (e.g., ["_macro/task/*", "_macro/wake"]) */
  extensions: string[];
}

// =============================================================================
// Connected Peer State
// =============================================================================

/**
 * Connection status for a federated peer.
 */
export type PeerConnectionStatus =
  | "connecting"
  | "connected"
  | "disconnecting"
  | "disconnected"
  | "error";

/**
 * State of a connected federated peer.
 */
export interface ConnectedPeer {
  /** System identifier of the peer */
  systemId: SystemId;

  /** Peer's advertised capabilities */
  capabilities: FederationCapabilities;

  /** Connection status */
  status: PeerConnectionStatus;

  /** Timestamp when connection was established */
  connectedAt: number;

  /** Last activity timestamp */
  lastActivityAt: number;

  /** Error message if status is "error" */
  error?: string;
}

// =============================================================================
// Federation Events
// =============================================================================

/**
 * Events emitted by the federation handler.
 */
export type FederationEventType =
  | "peer:connecting"
  | "peer:connected"
  | "peer:disconnected"
  | "peer:error"
  | "peer:capabilities_updated";

/**
 * Base federation event.
 */
export interface FederationEventBase {
  type: FederationEventType;
  systemId: SystemId;
  timestamp: number;
}

/**
 * Peer connecting event.
 */
export interface PeerConnectingEvent extends FederationEventBase {
  type: "peer:connecting";
}

/**
 * Peer connected event.
 */
export interface PeerConnectedEvent extends FederationEventBase {
  type: "peer:connected";
  capabilities: FederationCapabilities;
}

/**
 * Peer disconnected event.
 */
export interface PeerDisconnectedEvent extends FederationEventBase {
  type: "peer:disconnected";
  reason?: string;
}

/**
 * Peer error event.
 */
export interface PeerErrorEvent extends FederationEventBase {
  type: "peer:error";
  error: string;
}

/**
 * Peer capabilities updated event.
 */
export interface PeerCapabilitiesUpdatedEvent extends FederationEventBase {
  type: "peer:capabilities_updated";
  capabilities: FederationCapabilities;
}

/**
 * Union of all federation events.
 */
export type FederationEvent =
  | PeerConnectingEvent
  | PeerConnectedEvent
  | PeerDisconnectedEvent
  | PeerErrorEvent
  | PeerCapabilitiesUpdatedEvent;

/**
 * Handler for federation events.
 */
export type FederationEventHandler = (event: FederationEvent) => void;

// =============================================================================
// Federation Handler Interface
// =============================================================================

/**
 * Interface for federation handling.
 * Wraps the lower-level PeerManager with MAP semantics.
 */
export interface FederationHandler {
  /**
   * Connect to a federated peer system.
   * @param config - Peer configuration
   * @returns Peer's capabilities on successful connection
   */
  connect(config: MAPPeerConfig): Promise<FederationCapabilities>;

  /**
   * Disconnect from a federated peer.
   * @param systemId - System identifier of the peer
   */
  disconnect(systemId: SystemId): Promise<void>;

  /**
   * Get a connected peer by system ID.
   * @param systemId - System identifier
   */
  getPeer(systemId: SystemId): ConnectedPeer | undefined;

  /**
   * List all connected peers.
   */
  listPeers(): ConnectedPeer[];

  /**
   * Get capabilities of a connected peer.
   * @param systemId - System identifier
   */
  getCapabilities(systemId: SystemId): FederationCapabilities | undefined;

  /**
   * Check if a peer is connected.
   * @param systemId - System identifier
   */
  isConnected(systemId: SystemId): boolean;

  /**
   * Send a message to a federated system.
   * Used internally by MessageRouter for federated addresses.
   */
  sendMessage(
    systemId: SystemId,
    message: unknown
  ): Promise<void>;

  /**
   * Send a request to a federated system and wait for response.
   */
  sendRequest(
    systemId: SystemId,
    method: string,
    params?: unknown
  ): Promise<unknown>;

  /**
   * Subscribe to federation events.
   */
  on(handler: FederationEventHandler): () => void;

  /**
   * Get this system's configuration.
   */
  getConfig(): MAPFederationConfig;

  /**
   * Get this system's capabilities (for advertisement).
   */
  getLocalCapabilities(): FederationCapabilities;
}

// =============================================================================
// Error Types
// =============================================================================

/**
 * Error codes for federation operations.
 */
export type FederationErrorCode =
  | "PEER_NOT_FOUND"
  | "PEER_NOT_CONNECTED"
  | "PEER_ALREADY_CONNECTED"
  | "CONNECTION_FAILED"
  | "CONNECTION_TIMEOUT"
  | "CAPABILITY_DENIED"
  | "INVALID_SYSTEM_ID"
  | "FEDERATION_DISABLED";

/**
 * Error thrown by federation operations.
 */
export class FederationError extends Error {
  constructor(
    message: string,
    public readonly code: FederationErrorCode,
    public readonly systemId?: SystemId
  ) {
    super(message);
    this.name = "FederationError";
  }
}
