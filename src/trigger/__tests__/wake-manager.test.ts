/**
 * Wake Manager Tests
 *
 * Tests for the decoupled wake manager that handles
 * delivering queued events to agents.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createWakeManager } from "../wake/wake-manager.js";
import type { AgentId } from "../../store/types/index.js";

describe("WakeManager", () => {
  let mockDeps: ReturnType<typeof createMockDeps>;
  let wakeManager: ReturnType<typeof createWakeManager>;

  beforeEach(() => {
    vi.useFakeTimers();
    mockDeps = createMockDeps();
    wakeManager = createWakeManager(mockDeps, { enableLogging: false });
  });

  afterEach(() => {
    wakeManager.stop();
    vi.useRealTimers();
  });

  describe("lifecycle", () => {
    it("should start and stop", () => {
      expect(wakeManager.isRunning()).toBe(false);

      wakeManager.start();
      expect(wakeManager.isRunning()).toBe(true);

      wakeManager.stop();
      expect(wakeManager.isRunning()).toBe(false);
    });

    it("should be idempotent for start/stop", () => {
      wakeManager.start();
      wakeManager.start();
      expect(wakeManager.isRunning()).toBe(true);

      wakeManager.stop();
      wakeManager.stop();
      expect(wakeManager.isRunning()).toBe(false);
    });
  });

  describe("requestWakeNow", () => {
    it("should ignore wake requests when not running", () => {
      wakeManager.requestWakeNow({ reason: "test" });
      expect(wakeManager.hasPendingWake()).toBe(false);
    });

    it("should schedule wake when running", () => {
      wakeManager.start();
      wakeManager.requestWakeNow({ reason: "test" });
      expect(wakeManager.hasPendingWake()).toBe(true);
    });

    it("should coalesce multiple wake requests", () => {
      wakeManager.start();

      wakeManager.requestWakeNow({ reason: "first" });
      wakeManager.requestWakeNow({ reason: "second" });
      wakeManager.requestWakeNow({ reason: "third" });

      expect(wakeManager.hasPendingWake()).toBe(true);
      expect(wakeManager.getPendingReason()).toBe("first"); // First reason preserved
    });

    it("should run wake cycle after coalesce delay", async () => {
      mockDeps.systemEventQueue.getAgentsWithEvents = vi
        .fn()
        .mockReturnValue(["agent_1" as AgentId]);
      mockDeps.systemEventQueue.drainText = vi.fn().mockReturnValue(["Event 1"]);

      wakeManager.start();
      wakeManager.requestWakeNow({ reason: "test" });

      // Advance past default coalesce time (250ms)
      await vi.advanceTimersByTimeAsync(300);

      expect(mockDeps.systemEventQueue.drainText).toHaveBeenCalledWith(
        "agent_1",
        expect.any(Object)
      );
    });
  });

  describe("runWakeCycle", () => {
    it("should return skipped if wake in progress", async () => {
      wakeManager.start();

      // Start a long-running cycle
      mockDeps.systemEventQueue.getAgentsWithEvents = vi
        .fn()
        .mockReturnValue(["agent_1" as AgentId]);
      mockDeps.systemEventQueue.drainText = vi.fn().mockImplementation(() => {
        return new Promise((resolve) => setTimeout(() => resolve(["Event"]), 1000));
      });

      // Start first cycle
      const firstCyclePromise = wakeManager.runWakeCycle({ reason: "first" });

      // Try to start second cycle immediately
      const result = await wakeManager.runWakeCycle({ reason: "second" });

      expect(result.status).toBe("skipped");
      expect(result.reason).toBe("wake-in-progress");

      // Clean up
      await vi.runAllTimersAsync();
    });

    it("should deliver events to agents with inject", async () => {
      const mockSession = {
        supportsInject: vi.fn().mockReturnValue(true),
        inject: vi.fn().mockResolvedValue({ success: true }),
      };

      mockDeps.agentManager.getSession = vi.fn().mockReturnValue(mockSession);
      mockDeps.systemEventQueue.getAgentsWithEvents = vi
        .fn()
        .mockReturnValue(["agent_1" as AgentId]);
      mockDeps.systemEventQueue.drainText = vi.fn().mockReturnValue(["Event 1", "Event 2"]);

      wakeManager.start();
      const result = await wakeManager.runWakeCycle({ reason: "test" });

      expect(result.status).toBe("ran");
      expect(result.wokenAgents).toContain("agent_1");
      expect(mockSession.inject).toHaveBeenCalled();
    });

    it("should fall back to interrupt if inject fails", async () => {
      const mockIterator = {
        next: vi.fn().mockResolvedValue({ done: false, value: {} }),
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
      mockDeps.systemEventQueue.getAgentsWithEvents = vi
        .fn()
        .mockReturnValue(["agent_1" as AgentId]);
      mockDeps.systemEventQueue.drainText = vi.fn().mockReturnValue(["Event 1"]);

      wakeManager.start();
      const result = await wakeManager.runWakeCycle({ reason: "test" });

      expect(result.status).toBe("ran");
      expect(mockSession.interruptWith).toHaveBeenCalled();
    });

    it("should fall back to prompt if no session", async () => {
      mockDeps.agentManager.getSession = vi.fn().mockReturnValue(null);
      mockDeps.agentManager.get = vi.fn().mockReturnValue({ state: "running" });

      const mockPromptIterator = {
        next: vi.fn().mockResolvedValue({ done: true }),
        [Symbol.asyncIterator]: function () {
          return this;
        },
      };
      mockDeps.agentManager.prompt = vi.fn().mockReturnValue(mockPromptIterator);

      mockDeps.systemEventQueue.getAgentsWithEvents = vi
        .fn()
        .mockReturnValue(["agent_1" as AgentId]);
      mockDeps.systemEventQueue.drainText = vi.fn().mockReturnValue(["Event 1"]);

      wakeManager.start();
      const result = await wakeManager.runWakeCycle({ reason: "test" });

      expect(result.status).toBe("ran");
      expect(mockDeps.agentManager.prompt).toHaveBeenCalled();
    });

    it("should re-queue events if delivery fails", async () => {
      mockDeps.agentManager.getSession = vi.fn().mockReturnValue(null);
      mockDeps.agentManager.get = vi.fn().mockReturnValue({ state: "stopped" });

      mockDeps.systemEventQueue.getAgentsWithEvents = vi
        .fn()
        .mockReturnValue(["agent_1" as AgentId]);
      mockDeps.systemEventQueue.drainText = vi.fn().mockReturnValue(["Event 1"]);

      wakeManager.start();
      const result = await wakeManager.runWakeCycle({ reason: "test" });

      // Should have re-queued the event
      expect(mockDeps.systemEventQueue.enqueue).toHaveBeenCalledWith("Event 1", {
        agentId: "agent_1",
      });
      expect(result.status).toBe("failed");
    });

    it("should process multiple agents", async () => {
      const mockSession = {
        supportsInject: vi.fn().mockReturnValue(true),
        inject: vi.fn().mockResolvedValue({ success: true }),
      };

      mockDeps.agentManager.getSession = vi.fn().mockReturnValue(mockSession);
      mockDeps.systemEventQueue.getAgentsWithEvents = vi
        .fn()
        .mockReturnValue(["agent_1" as AgentId, "agent_2" as AgentId]);
      mockDeps.systemEventQueue.drainText = vi.fn().mockReturnValue(["Event"]);

      wakeManager.start();
      const result = await wakeManager.runWakeCycle({ reason: "test" });

      expect(result.status).toBe("ran");
      expect(result.wokenAgents).toHaveLength(2);
      expect(result.wokenAgents).toContain("agent_1");
      expect(result.wokenAgents).toContain("agent_2");
    });

    it("should handle empty queue gracefully", async () => {
      mockDeps.systemEventQueue.getAgentsWithEvents = vi.fn().mockReturnValue([]);

      wakeManager.start();
      const result = await wakeManager.runWakeCycle({ reason: "test" });

      expect(result.status).toBe("ran");
      expect(result.wokenAgents).toHaveLength(0);
    });
  });

  describe("heartbeat", () => {
    it("should not run heartbeat by default", async () => {
      mockDeps.systemEventQueue.getAgentsWithEvents = vi
        .fn()
        .mockReturnValue(["agent_1" as AgentId]);

      wakeManager.start();

      // Advance past default heartbeat interval (30s)
      await vi.advanceTimersByTimeAsync(35000);

      // No wake should have been triggered since heartbeat is disabled by default
      expect(wakeManager.hasPendingWake()).toBe(false);
    });

    it("should trigger wake on heartbeat when enabled", async () => {
      wakeManager = createWakeManager(mockDeps, {
        enableHeartbeat: true,
        heartbeatIntervalMs: 1000,
      });

      mockDeps.systemEventQueue.getAgentsWithEvents = vi
        .fn()
        .mockReturnValue(["agent_1" as AgentId]);
      mockDeps.systemEventQueue.drainText = vi.fn().mockReturnValue(["Event"]);

      const mockSession = {
        supportsInject: vi.fn().mockReturnValue(true),
        inject: vi.fn().mockResolvedValue({ success: true }),
      };
      mockDeps.agentManager.getSession = vi.fn().mockReturnValue(mockSession);

      wakeManager.start();

      // Advance past heartbeat interval
      await vi.advanceTimersByTimeAsync(1100);

      expect(wakeManager.hasPendingWake()).toBe(true);
    });

    it("should stop heartbeat on stop", () => {
      wakeManager = createWakeManager(mockDeps, {
        enableHeartbeat: true,
        heartbeatIntervalMs: 1000,
      });

      wakeManager.start();
      wakeManager.stop();

      // Heartbeat should be stopped
      expect(wakeManager.isRunning()).toBe(false);
    });
  });

  describe("pending reason tracking", () => {
    it("should track pending reason", () => {
      wakeManager.start();

      expect(wakeManager.getPendingReason()).toBeNull();

      wakeManager.requestWakeNow({ reason: "trigger:cron" });
      expect(wakeManager.getPendingReason()).toBe("trigger:cron");
    });

    it("should clear pending reason after cycle", async () => {
      mockDeps.systemEventQueue.getAgentsWithEvents = vi.fn().mockReturnValue([]);

      wakeManager.start();
      wakeManager.requestWakeNow({ reason: "test" });

      // Run the scheduled wake
      await vi.advanceTimersByTimeAsync(300);

      expect(wakeManager.getPendingReason()).toBeNull();
    });
  });
});

// =============================================================================
// Test Helpers
// =============================================================================

function createMockDeps() {
  return {
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
    systemEventQueue: {
      enqueue: vi.fn(),
      drainText: vi.fn().mockReturnValue([]),
      getAgentsWithEvents: vi.fn().mockReturnValue([]),
      getEventCount: vi.fn().mockReturnValue(0),
    } as any,
  };
}
