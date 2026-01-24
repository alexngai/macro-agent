/**
 * Message-related type definitions
 */

import type { EventId, Timestamp } from "./primitives.js";
import type { EventSource } from "./events.js";

// Message in queue
export interface QueuedMessage {
  id: EventId;
  from: EventSource;
  content: string;
  timestamp: Timestamp;
  truncated: boolean;
  correlation_id?: string;
}

// Subscription types
export type SubscriptionType =
  | "agent"
  | "task"
  | "lineage"
  | "subtree"
  | "topic"
  | "broadcast"
  | "role";

// Subscription record
export interface Subscription {
  type: SubscriptionType;
  target: string;
}
