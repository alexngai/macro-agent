/**
 * Peer communication type definitions
 *
 * These types define the interfaces for inter-macro-agent communication.
 * The design is transport-agnostic - the client injects the actual transport
 * implementation via callbacks.
 */

import type { AgentId } from "../store/types/index.js";

/**
 * Peer address format: "peerId" or "peerId/agentId"
 * - "peerId" routes to the root agent of that peer
 * - "peerId/agentId" routes to a specific internal agent within the peer
 */
export type PeerAddress = string;

/**
 * Parsed peer address
 */
export interface ParsedPeerAddress {
  peerId: string;
  agentId?: AgentId;
}

/**
 * Message sent between peers (fire-and-forget)
 */
export interface PeerMessage {
  /** Message type for routing/handling */
  type: string;
  /** Message payload */
  payload: unknown;
  /** Optional metadata */
  metadata?: {
    /** Correlation ID for relating messages to requests/tasks */
    correlationId?: string;
    /** Timestamp when message was created */
    timestamp?: number;
    /** Additional metadata */
    [key: string]: unknown;
  };
}

/**
 * Request sent to a peer (expects response)
 */
export interface PeerRequest {
  /** Request method name */
  method: string;
  /** Request parameters */
  params?: unknown;
  /** Timeout hint in milliseconds (not enforced by macro-agent) */
  timeout?: number;
}

/**
 * Response from a peer request
 */
export interface PeerResponse {
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
 * Transport interface that the client provides to macro-agent.
 * The client is responsible for the actual network/IPC communication.
 */
export interface PeerTransport {
  /**
   * Send a fire-and-forget message to a peer.
   * @param address - Peer address ("peerId" or "peerId/agentId")
   * @param message - The message to send
   */
  sendMessage(address: PeerAddress, message: PeerMessage): Promise<void>;

  /**
   * Send a request to a peer and wait for response.
   * @param address - Peer address ("peerId" or "peerId/agentId")
   * @param request - The request to send
   * @returns The peer's response
   */
  sendRequest(address: PeerAddress, request: PeerRequest): Promise<PeerResponse>;
}

/**
 * Handler interface that macro-agent provides to the client for routing inbound messages.
 */
export interface PeerHandler {
  /**
   * Handle an inbound message from a peer.
   * @param from - Source peer address
   * @param message - The received message
   */
  handleMessage(from: PeerAddress, message: PeerMessage): void;

  /**
   * Handle an inbound request from a peer.
   * @param from - Source peer address
   * @param request - The received request
   * @returns Response to send back to the peer
   */
  handleRequest(from: PeerAddress, request: PeerRequest): Promise<PeerResponse>;
}

/**
 * Configuration for peer message persistence
 */
export interface PeerConfig {
  /** Whether to persist peer messages in EventStore (default: false) */
  persistMessages?: boolean;
  /** Whether to persist peer requests in EventStore (default: false) */
  persistRequests?: boolean;
  /** Default timeout for requests in milliseconds (default: 30000) */
  defaultRequestTimeout?: number;
}

/**
 * Internal representation of a pending request
 */
export interface PendingRequest {
  /** Unique request ID */
  requestId: string;
  /** Source peer address */
  from: PeerAddress;
  /** The request */
  request: PeerRequest;
  /** Resolve function for the response promise */
  resolve: (response: PeerResponse) => void;
  /** Timeout handle */
  timeout: ReturnType<typeof setTimeout>;
  /** Target agent ID within this macro-agent */
  targetAgentId: AgentId;
  /** Timestamp when request was received */
  timestamp: number;
}

/**
 * Message as it appears in an agent's inbox (with peer source prefix)
 */
export interface PeerInboxMessage {
  /** Original message ID or generated ID */
  id: string;
  /** Source in format "peer:peerId" or "peer:peerId/agentId" */
  from: string;
  /** Message type */
  type: string;
  /** Message payload */
  payload: unknown;
  /** Timestamp */
  timestamp: number;
  /** Correlation ID if provided */
  correlationId?: string;
  /** Whether this is a request requiring a response */
  isRequest?: boolean;
  /** Request ID if this is a request */
  requestId?: string;
}

/**
 * Error thrown when peer operations fail
 */
export class PeerError extends Error {
  constructor(
    message: string,
    public readonly code: PeerErrorCode,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = "PeerError";
  }
}

export type PeerErrorCode =
  | "NO_TRANSPORT"
  | "INVALID_ADDRESS"
  | "AGENT_NOT_FOUND"
  | "REQUEST_TIMEOUT"
  | "REQUEST_NOT_FOUND"
  | "TRANSPORT_ERROR"
  | "CAPABILITY_DENIED";

// ─────────────────────────────────────────────────────────────────
// Capability Types
// ─────────────────────────────────────────────────────────────────

/**
 * Capability grant for task delegation pattern.
 * Allows a peer to delegate discrete tasks.
 */
export interface TaskDelegationCapability {
  type: "task-delegation";
  /** Maximum concurrent tasks this peer can delegate (optional) */
  maxConcurrentTasks?: number;
}

/**
 * Capability grant for federated hierarchy pattern.
 * Allows establishing parent-child relationships.
 */
export interface FederatedHierarchyCapability {
  type: "federated-hierarchy";
  /** Can query the agent hierarchy */
  canQueryAgents: boolean;
  /** Can mount remote agents locally */
  canMount: boolean;
  /** Can subscribe to status updates */
  canSubscribeStatus: boolean;
  /** Restrict to specific agent IDs (optional) */
  allowedAgentIds?: string[];
}

/**
 * Capability grant for transparent encapsulation pattern.
 * Allows registering as encapsulated child or accepting encapsulated children.
 */
export interface EncapsulationCapability {
  type: "encapsulation";
  /** Can register as an encapsulated child */
  canActAsChild: boolean;
  /** Can accept encapsulated children */
  canActAsParent: boolean;
}

/**
 * Union of all capability grant types
 */
export type CapabilityGrant =
  | TaskDelegationCapability
  | FederatedHierarchyCapability
  | EncapsulationCapability;

/**
 * Type helper to extract capability type string
 */
export type CapabilityType = CapabilityGrant["type"];

/**
 * Full capability set for a peer
 */
export interface PeerCapabilities {
  /** Peer ID these capabilities apply to */
  peerId: string;
  /** Granted capabilities */
  grants: CapabilityGrant[];
  /** When capabilities were issued (ms since epoch) */
  issuedAt: number;
  /** When capabilities expire (ms since epoch, optional) */
  expiresAt?: number;
  /** Who issued these capabilities (for audit trail) */
  issuedBy?: string;
}

/**
 * Options for granting capabilities
 */
export interface GrantCapabilityOptions {
  /** Time until expiration in milliseconds */
  expiresIn?: number;
  /** Issuer identifier for audit trail */
  issuedBy?: string;
}

// ─────────────────────────────────────────────────────────────────
// Failure Configuration Types
// ─────────────────────────────────────────────────────────────────

/**
 * Disconnect behavior options for federation
 */
export type FederationDisconnectBehavior =
  | "orphan"     // Continue operating independently
  | "abort"      // Terminate active tasks, enter error state
  | "reconnect"; // Wait for reconnection, buffer updates

/**
 * Configuration for federation failure handling
 */
export interface FederationConfig {
  /** Behavior when parent disconnects (for child) */
  onParentDisconnect: FederationDisconnectBehavior;
  /** Behavior when child disconnects (for parent) */
  onChildDisconnect: FederationDisconnectBehavior;
  /** Timeout in ms before giving up on reconnection */
  reconnectTimeout?: number;
  /** Maximum reconnection attempts */
  maxReconnectAttempts?: number;
}

/**
 * Error detail level for encapsulation facade
 */
export type ErrorDetailLevel =
  | "opaque"   // Only "failed" with generic message
  | "summary"  // Error category and brief description
  | "full";    // Complete error chain (trusted peers only)

/**
 * Configuration for encapsulation facade
 */
export interface FacadeConfig {
  /** How much error detail to expose to parent */
  errorDetail: ErrorDetailLevel;
  /** Display name in parent's hierarchy */
  name?: string;
  /** Advertised capabilities */
  capabilities?: string[];
}

/**
 * Default federation configuration
 */
export const DEFAULT_FEDERATION_CONFIG: FederationConfig = {
  onParentDisconnect: "orphan",
  onChildDisconnect: "orphan",
  reconnectTimeout: 30000,
  maxReconnectAttempts: 3,
};

/**
 * Default facade configuration
 */
export const DEFAULT_FACADE_CONFIG: FacadeConfig = {
  errorDetail: "summary",
};
