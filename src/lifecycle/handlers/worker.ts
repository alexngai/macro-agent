/**
 * Worker Done Handler
 *
 * Handles done() for worker agents:
 * - Commits workspace changes (no push - bare repo shared)
 * - Cascades terminate to children (basic, no consolidation yet)
 * - Emits WORKER_DONE signal
 * - Emits MERGE_REQUEST signal (queue submission stubbed for Phase 6)
 *
 * @module lifecycle/handlers/worker
 * @see s-32xs Self-Cleaning Workers spec
 */

import type { MessageRouter } from "../../router/message-router.js";
import type { AgentManager } from "../../agent/agent-manager.js";
import type {
  LifecycleContext,
  DoneArgs,
  CleanupStatus,
  DoneHandlerResult,
} from "../types.js";
import { commitChanges, getCurrentBranch } from "../cleanup.js";

// =============================================================================
// Handler Dependencies
// =============================================================================

/**
 * Dependencies for the worker handler
 */
export interface WorkerHandlerDeps {
  /** Message router for emitting signals */
  messageRouter: MessageRouter;

  /** Agent manager for cascade termination */
  agentManager: AgentManager;
}

// =============================================================================
// Worker Handler
// =============================================================================

/**
 * Handle done() for worker agents
 *
 * Processing steps:
 * 1. Commit any uncommitted changes
 * 2. Emit WORKER_DONE signal
 * 3. Emit MERGE_REQUEST signal (stubbed)
 * 4. Signal children to terminate (basic cascade)
 * 5. Return shouldTerminate=true
 */
export async function handleWorkerDone(
  context: LifecycleContext,
  args: DoneArgs,
  cleanupStatus: CleanupStatus,
  deps: WorkerHandlerDeps
): Promise<DoneHandlerResult> {
  const signalsEmitted: string[] = [];
  const cleanupActions: string[] = [];
  const warnings: string[] = [];

  // ─────────────────────────────────────────────────────────────────────────────
  // Step 1: Commit uncommitted changes
  // ─────────────────────────────────────────────────────────────────────────────

  if (context.workspacePath && !cleanupStatus.ready) {
    const uncommittedCount = cleanupStatus.uncommittedFiles?.length ?? 0;
    if (uncommittedCount > 0) {
      const commitMessage = args.summary
        ? `WIP: ${args.summary}`
        : `WIP: Auto-commit from done() with ${uncommittedCount} uncommitted file(s)`;

      const commitHash = commitChanges(context.workspacePath, commitMessage);
      if (commitHash) {
        cleanupActions.push(`Committed ${uncommittedCount} file(s): ${commitHash.slice(0, 8)}`);
      } else {
        warnings.push("Failed to auto-commit uncommitted changes");
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Step 2: Emit WORKER_DONE signal
  // ─────────────────────────────────────────────────────────────────────────────

  try {
    deps.messageRouter.emitStatus({
      from: { agent_id: context.agentId },
      status_type: args.status === "completed" ? "completed" : "failed",
      summary: args.summary ?? `Worker done with status: ${args.status}`,
      details: {
        signal: "WORKER_DONE",
        workerId: context.agentId,
        taskId: context.taskId,
        status: args.status,
        ...args.details,
      },
    });
    signalsEmitted.push("WORKER_DONE");
  } catch (error) {
    warnings.push(
      `Failed to emit WORKER_DONE: ${error instanceof Error ? error.message : "unknown"}`
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Step 3: Emit MERGE_REQUEST signal (stubbed for Phase 6)
  // ─────────────────────────────────────────────────────────────────────────────

  if (args.status === "completed" && context.workspacePath) {
    const branch = context.branch ?? getCurrentBranch(context.workspacePath);
    if (branch) {
      try {
        // Emit the signal - actual queue submission is stubbed for Phase 6
        deps.messageRouter.emitStatus({
          from: { agent_id: context.agentId },
          status_type: "checkpoint",
          summary: `Merge request for branch ${branch}`,
          details: {
            signal: "MERGE_REQUEST",
            sourceBranch: branch,
            targetBranch: "integration", // TODO: Get from parent/config
            taskId: context.taskId,
            workerId: context.agentId,
          },
        });
        signalsEmitted.push("MERGE_REQUEST");

        // TODO Phase 6: Submit to actual merge queue
        // mergeQueue.submit({ sourceBranch: branch, targetBranch, taskId, workerId });
        cleanupActions.push(`MERGE_REQUEST emitted for ${branch} (queue submission stubbed for Phase 6)`);
      } catch (error) {
        warnings.push(
          `Failed to emit MERGE_REQUEST: ${error instanceof Error ? error.message : "unknown"}`
        );
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Step 4: Cascade terminate to children (basic - no consolidation)
  // ─────────────────────────────────────────────────────────────────────────────

  try {
    const children = await deps.agentManager.getChildren(context.agentId);
    if (children.length > 0) {
      cleanupActions.push(`Signaling ${children.length} child(ren) to terminate`);

      // Signal children - actual termination happens after tool execution
      // The cascade will be performed by the MCP server after done() returns
      for (const child of children) {
        try {
          // Emit termination signal to each child
          deps.messageRouter.emitStatus({
            from: { agent_id: context.agentId },
            status_type: "completed",
            summary: `Parent ${context.agentId} signaling termination`,
            details: {
              signal: "FORCE_TERMINATE_REQUEST",
              agentId: child.id,
              reason: "parent_stopped",
              requestedBy: context.agentId,
            },
          });
        } catch {
          warnings.push(`Failed to signal child ${child.id}`);
        }
      }
    }
  } catch (error) {
    warnings.push(
      `Failed to get children: ${error instanceof Error ? error.message : "unknown"}`
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Return result - shouldTerminate=true for workers
  // ─────────────────────────────────────────────────────────────────────────────

  return {
    shouldTerminate: true,
    signalsEmitted,
    cleanupActions,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}
