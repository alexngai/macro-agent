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
import type { ApiServer } from "./api/types.js";
import type { WebSocketACPServer } from "./acp/websocket-server.js";

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

  /** REST API server config */
  api?: { enabled?: boolean; port?: number; host?: string };

  /** ACP WebSocket server config */
  acp?: { enabled?: boolean; port?: number; host?: string; path?: string };

  /** Federation config for cross-instance communication */
  federation?: {
    systemId: string;
    peers?: Array<{ systemId: string; url?: string; meshPeerId?: string }>;
    trust?: { allowedSystems?: string[] };
  };

  /** MAP server config (accept inbound connections from TUI/clients) */
  mapServer?: { enabled?: boolean; port?: number; host?: string; path?: string; name?: string };

  /** MAP sidecar config (connect to OpenHive hub) */
  map?: {
    enabled?: boolean;
    server?: string;
    token?: string;
    scope?: string;
    systemId?: string;
    credential?: string;
    agentName?: string;
    swarmId?: string;
    trajectorySyncLevel?: "off" | "lifecycle" | "metrics" | "full";
    reconnectIntervalMs?: number;
    reconnection?: {
      enabled?: boolean;
      maxRetries?: number;
      baseDelayMs?: number;
      maxDelayMs?: number;
    };
  };

  /** minimem (agent memory) — registers as MCP server for all agents */
  minimem?: {
    enabled?: boolean;
    dir?: string;          // default: ".swarm/minimem/"
    provider?: string;     // "auto" | "openai" | "gemini" | "local"
    global?: boolean;      // also search ~/.minimem
  };

  /** skill-tree (per-role skills) — compiles loadouts at team start, injects into prompts */
  skilltree?: {
    enabled?: boolean;
    basePath?: string;     // default: ".swarm/skill-tree/"
    defaultProfile?: string;
  };

  /** sessionlog — enriches trajectory checkpoints with session state data */
  sessionlog?: {
    enabled?: boolean;
    sync?: "off" | "lifecycle" | "metrics" | "full";
  };

  /** agentic-mesh — P2P encrypted transport for MAP sidecar */
  mesh?: {
    enabled?: boolean;
    peerId?: string;
  };
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

  /** REST API server (if enabled) */
  apiServer?: ApiServer;

  /** ACP WebSocket server (if enabled) */
  acpServer?: WebSocketACPServer;

  /** MAP server for inbound connections (if enabled) */
  mapServerInstance?: import("./map/types.js").MAPServerInstance;

  /** MAP sidecar for outbound hub connection (if enabled) */
  mapSidecar?: import("./map/types.js").MAPSidecar;

  /** Sessionlog sync level for trajectory checkpoint gating */
  _sessionlogSyncLevel?: string;

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
    // Pass federation config if provided
    ...(config.federation && {
      federation: {
        systemId: config.federation.systemId,
        peers: config.federation.peers,
        trust: config.federation.trust
          ? { allowedServers: config.federation.trust.allowedSystems }
          : undefined,
      },
    }),
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

  // 6. Federation (cross-instance communication)
  let federationCleanup: (() => void) | null = null;
  if (config.federation) {
    const { setupFederation } = await import("./adapters/federation.js");
    federationCleanup = setupFederation(agentManager, inboxAdapter, config.federation);
  }

  // 7. Trigger System V2
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

  // 8. Health check escalation loop
  //    Periodically check for unhealthy agents (stale MCP heartbeats)
  //    and notify their parents via inbox.
  const HEALTH_CHECK_INTERVAL_MS = 30_000;
  const UNHEALTHY_THRESHOLD_MS = 60_000;

  const healthCheckTimer = setInterval(async () => {
    try {
      const unhealthy = controlServer.getUnhealthyAgents(UNHEALTHY_THRESHOLD_MS);
      for (const { agentId, lastSeen } of unhealthy) {
        const agent = agentStore.getAgent(agentId);
        if (!agent || agent.state !== "running") continue;

        // Notify parent (if any) that this agent's MCP subprocess may be stale
        if (agent.parent_id) {
          try {
            await inboxAdapter.send(
              "system",
              agent.parent_id,
              {
                type: "event",
                event: "STALE_AGENT",
                data: {
                  agentId,
                  role: agent.role,
                  lastSeen,
                  staleSinceMs: Date.now() - lastSeen,
                },
              },
              { importance: "high", threadTag: `health:${agentId}` }
            );
          } catch {
            // Best effort notification
          }
        }
      }
    } catch {
      // Best effort health check
    }
  }, HEALTH_CHECK_INTERVAL_MS);
  healthCheckTimer.unref(); // Don't prevent process exit

  // Shared mutable system reference — passed to ACP server, MAP server, API server.
  // Components created before the sidecar (steps 9-11) receive this object.
  // When the sidecar is created (step 13), it's attached here so all components
  // see it via the same reference (e.g., ACP handler accessing system.mapSidecar).
  const systemRef = {
    agentManager,
    agentStore,
    inboxAdapter,
    tasksAdapter,
    triggerSystem,
    controlServer,
    roleRegistry,
    controlSocketPath,
  } as any;

  // 9. REST API server (optional)
  let apiServer: ApiServer | null = null;
  if (config.api?.enabled) {
    const { createApiServer } = await import("./api/server.js");
    apiServer = createApiServer(systemRef, {
      port: config.api.port,
      host: config.api.host,
    });
    await apiServer.start();
  }

  // 10. ACP WebSocket server (optional)
  let acpServer: WebSocketACPServer | null = null;
  if (config.acp?.enabled) {
    const { createWebSocketACPServer } = await import("./acp/websocket-server.js");
    acpServer = createWebSocketACPServer(
      systemRef,
      {
        port: config.acp.port,
        host: config.acp.host,
        path: config.acp.path,
      },
    );
    await acpServer.start();
  }

  // 11. MAP Server (optional — accept inbound connections from TUI/clients)
  let mapServerInstance: import("./map/types.js").MAPServerInstance | null = null;
  if (config.mapServer?.enabled) {
    try {
      const { createMAPServerInstance } = await import("./map/server.js");
      mapServerInstance = createMAPServerInstance(
        {
          agentManager,
          agentStore,
          inboxAdapter,
          tasksAdapter,
          system: systemRef,
        },
        {
          port: config.mapServer.port,
          host: config.mapServer.host,
          path: config.mapServer.path,
          name: config.mapServer.name,
        },
      );
      await mapServerInstance.start();

      // Tell AgentManager the MAP server URL so spawned agents' cc-swarm
      // hooks connect to this local server instead of an external hub.
      agentManager.setMapServerUrl(mapServerInstance.getUrl());
    } catch (err) {
      console.warn(
        `[boot-v2] MAP server failed to start: ${(err as Error).message}`,
      );
    }
  }

  // 12. Swarmkit integrations (minimem, skill-tree, sessionlog)
  agentManager.setIntegrationConfigs({
    minimem: config.minimem?.enabled ? config.minimem as any : undefined,
    skilltree: config.skilltree?.enabled ? config.skilltree as any : undefined,
    sessionlog: config.sessionlog?.enabled ? config.sessionlog as any : undefined,
  });

  // 12b. Skill-tree loadout compilation (if enabled)
  if (config.skilltree?.enabled) {
    try {
      const { compileAllRoleLoadouts } = await import("./integrations/skilltree.js");
      // Gather roles from the role registry
      const registeredRoles = roleRegistry.listRoles();
      const roleNames = registeredRoles.map((r) => r.name);
      if (roleNames.length > 0) {
        const loadouts = await compileAllRoleLoadouts(
          roleNames.filter(Boolean),
          config.skilltree,
        );
        for (const [role, content] of loadouts) {
          agentManager.setSkillLoadout(role, content);
        }
      }
    } catch {
      // skill-tree not available — non-fatal
    }
  }

  // 13. MAP Sidecar (optional — connect to OpenHive hub)
  let mapSidecar: import("./map/types.js").MAPSidecar | null = null;
  if (config.map?.enabled && config.map.server) {
    try {
      const { createMAPSidecar } = await import("./map/sidecar.js");
      mapSidecar = createMAPSidecar(
        { agentManager, agentStore, inboxAdapter, tasksAdapter },
        {
          server: config.map.server,
          token: config.map.token,
          scope: config.map.scope,
          systemId: config.map.systemId,
          credential: config.map.credential,
          agentName: config.map.agentName,
          swarmId: config.map.swarmId,
          trajectorySyncLevel: config.map.trajectorySyncLevel,
          reconnectIntervalMs: config.map.reconnectIntervalMs,
          reconnection: config.map.reconnection,
          mesh: config.mesh?.enabled ? config.mesh : undefined,
        },
      );
      await mapSidecar.start();
      // Wire sidecar into agent manager for session-end checkpoints
      agentManager.setSidecar(mapSidecar);
      // Attach to shared system ref so ACP/MAP handlers can access it
      systemRef.mapSidecar = mapSidecar;
    } catch (err) {
      // Non-fatal — MAP hub connectivity is optional
      console.warn(
        `[boot-v2] MAP sidecar failed to start: ${(err as Error).message}`,
      );
    }
  }

  // 13. Return system handle
  return {
    agentManager,
    agentStore,
    inboxAdapter,
    tasksAdapter,
    triggerSystem,
    controlServer,
    roleRegistry,
    controlSocketPath,
    ...(apiServer ? { apiServer } : {}),
    ...(acpServer ? { acpServer } : {}),
    ...(mapServerInstance ? { mapServerInstance } : {}),
    ...(mapSidecar ? { mapSidecar } : {}),
    _sessionlogSyncLevel: config.sessionlog?.sync ?? config.map?.trajectorySyncLevel ?? "full",

    async shutdown(): Promise<void> {
      clearInterval(healthCheckTimer);
      if (mapSidecar) await mapSidecar.stop();
      if (mapServerInstance) await mapServerInstance.stop();
      if (federationCleanup) federationCleanup();
      if (acpServer) await acpServer.stop();
      if (apiServer) await apiServer.stop();
      await controlServer.stop();
      await triggerSystem.stop();
      await agentManager.close();
      tasksAdapter.disconnect();
      await inboxAdapter.stop();
      agentStore.close();
    },
  };
}
