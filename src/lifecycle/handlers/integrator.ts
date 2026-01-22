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

import type { MessageRouter } from "../../router/message-router.js";
import type { MergeQueueInterface } from "../../workspace/merge-queue/types.js";
import type {
  LifecycleContext,
  DoneArgs,
  CleanupStatus,
  DoneHandlerResult,
} from "../types.js";
import { attemptMerge, abortMerge } from "../cleanup.js";

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
  conflicts?: string[];
  error?: string;
}

/**
 * Process a single merge request from the queue
 */
function processSingleMerge(
  mergeQueue: MergeQueueInterface,
  mrId: string,
  workerBranch: string,
  workspacePath: string
): ProcessMergeResult {
  // Mark as processing
  mergeQueue.markProcessing(mrId);

  // Attempt the merge
  const mergeResult = attemptMerge(workerBranch, workspacePath);

  if (mergeResult.success && mergeResult.mergeCommit) {
    mergeQueue.markMerged(mrId, mergeResult.mergeCommit);
    return {
      mrId,
      success: true,
      mergeCommit: mergeResult.mergeCommit,
    };
  }

  // Merge failed
  if (mergeResult.conflicts && mergeResult.conflicts.length > 0) {
    // Abort the merge and mark as conflict
    abortMerge(workspacePath);
    mergeQueue.markConflict(mrId, mergeResult.conflicts);
    return {
      mrId,
      success: false,
      conflicts: mergeResult.conflicts,
    };
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
 * Process all pending merge requests for a stream
 */
function processAllPendingMerges(
  streamId: string,
  mergeQueue: MergeQueueInterface,
  workspacePath: string
): { processed: number; merged: number; conflicts: number } {
  let processed = 0;
  let merged = 0;
  let conflicts = 0;

  // Process queue until empty
  while (true) {
    const next = mergeQueue.getNext(streamId);
    if (!next) break;

    processed++;
    const result = processSingleMerge(
      mergeQueue,
      next.id,
      next.workerBranch,
      workspacePath
    );

    if (result.success) {
      merged++;
    } else {
      conflicts++;
    }
  }

  return { processed, merged, conflicts };
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

  if (mergeQueue && streamId && workspacePath) {
    const pendingBefore = getPendingCount(streamId, mergeQueue);

    if (pendingBefore > 0) {
      cleanupActions.push(`Found ${pendingBefore} pending merge request(s) - processing before termination`);

      try {
        const result = processAllPendingMerges(streamId, mergeQueue, workspacePath);
        cleanupActions.push(
          `Processed ${result.processed} merge request(s): ${result.merged} merged, ${result.conflicts} conflicts`
        );

        if (result.conflicts > 0) {
          warnings.push(
            `${result.conflicts} merge request(s) had conflicts - manual resolution may be required`
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
  // Return result - shouldTerminate=true for integrators
  // ─────────────────────────────────────────────────────────────────────────────

  return {
    shouldTerminate: true,
    signalsEmitted,
    cleanupActions,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}
