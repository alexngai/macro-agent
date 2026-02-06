/**
 * Mail Integration Tests
 *
 * Full pipeline integration tests verifying MailService, ConversationMap,
 * TurnRecorder, MessageRouter, and EventStore all work together with
 * real (in-memory) services.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createEventStore, type EventStore } from "../../store/event-store.js";
import { createMailService, type MailService } from "../mail-service.js";
import { createConversationMap, type ConversationMap } from "../conversation-map.js";
import { createTurnRecorder } from "../turn-recorder.js";
import {
  createMessageRouter,
  type MessageRouter,
} from "../../router/message-router.js";
import type { AgentId } from "../../store/types/index.js";

describe("Mail Integration - Full Pipeline", () => {
  let eventStore: EventStore;
  let messageRouter: MessageRouter;
  let mailService: MailService;
  let conversationMap: ConversationMap;

  beforeEach(async () => {
    eventStore = await createEventStore({ inMemory: true });
    messageRouter = createMessageRouter(eventStore);
    mailService = createMailService({ eventStore });
    conversationMap = createConversationMap();

    // Wire turn recorder into message router
    const turnRecorder = createTurnRecorder({
      mailService,
      conversationMap,
      eventStore,
    });
    messageRouter.setTurnRecorder(turnRecorder);
  });

  afterEach(async () => {
    await eventStore.close();
  });

  // ─────────────────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────────────────

  function spawnAgent(agentId: string, parentId?: string, task?: string): void {
    const lineage: string[] = [];
    if (parentId) {
      const parent = eventStore.getAgent(parentId as AgentId);
      if (parent) {
        lineage.push(...parent.lineage, parentId);
      } else {
        lineage.push(parentId);
      }
    }
    eventStore.emit({
      type: "spawn",
      source: { agent_id: (parentId ?? agentId) as AgentId },
      payload: {
        agent_id: agentId,
        session_id: `session-${agentId}`,
        task: task ?? `Task for ${agentId}`,
        parent: parentId ?? null,
        lineage,
        role: "worker",
      },
    });
  }

  function setupTaskConversation(agentId: string, parentId: string): string {
    const parentConversationId =
      conversationMap.getAgentConversation(parentId) ??
      conversationMap.getSessionConversation(parentId);

    const { conversationId } = mailService.createConversation({
      type: "task",
      subject: `Task conversation for ${agentId}`,
      createdBy: parentId,
      parentConversationId,
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

  function setupSessionConversation(hmId: string): string {
    const { conversationId } = mailService.createConversation({
      type: "session",
      subject: "User session",
      createdBy: "user",
    });
    mailService.joinConversation({
      conversationId,
      participantId: hmId,
      role: "worker",
    });
    conversationMap.setSessionConversation(hmId, conversationId);
    return conversationId;
  }

  function subscribeAgent(agentId: string, parentId?: string): void {
    messageRouter.setupDefaultSubscriptions({
      agent_id: agentId as AgentId,
      parent_id: parentId as AgentId | undefined,
    });
  }

  // ─────────────────────────────────────────────────────────────────
  // Full lifecycle
  // ─────────────────────────────────────────────────────────────────

  describe("Full lifecycle: spawn → messages → done → terminate", () => {
    it("creates session conv, spawns worker, records turns via router, closes on done", async () => {
      // 1. Setup head manager with session conversation
      spawnAgent("hm-1");
      subscribeAgent("hm-1");
      const sessionConvId = setupSessionConversation("hm-1");

      // 2. Record user message in session conversation
      mailService.recordTurn({
        conversationId: sessionConvId,
        participant: "user",
        contentType: "text",
        content: "Please refactor the auth module",
      });

      // 3. Spawn worker, setup task conversation
      spawnAgent("worker-1", "hm-1", "Refactor auth");
      subscribeAgent("worker-1", "hm-1");
      const taskConvId = setupTaskConversation("worker-1", "hm-1");

      // 4. Head manager sends task instruction to worker via router
      await messageRouter.sendToAddress({
        from: "hm-1" as AgentId,
        to: { agent: "worker-1" as AgentId },
        content: "Refactor the auth module, focus on token storage",
      });

      // Verify: turn intercepted in worker's task conversation
      let taskTurns = mailService.listTurns({ conversationId: taskConvId });
      expect(taskTurns).toHaveLength(1);
      expect(taskTurns[0].participant).toBe("hm-1");
      expect(taskTurns[0].content).toBe("Refactor the auth module, focus on token storage");
      expect(taskTurns[0].sourceType).toBe("intercepted");

      // 5. Worker sends reply to head manager
      await messageRouter.sendToAddress({
        from: "worker-1" as AgentId,
        to: { agent: "hm-1" as AgentId },
        content: "Found 3 issues in auth module, proceeding with fix",
      });

      // Verify: 2 turns in task conversation (parent→child + child→parent)
      taskTurns = mailService.listTurns({ conversationId: taskConvId });
      expect(taskTurns).toHaveLength(2);
      expect(taskTurns[0].participant).toBe("hm-1");
      expect(taskTurns[1].participant).toBe("worker-1");

      // 6. Simulate worker done() — record completion turn + close
      mailService.recordTurn({
        conversationId: taskConvId,
        participant: "worker-1",
        contentType: "event",
        content: { event: "agent.completed", summary: "Auth refactored" },
      });
      mailService.closeConversation({
        conversationId: taskConvId,
        closedBy: "worker-1",
        reason: "completed",
      });
      conversationMap.removeAgent("worker-1");

      // 7. Head manager responds in session conversation
      mailService.recordTurn({
        conversationId: sessionConvId,
        participant: "hm-1",
        contentType: "text",
        content: "Done. The auth module has been refactored.",
      });

      // Verify final state
      const sessionConv = mailService.getConversation(sessionConvId);
      expect(sessionConv!.status).toBe("active");
      const sessionTurns = mailService.listTurns({ conversationId: sessionConvId });
      expect(sessionTurns).toHaveLength(2); // user + assistant

      const taskConv = mailService.getConversation(taskConvId);
      expect(taskConv!.status).toBe("completed");
      const finalTaskTurns = mailService.listTurns({ conversationId: taskConvId });
      expect(finalTaskTurns).toHaveLength(3); // 2 intercepted + 1 event

      // Verify total conversations
      const allConvs = mailService.listConversations();
      expect(allConvs).toHaveLength(2);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Multi-level hierarchy
  // ─────────────────────────────────────────────────────────────────

  describe("Multi-level hierarchy", () => {
    it("creates conversation tree with correct parentConversationId chain", () => {
      // Setup 3-level hierarchy
      spawnAgent("gp");
      const sessionConvId = setupSessionConversation("gp");

      spawnAgent("parent", "gp");
      const parentTaskConvId = setupTaskConversation("parent", "gp");

      spawnAgent("child", "parent");
      const childTaskConvId = setupTaskConversation("child", "parent");

      // Verify parentConversationId chain
      const parentConv = mailService.getConversation(parentTaskConvId);
      expect(parentConv!.parentConversationId).toBe(sessionConvId);

      const childConv = mailService.getConversation(childTaskConvId);
      expect(childConv!.parentConversationId).toBe(parentTaskConvId);

      // Verify total: 1 session + 2 task
      expect(mailService.listConversations()).toHaveLength(3);
    });

    it("routes messages correctly across three levels", async () => {
      // Setup 3-level hierarchy with subscriptions
      spawnAgent("gp");
      subscribeAgent("gp");
      setupSessionConversation("gp");

      spawnAgent("parent", "gp");
      subscribeAgent("parent", "gp");
      const parentConvId = setupTaskConversation("parent", "gp");

      spawnAgent("child", "parent");
      subscribeAgent("child", "parent");
      const childConvId = setupTaskConversation("child", "parent");

      // gp → parent: turn in parent's task conversation
      await messageRouter.sendToAddress({
        from: "gp" as AgentId,
        to: { agent: "parent" as AgentId },
        content: "GP to parent",
      });
      expect(mailService.listTurns({ conversationId: parentConvId })).toHaveLength(1);
      expect(mailService.listTurns({ conversationId: childConvId })).toHaveLength(0);

      // parent → child: turn in child's task conversation
      await messageRouter.sendToAddress({
        from: "parent" as AgentId,
        to: { agent: "child" as AgentId },
        content: "Parent to child",
      });
      expect(mailService.listTurns({ conversationId: childConvId })).toHaveLength(1);

      // child → parent: still in child's task conversation
      await messageRouter.sendToAddress({
        from: "child" as AgentId,
        to: { agent: "parent" as AgentId },
        content: "Child to parent",
      });
      expect(mailService.listTurns({ conversationId: childConvId })).toHaveLength(2);
      expect(mailService.listTurns({ conversationId: parentConvId })).toHaveLength(1);

      // parent → gp: in parent's task conversation
      await messageRouter.sendToAddress({
        from: "parent" as AgentId,
        to: { agent: "gp" as AgentId },
        content: "Parent to GP",
      });
      expect(mailService.listTurns({ conversationId: parentConvId })).toHaveLength(2);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // MessageRouter + TurnRecorder integration
  // ─────────────────────────────────────────────────────────────────

  describe("MessageRouter + TurnRecorder integration", () => {
    it("records turns for agent address messages with correct metadata", async () => {
      spawnAgent("parent");
      subscribeAgent("parent");
      spawnAgent("child", "parent");
      subscribeAgent("child", "parent");
      const taskConvId = setupTaskConversation("child", "parent");

      await messageRouter.sendToAddress({
        from: "parent" as AgentId,
        to: { agent: "child" as AgentId },
        content: "Hello child",
      });

      const turns = mailService.listTurns({ conversationId: taskConvId });
      expect(turns).toHaveLength(1);
      expect(turns[0].sourceType).toBe("intercepted");
      expect(turns[0].sourceMessageId).toBeDefined();
      expect(turns[0].participant).toBe("parent");
      expect(turns[0].contentType).toBe("text");
    });

    it("records turns for task address messages", async () => {
      spawnAgent("parent");
      subscribeAgent("parent");
      spawnAgent("child", "parent");
      subscribeAgent("child", "parent");
      const taskConvId = setupTaskConversation("child", "parent");

      // Create a task assigned to child
      eventStore.emit({
        type: "task",
        source: { agent_id: "parent" as AgentId },
        payload: {
          action: "created",
          task_id: "task-1",
          details: { description: "Test task" },
        },
      });
      // Assign to child
      eventStore.emit({
        type: "task",
        source: { agent_id: "parent" as AgentId },
        payload: {
          action: "assigned",
          task_id: "task-1",
          details: { agent_id: "child" },
        },
      });

      await messageRouter.sendToAddress({
        from: "parent" as AgentId,
        to: { task: "task-1" as any },
        content: "Task message",
      });

      const turns = mailService.listTurns({ conversationId: taskConvId });
      expect(turns).toHaveLength(1);
      expect(turns[0].content).toBe("Task message");
    });

    it("does NOT record turns for broadcast messages", async () => {
      spawnAgent("broadcaster");
      subscribeAgent("broadcaster");
      spawnAgent("listener", "broadcaster");
      subscribeAgent("listener", "broadcaster");
      setupTaskConversation("listener", "broadcaster");

      // Subscribe listener to broadcast channel
      messageRouter.subscribe("listener" as AgentId, {
        type: "broadcast",
        name: "announcements",
      });

      await messageRouter.sendToAddress({
        from: "broadcaster" as AgentId,
        to: { broadcast: true },
        content: "Broadcast announcement",
      });

      // No turns should be created anywhere
      const allConvs = mailService.listConversations();
      for (const conv of allConvs) {
        const turns = mailService.listTurns({ conversationId: conv.id });
        expect(turns).toHaveLength(0);
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Peer conversations
  // ─────────────────────────────────────────────────────────────────

  describe("Peer conversations", () => {
    it("auto-creates peer conversation when siblings message via router", async () => {
      spawnAgent("coordinator");
      subscribeAgent("coordinator");
      const coordConvId = setupSessionConversation("coordinator");

      spawnAgent("worker-a", "coordinator");
      subscribeAgent("worker-a", "coordinator");
      setupTaskConversation("worker-a", "coordinator");

      spawnAgent("worker-b", "coordinator");
      subscribeAgent("worker-b", "coordinator");
      setupTaskConversation("worker-b", "coordinator");

      // Worker A sends to Worker B (peers, not parent-child)
      await messageRouter.sendToAddress({
        from: "worker-a" as AgentId,
        to: { agent: "worker-b" as AgentId },
        content: "Hey, here's the schema you need",
      });

      // Peer conversation should exist
      const peerConvId = conversationMap.getPeerConversation("worker-a", "worker-b");
      expect(peerConvId).toBeDefined();

      const peerConv = mailService.getConversation(peerConvId!);
      expect(peerConv!.type).toBe("peer");
      // Nearest common ancestor is coordinator (session conv)
      expect(peerConv!.parentConversationId).toBe(coordConvId);

      // Verify participants
      const participants = mailService.listParticipants(peerConvId!);
      expect(participants).toHaveLength(2);

      // Verify turn
      const turns = mailService.listTurns({ conversationId: peerConvId! });
      expect(turns).toHaveLength(1);
      expect(turns[0].participant).toBe("worker-a");
    });

    it("reuses peer conversation for reply messages", async () => {
      spawnAgent("parent");
      subscribeAgent("parent");

      spawnAgent("peer-a", "parent");
      subscribeAgent("peer-a", "parent");

      spawnAgent("peer-b", "parent");
      subscribeAgent("peer-b", "parent");

      // First message
      await messageRouter.sendToAddress({
        from: "peer-a" as AgentId,
        to: { agent: "peer-b" as AgentId },
        content: "First",
      });

      const convId = conversationMap.getPeerConversation("peer-a", "peer-b");

      // Reply in reverse direction
      await messageRouter.sendToAddress({
        from: "peer-b" as AgentId,
        to: { agent: "peer-a" as AgentId },
        content: "Reply",
      });

      // Same conversation, 2 turns
      expect(conversationMap.getPeerConversation("peer-a", "peer-b")).toBe(convId);
      const turns = mailService.listTurns({ conversationId: convId! });
      expect(turns).toHaveLength(2);
      expect(turns[0].participant).toBe("peer-a");
      expect(turns[1].participant).toBe("peer-b");
    });

    it("sets parentConversationId to nearest common ancestor for deep hierarchy", async () => {
      // root → branch-a → leaf-a
      // root → branch-b → leaf-b
      spawnAgent("root");
      subscribeAgent("root");
      const rootConvId = setupSessionConversation("root");

      spawnAgent("branch-a", "root");
      subscribeAgent("branch-a", "root");
      setupTaskConversation("branch-a", "root");

      spawnAgent("branch-b", "root");
      subscribeAgent("branch-b", "root");
      setupTaskConversation("branch-b", "root");

      spawnAgent("leaf-a", "branch-a");
      subscribeAgent("leaf-a", "branch-a");

      spawnAgent("leaf-b", "branch-b");
      subscribeAgent("leaf-b", "branch-b");

      // leaf-a messages leaf-b
      await messageRouter.sendToAddress({
        from: "leaf-a" as AgentId,
        to: { agent: "leaf-b" as AgentId },
        content: "Cross-branch message",
      });

      const peerConvId = conversationMap.getPeerConversation("leaf-a", "leaf-b");
      const peerConv = mailService.getConversation(peerConvId!);

      // Nearest common ancestor is root (session conv)
      expect(peerConv!.parentConversationId).toBe(rootConvId);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Cascade termination cleanup
  // ─────────────────────────────────────────────────────────────────

  describe("Cascade termination cleanup", () => {
    it("closes child and peer conversations on terminate", async () => {
      // Setup: coordinator → worker-a, worker-b, peer conv between workers
      spawnAgent("coord");
      subscribeAgent("coord");
      setupSessionConversation("coord");

      spawnAgent("wa", "coord");
      subscribeAgent("wa", "coord");
      const waConvId = setupTaskConversation("wa", "coord");

      spawnAgent("wb", "coord");
      subscribeAgent("wb", "coord");
      const wbConvId = setupTaskConversation("wb", "coord");

      // Create peer conversation
      await messageRouter.sendToAddress({
        from: "wa" as AgentId,
        to: { agent: "wb" as AgentId },
        content: "Peer msg",
      });
      const peerConvId = conversationMap.getPeerConversation("wa", "wb")!;

      // Simulate terminate cascade (same sequence as agent-manager.ts:709-729)
      // Terminate worker-a
      const waConv = conversationMap.getAgentConversation("wa");
      if (waConv) {
        mailService.closeConversation({ conversationId: waConv, closedBy: "wa", reason: "completed" });
      }
      const waPeerConvIds = conversationMap.closePeerConversationsFor("wa");
      for (const id of waPeerConvIds) {
        mailService.closeConversation({ conversationId: id, closedBy: "wa", reason: "participant_left" });
      }
      conversationMap.removeAgent("wa");

      // Terminate worker-b
      const wbConv = conversationMap.getAgentConversation("wb");
      if (wbConv) {
        mailService.closeConversation({ conversationId: wbConv, closedBy: "wb", reason: "completed" });
      }
      conversationMap.closePeerConversationsFor("wb");
      conversationMap.removeAgent("wb");

      // Verify: all task + peer convs closed
      expect(mailService.getConversation(waConvId)!.status).toBe("completed");
      expect(mailService.getConversation(wbConvId)!.status).toBe("completed");
      expect(mailService.getConversation(peerConvId)!.status).toBe("completed");

      // Agents removed from map
      expect(conversationMap.getAgentConversation("wa")).toBeUndefined();
      expect(conversationMap.getAgentConversation("wb")).toBeUndefined();
      expect(conversationMap.getPeerConversation("wa", "wb")).toBeUndefined();

      // Session conversation stays active
      const sessionConvId = conversationMap.getSessionConversation("coord");
      expect(mailService.getConversation(sessionConvId!)!.status).toBe("active");
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // listConversations filters
  // ─────────────────────────────────────────────────────────────────

  describe("listConversations filters", () => {
    it("filters by type, status, and parentConversationId", () => {
      // Create 1 session, 2 task, 1 peer
      spawnAgent("root");
      const sessionId = setupSessionConversation("root");

      spawnAgent("child-1", "root");
      const task1Id = setupTaskConversation("child-1", "root");

      spawnAgent("child-2", "root");
      setupTaskConversation("child-2", "root");

      // Create peer
      const { conversationId: peerId } = mailService.createConversation({
        type: "peer",
        subject: "Peer conv",
        createdBy: "child-1",
      });

      // Close one task
      mailService.closeConversation({
        conversationId: task1Id,
        closedBy: "child-1",
        reason: "completed",
      });

      // Filter by type
      expect(mailService.listConversations({ type: "session" })).toHaveLength(1);
      expect(mailService.listConversations({ type: "task" })).toHaveLength(2);
      expect(mailService.listConversations({ type: "peer" })).toHaveLength(1);

      // Filter by status
      expect(mailService.listConversations({ status: "active" })).toHaveLength(3);
      expect(mailService.listConversations({ status: "completed" })).toHaveLength(1);

      // Filter by parentConversationId
      expect(
        mailService.listConversations({ parentConversationId: sessionId })
      ).toHaveLength(2); // both task convs have session as parent

      // Total
      expect(mailService.listConversations()).toHaveLength(4);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Error paths and edge cases
  // ─────────────────────────────────────────────────────────────────

  describe("Error paths and edge cases", () => {
    it("allows recording turns in a closed conversation (no validation at service layer)", () => {
      spawnAgent("parent");
      spawnAgent("child", "parent");
      const convId = setupTaskConversation("child", "parent");

      // Close the conversation
      mailService.closeConversation({ conversationId: convId, closedBy: "child", reason: "completed" });
      expect(mailService.getConversation(convId)!.status).toBe("completed");

      // MailService does NOT validate — turn still records
      const { turnId } = mailService.recordTurn({
        conversationId: convId,
        participant: "parent",
        contentType: "text",
        content: "Late message",
      });
      expect(turnId).toBeDefined();

      const turns = mailService.listTurns({ conversationId: convId });
      expect(turns).toHaveLength(1);
      expect(turns[0].content).toBe("Late message");
    });

    it("allows double-closing a conversation (idempotent at service layer)", () => {
      const { conversationId } = mailService.createConversation({
        type: "session",
        subject: "Double close",
        createdBy: "user",
      });

      mailService.closeConversation({ conversationId, closedBy: "user", reason: "completed" });
      expect(mailService.getConversation(conversationId)!.status).toBe("completed");

      // Second close doesn't throw — just re-applies
      mailService.closeConversation({ conversationId, closedBy: "user", reason: "failed" });
      expect(mailService.getConversation(conversationId)!.status).toBe("failed");
    });

    it("TurnRecorder silently skips when child task conv doesn't exist", async () => {
      spawnAgent("parent");
      subscribeAgent("parent");
      spawnAgent("child", "parent");
      subscribeAgent("child", "parent");
      // No task conversation set up for child

      // Should not throw
      await messageRouter.sendToAddress({
        from: "parent" as AgentId,
        to: { agent: "child" as AgentId },
        content: "No conv",
      });

      // No conversations created
      expect(mailService.listConversations()).toHaveLength(0);
    });

    it("handles messages between agents with no common ancestor gracefully", async () => {
      spawnAgent("root-a");
      subscribeAgent("root-a");
      spawnAgent("root-b");
      subscribeAgent("root-b");

      // Peers with no common ancestor
      await messageRouter.sendToAddress({
        from: "root-a" as AgentId,
        to: { agent: "root-b" as AgentId },
        content: "No ancestor",
      });

      const peerConvId = conversationMap.getPeerConversation("root-a", "root-b");
      expect(peerConvId).toBeDefined();

      const conv = mailService.getConversation(peerConvId!);
      expect(conv!.type).toBe("peer");
      expect(conv!.parentConversationId).toBeUndefined();
    });

    it("turn-recorder does not fail message routing when recordTurn throws", async () => {
      spawnAgent("parent");
      subscribeAgent("parent");
      spawnAgent("child", "parent");
      subscribeAgent("child", "parent");

      const taskConvId = setupTaskConversation("child", "parent");

      // Sabotage the mailService.recordTurn to throw
      const originalRecordTurn = mailService.recordTurn.bind(mailService);
      mailService.recordTurn = () => {
        throw new Error("Simulated store failure");
      };

      // Message routing should still succeed (no throw)
      await expect(
        messageRouter.sendToAddress({
          from: "parent" as AgentId,
          to: { agent: "child" as AgentId },
          content: "Should still route",
        })
      ).resolves.not.toThrow();

      // Restore original and send another message to verify routing still works
      mailService.recordTurn = originalRecordTurn;
      await messageRouter.sendToAddress({
        from: "parent" as AgentId,
        to: { agent: "child" as AgentId },
        content: "After recovery",
      });

      // The recovered turn should be recorded
      const turns = mailService.listTurns({ conversationId: taskConvId });
      expect(turns.length).toBeGreaterThanOrEqual(1);
      expect(turns.some((t) => t.content === "After recovery")).toBe(true);
    });

    it("does not create duplicate peer conversations for same pair", async () => {
      spawnAgent("parent");
      subscribeAgent("parent");
      spawnAgent("a", "parent");
      subscribeAgent("a", "parent");
      spawnAgent("b", "parent");
      subscribeAgent("b", "parent");

      // Send multiple messages in both directions
      await messageRouter.sendToAddress({
        from: "a" as AgentId,
        to: { agent: "b" as AgentId },
        content: "msg-1",
      });
      await messageRouter.sendToAddress({
        from: "b" as AgentId,
        to: { agent: "a" as AgentId },
        content: "msg-2",
      });
      await messageRouter.sendToAddress({
        from: "a" as AgentId,
        to: { agent: "b" as AgentId },
        content: "msg-3",
      });

      // Only 1 peer conversation should exist
      const peerConvs = mailService.listConversations({ type: "peer" });
      expect(peerConvs).toHaveLength(1);

      // All 3 turns in that single conversation
      const turns = mailService.listTurns({ conversationId: peerConvs[0].id });
      expect(turns).toHaveLength(3);
    });
  });
});
