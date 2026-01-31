/**
 * System Event Queue Implementation
 *
 * Lightweight in-memory queue for system events that should be
 * delivered to agents. Events are session-scoped and ephemeral.
 *
 * Inspired by openclaw's system-events.ts pattern.
 *
 * @module trigger/queue/system-event-queue
 */

import type { AgentId } from "../../store/types/index.js";
import type {
  SystemEventQueue,
  QueuedSystemEvent,
  SessionQueue,
  EnqueueOptions,
  DrainOptions,
} from "./types.js";

// =============================================================================
// Configuration
// =============================================================================

/** Maximum events per agent queue */
const DEFAULT_MAX_EVENTS = 50;

/** Priority order for sorting (higher = more important) */
const PRIORITY_ORDER: Record<string, number> = {
  urgent: 4,
  high: 3,
  normal: 2,
  low: 1,
};

// =============================================================================
// Implementation
// =============================================================================

/**
 * Create a new system event queue
 */
export function createSystemEventQueue(options?: {
  maxEventsPerAgent?: number;
}): SystemEventQueue {
  const maxEvents = options?.maxEventsPerAgent ?? DEFAULT_MAX_EVENTS;
  const queues = new Map<AgentId, SessionQueue>();

  /**
   * Get or create a session queue for an agent
   */
  function getOrCreateQueue(agentId: AgentId): SessionQueue {
    let queue = queues.get(agentId);
    if (!queue) {
      queue = {
        queue: [],
        lastText: null,
        lastContextKey: null,
      };
      queues.set(agentId, queue);
    }
    return queue;
  }

  /**
   * Normalize context key for comparison
   */
  function normalizeContextKey(key?: string | null): string | null {
    if (!key) return null;
    const trimmed = key.trim();
    return trimmed ? trimmed.toLowerCase() : null;
  }

  /**
   * Sort events by priority if requested
   */
  function sortByPriority(events: QueuedSystemEvent[]): QueuedSystemEvent[] {
    return [...events].sort((a, b) => {
      const priorityA = PRIORITY_ORDER[a.priority ?? "normal"] ?? 2;
      const priorityB = PRIORITY_ORDER[b.priority ?? "normal"] ?? 2;
      // Higher priority first, then by timestamp
      if (priorityA !== priorityB) {
        return priorityB - priorityA;
      }
      return a.ts - b.ts;
    });
  }

  return {
    enqueue(text: string, options: EnqueueOptions): void {
      const cleaned = text.trim();
      if (!cleaned) return;

      const queue = getOrCreateQueue(options.agentId);

      // Update context key
      queue.lastContextKey = normalizeContextKey(options.contextKey);

      // Skip consecutive duplicates (same text as last)
      if (queue.lastText === cleaned) {
        return;
      }
      queue.lastText = cleaned;

      // Create event
      const event: QueuedSystemEvent = {
        text: cleaned,
        ts: Date.now(),
        sourceKey: options.sourceKey,
        priority: options.priority,
      };

      // Add to queue
      queue.queue.push(event);

      // Evict oldest if over limit
      if (queue.queue.length > maxEvents) {
        queue.queue.shift();
      }
    },

    drain(agentId: AgentId, options?: DrainOptions): QueuedSystemEvent[] {
      const queue = queues.get(agentId);
      if (!queue || queue.queue.length === 0) {
        return [];
      }

      let events = [...queue.queue];

      // Sort by priority if requested
      if (options?.sortByPriority) {
        events = sortByPriority(events);
      }

      // Apply limit
      if (options?.limit && options.limit > 0) {
        events = events.slice(0, options.limit);
      }

      // Clear the queue
      queue.queue.length = 0;
      queue.lastText = null;
      queue.lastContextKey = null;
      queues.delete(agentId);

      return events;
    },

    drainText(agentId: AgentId, options?: DrainOptions): string[] {
      return this.drain(agentId, options).map((e) => e.text);
    },

    peek(agentId: AgentId): string[] {
      const queue = queues.get(agentId);
      return queue?.queue.map((e) => e.text) ?? [];
    },

    hasEvents(agentId: AgentId): boolean {
      const queue = queues.get(agentId);
      return (queue?.queue.length ?? 0) > 0;
    },

    getEventCount(agentId: AgentId): number {
      const queue = queues.get(agentId);
      return queue?.queue.length ?? 0;
    },

    isContextChanged(agentId: AgentId, contextKey?: string | null): boolean {
      const queue = queues.get(agentId);
      const normalized = normalizeContextKey(contextKey);
      return normalized !== (queue?.lastContextKey ?? null);
    },

    clear(agentId: AgentId): void {
      queues.delete(agentId);
    },

    reset(): void {
      queues.clear();
    },

    getAgentsWithEvents(): AgentId[] {
      const agents: AgentId[] = [];
      for (const [agentId, queue] of queues) {
        if (queue.queue.length > 0) {
          agents.push(agentId);
        }
      }
      return agents;
    },
  };
}

// =============================================================================
// Formatting Helpers
// =============================================================================

/**
 * Format queued events as a system message block
 */
export function formatQueuedEventsAsSystemMessage(
  events: QueuedSystemEvent[]
): string {
  if (events.length === 0) {
    return "";
  }

  const lines = ["[System Events]"];
  for (const event of events) {
    const timestamp = new Date(event.ts).toISOString();
    const priority = event.priority && event.priority !== "normal"
      ? ` [${event.priority.toUpperCase()}]`
      : "";
    lines.push(`• ${timestamp}${priority}: ${event.text}`);
  }
  return lines.join("\n");
}

/**
 * Format queued event texts as a simple block
 */
export function formatQueuedTextsAsBlock(texts: string[]): string {
  if (texts.length === 0) {
    return "";
  }

  if (texts.length === 1) {
    return `[System Event] ${texts[0]}`;
  }

  return `[System Events]\n${texts.map((t) => `• ${t}`).join("\n")}`;
}
