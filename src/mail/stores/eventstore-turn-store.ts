/**
 * EventStore-backed TurnStore adapter.
 *
 * Implements the MAP-compatible TurnStore interface by:
 * - append() → emits a `turn` event with action `recorded`
 * - get()/list() → reads from EventStore materialized views
 * - count() → counts turns in materialized view
 *
 * Supports cursor-based pagination and timestamp range queries
 * by post-filtering EventStore results.
 */

import type { EventStore } from "../../store/event-store.js";
import type { TurnStore, ServerTurn, MAPTurnFilter } from "./types.js";
import type { ConversationTurn, TurnFilter } from "../../store/types/index.js";

/**
 * Convert internal ConversationTurn to MAP ServerTurn.
 */
function toServerTurn(turn: ConversationTurn): ServerTurn {
  return {
    id: turn.id,
    conversationId: turn.conversationId,
    participant: turn.participant,
    timestamp: turn.timestamp,
    contentType: turn.contentType,
    content: turn.content,
    threadId: turn.threadId,
    inReplyTo: turn.inReplyTo,
    source:
      turn.sourceType === "intercepted" && turn.sourceMessageId
        ? { type: "intercepted", messageId: turn.sourceMessageId }
        : { type: "explicit", method: "mail/turn" },
    metadata: turn.metadata ?? {},
  };
}

export class EventStoreTurnStore implements TurnStore {
  constructor(private readonly eventStore: EventStore) {}

  /**
   * Append a turn by emitting a turn event.
   */
  append(turn: ServerTurn): void {
    this.eventStore.emit({
      type: "turn",
      source: { agent_id: turn.participant },
      payload: {
        action: "recorded",
        turn_id: turn.id,
        conversation_id: turn.conversationId,
        participant: turn.participant,
        content_type: turn.contentType,
        content: turn.content,
        thread_id: turn.threadId,
        in_reply_to: turn.inReplyTo,
        source_type: turn.source.type,
        source_message_id:
          turn.source.type === "intercepted"
            ? turn.source.messageId
            : undefined,
        metadata: turn.metadata,
      },
    });
  }

  /**
   * Get a specific turn by ID.
   * Searches across all conversations since we only have the turn ID.
   */
  get(id: string): ServerTurn | undefined {
    // EventStore's listTurns requires a conversationId.
    // For ID-based lookup, we scan all turns. In practice this is
    // called rarely — most access is via list() with a conversationId.
    //
    // A more efficient approach would be adding a getTurn(id) method
    // to EventStore, but for now this works with the existing interface.
    const allConvIds = this.eventStore
      .listConversations()
      .map((c) => c.id);

    for (const convId of allConvIds) {
      const turns = this.eventStore.listTurns({ conversationId: convId });
      const turn = turns.find((t) => t.id === id);
      if (turn) return toServerTurn(turn);
    }

    return undefined;
  }

  /**
   * List turns matching filter criteria with pagination.
   */
  list(filter: MAPTurnFilter): ServerTurn[] {
    // Get all turns for the conversation with basic filters
    const internalFilter: TurnFilter = {
      conversationId: filter.conversationId,
      threadId: filter.threadId,
      contentType: filter.contentTypes?.[0],
      participantId: filter.participantId,
      order: filter.order,
    };

    let turns = this.eventStore
      .listTurns(internalFilter)
      .map(toServerTurn);

    // Apply multi-value content type filter
    if (filter.contentTypes && filter.contentTypes.length > 1) {
      turns = turns.filter((t) =>
        filter.contentTypes!.includes(t.contentType)
      );
    }

    // Apply timestamp range filters
    if (filter.afterTimestamp !== undefined) {
      turns = turns.filter((t) => t.timestamp > filter.afterTimestamp!);
    }
    if (filter.beforeTimestamp !== undefined) {
      turns = turns.filter((t) => t.timestamp < filter.beforeTimestamp!);
    }

    // Apply cursor-based pagination
    if (filter.afterTurnId) {
      const idx = turns.findIndex((t) => t.id === filter.afterTurnId);
      if (idx !== -1) {
        turns = turns.slice(idx + 1);
      }
    }
    if (filter.beforeTurnId) {
      const idx = turns.findIndex((t) => t.id === filter.beforeTurnId);
      if (idx !== -1) {
        turns = turns.slice(0, idx);
      }
    }

    // Apply limit
    if (filter.limit !== undefined) {
      turns = turns.slice(0, filter.limit);
    }

    return turns;
  }

  /**
   * Delete a specific turn. Not supported — EventStore is append-only.
   */
  delete(_id: string): boolean {
    return false;
  }

  /**
   * Delete all turns for a conversation. Not supported.
   */
  deleteByConversation(_conversationId: string): number {
    return 0;
  }

  /**
   * Count turns in a conversation.
   */
  count(conversationId: string, threadId?: string): number {
    const filter: TurnFilter = { conversationId, threadId };
    return this.eventStore.listTurns(filter).length;
  }

  /**
   * Clear all turns. Not supported — EventStore is append-only.
   */
  clear(): void {
    // No-op
  }
}
