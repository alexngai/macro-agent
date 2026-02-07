/**
 * Tests for EventStore mail materialized views and store adapters.
 *
 * Validates:
 * - Conversation/turn/thread events are processed into materialized views
 * - Store adapters correctly delegate to EventStore
 * - Views survive rebuild from event replay
 * - Listener notifications work
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createEventStore, type EventStore } from "../../store/event-store.js";
import {
  EventStoreConversationStore,
  EventStoreTurnStore,
  EventStoreThreadStore,
  EventStoreParticipantStore,
} from "../stores/index.js";

describe("EventStore Mail Views", () => {
  let eventStore: EventStore;

  beforeEach(async () => {
    eventStore = await createEventStore({ inMemory: true });
  });

  afterEach(async () => {
    await eventStore.close();
  });

  // ===========================================================================
  // Direct EventStore view tests (emitting events, checking views)
  // ===========================================================================

  describe("Conversation Events", () => {
    it("should create a conversation from a conversation event", () => {
      eventStore.emit({
        type: "conversation",
        source: { agent_id: "user" },
        payload: {
          action: "created",
          conversation_id: "conv-1",
          conversation_type: "session",
          subject: "Test conversation",
        },
      });

      const conv = eventStore.getConversation("conv-1");
      expect(conv).not.toBeNull();
      expect(conv!.id).toBe("conv-1");
      expect(conv!.type).toBe("session");
      expect(conv!.status).toBe("active");
      expect(conv!.subject).toBe("Test conversation");
      expect(conv!.createdBy).toBe("user");
      expect(conv!.participantCount).toBe(0);
    });

    it("should close a conversation", () => {
      eventStore.emit({
        type: "conversation",
        source: { agent_id: "user" },
        payload: {
          action: "created",
          conversation_id: "conv-1",
          conversation_type: "session",
        },
      });

      eventStore.emit({
        type: "conversation",
        source: { agent_id: "agent-1" },
        payload: {
          action: "closed",
          conversation_id: "conv-1",
          closed_by: "agent-1",
          close_reason: "completed",
        },
      });

      const conv = eventStore.getConversation("conv-1");
      expect(conv!.status).toBe("completed");
      expect(conv!.closedBy).toBe("agent-1");
      expect(conv!.closedAt).toBeGreaterThan(0);
    });

    it("should track participants", () => {
      eventStore.emit({
        type: "conversation",
        source: { agent_id: "user" },
        payload: {
          action: "created",
          conversation_id: "conv-1",
          conversation_type: "session",
        },
      });

      eventStore.emit({
        type: "conversation",
        source: { agent_id: "user" },
        payload: {
          action: "participant_joined",
          conversation_id: "conv-1",
          participant_id: "user",
          participant_type: "user",
          participant_role: "initiator",
        },
      });

      eventStore.emit({
        type: "conversation",
        source: { agent_id: "agent-1" },
        payload: {
          action: "participant_joined",
          conversation_id: "conv-1",
          participant_id: "agent-1",
          participant_type: "agent",
          participant_role: "worker",
          agent_id: "agent-1",
        },
      });

      const conv = eventStore.getConversation("conv-1");
      expect(conv!.participantCount).toBe(2);

      const participants = eventStore.listParticipants("conv-1");
      expect(participants).toHaveLength(2);
      expect(participants[0].id).toBe("user");
      expect(participants[0].role).toBe("initiator");
      expect(participants[1].id).toBe("agent-1");
      expect(participants[1].role).toBe("worker");
      expect(participants[1].agentId).toBe("agent-1");
    });

    it("should handle participant leaving", () => {
      eventStore.emit({
        type: "conversation",
        source: { agent_id: "user" },
        payload: {
          action: "created",
          conversation_id: "conv-1",
          conversation_type: "session",
        },
      });

      eventStore.emit({
        type: "conversation",
        source: { agent_id: "agent-1" },
        payload: {
          action: "participant_joined",
          conversation_id: "conv-1",
          participant_id: "agent-1",
          participant_type: "agent",
          participant_role: "worker",
        },
      });

      eventStore.emit({
        type: "conversation",
        source: { agent_id: "agent-1" },
        payload: {
          action: "participant_left",
          conversation_id: "conv-1",
          participant_id: "agent-1",
        },
      });

      const conv = eventStore.getConversation("conv-1");
      expect(conv!.participantCount).toBe(0);

      // Active-only filter should exclude left participants
      const activeParticipants = eventStore.listParticipants("conv-1", true);
      expect(activeParticipants).toHaveLength(0);

      // All participants should still include left ones
      const allParticipants = eventStore.listParticipants("conv-1");
      expect(allParticipants).toHaveLength(1);
      expect(allParticipants[0].leftAt).toBeGreaterThan(0);
    });

    it("should list conversations with filters", () => {
      eventStore.emit({
        type: "conversation",
        source: { agent_id: "user" },
        payload: {
          action: "created",
          conversation_id: "conv-session",
          conversation_type: "session",
        },
      });

      eventStore.emit({
        type: "conversation",
        source: { agent_id: "agent-1" },
        payload: {
          action: "created",
          conversation_id: "conv-task",
          conversation_type: "task",
          parent_conversation_id: "conv-session",
        },
      });

      // Filter by type
      const sessions = eventStore.listConversations({ type: "session" });
      expect(sessions).toHaveLength(1);
      expect(sessions[0].id).toBe("conv-session");

      const tasks = eventStore.listConversations({ type: "task" });
      expect(tasks).toHaveLength(1);
      expect(tasks[0].id).toBe("conv-task");

      // Filter by parent
      const children = eventStore.listConversations({
        parentConversationId: "conv-session",
      });
      expect(children).toHaveLength(1);
      expect(children[0].id).toBe("conv-task");

      // All
      const all = eventStore.listConversations();
      expect(all).toHaveLength(2);
    });

    it("should set parent conversation ID", () => {
      eventStore.emit({
        type: "conversation",
        source: { agent_id: "user" },
        payload: {
          action: "created",
          conversation_id: "parent",
          conversation_type: "session",
        },
      });

      eventStore.emit({
        type: "conversation",
        source: { agent_id: "agent-1" },
        payload: {
          action: "created",
          conversation_id: "child",
          conversation_type: "task",
          parent_conversation_id: "parent",
        },
      });

      const child = eventStore.getConversation("child");
      expect(child!.parentConversationId).toBe("parent");
    });
  });

  describe("Turn Events", () => {
    beforeEach(() => {
      eventStore.emit({
        type: "conversation",
        source: { agent_id: "user" },
        payload: {
          action: "created",
          conversation_id: "conv-1",
          conversation_type: "session",
        },
      });
    });

    it("should record a turn from a turn event", () => {
      eventStore.emit({
        type: "turn",
        source: { agent_id: "user" },
        payload: {
          action: "recorded",
          turn_id: "turn-1",
          conversation_id: "conv-1",
          participant: "user",
          content_type: "text",
          content: { text: "Hello" },
          source_type: "explicit",
        },
      });

      const turns = eventStore.listTurns({ conversationId: "conv-1" });
      expect(turns).toHaveLength(1);
      expect(turns[0].id).toBe("turn-1");
      expect(turns[0].conversationId).toBe("conv-1");
      expect(turns[0].participant).toBe("user");
      expect(turns[0].contentType).toBe("text");
      expect(turns[0].content).toEqual({ text: "Hello" });
      expect(turns[0].sourceType).toBe("explicit");
    });

    it("should record an intercepted turn with source message ID", () => {
      eventStore.emit({
        type: "turn",
        source: { agent_id: "agent-1" },
        payload: {
          action: "recorded",
          turn_id: "turn-1",
          conversation_id: "conv-1",
          participant: "agent-1",
          content_type: "data",
          content: { message: "delegated work" },
          source_type: "intercepted",
          source_message_id: "msg-123",
        },
      });

      const turns = eventStore.listTurns({ conversationId: "conv-1" });
      expect(turns[0].sourceType).toBe("intercepted");
      expect(turns[0].sourceMessageId).toBe("msg-123");
    });

    it("should sort turns by timestamp", async () => {
      eventStore.emit({
        type: "turn",
        source: { agent_id: "user" },
        payload: {
          action: "recorded",
          turn_id: "turn-1",
          conversation_id: "conv-1",
          participant: "user",
          content_type: "text",
          content: { text: "First" },
          source_type: "explicit",
        },
      });

      await new Promise((r) => setTimeout(r, 10));

      eventStore.emit({
        type: "turn",
        source: { agent_id: "agent-1" },
        payload: {
          action: "recorded",
          turn_id: "turn-2",
          conversation_id: "conv-1",
          participant: "agent-1",
          content_type: "text",
          content: { text: "Second" },
          source_type: "explicit",
        },
      });

      const asc = eventStore.listTurns({
        conversationId: "conv-1",
        order: "asc",
      });
      expect(asc[0].id).toBe("turn-1");
      expect(asc[1].id).toBe("turn-2");

      const desc = eventStore.listTurns({
        conversationId: "conv-1",
        order: "desc",
      });
      expect(desc[0].id).toBe("turn-2");
      expect(desc[1].id).toBe("turn-1");
    });

    it("should filter turns by content type", () => {
      eventStore.emit({
        type: "turn",
        source: { agent_id: "user" },
        payload: {
          action: "recorded",
          turn_id: "turn-text",
          conversation_id: "conv-1",
          participant: "user",
          content_type: "text",
          content: { text: "Hello" },
          source_type: "explicit",
        },
      });

      eventStore.emit({
        type: "turn",
        source: { agent_id: "agent-1" },
        payload: {
          action: "recorded",
          turn_id: "turn-event",
          conversation_id: "conv-1",
          participant: "agent-1",
          content_type: "event",
          content: { event: "agent.started" },
          source_type: "intercepted",
          source_message_id: "msg-1",
        },
      });

      const textOnly = eventStore.listTurns({
        conversationId: "conv-1",
        contentType: "text",
      });
      expect(textOnly).toHaveLength(1);
      expect(textOnly[0].id).toBe("turn-text");
    });

    it("should limit turn results", () => {
      for (let i = 0; i < 5; i++) {
        eventStore.emit({
          type: "turn",
          source: { agent_id: "user" },
          payload: {
            action: "recorded",
            turn_id: `turn-${i}`,
            conversation_id: "conv-1",
            participant: "user",
            content_type: "text",
            content: { text: `Message ${i}` },
            source_type: "explicit",
          },
        });
      }

      const limited = eventStore.listTurns({
        conversationId: "conv-1",
        limit: 3,
      });
      expect(limited).toHaveLength(3);
    });
  });

  describe("Thread Events", () => {
    it("should create a thread from a thread event", () => {
      eventStore.emit({
        type: "conversation",
        source: { agent_id: "user" },
        payload: {
          action: "created",
          conversation_id: "conv-1",
          conversation_type: "session",
        },
      });

      eventStore.emit({
        type: "thread",
        source: { agent_id: "user" },
        payload: {
          action: "created",
          thread_id: "thread-1",
          conversation_id: "conv-1",
          root_turn_id: "turn-1",
          subject: "Sub-discussion",
        },
      });

      // Verify via thread events query
      const threadEvents = eventStore.query({ type: "thread" });
      expect(threadEvents).toHaveLength(1);
      expect(threadEvents[0].payload.thread_id).toBe("thread-1");
    });
  });

  describe("Listeners", () => {
    it("should notify on conversation changes", () => {
      const callback = vi.fn();
      const unsub = eventStore.onConversationChange(callback);

      eventStore.emit({
        type: "conversation",
        source: { agent_id: "user" },
        payload: {
          action: "created",
          conversation_id: "conv-1",
          conversation_type: "session",
        },
      });

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith(
        "conv-1",
        expect.objectContaining({ id: "conv-1", type: "session" })
      );

      unsub();

      eventStore.emit({
        type: "conversation",
        source: { agent_id: "user" },
        payload: {
          action: "created",
          conversation_id: "conv-2",
          conversation_type: "task",
        },
      });

      // Should not be called again after unsubscribe
      expect(callback).toHaveBeenCalledTimes(1);
    });

    it("should notify on turn changes", () => {
      const callback = vi.fn();
      const unsub = eventStore.onTurnChange(callback);

      eventStore.emit({
        type: "conversation",
        source: { agent_id: "user" },
        payload: {
          action: "created",
          conversation_id: "conv-1",
          conversation_type: "session",
        },
      });

      eventStore.emit({
        type: "turn",
        source: { agent_id: "user" },
        payload: {
          action: "recorded",
          turn_id: "turn-1",
          conversation_id: "conv-1",
          participant: "user",
          content_type: "text",
          content: { text: "Hello" },
          source_type: "explicit",
        },
      });

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith(
        "conv-1",
        expect.objectContaining({ id: "turn-1", conversationId: "conv-1" })
      );

      unsub();
    });
  });

  describe("View Rebuild", () => {
    it("should rebuild conversation views from event replay", async () => {
      // Emit events
      eventStore.emit({
        type: "conversation",
        source: { agent_id: "user" },
        payload: {
          action: "created",
          conversation_id: "conv-1",
          conversation_type: "session",
          subject: "Test session",
        },
      });

      eventStore.emit({
        type: "conversation",
        source: { agent_id: "agent-1" },
        payload: {
          action: "participant_joined",
          conversation_id: "conv-1",
          participant_id: "agent-1",
          participant_type: "agent",
          participant_role: "worker",
        },
      });

      eventStore.emit({
        type: "turn",
        source: { agent_id: "user" },
        payload: {
          action: "recorded",
          turn_id: "turn-1",
          conversation_id: "conv-1",
          participant: "user",
          content_type: "text",
          content: { text: "Hello" },
          source_type: "explicit",
        },
      });

      // Force a reload (rebuilds views from event log)
      await eventStore.reload();

      // Views should be rebuilt
      const conv = eventStore.getConversation("conv-1");
      expect(conv).not.toBeNull();
      expect(conv!.subject).toBe("Test session");
      expect(conv!.participantCount).toBe(1);

      const turns = eventStore.listTurns({ conversationId: "conv-1" });
      expect(turns).toHaveLength(1);
      expect(turns[0].content).toEqual({ text: "Hello" });

      const participants = eventStore.listParticipants("conv-1");
      expect(participants).toHaveLength(1);
    });
  });

  // ===========================================================================
  // Store Adapter Tests
  // ===========================================================================

  describe("EventStoreConversationStore", () => {
    let convStore: EventStoreConversationStore;

    beforeEach(() => {
      convStore = new EventStoreConversationStore(eventStore);
    });

    it("should save a new conversation", () => {
      convStore.save({
        id: "conv-1",
        type: "session",
        status: "active",
        subject: "Test",
        participantCount: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        createdBy: "user",
        metadata: {},
      });

      const result = convStore.get("conv-1");
      expect(result).toBeDefined();
      expect(result!.id).toBe("conv-1");
      expect(result!.type).toBe("session");
      expect(result!.status).toBe("active");
    });

    it("should list conversations with MAP filters", () => {
      convStore.save({
        id: "conv-1",
        type: "session",
        status: "active",
        participantCount: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        createdBy: "user",
        metadata: {},
      });

      convStore.save({
        id: "conv-2",
        type: "task",
        status: "active",
        parentConversationId: "conv-1",
        participantCount: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        createdBy: "agent-1",
        metadata: {},
      });

      const sessions = convStore.list({ type: ["session"] });
      expect(sessions).toHaveLength(1);

      const children = convStore.list({
        parentConversationId: "conv-1",
      });
      expect(children).toHaveLength(1);
      expect(children[0].id).toBe("conv-2");
    });

    it("should close a conversation via save with changed status", () => {
      convStore.save({
        id: "conv-1",
        type: "session",
        status: "active",
        participantCount: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        createdBy: "user",
        metadata: {},
      });

      // Save again with completed status
      convStore.save({
        id: "conv-1",
        type: "session",
        status: "completed",
        participantCount: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        createdBy: "user",
        metadata: {},
      });

      const result = convStore.get("conv-1");
      expect(result!.status).toBe("completed");
      expect(result!.closedAt).toBeGreaterThan(0);
    });

    it("should return undefined for non-existent conversation", () => {
      expect(convStore.get("nonexistent")).toBeUndefined();
    });
  });

  describe("EventStoreTurnStore", () => {
    let turnStore: EventStoreTurnStore;

    beforeEach(() => {
      turnStore = new EventStoreTurnStore(eventStore);

      // Create a conversation first
      eventStore.emit({
        type: "conversation",
        source: { agent_id: "user" },
        payload: {
          action: "created",
          conversation_id: "conv-1",
          conversation_type: "session",
        },
      });
    });

    it("should append a turn", () => {
      turnStore.append({
        id: "turn-1",
        conversationId: "conv-1",
        participant: "user",
        timestamp: Date.now(),
        contentType: "text",
        content: { text: "Hello" },
        source: { type: "explicit", method: "mail/turn" },
        metadata: {},
      });

      const turns = turnStore.list({ conversationId: "conv-1" });
      expect(turns).toHaveLength(1);
      expect(turns[0].id).toBe("turn-1");
      expect(turns[0].content).toEqual({ text: "Hello" });
      expect(turns[0].source.type).toBe("explicit");
    });

    it("should append an intercepted turn", () => {
      turnStore.append({
        id: "turn-1",
        conversationId: "conv-1",
        participant: "agent-1",
        timestamp: Date.now(),
        contentType: "data",
        content: { message: "intercepted content" },
        source: { type: "intercepted", messageId: "msg-123" },
        metadata: {},
      });

      const turns = turnStore.list({ conversationId: "conv-1" });
      expect(turns[0].source).toEqual({
        type: "intercepted",
        messageId: "msg-123",
      });
    });

    it("should list turns with cursor pagination", async () => {
      for (let i = 0; i < 5; i++) {
        turnStore.append({
          id: `turn-${i}`,
          conversationId: "conv-1",
          participant: "user",
          timestamp: Date.now() + i,
          contentType: "text",
          content: { text: `Message ${i}` },
          source: { type: "explicit", method: "mail/turn" },
          metadata: {},
        });
      }

      // After cursor
      const afterTurn1 = turnStore.list({
        conversationId: "conv-1",
        afterTurnId: "turn-1",
      });
      expect(afterTurn1).toHaveLength(3);
      expect(afterTurn1[0].id).toBe("turn-2");

      // Before cursor
      const beforeTurn3 = turnStore.list({
        conversationId: "conv-1",
        beforeTurnId: "turn-3",
      });
      expect(beforeTurn3).toHaveLength(3);
      expect(beforeTurn3[2].id).toBe("turn-2");

      // With limit
      const limited = turnStore.list({
        conversationId: "conv-1",
        limit: 2,
      });
      expect(limited).toHaveLength(2);
    });

    it("should count turns", () => {
      for (let i = 0; i < 3; i++) {
        turnStore.append({
          id: `turn-${i}`,
          conversationId: "conv-1",
          participant: "user",
          timestamp: Date.now() + i,
          contentType: "text",
          content: { text: `Message ${i}` },
          source: { type: "explicit", method: "mail/turn" },
          metadata: {},
        });
      }

      expect(turnStore.count("conv-1")).toBe(3);
      expect(turnStore.count("nonexistent")).toBe(0);
    });
  });

  describe("EventStoreThreadStore", () => {
    let threadStore: EventStoreThreadStore;

    beforeEach(() => {
      threadStore = new EventStoreThreadStore(eventStore);

      eventStore.emit({
        type: "conversation",
        source: { agent_id: "user" },
        payload: {
          action: "created",
          conversation_id: "conv-1",
          conversation_type: "session",
        },
      });
    });

    it("should save and list threads", () => {
      threadStore.save({
        id: "thread-1",
        conversationId: "conv-1",
        rootTurnId: "turn-1",
        subject: "Sub-topic",
        turnCount: 0,
        participantCount: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        createdBy: "user",
      });

      const threads = threadStore.list({ conversationId: "conv-1" });
      expect(threads).toHaveLength(1);
      expect(threads[0].id).toBe("thread-1");
      expect(threads[0].subject).toBe("Sub-topic");
    });

    it("should get a thread by ID", () => {
      threadStore.save({
        id: "thread-1",
        conversationId: "conv-1",
        rootTurnId: "turn-1",
        turnCount: 0,
        participantCount: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        createdBy: "user",
      });

      const thread = threadStore.get("thread-1");
      expect(thread).toBeDefined();
      expect(thread!.id).toBe("thread-1");
      expect(thread!.conversationId).toBe("conv-1");
    });

    it("should return undefined for non-existent thread", () => {
      expect(threadStore.get("nonexistent")).toBeUndefined();
    });

    it("should compute turnCount from actual turns with matching threadId", () => {
      threadStore.save({
        id: "thread-1",
        conversationId: "conv-1",
        rootTurnId: "turn-1",
        turnCount: 0,
        participantCount: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        createdBy: "user",
      });

      // Record some turns with this threadId
      for (let i = 0; i < 3; i++) {
        eventStore.emit({
          type: "turn",
          source: { agent_id: "user" },
          payload: {
            action: "recorded",
            turn_id: `turn-t1-${i}`,
            conversation_id: "conv-1",
            thread_id: "thread-1",
            participant: "user",
            content_type: "text",
            content: `Thread msg ${i}`,
            source_type: "explicit",
          },
        });
      }

      // Record a turn WITHOUT threadId (should not count)
      eventStore.emit({
        type: "turn",
        source: { agent_id: "user" },
        payload: {
          action: "recorded",
          turn_id: "turn-no-thread",
          conversation_id: "conv-1",
          participant: "user",
          content_type: "text",
          content: "No thread",
          source_type: "explicit",
        },
      });

      // get() should reflect actual turn count
      const thread = threadStore.get("thread-1");
      expect(thread).toBeDefined();
      expect(thread!.turnCount).toBe(3);

      // list() should also reflect actual turn count
      const threads = threadStore.list({ conversationId: "conv-1" });
      expect(threads).toHaveLength(1);
      expect(threads[0].turnCount).toBe(3);
    });
  });

  describe("EventStoreParticipantStore", () => {
    let participantStore: EventStoreParticipantStore;

    beforeEach(() => {
      participantStore = new EventStoreParticipantStore(eventStore);

      eventStore.emit({
        type: "conversation",
        source: { agent_id: "user" },
        payload: {
          action: "created",
          conversation_id: "conv-1",
          conversation_type: "session",
        },
      });
    });

    it("should save a participant", () => {
      participantStore.save({
        id: "user-1",
        conversationId: "conv-1",
        type: "user",
        role: "initiator",
        joinedAt: Date.now(),
        permissions: {
          canSend: true,
          canObserve: true,
          canInvite: false,
          canRemove: false,
          canCreateThreads: true,
          historyAccess: "full",
          canSeeInternal: false,
        },
      });

      const result = participantStore.get("conv-1", "user-1");
      expect(result).toBeDefined();
      expect(result!.id).toBe("user-1");
      expect(result!.role).toBe("initiator");
    });

    it("should list participants for a conversation", () => {
      participantStore.save({
        id: "user-1",
        conversationId: "conv-1",
        type: "user",
        role: "initiator",
        joinedAt: Date.now(),
        permissions: {
          canSend: true,
          canObserve: true,
          canInvite: false,
          canRemove: false,
          canCreateThreads: true,
          historyAccess: "full",
          canSeeInternal: false,
        },
      });

      participantStore.save({
        id: "agent-1",
        conversationId: "conv-1",
        type: "agent",
        role: "worker",
        joinedAt: Date.now(),
        permissions: {
          canSend: true,
          canObserve: true,
          canInvite: false,
          canRemove: false,
          canCreateThreads: true,
          historyAccess: "full",
          canSeeInternal: false,
        },
        agentInfo: { agentId: "agent-1" },
      });

      const participants = participantStore.list({
        conversationId: "conv-1",
      });
      expect(participants).toHaveLength(2);
    });

    it("should remove a participant", () => {
      participantStore.save({
        id: "agent-1",
        conversationId: "conv-1",
        type: "agent",
        role: "worker",
        joinedAt: Date.now(),
        permissions: {
          canSend: true,
          canObserve: true,
          canInvite: false,
          canRemove: false,
          canCreateThreads: true,
          historyAccess: "full",
          canSeeInternal: false,
        },
      });

      const removed = participantStore.delete("conv-1", "agent-1");
      expect(removed).toBe(true);

      // Active filter should exclude them
      const active = participantStore.list({
        conversationId: "conv-1",
        active: true,
      });
      expect(active).toHaveLength(0);
    });

    it("should get conversations for a participant", () => {
      eventStore.emit({
        type: "conversation",
        source: { agent_id: "agent-1" },
        payload: {
          action: "created",
          conversation_id: "conv-2",
          conversation_type: "task",
        },
      });

      participantStore.save({
        id: "agent-1",
        conversationId: "conv-1",
        type: "agent",
        role: "worker",
        joinedAt: Date.now(),
        permissions: {
          canSend: true,
          canObserve: true,
          canInvite: false,
          canRemove: false,
          canCreateThreads: true,
          historyAccess: "full",
          canSeeInternal: false,
        },
      });

      participantStore.save({
        id: "agent-1",
        conversationId: "conv-2",
        type: "agent",
        role: "initiator",
        joinedAt: Date.now(),
        permissions: {
          canSend: true,
          canObserve: true,
          canInvite: false,
          canRemove: false,
          canCreateThreads: true,
          historyAccess: "full",
          canSeeInternal: false,
        },
      });

      const convIds =
        participantStore.getConversationsForParticipant("agent-1");
      expect(convIds).toHaveLength(2);
      expect(convIds).toContain("conv-1");
      expect(convIds).toContain("conv-2");
    });
  });
});
