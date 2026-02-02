/**
 * System Event Queue Types
 *
 * Types for the per-agent ephemeral event queue that stores
 * pending system events to be delivered on the next prompt.
 *
 * @module trigger/queue/types
 */

import type { AgentId } from "../../store/types/index.js";

// =============================================================================
// Queued Event Types
// =============================================================================

/**
 * A system event queued for an agent
 */
export interface QueuedSystemEvent {
  /** Event text/content */
  text: string;
  /** Timestamp when queued */
  ts: number;
  /** Source identifier for deduplication */
  sourceKey?: string;
  /** Priority for ordering */
  priority?: "low" | "normal" | "high" | "urgent";
}

/**
 * Internal session queue state
 */
export interface SessionQueue {
  /** Queued events */
  queue: QueuedSystemEvent[];
  /** Last event text for consecutive dedup */
  lastText: string | null;
  /** Last context key for change detection */
  lastContextKey: string | null;
}

// =============================================================================
// Queue Operations
// =============================================================================

/**
 * Options for enqueueing a system event
 */
export interface EnqueueOptions {
  /** Target agent ID */
  agentId: AgentId;
  /** Optional context key for change detection */
  contextKey?: string | null;
  /** Optional source key for deduplication */
  sourceKey?: string;
  /** Priority level */
  priority?: "low" | "normal" | "high" | "urgent";
}

/**
 * Options for draining the queue
 */
export interface DrainOptions {
  /** Whether to include priority in sorting */
  sortByPriority?: boolean;
  /** Maximum number of events to drain */
  limit?: number;
}

// =============================================================================
// Queue Interface
// =============================================================================

/**
 * System event queue interface
 *
 * Manages per-agent ephemeral event queues. Events are queued
 * and drained into the agent's next prompt.
 */
export interface SystemEventQueue {
  /**
   * Enqueue an event for an agent
   * @param text - Event text content
   * @param options - Enqueue options including agent ID
   */
  enqueue(text: string, options: EnqueueOptions): void;

  /**
   * Drain all events for an agent (returns and clears queue)
   * @param agentId - Target agent ID
   * @param options - Optional drain options
   * @returns Array of queued events
   */
  drain(agentId: AgentId, options?: DrainOptions): QueuedSystemEvent[];

  /**
   * Drain events as text strings only
   * @param agentId - Target agent ID
   * @param options - Optional drain options
   * @returns Array of event text strings
   */
  drainText(agentId: AgentId, options?: DrainOptions): string[];

  /**
   * Peek at queued events without removing them
   * @param agentId - Target agent ID
   * @returns Array of event text strings
   */
  peek(agentId: AgentId): string[];

  /**
   * Check if agent has queued events
   * @param agentId - Target agent ID
   * @returns True if events are queued
   */
  hasEvents(agentId: AgentId): boolean;

  /**
   * Get count of queued events for an agent
   * @param agentId - Target agent ID
   * @returns Number of queued events
   */
  getEventCount(agentId: AgentId): number;

  /**
   * Check if context has changed since last enqueue
   * @param agentId - Target agent ID
   * @param contextKey - Context key to check
   * @returns True if context has changed
   */
  isContextChanged(agentId: AgentId, contextKey?: string | null): boolean;

  /**
   * Clear queue for a specific agent
   * @param agentId - Target agent ID
   */
  clear(agentId: AgentId): void;

  /**
   * Clear all queues (for testing/reset)
   */
  reset(): void;

  /**
   * Get all agent IDs with pending events
   * @returns Array of agent IDs
   */
  getAgentsWithEvents(): AgentId[];
}
