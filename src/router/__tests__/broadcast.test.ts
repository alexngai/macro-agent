/**
 * Tests for broadcast channel resolution
 *
 * @see s-9rld In-Flight Steering spec
 */

import { describe, it, expect } from "vitest";
import {
  matchesBroadcastScope,
  getBroadcastRecipients,
  resolveBroadcastTarget,
  type BroadcastAgentSource,
} from "../broadcast.js";

// ─────────────────────────────────────────────────────────────────────────────
// Test Helpers
// ─────────────────────────────────────────────────────────────────────────────

function createMockAgentSource(
  agents: Array<{ id: string; state: string; role?: string }>
): BroadcastAgentSource {
  return {
    listAgents: () => agents,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// matchesBroadcastScope
// ─────────────────────────────────────────────────────────────────────────────

describe("matchesBroadcastScope", () => {
  describe("scope: all", () => {
    it("should match any role", () => {
      expect(matchesBroadcastScope("worker", "all")).toBe(true);
      expect(matchesBroadcastScope("coordinator", "all")).toBe(true);
      expect(matchesBroadcastScope("monitor", "all")).toBe(true);
      expect(matchesBroadcastScope("integrator", "all")).toBe(true);
    });

    it("should match undefined role", () => {
      expect(matchesBroadcastScope(undefined, "all")).toBe(true);
    });
  });

  describe("scope: workers", () => {
    it("should match worker role", () => {
      expect(matchesBroadcastScope("worker", "workers")).toBe(true);
    });

    it("should match worker subroles", () => {
      expect(matchesBroadcastScope("worker.resolver", "workers")).toBe(true);
      expect(matchesBroadcastScope("worker.reviewer", "workers")).toBe(true);
    });

    it("should match undefined role (defaults to worker)", () => {
      expect(matchesBroadcastScope(undefined, "workers")).toBe(true);
    });

    it("should not match non-worker roles", () => {
      expect(matchesBroadcastScope("coordinator", "workers")).toBe(false);
      expect(matchesBroadcastScope("monitor", "workers")).toBe(false);
      expect(matchesBroadcastScope("integrator", "workers")).toBe(false);
    });
  });

  describe("scope: coordinators", () => {
    it("should match coordinator role", () => {
      expect(matchesBroadcastScope("coordinator", "coordinators")).toBe(true);
    });

    it("should match coordinator subroles", () => {
      expect(matchesBroadcastScope("coordinator.lead", "coordinators")).toBe(true);
    });

    it("should not match non-coordinator roles", () => {
      expect(matchesBroadcastScope("worker", "coordinators")).toBe(false);
      expect(matchesBroadcastScope("monitor", "coordinators")).toBe(false);
      expect(matchesBroadcastScope(undefined, "coordinators")).toBe(false);
    });
  });

  describe("scope: monitors", () => {
    it("should match monitor role", () => {
      expect(matchesBroadcastScope("monitor", "monitors")).toBe(true);
    });

    it("should match monitor subroles", () => {
      expect(matchesBroadcastScope("monitor.health", "monitors")).toBe(true);
    });

    it("should not match non-monitor roles", () => {
      expect(matchesBroadcastScope("worker", "monitors")).toBe(false);
      expect(matchesBroadcastScope("coordinator", "monitors")).toBe(false);
      expect(matchesBroadcastScope(undefined, "monitors")).toBe(false);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getBroadcastRecipients
// ─────────────────────────────────────────────────────────────────────────────

describe("getBroadcastRecipients", () => {
  const agents = [
    { id: "agent-1", state: "running", role: "worker" },
    { id: "agent-2", state: "running", role: "worker.resolver" },
    { id: "agent-3", state: "running", role: "coordinator" },
    { id: "agent-4", state: "running", role: "monitor" },
    { id: "agent-5", state: "stopped", role: "worker" },
    { id: "agent-6", state: "running", role: undefined },
  ];

  const agentSource = createMockAgentSource(agents);

  it("should return all running agents for scope 'all'", () => {
    const recipients = getBroadcastRecipients(agentSource, "all");
    expect(recipients).toEqual([
      "agent-1",
      "agent-2",
      "agent-3",
      "agent-4",
      "agent-6",
    ]);
  });

  it("should return all running agents when scope is undefined", () => {
    const recipients = getBroadcastRecipients(agentSource);
    expect(recipients).toEqual([
      "agent-1",
      "agent-2",
      "agent-3",
      "agent-4",
      "agent-6",
    ]);
  });

  it("should return only workers for scope 'workers'", () => {
    const recipients = getBroadcastRecipients(agentSource, "workers");
    expect(recipients).toEqual(["agent-1", "agent-2", "agent-6"]);
  });

  it("should return only coordinators for scope 'coordinators'", () => {
    const recipients = getBroadcastRecipients(agentSource, "coordinators");
    expect(recipients).toEqual(["agent-3"]);
  });

  it("should return only monitors for scope 'monitors'", () => {
    const recipients = getBroadcastRecipients(agentSource, "monitors");
    expect(recipients).toEqual(["agent-4"]);
  });

  it("should exclude stopped agents", () => {
    const recipients = getBroadcastRecipients(agentSource, "workers");
    expect(recipients).not.toContain("agent-5");
  });

  it("should return empty array when no agents match", () => {
    const emptySource = createMockAgentSource([]);
    const recipients = getBroadcastRecipients(emptySource, "all");
    expect(recipients).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// resolveBroadcastTarget
// ─────────────────────────────────────────────────────────────────────────────

describe("resolveBroadcastTarget", () => {
  const agents = [
    { id: "agent-1", state: "running", role: "worker" },
    { id: "agent-2", state: "running", role: "coordinator" },
  ];

  const agentSource = createMockAgentSource(agents);

  it("should resolve broadcast target with scope", () => {
    const recipients = resolveBroadcastTarget(agentSource, { scope: "workers" });
    expect(recipients).toEqual(["agent-1"]);
  });

  it("should resolve broadcast target without scope (defaults to all)", () => {
    const recipients = resolveBroadcastTarget(agentSource, {});
    expect(recipients).toEqual(["agent-1", "agent-2"]);
  });
});
