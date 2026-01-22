/**
 * Tests for cascade termination module
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  cascadeTerminateChildren,
  terminateWithChangeConsolidation,
  getAllDescendants,
  needsCascadeTermination,
  type CascadeAgent,
  type CascadeAgentManager,
} from "../cascade.js";

// Create mock agent manager
function createMockAgentManager(
  childrenMap: Map<string, CascadeAgent[]> = new Map()
): CascadeAgentManager {
  return {
    getChildren: vi.fn((agentId: string) => childrenMap.get(agentId) ?? []),
    terminate: vi.fn().mockResolvedValue(undefined),
  };
}

describe("cascade", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // cascadeTerminateChildren
  // ─────────────────────────────────────────────────────────────────────────────

  describe("cascadeTerminateChildren", () => {
    it("should return empty result when no children", async () => {
      const agentManager = createMockAgentManager();

      const result = await cascadeTerminateChildren("parent-1", agentManager);

      expect(result.childrenTerminated).toBe(0);
      expect(result.terminatedIds).toEqual([]);
      expect(result.errors).toBeUndefined();
    });

    it("should terminate single child", async () => {
      const childrenMap = new Map([
        ["parent-1", [{ id: "child-1", state: "running" as const }]],
      ]);
      const agentManager = createMockAgentManager(childrenMap);

      const result = await cascadeTerminateChildren("parent-1", agentManager);

      expect(result.childrenTerminated).toBe(1);
      expect(result.terminatedIds).toContain("child-1");
      expect(agentManager.terminate).toHaveBeenCalledWith(
        "child-1",
        "parent_stopped"
      );
    });

    it("should terminate multiple children", async () => {
      const childrenMap = new Map([
        [
          "parent-1",
          [
            { id: "child-1", state: "running" as const },
            { id: "child-2", state: "running" as const },
            { id: "child-3", state: "spawning" as const },
          ],
        ],
      ]);
      const agentManager = createMockAgentManager(childrenMap);

      const result = await cascadeTerminateChildren("parent-1", agentManager);

      expect(result.childrenTerminated).toBe(3);
      expect(result.terminatedIds).toContain("child-1");
      expect(result.terminatedIds).toContain("child-2");
      expect(result.terminatedIds).toContain("child-3");
    });

    it("should skip already stopped children", async () => {
      const childrenMap = new Map([
        [
          "parent-1",
          [
            { id: "child-1", state: "running" as const },
            { id: "child-2", state: "stopped" as const },
          ],
        ],
      ]);
      const agentManager = createMockAgentManager(childrenMap);

      const result = await cascadeTerminateChildren("parent-1", agentManager);

      expect(result.childrenTerminated).toBe(1);
      expect(result.terminatedIds).toContain("child-1");
      expect(result.terminatedIds).not.toContain("child-2");
      expect(agentManager.terminate).toHaveBeenCalledTimes(1);
    });

    it("should terminate grandchildren before children (depth-first)", async () => {
      const terminationOrder: string[] = [];
      const childrenMap = new Map([
        ["parent-1", [{ id: "child-1", state: "running" as const }]],
        ["child-1", [{ id: "grandchild-1", state: "running" as const }]],
      ]);
      const agentManager = {
        getChildren: vi.fn((agentId: string) => childrenMap.get(agentId) ?? []),
        terminate: vi.fn((agentId: string) => {
          terminationOrder.push(agentId);
          return Promise.resolve();
        }),
      };

      const result = await cascadeTerminateChildren("parent-1", agentManager);

      expect(result.childrenTerminated).toBe(2);
      // Grandchild should be terminated before child
      expect(terminationOrder).toEqual(["grandchild-1", "child-1"]);
    });

    it("should use custom termination reason", async () => {
      const childrenMap = new Map([
        ["parent-1", [{ id: "child-1", state: "running" as const }]],
      ]);
      const agentManager = createMockAgentManager(childrenMap);

      await cascadeTerminateChildren("parent-1", agentManager, {
        reason: "self_cleanup",
      });

      expect(agentManager.terminate).toHaveBeenCalledWith(
        "child-1",
        "self_cleanup"
      );
    });

    it("should collect errors but continue terminating", async () => {
      const childrenMap = new Map([
        [
          "parent-1",
          [
            { id: "child-1", state: "running" as const },
            { id: "child-2", state: "running" as const },
          ],
        ],
      ]);
      const agentManager = {
        getChildren: vi.fn((agentId: string) => childrenMap.get(agentId) ?? []),
        terminate: vi.fn((agentId: string) => {
          if (agentId === "child-1") {
            return Promise.reject(new Error("Termination failed"));
          }
          return Promise.resolve();
        }),
      };

      const result = await cascadeTerminateChildren("parent-1", agentManager);

      // Should still terminate child-2
      expect(result.terminatedIds).toContain("child-2");
      // Should report error for child-1
      expect(result.errors).toHaveLength(1);
      expect(result.errors![0].agentId).toBe("child-1");
      expect(result.errors![0].error).toContain("Termination failed");
    });

    it("should handle deep hierarchies", async () => {
      const terminationOrder: string[] = [];
      const childrenMap = new Map([
        ["parent-1", [{ id: "child-1", state: "running" as const }]],
        ["child-1", [{ id: "grandchild-1", state: "running" as const }]],
        ["grandchild-1", [{ id: "great-grandchild-1", state: "running" as const }]],
      ]);
      const agentManager = {
        getChildren: vi.fn((agentId: string) => childrenMap.get(agentId) ?? []),
        terminate: vi.fn((agentId: string) => {
          terminationOrder.push(agentId);
          return Promise.resolve();
        }),
      };

      const result = await cascadeTerminateChildren("parent-1", agentManager);

      expect(result.childrenTerminated).toBe(3);
      // Should terminate in depth-first order
      expect(terminationOrder).toEqual([
        "great-grandchild-1",
        "grandchild-1",
        "child-1",
      ]);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // terminateWithChangeConsolidation
  // ─────────────────────────────────────────────────────────────────────────────

  describe("terminateWithChangeConsolidation", () => {
    it("should terminate child (stub behavior)", async () => {
      const agentManager = createMockAgentManager();

      await terminateWithChangeConsolidation(
        "child-1",
        "parent-1",
        agentManager
      );

      expect(agentManager.terminate).toHaveBeenCalledWith(
        "child-1",
        "parent_stopped"
      );
    });

    it("should log TODO message", async () => {
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const agentManager = createMockAgentManager();

      await terminateWithChangeConsolidation(
        "child-1",
        "parent-1",
        agentManager
      );

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("TODO Phase 6")
      );
      consoleSpy.mockRestore();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // getAllDescendants
  // ─────────────────────────────────────────────────────────────────────────────

  describe("getAllDescendants", () => {
    it("should return empty array when no children", () => {
      const agentManager = createMockAgentManager();

      const result = getAllDescendants("parent-1", agentManager);

      expect(result).toEqual([]);
    });

    it("should return direct children", () => {
      const child: CascadeAgent = { id: "child-1", state: "running" };
      const childrenMap = new Map([["parent-1", [child]]]);
      const agentManager = createMockAgentManager(childrenMap);

      const result = getAllDescendants("parent-1", agentManager);

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("child-1");
    });

    it("should return all descendants recursively", () => {
      const childrenMap = new Map([
        ["parent-1", [{ id: "child-1", state: "running" as const }]],
        ["child-1", [{ id: "grandchild-1", state: "running" as const }]],
      ]);
      const agentManager = createMockAgentManager(childrenMap);

      const result = getAllDescendants("parent-1", agentManager);

      expect(result).toHaveLength(2);
      expect(result.map((a) => a.id)).toContain("child-1");
      expect(result.map((a) => a.id)).toContain("grandchild-1");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // needsCascadeTermination
  // ─────────────────────────────────────────────────────────────────────────────

  describe("needsCascadeTermination", () => {
    it("should return false when no children", () => {
      const agentManager = createMockAgentManager();

      const result = needsCascadeTermination("parent-1", agentManager);

      expect(result).toBe(false);
    });

    it("should return true when has running children", () => {
      const childrenMap = new Map([
        ["parent-1", [{ id: "child-1", state: "running" as const }]],
      ]);
      const agentManager = createMockAgentManager(childrenMap);

      const result = needsCascadeTermination("parent-1", agentManager);

      expect(result).toBe(true);
    });

    it("should return true when has spawning children", () => {
      const childrenMap = new Map([
        ["parent-1", [{ id: "child-1", state: "spawning" as const }]],
      ]);
      const agentManager = createMockAgentManager(childrenMap);

      const result = needsCascadeTermination("parent-1", agentManager);

      expect(result).toBe(true);
    });

    it("should return false when all children stopped", () => {
      const childrenMap = new Map([
        [
          "parent-1",
          [
            { id: "child-1", state: "stopped" as const },
            { id: "child-2", state: "stopped" as const },
          ],
        ],
      ]);
      const agentManager = createMockAgentManager(childrenMap);

      const result = needsCascadeTermination("parent-1", agentManager);

      expect(result).toBe(false);
    });
  });
});
