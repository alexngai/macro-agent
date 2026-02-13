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
  InMemoryTaskToolProvider,
  createTaskToolProvider,
} from "./tool-provider.js";

export type { TaskToolContext, GetToolContext } from "./tool-provider.js";

// =============================================================================
// Sudocode Backend (re-export)
// =============================================================================

export {
  SudocodeTaskBackend,
  SudocodeTaskBackendError,
  createSudocodeTaskBackend,
  createSudocodeClient,
  SudocodeTaskToolProvider,
  createSudocodeTaskToolProvider,
} from "./sudocode/index.js";

export type {
  SudocodeClient,
  SudocodeClientConfig,
  SudocodeClientMode,
  SudocodeToolContext,
  GetSudocodeToolContext,
} from "./sudocode/index.js";

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
import type { TaskBackend, TaskConfig, TaskBackendConfig, TaskToolMode, TaskToolProvider } from "./types.js";
import { DEFAULT_TASK_CONFIG, DEFAULT_SUDOCODE_CONFIG, DEFAULT_OPENTASKS_CONFIG } from "./types.js";
import { InMemoryTaskBackend } from "./memory.js";
import { InMemoryTaskToolProvider } from "./tool-provider.js";

/**
 * Result of creating a task backend with its tool provider
 */
export interface TaskBackendResult {
  /** The task backend instance */
  backend: TaskBackend;

  /** The tool provider for this backend (if any) */
  toolProvider?: TaskToolProvider;

  /** The effective tool mode */
  toolMode: TaskToolMode;
}

/**
 * Create a task backend based on configuration
 *
 * @param config - Task configuration
 * @param eventStore - Event store for state management
 * @returns Backend result with backend instance and tool provider
 *
 * @example
 * ```typescript
 * // Create in-memory backend (default)
 * const { backend, toolProvider } = await createTaskBackend(
 *   { backend: { type: 'memory' } },
 *   eventStore
 * );
 *
 * // Create sudocode backend
 * const { backend, toolProvider } = await createTaskBackend(
 *   {
 *     backend: {
 *       type: 'sudocode',
 *       projectPath: '/path/to/project',
 *     },
 *     toolMode: 'native',
 *   },
 *   eventStore
 * );
 * ```
 */
export async function createTaskBackend(
  config: TaskConfig,
  eventStore: EventStore
): Promise<TaskBackendResult> {
  const { backend: backendConfig, toolMode = "auto" } = config;

  if (backendConfig.type === "memory") {
    const backend = new InMemoryTaskBackend(eventStore);
    const effectiveMode = toolMode === "auto" ? "abstract" : toolMode;

    // For in-memory backend, we use the abstract tool provider
    // Note: Tool provider is created separately in MCP server with context
    return {
      backend,
      toolMode: effectiveMode,
    };
  }

  if (backendConfig.type === "sudocode") {
    // Dynamic import to avoid loading sudocode dependencies if not needed
    const { createSudocodeClient } = await import("./sudocode/client.js");
    const { SudocodeTaskBackend } = await import("./sudocode/backend.js");
    const { SudocodeTaskToolProvider } = await import("./sudocode/tools.js");

    // Merge with defaults
    const sudocodeConfig = {
      ...DEFAULT_SUDOCODE_CONFIG,
      ...backendConfig,
    };

    // Create sudocode client
    const client = await createSudocodeClient({
      mode: "auto",
      projectPath: sudocodeConfig.projectPath,
    });

    // Create backend
    const backend = new SudocodeTaskBackend(eventStore, client, sudocodeConfig);

    // Determine effective tool mode
    // Sudocode uses 'mapped' internally but we expose it as 'abstract' in TaskToolMode
    const backendToolMode = sudocodeConfig.toolMode ?? "mapped";

    // Map sudocode tool modes to TaskToolMode
    const mapSudocodeMode = (mode: "native" | "mapped" | "both"): TaskToolMode => {
      if (mode === "mapped") return "abstract";
      return mode; // 'native' and 'both' are same in both systems
    };

    // Determine the effective TaskToolMode
    let effectiveMode: TaskToolMode;
    if (toolMode === "auto") {
      effectiveMode = mapSudocodeMode(backendToolMode);
    } else if (toolMode === "abstract" || toolMode === "native" || toolMode === "both") {
      effectiveMode = toolMode;
    } else {
      // 'auto' falls back to backend default
      effectiveMode = mapSudocodeMode(backendToolMode);
    }

    return {
      backend,
      toolMode: effectiveMode,
    };
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
    const client = await createOpenTasksClient({
      socketPath: openTasksConfig.socketPath,
    });

    // Create backend
    const backend = new OpenTasksTaskBackend(eventStore, client, {
      socketPath: openTasksConfig.socketPath,
      syncStatus: openTasksConfig.syncStatus,
      sourceLabel: openTasksConfig.sourceLabel,
    });

    // OpenTasks uses abstract tools (same as in-memory)
    const effectiveMode = toolMode === "auto" ? "abstract" : toolMode;

    return {
      backend,
      toolMode: effectiveMode,
    };
  }

  throw new Error(`Unknown backend type: ${(backendConfig as TaskBackendConfig).type}`);
}

/**
 * Load task configuration from environment variables
 *
 * Environment variables:
 * - MACRO_TASK_BACKEND: 'memory' | 'sudocode' | 'opentasks' (default: 'memory')
 * - MACRO_TASK_TOOL_MODE: 'abstract' | 'native' | 'both' | 'auto' (default: 'auto')
 * - SUDOCODE_PROJECT_PATH: Path to sudocode project (default: cwd)
 * - SUDOCODE_TOOL_MODE: 'native' | 'mapped' | 'both' (default: 'mapped')
 * - OPENTASKS_SOCKET_PATH: Path to OpenTasks daemon socket (auto-discovered if not set)
 *
 * @returns Task configuration
 */
export function loadTaskConfigFromEnv(): TaskConfig {
  const backendType = process.env.MACRO_TASK_BACKEND ?? "memory";
  const toolMode = (process.env.MACRO_TASK_TOOL_MODE ?? "auto") as TaskToolMode;

  if (backendType === "sudocode") {
    const projectPath = process.env.SUDOCODE_PROJECT_PATH ?? process.cwd();
    const sudocodeToolMode = process.env.SUDOCODE_TOOL_MODE as
      | "native"
      | "mapped"
      | "both"
      | undefined;

    return {
      backend: {
        type: "sudocode",
        projectPath,
        toolMode: sudocodeToolMode ?? "mapped",
      },
      toolMode,
    };
  }

  if (backendType === "opentasks") {
    const socketPath = process.env.OPENTASKS_SOCKET_PATH;

    return {
      backend: {
        type: "opentasks",
        socketPath,
      },
      toolMode,
    };
  }

  return {
    backend: { type: "memory" },
    toolMode,
  };
}

/**
 * Default task configuration (in-memory backend)
 */
export { DEFAULT_TASK_CONFIG, DEFAULT_SUDOCODE_CONFIG, DEFAULT_OPENTASKS_CONFIG };
