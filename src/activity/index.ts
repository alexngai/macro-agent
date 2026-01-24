/**
 * Activity Module Exports
 *
 * Activity-based waking system for agents.
 *
 * @module activity
 * @see s-9rld In-Flight Steering spec section 3.4
 */

// Types
export * from "./types.js";

// Relevance detection
export {
  findRelevantAgents,
  matchesRole,
  matchesSubscriptionScope,
  getAncestors,
  isInSubtree,
  getAgentsByRole,
} from "./relevance.js";

export type {
  RelevanceAgentInfo,
  RelevanceAgentSource,
  RelevanceSubscriptionSource,
  RelevanceOptions,
} from "./relevance.js";

// Deduplication
export {
  ActivityDeduplicator,
  createDeduplicator,
} from "./deduplication.js";

export type {
  DeduplicationKey,
  DeduplicationConfig,
} from "./deduplication.js";

// Activity watcher
export {
  createActivityWatcher,
  subscribeAgentToEvents,
} from "./watcher.js";

export type {
  ActivityListener,
  WakeHandler,
  ActivityWatcher,
} from "./watcher.js";
