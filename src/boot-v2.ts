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
import * as crypto from "crypto";
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

  /**
   * Stable identifier for this macro-agent run. Controls the default on-disk
   * layout at `~/.macro-agent/<instanceId>/` (agents.db, inbox.db, sockets).
   *
   * Precedence when choosing an id:
   *   1. explicit `instanceId` (this field)
   *   2. `map.swarmId` (the MAP identity, when provided)
   *   3. `inst_<sha256(cwd)[:12]>` (stable per-project fallback)
   *
   * Explicit `baseDir` overrides all of the above. Hosts that manage their
   * own storage layout (openswarm spawns hosted swarms with a unique
   * per-spawn data dir) still win by setting `baseDir` directly.
   */
  instanceId?: string;

  /** Base directory for data storage. Default: `~/.macro-agent/<instanceId>/` */
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
  mapServer?: {
    enabled?: boolean;
    port?: number;
    host?: string;
    path?: string;
    name?: string;
  };

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

  /**
   * Cascade event binding config. Controls how cascade events emitted by
   * git-cascade-backed agents get tagged with external task references for
   * hub projection (changelog, task↔stream binding). Independent of MAP
   * transport: cascade events are data/identity, not transport.
   */
  cascade?: {
    /**
     * Default OpenTasks resource ID for this swarm. When set, the agent
     * manager auto-builds `taskRef = { resource_id, node_id: task_id }`
     * for spawned agents so cascade events carry the binding without
     * callers constructing refs by hand.
     *
     * Leave undefined if:
     *   - The swarm touches multiple opentasks graphs (use `resolveTaskRef`).
     *   - Every caller sets `SpawnAgentOptions.taskRef` explicitly.
     *   - You don't care about hub task↔stream binding.
     */
    taskResourceId?: string;

    /**
     * Custom resolver for multi-graph deployments. Called at every spawn;
     * return a `TaskRef` to set the binding or `undefined` to skip.
     * Precedence: explicit `SpawnAgentOptions.taskRef` > `resolveTaskRef` >
     * `taskResourceId` fallback (combined with `spawnOptions.task_id`).
     *
     * Keep implementations cheap — this runs on every spawn.
     *
     * @example
     *   resolveTaskRef: (opts) => {
     *     const graph = graphForCwd(opts.cwd ?? process.cwd());
     *     return graph ? { resource_id: graph.resourceId, node_id: String(opts.task_id) } : undefined;
     *   }
     */
    resolveTaskRef?: (
      spawnOptions: import("./agent/types.js").SpawnAgentOptions,
    ) => import("git-cascade/events").TaskRef | undefined;

    /**
     * Override the default `x-cascade` event prefix. Useful for branded
     * deployments or isolating cascade namespaces in testing. Affects all
     * events emitted by the tracker embedded in this swarm.
     */
    eventPrefix?: string;
  };

  /** minimem (agent memory) — registers as MCP server for all agents */
  minimem?: {
    enabled?: boolean;
    dir?: string; // default: ".swarm/minimem/"
    provider?: string; // "auto" | "openai" | "gemini" | "local"
    global?: boolean; // also search ~/.minimem
  };

  /** skill-tree (per-role skills) — compiles loadouts at team start, injects into prompts */
  skilltree?: {
    enabled?: boolean;
    basePath?: string; // default: ".swarm/skill-tree/"
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
    reconcile?: {
      enabled?: boolean;
      intervalMs?: number;
      stallTimeoutMs?: number;
    };
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

  /**
   * Boot-time agents to spawn after AgentManager is ready.
   *
   * Currently supports `coordinator` — when set, fires a non-blocking
   * `agentManager.spawn({ role: 'coordinator', parent: null, cwd, ... })`
   * during boot so the swarm has a default head manager ready for chat
   * without an explicit spawn call. Pass `true` for defaults (uses the
   * boot config's cwd) or an object for fine control.
   *
   * Also driven by env var `MACRO_BOOTSTRAP_COORDINATOR=true` (with
   * optional `MACRO_BOOTSTRAP_CWD=<path>`) when this field is unset —
   * lets indirect callers (e.g. openswarm host) opt in without modifying
   * the bootConfig pass-through whitelist.
   */
  bootstrap?: {
    coordinator?: boolean | {
      cwd?: string;
      permissionMode?: PermissionMode;
      agentType?: string;
      customPrompt?: string;
      task?: string;
    };
    /**
     * Optional parented worker spawn after the bootstrap coordinator
     * comes up. Used by live tests (e.g., `live-mail-reuse-dispatch`)
     * to provide a parented dispatch target that survives mail+reuse
     * `done()` cleanly (the worker terminates as designed; the parent
     * coord receives the `WORKER_DONE` signal — no orphan).
     *
     * Default `role`: `'reuse-target'`. Choose a role that does NOT
     * collide with the sidecar's projected `'worker'` role in the
     * hub-side roster — otherwise prefer-route may tie-break to the
     * sidecar instead of this worker.
     */
    worker?: boolean | {
      role?: string;
      task?: string;
    };
    /**
     * Rehydration policy for agents that existed before this boot. Controls
     * what the boot script does with agents that outlived their previous
     * host process (agent-store is durable; a restart finds agents still
     * marked `state='running'` but without any live ACP session).
     *
     *   - `'none'` — skip rehydration entirely. Always fall through to fresh
     *     bootstrap spawn (or no spawn if `bootstrap.coordinator` is unset).
     *   - `'coordinators'` (default) — revive only root coordinators for
     *     this cwd. Matches the common openhive case where the workspace
     *     intent is "I want a coordinator here" and workers are ephemeral.
     *   - `'all'` — revive every `state='running'` agent at this cwd
     *     (coordinators plus workers/integrators/monitors). Parent-first
     *     ordering; children are skipped if their parent failed to revive
     *     or is `state='stopped'` (deliberately down).
     *
     * Hosted swarms pass `'all'` via `MACRO_BOOTSTRAP_REHYDRATE=all` so a
     * restart restores the full macro-agent team, not just head managers.
     */
    rehydrate?: "none" | "coordinators" | "all";
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
  config: BootV2Config = {},
): Promise<MacroAgentSystemV2> {
  const cwd = config.cwd ?? process.cwd();
  // Resolve the instance id with three-tier precedence so the on-disk layout
  // stays meaningful across standalone, MAP-connected, and hosted runs:
  //
  //   1. Explicit `instanceId` — caller-chosen, human-readable.
  //   2. `map.swarmId` — the MAP identity when the caller has pre-registered
  //      one. This ties macro-agent's local store to its hub identity, so a
  //      swarm with swarm_id=X always resumes its own state.
  //   3. A stable hash of the resolved cwd — the last-resort fallback so two
  //      processes in different projects never collide on agents.db, inbox.db,
  //      or the control socket. Reruns in the same project reuse their store.
  //
  // Hosts that manage their own storage layout (e.g. openswarm spawning
  // per-swarm instances under a unique data dir) still win by passing
  // `baseDir` directly. Legacy `~/.macro-agent/*.db` from pre-instancing
  // versions is left alone — new boots start fresh under their own subdir.
  const instanceId =
    config.instanceId
    ?? config.map?.swarmId
    ?? ("inst_" + crypto.createHash("sha256").update(path.resolve(cwd)).digest("hex").slice(0, 12));
  const baseDir = config.baseDir ?? path.join(os.homedir(), ".macro-agent", instanceId);

  // Env-var bridge for hosts that pass through bootConfig with a fixed
  // whitelist (e.g. openswarm). Translates MACRO_BOOTSTRAP_COORDINATOR /
  // MACRO_BOOTSTRAP_CWD / MACRO_BOOTSTRAP_REHYDRATE into the structured
  // bootstrap field if not already set programmatically. Programmatic
  // config wins per field.
  if (
    process.env.MACRO_BOOTSTRAP_COORDINATOR === "true" &&
    !config.bootstrap?.coordinator
  ) {
    const envCwd = process.env.MACRO_BOOTSTRAP_CWD;
    config = {
      ...config,
      bootstrap: {
        ...(config.bootstrap ?? {}),
        coordinator: envCwd ? { cwd: envCwd } : true,
      },
    };
  }
  if (
    process.env.MACRO_BOOTSTRAP_WORKER === "true" &&
    !config.bootstrap?.worker
  ) {
    const envWorkerRole = process.env.MACRO_BOOTSTRAP_WORKER_ROLE;
    config = {
      ...config,
      bootstrap: {
        ...(config.bootstrap ?? {}),
        worker: envWorkerRole ? { role: envWorkerRole } : true,
      },
    };
  }
  const envRehydrate = process.env.MACRO_BOOTSTRAP_REHYDRATE;
  if (
    (envRehydrate === "none" ||
      envRehydrate === "coordinators" ||
      envRehydrate === "all") &&
    config.bootstrap?.rehydrate === undefined
  ) {
    config = {
      ...config,
      bootstrap: {
        ...(config.bootstrap ?? {}),
        rehydrate: envRehydrate,
      },
    };
  }

  // Ensure base directory exists
  fs.mkdirSync(baseDir, { recursive: true });

  // 1. Agent Store (minimal SQLite)
  const agentStorePath = path.join(baseDir, "agents.db");
  const agentStore = new AgentStore(agentStorePath);

  // 2. Inbox Adapter (embedded agent-inbox, hybrid mode)
  const inboxSocketPath =
    config.inbox?.socketPath ?? path.join(baseDir, "inbox.sock");
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
      "[boot-v2] opentasks daemon not available. Task operations will fail until connected.",
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
      taskResourceId: config.cascade?.taskResourceId,
      resolveTaskRef: config.cascade?.resolveTaskRef,
    },
  );

  // 6. Federation (cross-instance communication)
  let federationCleanup: (() => void) | null = null;
  if (config.federation) {
    const { setupFederation } = await import("./adapters/federation.js");
    federationCleanup = setupFederation(
      agentManager,
      inboxAdapter,
      config.federation,
    );
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
    },
  );
  await triggerSystem.start();

  // 7a. Task Dispatch (opt-in autonomous task dispatch mode)
  let taskDispatcher: import("swarm-dispatch").TaskDispatcher | null = null;
  // Hoisted so the MAP sidecar (step 13) can forward it to the mail bridge.
  let dispatcherAgentId: string | undefined;
  // Mail-inbound consumer — always wired (does not require dispatch.enabled).
  let mailInboundConsumer: import("./dispatch/mail-inbound-consumer.js").MailInboundConsumer | null = null;
  // Mail-inbound REUSE consumer — handles `x-dispatch/work` envelopes
  // addressed to non-sidecar agents (long-lived workers/coordinators) and
  // drives them through the dispatch turn using their existing session.
  // Always wired so reuse routing works even without the outbound
  // orchestrator. Filters non-overlapping with mailInboundConsumer.
  let mailInboundReuseConsumer:
    | import("./dispatch/mail-inbound-reuse-consumer.js").MailInboundReuseConsumer
    | null = null;

  {
    // Stable dispatcher ID used as the inbox recipient for bridged envelopes.
    // Matches the id the mail-bridge registers and delivers to. The outbound
    // orchestrator (below, opt-in) reuses the same id so both code paths share
    // one inbox recipient — no double-processing because the consumer only
    // fires spawn() while the orchestrator fires spawn() only when polling
    // opentasks (different trigger paths).
    const { getStableInstanceId } = await import("./cli/stable-instance-id.js");
    const inboundClaimantId = `${os.hostname()}:${process.pid}:${getStableInstanceId(cwd)}`;
    const inboundDispatcherId = `dispatcher:${inboundClaimantId}`;
    dispatcherAgentId = inboundDispatcherId;

    // Register the inbox recipient so mail-bridge's registerAgent call is a
    // no-op (it uses an upsert) and the inbox accepts deliveries immediately.
    await inboxAdapter.registerAgent(inboundDispatcherId, {
      role: "dispatcher",
      scope: "default",
    });

    const rawInbox = inboxAdapter.getInbox();
    const { createMailInboundConsumer } = await import(
      "./dispatch/mail-inbound-consumer.js"
    );
    mailInboundConsumer = createMailInboundConsumer({
      dispatcherAgentId: inboundDispatcherId,
      inboxEvents: rawInbox.events as any,
      agentManager,
      agentStore,
      getSidecar: () => (systemRef as any).mapSidecar ?? null,
      log: (msg) => console.log(msg),
    });

    // Reuse consumer for envelopes addressed to long-lived workers/
    // coordinators. Non-overlapping filter (event.agentId !== sidecarId).
    const { createMailInboundReuseConsumer } = await import(
      "./dispatch/mail-inbound-reuse-consumer.js"
    );
    mailInboundReuseConsumer = createMailInboundReuseConsumer({
      dispatcherAgentId: inboundDispatcherId,
      inboxEvents: rawInbox.events as any,
      agentManager,
      agentStore,
      getSidecar: () => (systemRef as any).mapSidecar ?? null,
      log: (msg) => console.log(msg),
    });
  }

  if (config.dispatch?.enabled && tasksAdapter) {
    const { createOrchestrator, createOpenTasksSource, createAgentInboxPort } =
      await import("swarm-dispatch");

    // dispatcherAgentId is already set by the unconditional mail-inbound block above.
    // Use it directly so both paths share the same inbox recipient.
    const dispatchAgentId = dispatcherAgentId!;

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
          transition: async (
            taskId: string,
            action: "start" | "complete" | "fail",
          ) => tasksAdapter.transitionTask(taskId, action),
          getTask: async (taskId: string) => tasksAdapter.getTask(taskId),
          listInProgress: async () =>
            tasksAdapter.listTasks({ status: "in_progress" }),
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
            const content = msg.content as {
              type?: string;
              schema?: string;
              data?: any;
              _conversationId?: string;
            };
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
                  // Thread conversation_id through so the reply bridge can post
                  // the worker's output back to the hub's mail conversation.
                  ...(content._conversationId
                    ? { _mailConversationId: content._conversationId }
                    : {}),
                },
              },
            };
          },
        },
      );
      // Note: registerAgent for dispatchAgentId was already called in the
      // unconditional mail-inbound block above — no need to repeat here.
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
              if (criteria.role && a.role && a.role !== criteria.role)
                return false;
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
    const dispatchMode =
      config.dispatch.dispatchMode ??
      (hasRouting ? ("prefer-route" as const) : ("spawn-only" as const));

    taskDispatcher = createOrchestrator(source, runtime, {
      claimantId: dispatchAgentId,
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
      const unhealthy = controlServer.getUnhealthyAgents(
        UNHEALTHY_THRESHOLD_MS,
      );
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
              { importance: "high", threadTag: `health:${agentId}` },
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
    const { createWebSocketACPServer } =
      await import("./acp/websocket-server.js");
    acpServer = createWebSocketACPServer(systemRef, {
      port: config.acp.port,
      host: config.acp.host,
      path: config.acp.path,
    });
    await acpServer.start();
  }

  // 11. MAP Server (optional — accept inbound connections from TUI/clients)
  let mapServerInstance: import("./map/types.js").MAPServerInstance | null =
    null;
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
    minimem: config.minimem?.enabled ? (config.minimem as any) : undefined,
    skilltree: config.skilltree?.enabled
      ? (config.skilltree as any)
      : undefined,
    sessionlog: config.sessionlog?.enabled
      ? (config.sessionlog as any)
      : undefined,
  });

  // 12b. Skill-tree loadout compilation (if enabled)
  if (config.skilltree?.enabled) {
    try {
      const { compileAllRoleLoadouts } =
        await import("./integrations/skilltree.js");
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
      // If a workspace manager is present, pull out its GitCascadeAdapter
      // so the sidecar can forward cascade events to the hub.
      const wsMgr = config.workspaceManager as
        | {
            getGitCascadeAdapter?: () =>
              | import("./workspace/git-cascade-adapter.js").GitCascadeAdapter
              | undefined;
          }
        | undefined;
      const gitCascadeAdapter = wsMgr?.getGitCascadeAdapter?.();
      mapSidecar = createMAPSidecar(
        {
          agentManager,
          agentStore,
          inboxAdapter,
          tasksAdapter,
          getLocalMapId: mapServerInstance
            ? (id: string) => mapServerInstance!.getLocalMapId(id)
            : undefined,
          gitCascadeAdapter,
          dispatcherAgentId,
        },
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

      // Bridge dispatch events to MAP for observability. Spread the source
      // event first, then namespace the `type` field — otherwise tsc warns
      // about the literal key being overwritten by the spread.
      if (taskDispatcher && mapSidecar.emitEvent) {
        taskDispatcher.onEvent((event) => {
          mapSidecar!.emitEvent!({
            ...event,
            type: `dispatch.${event.type}`,
          });
        });
      }
      // Attach to shared system ref so ACP/MAP handlers can access it
      systemRef.mapSidecar = mapSidecar;
    } catch (err) {
      // Non-fatal — MAP hub connectivity is optional
      console.warn(
        `[boot-v2] MAP sidecar failed to start: ${(err as Error).message}`,
      );
    }
  }

  // 13. Boot-time agents (opt-in)
  // Fire after all subsystems are wired so the agent's lifecycle events
  // (spawned/started) flow through the lifecycle bridge → MAP hub. Non-
  // blocking: don't gate boot completion on agent process startup, which
  // takes seconds. Failures are logged but do not abort boot.
  //
  // Rehydration on restart: the agent-store persists across process
  // restarts. When we boot into a workspace that already has one or more
  // coordinators (e.g. openhive spawned this swarm previously + auto-
  // revived it), resume THOSE agents instead of spawning a brand-new one.
  // Otherwise the UI shows a different coordinator name after every
  // server restart — the prior conversations still exist on disk but get
  // buried under stale, state='stopped' records that the UI treats as
  // dead.
  if (config.bootstrap?.coordinator) {
    const opts = config.bootstrap.coordinator === true
      ? {}
      : config.bootstrap.coordinator;
    const bootstrapCwd = opts.cwd ?? cwd;
    const policy = config.bootstrap.rehydrate ?? "coordinators";

    // Build the revival set based on policy:
    //   - 'none'          → empty set (always fall through to fresh spawn)
    //   - 'coordinators'  → root coordinators at this cwd, running or stopped
    //   - 'all'           → every agent at this cwd, running or stopped
    //
    // Both 'running' and 'stopped' count as revival candidates. The
    // hosted-swarm graceful-restart path transitions agents to 'stopped'
    // on shutdown; an abrupt parent crash leaves them as 'running'.
    // Either way, the workspace intent survives the restart and we want
    // the same coordinators + their children back. Agents that a user
    // explicitly terminated are tracked with a distinct `stop_reason`
    // and — since explicit termination clears them from the cascade — do
    // not appear in the listAgents result at a cwd they no longer
    // inhabit. The `state='failed'` set is also excluded.
    let priors: import("./agent/agent-store.js").AgentRecord[] = [];
    if (policy === "coordinators") {
      priors = agentStore
        .listAgents({ parent_id: null, role: "coordinator" })
        .filter(
          (a) =>
            a.cwd === bootstrapCwd &&
            (a.state === "running" || a.state === "stopped"),
        );
    } else if (policy === "all") {
      priors = agentStore
        .listAgents()
        .filter(
          (a) =>
            a.cwd === bootstrapCwd &&
            (a.state === "running" || a.state === "stopped"),
        );
    }

    const rehydrateOrSpawn = async () => {
      if (priors.length > 0) {
        // Parent-first ordering so a child's `resume()` sees its parent
        // already back (lineage bookkeeping, inbox subscriptions). Depth
        // = lineage.length: roots are 0, direct children of roots are 1.
        const byDepth = new Map<number, typeof priors>();
        for (const p of priors) {
          const d = p.lineage.length;
          if (!byDepth.has(d)) byDepth.set(d, []);
          byDepth.get(d)!.push(p);
        }
        const depths = Array.from(byDepth.keys()).sort((a, b) => a - b);

        const priorIds = new Set(priors.map((p) => p.id));
        const resumed = new Set<string>();
        const failed = new Set<string>();

        // Stagger spawns — each resume fires a Claude Code subprocess and
        // we don't want a coordinator + five workers all booting at once.
        const CONCURRENCY = 2;

        for (const depth of depths) {
          const atDepth = byDepth.get(depth)!;
          const eligible = atDepth.filter((a) => {
            if (!a.parent_id) return true; // roots are always eligible
            // Skip children whose parent isn't being revived at all
            // (deliberately stopped, or out of scope for this policy).
            if (!priorIds.has(a.parent_id)) {
              console.warn(
                `[boot-v2] Skipping ${a.role} ${a.id}: parent ${a.parent_id} not in revival set`,
              );
              return false;
            }
            // Skip children whose parent resume failed.
            if (failed.has(a.parent_id)) {
              console.warn(
                `[boot-v2] Skipping ${a.role} ${a.id}: parent ${a.parent_id} failed to resume`,
              );
              return false;
            }
            return resumed.has(a.parent_id);
          });

          for (let i = 0; i < eligible.length; i += CONCURRENCY) {
            const batch = eligible.slice(i, i + CONCURRENCY);
            await Promise.all(
              batch.map(async (prior) => {
                try {
                  const r = await agentManager.resume(prior.id);
                  resumed.add(prior.id);
                  console.log(
                    `[boot-v2] Rehydrated ${prior.role}: ${(r as any).name ?? r.id} at ${prior.cwd}`,
                  );
                } catch (err) {
                  const msg = (err as Error).message;
                  if (/ALREADY_RUNNING/i.test(msg)) {
                    // Rare lifecycle race — treat as success so children
                    // aren't held back waiting on a parent that's actually
                    // already alive.
                    resumed.add(prior.id);
                  } else {
                    failed.add(prior.id);
                    console.warn(
                      `[boot-v2] Failed to rehydrate ${prior.role} ${prior.id}: ${msg}`,
                    );
                  }
                }
              }),
            );
          }
        }
        return;
      }
      // No priors matched the policy → fresh spawn (first boot, or 'none').
      const spawned = await agentManager.spawn({
        role: "coordinator",
        parent: null,
        cwd: bootstrapCwd,
        task: opts.task ?? "Default coordinator (auto-spawn on boot)",
        permissionMode: opts.permissionMode,
        agentType: opts.agentType,
        customPrompt: opts.customPrompt,
      });
      console.log(
        `[boot-v2] Bootstrap coordinator spawned: ${(spawned as any).name ?? spawned.id} at ${bootstrapCwd}`,
      );

      // Optional: bootstrap an additional worker for live tests
      // exercising mail+reuse semantics. Spawned with parent=null
      // because:
      //   - The role-capability check only fires for parented spawns
      //     (agent-manager-v2 line 559-572); bypassing it lets us use
      //     a custom role (e.g., 'reuse-target') that doesn't collide
      //     with the sidecar's projected 'worker' in the hub-side
      //     dispatch roster.
      //   - The worker's done() lifecycle is the same as the bootstrap
      //     coord's: terminate cleanly. Phase 2C's `_lastSummary`
      //     fallback (handlers-v2 + mail-inbound-reuse-consumer)
      //     ensures the dispatch reply path recovers the summary from
      //     metadata even if the prompt iterator's update stream races
      //     the ACP connection close on terminate.
      if (config.bootstrap?.worker) {
        const workerOpts = config.bootstrap.worker === true
          ? {}
          : config.bootstrap.worker;
        const workerRole = workerOpts.role ?? "reuse-target";
        try {
          const workerSpawned = await agentManager.spawn({
            role: workerRole,
            parent: null,
            cwd: bootstrapCwd,
            task: workerOpts.task ?? "Await dispatch",
            // Funnel every tool call through the host so the prompt-iterator
            // handler can apply per-dispatch overlay deny rules at runtime
            // (Phase 3). Two layers must both be set:
            //   - askForAllTools=true → settings.permissions.ask=['*'] so
            //     the Claude SDK actually consults canUseTool for every
            //     tool (without this, default mode auto-approves "safe"
            //     tools like Read).
            //   - permissionMode='interactive' → acp-factory emits the
            //     resulting requestPermission as a `permission_request`
            //     session update instead of auto-approving it (which is
            //     macro-agent's default 'auto-approve' behavior).
            // Bootstrap dispatch targets are autonomous + latency-tolerant
            // so the per-call host roundtrip is acceptable.
            askForAllTools: true,
            permissionMode: "interactive",
          });
          console.log(
            `[boot-v2] Bootstrap dispatch-target spawned: ${(workerSpawned as any).name ?? workerSpawned.id} ` +
              `(role=${workerRole}, parent=null)`,
          );
        } catch (err) {
          console.warn(
            `[boot-v2] Bootstrap worker spawn failed: ${(err as Error).message}`,
          );
        }
      }
    };

    rehydrateOrSpawn().catch((err: Error) => {
      console.warn(
        `[boot-v2] Bootstrap coordinator init failed: ${err.message}`,
      );
    });
  }

  // 14. Return system handle
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
    _sessionlogSyncLevel:
      config.sessionlog?.sync ?? config.map?.trajectorySyncLevel ?? "full",

    async shutdown(): Promise<void> {
      clearInterval(healthCheckTimer);
      if (mailInboundConsumer) mailInboundConsumer.stop();
      if (mailInboundReuseConsumer) mailInboundReuseConsumer.stop();
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
