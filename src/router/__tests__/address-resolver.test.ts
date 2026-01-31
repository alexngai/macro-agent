/**
 * Tests for Address Resolver
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  resolveParent,
  resolveChildren,
  resolveAncestors,
  resolveDescendants,
  resolveSiblings,
  resolveHierarchicalAddress,
  hasRecipients,
  type HierarchySource,
  type HierarchyAgentInfo,
} from "../address-resolver.js";

describe("Address Resolver", () => {
  // Test hierarchy:
  //           root
  //          /    \
  //      coord1   coord2
  //       /  \       \
  //    work1 work2  work3
  //      |
  //   subwork1
  //
  // Lineage is ordered from root to parent (oldest to newest)
  // e.g., subwork1.lineage = [root, coord1, work1]

  let agents: Map<string, HierarchyAgentInfo>;
  let hierarchySource: HierarchySource;

  beforeEach(() => {
    agents = new Map([
      [
        "root",
        { id: "root", parent: undefined, lineage: [], state: "running" },
      ],
      [
        "coord1",
        { id: "coord1", parent: "root", lineage: ["root"], state: "running" },
      ],
      [
        "coord2",
        { id: "coord2", parent: "root", lineage: ["root"], state: "running" },
      ],
      [
        "work1",
        {
          id: "work1",
          parent: "coord1",
          lineage: ["root", "coord1"],
          state: "running",
        },
      ],
      [
        "work2",
        {
          id: "work2",
          parent: "coord1",
          lineage: ["root", "coord1"],
          state: "running",
        },
      ],
      [
        "work3",
        {
          id: "work3",
          parent: "coord2",
          lineage: ["root", "coord2"],
          state: "running",
        },
      ],
      [
        "subwork1",
        {
          id: "subwork1",
          parent: "work1",
          lineage: ["root", "coord1", "work1"],
          state: "running",
        },
      ],
    ]);

    hierarchySource = {
      getAgent: (id) => agents.get(id),
      listAgents: () => Array.from(agents.values()),
    };
  });

  describe("resolveParent", () => {
    it("returns parent for agent with parent", () => {
      const result = resolveParent("work1", hierarchySource);
      expect(result).toEqual(["coord1"]);
    });

    it("returns empty array for root agent", () => {
      const result = resolveParent("root", hierarchySource);
      expect(result).toEqual([]);
    });

    it("returns empty array for non-existent agent", () => {
      const result = resolveParent("nonexistent", hierarchySource);
      expect(result).toEqual([]);
    });

    it("excludes non-running parent", () => {
      agents.get("coord1")!.state = "terminated";
      const result = resolveParent("work1", hierarchySource);
      expect(result).toEqual([]);
    });
  });

  describe("resolveChildren", () => {
    it("returns direct children with depth 1", () => {
      const result = resolveChildren("coord1", 1, hierarchySource);
      expect(result).toHaveLength(2);
      expect(result).toContain("work1");
      expect(result).toContain("work2");
    });

    it("returns all descendants within depth 2", () => {
      const result = resolveChildren("coord1", 2, hierarchySource);
      expect(result).toHaveLength(3);
      expect(result).toContain("work1");
      expect(result).toContain("work2");
      expect(result).toContain("subwork1");
    });

    it("returns empty array for agent with no children", () => {
      const result = resolveChildren("subwork1", 1, hierarchySource);
      expect(result).toEqual([]);
    });

    it("uses default depth of 1", () => {
      const result = resolveChildren("coord1", undefined, hierarchySource);
      expect(result).toHaveLength(2);
      expect(result).not.toContain("subwork1");
    });

    it("excludes non-running children", () => {
      agents.get("work1")!.state = "terminated";
      const result = resolveChildren("coord1", 1, hierarchySource);
      expect(result).toHaveLength(1);
      expect(result).toContain("work2");
    });
  });

  describe("resolveAncestors", () => {
    it("returns all ancestors by default (closest first)", () => {
      const result = resolveAncestors("subwork1", Infinity, hierarchySource);
      // Lineage is [root, coord1, work1], reversed = [work1, coord1, root]
      expect(result).toEqual(["work1", "coord1", "root"]);
    });

    it("respects depth limit", () => {
      const result = resolveAncestors("subwork1", 2, hierarchySource);
      // depth=2 means closest 2 ancestors
      expect(result).toEqual(["work1", "coord1"]);
    });

    it("returns empty array for root", () => {
      const result = resolveAncestors("root", Infinity, hierarchySource);
      expect(result).toEqual([]);
    });

    it("excludes non-running ancestors", () => {
      agents.get("coord1")!.state = "terminated";
      const result = resolveAncestors("subwork1", Infinity, hierarchySource);
      // coord1 is filtered out
      expect(result).toEqual(["work1", "root"]);
      expect(result).not.toContain("coord1");
    });
  });

  describe("resolveDescendants", () => {
    it("returns all descendants by default", () => {
      const result = resolveDescendants("root", Infinity, hierarchySource);
      expect(result).toHaveLength(6);
      expect(result).toContain("coord1");
      expect(result).toContain("coord2");
      expect(result).toContain("work1");
      expect(result).toContain("work2");
      expect(result).toContain("work3");
      expect(result).toContain("subwork1");
    });

    it("respects depth limit", () => {
      const result = resolveDescendants("root", 1, hierarchySource);
      expect(result).toHaveLength(2);
      expect(result).toContain("coord1");
      expect(result).toContain("coord2");
    });

    it("returns empty array for leaf agent", () => {
      const result = resolveDescendants("subwork1", Infinity, hierarchySource);
      expect(result).toEqual([]);
    });

    it("excludes non-running descendants", () => {
      agents.get("work1")!.state = "terminated";
      agents.get("subwork1")!.state = "terminated";
      const result = resolveDescendants("coord1", Infinity, hierarchySource);
      expect(result).toEqual(["work2"]);
    });
  });

  describe("resolveSiblings", () => {
    it("returns siblings with same parent", () => {
      const result = resolveSiblings("work1", hierarchySource);
      expect(result).toHaveLength(1);
      expect(result).toContain("work2");
    });

    it("excludes the sender", () => {
      const result = resolveSiblings("work1", hierarchySource);
      expect(result).not.toContain("work1");
    });

    it("returns empty array for agent with no siblings", () => {
      const result = resolveSiblings("subwork1", hierarchySource);
      expect(result).toEqual([]);
    });

    it("returns empty array for root agent (no parent)", () => {
      const result = resolveSiblings("root", hierarchySource);
      expect(result).toEqual([]);
    });

    it("excludes non-running siblings", () => {
      agents.get("work2")!.state = "terminated";
      const result = resolveSiblings("work1", hierarchySource);
      expect(result).toEqual([]);
    });
  });

  describe("resolveHierarchicalAddress", () => {
    it("resolves parent address", () => {
      const result = resolveHierarchicalAddress(
        { parent: true },
        "work1",
        hierarchySource
      );
      expect(result.agentIds).toEqual(["coord1"]);
      expect(result.type).toBe("hierarchical");
    });

    it("resolves children address", () => {
      const result = resolveHierarchicalAddress(
        { children: true },
        "coord1",
        hierarchySource
      );
      expect(result.agentIds).toHaveLength(2);
      expect(result.type).toBe("hierarchical");
    });

    it("resolves children address with depth", () => {
      const result = resolveHierarchicalAddress(
        { children: true, depth: 2 },
        "coord1",
        hierarchySource
      );
      expect(result.agentIds).toHaveLength(3);
    });

    it("resolves ancestors address (closest first)", () => {
      const result = resolveHierarchicalAddress(
        { ancestors: true },
        "subwork1",
        hierarchySource
      );
      // Closest ancestor first
      expect(result.agentIds).toEqual(["work1", "coord1", "root"]);
    });

    it("resolves ancestors address with depth", () => {
      const result = resolveHierarchicalAddress(
        { ancestors: true, depth: 1 },
        "subwork1",
        hierarchySource
      );
      // depth=1 means only direct parent
      expect(result.agentIds).toEqual(["work1"]);
    });

    it("resolves descendants address", () => {
      const result = resolveHierarchicalAddress(
        { descendants: true },
        "coord1",
        hierarchySource
      );
      expect(result.agentIds).toHaveLength(3);
      expect(result.agentIds).toContain("work1");
      expect(result.agentIds).toContain("work2");
      expect(result.agentIds).toContain("subwork1");
    });

    it("resolves siblings address", () => {
      const result = resolveHierarchicalAddress(
        { siblings: true },
        "coord1",
        hierarchySource
      );
      expect(result.agentIds).toEqual(["coord2"]);
    });

    it("preserves original address in result", () => {
      const address = { parent: true } as const;
      const result = resolveHierarchicalAddress(
        address,
        "work1",
        hierarchySource
      );
      expect(result.originalAddress).toEqual(address);
    });
  });

  describe("hasRecipients", () => {
    it("returns true when address resolves to agents", () => {
      expect(hasRecipients({ parent: true }, "work1", hierarchySource)).toBe(
        true
      );
    });

    it("returns false when address resolves to empty", () => {
      expect(hasRecipients({ parent: true }, "root", hierarchySource)).toBe(
        false
      );
    });

    it("returns false when all matching agents are non-running", () => {
      agents.get("coord1")!.state = "terminated";
      expect(hasRecipients({ parent: true }, "work1", hierarchySource)).toBe(
        false
      );
    });
  });
});
