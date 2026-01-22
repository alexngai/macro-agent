/**
 * Activity Watcher
 *
 * Monitors events and triggers agent waking based on relevance.
 * Central coordination point for activity-based waking.
 *
 * @module activity/watcher
 * @see s-9rld In-Flight Steering spec section 3.4
 */

import type { AgentId } from "../store/types/index.js";
import type { MessagePriority } from "../router/types.js";
import type {
  Activity,
  ActivityEventType,
  EventSubscription,
  EventSubscriptionScope,
  ActivityWatcherConfig,
  WakeResult,
  RelevanceRule,
} from "./types.js";
import { DEFAULT_ACTIVITY_WATCHER_CONFIG } from "./types.js";
import {
  findRelevantAgents,
  type RelevanceAgentSource,
} from "./relevance.js";
import {
  ActivityDeduplicator,
  createDeduplicator,
} from "./deduplication.js";

// =============================================================================
// Types
// =============================================================================

/**
 * Event listener for activity events
 */
export type ActivityListener = (activity: Activity) => void;

/**
 * Wake handler function
 */
export type WakeHandler = (
  agentId: AgentId,
  activity: Activity,
  priority: MessagePriority
) => Promise<WakeResult>;

/**
 * Activity watcher interface
 */
export interface ActivityWatcher {
  /** Start watching for activities */
  start(): void;
  /** Stop watching for activities */
  stop(): void;
  /** Check if watcher is running */
  isRunning(): boolean;

  /** Configure which events trigger waking */
  setEventTypes(types: ActivityEventType[]): void;
  /** Get currently watched event types */
  getEventTypes(): ActivityEventType[];

  /** Subscribe an agent to event types */
  subscribe(subscription: EventSubscription): void;
  /** Unsubscribe an agent from event types */
  unsubscribe(agentId: AgentId, eventTypes?: ActivityEventType[]): void;
  /** Get subscriptions for an agent */
  getSubscriptions(agentId: AgentId): EventSubscription[];

  /** Add a custom relevance rule */
  addRelevanceRule(rule: RelevanceRule): void;
  /** Remove a custom relevance rule */
  removeRelevanceRule(rule: RelevanceRule): void;

  /** Process an activity (for manual triggering or testing) */
  processActivity(activity: Activity): Promise<WakeResult[]>;

  /** Add activity listener for wait_for_activity */
  addActivityListener(listener: ActivityListener): () => void;

  /** Get deduplication stats */
  getStats(): { slots: number; suppressed: number };
}

// =============================================================================
// Implementation
// =============================================================================

/**
 * Create an activity watcher instance.
 */
export function createActivityWatcher(
  agentSource: RelevanceAgentSource,
  wakeHandler: WakeHandler,
  config: Partial<ActivityWatcherConfig> = {}
): ActivityWatcher {
  const cfg = { ...DEFAULT_ACTIVITY_WATCHER_CONFIG, ...config };

  // State
  let running = false;
  let watchedEventTypes: ActivityEventType[] = cfg.eventTypes ?? [];
  const subscriptions = new Map<AgentId, EventSubscription[]>();
  const customRules: RelevanceRule[] = [];
  const activityListeners = new Set<ActivityListener>();

  // Deduplicator
  const deduplicator = cfg.enableDeduplication
    ? createDeduplicator({ windowMs: cfg.deduplicationWindowMs })
    : null;

  // ─────────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ─────────────────────────────────────────────────────────────────────────

  function start(): void {
    running = true;
  }

  function stop(): void {
    running = false;
  }

  function isRunning(): boolean {
    return running;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Event Type Configuration
  // ─────────────────────────────────────────────────────────────────────────

  function setEventTypes(types: ActivityEventType[]): void {
    watchedEventTypes = [...types];
  }

  function getEventTypes(): ActivityEventType[] {
    return [...watchedEventTypes];
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Subscription Management
  // ─────────────────────────────────────────────────────────────────────────

  function subscribe(subscription: EventSubscription): void {
    const existing = subscriptions.get(subscription.agentId) ?? [];

    // Check for duplicate subscription
    const isDuplicate = existing.some(
      (s) =>
        JSON.stringify(s.eventTypes.sort()) ===
          JSON.stringify(subscription.eventTypes.sort()) &&
        JSON.stringify(s.scope) === JSON.stringify(subscription.scope)
    );

    if (!isDuplicate) {
      subscriptions.set(subscription.agentId, [...existing, subscription]);
    }
  }

  function unsubscribe(agentId: AgentId, eventTypes?: ActivityEventType[]): void {
    if (!eventTypes) {
      // Remove all subscriptions for agent
      subscriptions.delete(agentId);
      return;
    }

    const existing = subscriptions.get(agentId);
    if (!existing) return;

    // Remove subscriptions matching the event types
    const remaining = existing.filter(
      (s) =>
        !eventTypes.some((et) => s.eventTypes.includes(et)) ||
        s.eventTypes.filter((et) => !eventTypes.includes(et)).length > 0
    );

    if (remaining.length === 0) {
      subscriptions.delete(agentId);
    } else {
      subscriptions.set(agentId, remaining);
    }
  }

  function getSubscriptionsForAgent(agentId: AgentId): EventSubscription[] {
    return subscriptions.get(agentId) ?? [];
  }

  // Subscription source adapter for relevance detection
  const subscriptionSource = {
    getSubscribers(eventType: ActivityEventType): EventSubscription[] {
      const result: EventSubscription[] = [];
      for (const [, agentSubs] of subscriptions) {
        for (const sub of agentSubs) {
          if (sub.eventTypes.length === 0 || sub.eventTypes.includes(eventType)) {
            result.push(sub);
          }
        }
      }
      return result;
    },
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Relevance Rules
  // ─────────────────────────────────────────────────────────────────────────

  function addRelevanceRule(rule: RelevanceRule): void {
    if (!customRules.includes(rule)) {
      customRules.push(rule);
    }
  }

  function removeRelevanceRule(rule: RelevanceRule): void {
    const idx = customRules.indexOf(rule);
    if (idx >= 0) {
      customRules.splice(idx, 1);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Activity Processing
  // ─────────────────────────────────────────────────────────────────────────

  async function processActivity(activity: Activity): Promise<WakeResult[]> {
    // Check if we're watching this event type
    if (
      watchedEventTypes.length > 0 &&
      !watchedEventTypes.includes(activity.type as ActivityEventType)
    ) {
      return [];
    }

    // Notify activity listeners (for wait_for_activity)
    for (const listener of activityListeners) {
      try {
        listener(activity);
      } catch {
        // Ignore listener errors
      }
    }

    // If not running, don't wake agents
    if (!running) {
      return [];
    }

    // Find relevant agents
    const relevantAgents = findRelevantAgents(
      activity,
      agentSource,
      subscriptionSource,
      { customRules }
    );

    // Wake each relevant agent
    const results: WakeResult[] = [];
    const priority = activity.priority ?? cfg.defaultPriority ?? "normal";

    for (const agentId of relevantAgents) {
      // Check deduplication
      if (deduplicator && !deduplicator.shouldNotify(agentId, activity)) {
        results.push({ success: true, method: "queued", reason: "no_session" });
        continue;
      }

      try {
        const result = await wakeHandler(agentId, activity, priority);
        results.push(result);
      } catch (error) {
        results.push({
          success: false,
          reason: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return results;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Activity Listeners (for wait_for_activity)
  // ─────────────────────────────────────────────────────────────────────────

  function addActivityListener(listener: ActivityListener): () => void {
    activityListeners.add(listener);
    return () => activityListeners.delete(listener);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Stats
  // ─────────────────────────────────────────────────────────────────────────

  function getStats(): { slots: number; suppressed: number } {
    if (!deduplicator) {
      return { slots: 0, suppressed: 0 };
    }
    const stats = deduplicator.getStats();
    return { slots: stats.totalSlots, suppressed: stats.totalSuppressed };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Return Interface
  // ─────────────────────────────────────────────────────────────────────────

  return {
    start,
    stop,
    isRunning,
    setEventTypes,
    getEventTypes,
    subscribe,
    unsubscribe,
    getSubscriptions: getSubscriptionsForAgent,
    addRelevanceRule,
    removeRelevanceRule,
    processActivity,
    addActivityListener,
    getStats,
  };
}

// =============================================================================
// Helper: Subscribe Agent to Event Types
// =============================================================================

/**
 * Helper to subscribe an agent to specific event types with optional scope.
 */
export function subscribeAgentToEvents(
  watcher: ActivityWatcher,
  agentId: AgentId,
  eventTypes: ActivityEventType[],
  scope?: EventSubscriptionScope,
  priority?: MessagePriority
): void {
  watcher.subscribe({
    agentId,
    eventTypes,
    scope,
    priority,
  });
}
