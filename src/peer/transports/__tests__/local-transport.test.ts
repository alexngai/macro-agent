import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { LocalPeerTransport, createLocalTransport } from "../local-transport.js";
import type { PeerHandler, PeerMessage, PeerRequest, PeerResponse } from "../../types.js";

describe("LocalPeerTransport", () => {
  const testSocketDir = "/tmp/macro-agent-test-peers";
  let transport1: LocalPeerTransport;
  let transport2: LocalPeerTransport;

  beforeEach(() => {
    // Ensure clean test directory
    if (fs.existsSync(testSocketDir)) {
      const files = fs.readdirSync(testSocketDir);
      for (const file of files) {
        fs.unlinkSync(path.join(testSocketDir, file));
      }
    }
  });

  afterEach(async () => {
    // Stop transports
    if (transport1) {
      await transport1.stop();
    }
    if (transport2) {
      await transport2.stop();
    }

    // Clean up test directory
    if (fs.existsSync(testSocketDir)) {
      const files = fs.readdirSync(testSocketDir);
      for (const file of files) {
        try {
          fs.unlinkSync(path.join(testSocketDir, file));
        } catch {
          // Ignore cleanup errors
        }
      }
    }
  });

  describe("createLocalTransport", () => {
    it("should create a LocalPeerTransport instance", () => {
      transport1 = createLocalTransport({
        peerId: "peer-1",
        socketDir: testSocketDir,
      });

      expect(transport1).toBeInstanceOf(LocalPeerTransport);
    });
  });

  describe("start and stop", () => {
    it("should start and create socket file", async () => {
      transport1 = createLocalTransport({
        peerId: "peer-1",
        socketDir: testSocketDir,
      });

      const mockHandler: PeerHandler = {
        handleMessage: vi.fn(),
        handleRequest: vi.fn().mockResolvedValue({ result: "ok" }),
      };

      await transport1.start(mockHandler);

      // Check socket file exists
      const socketPath = path.join(testSocketDir, "peer-1.sock");
      expect(fs.existsSync(socketPath)).toBe(true);
    });

    it("should stop and clean up socket file", async () => {
      transport1 = createLocalTransport({
        peerId: "peer-1",
        socketDir: testSocketDir,
      });

      const mockHandler: PeerHandler = {
        handleMessage: vi.fn(),
        handleRequest: vi.fn().mockResolvedValue({ result: "ok" }),
      };

      await transport1.start(mockHandler);
      await transport1.stop();

      const socketPath = path.join(testSocketDir, "peer-1.sock");
      expect(fs.existsSync(socketPath)).toBe(false);
    });

    it("should remove stale socket file on start", async () => {
      const socketPath = path.join(testSocketDir, "peer-1.sock");

      // Create stale socket file
      if (!fs.existsSync(testSocketDir)) {
        fs.mkdirSync(testSocketDir, { recursive: true });
      }
      fs.writeFileSync(socketPath, "stale");

      transport1 = createLocalTransport({
        peerId: "peer-1",
        socketDir: testSocketDir,
      });

      const mockHandler: PeerHandler = {
        handleMessage: vi.fn(),
        handleRequest: vi.fn().mockResolvedValue({ result: "ok" }),
      };

      await transport1.start(mockHandler);

      // Should have replaced the stale file with actual socket
      expect(fs.existsSync(socketPath)).toBe(true);
    });
  });

  describe("peer-to-peer communication", () => {
    it("should send and receive messages between two peers", async () => {
      const receivedMessages: PeerMessage[] = [];

      transport1 = createLocalTransport({
        peerId: "peer-1",
        socketDir: testSocketDir,
      });

      transport2 = createLocalTransport({
        peerId: "peer-2",
        socketDir: testSocketDir,
      });

      const handler1: PeerHandler = {
        handleMessage: vi.fn((from, message) => {
          receivedMessages.push(message);
        }),
        handleRequest: vi.fn().mockResolvedValue({ result: "ok" }),
      };

      const handler2: PeerHandler = {
        handleMessage: vi.fn(),
        handleRequest: vi.fn().mockResolvedValue({ result: "ok" }),
      };

      await transport1.start(handler1);
      await transport2.start(handler2);

      // Send message from peer-2 to peer-1
      await transport2.sendMessage("peer-1", {
        type: "greeting",
        payload: { text: "Hello from peer-2" },
      });

      // Wait for message delivery
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(handler1.handleMessage).toHaveBeenCalledWith(
        "peer-2",
        expect.objectContaining({
          type: "greeting",
          payload: { text: "Hello from peer-2" },
        })
      );
    });

    it("should handle request-response between two peers", async () => {
      transport1 = createLocalTransport({
        peerId: "peer-1",
        socketDir: testSocketDir,
      });

      transport2 = createLocalTransport({
        peerId: "peer-2",
        socketDir: testSocketDir,
      });

      const handler1: PeerHandler = {
        handleMessage: vi.fn(),
        handleRequest: vi.fn().mockResolvedValue({ result: 42 }),
      };

      const handler2: PeerHandler = {
        handleMessage: vi.fn(),
        handleRequest: vi.fn().mockResolvedValue({ result: "ok" }),
      };

      await transport1.start(handler1);
      await transport2.start(handler2);

      // Send request from peer-2 to peer-1
      const response = await transport2.sendRequest("peer-1", {
        method: "calculate",
        params: { x: 1, y: 2 },
      });

      expect(response).toEqual({ result: 42 });
      expect(handler1.handleRequest).toHaveBeenCalledWith(
        "peer-2",
        expect.objectContaining({
          method: "calculate",
          params: { x: 1, y: 2 },
        })
      );
    });

    it("should handle request timeout", async () => {
      transport1 = createLocalTransport({
        peerId: "peer-1",
        socketDir: testSocketDir,
        requestTimeout: 100, // Short timeout for test
      });

      transport2 = createLocalTransport({
        peerId: "peer-2",
        socketDir: testSocketDir,
      });

      const handler1: PeerHandler = {
        handleMessage: vi.fn(),
        // Simulate slow handler that never responds
        handleRequest: vi.fn().mockImplementation(
          () => new Promise(() => {}) // Never resolves
        ),
      };

      const handler2: PeerHandler = {
        handleMessage: vi.fn(),
        handleRequest: vi.fn().mockResolvedValue({ result: "ok" }),
      };

      await transport1.start(handler1);
      await transport2.start(handler2);

      // Send request with short timeout
      const response = await transport2.sendRequest("peer-1", {
        method: "slowMethod",
        timeout: 50,
      });

      expect(response).toEqual({
        error: { code: -32000, message: "Request timeout" },
      });
    });

    it("should handle bidirectional communication", async () => {
      transport1 = createLocalTransport({
        peerId: "peer-1",
        socketDir: testSocketDir,
      });

      transport2 = createLocalTransport({
        peerId: "peer-2",
        socketDir: testSocketDir,
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
      const response1 = await transport1.sendRequest("peer-2", { method: "test" });
      expect(response1).toEqual({ result: "from-peer-2" });

      // Request from peer-2 to peer-1
      const response2 = await transport2.sendRequest("peer-1", { method: "test" });
      expect(response2).toEqual({ result: "from-peer-1" });
    });

    it("should handle address with agent ID", async () => {
      transport1 = createLocalTransport({
        peerId: "peer-1",
        socketDir: testSocketDir,
      });

      transport2 = createLocalTransport({
        peerId: "peer-2",
        socketDir: testSocketDir,
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

      // Send message with agent ID in address
      await transport2.sendMessage("peer-1/agent-123", {
        type: "direct",
        payload: { forAgent: "agent-123" },
      });

      // Wait for message delivery
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(handler1.handleMessage).toHaveBeenCalledWith(
        "peer-2",
        expect.objectContaining({
          type: "direct",
        })
      );
    });
  });

  describe("connection management", () => {
    it("should reuse existing connection", async () => {
      transport1 = createLocalTransport({
        peerId: "peer-1",
        socketDir: testSocketDir,
      });

      transport2 = createLocalTransport({
        peerId: "peer-2",
        socketDir: testSocketDir,
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

      // Send multiple messages - should reuse connection
      await transport2.sendMessage("peer-1", { type: "msg1", payload: {} });
      await transport2.sendMessage("peer-1", { type: "msg2", payload: {} });
      await transport2.sendMessage("peer-1", { type: "msg3", payload: {} });

      // Wait for messages
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(handler1.handleMessage).toHaveBeenCalledTimes(3);
    });
  });
});
