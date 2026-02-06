/**
 * MAP-compatible store interfaces for mail.
 *
 * These mirror the store interfaces from the MAP SDK server module
 * (ConversationStore, TurnStore, ThreadStore, ParticipantStore) so that
 * our EventStore-backed implementations can be plugged into MAP handlers.
 *
 * The MAP SDK server module is not exported from the installed package,
 * so we define the interfaces locally. They match the SDK's shapes so
 * swapping to SDK imports is a single-line change per type.
 */

// =============================================================================
// Server-side record types (match MAP SDK ServerConversation, etc.)
// =============================================================================

export interface ServerConversation {
  id: string;
  type: string;
  status: string;
  subject?: string;
  participantCount: number;
  parentConversationId?: string;
  parentTurnId?: string;
  createdAt: number;
  updatedAt: number;
  closedAt?: number;
  createdBy: string;
  metadata: Record<string, unknown>;
}

export interface ServerParticipant {
  id: string;
  conversationId: string;
  type: "user" | "agent" | "system";
  role: string;
  joinedAt: number;
  leftAt?: number;
  permissions: {
    canSend: boolean;
    canObserve: boolean;
    canInvite: boolean;
    canRemove: boolean;
    canCreateThreads: boolean;
    historyAccess: "none" | "from-join" | "full";
    canSeeInternal: boolean;
  };
  agentInfo?: {
    agentId: string;
    name?: string;
    role?: string;
  };
}

export interface ServerTurn {
  id: string;
  conversationId: string;
  participant: string;
  timestamp: number;
  contentType: string;
  content: unknown;
  threadId?: string;
  inReplyTo?: string;
  source: { type: "explicit"; method: "mail/turn" } | { type: "intercepted"; messageId: string };
  visibility?: { type: string; [key: string]: unknown };
  status?: string;
  metadata: Record<string, unknown>;
}

export interface ServerThread {
  id: string;
  conversationId: string;
  parentThreadId?: string;
  subject?: string;
  rootTurnId: string;
  turnCount: number;
  participantCount: number;
  createdAt: number;
  updatedAt: number;
  createdBy: string;
}

// =============================================================================
// Filter types (match MAP SDK ConversationFilter, TurnFilter, etc.)
// =============================================================================

export interface MAPConversationFilter {
  type?: string[];
  status?: string[];
  participantId?: string;
  createdAfter?: number;
  createdBefore?: number;
  parentConversationId?: string;
}

export interface MAPTurnFilter {
  conversationId: string;
  threadId?: string;
  contentTypes?: string[];
  participantId?: string;
  afterTurnId?: string;
  beforeTurnId?: string;
  afterTimestamp?: number;
  beforeTimestamp?: number;
  limit?: number;
  order?: "asc" | "desc";
}

export interface MAPThreadFilter {
  conversationId: string;
  parentThreadId?: string;
}

export interface MAPParticipantFilter {
  conversationId?: string;
  participantId?: string;
  role?: string;
  active?: boolean;
}

// =============================================================================
// Store interfaces (match MAP SDK ConversationStore, TurnStore, etc.)
// =============================================================================

export interface ConversationStore {
  save(conversation: ServerConversation): void;
  get(id: string): ServerConversation | undefined;
  list(filter?: MAPConversationFilter): ServerConversation[];
  delete(id: string): boolean;
  clear(): void;
}

export interface TurnStore {
  append(turn: ServerTurn): void;
  get(id: string): ServerTurn | undefined;
  list(filter: MAPTurnFilter): ServerTurn[];
  delete(id: string): boolean;
  deleteByConversation(conversationId: string): number;
  count(conversationId: string, threadId?: string): number;
  clear(): void;
}

export interface ThreadStore {
  save(thread: ServerThread): void;
  get(id: string): ServerThread | undefined;
  list(filter: MAPThreadFilter): ServerThread[];
  delete(id: string): boolean;
  deleteByConversation(conversationId: string): number;
  clear(): void;
}

export interface ParticipantStore {
  save(participant: ServerParticipant): void;
  get(conversationId: string, participantId: string): ServerParticipant | undefined;
  list(filter: MAPParticipantFilter): ServerParticipant[];
  delete(conversationId: string, participantId: string): boolean;
  deleteByConversation(conversationId: string): number;
  getConversationsForParticipant(participantId: string, active?: boolean): string[];
  clear(): void;
}
