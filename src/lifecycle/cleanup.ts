/**
 * Cleanup Status Detection
 *
 * Auto-detects workspace cleanup readiness by checking:
 * - Uncommitted changes via git status
 *
 * @module lifecycle/cleanup
 * @see s-32xs Self-Cleaning Workers spec
 */

import * as fs from "fs";
import * as path from "path";
import { execSync, execFileSync } from "child_process";
import type { CleanupStatus, LifecycleContext } from "./types.js";

// =============================================================================
// Cleanup Detection Interface
// =============================================================================

/**
 * Dependencies for cleanup detection (currently empty — extend for V2 adapters if needed)
 */
export interface CleanupDependencies {}

// =============================================================================
// Git Status Helpers
// =============================================================================

/**
 * Check if a workspace has uncommitted changes
 */
export function hasUncommittedChanges(workspacePath: string): boolean {
  try {
    const status = execSync("git status --porcelain", {
      cwd: workspacePath,
      encoding: "utf-8",
    });
    return status.trim() !== "";
  } catch {
    // If git command fails, assume there are uncommitted changes
    return true;
  }
}

/**
 * Get list of uncommitted files in a workspace
 */
export function getUncommittedFiles(workspacePath: string): string[] {
  try {
    const status = execSync("git status --porcelain", {
      cwd: workspacePath,
      encoding: "utf-8",
    });
    if (!status.trim()) return [];

    // Split by newlines, filter empty lines, then extract filename
    // Git status format: XY FILENAME (2 char status + space + filename)
    return status
      .split("\n")
      .filter((line) => line.length > 3)
      .map((line) => line.slice(3).trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Get current branch name
 */
export function getCurrentBranch(workspacePath: string): string | undefined {
  try {
    return execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: workspacePath,
      encoding: "utf-8",
    }).trim();
  } catch {
    return undefined;
  }
}

// =============================================================================
// Main Detection Function
// =============================================================================

/**
 * Detect cleanup status for an agent
 *
 * Checks uncommitted changes in workspace.
 * Pending message checks are handled by agent-inbox directly.
 *
 * @param context - Lifecycle context with agent info
 * @param _deps - Dependencies (currently unused, reserved for future)
 * @returns Cleanup status indicating readiness
 */
export function detectCleanupStatus(
  context: LifecycleContext,
  _deps: CleanupDependencies = {}
): CleanupStatus {
  const reasons: string[] = [];
  let uncommittedFiles: string[] = [];

  // Check uncommitted changes if workspace path is available
  if (context.workspacePath) {
    uncommittedFiles = getUncommittedFiles(context.workspacePath);
    if (uncommittedFiles.length > 0) {
      reasons.push(
        `${uncommittedFiles.length} uncommitted file(s): ${uncommittedFiles.slice(0, 3).join(", ")}${uncommittedFiles.length > 3 ? "..." : ""}`
      );
    }
  }

  const ready = reasons.length === 0;

  return {
    ready,
    reason: ready ? undefined : reasons.join("; "),
    uncommittedFiles: uncommittedFiles.length > 0 ? uncommittedFiles : undefined,
  };
}

// =============================================================================
// Commit Changes Helper
// =============================================================================

/**
 * Commit all uncommitted changes in a workspace
 *
 * @param workspacePath - Path to the workspace
 * @param message - Commit message
 * @returns Commit hash if successful, undefined if nothing to commit
 */
export function commitChanges(
  workspacePath: string,
  message: string
): string | undefined {
  try {
    // Check if there are changes to commit
    if (!hasUncommittedChanges(workspacePath)) {
      return undefined;
    }

    // Stage all changes
    execFileSync("git", ["add", "--all"], {
      cwd: workspacePath,
      encoding: "utf-8",
    });

    // Commit - use execFileSync with array args to prevent command injection
    execFileSync("git", ["commit", "-m", message], {
      cwd: workspacePath,
      encoding: "utf-8",
    });

    // Get commit hash
    const hash = execSync("git rev-parse HEAD", {
      cwd: workspacePath,
      encoding: "utf-8",
    }).trim();

    return hash;
  } catch {
    return undefined;
  }
}

// =============================================================================
// Merge Helpers (Phase 6 - Change Consolidation)
// =============================================================================

/**
 * Result of a merge attempt
 */
export interface MergeResult {
  /** Whether the merge succeeded */
  success: boolean;

  /** Merge commit hash if successful (only set if a new merge commit was created) */
  mergeCommit?: string;

  /** True if branches were already merged (no new commit created) */
  alreadyMerged?: boolean;

  /** List of conflicting files if merge failed */
  conflicts?: string[];

  /** Error message if merge failed for non-conflict reason */
  error?: string;
}

/**
 * Attempt to merge a source branch into the target branch.
 *
 * This performs the merge in the specified worktree, which should already
 * be on the target branch.
 *
 * @param sourceBranch - Branch to merge from
 * @param worktreePath - Path to worktree (should be on target branch)
 * @param message - Optional merge commit message
 * @returns MergeResult indicating success or conflict details
 */
export function attemptMerge(
  sourceBranch: string,
  worktreePath: string,
  message?: string
): MergeResult {
  try {
    // Capture HEAD before merge to detect "already up-to-date" scenario
    const headBefore = execSync("git rev-parse HEAD", {
      cwd: worktreePath,
      encoding: "utf-8",
    }).trim();

    // Merge with execFileSync to prevent command injection
    const mergeMessage = message ?? `Merge branch '${sourceBranch}'`;
    execFileSync("git", ["merge", sourceBranch, "--no-ff", "-m", mergeMessage], {
      cwd: worktreePath,
      encoding: "utf-8",
      stdio: "pipe",
    });

    // Get HEAD after merge
    const headAfter = execSync("git rev-parse HEAD", {
      cwd: worktreePath,
      encoding: "utf-8",
    }).trim();

    // Check if HEAD changed - if not, branches were already merged
    if (headBefore === headAfter) {
      return {
        success: true,
        alreadyMerged: true,
      };
    }

    return {
      success: true,
      mergeCommit: headAfter,
    };
  } catch (error) {
    // Check if this is a merge conflict
    try {
      const status = execSync("git status --porcelain", {
        cwd: worktreePath,
        encoding: "utf-8",
      });

      // Look for unmerged files (UU, AA, DD, etc.)
      // Note: Using regex without /g flag since we test one line at a time
      const conflictPattern = /^(UU|AA|DD|AU|UA|DU|UD) /;
      const conflicts: string[] = [];

      for (const line of status.split("\n")) {
        if (conflictPattern.test(line)) {
          // Extract filename (after the status prefix)
          const filename = line.slice(3).trim();
          if (filename) {
            conflicts.push(filename);
          }
        }
      }

      if (conflicts.length > 0) {
        return {
          success: false,
          conflicts,
        };
      }
    } catch {
      // Ignore status check errors
    }

    // Non-conflict error
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Abort an in-progress merge.
 *
 * @param worktreePath - Path to worktree with merge in progress
 * @returns true if abort succeeded, false otherwise
 */
export function abortMerge(worktreePath: string): boolean {
  try {
    execSync("git merge --abort", {
      cwd: worktreePath,
      encoding: "utf-8",
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a worktree has a merge in progress.
 *
 * @param worktreePath - Path to worktree
 * @returns true if merge is in progress
 */
export function hasMergeInProgress(worktreePath: string): boolean {
  try {
    const gitDir = execSync("git rev-parse --git-dir", {
      cwd: worktreePath,
      encoding: "utf-8",
    }).trim();

    // Check for MERGE_HEAD file
    return fs.existsSync(path.join(worktreePath, gitDir, "MERGE_HEAD"));
  } catch {
    return false;
  }
}

/**
 * Get the current branch of a worktree.
 * Alias for getCurrentBranch for clarity.
 */
export { getCurrentBranch as getWorktreeBranch };
