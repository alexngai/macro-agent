/**
 * Cascade Termination Module
 *
 * Handles cascading termination of child agents when a parent agent completes.
 * Children are terminated depth-first (grandchildren before children).
 *
 * Change consolidation is stubbed for Phase 6.
 *
 * @module lifecycle/cascade
 * @see s-32xs Self-Cleaning Workers spec
 */

import type { AgentId } from "../store/types/index.js";
import type { CascadeOptions, CascadeResult } from "./types.js";

// =============================================================================
// Agent Manager Interface (to avoid circular dependency)
// =============================================================================

/**
 * Minimal agent interface for cascade operations
 */
export interface CascadeAgent {
  id: AgentId;
  state: "running" | "spawning" | "stopped";
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
// Change Consolidation (Stubbed for Phase 6)
// =============================================================================

/**
 * Terminate a child with change consolidation
 *
 * STUB: This is a placeholder for Phase 6 implementation.
 * Currently just delegates to regular cascade termination.
 *
 * In Phase 6, this will:
 * 1. Get child's workspace branch
 * 2. Create a merge request to parent's branch
 * 3. Wait for merge to complete (or queue it)
 * 4. Then terminate the child
 *
 * @param childId - Child agent to terminate
 * @param parentId - Parent agent to consolidate changes into
 * @param agentManager - Agent manager for operations
 */
export async function terminateWithChangeConsolidation(
  childId: AgentId,
  _parentId: AgentId,
  agentManager: CascadeAgentManager
): Promise<void> {
  // TODO Phase 6: Implement actual change consolidation
  // 1. Get child workspace info
  // 2. Create merge request: child.branch -> parent.branch
  // 3. Submit to merge queue
  // 4. Optionally wait for merge completion

  console.log(
    `[cascade] TODO Phase 6: consolidateChanges(${childId}.workspace -> parent.workspace)`
  );

  // For now, just terminate the child normally
  await agentManager.terminate(childId, "parent_stopped");
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
