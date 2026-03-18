/**
 * Boot V2 — Wires all V2 components into a running macro-agent system.
 *
 * This is the single entry point for the restructured architecture:
 * - AgentStore for lifecycle state
 * - InboxAdapter (embedded agent-inbox) for messaging
 * - TasksAdapter (opentasks client) for task management
 * - AgentManagerV2 for agent lifecycle
 * - TeamRuntimeV2 for team topology
 * - TriggerSystemV2 for wake/cron/webhooks
 * - ControlServer for MCP subprocess lifecycle RPC
 * - MCPServerV2 for per-agent tools
 *
 * Usage:
 *   const system = await bootV2({ cwd: process.cwd() });
 *   // system.agentManager, system.inboxAdapter, etc.
 *   await system.shutdown();
 *
 * @module boot-v2
 */

import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import { AgentStore } from "./agent/agent-store.js";
import {
  DefaultInboxAdapter,
  type InboxAdapterConfig,
} from "./adapters/inbox-adapter.js";
import {
  DefaultTasksAdapter,
  type TasksAdapterConfig,
} from "./adapters/tasks-adapter.js";
import { createAgentManagerV2 } from "./agent/agent-manager-v2.js";
import { createTriggerSystemV2 } from "./trigger/trigger-system-v2.js";
import { ControlServer } from "./control/control-server.js";
import type { AgentManager } from "./agent/agent-manager.js";
import type { InboxAdapter, TasksAdapter } from "./adapters/types.js";
import type { TriggerSystemV2 } from "./trigger/trigger-system-v2.js";
import type { RoleRegistry } from "./roles/types.js";
import { DefaultRoleRegistry } from "./roles/registry.js";
import type { WorkspaceManager } from "./workspace/types.js";
import type { PermissionMode } from "acp-factory";

// =============================================================================
// Configuration
// =============================================================================

export interface BootV2Config {
  /** Working directory (default: process.cwd()) */
  cwd?: string;

  /** Base directory for data storage (default: ~/.macro-agent) */
  baseDir?: string;

  /** Default permission mode for spawned agents */
  defaultPermissionMode?: PermissionMode;

  /** Default agent type (default: "claude-code") */
  defaultAgentType?: string;

  /** Role registry (default: DefaultRoleRegistry with built-in roles) */
  roleRegistry?: RoleRegistry;

  /** Workspace manager for git worktree isolation */
  workspaceManager?: WorkspaceManager;

  /** Inbox adapter config overrides */
  inbox?: Partial<InboxAdapterConfig>;

  /** Tasks adapter config overrides */
  tasks?: Partial<TasksAdapterConfig>;

  /** Trigger system config */
  trigger?: {
    enableHeartbeat?: boolean;
    heartbeatIntervalMs?: number;
  };

  /** Server URL for MCP thin-client mode */
  serverUrl?: string;

  /** Server token for thin-client auth */
  serverToken?: string;
}

// =============================================================================
// System Interface
// =============================================================================

export interface MacroAgentSystemV2 {
  /** Agent lifecycle manager */
  agentManager: AgentManager;

  /** Agent lifecycle store */
  agentStore: AgentStore;

  /** Messaging adapter (embedded agent-inbox) */
  inboxAdapter: InboxAdapter;

  /** Task management adapter (opentasks client) */
  tasksAdapter: TasksAdapter;

  /** Trigger system (wake, cron, webhooks) */
  triggerSystem: TriggerSystemV2;

  /** Control server (lifecycle RPC for MCP subprocesses) */
  controlServer: ControlServer;

  /** Role registry */
  roleRegistry: RoleRegistry;

  /** Control socket path (for MCP subprocess connection) */
  controlSocketPath: string;

  /** Shut down all components */
  shutdown(): Promise<void>;
}

// =============================================================================
// Boot Function
// =============================================================================

export async function bootV2(
  config: BootV2Config = {}
): Promise<MacroAgentSystemV2> {
  const cwd = config.cwd ?? process.cwd();
  const baseDir =
    config.baseDir ?? path.join(os.homedir(), ".macro-agent");

  // Ensure base directory exists
  fs.mkdirSync(baseDir, { recursive: true });

  // 1. Agent Store (minimal SQLite)
  const agentStorePath = path.join(baseDir, "agents.db");
  const agentStore = new AgentStore(agentStorePath);

  // 2. Inbox Adapter (embedded agent-inbox, hybrid mode)
  const inboxSocketPath =
    config.inbox?.socketPath ??
    path.join(baseDir, "inbox.sock");
  const inboxSqlitePath = path.join(baseDir, "inbox.db");

  const inboxAdapter = new DefaultInboxAdapter({
    socketPath: inboxSocketPath,
    sqlitePath: inboxSqlitePath,
    defaultScope: "default",
    ...config.inbox,
  });
  await inboxAdapter.initialize();

  // 3. Tasks Adapter (opentasks client, auto-discovers daemon)
  const tasksAdapter = new DefaultTasksAdapter({
    ...config.tasks,
  });
  try {
    await tasksAdapter.connect();
  } catch {
    // opentasks daemon may not be available — non-fatal
    console.warn(
      "[boot-v2] opentasks daemon not available. Task operations will fail until connected."
    );
  }

  // 4. Role Registry
  const roleRegistry = config.roleRegistry ?? new DefaultRoleRegistry();

  // 5. Agent Manager V2
  const controlSocketPath = path.join(baseDir, "control.sock");
  const agentManager = createAgentManagerV2(
    agentStore,
    inboxAdapter,
    tasksAdapter,
    {
      defaultPermissionMode: config.defaultPermissionMode ?? "auto-approve",
      defaultAgentType: config.defaultAgentType ?? "claude-code",
      defaultCwd: cwd,
      roleRegistry,
      workspaceManager: config.workspaceManager,
      serverUrl: config.serverUrl,
      serverToken: config.serverToken,
      controlSocketPath,
    }
  );

  // 6. Trigger System V2
  const triggerSystem = createTriggerSystemV2(
    {
      agentManager,
      agentStore,
      inboxAdapter,
    },
    {
      wake: {
        enableHeartbeat: config.trigger?.enableHeartbeat ?? false,
        heartbeatIntervalMs: config.trigger?.heartbeatIntervalMs,
      },
    }
  );
  await triggerSystem.start();

  // 7. Control Server (lifecycle RPC for MCP subprocesses)
  const controlServer = new ControlServer(agentManager, {
    socketPath: controlSocketPath,
  });
  await controlServer.start();

  // 8. Return system handle
  return {
    agentManager,
    agentStore,
    inboxAdapter,
    tasksAdapter,
    triggerSystem,
    controlServer,
    roleRegistry,
    controlSocketPath,

    async shutdown(): Promise<void> {
      await controlServer.stop();
      await triggerSystem.stop();
      await agentManager.close();
      tasksAdapter.disconnect();
      await inboxAdapter.stop();
      agentStore.close();
    },
  };
}
