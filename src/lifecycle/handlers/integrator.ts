/**
 * Integrator Done Handler
 *
 * Handles done() for integrator agents:
 * - Checks merge queue status for the stream
 * - Processes any pending merge requests before termination
 * - Emits INTEGRATOR_DONE signal to coordinator
 *
 * @module lifecycle/handlers/integrator
 * @see s-32xs Self-Cleaning Workers spec
 * @see s-bcqm Change Management spec
 */

import { execSync } from "child_process";
import type { MessageRouter } from "../../router/message-router.js";
import type { MergeQueueInterface, MergeRequest } from "../../workspace/merge-queue/types.js";
import type { AgentManager } from "../../agent/agent-manager.js";
import type {
  LifecycleContext,
  DoneArgs,
  CleanupStatus,
  DoneHandlerResult,
} from "../types.js";
import { attemptMerge, abortMerge, getCurrentBranch } from "../cleanup.js";

// =============================================================================
// Handler Dependencies
// =============================================================================

/**
 * Dependencies for the integrator handler
 */
export interface IntegratorHandlerDeps {
  /** Message router for emitting signals */
  messageRouter: MessageRouter;

  /** Merge queue for processing worker merges (optional - if not provided, queue checks return empty) */
  mergeQueue?: MergeQueueInterface;

  /** Workspace path for the integrator (needed for merge operations) */
  workspacePath?: string;

  /** Agent manager for spawning resolver workers (optional) */
  agentManager?: AgentManager;
}

// =============================================================================
// Resolver Types
// =============================================================================

/**
 * Information about a spawned resolver worker
 */
export interface PendingResolver {
  /** Merge request ID being resolved */
  mrId: string;
  /** Agent ID of the resolver worker */
  resolverId: string;
  /** Branch the resolver is working on */
  resolverBranch: string;
  /** Files with conflicts */
  conflictFiles: string[];
  /** Timestamp when resolver was spawned */
  spawnedAt: number;
}

// =============================================================================
// Merge Queue Helpers
// =============================================================================

/**
 * Check if merge queue is empty for a stream
 */
function isMergeQueueEmpty(
  streamId: string | undefined,
  mergeQueue: MergeQueueInterface | undefined
): boolean {
  if (!mergeQueue || !streamId) {
    // No queue or no stream - treat as empty
    return true;
  }
  return mergeQueue.getQueueDepth(streamId) === 0;
}

/**
 * Get the number of pending merge requests for a stream
 */
function getPendingCount(
  streamId: string | undefined,
  mergeQueue: MergeQueueInterface | undefined
): number {
  if (!mergeQueue || !streamId) {
    return 0;
  }
  return mergeQueue.getQueueDepth(streamId);
}

// =============================================================================
// Queue Processing
// =============================================================================

/**
 * Result of processing a single merge request
 */
interface ProcessMergeResult {
  mrId: string;
  success: boolean;
  mergeCommit?: string;
  /** True if the branch was already merged (no new commit created) */
  alreadyMerged?: boolean;
  conflicts?: string[];
  error?: string;
  /** True if a resolver worker was spawned for this conflict */
  resolverSpawned?: boolean;
  /** Resolver info if spawned */
  resolver?: PendingResolver;
}

/**
 * Spawn a resolver worker to handle merge conflicts.
 *
 * @param mr - The merge request with conflicts
 * @param conflictFiles - List of files with conflicts
 * @param context - Lifecycle context
 * @param deps - Handler dependencies
 * @returns PendingResolver info or null if spawn failed
 */
async function spawnResolverWorker(
  mr: MergeRequest,
  conflictFiles: string[],
  context: LifecycleContext,
  deps: IntegratorHandlerDeps
): Promise<PendingResolver | null> {
  if (!deps.agentManager) {
    console.warn("[Integrator] Cannot spawn resolver: no agentManager available");
    return null;
  }

  const timestamp = Date.now();
  const resolverBranch = `resolver/${mr.id}@${timestamp}`;

  // Build task description with conflict context
  const taskDescription = `
Resolve merge conflict for MR ${mr.id}.

**Original worker branch**: ${mr.workerBranch}
**Worker agent**: ${mr.workerAgentId}
**Task ID**: ${mr.taskId}

**Conflicting files**:
${conflictFiles.map((f) => `- ${f}`).join("\n")}

**Your task**:
1. The baseline has been updated since the original work was done
2. Apply the changes from the original work to the updated baseline
3. Resolve any conflicts that arise in the listed files
4. Ensure tests pass after resolution
5. Call done() when complete - do NOT submit to merge queue

**Important**: You are a resolver worker. When you call done(), a RESOLVER_DONE signal
will be emitted instead of MERGE_REQUEST, and your changes will be merged inline by
the integrator.
`.trim();

  try {
    const spawned = await deps.agentManager.spawn({
      task: taskDescription,
      parent: context.agentId,
      role: "worker.resolver",
      streamId: context.streamId,
      // Store mrId in agent config for the resolver to access
      config: {
        env: {
          MACRO_RESOLVER_MR_ID: mr.id,
        },
      },
    });

    return {
      mrId: mr.id,
      resolverId: spawned.id,
      resolverBranch,
      conflictFiles,
      spawnedAt: timestamp,
    };
  } catch (error) {
    console.error(
      `[Integrator] Failed to spawn resolver for MR ${mr.id}: ${error instanceof Error ? error.message : error}`
    );
    return null;
  }
}

/**
 * Process a single merge request from the queue
 */
async function processSingleMerge(
  mergeQueue: MergeQueueInterface,
  mr: MergeRequest,
  workspacePath: string,
  context: LifecycleContext,
  deps: IntegratorHandlerDeps,
  expectedBranch?: string
): Promise<ProcessMergeResult> {
  const { id: mrId, workerBranch } = mr;

  // Verify workspace is on expected branch before merge
  if (expectedBranch) {
    const currentBranch = getCurrentBranch(workspacePath);
    if (currentBranch !== expectedBranch) {
      // Don't mark as processing if branch is wrong - this is a system error
      return {
        mrId,
        success: false,
        error: `Workspace is on branch '${currentBranch}', expected '${expectedBranch}'`,
      };
    }
  }

  // Mark as processing
  mergeQueue.markProcessing(mrId);

  // Attempt the merge
  const mergeResult = attemptMerge(workerBranch, workspacePath);

  if (mergeResult.success) {
    if (mergeResult.alreadyMerged) {
      // Branch was already merged - mark as merged with current HEAD
      // This is a no-op merge but we track it for completeness
      const currentHead = execSync("git rev-parse HEAD", {
        cwd: workspacePath,
        encoding: "utf-8",
      }).trim();
      mergeQueue.markMerged(mrId, currentHead);
      return {
        mrId,
        success: true,
        alreadyMerged: true,
      };
    }

    if (mergeResult.mergeCommit) {
      mergeQueue.markMerged(mrId, mergeResult.mergeCommit);
      return {
        mrId,
        success: true,
        mergeCommit: mergeResult.mergeCommit,
      };
    }
  }

  // Merge failed - check for conflicts
  if (mergeResult.conflicts && mergeResult.conflicts.length > 0) {
    // Abort the merge
    abortMerge(workspacePath);

    // Attempt to spawn a resolver worker
    const resolver = await spawnResolverWorker(mr, mergeResult.conflicts, context, deps);

    if (resolver) {
      // Resolver spawned - mark conflict with resolver task ID
      mergeQueue.markConflict(mrId, mergeResult.conflicts, resolver.resolverId);

      // Emit CONFLICT_DETECTED signal for notification
      deps.messageRouter.emitStatus({
        from: { agent_id: context.agentId },
        status_type: "checkpoint",
        summary: `Merge conflict detected for MR ${mrId} - resolver spawned`,
        details: {
          signal: "CONFLICT_DETECTED",
          mrId,
          conflictFiles: mergeResult.conflicts,
          resolverSpawned: true,
          resolverId: resolver.resolverId,
          resolverBranch: resolver.resolverBranch,
        },
      });

      return {
        mrId,
        success: false,
        conflicts: mergeResult.conflicts,
        resolverSpawned: true,
        resolver,
      };
    } else {
      // Couldn't spawn resolver - mark conflict without resolver
      mergeQueue.markConflict(mrId, mergeResult.conflicts);

      // Emit CONFLICT_DETECTED signal without resolver
      deps.messageRouter.emitStatus({
        from: { agent_id: context.agentId },
        status_type: "checkpoint",
        summary: `Merge conflict detected for MR ${mrId} - manual resolution required`,
        details: {
          signal: "CONFLICT_DETECTED",
          mrId,
          conflictFiles: mergeResult.conflicts,
          resolverSpawned: false,
        },
      });

      return {
        mrId,
        success: false,
        conflicts: mergeResult.conflicts,
      };
    }
  }

  // Non-conflict error - abort and mark as conflict with error
  abortMerge(workspacePath);
  mergeQueue.markConflict(mrId, [], undefined);
  return {
    mrId,
    success: false,
    error: mergeResult.error ?? "Unknown merge error",
  };
}

/**
 * Result of processing all pending merge requests
 */
interface ProcessAllMergesResult {
  processed: number;
  merged: number;
  conflicts: number;
  branchErrors: number;
  /** Resolvers that were spawned for conflicts */
  pendingResolvers: PendingResolver[];
}

/**
 * Process all pending merge requests for a stream
 */
async function processAllPendingMerges(
  streamId: string,
  mergeQueue: MergeQueueInterface,
  workspacePath: string,
  context: LifecycleContext,
  deps: IntegratorHandlerDeps,
  expectedBranch?: string
): Promise<ProcessAllMergesResult> {
  let processed = 0;
  let merged = 0;
  let conflicts = 0;
  let branchErrors = 0;
  const pendingResolvers: PendingResolver[] = [];

  // Process queue until empty
  while (true) {
    const next = mergeQueue.getNext(streamId);
    if (!next) break;

    const result = await processSingleMerge(
      mergeQueue,
      next,
      workspacePath,
      context,
      deps,
      expectedBranch
    );

    // Check for branch verification error - if we're on the wrong branch,
    // no merges will succeed, so break out of the loop to avoid infinite loop
    // (the MR was never marked as processing, so it would be returned again)
    if (!result.success && result.error?.includes("expected")) {
      branchErrors++;
      break;
    }

    processed++;
    if (result.success) {
      merged++;
    } else {
      conflicts++;
      // Track spawned resolver
      if (result.resolverSpawned && result.resolver) {
        pendingResolvers.push(result.resolver);
      }
    }
  }

  return { processed, merged, conflicts, branchErrors, pendingResolvers };
}

// =============================================================================
// Integrator Handler
// =============================================================================

/**
 * Handle done() for integrator agents
 *
 * Processing steps:
 * 1. Process any pending merge requests in the queue
 * 2. Check final queue status
 * 3. Emit INTEGRATOR_DONE signal to coordinator
 * 4. Return shouldTerminate based on queue status
 */
export async function handleIntegratorDone(
  context: LifecycleContext,
  args: DoneArgs,
  _cleanupStatus: CleanupStatus,
  deps: IntegratorHandlerDeps
): Promise<DoneHandlerResult> {
  const signalsEmitted: string[] = [];
  const cleanupActions: string[] = [];
  const warnings: string[] = [];

  const streamId = context.streamId;
  const mergeQueue = deps.mergeQueue;
  const workspacePath = deps.workspacePath ?? context.workspacePath;

  // ─────────────────────────────────────────────────────────────────────────────
  // Step 1: Process any pending merge requests before termination
  // ─────────────────────────────────────────────────────────────────────────────

  // Track pending resolvers for the termination decision
  let activePendingResolvers: PendingResolver[] = [];

  if (mergeQueue && streamId && workspacePath) {
    const pendingBefore = getPendingCount(streamId, mergeQueue);

    if (pendingBefore > 0) {
      cleanupActions.push(`Found ${pendingBefore} pending merge request(s) - processing before termination`);

      try {
        // Pass the expected integration branch for verification
        const expectedBranch = context.branch ?? "integration";
        const result = await processAllPendingMerges(
          streamId,
          mergeQueue,
          workspacePath,
          context,
          deps,
          expectedBranch
        );
        cleanupActions.push(
          `Processed ${result.processed} merge request(s): ${result.merged} merged, ${result.conflicts} conflicts`
        );

        if (result.conflicts > 0) {
          if (result.pendingResolvers.length > 0) {
            cleanupActions.push(
              `Spawned ${result.pendingResolvers.length} resolver(s) for conflicts`
            );
            activePendingResolvers = result.pendingResolvers;
          } else {
            warnings.push(
              `${result.conflicts} merge request(s) had conflicts - manual resolution required`
            );
          }
        }

        if (result.branchErrors > 0) {
          warnings.push(
            `${result.branchErrors} merge request(s) skipped due to workspace not being on expected branch '${expectedBranch}'`
          );
        }
      } catch (error) {
        warnings.push(
          `Error processing merge queue: ${error instanceof Error ? error.message : "unknown"}`
        );
      }
    }
  } else if (!mergeQueue) {
    cleanupActions.push("Merge queue not configured - skipping queue processing");
  } else if (!streamId) {
    cleanupActions.push("No stream ID in context - skipping queue processing");
  } else if (!workspacePath) {
    cleanupActions.push("No workspace path available - skipping queue processing");
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Step 2: Check final merge queue status
  // ─────────────────────────────────────────────────────────────────────────────

  const queueEmpty = isMergeQueueEmpty(streamId, mergeQueue);
  const finalPending = getPendingCount(streamId, mergeQueue);

  if (!queueEmpty) {
    warnings.push(`Merge queue still has ${finalPending} pending request(s) - termination may be premature`);
  }
  cleanupActions.push(`Merge queue final status: ${queueEmpty ? "empty" : `${finalPending} pending`}`);

  // ─────────────────────────────────────────────────────────────────────────────
  // Step 3: Emit INTEGRATOR_DONE signal
  // ─────────────────────────────────────────────────────────────────────────────

  try {
    deps.messageRouter.emitStatus({
      from: { agent_id: context.agentId },
      status_type: args.status === "completed" ? "completed" : "failed",
      summary: args.summary ?? `Integrator done with status: ${args.status}`,
      details: {
        signal: "INTEGRATOR_DONE",
        integratorId: context.agentId,
        streamId,
        status: args.status,
        baseBranch: context.branch ?? "integration",
        queueEmpty,
        pendingCount: finalPending,
        ...args.details,
      },
    });
    signalsEmitted.push("INTEGRATOR_DONE");
  } catch (error) {
    warnings.push(
      `Failed to emit INTEGRATOR_DONE: ${error instanceof Error ? error.message : "unknown"}`
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Return result - shouldTerminate depends on pending resolvers
  // ─────────────────────────────────────────────────────────────────────────────

  // If resolvers are active, integrator should stay alive to handle their completion
  const hasActiveResolvers = activePendingResolvers.length > 0;

  if (hasActiveResolvers) {
    cleanupActions.push(
      `Staying alive to await ${activePendingResolvers.length} pending resolver(s)`
    );

    // Include resolver info in the result for the agent to track
    return {
      shouldTerminate: false,
      signalsEmitted,
      cleanupActions,
      warnings: warnings.length > 0 ? warnings : undefined,
      // Include pending resolver info for the agent to handle RESOLVER_DONE
      pendingResolvers: activePendingResolvers,
    } as DoneHandlerResult & { pendingResolvers: PendingResolver[] };
  }

  return {
    shouldTerminate: true,
    signalsEmitted,
    cleanupActions,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

// =============================================================================
// Resolver Completion Handler
// =============================================================================

/**
 * Result of handling a resolver completion
 */
export interface HandleResolverDoneResult {
  success: boolean;
  mergeCommit?: string;
  /** True if the resolver's merge also conflicted (nested conflict) */
  nestedConflict?: boolean;
  conflictFiles?: string[];
  error?: string;
}

/**
 * Handle RESOLVER_DONE signal by performing inline merge of resolver branch.
 *
 * This is called when a resolver worker completes. The integrator should:
 * 1. Merge the resolver branch into the integration branch
 * 2. Mark the original MR as resolved via markResolverComplete()
 * 3. If the merge also conflicts (nested conflict), escalate to coordinator
 *
 * @param mrId - The original merge request ID
 * @param resolverBranch - Branch the resolver worked on
 * @param context - Lifecycle context
 * @param deps - Handler dependencies
 * @returns Result of the inline merge
 */
export async function handleResolverDone(
  mrId: string,
  resolverBranch: string,
  context: LifecycleContext,
  deps: IntegratorHandlerDeps
): Promise<HandleResolverDoneResult> {
  const { mergeQueue, workspacePath, messageRouter } = deps;

  if (!mergeQueue || !workspacePath) {
    return {
      success: false,
      error: "Missing mergeQueue or workspacePath",
    };
  }

  // Verify the MR exists and is in conflict state
  const mr = mergeQueue.get(mrId);
  if (!mr) {
    return {
      success: false,
      error: `MR ${mrId} not found`,
    };
  }

  if (mr.status !== "conflict") {
    return {
      success: false,
      error: `MR ${mrId} is not in conflict state (status: ${mr.status})`,
    };
  }

  // Attempt inline merge of resolver branch
  const mergeResult = attemptMerge(
    resolverBranch,
    workspacePath,
    `Merge resolved changes for MR ${mrId}`
  );

  if (mergeResult.success && mergeResult.mergeCommit) {
    // Success! Mark the original MR as resolved
    mergeQueue.markResolverComplete(mrId, mergeResult.mergeCommit, resolverBranch);

    // Emit MERGE_COMPLETE signal
    messageRouter.emitStatus({
      from: { agent_id: context.agentId },
      status_type: "completed",
      summary: `MR ${mrId} resolved and merged`,
      details: {
        signal: "MERGE_COMPLETE",
        mrId,
        mergeCommit: mergeResult.mergeCommit,
        resolvedVia: "resolver",
        resolverBranch,
      },
    });

    return {
      success: true,
      mergeCommit: mergeResult.mergeCommit,
    };
  }

  // Resolver's merge also conflicted - this is a nested conflict!
  if (mergeResult.conflicts && mergeResult.conflicts.length > 0) {
    // Abort the failed merge
    abortMerge(workspacePath);

    // Emit CONFLICT_UNRESOLVED signal for escalation to coordinator
    messageRouter.emitStatus({
      from: { agent_id: context.agentId },
      status_type: "failed",
      summary: `Nested conflict: resolver for MR ${mrId} also conflicted - escalating`,
      details: {
        signal: "CONFLICT_UNRESOLVED",
        mrId,
        resolverBranch,
        conflictFiles: mergeResult.conflicts,
        reason: "resolver_conflict",
      },
    });

    console.warn(
      `[Integrator] Nested conflict on MR ${mrId}: resolver branch ${resolverBranch} also conflicts`
    );

    return {
      success: false,
      nestedConflict: true,
      conflictFiles: mergeResult.conflicts,
    };
  }

  // Other error
  abortMerge(workspacePath);
  return {
    success: false,
    error: mergeResult.error ?? "Unknown merge error",
  };
}
