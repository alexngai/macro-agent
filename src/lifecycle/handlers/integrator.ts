/**
 * Integrator Done Handler
 *
 * Handles done() for integrator agents:
 * - Checks merge queue is empty (stub check for Phase 6)
 * - Emits INTEGRATOR_DONE signal to coordinator
 *
 * @module lifecycle/handlers/integrator
 * @see s-32xs Self-Cleaning Workers spec
 */

import type { MessageRouter } from "../../router/message-router.js";
import type {
  LifecycleContext,
  DoneArgs,
  CleanupStatus,
  DoneHandlerResult,
} from "../types.js";

// =============================================================================
// Handler Dependencies
// =============================================================================

/**
 * Dependencies for the integrator handler
 */
export interface IntegratorHandlerDeps {
  /** Message router for emitting signals */
  messageRouter: MessageRouter;
}

// =============================================================================
// Merge Queue Check (Stub)
// =============================================================================

/**
 * Check if merge queue is empty (stub for Phase 6)
 *
 * TODO Phase 6: Wire to actual merge queue
 */
function isMergeQueueEmpty(_integratorId: string): boolean {
  // Stub: Always return true for now
  // Phase 6 will implement actual queue check
  return true;
}

// =============================================================================
// Integrator Handler
// =============================================================================

/**
 * Handle done() for integrator agents
 *
 * Processing steps:
 * 1. Check if merge queue is empty (stub)
 * 2. Emit INTEGRATOR_DONE signal to coordinator
 * 3. Return shouldTerminate based on queue status
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

  // ─────────────────────────────────────────────────────────────────────────────
  // Step 1: Check merge queue status (stubbed for Phase 6)
  // ─────────────────────────────────────────────────────────────────────────────

  const queueEmpty = isMergeQueueEmpty(context.agentId);
  if (!queueEmpty) {
    warnings.push("Merge queue not empty - termination may be premature");
  }
  cleanupActions.push(`Merge queue check: ${queueEmpty ? "empty" : "not empty"} (stub for Phase 6)`);

  // ─────────────────────────────────────────────────────────────────────────────
  // Step 2: Emit INTEGRATOR_DONE signal
  // ─────────────────────────────────────────────────────────────────────────────

  try {
    deps.messageRouter.emitStatus({
      from: { agent_id: context.agentId },
      status_type: args.status === "completed" ? "completed" : "failed",
      summary: args.summary ?? `Integrator done with status: ${args.status}`,
      details: {
        signal: "INTEGRATOR_DONE",
        integratorId: context.agentId,
        status: args.status,
        baseBranch: context.branch ?? "integration",
        queueEmpty,
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
