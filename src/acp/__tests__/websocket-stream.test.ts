/**
 * Tests for WebSocket Stream Adapter
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";
import {
  webSocketStream,
  isWebSocketOpen,
  isWebSocketConnecting,
} from "../websocket-stream.js";
import type { WebSocket } from "ws";

// Mock WebSocket class
class MockWebSocket extends EventEmitter {
  readyState: number;
  CONNECTING = 0;
  OPEN = 1;
  CLOSING = 2;
  CLOSED = 3;

  constructor(initialState: number = 1) {
    super();
    this.readyState = initialState;
  }

  send(data: string, callback?: (err?: Error) => void): void {
    if (this.readyState !== this.OPEN) {
      callback?.(new Error("WebSocket is not open"));
      return;
    }
    // Simulate async send
    setImmediate(() => callback?.());
  }

  close(code?: number, reason?: string): void {
    this.readyState = this.CLOSED;
    this.emit("close", code, reason);
  }
}

describe("webSocketStream", () => {
  let mockWs: MockWebSocket;

  beforeEach(() => {
    mockWs = new MockWebSocket();
  });

  afterEach(() => {
    mockWs.removeAllListeners();
  });

  describe("readable stream", () => {
    it("should enqueue parsed JSON messages", async () => {
      const stream = webSocketStream(mockWs as unknown as WebSocket);
      const reader = stream.readable.getReader();

      // Simulate incoming message
      const testMessage = { jsonrpc: "2.0" as const, method: "test", id: 1 };
      mockWs.emit("message", Buffer.from(JSON.stringify(testMessage)));

      const { value, done } = await reader.read();
      expect(done).toBe(false);
      expect(value).toEqual(testMessage);

      reader.releaseLock();
    });

    it("should handle multiple messages", async () => {
      const stream = webSocketStream(mockWs as unknown as WebSocket);
      const reader = stream.readable.getReader();

      const messages = [
        { jsonrpc: "2.0" as const, method: "test1", id: 1 },
        { jsonrpc: "2.0" as const, method: "test2", id: 2 },
        { jsonrpc: "2.0" as const, method: "test3", id: 3 },
      ];

      for (const msg of messages) {
        mockWs.emit("message", Buffer.from(JSON.stringify(msg)));
      }

      for (const expected of messages) {
        const { value } = await reader.read();
        expect(value).toEqual(expected);
      }

      reader.releaseLock();
    });

    it("should close stream when WebSocket closes", async () => {
      const stream = webSocketStream(mockWs as unknown as WebSocket);
      const reader = stream.readable.getReader();

      // Close the WebSocket
      mockWs.emit("close");

      const { done } = await reader.read();
      expect(done).toBe(true);

      reader.releaseLock();
    });

    it("should error stream when WebSocket errors", async () => {
      const stream = webSocketStream(mockWs as unknown as WebSocket);
      const reader = stream.readable.getReader();

      const testError = new Error("Connection failed");
      mockWs.emit("error", testError);

      await expect(reader.read()).rejects.toThrow("Connection failed");

      reader.releaseLock();
    });

    it("should handle malformed JSON gracefully", async () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const stream = webSocketStream(mockWs as unknown as WebSocket);
      const reader = stream.readable.getReader();

      // Send malformed JSON
      mockWs.emit("message", Buffer.from("not valid json{"));

      // Send valid message after
      const validMessage = { jsonrpc: "2.0" as const, method: "test", id: 1 };
      mockWs.emit("message", Buffer.from(JSON.stringify(validMessage)));

      // Should still receive the valid message
      const { value } = await reader.read();
      expect(value).toEqual(validMessage);

      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
      reader.releaseLock();
    });

    it("should handle ArrayBuffer messages", async () => {
      const stream = webSocketStream(mockWs as unknown as WebSocket);
      const reader = stream.readable.getReader();

      const testMessage = { jsonrpc: "2.0" as const, method: "test", id: 1 };
      const arrayBuffer = new TextEncoder().encode(
        JSON.stringify(testMessage)
      ).buffer;
      mockWs.emit("message", arrayBuffer);

      const { value } = await reader.read();
      expect(value).toEqual(testMessage);

      reader.releaseLock();
    });
  });

  describe("writable stream", () => {
    it("should send JSON stringified messages", async () => {
      const sendSpy = vi.spyOn(mockWs, "send");
      const stream = webSocketStream(mockWs as unknown as WebSocket);
      const writer = stream.writable.getWriter();

      const testMessage = { jsonrpc: "2.0" as const, method: "test", id: 1 };
      await writer.write(testMessage);

      expect(sendSpy).toHaveBeenCalledWith(
        JSON.stringify(testMessage),
        expect.any(Function)
      );

      writer.releaseLock();
    });

    it("should handle multiple writes", async () => {
      const sendSpy = vi.spyOn(mockWs, "send");
      const stream = webSocketStream(mockWs as unknown as WebSocket);
      const writer = stream.writable.getWriter();

      const messages = [
        { jsonrpc: "2.0" as const, result: "ok", id: 1 },
        { jsonrpc: "2.0" as const, result: "ok", id: 2 },
      ];

      for (const msg of messages) {
        await writer.write(msg);
      }

      expect(sendSpy).toHaveBeenCalledTimes(2);
      writer.releaseLock();
    });

    it("should silently drop messages when WebSocket is not open", async () => {
      mockWs.readyState = mockWs.CLOSED;
      const sendSpy = vi.spyOn(mockWs, "send");
      const stream = webSocketStream(mockWs as unknown as WebSocket);
      const writer = stream.writable.getWriter();

      const testMessage = { jsonrpc: "2.0" as const, method: "test", id: 1 };
      // Should not throw
      await writer.write(testMessage);

      expect(sendSpy).not.toHaveBeenCalled();
      writer.releaseLock();
    });

    it("should close WebSocket when stream is closed", async () => {
      const closeSpy = vi.spyOn(mockWs, "close");
      const stream = webSocketStream(mockWs as unknown as WebSocket);
      const writer = stream.writable.getWriter();

      await writer.close();

      expect(closeSpy).toHaveBeenCalledWith(1000, "Stream closed");
      writer.releaseLock();
    });

    it("should abort WebSocket with error code", async () => {
      const closeSpy = vi.spyOn(mockWs, "close");
      const stream = webSocketStream(mockWs as unknown as WebSocket);
      const writer = stream.writable.getWriter();

      await writer.abort("Test abort reason");

      expect(closeSpy).toHaveBeenCalledWith(1011, "Test abort reason");
      writer.releaseLock();
    });
  });

  describe("bidirectional communication", () => {
    it("should support simultaneous read and write", async () => {
      const stream = webSocketStream(mockWs as unknown as WebSocket);
      const reader = stream.readable.getReader();
      const writer = stream.writable.getWriter();

      // Write a message
      const outgoingMessage = {
        jsonrpc: "2.0" as const,
        method: "request",
        id: 1,
      };
      await writer.write(outgoingMessage);

      // Receive a message
      const incomingMessage = {
        jsonrpc: "2.0" as const,
        result: "ok",
        id: 1,
      };
      mockWs.emit("message", Buffer.from(JSON.stringify(incomingMessage)));

      const { value } = await reader.read();
      expect(value).toEqual(incomingMessage);

      reader.releaseLock();
      writer.releaseLock();
    });
  });
});

describe("utility functions", () => {
  describe("isWebSocketOpen", () => {
    it("should return true when WebSocket is open", () => {
      const mockWs = new MockWebSocket(1); // OPEN
      expect(isWebSocketOpen(mockWs as unknown as WebSocket)).toBe(true);
    });

    it("should return false when WebSocket is closed", () => {
      const mockWs = new MockWebSocket(3); // CLOSED
      expect(isWebSocketOpen(mockWs as unknown as WebSocket)).toBe(false);
    });
  });

  describe("isWebSocketConnecting", () => {
    it("should return true when WebSocket is connecting", () => {
      const mockWs = new MockWebSocket(0); // CONNECTING
      expect(isWebSocketConnecting(mockWs as unknown as WebSocket)).toBe(true);
    });

    it("should return false when WebSocket is open", () => {
      const mockWs = new MockWebSocket(1); // OPEN
      expect(isWebSocketConnecting(mockWs as unknown as WebSocket)).toBe(false);
    });
  });
});
