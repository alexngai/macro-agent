/**
 * SubscriptionManager - Manages external client subscriptions
 *
 * Tracks subscriptions for external MAP participants, handles filter matching,
 * and provides event delivery to subscribers.
 *
 * Key design decisions:
 * - Ephemeral subscriptions (no persistence across disconnect)
 * - Filter matching: eventTypes, agents, scopes, subtree, lineage
 * - Subscription limits enforced per participant
 *
 * @see specs/s-5qir_map_integration_for_macro_agent.md
 */

import { ulid } from "ulid";
import type {
  ParticipantId,
  SubscriptionId,
  SubscriptionFilter,
  Subscription,
  EventNotification,
  MAPEventType,
} from "./types.js";
import type { AdapterLimits } from "./interface.js";
import type { AgentId } from "../../store/types/index.js";
import { createSubscriptionId } from "./types.js";

// =============================================================================
// Error Types
// =============================================================================

/**
 * Error codes for subscription manager operations.
 */
export type SubscriptionErrorCode =
  | "MAX_SUBSCRIPTIONS_EXCEEDED"
  | "SUBSCRIPTION_NOT_FOUND"
  | "PARTICIPANT_NOT_FOUND"
  | "INVALID_FILTER";

/**
 * Error thrown by subscription manager operations.
 */
export class SubscriptionError extends Error {
  readonly code: SubscriptionErrorCode;

  constructor(message: string, code: SubscriptionErrorCode) {
    super(message);
    this.name = "SubscriptionError";
    this.code = code;
  }
}

// =============================================================================
// Configuration
// =============================================================================

/**
 * Configuration for SubscriptionManager.
 */
export interface SubscriptionManagerConfig {
  /** Resource limits */
  limits?: AdapterLimits;

  /**
   * Function to get agent's ancestors (for lineage filter matching).
   * Returns agent IDs from immediate parent to root.
   */
  getAncestors?: (agentId: AgentId) => AgentId[];

  /**
   * Function to get agent's descendants (for subtree filter matching).
   * Returns all descendant agent IDs.
   */
  getDescendants?: (agentId: AgentId) => AgentId[];
}

// =============================================================================
// Types
// =============================================================================

/**
 * Internal subscription state with additional tracking.
 */
interface SubscriptionState extends Subscription {
  /** Client identity for cleanup tracking */
  clientIdentity?: string;
}

/**
 * Event types emitted by SubscriptionManager.
 */
export type SubscriptionManagerEventType =
  | "subscription.created"
  | "subscription.removed"
  | "subscription.paused"
  | "subscription.resumed";

/**
 * Event payload for subscription manager events.
 */
export type SubscriptionManagerEvent =
  | { type: "subscription.created"; subscription: Subscription }
  | { type: "subscription.removed"; subscriptionId: SubscriptionId }
  | { type: "subscription.paused"; subscriptionId: SubscriptionId }
  | { type: "subscription.resumed"; subscriptionId: SubscriptionId };

/**
 * Handler for subscription manager events.
 */
export type SubscriptionManagerEventHandler = (event: SubscriptionManagerEvent) => void;

/**
 * Result of matching an event against subscriptions.
 */
export interface MatchResult {
  /** Subscriptions that match the event */
  subscriptions: Subscription[];
  /** Participant IDs to deliver to */
  participantIds: ParticipantId[];
}

// =============================================================================
// Subscription Manager Interface
// =============================================================================

/**
 * SubscriptionManager interface.
 */
export interface SubscriptionManager {
  /**
   * Create a subscription for a participant.
   *
   * @param participantId - Subscribing participant
   * @param filter - Event filter criteria (empty = all events)
   * @returns Subscription ID
   * @throws SubscriptionError if limits exceeded
   */
  subscribe(participantId: ParticipantId, filter?: SubscriptionFilter): SubscriptionId;

  /**
   * Remove a subscription.
   *
   * @param subscriptionId - Subscription to remove
   */
  unsubscribe(subscriptionId: SubscriptionId): void;

  /**
   * Get all subscriptions for a participant.
   */
  getSubscriptions(participantId: ParticipantId): Subscription[];

  /**
   * Get all subscription IDs for a participant.
   */
  getSubscriptionIds(participantId: ParticipantId): SubscriptionId[];

  /**
   * Get a specific subscription.
   */
  getSubscription(subscriptionId: SubscriptionId): Subscription | undefined;

  /**
   * Pause a subscription (stop receiving events).
   */
  pause(subscriptionId: SubscriptionId): void;

  /**
   * Resume a paused subscription.
   */
  resume(subscriptionId: SubscriptionId): void;

  /**
   * Check if a subscription is paused.
   */
  isPaused(subscriptionId: SubscriptionId): boolean;

  /**
   * Match an event against all active subscriptions.
   *
   * @param event - Event to match
   * @returns Matching subscriptions and participant IDs
   */
  match(event: EventNotification): MatchResult;

  /**
   * Remove all subscriptions for a participant.
   * Called when participant disconnects.
   */
  removeAllForParticipant(participantId: ParticipantId): void;

  /**
   * Get total subscription count.
   */
  getSubscriptionCount(): number;

  /**
   * Register an event handler.
   */
  onEvent(handler: SubscriptionManagerEventHandler): () => void;
}

// =============================================================================
// Implementation
// =============================================================================

/**
 * SubscriptionManager implementation.
 */
export class SubscriptionManagerImpl implements SubscriptionManager {
  private readonly subscriptions: Map<SubscriptionId, SubscriptionState> = new Map();
  private readonly participantSubscriptions: Map<ParticipantId, Set<SubscriptionId>> = new Map();
  private readonly eventHandlers: Set<SubscriptionManagerEventHandler> = new Set();
  private readonly config: SubscriptionManagerConfig;

  constructor(config: SubscriptionManagerConfig = {}) {
    this.config = config;
  }

  subscribe(participantId: ParticipantId, filter?: SubscriptionFilter): SubscriptionId {
    // Check subscription limit for this participant
      const existing = this.participantSubscriptions.get(participantId);
      const currentCount = existing?.size ?? 0;
      const maxPerConnection = this.config.limits?.maxSubscriptionsPerConnection;

      if (maxPerConnection !== undefined && currentCount >= maxPerConnection) {
        throw new SubscriptionError(
          `Maximum subscriptions per connection exceeded (limit: ${maxPerConnection})`,
          "MAX_SUBSCRIPTIONS_EXCEEDED"
        );
      }

    // Generate subscription ID
    const subscriptionId = createSubscriptionId(`sub-${ulid()}`);

    // Create subscription
    const subscription: SubscriptionState = {
      id: subscriptionId,
      participantId,
      filter: filter ?? {},
      createdAt: Date.now(),
      paused: false,
    };

    // Track subscription
    this.subscriptions.set(subscriptionId, subscription);

    // Track per-participant
    if (!existing) {
      this.participantSubscriptions.set(participantId, new Set([subscriptionId]));
    } else {
      existing.add(subscriptionId);
    }

    // Emit event
    this.emit({ type: "subscription.created", subscription });

    return subscriptionId;
  }

  unsubscribe(subscriptionId: SubscriptionId): void {
    const subscription = this.subscriptions.get(subscriptionId);
    if (!subscription) {
      return; // Already removed or never existed
    }

    // Remove from main tracking
    this.subscriptions.delete(subscriptionId);

    // Remove from participant tracking
    const participantSubs = this.participantSubscriptions.get(subscription.participantId);
    if (participantSubs) {
      participantSubs.delete(subscriptionId);
      if (participantSubs.size === 0) {
        this.participantSubscriptions.delete(subscription.participantId);
      }
    }

    // Emit event
    this.emit({ type: "subscription.removed", subscriptionId });
  }

  getSubscriptions(participantId: ParticipantId): Subscription[] {
    const subscriptionIds = this.participantSubscriptions.get(participantId);
    if (!subscriptionIds) {
      return [];
    }

    const result: Subscription[] = [];
    for (const id of subscriptionIds) {
      const sub = this.subscriptions.get(id);
      if (sub) {
        result.push(sub);
      }
    }
    return result;
  }

  getSubscriptionIds(participantId: ParticipantId): SubscriptionId[] {
    const subscriptionIds = this.participantSubscriptions.get(participantId);
    return subscriptionIds ? Array.from(subscriptionIds) : [];
  }

  getSubscription(subscriptionId: SubscriptionId): Subscription | undefined {
    return this.subscriptions.get(subscriptionId);
  }

  pause(subscriptionId: SubscriptionId): void {
    const subscription = this.subscriptions.get(subscriptionId);
    if (!subscription) {
      throw new SubscriptionError(
        `Subscription not found: ${subscriptionId}`,
        "SUBSCRIPTION_NOT_FOUND"
      );
    }

    if (!subscription.paused) {
      subscription.paused = true;
      this.emit({ type: "subscription.paused", subscriptionId });
    }
  }

  resume(subscriptionId: SubscriptionId): void {
    const subscription = this.subscriptions.get(subscriptionId);
    if (!subscription) {
      throw new SubscriptionError(
        `Subscription not found: ${subscriptionId}`,
        "SUBSCRIPTION_NOT_FOUND"
      );
    }

    if (subscription.paused) {
      subscription.paused = false;
      this.emit({ type: "subscription.resumed", subscriptionId });
    }
  }

  isPaused(subscriptionId: SubscriptionId): boolean {
    const subscription = this.subscriptions.get(subscriptionId);
    return subscription?.paused ?? false;
  }

  match(event: EventNotification): MatchResult {
    const matchingSubscriptions: Subscription[] = [];
    const participantIds = new Set<ParticipantId>();

    for (const subscription of this.subscriptions.values()) {
      // Skip paused subscriptions
      if (subscription.paused) {
        continue;
      }

      // Check if event matches filter
      if (this.matchesFilter(event, subscription.filter)) {
        matchingSubscriptions.push(subscription);
        participantIds.add(subscription.participantId);
      }
    }

    return {
      subscriptions: matchingSubscriptions,
      participantIds: Array.from(participantIds),
    };
  }

  removeAllForParticipant(participantId: ParticipantId): void {
    const subscriptionIds = this.participantSubscriptions.get(participantId);
    if (!subscriptionIds) {
      return;
    }

    // Copy to avoid modification during iteration
    const idsToRemove = Array.from(subscriptionIds);
    for (const id of idsToRemove) {
      this.unsubscribe(id);
    }
  }

  getSubscriptionCount(): number {
    return this.subscriptions.size;
  }

  onEvent(handler: SubscriptionManagerEventHandler): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  /**
   * Check if an event matches a subscription filter.
   * All filters are ANDed together.
   */
  private matchesFilter(event: EventNotification, filter: SubscriptionFilter): boolean {
    // Empty filter matches everything
    if (!filter || Object.keys(filter).length === 0) {
      return true;
    }

    // Event type filter (OR within array)
    if (filter.eventTypes && filter.eventTypes.length > 0) {
      if (!filter.eventTypes.includes(event.type as MAPEventType)) {
        return false;
      }
    }

    // Agent filter (OR within array)
    if (filter.agents && filter.agents.length > 0) {
      if (!event.agentId || !filter.agents.includes(event.agentId)) {
        return false;
      }
    }

    // Scope filter (OR within array)
    if (filter.scopes && filter.scopes.length > 0) {
      if (!event.scopeId || !filter.scopes.includes(event.scopeId)) {
        return false;
      }
    }

    // Subtree filter - event must be from a descendant of the specified agent
    if (filter.subtree) {
      if (!event.agentId) {
        return false;
      }
      const descendants = this.config.getDescendants?.(filter.subtree) ?? [];
      if (!descendants.includes(event.agentId) && event.agentId !== filter.subtree) {
        return false;
      }
    }

    // Lineage filter - event must be from an ancestor of the specified agent
    if (filter.lineage) {
      if (!event.agentId) {
        return false;
      }
      const ancestors = this.config.getAncestors?.(filter.lineage) ?? [];
      if (!ancestors.includes(event.agentId) && event.agentId !== filter.lineage) {
        return false;
      }
    }

    return true;
  }

  private emit(event: SubscriptionManagerEvent): void {
    for (const handler of this.eventHandlers) {
      try {
        handler(event);
      } catch (error) {
        console.error("[SubscriptionManager] Event handler error:", error);
      }
    }
  }
}

// =============================================================================
// Factory
// =============================================================================

/**
 * Create a SubscriptionManager instance.
 */
export function createSubscriptionManager(
  config?: SubscriptionManagerConfig
): SubscriptionManager {
  return new SubscriptionManagerImpl(config);
}
