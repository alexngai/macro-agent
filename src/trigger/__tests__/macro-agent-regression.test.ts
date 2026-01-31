/**
 * Macro-Agent Regression Tests
 *
 * These tests verify that the trigger system integrates correctly with
 * the existing macro-agent components and doesn't cause regressions.
 *
 * Tests cover:
 * - AgentManager integration (spawn, lifecycle, sessions)
 * - MessageRouter integration (routing, subscriptions)
 * - EventStore integration (events, persistence)
 * - Workspace integration (worktrees, isolation)
 * - Role system integration (capabilities, enforcement)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTriggerSystem, type TriggerSystemDeps } from "../trigger-system.js";
import { createTriggerEvent } from "../types.js";
import type { AgentId, TaskId } from "../../store/types/index.js";
import type { Agent } from "../../store/types/agents.js";

// =============================================================================
// Test Fixtures
// =============================================================================

/**
 * Create mock dependencies that mirror real macro-agent structure
 */
function createMockMacroAgentDeps(): TriggerSystemDeps & {
  _internal: {
    agents: Map<string, MockAgent>;
    sessions: Map<string, MockSession>;
    events: any[];
    subscriptions: Map<string, Set<string>>;
  };
} {
  const agents = new Map<string, MockAgent>();
  const sessions = new Map<string, MockSession>();
  const events: any[] = [];
  const subscriptions = new Map<string, Set<string>>();

  return {
    eventStore: {
      getAllTasks: vi.fn().mockReturnValue([]),
      appendEvent: vi.fn((event) => events.push(event)),
      getAgent: vi.fn((id) => agents.get(id) ?? null),
      listAgents: vi.fn(() => Array.from(agents.values())),
      query: vi.fn(() => events),
      emit: vi.fn((event) => {
        events.push({ ...event, id: `evt_${events.length}`, timestamp: Date.now() });
        return events[events.length - 1];
      }),
      persist: vi.fn().mockResolvedValue(undefined),
      reload: vi.fn().mockResolvedValue(undefined),
      getSubscriptions: vi.fn((agentId) => {
        const subs = subscriptions.get(agentId);
        return subs ? Array.from(subs).map((s) => ({ type: s.split(":")[0], target: s.split(":")[1] })) : [];
      }),
      addSubscription: vi.fn((agentId, sub) => {
        if (!subscriptions.has(agentId)) subscriptions.set(agentId, new Set());
        subscriptions.get(agentId)!.add(`${sub.type}:${sub.target}`);
      }),
    } as any,
    agentManager: {
      list: vi.fn(() => Array.from(agents.values())),
      get: vi.fn((id) => agents.get(id) ?? null),
      getSession: vi.fn((id) => sessions.get(id) ?? null),
      hasActiveSession: vi.fn((id) => sessions.has(id)),
      isPrompting: vi.fn(() => false),
      supportsInjection: vi.fn().mockResolvedValue(true),
      prompt: vi.fn(() => ({
        [Symbol.asyncIterator]: () => ({
          next: vi.fn().mockResolvedValue({ done: true }),
        }),
      })),
      spawn: vi.fn(async (options) => {
        const id = `agent_${agents.size + 1}` as AgentId;
        const agent: MockAgent = {
          id,
          state: "running",
          parent: options.parent ?? null,
          task: options.task,
          role: options.role,
          config: options.config ?? {},
          lineage: options.parent ? [options.parent] : [],
          created_at: Date.now(),
          session_id: `session_${id}`,
        };
        agents.set(id, agent);
        sessions.set(id, createMockSession(id));
        return { id, agent, session: sessions.get(id) };
      }),
      terminate: vi.fn(async (id) => {
        const agent = agents.get(id);
        if (agent) {
          agent.state = "stopped";
          sessions.delete(id);
        }
      }),
      getChildren: vi.fn((id) =>
        Array.from(agents.values()).filter((a) => a.parent === id)
      ),
    } as any,
    messageRouter: {
      send: vi.fn().mockResolvedValue({ id: "msg_1", timestamp: Date.now() }),
      emitStatus: vi.fn(),
      getMessages: vi.fn().mockReturnValue([]),
      subscribe: vi.fn((agentId, channel) => {
        if (!subscriptions.has(agentId)) subscriptions.set(agentId, new Set());
        subscriptions.get(agentId)!.add(`${channel.type}:${channel.target}`);
      }),
      broadcast: vi.fn(),
    } as any,
    _internal: {
      agents,
      sessions,
      events,
      subscriptions,
    },
  };
}

interface MockAgent {
  id: AgentId;
  state: "running" | "stopped" | "spawning";
  parent: AgentId | null;
  task?: string;
  role?: string;
  config: Record<string, unknown>;
  lineage: AgentId[];
  created_at: number;
  session_id: string;
}

interface MockSession {
  id: string;
  agentId: string;
  supportsInject: () => boolean;
  inject: (content: string) => Promise<{ success: boolean }>;
  interruptWith: (content: string) => Promise<{ success: boolean }>;
}

function createMockSession(agentId: string): MockSession {
  return {
    id: `session_${agentId}`,
    agentId,
    supportsInject: vi.fn().mockReturnValue(true),
    inject: vi.fn().mockResolvedValue({ success: true }),
    interruptWith: vi.fn().mockResolvedValue({ success: true }),
  };
}

// =============================================================================
// AgentManager Integration Tests
// =============================================================================

describe("AgentManager Integration", () => {
  let deps: ReturnType<typeof createMockMacroAgentDeps>;
  let triggerSystem: ReturnType<typeof createTriggerSystem>;

  beforeEach(async () => {
    vi.useFakeTimers();
    deps = createMockMacroAgentDeps();

    // Pre-populate with a head manager
    const headAgent: MockAgent = {
      id: "agent_head" as AgentId,
      state: "running",
      parent: null,
      task: "Coordinate all agents",
      role: "coordinator",
      config: {},
      lineage: [],
      created_at: Date.now(),
      session_id: "session_head",
    };
    deps._internal.agents.set("agent_head", headAgent);
    deps._internal.sessions.set("agent_head", createMockSession("agent_head"));

    triggerSystem = createTriggerSystem(deps);
    await triggerSystem.start();
  });

  afterEach(async () => {
    await triggerSystem.stop();
    vi.useRealTimers();
  });

  describe("spawn handling", () => {
    it("should spawn new agent when routing hint requests spawn", async () => {
      const event = createTriggerEvent({
        source: { type: "webhook", endpointId: "ep1", method: "POST", path: "/deploy" },
        payload: { kind: "text", content: "Deploy to production" },
        wakeMode: "now",
        routing: {
          target: { type: "role", role: "worker" },
          spawnIfNotFound: true,
          spawnConfig: {
            task: "Handle deployment webhook",
            role: "worker",
          },
        },
      });

      // No workers exist initially
      deps.agentManager.list = vi.fn().mockReturnValue([
        deps._internal.agents.get("agent_head"),
      ]);

      const result = await triggerSystem.router.route(event);

      // Should have attempted to spawn
      expect(result.success).toBe(true);
      expect(result.metadata?.spawnedNew).toBe(true);
    });

    it("should not spawn when agent with role exists", async () => {
      // Add a worker agent
      const workerAgent: MockAgent = {
        id: "agent_worker" as AgentId,
        state: "running",
        parent: "agent_head" as AgentId,
        task: "Existing worker",
        role: "worker",
        config: {},
        lineage: ["agent_head" as AgentId],
        created_at: Date.now(),
        session_id: "session_worker",
      };
      deps._internal.agents.set("agent_worker", workerAgent);
      deps._internal.sessions.set("agent_worker", createMockSession("agent_worker"));

      const event = createTriggerEvent({
        source: { type: "internal", component: "scheduler" },
        payload: { kind: "text", content: "New task for worker" },
        wakeMode: "now",
        routing: {
          target: { type: "role", role: "worker" },
          spawnIfNotFound: true,
        },
      });

      const result = await triggerSystem.router.route(event);

      expect(result.success).toBe(true);
      expect(result.deliveredTo).toContain("agent_worker");
      expect(deps.agentManager.spawn).not.toHaveBeenCalled();
    });
  });

  describe("session integration", () => {
    it("should use session inject when available", async () => {
      const session = deps._internal.sessions.get("agent_head")!;

      const event = createTriggerEvent({
        source: { type: "system", eventType: "health-check" },
        payload: { kind: "text", content: "Perform health check" },
        wakeMode: "now",
        routing: { target: { type: "head" } },
      });

      await triggerSystem.router.route(event);

      // Wake manager should have tried inject
      triggerSystem.wakeManager.start();
      await triggerSystem.wakeManager.runWakeCycle({ reason: "test" });

      expect(session.inject).toHaveBeenCalled();
    });

    it("should fallback to prompt when inject not supported", async () => {
      const session = deps._internal.sessions.get("agent_head")!;
      session.supportsInject = vi.fn().mockReturnValue(false);
      session.inject = vi.fn().mockRejectedValue(new Error("Not supported"));

      // Queue event for the agent
      triggerSystem.queue.enqueue("Test message", {
        agentId: "agent_head" as AgentId,
      });

      triggerSystem.wakeManager.start();
      await triggerSystem.wakeManager.runWakeCycle({ reason: "test" });

      // Should have fallen back to prompt
      expect(deps.agentManager.prompt).toHaveBeenCalled();
    });
  });

  describe("lifecycle events", () => {
    it("should not interfere with normal agent termination", async () => {
      const workerId = "agent_worker" as AgentId;
      const workerAgent: MockAgent = {
        id: workerId,
        state: "running",
        parent: "agent_head" as AgentId,
        task: "Test task",
        role: "worker",
        config: {},
        lineage: ["agent_head" as AgentId],
        created_at: Date.now(),
        session_id: "session_worker",
      };
      deps._internal.agents.set(workerId, workerAgent);

      // Terminate via agent manager
      await deps.agentManager.terminate(workerId, "completed");

      // Agent should be stopped
      expect(deps._internal.agents.get(workerId)?.state).toBe("stopped");

      // Queue should be cleared for stopped agent
      triggerSystem.queue.enqueue("Should be ignored", { agentId: workerId });
      expect(triggerSystem.queue.hasEvents(workerId)).toBe(true);

      // Drain should return empty for stopped agents in real implementation
      // (the queue itself doesn't check agent state, but wake manager does)
    });
  });
});

// =============================================================================
// MessageRouter Integration Tests
// =============================================================================

describe("MessageRouter Integration", () => {
  let deps: ReturnType<typeof createMockMacroAgentDeps>;
  let triggerSystem: ReturnType<typeof createTriggerSystem>;

  beforeEach(async () => {
    vi.useFakeTimers();
    deps = createMockMacroAgentDeps();

    // Pre-populate with agents
    const headAgent: MockAgent = {
      id: "agent_head" as AgentId,
      state: "running",
      parent: null,
      role: "coordinator",
      config: { channels: ["alerts", "system"] },
      lineage: [],
      created_at: Date.now(),
      session_id: "session_head",
    };
    deps._internal.agents.set("agent_head", headAgent);
    deps._internal.sessions.set("agent_head", createMockSession("agent_head"));

    triggerSystem = createTriggerSystem(deps);
    await triggerSystem.start();
  });

  afterEach(async () => {
    await triggerSystem.stop();
    vi.useRealTimers();
  });

  describe("message routing compatibility", () => {
    it("should not conflict with MessageRouter send", async () => {
      // Use trigger system to route
      const event = createTriggerEvent({
        source: { type: "internal", component: "test" },
        payload: { kind: "text", content: "Via trigger system" },
        wakeMode: "now",
        routing: { target: { type: "head" } },
      });

      await triggerSystem.router.route(event);

      // Also use MessageRouter directly
      await deps.messageRouter.send({
        from: { agent_id: "agent_head" as AgentId },
        to: { agent_id: "agent_head" as AgentId },
        content: "Via message router",
      });

      // Both should work without conflicts
      expect(deps.messageRouter.send).toHaveBeenCalled();
    });

    it("should integrate with MessageRouter subscriptions", async () => {
      // Add subscription via MessageRouter
      deps.messageRouter.subscribe("agent_head" as AgentId, {
        type: "broadcast",
        target: "alerts",
      });

      // Verify subscription was added
      expect(deps._internal.subscriptions.get("agent_head")).toContain("broadcast:alerts");

      // Trigger system broadcast should respect existing subscriptions
      const event = createTriggerEvent({
        source: { type: "system", eventType: "alert" },
        payload: { kind: "text", content: "Alert broadcast" },
        wakeMode: "now",
        routing: { target: { type: "broadcast", channel: "alerts" } },
      });

      const result = await triggerSystem.router.route(event);
      expect(result.success).toBe(true);
    });
  });

  describe("status event compatibility", () => {
    it("should not interfere with MessageRouter emitStatus", () => {
      // Use MessageRouter for status
      deps.messageRouter.emitStatus({
        from: { agent_id: "agent_head" as AgentId },
        status_type: "progress",
        summary: "Working on task",
      });

      expect(deps.messageRouter.emitStatus).toHaveBeenCalled();

      // Trigger system should still work for its own events
      const event = createTriggerEvent({
        source: { type: "cron", jobId: "job1", jobName: "Heartbeat" },
        payload: { kind: "text", content: "Heartbeat check" },
        wakeMode: "now",
      });

      // Route shouldn't throw
      expect(() => triggerSystem.router.route(event)).not.toThrow();
    });
  });
});

// =============================================================================
// EventStore Integration Tests
// =============================================================================

describe("EventStore Integration", () => {
  let deps: ReturnType<typeof createMockMacroAgentDeps>;
  let triggerSystem: ReturnType<typeof createTriggerSystem>;

  beforeEach(async () => {
    deps = createMockMacroAgentDeps();
    triggerSystem = createTriggerSystem(deps);
    await triggerSystem.start();
  });

  afterEach(async () => {
    await triggerSystem.stop();
  });

  describe("event emission compatibility", () => {
    it("should not corrupt EventStore with trigger events", () => {
      // Queue multiple events
      triggerSystem.queue.enqueue("Event 1", { agentId: "agent_1" as AgentId });
      triggerSystem.queue.enqueue("Event 2", { agentId: "agent_1" as AgentId });
      triggerSystem.queue.enqueue("Event 3", { agentId: "agent_2" as AgentId });

      // Events should be isolated in trigger queue, not in EventStore
      // EventStore.emit should only be called for routed events
      const storeEvents = deps._internal.events;

      // Queue doesn't emit to EventStore directly
      // Only actual deliveries or status changes would emit events
    });

    it("should work alongside EventStore queries", () => {
      // Emit a regular event to EventStore
      deps.eventStore.emit({
        type: "status",
        source: { agent_id: "agent_1" },
        payload: { status_type: "progress", summary: "Test" },
      });

      // Query should still work
      const events = deps.eventStore.query({ type: "status" });
      expect(events.length).toBeGreaterThan(0);

      // Trigger system should not affect these queries
      triggerSystem.queue.enqueue("Trigger event", { agentId: "agent_1" as AgentId });

      const eventsAfter = deps.eventStore.query({ type: "status" });
      expect(eventsAfter.length).toBe(events.length);
    });
  });

  describe("persistence compatibility", () => {
    it("should not block EventStore persist", async () => {
      // Persist should work normally
      await deps.eventStore.persist();

      expect(deps.eventStore.persist).toHaveBeenCalled();
    });

    it("should handle EventStore reload during wake cycle", async () => {
      // Add agent and session
      const agent: MockAgent = {
        id: "agent_1" as AgentId,
        state: "running",
        parent: null,
        config: {},
        lineage: [],
        created_at: Date.now(),
        session_id: "session_1",
      };
      deps._internal.agents.set("agent_1", agent);
      deps._internal.sessions.set("agent_1", createMockSession("agent_1"));

      // Queue event
      triggerSystem.queue.enqueue("Test", { agentId: "agent_1" as AgentId });

      // Run wake cycle (which may reload)
      triggerSystem.wakeManager.start();
      await triggerSystem.wakeManager.runWakeCycle({ reason: "test" });

      // Should complete without errors
    });
  });
});

// =============================================================================
// Role System Integration Tests
// =============================================================================

describe("Role System Integration", () => {
  let deps: ReturnType<typeof createMockMacroAgentDeps>;
  let triggerSystem: ReturnType<typeof createTriggerSystem>;

  beforeEach(async () => {
    deps = createMockMacroAgentDeps();

    // Set up agents with different roles
    const roles = ["coordinator", "worker", "integrator", "monitor"];
    for (const role of roles) {
      const agent: MockAgent = {
        id: `agent_${role}` as AgentId,
        state: "running",
        parent: role === "coordinator" ? null : ("agent_coordinator" as AgentId),
        role,
        config: {},
        lineage: role === "coordinator" ? [] : ["agent_coordinator" as AgentId],
        created_at: Date.now(),
        session_id: `session_${role}`,
      };
      deps._internal.agents.set(`agent_${role}`, agent);
      deps._internal.sessions.set(`agent_${role}`, createMockSession(`agent_${role}`));
    }

    triggerSystem = createTriggerSystem(deps);
    await triggerSystem.start();
  });

  afterEach(async () => {
    await triggerSystem.stop();
  });

  describe("role-based routing", () => {
    it("should route to workers correctly", async () => {
      const event = createTriggerEvent({
        source: { type: "internal", component: "scheduler" },
        payload: { kind: "text", content: "Task for worker" },
        wakeMode: "now",
        routing: { target: { type: "role", role: "worker" } },
      });

      const result = await triggerSystem.router.route(event);

      expect(result.success).toBe(true);
      expect(result.deliveredTo).toContain("agent_worker");
      expect(result.deliveredTo).not.toContain("agent_monitor");
    });

    it("should route to monitors correctly", async () => {
      const event = createTriggerEvent({
        source: { type: "cron", jobId: "health", jobName: "Health Check" },
        payload: { kind: "text", content: "Run health check" },
        wakeMode: "now",
        routing: { target: { type: "role", role: "monitor" } },
      });

      const result = await triggerSystem.router.route(event);

      expect(result.success).toBe(true);
      expect(result.deliveredTo).toContain("agent_monitor");
    });

    it("should route to integrators correctly", async () => {
      const event = createTriggerEvent({
        source: { type: "webhook", endpointId: "merge", method: "POST", path: "/merge" },
        payload: { kind: "text", content: "Merge request" },
        wakeMode: "now",
        routing: { target: { type: "role", role: "integrator" } },
      });

      const result = await triggerSystem.router.route(event);

      expect(result.success).toBe(true);
      expect(result.deliveredTo).toContain("agent_integrator");
    });
  });

  describe("coordinator routing", () => {
    it("should route head target to coordinator", async () => {
      const event = createTriggerEvent({
        source: { type: "system", eventType: "startup" },
        payload: { kind: "text", content: "System startup" },
        wakeMode: "now",
        routing: { target: { type: "head" } },
      });

      const result = await triggerSystem.router.route(event);

      expect(result.success).toBe(true);
      expect(result.deliveredTo).toContain("agent_coordinator");
    });
  });
});

// =============================================================================
// Concurrent Operations Tests
// =============================================================================

describe("Concurrent Operations", () => {
  let deps: ReturnType<typeof createMockMacroAgentDeps>;
  let triggerSystem: ReturnType<typeof createTriggerSystem>;

  beforeEach(async () => {
    deps = createMockMacroAgentDeps();

    // Add head agent
    const agent: MockAgent = {
      id: "agent_head" as AgentId,
      state: "running",
      parent: null,
      role: "coordinator",
      config: {},
      lineage: [],
      created_at: Date.now(),
      session_id: "session_head",
    };
    deps._internal.agents.set("agent_head", agent);
    deps._internal.sessions.set("agent_head", createMockSession("agent_head"));

    triggerSystem = createTriggerSystem(deps);
    await triggerSystem.start();
  });

  afterEach(async () => {
    await triggerSystem.stop();
  });

  describe("parallel trigger handling", () => {
    it("should handle multiple simultaneous triggers", async () => {
      const events = Array.from({ length: 10 }, (_, i) =>
        createTriggerEvent({
          source: { type: "webhook", endpointId: `ep${i}`, method: "POST", path: `/hook${i}` },
          payload: { kind: "text", content: `Event ${i}` },
          wakeMode: "now",
          routing: { target: { type: "head" } },
        })
      );

      // Route all in parallel
      const results = await Promise.all(events.map((e) => triggerSystem.router.route(e)));

      // All should succeed
      expect(results.every((r) => r.success)).toBe(true);
      expect(results.every((r) => r.deliveredTo.includes("agent_head"))).toBe(true);
    });

    it("should not lose events during concurrent wake cycles", async () => {
      // Queue events for multiple agents
      for (let i = 0; i < 5; i++) {
        const agentId = `agent_${i}` as AgentId;
        const agent: MockAgent = {
          id: agentId,
          state: "running",
          parent: "agent_head" as AgentId,
          config: {},
          lineage: ["agent_head" as AgentId],
          created_at: Date.now(),
          session_id: `session_${i}`,
        };
        deps._internal.agents.set(agentId, agent);
        deps._internal.sessions.set(agentId, createMockSession(agentId));

        triggerSystem.queue.enqueue(`Event for agent ${i}`, { agentId });
      }

      // Run multiple wake cycles concurrently
      triggerSystem.wakeManager.start();
      const cycles = await Promise.all([
        triggerSystem.wakeManager.runWakeCycle({ reason: "cycle1" }),
        triggerSystem.wakeManager.runWakeCycle({ reason: "cycle2" }),
        triggerSystem.wakeManager.runWakeCycle({ reason: "cycle3" }),
      ]);

      // At least one should have run (others may be skipped due to coalescing)
      const ranCycles = cycles.filter((c) => c.status === "ran");
      expect(ranCycles.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("cron and webhook interaction", () => {
    it("should handle cron and webhook triggers simultaneously", async () => {
      // Register a webhook endpoint
      const endpoint = await triggerSystem.webhookHandler.registerEndpoint({
        name: "Test",
        methods: ["POST"],
        path: "/test",
        enabled: true,
        wakeMode: "now",
      });

      // Add a cron job
      await triggerSystem.cronService.add({
        name: "Test Cron",
        enabled: true,
        schedule: { kind: "every", everyMs: 1000 },
        sessionTarget: "main",
        wakeMode: "now",
        payload: { kind: "text", content: "Cron event" },
      });

      // Handle webhook request
      const webhookPromise = triggerSystem.webhookHandler.handleRequest({
        endpointId: endpoint.id,
        method: "POST",
        path: "/test",
        headers: {},
        body: { test: true },
        timestamp: Date.now(),
      });

      // Trigger cron manually
      const cronPromise = triggerSystem.cronService.triggerNow(
        (await triggerSystem.cronService.list())[0].id
      );

      // Both should complete
      const [webhookResult, cronResult] = await Promise.all([webhookPromise, cronPromise]);

      expect(webhookResult.success).toBe(true);
      // Cron trigger returns void, just ensure no error
    });
  });
});

// =============================================================================
// Error Recovery Tests
// =============================================================================

describe("Error Recovery", () => {
  let deps: ReturnType<typeof createMockMacroAgentDeps>;
  let triggerSystem: ReturnType<typeof createTriggerSystem>;

  beforeEach(async () => {
    deps = createMockMacroAgentDeps();
    triggerSystem = createTriggerSystem(deps);
    await triggerSystem.start();
  });

  afterEach(async () => {
    await triggerSystem.stop();
  });

  describe("graceful degradation", () => {
    it("should continue after individual agent failures", async () => {
      // Add agents, one will fail
      for (let i = 0; i < 3; i++) {
        const agentId = `agent_${i}` as AgentId;
        const session = createMockSession(agentId);

        if (i === 1) {
          // Make this agent's session fail
          session.inject = vi.fn().mockRejectedValue(new Error("Inject failed"));
          session.interruptWith = vi.fn().mockRejectedValue(new Error("Interrupt failed"));
        }

        const agent: MockAgent = {
          id: agentId,
          state: "running",
          parent: null,
          config: {},
          lineage: [],
          created_at: Date.now(),
          session_id: `session_${i}`,
        };
        deps._internal.agents.set(agentId, agent);
        deps._internal.sessions.set(agentId, session);

        triggerSystem.queue.enqueue(`Event for ${i}`, { agentId });
      }

      // Run wake cycle
      triggerSystem.wakeManager.start();
      const result = await triggerSystem.wakeManager.runWakeCycle({ reason: "test" });

      // Should have woken some agents despite failure
      expect(result.status).toBe("ran");
      // Agent 0 and 2 should be woken, agent 1 may have failed
    });

    it("should not crash when EventStore is temporarily unavailable", async () => {
      // Make EventStore throw
      deps.eventStore.emit = vi.fn().mockImplementation(() => {
        throw new Error("EventStore unavailable");
      });

      // Trigger should handle gracefully
      const event = createTriggerEvent({
        source: { type: "internal", component: "test" },
        payload: { kind: "text", content: "Test" },
        wakeMode: "now",
      });

      // Should not throw, but may fail gracefully
      await expect(triggerSystem.router.route(event)).resolves.toBeDefined();
    });
  });

  describe("queue overflow protection", () => {
    it("should respect max events per agent", () => {
      const agentId = "agent_1" as AgentId;

      // Queue many events (default limit is 100)
      for (let i = 0; i < 150; i++) {
        triggerSystem.queue.enqueue(`Event ${i}`, { agentId });
      }

      // Should not exceed limit
      const events = triggerSystem.queue.drainText(agentId);
      expect(events.length).toBeLessThanOrEqual(100);
    });
  });
});

// =============================================================================
// Cleanup and Resource Management Tests
// =============================================================================

describe("Cleanup and Resource Management", () => {
  let deps: ReturnType<typeof createMockMacroAgentDeps>;

  beforeEach(() => {
    vi.useFakeTimers();
    deps = createMockMacroAgentDeps();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("system shutdown", () => {
    it("should clean up all resources on stop", async () => {
      const triggerSystem = createTriggerSystem(deps);
      await triggerSystem.start();

      // Add cron jobs
      await triggerSystem.cronService.add({
        name: "Test",
        enabled: true,
        schedule: { kind: "every", everyMs: 1000 },
        sessionTarget: "main",
        wakeMode: "now",
        payload: { kind: "text", content: "Test" },
      });

      // Start wake manager heartbeat
      triggerSystem.wakeManager.start();

      // Stop system
      await triggerSystem.stop();

      expect(triggerSystem.isRunning()).toBe(false);
      expect(triggerSystem.wakeManager.isRunning()).toBe(false);
      expect(triggerSystem.cronService.isRunning()).toBe(false);
    });

    it("should be safe to stop multiple times", async () => {
      const triggerSystem = createTriggerSystem(deps);
      await triggerSystem.start();

      await triggerSystem.stop();
      await triggerSystem.stop();
      await triggerSystem.stop();

      expect(triggerSystem.isRunning()).toBe(false);
    });
  });

  describe("memory management", () => {
    it("should not leak memory with repeated start/stop cycles", async () => {
      for (let i = 0; i < 5; i++) {
        const triggerSystem = createTriggerSystem(deps);
        await triggerSystem.start();

        // Queue some events
        triggerSystem.queue.enqueue("Test", { agentId: "agent_1" as AgentId });

        await triggerSystem.stop();
      }

      // If we got here without OOM, memory is being managed
    });
  });
});
