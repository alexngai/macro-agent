/**
 * Priority-Based Wake Decisions
 *
 * Determines how to deliver messages based on priority and agent state.
 *
 * Wake action semantics:
 * - 'wake': Start the agent if idle (begin new prompt/turn)
 * - 'inject': Inject message into current session (if supported)
 * - 'interrupt': Pause current work, inject message, resume
 * - 'queue': Just add to message queue, agent will see it on next check
 *
 * Priority mappings:
 * - 'urgent': Always interrupt if busy, wake if idle
 * - 'high': Inject if busy, wake if idle
 * - 'normal': Queue if busy, wake if idle
 * - 'low': Always queue, never wake
 *
 * @module router/wake
 * @see s-9rld In-Flight Steering spec section 3.2
 */

import type { AgentId } from "../store/types/index.js";
import type { MessagePriority, WakeAction } from "./types.js";

// =============================================================================
// Types
// =============================================================================

/**
 * Session checker interface
 */
export interface SessionChecker {
  /** Check if agent has an active session */
  hasActiveSession(agentId: AgentId): boolean;
  /** Check if agent is currently processing a prompt (busy) */
  isPrompting?(agentId: AgentId): boolean;
  /** Check if agent's session supports injection */
  supportsInjection?(agentId: AgentId): boolean;
}

/**
 * Wake decision result
 */
export interface WakeDecision {
  /** The action to take */
  action: WakeAction;
  /** Whether to wake the agent (start session if not active) */
  shouldWake: boolean;
  /** Whether to interrupt current work */
  shouldInterrupt: boolean;
  /** Whether injection is available */
  canInject: boolean;
}

// =============================================================================
// Wake Decision Logic
// =============================================================================

/**
 * Determine the wake action for a message based on priority and agent state.
 *
 * Priority semantics:
 * - 'urgent' → Always wake (interrupt if busy)
 * - 'high' → Wake if idle, inject if busy
 * - 'normal' → Wake if idle, queue if busy
 * - 'low' → Never wake, just queue
 */
export function determineWakeAction(
  priority: MessagePriority,
  hasActiveSession: boolean,
  isPrompting: boolean = false
): WakeAction {
  // If no active session
  if (!hasActiveSession) {
    // Low priority never wakes an idle agent
    return priority === "low" ? "queue" : "wake";
  }

  // If session exists but not currently prompting
  if (!isPrompting) {
    return priority === "low" ? "queue" : "wake";
  }

  // Agent is actively prompting (busy)
  switch (priority) {
    case "urgent":
      return "interrupt";
    case "high":
      return "inject";
    case "normal":
      return "queue";
    case "low":
      return "queue";
  }
}

/**
 * Get full wake decision with all state information.
 */
export function getWakeDecision(
  agentId: AgentId,
  priority: MessagePriority,
  sessionChecker: SessionChecker
): WakeDecision {
  const hasSession = sessionChecker.hasActiveSession(agentId);
  const isPrompting = sessionChecker.isPrompting?.(agentId) ?? false;
  const supportsInjection = sessionChecker.supportsInjection?.(agentId) ?? true;

  const action = determineWakeAction(priority, hasSession, isPrompting);

  // If we want to inject but session doesn't support it, fall back to interrupt
  const effectiveAction =
    action === "inject" && !supportsInjection ? "interrupt" : action;

  return {
    action: effectiveAction,
    shouldWake: effectiveAction === "wake",
    shouldInterrupt: effectiveAction === "interrupt",
    canInject: supportsInjection,
  };
}

/**
 * Check if a message should wake an idle agent based on priority.
 */
export function shouldWakeAgent(priority: MessagePriority): boolean {
  return priority !== "low";
}

/**
 * Check if a message should interrupt a busy agent based on priority.
 */
export function shouldInterruptAgent(priority: MessagePriority): boolean {
  return priority === "urgent";
}

/**
 * Get the numeric value of a priority for comparison.
 */
export const PRIORITY_VALUES: Record<MessagePriority, number> = {
  low: 0,
  normal: 1,
  high: 2,
  urgent: 3,
};

/**
 * Compare two priorities. Returns positive if a > b.
 */
export function comparePriority(
  a: MessagePriority,
  b: MessagePriority
): number {
  return PRIORITY_VALUES[a] - PRIORITY_VALUES[b];
}
