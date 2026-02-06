/**
 * Mail MAP Protocol E2E Tests
 *
 * Tests MAP mail/* protocol methods via real WebSocket connections,
 * REST API endpoints, and WebSocket subscription channels.
 *
 * Uses a real CombinedServer with in-memory EventStore.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { WebSocket } from "ws";
import { createEventStore, type EventStore } from "../../store/event-store.js";
import {
  createAgentManager,
  type AgentManager,
} from "../../agent/agent-manager.js";
import { createTaskManager, type TaskManager } from "../../task/task-manager.js";
import {
  createMessageRouter,
  type MessageRouter,
} from "../../router/message-router.js";
import {
  createCombinedServer,
  type CombinedServer,
  type CombinedServerServices,
} from "../../server/combined-server.js";
import type { AgentId } from "../../store/types/index.js";

// ─────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────

function getRandomPort(): number {
  return 10000 + Math.floor(Math.random() * 50000);
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: any;
  error?: { code: number; message: string; data?: unknown };
}

/**
 * JSON-RPC WebSocket client for MAP protocol at /map.
 */
class TestMAPClient {
  private ws!: WebSocket;
  private waiters: Map<number, { resolve: (r: JsonRpcResponse) => void; reject: (e: Error) => void }> = new Map();
  private nextId = 1;
  private url: string;

  constructor(url: string) {
    this.url = url;
  }

  async connect(): Promise<void> {
    this.ws = new WebSocket(this.url);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("MAP connection timeout")), 5000);
      this.ws.on("open", () => {
        clearTimeout(timeout);
        resolve();
      });
      this.ws.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
      this.ws.on("message", (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.id != null) {
            const waiter = this.waiters.get(msg.id);
            if (waiter) {
              this.waiters.delete(msg.id);
              waiter.resolve(msg as JsonRpcResponse);
            }
          }
        } catch {
          // ignore
        }
      });
    });
  }

  async request(method: string, params?: unknown): Promise<JsonRpcResponse> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.waiters.delete(id);
        reject(new Error(`MAP request timeout: ${method}`));
      }, 10000);
      this.waiters.set(id, {
        resolve: (r) => { clearTimeout(timeout); resolve(r); },
        reject: (e) => { clearTimeout(timeout); reject(e); },
      });
      this.ws.send(JSON.stringify({ jsonrpc: "2.0", method, params, id }));
    });
  }

  close(): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.close();
    }
  }
}

interface WSMessage {
  type: string;
  [key: string]: unknown;
}

/**
 * Simple WebSocket client for API WebSocket at /api/ws.
 * Uses subscribe/unsubscribe protocol (not JSON-RPC).
 */
class TestAPIWSClient {
  private ws!: WebSocket;
  private messages: WSMessage[] = [];
  private messageWaiters: Array<{
    check: (msg: WSMessage) => boolean;
    resolve: (msg: WSMessage) => void;
    reject: (err: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  }> = [];
  private url: string;

  constructor(url: string) {
    this.url = url;
  }

  async connect(): Promise<void> {
    this.ws = new WebSocket(this.url);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("API WS connection timeout")), 5000);
      this.ws.on("open", () => {
        clearTimeout(timeout);
        resolve();
      });
      this.ws.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
      this.ws.on("message", (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString()) as WSMessage;
          this.messages.push(msg);

          // Check pending waiters
          for (let i = this.messageWaiters.length - 1; i >= 0; i--) {
            const waiter = this.messageWaiters[i];
            if (waiter.check(msg)) {
              clearTimeout(waiter.timeout);
              this.messageWaiters.splice(i, 1);
              waiter.resolve(msg);
            }
          }
        } catch {
          // ignore
        }
      });
    });
  }

  async subscribe(channel: string): Promise<void> {
    this.ws.send(JSON.stringify({ type: "subscribe", channel }));
    // Wait for subscribed confirmation
    await this.waitForMessage((msg) => msg.type === "subscribed" && msg.channel === channel);
  }

  waitForMessage(
    check: (msg: WSMessage) => boolean,
    timeoutMs = 5000
  ): Promise<WSMessage> {
    // Check existing messages first
    const existing = this.messages.find(check);
    if (existing) return Promise.resolve(existing);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const idx = this.messageWaiters.findIndex((w) => w.resolve === resolve);
        if (idx >= 0) this.messageWaiters.splice(idx, 1);
        reject(new Error("Timeout waiting for WebSocket message"));
      }, timeoutMs);

      this.messageWaiters.push({ check, resolve, reject, timeout });
    });
  }

  getMessages(): WSMessage[] {
    return [...this.messages];
  }

  clearMessages(): void {
    this.messages.length = 0;
  }

  close(): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.close();
    }
  }
}

function spawnAgent(eventStore: EventStore, agentId: string, parentId?: string): void {
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
      task: `Task for ${agentId}`,
      parent: parentId ?? null,
      lineage,
      role: "worker",
    },
  });
}

// ─────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────

describe("Mail MAP Protocol E2E", () => {
  let eventStore: EventStore;
  let agentManager: AgentManager;
  let taskManager: TaskManager;
  let messageRouter: MessageRouter;
  let server: CombinedServer;
  let port: number;
  let baseUrl: string;
  const clients: Array<{ close(): void }> = [];

  beforeEach(async () => {
    port = getRandomPort();
    eventStore = await createEventStore({ inMemory: true });
    messageRouter = createMessageRouter(eventStore);
    taskManager = createTaskManager(eventStore);
    agentManager = createAgentManager(eventStore, messageRouter, {
      defaultPermissionMode: "auto-approve",
      defaultCwd: process.cwd(),
    });

    const services: CombinedServerServices = {
      eventStore,
      agentManager,
      taskManager,
      messageRouter,
    };

    server = createCombinedServer(services, { port, host: "localhost" });
    await server.start();
    baseUrl = server.getUrl();
  });

  afterEach(async () => {
    for (const c of clients) {
      c.close();
    }
    clients.length = 0;
    await server.stop().catch(() => {});
    await agentManager.close();
    await eventStore.close();
  });

  function createMAPClient(): TestMAPClient {
    const client = new TestMAPClient(`ws://localhost:${port}/map`);
    clients.push(client);
    return client;
  }

  function createAPIWSClient(): TestAPIWSClient {
    const client = new TestAPIWSClient(`ws://localhost:${port}/api/ws`);
    clients.push(client);
    return client;
  }

  // ─────────────────────────────────────────────────────────────────
  // MAP WebSocket mail/* methods
  // ─────────────────────────────────────────────────────────────────

  describe("MAP WebSocket mail/* methods", () => {
    describe("mail/create", () => {
      it("creates a conversation via MAP protocol", async () => {
        const client = createMAPClient();
        await client.connect();


        const res = await client.request("mail/create", {
          type: "session",
          subject: "Test session from MAP",
        });

        expect(res.error).toBeUndefined();
        expect(res.result.conversation).toBeDefined();
        expect(res.result.conversation.id).toMatch(/^conv_/);
        expect(res.result.conversation.type).toBe("session");
        expect(res.result.conversation.status).toBe("active");
        expect(res.result.conversation.subject).toBe("Test session from MAP");
        expect(res.result.conversation.participantCount).toBeGreaterThanOrEqual(1);
      });

      it("creates conversation with initial participants", async () => {
        const client = createMAPClient();
        await client.connect();


        const res = await client.request("mail/create", {
          type: "task",
          subject: "Task with participants",
          initialParticipants: [{ id: "agent-1", role: "worker" }],
        });

        expect(res.error).toBeUndefined();
        expect(res.result.conversation.participantCount).toBe(2);
      });
    });

    describe("mail/list", () => {
      it("lists conversations created by internal agents", async () => {
        // Pre-populate via server's mailService
        const ms = server.mailService!;
        ms.createConversation({ type: "session", subject: "Session 1", createdBy: "user" });
        ms.createConversation({ type: "task", subject: "Task 1", createdBy: "agent-1" });
        ms.createConversation({ type: "task", subject: "Task 2", createdBy: "agent-2" });

        const client = createMAPClient();
        await client.connect();


        const res = await client.request("mail/list");
        expect(res.error).toBeUndefined();
        expect(res.result.conversations).toHaveLength(3);
        expect(res.result.hasMore).toBe(false);
      });

      it("filters by type", async () => {
        const ms = server.mailService!;
        ms.createConversation({ type: "session", subject: "S", createdBy: "user" });
        ms.createConversation({ type: "task", subject: "T1", createdBy: "a" });
        ms.createConversation({ type: "task", subject: "T2", createdBy: "b" });

        const client = createMAPClient();
        await client.connect();


        const res = await client.request("mail/list", {
          filter: { type: "session" },
        });
        expect(res.result.conversations).toHaveLength(1);
        expect(res.result.conversations[0].type).toBe("session");
      });

      it("supports cursor pagination with limit", async () => {
        const ms = server.mailService!;
        for (let i = 0; i < 5; i++) {
          ms.createConversation({ type: "task", subject: `Task ${i}`, createdBy: "a" });
        }

        const client = createMAPClient();
        await client.connect();


        const res = await client.request("mail/list", { limit: 2 });
        expect(res.result.conversations).toHaveLength(2);
        expect(res.result.hasMore).toBe(true);
        expect(res.result.nextCursor).toBeDefined();
      });
    });

    describe("mail/get", () => {
      it("gets conversation details", async () => {
        const ms = server.mailService!;
        const { conversationId } = ms.createConversation({
          type: "session", subject: "Detail test", createdBy: "user",
        });

        const client = createMAPClient();
        await client.connect();


        const res = await client.request("mail/get", { conversationId });
        expect(res.error).toBeUndefined();
        expect(res.result.conversation.id).toBe(conversationId);
        expect(res.result.conversation.subject).toBe("Detail test");
      });

      it("includes participants when requested", async () => {
        const ms = server.mailService!;
        const { conversationId } = ms.createConversation({
          type: "task", subject: "P test", createdBy: "a",
        });
        ms.joinConversation({ conversationId, participantId: "a", role: "initiator" });
        ms.joinConversation({ conversationId, participantId: "b", role: "worker" });

        const client = createMAPClient();
        await client.connect();


        const res = await client.request("mail/get", {
          conversationId,
          include: { participants: true },
        });
        expect(res.result.participants).toBeDefined();
        expect(res.result.participants).toHaveLength(2);
      });

      it("includes recentTurns when requested", async () => {
        const ms = server.mailService!;
        const { conversationId } = ms.createConversation({
          type: "session", subject: "Turns test", createdBy: "user",
        });
        for (let i = 0; i < 5; i++) {
          ms.recordTurn({
            conversationId,
            participant: "user",
            contentType: "text",
            content: `Message ${i}`,
          });
        }

        const client = createMAPClient();
        await client.connect();


        const res = await client.request("mail/get", {
          conversationId,
          include: { recentTurns: 3 },
        });
        expect(res.result.recentTurns).toBeDefined();
        expect(res.result.recentTurns).toHaveLength(3);
      });

      it("includes stats when requested", async () => {
        const ms = server.mailService!;
        const { conversationId } = ms.createConversation({
          type: "session", subject: "Stats test", createdBy: "user",
        });
        ms.joinConversation({ conversationId, participantId: "a" });
        ms.recordTurn({ conversationId, participant: "a", contentType: "text", content: "Hello" });

        const client = createMAPClient();
        await client.connect();


        const res = await client.request("mail/get", {
          conversationId,
          include: { stats: true },
        });
        expect(res.result.stats).toBeDefined();
        expect(res.result.stats.totalTurns).toBe(1);
        expect(res.result.stats.activeParticipants).toBeGreaterThanOrEqual(1);
      });

      it("returns error for non-existent conversation", async () => {
        const client = createMAPClient();
        await client.connect();


        const res = await client.request("mail/get", { conversationId: "nonexistent" });
        expect(res.error).toBeDefined();
      });
    });

    describe("mail/turn and mail/turns/list", () => {
      it("records a turn from external MAP client", async () => {
        const ms = server.mailService!;
        const { conversationId } = ms.createConversation({
          type: "session", subject: "Turn test", createdBy: "user",
        });

        const client = createMAPClient();
        await client.connect();


        const res = await client.request("mail/turn", {
          conversationId,
          contentType: "text",
          content: "Hello from MAP client",
        });

        expect(res.error).toBeUndefined();
        expect(res.result.turn).toBeDefined();
        expect(res.result.turn.content).toBe("Hello from MAP client");

        // Verify via mailService
        const turns = ms.listTurns({ conversationId });
        expect(turns).toHaveLength(1);
      });

      it("lists turns from MessageRouter-intercepted messages", async () => {
        const ms = server.mailService!;
        const cm = server.conversationMap!;

        // Spawn parent + child in EventStore
        spawnAgent(eventStore, "parent-1");
        spawnAgent(eventStore, "child-1", "parent-1");

        // Set up subscriptions so messages can be delivered
        messageRouter.setupDefaultSubscriptions({
          agent_id: "parent-1" as AgentId,
        });
        messageRouter.setupDefaultSubscriptions({
          agent_id: "child-1" as AgentId,
          parent_id: "parent-1" as AgentId,
        });

        // Create task conversation and wire ConversationMap
        const { conversationId } = ms.createConversation({
          type: "task", subject: "Task conv", createdBy: "parent-1",
        });
        ms.joinConversation({ conversationId, participantId: "parent-1", role: "initiator" });
        ms.joinConversation({ conversationId, participantId: "child-1", role: "worker" });
        cm.setAgentConversation("child-1", conversationId);

        // Send messages via router (TurnRecorder intercepts)
        await messageRouter.sendToAddress({
          from: "parent-1" as AgentId,
          to: { agent: "child-1" as AgentId },
          content: "Do this task",
        });
        await messageRouter.sendToAddress({
          from: "child-1" as AgentId,
          to: { agent: "parent-1" as AgentId },
          content: "Done with task",
        });

        // Query via MAP protocol
        const client = createMAPClient();
        await client.connect();


        const res = await client.request("mail/turns/list", { conversationId });
        expect(res.error).toBeUndefined();
        expect(res.result.turns).toHaveLength(2);
        expect(res.result.turns[0].participant).toBe("parent-1");
        expect(res.result.turns[1].participant).toBe("child-1");
      });

      it("supports pagination", async () => {
        const ms = server.mailService!;
        const { conversationId } = ms.createConversation({
          type: "session", subject: "Paginated", createdBy: "user",
        });
        for (let i = 0; i < 10; i++) {
          ms.recordTurn({ conversationId, participant: "user", contentType: "text", content: `Msg ${i}` });
        }

        const client = createMAPClient();
        await client.connect();


        const res = await client.request("mail/turns/list", { conversationId, limit: 3 });
        expect(res.result.turns).toHaveLength(3);
        expect(res.result.hasMore).toBe(true);
      });
    });

    describe("mail/close", () => {
      it("closes a conversation via MAP protocol", async () => {
        const ms = server.mailService!;
        const { conversationId } = ms.createConversation({
          type: "session", subject: "Close test", createdBy: "user",
        });

        const client = createMAPClient();
        await client.connect();


        const res = await client.request("mail/close", { conversationId, reason: "completed" });
        expect(res.error).toBeUndefined();
        expect(res.result.conversation.status).toBe("completed");

        // Verify via mailService
        expect(ms.getConversation(conversationId)!.status).toBe("completed");
      });
    });

    describe("mail/join and mail/leave", () => {
      it("joins with catch-up history", async () => {
        const ms = server.mailService!;
        const { conversationId } = ms.createConversation({
          type: "task", subject: "Join test", createdBy: "a",
        });
        ms.recordTurn({ conversationId, participant: "a", contentType: "text", content: "Msg 1" });
        ms.recordTurn({ conversationId, participant: "a", contentType: "text", content: "Msg 2" });

        const client = createMAPClient();
        await client.connect();


        const res = await client.request("mail/join", {
          conversationId,
          catchUp: { limit: 10 },
        });
        expect(res.error).toBeUndefined();
        expect(res.result.conversation).toBeDefined();
        expect(res.result.history).toBeDefined();
        expect(res.result.history).toHaveLength(2);
      });

      it("leaves a conversation", async () => {
        const ms = server.mailService!;
        const { conversationId } = ms.createConversation({
          type: "task", subject: "Leave test", createdBy: "a",
        });

        const client = createMAPClient();
        await client.connect();


        // Join first
        await client.request("mail/join", { conversationId });

        // Leave
        const res = await client.request("mail/leave", { conversationId });
        expect(res.error).toBeUndefined();
        expect(res.result.success).toBe(true);
      });
    });

    describe("mail/replay", () => {
      it("replays turns in ascending order", async () => {
        const ms = server.mailService!;
        const { conversationId } = ms.createConversation({
          type: "session", subject: "Replay test", createdBy: "user",
        });
        ms.recordTurn({ conversationId, participant: "user", contentType: "text", content: "First" });
        ms.recordTurn({ conversationId, participant: "agent", contentType: "text", content: "Second" });
        ms.recordTurn({ conversationId, participant: "user", contentType: "text", content: "Third" });

        const client = createMAPClient();
        await client.connect();


        const res = await client.request("mail/replay", { conversationId });
        expect(res.error).toBeUndefined();
        expect(res.result.turns).toHaveLength(3);
        expect(res.result.turns[0].content).toBe("First");
        expect(res.result.turns[2].content).toBe("Third");
      });
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // REST API /api/conversations
  // ─────────────────────────────────────────────────────────────────

  describe("REST API /api/conversations", () => {
    it("lists conversations via GET /api/conversations", async () => {
      const ms = server.mailService!;
      ms.createConversation({ type: "session", subject: "S1", createdBy: "user" });
      ms.createConversation({ type: "task", subject: "T1", createdBy: "a" });

      const res = await fetch(`${baseUrl}/api/conversations`);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.conversations).toHaveLength(2);
      expect(body.total).toBe(2);
    });

    it("returns conversation detail via GET /api/conversations/:id", async () => {
      const ms = server.mailService!;
      const { conversationId } = ms.createConversation({
        type: "session", subject: "Detail", createdBy: "user",
      });

      const res = await fetch(`${baseUrl}/api/conversations/${conversationId}`);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.id).toBe(conversationId);
      expect(body.type).toBe("session");
      expect(body.status).toBe("active");
      expect(body.subject).toBe("Detail");
    });

    it("returns turns via GET /api/conversations/:id/turns", async () => {
      const ms = server.mailService!;
      const { conversationId } = ms.createConversation({
        type: "session", subject: "Turns", createdBy: "user",
      });
      ms.recordTurn({ conversationId, participant: "user", contentType: "text", content: "Hello" });
      ms.recordTurn({ conversationId, participant: "agent", contentType: "text", content: "Hi" });

      const res = await fetch(`${baseUrl}/api/conversations/${conversationId}/turns`);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.turns).toHaveLength(2);
      expect(body.total).toBe(2);
      expect(body.turns[0].participant).toBe("user");
      expect(body.turns[0].content).toBe("Hello");
    });

    it("closes via POST /api/conversations/:id/close", async () => {
      const ms = server.mailService!;
      const { conversationId } = ms.createConversation({
        type: "session", subject: "Close", createdBy: "user",
      });

      const res = await fetch(`${baseUrl}/api/conversations/${conversationId}/close`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "completed" }),
      });
      expect(res.status).toBe(200);

      // Verify closed
      expect(ms.getConversation(conversationId)!.status).toBe("completed");
    });

    it("returns participants via GET /api/conversations/:id/participants", async () => {
      const ms = server.mailService!;
      const { conversationId } = ms.createConversation({
        type: "task", subject: "Participants", createdBy: "a",
      });
      ms.joinConversation({ conversationId, participantId: "a", role: "initiator" });
      ms.joinConversation({ conversationId, participantId: "b", role: "worker" });

      const res = await fetch(`${baseUrl}/api/conversations/${conversationId}/participants`);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.participants).toHaveLength(2);
      expect(body.total).toBe(2);
    });

    it("returns 404 for non-existent conversation", async () => {
      const res = await fetch(`${baseUrl}/api/conversations/nonexistent`);
      expect(res.status).toBe(404);

      const body = await res.json();
      expect(body.code).toBe("CONVERSATION_NOT_FOUND");
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // WebSocket subscription channels
  // ─────────────────────────────────────────────────────────────────

  describe("WebSocket subscription channels", () => {
    it("receives conversation_update on 'conversations' channel", async () => {
      const ws = createAPIWSClient();
      await ws.connect();
      await ws.subscribe("conversations");
      ws.clearMessages();

      // Create conversation — triggers onConversationChange
      const ms = server.mailService!;
      ms.createConversation({ type: "session", subject: "WS test", createdBy: "user" });

      const msg = await ws.waitForMessage((m) => m.type === "conversation_update");
      expect(msg.type).toBe("conversation_update");
      // Strict: wire format is flat { type, conversation }, NOT nested in data
      expect(msg).not.toHaveProperty("data");
      expect((msg as any).conversation).toBeDefined();
      expect((msg as any).conversation.type).toBe("session");
      expect((msg as any).conversation.subject).toBe("WS test");
    });

    it("receives turn_added on 'conversation:${id}' channel", async () => {
      const ms = server.mailService!;
      const { conversationId } = ms.createConversation({
        type: "session", subject: "Turn WS", createdBy: "user",
      });

      const ws = createAPIWSClient();
      await ws.connect();
      await ws.subscribe(`conversation:${conversationId}`);
      ws.clearMessages();

      // Record turn — triggers onTurnChange
      ms.recordTurn({ conversationId, participant: "user", contentType: "text", content: "WS turn" });

      const msg = await ws.waitForMessage((m) => m.type === "turn_added");
      expect(msg.type).toBe("turn_added");
      // Strict: wire format is flat { type, conversation_id, turn }
      expect(msg).not.toHaveProperty("data");
      expect((msg as any).conversation_id).toBe(conversationId);
      expect((msg as any).turn).toBeDefined();
      expect((msg as any).turn.content).toBe("WS turn");
      expect((msg as any).turn.participant).toBe("user");
      expect((msg as any).turn.content_type).toBe("text");
    });

    it("receives turn_added from MessageRouter-intercepted turns", async () => {
      const ms = server.mailService!;
      const cm = server.conversationMap!;

      // Spawn parent + child
      spawnAgent(eventStore, "ws-parent");
      spawnAgent(eventStore, "ws-child", "ws-parent");
      messageRouter.setupDefaultSubscriptions({ agent_id: "ws-parent" as AgentId });
      messageRouter.setupDefaultSubscriptions({ agent_id: "ws-child" as AgentId, parent_id: "ws-parent" as AgentId });

      // Create task conversation
      const { conversationId } = ms.createConversation({
        type: "task", subject: "WS intercept", createdBy: "ws-parent",
      });
      ms.joinConversation({ conversationId, participantId: "ws-parent", role: "initiator" });
      ms.joinConversation({ conversationId, participantId: "ws-child", role: "worker" });
      cm.setAgentConversation("ws-child", conversationId);

      // Subscribe to conversation channel
      const ws = createAPIWSClient();
      await ws.connect();
      await ws.subscribe(`conversation:${conversationId}`);
      ws.clearMessages();

      // Send message via router — TurnRecorder intercepts
      await messageRouter.sendToAddress({
        from: "ws-parent" as AgentId,
        to: { agent: "ws-child" as AgentId },
        content: "Intercepted for WS",
      });

      const msg = await ws.waitForMessage((m) => m.type === "turn_added");
      expect(msg.type).toBe("turn_added");
      expect(msg).not.toHaveProperty("data");
      expect((msg as any).turn.participant).toBe("ws-parent");
      expect((msg as any).turn.content).toBe("Intercepted for WS");
      expect((msg as any).turn.source_type).toBe("intercepted");
    });

    it("receives conversation_update when conversation is closed", async () => {
      const ms = server.mailService!;
      const { conversationId } = ms.createConversation({
        type: "session", subject: "Close WS", createdBy: "user",
      });

      const ws = createAPIWSClient();
      await ws.connect();
      await ws.subscribe(`conversation:${conversationId}`);
      ws.clearMessages();

      ms.closeConversation({ conversationId, closedBy: "user", reason: "completed" });

      const msg = await ws.waitForMessage((m) => m.type === "conversation_update");
      expect(msg).not.toHaveProperty("data");
      expect((msg as any).conversation.status).toBe("completed");
      expect((msg as any).conversation.id).toBe(conversationId);
    });

    it("does not receive events for unsubscribed conversations", async () => {
      const ms = server.mailService!;
      const { conversationId: convA } = ms.createConversation({
        type: "session", subject: "Conv A", createdBy: "user",
      });
      const { conversationId: convB } = ms.createConversation({
        type: "session", subject: "Conv B", createdBy: "user",
      });

      const ws = createAPIWSClient();
      await ws.connect();
      await ws.subscribe(`conversation:${convA}`);
      ws.clearMessages();

      // Record turn in conv B (not subscribed)
      ms.recordTurn({ conversationId: convB, participant: "user", contentType: "text", content: "B msg" });

      // Wait briefly — no message should arrive
      await new Promise((resolve) => setTimeout(resolve, 200));

      const turnMessages = ws.getMessages().filter((m) => m.type === "turn_added");
      expect(turnMessages).toHaveLength(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Validation and error handling
  // ─────────────────────────────────────────────────────────────────

  describe("Validation and error handling", () => {
    it("mail/close on non-existent conversation returns error", async () => {
      const client = createMAPClient();
      await client.connect();

      const res = await client.request("mail/close", {
        conversationId: "nonexistent-conv",
      });
      expect(res.error).toBeDefined();
      expect(res.error!.message).toContain("not found");
    });

    it("mail/close on already-closed conversation returns error", async () => {
      const client = createMAPClient();
      await client.connect();

      const createRes = await client.request("mail/create", {
        type: "session",
        subject: "Close twice test",
      });
      const convId = createRes.result.conversation.id;

      // Close once — should succeed
      const closeRes1 = await client.request("mail/close", {
        conversationId: convId,
      });
      expect(closeRes1.error).toBeUndefined();

      // Close again — should fail
      const closeRes2 = await client.request("mail/close", {
        conversationId: convId,
      });
      expect(closeRes2.error).toBeDefined();
      expect(closeRes2.error!.message).toContain("already");
    });

    it("mail/turn on non-existent conversation returns error", async () => {
      const client = createMAPClient();
      await client.connect();

      const res = await client.request("mail/turn", {
        conversationId: "nonexistent-conv",
        contentType: "text",
        content: "should fail",
      });
      expect(res.error).toBeDefined();
      expect(res.error!.message).toContain("not found");
    });

    it("mail/join on non-existent conversation returns error", async () => {
      const client = createMAPClient();
      await client.connect();

      const res = await client.request("mail/join", {
        conversationId: "nonexistent-conv",
      });
      expect(res.error).toBeDefined();
      expect(res.error!.message).toContain("not found");
    });

    it("mail/join duplicate participant is idempotent", async () => {
      const client = createMAPClient();
      await client.connect();

      const createRes = await client.request("mail/create", {
        type: "session",
        subject: "Dup join test",
      });
      const convId = createRes.result.conversation.id;

      // Creator is auto-joined. Join again — should be idempotent.
      const joinRes = await client.request("mail/join", {
        conversationId: convId,
        role: "worker",
      });
      expect(joinRes.error).toBeUndefined();

      // Verify no duplicate participants — get the participant list
      const ms = server.mailService!;
      const participants = ms.listParticipants(convId, true);

      // Group by ID — no participant should appear more than once
      const idCounts = new Map<string, number>();
      for (const p of participants) {
        idCounts.set(p.id, (idCounts.get(p.id) ?? 0) + 1);
      }
      for (const [id, count] of idCounts) {
        expect(count, `Participant ${id} should appear only once`).toBe(1);
      }
    });

    it("mail/leave on non-existent conversation returns error", async () => {
      const client = createMAPClient();
      await client.connect();

      const res = await client.request("mail/leave", {
        conversationId: "nonexistent-conv",
      });
      expect(res.error).toBeDefined();
      expect(res.error!.message).toContain("not found");
    });

    it("mail/thread/create on non-existent conversation returns error", async () => {
      const client = createMAPClient();
      await client.connect();

      const res = await client.request("mail/thread/create", {
        conversationId: "nonexistent-conv",
        rootTurnId: "turn-1",
        subject: "Thread in void",
      });
      expect(res.error).toBeDefined();
      expect(res.error!.message).toContain("not found");
    });

    it("mail/thread/create returns thread object with nanoid-style ID", async () => {
      const client = createMAPClient();
      await client.connect();

      const createRes = await client.request("mail/create", {
        type: "session",
        subject: "Thread create test",
      });
      const convId = createRes.result.conversation.id;

      // Record a turn to use as root
      const turnRes = await client.request("mail/turn", {
        conversationId: convId,
        contentType: "text",
        content: "Root turn",
      });
      const rootTurnId = turnRes.result.turn.id;

      const threadRes = await client.request("mail/thread/create", {
        conversationId: convId,
        rootTurnId,
        subject: "Discussion thread",
      });

      expect(threadRes.error).toBeUndefined();
      expect(threadRes.result.thread).toBeDefined();
      expect(threadRes.result.thread.id).toMatch(/^thread_[A-Za-z0-9_-]+$/);
      expect(threadRes.result.thread.subject).toBe("Discussion thread");
      expect(threadRes.result.thread.conversationId).toBe(convId);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Cross-protocol consistency
  // ─────────────────────────────────────────────────────────────────

  describe("Cross-protocol consistency", () => {
    it("MAP-created conversations appear in REST API", async () => {
      const client = createMAPClient();
      await client.connect();

      // Create conversation via MAP
      const createRes = await client.request("mail/create", {
        type: "task",
        subject: "Cross-protocol test",
      });
      const convId = createRes.result.conversation.id;

      // Record turn via MAP
      await client.request("mail/turn", {
        conversationId: convId,
        contentType: "text",
        content: "MAP turn content",
      });

      // Query via REST
      const restConvRes = await fetch(`${baseUrl}/api/conversations/${convId}`);
      expect(restConvRes.status).toBe(200);
      const restConv = await restConvRes.json();
      expect(restConv.subject).toBe("Cross-protocol test");

      // Query turns via REST
      const restTurnsRes = await fetch(`${baseUrl}/api/conversations/${convId}/turns`);
      expect(restTurnsRes.status).toBe(200);
      const restTurns = await restTurnsRes.json();
      expect(restTurns.turns).toHaveLength(1);
      expect(restTurns.turns[0].content).toBe("MAP turn content");
    });
  });
});
