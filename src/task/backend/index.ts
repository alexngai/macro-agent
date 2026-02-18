/**
 * Task Backend Module
 *
 * Exports task backend interface types and implementations.
 *
 * @module task/backend
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
  TaskToolProvider,

  // Configuration
  InMemoryBackendConfig,
  OpenTasksBackendConfig,
  TaskBackendConfig,
  TaskConfig,
} from "./types.js";

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
  UnifiedTaskToolProvider,
  createUnifiedToolProvider,
} from "./unified-tool-provider.js";

export type { ToolContext, GetToolContext } from "./unified-tool-provider.js";

// =============================================================================
// OpenTasks Backend (re-export)
// =============================================================================

export {
  OpenTasksTaskBackend,
  OpenTasksBackendError,
  createOpenTasksTaskBackend,
  IPCOpenTasksClient,
  OpenTasksClientError,
  createOpenTasksClient,
} from "./opentasks/index.js";

export type {
  OpenTasksClient,
  OpenTasksClientConfig,
  OpenTasksIssue,
  OpenTasksEdge,
  OpenTasksNodeSummary,
} from "./opentasks/index.js";

// =============================================================================
// Backend Factory
// =============================================================================

import type { EventStore } from "../../store/event-store.js";
import type { TaskBackend, TaskConfig, TaskBackendConfig } from "./types.js";
import type { OpenTasksClient } from "./opentasks/client.js";
import { DEFAULT_TASK_CONFIG, DEFAULT_OPENTASKS_CONFIG } from "./types.js";
import { InMemoryTaskBackend } from "./memory.js";

/**
 * Result of creating a task backend
 */
export interface TaskBackendResult {
  /** The task backend instance */
  backend: TaskBackend;

  /** OpenTasks client (if opentasks backend is used) */
  openTasksClient?: OpenTasksClient;
}

/**
 * Create a task backend based on configuration
 *
 * @param config - Task configuration
 * @param eventStore - Event store for state management
 * @returns Backend result with backend instance and optional OpenTasks client
 *
 * @example
 * ```typescript
 * // Create in-memory backend (default)
 * const { backend } = await createTaskBackend(
 *   { backend: { type: 'memory' } },
 *   eventStore
 * );
 *
 * // Create opentasks backend
 * const { backend, openTasksClient } = await createTaskBackend(
 *   { backend: { type: 'opentasks' } },
 *   eventStore
 * );
 * ```
 */
export async function createTaskBackend(
  config: TaskConfig,
  eventStore: EventStore
): Promise<TaskBackendResult> {
  const { backend: backendConfig } = config;

  if (backendConfig.type === "memory") {
    const backend = new InMemoryTaskBackend(eventStore);
    return { backend };
  }

  if (backendConfig.type === "opentasks") {
    // Dynamic import to avoid loading opentasks dependencies if not needed
    const { createOpenTasksClient } = await import("./opentasks/client.js");
    const { OpenTasksTaskBackend } = await import("./opentasks/backend.js");

    // Merge with defaults
    const openTasksConfig = {
      ...DEFAULT_OPENTASKS_CONFIG,
      ...backendConfig,
    };

    // Create OpenTasks client
    const openTasksClient = await createOpenTasksClient({
      socketPath: openTasksConfig.socketPath,
    });

    // Create backend
    const backend = new OpenTasksTaskBackend(eventStore, openTasksClient, {
      socketPath: openTasksConfig.socketPath,
      syncStatus: openTasksConfig.syncStatus,
      sourceLabel: openTasksConfig.sourceLabel,
    });

    return { backend, openTasksClient };
  }

  throw new Error(
    `Unknown backend type: ${(backendConfig as TaskBackendConfig).type}`
  );
}

/**
 * Load task configuration from environment variables
 *
 * Environment variables:
 * - MACRO_TASK_BACKEND: 'memory' | 'opentasks' (default: 'memory')
 * - OPENTASKS_SOCKET_PATH: Path to OpenTasks daemon socket (auto-discovered if not set)
 *
 * @returns Task configuration
 */
export function loadTaskConfigFromEnv(): TaskConfig {
  const backendType = process.env.MACRO_TASK_BACKEND ?? "memory";

  if (backendType === "opentasks") {
    const socketPath = process.env.OPENTASKS_SOCKET_PATH;

    return {
      backend: {
        type: "opentasks",
        socketPath,
      },
    };
  }

  return {
    backend: { type: "memory" },
  };
}

/**
 * Load task configuration from a merged MultiagentConfig.
 *
 * Use this instead of loadTaskConfigFromEnv() when you have
 * a merged config from the layered config system.
 *
 * @param config - Merged config with task settings already resolved
 * @returns Task configuration
 */
export function loadTaskConfigFromMerged(config: {
  task?: { backend?: string; opentasks?: { socket_path?: string } };
}): TaskConfig {
  const backendType = config.task?.backend ?? "memory";

  if (backendType === "opentasks") {
    return {
      backend: {
        type: "opentasks",
        socketPath: config.task?.opentasks?.socket_path,
      },
    };
  }

  return {
    backend: { type: "memory" },
  };
}

/**
 * Default task configuration (in-memory backend)
 */
export { DEFAULT_TASK_CONFIG, DEFAULT_OPENTASKS_CONFIG };
