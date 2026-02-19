/**
 * Task Backend Interface Types
 *
 * Defines the pluggable task backend interface that allows macro-agent's
 * internal task system to be backed by external task management systems.
 *
 * @module task/backend
 */

import type {
  AgentId,
  TaskId,
  Timestamp,
  Task,
  TaskStatus,
  ArtifactRef,
  AgentHistoryEntry,
} from "../../store/types/index.js";

// Re-export for convenience
export type { Task, TaskStatus, ArtifactRef, AgentHistoryEntry };

// =============================================================================
// Extended Task Type
// =============================================================================

/**
 * Extended Task type with computed fields and external binding.
 * Extends the base Task type with additional fields for backend integration.
 */
export interface ExtendedTask extends Task {
  /** True if blocked by dependencies (computed, not stored) */
  isBlocked?: boolean;

  /** Binding to external system (e.g., OpenTasks issue ID "i-xxxx") */
  external_id?: string;

  /** Source project location (e.g., opentasks path or URI) for federated tasks */
  source_location?: string;
}

// =============================================================================
// Create/Update Options
// =============================================================================

/**
 * Options for creating a new task
 */
export interface CreateTaskOptions {
  /** Task description */
  description: string;

  /** Agent creating the task */
  created_by: AgentId;

  /** Optional parent task for subtask hierarchy */
  parent_task?: TaskId;

  /** Optional binding to external system (e.g., OpenTasks issue ID) */
  external_id?: string;

  /** Optional tags for classification and filtering (pull model) */
  tags?: string[];
}

/**
 * Options for updating task metadata
 */
export interface UpdateTaskOptions {
  /** Update task outputs */
  outputs?: Record<string, unknown>;

  /** Add artifacts to task */
  artifacts?: ArtifactRef[];

  /** Update description */
  description?: string;

  /** Update status */
  status?: TaskStatus;
}

/**
 * Task outputs on completion
 */
export interface TaskOutputs {
  /** Summary of work done */
  summary?: string;

  /** Output data */
  data?: Record<string, unknown>;

  /** Artifacts produced */
  artifacts?: ArtifactRef[];
}

/**
 * Task error on failure
 */
export interface TaskError {
  /** Error message */
  message: string;

  /** Error code/type */
  code?: string;

  /** Stack trace or additional details */
  details?: unknown;
}

// =============================================================================
// Query Options
// =============================================================================

/**
 * Filter options for listing tasks
 */
export interface TaskFilter {
  /** Filter by status (single or multiple) */
  status?: TaskStatus | TaskStatus[];

  /** Filter by assigned agent */
  assigned_agent?: AgentId;

  /** Filter by parent task */
  parent_task?: TaskId;

  /** Filter by creator */
  created_by?: AgentId;

  /** Only root tasks (no parent) */
  rootTasksOnly?: boolean;

  /** Include blocked tasks (default: false) */
  includeBlocked?: boolean;

  /** Filter tasks assigned before this timestamp (for stale assignment detection) */
  assignedBefore?: Timestamp;

  /** Filter by tags (task must have at least one matching tag) */
  tags?: string[];
}

/**
 * Aggregate status of subtasks
 */
export interface SubtaskStatus {
  total: number;
  pending: number;
  assigned: number;
  in_progress: number;
  completed: number;
  failed: number;
  allCompleted: boolean;
  anyFailed: boolean;
}

// =============================================================================
// Assignment Options
// =============================================================================

/**
 * Options for assigning a task to an agent
 */
export interface AssignOptions {
  /** Optional role of the agent */
  role?: string;

  /** Optional lease timeout in milliseconds (default: none) */
  leaseMs?: number;
}

// =============================================================================
// Claim Filter (Pull Model)
// =============================================================================

/**
 * Filter options for claiming tasks.
 * Used by the pull model to find eligible tasks for an agent.
 */
export interface ClaimFilter {
  /** Only claim tasks with at least one matching tag */
  tags?: string[];

  /** Only claim root tasks (no parent) */
  rootTasksOnly?: boolean;

  /** Only claim tasks created by a specific agent */
  created_by?: AgentId;
}

// =============================================================================
// Event Types
// =============================================================================

/**
 * Task change event types
 */
export type TaskChangeType =
  | "created"
  | "updated"
  | "status_changed"
  | "assigned"
  | "unassigned"
  | "completed"
  | "failed"
  | "deleted";

/**
 * Task change event
 */
export interface TaskChangeEvent {
  /** Event type */
  type: TaskChangeType;

  /** Task ID */
  taskId: TaskId;

  /** Current task state */
  task: ExtendedTask;

  /** Previous task state (for updates) */
  previousTask?: ExtendedTask;

  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Callback for task change events
 */
export type TaskChangeCallback = (event: TaskChangeEvent) => void;

/**
 * Unsubscribe function
 */
export type Unsubscribe = () => void;

// =============================================================================
// Task Backend Interface
// =============================================================================

/**
 * Task Backend Interface
 *
 * Abstraction over task storage allowing different implementations:
 * - InMemoryTaskBackend - Current behavior (default)
 * - OpenTasksTaskBackend - Backed by OpenTasks graph
 */
export interface TaskBackend {
  // ─── Lifecycle ───────────────────────────────────────────────
  /** Gracefully close the backend. After close(), write operations may throw. */
  close?(): Promise<void>;

  /** Create a new task */
  create(options: CreateTaskOptions): Promise<ExtendedTask>;

  /** Get a task by ID */
  get(id: TaskId): Promise<ExtendedTask | null>;

  /** Update task metadata */
  update(id: TaskId, updates: UpdateTaskOptions): Promise<ExtendedTask>;

  /** Delete a task */
  delete(id: TaskId): Promise<void>;

  // ─── Status Transitions ──────────────────────────────────────
  /** Assign task to an agent */
  assign(id: TaskId, agentId: AgentId, options?: AssignOptions): Promise<void>;

  /** Unassign task from its current agent */
  unassign(id: TaskId): Promise<void>;

  /** Start task execution */
  start(id: TaskId): Promise<void>;

  /** Complete task with optional outputs */
  complete(id: TaskId, outputs?: TaskOutputs): Promise<void>;

  /** Mark task as failed */
  fail(id: TaskId, error: TaskError): Promise<void>;

  // ─── Queries ─────────────────────────────────────────────────
  /** List tasks with optional filter */
  list(filter?: TaskFilter): Promise<ExtendedTask[]>;

  /** List tasks that are ready to work on (no blocking dependencies) */
  listReady(filter?: TaskFilter): Promise<ExtendedTask[]>;

  /** Get child tasks of a parent */
  getChildren(parentId: TaskId): Promise<ExtendedTask[]>;

  /** Get aggregate subtask status */
  getSubtaskStatus(parentId: TaskId): Promise<SubtaskStatus>;

  // ─── Hierarchy ───────────────────────────────────────────────
  /** Create a subtask under a parent */
  createSubtask(
    parentId: TaskId,
    options: CreateTaskOptions
  ): Promise<ExtendedTask>;

  // ─── Dependencies ────────────────────────────────────────────
  /** Add a blocking dependency */
  addBlocker(taskId: TaskId, blockerId: TaskId): Promise<void>;

  /** Remove a blocking dependency */
  removeBlocker(taskId: TaskId, blockerId: TaskId): Promise<void>;

  /** Get tasks that block this task */
  getBlockers(taskId: TaskId): Promise<ExtendedTask[]>;

  /** Get tasks that this task blocks */
  getBlocking(taskId: TaskId): Promise<ExtendedTask[]>;

  // ─── Pull Model (Claim/Unclaim) ──────────────────────────────
  /**
   * Claim the next available task matching the filter.
   * Atomically assigns the task to the agent. Returns null if no matching task
   * is available or if another agent claimed it first (contention).
   */
  claim?(agentId: AgentId, filter?: ClaimFilter): Promise<ExtendedTask | null>;

  /**
   * Release a claimed task back to pending status.
   */
  unclaim?(taskId: TaskId): Promise<void>;

  /**
   * List tasks available for claiming (pending, not blocked, not assigned).
   */
  listClaimable?(filter?: ClaimFilter): Promise<ExtendedTask[]>;

  // ─── History ─────────────────────────────────────────────────
  /** Get agent assignment history for a task */
  getAgentHistory(taskId: TaskId): Promise<AgentHistoryEntry[]>;

  // ─── Event Subscriptions ─────────────────────────────────────
  /** Subscribe to all task changes */
  onTaskChange(callback: TaskChangeCallback): Unsubscribe;

  /** Subscribe to changes for a specific task */
  onTaskChange(taskId: TaskId, callback: TaskChangeCallback): Unsubscribe;
}

// =============================================================================
// Tool Provider Interface
// =============================================================================

/**
 * MCP tool definition for task operations
 */
export interface MCPToolDefinition {
  /** Tool name */
  name: string;

  /** Tool description */
  description: string;

  /** JSON Schema for parameters */
  schema: Record<string, unknown>;

  /** Tool handler function */
  handler: (params: unknown) => Promise<unknown>;
}

/**
 * Task Tool Provider Interface
 *
 * Allows backends to define which MCP tools are exposed for task operations.
 */
export interface TaskToolProvider {
  /** Get the MCP tools to expose for task operations */
  getTools(): MCPToolDefinition[];

  /** Tools that should NOT be exposed when this provider is active */
  getExcludedTools?(): string[];
}

// =============================================================================
// Configuration Types
// =============================================================================

/**
 * In-memory backend configuration
 */
export interface InMemoryBackendConfig {
  type: "memory";
}

/**
 * OpenTasks backend configuration
 */
export interface OpenTasksBackendConfig {
  type: "opentasks";

  /** Path to the OpenTasks daemon socket (auto-discovered if not set) */
  socketPath?: string;

  /** Whether to sync status changes to OpenTasks (default: true) */
  syncStatus?: boolean;

  /** Source label for issues created by this backend (default: "macro-agent") */
  sourceLabel?: string;

  /** Auto-start the central opentasks daemon (default: true) */
  autoStart?: boolean;

  /** Central daemon location (default: ~/.multiagent/opentasks) */
  centralPath?: string;

  /** Auto-connect project .opentasks/ dirs on agent spawn (default: true) */
  connectOnSpawn?: boolean;
}

/**
 * Task backend configuration
 */
export type TaskBackendConfig = InMemoryBackendConfig | OpenTasksBackendConfig;

/**
 * Macro-agent task configuration
 */
export interface TaskConfig {
  /** Task backend configuration */
  backend: TaskBackendConfig;
}

// =============================================================================
// Default Configuration
// =============================================================================

/**
 * Default task configuration
 */
export const DEFAULT_TASK_CONFIG: TaskConfig = {
  backend: { type: "opentasks" },
};

/**
 * Default OpenTasks backend configuration
 */
export const DEFAULT_OPENTASKS_CONFIG: Omit<OpenTasksBackendConfig, "type"> = {
  syncStatus: true,
  sourceLabel: "macro-agent",
  autoStart: true,
  connectOnSpawn: true,
};
