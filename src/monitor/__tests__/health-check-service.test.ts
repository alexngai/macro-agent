/**
 * Tests for HealthCheckService
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  HealthCheckService,
  DEFAULT_HEALTH_CHECK_CONFIG,
} from "../health-check-service.js";
import type { EventStore } from "../../store/event-store.js";
import type { SessionMapper } from "../../acp/session-mapper.js";
import type { MessageRouter } from "../../router/message-router.js";
import type { Agent } from "../../store/types/index.js";

// =============================================================================
// Mock Factories
// =============================================================================

function createMockAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: `agent_${Math.random().toString(36).slice(2, 8)}`,
    session_id: `session_${Math.random().toString(36).slice(2, 8)}`,
    parent: null,
    lineage: [],
    state: "running",
    task: "Test task",
    config: {},
    cwd: "/tmp",
    created_at: Date.now() - 60000,
    ...overrides,
  };
}

function createMockEventStore(agents: Agent[] = []): EventStore {
  return {
    listAgents: vi.fn((filter?: { parent?: string | null; state?: string }) => {
      return agents.filter((a) => {
        if (filter?.parent !== undefined && a.parent !== filter.parent)
          return false;
        if (filter?.state !== undefined && a.state !== filter.state)
          return false;
        return true;
      });
    }),
  } as unknown as EventStore;
}

function createMockSessionMapper(
  sessionStatuses: Map<
    string,
    { isProcessing: boolean; sessionId: string; lastProcessingChangeAt: number }
  > = new Map(),
  agentSessions: Map<string, string[]> = new Map()
): SessionMapper {
  return {
    getSessionStatus: vi.fn((agentId: string) => sessionStatuses.get(agentId)),
    getSessionsForAgent: vi.fn(
      (agentId: string) => agentSessions.get(agentId) ?? []
    ),
    removeMapping: vi.fn(),
  } as unknown as SessionMapper;
}

function createMockMessageRouter(): MessageRouter {
  return {
    emitStatus: vi.fn(),
  } as unknown as MessageRouter;
}

// =============================================================================
// Tests
// =============================================================================

describe("HealthCheckService", () => {
  let service: HealthCheckService;
  let eventStore: EventStore;
  let sessionMapper: SessionMapper;
  let messageRouter: MessageRouter;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    service?.stopAll();
    vi.useRealTimers();
  });

  describe("constructor", () => {
    it("should use default config when none provided", () => {
      eventStore = createMockEventStore();
      sessionMapper = createMockSessionMapper();
      messageRouter = createMockMessageRouter();

      service = new HealthCheckService(
        eventStore,
        sessionMapper,
        messageRouter
      );

      expect(service.getConfig()).toEqual(DEFAULT_HEALTH_CHECK_CONFIG);
    });

    it("should merge provided config with defaults", () => {
      eventStore = createMockEventStore();
      sessionMapper = createMockSessionMapper();
      messageRouter = createMockMessageRouter();

      service = new HealthCheckService(
        eventStore,
        sessionMapper,
        messageRouter,
        {
          intervalMs: 60000,
        }
      );

      const config = service.getConfig();
      expect(config.intervalMs).toBe(60000);
      expect(config.stalledThresholdMs).toBe(
        DEFAULT_HEALTH_CHECK_CONFIG.stalledThresholdMs
      );
    });
  });

  describe("startForCoordinator", () => {
    it("should start monitoring a coordinator", () => {
      eventStore = createMockEventStore();
      sessionMapper = createMockSessionMapper();
      messageRouter = createMockMessageRouter();

      service = new HealthCheckService(
        eventStore,
        sessionMapper,
        messageRouter
      );

      service.startForCoordinator("coordinator_1");

      expect(service.getMonitoredCoordinators()).toContain("coordinator_1");
      expect(service.getHealthState("coordinator_1")).toBeDefined();
      expect(service.getHealthState("coordinator_1")?.isRunning).toBe(true);
    });

    it("should run initial health check immediately", async () => {
      const staleActivity = Date.now() - 15 * 60 * 1000;
      const worker = createMockAgent({
        id: "worker_1",
        parent: "coordinator_1",
        last_activity_at: staleActivity,
      });

      eventStore = createMockEventStore([worker]);
      sessionMapper = createMockSessionMapper();
      messageRouter = createMockMessageRouter();

      service = new HealthCheckService(
        eventStore,
        sessionMapper,
        messageRouter
      );

      service.startForCoordinator("coordinator_1");

      // Initial check runs asynchronously, flush promises
      await vi.runOnlyPendingTimersAsync();

      expect(eventStore.listAgents).toHaveBeenCalled();
    });

    it("should replace existing timer when called again", () => {
      eventStore = createMockEventStore();
      sessionMapper = createMockSessionMapper();
      messageRouter = createMockMessageRouter();

      service = new HealthCheckService(
        eventStore,
        sessionMapper,
        messageRouter
      );

      service.startForCoordinator("coordinator_1");
      service.startForCoordinator("coordinator_1");

      // Should still only have one coordinator monitored
      expect(service.getMonitoredCoordinators()).toHaveLength(1);
    });
  });

  describe("stopForCoordinator", () => {
    it("should stop monitoring a coordinator", () => {
      eventStore = createMockEventStore();
      sessionMapper = createMockSessionMapper();
      messageRouter = createMockMessageRouter();

      service = new HealthCheckService(
        eventStore,
        sessionMapper,
        messageRouter
      );

      service.startForCoordinator("coordinator_1");
      expect(service.getMonitoredCoordinators()).toContain("coordinator_1");

      service.stopForCoordinator("coordinator_1");
      expect(service.getMonitoredCoordinators()).not.toContain("coordinator_1");
      expect(service.getHealthState("coordinator_1")?.isRunning).toBe(false);
    });

    it("should handle stopping non-existent coordinator gracefully", () => {
      eventStore = createMockEventStore();
      sessionMapper = createMockSessionMapper();
      messageRouter = createMockMessageRouter();

      service = new HealthCheckService(
        eventStore,
        sessionMapper,
        messageRouter
      );

      // Should not throw
      service.stopForCoordinator("non_existent");
    });
  });

  describe("stopAll", () => {
    it("should stop all coordinators", () => {
      eventStore = createMockEventStore();
      sessionMapper = createMockSessionMapper();
      messageRouter = createMockMessageRouter();

      service = new HealthCheckService(
        eventStore,
        sessionMapper,
        messageRouter
      );

      service.startForCoordinator("coordinator_1");
      service.startForCoordinator("coordinator_2");
      expect(service.getMonitoredCoordinators()).toHaveLength(2);

      service.stopAll();
      expect(service.getMonitoredCoordinators()).toHaveLength(0);
    });
  });

  describe("checkNow", () => {
    it("should return health check result", async () => {
      const staleActivity = Date.now() - 15 * 60 * 1000;
      const worker = createMockAgent({
        id: "worker_1",
        parent: "coordinator_1",
        last_activity_at: staleActivity,
        task_id: "task_1",
      });

      eventStore = createMockEventStore([worker]);
      sessionMapper = createMockSessionMapper();
      messageRouter = createMockMessageRouter();

      service = new HealthCheckService(
        eventStore,
        sessionMapper,
        messageRouter
      );

      const result = await service.checkNow("coordinator_1");

      expect(result.coordinatorId).toBe("coordinator_1");
      expect(result.stalledAgents).toHaveLength(1);
      expect(result.stalledAgents[0].agentId).toBe("worker_1");
    });

    it("should track consecutive failures", async () => {
      const staleActivity = Date.now() - 15 * 60 * 1000;
      const worker = createMockAgent({
        id: "worker_1",
        parent: "coordinator_1",
        last_activity_at: staleActivity,
      });

      eventStore = createMockEventStore([worker]);
      sessionMapper = createMockSessionMapper();
      messageRouter = createMockMessageRouter();

      service = new HealthCheckService(
        eventStore,
        sessionMapper,
        messageRouter,
        { consecutiveFailuresBeforeEscalate: 3 }
      );

      // First check - warning
      await service.checkNow("coordinator_1");
      let state = service.getHealthState("coordinator_1");
      expect(state?.workers.get("worker_1")?.consecutiveFailures).toBe(1);
      expect(state?.workers.get("worker_1")?.status).toBe("warning");

      // Second check - still warning
      await service.checkNow("coordinator_1");
      state = service.getHealthState("coordinator_1");
      expect(state?.workers.get("worker_1")?.consecutiveFailures).toBe(2);
      expect(state?.workers.get("worker_1")?.status).toBe("warning");

      // Third check - escalated to stalled
      await service.checkNow("coordinator_1");
      state = service.getHealthState("coordinator_1");
      expect(state?.workers.get("worker_1")?.consecutiveFailures).toBe(3);
      expect(state?.workers.get("worker_1")?.status).toBe("stalled");
    });

    it("should emit STALE_AGENT signal when escalating", async () => {
      const staleActivity = Date.now() - 15 * 60 * 1000;
      const worker = createMockAgent({
        id: "worker_1",
        parent: "coordinator_1",
        last_activity_at: staleActivity,
        task_id: "task_1",
      });

      eventStore = createMockEventStore([worker]);
      sessionMapper = createMockSessionMapper();
      messageRouter = createMockMessageRouter();

      service = new HealthCheckService(
        eventStore,
        sessionMapper,
        messageRouter,
        { consecutiveFailuresBeforeEscalate: 1 }
      );

      await service.checkNow("coordinator_1");

      expect(messageRouter.emitStatus).toHaveBeenCalledWith(
        expect.objectContaining({
          status_type: "checkpoint",
          details: expect.objectContaining({
            signal: "STALE_AGENT",
            workerId: "worker_1",
            taskId: "task_1",
          }),
        })
      );
    });

    it("should reset failure counter when worker becomes healthy", async () => {
      const recentActivity = Date.now() - 1000;
      const worker = createMockAgent({
        id: "worker_1",
        parent: "coordinator_1",
        last_activity_at: recentActivity,
      });

      eventStore = createMockEventStore([worker]);
      sessionMapper = createMockSessionMapper();
      messageRouter = createMockMessageRouter();

      service = new HealthCheckService(
        eventStore,
        sessionMapper,
        messageRouter
      );

      // Manually set up some failure state
      service.startForCoordinator("coordinator_1");
      const state = service.getHealthState("coordinator_1")!;
      state.workers.set("worker_1", {
        agentId: "worker_1",
        lastActivityAt: Date.now() - 60000,
        consecutiveFailures: 2,
        lastCheckAt: Date.now() - 60000,
        status: "warning",
      });

      // Now check - worker is healthy
      await service.checkNow("coordinator_1");

      const workerState = state.workers.get("worker_1");
      expect(workerState?.consecutiveFailures).toBe(0);
      expect(workerState?.status).toBe("healthy");
    });
  });

  describe("periodic health checks", () => {
    it("should run health checks at configured interval", async () => {
      const staleActivity = Date.now() - 15 * 60 * 1000;
      const worker = createMockAgent({
        id: "worker_1",
        parent: "coordinator_1",
        last_activity_at: staleActivity,
      });

      eventStore = createMockEventStore([worker]);
      sessionMapper = createMockSessionMapper();
      messageRouter = createMockMessageRouter();

      service = new HealthCheckService(
        eventStore,
        sessionMapper,
        messageRouter,
        { intervalMs: 1000 } // 1 second for testing
      );

      service.startForCoordinator("coordinator_1");

      // Flush the initial async check
      await vi.runOnlyPendingTimersAsync();

      // listAgents is called twice per check (once for running workers, once for stopped)
      // due to StallDetector and cleanupZombies
      const initialCalls = (eventStore.listAgents as ReturnType<typeof vi.fn>).mock.calls.length;
      expect(initialCalls).toBeGreaterThan(0);

      // Advance time by interval
      await vi.advanceTimersByTimeAsync(1000);
      const afterFirstInterval = (eventStore.listAgents as ReturnType<typeof vi.fn>).mock.calls.length;
      expect(afterFirstInterval).toBeGreaterThan(initialCalls);

      // Advance again
      await vi.advanceTimersByTimeAsync(1000);
      const afterSecondInterval = (eventStore.listAgents as ReturnType<typeof vi.fn>).mock.calls.length;
      expect(afterSecondInterval).toBeGreaterThan(afterFirstInterval);
    });
  });
});
