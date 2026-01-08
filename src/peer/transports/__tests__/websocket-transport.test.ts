import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  WebSocketPeerTransport,
  createWebSocketTransport,
} from "../websocket-transport.js";
import type { PeerHandler } from "../../types.js";

describe("WebSocketPeerTransport", () => {
  let transport1: WebSocketPeerTransport;
  let transport2: WebSocketPeerTransport;

  // Use different ports for each test to avoid conflicts
  let port1: number;
  let port2: number;

  beforeEach(() => {
    // Random ports in ephemeral range to avoid conflicts
    port1 = 40000 + Math.floor(Math.random() * 10000);
    port2 = port1 + 1;
  });

  afterEach(async () => {
    if (transport1) {
      await transport1.stop();
    }
    if (transport2) {
      await transport2.stop();
    }
  });

  describe("createWebSocketTransport", () => {
    it("should create a WebSocketPeerTransport instance", () => {
      transport1 = createWebSocketTransport({
        peerId: "peer-1",
        port: port1,
      });

      expect(transport1).toBeInstanceOf(WebSocketPeerTransport);
    });
  });

  describe("start and stop", () => {
    it("should start server on specified port", async () => {
      transport1 = createWebSocketTransport({
        peerId: "peer-1",
        port: port1,
      });

      const mockHandler: PeerHandler = {
        handleMessage: vi.fn(),
        handleRequest: vi.fn().mockResolvedValue({ result: "ok" }),
      };

      await transport1.start(mockHandler);

      // Server should be listening - stop will confirm it was running
      await transport1.stop();
    });
  });

  describe("peer registry", () => {
    it("should register and unregister peers", async () => {
      transport1 = createWebSocketTransport({
        peerId: "peer-1",
        port: port1,
      });

      const mockHandler: PeerHandler = {
        handleMessage: vi.fn(),
        handleRequest: vi.fn().mockResolvedValue({ result: "ok" }),
      };

      await transport1.start(mockHandler);

      // Register peer
      transport1.registerPeer("peer-2", `ws://localhost:${port2}`);

      // Unregister peer
      transport1.unregisterPeer("peer-2");
    });

    it("should throw when sending to unknown peer", async () => {
      transport1 = createWebSocketTransport({
        peerId: "peer-1",
        port: port1,
      });

      const mockHandler: PeerHandler = {
        handleMessage: vi.fn(),
        handleRequest: vi.fn().mockResolvedValue({ result: "ok" }),
      };

      await transport1.start(mockHandler);

      await expect(
        transport1.sendMessage("unknown-peer", {
          type: "test",
          payload: {},
        })
      ).rejects.toThrow("Unknown peer");
    });
  });

  describe("peer-to-peer communication", () => {
    it("should send and receive messages between two peers", async () => {
      transport1 = createWebSocketTransport({
        peerId: "peer-1",
        port: port1,
        peerRegistry: [{ peerId: "peer-2", url: `ws://localhost:${port2}` }],
      });

      transport2 = createWebSocketTransport({
        peerId: "peer-2",
        port: port2,
        peerRegistry: [{ peerId: "peer-1", url: `ws://localhost:${port1}` }],
      });

      const handler1: PeerHandler = {
        handleMessage: vi.fn(),
        handleRequest: vi.fn().mockResolvedValue({ result: "ok" }),
      };

      const handler2: PeerHandler = {
        handleMessage: vi.fn(),
        handleRequest: vi.fn().mockResolvedValue({ result: "ok" }),
      };

      await transport1.start(handler1);
      await transport2.start(handler2);

      // Send message from peer-1 to peer-2
      await transport1.sendMessage("peer-2", {
        type: "greeting",
        payload: { text: "Hello from peer-1" },
      });

      // Wait for message delivery
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(handler2.handleMessage).toHaveBeenCalledWith(
        "peer-1",
        expect.objectContaining({
          type: "greeting",
          payload: { text: "Hello from peer-1" },
        })
      );
    });

    it("should handle request-response between two peers", async () => {
      transport1 = createWebSocketTransport({
        peerId: "peer-1",
        port: port1,
        peerRegistry: [{ peerId: "peer-2", url: `ws://localhost:${port2}` }],
      });

      transport2 = createWebSocketTransport({
        peerId: "peer-2",
        port: port2,
        peerRegistry: [{ peerId: "peer-1", url: `ws://localhost:${port1}` }],
      });

      const handler1: PeerHandler = {
        handleMessage: vi.fn(),
        handleRequest: vi.fn().mockResolvedValue({ result: "ok" }),
      };

      const handler2: PeerHandler = {
        handleMessage: vi.fn(),
        handleRequest: vi.fn().mockResolvedValue({ result: 42 }),
      };

      await transport1.start(handler1);
      await transport2.start(handler2);

      // Send request from peer-1 to peer-2
      const response = await transport1.sendRequest("peer-2", {
        method: "calculate",
        params: { x: 1, y: 2 },
      });

      expect(response).toEqual({ result: 42 });
      expect(handler2.handleRequest).toHaveBeenCalledWith(
        "peer-1",
        expect.objectContaining({
          method: "calculate",
          params: { x: 1, y: 2 },
        })
      );
    });

    it("should handle request timeout", async () => {
      transport1 = createWebSocketTransport({
        peerId: "peer-1",
        port: port1,
        peerRegistry: [{ peerId: "peer-2", url: `ws://localhost:${port2}` }],
        requestTimeout: 100,
      });

      transport2 = createWebSocketTransport({
        peerId: "peer-2",
        port: port2,
      });

      const handler1: PeerHandler = {
        handleMessage: vi.fn(),
        handleRequest: vi.fn().mockResolvedValue({ result: "ok" }),
      };

      const handler2: PeerHandler = {
        handleMessage: vi.fn(),
        // Simulate slow handler that never responds
        handleRequest: vi.fn().mockImplementation(
          () => new Promise(() => {}) // Never resolves
        ),
      };

      await transport1.start(handler1);
      await transport2.start(handler2);

      // Send request with short timeout
      const response = await transport1.sendRequest("peer-2", {
        method: "slowMethod",
        timeout: 50,
      });

      expect(response).toEqual({
        error: { code: -32000, message: "Request timeout" },
      });
    });

    it("should handle bidirectional communication", async () => {
      transport1 = createWebSocketTransport({
        peerId: "peer-1",
        port: port1,
        peerRegistry: [{ peerId: "peer-2", url: `ws://localhost:${port2}` }],
      });

      transport2 = createWebSocketTransport({
        peerId: "peer-2",
        port: port2,
        peerRegistry: [{ peerId: "peer-1", url: `ws://localhost:${port1}` }],
      });

      const handler1: PeerHandler = {
        handleMessage: vi.fn(),
        handleRequest: vi.fn().mockResolvedValue({ result: "from-peer-1" }),
      };

      const handler2: PeerHandler = {
        handleMessage: vi.fn(),
        handleRequest: vi.fn().mockResolvedValue({ result: "from-peer-2" }),
      };

      await transport1.start(handler1);
      await transport2.start(handler2);

      // Request from peer-1 to peer-2
      const response1 = await transport1.sendRequest("peer-2", {
        method: "test",
      });
      expect(response1).toEqual({ result: "from-peer-2" });

      // Request from peer-2 to peer-1
      const response2 = await transport2.sendRequest("peer-1", {
        method: "test",
      });
      expect(response2).toEqual({ result: "from-peer-1" });
    });
  });
});
