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
  type WorkspaceProvider,
} from "../cascade.js";
import type { Workspace } from "../../workspace/types.js";

// Mock cleanup module
vi.mock("../cleanup.js", () => ({
  attemptMerge: vi.fn(),
  abortMerge: vi.fn(),
  getCurrentBranch: vi.fn(),
}));

import { attemptMerge, abortMerge, getCurrentBranch } from "../cleanup.js";

const mockAttemptMerge = vi.mocked(attemptMerge);
const mockAbortMerge = vi.mocked(abortMerge);
const mockGetCurrentBranch = vi.mocked(getCurrentBranch);

// Create mock agent manager
function createMockAgentManager(
  childrenMap: Map<string, CascadeAgent[]> = new Map()
): CascadeAgentManager {
  return {
    getChildren: vi.fn((agentId: string) => childrenMap.get(agentId) ?? []),
    terminate: vi.fn().mockResolvedValue(undefined),
  };
}

// Create mock workspace provider
function createMockWorkspaceProvider(
  workspaceMap: Map<string, Workspace>
): WorkspaceProvider {
  return {
    getWorkspace: (agentId: string) => workspaceMap.get(agentId) ?? null,
  };
}

// Helper to create a mock workspace
function createMockWorkspace(
  agentId: string,
  branch: string,
  path: string
): Workspace {
  return {
    agentId,
    branch,
    path,
    repoPath: "/repo",
    type: "worktree",
    isActive: true,
    createdAt: Date.now(),
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
    beforeEach(() => {
      mockAttemptMerge.mockReset();
      mockAbortMerge.mockReset();
      mockGetCurrentBranch.mockReset();
    });

    it("should terminate child without merge when no workspace provider", async () => {
      const agentManager = createMockAgentManager();

      const result = await terminateWithChangeConsolidation(
        "child-1",
        "parent-1",
        agentManager
      );

      expect(agentManager.terminate).toHaveBeenCalledWith(
        "child-1",
        "parent_stopped"
      );
      expect(result.success).toBe(true);
      expect(result.merged).toBe(false);
    });

    it("should terminate child without merge when child has no workspace", async () => {
      const agentManager = createMockAgentManager();
      const workspaceMap = new Map<string, Workspace>();
      // Only parent has workspace
      workspaceMap.set(
        "parent-1",
        createMockWorkspace("parent-1", "main", "/worktrees/parent")
      );
      const workspaceProvider = createMockWorkspaceProvider(workspaceMap);

      const result = await terminateWithChangeConsolidation(
        "child-1",
        "parent-1",
        agentManager,
        workspaceProvider
      );

      expect(agentManager.terminate).toHaveBeenCalledWith(
        "child-1",
        "parent_stopped"
      );
      expect(result.success).toBe(true);
      expect(result.merged).toBe(false);
      expect(mockAttemptMerge).not.toHaveBeenCalled();
    });

    it("should terminate child without merge when parent has no workspace", async () => {
      const agentManager = createMockAgentManager();
      const workspaceMap = new Map<string, Workspace>();
      // Only child has workspace
      workspaceMap.set(
        "child-1",
        createMockWorkspace("child-1", "feature/child", "/worktrees/child")
      );
      const workspaceProvider = createMockWorkspaceProvider(workspaceMap);

      const result = await terminateWithChangeConsolidation(
        "child-1",
        "parent-1",
        agentManager,
        workspaceProvider
      );

      expect(agentManager.terminate).toHaveBeenCalledWith(
        "child-1",
        "parent_stopped"
      );
      expect(result.success).toBe(true);
      expect(result.merged).toBe(false);
    });

    it("should merge child branch into parent and terminate on success", async () => {
      const agentManager = createMockAgentManager();
      const workspaceMap = new Map<string, Workspace>();
      workspaceMap.set(
        "child-1",
        createMockWorkspace("child-1", "feature/child", "/worktrees/child")
      );
      workspaceMap.set(
        "parent-1",
        createMockWorkspace("parent-1", "main", "/worktrees/parent")
      );
      const workspaceProvider = createMockWorkspaceProvider(workspaceMap);

      mockGetCurrentBranch.mockReturnValue("main");
      mockAttemptMerge.mockReturnValue({
        success: true,
        mergeCommit: "abc123",
      });

      const result = await terminateWithChangeConsolidation(
        "child-1",
        "parent-1",
        agentManager,
        workspaceProvider
      );

      expect(mockAttemptMerge).toHaveBeenCalledWith(
        "feature/child",
        "/worktrees/parent",
        "Merge changes from child-1 (feature/child)"
      );
      expect(agentManager.terminate).toHaveBeenCalledWith(
        "child-1",
        "changes_consolidated"
      );
      expect(result.success).toBe(true);
      expect(result.merged).toBe(true);
      expect(result.mergeCommit).toBe("abc123");
    });

    it("should use custom merge message when provided", async () => {
      const agentManager = createMockAgentManager();
      const workspaceMap = new Map<string, Workspace>();
      workspaceMap.set(
        "child-1",
        createMockWorkspace("child-1", "feature/child", "/worktrees/child")
      );
      workspaceMap.set(
        "parent-1",
        createMockWorkspace("parent-1", "main", "/worktrees/parent")
      );
      const workspaceProvider = createMockWorkspaceProvider(workspaceMap);

      mockGetCurrentBranch.mockReturnValue("main");
      mockAttemptMerge.mockReturnValue({ success: true, mergeCommit: "abc123" });

      await terminateWithChangeConsolidation(
        "child-1",
        "parent-1",
        agentManager,
        workspaceProvider,
        { mergeMessage: "Custom merge message" }
      );

      expect(mockAttemptMerge).toHaveBeenCalledWith(
        "feature/child",
        "/worktrees/parent",
        "Custom merge message"
      );
    });

    it("should abort merge and terminate with conflict status on merge conflict", async () => {
      const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const agentManager = createMockAgentManager();
      const workspaceMap = new Map<string, Workspace>();
      workspaceMap.set(
        "child-1",
        createMockWorkspace("child-1", "feature/child", "/worktrees/child")
      );
      workspaceMap.set(
        "parent-1",
        createMockWorkspace("parent-1", "main", "/worktrees/parent")
      );
      const workspaceProvider = createMockWorkspaceProvider(workspaceMap);

      mockGetCurrentBranch.mockReturnValue("main");
      mockAttemptMerge.mockReturnValue({
        success: false,
        conflicts: ["file1.ts", "file2.ts"],
      });
      mockAbortMerge.mockReturnValue(true);

      const result = await terminateWithChangeConsolidation(
        "child-1",
        "parent-1",
        agentManager,
        workspaceProvider
      );

      expect(mockAbortMerge).toHaveBeenCalledWith("/worktrees/parent");
      expect(agentManager.terminate).toHaveBeenCalledWith(
        "child-1",
        "merge_conflict"
      );
      expect(result.success).toBe(false);
      expect(result.merged).toBe(false);
      expect(result.conflicts).toEqual(["file1.ts", "file2.ts"]);
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("Merge conflict")
      );
      consoleSpy.mockRestore();
    });

    it("should terminate with merge_failed on non-conflict error", async () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const agentManager = createMockAgentManager();
      const workspaceMap = new Map<string, Workspace>();
      workspaceMap.set(
        "child-1",
        createMockWorkspace("child-1", "feature/child", "/worktrees/child")
      );
      workspaceMap.set(
        "parent-1",
        createMockWorkspace("parent-1", "main", "/worktrees/parent")
      );
      const workspaceProvider = createMockWorkspaceProvider(workspaceMap);

      mockGetCurrentBranch.mockReturnValue("main");
      mockAttemptMerge.mockReturnValue({
        success: false,
        error: "Branch not found",
      });

      const result = await terminateWithChangeConsolidation(
        "child-1",
        "parent-1",
        agentManager,
        workspaceProvider
      );

      expect(agentManager.terminate).toHaveBeenCalledWith(
        "child-1",
        "merge_failed"
      );
      expect(result.success).toBe(false);
      expect(result.merged).toBe(false);
      expect(result.error).toBe("Branch not found");
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("Merge failed")
      );
      consoleSpy.mockRestore();
    });

    it("should warn but continue when parent worktree is on unexpected branch", async () => {
      const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const agentManager = createMockAgentManager();
      const workspaceMap = new Map<string, Workspace>();
      workspaceMap.set(
        "child-1",
        createMockWorkspace("child-1", "feature/child", "/worktrees/child")
      );
      workspaceMap.set(
        "parent-1",
        createMockWorkspace("parent-1", "main", "/worktrees/parent")
      );
      const workspaceProvider = createMockWorkspaceProvider(workspaceMap);

      // Parent worktree is on different branch than expected
      mockGetCurrentBranch.mockReturnValue("develop");
      mockAttemptMerge.mockReturnValue({ success: true, mergeCommit: "abc123" });

      const result = await terminateWithChangeConsolidation(
        "child-1",
        "parent-1",
        agentManager,
        workspaceProvider
      );

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("expected 'main'")
      );
      // Should still attempt the merge
      expect(mockAttemptMerge).toHaveBeenCalled();
      expect(result.success).toBe(true);
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
