/**
 * Mail Protocol Handler Adapter
 *
 * Creates a HandlerRegistry for mail/* protocol methods that can be
 * merged into the MAPAdapter's RPC handler. Delegates to MailService
 * for business logic.
 *
 * Implements the following MAP mail protocol methods:
 * - mail/create — Create a conversation
 * - mail/get — Get conversation details
 * - mail/list — List conversations
 * - mail/close — Close a conversation
 * - mail/join — Join a conversation
 * - mail/leave — Leave a conversation
 * - mail/turn — Record a turn
 * - mail/turns/list — List turns
 * - mail/thread/create — Create a thread
 * - mail/thread/list — List threads
 * - mail/replay — Replay turns
 */

import { nanoid } from "nanoid";
import { RPCError, type HandlerRegistry, type HandlerContext } from "./rpc-handler.js";
import type { MailService } from "../../mail/mail-service.js";

/**
 * Create mail protocol handlers backed by a MailService.
 */
export function createMailHandlers(mailService: MailService): HandlerRegistry {
  /**
   * Validate that a conversation exists, returning it or throwing RPCError.
   */
  function requireConversation(id: string) {
    const conv = mailService.getConversation(id);
    if (!conv) throw RPCError.notFound("conversation", id);
    return conv;
  }

  return {
    // =========================================================================
    // Conversation lifecycle
    // =========================================================================

    "mail/create": async (params: unknown, ctx: HandlerContext) => {
      const p = params as {
        type?: string;
        subject?: string;
        parentConversationId?: string;
        metadata?: Record<string, unknown>;
        initialParticipants?: Array<{ id: string; role?: string }>;
      };

      const { conversationId } = mailService.createConversation({
        type: (p.type as "session" | "task" | "peer") ?? "session",
        subject: p.subject,
        createdBy: ctx.participantId,
        parentConversationId: p.parentConversationId,
        metadata: p.metadata,
      });

      // Auto-join creator
      mailService.joinConversation({
        conversationId,
        participantId: ctx.participantId,
        participantType: "agent",
        role: "initiator",
      });

      // Join initial participants
      if (p.initialParticipants) {
        for (const ip of p.initialParticipants) {
          mailService.joinConversation({
            conversationId,
            participantId: ip.id,
            participantType: "agent",
            role: ip.role ?? "worker",
          });
        }
      }

      const conversation = mailService.getConversation(conversationId);
      return { conversation };
    },

    "mail/get": async (params: unknown) => {
      const p = params as {
        conversationId: string;
        include?: {
          participants?: boolean;
          threads?: boolean;
          recentTurns?: number;
          stats?: boolean;
        };
      };

      const conversation = requireConversation(p.conversationId);

      const response: Record<string, unknown> = { conversation };

      if (p.include?.participants) {
        response.participants = mailService.listParticipants(
          p.conversationId,
          true
        );
      }

      if (p.include?.recentTurns) {
        response.recentTurns = mailService.listTurns({
          conversationId: p.conversationId,
          limit: p.include.recentTurns,
          order: "desc",
        });
      }

      if (p.include?.stats) {
        const totalTurns = mailService.countTurns(p.conversationId);
        const activeParticipants = mailService.listParticipants(
          p.conversationId,
          true
        );
        response.stats = {
          totalTurns,
          activeParticipants: activeParticipants.length,
        };
      }

      return response;
    },

    "mail/list": async (params: unknown) => {
      const p = (params ?? {}) as {
        filter?: {
          type?: string;
          status?: string;
          participantId?: string;
          parentConversationId?: string;
        };
        limit?: number;
        cursor?: string;
      };

      const limit = p.limit ?? 50;
      const conversations = mailService.listConversations(
        p.filter
          ? {
              type: p.filter.type as "session" | "task" | "peer" | undefined,
              status: p.filter.status as
                | "active"
                | "completed"
                | "failed"
                | "archived"
                | undefined,
              participantId: p.filter.participantId,
              parentConversationId: p.filter.parentConversationId,
            }
          : undefined
      );

      // Cursor-based pagination
      let startIndex = 0;
      if (p.cursor) {
        const idx = conversations.findIndex((c) => c.id === p.cursor);
        if (idx >= 0) startIndex = idx + 1;
      }

      const page = conversations.slice(startIndex, startIndex + limit + 1);
      const hasMore = page.length > limit;
      const items = hasMore ? page.slice(0, limit) : page;

      return {
        conversations: items,
        hasMore,
        nextCursor: hasMore ? items[items.length - 1].id : undefined,
      };
    },

    "mail/close": async (params: unknown, ctx: HandlerContext) => {
      const p = params as { conversationId: string; reason?: string };

      const conv = requireConversation(p.conversationId);
      if (conv.status !== "active") {
        throw RPCError.invalidParams(
          `Conversation already ${conv.status}: ${p.conversationId}`
        );
      }

      mailService.closeConversation({
        conversationId: p.conversationId,
        closedBy: ctx.participantId,
        reason: p.reason,
      });

      const conversation = mailService.getConversation(p.conversationId);
      return { conversation };
    },

    // =========================================================================
    // Participants
    // =========================================================================

    "mail/join": async (params: unknown, ctx: HandlerContext) => {
      const p = params as {
        conversationId: string;
        role?: string;
        catchUp?: { from?: string | number; limit?: number };
      };

      requireConversation(p.conversationId);

      // Check for duplicate join — if already an active participant, skip
      const existing = mailService.listParticipants(p.conversationId, true);
      const alreadyJoined = existing.some((pt) => pt.id === ctx.participantId);

      if (!alreadyJoined) {
        mailService.joinConversation({
          conversationId: p.conversationId,
          participantId: ctx.participantId,
          participantType: "agent",
          role: p.role ?? "worker",
        });
      }

      const conversation = mailService.getConversation(p.conversationId);
      const response: Record<string, unknown> = { conversation };

      if (p.catchUp) {
        const catchUpLimit = p.catchUp.limit ?? 50;
        const history = mailService.listTurns({
          conversationId: p.conversationId,
          limit: catchUpLimit + 1,
          order: "asc",
        });
        const hasMore = history.length > catchUpLimit;
        const items = hasMore ? history.slice(0, catchUpLimit) : history;
        response.history = items;
        if (hasMore) {
          response.historyCursor = items[items.length - 1].id;
        }
      }

      return response;
    },

    "mail/leave": async (params: unknown, ctx: HandlerContext) => {
      const p = params as { conversationId: string };
      requireConversation(p.conversationId);
      mailService.leaveConversation(p.conversationId, ctx.participantId);
      return { success: true, leftAt: Date.now() };
    },

    // =========================================================================
    // Turns
    // =========================================================================

    "mail/turn": async (params: unknown, ctx: HandlerContext) => {
      const p = params as {
        conversationId: string;
        contentType: string;
        content: unknown;
        threadId?: string;
        inReplyTo?: string;
        metadata?: Record<string, unknown>;
      };

      requireConversation(p.conversationId);

      const { turnId } = mailService.recordTurn({
        conversationId: p.conversationId,
        participant: ctx.participantId,
        contentType: p.contentType,
        content: p.content,
        threadId: p.threadId,
        inReplyTo: p.inReplyTo,
        sourceType: "explicit",
        metadata: p.metadata,
      });

      const turns = mailService.listTurns({
        conversationId: p.conversationId,
        limit: 1,
        order: "desc",
      });

      return { turn: turns[0] ?? { id: turnId } };
    },

    "mail/turns/list": async (params: unknown) => {
      const p = params as {
        conversationId: string;
        filter?: {
          threadId?: string;
          contentTypes?: string[];
          participantId?: string;
          afterTurnId?: string;
          beforeTurnId?: string;
          afterTimestamp?: number;
          beforeTimestamp?: number;
        };
        limit?: number;
        order?: "asc" | "desc";
      };

      requireConversation(p.conversationId);

      const limit = p.limit ?? 50;
      let turns = mailService.listTurns({
        conversationId: p.conversationId,
        threadId: p.filter?.threadId,
        participantId: p.filter?.participantId,
        limit: limit + 1,
        order: p.order,
      });

      // Filter by multiple content types (if provided)
      if (p.filter?.contentTypes?.length) {
        const typeSet = new Set(p.filter.contentTypes);
        turns = turns.filter((t) => typeSet.has(t.contentType));
      }

      const hasMore = turns.length > limit;
      const items = hasMore ? turns.slice(0, limit) : turns;

      return {
        turns: items,
        hasMore,
        nextCursor: hasMore ? items[items.length - 1].id : undefined,
      };
    },

    // =========================================================================
    // Threads
    // =========================================================================

    "mail/thread/create": async (params: unknown, ctx: HandlerContext) => {
      const p = params as {
        conversationId: string;
        rootTurnId: string;
        subject?: string;
        parentThreadId?: string;
      };

      requireConversation(p.conversationId);

      const threadId = `thread_${nanoid(12)}`;

      mailService.stores.threads.save({
        id: threadId,
        conversationId: p.conversationId,
        rootTurnId: p.rootTurnId,
        subject: p.subject,
        parentThreadId: p.parentThreadId,
        turnCount: 0,
        participantCount: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        createdBy: ctx.participantId,
      });

      const thread = mailService.stores.threads.get(threadId);
      return { thread };
    },

    "mail/thread/list": async (params: unknown) => {
      const p = (params ?? {}) as {
        conversationId: string;
        parentThreadId?: string;
        limit?: number;
        cursor?: string;
      };

      requireConversation(p.conversationId);

      const threads = mailService.stores.threads.list({
        conversationId: p.conversationId,
        parentThreadId: p.parentThreadId,
      });

      const limit = p.limit ?? 50;
      let startIndex = 0;
      if (p.cursor) {
        const idx = threads.findIndex((t) => t.id === p.cursor);
        if (idx >= 0) startIndex = idx + 1;
      }

      const page = threads.slice(startIndex, startIndex + limit + 1);
      const hasMore = page.length > limit;
      const items = hasMore ? page.slice(0, limit) : page;

      return {
        threads: items,
        hasMore,
        nextCursor: hasMore ? items[items.length - 1].id : undefined,
      };
    },

    // =========================================================================
    // Replay
    // =========================================================================

    "mail/replay": async (params: unknown) => {
      const p = params as {
        conversationId: string;
        threadId?: string;
        fromTurnId?: string;
        limit?: number;
      };

      requireConversation(p.conversationId);

      const limit = p.limit ?? 50;
      const turns = mailService.listTurns({
        conversationId: p.conversationId,
        threadId: p.threadId,
        limit: limit + 1,
        order: "asc",
      });

      const hasMore = turns.length > limit;
      const items = hasMore ? turns.slice(0, limit) : turns;

      return {
        turns: items,
        hasMore,
        nextCursor: hasMore ? items[items.length - 1].id : undefined,
        missedCount: 0,
      };
    },
  };
}
