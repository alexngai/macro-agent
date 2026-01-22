/**
 * Lifecycle E2E Tests
 *
 * Integration tests for lifecycle module with real git operations.
 * Tests the complete done() → cleanup → terminate flow.
 *
 * @see s-32xs Self-Cleaning Workers spec
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execSync } from "child_process";

import {
  detectCleanupStatus,
  hasUncommittedChanges,
  getUncommittedFiles,
  getCurrentBranch,
  commitChanges,
} from "../cleanup.js";
import type { LifecycleContext } from "../types.js";

describe("Lifecycle E2E", () => {
  let tempDir: string;
  let repoPath: string;

  /**
   * Helper to run git commands in the repo
   */
  function git(args: string, cwd: string = repoPath): string {
    return execSync(`git ${args}`, {
      cwd,
      stdio: "pipe",
      encoding: "utf8",
    }).trim();
  }

  /**
   * Helper to write a file
   */
  function writeFile(filePath: string, content: string): void {
    const fullPath = path.join(repoPath, filePath);
    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(fullPath, content);
  }

  beforeEach(() => {
    // Create temp directory
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lifecycle-e2e-test-"));
    repoPath = path.join(tempDir, "repo");
    fs.mkdirSync(repoPath);

    // Initialize git repo
    git("init");
    git('config user.email "test@test.com"');
    git('config user.name "Test User"');

    // Create initial commit
    writeFile("README.md", "# Test Project\n");
    git("add .");
    git('commit -m "Initial commit"');
  });

  afterEach(() => {
    // Clean up temp directory
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Cleanup Status Detection
  // ─────────────────────────────────────────────────────────────────────────────

  describe("cleanup status detection", () => {
    describe("hasUncommittedChanges", () => {
      it("should return false for clean workspace", () => {
        expect(hasUncommittedChanges(repoPath)).toBe(false);
      });

      it("should return true for modified files", () => {
        writeFile("README.md", "# Modified\n");
        expect(hasUncommittedChanges(repoPath)).toBe(true);
      });

      it("should return true for new untracked files", () => {
        writeFile("newfile.txt", "new content");
        expect(hasUncommittedChanges(repoPath)).toBe(true);
      });

      it("should return true for staged files", () => {
        writeFile("staged.txt", "staged content");
        git("add staged.txt");
        expect(hasUncommittedChanges(repoPath)).toBe(true);
      });

      it("should return false after committing changes", () => {
        writeFile("newfile.txt", "content");
        git("add .");
        git('commit -m "Add newfile"');
        expect(hasUncommittedChanges(repoPath)).toBe(false);
      });
    });

    describe("getUncommittedFiles", () => {
      it("should return empty array for clean workspace", () => {
        expect(getUncommittedFiles(repoPath)).toEqual([]);
      });

      it("should return modified files", () => {
        writeFile("README.md", "# Modified\n");
        const files = getUncommittedFiles(repoPath);
        expect(files).toContain("README.md");
      });

      it("should return new files", () => {
        writeFile("newfile.txt", "new content");
        const files = getUncommittedFiles(repoPath);
        expect(files).toContain("newfile.txt");
      });

      it("should return multiple files", () => {
        writeFile("file1.txt", "content1");
        writeFile("file2.txt", "content2");
        // Note: git status --porcelain shows new directories as "src/" not individual files
        writeFile("src/file3.ts", "content3");
        const files = getUncommittedFiles(repoPath);
        expect(files.length).toBeGreaterThanOrEqual(2);
        expect(files).toContain("file1.txt");
        expect(files).toContain("file2.txt");
        // New files in new directories may be shown as directory or file
        expect(files.some((f) => f.includes("src"))).toBe(true);
      });
    });

    describe("getCurrentBranch", () => {
      it("should return main branch name", () => {
        const branch = getCurrentBranch(repoPath);
        // Git may use 'main' or 'master' depending on configuration
        expect(["main", "master"]).toContain(branch);
      });

      it("should return feature branch name", () => {
        git("checkout -b feature/test-branch");
        expect(getCurrentBranch(repoPath)).toBe("feature/test-branch");
      });

      it("should handle branch with special characters", () => {
        git("checkout -b worker/agent-1/task-123@abc");
        expect(getCurrentBranch(repoPath)).toBe("worker/agent-1/task-123@abc");
      });
    });

    describe("detectCleanupStatus", () => {
      it("should return ready=true for clean workspace", () => {
        const context: LifecycleContext = {
          agentId: "agent-1",
          role: "worker",
          workspacePath: repoPath,
        };

        const status = detectCleanupStatus(context);

        expect(status.ready).toBe(true);
        expect(status.reason).toBeUndefined();
        expect(status.uncommittedFiles).toBeUndefined();
      });

      it("should return ready=false with uncommitted files", () => {
        writeFile("dirty.txt", "uncommitted");
        const context: LifecycleContext = {
          agentId: "agent-1",
          role: "worker",
          workspacePath: repoPath,
        };

        const status = detectCleanupStatus(context);

        expect(status.ready).toBe(false);
        expect(status.reason).toContain("uncommitted");
        expect(status.uncommittedFiles).toContain("dirty.txt");
      });

      it("should handle workspace without git", () => {
        const nonGitDir = path.join(tempDir, "non-git");
        fs.mkdirSync(nonGitDir);

        const context: LifecycleContext = {
          agentId: "agent-1",
          role: "worker",
          workspacePath: nonGitDir,
        };

        // Should not throw, should assume uncommitted changes
        const status = detectCleanupStatus(context);
        expect(status.ready).toBe(true); // No uncommitted files detected
      });

      it("should handle missing workspace path", () => {
        const context: LifecycleContext = {
          agentId: "agent-1",
          role: "worker",
        };

        const status = detectCleanupStatus(context);

        expect(status.ready).toBe(true); // No workspace to check
      });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Commit Changes Helper
  // ─────────────────────────────────────────────────────────────────────────────

  describe("commitChanges helper", () => {
    it("should commit uncommitted files", () => {
      writeFile("newfile.txt", "content");
      expect(hasUncommittedChanges(repoPath)).toBe(true);

      const hash = commitChanges(repoPath, "Test commit message");

      expect(hash).toBeDefined();
      expect(hash).toHaveLength(40); // Full SHA
      expect(hasUncommittedChanges(repoPath)).toBe(false);
    });

    it("should include all changes in single commit", () => {
      writeFile("file1.txt", "content1");
      writeFile("file2.txt", "content2");
      writeFile("src/file3.ts", "content3");

      commitChanges(repoPath, "Multiple files");

      expect(hasUncommittedChanges(repoPath)).toBe(false);
      // Verify all files are in the commit
      const showFiles = git("show --name-only --pretty=format:");
      expect(showFiles).toContain("file1.txt");
      expect(showFiles).toContain("file2.txt");
      expect(showFiles).toContain("src/file3.ts");
    });

    it("should return undefined when nothing to commit", () => {
      const hash = commitChanges(repoPath, "No changes");
      expect(hash).toBeUndefined();
    });

    it("should use provided commit message", () => {
      writeFile("newfile.txt", "content");

      commitChanges(repoPath, "Custom commit message");

      const lastMessage = git("log -1 --pretty=%B");
      expect(lastMessage).toBe("Custom commit message");
    });

    it("should handle special characters in commit message", () => {
      writeFile("newfile.txt", "content");

      commitChanges(repoPath, 'Message with "quotes" and $pecial chars');

      const lastMessage = git("log -1 --pretty=%B");
      expect(lastMessage).toContain("quotes");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Worker Done Flow (Simulated)
  // ─────────────────────────────────────────────────────────────────────────────

  describe("worker done flow", () => {
    it("should detect dirty workspace and auto-commit on done", () => {
      // Simulate worker making changes (in existing tracked directory)
      writeFile("feature.ts", "export const feature = true;");

      // Detect cleanup status (would be done by done() tool)
      const context: LifecycleContext = {
        agentId: "worker-1",
        role: "worker",
        workspacePath: repoPath,
      };
      const status = detectCleanupStatus(context);
      expect(status.ready).toBe(false);
      expect(status.uncommittedFiles).toContain("feature.ts");

      // Auto-commit (simulating what worker handler does)
      const commitHash = commitChanges(repoPath, "WIP: Feature implementation");
      expect(commitHash).toBeDefined();

      // Now cleanup status should be ready
      const statusAfter = detectCleanupStatus(context);
      expect(statusAfter.ready).toBe(true);
    });

    it("should work with multiple uncommitted file types", () => {
      // Modified existing file
      writeFile("README.md", "# Updated README\n");

      // New files
      writeFile("src/new-module.ts", "export const x = 1;");
      writeFile("src/new-module.test.ts", "test()");

      // Deleted file (simulate by creating and then removing)
      writeFile("to-delete.txt", "temp");
      git("add to-delete.txt");
      git('commit -m "Add file to delete"');
      fs.unlinkSync(path.join(repoPath, "to-delete.txt"));

      const status = detectCleanupStatus({
        agentId: "worker-1",
        role: "worker",
        workspacePath: repoPath,
      });

      expect(status.ready).toBe(false);
      expect(status.uncommittedFiles?.length).toBeGreaterThanOrEqual(3);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Branch Operations
  // ─────────────────────────────────────────────────────────────────────────────

  describe("branch operations", () => {
    it("should detect branch for worker worktree-style branches", () => {
      // Create a branch mimicking worker worktree naming
      git("checkout -b worker/worker-123/task-456@1234567890");
      writeFile("feature.ts", "export const f = 1;");

      const branch = getCurrentBranch(repoPath);
      expect(branch).toBe("worker/worker-123/task-456@1234567890");

      // Even on a feature branch, cleanup detection should work
      const status = detectCleanupStatus({
        agentId: "worker-123",
        role: "worker",
        workspacePath: repoPath,
      });
      expect(status.ready).toBe(false);
      expect(status.uncommittedFiles).toContain("feature.ts");
    });

    it("should handle stream branch naming", () => {
      git("checkout -b stream/abc123def");

      expect(getCurrentBranch(repoPath)).toBe("stream/abc123def");
    });
  });
});
