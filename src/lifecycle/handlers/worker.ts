/**
 * Worker Done Handler
 *
 * Handles done() for worker agents:
 * - Commits workspace changes (no push - bare repo shared)
 * - Creates checkpoints for task commits
 * - Emits WORKER_DONE signal
 * - Emits MERGE_REQUEST signal and submits to merge queue
 * - Signals descendants to prepare for termination
 *
 * Note: Actual termination is handled by AgentManager after done() returns.
 * The AgentManager.terminate() method cascades depth-first to all children.
 * This handler emits signals for notification only.
 *
 * @module lifecycle/handlers/worker
 * @see s-32xs Self-Cleaning Workers spec
 * @see s-bcqm Change Management spec
 */

import type { MessageRouter } from "../../router/message-router.js";
import type { AgentManager } from "../../agent/agent-manager.js";
import type { DataplaneAdapter } from "../../workspace/dataplane-adapter.js";
import type { MergeQueueInterface } from "../../workspace/merge-queue/types.js";
import type {
  LifecycleContext,
  DoneArgs,
  CleanupStatus,
  DoneHandlerResult,
} from "../types.js";
import { commitChanges, getCurrentBranch } from "../cleanup.js";
import {
  getAllDescendants,
  needsCascadeTermination,
  type CascadeAgentManager,
} from "../cascade.js";

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

  /** Dataplane adapter for checkpoint creation (optional) */
  dataplane?: DataplaneAdapter;

  /** Merge queue for submitting merge requests (optional) */
  mergeQueue?: MergeQueueInterface;
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
  // Step 1.5: Create checkpoints for task commits (Phase 6)
  // ─────────────────────────────────────────────────────────────────────────────

  if (deps.dataplane && context.taskId) {
    try {
      const checkpoints = deps.dataplane.createCheckpointsForTask(
        context.taskId,
        context.agentId
      );
      if (checkpoints.length > 0) {
        cleanupActions.push(
          `Created ${checkpoints.length} checkpoint(s) for task ${context.taskId}`
        );
      }
    } catch (error) {
      warnings.push(
        `Failed to create checkpoints: ${error instanceof Error ? error.message : "unknown"}`
      );
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
  // Step 3: Emit MERGE_REQUEST signal and submit to queue
  // ─────────────────────────────────────────────────────────────────────────────

  if (args.status === "completed" && context.workspacePath) {
    const sourceBranch = context.branch ?? getCurrentBranch(context.workspacePath);
    const targetBranch = context.integrationBranch ?? "integration";

    if (sourceBranch) {
      try {
        // Emit the signal for notification
        deps.messageRouter.emitStatus({
          from: { agent_id: context.agentId },
          status_type: "checkpoint",
          summary: `Merge request for branch ${sourceBranch}`,
          details: {
            signal: "MERGE_REQUEST",
            sourceBranch,
            targetBranch,
            taskId: context.taskId,
            workerId: context.agentId,
          },
        });
        signalsEmitted.push("MERGE_REQUEST");

        // Submit to actual merge queue if available
        if (deps.mergeQueue && context.streamId && context.taskId) {
          try {
            const mrId = deps.mergeQueue.submit({
              streamId: context.streamId,
              taskId: context.taskId,
              workerBranch: sourceBranch,
              workerAgentId: context.agentId,
            });
            cleanupActions.push(
              `Submitted merge request ${mrId} to queue for ${sourceBranch} -> ${targetBranch}`
            );
          } catch (queueError) {
            warnings.push(
              `Failed to submit to merge queue: ${queueError instanceof Error ? queueError.message : "unknown"}`
            );
            cleanupActions.push(
              `MERGE_REQUEST emitted for ${sourceBranch} -> ${targetBranch} (queue submission failed)`
            );
          }
        } else {
          // No queue configured or missing required context
          const reason = !deps.mergeQueue
            ? "no queue configured"
            : !context.streamId
              ? "no streamId"
              : "no taskId";
          cleanupActions.push(
            `MERGE_REQUEST emitted for ${sourceBranch} -> ${targetBranch} (${reason})`
          );
        }
      } catch (error) {
        warnings.push(
          `Failed to emit MERGE_REQUEST: ${error instanceof Error ? error.message : "unknown"}`
        );
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Step 4: Signal descendants to prepare for termination
  // ─────────────────────────────────────────────────────────────────────────────
  // Note: This is notification only. Actual termination is handled by
  // AgentManager.terminate() which cascades depth-first after done() returns.

  try {
    // Create cascade adapter from AgentManager
    const cascadeAdapter: CascadeAgentManager = {
      getChildren: (agentId) => {
        const children = deps.agentManager.getChildren(agentId);
        return children.map((c) => ({
          id: c.id,
          state: c.state,
          parent: c.parent,
        }));
      },
      terminate: async () => {
        // No-op: actual termination handled by AgentManager after done()
      },
    };

    // Check if cascade signaling is needed
    if (needsCascadeTermination(context.agentId, cascadeAdapter)) {
      // Get ALL descendants (children, grandchildren, etc.)
      const descendants = getAllDescendants(context.agentId, cascadeAdapter);
      const activeDescendants = descendants.filter(
        (d) => d.state === "running" || d.state === "spawning"
      );

      if (activeDescendants.length > 0) {
        cleanupActions.push(
          `Signaling ${activeDescendants.length} descendant(s) to terminate`
        );

        // Signal all active descendants - notification for cleanup preparation
        // Actual termination will cascade depth-first via AgentManager
        for (const descendant of activeDescendants) {
          try {
            deps.messageRouter.emitStatus({
              from: { agent_id: context.agentId },
              status_type: "completed",
              summary: `Parent ${context.agentId} signaling termination`,
              details: {
                signal: "FORCE_TERMINATE_REQUEST",
                agentId: descendant.id,
                reason: "parent_stopped",
                requestedBy: context.agentId,
              },
            });
          } catch {
            warnings.push(`Failed to signal descendant ${descendant.id}`);
          }
        }
      }
    }
  } catch (error) {
    warnings.push(
      `Failed to signal descendants: ${error instanceof Error ? error.message : "unknown"}`
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
