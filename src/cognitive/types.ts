/**
 * Cognitive Module - Bridge Types
 *
 * Structurally compatible with cognitive-core's runtime types (AgentSession,
 * AgentMessage, ToolCall) without importing from cognitive-core.
 * TypeScript's structural typing makes these assignable without casting.
 *
 * Stripped to what OpenHive needs: agent execution + session tracking.
 * Atlas, trajectory extraction, and ACP extensions are handled by OpenHive.
 */

import type { AgentId } from "../store/types/index.js";
import type { TasksAdapter, InboxAdapter } from "../adapters/types.js";

// ─────────────────────────────────────────────────────────────────
// Agent Session Types (matches cognitive-core/src/runtime/types.ts)
// ─────────────────────────────────────────────────────────────────

export interface CognitiveAgentMessage {
  role: "user" | "assistant" | "system" | "tool_use" | "tool_result";
  content: string;
  toolName?: string;
  toolInput?: unknown;
  toolOutput?: unknown;
  timestamp: Date;
}

export interface CognitiveToolCall {
  id: string;
  name: string;
  input: unknown;
  output?: unknown;
  error?: string;
  startTime: Date;
  endTime?: Date;
}

export type CognitiveAgentState =
  | "idle"
  | "running"
  | "paused"
  | "completed"
  | "failed";

export interface CognitiveTask {
  description: string;
  context?: Record<string, unknown>;
  domain?: string;
}

/**
 * Agent session — represents a running or completed agent execution.
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
 * Configuration for spawning an agent.
 * Structurally matches cognitive-core's AgentSpawnConfig (core fields).
 */
export interface CognitiveAgentSpawnConfig {
  agentType: string;
  task: CognitiveTask;
  systemPromptAdditions?: string;
  env?: Record<string, string>;
  cwd?: string;
  timeout?: number;
  onMessage?: (message: CognitiveAgentMessage) => void;
}

// ─────────────────────────────────────────────────────────────────
// Session Completion Types
// ─────────────────────────────────────────────────────────────────

/**
 * Event emitted when a cognitive session completes (success or failure).
 */
export interface SessionCompleteEvent {
  sessionId: string;
  agentId: string;
  state: CognitiveAgentState;
  duration_ms: number;
  message_count: number;
  tool_call_count: number;
}

// ─────────────────────────────────────────────────────────────────
// Backend Configuration
// ─────────────────────────────────────────────────────────────────

/**
 * Configuration for MacroAgentBackend.
 *
 * Stripped to essentials: agent lifecycle + optional task tracking.
 * Atlas/trajectory handling is done by OpenHive, not the swarm.
 */
export interface MacroAgentBackendConfig {
  /** Max follow-up prompts if agent doesn't call done(). Default: 1 */
  maxFollowUps?: number;
  /** Fraction of timeout at which to send "wrap up" nudge. Default: 0.8 */
  softTimeoutRatio?: number;
  /** Optional TasksAdapter for tracking analyst tasks. */
  tasksAdapter?: TasksAdapter;
  /** Callback invoked when a session completes (success or failure). */
  onSessionComplete?: (event: SessionCompleteEvent) => void;
  /** Optional inbox adapter for sending session.complete notifications. */
  inboxAdapter?: InboxAdapter;
  /** When true, spawned analysts are children of coordinatorAgentId. */
  useTeam?: boolean;
  /** Parent agent ID when useTeam is true. */
  coordinatorAgentId?: AgentId;
}

/**
 * Internal session tracking state.
 */
export interface MacroSessionState {
  agentId: AgentId;
  session: CognitiveAgentSession;
  config: CognitiveAgentSpawnConfig;
  runPromise: Promise<void>;
  taskId?: string;
}

// ─────────────────────────────────────────────────────────────────
// Batch Types
// ─────────────────────────────────────────────────────────────────

export interface CognitiveBatchConfig {
  tasks: CognitiveAgentSpawnConfig[];
  maxConcurrency?: number;
}

export interface CognitiveBatchTaskResult {
  config: CognitiveAgentSpawnConfig;
  session?: CognitiveAgentSession;
  error?: string;
}

export interface CognitiveBatchResult {
  results: CognitiveBatchTaskResult[];
  completed: number;
  failed: number;
  cancelled: boolean;
}

export interface CognitiveBatchHandle {
  totalTasks: number;
  waitForAll(): Promise<CognitiveBatchResult>;
  cancel(): Promise<CognitiveBatchResult>;
}
