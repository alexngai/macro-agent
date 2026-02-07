/**
 * Conversation-related type definitions for mail integration.
 *
 * These types define the materialized views for conversations, turns,
 * and threads stored in the EventStore.
 */

import type { AgentId, Timestamp } from "./primitives.js";

// ─────────────────────────────────────────────────────────────────────────────
// Conversation Types (aligned with MAP SDK)
// ─────────────────────────────────────────────────────────────────────────────

export type ConversationType = "session" | "task" | "peer";

export type ConversationStatus = "active" | "completed" | "failed" | "archived";

export type ParticipantRole =
  | "initiator"
  | "assistant"
  | "worker"
  | "observer";

export type TurnSourceType = "explicit" | "intercepted";

// ─────────────────────────────────────────────────────────────────────────────
// Materialized View Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A conversation groups related interactions between participants.
 * Materialized from `conversation` events.
 */
export interface Conversation {
  id: string;
  type: ConversationType;
  status: ConversationStatus;
  subject?: string;
  parentConversationId?: string;
  createdBy: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  closedAt?: Timestamp;
  closedBy?: string;
  closeReason?: string;
  participantCount: number;
  metadata?: Record<string, unknown>;
}

/**
 * A turn is a single message or event recorded within a conversation.
 * Materialized from `turn` events.
 */
export interface ConversationTurn {
  id: string;
  conversationId: string;
  participant: string;
  timestamp: Timestamp;
  contentType: string;
  content: unknown;
  threadId?: string;
  inReplyTo?: string;
  sourceType: TurnSourceType;
  sourceMessageId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * A thread is a sub-conversation within a conversation, rooted at a specific turn.
 * Materialized from `thread` events.
 */
export interface ConversationThread {
  id: string;
  conversationId: string;
  rootTurnId: string;
  subject?: string;
  parentThreadId?: string;
  createdBy: string;
  createdAt: Timestamp;
  turnCount: number;
}

/**
 * A participant is a member of a conversation with a role and join/leave tracking.
 * Materialized from conversation `participant_joined` / `participant_left` events.
 */
export interface ConversationParticipant {
  id: string;
  conversationId: string;
  type: "user" | "agent" | "system";
  role: ParticipantRole;
  joinedAt: Timestamp;
  leftAt?: Timestamp;
  agentId?: AgentId;
}

// ─────────────────────────────────────────────────────────────────────────────
// Filter Types
// ─────────────────────────────────────────────────────────────────────────────

export interface ConversationFilter {
  type?: ConversationType;
  status?: ConversationStatus;
  participantId?: string;
  parentConversationId?: string;
}

export interface TurnFilter {
  conversationId: string;
  threadId?: string;
  contentType?: string;
  participantId?: string;
  limit?: number;
  order?: "asc" | "desc";
}

// ─────────────────────────────────────────────────────────────────────────────
// Callback Types
// ─────────────────────────────────────────────────────────────────────────────

export type ConversationChangeCallback = (
  conversationId: string,
  conversation: Conversation | null
) => void;

export type TurnChangeCallback = (
  conversationId: string,
  turn: ConversationTurn
) => void;
