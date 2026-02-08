/**
 * Session-related type definitions
 *
 * Sessions track the mapping between ACP protocol sessions and
 * macro-agent agents. Unlike the in-memory SessionMapper, these
 * records are persisted in the EventStore for recovery after restart.
 */

import type { AgentId, Timestamp } from "./primitives.js";

/**
 * Session state enum — tracks the lifecycle of an ACP session.
 *
 * State transitions:
 *   active → mounted → active (via unmount)
 *   active → closed
 *   mounted → closed
 */
export type SessionState = "active" | "mounted" | "closed";

/**
 * Persistent session record in the EventStore materialized view.
 *
 * Maps an ACP session ID to its head manager agent, current agent
 * target (which may differ when mounted), and lifecycle state.
 */
export interface Session {
  /** ACP session ID (primary key) */
  id: string;

  /** Head manager agent ID — the original agent for this session */
  head_manager_id: AgentId;

  /** Currently targeted agent ID (may differ from head_manager_id when mounted) */
  current_agent_id: AgentId;

  /** Current session state */
  state: SessionState;

  /** When the session was created */
  created_at: Timestamp;

  /** When the session state last changed */
  updated_at: Timestamp;

  /** When the session was closed (if applicable) */
  closed_at?: Timestamp;
}

/**
 * Session event actions used in the event payload.
 */
export type SessionAction = "created" | "mounted" | "unmounted" | "closed";
