/**
 * MailService — Central facade for mail conversation tracking.
 *
 * Provides conversation lifecycle management, turn recording,
 * and participant tracking backed by EventStore materialized views.
 *
 * Since the MAP SDK server module is not importable, this implements
 * the business logic directly rather than delegating to SDK managers.
 */

import { nanoid } from "nanoid";
import type { EventStore } from "../store/event-store.js";
import type {
  Conversation,
  ConversationTurn,
  ConversationParticipant,
  ConversationFilter,
  TurnFilter,
  ConversationType,
  ConversationStatus,
  ConversationChangeCallback,
  TurnChangeCallback,
} from "../store/types/index.js";
import type { Unsubscribe } from "../store/event-store.js";
import {
  EventStoreConversationStore,
  EventStoreTurnStore,
  EventStoreThreadStore,
  EventStoreParticipantStore,
  type ConversationStore,
  type TurnStore,
  type ThreadStore,
  type ParticipantStore,
} from "./stores/index.js";

// =============================================================================
// Types
// =============================================================================

export interface CreateConversationOptions {
  type: ConversationType;
  subject?: string;
  createdBy: string;
  parentConversationId?: string;
  metadata?: Record<string, unknown>;
}

export interface RecordTurnOptions {
  conversationId: string;
  participant: string;
  contentType: string;
  content: unknown;
  threadId?: string;
  inReplyTo?: string;
  sourceType?: "explicit" | "intercepted";
  sourceMessageId?: string;
  metadata?: Record<string, unknown>;
}

export interface CloseConversationOptions {
  conversationId: string;
  closedBy: string;
  reason?: string;
}

export interface JoinConversationOptions {
  conversationId: string;
  participantId: string;
  participantType?: "user" | "agent" | "system";
  role?: string;
  agentId?: string;
}

export interface MailServiceConfig {
  eventStore: EventStore;
}

// =============================================================================
// MailService Interface
// =============================================================================

export interface MailService {
  /** Create a new conversation. */
  createConversation(opts: CreateConversationOptions): { conversationId: string };

  /** Record a turn in a conversation. */
  recordTurn(opts: RecordTurnOptions): { turnId: string };

  /** Close a conversation. */
  closeConversation(opts: CloseConversationOptions): void;

  /** Join a participant to a conversation. */
  joinConversation(opts: JoinConversationOptions): void;

  /** Remove a participant from a conversation. */
  leaveConversation(conversationId: string, participantId: string): void;

  /** Get a conversation by ID. */
  getConversation(id: string): Conversation | null;

  /** List conversations with optional filter. */
  listConversations(filter?: ConversationFilter): Conversation[];

  /** List turns for a conversation. */
  listTurns(filter: TurnFilter): ConversationTurn[];

  /** List participants for a conversation. */
  listParticipants(conversationId: string, active?: boolean): ConversationParticipant[];

  /** Count turns in a conversation. */
  countTurns(conversationId: string, threadId?: string): number;

  /** Subscribe to conversation changes. */
  onConversationChange(callback: ConversationChangeCallback): Unsubscribe;

  /** Subscribe to turn changes. */
  onTurnChange(callback: TurnChangeCallback): Unsubscribe;

  /** Access to underlying stores for MAP handler integration. */
  readonly stores: {
    conversations: ConversationStore;
    turns: TurnStore;
    threads: ThreadStore;
    participants: ParticipantStore;
  };
}

// =============================================================================
// Implementation
// =============================================================================

export function createMailService(config: MailServiceConfig): MailService {
  const { eventStore } = config;

  // Create EventStore-backed stores
  const conversationStore = new EventStoreConversationStore(eventStore);
  const turnStore = new EventStoreTurnStore(eventStore);
  const threadStore = new EventStoreThreadStore(eventStore);
  const participantStore = new EventStoreParticipantStore(eventStore);

  function createConversation(
    opts: CreateConversationOptions
  ): { conversationId: string } {
    const conversationId = `conv_${nanoid(12)}`;

    eventStore.emit({
      type: "conversation",
      source: { agent_id: opts.createdBy },
      payload: {
        action: "created",
        conversation_id: conversationId,
        conversation_type: opts.type,
        subject: opts.subject,
        parent_conversation_id: opts.parentConversationId,
        metadata: opts.metadata,
      },
    });

    return { conversationId };
  }

  function recordTurn(opts: RecordTurnOptions): { turnId: string } {
    const conv = eventStore.getConversation(opts.conversationId);
    if (!conv) {
      throw new Error(`Cannot record turn: conversation not found: ${opts.conversationId}`);
    }

    const turnId = `turn_${nanoid(12)}`;

    eventStore.emit({
      type: "turn",
      source: { agent_id: opts.participant },
      payload: {
        action: "recorded",
        turn_id: turnId,
        conversation_id: opts.conversationId,
        participant: opts.participant,
        content_type: opts.contentType,
        content: opts.content,
        thread_id: opts.threadId,
        in_reply_to: opts.inReplyTo,
        source_type: opts.sourceType ?? "explicit",
        source_message_id: opts.sourceMessageId,
        metadata: opts.metadata,
      },
    });

    return { turnId };
  }

  function closeConversation(opts: CloseConversationOptions): void {
    eventStore.emit({
      type: "conversation",
      source: { agent_id: opts.closedBy },
      payload: {
        action: "closed",
        conversation_id: opts.conversationId,
        closed_by: opts.closedBy,
        close_reason: opts.reason ?? "completed",
      },
    });
  }

  function joinConversation(opts: JoinConversationOptions): void {
    eventStore.emit({
      type: "conversation",
      source: { agent_id: opts.participantId },
      payload: {
        action: "participant_joined",
        conversation_id: opts.conversationId,
        participant_id: opts.participantId,
        participant_type: opts.participantType ?? "agent",
        participant_role: opts.role ?? "worker",
        agent_id: opts.agentId,
      },
    });
  }

  function leaveConversation(
    conversationId: string,
    participantId: string
  ): void {
    eventStore.emit({
      type: "conversation",
      source: { agent_id: participantId },
      payload: {
        action: "participant_left",
        conversation_id: conversationId,
        participant_id: participantId,
      },
    });
  }

  return {
    createConversation,
    recordTurn,
    closeConversation,
    joinConversation,
    leaveConversation,
    getConversation: (id) => eventStore.getConversation(id),
    listConversations: (filter) => eventStore.listConversations(filter),
    listTurns: (filter) => eventStore.listTurns(filter),
    listParticipants: (conversationId, active) =>
      eventStore.listParticipants(conversationId, active),
    countTurns: (conversationId, threadId) =>
      turnStore.count(conversationId, threadId),
    onConversationChange: (callback) =>
      eventStore.onConversationChange(callback),
    onTurnChange: (callback) => eventStore.onTurnChange(callback),
    stores: {
      conversations: conversationStore,
      turns: turnStore,
      threads: threadStore,
      participants: participantStore,
    },
  };
}
