/**
 * Event Log - In-memory ring buffer for MAP event replay
 *
 * Stores emitted MAP events for replay by newly connected clients.
 * Events are stored in chronological order with ULID-based event IDs
 * for keyset pagination.
 *
 * Event type normalization:
 * - Server emits dot format: "agent.registered", "message.sent"
 * - SDK sends underscore format: "agent_registered", "message_sent"
 * - ACP-over-MAP emits underscore format: "message_delivered"
 * - Both formats are normalized to dot format for filter comparison
 * - Response events are converted to underscore format for the SDK
 */

// =============================================================================
// Types
// =============================================================================

/** Configuration for the event log */
export interface EventLogConfig {
  /** Maximum number of events to retain. Default: 10000 */
  maxSize?: number;
}

/** A logged event entry */
export interface LoggedEvent {
  /** ULID event ID — stable, lexicographically sortable */
  eventId: string;
  /** Event timestamp (ms since epoch) */
  timestamp: number;
  /** Event type (dot or underscore format, as emitted) */
  type: string;
  /** Event-specific data payload */
  data: unknown;
  /** Parent event IDs for causal ordering */
  causedBy?: string[];
  /** Related agent ID (for filter matching) */
  agentId?: string;
  /** Related scope ID (for filter matching) */
  scopeId?: string;
}

/** Filter for event log queries */
export interface EventLogFilter {
  /** Event types (can be underscore or dot format — normalized during comparison) */
  eventTypes?: string[];
  /** Agent IDs (OR within array) */
  agents?: string[];
  /** Scope IDs (OR within array) */
  scopes?: string[];
}

/** Query parameters for replay */
export interface EventLogQueryParams {
  /** Keyset pagination cursor — start after this event ID */
  afterEventId?: string;
  /** Include events from this timestamp (inclusive) */
  fromTimestamp?: number;
  /** Include events up to this timestamp (inclusive) */
  toTimestamp?: number;
  /** Event filter */
  filter?: EventLogFilter;
  /** Maximum events to return (capped at 1000) */
  limit?: number;
}

/** Result of an event log query */
export interface EventLogQueryResult {
  /** Matching events in chronological order */
  events: LoggedEvent[];
  /** Whether more events exist beyond this page */
  hasMore: boolean;
}

// =============================================================================
// Format Normalization
// =============================================================================

/** Convert underscore format to dot format: "agent_registered" → "agent.registered" */
export function underscoreToDot(type: string): string {
  return type.replace(/_/g, ".");
}

/** Convert dot format to underscore format: "agent.registered" → "agent_registered" */
export function dotToUnderscore(type: string): string {
  return type.replace(/\./g, "_");
}

// =============================================================================
// EventLog
// =============================================================================

const DEFAULT_MAX_SIZE = 10_000;
const MAX_QUERY_LIMIT = 1000;
const DEFAULT_QUERY_LIMIT = 100;

/**
 * In-memory ring buffer for MAP event replay.
 *
 * Events are appended in emission order and oldest are evicted
 * when the buffer exceeds maxSize.
 */
export class EventLog {
  private readonly buffer: LoggedEvent[] = [];
  private readonly maxSize: number;

  constructor(config: EventLogConfig = {}) {
    this.maxSize = config.maxSize ?? DEFAULT_MAX_SIZE;
  }

  /** Append an event to the log. O(1) amortized. */
  append(event: LoggedEvent): void {
    this.buffer.push(event);

    // Evict oldest events if over capacity
    if (this.buffer.length > this.maxSize) {
      const overflow = this.buffer.length - this.maxSize;
      this.buffer.splice(0, overflow);
    }
  }

  /** Query events with filter and pagination. */
  query(params: EventLogQueryParams = {}): EventLogQueryResult {
    const limit = Math.min(params.limit ?? DEFAULT_QUERY_LIMIT, MAX_QUERY_LIMIT);

    // Normalize filter event types to dot format for comparison
    const normalizedFilterTypes = params.filter?.eventTypes?.map(underscoreToDot);

    let startIndex = 0;

    // Handle afterEventId (keyset pagination)
    if (params.afterEventId) {
      const idx = this.buffer.findIndex(
        (e) => e.eventId === params.afterEventId,
      );
      if (idx >= 0) {
        startIndex = idx + 1;
      }
      // If not found (evicted), start from beginning
    }

    // Handle fromTimestamp (only if no afterEventId)
    if (params.fromTimestamp != null && !params.afterEventId) {
      const idx = this.buffer.findIndex(
        (e) => e.timestamp >= params.fromTimestamp!,
      );
      if (idx >= 0) {
        startIndex = idx;
      } else {
        // All events are before fromTimestamp
        return { events: [], hasMore: false };
      }
    }

    const results: LoggedEvent[] = [];

    for (let i = startIndex; i < this.buffer.length && results.length < limit; i++) {
      const event = this.buffer[i];

      // Apply toTimestamp filter
      if (params.toTimestamp != null && event.timestamp > params.toTimestamp) {
        break;
      }

      // Apply event type filter (normalize stored type for comparison)
      if (normalizedFilterTypes && normalizedFilterTypes.length > 0) {
        const normalizedStoredType = underscoreToDot(event.type);
        if (!normalizedFilterTypes.includes(normalizedStoredType)) {
          continue;
        }
      }

      // Apply agent filter (OR within array)
      if (params.filter?.agents && params.filter.agents.length > 0) {
        if (!event.agentId || !params.filter.agents.includes(event.agentId)) {
          continue;
        }
      }

      // Apply scope filter (OR within array)
      if (params.filter?.scopes && params.filter.scopes.length > 0) {
        if (!event.scopeId || !params.filter.scopes.includes(event.scopeId)) {
          continue;
        }
      }

      results.push(event);
    }

    // Determine hasMore: check if there are more matching events beyond our limit
    let hasMore = false;
    if (results.length === limit) {
      // Check if there's at least one more event in the buffer after our results
      const lastResultIndex = this.buffer.indexOf(results[results.length - 1]);
      if (lastResultIndex >= 0 && lastResultIndex < this.buffer.length - 1) {
        hasMore = true;
      }
    }

    return { events: results, hasMore };
  }

  /** Number of events currently in the buffer. */
  get size(): number {
    return this.buffer.length;
  }
}
