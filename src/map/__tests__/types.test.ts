/**
 * Tests for MAP address types and type guards
 */

import { describe, it, expect } from "vitest";
import {
  type Address,
  isAgentAddress,
  isAgentsAddress,
  isScopeAddress,
  isRoleAddress,
  isParentAddress,
  isChildrenAddress,
  isAncestorsAddress,
  isDescendantsAddress,
  isSiblingsAddress,
  isHierarchicalAddress,
  isBroadcastAddress,
  isTaskAddress,
  isDirectAddress,
  isStructuralAddress,
  describeAddress,
  normalizeAddress,
} from "../types.js";

describe("Address type guards", () => {
  describe("isAgentAddress", () => {
    it("returns true for agent address", () => {
      expect(isAgentAddress({ agent: "agent-1" })).toBe(true);
    });

    it("returns false for other address types", () => {
      expect(isAgentAddress({ agents: ["a", "b"] })).toBe(false);
      expect(isAgentAddress({ scope: "scope-1" })).toBe(false);
      expect(isAgentAddress({ role: "worker" })).toBe(false);
      expect(isAgentAddress({ broadcast: true })).toBe(false);
      expect(isAgentAddress({ task: "task-1" })).toBe(false);
      expect(isAgentAddress({ parent: true })).toBe(false);
    });
  });

  describe("isAgentsAddress", () => {
    it("returns true for agents address", () => {
      expect(isAgentsAddress({ agents: ["agent-1", "agent-2"] })).toBe(true);
    });

    it("returns true for empty agents array", () => {
      expect(isAgentsAddress({ agents: [] })).toBe(true);
    });

    it("returns false for single agent address", () => {
      expect(isAgentsAddress({ agent: "agent-1" })).toBe(false);
    });
  });

  describe("isScopeAddress", () => {
    it("returns true for scope address", () => {
      expect(isScopeAddress({ scope: "my-scope" })).toBe(true);
    });

    it("returns false for other address types", () => {
      expect(isScopeAddress({ agent: "agent-1" })).toBe(false);
      expect(isScopeAddress({ role: "worker" })).toBe(false);
    });
  });

  describe("isRoleAddress", () => {
    it("returns true for role address", () => {
      expect(isRoleAddress({ role: "worker" })).toBe(true);
    });

    it("returns true for role address with scope", () => {
      expect(isRoleAddress({ role: "worker", within: "scope-1" })).toBe(true);
    });

    it("returns false for other address types", () => {
      expect(isRoleAddress({ agent: "agent-1" })).toBe(false);
      expect(isRoleAddress({ scope: "scope-1" })).toBe(false);
    });
  });

  describe("isParentAddress", () => {
    it("returns true for parent address", () => {
      expect(isParentAddress({ parent: true })).toBe(true);
    });

    it("returns false for other hierarchical addresses", () => {
      expect(isParentAddress({ children: true })).toBe(false);
      expect(isParentAddress({ ancestors: true })).toBe(false);
    });
  });

  describe("isChildrenAddress", () => {
    it("returns true for children address", () => {
      expect(isChildrenAddress({ children: true })).toBe(true);
    });

    it("returns true for children address with depth", () => {
      expect(isChildrenAddress({ children: true, depth: 2 })).toBe(true);
    });

    it("returns false for parent address", () => {
      expect(isChildrenAddress({ parent: true })).toBe(false);
    });
  });

  describe("isAncestorsAddress", () => {
    it("returns true for ancestors address", () => {
      expect(isAncestorsAddress({ ancestors: true })).toBe(true);
    });

    it("returns true for ancestors address with depth", () => {
      expect(isAncestorsAddress({ ancestors: true, depth: 3 })).toBe(true);
    });

    it("returns false for descendants address", () => {
      expect(isAncestorsAddress({ descendants: true })).toBe(false);
    });
  });

  describe("isDescendantsAddress", () => {
    it("returns true for descendants address", () => {
      expect(isDescendantsAddress({ descendants: true })).toBe(true);
    });

    it("returns true for descendants address with depth", () => {
      expect(isDescendantsAddress({ descendants: true, depth: 5 })).toBe(true);
    });

    it("returns false for ancestors address", () => {
      expect(isDescendantsAddress({ ancestors: true })).toBe(false);
    });
  });

  describe("isSiblingsAddress", () => {
    it("returns true for siblings address", () => {
      expect(isSiblingsAddress({ siblings: true })).toBe(true);
    });

    it("returns false for other addresses", () => {
      expect(isSiblingsAddress({ parent: true })).toBe(false);
      expect(isSiblingsAddress({ children: true })).toBe(false);
    });
  });

  describe("isHierarchicalAddress", () => {
    it("returns true for all hierarchical addresses", () => {
      expect(isHierarchicalAddress({ parent: true })).toBe(true);
      expect(isHierarchicalAddress({ children: true })).toBe(true);
      expect(isHierarchicalAddress({ ancestors: true })).toBe(true);
      expect(isHierarchicalAddress({ descendants: true })).toBe(true);
      expect(isHierarchicalAddress({ siblings: true })).toBe(true);
    });

    it("returns false for non-hierarchical addresses", () => {
      expect(isHierarchicalAddress({ agent: "a" })).toBe(false);
      expect(isHierarchicalAddress({ scope: "s" })).toBe(false);
      expect(isHierarchicalAddress({ role: "r" })).toBe(false);
      expect(isHierarchicalAddress({ broadcast: true })).toBe(false);
      expect(isHierarchicalAddress({ task: "t" })).toBe(false);
    });
  });

  describe("isBroadcastAddress", () => {
    it("returns true for broadcast address", () => {
      expect(isBroadcastAddress({ broadcast: true })).toBe(true);
    });

    it("returns false for other addresses", () => {
      expect(isBroadcastAddress({ agent: "a" })).toBe(false);
      expect(isBroadcastAddress({ role: "worker" })).toBe(false);
    });
  });

  describe("isTaskAddress", () => {
    it("returns true for task address", () => {
      expect(isTaskAddress({ task: "task-123" })).toBe(true);
    });

    it("returns false for agent address", () => {
      expect(isTaskAddress({ agent: "agent-1" })).toBe(false);
    });
  });

  describe("isDirectAddress", () => {
    it("returns true for agent and agents addresses", () => {
      expect(isDirectAddress({ agent: "a" })).toBe(true);
      expect(isDirectAddress({ agents: ["a", "b"] })).toBe(true);
    });

    it("returns false for non-direct addresses", () => {
      expect(isDirectAddress({ scope: "s" })).toBe(false);
      expect(isDirectAddress({ role: "r" })).toBe(false);
      expect(isDirectAddress({ broadcast: true })).toBe(false);
    });
  });

  describe("isStructuralAddress", () => {
    it("returns true for scope and role addresses", () => {
      expect(isStructuralAddress({ scope: "s" })).toBe(true);
      expect(isStructuralAddress({ role: "r" })).toBe(true);
      expect(isStructuralAddress({ role: "r", within: "s" })).toBe(true);
    });

    it("returns false for non-structural addresses", () => {
      expect(isStructuralAddress({ agent: "a" })).toBe(false);
      expect(isStructuralAddress({ broadcast: true })).toBe(false);
    });
  });
});

describe("describeAddress", () => {
  it("describes agent address", () => {
    expect(describeAddress({ agent: "agent-1" })).toBe("agent:agent-1");
  });

  it("describes agents address", () => {
    expect(describeAddress({ agents: ["a", "b"] })).toBe("agents:[a, b]");
  });

  it("describes scope address", () => {
    expect(describeAddress({ scope: "my-scope" })).toBe("scope:my-scope");
  });

  it("describes role address", () => {
    expect(describeAddress({ role: "worker" })).toBe("role:worker");
  });

  it("describes role address with scope", () => {
    expect(describeAddress({ role: "worker", within: "s1" })).toBe(
      "role:worker@s1"
    );
  });

  it("describes parent address", () => {
    expect(describeAddress({ parent: true })).toBe("parent");
  });

  it("describes children address", () => {
    expect(describeAddress({ children: true })).toBe("children");
    expect(describeAddress({ children: true, depth: 2 })).toBe(
      "children(depth=2)"
    );
  });

  it("describes ancestors address", () => {
    expect(describeAddress({ ancestors: true })).toBe("ancestors");
    expect(describeAddress({ ancestors: true, depth: 3 })).toBe(
      "ancestors(depth=3)"
    );
  });

  it("describes descendants address", () => {
    expect(describeAddress({ descendants: true })).toBe("descendants");
    expect(describeAddress({ descendants: true, depth: 5 })).toBe(
      "descendants(depth=5)"
    );
  });

  it("describes siblings address", () => {
    expect(describeAddress({ siblings: true })).toBe("siblings");
  });

  it("describes broadcast address", () => {
    expect(describeAddress({ broadcast: true })).toBe("broadcast");
  });

  it("describes task address", () => {
    expect(describeAddress({ task: "task-123" })).toBe("task:task-123");
  });
});

describe("normalizeAddress", () => {
  it("adds default depth=1 to children address", () => {
    const addr = { children: true } as const;
    const normalized = normalizeAddress(addr);
    expect(normalized).toEqual({ children: true, depth: 1 });
  });

  it("preserves explicit depth on children address", () => {
    const addr = { children: true, depth: 3 } as const;
    const normalized = normalizeAddress(addr);
    expect(normalized).toEqual({ children: true, depth: 3 });
  });

  it("adds default depth=Infinity to descendants address", () => {
    const addr = { descendants: true } as const;
    const normalized = normalizeAddress(addr);
    expect(normalized).toEqual({ descendants: true, depth: Infinity });
  });

  it("adds default depth=Infinity to ancestors address", () => {
    const addr = { ancestors: true } as const;
    const normalized = normalizeAddress(addr);
    expect(normalized).toEqual({ ancestors: true, depth: Infinity });
  });

  it("returns non-hierarchical addresses unchanged", () => {
    const addresses: Address[] = [
      { agent: "a" },
      { agents: ["a", "b"] },
      { scope: "s" },
      { role: "r" },
      { parent: true },
      { siblings: true },
      { broadcast: true },
      { task: "t" },
    ];

    for (const addr of addresses) {
      expect(normalizeAddress(addr)).toEqual(addr);
    }
  });
});
