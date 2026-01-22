/**
 * Tests for activity relevance detection
 *
 * @see s-9rld In-Flight Steering spec
 */

import { describe, it, expect } from "vitest";
import {
  findRelevantAgents,
  matchesRole,
  matchesSubscriptionScope,
  getAncestors,
  isInSubtree,
  getAgentsByRole,
  type RelevanceAgentSource,
  type RelevanceSubscriptionSource,
} from "../relevance.js";
import type { Activity, EventSubscription } from "../types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Test Helpers
// ─────────────────────────────────────────────────────────────────────────────

function createMockAgentSource(
  agents: Array<{ id: string; state: string; role?: string; lineage: string[] }>
): RelevanceAgentSource {
  return {
    listAgents: () => agents,
    getAgent: (id) => agents.find((a) => a.id === id) ?? null,
  };
}

function createMockSubscriptionSource(
  subscriptions: EventSubscription[]
): RelevanceSubscriptionSource {
  return {
    getSubscribers: (eventType) =>
      subscriptions.filter(
        (s) => s.eventTypes.length === 0 || s.eventTypes.includes(eventType)
      ),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// matchesRole
// ─────────────────────────────────────────────────────────────────────────────

describe("matchesRole", () => {
  it("should match exact role", () => {
    expect(matchesRole("worker", "worker")).toBe(true);
    expect(matchesRole("coordinator", "coordinator")).toBe(true);
  });

  it("should match subroles", () => {
    expect(matchesRole("worker.resolver", "worker")).toBe(true);
    expect(matchesRole("coordinator.lead", "coordinator")).toBe(true);
  });

  it("should not match different roles", () => {
    expect(matchesRole("worker", "coordinator")).toBe(false);
  });

  it("should treat undefined role as worker", () => {
    expect(matchesRole(undefined, "worker")).toBe(true);
    expect(matchesRole(undefined, "coordinator")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// matchesSubscriptionScope
// ─────────────────────────────────────────────────────────────────────────────

describe("matchesSubscriptionScope", () => {
  const agents = [
    { id: "coord-1", state: "running", role: "coordinator", lineage: [] },
    { id: "worker-1", state: "running", role: "worker", lineage: ["coord-1"] },
    { id: "worker-2", state: "running", role: "worker.resolver", lineage: ["coord-1"] },
  ];
  const agentSource = createMockAgentSource(agents);

  it("should match when no scope filter", () => {
    const activity: Activity = {
      id: "evt-1",
      type: "task_completed",
      source: { agent_id: "worker-1" },
      timestamp: Date.now(),
    };
    const subscription: EventSubscription = {
      agentId: "coord-1",
      eventTypes: ["task_completed"],
    };

    expect(matchesSubscriptionScope(activity, subscription, agentSource)).toBe(true);
  });

  it("should filter by role scope", () => {
    const activity: Activity = {
      id: "evt-1",
      type: "task_completed",
      source: { agent_id: "worker-1", role: "worker" },
      timestamp: Date.now(),
    };
    const subscriptionMatch: EventSubscription = {
      agentId: "coord-1",
      eventTypes: ["task_completed"],
      scope: { role: "worker" },
    };
    const subscriptionNoMatch: EventSubscription = {
      agentId: "coord-1",
      eventTypes: ["task_completed"],
      scope: { role: "coordinator" },
    };

    expect(matchesSubscriptionScope(activity, subscriptionMatch, agentSource)).toBe(true);
    expect(matchesSubscriptionScope(activity, subscriptionNoMatch, agentSource)).toBe(false);
  });

  it("should filter by target agent scope", () => {
    const activity: Activity = {
      id: "evt-1",
      type: "message_received",
      source: { agent_id: "worker-1" },
      target: { type: "agent", target: "coord-1" },
      timestamp: Date.now(),
    };
    const subscriptionMatch: EventSubscription = {
      agentId: "coord-1",
      eventTypes: ["message_received"],
      scope: { targetAgent: "coord-1" },
    };
    const subscriptionNoMatch: EventSubscription = {
      agentId: "coord-1",
      eventTypes: ["message_received"],
      scope: { targetAgent: "worker-2" },
    };

    expect(matchesSubscriptionScope(activity, subscriptionMatch, agentSource)).toBe(true);
    expect(matchesSubscriptionScope(activity, subscriptionNoMatch, agentSource)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getAncestors
// ─────────────────────────────────────────────────────────────────────────────

describe("getAncestors", () => {
  const agents = [
    { id: "root", state: "running", role: "coordinator", lineage: [] },
    { id: "child", state: "running", role: "worker", lineage: ["root"] },
    { id: "grandchild", state: "running", role: "worker", lineage: ["root", "child"] },
  ];
  const agentSource = createMockAgentSource(agents);

  it("should return empty for root agent", () => {
    expect(getAncestors("root", agentSource)).toEqual([]);
  });

  it("should return parent for child agent", () => {
    expect(getAncestors("child", agentSource)).toEqual(["root"]);
  });

  it("should return full lineage for grandchild", () => {
    expect(getAncestors("grandchild", agentSource)).toEqual(["root", "child"]);
  });

  it("should return empty for unknown agent", () => {
    expect(getAncestors("unknown", agentSource)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// isInSubtree
// ─────────────────────────────────────────────────────────────────────────────

describe("isInSubtree", () => {
  const agents = [
    { id: "root", state: "running", role: "coordinator", lineage: [] },
    { id: "child", state: "running", role: "worker", lineage: ["root"] },
    { id: "grandchild", state: "running", role: "worker", lineage: ["root", "child"] },
    { id: "other", state: "running", role: "worker", lineage: [] },
  ];
  const agentSource = createMockAgentSource(agents);

  it("should return true for self", () => {
    expect(isInSubtree("root", "root", agentSource)).toBe(true);
  });

  it("should return true for direct child", () => {
    expect(isInSubtree("child", "root", agentSource)).toBe(true);
  });

  it("should return true for grandchild", () => {
    expect(isInSubtree("grandchild", "root", agentSource)).toBe(true);
  });

  it("should return false for unrelated agent", () => {
    expect(isInSubtree("other", "root", agentSource)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getAgentsByRole
// ─────────────────────────────────────────────────────────────────────────────

describe("getAgentsByRole", () => {
  const agents = [
    { id: "coord-1", state: "running", role: "coordinator", lineage: [] },
    { id: "worker-1", state: "running", role: "worker", lineage: [] },
    { id: "worker-2", state: "running", role: "worker.resolver", lineage: [] },
    { id: "worker-3", state: "stopped", role: "worker", lineage: [] },
  ];
  const agentSource = createMockAgentSource(agents);

  it("should return all workers (including subroles)", () => {
    const workers = getAgentsByRole("worker", agentSource);
    expect(workers).toContain("worker-1");
    expect(workers).toContain("worker-2");
    expect(workers).not.toContain("worker-3"); // stopped
  });

  it("should return coordinators", () => {
    const coords = getAgentsByRole("coordinator", agentSource);
    expect(coords).toEqual(["coord-1"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// findRelevantAgents
// ─────────────────────────────────────────────────────────────────────────────

describe("findRelevantAgents", () => {
  const agents = [
    { id: "coord-1", state: "running", role: "coordinator", lineage: [] },
    { id: "worker-1", state: "running", role: "worker", lineage: ["coord-1"] },
    { id: "worker-2", state: "running", role: "worker", lineage: ["coord-1"] },
    { id: "monitor-1", state: "running", role: "monitor", lineage: [] },
  ];
  const agentSource = createMockAgentSource(agents);

  it("should find ancestors by lineage", () => {
    const activity: Activity = {
      id: "evt-1",
      type: "task_completed",
      source: { agent_id: "worker-1" },
      timestamp: Date.now(),
    };

    const relevant = findRelevantAgents(activity, agentSource, undefined, {
      includeLineage: true,
      includeRole: false,
      includeSubscriptions: false,
      includeTarget: false,
    });

    expect(relevant).toContain("coord-1");
    expect(relevant).not.toContain("worker-1"); // source is not relevant to itself
    expect(relevant).not.toContain("worker-2");
  });

  it("should find agents by role target", () => {
    const activity: Activity = {
      id: "evt-1",
      type: "message_received",
      source: { agent_id: "coord-1" },
      target: { type: "role", role: "worker" },
      timestamp: Date.now(),
    };

    const relevant = findRelevantAgents(activity, agentSource, undefined, {
      includeLineage: false,
      includeRole: true,
      includeSubscriptions: false,
      includeTarget: false,
    });

    expect(relevant).toContain("worker-1");
    expect(relevant).toContain("worker-2");
    expect(relevant).not.toContain("coord-1");
  });

  it("should find agents by subscription", () => {
    const subscriptions: EventSubscription[] = [
      { agentId: "monitor-1", eventTypes: ["agent_terminated"] },
    ];
    const subscriptionSource = createMockSubscriptionSource(subscriptions);

    const activity: Activity = {
      id: "evt-1",
      type: "agent_terminated",
      source: { agent_id: "worker-1" },
      timestamp: Date.now(),
    };

    const relevant = findRelevantAgents(activity, agentSource, subscriptionSource, {
      includeLineage: false,
      includeRole: false,
      includeSubscriptions: true,
      includeTarget: false,
    });

    expect(relevant).toContain("monitor-1");
  });

  it("should find direct target agent", () => {
    const activity: Activity = {
      id: "evt-1",
      type: "message_received",
      source: { agent_id: "coord-1" },
      target: { type: "agent", target: "worker-1" },
      timestamp: Date.now(),
    };

    const relevant = findRelevantAgents(activity, agentSource, undefined, {
      includeLineage: false,
      includeRole: false,
      includeSubscriptions: false,
      includeTarget: true,
    });

    expect(relevant).toEqual(["worker-1"]);
  });

  it("should exclude stopped agents", () => {
    const agentsWithStopped = [
      ...agents,
      { id: "worker-3", state: "stopped", role: "worker", lineage: ["coord-1"] },
    ];
    const source = createMockAgentSource(agentsWithStopped);

    const activity: Activity = {
      id: "evt-1",
      type: "message_received",
      source: { agent_id: "coord-1" },
      target: { type: "role", role: "worker" },
      timestamp: Date.now(),
    };

    const relevant = findRelevantAgents(activity, source, undefined, {
      includeLineage: false,
      includeRole: true,
      includeSubscriptions: false,
      includeTarget: false,
    });

    expect(relevant).not.toContain("worker-3");
  });
});
