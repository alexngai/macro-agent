/**
 * Task Backend Module
 *
 * Exports task backend interface types and implementations.
 *
 * @module task/backend
 * @see s-8472 Pluggable Task Backend Integration with Sudocode
 */

// =============================================================================
// Types
// =============================================================================

export type {
  // Extended task type
  ExtendedTask,

  // Options
  CreateTaskOptions,
  UpdateTaskOptions,
  TaskOutputs,
  TaskError,
  TaskFilter,
  SubtaskStatus,
  AssignOptions,

  // Events
  TaskChangeType,
  TaskChangeEvent,
  TaskChangeCallback,
  Unsubscribe,

  // Backend interface
  TaskBackend,

  // Tool provider
  MCPToolDefinition,
  TaskToolMode,
  TaskToolProvider,

  // Configuration
  InMemoryBackendConfig,
  ExecutionTrackingConfig,
  ExecutionFilter,
  SudocodeBackendConfig,
  TaskBackendConfig,
  TaskConfig,
} from "./types.js";

export { DEFAULT_TASK_CONFIG, DEFAULT_SUDOCODE_CONFIG } from "./types.js";

// Re-export base types for convenience
export type {
  Task,
  TaskStatus,
  ArtifactRef,
  AgentHistoryEntry,
} from "./types.js";

// =============================================================================
// Implementations
// =============================================================================

export {
  InMemoryTaskBackend,
  createInMemoryTaskBackend,
  TaskBackendError,
} from "./memory.js";

export {
  InMemoryTaskToolProvider,
  createTaskToolProvider,
} from "./tool-provider.js";

export type { TaskToolContext, GetToolContext } from "./tool-provider.js";
