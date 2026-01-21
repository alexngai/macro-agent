import { describe, it, expect, beforeEach, vi } from "vitest";
import { createPeerManager, type PeerManager } from "../peer-manager.js";
import type { PeerTransport, PeerMessage, PeerRequest } from "../types.js";
import { PeerError } from "../types.js";
import type { EventStore } from "../../store/event-store.js";
import type { MessageRouter } from "../../router/message-router.js";
import type { AgentId } from "../../store/types/index.js";

describe("PeerManager", () => {
  let peerManager: PeerManager;
  let mockEventStore: EventStore;
  let mockMessageRouter: MessageRouter;
  let mockTransport: PeerTransport;
  const rootAgentId = "agent-root" as AgentId;

  beforeEach(() => {
    // Create mock EventStore
    mockEventStore = {
      getAgent: vi.fn().mockReturnValue({ id: "agent-123", state: "running" }),
      emit: vi.fn(),
    } as unknown as EventStore;

    // Create mock MessageRouter
    mockMessageRouter = {} as MessageRouter;

    // Create mock transport
    mockTransport = {
      sendMessage: vi.fn().mockResolvedValue(undefined),
      sendRequest: vi.fn().mockResolvedValue({ result: "ok" }),
    };

    peerManager = createPeerManager(
      mockEventStore,
      mockMessageRouter,
      rootAgentId
    );
  });

  describe("parseAddress", () => {
    it("should parse peer-only address", () => {
      const result = peerManager.parseAddress("my-peer");
      expect(result).toEqual({ peerId: "my-peer" });
    });

    it("should parse peer/agent address", () => {
      const result = peerManager.parseAddress("my-peer/agent-123");
      expect(result).toEqual({ peerId: "my-peer", agentId: "agent-123" });
    });

    it("should handle multiple slashes in agent ID", () => {
      const result = peerManager.parseAddress("my-peer/agent/with/slashes");
      expect(result).toEqual({
        peerId: "my-peer",
        agentId: "agent/with/slashes",
      });
    });
  });

  describe("hasTransport", () => {
    it("should return false when no transport registered", () => {
      expect(peerManager.hasTransport()).toBe(false);
    });

    it("should return true after transport registration", () => {
      peerManager.registerTransport(mockTransport);
      expect(peerManager.hasTransport()).toBe(true);
    });
  });

  describe("registerTransport", () => {
    it("should return a PeerHandler", () => {
      const handler = peerManager.registerTransport(mockTransport);
      expect(handler).toHaveProperty("handleMessage");
      expect(handler).toHaveProperty("handleRequest");
    });
  });

  describe("sendMessage", () => {
    it("should throw when no transport registered", async () => {
      await expect(
        peerManager.sendMessage(
          rootAgentId,
          "other-peer",
          { type: "test", payload: {} }
        )
      ).rejects.toThrow(PeerError);
    });

    it("should send message via transport", async () => {
      peerManager.registerTransport(mockTransport);

      const message: PeerMessage = { type: "greeting", payload: { text: "hi" } };
      await peerManager.sendMessage(rootAgentId, "other-peer", message);

      expect(mockTransport.sendMessage).toHaveBeenCalledWith(
        "other-peer",
        expect.objectContaining({
          type: "greeting",
          payload: { text: "hi" },
          metadata: expect.objectContaining({
            sourceAgent: rootAgentId,
          }),
        })
      );
    });

    it("should add timestamp to message metadata", async () => {
      peerManager.registerTransport(mockTransport);

      await peerManager.sendMessage(
        rootAgentId,
        "other-peer",
        { type: "test", payload: {} }
      );

      expect(mockTransport.sendMessage).toHaveBeenCalledWith(
        "other-peer",
        expect.objectContaining({
          metadata: expect.objectContaining({
            timestamp: expect.any(Number),
          }),
        })
      );
    });
  });

  describe("sendRequest", () => {
    it("should throw when no transport registered", async () => {
      await expect(
        peerManager.sendRequest(
          rootAgentId,
          "other-peer",
          { method: "test" }
        )
      ).rejects.toThrow(PeerError);
    });

    it("should send request via transport and return response", async () => {
      mockTransport.sendRequest = vi.fn().mockResolvedValue({ result: 42 });
      peerManager.registerTransport(mockTransport);

      const response = await peerManager.sendRequest(
        rootAgentId,
        "other-peer",
        { method: "calculate", params: { x: 1, y: 2 } }
      );

      expect(mockTransport.sendRequest).toHaveBeenCalledWith(
        "other-peer",
        { method: "calculate", params: { x: 1, y: 2 } }
      );
      expect(response).toEqual({ result: 42 });
    });
  });

  describe("handleMessage (inbound)", () => {
    it("should queue message for root agent when no agent specified", () => {
      const handler = peerManager.registerTransport(mockTransport);

      handler.handleMessage("other-peer", {
        type: "notification",
        payload: { data: "test" },
      });

      const messages = peerManager.getPeerMessages(rootAgentId);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        from: "peer:other-peer",
        type: "notification",
        payload: { data: "test" },
      });
    });

    it("should queue message for specific agent when specified", () => {
      const targetAgentId = "agent-123" as AgentId;
      const handler = peerManager.registerTransport(mockTransport);

      handler.handleMessage(`other-peer/${targetAgentId}`, {
        type: "direct",
        payload: {},
      });

      const messages = peerManager.getPeerMessages(targetAgentId);
      expect(messages).toHaveLength(1);
      expect(messages[0].from).toBe(`peer:other-peer/${targetAgentId}`);
    });

    it("should include correlation ID in queued message", () => {
      const handler = peerManager.registerTransport(mockTransport);

      handler.handleMessage("other-peer", {
        type: "response",
        payload: {},
        metadata: { correlationId: "corr-123" },
      });

      const messages = peerManager.getPeerMessages(rootAgentId);
      expect(messages[0].correlationId).toBe("corr-123");
    });
  });

  describe("handleRequest (inbound)", () => {
    it("should queue request as message", async () => {
      const handler = peerManager.registerTransport(mockTransport);

      // Start request (don't await - it waits for response)
      const requestPromise = handler.handleRequest("other-peer", {
        method: "doSomething",
        params: { x: 1 },
        timeout: 5000,
      });

      // Check message is queued
      const messages = peerManager.getPeerMessages(rootAgentId);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        type: "request:doSomething",
        payload: { x: 1 },
        isRequest: true,
      });
      expect(messages[0].requestId).toBeDefined();

      // Respond to the request
      peerManager.respondToRequest(rootAgentId, messages[0].requestId!, {
        result: "done",
      });

      // Now the promise should resolve
      const response = await requestPromise;
      expect(response).toEqual({ result: "done" });
    });

    it("should timeout if no response", async () => {
      vi.useFakeTimers();
      const handler = peerManager.registerTransport(mockTransport);

      const requestPromise = handler.handleRequest("other-peer", {
        method: "slowMethod",
        timeout: 100,
      });

      vi.advanceTimersByTime(150);

      const response = await requestPromise;
      expect(response).toEqual({
        error: { code: -32000, message: "Request timeout" },
      });

      vi.useRealTimers();
    });
  });

  describe("respondToRequest", () => {
    it("should throw for unknown request ID", () => {
      peerManager.registerTransport(mockTransport);

      expect(() =>
        peerManager.respondToRequest(rootAgentId, "unknown-id", { result: "ok" })
      ).toThrow(PeerError);
    });

    it("should throw if wrong agent responds", async () => {
      const handler = peerManager.registerTransport(mockTransport);

      // Start request to root agent
      handler.handleRequest("other-peer", { method: "test" });

      const messages = peerManager.getPeerMessages(rootAgentId);
      const requestId = messages[0].requestId!;

      // Try to respond as different agent
      expect(() =>
        peerManager.respondToRequest(
          "wrong-agent" as AgentId,
          requestId,
          { result: "ok" }
        )
      ).toThrow(PeerError);
    });

    it("should allow error responses", async () => {
      const handler = peerManager.registerTransport(mockTransport);

      const requestPromise = handler.handleRequest("other-peer", {
        method: "failingMethod",
      });

      const messages = peerManager.getPeerMessages(rootAgentId);
      peerManager.respondToRequest(rootAgentId, messages[0].requestId!, {
        error: { code: 500, message: "Internal error" },
      });

      const response = await requestPromise;
      expect(response).toEqual({
        error: { code: 500, message: "Internal error" },
      });
    });
  });

  describe("getPeerMessages", () => {
    it("should return empty array when no messages", () => {
      const messages = peerManager.getPeerMessages(rootAgentId);
      expect(messages).toEqual([]);
    });

    it("should filter out acknowledged messages", () => {
      const handler = peerManager.registerTransport(mockTransport);

      handler.handleMessage("peer1", { type: "msg1", payload: {} });
      handler.handleMessage("peer2", { type: "msg2", payload: {} });

      const messages = peerManager.getPeerMessages(rootAgentId);
      expect(messages).toHaveLength(2);

      // Acknowledge first message
      peerManager.acknowledgePeerMessages(rootAgentId, [messages[0].id]);

      const remaining = peerManager.getPeerMessages(rootAgentId);
      expect(remaining).toHaveLength(1);
      expect(remaining[0].type).toBe("msg2");
    });

    it("should optionally exclude requests", () => {
      const handler = peerManager.registerTransport(mockTransport);

      handler.handleMessage("peer1", { type: "msg", payload: {} });
      handler.handleRequest("peer2", { method: "req" });

      const allMessages = peerManager.getPeerMessages(rootAgentId);
      expect(allMessages).toHaveLength(2);

      const messagesOnly = peerManager.getPeerMessages(rootAgentId, {
        includeRequests: false,
      });
      expect(messagesOnly).toHaveLength(1);
      expect(messagesOnly[0].type).toBe("msg");
    });
  });

  describe("acknowledgePeerMessages", () => {
    it("should mark messages as acknowledged", () => {
      const handler = peerManager.registerTransport(mockTransport);

      handler.handleMessage("peer", { type: "test", payload: {} });

      const before = peerManager.getPeerMessages(rootAgentId);
      expect(before).toHaveLength(1);

      peerManager.acknowledgePeerMessages(rootAgentId, [before[0].id]);

      const after = peerManager.getPeerMessages(rootAgentId);
      expect(after).toHaveLength(0);
    });
  });

  describe("persistence", () => {
    it("should emit peer_message events when persistMessages is enabled", () => {
      const peerManagerWithPersistence = createPeerManager(
        mockEventStore,
        mockMessageRouter,
        rootAgentId,
        { persistMessages: true }
      );

      const handler = peerManagerWithPersistence.registerTransport(mockTransport);

      handler.handleMessage("other-peer", {
        type: "notification",
        payload: { data: "test" },
      });

      expect(mockEventStore.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "peer_message",
          source: { peer: "peer:other-peer" },
          target: { agent_id: rootAgentId },
        })
      );
    });

    it("should not emit events when persistence is disabled", () => {
      const handler = peerManager.registerTransport(mockTransport);

      handler.handleMessage("other-peer", {
        type: "notification",
        payload: { data: "test" },
      });

      expect(mockEventStore.emit).not.toHaveBeenCalled();
    });

    it("should emit peer_request events when persistRequests is enabled", async () => {
      const peerManagerWithPersistence = createPeerManager(
        mockEventStore,
        mockMessageRouter,
        rootAgentId,
        { persistRequests: true }
      );

      const handler = peerManagerWithPersistence.registerTransport(mockTransport);

      // Start request (don't await - we just want to check emission)
      handler.handleRequest("other-peer", {
        method: "test",
        params: { x: 1 },
      });

      expect(mockEventStore.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "peer_request",
          source: { peer: "other-peer" },
          target: { agent_id: rootAgentId },
          payload: expect.objectContaining({
            method: "test",
            params: { x: 1 },
          }),
        })
      );
    });
  });

  describe("deliverMessage (ACP integration)", () => {
    it("should queue message for root agent", () => {
      // No transport needed for deliverMessage
      const messageId = peerManager.deliverMessage("other-peer", {
        type: "notification",
        payload: { data: "test" },
      });

      expect(messageId).toMatch(/^peer_/);

      const messages = peerManager.getPeerMessages(rootAgentId);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        from: "peer:other-peer",
        type: "notification",
        payload: { data: "test" },
      });
    });

    it("should queue message for specific agent", () => {
      const targetAgentId = "agent-123" as AgentId;

      const messageId = peerManager.deliverMessage(
        "other-peer",
        { type: "direct", payload: {} },
        targetAgentId
      );

      expect(messageId).toMatch(/^peer_/);

      const messages = peerManager.getPeerMessages(targetAgentId);
      expect(messages).toHaveLength(1);
      expect(messages[0].from).toBe("peer:other-peer");
    });

    it("should include correlation ID in queued message", () => {
      peerManager.deliverMessage("other-peer", {
        type: "response",
        payload: {},
        metadata: { correlationId: "corr-456" },
      });

      const messages = peerManager.getPeerMessages(rootAgentId);
      expect(messages[0].correlationId).toBe("corr-456");
    });
  });

  describe("deliverRequest (ACP integration)", () => {
    it("should queue request and resolve when responded to", async () => {
      // Start request delivery
      const responsePromise = peerManager.deliverRequest("other-peer", {
        method: "calculate",
        params: { x: 1, y: 2 },
      });

      // Check request is queued
      const messages = peerManager.getPeerMessages(rootAgentId);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        type: "request:calculate",
        payload: { x: 1, y: 2 },
        isRequest: true,
      });
      expect(messages[0].requestId).toBeDefined();

      // Respond to the request
      peerManager.respondToRequest(rootAgentId, messages[0].requestId!, {
        result: 3,
      });

      // Promise should resolve
      const response = await responsePromise;
      expect(response).toEqual({ result: 3 });
    });

    it("should timeout if no response", async () => {
      vi.useFakeTimers();

      const responsePromise = peerManager.deliverRequest("other-peer", {
        method: "slowMethod",
        timeout: 100,
      });

      vi.advanceTimersByTime(150);

      const response = await responsePromise;
      expect(response).toEqual({
        error: { code: -32000, message: "Request timeout" },
      });

      vi.useRealTimers();
    });

    it("should deliver to specific agent", async () => {
      const targetAgentId = "agent-123" as AgentId;

      const responsePromise = peerManager.deliverRequest(
        "other-peer",
        { method: "test" },
        targetAgentId
      );

      const messages = peerManager.getPeerMessages(targetAgentId);
      expect(messages).toHaveLength(1);

      peerManager.respondToRequest(targetAgentId, messages[0].requestId!, {
        result: "ok",
      });

      const response = await responsePromise;
      expect(response).toEqual({ result: "ok" });
    });
  });
});
