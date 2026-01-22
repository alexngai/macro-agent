/**
 * Generic Done Handler
 *
 * Fallback handler for roles without specific done() handling.
 * Provides basic cleanup and termination.
 *
 * @module lifecycle/handlers/generic
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
 * Dependencies for the generic handler
 */
export interface GenericHandlerDeps {
  /** Message router for emitting status */
  messageRouter: MessageRouter;
}

// =============================================================================
// Generic Handler
// =============================================================================

/**
 * Handle done() for any role without a specific handler
 *
 * Processing steps:
 * 1. Emit STATUS signal with done status
 * 2. Return shouldTerminate=true
 */
export async function handleGenericDone(
  context: LifecycleContext,
  args: DoneArgs,
  _cleanupStatus: CleanupStatus,
  deps: GenericHandlerDeps
): Promise<DoneHandlerResult> {
  const signalsEmitted: string[] = [];
  const cleanupActions: string[] = [];
  const warnings: string[] = [];

  // ─────────────────────────────────────────────────────────────────────────────
  // Emit completion status
  // ─────────────────────────────────────────────────────────────────────────────

  try {
    deps.messageRouter.emitStatus({
      from: { agent_id: context.agentId },
      status_type: args.status === "completed" ? "completed" : "failed",
      summary: args.summary ?? `Agent done with status: ${args.status}`,
      details: {
        signal: "STATUS",
        agentId: context.agentId,
        role: context.role,
        status: args.status,
        ...args.details,
      },
    });
    signalsEmitted.push("STATUS");
    cleanupActions.push(`Emitted done status for role: ${context.role}`);
  } catch (error) {
    warnings.push(
      `Failed to emit status: ${error instanceof Error ? error.message : "unknown"}`
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Return result - shouldTerminate=true by default
  // ─────────────────────────────────────────────────────────────────────────────

  return {
    shouldTerminate: true,
    signalsEmitted,
    cleanupActions,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}
