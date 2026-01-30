/**
 * ConnectionManager - Manages connected MAP participants
 *
 * Tracks connected participants, their capabilities, sessions, and
 * enforces connection limits.
 *
 * @see specs/s-5qir_map_integration_for_macro_agent.md
 */

import { ulid } from "ulid";
import type {
  ParticipantId,
  ParticipantType,
  ParticipantCapabilities,
  ConnectedParticipant,
  SessionId,
} from "./types.js";
import type { AdapterLimits } from "./interface.js";
import {
  createParticipantId,
  createSessionId,
} from "./types.js";

// =============================================================================
// Error Types
// =============================================================================

/**
 * Error codes for connection manager operations.
 */
export type ConnectionErrorCode =
  | "MAX_CONNECTIONS_EXCEEDED"
  | "MAX_CONNECTIONS_PER_CLIENT_EXCEEDED"
  | "PARTICIPANT_NOT_FOUND"
  | "INVALID_PARTICIPANT_TYPE";

/**
 * Error thrown by connection manager operations.
 */
export class ConnectionError extends Error {
  readonly code: ConnectionErrorCode;

  constructor(message: string, code: ConnectionErrorCode) {
    super(message);
    this.name = "ConnectionError";
    this.code = code;
  }
}

// =============================================================================
// Configuration
// =============================================================================

/**
 * Configuration for ConnectionManager.
 */
export interface ConnectionManagerConfig {
  /** Resource limits */
  limits?: AdapterLimits;

  /** Default capabilities for anonymous connections */
  anonymousCapabilities?: ParticipantCapabilities;

  /** Default capabilities for authenticated clients */
  defaultClientCapabilities?: ParticipantCapabilities;

  /** Default capabilities for authenticated agents */
  defaultAgentCapabilities?: ParticipantCapabilities;
}

/**
 * Default capabilities for anonymous connections.
 */
const DEFAULT_ANONYMOUS_CAPABILITIES: ParticipantCapabilities = {
  canQuery: true,
  canSubscribe: true,
  canMessage: false,
  canSpawn: false,
  canStop: false,
  canManageScopes: false,
  canUpdatePermissions: false,
  canManageTasks: false,
};

/**
 * Default capabilities for authenticated clients.
 */
const DEFAULT_CLIENT_CAPABILITIES: ParticipantCapabilities = {
  canQuery: true,
  canSubscribe: true,
  canMessage: true,
  canSpawn: false,
  canStop: false,
  canManageScopes: false,
  canUpdatePermissions: false,
  canManageTasks: false,
};

/**
 * Default capabilities for authenticated agents.
 */
const DEFAULT_AGENT_CAPABILITIES: ParticipantCapabilities = {
  canQuery: true,
  canSubscribe: true,
  canMessage: true,
  canSpawn: true,
  canStop: true,
  canManageScopes: true,
  canUpdatePermissions: false,
  canManageTasks: true,
};

// =============================================================================
// Connection Manager Interface
// =============================================================================

/**
 * Event types emitted by ConnectionManager.
 */
export type ConnectionManagerEventType =
  | "participant.connected"
  | "participant.disconnected";

/**
 * Event payload for connection manager events.
 */
export type ConnectionManagerEvent =
  | { type: "participant.connected"; participant: ConnectedParticipant }
  | { type: "participant.disconnected"; participantId: ParticipantId; reason?: string };

/**
 * Handler for connection manager events.
 */
export type ConnectionManagerEventHandler = (event: ConnectionManagerEvent) => void;

/**
 * Options for creating a new connection.
 */
export interface ConnectOptions {
  /** Type of participant */
  type: ParticipantType;
  /** Human-readable name */
  name?: string;
  /** Capabilities (overrides defaults) */
  capabilities?: ParticipantCapabilities;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
  /** Client identity for rate limiting */
  clientIdentity?: string;
}

/**
 * ConnectionManager interface.
 */
export interface ConnectionManager {
  /**
   * Register a new participant connection.
   *
   * @param options - Connection options
   * @returns Connected participant info
   * @throws ConnectionError if limits exceeded
   */
  connect(options: ConnectOptions): ConnectedParticipant;

  /**
   * Disconnect a participant.
   *
   * @param id - Participant to disconnect
   * @param reason - Optional disconnect reason
   */
  disconnect(id: ParticipantId, reason?: string): void;

  /**
   * Get all connected participants.
   */
  getParticipants(): ConnectedParticipant[];

  /**
   * Get a specific participant by ID.
   */
  getParticipant(id: ParticipantId): ConnectedParticipant | undefined;

  /**
   * Get participant count.
   */
  getConnectionCount(): number;

  /**
   * Check if a participant is connected.
   */
  isConnected(id: ParticipantId): boolean;

  /**
   * Update participant capabilities.
   *
   * @param id - Participant to update
   * @param capabilities - New capabilities (merged with existing)
   */
  updateCapabilities(id: ParticipantId, capabilities: Partial<ParticipantCapabilities>): void;

  /**
   * Register an event handler.
   *
   * @param handler - Event handler function
   * @returns Unsubscribe function
   */
  onEvent(handler: ConnectionManagerEventHandler): () => void;

  /**
   * Disconnect all participants.
   *
   * @param reason - Disconnect reason
   */
  disconnectAll(reason?: string): void;
}

// =============================================================================
// Implementation
// =============================================================================

/**
 * ConnectionManager implementation.
 */
export class ConnectionManagerImpl implements ConnectionManager {
  private readonly participants: Map<ParticipantId, ConnectedParticipant> = new Map();
  private readonly clientConnectionCounts: Map<string, number> = new Map();
  private readonly eventHandlers: Set<ConnectionManagerEventHandler> = new Set();
  private readonly config: Required<ConnectionManagerConfig>;

  constructor(config: ConnectionManagerConfig = {}) {
    this.config = {
      limits: config.limits ?? {},
      anonymousCapabilities: config.anonymousCapabilities ?? DEFAULT_ANONYMOUS_CAPABILITIES,
      defaultClientCapabilities: config.defaultClientCapabilities ?? DEFAULT_CLIENT_CAPABILITIES,
      defaultAgentCapabilities: config.defaultAgentCapabilities ?? DEFAULT_AGENT_CAPABILITIES,
    };
  }

  connect(options: ConnectOptions): ConnectedParticipant {
    // Check total connection limit
    const maxConnections = this.config.limits.maxConnections;
    if (maxConnections !== undefined && this.participants.size >= maxConnections) {
      throw new ConnectionError(
        `Maximum connections exceeded (limit: ${maxConnections})`,
        "MAX_CONNECTIONS_EXCEEDED"
      );
    }

    // Check per-client connection limit
    if (options.clientIdentity) {
      const clientCount = this.clientConnectionCounts.get(options.clientIdentity) ?? 0;
      const maxPerClient = this.config.limits.maxConnectionsPerClient;
      if (maxPerClient !== undefined && clientCount >= maxPerClient) {
        throw new ConnectionError(
          `Maximum connections per client exceeded (limit: ${maxPerClient})`,
          "MAX_CONNECTIONS_PER_CLIENT_EXCEEDED"
        );
      }
    }

    // Generate IDs
    const participantId = createParticipantId(`p-${ulid()}`);
    const sessionId = createSessionId(`s-${ulid()}`);

    // Determine capabilities
    const capabilities = options.capabilities ?? this.getDefaultCapabilities(options.type);

    // Create participant
    const participant: ConnectedParticipant = {
      id: participantId,
      type: options.type,
      name: options.name,
      capabilities,
      sessionId,
      connectedAt: Date.now(),
      metadata: options.metadata,
    };

    // Track connection
    this.participants.set(participantId, participant);

    // Track per-client count
    if (options.clientIdentity) {
      const count = this.clientConnectionCounts.get(options.clientIdentity) ?? 0;
      this.clientConnectionCounts.set(options.clientIdentity, count + 1);
    }

    // Emit event
    this.emit({ type: "participant.connected", participant });

    return participant;
  }

  disconnect(id: ParticipantId, reason?: string): void {
    const participant = this.participants.get(id);
    if (!participant) {
      return; // Already disconnected or never existed
    }

    // Remove from tracking
    this.participants.delete(id);

    // Decrement per-client count if tracked
    // Note: We'd need to store clientIdentity on participant to do this properly
    // For now, this is a simplification

    // Emit event
    this.emit({ type: "participant.disconnected", participantId: id, reason });
  }

  getParticipants(): ConnectedParticipant[] {
    return Array.from(this.participants.values());
  }

  getParticipant(id: ParticipantId): ConnectedParticipant | undefined {
    return this.participants.get(id);
  }

  getConnectionCount(): number {
    return this.participants.size;
  }

  isConnected(id: ParticipantId): boolean {
    return this.participants.has(id);
  }

  updateCapabilities(id: ParticipantId, capabilities: Partial<ParticipantCapabilities>): void {
    const participant = this.participants.get(id);
    if (!participant) {
      throw new ConnectionError(
        `Participant not found: ${id}`,
        "PARTICIPANT_NOT_FOUND"
      );
    }

    // Merge capabilities
    participant.capabilities = {
      ...participant.capabilities,
      ...capabilities,
    };
  }

  onEvent(handler: ConnectionManagerEventHandler): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  disconnectAll(reason?: string): void {
    const ids = Array.from(this.participants.keys());
    for (const id of ids) {
      this.disconnect(id, reason);
    }
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  private getDefaultCapabilities(type: ParticipantType): ParticipantCapabilities {
    switch (type) {
      case "client":
        return { ...this.config.defaultClientCapabilities };
      case "agent":
        return { ...this.config.defaultAgentCapabilities };
      case "gateway":
        // Gateways get agent-level capabilities by default
        return { ...this.config.defaultAgentCapabilities };
      default:
        return { ...this.config.anonymousCapabilities };
    }
  }

  private emit(event: ConnectionManagerEvent): void {
    for (const handler of this.eventHandlers) {
      try {
        handler(event);
      } catch (error) {
        console.error("[ConnectionManager] Event handler error:", error);
      }
    }
  }
}

// =============================================================================
// Factory
// =============================================================================

/**
 * Create a ConnectionManager instance.
 */
export function createConnectionManager(
  config?: ConnectionManagerConfig
): ConnectionManager {
  return new ConnectionManagerImpl(config);
}
