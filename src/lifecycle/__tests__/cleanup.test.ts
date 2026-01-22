/**
 * Tests for cleanup detection module
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execSync } from "child_process";
import {
  detectCleanupStatus,
  hasUncommittedChanges,
  getUncommittedFiles,
  getCurrentBranch,
  getPendingMessageCount,
  commitChanges,
} from "../cleanup.js";
import type { LifecycleContext } from "../types.js";

// Mock child_process
vi.mock("child_process", () => ({
  execSync: vi.fn(),
}));

const mockExecSync = vi.mocked(execSync);

describe("cleanup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // hasUncommittedChanges
  // ─────────────────────────────────────────────────────────────────────────────

  describe("hasUncommittedChanges", () => {
    it("should return false when workspace is clean", () => {
      mockExecSync.mockReturnValue("");

      const result = hasUncommittedChanges("/path/to/workspace");

      expect(result).toBe(false);
      expect(mockExecSync).toHaveBeenCalledWith("git status --porcelain", {
        cwd: "/path/to/workspace",
        encoding: "utf-8",
      });
    });

    it("should return true when workspace has changes", () => {
      mockExecSync.mockReturnValue(" M file.ts\n?? new-file.ts\n");

      const result = hasUncommittedChanges("/path/to/workspace");

      expect(result).toBe(true);
    });

    it("should return true when git command fails", () => {
      mockExecSync.mockImplementation(() => {
        throw new Error("git error");
      });

      const result = hasUncommittedChanges("/path/to/workspace");

      expect(result).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // getUncommittedFiles
  // ─────────────────────────────────────────────────────────────────────────────

  describe("getUncommittedFiles", () => {
    it("should return empty array when workspace is clean", () => {
      mockExecSync.mockReturnValue("");

      const result = getUncommittedFiles("/path/to/workspace");

      expect(result).toEqual([]);
    });

    it("should return list of uncommitted files", () => {
      mockExecSync.mockReturnValue(" M file.ts\n?? new-file.ts\nA  added.ts\n");

      const result = getUncommittedFiles("/path/to/workspace");

      expect(result).toEqual(["file.ts", "new-file.ts", "added.ts"]);
    });

    it("should return empty array when git command fails", () => {
      mockExecSync.mockImplementation(() => {
        throw new Error("git error");
      });

      const result = getUncommittedFiles("/path/to/workspace");

      expect(result).toEqual([]);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // getCurrentBranch
  // ─────────────────────────────────────────────────────────────────────────────

  describe("getCurrentBranch", () => {
    it("should return branch name", () => {
      mockExecSync.mockReturnValue("feature/my-branch\n");

      const result = getCurrentBranch("/path/to/workspace");

      expect(result).toBe("feature/my-branch");
    });

    it("should return undefined when git command fails", () => {
      mockExecSync.mockImplementation(() => {
        throw new Error("git error");
      });

      const result = getCurrentBranch("/path/to/workspace");

      expect(result).toBeUndefined();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // getPendingMessageCount
  // ─────────────────────────────────────────────────────────────────────────────

  describe("getPendingMessageCount", () => {
    it("should return 0 when no message router provided", () => {
      const result = getPendingMessageCount("agent-1");

      expect(result).toBe(0);
    });

    it("should return message count from router", () => {
      const mockRouter = {
        getMessages: vi.fn().mockReturnValue([
          { id: "msg-1" },
          { id: "msg-2" },
          { id: "msg-3" },
        ]),
      };

      const result = getPendingMessageCount("agent-1", mockRouter as any);

      expect(result).toBe(3);
      expect(mockRouter.getMessages).toHaveBeenCalledWith("agent-1", {
        includeAcknowledged: false,
      });
    });

    it("should return 0 when getMessages throws", () => {
      const mockRouter = {
        getMessages: vi.fn().mockImplementation(() => {
          throw new Error("Router error");
        }),
      };

      const result = getPendingMessageCount("agent-1", mockRouter as any);

      expect(result).toBe(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // detectCleanupStatus
  // ─────────────────────────────────────────────────────────────────────────────

  describe("detectCleanupStatus", () => {
    it("should return ready when no issues", () => {
      mockExecSync.mockReturnValue("");

      const context: LifecycleContext = {
        agentId: "agent-1",
        role: "worker",
        workspacePath: "/path/to/workspace",
      };

      const result = detectCleanupStatus(context);

      expect(result.ready).toBe(true);
      expect(result.reason).toBeUndefined();
      expect(result.uncommittedFiles).toBeUndefined();
      expect(result.pendingMessages).toBeUndefined();
    });

    it("should detect uncommitted changes", () => {
      mockExecSync.mockReturnValue(" M file1.ts\n M file2.ts\n");

      const context: LifecycleContext = {
        agentId: "agent-1",
        role: "worker",
        workspacePath: "/path/to/workspace",
      };

      const result = detectCleanupStatus(context);

      expect(result.ready).toBe(false);
      expect(result.reason).toContain("uncommitted file(s)");
      expect(result.uncommittedFiles).toEqual(["file1.ts", "file2.ts"]);
    });

    it("should detect pending messages", () => {
      mockExecSync.mockReturnValue("");

      const mockRouter = {
        getMessages: vi.fn().mockReturnValue([
          { id: "msg-1" },
          { id: "msg-2" },
        ]),
      };

      const context: LifecycleContext = {
        agentId: "agent-1",
        role: "worker",
        workspacePath: "/path/to/workspace",
      };

      const result = detectCleanupStatus(context, { messageRouter: mockRouter as any });

      expect(result.ready).toBe(false);
      expect(result.reason).toContain("pending message(s)");
      expect(result.pendingMessages).toBe(2);
    });

    it("should report both uncommitted changes and pending messages", () => {
      mockExecSync.mockReturnValue(" M file.ts\n");

      const mockRouter = {
        getMessages: vi.fn().mockReturnValue([{ id: "msg-1" }]),
      };

      const context: LifecycleContext = {
        agentId: "agent-1",
        role: "worker",
        workspacePath: "/path/to/workspace",
      };

      const result = detectCleanupStatus(context, { messageRouter: mockRouter as any });

      expect(result.ready).toBe(false);
      expect(result.reason).toContain("uncommitted file(s)");
      expect(result.reason).toContain("pending message(s)");
    });

    it("should skip workspace check when no workspace path", () => {
      const context: LifecycleContext = {
        agentId: "agent-1",
        role: "worker",
      };

      const result = detectCleanupStatus(context);

      expect(result.ready).toBe(true);
      expect(mockExecSync).not.toHaveBeenCalled();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // commitChanges
  // ─────────────────────────────────────────────────────────────────────────────

  describe("commitChanges", () => {
    it("should commit changes and return hash", () => {
      mockExecSync
        .mockReturnValueOnce(" M file.ts\n") // hasUncommittedChanges check
        .mockReturnValueOnce("") // git add
        .mockReturnValueOnce("") // git commit
        .mockReturnValueOnce("abc123def456\n"); // git rev-parse

      const result = commitChanges("/path/to/workspace", "Test commit");

      expect(result).toBe("abc123def456");
      expect(mockExecSync).toHaveBeenCalledTimes(4);
    });

    it("should return undefined when no changes to commit", () => {
      mockExecSync.mockReturnValue(""); // clean workspace

      const result = commitChanges("/path/to/workspace", "Test commit");

      expect(result).toBeUndefined();
      expect(mockExecSync).toHaveBeenCalledTimes(1);
    });

    it("should return undefined when commit fails", () => {
      mockExecSync
        .mockReturnValueOnce(" M file.ts\n") // hasUncommittedChanges check
        .mockReturnValueOnce("") // git add
        .mockImplementationOnce(() => {
          throw new Error("Commit failed");
        }); // git commit fails

      const result = commitChanges("/path/to/workspace", "Test commit");

      expect(result).toBeUndefined();
    });

    it("should escape quotes in commit message", () => {
      mockExecSync
        .mockReturnValueOnce(" M file.ts\n")
        .mockReturnValueOnce("")
        .mockReturnValueOnce("")
        .mockReturnValueOnce("abc123\n");

      commitChanges("/path/to/workspace", 'Test "quoted" message');

      expect(mockExecSync).toHaveBeenCalledWith(
        expect.stringContaining('Test \\"quoted\\" message'),
        expect.any(Object)
      );
    });
  });
});
