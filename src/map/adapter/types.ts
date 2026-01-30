/**
 * MAPAdapter Connection and Participant Types
 *
 * This module defines the types for managing external connections,
 * participants, and subscriptions in the MAP adapter layer.
 *
 * @see specs/s-5qir_map_integration_for_macro_agent.md
 */

import type { AgentId } from "../../store/types/index.js";
import type { ScopeId } from "../types.js";

// =============================================================================
// Branded ID Types
// =============================================================================

/**
 * Unique identifier for a connected participant.
 * Generated when a participant connects to the MAP adapter.
 */
export type ParticipantId = string & { readonly __brand: "ParticipantId" };

/**
 * Session identifier for connection persistence.
 * Can be used for reconnection and subscription restoration.
 */
export type SessionId = string & { readonly __brand: "SessionId" };

/**
 * Unique identifier for an active subscription.
 */
export type SubscriptionId = string & { readonly __brand: "SubscriptionId" };

/**
 * Create a ParticipantId from a string.
 */
export function createParticipantId(id: string): ParticipantId {
  return id as ParticipantId;
}

/**
 * Create a SessionId from a string.
 */
export function createSessionId(id: string): SessionId {
  return id as SessionId;
}

/**
 * Create a SubscriptionId from a string.
 */
export function createSubscriptionId(id: string): SubscriptionId {
  return id as SubscriptionId;
}

// =============================================================================
// Participant Types
// =============================================================================

/**
 * Types of participants that can connect to the MAP adapter.
 *
 * - client: External observer/controller (e.g., CLI, web UI)
 * - agent: Internal agent participant (for federation scenarios)
 * - gateway: Federation bridge to another MAP system
 */
export type ParticipantType = "client" | "agent" | "gateway";

/**
 * Capabilities that can be granted to a participant.
 * Controls what operations the participant can perform.
 */
export interface ParticipantCapabilities {
  /** Can query agent list and details */
  canQuery?: boolean;
  /** Can subscribe to events */
  canSubscribe?: boolean;
  /** Can send messages to agents */
  canMessage?: boolean;
  /** Can spawn new agents */
  canSpawn?: boolean;
  /** Can stop/terminate agents */
  canStop?: boolean;
  /** Can create and manage scopes */
  canManageScopes?: boolean;
  /** Can update permissions */
  canUpdatePermissions?: boolean;
}

/**
 * Information about a connected participant.
 */
export interface ConnectedParticipant {
  /** Unique participant identifier */
  id: ParticipantId;
  /** Type of participant */
  type: ParticipantType;
  /** Human-readable name */
  name?: string;
  /** Granted capabilities */
  capabilities: ParticipantCapabilities;
  /** Session identifier for reconnection */
  sessionId: SessionId;
  /** Connection timestamp (ms since epoch) */
  connectedAt: number;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

// =============================================================================
// Authentication Types
// =============================================================================

/**
 * Authentication credentials passed in map/connect request.
 */
export interface AuthCredentials {
  /** Authentication method (e.g., "token", "api-key", "none") */
  method: string;
  /** Authentication token/key */
  token?: string;
  /** Additional auth parameters */
  params?: Record<string, unknown>;
}

/**
 * Result of authentication attempt.
 */
export interface AuthResult {
  /** Whether authentication succeeded */
  allowed: boolean;
  /** Capabilities granted on success */
  capabilities?: ParticipantCapabilities;
  /** Assigned participant ID on success */
  participantId?: ParticipantId;
  /** Error message on failure */
  error?: string;
}

// =============================================================================
// Subscription Types
// =============================================================================

/**
 * Event types that can be subscribed to.
 */
export type MAPEventType =
  // Agent lifecycle
  | "agent.registered"
  | "agent.unregistered"
  | "agent.state.changed"
  // Scope events
  | "scope.created"
  | "scope.deleted"
  | "scope.member.joined"
  | "scope.member.left"
  // Message events
  | "message.sent"
  | "message.delivered"
  // Permission events
  | "permissions.updated"
  // Extension events (macro-agent specific)
  | "task.created"
  | "task.assigned"
  | "task.completed"
  | "task.failed";

/**
 * Filter for event subscriptions.
 * All filters are ANDed together.
 */
export interface SubscriptionFilter {
  /** Filter by event types (OR within array) */
  eventTypes?: MAPEventType[];
  /** Filter by agent IDs (OR within array) */
  agents?: AgentId[];
  /** Filter by scope IDs (OR within array) */
  scopes?: ScopeId[];
  /** Subscribe to events from agent's descendants */
  subtree?: AgentId;
  /** Subscribe to events from agent's ancestors */
  lineage?: AgentId;
}

/**
 * Active subscription state.
 */
export interface Subscription {
  /** Unique subscription identifier */
  id: SubscriptionId;
  /** Owning participant */
  participantId: ParticipantId;
  /** Subscription filter */
  filter: SubscriptionFilter;
  /** Creation timestamp (ms since epoch) */
  createdAt: number;
  /** Whether subscription is paused */
  paused: boolean;
  /** Last delivered event ID (for resumption) */
  lastEventId?: string;
  /** Last sequence number (for gap detection) */
  lastSequence?: number;
}

// =============================================================================
// Event Types
// =============================================================================

/**
 * Event notification sent to subscribers.
 */
export interface EventNotification {
  /** Unique event identifier (ULID) */
  eventId: string;
  /** Event type */
  type: MAPEventType;
  /** Event timestamp (ms since epoch) */
  timestamp: number;
  /** Event-specific data */
  data: unknown;
  /** Parent event IDs for causal ordering */
  causedBy?: string[];
  /** Related agent ID (if applicable) */
  agentId?: AgentId;
  /** Related scope ID (if applicable) */
  scopeId?: ScopeId;
  /** Sequence number for ordering */
  sequence?: number;
}

// =============================================================================
// Connection Events
// =============================================================================

/**
 * Events emitted by the connection lifecycle.
 */
export type ConnectionEventType =
  | "connected"
  | "disconnected"
  | "reconnecting"
  | "reconnected"
  | "error";

/**
 * Connection event data.
 */
export interface ConnectionEvent {
  type: ConnectionEventType;
  participantId: ParticipantId;
  timestamp: number;
  reason?: string;
  error?: Error;
}
