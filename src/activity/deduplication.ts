/**
 * Activity Deduplication
 *
 * Prevents alert storms by deduplicating similar activities within a time window.
 * Uses a slot-based pattern inspired by Gastown's notification deduplication.
 *
 * @module activity/deduplication
 * @see s-9rld In-Flight Steering spec
 * @see Gastown internal/daemon/notification.go
 */

import type { AgentId } from "../store/types/index.js";
import type { Activity, ActivityEventType } from "./types.js";

// =============================================================================
// Types
// =============================================================================

/**
 * Key for deduplication slot
 */
export interface DeduplicationKey {
  /** Agent being notified */
  agentId: AgentId;
  /** Event type */
  eventType: ActivityEventType | string;
  /** Optional source agent (for source-specific dedup) */
  sourceAgentId?: AgentId;
}

/**
 * Slot entry tracking recent notifications
 */
interface SlotEntry {
  /** Key for this slot */
  key: string;
  /** Timestamp of last notification */
  lastNotified: number;
  /** Count of suppressed notifications */
  suppressedCount: number;
}

/**
 * Deduplication configuration
 */
export interface DeduplicationConfig {
  /** Time window for deduplication in milliseconds */
  windowMs: number;
  /** Maximum slots to track (LRU eviction) */
  maxSlots: number;
  /** Whether to track suppression counts */
  trackSuppressed: boolean;
}

const DEFAULT_DEDUP_CONFIG: DeduplicationConfig = {
  windowMs: 5000,
  maxSlots: 10000,
  trackSuppressed: true,
};

// =============================================================================
// Deduplicator Implementation
// =============================================================================

/**
 * Activity deduplicator using slot-based pattern.
 *
 * Prevents the same agent from being notified multiple times for similar
 * events within a configurable time window.
 */
export class ActivityDeduplicator {
  private slots = new Map<string, SlotEntry>();
  private config: DeduplicationConfig;

  constructor(config: Partial<DeduplicationConfig> = {}) {
    this.config = { ...DEFAULT_DEDUP_CONFIG, ...config };
  }

  /**
   * Check if a notification should be sent.
   *
   * @param agentId - Agent to notify
   * @param activity - Activity triggering the notification
   * @returns true if notification should be sent, false if suppressed
   */
  shouldNotify(agentId: AgentId, activity: Activity): boolean {
    const key = this.buildKey({
      agentId,
      eventType: activity.type,
      sourceAgentId: activity.source?.agent_id,
    });

    const now = Date.now();
    const existing = this.slots.get(key);

    if (existing) {
      // Check if within deduplication window
      if (now - existing.lastNotified < this.config.windowMs) {
        // Suppress notification
        if (this.config.trackSuppressed) {
          existing.suppressedCount++;
        }
        return false;
      }
    }

    // Update slot
    this.slots.set(key, {
      key,
      lastNotified: now,
      suppressedCount: 0,
    });

    // Evict old entries if needed
    this.evictIfNeeded();

    return true;
  }

  /**
   * Mark a notification as sent (update slot timestamp).
   */
  markNotified(agentId: AgentId, activity: Activity): void {
    const key = this.buildKey({
      agentId,
      eventType: activity.type,
      sourceAgentId: activity.source?.agent_id,
    });

    this.slots.set(key, {
      key,
      lastNotified: Date.now(),
      suppressedCount: 0,
    });

    this.evictIfNeeded();
  }

  /**
   * Get suppression stats for debugging.
   */
  getStats(): { totalSlots: number; totalSuppressed: number } {
    let totalSuppressed = 0;
    for (const slot of this.slots.values()) {
      totalSuppressed += slot.suppressedCount;
    }
    return {
      totalSlots: this.slots.size,
      totalSuppressed,
    };
  }

  /**
   * Clear all slots.
   */
  clear(): void {
    this.slots.clear();
  }

  /**
   * Clear expired slots (outside deduplication window).
   */
  clearExpired(): number {
    const now = Date.now();
    let cleared = 0;

    for (const [key, slot] of this.slots) {
      if (now - slot.lastNotified >= this.config.windowMs) {
        this.slots.delete(key);
        cleared++;
      }
    }

    return cleared;
  }

  /**
   * Build a slot key from deduplication key components.
   */
  private buildKey(keyParts: DeduplicationKey): string {
    const parts = [keyParts.agentId, keyParts.eventType];
    if (keyParts.sourceAgentId) {
      parts.push(keyParts.sourceAgentId);
    }
    return parts.join("::");
  }

  /**
   * Evict oldest entries if over max slots.
   */
  private evictIfNeeded(): void {
    if (this.slots.size <= this.config.maxSlots) {
      return;
    }

    // Find and remove oldest entries
    const entries = [...this.slots.entries()].sort(
      (a, b) => a[1].lastNotified - b[1].lastNotified
    );

    const toRemove = entries.slice(0, this.slots.size - this.config.maxSlots);
    for (const [key] of toRemove) {
      this.slots.delete(key);
    }
  }
}

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Create an activity deduplicator with the given configuration.
 */
export function createDeduplicator(
  config?: Partial<DeduplicationConfig>
): ActivityDeduplicator {
  return new ActivityDeduplicator(config);
}
