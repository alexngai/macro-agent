/**
 * EventStore-backed ParticipantStore adapter.
 *
 * Implements the MAP-compatible ParticipantStore interface by:
 * - save() → emits conversation events with action `participant_joined`
 * - get()/list() → reads from EventStore materialized views
 * - Bidirectional lookup: conversation→participants and participant→conversations
 */

import type { EventStore } from "../../store/event-store.js";
import type {
  ParticipantStore,
  ServerParticipant,
  MAPParticipantFilter,
} from "./types.js";
import type { ConversationParticipant } from "../../store/types/index.js";

/** Default permissions for participants. */
const DEFAULT_PERMISSIONS: ServerParticipant["permissions"] = {
  canSend: true,
  canObserve: true,
  canInvite: false,
  canRemove: false,
  canCreateThreads: true,
  historyAccess: "full",
  canSeeInternal: false,
};

/**
 * Convert internal ConversationParticipant to MAP ServerParticipant.
 */
function toServerParticipant(p: ConversationParticipant): ServerParticipant {
  return {
    id: p.id,
    conversationId: p.conversationId,
    type: p.type,
    role: p.role,
    joinedAt: p.joinedAt,
    leftAt: p.leftAt,
    permissions: DEFAULT_PERMISSIONS,
    agentInfo: p.agentId ? { agentId: p.agentId } : undefined,
  };
}

export class EventStoreParticipantStore implements ParticipantStore {
  constructor(private readonly eventStore: EventStore) {}

  /**
   * Save a participant by emitting a conversation participant_joined event.
   */
  save(participant: ServerParticipant): void {
    this.eventStore.emit({
      type: "conversation",
      source: { agent_id: participant.id },
      payload: {
        action: "participant_joined",
        conversation_id: participant.conversationId,
        participant_id: participant.id,
        participant_type: participant.type,
        participant_role: participant.role,
        agent_id: participant.agentInfo?.agentId,
      },
    });
  }

  /**
   * Get a specific participant in a conversation.
   */
  get(
    conversationId: string,
    participantId: string
  ): ServerParticipant | undefined {
    const participants = this.eventStore.listParticipants(conversationId);
    const found = participants.find((p) => p.id === participantId);
    return found ? toServerParticipant(found) : undefined;
  }

  /**
   * List participants matching filter criteria.
   */
  list(filter: MAPParticipantFilter): ServerParticipant[] {
    if (filter.conversationId) {
      const participants = this.eventStore
        .listParticipants(filter.conversationId, filter.active)
        .map(toServerParticipant);

      return participants.filter((p) => {
        if (filter.participantId && p.id !== filter.participantId) return false;
        if (filter.role && p.role !== filter.role) return false;
        return true;
      });
    }

    // Without conversationId, we need to scan all conversations
    if (filter.participantId) {
      const convIds = this.getConversationsForParticipant(
        filter.participantId,
        filter.active
      );
      const results: ServerParticipant[] = [];
      for (const convId of convIds) {
        const participants = this.eventStore.listParticipants(convId);
        const found = participants.find((p) => p.id === filter.participantId);
        if (found) {
          const sp = toServerParticipant(found);
          if (!filter.role || sp.role === filter.role) {
            results.push(sp);
          }
        }
      }
      return results;
    }

    // No conversationId and no participantId — return empty
    // (listing all participants across all conversations is expensive and rarely needed)
    return [];
  }

  /**
   * Remove a participant from a conversation by emitting a participant_left event.
   */
  delete(conversationId: string, participantId: string): boolean {
    const existing = this.get(conversationId, participantId);
    if (!existing) return false;

    this.eventStore.emit({
      type: "conversation",
      source: { agent_id: participantId },
      payload: {
        action: "participant_left",
        conversation_id: conversationId,
        participant_id: participantId,
      },
    });

    return true;
  }

  /**
   * Delete all participants for a conversation. Not supported.
   */
  deleteByConversation(_conversationId: string): number {
    return 0;
  }

  /**
   * Get all conversation IDs a participant belongs to.
   */
  getConversationsForParticipant(
    participantId: string,
    active?: boolean
  ): string[] {
    const conversations = this.eventStore.listConversations();
    const result: string[] = [];

    for (const conv of conversations) {
      const participants = this.eventStore.listParticipants(conv.id, active);
      if (participants.some((p) => p.id === participantId)) {
        result.push(conv.id);
      }
    }

    return result;
  }

  /**
   * Clear all participants. Not supported — EventStore is append-only.
   */
  clear(): void {
    // No-op
  }
}
