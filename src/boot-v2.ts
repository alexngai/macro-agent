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

  /** Task dispatch config — opt-in autonomous task dispatch mode */
  dispatch?: {
    enabled?: boolean;
    pollIntervalMs?: number;
    maxConcurrent?: number;
    defaultRole?: string;
    tags?: string[];
    maxRetries?: number;
    retryBaseDelayMs?: number;
    retryMaxDelayMs?: number;
    reconcile?: { enabled?: boolean; intervalMs?: number; stallTimeoutMs?: number };
    eligibility?: import("swarm-dispatch").EligibilityConfig;
    /** Dispatch mode: route-only, spawn-only, prefer-route, prefer-spawn. Default: prefer-route when inbox available, spawn-only otherwise. */
    dispatchMode?: import("swarm-dispatch").DispatchMode;
    /** Enable mail-based work routing via agent-inbox (default: true when dispatch enabled). */
    enableMailRouting?: boolean;
    /** Enable roster-based agent discovery for route-first dispatch (default: true when dispatch enabled). */
    enableRoster?: boolean;
    /** Continuation config. */
    continuation?: { delayMs?: number; maxTurns?: number };
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

  /** Task dispatcher (if dispatch mode enabled) */
  taskDispatcher?: import("swarm-dispatch").TaskDispatcher;

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

  // 7a. Task Dispatch (opt-in autonomous task dispatch mode)
  let taskDispatcher: import("swarm-dispatch").TaskDispatcher | null = null;

  if (config.dispatch?.enabled && tasksAdapter) {
    const {
      createOrchestrator,
      createOpenTasksSource,
      createAgentInboxPort,
    } = await import("swarm-dispatch");
    const { getStableInstanceId } = await import("./cli/stable-instance-id.js");

    const claimantId = `${os.hostname()}:${process.pid}:${getStableInstanceId(cwd)}`;
    const dispatchAgentId = `dispatcher:${claimantId}`;

    // Adapt opentasks client → DispatchTaskSource
    const opentasksClient = (tasksAdapter as any).client;
    const source = opentasksClient
      ? createOpenTasksSource(opentasksClient)
      : {
          // Fallback adapter when opentasks client is available via TasksAdapter methods
          queryReady: async (opts?: { tags?: string[]; limit?: number }) =>
            tasksAdapter.queryReady(opts),
          claim: async (taskId: string, claimantIdArg: string) => {
            try {
              await tasksAdapter.assignTask(taskId, claimantIdArg);
              return { success: true as const };
            } catch {
              return { success: false as const };
            }
          },
          release: async (taskId: string) => tasksAdapter.unclaimTask(taskId),
          transition: async (taskId: string, action: "start" | "complete" | "fail") =>
            tasksAdapter.transitionTask(taskId, action),
          getTask: async (taskId: string) => tasksAdapter.getTask(taskId),
          listInProgress: async () => tasksAdapter.listTasks({ status: "in_progress" }),
        };

    // Adapt AgentManagerV2 → DispatchAgentRuntime
    const runtime: import("swarm-dispatch").DispatchAgentRuntime = {
      spawn: async (opts: { prompt: string; taskId: string; role: string }) => {
        const spawned = await agentManager.spawn({
          task: opts.prompt,
          task_id: opts.taskId,
          role: opts.role,
          parent: null,
        });
        return { id: spawned.id };
      },
      terminate: async (agentId: string, reason?: string) => {
        await agentManager.terminate(agentId, (reason ?? "cancelled") as any);
      },
      onStopped: (callback: (agentId: string, reason: string) => void) =>
        agentManager.onLifecycleEvent((event) => {
          if (event.type === "stopped") {
            callback(event.agent.id, event.reason);
          }
        }),
    };

    // Phase 2: Wire MessagePort via agent-inbox for mail-based work routing
    let messagePort: import("swarm-dispatch").MessagePort | undefined;
    if (config.dispatch.enableMailRouting !== false) {
      const inbox = inboxAdapter.getInbox();
      messagePort = createAgentInboxPort(
        inbox.router as any,
        inbox.events as any,
        {
          dispatcherAgentId: dispatchAgentId,
          classifyMessage: (msg: any) => {
            // Classify inbox messages as dispatchable work when they carry
            // the x-dispatch/work schema. Other messages are ignored.
            const content = msg.content as { type?: string; schema?: string; data?: any };
            if (content?.schema !== "x-dispatch/work") return null;
            const data = content.data;
            if (!data?.taskId) return null;
            return {
              messageId: msg.id,
              correlationId: msg.thread_tag ?? msg.id,
              replyTo: msg.sender_id ? { agentId: msg.sender_id } : undefined,
              task: {
                id: data.taskId,
                title: data.title ?? `Delegated: ${data.taskId}`,
                status: "open",
                content: data.prompt ?? data.content,
                tags: data.tags,
                metadata: {
                  ...data.metadata,
                  role: data.role,
                },
              },
            };
          },
        }
      );

      // Register the dispatcher as an agent in the inbox so it can receive messages
      await inboxAdapter.registerAgent(dispatchAgentId, {
        role: "dispatcher",
        scope: "default",
      });
    }

    // Phase 2: Wire AgentRoster via inbox agent listing for route-first dispatch
    let roster: import("swarm-dispatch").AgentRoster | undefined;
    if (config.dispatch.enableRoster !== false) {
      const inbox = inboxAdapter.getInbox();
      roster = {
        async findAvailable(criteria) {
          // List agents from inbox storage, filter by role and idle state
          const agents = inbox.storage.listAgents();
          return agents
            .filter((a: any) => {
              if (a.agentId === dispatchAgentId) return false;
              if (criteria.role && a.role && a.role !== criteria.role) return false;
              if (criteria.notBusy && a.status === "busy") return false;
              return true;
            })
            .map((a: any) => ({
              agentId: a.agentId ?? a.agent_id ?? a.id,
              host: a.host,
            }));
        },
      };
    }

    // Determine dispatch mode
    const hasRouting = !!messagePort && !!roster;
    const dispatchMode = config.dispatch.dispatchMode
      ?? (hasRouting ? "prefer-route" as const : "spawn-only" as const);

    taskDispatcher = createOrchestrator(source, runtime, {
      claimantId,
      pollIntervalMs: config.dispatch.pollIntervalMs ?? 15_000,
      defaultRole: config.dispatch.defaultRole ?? "worker",
      concurrency: { global: config.dispatch.maxConcurrent ?? 3 },
      retry: {
        maxRetries: config.dispatch.maxRetries ?? 3,
        baseDelayMs: config.dispatch.retryBaseDelayMs ?? 10_000,
        maxDelayMs: config.dispatch.retryMaxDelayMs ?? 300_000,
      },
      eligibility: config.dispatch.eligibility,
      tags: config.dispatch.tags,
      reconcile: {
        enabled: config.dispatch.reconcile?.enabled ?? true,
        intervalMs: config.dispatch.reconcile?.intervalMs ?? 60_000,
        stallTimeoutMs: config.dispatch.reconcile?.stallTimeoutMs,
      },
      ...(config.dispatch.continuation && {
        continuation: {
          delayMs: config.dispatch.continuation.delayMs ?? 1_000,
          maxTurns: config.dispatch.continuation.maxTurns ?? 20,
        },
      }),
      messagePort,
      roster,
      dispatchMode,
    });

    await taskDispatcher.start();
  }

  // 7b. Control Server (lifecycle RPC for MCP subprocesses)
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

  // 9. REST API server (optional)
  let apiServer: ApiServer | null = null;
  if (config.api?.enabled) {
    const { createApiServer } = await import("./api/server.js");
    // Build a partial system reference for the API server.
    // The full system object is returned below; we create the API server
    // first so it can be included in the return value and shut down cleanly.
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
      // Pass a partial system ref (the full object is built below)
      {
        agentManager,
        agentStore,
        inboxAdapter,
        tasksAdapter,
        triggerSystem,
        controlServer,
        roleRegistry,
        controlSocketPath,
      } as any,
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
          // Pass partial system ref for ACP-over-MAP bridge
          system: {
            agentManager,
            agentStore,
            inboxAdapter,
            tasksAdapter,
            triggerSystem,
            controlServer,
            roleRegistry,
            controlSocketPath,
          } as any,
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
          trajectorySyncLevel: config.map.trajectorySyncLevel,
          reconnectIntervalMs: config.map.reconnectIntervalMs,
          reconnection: config.map.reconnection,
          mesh: config.mesh?.enabled ? config.mesh : undefined,
        },
      );
      await mapSidecar.start();
      // Wire sidecar into agent manager for session-end checkpoints
      agentManager.setSidecar(mapSidecar);

      // Bridge dispatch events to MAP for observability
      if (taskDispatcher && mapSidecar.emitEvent) {
        taskDispatcher.onEvent((event) => {
          mapSidecar!.emitEvent!({
            type: `dispatch.${event.type}`,
            ...event,
          });
        });
      }
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
    ...(taskDispatcher ? { taskDispatcher } : {}),
    ...(apiServer ? { apiServer } : {}),
    ...(acpServer ? { acpServer } : {}),
    ...(mapServerInstance ? { mapServerInstance } : {}),
    ...(mapSidecar ? { mapSidecar } : {}),
    _sessionlogSyncLevel: config.sessionlog?.sync ?? config.map?.trajectorySyncLevel ?? "full",

    async shutdown(): Promise<void> {
      clearInterval(healthCheckTimer);
      if (taskDispatcher) await taskDispatcher.stop();
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
