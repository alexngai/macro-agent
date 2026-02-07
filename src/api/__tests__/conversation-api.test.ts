/**
 * Conversation API Tests
 *
 * Tests for the conversation REST endpoints added in Phase 5.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { createEventStore, type EventStore } from "../../store/event-store.js";
import { createMailService, type MailService } from "../../mail/mail-service.js";
import { createConversationMap, type ConversationMap } from "../../mail/conversation-map.js";
import { createAPIServer, type APIServer, type APIServices } from "../server.js";

// Minimal mock services for API tests
function createMockAgentManager() {
  const agents: any[] = [];
  return {
    list: () => agents,
    get: (id: string) => agents.find((a) => a.id === id) ?? null,
    getChildren: () => [],
    getHierarchy: () => null,
    getOrCreateHeadManager: async (opts: any) => ({
      id: "hm-1",
      session_id: "session-1",
    }),
    getSession: () => null,
    hasActiveSession: () => false,
    isPrompting: () => false,
    supportsInjection: async () => false,
    isProcessRunning: () => false,
    prompt: async function* () {},
    promptUntilDone: async () => ({ doneCalled: false, updates: [] }),
    spawn: async () => ({ agent_id: "a-1", session_id: "s-1", id: "a-1" }),
    terminate: async () => {},
    resume: async () => ({ agent_id: "a-1", session_id: "s-1", id: "a-1" }),
    respondToPermission: () => false,
    cancelPermission: () => false,
    onLifecycleEvent: () => () => {},
    listHeadManagers: () => [],
    setMailServices: () => {},
    close: async () => {},
  };
}

function createMockTaskManager() {
  return {
    list: () => [],
    get: () => null,
    create: () => ({ id: "t-1" }),
    updateStatus: () => {},
  };
}

function createMockMessageRouter() {
  return {
    sendToAddress: async () => ({ id: "e-1", from: "a-1", to: {}, content: "", timestamp: 0, delivered: [] }),
    emitStatus: () => {},
    getMessages: () => [],
    getFullMessage: () => null,
    acknowledgeMessage: () => {},
    acknowledgeMessages: () => {},
    subscribe: () => {},
    unsubscribe: () => {},
    getSubscriptions: () => [],
    getSubscribers: () => [],
    setupDefaultSubscriptions: () => {},
    setTurnRecorder: () => {},
  };
}

describe("Conversation API", () => {
  let eventStore: EventStore;
  let mailService: MailService;
  let server: APIServer;

  beforeEach(async () => {
    eventStore = await createEventStore({ inMemory: true });
    mailService = createMailService({ eventStore });

    const services: APIServices = {
      eventStore,
      agentManager: createMockAgentManager() as any,
      taskManager: createMockTaskManager() as any,
      messageRouter: createMockMessageRouter() as any,
      mailService,
    };

    server = createAPIServer(services, { port: 0 });
  });

  afterEach(async () => {
    await eventStore.close();
  });

  describe("GET /api/conversations", () => {
    it("should return empty list when no conversations", async () => {
      const res = await request(server.app).get("/api/conversations");
      expect(res.status).toBe(200);
      expect(res.body.conversations).toEqual([]);
      expect(res.body.total).toBe(0);
    });

    it("should list created conversations", async () => {
      mailService.createConversation({
        type: "session",
        subject: "Test session",
        createdBy: "user",
      });
      mailService.createConversation({
        type: "task",
        subject: "Test task",
        createdBy: "agent-1",
      });

      const res = await request(server.app).get("/api/conversations");
      expect(res.status).toBe(200);
      expect(res.body.conversations).toHaveLength(2);
      expect(res.body.total).toBe(2);
    });

    it("should filter by type", async () => {
      mailService.createConversation({
        type: "session",
        subject: "Session",
        createdBy: "user",
      });
      mailService.createConversation({
        type: "task",
        subject: "Task",
        createdBy: "agent",
      });

      const res = await request(server.app).get("/api/conversations?type=session");
      expect(res.status).toBe(200);
      expect(res.body.conversations).toHaveLength(1);
      expect(res.body.conversations[0].type).toBe("session");
    });

    it("should support pagination", async () => {
      for (let i = 0; i < 5; i++) {
        mailService.createConversation({
          type: "task",
          subject: `Task ${i}`,
          createdBy: "agent",
        });
      }

      const res = await request(server.app).get("/api/conversations?limit=2&offset=1");
      expect(res.status).toBe(200);
      expect(res.body.conversations).toHaveLength(2);
      expect(res.body.total).toBe(5);
    });
  });

  describe("GET /api/conversations/:id", () => {
    it("should return conversation detail", async () => {
      const { conversationId } = mailService.createConversation({
        type: "session",
        subject: "My session",
        createdBy: "user",
      });

      const res = await request(server.app).get(`/api/conversations/${conversationId}`);
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(conversationId);
      expect(res.body.type).toBe("session");
      expect(res.body.subject).toBe("My session");
      expect(res.body.status).toBe("active");
    });

    it("should return 404 for non-existent conversation", async () => {
      const res = await request(server.app).get("/api/conversations/nonexistent");
      expect(res.status).toBe(404);
      expect(res.body.code).toBe("CONVERSATION_NOT_FOUND");
    });
  });

  describe("GET /api/conversations/:id/turns", () => {
    it("should list turns for a conversation", async () => {
      const { conversationId } = mailService.createConversation({
        type: "session",
        subject: "Session",
        createdBy: "user",
      });

      mailService.recordTurn({
        conversationId,
        participant: "user",
        contentType: "text",
        content: "Hello",
      });

      mailService.recordTurn({
        conversationId,
        participant: "agent-1",
        contentType: "text",
        content: "Hi there!",
      });

      const res = await request(server.app).get(`/api/conversations/${conversationId}/turns`);
      expect(res.status).toBe(200);
      expect(res.body.turns).toHaveLength(2);
      expect(res.body.total).toBe(2);
      expect(res.body.turns[0].participant).toBe("user");
      expect(res.body.turns[0].content).toBe("Hello");
      expect(res.body.turns[1].participant).toBe("agent-1");
    });

    it("should return 404 for non-existent conversation", async () => {
      const res = await request(server.app).get("/api/conversations/nonexistent/turns");
      expect(res.status).toBe(404);
    });

    it("should support pagination", async () => {
      const { conversationId } = mailService.createConversation({
        type: "session",
        subject: "Session",
        createdBy: "user",
      });

      for (let i = 0; i < 5; i++) {
        mailService.recordTurn({
          conversationId,
          participant: "user",
          contentType: "text",
          content: `Message ${i}`,
        });
      }

      const res = await request(server.app).get(`/api/conversations/${conversationId}/turns?limit=2&offset=1`);
      expect(res.status).toBe(200);
      expect(res.body.turns).toHaveLength(2);
      expect(res.body.total).toBe(5);
    });
  });

  describe("POST /api/conversations/:id/close", () => {
    it("should close an active conversation", async () => {
      const { conversationId } = mailService.createConversation({
        type: "session",
        subject: "Session",
        createdBy: "user",
      });

      const res = await request(server.app)
        .post(`/api/conversations/${conversationId}/close`)
        .send({ reason: "completed" });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      // Verify it's closed
      const conv = mailService.getConversation(conversationId);
      expect(conv!.status).toBe("completed");
    });

    it("should return 404 for non-existent conversation", async () => {
      const res = await request(server.app)
        .post("/api/conversations/nonexistent/close")
        .send({});
      expect(res.status).toBe(404);
    });

    it("should reject closing already-closed conversation", async () => {
      const { conversationId } = mailService.createConversation({
        type: "session",
        subject: "Session",
        createdBy: "user",
      });
      mailService.closeConversation({
        conversationId,
        closedBy: "user",
        reason: "completed",
      });

      const res = await request(server.app)
        .post(`/api/conversations/${conversationId}/close`)
        .send({});
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("ALREADY_CLOSED");
    });
  });

  describe("GET /api/conversations/:id/participants", () => {
    it("should list participants", async () => {
      const { conversationId } = mailService.createConversation({
        type: "task",
        subject: "Task",
        createdBy: "parent-1",
      });
      mailService.joinConversation({
        conversationId,
        participantId: "parent-1",
        role: "initiator",
      });
      mailService.joinConversation({
        conversationId,
        participantId: "child-1",
        role: "worker",
      });

      const res = await request(server.app).get(`/api/conversations/${conversationId}/participants`);
      expect(res.status).toBe(200);
      expect(res.body.participants).toHaveLength(2);
      expect(res.body.total).toBe(2);
    });

    it("should return 404 for non-existent conversation", async () => {
      const res = await request(server.app).get("/api/conversations/nonexistent/participants");
      expect(res.status).toBe(404);
    });
  });
});

// ─────────────────────────────────────────────────────────────────
// POST /api/init and POST /api/conversation/message mail side effects
// ─────────────────────────────────────────────────────────────────

describe("API Mail Side Effects", () => {
  let eventStore: EventStore;
  let mailService: MailService;
  let conversationMap: ConversationMap;
  let server: APIServer;

  function createPromptableAgentManager() {
    const agents: any[] = [];
    return {
      list: () => agents,
      get: (id: string) => agents.find((a: any) => a.id === id) ?? null,
      getChildren: () => [],
      getHierarchy: () => null,
      getOrCreateHeadManager: async () => ({
        id: "hm-test",
        session_id: "session-hm-test",
      }),
      getSession: () => null,
      hasActiveSession: () => false,
      isPrompting: () => false,
      supportsInjection: async () => false,
      isProcessRunning: () => false,
      prompt: async function* () {
        yield {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Agent response" },
        };
      },
      promptUntilDone: async () => ({ doneCalled: false, updates: [] }),
      spawn: async () => ({ agent_id: "a-1", session_id: "s-1", id: "a-1" }),
      terminate: async () => {},
      resume: async () => ({ agent_id: "a-1", session_id: "s-1", id: "a-1" }),
      respondToPermission: () => false,
      cancelPermission: () => false,
      onLifecycleEvent: () => () => {},
      listHeadManagers: () => [],
      setMailServices: () => {},
      close: async () => {},
    };
  }

  beforeEach(async () => {
    eventStore = await createEventStore({ inMemory: true });
    mailService = createMailService({ eventStore });
    conversationMap = createConversationMap();

    const services: APIServices = {
      eventStore,
      agentManager: createPromptableAgentManager() as any,
      taskManager: createMockTaskManager() as any,
      messageRouter: createMockMessageRouter() as any,
      mailService,
      conversationMap,
    };

    server = createAPIServer(services, { port: 0 });
  });

  afterEach(async () => {
    await eventStore.close();
  });

  describe("POST /api/init mail side effects", () => {
    it("should create session conversation on init", async () => {
      const res = await request(server.app)
        .post("/api/init")
        .send({ cwd: "/tmp" });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.head_manager_id).toBe("hm-test");

      // Verify session conversation created
      const convs = mailService.listConversations({ type: "session" });
      expect(convs).toHaveLength(1);
      expect(convs[0].subject).toBe("User session");
      expect(convs[0].status).toBe("active");

      // Verify HM joined as worker
      const participants = mailService.listParticipants(convs[0].id);
      expect(participants).toHaveLength(1);
      expect(participants[0].id).toBe("hm-test");
      expect(participants[0].role).toBe("worker");

      // Verify conversationMap wired
      expect(conversationMap.getSessionConversation("hm-test")).toBe(convs[0].id);
    });
  });

  describe("POST /api/conversation/message mail side effects", () => {
    it("should record user and assistant turns in session conversation", async () => {
      // First init
      await request(server.app)
        .post("/api/init")
        .send({ cwd: "/tmp" });

      const sessionConvId = conversationMap.getSessionConversation("hm-test")!;
      expect(sessionConvId).toBeDefined();

      // Send message
      const res = await request(server.app)
        .post("/api/conversation/message")
        .send({ message: "Hello agent" });

      expect(res.status).toBe(200);
      expect(res.body.content).toBe("Agent response");

      // Verify turns recorded
      const turns = mailService.listTurns({ conversationId: sessionConvId });
      expect(turns).toHaveLength(2);

      // User turn
      expect(turns[0].participant).toBe("user");
      expect(turns[0].content).toBe("Hello agent");
      expect(turns[0].contentType).toBe("text");

      // Assistant turn
      expect(turns[1].participant).toBe("hm-test");
      expect(turns[1].content).toBe("Agent response");
      expect(turns[1].contentType).toBe("text");
    });

    it("should record multiple exchanges in session conversation", async () => {
      await request(server.app)
        .post("/api/init")
        .send({ cwd: "/tmp" });

      const sessionConvId = conversationMap.getSessionConversation("hm-test")!;

      // Send two messages
      await request(server.app)
        .post("/api/conversation/message")
        .send({ message: "First question" });

      await request(server.app)
        .post("/api/conversation/message")
        .send({ message: "Second question" });

      const turns = mailService.listTurns({ conversationId: sessionConvId });
      // 2 exchanges × 2 turns = 4 turns
      expect(turns).toHaveLength(4);
      expect(turns[0].participant).toBe("user");
      expect(turns[0].content).toBe("First question");
      expect(turns[1].participant).toBe("hm-test");
      expect(turns[2].participant).toBe("user");
      expect(turns[2].content).toBe("Second question");
      expect(turns[3].participant).toBe("hm-test");
    });
  });
});
