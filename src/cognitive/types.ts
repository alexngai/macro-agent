/**
 * Cognitive Module - Bridge Types
 *
 * Structurally compatible with cognitive-core's runtime types (AgentSession,
 * AgentMessage, ToolCall, etc.) without importing from cognitive-core.
 * TypeScript's structural typing makes these assignable without casting.
 */

import type { AgentId } from "../store/types/index.js";
import type { TaskBackend } from "../task/backend/types.js";

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
// Trajectory Types (matches cognitive-core's Trajectory/Step/Outcome)
// ─────────────────────────────────────────────────────────────────

/**
 * A single ReAct step: thought → action → observation.
 * Structurally matches cognitive-core's Step.
 */
export interface CognitiveStep {
  thought?: string;
  action: string;
  observation: string;
  timestamp?: Date;
  metadata?: Record<string, unknown>;
}

/**
 * Outcome of an agent trajectory.
 * Structurally matches cognitive-core's Outcome.
 */
export interface CognitiveOutcome {
  success: boolean;
  solution?: unknown;
  errorInfo?: string;
  partialScore?: number;
}

/**
 * Full trajectory of an agent execution.
 * Structurally matches cognitive-core's Trajectory.
 */
export interface CognitiveTrajectory {
  id: string;
  task: CognitiveTask;
  steps: CognitiveStep[];
  outcome: CognitiveOutcome;
  agentId: string;
  timestamp: Date;
  llmCalls: number;
  totalTokens: number;
  wallTimeSeconds: number;
  metadata: Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────────
// Atlas Interface (structural match for cognitive-core's Atlas)
// ─────────────────────────────────────────────────────────────────

/** Operations that can be dispatched to Atlas. */
export type CognitiveOperation = "extract" | "prune" | "team-extract" | "query";

/**
 * Structural interface for cognitive-core's Atlas class.
 * Accepted via dependency injection (cognitive-core is not yet published).
 */
export interface AtlasInstance {
  processTrajectory(trajectory: CognitiveTrajectory): Promise<{
    trajectoryId: string;
    stored: boolean;
  }>;
  runBatchLearning(): Promise<{
    trajectoriesProcessed: number;
    playbooksExtracted: number;
  }>;
  runTeamBatchLearning?(): Promise<{
    trajectoriesProcessed: number;
    teamPlaybooksCreated: number;
  } | null>;
  queryMemory(query: string, options?: {
    domains?: string[];
    includeExperiences?: boolean;
    includePlaybooks?: boolean;
  }): Promise<unknown>;
  prune?(options?: Record<string, unknown>): Promise<{
    totalPruned: number;
    remainingCount: number;
  }>;
  close(): Promise<void>;
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
  trajectory?: CognitiveTrajectory;
  duration_ms: number;
  message_count: number;
  tool_call_count: number;
}

// ─────────────────────────────────────────────────────────────────
// MAP Event Emission
// ─────────────────────────────────────────────────────────────────

/**
 * Minimal structural interface for emitting MAP events.
 * Avoids importing the full MAPAdapter type into the cognitive module.
 */
export interface SessionEventEmitter {
  emitEvent(event: {
    eventId: string;
    type: string;
    timestamp: number;
    data: unknown;
    agentId?: string;
  }): void;
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
  /** Optional TaskBackend for tracking analyst tasks. When provided, spawn() creates tracked tasks. */
  taskBackend?: TaskBackend;
  /** Optional Atlas instance for trajectory learning. */
  atlas?: AtlasInstance;
  /** Callback invoked when a session completes (success or failure). */
  onSessionComplete?: (event: SessionCompleteEvent) => void;
  /** Optional MAP adapter for emitting session.complete events to external subscribers. */
  mapAdapter?: SessionEventEmitter;
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
  /** Task ID in TaskBackend, if task tracking is enabled */
  taskId?: string;
}

// ─────────────────────────────────────────────────────────────────
// Batch Types (Phase 3a)
// ─────────────────────────────────────────────────────────────────

/**
 * Configuration for batch task submission.
 */
export interface CognitiveBatchConfig {
  /** Array of spawn configs (one per task) */
  tasks: CognitiveAgentSpawnConfig[];
  /** Max analysts running concurrently. Default: 4 */
  maxConcurrency?: number;
}

/**
 * Per-task result in a batch.
 */
export interface CognitiveBatchTaskResult {
  /** The spawn config for this task */
  config: CognitiveAgentSpawnConfig;
  /** The session (populated after completion) */
  session?: CognitiveAgentSession;
  /** Error if spawn or execution failed before session creation */
  error?: string;
}

/**
 * Aggregate result of a batch submission.
 */
export interface CognitiveBatchResult {
  /** Results per task (same order as input tasks) */
  results: CognitiveBatchTaskResult[];
  /** Count of completed tasks */
  completed: number;
  /** Count of failed tasks */
  failed: number;
  /** Whether the batch was cancelled */
  cancelled: boolean;
}

/**
 * Handle for a running batch, returned by submitBatch().
 */
export interface CognitiveBatchHandle {
  /** Total tasks in this batch */
  totalTasks: number;
  /** Wait for all tasks to complete or fail */
  waitForAll(): Promise<CognitiveBatchResult>;
  /** Cancel remaining tasks and terminate running sessions */
  cancel(): Promise<CognitiveBatchResult>;
}
