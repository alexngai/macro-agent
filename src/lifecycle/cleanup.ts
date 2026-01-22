/**
 * Cleanup Status Detection
 *
 * Auto-detects workspace cleanup readiness by checking:
 * - Uncommitted changes via git status
 * - Pending messages via MessageRouter
 *
 * @module lifecycle/cleanup
 * @see s-32xs Self-Cleaning Workers spec
 */

import { execSync } from "child_process";
import type { CleanupStatus, LifecycleContext } from "./types.js";
import type { MessageRouter } from "../router/message-router.js";

// =============================================================================
// Cleanup Detection Interface
// =============================================================================

/**
 * Dependencies for cleanup detection
 */
export interface CleanupDependencies {
  /** Message router for checking pending messages */
  messageRouter?: MessageRouter;
}

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
// Message Status Helpers
// =============================================================================

/**
 * Get count of pending (unacknowledged) messages for an agent
 */
export function getPendingMessageCount(
  agentId: string,
  messageRouter?: MessageRouter
): number {
  if (!messageRouter) {
    return 0;
  }

  try {
    const messages = messageRouter.getMessages(agentId, {
      includeAcknowledged: false,
    });
    return messages.length;
  } catch {
    return 0;
  }
}

// =============================================================================
// Main Detection Function
// =============================================================================

/**
 * Detect cleanup status for an agent
 *
 * Checks:
 * 1. Uncommitted changes in workspace
 * 2. Pending (unacknowledged) messages
 *
 * @param context - Lifecycle context with agent info
 * @param deps - Dependencies for detection
 * @returns Cleanup status indicating readiness
 */
export function detectCleanupStatus(
  context: LifecycleContext,
  deps: CleanupDependencies = {}
): CleanupStatus {
  const reasons: string[] = [];
  let uncommittedFiles: string[] = [];
  let pendingMessages = 0;

  // Check uncommitted changes if workspace path is available
  if (context.workspacePath) {
    uncommittedFiles = getUncommittedFiles(context.workspacePath);
    if (uncommittedFiles.length > 0) {
      reasons.push(
        `${uncommittedFiles.length} uncommitted file(s): ${uncommittedFiles.slice(0, 3).join(", ")}${uncommittedFiles.length > 3 ? "..." : ""}`
      );
    }
  }

  // Check pending messages
  pendingMessages = getPendingMessageCount(context.agentId, deps.messageRouter);
  if (pendingMessages > 0) {
    reasons.push(`${pendingMessages} pending message(s)`);
  }

  // Determine readiness
  const ready = reasons.length === 0;

  return {
    ready,
    reason: ready ? undefined : reasons.join("; "),
    uncommittedFiles: uncommittedFiles.length > 0 ? uncommittedFiles : undefined,
    pendingMessages: pendingMessages > 0 ? pendingMessages : undefined,
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
    execSync("git add --all", {
      cwd: workspacePath,
      encoding: "utf-8",
    });

    // Commit
    execSync(`git commit -m "${message.replace(/"/g, '\\"')}"`, {
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
