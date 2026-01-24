/**
 * Tests for role channel resolution
 *
 * @see s-9rld In-Flight Steering spec
 */

import { describe, it, expect } from "vitest";
import {
  matchesRole,
  getSubtreeIds,
  resolveRoleTarget,
  getAgentsByRole,
  type RoleAgentSource,
} from "../role-resolver.js";

// ─────────────────────────────────────────────────────────────────────────────
// Test Helpers
// ─────────────────────────────────────────────────────────────────────────────

function createMockAgentSource(
  agents: Array<{ id: string; state: string; role?: string; lineage: string[] }>
): RoleAgentSource {
  return {
    listAgents: () => agents,
    getAgent: (id) => agents.find((a) => a.id === id) ?? null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// matchesRole
// ─────────────────────────────────────────────────────────────────────────────

describe("matchesRole", () => {
  it("should match exact role", () => {
    expect(matchesRole("worker", "worker")).toBe(true);
    expect(matchesRole("coordinator", "coordinator")).toBe(true);
    expect(matchesRole("monitor", "monitor")).toBe(true);
  });

  it("should match subroles (prefix match)", () => {
    expect(matchesRole("worker.resolver", "worker")).toBe(true);
    expect(matchesRole("worker.reviewer", "worker")).toBe(true);
    expect(matchesRole("coordinator.lead", "coordinator")).toBe(true);
  });

  it("should not match partial role names", () => {
    // "workerx" should not match "worker"
    expect(matchesRole("workerx", "worker")).toBe(false);
    // "workersub" should not match "worker" (no dot separator)
    expect(matchesRole("workersub", "worker")).toBe(false);
  });

  it("should not match different roles", () => {
    expect(matchesRole("worker", "coordinator")).toBe(false);
    expect(matchesRole("coordinator", "worker")).toBe(false);
    expect(matchesRole("monitor", "worker")).toBe(false);
  });

  it("should treat undefined role as worker", () => {
    expect(matchesRole(undefined, "worker")).toBe(true);
    expect(matchesRole(undefined, "coordinator")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getSubtreeIds
// ─────────────────────────────────────────────────────────────────────────────

describe("getSubtreeIds", () => {
  const agents = [
    { id: "coordinator-1", state: "running", role: "coordinator", lineage: [] },
    { id: "worker-1", state: "running", role: "worker", lineage: ["coordinator-1"] },
    { id: "worker-2", state: "running", role: "worker", lineage: ["coordinator-1"] },
    { id: "subworker-1", state: "running", role: "worker", lineage: ["coordinator-1", "worker-1"] },
    { id: "worker-3", state: "running", role: "worker", lineage: ["coordinator-2"] },
    { id: "coordinator-2", state: "running", role: "coordinator", lineage: [] },
  ];

  const agentSource = createMockAgentSource(agents);

  it("should return coordinator and all descendants", () => {
    const subtree = getSubtreeIds("coordinator-1", agentSource);
    expect(subtree.has("coordinator-1")).toBe(true);
    expect(subtree.has("worker-1")).toBe(true);
    expect(subtree.has("worker-2")).toBe(true);
    expect(subtree.has("subworker-1")).toBe(true);
  });

  it("should not include agents from other coordinators", () => {
    const subtree = getSubtreeIds("coordinator-1", agentSource);
    expect(subtree.has("worker-3")).toBe(false);
    expect(subtree.has("coordinator-2")).toBe(false);
  });

  it("should work for intermediate nodes", () => {
    const subtree = getSubtreeIds("worker-1", agentSource);
    expect(subtree.has("worker-1")).toBe(true);
    expect(subtree.has("subworker-1")).toBe(true);
    expect(subtree.has("worker-2")).toBe(false);
  });

  it("should return only self for leaf nodes", () => {
    const subtree = getSubtreeIds("subworker-1", agentSource);
    expect(subtree.size).toBe(1);
    expect(subtree.has("subworker-1")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// resolveRoleTarget
// ─────────────────────────────────────────────────────────────────────────────

describe("resolveRoleTarget", () => {
  const agents = [
    { id: "coordinator-1", state: "running", role: "coordinator", lineage: [] },
    { id: "worker-1", state: "running", role: "worker", lineage: ["coordinator-1"] },
    { id: "worker-2", state: "running", role: "worker.resolver", lineage: ["coordinator-1"] },
    { id: "worker-3", state: "running", role: "worker", lineage: ["coordinator-2"] },
    { id: "worker-4", state: "stopped", role: "worker", lineage: ["coordinator-1"] },
    { id: "coordinator-2", state: "running", role: "coordinator", lineage: [] },
    { id: "integrator-1", state: "running", role: "integrator", lineage: ["coordinator-1"] },
  ];

  const agentSource = createMockAgentSource(agents);

  describe("without coordinator scoping", () => {
    it("should return all running agents with matching role", () => {
      const recipients = resolveRoleTarget(agentSource, { role: "worker" });
      expect(recipients).toContain("worker-1");
      expect(recipients).toContain("worker-2"); // worker.resolver matches worker
      expect(recipients).toContain("worker-3");
      expect(recipients).not.toContain("worker-4"); // stopped
    });

    it("should return coordinators when targeting coordinator role", () => {
      const recipients = resolveRoleTarget(agentSource, { role: "coordinator" });
      expect(recipients).toEqual(["coordinator-1", "coordinator-2"]);
    });

    it("should return specific subroles when targeting subrole", () => {
      const recipients = resolveRoleTarget(agentSource, { role: "worker.resolver" });
      expect(recipients).toEqual(["worker-2"]);
    });

    it("should return integrators when targeting integrator role", () => {
      const recipients = resolveRoleTarget(agentSource, { role: "integrator" });
      expect(recipients).toEqual(["integrator-1"]);
    });
  });

  describe("with coordinator scoping", () => {
    it("should only return workers in coordinator subtree", () => {
      const recipients = resolveRoleTarget(agentSource, {
        role: "worker",
        coordinatorId: "coordinator-1",
      });
      expect(recipients).toContain("worker-1");
      expect(recipients).toContain("worker-2");
      expect(recipients).not.toContain("worker-3"); // different coordinator
      expect(recipients).not.toContain("worker-4"); // stopped
    });

    it("should include coordinator if role matches", () => {
      const recipients = resolveRoleTarget(agentSource, {
        role: "coordinator",
        coordinatorId: "coordinator-1",
      });
      expect(recipients).toEqual(["coordinator-1"]);
    });

    it("should return empty array if no agents match in subtree", () => {
      const recipients = resolveRoleTarget(agentSource, {
        role: "monitor",
        coordinatorId: "coordinator-1",
      });
      expect(recipients).toEqual([]);
    });
  });

  it("should exclude stopped agents", () => {
    const recipients = resolveRoleTarget(agentSource, { role: "worker" });
    expect(recipients).not.toContain("worker-4");
  });

  it("should return empty array for non-existent role", () => {
    const recipients = resolveRoleTarget(agentSource, { role: "nonexistent" });
    expect(recipients).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getAgentsByRole
// ─────────────────────────────────────────────────────────────────────────────

describe("getAgentsByRole", () => {
  const agents = [
    { id: "worker-1", state: "running", role: "worker", lineage: [] },
    { id: "worker-2", state: "running", role: "worker", lineage: [] },
    { id: "coordinator-1", state: "running", role: "coordinator", lineage: [] },
  ];

  const agentSource = createMockAgentSource(agents);

  it("should return all agents with the specified role", () => {
    const workers = getAgentsByRole(agentSource, "worker");
    expect(workers).toEqual(["worker-1", "worker-2"]);
  });

  it("should return empty array if no agents have the role", () => {
    const monitors = getAgentsByRole(agentSource, "monitor");
    expect(monitors).toEqual([]);
  });
});
