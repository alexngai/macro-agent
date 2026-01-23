/**
 * Tests for StallDetector
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { StallDetector, DEFAULT_STALL_DETECTOR_CONFIG } from "../stall-detector.js";
import type { EventStore } from "../../store/event-store.js";
import type { SessionMapper } from "../../acp/session-mapper.js";
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
    created_at: Date.now() - 60000, // 1 minute ago
    ...overrides,
  };
}

function createMockEventStore(agents: Agent[] = []): EventStore {
  return {
    listAgents: vi.fn((filter?: { parent?: string | null; state?: string }) => {
      return agents.filter((a) => {
        if (filter?.parent !== undefined && a.parent !== filter.parent) return false;
        if (filter?.state !== undefined && a.state !== filter.state) return false;
        return true;
      });
    }),
  } as unknown as EventStore;
}

function createMockSessionMapper(
  sessionStatuses: Map<string, { isProcessing: boolean; sessionId: string; lastProcessingChangeAt: number }> = new Map(),
  agentSessions: Map<string, string[]> = new Map()
): SessionMapper {
  return {
    getSessionStatus: vi.fn((agentId: string) => sessionStatuses.get(agentId)),
    getSessionsForAgent: vi.fn((agentId: string) => agentSessions.get(agentId) ?? []),
    removeMapping: vi.fn(),
  } as unknown as SessionMapper;
}

// =============================================================================
// Tests
// =============================================================================

describe("StallDetector", () => {
  describe("constructor", () => {
    it("should use default config when none provided", () => {
      const eventStore = createMockEventStore();
      const sessionMapper = createMockSessionMapper();

      const detector = new StallDetector(eventStore, sessionMapper);

      expect(detector.getConfig()).toEqual(DEFAULT_STALL_DETECTOR_CONFIG);
    });

    it("should merge provided config with defaults", () => {
      const eventStore = createMockEventStore();
      const sessionMapper = createMockSessionMapper();

      const detector = new StallDetector(eventStore, sessionMapper, {
        stalledThresholdMs: 5 * 60 * 1000, // 5 minutes
      });

      expect(detector.getConfig().stalledThresholdMs).toBe(5 * 60 * 1000);
    });
  });

  describe("detectStalled", () => {
    it("should return empty array when no workers under coordinator", () => {
      const eventStore = createMockEventStore([]);
      const sessionMapper = createMockSessionMapper();

      const detector = new StallDetector(eventStore, sessionMapper);
      const stalled = detector.detectStalled("coordinator_1");

      expect(stalled).toEqual([]);
    });

    it("should not detect active workers as stalled", () => {
      const recentActivity = Date.now() - 1000; // 1 second ago
      const worker = createMockAgent({
        id: "worker_1",
        parent: "coordinator_1",
        last_activity_at: recentActivity,
      });

      const eventStore = createMockEventStore([worker]);
      const sessionMapper = createMockSessionMapper();

      const detector = new StallDetector(eventStore, sessionMapper);
      const stalled = detector.detectStalled("coordinator_1");

      expect(stalled).toEqual([]);
    });

    it("should detect workers with stale activity as stalled", () => {
      const staleActivity = Date.now() - 15 * 60 * 1000; // 15 minutes ago
      const worker = createMockAgent({
        id: "worker_1",
        parent: "coordinator_1",
        last_activity_at: staleActivity,
        task_id: "task_1",
      });

      const eventStore = createMockEventStore([worker]);
      const sessionMapper = createMockSessionMapper();

      const detector = new StallDetector(eventStore, sessionMapper);
      const stalled = detector.detectStalled("coordinator_1");

      expect(stalled).toHaveLength(1);
      expect(stalled[0].agentId).toBe("worker_1");
      expect(stalled[0].coordinatorId).toBe("coordinator_1");
      expect(stalled[0].assignedTaskId).toBe("task_1");
      expect(stalled[0].sessionStatus).toBe("unknown");
      expect(stalled[0].stalledDurationMs).toBeGreaterThan(14 * 60 * 1000);
    });

    it("should not detect workers as stalled if they are processing", () => {
      const staleActivity = Date.now() - 15 * 60 * 1000; // 15 minutes ago
      const worker = createMockAgent({
        id: "worker_1",
        parent: "coordinator_1",
        last_activity_at: staleActivity,
      });

      const eventStore = createMockEventStore([worker]);
      const sessionStatuses = new Map([
        ["worker_1", { isProcessing: true, sessionId: "session_1", lastProcessingChangeAt: Date.now() }],
      ]);
      const sessionMapper = createMockSessionMapper(sessionStatuses);

      const detector = new StallDetector(eventStore, sessionMapper);
      const stalled = detector.detectStalled("coordinator_1");

      expect(stalled).toEqual([]);
    });

    it("should detect workers as stalled if session is idle", () => {
      const staleActivity = Date.now() - 15 * 60 * 1000; // 15 minutes ago
      const worker = createMockAgent({
        id: "worker_1",
        parent: "coordinator_1",
        last_activity_at: staleActivity,
      });

      const eventStore = createMockEventStore([worker]);
      const sessionStatuses = new Map([
        ["worker_1", { isProcessing: false, sessionId: "session_1", lastProcessingChangeAt: Date.now() }],
      ]);
      const sessionMapper = createMockSessionMapper(sessionStatuses);

      const detector = new StallDetector(eventStore, sessionMapper);
      const stalled = detector.detectStalled("coordinator_1");

      expect(stalled).toHaveLength(1);
      expect(stalled[0].sessionStatus).toBe("idle");
    });

    it("should use created_at as fallback when last_activity_at is not set", () => {
      const oldCreatedAt = Date.now() - 15 * 60 * 1000; // 15 minutes ago
      const worker = createMockAgent({
        id: "worker_1",
        parent: "coordinator_1",
        created_at: oldCreatedAt,
        // last_activity_at not set
      });

      const eventStore = createMockEventStore([worker]);
      const sessionMapper = createMockSessionMapper();

      const detector = new StallDetector(eventStore, sessionMapper);
      const stalled = detector.detectStalled("coordinator_1");

      expect(stalled).toHaveLength(1);
    });

    it("should respect custom stalledThresholdMs", () => {
      const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
      const worker = createMockAgent({
        id: "worker_1",
        parent: "coordinator_1",
        last_activity_at: fiveMinutesAgo,
      });

      const eventStore = createMockEventStore([worker]);
      const sessionMapper = createMockSessionMapper();

      // Default threshold is 10 minutes, so worker should not be stalled
      const detector1 = new StallDetector(eventStore, sessionMapper);
      expect(detector1.detectStalled("coordinator_1")).toHaveLength(0);

      // With 3 minute threshold, worker should be stalled
      const detector2 = new StallDetector(eventStore, sessionMapper, {
        stalledThresholdMs: 3 * 60 * 1000,
      });
      expect(detector2.detectStalled("coordinator_1")).toHaveLength(1);
    });

    it("should only detect running workers, not stopped ones", () => {
      const staleActivity = Date.now() - 15 * 60 * 1000;
      const runningWorker = createMockAgent({
        id: "worker_1",
        parent: "coordinator_1",
        state: "running",
        last_activity_at: staleActivity,
      });
      const stoppedWorker = createMockAgent({
        id: "worker_2",
        parent: "coordinator_1",
        state: "stopped",
        last_activity_at: staleActivity,
      });

      const eventStore = createMockEventStore([runningWorker, stoppedWorker]);
      const sessionMapper = createMockSessionMapper();

      const detector = new StallDetector(eventStore, sessionMapper);
      const stalled = detector.detectStalled("coordinator_1");

      expect(stalled).toHaveLength(1);
      expect(stalled[0].agentId).toBe("worker_1");
    });
  });

  describe("detectAllStalled", () => {
    it("should detect stalled agents across all coordinators", () => {
      const staleActivity = Date.now() - 15 * 60 * 1000;

      const coordinator1 = createMockAgent({
        id: "coordinator_1",
        role: "coordinator",
        parent: null,
      });
      const coordinator2 = createMockAgent({
        id: "coordinator_2",
        role: "coordinator",
        parent: null,
      });
      const worker1 = createMockAgent({
        id: "worker_1",
        parent: "coordinator_1",
        last_activity_at: staleActivity,
      });
      const worker2 = createMockAgent({
        id: "worker_2",
        parent: "coordinator_2",
        last_activity_at: staleActivity,
      });

      const eventStore = createMockEventStore([
        coordinator1,
        coordinator2,
        worker1,
        worker2,
      ]);
      const sessionMapper = createMockSessionMapper();

      const detector = new StallDetector(eventStore, sessionMapper);
      const stalled = detector.detectAllStalled();

      expect(stalled).toHaveLength(2);
      expect(stalled.map((s) => s.agentId).sort()).toEqual(["worker_1", "worker_2"]);
    });
  });

  describe("cleanupZombies", () => {
    it("should return empty array when no zombies exist", () => {
      const eventStore = createMockEventStore([]);
      const sessionMapper = createMockSessionMapper();

      const detector = new StallDetector(eventStore, sessionMapper);
      const zombies = detector.cleanupZombies();

      expect(zombies).toEqual([]);
    });

    it("should detect and clean up zombie agents", () => {
      const stoppedAgent = createMockAgent({
        id: "agent_1",
        state: "stopped",
        stop_reason: "completed",
        stopped_at: Date.now() - 1000,
      });

      const eventStore = createMockEventStore([stoppedAgent]);
      const agentSessions = new Map([["agent_1", ["session_1"]]]);
      const sessionMapper = createMockSessionMapper(new Map(), agentSessions);

      const detector = new StallDetector(eventStore, sessionMapper);
      const zombies = detector.cleanupZombies();

      expect(zombies).toHaveLength(1);
      expect(zombies[0].agentId).toBe("agent_1");
      expect(zombies[0].acpSessionId).toBe("session_1");
      expect(zombies[0].reason).toBe("done_called");
      expect(sessionMapper.removeMapping).toHaveBeenCalledWith("session_1");
    });

    it("should not report stopped agents without sessions as zombies", () => {
      const stoppedAgent = createMockAgent({
        id: "agent_1",
        state: "stopped",
      });

      const eventStore = createMockEventStore([stoppedAgent]);
      const sessionMapper = createMockSessionMapper();

      const detector = new StallDetector(eventStore, sessionMapper);
      const zombies = detector.cleanupZombies();

      expect(zombies).toEqual([]);
    });

    it("should correctly identify stop reasons", () => {
      const agentCompleted = createMockAgent({
        id: "agent_1",
        state: "stopped",
        stop_reason: "completed",
      });
      const agentCancelled = createMockAgent({
        id: "agent_2",
        state: "stopped",
        stop_reason: "cancelled",
      });
      const agentStopped = createMockAgent({
        id: "agent_3",
        state: "stopped",
        stop_reason: "stopped",
      });

      const eventStore = createMockEventStore([agentCompleted, agentCancelled, agentStopped]);
      const agentSessions = new Map([
        ["agent_1", ["session_1"]],
        ["agent_2", ["session_2"]],
        ["agent_3", ["session_3"]],
      ]);
      const sessionMapper = createMockSessionMapper(new Map(), agentSessions);

      const detector = new StallDetector(eventStore, sessionMapper);
      const zombies = detector.cleanupZombies();

      expect(zombies).toHaveLength(3);

      const byId = new Map(zombies.map((z) => [z.agentId, z]));
      expect(byId.get("agent_1")?.reason).toBe("done_called");
      expect(byId.get("agent_2")?.reason).toBe("parent_terminated");
      expect(byId.get("agent_3")?.reason).toBe("parent_terminated");
    });

    it("should clean up all sessions for a zombie agent", () => {
      const stoppedAgent = createMockAgent({
        id: "agent_1",
        state: "stopped",
      });

      const eventStore = createMockEventStore([stoppedAgent]);
      const agentSessions = new Map([["agent_1", ["session_1", "session_2", "session_3"]]]);
      const sessionMapper = createMockSessionMapper(new Map(), agentSessions);

      const detector = new StallDetector(eventStore, sessionMapper);
      detector.cleanupZombies();

      expect(sessionMapper.removeMapping).toHaveBeenCalledTimes(3);
      expect(sessionMapper.removeMapping).toHaveBeenCalledWith("session_1");
      expect(sessionMapper.removeMapping).toHaveBeenCalledWith("session_2");
      expect(sessionMapper.removeMapping).toHaveBeenCalledWith("session_3");
    });
  });

  describe("updateConfig", () => {
    it("should update configuration", () => {
      const eventStore = createMockEventStore();
      const sessionMapper = createMockSessionMapper();

      const detector = new StallDetector(eventStore, sessionMapper);
      expect(detector.getConfig().stalledThresholdMs).toBe(10 * 60 * 1000);

      detector.updateConfig({ stalledThresholdMs: 5 * 60 * 1000 });
      expect(detector.getConfig().stalledThresholdMs).toBe(5 * 60 * 1000);
    });
  });
});
