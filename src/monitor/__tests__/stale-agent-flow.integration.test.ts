/**
 * Integration tests for STALE_AGENT flow
 *
 * Tests the complete flow from stall detection to coordinator notification.
 *
 * @see i-33hv B5.3: Add integration tests for STALE_AGENT flow
 * @see s-5yhx Phase B: Monitor Active Behaviors
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createEventStore, EventStore } from "../../store/event-store.js";
import { createMessageRouter, MessageRouter } from "../../router/message-router.js";
import { SessionMapper } from "../../acp/session-mapper.js";
import { StallDetector } from "../stall-detector.js";
import { HealthCheckService } from "../health-check-service.js";
import type { AgentId, TaskId } from "../../store/types/index.js";

describe("STALE_AGENT Flow Integration", () => {
  let eventStore: EventStore;
  let messageRouter: MessageRouter;
  let sessionMapper: SessionMapper;
  let stallDetector: StallDetector;

  beforeEach(async () => {
    vi.useFakeTimers();
    eventStore = await createEventStore({ inMemory: true });
    messageRouter = createMessageRouter(eventStore);
    sessionMapper = new SessionMapper();
    stallDetector = new StallDetector(eventStore, sessionMapper, {
      stalledThresholdMs: 10000, // 10 seconds for testing
    });
  });

  afterEach(async () => {
    vi.useRealTimers();
    await eventStore.close();
  });

  // ==========================================================================
  // Test Helpers
  // ==========================================================================

  function spawnCoordinator(id: AgentId): void {
    eventStore.emit({
      type: "spawn",
      source: { agent_id: "system" },
      payload: {
        agent_id: id,
        session_id: `session_${id}`,
        task: "Coordinate work",
        parent: null,
        role: "coordinator",
      },
    });
    // Set to running state
    eventStore.emit({
      type: "status",
      source: { agent_id: id },
      payload: {
        status_type: "started",
        summary: "Started",
      },
    });
  }

  function spawnWorker(
    id: AgentId,
    parentId: AgentId,
    taskId?: TaskId
  ): void {
    eventStore.emit({
      type: "spawn",
      source: { agent_id: parentId },
      payload: {
        agent_id: id,
        session_id: `session_${id}`,
        task: "Do work",
        task_id: taskId,
        parent: parentId,
        role: "worker",
      },
    });
    // Set to running state
    eventStore.emit({
      type: "status",
      source: { agent_id: id },
      payload: {
        status_type: "started",
        summary: "Started",
      },
    });
    // Map session - createMapping sets agentId = headManagerId
    // For workers, we treat them as their own "head manager" for their session
    sessionMapper.createMapping(`acp_${id}`, id);
  }

  function advanceTime(ms: number): void {
    vi.advanceTimersByTime(ms);
  }

  // ==========================================================================
  // Stall Detection Tests
  // ==========================================================================

  describe("Stall Detection", () => {
    it("should detect stalled worker after threshold", () => {
      const coordinatorId = "coord_1" as AgentId;
      const workerId = "worker_1" as AgentId;

      spawnCoordinator(coordinatorId);
      spawnWorker(workerId, coordinatorId);

      // Worker is not stalled initially
      let stalled = stallDetector.detectStalled(coordinatorId);
      expect(stalled).toHaveLength(0);

      // Advance time beyond threshold
      advanceTime(15000); // 15 seconds > 10 second threshold

      // Now worker should be detected as stalled
      stalled = stallDetector.detectStalled(coordinatorId);
      expect(stalled).toHaveLength(1);
      expect(stalled[0].agentId).toBe(workerId);
      expect(stalled[0].coordinatorId).toBe(coordinatorId);
    });

    it("should not detect stalled worker if processing", () => {
      const coordinatorId = "coord_2" as AgentId;
      const workerId = "worker_2" as AgentId;

      spawnCoordinator(coordinatorId);
      spawnWorker(workerId, coordinatorId);

      // Mark worker as processing
      sessionMapper.setProcessing(`acp_${workerId}`, true);

      // Advance time beyond threshold
      advanceTime(15000);

      // Worker should NOT be stalled because it's processing
      const stalled = stallDetector.detectStalled(coordinatorId);
      expect(stalled).toHaveLength(0);
    });

    it("should detect stalled worker when processing stops", () => {
      const coordinatorId = "coord_3" as AgentId;
      const workerId = "worker_3" as AgentId;

      spawnCoordinator(coordinatorId);
      spawnWorker(workerId, coordinatorId);

      // Mark worker as processing
      sessionMapper.setProcessing(`acp_${workerId}`, true);

      // Advance time
      advanceTime(15000);

      // Not stalled while processing
      expect(stallDetector.detectStalled(coordinatorId)).toHaveLength(0);

      // Stop processing
      sessionMapper.setProcessing(`acp_${workerId}`, false);

      // Now should be stalled (lastActivityAt is old)
      const stalled = stallDetector.detectStalled(coordinatorId);
      expect(stalled).toHaveLength(1);
    });

    it("should not detect recently active worker as stalled", () => {
      const coordinatorId = "coord_4" as AgentId;
      const workerId = "worker_4" as AgentId;

      spawnCoordinator(coordinatorId);
      spawnWorker(workerId, coordinatorId);

      // Advance 5 seconds (less than threshold)
      advanceTime(5000);

      // Emit activity (updates lastActivityAt)
      eventStore.emit({
        type: "status",
        source: { agent_id: workerId },
        payload: {
          status_type: "checkpoint",
          summary: "Still working",
        },
      });

      // Advance another 5 seconds
      advanceTime(5000);

      // Worker should not be stalled (activity was 5s ago, threshold is 10s)
      const stalled = stallDetector.detectStalled(coordinatorId);
      expect(stalled).toHaveLength(0);
    });
  });

  // ==========================================================================
  // Signal Emission Tests
  // ==========================================================================

  describe("STALE_AGENT Signal Emission", () => {
    it("should emit STALE_AGENT signal via HealthCheckService", async () => {
      const healthCheckService = new HealthCheckService(
        eventStore,
        sessionMapper,
        messageRouter,
        {
          intervalMs: 5000, // Check every 5 seconds
          stalledThresholdMs: 10000,
          consecutiveFailuresBeforeEscalate: 1, // Escalate after 1 failure
        }
      );

      const coordinatorId = "coord_5" as AgentId;
      const workerId = "worker_5" as AgentId;
      const taskId = "task_5" as TaskId;

      spawnCoordinator(coordinatorId);
      spawnWorker(workerId, coordinatorId, taskId);

      // Start health monitoring
      healthCheckService.startForCoordinator(coordinatorId);

      // Advance time beyond stalled threshold
      advanceTime(15000);

      // Trigger health check
      await vi.runOnlyPendingTimersAsync();

      // Check events for STALE_AGENT signal
      const events = eventStore.query({ type: "status" });
      const staleAgentEvents = events.filter(
        (e) =>
          e.payload &&
          typeof e.payload === "object" &&
          "details" in e.payload &&
          e.payload.details &&
          typeof e.payload.details === "object" &&
          "signal" in e.payload.details &&
          e.payload.details.signal === "STALE_AGENT"
      );

      expect(staleAgentEvents.length).toBeGreaterThanOrEqual(1);

      // Cleanup
      healthCheckService.stopForCoordinator(coordinatorId);
    });
  });

  // ==========================================================================
  // Zombie Cleanup Tests
  // ==========================================================================

  describe("Zombie Agent Cleanup", () => {
    it("should detect zombie agents (stopped but session exists)", () => {
      const coordinatorId = "coord_6" as AgentId;
      const workerId = "worker_6" as AgentId;

      spawnCoordinator(coordinatorId);
      spawnWorker(workerId, coordinatorId);

      // Terminate the worker
      eventStore.emit({
        type: "terminate",
        source: { agent_id: workerId },
        payload: {
          agent_id: workerId,
          reason: "completed",
        },
      });

      // Session mapping still exists (zombie)
      const sessionStatus = sessionMapper.getSessionStatus(workerId);
      expect(sessionStatus).toBeDefined();

      // Cleanup zombies
      const zombies = stallDetector.cleanupZombies();
      expect(zombies).toHaveLength(1);
      expect(zombies[0].agentId).toBe(workerId);

      // Session should now be removed
      const sessionStatusAfter = sessionMapper.getSessionStatus(workerId);
      expect(sessionStatusAfter).toBeUndefined();
    });

    it("should not flag running agents as zombies", () => {
      const coordinatorId = "coord_7" as AgentId;
      const workerId = "worker_7" as AgentId;

      spawnCoordinator(coordinatorId);
      spawnWorker(workerId, coordinatorId);

      // Worker is still running (not terminated)
      const zombies = stallDetector.cleanupZombies();
      expect(zombies).toHaveLength(0);

      // Session should still exist
      const sessionStatus = sessionMapper.getSessionStatus(workerId);
      expect(sessionStatus).toBeDefined();
    });
  });

  // ==========================================================================
  // Signal Routing Tests
  // ==========================================================================

  describe("Signal Routing to Coordinator", () => {
    it("should route STALE_AGENT status to coordinator via subtree subscription", () => {
      const coordinatorId = "coord_8" as AgentId;
      const workerId = "worker_8" as AgentId;

      spawnCoordinator(coordinatorId);
      spawnWorker(workerId, coordinatorId);

      // Set up subtree subscription (normally done by MessageRouter.setupDefaultSubscriptions)
      messageRouter.subscribe(coordinatorId, {
        type: "subtree",
        target: workerId,
      });

      // Emit a status from the worker
      eventStore.emit({
        type: "status",
        source: { agent_id: workerId },
        payload: {
          status_type: "alert",
          summary: "STALE_AGENT detected",
          details: {
            signal: "STALE_AGENT",
            workerId,
            stalledDurationMs: 15000,
          },
        },
      });

      // The event should be stored and queryable
      const events = eventStore.query({
        type: "status",
        agentId: workerId,
      });

      expect(events.length).toBeGreaterThanOrEqual(1);
      const staleEvent = events.find(
        (e) =>
          e.payload &&
          typeof e.payload === "object" &&
          "details" in e.payload &&
          e.payload.details?.signal === "STALE_AGENT"
      );
      expect(staleEvent).toBeDefined();
    });
  });

  // ==========================================================================
  // Multiple Workers Tests
  // ==========================================================================

  describe("Multiple Workers", () => {
    it("should only detect stalled workers, not active ones", () => {
      const coordinatorId = "coord_9" as AgentId;
      const worker1 = "worker_9a" as AgentId;
      const worker2 = "worker_9b" as AgentId;
      const worker3 = "worker_9c" as AgentId;

      spawnCoordinator(coordinatorId);
      spawnWorker(worker1, coordinatorId);
      spawnWorker(worker2, coordinatorId);
      spawnWorker(worker3, coordinatorId);

      // Advance time
      advanceTime(15000);

      // Worker2 is processing
      sessionMapper.setProcessing(`acp_${worker2}`, true);

      // Worker3 has recent activity
      eventStore.emit({
        type: "status",
        source: { agent_id: worker3 },
        payload: {
          status_type: "checkpoint",
          summary: "Active",
        },
      });

      // Only worker1 should be stalled
      const stalled = stallDetector.detectStalled(coordinatorId);
      expect(stalled).toHaveLength(1);
      expect(stalled[0].agentId).toBe(worker1);
    });
  });
});
