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
import {
  handleResolverDone,
  type IntegratorHandlerDeps,
} from "./integrator.js";

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

  /** Get workspace path for an agent (for resolver → integrator inline merge) */
  getWorkspacePath?: (agentId: string) => string | undefined;

  /** Optional integration strategy (from team config) */
  integrationStrategy?: import("../../workspace/strategies/types.js").IntegrationStrategy;

  /** Optional task mode from team config */
  taskMode?: "push" | "pull";
}

// =============================================================================
// Worker Handler
// =============================================================================

/**
 * Handle done() for worker agents
 *
 * Processing steps:
 * 1. Commit any uncommitted changes
 * 1.5. Create checkpoints for task commits (Phase 6)
 * 2. Handle blocked/deferred status (emit HELP_NEEDED, return shouldTerminate=false)
 * 3. Emit WORKER_DONE signal (for completed/failed)
 * 4. Emit MERGE_REQUEST signal and submit to queue
 * 5. Signal children to terminate (basic cascade)
 * 6. Return shouldTerminate=true (for completed/failed only)
 */
export async function handleWorkerDone(
  context: LifecycleContext,
  args: DoneArgs,
  cleanupStatus: CleanupStatus,
  deps: WorkerHandlerDeps,
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
        cleanupActions.push(
          `Committed ${uncommittedCount} file(s): ${commitHash.slice(0, 8)}`,
        );
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
        context.agentId,
      );
      if (checkpoints.length > 0) {
        cleanupActions.push(
          `Created ${checkpoints.length} checkpoint(s) for task ${context.taskId}`,
        );
      }
    } catch (error) {
      warnings.push(
        `Failed to create checkpoints: ${error instanceof Error ? error.message : "unknown"}`,
      );
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Step 2: Handle blocked/deferred status (don't terminate, emit HELP_NEEDED)
  // Per s-32xs spec: "Agent explicitly blocked → Self-report + wait → Needs help, don't auto-terminate"
  // ─────────────────────────────────────────────────────────────────────────────

  if (args.status === "blocked") {
    try {
      deps.messageRouter.emitStatus({
        from: { agent_id: context.agentId },
        status_type: "blocked",
        summary: args.summary ?? `Worker blocked - needs help`,
        details: {
          signal: "HELP_NEEDED",
          workerId: context.agentId,
          taskId: context.taskId,
          parentId: context.parentId,
          status: args.status,
          ...args.details,
        },
      });
      signalsEmitted.push("HELP_NEEDED");
    } catch (error) {
      warnings.push(
        `Failed to emit HELP_NEEDED: ${error instanceof Error ? error.message : "unknown"}`,
      );
    }

    // Blocked agents should NOT terminate - they wait for help
    return {
      shouldTerminate: false,
      signalsEmitted,
      cleanupActions,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }

  if (args.status === "deferred") {
    try {
      deps.messageRouter.emitStatus({
        from: { agent_id: context.agentId },
        status_type: "checkpoint",
        summary: args.summary ?? `Worker deferred work`,
        details: {
          signal: "WORKER_DEFERRED",
          workerId: context.agentId,
          taskId: context.taskId,
          status: args.status,
          ...args.details,
        },
      });
      signalsEmitted.push("WORKER_DEFERRED");
    } catch (error) {
      warnings.push(
        `Failed to emit WORKER_DEFERRED: ${error instanceof Error ? error.message : "unknown"}`,
      );
    }

    // Deferred agents should NOT terminate
    return {
      shouldTerminate: false,
      signalsEmitted,
      cleanupActions,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Step 3: Emit WORKER_DONE signal (for completed/failed)
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
      `Failed to emit WORKER_DONE: ${error instanceof Error ? error.message : "unknown"}`,
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Step 4: Emit MERGE_REQUEST signal and submit to queue
  // ─────────────────────────────────────────────────────────────────────────────

  if (args.status === "completed" && context.workspacePath) {
    const sourceBranch =
      context.branch ?? getCurrentBranch(context.workspacePath);
    const targetBranch = context.integrationBranch ?? "integration";

    // Check if this is a resolver worker
    const isResolver = context.role === "worker.resolver";

    if (sourceBranch) {
      if (isResolver) {
        // ───────────────────────────────────────────────────────────────────────
        // Resolver workers emit RESOLVER_DONE instead of MERGE_REQUEST
        // They do NOT submit to the merge queue - integrator merges inline
        // ───────────────────────────────────────────────────────────────────────
        try {
          deps.messageRouter.emitStatus({
            from: { agent_id: context.agentId },
            status_type: "completed",
            summary: `Resolver completed${context.mrId ? ` for MR ${context.mrId}` : ""}`,
            details: {
              signal: "RESOLVER_DONE",
              mrId: context.mrId,
              resolverBranch: sourceBranch,
              resolverId: context.agentId,
              taskId: context.taskId,
              status: args.status,
            },
          });
          signalsEmitted.push("RESOLVER_DONE");
          cleanupActions.push(
            `Emitted RESOLVER_DONE for resolver branch ${sourceBranch}${context.mrId ? ` (MR: ${context.mrId})` : ""}`,
          );

          // ─────────────────────────────────────────────────────────────────────
          // Trigger inline merge on behalf of integrator (parent)
          // ─────────────────────────────────────────────────────────────────────
          if (context.mrId && context.parentId && deps.getWorkspacePath) {
            const integratorWorkspace = deps.getWorkspacePath(context.parentId);

            if (integratorWorkspace) {
              // Build integrator context for the inline merge
              const integratorContext: LifecycleContext = {
                agentId: context.parentId,
                role: "integrator",
                workspacePath: integratorWorkspace,
                streamId: context.streamId,
                branch: context.integrationBranch ?? "integration",
              };

              // Build integrator deps
              const integratorDeps: IntegratorHandlerDeps = {
                messageRouter: deps.messageRouter,
                mergeQueue: deps.mergeQueue,
                workspacePath: integratorWorkspace,
                agentManager: deps.agentManager,
              };

              try {
                const resolverResult = await handleResolverDone(
                  context.mrId,
                  sourceBranch,
                  integratorContext,
                  integratorDeps,
                );

                if (resolverResult.success) {
                  cleanupActions.push(
                    `Inline merge completed for MR ${context.mrId}: ${resolverResult.mergeCommit?.slice(0, 8)}`,
                  );
                } else if (resolverResult.nestedConflict) {
                  warnings.push(
                    `Nested conflict on MR ${context.mrId} - escalated to coordinator`,
                  );
                } else {
                  warnings.push(
                    `Inline merge failed for MR ${context.mrId}: ${resolverResult.error}`,
                  );
                }
              } catch (mergeError) {
                warnings.push(
                  `Error during inline merge for MR ${context.mrId}: ${mergeError instanceof Error ? mergeError.message : "unknown"}`,
                );
              }
            } else {
              warnings.push(
                `Cannot perform inline merge: integrator workspace not found for parent ${context.parentId}`,
              );
            }
          } else if (!context.mrId) {
            warnings.push("Cannot perform inline merge: no mrId in context");
          } else if (!context.parentId) {
            warnings.push(
              "Cannot perform inline merge: no parent (integrator) in context",
            );
          }
        } catch (error) {
          warnings.push(
            `Failed to emit RESOLVER_DONE: ${error instanceof Error ? error.message : "unknown"}`,
          );
        }
      } else if (deps.integrationStrategy) {
        // ───────────────────────────────────────────────────────────────────────
        // Strategy-based integration (team config)
        // ───────────────────────────────────────────────────────────────────────
        try {
          const landResult = await deps.integrationStrategy.land({
            sourceBranch,
            targetBranch,
            workspacePath: context.workspacePath!,
            agentId: context.agentId,
            taskId: context.taskId,
            streamId: context.streamId,
          });

          if (landResult.status === "landed") {
            cleanupActions.push(
              `Strategy '${deps.integrationStrategy.name}' landed ${sourceBranch} → ${targetBranch}${landResult.commitHash ? ` (${landResult.commitHash.slice(0, 8)})` : ""}${landResult.mergeRequestId ? ` (MR: ${landResult.mergeRequestId})` : ""}`,
            );
            signalsEmitted.push("WORKER_INTEGRATED");
          } else if (landResult.status === "conflict") {
            warnings.push(
              `Strategy '${deps.integrationStrategy.name}' conflict: ${landResult.error ?? "unknown conflict"}`,
            );
          } else {
            warnings.push(
              `Strategy '${deps.integrationStrategy.name}' failed: ${landResult.error ?? "unknown error"}`,
            );
          }
        } catch (strategyError) {
          warnings.push(
            `Integration strategy error: ${strategyError instanceof Error ? strategyError.message : "unknown"}`,
          );
        }
      } else {
        // ───────────────────────────────────────────────────────────────────────
        // Regular workers emit MERGE_REQUEST and submit to queue (fallback)
        // ───────────────────────────────────────────────────────────────────────
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
                `Submitted merge request ${mrId} to queue for ${sourceBranch} -> ${targetBranch}`,
              );
            } catch (queueError) {
              warnings.push(
                `Failed to submit to merge queue: ${queueError instanceof Error ? queueError.message : "unknown"}`,
              );
              cleanupActions.push(
                `MERGE_REQUEST emitted for ${sourceBranch} -> ${targetBranch} (queue submission failed)`,
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
              `MERGE_REQUEST emitted for ${sourceBranch} -> ${targetBranch} (${reason})`,
            );
          }
        } catch (error) {
          warnings.push(
            `Failed to emit MERGE_REQUEST: ${error instanceof Error ? error.message : "unknown"}`,
          );
        }
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Step 5: Signal descendants to prepare for termination
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
        (d) => d.state === "running" || d.state === "spawning",
      );

      if (activeDescendants.length > 0) {
        cleanupActions.push(
          `Signaling ${activeDescendants.length} descendant(s) to terminate`,
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
      `Failed to signal descendants: ${error instanceof Error ? error.message : "unknown"}`,
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Return result
  // ─────────────────────────────────────────────────────────────────────────────

  // In pull mode, completed workers stay alive to claim more tasks
  const shouldTerminate =
    deps.taskMode === "pull" && args.status === "completed"
      ? false
      : true;

  return {
    shouldTerminate,
    signalsEmitted,
    cleanupActions,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}
