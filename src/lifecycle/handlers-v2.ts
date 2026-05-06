/**
 * Lifecycle Handlers V2
 *
 * Simplified done() handlers that use InboxAdapter instead of MessageRouter.
 *
 * Key simplifications vs V1:
 * - Worker handler no longer constructs merge requests (AgentManagerV2.terminate handles that)
 * - Worker handler no longer reads git branches
 * - All signal emission goes through InboxAdapter
 * - Monitor handler no longer needs MessageRouter for subscription management
 * - Integration strategy dispatch removed (handled at terminate level)
 *
 * @module lifecycle/handlers-v2
 */

import type { InboxAdapter } from "../adapters/types.js";
import type { TasksAdapter } from "../adapters/types.js";
import type { AgentManager } from "../agent/agent-manager.js";
import type { AgentStore } from "../agent/agent-store.js";
import { getPermissionOverlay } from "../dispatch/permission-overlay.js";
import type {
  LifecycleContext,
  DoneArgs,
  CleanupStatus,
  DoneHandlerResult,
} from "./types.js";
import { commitChanges, attemptMerge, abortMerge, type TrackedCommitHandle } from "./cleanup.js";
import type { MergeQueueInterface } from "../workspace/merge-queue/types.js";
import type { WorkspaceManager } from "../workspace/types.js";
import {
  getAllDescendants,
  needsCascadeTermination,
  type CascadeAgentManager,
} from "./cascade.js";

// =============================================================================
// Handler Dependencies
// =============================================================================

export interface HandlerDepsV2 {
  inboxAdapter: InboxAdapter;
  tasksAdapter: TasksAdapter;
  agentManager: AgentManager;
  taskMode?: "push" | "pull";
  mergeQueue?: MergeQueueInterface;
  /**
   * Optional workspace manager. When provided AND `context.streamId` is set,
   * commits route through the cascade tracker (Change-Id + x-cascade events).
   * Without it, commits use raw git (legacy / null-workspace path).
   */
  workspaceManager?: WorkspaceManager;
  /**
   * Optional agent store. When provided, the done() summary is persisted in
   * agent metadata for parentless agents (mail-inbound dispatch workers) so
   * the dispatch reply bridge can forward it as a hub mail turn.
   */
  agentStore?: AgentStore;
}

// =============================================================================
// Tracked Commit Helper
// =============================================================================

/**
 * Build a TrackedCommitHandle when the agent has a streamId + workspaceManager.
 * Returns undefined if either is missing — caller falls back to raw git.
 */
function buildTrackedHandle(
  context: LifecycleContext,
  deps: HandlerDepsV2
): TrackedCommitHandle | undefined {
  if (!context.streamId || !deps.workspaceManager) return undefined;
  const ws = deps.workspaceManager;
  // Build metadata with task_ref if known. Empty object is fine — the hub
  // ignores unknown fields, and back-fill kicks in if task_ref appears later.
  const metadata: Record<string, unknown> = {};
  if (context.taskRef) {
    metadata.task_ref = context.taskRef;
  }
  return {
    streamId: context.streamId,
    agentId: context.agentId,
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    commitChanges: (opts) => ws.commitChanges(opts),
  };
}

// =============================================================================
// Signal Emission Helper
// =============================================================================

async function emitSignal(
  deps: HandlerDepsV2,
  context: LifecycleContext,
  signal: string,
  opts: {
    summary?: string;
    details?: Record<string, unknown>;
    importance?: "normal" | "high" | "urgent";
  } = {}
): Promise<void> {
  if (!context.parentId) return;

  await deps.inboxAdapter.send(
    context.agentId,
    context.parentId,
    {
      type: "event",
      event: signal,
      data: {
        agentId: context.agentId,
        taskId: context.taskId,
        role: context.role,
        ...opts.details,
      },
    },
    {
      importance: opts.importance ?? "normal",
      threadTag: `lifecycle:${context.agentId}`,
      subject: opts.summary,
    }
  );
}

// =============================================================================
// Worker Handler V2
// =============================================================================

/**
 * Handle done() for worker agents.
 *
 * Simplified from V1:
 * - No branch reading or merge request construction
 * - No integration strategy dispatch
 * - AgentManagerV2.terminate() handles merge submission
 * - Just commits changes, emits signals, and returns shouldTerminate
 */
async function handleWorkerDone(
  context: LifecycleContext,
  args: DoneArgs,
  cleanupStatus: CleanupStatus,
  deps: HandlerDepsV2
): Promise<DoneHandlerResult> {
  const signalsEmitted: string[] = [];
  const cleanupActions: string[] = [];
  const warnings: string[] = [];

  // Step 1: Auto-commit uncommitted changes
  if (context.workspacePath && !cleanupStatus.ready) {
    const uncommittedCount = cleanupStatus.uncommittedFiles?.length ?? 0;
    if (uncommittedCount > 0) {
      const commitMessage = args.summary
        ? `WIP: ${args.summary}`
        : `WIP: Auto-commit from done() with ${uncommittedCount} uncommitted file(s)`;

      const tracked = buildTrackedHandle(context, deps);
      const commitHash = commitChanges(context.workspacePath, commitMessage, tracked);
      if (commitHash) {
        const via = tracked ? "tracker" : "raw-git";
        cleanupActions.push(
          `Committed ${uncommittedCount} file(s) via ${via}: ${commitHash.slice(0, 8)}`
        );
      } else {
        warnings.push("Failed to auto-commit uncommitted changes");
      }
    }
  }

  // Step 2: Handle blocked/deferred — don't terminate
  if (args.status === "blocked") {
    try {
      await emitSignal(deps, context, "HELP_NEEDED", {
        summary: args.summary ?? "Worker blocked - needs help",
        details: { status: args.status, ...args.details },
        importance: "high",
      });
      signalsEmitted.push("HELP_NEEDED");
    } catch {
      warnings.push("Failed to emit HELP_NEEDED");
    }

    return {
      shouldTerminate: false,
      signalsEmitted,
      cleanupActions,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }

  if (args.status === "deferred") {
    try {
      await emitSignal(deps, context, "WORKER_DEFERRED", {
        summary: args.summary ?? "Worker deferred work",
        details: { status: args.status, ...args.details },
      });
      signalsEmitted.push("WORKER_DEFERRED");
    } catch {
      warnings.push("Failed to emit WORKER_DEFERRED");
    }

    return {
      shouldTerminate: false,
      signalsEmitted,
      cleanupActions,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }

  // Step 3: Emit WORKER_DONE signal
  try {
    await emitSignal(deps, context, "WORKER_DONE", {
      summary: args.summary ?? `Worker done with status: ${args.status}`,
      details: { status: args.status, ...args.details },
      importance: "high",
    });
    signalsEmitted.push("WORKER_DONE");
  } catch {
    warnings.push("Failed to emit WORKER_DONE");
  }

  // Step 3b: Persist `_lastSummary` to agent metadata when:
  //   - Agent is parentless (mail-inbound fresh-spawn dispatch workers —
  //     emitSignal is a no-op for parentless, so metadata is the only
  //     reply-path channel), OR
  //   - Agent is processing a dispatch (Phase 1 permission overlay set
  //     for this agent → in-flight). Gives the mail-inbound-reuse-consumer
  //     a metadata-side fallback for the reply summary that's
  //     independent of whether the prompt iterator's update stream
  //     races with ACP connection close. Applies to both parentless
  //     AND parented in-flight agents (parented dispatch targets are
  //     the typical mail+reuse setup).
  const inDispatch = !!getPermissionOverlay(context.agentId);
  if ((inDispatch || !context.parentId) && args.summary && deps.agentStore) {
    try {
      const existing = deps.agentStore.getAgent(context.agentId);
      deps.agentStore.updateAgent(context.agentId, {
        metadata: {
          ...(existing?.metadata ?? {}),
          _lastSummary: args.summary,
        },
      });
    } catch {
      // best effort — don't block termination
    }
  }

  // NOTE: Task transition is NOT done here — AgentManagerV2.terminate() handles
  // it to avoid double-transitioning.

  // Step 4: Signal descendants (notification only — actual cascade via AgentManager)
  try {
    const cascadeAdapter: CascadeAgentManager = {
      getChildren: (agentId) => {
        const children = deps.agentManager.getChildren(agentId);
        return children.map((c) => ({ id: c.id, state: c.state, parent: c.parent }));
      },
      terminate: async () => {
        // No-op: actual termination via AgentManager after done() returns
      },
    };

    if (needsCascadeTermination(context.agentId, cascadeAdapter)) {
      const descendants = getAllDescendants(context.agentId, cascadeAdapter);
      const active = descendants.filter(
        (d) => d.state === "running" || d.state === "spawning"
      );
      if (active.length > 0) {
        cleanupActions.push(
          `${active.length} descendant(s) will be cascade-terminated`
        );
      }
    }
  } catch {
    warnings.push("Failed to check descendants for cascade");
  }

  // NOTE: Merge request submission is NOT done here.
  // AgentManagerV2.terminate() handles it when the worker's workspace
  // has completed work — keeping merge logistics system-level.

  // In pull mode, completed workers stay alive to claim more tasks
  const shouldTerminate =
    deps.taskMode === "pull" && args.status === "completed" ? false : true;

  return {
    shouldTerminate,
    signalsEmitted,
    cleanupActions,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

// =============================================================================
// Integrator Handler V2
// =============================================================================

async function handleIntegratorDone(
  context: LifecycleContext,
  args: DoneArgs,
  _cleanupStatus: CleanupStatus,
  deps: HandlerDepsV2
): Promise<DoneHandlerResult> {
  const signalsEmitted: string[] = [];
  const cleanupActions: string[] = [];
  const warnings: string[] = [];
  const pendingResolvers: string[] = [];

  // Only process queue on "completed" status (not failed/blocked)
  if (args.status === "completed" && context.workspacePath && context.streamId) {
    const mergeQueue = deps.mergeQueue;

    if (mergeQueue) {
      let mr = mergeQueue.getNext(context.streamId);
      while (mr) {
        mergeQueue.markProcessing(mr.id);

        const mergeResult = attemptMerge(
          mr.workerBranch,
          context.workspacePath,
          `Merge worker branch '${mr.workerBranch}'`
        );

        if (mergeResult.success) {
          mergeQueue.markMerged(mr.id, mergeResult.mergeCommit ?? "");
          cleanupActions.push(
            `Merged ${mr.workerBranch} (${mergeResult.mergeCommit?.slice(0, 8) ?? "already-merged"})`
          );

          // Notify via inbox
          await emitSignal(deps, context, "MERGE_COMPLETE", {
            summary: `Merged ${mr.workerBranch}`,
            details: {
              mrId: mr.id,
              branch: mr.workerBranch,
              commit: mergeResult.mergeCommit,
            },
          });
          signalsEmitted.push("MERGE_COMPLETE");
        } else if (mergeResult.conflicts && mergeResult.conflicts.length > 0) {
          // Conflict detected — abort and spawn resolver
          abortMerge(context.workspacePath);

          const conflictFiles = mergeResult.conflicts;
          const taskDesc = [
            `Resolve merge conflicts for branch '${mr.workerBranch}'.`,
            `Conflicting files: ${conflictFiles.join(", ")}`,
            `Work in your worktree to fix the conflicts, then call done(status="completed").`,
            `Do NOT submit to the merge queue — the integrator will handle that.`,
          ].join("\n");

          try {
            const spawned = await deps.agentManager.spawn({
              task: taskDesc,
              parent: context.agentId,
              role: "worker.resolver",
            });

            mergeQueue.markConflict(mr.id, conflictFiles, spawned.id);
            pendingResolvers.push(spawned.id);
            cleanupActions.push(
              `Spawned resolver ${spawned.id} for ${mr.workerBranch} (${conflictFiles.length} conflicts)`
            );
          } catch (err) {
            warnings.push(
              `Failed to spawn resolver for ${mr.workerBranch}: ${err}`
            );
          }
        } else {
          // Non-conflict failure
          warnings.push(
            `Merge failed for ${mr.workerBranch}: ${mergeResult.error}`
          );
        }

        mr = mergeQueue.getNext(context.streamId);
      }
    }
  }

  // Emit INTEGRATOR_DONE signal
  try {
    await emitSignal(deps, context, "INTEGRATOR_DONE", {
      summary: args.summary ?? `Integrator done: ${args.status}`,
      details: {
        status: args.status,
        resolversSpawned: pendingResolvers.length,
        ...args.details,
      },
    });
    signalsEmitted.push("INTEGRATOR_DONE");
  } catch {
    warnings.push("Failed to emit INTEGRATOR_DONE");
  }

  // Stay alive if resolvers are pending
  const shouldTerminate = pendingResolvers.length === 0;

  return {
    shouldTerminate,
    signalsEmitted,
    cleanupActions: cleanupActions.length > 0 ? cleanupActions : undefined,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

// =============================================================================
// Monitor Handler V2
// =============================================================================

async function handleMonitorDone(
  context: LifecycleContext,
  args: DoneArgs,
  _cleanupStatus: CleanupStatus,
  deps: HandlerDepsV2
): Promise<DoneHandlerResult> {
  const signalsEmitted: string[] = [];
  const warnings: string[] = [];

  try {
    await emitSignal(deps, context, "MONITOR_DONE", {
      summary: args.summary ?? `Monitor done: ${args.status}`,
      details: { status: args.status, ...args.details },
    });
    signalsEmitted.push("MONITOR_DONE");
  } catch {
    warnings.push("Failed to emit MONITOR_DONE");
  }

  return {
    shouldTerminate: true,
    signalsEmitted,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

// =============================================================================
// Generic Handler V2
// =============================================================================

async function handleGenericDone(
  context: LifecycleContext,
  args: DoneArgs,
  _cleanupStatus: CleanupStatus,
  deps: HandlerDepsV2
): Promise<DoneHandlerResult> {
  const signalsEmitted: string[] = [];
  const warnings: string[] = [];

  const signal = args.status === "completed" ? "AGENT_COMPLETED" : "AGENT_FAILED";

  try {
    await emitSignal(deps, context, signal, {
      summary: args.summary ?? `Agent done: ${args.status}`,
      details: { status: args.status, ...args.details },
    });
    signalsEmitted.push(signal);
  } catch {
    warnings.push(`Failed to emit ${signal}`);
  }

  return {
    shouldTerminate: true,
    signalsEmitted,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

// =============================================================================
// Dispatch
// =============================================================================

/**
 * Dispatch done() to the appropriate handler based on role.
 *
 * Resolution: exact match → dot-prefix → capability-based → generic fallback.
 */
export async function dispatchDoneV2(
  context: LifecycleContext,
  args: DoneArgs,
  cleanupStatus: CleanupStatus,
  deps: HandlerDepsV2
): Promise<DoneHandlerResult> {
  const role = context.role;
  const capabilities = context.capabilities ?? [];

  // Exact or prefix match
  const baseRole = role.split(".")[0];
  if (role === "worker" || baseRole === "worker") {
    return handleWorkerDone(context, args, cleanupStatus, deps);
  }
  if (role === "integrator" || baseRole === "integrator") {
    return handleIntegratorDone(context, args, cleanupStatus, deps);
  }
  if (role === "monitor" || baseRole === "monitor") {
    return handleMonitorDone(context, args, cleanupStatus, deps);
  }

  // Capability-based dispatch (team-defined roles)
  if (capabilities.includes("workspace.worktree")) {
    return handleWorkerDone(context, args, cleanupStatus, deps);
  }
  if (capabilities.includes("workspace.integrate")) {
    return handleIntegratorDone(context, args, cleanupStatus, deps);
  }

  // Generic fallback
  return handleGenericDone(context, args, cleanupStatus, deps);
}
