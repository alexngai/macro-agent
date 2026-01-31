/**
 * Routing Strategies Tests
 *
 * Tests for individual routing strategy implementations.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createDirectStrategy,
  createHeadStrategy,
  createRoleStrategy,
  createBroadcastStrategy,
  createTaskStrategy,
} from "../router/strategies/index.js";
import type { TriggerEvent } from "../types.js";
import type { RoutingContext } from "../router/types.js";
import type { AgentId } from "../../store/types/index.js";

describe("Routing Strategies", () => {
  let mockContext: RoutingContext;

  beforeEach(() => {
    mockContext = createMockContext();
  });

  describe("DirectStrategy", () => {
    it("should route to specified agent", async () => {
      const strategy = createDirectStrategy();
      const event = createMockEvent({
        routing: { target: { type: "agent", agentId: "agent_123" as AgentId } },
      });

      // Mock agent exists
      mockContext.agentManager.get = vi.fn().mockReturnValue({
        id: "agent_123",
        state: "running",
      });

      const decision = await strategy.route(event, mockContext);

      expect(decision.targetAgents).toEqual(["agent_123"]);
      expect(decision.defer).toBeFalsy();
    });

    it("should defer if agent not found", async () => {
      const strategy = createDirectStrategy();
      const event = createMockEvent({
        routing: { target: { type: "agent", agentId: "nonexistent" as AgentId } },
      });

      mockContext.agentManager.get = vi.fn().mockReturnValue(null);

      const decision = await strategy.route(event, mockContext);

      expect(decision.targetAgents).toEqual([]);
      expect(decision.defer).toBe(true);
      expect(decision.deferReason).toContain("not found");
    });

    it("should handle spawn if configured", async () => {
      const strategy = createDirectStrategy({ allowSpawn: true });
      const event = createMockEvent({
        routing: {
          target: { type: "agent", agentId: "nonexistent" as AgentId },
          spawnIfNotFound: true,
          spawnConfig: { task: "Handle this trigger", role: "worker" },
        },
      });

      mockContext.agentManager.get = vi.fn().mockReturnValue(null);

      const decision = await strategy.route(event, mockContext);

      expect(decision.spawnNew).toBeDefined();
      expect(decision.spawnNew?.task).toBe("Handle this trigger");
      expect(decision.spawnNew?.role).toBe("worker");
    });

    it("should report canHandle correctly", () => {
      const strategy = createDirectStrategy();

      expect(
        strategy.canHandle?.(
          createMockEvent({
            routing: { target: { type: "agent", agentId: "x" as AgentId } },
          })
        )
      ).toBe(true);

      expect(
        strategy.canHandle?.(
          createMockEvent({
            routing: { target: { type: "role", role: "worker" } },
          })
        )
      ).toBe(false);
    });
  });

  describe("HeadStrategy", () => {
    it("should route to head manager (root agent)", async () => {
      const strategy = createHeadStrategy();
      const event = createMockEvent({
        routing: { target: { type: "head" } },
      });

      mockContext.agentManager.list = vi.fn().mockReturnValue([
        { id: "agent_root", parent: null, state: "running" },
        { id: "agent_child", parent: "agent_root", state: "running" },
      ]);

      const decision = await strategy.route(event, mockContext);

      expect(decision.targetAgents).toEqual(["agent_root"]);
    });

    it("should defer if no head manager", async () => {
      const strategy = createHeadStrategy();
      const event = createMockEvent({});

      mockContext.agentManager.list = vi.fn().mockReturnValue([]);

      const decision = await strategy.route(event, mockContext);

      expect(decision.defer).toBe(true);
      expect(decision.deferReason).toContain("No head manager");
    });

    it("should handle events with no explicit target", () => {
      const strategy = createHeadStrategy();

      expect(strategy.canHandle?.(createMockEvent({}))).toBe(true);
      expect(
        strategy.canHandle?.(createMockEvent({ routing: { target: { type: "head" } } }))
      ).toBe(true);
    });
  });

  describe("RoleStrategy", () => {
    it("should route to agents with matching role", async () => {
      const strategy = createRoleStrategy();
      const event = createMockEvent({
        routing: { target: { type: "role", role: "monitor" } },
      });

      mockContext.agentManager.list = vi.fn().mockReturnValue([
        { id: "agent_1", state: "running", config: { role: "monitor" } },
        { id: "agent_2", state: "running", config: { role: "worker" } },
        { id: "agent_3", state: "running", config: { role: "monitor" } },
      ]);

      const decision = await strategy.route(event, mockContext);

      // Default mode is "first" so should return first match
      expect(decision.targetAgents).toHaveLength(1);
      expect(decision.targetAgents[0]).toBe("agent_1");
    });

    it("should route to all agents with role in broadcast mode", async () => {
      const strategy = createRoleStrategy({ mode: "all" });
      const event = createMockEvent({
        routing: { target: { type: "role", role: "monitor" } },
      });

      mockContext.agentManager.list = vi.fn().mockReturnValue([
        { id: "agent_1", state: "running", config: { role: "monitor" } },
        { id: "agent_2", state: "running", config: { role: "worker" } },
        { id: "agent_3", state: "stopped", config: { role: "monitor" } },
      ]);

      const decision = await strategy.route(event, mockContext);

      expect(decision.targetAgents).toHaveLength(2);
      expect(decision.targetAgents).toContain("agent_1");
      expect(decision.targetAgents).toContain("agent_3");
    });

    it("should prefer running agents when configured", async () => {
      const strategy = createRoleStrategy({ preferRunning: true });
      const event = createMockEvent({
        routing: { target: { type: "role", role: "monitor" } },
      });

      mockContext.agentManager.list = vi.fn().mockReturnValue([
        { id: "agent_stopped", state: "stopped", config: { role: "monitor" }, created_at: 1000 },
        { id: "agent_running", state: "running", config: { role: "monitor" }, created_at: 2000 },
      ]);

      const decision = await strategy.route(event, mockContext);

      expect(decision.targetAgents[0]).toBe("agent_running");
    });

    it("should defer if no agents with role", async () => {
      const strategy = createRoleStrategy();
      const event = createMockEvent({
        routing: { target: { type: "role", role: "nonexistent" } },
      });

      mockContext.agentManager.list = vi.fn().mockReturnValue([
        { id: "agent_1", state: "running", config: { role: "worker" } },
      ]);

      const decision = await strategy.route(event, mockContext);

      expect(decision.defer).toBe(true);
    });

    it("should match role from task description as fallback", async () => {
      const strategy = createRoleStrategy();
      const event = createMockEvent({
        routing: { target: { type: "role", role: "monitor" } },
      });

      mockContext.agentManager.list = vi.fn().mockReturnValue([
        { id: "agent_1", state: "running", config: {}, task: "Act as a monitor for the system" },
      ]);

      const decision = await strategy.route(event, mockContext);

      expect(decision.targetAgents).toContain("agent_1");
    });
  });

  describe("BroadcastStrategy", () => {
    it("should broadcast to running agents on channel", async () => {
      const strategy = createBroadcastStrategy();
      const event = createMockEvent({
        routing: { target: { type: "broadcast", channel: "alerts" } },
      });

      mockContext.agentManager.list = vi.fn().mockReturnValue([
        { id: "agent_1", state: "running", config: { role: "alerts" } },
        { id: "agent_2", state: "stopped", config: { role: "alerts" } },
        { id: "agent_3", state: "running", config: { channels: ["alerts", "logs"] } },
      ]);

      const decision = await strategy.route(event, mockContext);

      expect(decision.targetAgents).toHaveLength(2);
      expect(decision.targetAgents).toContain("agent_1");
      expect(decision.targetAgents).toContain("agent_3");
    });

    it("should return empty if no subscribers", async () => {
      const strategy = createBroadcastStrategy();
      const event = createMockEvent({
        routing: { target: { type: "broadcast", channel: "empty-channel" } },
      });

      mockContext.agentManager.list = vi.fn().mockReturnValue([
        { id: "agent_1", state: "running", config: { role: "worker" } },
      ]);

      const decision = await strategy.route(event, mockContext);

      expect(decision.targetAgents).toHaveLength(0);
    });
  });

  describe("TaskStrategy", () => {
    it("should route to agent assigned to task", async () => {
      const strategy = createTaskStrategy();
      const event = createMockEvent({
        routing: { target: { type: "task", taskId: "task_123" } },
      });

      mockContext.agentManager.list = vi.fn().mockReturnValue([
        { id: "agent_1", state: "running", task_id: "task_456" },
        { id: "agent_2", state: "running", task_id: "task_123" },
      ]);

      const decision = await strategy.route(event, mockContext);

      expect(decision.targetAgents).toEqual(["agent_2"]);
    });

    it("should defer if no agent assigned to task", async () => {
      const strategy = createTaskStrategy();
      const event = createMockEvent({
        routing: { target: { type: "task", taskId: "task_unknown" } },
      });

      mockContext.agentManager.list = vi.fn().mockReturnValue([
        { id: "agent_1", state: "running", task_id: "task_123" },
      ]);

      const decision = await strategy.route(event, mockContext);

      expect(decision.defer).toBe(true);
      expect(decision.deferReason).toContain("No agent assigned");
    });
  });
});

// =============================================================================
// Test Helpers
// =============================================================================

function createMockContext(): RoutingContext {
  return {
    eventStore: {
      getAllTasks: vi.fn().mockReturnValue([]),
    } as any,
    agentManager: {
      list: vi.fn().mockReturnValue([]),
      get: vi.fn().mockReturnValue(null),
      getSession: vi.fn().mockReturnValue(null),
      prompt: vi.fn(),
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
    id: "trigger_test",
    source: { type: "system", eventType: "test" },
    payload: { kind: "text", content: "Test payload" },
    wakeMode: "now",
    timestamp: Date.now(),
    ...overrides,
  };
}
