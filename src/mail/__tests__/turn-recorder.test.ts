/**
 * TurnRecorder Tests
 *
 * Tests for hierarchy-aware conversation resolution and turn recording.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createEventStore, type EventStore } from "../../store/event-store.js";
import { createMailService, type MailService } from "../mail-service.js";
import { createConversationMap, type ConversationMap } from "../conversation-map.js";
import { createTurnRecorder } from "../turn-recorder.js";
import type { TurnRecorderCallback, TurnRecordInfo } from "../../router/types.js";
import type { AgentId, EventId } from "../../store/types/index.js";

describe("TurnRecorder", () => {
  let eventStore: EventStore;
  let mailService: MailService;
  let conversationMap: ConversationMap;
  let turnRecorder: TurnRecorderCallback;

  beforeEach(async () => {
    eventStore = await createEventStore({ inMemory: true });
    mailService = createMailService({ eventStore });
    conversationMap = createConversationMap();
    turnRecorder = createTurnRecorder({ mailService, conversationMap, eventStore });
  });

  afterEach(async () => {
    await eventStore.close();
  });

  // Helper: create a spawned agent in EventStore
  function spawnAgent(agentId: string, parentId?: string): void {
    eventStore.emit({
      type: "spawn",
      source: { agent_id: (parentId ?? agentId) as AgentId },
      payload: {
        agent_id: agentId,
        session_id: `session-${agentId}`,
        task: `Task for ${agentId}`,
        parent: parentId ?? null,
        lineage: parentId ? [parentId] : [],
        role: "worker",
      },
    });
  }

  // Helper: set up a task conversation for an agent
  function setupTaskConversation(agentId: string, parentId: string): string {
    const { conversationId } = mailService.createConversation({
      type: "task",
      subject: `Task conversation for ${agentId}`,
      createdBy: parentId,
    });
    mailService.joinConversation({
      conversationId,
      participantId: parentId,
      role: "initiator",
    });
    mailService.joinConversation({
      conversationId,
      participantId: agentId,
      role: "worker",
    });
    conversationMap.setAgentConversation(agentId, conversationId);
    return conversationId;
  }

  describe("Parent → Child resolution", () => {
    it("should record turn in child's task conversation when parent sends to child", () => {
      spawnAgent("parent-1");
      spawnAgent("child-1", "parent-1");
      const taskConvId = setupTaskConversation("child-1", "parent-1");

      turnRecorder({
        from: "parent-1" as AgentId,
        toAgent: "child-1" as AgentId,
        content: "Hello child",
        messageId: "msg-1" as EventId,
        addressType: "agent",
      });

      const turns = mailService.listTurns({ conversationId: taskConvId });
      expect(turns).toHaveLength(1);
      expect(turns[0].participant).toBe("parent-1");
      expect(turns[0].content).toBe("Hello child");
      expect(turns[0].sourceType).toBe("intercepted");
      expect(turns[0].sourceMessageId).toBe("msg-1");
    });
  });

  describe("Child → Parent resolution", () => {
    it("should record turn in child's task conversation when child sends to parent", () => {
      spawnAgent("parent-1");
      spawnAgent("child-1", "parent-1");
      const taskConvId = setupTaskConversation("child-1", "parent-1");

      turnRecorder({
        from: "child-1" as AgentId,
        toAgent: "parent-1" as AgentId,
        content: "Hello parent",
        messageId: "msg-2" as EventId,
        addressType: "agent",
      });

      const turns = mailService.listTurns({ conversationId: taskConvId });
      expect(turns).toHaveLength(1);
      expect(turns[0].participant).toBe("child-1");
      expect(turns[0].content).toBe("Hello parent");
    });
  });

  describe("Peer resolution", () => {
    it("should auto-create peer conversation when peers message each other", () => {
      spawnAgent("parent-1");
      spawnAgent("peer-a", "parent-1");
      spawnAgent("peer-b", "parent-1");

      // Set up parent's task conversation so it can be used as parentConversationId
      const parentConvId = setupTaskConversation("parent-1", "parent-1");

      // peer-a sends to peer-b (neither is the other's parent)
      turnRecorder({
        from: "peer-a" as AgentId,
        toAgent: "peer-b" as AgentId,
        content: "Hey peer",
        messageId: "msg-3" as EventId,
        addressType: "agent",
      });

      // A peer conversation should have been auto-created
      const peerConvId = conversationMap.getPeerConversation("peer-a", "peer-b");
      expect(peerConvId).toBeDefined();

      const turns = mailService.listTurns({ conversationId: peerConvId! });
      expect(turns).toHaveLength(1);
      expect(turns[0].participant).toBe("peer-a");
      expect(turns[0].content).toBe("Hey peer");

      // Verify peer conversation was created properly
      const conv = mailService.getConversation(peerConvId!);
      expect(conv).not.toBeNull();
      expect(conv!.type).toBe("peer");

      // Verify parentConversationId is set to nearest common ancestor's conversation
      expect(conv!.parentConversationId).toBe(parentConvId);
    });

    it("should set parentConversationId to nearest common ancestor in deep hierarchy", () => {
      // grandparent → parent-a → peer-a
      // grandparent → parent-b → peer-b
      spawnAgent("grandparent");
      spawnAgent("parent-a", "grandparent");
      spawnAgent("parent-b", "grandparent");
      spawnAgent("peer-a", "parent-a");
      spawnAgent("peer-b", "parent-b");

      // Set up conversations for ancestors
      const gpConvId = setupTaskConversation("grandparent", "grandparent");
      setupTaskConversation("parent-a", "grandparent");
      setupTaskConversation("parent-b", "grandparent");

      turnRecorder({
        from: "peer-a" as AgentId,
        toAgent: "peer-b" as AgentId,
        content: "Deep peer message",
        messageId: "msg-deep" as EventId,
        addressType: "agent",
      });

      const peerConvId = conversationMap.getPeerConversation("peer-a", "peer-b");
      const conv = mailService.getConversation(peerConvId!);
      // Nearest common ancestor is grandparent
      expect(conv!.parentConversationId).toBe(gpConvId);
    });

    it("should leave parentConversationId undefined when peers share no ancestor", () => {
      // Two root agents with no common parent
      spawnAgent("root-a");
      spawnAgent("root-b");

      turnRecorder({
        from: "root-a" as AgentId,
        toAgent: "root-b" as AgentId,
        content: "No ancestor",
        messageId: "msg-no-ancestor" as EventId,
        addressType: "agent",
      });

      const peerConvId = conversationMap.getPeerConversation("root-a", "root-b");
      const conv = mailService.getConversation(peerConvId!);
      expect(conv!.parentConversationId).toBeUndefined();
    });

    it("should reuse peer conversation for subsequent messages", () => {
      spawnAgent("parent-1");
      spawnAgent("peer-a", "parent-1");
      spawnAgent("peer-b", "parent-1");

      // First message
      turnRecorder({
        from: "peer-a" as AgentId,
        toAgent: "peer-b" as AgentId,
        content: "First message",
        messageId: "msg-4" as EventId,
        addressType: "agent",
      });

      // Second message (reverse direction)
      turnRecorder({
        from: "peer-b" as AgentId,
        toAgent: "peer-a" as AgentId,
        content: "Reply",
        messageId: "msg-5" as EventId,
        addressType: "agent",
      });

      const peerConvId = conversationMap.getPeerConversation("peer-a", "peer-b");
      const turns = mailService.listTurns({ conversationId: peerConvId! });
      expect(turns).toHaveLength(2);
      expect(turns[0].participant).toBe("peer-a");
      expect(turns[1].participant).toBe("peer-b");
    });
  });

  describe("Task address resolution", () => {
    it("should handle task address type the same as agent address", () => {
      spawnAgent("parent-1");
      spawnAgent("child-1", "parent-1");
      const taskConvId = setupTaskConversation("child-1", "parent-1");

      turnRecorder({
        from: "parent-1" as AgentId,
        toAgent: "child-1" as AgentId,
        content: "Task message",
        messageId: "msg-6" as EventId,
        addressType: "task",
      });

      const turns = mailService.listTurns({ conversationId: taskConvId });
      expect(turns).toHaveLength(1);
      expect(turns[0].content).toBe("Task message");
    });
  });

  describe("Edge cases", () => {
    it("should silently skip when sender agent not found", () => {
      spawnAgent("child-1");

      // This should not throw
      turnRecorder({
        from: "nonexistent" as AgentId,
        toAgent: "child-1" as AgentId,
        content: "Hello",
        messageId: "msg-7" as EventId,
        addressType: "agent",
      });

      // No conversations should have been created
      expect(conversationMap.getPeerConversation("nonexistent", "child-1")).toBeUndefined();
    });

    it("should silently skip when receiver agent not found", () => {
      spawnAgent("sender-1");

      turnRecorder({
        from: "sender-1" as AgentId,
        toAgent: "nonexistent" as AgentId,
        content: "Hello",
        messageId: "msg-8" as EventId,
        addressType: "agent",
      });

      expect(conversationMap.getPeerConversation("sender-1", "nonexistent")).toBeUndefined();
    });

    it("should skip when child has no task conversation and parent sends", () => {
      spawnAgent("parent-1");
      spawnAgent("child-1", "parent-1");
      // No task conversation set up

      turnRecorder({
        from: "parent-1" as AgentId,
        toAgent: "child-1" as AgentId,
        content: "Hello",
        messageId: "msg-9" as EventId,
        addressType: "agent",
      });

      // No error should have been thrown, and no turns recorded anywhere
      // (resolveConversation returns null)
    });

    it("should handle multiple children correctly", () => {
      spawnAgent("parent-1");
      spawnAgent("child-a", "parent-1");
      spawnAgent("child-b", "parent-1");

      const convA = setupTaskConversation("child-a", "parent-1");
      const convB = setupTaskConversation("child-b", "parent-1");

      // Message to child-a
      turnRecorder({
        from: "parent-1" as AgentId,
        toAgent: "child-a" as AgentId,
        content: "To child A",
        messageId: "msg-10" as EventId,
        addressType: "agent",
      });

      // Message to child-b
      turnRecorder({
        from: "parent-1" as AgentId,
        toAgent: "child-b" as AgentId,
        content: "To child B",
        messageId: "msg-11" as EventId,
        addressType: "agent",
      });

      const turnsA = mailService.listTurns({ conversationId: convA });
      const turnsB = mailService.listTurns({ conversationId: convB });
      expect(turnsA).toHaveLength(1);
      expect(turnsA[0].content).toBe("To child A");
      expect(turnsB).toHaveLength(1);
      expect(turnsB[0].content).toBe("To child B");
    });
  });
});
