/**
 * Tests for activity deduplication
 *
 * @see s-9rld In-Flight Steering spec
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  ActivityDeduplicator,
  createDeduplicator,
} from "../deduplication.js";
import type { Activity } from "../types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Test Helpers
// ─────────────────────────────────────────────────────────────────────────────

function createActivity(
  type: string,
  sourceAgentId?: string
): Activity {
  return {
    id: `evt-${Math.random().toString(36).slice(2)}`,
    type,
    source: { agent_id: sourceAgentId },
    timestamp: Date.now(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// ActivityDeduplicator
// ─────────────────────────────────────────────────────────────────────────────

describe("ActivityDeduplicator", () => {
  let deduplicator: ActivityDeduplicator;

  beforeEach(() => {
    deduplicator = new ActivityDeduplicator({ windowMs: 1000 });
  });

  describe("shouldNotify", () => {
    it("should allow first notification", () => {
      const activity = createActivity("task_completed", "agent-1");
      expect(deduplicator.shouldNotify("target-1", activity)).toBe(true);
    });

    it("should suppress duplicate within window", () => {
      const activity1 = createActivity("task_completed", "agent-1");
      const activity2 = createActivity("task_completed", "agent-1");

      expect(deduplicator.shouldNotify("target-1", activity1)).toBe(true);
      expect(deduplicator.shouldNotify("target-1", activity2)).toBe(false);
    });

    it("should allow different event types", () => {
      const activity1 = createActivity("task_completed", "agent-1");
      const activity2 = createActivity("task_failed", "agent-1");

      expect(deduplicator.shouldNotify("target-1", activity1)).toBe(true);
      expect(deduplicator.shouldNotify("target-1", activity2)).toBe(true);
    });

    it("should allow different source agents", () => {
      const activity1 = createActivity("task_completed", "agent-1");
      const activity2 = createActivity("task_completed", "agent-2");

      expect(deduplicator.shouldNotify("target-1", activity1)).toBe(true);
      expect(deduplicator.shouldNotify("target-1", activity2)).toBe(true);
    });

    it("should allow different target agents", () => {
      const activity = createActivity("task_completed", "agent-1");

      expect(deduplicator.shouldNotify("target-1", activity)).toBe(true);
      expect(deduplicator.shouldNotify("target-2", activity)).toBe(true);
    });

    it("should allow after window expires", async () => {
      const dedup = new ActivityDeduplicator({ windowMs: 50 });
      const activity1 = createActivity("task_completed", "agent-1");
      const activity2 = createActivity("task_completed", "agent-1");

      expect(dedup.shouldNotify("target-1", activity1)).toBe(true);
      expect(dedup.shouldNotify("target-1", activity2)).toBe(false);

      // Wait for window to expire
      await new Promise((resolve) => setTimeout(resolve, 60));

      const activity3 = createActivity("task_completed", "agent-1");
      expect(dedup.shouldNotify("target-1", activity3)).toBe(true);
    });
  });

  describe("markNotified", () => {
    it("should update slot timestamp", () => {
      const activity = createActivity("task_completed", "agent-1");

      // First notification
      expect(deduplicator.shouldNotify("target-1", activity)).toBe(true);

      // Mark notified again (resets window)
      deduplicator.markNotified("target-1", activity);

      // Should still be suppressed
      const activity2 = createActivity("task_completed", "agent-1");
      expect(deduplicator.shouldNotify("target-1", activity2)).toBe(false);
    });
  });

  describe("getStats", () => {
    it("should track slot count", () => {
      const activity1 = createActivity("task_completed", "agent-1");
      const activity2 = createActivity("task_failed", "agent-1");

      deduplicator.shouldNotify("target-1", activity1);
      deduplicator.shouldNotify("target-1", activity2);

      const stats = deduplicator.getStats();
      expect(stats.totalSlots).toBe(2);
    });

    it("should track suppressed count", () => {
      const activity1 = createActivity("task_completed", "agent-1");
      const activity2 = createActivity("task_completed", "agent-1");
      const activity3 = createActivity("task_completed", "agent-1");

      deduplicator.shouldNotify("target-1", activity1);
      deduplicator.shouldNotify("target-1", activity2); // suppressed
      deduplicator.shouldNotify("target-1", activity3); // suppressed

      const stats = deduplicator.getStats();
      expect(stats.totalSuppressed).toBe(2);
    });
  });

  describe("clear", () => {
    it("should clear all slots", () => {
      const activity = createActivity("task_completed", "agent-1");
      deduplicator.shouldNotify("target-1", activity);

      expect(deduplicator.getStats().totalSlots).toBe(1);

      deduplicator.clear();

      expect(deduplicator.getStats().totalSlots).toBe(0);
    });

    it("should allow notifications after clear", () => {
      const activity1 = createActivity("task_completed", "agent-1");
      const activity2 = createActivity("task_completed", "agent-1");

      deduplicator.shouldNotify("target-1", activity1);
      deduplicator.clear();

      // Should now allow the same notification
      expect(deduplicator.shouldNotify("target-1", activity2)).toBe(true);
    });
  });

  describe("clearExpired", () => {
    it("should clear expired slots", async () => {
      const dedup = new ActivityDeduplicator({ windowMs: 50 });
      const activity1 = createActivity("task_completed", "agent-1");
      const activity2 = createActivity("task_failed", "agent-2");

      dedup.shouldNotify("target-1", activity1);

      // Wait for first to expire
      await new Promise((resolve) => setTimeout(resolve, 60));

      dedup.shouldNotify("target-1", activity2);

      // First should be expired, second should not
      const cleared = dedup.clearExpired();
      expect(cleared).toBe(1);
      expect(dedup.getStats().totalSlots).toBe(1);
    });
  });

  describe("LRU eviction", () => {
    it("should evict oldest entries when over max slots", () => {
      const dedup = new ActivityDeduplicator({ maxSlots: 3 });

      // Fill up slots
      dedup.shouldNotify("target-1", createActivity("event-1", "agent-1"));
      dedup.shouldNotify("target-1", createActivity("event-2", "agent-1"));
      dedup.shouldNotify("target-1", createActivity("event-3", "agent-1"));

      expect(dedup.getStats().totalSlots).toBe(3);

      // Add one more - should evict oldest
      dedup.shouldNotify("target-1", createActivity("event-4", "agent-1"));

      expect(dedup.getStats().totalSlots).toBe(3);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Wake Loop Prevention (E2E scenario from s-1zcx)
  // ─────────────────────────────────────────────────────────────────────────────

  describe("wake loop prevention", () => {
    it("should prevent 2-agent wake cycle (A→B→A)", () => {
      // Scenario: Agent A's activity wakes Agent B
      //           Agent B's activity would wake Agent A
      //           This could cause infinite loop without deduplication

      // Agent A triggers activity that would wake B
      const activityFromA = createActivity("task_completed", "agent-a");
      expect(deduplicator.shouldNotify("agent-b", activityFromA)).toBe(true);

      // Agent B reacts and triggers activity that would wake A
      const activityFromB = createActivity("task_completed", "agent-b");
      expect(deduplicator.shouldNotify("agent-a", activityFromB)).toBe(true);

      // If B's wake causes A to emit same type of activity back to B,
      // it should be suppressed (preventing the loop)
      const activityFromA2 = createActivity("task_completed", "agent-a");
      expect(deduplicator.shouldNotify("agent-b", activityFromA2)).toBe(false);
    });

    it("should prevent 3-agent wake cycle (A→B→C→A)", () => {
      // Scenario: A wakes B, B wakes C, C would wake A (cycle)

      // A → B
      expect(
        deduplicator.shouldNotify("agent-b", createActivity("status", "agent-a"))
      ).toBe(true);

      // B → C
      expect(
        deduplicator.shouldNotify("agent-c", createActivity("status", "agent-b"))
      ).toBe(true);

      // C → A
      expect(
        deduplicator.shouldNotify("agent-a", createActivity("status", "agent-c"))
      ).toBe(true);

      // Now if A tries to wake B again with same event type, it's suppressed
      expect(
        deduplicator.shouldNotify("agent-b", createActivity("status", "agent-a"))
      ).toBe(false);

      // Same for B → C
      expect(
        deduplicator.shouldNotify("agent-c", createActivity("status", "agent-b"))
      ).toBe(false);
    });

    it("should allow different event types even in cycle", () => {
      // A wakes B with "task_completed"
      expect(
        deduplicator.shouldNotify(
          "agent-b",
          createActivity("task_completed", "agent-a")
        )
      ).toBe(true);

      // B wakes A with "status" (different type - allowed)
      expect(
        deduplicator.shouldNotify("agent-a", createActivity("status", "agent-b"))
      ).toBe(true);

      // A can wake B with "status" (different type - allowed)
      expect(
        deduplicator.shouldNotify("agent-b", createActivity("status", "agent-a"))
      ).toBe(true);

      // But A cannot wake B with "task_completed" again (same type - suppressed)
      expect(
        deduplicator.shouldNotify(
          "agent-b",
          createActivity("task_completed", "agent-a")
        )
      ).toBe(false);
    });

    it("should track suppressed wake attempts for diagnostics", () => {
      // First round - allowed
      deduplicator.shouldNotify(
        "agent-b",
        createActivity("task_completed", "agent-a")
      );
      deduplicator.shouldNotify(
        "agent-a",
        createActivity("task_completed", "agent-b")
      );

      // Second round - suppressed (would be loop)
      deduplicator.shouldNotify(
        "agent-b",
        createActivity("task_completed", "agent-a")
      );
      deduplicator.shouldNotify(
        "agent-a",
        createActivity("task_completed", "agent-b")
      );

      const stats = deduplicator.getStats();
      expect(stats.totalSuppressed).toBe(2);
    });

    it("should resume allowing wakes after window expires", async () => {
      const dedup = new ActivityDeduplicator({ windowMs: 50 });

      // Initial wake cycle
      expect(
        dedup.shouldNotify("agent-b", createActivity("event", "agent-a"))
      ).toBe(true);
      expect(
        dedup.shouldNotify("agent-a", createActivity("event", "agent-b"))
      ).toBe(true);

      // Suppressed during window
      expect(
        dedup.shouldNotify("agent-b", createActivity("event", "agent-a"))
      ).toBe(false);

      // Wait for window to expire
      await new Promise((resolve) => setTimeout(resolve, 60));

      // Should now allow wake again
      expect(
        dedup.shouldNotify("agent-b", createActivity("event", "agent-a"))
      ).toBe(true);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// createDeduplicator
// ─────────────────────────────────────────────────────────────────────────────

describe("createDeduplicator", () => {
  it("should create deduplicator with default config", () => {
    const dedup = createDeduplicator();
    expect(dedup).toBeInstanceOf(ActivityDeduplicator);
  });

  it("should create deduplicator with custom config", () => {
    const dedup = createDeduplicator({ windowMs: 2000 });
    expect(dedup).toBeInstanceOf(ActivityDeduplicator);
  });
});
