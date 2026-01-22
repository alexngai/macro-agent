/**
 * Monitor Done Handler
 *
 * Handles done() for monitor agents:
 * - Unsubscribes from events
 * - Cleans up monitoring state
 *
 * @module lifecycle/handlers/monitor
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
 * Dependencies for the monitor handler
 */
export interface MonitorHandlerDeps {
  /** Message router for managing subscriptions */
  messageRouter: MessageRouter;
}

// =============================================================================
// Monitor Handler
// =============================================================================

/**
 * Handle done() for monitor agents
 *
 * Processing steps:
 * 1. Unsubscribe from all event channels
 * 2. Clean up any monitoring state
 * 3. Return shouldTerminate=true
 */
export async function handleMonitorDone(
  context: LifecycleContext,
  args: DoneArgs,
  _cleanupStatus: CleanupStatus,
  deps: MonitorHandlerDeps
): Promise<DoneHandlerResult> {
  const signalsEmitted: string[] = [];
  const cleanupActions: string[] = [];
  const warnings: string[] = [];

  // ─────────────────────────────────────────────────────────────────────────────
  // Step 1: Unsubscribe from all event channels
  // ─────────────────────────────────────────────────────────────────────────────

  try {
    // Get current subscriptions
    const subscriptions = deps.messageRouter.getSubscriptions(context.agentId);

    // Unsubscribe from each
    for (const sub of subscriptions) {
      try {
        deps.messageRouter.unsubscribe(context.agentId, sub);
        cleanupActions.push(`Unsubscribed from ${sub.type}:${sub.target}`);
      } catch {
        warnings.push(`Failed to unsubscribe from ${sub.type}:${sub.target}`);
      }
    }

    if (subscriptions.length === 0) {
      cleanupActions.push("No subscriptions to clean up");
    }
  } catch (error) {
    warnings.push(
      `Failed to get subscriptions: ${error instanceof Error ? error.message : "unknown"}`
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Step 2: Emit completion status
  // ─────────────────────────────────────────────────────────────────────────────

  try {
    deps.messageRouter.emitStatus({
      from: { agent_id: context.agentId },
      status_type: args.status === "completed" ? "completed" : "failed",
      summary: args.summary ?? `Monitor done with status: ${args.status}`,
      details: {
        signal: "STATUS",
        monitorId: context.agentId,
        status: args.status,
        ...args.details,
      },
    });
    signalsEmitted.push("STATUS");
  } catch (error) {
    warnings.push(
      `Failed to emit status: ${error instanceof Error ? error.message : "unknown"}`
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Return result - shouldTerminate=true for monitors
  // ─────────────────────────────────────────────────────────────────────────────

  return {
    shouldTerminate: true,
    signalsEmitted,
    cleanupActions,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}
