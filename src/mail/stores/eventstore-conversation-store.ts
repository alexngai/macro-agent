/**
 * EventStore-backed ConversationStore adapter.
 *
 * Implements the MAP-compatible ConversationStore interface by:
 * - save() → emits a `conversation` event with action `created` or `updated`
 * - get()/list() → reads from EventStore materialized views
 * - delete() → not supported (conversations are closed, not deleted)
 *
 * All state is derived from the EventStore event log — this adapter
 * is a thin translation layer between MAP server types and EventStore.
 */

import type { EventStore } from "../../store/event-store.js";
import type {
  ConversationStore,
  ServerConversation,
  MAPConversationFilter,
} from "./types.js";
import type { Conversation, ConversationFilter } from "../../store/types/index.js";

/**
 * Convert internal Conversation to MAP ServerConversation.
 */
function toServerConversation(conv: Conversation): ServerConversation {
  return {
    id: conv.id,
    type: conv.type,
    status: conv.status,
    subject: conv.subject,
    participantCount: conv.participantCount,
    parentConversationId: conv.parentConversationId,
    createdAt: conv.createdAt,
    updatedAt: conv.updatedAt,
    closedAt: conv.closedAt,
    createdBy: conv.createdBy,
    metadata: conv.metadata ?? {},
  };
}

export class EventStoreConversationStore implements ConversationStore {
  constructor(private readonly eventStore: EventStore) {}

  /**
   * Save a conversation by emitting a conversation event.
   * If the conversation already exists, emits an update.
   */
  save(conversation: ServerConversation): void {
    const existing = this.eventStore.getConversation(conversation.id);

    if (existing) {
      // Update: emit a conversation event with action "updated"
      // For now we handle status changes (e.g., closing)
      if (existing.status !== conversation.status && (conversation.status === "completed" || conversation.status === "failed")) {
        this.eventStore.emit({
          type: "conversation",
          source: { agent_id: conversation.createdBy },
          payload: {
            action: "closed",
            conversation_id: conversation.id,
            closed_by: conversation.createdBy,
            close_reason: conversation.status,
          },
        });
      }
    } else {
      // Create: emit conversation created event
      this.eventStore.emit({
        type: "conversation",
        source: { agent_id: conversation.createdBy },
        payload: {
          action: "created",
          conversation_id: conversation.id,
          conversation_type: conversation.type,
          subject: conversation.subject,
          parent_conversation_id: conversation.parentConversationId,
          metadata: conversation.metadata,
        },
      });
    }
  }

  /**
   * Get a conversation by ID.
   */
  get(id: string): ServerConversation | undefined {
    const conv = this.eventStore.getConversation(id);
    return conv ? toServerConversation(conv) : undefined;
  }

  /**
   * List conversations matching filter criteria.
   */
  list(filter?: MAPConversationFilter): ServerConversation[] {
    // Translate MAP filter to internal filter
    const internalFilter: ConversationFilter | undefined = filter
      ? {
          // MAP uses arrays for type/status, internal uses single values
          // Use first value if provided
          type: filter.type?.[0] as Conversation["type"] | undefined,
          status: filter.status?.[0] as Conversation["status"] | undefined,
          participantId: filter.participantId,
          parentConversationId: filter.parentConversationId,
        }
      : undefined;

    const conversations = this.eventStore.listConversations(internalFilter);

    // Apply additional MAP-specific filters not in internal filter
    let results = conversations.map(toServerConversation);

    if (filter) {
      // Multi-value type filter
      if (filter.type && filter.type.length > 1) {
        results = results.filter((c) => filter.type!.includes(c.type));
      }
      // Multi-value status filter
      if (filter.status && filter.status.length > 1) {
        results = results.filter((c) => filter.status!.includes(c.status));
      }
      // Timestamp range filters
      if (filter.createdAfter !== undefined) {
        results = results.filter((c) => c.createdAt > filter.createdAfter!);
      }
      if (filter.createdBefore !== undefined) {
        results = results.filter((c) => c.createdAt < filter.createdBefore!);
      }
    }

    return results;
  }

  /**
   * Delete a conversation. Not supported — conversations are closed, not deleted.
   * Returns false as no deletion occurs.
   */
  delete(_id: string): boolean {
    return false;
  }

  /**
   * Clear all conversations. Not supported — EventStore is append-only.
   */
  clear(): void {
    // No-op: EventStore is append-only, views are rebuilt on replay
  }
}
