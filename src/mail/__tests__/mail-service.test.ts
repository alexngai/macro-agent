/**
 * MailService Tests
 *
 * Tests for the MailService facade covering:
 * - Conversation lifecycle (create, close)
 * - Turn recording
 * - Participant management
 * - Querying
 * - Listener notifications
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createEventStore, type EventStore } from "../../store/event-store.js";
import { createMailService, type MailService } from "../mail-service.js";

describe("MailService", () => {
  let eventStore: EventStore;
  let mailService: MailService;

  beforeEach(async () => {
    eventStore = await createEventStore({ inMemory: true });
    mailService = createMailService({ eventStore });
  });

  afterEach(async () => {
    await eventStore.close();
  });

  describe("Conversation Lifecycle", () => {
    it("should create a conversation", () => {
      const { conversationId } = mailService.createConversation({
        type: "session",
        subject: "Test session",
        createdBy: "user",
      });

      expect(conversationId).toMatch(/^conv_/);

      const conv = mailService.getConversation(conversationId);
      expect(conv).not.toBeNull();
      expect(conv!.type).toBe("session");
      expect(conv!.subject).toBe("Test session");
      expect(conv!.status).toBe("active");
      expect(conv!.createdBy).toBe("user");
    });

    it("should create a task conversation with parent", () => {
      const { conversationId: parentId } = mailService.createConversation({
        type: "session",
        createdBy: "user",
      });

      const { conversationId: childId } = mailService.createConversation({
        type: "task",
        subject: "Worker task",
        createdBy: "head-manager",
        parentConversationId: parentId,
      });

      const child = mailService.getConversation(childId);
      expect(child!.type).toBe("task");
      expect(child!.parentConversationId).toBe(parentId);
    });

    it("should close a conversation", () => {
      const { conversationId } = mailService.createConversation({
        type: "session",
        createdBy: "user",
      });

      mailService.closeConversation({
        conversationId,
        closedBy: "head-manager",
        reason: "completed",
      });

      const conv = mailService.getConversation(conversationId);
      expect(conv!.status).toBe("completed");
      expect(conv!.closedBy).toBe("head-manager");
      expect(conv!.closedAt).toBeGreaterThan(0);
    });

    it("should create a peer conversation", () => {
      const { conversationId } = mailService.createConversation({
        type: "peer",
        subject: "Agent-to-agent discussion",
        createdBy: "agent-1",
      });

      const conv = mailService.getConversation(conversationId);
      expect(conv!.type).toBe("peer");
    });
  });

  describe("Participant Management", () => {
    let conversationId: string;

    beforeEach(() => {
      ({ conversationId } = mailService.createConversation({
        type: "session",
        createdBy: "user",
      }));
    });

    it("should join a participant", () => {
      mailService.joinConversation({
        conversationId,
        participantId: "user",
        participantType: "user",
        role: "initiator",
      });

      const participants = mailService.listParticipants(conversationId);
      expect(participants).toHaveLength(1);
      expect(participants[0].id).toBe("user");
      expect(participants[0].role).toBe("initiator");
    });

    it("should track participant count", () => {
      mailService.joinConversation({
        conversationId,
        participantId: "user",
        participantType: "user",
        role: "initiator",
      });

      mailService.joinConversation({
        conversationId,
        participantId: "agent-1",
        participantType: "agent",
        role: "worker",
        agentId: "agent-1",
      });

      const conv = mailService.getConversation(conversationId);
      expect(conv!.participantCount).toBe(2);
    });

    it("should handle participant leaving", () => {
      mailService.joinConversation({
        conversationId,
        participantId: "agent-1",
        participantType: "agent",
        role: "worker",
      });

      mailService.leaveConversation(conversationId, "agent-1");

      const conv = mailService.getConversation(conversationId);
      expect(conv!.participantCount).toBe(0);

      const active = mailService.listParticipants(conversationId, true);
      expect(active).toHaveLength(0);
    });
  });

  describe("Turn Recording", () => {
    let conversationId: string;

    beforeEach(() => {
      ({ conversationId } = mailService.createConversation({
        type: "session",
        createdBy: "user",
      }));
    });

    it("should record a turn", () => {
      const { turnId } = mailService.recordTurn({
        conversationId,
        participant: "user",
        contentType: "text",
        content: { text: "Hello, world!" },
      });

      expect(turnId).toMatch(/^turn_/);

      const turns = mailService.listTurns({ conversationId });
      expect(turns).toHaveLength(1);
      expect(turns[0].participant).toBe("user");
      expect(turns[0].contentType).toBe("text");
      expect(turns[0].content).toEqual({ text: "Hello, world!" });
      expect(turns[0].sourceType).toBe("explicit");
    });

    it("should record an intercepted turn", () => {
      mailService.recordTurn({
        conversationId,
        participant: "agent-1",
        contentType: "data",
        content: { message: "delegated work result" },
        sourceType: "intercepted",
        sourceMessageId: "msg-123",
      });

      const turns = mailService.listTurns({ conversationId });
      expect(turns[0].sourceType).toBe("intercepted");
      expect(turns[0].sourceMessageId).toBe("msg-123");
    });

    it("should record multiple turns in order", async () => {
      mailService.recordTurn({
        conversationId,
        participant: "user",
        contentType: "text",
        content: { text: "First" },
      });

      await new Promise((r) => setTimeout(r, 5));

      mailService.recordTurn({
        conversationId,
        participant: "agent-1",
        contentType: "text",
        content: { text: "Second" },
      });

      const turns = mailService.listTurns({
        conversationId,
        order: "asc",
      });
      expect(turns).toHaveLength(2);
      expect((turns[0].content as { text: string }).text).toBe("First");
      expect((turns[1].content as { text: string }).text).toBe("Second");
    });

    it("should count turns", () => {
      for (let i = 0; i < 5; i++) {
        mailService.recordTurn({
          conversationId,
          participant: "user",
          contentType: "text",
          content: { text: `Message ${i}` },
        });
      }

      expect(mailService.countTurns(conversationId)).toBe(5);
    });
  });

  describe("Querying", () => {
    it("should list conversations by type", () => {
      mailService.createConversation({
        type: "session",
        createdBy: "user",
      });

      mailService.createConversation({
        type: "task",
        createdBy: "agent-1",
      });

      mailService.createConversation({
        type: "task",
        createdBy: "agent-2",
      });

      const sessions = mailService.listConversations({ type: "session" });
      expect(sessions).toHaveLength(1);

      const tasks = mailService.listConversations({ type: "task" });
      expect(tasks).toHaveLength(2);
    });

    it("should list conversations by status", () => {
      const { conversationId: active } = mailService.createConversation({
        type: "session",
        createdBy: "user",
      });

      const { conversationId: closed } = mailService.createConversation({
        type: "session",
        createdBy: "user",
      });

      mailService.closeConversation({
        conversationId: closed,
        closedBy: "user",
      });

      const activeConvs = mailService.listConversations({ status: "active" });
      expect(activeConvs).toHaveLength(1);
      expect(activeConvs[0].id).toBe(active);
    });

    it("should return null for non-existent conversation", () => {
      expect(mailService.getConversation("nonexistent")).toBeNull();
    });

    it("should list turns with filters", () => {
      const { conversationId } = mailService.createConversation({
        type: "session",
        createdBy: "user",
      });

      mailService.recordTurn({
        conversationId,
        participant: "user",
        contentType: "text",
        content: { text: "User message" },
      });

      mailService.recordTurn({
        conversationId,
        participant: "agent-1",
        contentType: "event",
        content: { event: "tool.called" },
      });

      const textTurns = mailService.listTurns({
        conversationId,
        contentType: "text",
      });
      expect(textTurns).toHaveLength(1);

      const agentTurns = mailService.listTurns({
        conversationId,
        participantId: "agent-1",
      });
      expect(agentTurns).toHaveLength(1);
    });
  });

  describe("Listeners", () => {
    it("should notify on conversation creation", () => {
      const callback = vi.fn();
      mailService.onConversationChange(callback);

      const { conversationId } = mailService.createConversation({
        type: "session",
        createdBy: "user",
      });

      expect(callback).toHaveBeenCalledWith(
        conversationId,
        expect.objectContaining({ type: "session" })
      );
    });

    it("should notify on turn recorded", () => {
      const callback = vi.fn();
      mailService.onTurnChange(callback);

      const { conversationId } = mailService.createConversation({
        type: "session",
        createdBy: "user",
      });

      mailService.recordTurn({
        conversationId,
        participant: "user",
        contentType: "text",
        content: { text: "Hello" },
      });

      expect(callback).toHaveBeenCalledWith(
        conversationId,
        expect.objectContaining({
          participant: "user",
          contentType: "text",
        })
      );
    });

    it("should unsubscribe from notifications", () => {
      const callback = vi.fn();
      const unsub = mailService.onConversationChange(callback);

      mailService.createConversation({
        type: "session",
        createdBy: "user",
      });

      expect(callback).toHaveBeenCalledTimes(1);

      unsub();

      mailService.createConversation({
        type: "task",
        createdBy: "agent",
      });

      expect(callback).toHaveBeenCalledTimes(1);
    });
  });

  describe("Full Lifecycle", () => {
    it("should support complete conversation lifecycle", () => {
      // Create session conversation
      const { conversationId: sessionId } = mailService.createConversation({
        type: "session",
        subject: "Refactor auth module",
        createdBy: "user",
      });

      // User and head manager join
      mailService.joinConversation({
        conversationId: sessionId,
        participantId: "user",
        participantType: "user",
        role: "initiator",
      });
      mailService.joinConversation({
        conversationId: sessionId,
        participantId: "head-manager",
        participantType: "agent",
        role: "assistant",
        agentId: "head-manager",
      });

      // User sends message
      mailService.recordTurn({
        conversationId: sessionId,
        participant: "user",
        contentType: "text",
        content: { text: "Refactor the auth module" },
      });

      // Head manager delegates — create task conversation
      const { conversationId: taskId } = mailService.createConversation({
        type: "task",
        subject: "Analyze auth code",
        createdBy: "head-manager",
        parentConversationId: sessionId,
      });

      // Worker joins task conversation
      mailService.joinConversation({
        conversationId: taskId,
        participantId: "head-manager",
        participantType: "agent",
        role: "initiator",
      });
      mailService.joinConversation({
        conversationId: taskId,
        participantId: "worker-1",
        participantType: "agent",
        role: "worker",
        agentId: "worker-1",
      });

      // Worker records work
      mailService.recordTurn({
        conversationId: taskId,
        participant: "worker-1",
        contentType: "event",
        content: { event: "tool.file_read", file: "src/auth.ts" },
        sourceType: "intercepted",
        sourceMessageId: "msg-001",
      });

      // Worker completes
      mailService.recordTurn({
        conversationId: taskId,
        participant: "worker-1",
        contentType: "event",
        content: { event: "agent.completed", summary: "Analysis complete" },
      });

      mailService.closeConversation({
        conversationId: taskId,
        closedBy: "worker-1",
        reason: "completed",
      });

      // Head manager responds in session
      mailService.recordTurn({
        conversationId: sessionId,
        participant: "head-manager",
        contentType: "text",
        content: { text: "Auth module refactored successfully." },
      });

      // Verify conversation tree
      const session = mailService.getConversation(sessionId);
      expect(session!.status).toBe("active");
      expect(session!.participantCount).toBe(2);

      const task = mailService.getConversation(taskId);
      expect(task!.status).toBe("completed");
      expect(task!.parentConversationId).toBe(sessionId);

      // Verify turns
      const sessionTurns = mailService.listTurns({ conversationId: sessionId });
      expect(sessionTurns).toHaveLength(2); // user + head-manager

      const taskTurns = mailService.listTurns({ conversationId: taskId });
      expect(taskTurns).toHaveLength(2); // tool call + completion

      // List child conversations
      const children = mailService.listConversations({
        parentConversationId: sessionId,
      });
      expect(children).toHaveLength(1);
      expect(children[0].id).toBe(taskId);
    });
  });

  describe("Stores Access", () => {
    it("should expose underlying stores", () => {
      expect(mailService.stores.conversations).toBeDefined();
      expect(mailService.stores.turns).toBeDefined();
      expect(mailService.stores.threads).toBeDefined();
      expect(mailService.stores.participants).toBeDefined();
    });
  });
});
