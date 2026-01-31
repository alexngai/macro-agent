/**
 * Trigger System Integration Tests
 *
 * End-to-end tests that verify the complete trigger system
 * working together: queue -> router -> strategies -> wake manager.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTriggerSystem, type TriggerSystemDeps } from "../trigger-system.js";
import { createTriggerEvent, type TriggerEvent } from "../types.js";
import type { RoutingStrategy, RoutingDecision } from "../router/types.js";
import type { AgentId } from "../../store/types/index.js";

describe("TriggerSystem Integration", () => {
  let mockDeps: TriggerSystemDeps;
  let triggerSystem: ReturnType<typeof createTriggerSystem>;

  beforeEach(() => {
    vi.useFakeTimers();
    mockDeps = createMockDeps();
  });

  afterEach(async () => {
    if (triggerSystem?.isRunning()) {
      await triggerSystem.stop();
    }
    vi.useRealTimers();
  });

  describe("system lifecycle", () => {
    it("should create and start the trigger system", async () => {
      triggerSystem = createTriggerSystem(mockDeps);

      expect(triggerSystem.isRunning()).toBe(false);

      await triggerSystem.start();

      expect(triggerSystem.isRunning()).toBe(true);
      expect(triggerSystem.queue).toBeDefined();
      expect(triggerSystem.router).toBeDefined();
      expect(triggerSystem.wakeManager).toBeDefined();
      expect(triggerSystem.cronService).toBeDefined();
      expect(triggerSystem.webhookHandler).toBeDefined();
    });

    it("should stop all components", async () => {
      triggerSystem = createTriggerSystem(mockDeps);
      await triggerSystem.start();

      await triggerSystem.stop();

      expect(triggerSystem.isRunning()).toBe(false);
    });

    it("should be idempotent for start/stop", async () => {
      triggerSystem = createTriggerSystem(mockDeps);

      await triggerSystem.start();
      await triggerSystem.start();
      expect(triggerSystem.isRunning()).toBe(true);

      await triggerSystem.stop();
      await triggerSystem.stop();
      expect(triggerSystem.isRunning()).toBe(false);
    });
  });

  describe("end-to-end trigger flow", () => {
    it("should route trigger event to head agent", async () => {
      // Setup: head agent exists
      mockDeps.agentManager.list = vi.fn().mockReturnValue([
        { id: "agent_head", parent: null, state: "running" },
      ]);
      mockDeps.agentManager.get = vi.fn().mockReturnValue({ state: "running" });
      mockDeps.agentManager.getSession = vi.fn().mockReturnValue(null);

      triggerSystem = createTriggerSystem(mockDeps);
      await triggerSystem.start();

      const event = createTriggerEvent({
        source: { type: "system", eventType: "test" },
        payload: { kind: "text", content: "Test message" },
        wakeMode: "now",
      });

      const result = await triggerSystem.router.route(event);

      expect(result.success).toBe(true);
      expect(result.deliveredTo).toContain("agent_head");
    });

    it("should route to specific agent with direct strategy", async () => {
      const targetAgentId = "agent_target" as AgentId;

      mockDeps.agentManager.get = vi.fn().mockReturnValue({
        id: targetAgentId,
        state: "running",
      });
      mockDeps.agentManager.getSession = vi.fn().mockReturnValue(null);

      triggerSystem = createTriggerSystem(mockDeps);
      await triggerSystem.start();

      const event = createTriggerEvent({
        source: { type: "webhook", endpointId: "ep1", method: "POST", path: "/test" },
        payload: { kind: "text", content: "Direct message" },
        wakeMode: "now",
        routing: {
          target: { type: "agent", agentId: targetAgentId },
        },
      });

      const result = await triggerSystem.router.route(event);

      expect(result.success).toBe(true);
      expect(result.deliveredTo).toContain(targetAgentId);
      expect(result.metadata?.strategy).toBe("direct");
    });

    it("should route to agents by role", async () => {
      mockDeps.agentManager.list = vi.fn().mockReturnValue([
        { id: "agent_worker1", state: "running", config: { role: "worker" } },
        { id: "agent_worker2", state: "running", config: { role: "worker" } },
        { id: "agent_monitor", state: "running", config: { role: "monitor" } },
      ]);
      mockDeps.agentManager.get = vi.fn().mockReturnValue({ state: "running" });
      mockDeps.agentManager.getSession = vi.fn().mockReturnValue(null);

      triggerSystem = createTriggerSystem(mockDeps);
      await triggerSystem.start();

      const event = createTriggerEvent({
        source: { type: "internal", component: "scheduler" },
        payload: { kind: "text", content: "Worker task" },
        wakeMode: "now",
        routing: {
          target: { type: "role", role: "worker" },
        },
      });

      const result = await triggerSystem.router.route(event);

      expect(result.success).toBe(true);
      expect(result.deliveredTo.length).toBeGreaterThanOrEqual(1);
      expect(result.metadata?.strategy).toBe("role");
    });

    it("should broadcast to all subscribers on channel", async () => {
      mockDeps.agentManager.list = vi.fn().mockReturnValue([
        { id: "agent_1", state: "running", config: { channels: ["alerts"] } },
        { id: "agent_2", state: "running", config: { channels: ["alerts", "logs"] } },
        { id: "agent_3", state: "running", config: { channels: ["logs"] } },
      ]);
      mockDeps.agentManager.get = vi.fn().mockReturnValue({ state: "running" });
      mockDeps.agentManager.getSession = vi.fn().mockReturnValue(null);

      triggerSystem = createTriggerSystem(mockDeps);
      await triggerSystem.start();

      const event = createTriggerEvent({
        source: { type: "system", eventType: "alert" },
        payload: { kind: "text", content: "Alert broadcast" },
        wakeMode: "now",
        routing: {
          target: { type: "broadcast", channel: "alerts" },
        },
      });

      const result = await triggerSystem.router.route(event);

      expect(result.success).toBe(true);
      expect(result.deliveredTo).toHaveLength(2);
      expect(result.deliveredTo).toContain("agent_1");
      expect(result.deliveredTo).toContain("agent_2");
      expect(result.method).toBe("broadcast");
    });

    it("should queue events with next-prompt wake mode", async () => {
      const agentId = "agent_head" as AgentId;

      mockDeps.agentManager.list = vi.fn().mockReturnValue([
        { id: agentId, parent: null, state: "running" },
      ]);

      triggerSystem = createTriggerSystem(mockDeps);
      await triggerSystem.start();

      const event = createTriggerEvent({
        source: { type: "cron", jobId: "job1", jobName: "Daily" },
        payload: { kind: "text", content: "Queued message" },
        wakeMode: "next-prompt",
      });

      const result = await triggerSystem.router.route(event);

      expect(result.success).toBe(true);
      expect(result.method).toBe("queued");

      // Verify event is in queue
      const hasEvents = triggerSystem.queue.hasEvents(agentId);
      expect(hasEvents).toBe(true);
    });
  });

  describe("cron service integration", () => {
    it("should execute cron job and route through system", async () => {
      mockDeps.agentManager.list = vi.fn().mockReturnValue([
        { id: "agent_head", parent: null, state: "running" },
      ]);
      mockDeps.agentManager.get = vi.fn().mockReturnValue({ state: "running" });
      mockDeps.agentManager.getSession = vi.fn().mockReturnValue(null);

      triggerSystem = createTriggerSystem(mockDeps);
      await triggerSystem.start();

      // Add a cron job
      await triggerSystem.cronService.add({
        name: "Test Cron",
        enabled: true,
        schedule: { kind: "every", everyMs: 1000 },
        sessionTarget: "main",
        wakeMode: "now",
        payload: { kind: "systemEvent", text: "Cron triggered" },
      });

      // Advance time past interval
      await vi.advanceTimersByTimeAsync(1100);

      // The cron service should have routed through the trigger router
      // We can verify by checking if prompt was called (wake mode is "now")
      expect(mockDeps.agentManager.prompt).toHaveBeenCalled();
    });

    it("should schedule one-shot job for specific time", async () => {
      mockDeps.agentManager.list = vi.fn().mockReturnValue([
        { id: "agent_head", parent: null, state: "running" },
      ]);
      mockDeps.agentManager.get = vi.fn().mockReturnValue({ state: "running" });
      mockDeps.agentManager.getSession = vi.fn().mockReturnValue(null);

      triggerSystem = createTriggerSystem(mockDeps);
      await triggerSystem.start();

      const futureTime = Date.now() + 5000;

      const job = await triggerSystem.cronService.add({
        name: "One-shot Job",
        enabled: true,
        schedule: { kind: "at", atMs: futureTime },
        sessionTarget: "main",
        wakeMode: "now",
        payload: { kind: "systemEvent", text: "One-shot triggered" },
      });

      // Verify job is scheduled
      expect(job.state.nextRunAtMs).toBe(futureTime);

      // Advance time to trigger
      await vi.advanceTimersByTimeAsync(5100);

      // Job should have executed and been disabled
      const updatedJob = await triggerSystem.cronService.get(job.id);
      expect(updatedJob?.enabled).toBe(false);
    });
  });

  describe("webhook integration", () => {
    it("should handle webhook and route through system", async () => {
      mockDeps.agentManager.list = vi.fn().mockReturnValue([
        { id: "agent_head", parent: null, state: "running" },
      ]);
      mockDeps.agentManager.get = vi.fn().mockReturnValue({ state: "running" });
      mockDeps.agentManager.getSession = vi.fn().mockReturnValue(null);

      triggerSystem = createTriggerSystem(mockDeps);
      await triggerSystem.start();

      // Register webhook endpoint
      const endpoint = await triggerSystem.webhookHandler.registerEndpoint({
        name: "Test Webhook",
        methods: ["POST"],
        path: "/webhooks/test",
        enabled: true,
        wakeMode: "now",
      });

      // Handle request
      const result = await triggerSystem.webhookHandler.handleRequest({
        endpointId: endpoint.id,
        method: "POST",
        path: "/webhooks/test",
        headers: { "content-type": "application/json" },
        body: { action: "deploy", environment: "staging" },
        timestamp: Date.now(),
      });

      expect(result.success).toBe(true);
      expect(result.triggerId).toBeDefined();
      expect(mockDeps.agentManager.prompt).toHaveBeenCalled();
    });

    it("should route webhook to specific agent", async () => {
      const targetAgentId = "agent_deploy" as AgentId;

      mockDeps.agentManager.get = vi.fn().mockReturnValue({
        id: targetAgentId,
        state: "running",
      });
      mockDeps.agentManager.getSession = vi.fn().mockReturnValue(null);

      triggerSystem = createTriggerSystem(mockDeps);
      await triggerSystem.start();

      // Register webhook with routing
      const endpoint = await triggerSystem.webhookHandler.registerEndpoint({
        name: "Deploy Webhook",
        methods: ["POST"],
        path: "/webhooks/deploy",
        enabled: true,
        wakeMode: "now",
        routing: {
          target: { type: "agent", agentId: targetAgentId },
        },
      });

      const result = await triggerSystem.webhookHandler.handleRequest({
        endpointId: endpoint.id,
        method: "POST",
        path: "/webhooks/deploy",
        headers: {},
        body: { deploy: true },
        timestamp: Date.now(),
      });

      expect(result.success).toBe(true);
    });
  });

  describe("wake manager integration", () => {
    it("should wake agents with pending events", async () => {
      const mockSession = {
        supportsInject: vi.fn().mockReturnValue(true),
        inject: vi.fn().mockResolvedValue({ success: true }),
      };

      mockDeps.agentManager.getSession = vi.fn().mockReturnValue(mockSession);

      triggerSystem = createTriggerSystem(mockDeps);
      await triggerSystem.start();

      // Queue an event directly
      const agentId = "agent_1" as AgentId;
      triggerSystem.queue.enqueue("Pending event", { agentId });

      // Manually run wake cycle
      triggerSystem.wakeManager.start();
      const result = await triggerSystem.wakeManager.runWakeCycle({
        reason: "test",
      });

      expect(result.status).toBe("ran");
      expect(result.wokenAgents).toContain(agentId);
      expect(mockSession.inject).toHaveBeenCalled();
    });

    it("should coalesce multiple wake requests", async () => {
      const mockSession = {
        supportsInject: vi.fn().mockReturnValue(true),
        inject: vi.fn().mockResolvedValue({ success: true }),
      };

      mockDeps.agentManager.getSession = vi.fn().mockReturnValue(mockSession);

      triggerSystem = createTriggerSystem(mockDeps);
      await triggerSystem.start();

      // Queue events for multiple agents
      triggerSystem.queue.enqueue("Event 1", { agentId: "agent_1" as AgentId });
      triggerSystem.queue.enqueue("Event 2", { agentId: "agent_2" as AgentId });

      // Request multiple wakes
      triggerSystem.wakeManager.start();
      triggerSystem.wakeManager.requestWakeNow({ reason: "first" });
      triggerSystem.wakeManager.requestWakeNow({ reason: "second" });
      triggerSystem.wakeManager.requestWakeNow({ reason: "third" });

      // Should only have one pending wake
      expect(triggerSystem.wakeManager.hasPendingWake()).toBe(true);

      // Advance time to process
      await vi.advanceTimersByTimeAsync(300);

      // Both agents should have been woken
      expect(mockSession.inject).toHaveBeenCalledTimes(2);
    });
  });

  describe("custom routing strategies", () => {
    it("should support custom routing strategy", async () => {
      const customTargetAgent = "agent_custom" as AgentId;

      const customStrategy: RoutingStrategy = {
        name: "custom-priority",
        canHandle: (event) => event.priority === "high",
        route: vi.fn().mockResolvedValue({
          targetAgents: [customTargetAgent],
          reason: "High priority routed to custom agent",
        } as RoutingDecision),
      };

      mockDeps.agentManager.get = vi.fn().mockReturnValue({ state: "running" });
      mockDeps.agentManager.getSession = vi.fn().mockReturnValue(null);

      triggerSystem = createTriggerSystem(mockDeps);
      await triggerSystem.start();

      triggerSystem.router.registerStrategy(customStrategy);

      const event = createTriggerEvent({
        source: { type: "system", eventType: "urgent" },
        payload: { kind: "text", content: "High priority message" },
        wakeMode: "now",
        priority: "high",
      });

      const result = await triggerSystem.router.route(event);

      expect(result.success).toBe(true);
      expect(result.deliveredTo).toContain(customTargetAgent);
      expect(customStrategy.route).toHaveBeenCalled();
    });

    it("should enable AI router strategy when configured", async () => {
      mockDeps.agentManager.list = vi.fn().mockReturnValue([
        { id: "agent_head", parent: null, state: "running" },
      ]);

      triggerSystem = createTriggerSystem(mockDeps, {
        enableAIRouter: true,
      });
      await triggerSystem.start();

      const strategies = triggerSystem.router.listStrategies();
      expect(strategies).toContain("ai-router");
    });
  });

  describe("event priority handling", () => {
    it("should process high priority events first", async () => {
      const agentId = "agent_1" as AgentId;

      triggerSystem = createTriggerSystem(mockDeps);
      await triggerSystem.start();

      // Queue events with different priorities
      triggerSystem.queue.enqueue("Low priority", {
        agentId,
        priority: "low",
      });
      triggerSystem.queue.enqueue("High priority", {
        agentId,
        priority: "high",
      });
      triggerSystem.queue.enqueue("Normal priority", {
        agentId,
        priority: "normal",
      });

      // Drain with priority sorting
      const events = triggerSystem.queue.drainText(agentId, {
        sortByPriority: true,
      });

      // High priority should be first
      expect(events[0]).toContain("High priority");
    });
  });

  describe("error resilience", () => {
    it("should handle routing failures gracefully", async () => {
      mockDeps.agentManager.list = vi.fn().mockReturnValue([]);

      triggerSystem = createTriggerSystem(mockDeps);
      await triggerSystem.start();

      const event = createTriggerEvent({
        source: { type: "system", eventType: "test" },
        payload: { kind: "text", content: "No targets" },
        wakeMode: "now",
      });

      const result = await triggerSystem.router.route(event);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it("should re-queue events when delivery fails", async () => {
      const agentId = "agent_stopped" as AgentId;

      mockDeps.agentManager.getSession = vi.fn().mockReturnValue(null);
      mockDeps.agentManager.get = vi.fn().mockReturnValue({ state: "stopped" });

      triggerSystem = createTriggerSystem(mockDeps);
      await triggerSystem.start();

      // Queue an event
      triggerSystem.queue.enqueue("Undeliverable event", { agentId });

      // Try to wake
      triggerSystem.wakeManager.start();
      await triggerSystem.wakeManager.runWakeCycle({ reason: "test" });

      // Event should still be queued
      expect(triggerSystem.queue.hasEvents(agentId)).toBe(true);
    });

    it("should continue processing after individual delivery failures", async () => {
      const agent1 = "agent_1" as AgentId;
      const agent2 = "agent_2" as AgentId;

      const mockSession = {
        supportsInject: vi.fn().mockReturnValue(true),
        inject: vi.fn().mockResolvedValue({ success: true }),
      };

      // First agent fails, second succeeds
      mockDeps.agentManager.getSession = vi.fn().mockImplementation((id) => {
        if (id === agent1) return null;
        return mockSession;
      });
      mockDeps.agentManager.get = vi.fn().mockReturnValue({ state: "stopped" });

      triggerSystem = createTriggerSystem(mockDeps);
      await triggerSystem.start();

      // Queue events for both agents
      triggerSystem.queue.enqueue("Event for agent 1", { agentId: agent1 });
      triggerSystem.queue.enqueue("Event for agent 2", { agentId: agent2 });

      // Run wake cycle
      triggerSystem.wakeManager.start();
      const result = await triggerSystem.wakeManager.runWakeCycle({
        reason: "test",
      });

      // Agent 2 should have been woken despite agent 1 failure
      expect(result.wokenAgents).toContain(agent2);
    });
  });
});

// =============================================================================
// Test Helpers
// =============================================================================

function createMockDeps(): TriggerSystemDeps {
  return {
    eventStore: {
      getAllTasks: vi.fn().mockReturnValue([]),
      appendEvent: vi.fn(),
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
    messageRouter: {
      send: vi.fn(),
      broadcast: vi.fn(),
    } as any,
  };
}
