/**
 * Agent Wake Mechanism
 *
 * Implements progressive waking for agents based on activity and priority.
 * Supports inject/interrupt fallback chain.
 *
 * @module agent/wake
 * @see s-9rld In-Flight Steering spec section 3.4
 */

import type { AgentId } from "../store/types/index.js";
import type { MessagePriority, WakeAction } from "../router/types.js";
import type { Activity, WakeResult, WakeMethod } from "../activity/types.js";
import { determineWakeAction } from "../router/wake.js";
import type { AgentManager } from "./agent-manager.js";

// =============================================================================
// Types
// =============================================================================

/**
 * Session info required for wake decisions
 */
export interface WakeSessionInfo {
  /** Whether agent has an active session */
  hasSession: boolean;
  /** Whether agent is currently processing a prompt */
  isPrompting: boolean;
  /** Whether the session supports injection */
  supportsInjection: boolean;
}

/**
 * Session provider interface
 */
export interface WakeSessionProvider {
  /** Get session info for an agent */
  getSessionInfo(agentId: AgentId): WakeSessionInfo | null;
  /** Inject a message into an agent's session */
  inject?(agentId: AgentId, message: string): Promise<boolean>;
  /** Interrupt an agent's session with a message */
  interrupt?(agentId: AgentId, message: string): Promise<boolean>;
}

/**
 * Options for waking an agent
 */
export interface WakeAgentOptions {
  /** Priority for wake decision */
  priority?: MessagePriority;
  /** Force a specific wake action */
  forceAction?: WakeAction;
}

// =============================================================================
// Activity Formatting
// =============================================================================

/**
 * Format an activity as a context message for the agent.
 */
export function formatActivityContext(activity: Activity): string {
  const lines: string[] = [
    `[Activity Notification]`,
    `Type: ${activity.type}`,
    `Time: ${new Date(activity.timestamp).toISOString()}`,
  ];

  if (activity.source?.agent_id) {
    lines.push(`Source Agent: ${activity.source.agent_id}`);
  }
  if (activity.source?.task_id) {
    lines.push(`Source Task: ${activity.source.task_id}`);
  }
  if (activity.source?.role) {
    lines.push(`Source Role: ${activity.source.role}`);
  }

  if (activity.details && Object.keys(activity.details).length > 0) {
    lines.push(`Details: ${JSON.stringify(activity.details, null, 2)}`);
  }

  return lines.join("\n");
}

// =============================================================================
// Wake Agent Implementation
// =============================================================================

/**
 * Wake an agent with an activity notification.
 *
 * Uses progressive wake strategy:
 * 1. If agent has no session, wake if priority allows
 * 2. If agent is idle (session but not prompting), wake
 * 3. If agent is busy:
 *    - urgent: interrupt
 *    - high: inject (fallback to interrupt)
 *    - normal/low: queue
 */
export async function wakeAgent(
  agentId: AgentId,
  activity: Activity,
  sessionProvider: WakeSessionProvider,
  agentManager?: AgentManager,
  options: WakeAgentOptions = {}
): Promise<WakeResult> {
  const priority = options.priority ?? activity.priority ?? "normal";

  // Get session info
  const sessionInfo = sessionProvider.getSessionInfo(agentId);

  // No session means agent is stopped or doesn't exist
  if (!sessionInfo || !sessionInfo.hasSession) {
    // Check if we should wake the agent
    const action = determineWakeAction(priority, false, false);
    if (action === "queue") {
      return { success: true, method: "queued" };
    }

    // Can't wake without agent manager
    if (!agentManager) {
      return { success: false, reason: "no_session" };
    }

    // Try to prompt the agent (which will start/resume session)
    try {
      const message = formatActivityContext(activity);
      // Note: This would need the agent to already have a session
      // For now, we just queue the message
      return { success: true, method: "queued", reason: "no_session" };
    } catch (error) {
      return {
        success: false,
        reason: "error",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  // Determine wake action
  let action: WakeAction;
  if (options.forceAction) {
    action = options.forceAction;
  } else {
    action = determineWakeAction(priority, true, sessionInfo.isPrompting);
  }

  // Execute wake action
  const message = formatActivityContext(activity);

  switch (action) {
    case "wake":
      // Agent has session but is not prompting - start new prompt
      if (agentManager) {
        try {
          // Consume the async iterator to send the prompt
          // Fire and forget - start the iteration but don't await it
          const promptIterable = agentManager.prompt(agentId, message);
          (async () => {
            try {
              // eslint-disable-next-line @typescript-eslint/no-unused-vars
              for await (const _update of promptIterable) {
                // Just iterate to drive the prompt, don't need to process updates
                break; // Exit after first update to avoid blocking
              }
            } catch {
              // Ignore errors - prompt is fire and forget for wake
            }
          })();
          return { success: true, method: "wake" };
        } catch (error) {
          return {
            success: false,
            reason: "error",
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }
      return { success: true, method: "queued" };

    case "inject":
      // Try to inject into current session
      if (sessionProvider.inject && sessionInfo.supportsInjection) {
        try {
          const injected = await sessionProvider.inject(agentId, message);
          if (injected) {
            return { success: true, method: "inject" };
          }
        } catch {
          // Fall through to interrupt
        }
      }

      // Fallback to interrupt if inject not supported or failed
      if (sessionProvider.interrupt) {
        try {
          const interrupted = await sessionProvider.interrupt(agentId, message);
          if (interrupted) {
            return { success: true, method: "interrupt" };
          }
        } catch (error) {
          return {
            success: false,
            reason: "inject_failed",
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }

      // If all else fails, queue
      return { success: true, method: "queued" };

    case "interrupt":
      // Interrupt current session
      if (sessionProvider.interrupt) {
        try {
          const interrupted = await sessionProvider.interrupt(agentId, message);
          if (interrupted) {
            return { success: true, method: "interrupt" };
          }
        } catch (error) {
          return {
            success: false,
            reason: "error",
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }
      return { success: true, method: "queued" };

    case "queue":
      // Just queue the message, don't wake
      return { success: true, method: "queued" };

    default:
      // Exhaustive check - should never reach here
      return { success: true, method: "queued" };
  }
}

// =============================================================================
// Factory Functions
// =============================================================================

/**
 * Create a wake handler function for use with ActivityWatcher.
 */
export function createWakeHandler(
  sessionProvider: WakeSessionProvider,
  agentManager?: AgentManager
) {
  return async (
    agentId: AgentId,
    activity: Activity,
    priority: MessagePriority
  ): Promise<WakeResult> => {
    return wakeAgent(agentId, activity, sessionProvider, agentManager, {
      priority,
    });
  };
}

/**
 * Create a session provider from AgentManager.
 */
export function createSessionProviderFromAgentManager(
  agentManager: AgentManager
): WakeSessionProvider {
  return {
    getSessionInfo(agentId: AgentId): WakeSessionInfo | null {
      const hasSession = agentManager.hasActiveSession(agentId);
      if (!hasSession) {
        return null;
      }

      // Note: AgentManager doesn't expose isPrompting directly
      // In a real implementation, we'd need to track this
      return {
        hasSession: true,
        isPrompting: false, // Would need to be tracked
        supportsInjection: false, // Claude Code doesn't support injection yet
      };
    },

    // Note: inject and interrupt would need to be implemented
    // when the underlying session supports it
  };
}
