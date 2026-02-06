/**
 * Event Translator - Translates internal EventStore events to MAP events
 *
 * Converts internal macro-agent events (spawn, terminate, status, message, task)
 * to MAP protocol event format (EventNotification).
 *
 * Translation happens at the adapter boundary, keeping internal events unchanged.
 *
 * @see specs/s-5qir_map_integration_for_macro_agent.md
 */

import { ulid } from "ulid";
import type { Event, EventType, StatusType } from "../../store/types/events.js";
import type { AgentId } from "../../store/types/primitives.js";
import type { EventNotification, MAPEventType } from "./types.js";
import type { ScopeId } from "../types.js";

// =============================================================================
// Translation Types
// =============================================================================

/**
 * Result of translating an internal event.
 * Some internal events map to multiple MAP events.
 */
export type TranslationResult =
  | { translated: true; events: EventNotification[] }
  | { translated: false; reason: string };

/**
 * Context for event translation.
 */
export interface TranslationContext {
  /**
   * Generate unique event ID.
   * Defaults to ULID generation.
   */
  generateEventId?: () => string;
}

// =============================================================================
// Event Type Mapping
// =============================================================================

/**
 * Map internal event types to MAP event types.
 */
const EVENT_TYPE_MAP: Record<EventType, MAPEventType | MAPEventType[] | null> = {
  spawn: "agent.registered",
  terminate: "agent.unregistered",
  status: "agent.state.changed",
  message: ["message.sent", "message.delivered"], // Two events for message
  task: null, // Handled specially based on payload
  subscription: null, // Internal only, not exposed
  peer_message: null, // Federation, handled separately
  peer_request: null, // Federation, handled separately
  conversation: null, // Mail: handled by mail module
  turn: null, // Mail: handled by mail module
  thread: null, // Mail: handled by mail module
};

/**
 * Map status types to agent state names.
 */
const STATUS_TO_STATE: Record<StatusType, string> = {
  started: "running",
  checkpoint: "running",
  blocked: "blocked",
  discovery: "running",
  completed: "completed",
  failed: "failed",
};

/**
 * Map task payload types to MAP event types.
 */
const TASK_EVENT_MAP: Record<string, MAPEventType> = {
  created: "task.created",
  assigned: "task.assigned",
  completed: "task.completed",
  failed: "task.failed",
};

// =============================================================================
// Translation Functions
// =============================================================================

/**
 * Translate an internal EventStore event to MAP EventNotification(s).
 *
 * Some internal events (like message) produce multiple MAP events.
 *
 * @param event - Internal event from EventStore
 * @param context - Optional translation context
 * @returns Translation result with MAP events or reason for not translating
 */
export function translateEvent(
  event: Event,
  context: TranslationContext = {}
): TranslationResult {
  const generateEventId = context.generateEventId ?? (() => ulid());

  switch (event.type) {
    case "spawn":
      return translateSpawnEvent(event, generateEventId);

    case "terminate":
      return translateTerminateEvent(event, generateEventId);

    case "status":
      return translateStatusEvent(event, generateEventId);

    case "message":
      return translateMessageEvent(event, generateEventId);

    case "task":
      return translateTaskEvent(event, generateEventId);

    case "subscription":
    case "peer_message":
    case "peer_request":
      return { translated: false, reason: `Event type not exposed: ${event.type}` };

    default:
      return { translated: false, reason: `Unknown event type: ${event.type}` };
  }
}

/**
 * Translate spawn event to agent.registered.
 */
function translateSpawnEvent(
  event: Event,
  generateEventId: () => string
): TranslationResult {
  const agentId = event.source.agent_id;
  if (!agentId) {
    return { translated: false, reason: "Spawn event missing agent_id" };
  }

  const notification: EventNotification = {
    eventId: generateEventId(),
    type: "agent.registered",
    timestamp: event.timestamp,
    data: {
      agentId,
      name: event.payload.name,
      role: event.payload.role,
      parent: event.payload.parent_id,
      metadata: event.payload.metadata,
    },
    agentId,
  };

  return { translated: true, events: [notification] };
}

/**
 * Translate terminate event to agent.unregistered.
 */
function translateTerminateEvent(
  event: Event,
  generateEventId: () => string
): TranslationResult {
  const agentId = event.source.agent_id;
  if (!agentId) {
    return { translated: false, reason: "Terminate event missing agent_id" };
  }

  const notification: EventNotification = {
    eventId: generateEventId(),
    type: "agent.unregistered",
    timestamp: event.timestamp,
    data: {
      agentId,
      reason: event.payload.reason,
      exitCode: event.payload.exit_code,
    },
    agentId,
  };

  return { translated: true, events: [notification] };
}

/**
 * Translate status event to agent.state.changed.
 */
function translateStatusEvent(
  event: Event,
  generateEventId: () => string
): TranslationResult {
  const agentId = event.source.agent_id;
  if (!agentId) {
    return { translated: false, reason: "Status event missing agent_id" };
  }

  const statusType = event.payload.status as StatusType;
  const state = STATUS_TO_STATE[statusType] ?? statusType;

  const notification: EventNotification = {
    eventId: generateEventId(),
    type: "agent.state.changed",
    timestamp: event.timestamp,
    data: {
      agentId,
      state,
      previousState: event.payload.previous_state,
      message: event.payload.message,
      metadata: event.payload.metadata,
    },
    agentId,
  };

  return { translated: true, events: [notification] };
}

/**
 * Translate message event to message.sent and message.delivered.
 *
 * A single internal message event produces two MAP events:
 * - message.sent: When message is sent
 * - message.delivered: For each recipient (or one aggregated)
 */
function translateMessageEvent(
  event: Event,
  generateEventId: () => string
): TranslationResult {
  const senderId = event.source.agent_id;
  if (!senderId) {
    return { translated: false, reason: "Message event missing sender agent_id" };
  }

  const events: EventNotification[] = [];

  // message.sent event
  const sentEvent: EventNotification = {
    eventId: generateEventId(),
    type: "message.sent",
    timestamp: event.timestamp,
    data: {
      messageId: event.id,
      from: senderId,
      to: event.target?.address ?? event.target?.agent_id,
      content: event.payload.content,
      priority: event.payload.priority,
      correlationId: event.metadata?.correlation_id,
    },
    agentId: senderId,
  };
  events.push(sentEvent);

  // message.delivered event(s)
  const delivered = event.target?.delivered ?? (event.target?.agent_id ? [event.target.agent_id] : []);
  if (delivered.length > 0) {
    const deliveredEvent: EventNotification = {
      eventId: generateEventId(),
      type: "message.delivered",
      timestamp: event.timestamp,
      data: {
        messageId: event.id,
        from: senderId,
        to: delivered,
        deliveredCount: delivered.length,
      },
      causedBy: [sentEvent.eventId],
    };
    events.push(deliveredEvent);
  }

  return { translated: true, events };
}

/**
 * Translate task event to task.* events.
 */
function translateTaskEvent(
  event: Event,
  generateEventId: () => string
): TranslationResult {
  const taskAction = event.payload.action as string;
  const mapEventType = TASK_EVENT_MAP[taskAction];

  if (!mapEventType) {
    return { translated: false, reason: `Unknown task action: ${taskAction}` };
  }

  const notification: EventNotification = {
    eventId: generateEventId(),
    type: mapEventType,
    timestamp: event.timestamp,
    data: {
      taskId: event.payload.task_id,
      title: event.payload.title,
      description: event.payload.description,
      assignee: event.payload.assignee,
      status: event.payload.status,
      result: event.payload.result,
      error: event.payload.error,
    },
    agentId: event.source.agent_id,
  };

  return { translated: true, events: [notification] };
}

// =============================================================================
// Batch Translation
// =============================================================================

/**
 * Translate multiple events, filtering out untranslatable ones.
 *
 * @param events - Array of internal events
 * @param context - Translation context
 * @returns Array of MAP events (flattened)
 */
export function translateEvents(
  events: Event[],
  context: TranslationContext = {}
): EventNotification[] {
  const results: EventNotification[] = [];

  for (const event of events) {
    const result = translateEvent(event, context);
    if (result.translated) {
      results.push(...result.events);
    }
  }

  return results;
}

// =============================================================================
// Event Stream Adapter
// =============================================================================

/**
 * Options for creating an event stream adapter.
 */
export interface EventStreamAdapterOptions {
  /**
   * Function to subscribe to internal events.
   * Called with callback that receives events.
   * Returns unsubscribe function.
   */
  subscribe: (callback: (event: Event) => void) => () => void;

  /**
   * Translation context.
   */
  context?: TranslationContext;
}

/**
 * Create an event stream adapter that translates internal events
 * and calls handlers with MAP events.
 *
 * @param options - Adapter options
 * @returns Object with onEvent registration and cleanup
 */
export function createEventStreamAdapter(options: EventStreamAdapterOptions): {
  /**
   * Register handler for MAP events.
   * Returns unsubscribe function.
   */
  onEvent: (handler: (event: EventNotification) => void) => () => void;

  /**
   * Stop the adapter and clean up.
   */
  stop: () => void;
} {
  const handlers = new Set<(event: EventNotification) => void>();
  let unsubscribe: (() => void) | null = null;

  // Start subscription when first handler is added
  const ensureSubscription = () => {
    if (unsubscribe) return;

    unsubscribe = options.subscribe((event) => {
      const result = translateEvent(event, options.context);
      if (result.translated) {
        for (const mapEvent of result.events) {
          for (const handler of handlers) {
            try {
              handler(mapEvent);
            } catch (error) {
              console.error("[EventStreamAdapter] Handler error:", error);
            }
          }
        }
      }
    });
  };

  return {
    onEvent(handler) {
      handlers.add(handler);
      ensureSubscription();

      return () => {
        handlers.delete(handler);
        // Keep subscription active even with no handlers
        // (adapter might be reused)
      };
    },

    stop() {
      unsubscribe?.();
      unsubscribe = null;
      handlers.clear();
    },
  };
}
