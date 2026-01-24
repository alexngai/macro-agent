/**
 * Tests for activity watcher
 *
 * @see s-9rld In-Flight Steering spec
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createActivityWatcher,
  subscribeAgentToEvents,
  type ActivityWatcher,
} from "../watcher.js";
import type { Activity, WakeResult } from "../types.js";
import type { RelevanceAgentSource } from "../relevance.js";

// ─────────────────────────────────────────────────────────────────────────────
// Test Helpers
// ─────────────────────────────────────────────────────────────────────────────

function createMockAgentSource(): RelevanceAgentSource {
  const agents = [
    { id: "coord-1", state: "running", role: "coordinator", lineage: [] },
    { id: "worker-1", state: "running", role: "worker", lineage: ["coord-1"] },
    { id: "monitor-1", state: "running", role: "monitor", lineage: [] },
  ];
  return {
    listAgents: () => agents,
    getAgent: (id) => agents.find((a) => a.id === id) ?? null,
  };
}

function createActivity(type: string, sourceAgentId?: string): Activity {
  return {
    id: `evt-${Math.random().toString(36).slice(2)}`,
    type,
    source: { agent_id: sourceAgentId },
    timestamp: Date.now(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// createActivityWatcher
// ─────────────────────────────────────────────────────────────────────────────

describe("createActivityWatcher", () => {
  let watcher: ActivityWatcher;
  let mockWakeHandler: ReturnType<typeof vi.fn>;
  let agentSource: RelevanceAgentSource;

  beforeEach(() => {
    agentSource = createMockAgentSource();
    mockWakeHandler = vi.fn().mockResolvedValue({ success: true, method: "wake" });
    watcher = createActivityWatcher(agentSource, mockWakeHandler, {
      enableDeduplication: false,
    });
  });

  describe("lifecycle", () => {
    it("should start and stop", () => {
      expect(watcher.isRunning()).toBe(false);
      watcher.start();
      expect(watcher.isRunning()).toBe(true);
      watcher.stop();
      expect(watcher.isRunning()).toBe(false);
    });
  });

  describe("event types", () => {
    it("should get and set event types", () => {
      expect(watcher.getEventTypes()).toEqual([]);
      watcher.setEventTypes(["task_completed", "agent_terminated"]);
      expect(watcher.getEventTypes()).toEqual(["task_completed", "agent_terminated"]);
    });
  });

  describe("subscriptions", () => {
    it("should subscribe agent to events", () => {
      watcher.subscribe({
        agentId: "monitor-1",
        eventTypes: ["agent_terminated"],
      });

      const subs = watcher.getSubscriptions("monitor-1");
      expect(subs).toHaveLength(1);
      expect(subs[0].eventTypes).toContain("agent_terminated");
    });

    it("should unsubscribe agent from all events", () => {
      watcher.subscribe({
        agentId: "monitor-1",
        eventTypes: ["agent_terminated"],
      });
      watcher.unsubscribe("monitor-1");

      expect(watcher.getSubscriptions("monitor-1")).toEqual([]);
    });

    it("should not duplicate subscriptions", () => {
      watcher.subscribe({
        agentId: "monitor-1",
        eventTypes: ["agent_terminated"],
      });
      watcher.subscribe({
        agentId: "monitor-1",
        eventTypes: ["agent_terminated"],
      });

      expect(watcher.getSubscriptions("monitor-1")).toHaveLength(1);
    });
  });

  describe("processActivity", () => {
    it("should not wake agents when not running", async () => {
      watcher.subscribe({
        agentId: "monitor-1",
        eventTypes: ["task_completed"],
      });

      const activity = createActivity("task_completed", "worker-1");
      const results = await watcher.processActivity(activity);

      expect(results).toEqual([]);
      expect(mockWakeHandler).not.toHaveBeenCalled();
    });

    it("should wake subscribed agents when running", async () => {
      watcher.start();
      watcher.subscribe({
        agentId: "monitor-1",
        eventTypes: ["task_completed"],
      });

      const activity = createActivity("task_completed", "worker-1");
      await watcher.processActivity(activity);

      expect(mockWakeHandler).toHaveBeenCalledWith(
        "monitor-1",
        activity,
        "normal"
      );
    });

    it("should not wake subscribed agents for non-matching event types", async () => {
      watcher.start();
      watcher.subscribe({
        agentId: "monitor-1",
        eventTypes: ["task_failed"],
      });

      // Use monitor-1 as source (no ancestors) so only subscriptions can trigger wakes
      const activity = createActivity("task_completed", "monitor-1");
      await watcher.processActivity(activity);

      // monitor-1 subscribed to task_failed, but event is task_completed - no wake
      expect(mockWakeHandler).not.toHaveBeenCalled();
    });

    it("should filter by watched event types", async () => {
      watcher.start();
      watcher.setEventTypes(["task_failed"]);
      watcher.subscribe({
        agentId: "monitor-1",
        eventTypes: [], // All events
      });

      const activity = createActivity("task_completed", "worker-1");
      await watcher.processActivity(activity);

      expect(mockWakeHandler).not.toHaveBeenCalled();
    });

    it("should wake ancestors via lineage", async () => {
      watcher.start();

      // Worker-1 has coord-1 in lineage, so coord-1 should be notified
      const activity = createActivity("task_completed", "worker-1");
      await watcher.processActivity(activity);

      expect(mockWakeHandler).toHaveBeenCalledWith(
        "coord-1",
        activity,
        "normal"
      );
    });

    it("should return results from wake handler", async () => {
      watcher.start();
      watcher.subscribe({
        agentId: "monitor-1",
        eventTypes: ["task_completed"],
      });

      mockWakeHandler.mockResolvedValue({ success: true, method: "inject" });

      const activity = createActivity("task_completed", "worker-1");
      const results = await watcher.processActivity(activity);

      expect(results.some((r) => r.method === "inject")).toBe(true);
    });

    it("should handle wake handler errors", async () => {
      watcher.start();
      watcher.subscribe({
        agentId: "monitor-1",
        eventTypes: ["task_completed"],
      });

      mockWakeHandler.mockRejectedValue(new Error("Wake failed"));

      const activity = createActivity("task_completed", "worker-1");
      const results = await watcher.processActivity(activity);

      expect(results.some((r) => r.success === false)).toBe(true);
    });
  });

  describe("activity listeners", () => {
    it("should notify activity listeners", async () => {
      const listener = vi.fn();
      watcher.addActivityListener(listener);

      const activity = createActivity("task_completed", "worker-1");
      await watcher.processActivity(activity);

      expect(listener).toHaveBeenCalledWith(activity);
    });

    it("should remove activity listener", async () => {
      const listener = vi.fn();
      const unsubscribe = watcher.addActivityListener(listener);
      unsubscribe();

      const activity = createActivity("task_completed", "worker-1");
      await watcher.processActivity(activity);

      expect(listener).not.toHaveBeenCalled();
    });

    it("should continue on listener error", async () => {
      const badListener = vi.fn().mockImplementation(() => {
        throw new Error("Listener failed");
      });
      const goodListener = vi.fn();

      watcher.addActivityListener(badListener);
      watcher.addActivityListener(goodListener);

      const activity = createActivity("task_completed", "worker-1");
      await watcher.processActivity(activity);

      expect(goodListener).toHaveBeenCalled();
    });
  });

  describe("relevance rules", () => {
    it("should use custom relevance rules", async () => {
      watcher.start();

      // Add a custom rule that always returns monitor-1
      const customRule = vi.fn().mockReturnValue(["monitor-1"]);
      watcher.addRelevanceRule(customRule);

      const activity = createActivity("custom_event", "unknown-agent");
      await watcher.processActivity(activity);

      expect(customRule).toHaveBeenCalledWith(activity);
      expect(mockWakeHandler).toHaveBeenCalledWith(
        "monitor-1",
        activity,
        "normal"
      );
    });

    it("should remove custom relevance rules", async () => {
      watcher.start();

      const customRule = vi.fn().mockReturnValue(["monitor-1"]);
      watcher.addRelevanceRule(customRule);
      watcher.removeRelevanceRule(customRule);

      const activity = createActivity("custom_event", "unknown-agent");
      await watcher.processActivity(activity);

      expect(customRule).not.toHaveBeenCalled();
    });
  });

  describe("deduplication", () => {
    it("should deduplicate when enabled", async () => {
      const watcherWithDedup = createActivityWatcher(agentSource, mockWakeHandler, {
        enableDeduplication: true,
        deduplicationWindowMs: 1000,
      });
      watcherWithDedup.start();
      watcherWithDedup.subscribe({
        agentId: "monitor-1",
        eventTypes: ["task_completed"],
      });

      const activity1 = createActivity("task_completed", "worker-1");
      const activity2 = createActivity("task_completed", "worker-1");

      await watcherWithDedup.processActivity(activity1);
      await watcherWithDedup.processActivity(activity2);

      // Only called once due to deduplication
      expect(mockWakeHandler).toHaveBeenCalledTimes(2); // coord-1 + monitor-1 for first
    });

    it("should report dedup stats", () => {
      const watcherWithDedup = createActivityWatcher(agentSource, mockWakeHandler, {
        enableDeduplication: true,
      });

      const stats = watcherWithDedup.getStats();
      expect(stats).toEqual({ slots: 0, suppressed: 0 });
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// subscribeAgentToEvents helper
// ─────────────────────────────────────────────────────────────────────────────

describe("subscribeAgentToEvents", () => {
  it("should subscribe agent with scope", () => {
    const agentSource = createMockAgentSource();
    const mockWakeHandler = vi.fn().mockResolvedValue({ success: true });
    const watcher = createActivityWatcher(agentSource, mockWakeHandler);

    subscribeAgentToEvents(
      watcher,
      "monitor-1",
      ["agent_terminated", "task_failed"],
      { role: "worker" },
      "high"
    );

    const subs = watcher.getSubscriptions("monitor-1");
    expect(subs).toHaveLength(1);
    expect(subs[0].scope?.role).toBe("worker");
    expect(subs[0].priority).toBe("high");
  });
});
