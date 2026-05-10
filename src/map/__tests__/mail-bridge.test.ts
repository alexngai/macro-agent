/**
 * Unit tests for mail-bridge — verifies that hub `mail/turn.received`
 * notifications are forwarded into the local inbox with the correct shape
 * so createAgentInboxPort.onIncoming can classify them.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { setupMailBridge, type MailBridgeConnection } from "../mail-bridge.js";

// Minimal InboxAdapter mock that captures send() calls.
function mockInboxAdapter() {
  return {
    registerAgent: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue("msg-001"),
  };
}

// Minimal MAP connection mock.
function mockConnection(): MailBridgeConnection & {
  onNotification: ReturnType<typeof vi.fn>;
  offNotification: ReturnType<typeof vi.fn>;
  _fire: (params: unknown) => Promise<void>;
} {
  let registeredHandler: ((params: unknown) => void | Promise<void>) | null =
    null;

  const conn = {
    onNotification: vi.fn((method: string, handler: (params: unknown) => void | Promise<void>) => {
      if (method === "mail/turn.received") {
        registeredHandler = handler;
      }
    }),
    offNotification: vi.fn(),
    _fire: async (params: unknown) => {
      if (registeredHandler) await registeredHandler(params);
    },
  };
  return conn;
}

describe("setupMailBridge", () => {
  let conn: ReturnType<typeof mockConnection>;
  let inbox: ReturnType<typeof mockInboxAdapter>;

  beforeEach(() => {
    conn = mockConnection();
    inbox = mockInboxAdapter();
  });

  it("registers notification handler on 'mail/turn.received'", async () => {
    await setupMailBridge({ connection: conn, inboxAdapter: inbox as any });
    expect(conn.onNotification).toHaveBeenCalledWith(
      "mail/turn.received",
      expect.any(Function),
    );
  });

  it("returns cleanup that calls offNotification", async () => {
    const cleanup = await setupMailBridge({
      connection: conn,
      inboxAdapter: inbox as any,
    });
    cleanup();
    expect(conn.offNotification).toHaveBeenCalledWith(
      "mail/turn.received",
      expect.any(Function),
    );
  });

  it("drops non-JSON turns silently", async () => {
    const logs: string[] = [];
    await setupMailBridge({
      connection: conn,
      inboxAdapter: inbox as any,
      log: (m) => logs.push(m),
    });

    await conn._fire({
      conversation_id: "conv-1",
      turn_id: "turn-1",
      participant_id: "some-agent",
      content_type: "text/plain",
      content: "hello world",
    });

    expect(inbox.send).not.toHaveBeenCalled();
    expect(logs.some((l) => l.includes("Dropping"))).toBe(true);
  });

  describe("with dispatcherAgentId", () => {
    const DISPATCHER_ID = "dispatcher:host:1234:abc";

    it("registers the dispatcher as inbox recipient", async () => {
      await setupMailBridge({
        connection: conn,
        inboxAdapter: inbox as any,
        dispatcherAgentId: DISPATCHER_ID,
      });
      expect(inbox.registerAgent).toHaveBeenCalledWith(
        DISPATCHER_ID,
        expect.objectContaining({ role: "dispatcher" }),
      );
    });

    it("translates hub envelope { type, body } → { schema, data } and delivers to dispatcher", async () => {
      await setupMailBridge({
        connection: conn,
        inboxAdapter: inbox as any,
        dispatcherAgentId: DISPATCHER_ID,
      });

      const hubEnvelope = {
        type: "x-dispatch/work",
        body: { prompt: "do the thing", taskId: "task-123", role: "worker" },
      };

      await conn._fire({
        conversation_id: "conv-1",
        turn_id: "turn-1",
        participant_id: "openhive:dispatcher",
        content_type: "application/json",
        content: JSON.stringify(hubEnvelope),
        thread_id: "thread-abc",
      });

      expect(inbox.send).toHaveBeenCalledOnce();
      const [from, to, content, opts] = inbox.send.mock.calls[0];

      // Must deliver FROM the hub participant, TO the dispatcher
      expect(from).toBe("openhive:dispatcher");
      expect(to).toBe(DISPATCHER_ID);

      // Content must carry top-level `schema` and `data`, plus `type: "data"`
      // so agent-inbox's `normalizeContent` passes it through unchanged
      // (without a `type`, the inbox wraps the payload as { type: "data",
      // data: <original> }, burying `schema` and breaking downstream
      // classifiers like swarm-dispatch's createAgentInboxPort).
      expect(content).toMatchObject({
        type: "data",
        schema: "x-dispatch/work",
        data: { prompt: "do the thing", taskId: "task-123", role: "worker" },
      });
      expect(content).not.toHaveProperty("body");

      // Thread tag preserved
      expect(opts?.threadTag).toBe("thread-abc");
    });

    it("passes through already-canonical { schema, data } payloads unchanged", async () => {
      await setupMailBridge({
        connection: conn,
        inboxAdapter: inbox as any,
        dispatcherAgentId: DISPATCHER_ID,
      });

      // Payload already in canonical shape (no 'body' key)
      const canonical = {
        schema: "x-dispatch/work",
        data: { taskId: "t-99", prompt: "go", role: "worker" },
      };

      await conn._fire({
        conversation_id: "conv-2",
        turn_id: "turn-2",
        participant_id: "openhive:dispatcher",
        content_type: "application/json",
        content: JSON.stringify(canonical),
      });

      expect(inbox.send).toHaveBeenCalledOnce();
      const [, , content] = inbox.send.mock.calls[0];
      expect(content).toMatchObject(canonical);
    });
  });

  describe("importance derivation", () => {
    const DISPATCHER_ID = "dispatcher:host:1234:abc";

    it("passes through importance from hub notification params", async () => {
      await setupMailBridge({
        connection: conn,
        inboxAdapter: inbox as any,
        dispatcherAgentId: DISPATCHER_ID,
      });

      await conn._fire({
        conversation_id: "conv-imp-1",
        turn_id: "turn-imp-1",
        participant_id: "user:admin",
        content_type: "application/json",
        content: JSON.stringify({ schema: "x-dispatch/work", data: { taskId: "t-1" } }),
        importance: "high",
      });

      expect(inbox.send).toHaveBeenCalledOnce();
      const [, , , opts] = inbox.send.mock.calls[0];
      expect(opts?.importance).toBe("high");
    });

    it("passes through 'urgent' importance for orchestrator recall", async () => {
      await setupMailBridge({
        connection: conn,
        inboxAdapter: inbox as any,
        dispatcherAgentId: DISPATCHER_ID,
      });

      await conn._fire({
        conversation_id: "conv-imp-2",
        turn_id: "turn-imp-2",
        participant_id: "system:dispatch-orchestrator",
        content_type: "application/json",
        content: JSON.stringify({ schema: "x-dispatch/work", data: { taskId: "t-2" } }),
        importance: "urgent",
      });

      expect(inbox.send).toHaveBeenCalledOnce();
      const [, , , opts] = inbox.send.mock.calls[0];
      expect(opts?.importance).toBe("urgent");
    });

    it("defaults to 'normal' when importance is missing", async () => {
      await setupMailBridge({
        connection: conn,
        inboxAdapter: inbox as any,
        dispatcherAgentId: DISPATCHER_ID,
      });

      await conn._fire({
        conversation_id: "conv-imp-3",
        turn_id: "turn-imp-3",
        participant_id: "user:admin",
        content_type: "application/json",
        content: JSON.stringify({ schema: "x-dispatch/work", data: { taskId: "t-3" } }),
        // no importance field
      });

      expect(inbox.send).toHaveBeenCalledOnce();
      const [, , , opts] = inbox.send.mock.calls[0];
      expect(opts?.importance).toBe("normal");
    });

    it("ignores invalid importance values and falls back to 'normal'", async () => {
      await setupMailBridge({
        connection: conn,
        inboxAdapter: inbox as any,
        dispatcherAgentId: DISPATCHER_ID,
      });

      await conn._fire({
        conversation_id: "conv-imp-4",
        turn_id: "turn-imp-4",
        participant_id: "user:admin",
        content_type: "application/json",
        content: JSON.stringify({ schema: "x-dispatch/work", data: { taskId: "t-4" } }),
        importance: "critical", // invalid value
      });

      expect(inbox.send).toHaveBeenCalledOnce();
      const [, , , opts] = inbox.send.mock.calls[0];
      expect(opts?.importance).toBe("normal");
    });
  });

  describe("without dispatcherAgentId (fallback mode)", () => {
    it("delivers to BRIDGE_RECIPIENT_ID", async () => {
      await setupMailBridge({
        connection: conn,
        inboxAdapter: inbox as any,
      });

      await conn._fire({
        conversation_id: "conv-3",
        turn_id: "turn-3",
        participant_id: "openhive:dispatcher",
        content_type: "application/json",
        content: JSON.stringify({ schema: "x-dispatch/work", data: { taskId: "t-1" } }),
      });

      expect(inbox.send).toHaveBeenCalledOnce();
      const [, to] = inbox.send.mock.calls[0];
      expect(to).toBe("openhive-mail-bridge");
    });
  });
});
