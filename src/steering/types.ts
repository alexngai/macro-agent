/**
 * Context Injection Types
 *
 * Types for the context injection system that enables steering agents
 * mid-execution via inject, interrupt, or message fallback.
 *
 * @module steering/types
 * @see s-9rld In-Flight Steering spec section 3.1
 */

import type { AgentId } from "../store/types/index.js";

// =============================================================================
// Injection Source
// =============================================================================

/**
 * Source of a context injection for audit tracking
 */
export type InjectionSource =
  | { type: "human" }
  | { type: "agent"; agentId: AgentId };

// =============================================================================
// Injection Options
// =============================================================================

/**
 * Options for context injection
 */
export interface InjectionOptions {
  /**
   * Allow falling back to interruptWith() if inject() fails.
   * Warning: This will cancel the agent's current work.
   * @default true
   */
  allowInterrupt?: boolean;

  /**
   * Force interrupt even if inject is available.
   * Use for urgent redirects that need immediate effect.
   * @default false
   */
  urgent?: boolean;

  /**
   * Source of the injection for audit logging.
   */
  source?: InjectionSource;

  /**
   * Optional reason for the injection (for audit logs).
   */
  reason?: string;
}

// =============================================================================
// Injection Result
// =============================================================================

/**
 * Method used to deliver the context
 */
export type InjectionMethod =
  | "inject" // Used session.inject() - queued for next turn
  | "interrupt" // Used session.interruptWith() - cancelled and restarted
  | "message" // Sent as high-priority message
  | "queued"; // Queued for later (agent not available)

/**
 * Result of a context injection attempt
 */
export interface InjectionResult {
  /** Whether the injection was successful */
  success: boolean;

  /** Method used to deliver the context (if successful) */
  method?: InjectionMethod;

  /** Error message (if not successful) */
  error?: string;

  /** Additional notes about the injection */
  note?: string;
}

// =============================================================================
// Session Injection Interface
// =============================================================================

/**
 * Minimal session interface needed for injection.
 * Matches acp-factory's Session type.
 */
export interface InjectableSession {
  /** Inject content to be queued for next turn */
  inject(
    content: string,
    options?: { throwOnUnsupported?: boolean }
  ): Promise<{ success: boolean; error?: string }>;

  /** Check if inject is supported (cached check) */
  supportsInject(): boolean;

  /** Check if inject is supported (probes the agent) */
  checkInjectSupport(): Promise<boolean>;

  /** Interrupt current work and restart with new content */
  interruptWith(
    content: string
  ): AsyncIterable<unknown>;
}

// =============================================================================
// Injection Handler Dependencies
// =============================================================================

/**
 * Dependencies needed by the injection handler
 */
export interface InjectionDeps {
  /**
   * Get a session for an agent.
   * Returns null if agent has no active session.
   */
  getSession(agentId: AgentId): InjectableSession | null;

  /**
   * Check if an agent is currently processing a prompt.
   */
  isPrompting(agentId: AgentId): boolean;

  /**
   * Send a high-priority message to an agent.
   * Used as fallback when inject/interrupt are not available.
   */
  sendMessage(
    fromAgentId: AgentId | undefined,
    toAgentId: AgentId,
    content: string,
    priority: "high"
  ): Promise<void>;
}
