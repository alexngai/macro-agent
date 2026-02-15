/**
 * MAPAdapter Interface
 *
 * Defines the interface for the MAP adapter layer that handles external
 * client connections to macro-agent via the Multi-Agent Protocol.
 *
 * The adapter sits at the external boundary, handling:
 * - JSON-RPC protocol (via BaseConnection from MAP SDK)
 * - Connection/participant lifecycle
 * - External subscription management
 * - Extension method dispatch (`_macro/*` methods)
 * - Event streaming to subscribers
 * - Auth/permission checks
 *
 * Does NOT own:
 * - Address resolution (delegates to MessageRouter)
 * - Wake/delivery decisions (delegates to MessageRouter)
 * - Agent process lifecycle (delegates to AgentManager)
 * - Internal agent-to-agent routing
 *
 * @see specs/s-5qir_map_integration_for_macro_agent.md
 */

import type {
  ParticipantId,
  ParticipantType,
  ParticipantCapabilities,
  ConnectedParticipant,
  SubscriptionId,
  SubscriptionFilter,
  EventNotification,
  AuthCredentials,
  AuthResult,
  MAPEventType,
} from "./types.js";
import type { Address, SendOptions, ScopeId } from "../types.js";
import type { AgentId } from "../../store/types/index.js";

// =============================================================================
// Stream Type (simplified for interface definition)
// =============================================================================

/**
 * Bidirectional stream for MAP connections.
 * Compatible with MAP SDK's Stream type.
 */
export interface Stream {
  readable: ReadableStream<unknown>;
  writable: WritableStream<unknown>;
}

// =============================================================================
// Extension Handler Types
// =============================================================================

/**
 * Context provided to extension handlers.
 */
export interface ExtensionContext {
  /** The participant making the request */
  participantId: ParticipantId;
  /** Participant's capabilities */
  capabilities: ParticipantCapabilities;
  /** Session ID for the connection */
  sessionId: string;
}

/**
 * Handler function for extension methods.
 * Extension methods use the pattern: `_macro/<namespace>/<method>`
 *
 * @param context - Request context including participant info
 * @param params - Method parameters
 * @returns Method result
 */
export type ExtensionHandler = (
  context: ExtensionContext,
  params: unknown,
) => Promise<unknown>;

// =============================================================================
// Configuration Types
// =============================================================================

/**
 * Agent exposure configuration.
 * Controls which agents are visible to external participants.
 */
export interface AgentExposure {
  /** Whether agents are public by default (default: true) */
  publicByDefault?: boolean;
  /** Glob patterns for agents that are always public */
  publicAgents?: string[];
  /** Glob patterns for agents that are always hidden (takes precedence) */
  hiddenAgents?: string[];
}

/**
 * Scope exposure configuration.
 * Controls which scopes are visible to external participants.
 */
export interface ScopeExposure {
  /** Whether scopes are public by default (default: true) */
  publicByDefault?: boolean;
  /** Glob patterns for scopes that are always public */
  publicScopes?: string[];
  /** Glob patterns for scopes that are always hidden (takes precedence) */
  hiddenScopes?: string[];
}

/**
 * Event exposure configuration.
 * Controls which event types are visible to external participants.
 */
export interface EventExposure {
  /** Event types that are exposed (whitelist - if provided, only these are visible) */
  exposedTypes?: MAPEventType[];
  /** Event types that are always hidden (blacklist - takes precedence) */
  hiddenTypes?: MAPEventType[];
}

/**
 * System-level exposure configuration.
 * This is Layer 1 of the MAP permission model.
 */
export interface SystemExposure {
  /** Agent visibility configuration */
  agents?: AgentExposure;
  /** Scope visibility configuration */
  scopes?: ScopeExposure;
  /** Event visibility configuration */
  events?: EventExposure;
}

/**
 * Resource limits for the adapter.
 * Enforces capacity constraints to prevent resource exhaustion.
 */
export interface AdapterLimits {
  /** Maximum total concurrent connections */
  maxConnections?: number;
  /** Maximum connections per unique client identity */
  maxConnectionsPerClient?: number;
  /** Maximum subscriptions per connection */
  maxSubscriptionsPerConnection?: number;
  /** Maximum message size in bytes */
  maxMessageSize?: number;
  /** Request timeout in milliseconds */
  requestTimeoutMs?: number;
  /** Maximum events stored in replay buffer (default: 10000) */
  maxReplayBufferSize?: number;
}

/**
 * Authentication handler function type.
 */
export type AuthenticateHandler = (
  participantType: ParticipantType,
  credentials: AuthCredentials,
) => Promise<AuthResult>;

/**
 * MAPAdapter configuration.
 */
export interface MAPAdapterConfig {
  /** System name for identification */
  name?: string;

  /** System version */
  version?: string;

  /** Default capabilities for anonymous/unauthenticated connections */
  anonymousCapabilities?: ParticipantCapabilities;

  /** Default capabilities for authenticated clients */
  defaultClientCapabilities?: ParticipantCapabilities;

  /** Default capabilities for authenticated agents */
  defaultAgentCapabilities?: ParticipantCapabilities;

  /** Authentication handler */
  authenticate?: AuthenticateHandler;

  /** System-level exposure configuration (Layer 1 permissions) */
  exposure?: SystemExposure;

  /** Resource limits */
  limits?: AdapterLimits;
}

// =============================================================================
// Message Types
// =============================================================================

/**
 * Message payload for sending via MAP.
 */
export interface MessagePayload {
  /** Message content type */
  type?: string;
  /** Message content */
  content: unknown;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Result of sending a message.
 */
export interface SendResult {
  /** Message ID */
  messageId: string;
  /** Agents the message was delivered to */
  delivered: AgentId[];
  /** Agents where delivery failed */
  failed?: Array<{ agentId: AgentId; reason: string }>;
}

// =============================================================================
// Query Types
// =============================================================================

/**
 * Filter for listing agents.
 */
export interface AgentFilter {
  /** Filter by agent states */
  states?: string[];
  /** Filter by roles */
  roles?: string[];
  /** Filter by scope membership */
  scopes?: ScopeId[];
  /** Filter by parent agent */
  parent?: AgentId;
}

/**
 * ACP capability advertisement (matches MAP SDK's ACPCapability).
 */
export interface ACPCapability {
  /** ACP protocol version supported (e.g., '2024-10-07') */
  version?: string;
  /** ACP features supported by this agent */
  features?: string[];
}

/**
 * Agent capabilities advertised via MAP (matches MAP SDK's ParticipantCapabilities).
 */
export interface AgentCapabilities {
  /** Protocols supported by this agent (e.g., ["acp"]) */
  protocols?: string[];
  /** ACP capability details (present if 'acp' is in protocols array) */
  acp?: ACPCapability;
  /** Additional capability flags */
  [key: string]: unknown;
}

/**
 * Agent info returned by queries.
 */
export interface AgentInfo {
  id: AgentId;
  name?: string;
  role?: string;
  state: string;
  parent?: AgentId;
  scopes: ScopeId[];
  metadata?: Record<string, unknown>;
  createdAt: number;
  /** Agent capabilities (protocols, features) */
  capabilities?: AgentCapabilities;
}

/**
 * Scope info returned by queries.
 */
export interface ScopeInfo {
  id: ScopeId;
  name?: string;
  members: AgentId[];
  createdAt: number;
  metadata?: Record<string, unknown>;
}

// =============================================================================
// Event Types
// =============================================================================

/**
 * Handler for adapter events.
 */
export type AdapterEventHandler = (event: AdapterEvent) => void;

/**
 * Events emitted by the adapter.
 */
export type AdapterEvent =
  | { type: "participant.connected"; participant: ConnectedParticipant }
  | {
      type: "participant.disconnected";
      participantId: ParticipantId;
      reason?: string;
    }
  | { type: "subscription.created"; subscriptionId: SubscriptionId }
  | { type: "subscription.removed"; subscriptionId: SubscriptionId }
  | { type: "error"; error: Error; context?: string };

// =============================================================================
// MAPAdapter Interface
// =============================================================================

/**
 * MAPAdapter interface.
 *
 * The adapter is the external-facing component that:
 * - Accepts MAP protocol connections from clients, agents, and gateways
 * - Manages participant lifecycle and authentication
 * - Handles subscriptions and event streaming
 * - Dispatches extension method calls
 * - Enforces system-level permissions (Layer 1)
 *
 * The adapter delegates to internal components:
 * - MessageRouter: For message routing and delivery
 * - AgentManager: For agent lifecycle operations
 * - EventStore: For event persistence and replay
 */
export interface MAPAdapter {
  /** Adapter configuration */
  readonly config: MAPAdapterConfig;

  // ===========================================================================
  // Connection Management
  // ===========================================================================

  /**
   * Accept a new connection from a stream.
   *
   * Performs the MAP connection handshake:
   * 1. Receive `map/connect` request
   * 2. Authenticate credentials (if provided)
   * 3. Assign capabilities based on auth result
   * 4. Return connection info
   *
   * @param stream - Bidirectional stream for the connection
   * @returns Connected participant info
   * @throws If authentication fails or limits exceeded
   */
  acceptConnection(stream: Stream): Promise<ConnectedParticipant>;

  /**
   * Disconnect a participant.
   *
   * Cleans up:
   * - Active subscriptions
   * - Pending requests
   * - Connection resources
   *
   * Emits `participant.disconnected` event.
   *
   * @param id - Participant to disconnect
   * @param reason - Optional disconnect reason
   */
  disconnectParticipant(id: ParticipantId, reason?: string): Promise<void>;

  /**
   * Get all connected participants.
   */
  getParticipants(): ConnectedParticipant[];

  /**
   * Get a specific participant by ID.
   */
  getParticipant(id: ParticipantId): ConnectedParticipant | undefined;

  // ===========================================================================
  // Messaging
  // ===========================================================================

  /**
   * Send a message to the specified address.
   *
   * Performs permission checks, resolves the address, and routes
   * the message through the internal MessageRouter.
   *
   * @param participantId - Sending participant
   * @param to - Target address
   * @param payload - Message payload
   * @param options - Send options (priority, delivery hint)
   * @returns Send result with delivery status
   * @throws If participant lacks messaging capability
   */
  sendMessage(
    participantId: ParticipantId,
    to: Address,
    payload: MessagePayload,
    options?: SendOptions,
  ): Promise<SendResult>;

  // ===========================================================================
  // Subscriptions
  // ===========================================================================

  /**
   * Create a subscription for a participant.
   *
   * The subscription will receive events matching the filter,
   * subject to the participant's visibility permissions.
   *
   * @param participantId - Subscribing participant
   * @param filter - Event filter criteria
   * @returns Subscription ID for management
   * @throws If participant lacks subscribe capability or limits exceeded
   */
  createSubscription(
    participantId: ParticipantId,
    filter?: SubscriptionFilter,
  ): Promise<SubscriptionId>;

  /**
   * Remove a subscription.
   *
   * @param subscriptionId - Subscription to remove
   */
  removeSubscription(subscriptionId: SubscriptionId): Promise<void>;

  /**
   * Get all subscription IDs for a participant.
   */
  getSubscriptions(participantId: ParticipantId): SubscriptionId[];

  /**
   * Pause a subscription (stop receiving events).
   */
  pauseSubscription(subscriptionId: SubscriptionId): Promise<void>;

  /**
   * Resume a paused subscription.
   */
  resumeSubscription(subscriptionId: SubscriptionId): Promise<void>;

  // ===========================================================================
  // Queries
  // ===========================================================================

  /**
   * List agents visible to the participant.
   *
   * Results are filtered by:
   * 1. System exposure rules
   * 2. Participant capabilities
   * 3. Optional filter criteria
   *
   * @param participantId - Querying participant
   * @param filter - Optional filter criteria
   * @returns List of visible agents
   */
  listAgents(participantId: ParticipantId, filter?: AgentFilter): AgentInfo[];

  /**
   * Get details of a specific agent.
   *
   * @param participantId - Querying participant
   * @param agentId - Agent to query
   * @returns Agent info or undefined if not visible
   */
  getAgent(
    participantId: ParticipantId,
    agentId: AgentId,
  ): AgentInfo | undefined;

  /**
   * List scopes visible to the participant.
   *
   * @param participantId - Querying participant
   * @returns List of visible scopes
   */
  listScopes(participantId: ParticipantId): ScopeInfo[];

  /**
   * Get details of a specific scope.
   *
   * @param participantId - Querying participant
   * @param scopeId - Scope to query
   * @returns Scope info or undefined if not visible
   */
  getScope(
    participantId: ParticipantId,
    scopeId: ScopeId,
  ): ScopeInfo | undefined;

  // ===========================================================================
  // Events
  // ===========================================================================

  /**
   * Emit an event to all matching subscribers.
   *
   * The event is filtered per-subscriber based on:
   * 1. Subscription filter match
   * 2. System exposure rules
   * 3. Participant visibility permissions
   *
   * @param event - Event to emit
   */
  emitEvent(event: EventNotification): void;

  /**
   * Register a handler for adapter events.
   *
   * @param handler - Event handler function
   * @returns Unsubscribe function
   */
  onEvent(handler: AdapterEventHandler): () => void;

  // ===========================================================================
  // Extensions
  // ===========================================================================

  /**
   * Register an extension method handler.
   *
   * Extensions use the pattern: `_macro/<namespace>/<method>`
   * For example: `_macro/task/list`, `_macro/wake`
   *
   * @param method - Full method name (e.g., "_macro/task/list")
   * @param handler - Handler function
   */
  registerExtension(method: string, handler: ExtensionHandler): void;

  /**
   * Unregister an extension method.
   *
   * @param method - Method name to unregister
   */
  unregisterExtension(method: string): void;

  /**
   * Get list of registered extension methods.
   */
  getExtensions(): string[];

  /**
   * Check if an extension method is registered.
   */
  hasExtension(method: string): boolean;

  // ===========================================================================
  // Lifecycle
  // ===========================================================================

  /**
   * Start the adapter.
   *
   * Initializes resources and begins accepting connections.
   */
  start(): Promise<void>;

  /**
   * Stop the adapter.
   *
   * Disconnects all participants and releases resources.
   *
   * @param graceful - If true, wait for pending operations (default: true)
   */
  stop(graceful?: boolean): Promise<void>;

  /**
   * Check if the adapter is running.
   */
  isRunning(): boolean;
}

// =============================================================================
// Factory Type
// =============================================================================

/**
 * Factory function for creating MAPAdapter instances.
 */
export type MAPAdapterFactory = (config?: MAPAdapterConfig) => MAPAdapter;
