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
import type {
  LifecycleContext,
  DoneArgs,
  CleanupStatus,
  DoneHandlerResult,
} from "./types.js";
import { commitChanges } from "./cleanup.js";
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

      const commitHash = commitChanges(context.workspacePath, commitMessage);
      if (commitHash) {
        cleanupActions.push(
          `Committed ${uncommittedCount} file(s): ${commitHash.slice(0, 8)}`
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
  const warnings: string[] = [];

  try {
    await emitSignal(deps, context, "INTEGRATOR_DONE", {
      summary: args.summary ?? `Integrator done: ${args.status}`,
      details: { status: args.status, ...args.details },
    });
    signalsEmitted.push("INTEGRATOR_DONE");
  } catch {
    warnings.push("Failed to emit INTEGRATOR_DONE");
  }

  return {
    shouldTerminate: true,
    signalsEmitted,
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
