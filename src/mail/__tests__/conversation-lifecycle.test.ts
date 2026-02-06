/**
 * Conversation Lifecycle Tests
 *
 * Tests for Phase 3: automatic conversation creation/closure
 * on agent spawn, done(), terminate, and API init/message.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createEventStore, type EventStore } from "../../store/event-store.js";
import { createMailService, type MailService } from "../mail-service.js";
import { createConversationMap, type ConversationMap } from "../conversation-map.js";

describe("Conversation Lifecycle", () => {
  let eventStore: EventStore;
  let mailService: MailService;
  let conversationMap: ConversationMap;

  beforeEach(async () => {
    eventStore = await createEventStore({ inMemory: true });
    mailService = createMailService({ eventStore });
    conversationMap = createConversationMap();
  });

  afterEach(async () => {
    await eventStore.close();
  });

  describe("ConversationMap", () => {
    it("should set and get agent conversation", () => {
      conversationMap.setAgentConversation("agent-1", "conv-1");
      expect(conversationMap.getAgentConversation("agent-1")).toBe("conv-1");
    });

    it("should return undefined for unknown agent", () => {
      expect(conversationMap.getAgentConversation("unknown")).toBeUndefined();
    });

    it("should remove agent from map", () => {
      conversationMap.setAgentConversation("agent-1", "conv-1");
      conversationMap.removeAgent("agent-1");
      expect(conversationMap.getAgentConversation("agent-1")).toBeUndefined();
    });

    it("should set and get session conversation", () => {
      conversationMap.setSessionConversation("hm-1", "session-conv-1");
      expect(conversationMap.getSessionConversation("hm-1")).toBe("session-conv-1");
    });

    it("should return undefined for unknown session", () => {
      expect(conversationMap.getSessionConversation("unknown")).toBeUndefined();
    });

    it("should create peer conversation on first access", () => {
      let createCount = 0;
      const convId = conversationMap.getOrCreatePeerConversation(
        "agent-a",
        "agent-b",
        () => {
          createCount++;
          return "peer-conv-1";
        }
      );
      expect(convId).toBe("peer-conv-1");
      expect(createCount).toBe(1);
    });

    it("should reuse peer conversation on subsequent access", () => {
      let createCount = 0;
      const createFn = () => {
        createCount++;
        return `peer-conv-${createCount}`;
      };

      const convId1 = conversationMap.getOrCreatePeerConversation("agent-a", "agent-b", createFn);
      const convId2 = conversationMap.getOrCreatePeerConversation("agent-a", "agent-b", createFn);
      const convId3 = conversationMap.getOrCreatePeerConversation("agent-b", "agent-a", createFn);

      expect(convId1).toBe("peer-conv-1");
      expect(convId2).toBe("peer-conv-1");
      expect(convId3).toBe("peer-conv-1"); // Order shouldn't matter
      expect(createCount).toBe(1);
    });

    it("should get peer conversation without creating", () => {
      expect(conversationMap.getPeerConversation("agent-a", "agent-b")).toBeUndefined();

      conversationMap.getOrCreatePeerConversation("agent-a", "agent-b", () => "peer-conv-1");
      expect(conversationMap.getPeerConversation("agent-a", "agent-b")).toBe("peer-conv-1");
      expect(conversationMap.getPeerConversation("agent-b", "agent-a")).toBe("peer-conv-1");
    });

    it("should close all peer conversations for an agent", () => {
      conversationMap.getOrCreatePeerConversation("agent-a", "agent-b", () => "peer-1");
      conversationMap.getOrCreatePeerConversation("agent-a", "agent-c", () => "peer-2");
      conversationMap.getOrCreatePeerConversation("agent-b", "agent-c", () => "peer-3");

      const closed = conversationMap.closePeerConversationsFor("agent-a");
      expect(closed).toHaveLength(2);
      expect(closed).toContain("peer-1");
      expect(closed).toContain("peer-2");

      // agent-a's peer conversations should be gone
      expect(conversationMap.getPeerConversation("agent-a", "agent-b")).toBeUndefined();
      expect(conversationMap.getPeerConversation("agent-a", "agent-c")).toBeUndefined();

      // agent-b ↔ agent-c should still exist
      expect(conversationMap.getPeerConversation("agent-b", "agent-c")).toBe("peer-3");
    });
  });

  describe("Session Conversation (API init pattern)", () => {
    it("should create session conversation and map head manager", () => {
      const headManagerId = "hm-001";

      // Simulate what POST /api/init does
      const { conversationId } = mailService.createConversation({
        type: "session",
        subject: "User session",
        createdBy: "user",
      });
      mailService.joinConversation({
        conversationId,
        participantId: headManagerId,
        role: "worker",
      });
      conversationMap.setSessionConversation(headManagerId, conversationId);

      // Verify
      const sessionConvId = conversationMap.getSessionConversation(headManagerId);
      expect(sessionConvId).toBe(conversationId);

      const conv = mailService.getConversation(conversationId);
      expect(conv).not.toBeNull();
      expect(conv!.type).toBe("session");
      expect(conv!.status).toBe("active");
    });

    it("should record user and assistant turns in session conversation", () => {
      const headManagerId = "hm-001";

      // Create session conversation
      const { conversationId } = mailService.createConversation({
        type: "session",
        subject: "User session",
        createdBy: "user",
      });
      conversationMap.setSessionConversation(headManagerId, conversationId);

      // Record user turn
      mailService.recordTurn({
        conversationId,
        participant: "user",
        contentType: "text",
        content: "Hello, please help me",
      });

      // Record assistant turn
      mailService.recordTurn({
        conversationId,
        participant: headManagerId,
        contentType: "text",
        content: "I can help with that!",
      });

      // Verify turns
      const turns = mailService.listTurns({ conversationId });
      expect(turns).toHaveLength(2);
      expect(turns[0].participant).toBe("user");
      expect(turns[0].content).toBe("Hello, please help me");
      expect(turns[1].participant).toBe(headManagerId);
      expect(turns[1].content).toBe("I can help with that!");
    });
  });

  describe("Task Conversation (spawn pattern)", () => {
    it("should create task conversation on spawn", () => {
      const parentId = "parent-001";
      const childId = "child-001";

      // Set up parent's conversation
      const { conversationId: parentConvId } = mailService.createConversation({
        type: "session",
        subject: "Parent session",
        createdBy: parentId,
      });
      conversationMap.setSessionConversation(parentId, parentConvId);

      // Simulate what agent-manager spawn does
      const parentConversation =
        conversationMap.getAgentConversation(parentId) ??
        conversationMap.getSessionConversation(parentId);

      const { conversationId: taskConvId } = mailService.createConversation({
        type: "task",
        subject: "Worker task",
        createdBy: parentId,
        parentConversationId: parentConversation,
      });
      mailService.joinConversation({
        conversationId: taskConvId,
        participantId: parentId,
        role: "initiator",
      });
      mailService.joinConversation({
        conversationId: taskConvId,
        participantId: childId,
        role: "worker",
      });
      conversationMap.setAgentConversation(childId, taskConvId);

      // Verify
      expect(conversationMap.getAgentConversation(childId)).toBe(taskConvId);

      const conv = mailService.getConversation(taskConvId);
      expect(conv).not.toBeNull();
      expect(conv!.type).toBe("task");
      expect(conv!.parentConversationId).toBe(parentConvId);

      const participants = mailService.listParticipants(taskConvId);
      expect(participants).toHaveLength(2);
    });
  });

  describe("Conversation Closure (done/terminate pattern)", () => {
    it("should record completion turn and close conversation on done", () => {
      const agentId = "worker-001";

      // Create task conversation
      const { conversationId } = mailService.createConversation({
        type: "task",
        subject: "Worker task",
        createdBy: "parent-001",
      });
      conversationMap.setAgentConversation(agentId, conversationId);

      // Simulate what done() does
      const convId = conversationMap.getAgentConversation(agentId);
      expect(convId).toBe(conversationId);

      mailService.recordTurn({
        conversationId: convId!,
        participant: agentId,
        contentType: "event",
        content: {
          event: "agent.completed",
          summary: "Task finished",
        },
      });
      mailService.closeConversation({
        conversationId: convId!,
        closedBy: agentId,
        reason: "completed",
      });

      // Verify
      const conv = mailService.getConversation(conversationId);
      expect(conv).not.toBeNull();
      expect(conv!.status).toBe("completed");

      const turns = mailService.listTurns({ conversationId });
      expect(turns).toHaveLength(1);
      expect(turns[0].contentType).toBe("event");
    });

    it("should close conversation and clean up on terminate", () => {
      const agentId = "worker-002";

      // Create task conversation
      const { conversationId: taskConvId } = mailService.createConversation({
        type: "task",
        subject: "Worker task",
        createdBy: "parent-001",
      });
      conversationMap.setAgentConversation(agentId, taskConvId);

      // Create peer conversations
      conversationMap.getOrCreatePeerConversation(agentId, "peer-001", () => {
        const { conversationId } = mailService.createConversation({
          type: "peer",
          subject: "Peer chat",
          createdBy: agentId,
        });
        return conversationId;
      });

      // Simulate what terminate does
      const convId = conversationMap.getAgentConversation(agentId);
      if (convId) {
        mailService.closeConversation({
          conversationId: convId,
          closedBy: agentId,
          reason: "terminated",
        });
      }

      const peerConvIds = conversationMap.closePeerConversationsFor(agentId);
      for (const peerConvId of peerConvIds) {
        mailService.closeConversation({
          conversationId: peerConvId,
          closedBy: agentId,
          reason: "terminated",
        });
      }

      conversationMap.removeAgent(agentId);

      // Verify task conversation closed
      const taskConv = mailService.getConversation(taskConvId);
      expect(taskConv!.status).toBe("completed");

      // Verify agent removed from map
      expect(conversationMap.getAgentConversation(agentId)).toBeUndefined();

      // Verify peer conversations closed
      expect(peerConvIds).toHaveLength(1);
      expect(conversationMap.getPeerConversation(agentId, "peer-001")).toBeUndefined();
    });
  });

  describe("Full Lifecycle Flow", () => {
    it("should handle complete session → spawn → message → done → terminate flow", () => {
      const headManagerId = "hm-001";
      const workerId = "worker-001";

      // 1. API init → session conversation
      const { conversationId: sessionConvId } = mailService.createConversation({
        type: "session",
        subject: "User session",
        createdBy: "user",
      });
      mailService.joinConversation({
        conversationId: sessionConvId,
        participantId: headManagerId,
        role: "worker",
      });
      conversationMap.setSessionConversation(headManagerId, sessionConvId);

      // 2. User message → turns recorded
      mailService.recordTurn({
        conversationId: sessionConvId,
        participant: "user",
        contentType: "text",
        content: "Please do something",
      });

      // 3. Head manager spawns worker → task conversation
      const parentConv =
        conversationMap.getAgentConversation(headManagerId) ??
        conversationMap.getSessionConversation(headManagerId);

      const { conversationId: taskConvId } = mailService.createConversation({
        type: "task",
        subject: "Worker task",
        createdBy: headManagerId,
        parentConversationId: parentConv,
      });
      mailService.joinConversation({
        conversationId: taskConvId,
        participantId: headManagerId,
        role: "initiator",
      });
      mailService.joinConversation({
        conversationId: taskConvId,
        participantId: workerId,
        role: "worker",
      });
      conversationMap.setAgentConversation(workerId, taskConvId);

      // 4. Worker calls done() → completion turn + close
      mailService.recordTurn({
        conversationId: taskConvId,
        participant: workerId,
        contentType: "event",
        content: { event: "agent.completed", summary: "Done!" },
      });
      mailService.closeConversation({
        conversationId: taskConvId,
        closedBy: workerId,
        reason: "completed",
      });

      // 5. Head manager responds → assistant turn in session
      mailService.recordTurn({
        conversationId: sessionConvId,
        participant: headManagerId,
        contentType: "text",
        content: "The worker completed the task.",
      });

      // Verify: session conversation has user + assistant turns
      const sessionTurns = mailService.listTurns({ conversationId: sessionConvId });
      expect(sessionTurns).toHaveLength(2);
      expect(sessionTurns[0].participant).toBe("user");
      expect(sessionTurns[1].participant).toBe(headManagerId);

      // Verify: task conversation has completion turn and is closed
      const taskConv = mailService.getConversation(taskConvId);
      expect(taskConv!.status).toBe("completed");
      expect(taskConv!.parentConversationId).toBe(sessionConvId);

      const taskTurns = mailService.listTurns({ conversationId: taskConvId });
      expect(taskTurns).toHaveLength(1);

      // Verify: we can list all conversations
      const allConvs = mailService.listConversations();
      expect(allConvs).toHaveLength(2);
    });
  });
});
