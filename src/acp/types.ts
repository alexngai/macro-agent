/**
 * ACP (Agent Communication Protocol) types for macro-agent.
 *
 * Lean type definitions for session mapping, configuration,
 * and error handling in the ACP WebSocket layer.
 *
 * @module acp/types
 */

// ─────────────────────────────────────────────────────────────────
// Session Types
// ─────────────────────────────────────────────────────────────────

export type ACPSessionId = string;

/**
 * Maps an ACP session to an underlying macro-agent agent.
 * Each ACP connection can have multiple sessions, each pointing
 * to a different agent (with a head manager as the default).
 */
export interface SessionMapping {
  /** ACP protocol session ID */
  acpSessionId: ACPSessionId;

  /** Currently active agent ID (changes on mount/unmount) */
  agentId: string;

  /** The root head manager ID (restored on unmount) */
  headManagerId: string;

  /** Whether a non-head agent is mounted */
  isMounted: boolean;

  /** When the session was created (epoch ms) */
  createdAt: number;

  /** Whether a prompt is currently in-flight */
  isProcessing: boolean;
}

// ─────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────

/**
 * Configuration passed to the macro-agent ACP handler.
 */
export interface MacroAgentInitConfig {
  /** Default working directory for new sessions */
  defaultCwd?: string;

  /** Prefix prepended to system prompts */
  systemPromptPrefix?: string;

  /** Suffix appended to system prompts */
  systemPromptSuffix?: string;

  /**
   * Local agent ID this ACP stream is bound to. When set, `session/new` binds
   * the new session to this specific agent (any role) instead of falling back
   * to cwd-based head-manager lookup. Set by the ACP-over-MAP bridge so that
   * MAP-level routing (which already targets a specific agent) is preserved
   * end-to-end through the ACP layer — important when multiple coordinators
   * share the same cwd.
   */
  targetAgentId?: string;
}

// ─────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────

export type ACPErrorCode =
  | "SESSION_NOT_FOUND"
  | "AGENT_NOT_FOUND"
  | "MOUNT_FAILED"
  | "FORK_FAILED"
  | "INVALID_EXTENSION"
  | "PERMISSION_DENIED"
  | "NO_PEER_MANAGER";

/**
 * Typed error for ACP operations.
 */
export class ACPError extends Error {
  public readonly code: ACPErrorCode;
  public readonly details?: Record<string, unknown>;

  constructor(
    message: string,
    code: ACPErrorCode,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ACPError";
    this.code = code;
    this.details = details;
  }
}
