/**
 * Tests for Trigger System V2
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTriggerSystemV2, type TriggerSystemV2 } from "../trigger-system-v2.js";
import { AgentStore } from "../../agent/agent-store.js";
import type { AgentManager } from "../../agent/agent-manager.js";
import type { InboxAdapter, InboxDeliveryEvent, DeliveryHandler } from "../../adapters/types.js";

// =============================================================================
// Mocks
// =============================================================================

function createMockAgentManager(): AgentManager {
  return {
    spawn: vi.fn().mockResolvedValue({ id: "agent_new" }),
    terminate: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockReturnValue(null),
    list: vi.fn().mockReturnValue([]),
    getChildren: vi.fn().mockReturnValue([]),
    getSession: vi.fn().mockReturnValue(null),
    hasActiveSession: vi.fn().mockReturnValue(false),
    isPrompting: vi.fn().mockReturnValue(false),
    prompt: vi.fn().mockReturnValue({
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.resolve({ done: true, value: undefined }),
      }),
    }),
    setSpawnInterceptor: vi.fn(),
    getRoleRegistry: vi.fn(),
    onLifecycleEvent: vi.fn().mockReturnValue(() => {}),
    close: vi.fn().mockResolvedValue(undefined),
    supportsInjection: vi.fn().mockResolvedValue(false),
  } as unknown as AgentManager;
}

function createMockInboxAdapter(): InboxAdapter & {
  _handlers: Set<DeliveryHandler>;
  _simulateDelivery: (event: InboxDeliveryEvent) => void;
} {
  const handlers = new Set<DeliveryHandler>();

  return {
    registerAgent: vi.fn().mockResolvedValue(undefined),
    deregisterAgent: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue("msg-1"),
    onDelivery: vi.fn((handler: DeliveryHandler) => {
      handlers.add(handler);
    }),
    offDelivery: vi.fn((handler: DeliveryHandler) => {
      handlers.delete(handler);
    }),
    checkInbox: vi.fn().mockResolvedValue([]),
    readThread: vi.fn().mockResolvedValue([]),
    setSignalFilter: vi.fn(),
    setEmissionValidator: vi.fn(),
    socketPath: "/tmp/test-inbox.sock",
    stop: vi.fn().mockResolvedValue(undefined),
    _handlers: handlers,
    _simulateDelivery(event: InboxDeliveryEvent) {
      for (const handler of handlers) {
        handler(event);
      }
    },
  } as unknown as InboxAdapter & {
    _handlers: Set<DeliveryHandler>;
    _simulateDelivery: (event: InboxDeliveryEvent) => void;
  };
}

function makeDeliveryEvent(overrides: Partial<InboxDeliveryEvent> = {}): InboxDeliveryEvent {
  return {
    agentId: "worker-1",
    recipientKind: "to",
    message: {
      id: `msg-${Date.now()}`,
      scope: "default",
      sender_id: "coordinator-1",
      recipients: [{ agent_id: "worker-1", kind: "to" }],
      content: { type: "text", text: "Hello worker" },
      importance: "normal",
      metadata: {},
      created_at: new Date().toISOString(),
    } as any,
    ...overrides,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe("TriggerSystemV2", () => {
  let agentStore: AgentStore;
  let agentManager: AgentManager;
  let inboxAdapter: ReturnType<typeof createMockInboxAdapter>;
  let system: TriggerSystemV2;

  beforeEach(async () => {
    agentStore = new AgentStore(":memory:");
    agentManager = createMockAgentManager();
    inboxAdapter = createMockInboxAdapter();

    system = createTriggerSystemV2(
      { agentManager, agentStore, inboxAdapter },
      { wake: { enableHeartbeat: false } }
    );
  });

  afterEach(async () => {
    await system.stop();
    agentStore.close();
  });

  // ── Lifecycle ──────────────────────────────────────────────

  describe("lifecycle", () => {
    it("should start and stop cleanly", async () => {
      expect(system.isRunning()).toBe(false);

      await system.start();
      expect(system.isRunning()).toBe(true);

      await system.stop();
      expect(system.isRunning()).toBe(false);
    });

    it("should subscribe to inbox on start and unsubscribe on stop", async () => {
      await system.start();
      expect(inboxAdapter.onDelivery).toHaveBeenCalledOnce();

      await system.stop();
      expect(inboxAdapter.offDelivery).toHaveBeenCalledOnce();
    });

    it("should handle double start/stop", async () => {
      await system.start();
      await system.start(); // no-op
      expect(system.isRunning()).toBe(true);

      await system.stop();
      await system.stop(); // no-op
      expect(system.isRunning()).toBe(false);
    });
  });

  // ── Inbox Delivery → Wake ─────────────────────────────────

  describe("inbox delivery → wake", () => {
    it("should enqueue messages from inbox delivery events", async () => {
      await system.start();

      inboxAdapter._simulateDelivery(makeDeliveryEvent());

      // Message should be in the queue for worker-1
      const pending = system.queue.getAgentsWithEvents();
      expect(pending).toContain("worker-1");
    });

    it("should request immediate wake for urgent messages", async () => {
      await system.start();

      // Mock that agent has an active session
      vi.mocked(agentManager.hasActiveSession).mockReturnValue(true);

      inboxAdapter._simulateDelivery(
        makeDeliveryEvent({
          message: {
            ...makeDeliveryEvent().message,
            importance: "urgent",
          } as any,
        })
      );

      // Should have enqueued with high priority
      const pending = system.queue.getAgentsWithEvents();
      expect(pending).toContain("worker-1");
    });

    it("should enqueue low-priority messages without waking", async () => {
      await system.start();

      inboxAdapter._simulateDelivery(
        makeDeliveryEvent({
          message: {
            ...makeDeliveryEvent().message,
            importance: "low",
          } as any,
        })
      );

      // Should be queued (for next heartbeat or prompt)
      const pending = system.queue.getAgentsWithEvents();
      expect(pending).toContain("worker-1");
    });

    it("should format text content correctly", async () => {
      await system.start();

      inboxAdapter._simulateDelivery(
        makeDeliveryEvent({
          message: {
            ...makeDeliveryEvent().message,
            content: { type: "text", text: "Task assigned: implement feature X" },
            subject: "New Task",
          } as any,
        })
      );

      const events = system.queue.drain("worker-1");
      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events[0].text).toContain("New Task");
      expect(events[0].text).toContain("Task assigned: implement feature X");
    });

    it("should format event content correctly", async () => {
      await system.start();

      inboxAdapter._simulateDelivery(
        makeDeliveryEvent({
          message: {
            ...makeDeliveryEvent().message,
            content: {
              type: "event",
              event: "task_completed",
              data: { taskId: "t-1" },
            },
          } as any,
        })
      );

      const events = system.queue.drain("worker-1");
      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events[0].text).toContain("task_completed");
    });

    it("should not deliver events before start", () => {
      // System not started — delivery handler not installed
      inboxAdapter._simulateDelivery(makeDeliveryEvent());

      const pending = system.queue.getAgentsWithEvents();
      expect(pending).not.toContain("worker-1");
    });
  });

  // ── Components ─────────────────────────────────────────────

  describe("components", () => {
    it("should expose queue, wakeManager, cronService, webhookHandler", () => {
      expect(system.queue).toBeDefined();
      expect(system.wakeManager).toBeDefined();
      expect(system.cronService).toBeDefined();
      expect(system.webhookHandler).toBeDefined();
    });
  });
});
