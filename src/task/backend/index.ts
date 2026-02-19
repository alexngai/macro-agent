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
import { OpenTasksTaskBackend } from "./opentasks/backend.js";
import { createOpenTasksClient } from "./opentasks/client.js";
import { DaemonManager } from "./opentasks/daemon-manager.js";

/**
 * Result of creating a task backend
 */
export interface TaskBackendResult {
  /** The task backend instance */
  backend: TaskBackend;

  /** OpenTasks client (if opentasks backend is used) */
  openTasksClient?: OpenTasksClient;

  /** Runtime socket path of the daemon (for propagating to child agents) */
  socketPath?: string;

  /** Shutdown function — stops daemon if we started it, disconnects client */
  shutdown?: () => Promise<void>;

  /** Connect a project's .opentasks/ directory to the central daemon (Phase 2) */
  connectProject?: (projectPath: string) => Promise<void>;

  /** Get list of connected project .opentasks/ paths */
  getConnectedProjects?: () => string[];
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
    // Merge with defaults
    const openTasksConfig = {
      ...DEFAULT_OPENTASKS_CONFIG,
      ...backendConfig,
    };

    // Determine how to get the OpenTasks client:
    // 1. If socketPath is explicitly provided, connect directly (legacy / child agent mode)
    // 2. If autoStart is enabled (default), use DaemonManager to auto-start central daemon
    // 3. Otherwise, try to connect without auto-start

    let openTasksClient: OpenTasksClient;
    let resolvedSocketPath: string | undefined;
    let shutdownFn: (() => Promise<void>) | undefined;
    let daemonManager: DaemonManager | undefined;

    if (openTasksConfig.socketPath) {
      // Direct connection to a known socket (e.g., child agent with inherited socket path)
      openTasksClient = await createOpenTasksClient({
        socketPath: openTasksConfig.socketPath,
      });
      resolvedSocketPath = openTasksConfig.socketPath;
      shutdownFn = async () => {
        openTasksClient.disconnect();
      };
    } else if (openTasksConfig.autoStart !== false) {
      // Auto-start daemon via DaemonManager (default behavior)
      daemonManager = new DaemonManager({
        centralPath: openTasksConfig.centralPath,
        connectOnSpawn: openTasksConfig.connectOnSpawn,
      });

      const result = await daemonManager.ensureDaemon();
      openTasksClient = result.client;
      resolvedSocketPath = result.socketPath;
      shutdownFn = () => daemonManager!.shutdown();
    } else {
      // Auto-start disabled, no socket path — try default socket discovery
      openTasksClient = await createOpenTasksClient();
      shutdownFn = async () => {
        openTasksClient.disconnect();
      };
    }

    // Create backend
    const backend = new OpenTasksTaskBackend(eventStore, openTasksClient, {
      socketPath: openTasksConfig.socketPath,
      syncStatus: openTasksConfig.syncStatus,
      sourceLabel: openTasksConfig.sourceLabel,
    });

    // Wrap shutdown to close the backend before disconnecting the client/daemon
    const finalShutdown = async () => {
      if (backend.close) {
        try { await backend.close(); } catch { /* ignore */ }
      }
      if (shutdownFn) await shutdownFn();
    };

    return {
      backend,
      openTasksClient,
      socketPath: resolvedSocketPath,
      shutdown: finalShutdown,
      connectProject: daemonManager
        ? (projectPath: string) => daemonManager.connectProject(projectPath)
        : undefined,
      getConnectedProjects: daemonManager
        ? () => daemonManager.getConnectedProjects()
        : undefined,
    };
  }

  throw new Error(
    `Unknown backend type: ${(backendConfig as TaskBackendConfig).type}`
  );
}

/**
 * Load task configuration from environment variables
 *
 * Environment variables:
 * - MACRO_TASK_BACKEND: 'memory' | 'opentasks' (default: 'opentasks')
 * - OPENTASKS_SOCKET_PATH: Path to OpenTasks daemon socket (auto-discovered if not set)
 *
 * @returns Task configuration
 */
export function loadTaskConfigFromEnv(): TaskConfig {
  const backendType = process.env.MACRO_TASK_BACKEND ?? "opentasks";

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
  task?: {
    backend?: string;
    opentasks?: {
      socket_path?: string;
      auto_start?: boolean;
      central_path?: string;
      connect_on_spawn?: boolean;
    };
  };
}): TaskConfig {
  const backendType = config.task?.backend ?? "opentasks";

  if (backendType === "opentasks") {
    return {
      backend: {
        type: "opentasks",
        socketPath: config.task?.opentasks?.socket_path,
        autoStart: config.task?.opentasks?.auto_start,
        centralPath: config.task?.opentasks?.central_path,
        connectOnSpawn: config.task?.opentasks?.connect_on_spawn,
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
