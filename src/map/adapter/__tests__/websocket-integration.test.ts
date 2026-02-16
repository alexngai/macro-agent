/**
 * Tests for MAP WebSocket Integration
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  createMAPWebSocketHandler,
  setupMAPWebSocket,
  type MAPWebSocketHandler,
} from "../websocket-integration.js";
import { createMAPAdapter, type MAPAdapterServices } from "../map-adapter.js";
import type { MAPAdapter } from "../interface.js";

/**
 * Mock WebSocket implementation for testing
 */
function createMockWebSocket() {
  const handlers = new Map<string, ((...args: unknown[]) => void)[]>();
  let readyState = 1; // OPEN

  const ws = {
    get OPEN() {
      return 1;
    },
    get readyState() {
      return readyState;
    },
    set readyState(value: number) {
      readyState = value;
    },
    on(event: string, handler: (...args: unknown[]) => void) {
      if (!handlers.has(event)) {
        handlers.set(event, []);
      }
      handlers.get(event)!.push(handler);
      return ws;
    },
    emit(event: string, ...args: unknown[]) {
      const eventHandlers = handlers.get(event) ?? [];
      for (const handler of eventHandlers) {
        handler(...args);
      }
    },
    close: vi.fn((code?: number, reason?: string) => {
      readyState = 3; // CLOSED
      ws.emit("close", code ?? 1000, Buffer.from(reason ?? ""));
    }),
    send: vi.fn((data: string, callback?: (err?: Error) => void) => {
      if (callback) callback();
    }),
  };

  return ws;
}

describe("createMAPWebSocketHandler", () => {
  let adapter: MAPAdapter;
  let handler: MAPWebSocketHandler;
  let services: MAPAdapterServices;

  beforeEach(async () => {
    services = {
      getAgent: vi.fn(),
      listAgents: vi.fn().mockReturnValue([]),
      sendMessage: vi.fn().mockResolvedValue({ delivered: [] }),
      getAncestors: vi.fn().mockReturnValue([]),
      getDescendants: vi.fn().mockReturnValue([]),
    };

    adapter = createMAPAdapter(
      {
        name: "test-adapter",
        version: "1.0.0",
      },
      services
    );

    await adapter.start();
    handler = createMAPWebSocketHandler(adapter);
  });

  afterEach(async () => {
    handler.closeAll();
    if (adapter.isRunning()) {
      await adapter.stop();
    }
  });

  describe("handleConnection", () => {
    it("accepts WebSocket connection and tracks it", async () => {
      const ws = createMockWebSocket();
      const req = { socket: { remoteAddress: "127.0.0.1" } };

      expect(handler.getConnectionCount()).toBe(0);

      await handler.handleConnection(ws as any, req);

      expect(handler.getConnectionCount()).toBe(1);
    });

    it("returns participant for connection", async () => {
      const ws = createMockWebSocket();
      const req = { socket: { remoteAddress: "127.0.0.1" } };

      await handler.handleConnection(ws as any, req);

      const participant = handler.getParticipant(ws as any);
      expect(participant).toBeDefined();
      expect(participant?.id).toMatch(/^p-/);
    });

    it("handles multiple connections", async () => {
      const ws1 = createMockWebSocket();
      const ws2 = createMockWebSocket();
      const req = { socket: { remoteAddress: "127.0.0.1" } };

      await handler.handleConnection(ws1 as any, req);
      await handler.handleConnection(ws2 as any, req);

      expect(handler.getConnectionCount()).toBe(2);
    });

    it("handles connection close", async () => {
      const ws = createMockWebSocket();
      const req = { socket: { remoteAddress: "127.0.0.1" } };

      await handler.handleConnection(ws as any, req);
      expect(handler.getConnectionCount()).toBe(1);

      // Simulate connection close
      ws.emit("close", 1000, Buffer.from("normal closure"));

      expect(handler.getConnectionCount()).toBe(0);
    });

    it("handles connection error", async () => {
      const ws = createMockWebSocket();
      const req = { socket: { remoteAddress: "127.0.0.1" } };

      await handler.handleConnection(ws as any, req);
      expect(handler.getConnectionCount()).toBe(1);

      // Simulate connection error
      ws.emit("error", new Error("Connection failed"));

      expect(handler.getConnectionCount()).toBe(0);
    });

    it("rejects connection when adapter not running", async () => {
      await adapter.stop();

      const ws = createMockWebSocket();
      const req = { socket: { remoteAddress: "127.0.0.1" } };

      await handler.handleConnection(ws as any, req);

      // Connection should be closed due to error
      expect(ws.close).toHaveBeenCalledWith(1011, "Connection setup failed");
    });
  });

  describe("closeAll", () => {
    it("closes all connections", async () => {
      const ws1 = createMockWebSocket();
      const ws2 = createMockWebSocket();
      const req = { socket: { remoteAddress: "127.0.0.1" } };

      await handler.handleConnection(ws1 as any, req);
      await handler.handleConnection(ws2 as any, req);

      expect(handler.getConnectionCount()).toBe(2);

      handler.closeAll();

      expect(ws1.close).toHaveBeenCalled();
      expect(ws2.close).toHaveBeenCalled();
      expect(handler.getConnectionCount()).toBe(0);
    });

    it("skips already closed connections", async () => {
      const ws = createMockWebSocket();
      const req = { socket: { remoteAddress: "127.0.0.1" } };

      await handler.handleConnection(ws as any, req);

      // Close the WebSocket manually
      ws.readyState = 3; // CLOSED

      // Should not throw
      handler.closeAll();

      expect(ws.close).not.toHaveBeenCalled();
    });
  });

  describe("getParticipant", () => {
    it("returns undefined for unknown WebSocket", () => {
      const ws = createMockWebSocket();

      expect(handler.getParticipant(ws as any)).toBeUndefined();
    });
  });
});

describe("setupMAPWebSocket", () => {
  let adapter: MAPAdapter;
  let services: MAPAdapterServices;

  beforeEach(async () => {
    services = {
      getAgent: vi.fn(),
      listAgents: vi.fn().mockReturnValue([]),
      sendMessage: vi.fn().mockResolvedValue({ delivered: [] }),
      getAncestors: vi.fn().mockReturnValue([]),
      getDescendants: vi.fn().mockReturnValue([]),
    };

    adapter = createMAPAdapter(
      {
        name: "test-adapter",
        version: "1.0.0",
      },
      services
    );

    await adapter.start();
  });

  afterEach(async () => {
    if (adapter.isRunning()) {
      await adapter.stop();
    }
  });

  it("creates handler and path matcher", () => {
    const setup = setupMAPWebSocket({ adapter });

    expect(setup.handler).toBeDefined();
    expect(setup.matchesPath).toBeDefined();
  });

  describe("matchesPath", () => {
    it("matches default /map path", () => {
      const setup = setupMAPWebSocket({ adapter });

      expect(setup.matchesPath("/map")).toBe(true);
      expect(setup.matchesPath("/map?foo=bar")).toBe(true);
      expect(setup.matchesPath("/map/")).toBe(true);
    });

    it("matches custom path", () => {
      const setup = setupMAPWebSocket({ adapter, path: "/custom" });

      expect(setup.matchesPath("/custom")).toBe(true);
      expect(setup.matchesPath("/custom?foo=bar")).toBe(true);
      expect(setup.matchesPath("/map")).toBe(false);
    });

    it("does not match other paths", () => {
      const setup = setupMAPWebSocket({ adapter });

      expect(setup.matchesPath("/acp")).toBe(false);
      expect(setup.matchesPath("/")).toBe(false);
      expect(setup.matchesPath("/maps")).toBe(false);
      expect(setup.matchesPath("")).toBe(false);
      expect(setup.matchesPath(undefined)).toBe(false);
    });
  });
});

// =============================================================================
// WebSocket Event Broadcast (full RPC flow)
// =============================================================================

describe("WebSocket event broadcast", () => {
  let adapter: MAPAdapter;
  let handler: MAPWebSocketHandler;
  let services: MAPAdapterServices;

  beforeEach(async () => {
    services = {
      getAgent: vi.fn(),
      listAgents: vi.fn().mockReturnValue([]),
      sendMessage: vi.fn().mockResolvedValue({ delivered: [] }),
      getAncestors: vi.fn().mockReturnValue([]),
      getDescendants: vi.fn().mockReturnValue([]),
    };

    adapter = createMAPAdapter(
      { name: "test-broadcast", version: "1.0.0" },
      services,
    );

    await adapter.start();
    handler = createMAPWebSocketHandler(adapter);
  });

  afterEach(async () => {
    handler.closeAll();
    if (adapter.isRunning()) {
      await adapter.stop();
    }
  });

  async function flushAsync(ms = 50): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  it("delivers event notifications via WebSocket after subscription", async () => {
    const wsA = createMockWebSocket();
    await handler.handleConnection(wsA as any, {
      socket: { remoteAddress: "127.0.0.1" },
    });

    const participantA = handler.getParticipant(wsA as any);
    expect(participantA).toBeDefined();

    await adapter.createSubscription(participantA!.id, {
      eventTypes: [
        "message_sent" as any,
        "message_delivered" as any,
        "agent_registered" as any,
      ],
    });

    (wsA.send as ReturnType<typeof vi.fn>).mockClear();

    const { ulid } = await import("ulid");
    adapter.emitEvent({
      eventId: ulid(),
      type: "message_delivered" as any,
      timestamp: Date.now(),
      agentId: "agent-1" as any,
      data: {
        from: "agent-1",
        to: "p-client-b",
        message: {
          id: `acp-notif-${Date.now()}`,
          from: "agent-1",
          payload: {
            acp: {
              jsonrpc: "2.0",
              method: "session/update",
              params: { update: { text: "hello from agent" } },
            },
            acpContext: {
              streamId: "stream-123",
              sessionId: "session-456",
              direction: "agent-to-client",
            },
          },
        },
      },
    });

    await flushAsync();

    expect(wsA.send).toHaveBeenCalled();
    const notificationData = JSON.parse(
      (wsA.send as ReturnType<typeof vi.fn>).mock.calls[0][0] as string,
    );
    expect(notificationData.jsonrpc).toBe("2.0");
    expect(notificationData.method).toBe("map/event");
    expect(notificationData.params.event.type).toBe("message_delivered");
    expect(notificationData.params.event.data.from).toBe("agent-1");
    expect(
      notificationData.params.event.data.message.payload.acp.method,
    ).toBe("session/update");
  });

  it("two WebSocket clients both receive events when subscribed", async () => {
    const wsA = createMockWebSocket();
    const wsB = createMockWebSocket();
    const req = { socket: { remoteAddress: "127.0.0.1" } };

    await handler.handleConnection(wsA as any, req);
    await handler.handleConnection(wsB as any, req);

    const pA = handler.getParticipant(wsA as any)!;
    const pB = handler.getParticipant(wsB as any)!;

    await adapter.createSubscription(pA.id, {
      eventTypes: ["message_delivered" as any],
    });
    await adapter.createSubscription(pB.id, {
      eventTypes: ["message_delivered" as any],
    });

    (wsA.send as ReturnType<typeof vi.fn>).mockClear();
    (wsB.send as ReturnType<typeof vi.fn>).mockClear();

    const { ulid } = await import("ulid");
    adapter.emitEvent({
      eventId: ulid(),
      type: "message_delivered" as any,
      timestamp: Date.now(),
      agentId: "agent-1" as any,
      data: { from: "agent-1", to: "some-client", message: {} },
    });

    await flushAsync();

    expect(wsA.send).toHaveBeenCalled();
    expect(wsB.send).toHaveBeenCalled();
  });

  it("RPC subscribe + event delivery full flow", async () => {
    const wsA = createMockWebSocket();
    await handler.handleConnection(wsA as any, {
      socket: { remoteAddress: "127.0.0.1" },
    });

    // Simulate Client A sending map/subscribe RPC through WebSocket
    wsA.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "map/subscribe",
          params: {
            filter: {
              eventTypes: [
                "agent_registered",
                "message_sent",
                "message_delivered",
                "agent_state_changed",
              ],
            },
          },
        }),
      ),
    );

    // Wait for RPC processing
    await flushAsync(100);

    // Verify subscribe response
    const sendCalls = (wsA.send as ReturnType<typeof vi.fn>).mock.calls;
    expect(sendCalls.length).toBeGreaterThan(0);
    const subscribeResponse = JSON.parse(sendCalls[0][0] as string);
    expect(subscribeResponse.id).toBe(1);
    expect(subscribeResponse.result.subscriptionId).toMatch(/^sub-/);

    (wsA.send as ReturnType<typeof vi.fn>).mockClear();

    // Emit an event
    const { ulid } = await import("ulid");
    adapter.emitEvent({
      eventId: ulid(),
      type: "message_delivered" as any,
      timestamp: Date.now(),
      agentId: "agent-1" as any,
      data: {
        from: "agent-1",
        to: "p-other-client",
        message: {
          id: "test-msg-1",
          from: "agent-1",
          payload: {
            acp: { jsonrpc: "2.0", method: "session/update", params: {} },
            acpContext: {
              streamId: "stream-abc",
              sessionId: "sess-xyz",
              direction: "agent-to-client",
            },
          },
        },
      },
    });

    await flushAsync();

    // Verify notification was delivered via WebSocket
    expect(wsA.send).toHaveBeenCalled();
    const notification = JSON.parse(
      (wsA.send as ReturnType<typeof vi.fn>).mock.calls[0][0] as string,
    );
    expect(notification.jsonrpc).toBe("2.0");
    expect(notification.method).toBe("map/event");
    expect(notification.params.subscriptionId).toBe(
      subscribeResponse.result.subscriptionId,
    );
    expect(notification.params.event.type).toBe("message_delivered");
    expect(notification.params.event.data.from).toBe("agent-1");
  });
});
