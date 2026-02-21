/**
 * Cognitive Module - Bridge Types
 *
 * Structurally compatible with cognitive-core's runtime types (AgentSession,
 * AgentMessage, ToolCall, etc.) without importing from cognitive-core.
 * TypeScript's structural typing makes these assignable without casting.
 */

import type { AgentId } from "../store/types/index.js";

// ─────────────────────────────────────────────────────────────────
// Agent Session Types (matches cognitive-core/src/runtime/types.ts)
// ─────────────────────────────────────────────────────────────────

/**
 * Message in an agent conversation.
 * Structurally matches cognitive-core's AgentMessage.
 */
export interface CognitiveAgentMessage {
  role: "user" | "assistant" | "system" | "tool_use" | "tool_result";
  content: string;
  toolName?: string;
  toolInput?: unknown;
  toolOutput?: unknown;
  timestamp: Date;
}

/**
 * Tool call made by an agent.
 * Structurally matches cognitive-core's ToolCall.
 */
export interface CognitiveToolCall {
  id: string;
  name: string;
  input: unknown;
  output?: unknown;
  error?: string;
  startTime: Date;
  endTime?: Date;
}

/**
 * Agent execution state.
 */
export type CognitiveAgentState =
  | "idle"
  | "running"
  | "paused"
  | "completed"
  | "failed";

/**
 * Minimal task description.
 * Structurally matches cognitive-core's Task (core fields only).
 */
export interface CognitiveTask {
  description: string;
  context?: Record<string, unknown>;
  domain?: string;
}

/**
 * Agent session - represents a running or completed agent execution.
 * Structurally matches cognitive-core's AgentSession.
 */
export interface CognitiveAgentSession {
  id: string;
  agentType: string;
  task: CognitiveTask;
  state: CognitiveAgentState;
  messages: CognitiveAgentMessage[];
  toolCalls: CognitiveToolCall[];
  startTime: Date;
  endTime?: Date;
  result?: unknown;
  error?: string;
  metadata: Record<string, unknown>;
}

/**
 * Spawn configuration (subset of cognitive-core's AgentSpawnConfig).
 * Only the fields that MacroAgentBackend needs.
 */
export interface CognitiveAgentSpawnConfig {
  agentType: string;
  task: CognitiveTask;
  systemPromptAdditions?: string;
  env?: Record<string, string>;
  cwd?: string;
  timeout?: number;
  captureToolCalls?: boolean;
  onMessage?: (message: CognitiveAgentMessage) => void;
  onToolCall?: (toolCall: CognitiveToolCall) => void;
  backendOptions?: Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────────
// Backend Configuration
// ─────────────────────────────────────────────────────────────────

/**
 * Configuration for MacroAgentBackend.
 */
export interface MacroAgentBackendConfig {
  /** Max follow-up prompts if agent doesn't call done(). Default: 1 */
  maxFollowUps?: number;
  /** Fraction of timeout at which to send "wrap up" nudge. Default: 0.8 */
  softTimeoutRatio?: number;
  /** Spawn analysts under a team coordinator (Phase B). Default: false */
  useTeam?: boolean;
  /** Agent ID of team coordinator. Required when useTeam is true. */
  coordinatorAgentId?: AgentId;
}

/**
 * Internal session tracking state.
 */
export interface MacroSessionState {
  /** macro-agent's internal agent ID */
  agentId: AgentId;
  /** The cognitive session being populated */
  session: CognitiveAgentSession;
  /** Original spawn config */
  config: CognitiveAgentSpawnConfig;
  /** Promise tracking the runSession background task */
  runPromise: Promise<void>;
}
