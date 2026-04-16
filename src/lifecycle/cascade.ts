/**
 * Cascade Termination Module
 *
 * Handles cascading termination of child agents when a parent agent completes.
 * Children are terminated depth-first (grandchildren before children).
 *
 * Change consolidation merges child branches back to parent branches.
 *
 * @module lifecycle/cascade
 * @see s-32xs Self-Cleaning Workers spec
 * @see s-bcqm Change Management spec
 */

import type { AgentId } from "../store/types/index.js";
import type {
  CascadeOptions,
  CascadeResult,
  ConsolidationResult,
  ConsolidationOptions,
} from "./types.js";
import type { Workspace, WorkspaceManager } from "../workspace/types.js";
import { attemptMerge, abortMerge, getCurrentBranch } from "./cleanup.js";

// =============================================================================
// Agent Manager Interface (to avoid circular dependency)
// =============================================================================

/**
 * Minimal agent interface for cascade operations
 */
export interface CascadeAgent {
  id: AgentId;
  state: "running" | "spawning" | "stopped" | "failed";
  parent?: AgentId | null;
}

/**
 * Agent manager interface for cascade operations
 */
export interface CascadeAgentManager {
  /** Get children of an agent */
  getChildren(agentId: AgentId): CascadeAgent[];

  /** Terminate an agent */
  terminate(agentId: AgentId, reason: string): Promise<void>;
}

// =============================================================================
// Cascade Termination
// =============================================================================

/**
 * Cascade terminate all children of an agent (depth-first)
 *
 * This terminates grandchildren before children to ensure proper cleanup order.
 *
 * @param agentId - Parent agent ID
 * @param agentManager - Agent manager for terminate operations
 * @param options - Cascade options
 * @returns Cascade result with terminated agent IDs
 */
export async function cascadeTerminateChildren(
  agentId: AgentId,
  agentManager: CascadeAgentManager,
  options: CascadeOptions = { reason: "parent_stopped" }
): Promise<CascadeResult> {
  const terminatedIds: AgentId[] = [];
  const errors: Array<{ agentId: AgentId; error: string }> = [];

  // Get direct children
  const children = agentManager.getChildren(agentId);

  // Process each child depth-first
  for (const child of children) {
    // Skip already stopped agents
    if (child.state === "stopped") {
      continue;
    }

    try {
      // Recursively terminate grandchildren first
      const childCascade = await cascadeTerminateChildren(
        child.id,
        agentManager,
        options
      );

      // Accumulate results from grandchildren
      terminatedIds.push(...childCascade.terminatedIds);
      if (childCascade.errors) {
        errors.push(...childCascade.errors);
      }

      // Now terminate this child
      await agentManager.terminate(child.id, options.reason);
      terminatedIds.push(child.id);
    } catch (error) {
      errors.push({
        agentId: child.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    childrenTerminated: terminatedIds.length,
    terminatedIds,
    errors: errors.length > 0 ? errors : undefined,
  };
}

// =============================================================================
// Change Consolidation (Phase 6)
// =============================================================================

/**
 * Workspace provider interface for change consolidation.
 * Allows injection of workspace lookup without tight coupling.
 */
export interface WorkspaceProvider {
  /** Get workspace for an agent */
  getWorkspace(agentId: AgentId): Workspace | null;
}

/**
 * Terminate a child with change consolidation
 *
 * Merges the child's branch into the parent's branch before terminating.
 * If a merge conflict occurs, the merge is aborted and the child is
 * terminated with a "merge_conflict" reason.
 *
 * When a `workspaceManager` is provided AND both workspaces carry stream
 * ids, the merge is routed through `workspaceManager.mergeStream()` so
 * it flows through git-cascade's tracker — gaining a `stream.merged`
 * cascade event that propagates to the hub via CascadeBridge. This is
 * the primary observability win of A3 in the integration plan.
 *
 * Falls back to raw `attemptMerge` (unchanged behavior) when either
 * workspace lacks a stream id or no manager is passed — so
 * programmatic/legacy callers keep working unchanged.
 *
 * @param childId - Child agent to terminate
 * @param parentId - Parent agent to consolidate changes into
 * @param agentManager - Agent manager for operations
 * @param workspaceProvider - Optional workspace provider for getting agent workspaces
 * @param options - Optional consolidation options
 * @param workspaceManager - Optional workspace manager; enables cascade-
 *   event emission on the consolidation merge when both workspaces are
 *   stream-backed.
 * @returns ConsolidationResult indicating success or failure
 */
export async function terminateWithChangeConsolidation(
  childId: AgentId,
  parentId: AgentId,
  agentManager: CascadeAgentManager,
  workspaceProvider?: WorkspaceProvider,
  options?: ConsolidationOptions,
  workspaceManager?: WorkspaceManager,
  /**
   * Optional task reference inherited from the parent agent's metadata.
   * When provided + routing through the tracker, threaded into the
   * `x-cascade/stream.merged` emit so the hub's cascade_merges row records
   * which task drove the consolidation.
   */
  taskRef?: { resource_id: string; node_id: string }
): Promise<ConsolidationResult> {
  // If no workspace provider, just terminate normally
  if (!workspaceProvider) {
    await agentManager.terminate(childId, "parent_stopped");
    return { success: true, merged: false };
  }

  // Get workspaces for both child and parent
  const childWorkspace = workspaceProvider.getWorkspace(childId);
  const parentWorkspace = workspaceProvider.getWorkspace(parentId);

  // If either has no workspace, just terminate normally
  if (!childWorkspace || !parentWorkspace) {
    await agentManager.terminate(childId, "parent_stopped");
    return { success: true, merged: false };
  }

  // Get the child's branch name
  const childBranch = childWorkspace.branch;

  // Verify the parent worktree is on the expected branch
  const currentParentBranch = getCurrentBranch(parentWorkspace.path);
  if (currentParentBranch !== parentWorkspace.branch) {
    console.warn(
      `[cascade] Parent worktree is on '${currentParentBranch}' but expected '${parentWorkspace.branch}'`
    );
    // Continue with merge anyway - use the actual current branch
  }

  // Attempt to merge child branch into parent's worktree.
  //
  // Preferred path: route through workspaceManager.mergeStream when both
  // workspaces have stream ids. Goes via git-cascade's tracker.mergeStream,
  // which fires `x-cascade/stream.merged` with source/target stream ids so
  // the hub's cascade projection + the source stream's `merged` status
  // update in lockstep with the actual git operation.
  if (
    workspaceManager &&
    childWorkspace.streamId &&
    parentWorkspace.streamId
  ) {
    try {
      const result = workspaceManager.mergeStream({
        sourceStreamId: childWorkspace.streamId,
        targetStreamId: parentWorkspace.streamId,
        agentId: parentId,
        worktree: parentWorkspace.path,
        metadata: taskRef ? { task_ref: taskRef } : undefined,
      });
      if (result.success) {
        await agentManager.terminate(childId, "changes_consolidated");
        return {
          success: true,
          merged: true,
          mergeCommit: result.newHead,
        };
      }
      if (result.conflicts && result.conflicts.length > 0) {
        // Tracker already aborted; emit and terminate with conflict reason.
        console.warn(
          `[cascade] Merge conflict consolidating ${childId} -> ${parentId} via tracker: ${result.conflicts.join(", ")}`
        );
        await agentManager.terminate(childId, "merge_conflict");
        return {
          success: false,
          merged: false,
          conflicts: result.conflicts,
        };
      }
      // Tracker returned a non-conflict failure — fall through to raw
      // git path so we don't regress the consolidation semantics for
      // cases the tracker can't handle (e.g., stream in unexpected
      // status, detached HEAD, branch-name mismatches).
    } catch (err) {
      console.warn(
        `[cascade] tracker.mergeStream failed consolidating ${childId} -> ${parentId}; falling back to raw git: ${err instanceof Error ? err.message : String(err)}`
      );
      // Fall through to raw-git path below.
    }
  }

  // Fallback: raw git merge. Preserves pre-A3 behavior when streams
  // aren't available (programmatic callers, legacy role-shaped
  // workspaces) or when the tracker path bailed.
  const mergeMessage =
    options?.mergeMessage ??
    `Merge changes from ${childId} (${childBranch})`;

  const mergeResult = attemptMerge(childBranch, parentWorkspace.path, mergeMessage);

  if (mergeResult.success) {
    // Merge succeeded - terminate child normally
    await agentManager.terminate(childId, "changes_consolidated");
    return {
      success: true,
      merged: true,
      mergeCommit: mergeResult.mergeCommit,
    };
  }

  // Merge failed
  if (mergeResult.conflicts && mergeResult.conflicts.length > 0) {
    // Conflict detected - abort the merge and terminate with conflict status
    abortMerge(parentWorkspace.path);

    console.warn(
      `[cascade] Merge conflict consolidating ${childId} -> ${parentId}: ${mergeResult.conflicts.join(", ")}`
    );

    // Terminate child with conflict reason
    await agentManager.terminate(childId, "merge_conflict");

    return {
      success: false,
      merged: false,
      conflicts: mergeResult.conflicts,
    };
  }

  // Non-conflict error
  console.error(
    `[cascade] Merge failed consolidating ${childId} -> ${parentId}: ${mergeResult.error}`
  );

  // Still terminate the child, but note the failure
  await agentManager.terminate(childId, "merge_failed");

  return {
    success: false,
    merged: false,
    error: mergeResult.error,
  };
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Get all descendants of an agent (children, grandchildren, etc.)
 */
export function getAllDescendants(
  agentId: AgentId,
  agentManager: CascadeAgentManager
): CascadeAgent[] {
  const descendants: CascadeAgent[] = [];
  const children = agentManager.getChildren(agentId);

  for (const child of children) {
    descendants.push(child);
    // Recursively get grandchildren
    const grandchildren = getAllDescendants(child.id, agentManager);
    descendants.push(...grandchildren);
  }

  return descendants;
}

/**
 * Check if cascade termination is needed (agent has running children)
 */
export function needsCascadeTermination(
  agentId: AgentId,
  agentManager: CascadeAgentManager
): boolean {
  const children = agentManager.getChildren(agentId);
  return children.some(
    (child) => child.state === "running" || child.state === "spawning"
  );
}
