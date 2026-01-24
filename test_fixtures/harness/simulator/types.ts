/**
 * Types for Agent Simulator
 *
 * @see s-1zcx Multi-Agent Orchestration Testing Strategy
 */

import type { EventStore } from "../../../src/store/event-store.js";
import type { MessageRouter } from "../../../src/router/message-router.js";
import type { TaskManager } from "../../../src/task/task-manager.js";
import type { MergeQueueInterface } from "../../../src/workspace/merge-queue/types.js";
import type { AgentId, TaskId } from "../../../src/store/types/index.js";

// ─────────────────────────────────────────────────────────────────────────────
// Agent Roles
// ─────────────────────────────────────────────────────────────────────────────

export type AgentRole =
  | "worker"
  | "coordinator"
  | "integrator"
  | "monitor"
  | "resolver";

// ─────────────────────────────────────────────────────────────────────────────
// Done Status (matches lifecycle/types.ts)
// ─────────────────────────────────────────────────────────────────────────────

export type DoneStatus = "completed" | "failed" | "blocked" | "deferred";

// ─────────────────────────────────────────────────────────────────────────────
// Behavior Steps
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A single step in a simulated behavior script
 */
export type BehaviorStep =
  | CallToolStep
  | EmitSignalStep
  | WaitForEventStep
  | WaitForConditionStep
  | WriteFileStep
  | ReadFileStep
  | CommitStep
  | SleepStep
  | SpawnChildStep
  | DoneStep
  | ConditionalStep
  | LogStep
  | AssertStep;

export interface CallToolStep {
  type: "call_tool";
  tool: string;
  params: Record<string, unknown>;
  /** Store result in context.variables under this key */
  storeResult?: string;
}

export interface EmitSignalStep {
  type: "emit_signal";
  signal: string;
  payload: Record<string, unknown>;
}

export interface WaitForEventStep {
  type: "wait_for_event";
  event: string;
  timeoutMs?: number;
}

export interface WaitForConditionStep {
  type: "wait_for_condition";
  condition: ConditionFn;
  timeoutMs?: number;
}

export interface WriteFileStep {
  type: "write_file";
  path: string;
  content: string;
}

export interface ReadFileStep {
  type: "read_file";
  path: string;
  /** Store content in context.variables under this key */
  into: string;
}

export interface CommitStep {
  type: "commit";
  message: string;
}

export interface SleepStep {
  type: "sleep";
  ms: number;
}

export interface SpawnChildStep {
  type: "spawn_child";
  role: AgentRole;
  behavior: SimulatedBehavior;
  config?: Partial<SimulatorConfig>;
}

export interface DoneStep {
  type: "done";
  status: DoneStatus;
  summary?: string;
  details?: Record<string, unknown>;
}

export interface ConditionalStep {
  type: "conditional";
  if: ConditionFn;
  then: BehaviorStep[];
  else?: BehaviorStep[];
}

export interface LogStep {
  type: "log";
  message: string;
}

export interface AssertStep {
  type: "assert";
  condition: ConditionFn;
  message?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Simulated Behavior
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Condition function for conditional steps and wait_for_condition
 */
export type ConditionFn = (
  context: SimulatorContext
) => boolean | Promise<boolean>;

/**
 * Conditional behavior that triggers when condition is met
 */
export interface ConditionalBehavior {
  condition: ConditionFn;
  behavior: BehaviorStep[];
  /** Only trigger once (default: false) */
  once?: boolean;
}

/**
 * Complete behavior specification for a simulated agent
 */
export interface SimulatedBehavior {
  /** Steps to execute when the agent starts */
  onStart: BehaviorStep[];

  /** Event handlers (keyed by event/signal name) */
  onEvent?: Record<string, BehaviorStep[]>;

  /** Conditional behaviors evaluated continuously */
  conditions?: ConditionalBehavior[];

  /** Fail after N steps (for testing error handling) */
  failAfter?: number;

  /** Error to throw when failAfter is reached */
  failWith?: Error | string;

  /** Delay between steps in milliseconds (default: 0) */
  stepDelayMs?: number;

  /** Maximum execution time in milliseconds */
  timeoutMs?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Simulator Context
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Context available to behavior steps and condition functions
 */
export interface SimulatorContext {
  /** Agent ID */
  agentId: string;

  /** Agent role */
  role: AgentRole;

  /** Task ID (if assigned) */
  taskId?: string;

  /** Parent agent ID */
  parentId?: string;

  /** Workspace path (git worktree) */
  workspacePath: string;

  /** Stream ID (if assigned) */
  streamId?: string;

  /** Current branch name */
  branch?: string;

  /** Variables stored by steps (via storeResult) */
  variables: Map<string, unknown>;

  /** Events received by this agent */
  events: SimulatedEvent[];

  /** Child simulators spawned by this agent */
  children: AgentSimulator[];

  /** Stuck agents detected (for monitors) */
  stuckAgents: string[];

  /** Number of steps executed */
  stepCount: number;

  /** Timestamp when agent started */
  startedAt: number;

  /** Services for tool calls */
  services: SimulatorServices;
}

/**
 * Services available to the simulator for tool calls
 */
export interface SimulatorServices {
  eventStore: EventStore;
  messageRouter: MessageRouter;
  taskManager: TaskManager;
  mergeQueue?: MergeQueueInterface;
  roleRegistry?: import("../../../src/roles/types.js").RoleRegistry;
}

// ─────────────────────────────────────────────────────────────────────────────
// Simulated Events
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Event that can be injected into a simulator
 */
export interface SimulatedEvent {
  type: string;
  payload: Record<string, unknown>;
  source?: {
    agentId?: string;
    taskId?: string;
  };
  timestamp: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Step Results
// ─────────────────────────────────────────────────────────────────────────────

export type StepResultStatus =
  | "completed"
  | "waiting"
  | "failed"
  | "done"
  | "spawned_child";

/**
 * Result of executing a single step
 */
export interface StepResult {
  status: StepResultStatus;
  step: BehaviorStep;
  result?: unknown;
  error?: Error;
  childAgentId?: string;
}

/**
 * Result of a tool call
 */
export interface ToolResult {
  success: boolean;
  result?: unknown;
  error?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Workspace and Git State
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Current state of the workspace
 */
export interface WorkspaceState {
  path: string;
  branch: string;
  hasUncommittedChanges: boolean;
  files: string[];
}

/**
 * Git-specific state
 */
export interface GitState {
  currentBranch: string;
  branches: string[];
  uncommittedFiles: string[];
  lastCommit?: {
    hash: string;
    message: string;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Execution Log
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Entry in the execution log
 */
export interface ExecutionLogEntry {
  timestamp: number;
  stepIndex: number;
  step: BehaviorStep;
  result: StepResult;
  duration: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Simulator Configuration
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Configuration for spawning a simulator
 */
export interface SimulatorConfig {
  /** Agent role */
  role: AgentRole;

  /** Behavior script to execute */
  behavior: SimulatedBehavior;

  /** Repository path */
  repoPath: string;

  /** Task ID to assign */
  taskId?: string;

  /** Parent agent ID */
  parentId?: string;

  /** Stream ID */
  streamId?: string;

  /** Custom agent ID (default: auto-generated) */
  agentId?: string;

  /** Working directory override */
  cwd?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Agent Simulator Interface
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Simulated agent that executes behavior scripts
 */
export interface AgentSimulator {
  /** Agent ID */
  readonly agentId: string;

  /** Agent role */
  readonly role: AgentRole;

  /** Session ID (for EventStore integration) */
  readonly sessionId: string;

  /** Behavior being executed */
  behavior: SimulatedBehavior;

  // ── Lifecycle ────────────────────────────────────────────────────────────

  /**
   * Start the simulator
   */
  start(context: Omit<SimulatorContext, "variables" | "events" | "children" | "stuckAgents" | "stepCount" | "startedAt">): Promise<void>;

  /**
   * Stop the simulator
   */
  stop(): Promise<void>;

  /**
   * Check if the simulator is running
   */
  isRunning(): boolean;

  // ── Execution Control ────────────────────────────────────────────────────

  /**
   * Execute one step and return the result
   */
  stepOnce(): Promise<StepResult>;

  /**
   * Check if there are pending steps to execute
   */
  hasPendingSteps(): boolean;

  /**
   * Pause execution
   */
  pauseExecution(): void;

  /**
   * Resume execution
   */
  resumeExecution(): void;

  // ── Tool Execution ───────────────────────────────────────────────────────

  /**
   * Handle a tool call (routes to real services)
   */
  handleToolCall(tool: string, params: unknown): Promise<ToolResult>;

  // ── Event Injection ──────────────────────────────────────────────────────

  /**
   * Inject an event into the simulator
   */
  injectEvent(event: SimulatedEvent): void;

  // ── State Access ─────────────────────────────────────────────────────────

  /**
   * Get current workspace state
   */
  getWorkspaceState(): WorkspaceState;

  /**
   * Get current git state
   */
  getGitState(): GitState;

  /**
   * Get execution log
   */
  getExecutionLog(): ExecutionLogEntry[];

  /**
   * Get the simulator context
   */
  getContext(): SimulatorContext;
}
