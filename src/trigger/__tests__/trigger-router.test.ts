/**
 * Trigger Router Tests
 *
 * Tests for the main trigger routing functionality.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTriggerRouter } from "../router/trigger-router.js";
import type { TriggerEvent } from "../types.js";
import type { RoutingStrategy, RoutingContext, RoutingDecision } from "../router/types.js";
import type { AgentId } from "../../store/types/index.js";

describe("TriggerRouter", () => {
  let mockDeps: ReturnType<typeof createMockDeps>;
  let router: ReturnType<typeof createTriggerRouter>;

  beforeEach(() => {
    mockDeps = createMockDeps();
    router = createTriggerRouter(mockDeps);
  });

  afterEach(async () => {
    await router.stop();
  });

  describe("lifecycle", () => {
    it("should register built-in strategies on start", async () => {
      await router.start();

      const strategies = router.listStrategies();
      expect(strategies).toContain("head");
      expect(strategies).toContain("direct");
      expect(strategies).toContain("role");
      expect(strategies).toContain("broadcast");
      expect(strategies).toContain("task");
    });

    it("should return error when routing before start", async () => {
      const event = createMockEvent({});

      const result = await router.route(event);

      expect(result.success).toBe(false);
      expect(result.error).toContain("not started");
    });

    it("should allow routing after start", async () => {
      await router.start();

      // Mock agent manager to return a head agent
      mockDeps.agentManager.list = vi.fn().mockReturnValue([
        { id: "agent_head", parent: null, state: "running" },
      ]);

      const event = createMockEvent({});
      const result = await router.route(event);

      expect(result.success).toBe(true);
    });
  });

  describe("strategy registration", () => {
    it("should register custom strategies", async () => {
      const customStrategy: RoutingStrategy = {
        name: "custom",
        route: vi.fn().mockResolvedValue({
          targetAgents: ["agent_1" as AgentId],
        }),
      };

      router.registerStrategy(customStrategy);

      expect(router.listStrategies()).toContain("custom");
      expect(router.getStrategy("custom")).toBe(customStrategy);
    });

    it("should unregister strategies", async () => {
      const customStrategy: RoutingStrategy = {
        name: "custom",
        route: vi.fn().mockResolvedValue({ targetAgents: [] }),
      };

      router.registerStrategy(customStrategy);
      expect(router.getStrategy("custom")).toBeDefined();

      router.unregisterStrategy("custom");
      expect(router.getStrategy("custom")).toBeUndefined();
    });

    it("should set and get default strategy", async () => {
      await router.start();

      expect(router.getDefaultStrategy()).toBe("head");

      router.setDefaultStrategy("direct");
      expect(router.getDefaultStrategy()).toBe("direct");
    });

    it("should throw when setting non-existent default strategy", async () => {
      expect(() => router.setDefaultStrategy("nonexistent")).toThrow(
        "Strategy not found"
      );
    });
  });

  describe("strategy selection", () => {
    it("should use explicit strategy from routing hints", async () => {
      await router.start();

      const customStrategy: RoutingStrategy = {
        name: "custom",
        route: vi.fn().mockResolvedValue({
          targetAgents: ["agent_custom" as AgentId],
        }),
      };
      router.registerStrategy(customStrategy);

      const event = createMockEvent({
        routing: { strategyName: "custom" },
      });

      mockDeps.agentManager.get = vi.fn().mockReturnValue({ state: "running" });
      mockDeps.agentManager.getSession = vi.fn().mockReturnValue(null);

      await router.route(event);

      expect(customStrategy.route).toHaveBeenCalled();
    });

    it("should select strategy based on target type", async () => {
      await router.start();

      mockDeps.agentManager.list = vi.fn().mockReturnValue([
        { id: "agent_1", state: "running", config: { role: "worker" } },
      ]);
      mockDeps.agentManager.get = vi.fn().mockReturnValue({ state: "running" });
      mockDeps.agentManager.getSession = vi.fn().mockReturnValue(null);

      const event = createMockEvent({
        routing: { target: { type: "role", role: "worker" } },
      });

      const result = await router.route(event);

      expect(result.success).toBe(true);
      expect(result.deliveredTo).toContain("agent_1");
    });

    it("should fall back to default strategy when no match", async () => {
      await router.start();

      mockDeps.agentManager.list = vi.fn().mockReturnValue([
        { id: "agent_head", parent: null, state: "running" },
      ]);
      mockDeps.agentManager.get = vi.fn().mockReturnValue({ state: "running" });
      mockDeps.agentManager.getSession = vi.fn().mockReturnValue(null);

      const event = createMockEvent({});

      const result = await router.route(event);

      // Should use head strategy by default
      expect(result.metadata?.strategy).toBe("head");
    });
  });

  describe("delivery methods", () => {
    it("should queue events with next-prompt wake mode", async () => {
      await router.start();

      mockDeps.agentManager.list = vi.fn().mockReturnValue([
        { id: "agent_head", parent: null, state: "running" },
      ]);

      const event = createMockEvent({
        wakeMode: "next-prompt",
      });

      await router.route(event);

      expect(mockDeps.systemEventQueue.enqueue).toHaveBeenCalled();
    });

    it("should try inject for active session with inject support", async () => {
      await router.start();

      mockDeps.agentManager.list = vi.fn().mockReturnValue([
        { id: "agent_head", parent: null, state: "running" },
      ]);

      const mockSession = {
        supportsInject: vi.fn().mockReturnValue(true),
        inject: vi.fn().mockResolvedValue({ success: true }),
      };
      mockDeps.agentManager.getSession = vi.fn().mockReturnValue(mockSession);

      const event = createMockEvent({
        wakeMode: "now",
      });

      const result = await router.route(event);

      expect(result.success).toBe(true);
      expect(result.method).toBe("inject");
      expect(mockSession.inject).toHaveBeenCalled();
    });

    it("should fall back to interrupt if inject fails", async () => {
      await router.start();

      mockDeps.agentManager.list = vi.fn().mockReturnValue([
        { id: "agent_head", parent: null, state: "running" },
      ]);

      const mockIterator = {
        next: vi.fn().mockResolvedValue({ done: false }),
        [Symbol.asyncIterator]: function () {
          return this;
        },
      };

      const mockSession = {
        supportsInject: vi.fn().mockReturnValue(true),
        inject: vi.fn().mockResolvedValue({ success: false }),
        interruptWith: vi.fn().mockReturnValue(mockIterator),
      };
      mockDeps.agentManager.getSession = vi.fn().mockReturnValue(mockSession);

      const event = createMockEvent({
        wakeMode: "now",
      });

      const result = await router.route(event);

      expect(result.success).toBe(true);
      expect(result.method).toBe("interrupt");
    });

    it("should fall back to wake prompt if no session", async () => {
      await router.start();

      mockDeps.agentManager.list = vi.fn().mockReturnValue([
        { id: "agent_head", parent: null, state: "running" },
      ]);
      mockDeps.agentManager.get = vi.fn().mockReturnValue({ state: "running" });
      mockDeps.agentManager.getSession = vi.fn().mockReturnValue(null);

      const mockPromptIterator = {
        next: vi.fn().mockResolvedValue({ done: true }),
        [Symbol.asyncIterator]: function () {
          return this;
        },
      };
      mockDeps.agentManager.prompt = vi.fn().mockReturnValue(mockPromptIterator);

      const event = createMockEvent({
        wakeMode: "now",
      });

      const result = await router.route(event);

      expect(result.success).toBe(true);
      expect(result.method).toBe("wake");
    });
  });

  describe("defer handling", () => {
    it("should handle defer response from strategy", async () => {
      await router.start();

      const deferStrategy: RoutingStrategy = {
        name: "defer-test",
        route: vi.fn().mockResolvedValue({
          targetAgents: [],
          defer: true,
          deferReason: "Agent busy",
        }),
        canHandle: () => true,
      };
      router.registerStrategy(deferStrategy);
      router.setDefaultStrategy("defer-test");

      const event = createMockEvent({});

      const result = await router.route(event);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Agent busy");
    });

    it("should try fallback target when defer", async () => {
      await router.start();

      // First call defers, fallback should route to head
      let callCount = 0;
      const smartStrategy: RoutingStrategy = {
        name: "smart",
        route: vi.fn().mockImplementation(() => {
          callCount++;
          if (callCount === 1) {
            return Promise.resolve({
              targetAgents: [],
              defer: true,
              deferReason: "Primary agent unavailable",
            });
          }
          return Promise.resolve({
            targetAgents: ["fallback_agent" as AgentId],
          });
        }),
        canHandle: () => true,
      };
      router.registerStrategy(smartStrategy);
      router.setDefaultStrategy("smart");

      mockDeps.agentManager.get = vi.fn().mockReturnValue({ state: "running" });
      mockDeps.agentManager.getSession = vi.fn().mockReturnValue(null);

      const event = createMockEvent({
        routing: {
          target: { type: "agent", agentId: "primary" as AgentId },
          fallbackTarget: { type: "agent", agentId: "fallback" as AgentId },
        },
      });

      const result = await router.route(event);

      expect(result.success).toBe(true);
    });
  });

  describe("broadcast delivery", () => {
    it("should deliver to multiple agents", async () => {
      await router.start();

      mockDeps.agentManager.list = vi.fn().mockReturnValue([
        { id: "agent_1", state: "running", config: { channels: ["alerts"] } },
        { id: "agent_2", state: "running", config: { channels: ["alerts"] } },
      ]);
      mockDeps.agentManager.get = vi.fn().mockReturnValue({ state: "running" });
      mockDeps.agentManager.getSession = vi.fn().mockReturnValue(null);

      const event = createMockEvent({
        routing: { target: { type: "broadcast", channel: "alerts" } },
      });

      const result = await router.route(event);

      expect(result.success).toBe(true);
      expect(result.deliveredTo.length).toBe(2);
      expect(result.method).toBe("broadcast");
    });
  });

  describe("error handling", () => {
    it("should handle strategy errors gracefully", async () => {
      await router.start();

      const errorStrategy: RoutingStrategy = {
        name: "error-test",
        route: vi.fn().mockRejectedValue(new Error("Strategy error")),
        canHandle: () => true,
      };
      router.registerStrategy(errorStrategy);
      router.setDefaultStrategy("error-test");

      const event = createMockEvent({});

      const result = await router.route(event);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Strategy error");
    });

    it("should return error when no targets found", async () => {
      await router.start();

      const emptyStrategy: RoutingStrategy = {
        name: "empty",
        route: vi.fn().mockResolvedValue({ targetAgents: [] }),
        canHandle: () => true,
      };
      router.registerStrategy(emptyStrategy);
      router.setDefaultStrategy("empty");

      const event = createMockEvent({});

      const result = await router.route(event);

      expect(result.success).toBe(false);
      expect(result.error).toContain("No target agents");
    });
  });
});

// =============================================================================
// Test Helpers
// =============================================================================

function createMockDeps() {
  return {
    eventStore: {
      getAllTasks: vi.fn().mockReturnValue([]),
    } as any,
    agentManager: {
      list: vi.fn().mockReturnValue([]),
      get: vi.fn().mockReturnValue(null),
      getSession: vi.fn().mockReturnValue(null),
      prompt: vi.fn().mockReturnValue({
        [Symbol.asyncIterator]: () => ({
          next: vi.fn().mockResolvedValue({ done: true }),
        }),
      }),
    } as any,
    messageRouter: {} as any,
    systemEventQueue: {
      enqueue: vi.fn(),
      drain: vi.fn().mockReturnValue([]),
      hasEvents: vi.fn().mockReturnValue(false),
    } as any,
  };
}

function createMockEvent(overrides: Partial<TriggerEvent> = {}): TriggerEvent {
  return {
    id: `trigger_${Date.now()}`,
    source: { type: "system", eventType: "test" },
    payload: { kind: "text", content: "Test payload" },
    wakeMode: "now",
    timestamp: Date.now(),
    ...overrides,
  };
}
