/**
 * Tests for Federation — cross-instance communication via agent-inbox.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createRemoteSpawnHandler,
  setupFederation,
} from "../federation.js";
import type { InboxAdapter, InboxDeliveryEvent } from "../types.js";
import type { AgentManager } from "../../agent/agent-manager.js";

// =============================================================================
// Mocks
// =============================================================================

function createMockAgentManager(): AgentManager {
  return {
    spawn: vi.fn().mockResolvedValue({
      id: "agent_spawned",
      agent: { name: "remote-worker", role: "worker" },
    }),
    terminate: vi.fn(),
    get: vi.fn(),
    list: vi.fn().mockReturnValue([]),
    getChildren: vi.fn().mockReturnValue([]),
    getHierarchy: vi.fn(),
    getSession: vi.fn(),
    hasActiveSession: vi.fn(),
    prompt: vi.fn(),
    setSpawnInterceptor: vi.fn(),
    getRoleRegistry: vi.fn(),
    onLifecycleEvent: vi.fn().mockReturnValue(() => {}),
    close: vi.fn(),
  } as unknown as AgentManager;
}

function createMockInboxAdapter(): InboxAdapter {
  const handlers: Array<(e: InboxDeliveryEvent) => void> = [];
  return {
    registerAgent: vi.fn().mockResolvedValue(undefined),
    deregisterAgent: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue("msg-1"),
    onDelivery: vi.fn((handler) => handlers.push(handler)),
    offDelivery: vi.fn((handler) => {
      const idx = handlers.indexOf(handler);
      if (idx >= 0) handlers.splice(idx, 1);
    }),
    checkInbox: vi.fn().mockResolvedValue([]),
    readThread: vi.fn().mockResolvedValue([]),
    setSignalFilter: vi.fn(),
    setEmissionValidator: vi.fn(),
    addSignalFilter: vi.fn(),
    removeSignalFilter: vi.fn(),
    addEmissionValidator: vi.fn(),
    removeEmissionValidator: vi.fn(),
    socketPath: "/tmp/test.sock",
    stop: vi.fn().mockResolvedValue(undefined),
    _handlers: handlers,
  } as unknown as InboxAdapter & { _handlers: Array<(e: InboxDeliveryEvent) => void> };
}

function makeSpawnRequestEvent(
  systemId: string,
  data: Record<string, unknown>
): InboxDeliveryEvent {
  return {
    agentId: `system@${systemId}`,
    recipientKind: "to",
    message: {
      id: "msg-1",
      scope: "default",
      sender_id: "coordinator@remote",
      recipients: [],
      content: {
        type: "event",
        event: "remote_spawn_request",
        data,
      },
      importance: "high",
      metadata: {},
      created_at: new Date().toISOString(),
    } as any,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe("Federation", () => {
  let agentManager: AgentManager;
  let inboxAdapter: ReturnType<typeof createMockInboxAdapter>;

  beforeEach(() => {
    agentManager = createMockAgentManager();
    inboxAdapter = createMockInboxAdapter();
  });

  describe("createRemoteSpawnHandler", () => {
    it("should spawn agent on remote_spawn_request", async () => {
      const handler = createRemoteSpawnHandler(
        agentManager,
        inboxAdapter,
        "local-instance"
      );

      await handler(
        makeSpawnRequestEvent("local-instance", {
          task: "Run tests",
          role: "worker",
          requestedBy: "coordinator@remote",
        })
      );

      expect(agentManager.spawn).toHaveBeenCalledWith(
        expect.objectContaining({
          task: "Run tests",
          role: "worker",
        })
      );
    });

    it("should send confirmation back to requester", async () => {
      const handler = createRemoteSpawnHandler(
        agentManager,
        inboxAdapter,
        "local-instance"
      );

      await handler(
        makeSpawnRequestEvent("local-instance", {
          task: "Run tests",
          role: "worker",
          requestedBy: "coordinator@remote",
        })
      );

      expect(inboxAdapter.send).toHaveBeenCalledWith(
        "system@local-instance",
        "coordinator@remote",
        expect.objectContaining({
          type: "event",
          event: "remote_spawn_response",
          data: expect.objectContaining({
            success: true,
            agentId: "agent_spawned",
          }),
        }),
        expect.any(Object)
      );
    });

    it("should send error response on spawn failure", async () => {
      vi.mocked(agentManager.spawn).mockRejectedValueOnce(
        new Error("Capability denied")
      );

      const handler = createRemoteSpawnHandler(
        agentManager,
        inboxAdapter,
        "local-instance"
      );

      await handler(
        makeSpawnRequestEvent("local-instance", {
          task: "Bad spawn",
          requestedBy: "coordinator@remote",
        })
      );

      expect(inboxAdapter.send).toHaveBeenCalledWith(
        "system@local-instance",
        "coordinator@remote",
        expect.objectContaining({
          data: expect.objectContaining({
            success: false,
            error: "Capability denied",
          }),
        }),
        expect.any(Object)
      );
    });

    it("should ignore non-spawn events", async () => {
      const handler = createRemoteSpawnHandler(
        agentManager,
        inboxAdapter,
        "local-instance"
      );

      await handler({
        agentId: "system@local-instance",
        recipientKind: "to",
        message: {
          content: { type: "text", text: "hello" },
        } as any,
      } as InboxDeliveryEvent);

      expect(agentManager.spawn).not.toHaveBeenCalled();
    });

    it("should ignore events to wrong system", async () => {
      const handler = createRemoteSpawnHandler(
        agentManager,
        inboxAdapter,
        "local-instance"
      );

      await handler(
        makeSpawnRequestEvent("other-instance", {
          task: "Run tests",
          requestedBy: "coordinator@remote",
        })
      );

      expect(agentManager.spawn).not.toHaveBeenCalled();
    });
  });

  describe("setupFederation", () => {
    it("should register delivery handler", () => {
      setupFederation(agentManager, inboxAdapter, {
        systemId: "my-instance",
      });

      expect(inboxAdapter.onDelivery).toHaveBeenCalledWith(
        expect.any(Function)
      );
    });

    it("should register system agent in inbox", () => {
      setupFederation(agentManager, inboxAdapter, {
        systemId: "my-instance",
      });

      expect(inboxAdapter.registerAgent).toHaveBeenCalledWith(
        "system@my-instance",
        expect.objectContaining({
          name: "System",
          role: "system",
        })
      );
    });

    it("should return cleanup function that removes handler", () => {
      const cleanup = setupFederation(agentManager, inboxAdapter, {
        systemId: "my-instance",
      });

      cleanup();

      expect(inboxAdapter.offDelivery).toHaveBeenCalled();
    });
  });
});
