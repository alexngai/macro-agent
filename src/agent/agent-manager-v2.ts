/**
 * AgentManager V2 — Uses AgentStore + InboxAdapter + TasksAdapter
 *
 * Replaces EventStore/MessageRouter dependencies with the adapter layer.
 * Messages flow through agent-inbox, tasks through opentasks,
 * agent lifecycle state in AgentStore (minimal SQLite).
 *
 * @module agent/agent-manager-v2
 */

import { nanoid } from "nanoid";
import {
  uniqueNamesGenerator,
  adjectives,
  animals,
} from "unique-names-generator";
import {
  AgentFactory,
  type Session,
  type AgentHandle,
  type ExtendedSessionUpdate,
  type PermissionMode,
} from "acp-factory";
import {
  AgentStore,
  type AgentRecord,
  type SessionRecord,
} from "./agent-store.js";
import type {
  AgentId,
  TaskId,
  Timestamp,
  Agent,
  AgentState,
} from "../store/types/index.js";
import type {
  SpawnAgentOptions,
  SpawnedAgent,
  AgentFilter,
  AgentHierarchy,
  AgentHierarchyNode,
  HierarchyOptions,
  ActiveSession,
  AgentStopReason,
  HeadManagerOptions,
  SystemPromptContext,
  AgentLifecycleCallback,
  AgentLifecycleEvent,
  AgentConfig,
  ContinueAgentOptions,
  MCPServerConfig,
} from "./types.js";
import { AgentManagerError } from "./types.js";
import type { RoleRegistry, Capability } from "../roles/types.js";
import { AGENT_CAPABILITIES } from "../roles/capabilities.js";
import { DefaultRoleRegistry } from "../roles/registry.js";
import { generateSystemPrompt } from "./system-prompt.js";
import type { WorkspaceManager, Workspace } from "../workspace/types.js";
import {
  terminateWithChangeConsolidation,
  type WorkspaceProvider,
  type CascadeAgentManager,
} from "../lifecycle/cascade.js";
import { AgentTokenManager } from "../auth/token.js";
import type { InboxAdapter } from "../adapters/types.js";
import type { TasksAdapter } from "../adapters/types.js";
import type { AgentManager, SpawnInterceptor } from "./agent-manager.js";

// ─────────────────────────────────────────────────────────────────
// Helper
// ─────────────────────────────────────────────────────────────────

function getSpawnCapability(childRole: string): Capability {
  const baseRole = childRole.split(".")[0];
  switch (baseRole) {
    case "worker":
      return AGENT_CAPABILITIES.SPAWN_WORKER;
    case "integrator":
      return AGENT_CAPABILITIES.SPAWN_INTEGRATOR;
    case "monitor":
      return AGENT_CAPABILITIES.SPAWN_MONITOR;
    case "coordinator":
      return AGENT_CAPABILITIES.SPAWN_CUSTOM;
    default:
      return `agent.spawn.${childRole}` as Capability;
  }
}

function generateName(): string {
  return uniqueNamesGenerator({
    dictionaries: [adjectives, animals],
    separator: "-",
    length: 2,
  });
}

// ─────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────

/** Minimal health check interface (monitor module removed in V2) */
interface HealthCheckService {
  startForCoordinator(agentId: string): void;
  stopForCoordinator(agentId: string): void;
}

export interface AgentManagerV2Config {
  defaultPermissionMode?: PermissionMode;
  defaultAgentType?: string;
  defaultCwd?: string;
  workspaceManager?: WorkspaceManager;
  roleRegistry?: RoleRegistry;
  healthCheckService?: HealthCheckService;
  agentTokenManager?: AgentTokenManager;
  serverUrl?: string;
  serverToken?: string;
  /** Control socket path for MCP subprocess lifecycle RPC */
  controlSocketPath?: string;
  /**
   * Default opentasks resource ID hosted on the OpenHive hub. When set,
   * spawn paths build `taskRef = { resource_id: <this>, node_id: task_id }`
   * automatically from `SpawnAgentOptions.task_id` (for any spawn where
   * `resolveTaskRef` returned undefined AND the caller didn't supply an
   * explicit `taskRef`).
   *
   * Operators set this once at swarm registration for the common
   * single-graph case. Multi-graph deployments should use `resolveTaskRef`
   * instead.
   */
  taskResourceId?: string;

  /**
   * Multi-graph resolver. Called at every spawn; return a `TaskRef` to set
   * the binding or `undefined` to fall through to the `taskResourceId`
   * default. Explicit `SpawnAgentOptions.taskRef` always wins over both.
   *
   * Keep cheap — runs per-spawn.
   */
  resolveTaskRef?: (
    spawnOptions: SpawnAgentOptions
  ) => import("git-cascade/events").TaskRef | undefined;
}

// ─────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────

export function createAgentManagerV2(
  agentStore: AgentStore,
  inboxAdapter: InboxAdapter,
  tasksAdapter: TasksAdapter,
  config: AgentManagerV2Config = {}
): AgentManager {
  const {
    defaultPermissionMode = "auto-approve",
    defaultAgentType = "claude-code",
    defaultCwd = process.cwd(),
    workspaceManager,
    roleRegistry = new DefaultRoleRegistry(),
    healthCheckService,
    serverUrl,
    serverToken,
    agentTokenManager,
    controlSocketPath,
    taskResourceId,
    resolveTaskRef,
  } = config;

  // In-memory state
  const activeSessions = new Map<AgentId, ActiveSession>();
  const agentWorkspaces = new Map<AgentId, Workspace>();
  const lifecycleListeners = new Set<AgentLifecycleCallback>();
  let spawnInterceptor: SpawnInterceptor | null = null;
  let isShuttingDown = false;
  let mapServerUrl: string | undefined;

  // Swarmkit integration configs (set via late-binding setters from boot-v2)
  let minimemConfig: { enabled: boolean; dir?: string; provider?: string; global?: boolean } | undefined;
  let skilltreeConfig: { enabled: boolean; basePath?: string; defaultProfile?: string } | undefined;
  let sessionlogConfig: { enabled: boolean; sync?: string } | undefined;
  // Compiled skill loadouts per role (populated by team runtime)
  const skillLoadouts = new Map<string, string>();
  // MAP sidecar reference for trajectory reporting (set via setSidecar)
  let sidecarRef: { connected: boolean; reportCheckpoint(cp: any): Promise<any> } | null = null;

  // TopologyPolicy for workspace allocation (Phase 3+); set via setTopologyPolicy.
  // When null, createWorkspaceForRole falls back to legacy role-name dispatch.
  let topologyPolicy:
    | import('../workspace/topology/types.js').TopologyPolicy
    | null = null;

  // ── Helpers ──────────────────────────────────────────────────

  function notifyLifecycle(event: AgentLifecycleEvent): void {
    for (const listener of lifecycleListeners) {
      try {
        listener(event);
      } catch {
        // Ignore listener errors
      }
    }
  }

  function agentRecordToAgent(record: AgentRecord): Agent {
    const session = agentStore.getSession(record.id as AgentId);
    return {
      id: record.id,
      name: record.name,
      session_id: session?.session_id ?? "",
      parent: record.parent_id,
      lineage: record.lineage,
      state: record.state,
      stop_reason: record.stop_reason as Agent["stop_reason"],
      task: record.task,
      task_id: record.task_id,
      role: record.role,
      team_instance: record.team,
      config: (record.config as Agent["config"]) ?? {},
      cwd: record.cwd,
      plan: [],
      metadata: record.metadata,
      created_at: record.created_at,
      started_at: record.started_at,
      stopped_at: record.stopped_at,
      last_activity_at: record.last_activity_at,
    };
  }

  function buildMcpServerConfig(opts: {
    agentId: string;
    parentId: string;
    taskId: string;
    cwd: string;
    permissionMode: string;
    lineage?: string[];
    sessionId?: string;
    streamId?: string;
  }): MCPServerConfig {
    const env: Record<string, string> = {
      MACRO_AGENT_ID: opts.agentId,
      MACRO_PARENT_ID: opts.parentId,
      MACRO_TASK_ID: opts.taskId,
      MACRO_AGENT_CWD: opts.cwd,
      MACRO_PERMISSION_MODE: opts.permissionMode,
      MACRO_STREAM_ID: opts.streamId ?? "",
      // Point to inbox socket for agent-inbox MCP tools
      INBOX_SOCKET_PATH: inboxAdapter.socketPath,
      // Control socket for lifecycle RPC (spawn, terminate, etc.)
      MACRO_CONTROL_SOCKET_PATH: controlSocketPath ?? "",
      // Base directory for AgentStore + inbox in MCP subprocess
      MACRO_BASE_DIR: controlSocketPath
        ? controlSocketPath.replace(/\/control\.sock$/, "")
        : "",
      // opentasks client auto-discovers its socket
    };

    if (serverUrl) {
      env.MACRO_SERVER_URL = serverUrl;
      env.MACRO_AGENT_LINEAGE = JSON.stringify(opts.lineage ?? []);
      env.MACRO_SESSION_ID = opts.sessionId ?? "";
      if (serverToken) env.MACRO_SERVER_TOKEN = serverToken;
      if (agentTokenManager) {
        env.MACRO_AGENT_TOKEN = agentTokenManager.createToken(opts.agentId);
      }
    }

    // Use node with local dist path to ensure we run V2 MCP server,
    // not a globally installed V1 version.
    const mcpEntryPoint = new URL("../../dist/cli/mcp.js", import.meta.url).pathname;

    return {
      name: "macro-agent",
      command: "node",
      args: [mcpEntryPoint],
      env,
    };
  }

  // ── Workspace Helper ─────────────────────────────────────────

  /**
   * Execute a TopologyPolicy decision against the WorkspaceManager.
   *
   * Translates declarative `WorkspaceDecision` into concrete workspace
   * allocations. Returns a `Workspace` compatible with the legacy shape
   * so the rest of AgentManagerV2 doesn't need to change.
   */
  async function executeWorkspaceDecision(
    agentId: AgentId,
    decision: import('../workspace/topology/types.js').WorkspaceDecision,
    role?: string,
    spawnOptions?: SpawnAgentOptions
  ): Promise<Workspace | undefined> {
    if (!workspaceManager) return undefined;

    switch (decision.kind) {
      case 'none':
      case 'share-parent-cwd':
        return undefined;

      case 'share-with-agent': {
        const worktree = workspaceManager.allocateWorktree({
          agentId,
          sharedWithAgent: decision.agentId,
        });
        return {
          agentId,
          path: worktree.path,
          branch: worktree.currentStream
            ? `stream/${worktree.currentStream}`
            : 'unknown',
          streamId: worktree.currentStream ?? '',
          role: 'v3', // V3 path — bypass legacy worker task/merge-queue flows
          createdAt: worktree.createdAt,
        };
      }

      case 'attach-to-stream': {
        // Record even if no worktree — the topology needs the stream↔role
        // mapping for event-driven features like on_parent_advanced.
        const attachPolicy = topologyPolicy as unknown as {
          recordAgentStream?: (a: string, s: string, role?: string) => void;
        };
        attachPolicy.recordAgentStream?.(agentId, decision.streamId, role);

        if (!decision.allocateWorktree) {
          return undefined;
        }
        const worktree = workspaceManager.allocateWorktree({
          agentId,
          streamId: decision.streamId,
        });
        return {
          agentId,
          path: worktree.path,
          branch: `stream/${decision.streamId}`,
          streamId: decision.streamId,
          role: 'v3', // V3 path — attach-to-team-root
          createdAt: worktree.createdAt,
        };
      }

      case 'new-stream': {
        // If the spawning agent has a taskRef and the streamSpec doesn't
        // already carry one, weave it into metadata so the resulting stream
        // binds to the OpenTasks node. Explicit streamSpec.metadata.task_ref
        // wins.
        const taskRef = spawnOptions?.taskRef;
        const existingMeta = decision.streamSpec.metadata as
          | Record<string, unknown>
          | undefined;
        const streamSpec = taskRef && !existingMeta?.task_ref
          ? {
              ...decision.streamSpec,
              metadata: { ...(existingMeta ?? {}), task_ref: taskRef },
            }
          : decision.streamSpec;
        const streamId = workspaceManager.createStreamV3(streamSpec);
        // Record the mapping in the topology if it supports it (for share-with lookup).
        const policy = topologyPolicy as unknown as {
          recordAgentStream?: (a: string, s: string, role?: string) => void;
        };
        policy.recordAgentStream?.(agentId, streamId, role);

        if (!decision.allocateWorktree) {
          return undefined;
        }
        const worktree = workspaceManager.allocateWorktree({
          agentId,
          streamId,
        });
        return {
          agentId,
          path: worktree.path,
          branch: `stream/${streamId}`,
          streamId,
          role: 'v3', // V3 path — new-stream
          createdAt: worktree.createdAt,
        };
      }
    }
  }

  async function createWorkspaceForRole(
    agentId: AgentId,
    role: string,
    options: SpawnAgentOptions
  ): Promise<Workspace | undefined> {
    if (!workspaceManager) return undefined;

    // V3 path — TopologyPolicy-driven. Set by boot-v2 when team YAML has
    // `macro_agent.workspace`. When set, this takes precedence over the legacy
    // capability/role-name dispatch below.
    if (topologyPolicy) {
      const decision = await topologyPolicy.onAgentSpawn({
        agentId,
        role,
        parentAgentId: options.parent ?? undefined,
        parentStreamId: options.streamId,
        teamStreamId: (() => {
          const stream = (
            topologyPolicy as { getAgentStream?: (a: AgentId) => string | null }
          ).getAgentStream?.(agentId);
          return stream ?? undefined;
        })(),
        workspaceManager,
        getAgentByRole: (r: string) => {
          for (const [aid, ws] of agentWorkspaces) {
            const rec = agentStore.getAgent(aid);
            if (rec?.role === r) return aid;
          }
          return null;
        },
      });
      return executeWorkspaceDecision(agentId, decision, role, options);
    }

    // Capability-based dispatch for programmatic callers that don't use
    // team YAML. This is the supported path for libraries that construct
    // WorkspaceManager + GitCascadeAdapter directly and spawn agents with
    // explicit `capabilities` + `streamId` arguments. It coexists with the
    // V3 topology path above.
    return capabilityBasedDispatch(agentId, options, workspaceManager);
  }

  /**
   * Capability-based workspace allocation for programmatic callers.
   *
   * Matches on `workspace.stream` / `workspace.integrate` / `workspace.worktree`
   * capabilities + corresponding streamId/streamConfig args. Delegates to the
   * role-shaped WorkspaceManager methods (createWorkerWorkspace,
   * createIntegratorWorkspace, createCoordinatorWorkspace).
   *
   * Not used by team-YAML-driven teams — those go through TopologyPolicy above.
   */
  async function capabilityBasedDispatch(
    agentId: AgentId,
    options: SpawnAgentOptions,
    ws: WorkspaceManager
  ): Promise<Workspace | undefined> {
    const capabilities = options.capabilities ?? [];
    const streamId = options.streamId;
    // Merge taskRef (if set at spawn time) into streamConfig.metadata so that
    // adapter.createStream → x-cascade/stream.opened carries the binding to
    // OpenTasks. Explicit streamConfig.metadata.task_ref wins if already set.
    const streamConfig = options.streamConfig
      ? options.taskRef &&
        !(options.streamConfig.metadata &&
          (options.streamConfig.metadata as Record<string, unknown>).task_ref)
        ? {
            ...options.streamConfig,
            metadata: {
              ...(options.streamConfig.metadata ?? {}),
              task_ref: options.taskRef,
            },
          }
        : options.streamConfig
      : undefined;
    const gitCascadeTaskId = options.gitCascadeTaskId;

    if (capabilities.includes("workspace.stream") && streamConfig) {
      const newStreamId = ws.createIntegrationStream(agentId, streamConfig);
      return ws.createCoordinatorWorkspace(agentId, newStreamId);
    }

    if (capabilities.includes("workspace.integrate") && streamId) {
      return ws.createIntegratorWorkspace(agentId, streamId);
    }

    if (capabilities.includes("workspace.worktree") && streamId) {
      const taskId = gitCascadeTaskId ?? agentId;
      return ws.createWorkerWorkspace(agentId, taskId, streamId);
    }

    // No matching capability — agent inherits parent cwd (no workspace)
    return undefined;
  }

  // ── Core Lifecycle ───────────────────────────────────────────

  async function spawn(rawOptions: SpawnAgentOptions): Promise<SpawnedAgent> {
    if (isShuttingDown) {
      throw new AgentManagerError(
        "Cannot spawn agent during shutdown",
        "SHUTDOWN_IN_PROGRESS"
      );
    }

    // Apply spawn interceptor (set by TeamRuntime)
    const interceptedOptions = spawnInterceptor
      ? await spawnInterceptor(rawOptions)
      : rawOptions;

    // Resolve taskRef with three-level precedence:
    //   1. Explicit `options.taskRef` (caller knows exactly what graph).
    //   2. `resolveTaskRef(opts)` (multi-graph deployments decide per spawn).
    //   3. `taskResourceId` + `options.task_id` (single-graph default).
    // If none resolves, spawn proceeds with no taskRef — cascade events
    // land without a task binding (hub back-fills from first commit that
    // carries one, if any).
    let resolvedTaskRef = interceptedOptions.taskRef;
    if (!resolvedTaskRef && resolveTaskRef) {
      try {
        resolvedTaskRef = resolveTaskRef(interceptedOptions);
      } catch (err) {
        // Resolver failures must not block spawn. Log + fall through.
        // eslint-disable-next-line no-console
        console.warn(
          "[agent-manager-v2] resolveTaskRef threw; falling back to taskResourceId default:",
          err instanceof Error ? err.message : err
        );
      }
    }
    if (!resolvedTaskRef && taskResourceId && interceptedOptions.task_id) {
      resolvedTaskRef = {
        resource_id: taskResourceId,
        node_id: String(interceptedOptions.task_id),
      };
    }
    const options = resolvedTaskRef === interceptedOptions.taskRef
      ? interceptedOptions
      : { ...interceptedOptions, taskRef: resolvedTaskRef };

    const {
      task,
      task_id,
      parent,
      cwd = defaultCwd,
      permissionMode = defaultPermissionMode,
      askForAllTools = false,
      subscribeParent = true,
      topics = [],
      config: agentConfig,
      agentType = defaultAgentType,
      customPrompt,
      interactionPatterns,
      role,
      team_instance,
      capabilities,
    } = options;

    // Generate IDs
    const agentId = `agent_${nanoid(12)}` as AgentId;
    const taskId = (task_id ?? `task_${nanoid(12)}`) as TaskId;
    const sessionId = `session_${nanoid(12)}`;
    const name = generateName();

    // Validate parent exists
    if (parent) {
      const parentRecord = agentStore.getAgent(parent);
      if (!parentRecord) {
        throw new AgentManagerError(
          `Parent agent ${parent} not found`,
          "AGENT_NOT_FOUND",
          parent
        );
      }

      // Check spawn capability
      if (role) {
        const requiredCap = getSpawnCapability(role);
        const parentRole = parentRecord.role;
        if (
          !roleRegistry.hasCapability(parentRole, requiredCap) &&
          !roleRegistry.hasCapability(parentRole, AGENT_CAPABILITIES.SPAWN_CUSTOM)
        ) {
          throw new AgentManagerError(
            `Parent ${parent} (role: ${parentRole}) lacks capability ${requiredCap}`,
            "CAPABILITY_DENIED",
            parent
          );
        }
      }
    }

    // Compute lineage
    const lineage: AgentId[] = [];
    if (parent) {
      const parentRecord = agentStore.getAgent(parent);
      if (parentRecord) {
        lineage.push(...parentRecord.lineage, parent);
      }
    }

    // Generate system prompt
    const resolvedRole = role
      ? roleRegistry.resolveRole(role)
      : undefined;
    const systemPromptContext: SystemPromptContext = {
      agentId,
      task,
      taskId,
      parentId: parent ?? null,
      isHeadManager: !parent,
      lineage,
      role,
    };
    let systemPrompt = generateSystemPrompt(systemPromptContext);
    if (customPrompt) {
      systemPrompt += `\n\n## Role Instructions\n\n${customPrompt}`;
    } else if (resolvedRole?.systemPrompt) {
      systemPrompt += `\n\n## Role Instructions\n\n${resolvedRole.systemPrompt}`;
    }
    if (interactionPatterns?.length) {
      systemPrompt += `\n\n${interactionPatterns.join("\n\n")}`;
    }

    // Persist agent in store. Stash taskRef in metadata so done()'s
    // lifecycle context can read it without separate plumbing — this is the
    // path that makes per-commit task_ref binding work end-to-end.
    const now = Date.now() as Timestamp;
    const agentRecord: AgentRecord = {
      id: agentId,
      name,
      role: role ?? (parent ? "worker" : "coordinator"),
      state: "running",
      parent_id: parent ?? null,
      lineage,
      team: team_instance,
      scope: team_instance ?? "default",
      task: task ?? "",
      task_id: taskId,
      cwd,
      capabilities: capabilities ?? resolvedRole?.capabilities ?? [],
      created_at: now,
      started_at: now,
      config: agentConfig as Record<string, unknown>,
      metadata: options.taskRef ? { task_ref: options.taskRef } : {},
    };
    agentStore.putAgent(agentRecord);

    let handle: AgentHandle | undefined;
    let workspace: Workspace | undefined;

    try {
      // Spawn process via acp-factory
      const env: Record<string, string> = {
        ...agentConfig?.env,
      };

      // Configure cc-swarm to connect to macro-agent's local MAP server.
      // These env vars are read by cc-swarm hooks in the Claude Code process
      // (not the MCP subprocess), so they must be in the agent process env.
      if (mapServerUrl) {
        env.SWARM_MAP_SERVER = mapServerUrl;
        env.SWARM_MAP_ENABLED = "true";
        env.SWARM_MAP_SCOPE = `swarm:${agentId}`;
        env.SWARM_SESSIONLOG_ENABLED = "true";
        env.SWARM_SESSIONLOG_SYNC = "metrics";
      }

      handle = await AgentFactory.spawn(agentType, {
        permissionMode,
        env,
      });

      // Create workspace if applicable
      workspace = await createWorkspaceForRole(agentId, role ?? "", options);
      if (workspace) {
        agentWorkspaces.set(agentId, workspace);

        // Create and claim git-cascade task for workers
        if (
          workspace.role === "worker" &&
          workspace.streamId &&
          workspaceManager
        ) {
          const dpTaskId = options.gitCascadeTaskId ?? agentId;
          workspaceManager.createTask(workspace.streamId, {
            title: task ?? `Task for ${agentId}`,
          });
          workspaceManager.claimTask(dpTaskId, agentId, workspace.path);
        }

        agentStore.updateAgent(agentId, {
          cwd: workspace.path,
          workspace_path: workspace.path,
          workspace_stream_id: workspace.streamId,
        });
      }

      const effectiveCwd = workspace?.path ?? cwd;

      // Build MCP server config
      const macroAgentMcp = buildMcpServerConfig({
        agentId,
        parentId: parent ?? "",
        taskId,
        cwd: effectiveCwd,
        permissionMode,
        lineage,
        sessionId,
        streamId: workspace?.streamId,
      });

      // Convert to acp-factory format
      const mcpServers = [
        {
          name: macroAgentMcp.name,
          command: macroAgentMcp.command,
          args: macroAgentMcp.args ?? [],
          env: Object.entries(macroAgentMcp.env ?? {}).map(([k, v]) => ({
            name: k,
            value: v,
          })),
        },
        ...(agentConfig?.mcpServers?.map((s) => ({
          name: s.name,
          command: s.command,
          args: s.args ?? [],
          env: Object.entries(s.env ?? {}).map(([k, v]) => ({
            name: k,
            value: v,
          })),
        })) ?? []),
      ];

      // Register minimem MCP server (agent-type independent — works for any MCP-capable agent)
      if (minimemConfig?.enabled) {
        mcpServers.push({
          name: "minimem",
          command: "minimem",
          args: [
            "mcp",
            "--dir", minimemConfig.dir ?? ".swarm/minimem/",
            "--provider", minimemConfig.provider ?? "auto",
            ...(minimemConfig.global ? ["--global"] : []),
          ],
          env: [],
        } as any);
      }

      // Build agentMeta
      let agentMeta: Record<string, any> | undefined;

      if (permissionMode === "interactive" && askForAllTools) {
        agentMeta = {
          claudeCode: {
            options: {
              settingSources: [],
              settings: {
                permissions: {
                  ask: ["*", "Write(**)", "Edit(**)", "MultiEdit(**)", "Bash(*)"],
                },
              },
            },
          },
        };
      }

      // Build capabilities context + skill-tree loadout for system prompt
      // Matches cc-swarm's context injection pattern (role-aware, tool-specific)
      let contextSuffix = "";
      try {
        const { buildCapabilitiesContext } = await import("../integrations/context-builder.js");
        contextSuffix = buildCapabilitiesContext({
          role: parent ? (role ?? "worker") : null, // null = orchestrator, string = spawned agent
          teamName: team_instance ?? undefined,
          minimem: minimemConfig
            ? { enabled: minimemConfig.enabled, status: "ready" }
            : undefined,
          skilltree: skilltreeConfig
            ? { enabled: skilltreeConfig.enabled, status: "ready", profile: skilltreeConfig.defaultProfile }
            : undefined,
          sessionlog: sessionlogConfig
            ? { enabled: sessionlogConfig.enabled, sync: sessionlogConfig.sync }
            : undefined,
          mesh: mapServerUrl ? { enabled: false } : undefined, // mesh state from config
          map: mapServerUrl
            ? { enabled: true, scope: `swarm:${agentId}`, status: "connected" }
            : undefined,
          opentasks: tasksAdapter.connected
            ? { enabled: true, status: "connected" }
            : undefined,
          inbox: { enabled: true },
        });
      } catch { /* context builder not available */ }

      // Inject skill-tree loadout if available for this role
      const roleLoadout = role ? skillLoadouts.get(role) : undefined;
      if (roleLoadout) {
        contextSuffix += `\n\n## Skills\n\n${roleLoadout}`;
      }

      // Merge context into system prompt
      const enrichedPrompt = contextSuffix
        ? `${systemPrompt ?? ""}\n\n${contextSuffix}`.trim()
        : systemPrompt;

      // Create session
      const session = await handle.createSession(effectiveCwd, {
        mcpServers,
        systemPrompt: enrichedPrompt ?? systemPrompt,
        ...(agentMeta && { agentMeta }),
      } as any);

      // Store session record
      agentStore.putSession({
        agent_id: agentId,
        session_id: sessionId,
        provider_session_id: session.id,
        created_at: now,
      });

      // Update agent with provider session ID. Merge with existing metadata
      // so fields set at spawn time (e.g. task_ref) aren't clobbered.
      const existingMeta = agentStore.getAgent(agentId)?.metadata ?? {};
      agentStore.updateAgent(agentId, {
        metadata: { ...existingMeta, provider_session_id: session.id },
      });

      // Register agent in inbox
      await inboxAdapter.registerAgent(agentId, {
        name,
        role: role ?? "worker",
        scope: team_instance ?? "default",
      });

      // Track active session
      const activeSession: ActiveSession = {
        agentId,
        handle,
        session,
        createdAt: now,
        isPrompting: false,
      };
      activeSessions.set(agentId, activeSession);

      // Notify lifecycle
      const agent = agentRecordToAgent(agentStore.getAgent(agentId)!);
      notifyLifecycle({ type: "spawned", agent });
      notifyLifecycle({ type: "started", agent });

      // Start health monitoring for coordinators
      if (healthCheckService && role === "coordinator") {
        healthCheckService.startForCoordinator(agentId);
      }

      return {
        id: agentId,
        session_id: sessionId,
        agent,
        session,
        workspace,
        streamId: workspace?.streamId,
      };
    } catch (err) {
      // Cleanup on failure
      if (handle) {
        try {
          await handle.close();
        } catch {
          /* ignore */
        }
      }
      agentStore.updateAgent(agentId, {
        state: "failed",
        stop_reason: "failed",
        stopped_at: Date.now(),
      });
      throw err;
    }
  }

  async function terminate(
    agentId: AgentId,
    reason: AgentStopReason
  ): Promise<void> {
    const record = agentStore.getAgent(agentId);
    if (!record) {
      throw new AgentManagerError(
        `Agent ${agentId} not found`,
        "AGENT_NOT_FOUND",
        agentId
      );
    }

    // Close active session
    const activeSession = activeSessions.get(agentId);
    if (activeSession) {
      try {
        await activeSession.handle.close();
      } catch {
        /* ignore close errors */
      }
      activeSessions.delete(agentId);
    }

    // Stop health monitoring
    if (healthCheckService && record.role === "coordinator") {
      healthCheckService.stopForCoordinator(agentId);
    }

    // Land the worker's work if completed with a workspace.
    //
    // V3 path (preferred): look up the role's YAML landing strategy via
    // TopologyPolicy.getRoleConfig and dispatch through
    // WorkspaceManager.land(). This fires cascade events (stream.merged or
    // queue.added) so the hub sees the work. Landing = 'none' short-circuits.
    //
    // Legacy fallback: if no TopologyPolicy is wired or it can't resolve a
    // landing for this role, submit to the legacy MergeQueue as before.
    // Keeps pre-V3 programmatic callers + tests that bypass YAML working.
    if (
      workspaceManager &&
      agentWorkspaces.has(agentId) &&
      reason === "completed"
    ) {
      const ws = agentWorkspaces.get(agentId)!;
      if (ws.role === "worker" && ws.streamId) {
        const roleConfig = topologyPolicy?.getRoleConfig?.(record.role);
        const yamlLandingName = roleConfig?.landing;
        const usingV3Landing =
          typeof yamlLandingName === "string" && yamlLandingName.length > 0;

        if (usingV3Landing) {
          try {
            const taskRef = (record.metadata as Record<string, unknown> | undefined)
              ?.task_ref as { resource_id: string; node_id: string } | undefined;
            await workspaceManager.land({
              agentId,
              streamId: ws.streamId,
              sourceWorktree: ws.path,
              strategyName: yamlLandingName,
              strategyConfig: roleConfig?.landing_config,
              taskRef,
              // Dispatcher overwrites this with `this`; placeholder keeps the
              // type satisfied without a cast.
              workspaceManager,
            });
          } catch {
            // Non-fatal landing failure — agent still terminates; conflicts
            // and strategy errors surface via WorkspaceEvent emission and
            // the strategy's own logs.
          }
        } else {
          try {
            const mergeQueue = workspaceManager.getMergeQueue();
            if (mergeQueue) {
              mergeQueue.submit({
                streamId: ws.streamId,
                workerBranch: ws.branch,
                taskId: record.task_id ?? agentId,
                workerAgentId: agentId,
              });
            }
          } catch {
            // Non-fatal merge queue submission failure
          }
        }
      }
    }

    // Deallocate workspace
    if (workspaceManager && agentWorkspaces.has(agentId)) {
      try {
        workspaceManager.deallocateWorkspace(agentId);
      } catch {
        /* ignore */
      }
      agentWorkspaces.delete(agentId);
    }

    // Revoke auth token
    if (agentTokenManager) {
      agentTokenManager.revokeToken(agentId);
    }

    // Notify parent via inbox
    if (record.parent_id) {
      try {
        await inboxAdapter.send(
          agentId,
          record.parent_id,
          {
            type: "event",
            event: "agent_stopped",
            data: {
              agentId,
              reason,
              taskId: record.task_id,
              role: record.role,
            },
          },
          { importance: "high", threadTag: `lifecycle:${agentId}` }
        );
      } catch {
        // Non-fatal inbox notification failure
      }
    }

    // Deregister from inbox
    await inboxAdapter.deregisterAgent(agentId);

    // Update agent state
    agentStore.updateAgent(agentId, {
      state: "stopped" as AgentState,
      stop_reason: reason as any,
      stopped_at: Date.now(),
    });

    // Emit final trajectory checkpoint with phase: "ended"
    if (sidecarRef?.connected) {
      try {
        const session = agentStore.getSession(agentId);
        sidecarRef.reportCheckpoint({
          id: `${session?.session_id ?? agentId}-ended`,
          session_id: session?.session_id ?? agentId,
          agent: record.name ?? agentId,
          branch: null,
          files_touched: [],
          checkpoints_count: 0,
          metadata: { phase: "ended", reason },
        }).catch(() => {});
      } catch {
        // best effort
      }
    }

    // Notify lifecycle
    const updatedAgent = agentRecordToAgent(agentStore.getAgent(agentId)!);
    notifyLifecycle({ type: "stopped", agent: updatedAgent, reason });

    // Cascade termination to children
    const children = agentStore.getChildren(agentId);
    for (const child of children) {
      if (child.state === "running" || child.state === "spawning") {
        const wsProvider: WorkspaceProvider = {
          getWorkspace: (id: AgentId) => agentWorkspaces.get(id) ?? null,
        };
        const cascadeAdapter: CascadeAgentManager = {
          getChildren: (id: AgentId) =>
            agentStore
              .getChildren(id)
              .map((r) => agentRecordToAgent(r)),
          terminate: (id: AgentId, r: AgentStopReason) => terminate(id, r),
        };
        const parentTaskRef = (record.metadata as Record<string, unknown> | undefined)
          ?.task_ref as { resource_id: string; node_id: string } | undefined;
        await terminateWithChangeConsolidation(
          child.id as AgentId,
          agentId,
          cascadeAdapter,
          wsProvider,
          undefined,
          workspaceManager ?? undefined,
          parentTaskRef
        );
      }
    }
  }

  async function resume(
    agentId: AgentId,
    overridePermissionMode?: PermissionMode
  ): Promise<SpawnedAgent> {
    if (isShuttingDown) {
      throw new AgentManagerError(
        "Cannot resume agent during shutdown",
        "SHUTDOWN_IN_PROGRESS"
      );
    }

    const record = agentStore.getAgent(agentId);
    if (!record) {
      throw new AgentManagerError(
        `Agent ${agentId} not found`,
        "AGENT_NOT_FOUND",
        agentId
      );
    }

    if (activeSessions.has(agentId)) {
      throw new AgentManagerError(
        `Agent ${agentId} already has active session`,
        "ALREADY_RUNNING",
        agentId
      );
    }

    const permMode = overridePermissionMode ?? defaultPermissionMode;
    const agentCwd = record.cwd || defaultCwd;

    const handle = await AgentFactory.spawn(defaultAgentType, {
      permissionMode: permMode,
    });

    const macroAgentMcp = buildMcpServerConfig({
      agentId,
      parentId: record.parent_id ?? "",
      taskId: record.task_id ?? "",
      cwd: agentCwd,
      permissionMode: permMode,
      lineage: record.lineage,
    });

    const mcpServers = [
      {
        name: macroAgentMcp.name,
        command: macroAgentMcp.command,
        args: macroAgentMcp.args ?? [],
        env: Object.entries(macroAgentMcp.env ?? {}).map(([k, v]) => ({
          name: k,
          value: v,
        })),
      },
    ];

    const agentMeta =
      permMode === "interactive"
        ? { claudeCode: { options: { settingSources: [] } } }
        : undefined;

    // Try to load existing session or create new
    const sessionRecord = agentStore.getSession(agentId);
    let session: Session;

    if (sessionRecord?.provider_session_id) {
      session = await handle.loadSession(
        sessionRecord.provider_session_id,
        agentCwd,
        mcpServers as any,
        agentMeta ? { agentMeta } : undefined
      );
    } else {
      session = await handle.createSession(agentCwd, {
        mcpServers,
        ...(agentMeta && { agentMeta }),
      });
    }

    const now = Date.now() as Timestamp;
    activeSessions.set(agentId, {
      agentId,
      handle,
      session,
      createdAt: now,
      isPrompting: false,
    });

    agentStore.updateAgent(agentId, {
      state: "running",
      started_at: now,
    });
    agentStore.putSession({
      agent_id: agentId,
      session_id: sessionRecord?.session_id ?? `session_${nanoid(12)}`,
      provider_session_id: session.id,
      created_at: now,
    });

    const agent = agentRecordToAgent(agentStore.getAgent(agentId)!);

    // Re-publish the agent to subscribers (local MAP server, hub lifecycle
    // bridge, team auto-join listeners) so a resumed agent is a first-class
    // registered agent — not just an in-memory handle. Without this, the hub
    // never re-registers the agent after cold-start; ACP routing works but
    // the hub's "Registered Agents" view stays empty and capabilities never
    // propagate back through `map/agents/register`.
    //
    // Spawn semantics are correct here: the process is new, the session is
    // (re)loaded, and subscribers treat it as a fresh registration. Paired
    // with the `stopped` event that fired on the prior termination, this
    // keeps the bridge's `registered` map consistent.
    notifyLifecycle({ type: "spawned", agent });
    notifyLifecycle({ type: "started", agent });

    return {
      id: agentId,
      session_id: sessionRecord?.session_id ?? "",
      agent,
      session,
    };
  }

  async function continueAgent(
    agentId: AgentId,
    options?: ContinueAgentOptions
  ): Promise<SpawnedAgent> {
    const record = agentStore.getAgent(agentId);
    if (!record) {
      throw new AgentManagerError(
        `Agent ${agentId} not found`,
        "AGENT_NOT_FOUND",
        agentId
      );
    }

    const contextLines: string[] = [];
    if (options?.additionalContext) {
      contextLines.push(options.additionalContext);
    }
    contextLines.push(`## Prior Session Context`);
    contextLines.push(`Continuing from agent ${agentId}.`);

    const resumeContext = contextLines.join("\n");
    const taskDescription =
      options?.task ?? record.task ?? `Continue work from ${agentId}`;

    return spawn({
      task: taskDescription,
      role: record.role,
      parent: record.parent_id ?? undefined,
      cwd: record.cwd || defaultCwd,
      customPrompt: resumeContext,
    });
  }

  async function forkAgent(
    sourceAgentId: AgentId,
    options?: { name?: string; prompt?: string; cwd?: string }
  ): Promise<SpawnedAgent> {
    if (isShuttingDown) {
      throw new AgentManagerError(
        "Cannot fork during shutdown",
        "SHUTDOWN_IN_PROGRESS"
      );
    }

    const record = agentStore.getAgent(sourceAgentId);
    if (!record) {
      throw new AgentManagerError(
        `Agent ${sourceAgentId} not found`,
        "AGENT_NOT_FOUND",
        sourceAgentId
      );
    }

    const activeSession = activeSessions.get(sourceAgentId);
    const sessionRecord = agentStore.getSession(sourceAgentId);
    if (!activeSession && !sessionRecord?.provider_session_id) {
      throw new AgentManagerError(
        `Agent ${sourceAgentId} has no session to fork`,
        "FORK_NOT_SUPPORTED",
        sourceAgentId
      );
    }

    const forkCwd = options?.cwd ?? record.cwd ?? defaultCwd;

    // Get forked session ID
    let forkedProviderSessionId: string;
    if (activeSession) {
      const forkedSession = await activeSession.session.forkWithFlush();
      forkedProviderSessionId = forkedSession.id;
    } else {
      forkedProviderSessionId = sessionRecord!.provider_session_id!;
    }

    // Spawn new process
    const handle = await AgentFactory.spawn(defaultAgentType, {
      permissionMode: defaultPermissionMode,
    });

    const agentId = `agent_${nanoid(12)}` as AgentId;
    const taskId = `task_${nanoid(12)}` as TaskId;
    const sessionId = `session_${nanoid(12)}`;
    const name = options?.name ?? generateName();
    const now = Date.now() as Timestamp;

    // Persist forked agent
    agentStore.putAgent({
      id: agentId,
      name,
      role: record.role,
      state: "running",
      parent_id: record.parent_id,
      lineage: record.lineage,
      team: record.team,
      scope: record.scope,
      task: options?.prompt ?? `[Fork of ${sourceAgentId}]`,
      task_id: taskId,
      cwd: forkCwd,
      capabilities: record.capabilities,
      created_at: now,
      started_at: now,
      metadata: { fork_of: sourceAgentId },
    });

    const macroAgentMcp = buildMcpServerConfig({
      agentId,
      parentId: record.parent_id ?? "",
      taskId,
      cwd: forkCwd,
      permissionMode: defaultPermissionMode,
      lineage: record.lineage,
      sessionId,
    });

    const session = await handle.loadSession(
      forkedProviderSessionId,
      forkCwd,
      [
        {
          name: macroAgentMcp.name,
          command: macroAgentMcp.command,
          args: macroAgentMcp.args ?? [],
          env: Object.entries(macroAgentMcp.env ?? {}).map(([k, v]) => ({
            name: k,
            value: v,
          })),
        },
      ] as any
    );

    agentStore.putSession({
      agent_id: agentId,
      session_id: sessionId,
      provider_session_id: session.id,
      created_at: now,
    });

    await inboxAdapter.registerAgent(agentId, {
      name,
      role: record.role,
      scope: record.scope,
    });

    activeSessions.set(agentId, {
      agentId,
      handle,
      session,
      createdAt: now,
      isPrompting: false,
    });

    const agent = agentRecordToAgent(agentStore.getAgent(agentId)!);
    notifyLifecycle({ type: "spawned", agent });
    notifyLifecycle({ type: "started", agent });

    return { id: agentId, session_id: sessionId, agent, session };
  }

  // ── Query Methods ──────────────────────────────────────────

  function get(agentId: AgentId): Agent | null {
    const record = agentStore.getAgent(agentId);
    return record ? agentRecordToAgent(record) : null;
  }

  function list(filter?: AgentFilter): Agent[] {
    const records = agentStore.listAgents({
      state: filter?.state,
      parent_id: filter?.parent,
    });

    let result = records.map(agentRecordToAgent);

    if (filter?.task_id) {
      result = result.filter((a) => a.task_id === filter.task_id);
    }
    if (filter?.headManagersOnly) {
      result = result.filter((a) => !a.parent);
    }

    return result;
  }

  function getChildren(agentId: AgentId): Agent[] {
    return agentStore.getChildren(agentId).map(agentRecordToAgent);
  }

  function getHierarchy(
    agentId: AgentId,
    options?: HierarchyOptions
  ): AgentHierarchy | null {
    const record = agentStore.getAgent(agentId);
    if (!record) return null;

    function buildTree(
      id: AgentId,
      depth: number
    ): AgentHierarchyNode {
      const agent = agentRecordToAgent(agentStore.getAgent(id)!);
      const maxDepth = options?.depth;
      const children =
        maxDepth !== undefined && depth >= maxDepth
          ? []
          : agentStore
              .getChildren(id)
              .map((c) => buildTree(c.id as AgentId, depth + 1));

      return { agent, children };
    }

    const root = buildTree(agentId, 0);

    function countNodes(node: AgentHierarchyNode): number {
      return 1 + node.children.reduce((sum, c) => sum + countNodes(c), 0);
    }

    function maxDepth(node: AgentHierarchyNode, d: number): number {
      if (node.children.length === 0) return d;
      return Math.max(...node.children.map((c) => maxDepth(c, d + 1)));
    }

    return {
      root,
      depth: maxDepth(root, 0),
      totalAgents: countNodes(root),
    };
  }

  // ── Head Manager ─────────────────────────────────────────────

  async function getOrCreateHeadManager(
    options: HeadManagerOptions
  ): Promise<SpawnedAgent> {
    // Check for an existing head manager matching this cwd that ALSO has a
    // live session in this process. The activeSessions check has to be inside
    // the predicate (not after .find) — the agentStore is persistent across
    // process restarts, so without this filter we'd match stale "running"
    // records from previous processes whose sessions are gone, then fall
    // through to spawn() and create a duplicate coordinator.
    const existing = agentStore
      .listAgents({ parent_id: null, state: "running" })
      .find(
        (a) =>
          a.cwd === options.cwd &&
          activeSessions.has(a.id as AgentId),
      );

    if (existing) {
      const sessionEntry = activeSessions.get(existing.id as AgentId)!;
      const storedSession = agentStore.getSession(existing.id as AgentId);
      return {
        id: existing.id as AgentId,
        session_id: storedSession?.session_id ?? sessionEntry.session.id ?? "",
        agent: agentRecordToAgent(existing),
        session: sessionEntry.session,
      };
    }

    return spawn({
      task: "Head manager",
      parent: null,
      cwd: options.cwd,
      permissionMode: options.permissionMode,
      customPrompt: options.systemPrompt,
      role: "coordinator",
      topics: options.topics,
    });
  }

  function listHeadManagers(): Agent[] {
    return agentStore
      .listAgents({ parent_id: null })
      .map(agentRecordToAgent);
  }

  /**
   * Look up the spawned-agent shape for any agent that's still alive in this
   * process (any role, not just coordinators). Returns null if the agent
   * doesn't exist, isn't running, or has no live session in `activeSessions`.
   *
   * Used by the ACP layer to bind a session to a specific agent when the MAP
   * stream targets one explicitly — preserving the routing intent that
   * cwd-based head-manager lookup would otherwise lose in multi-coordinator
   * scenarios.
   */
  function getActiveAgentSession(agentId: AgentId): SpawnedAgent | null {
    if (!activeSessions.has(agentId)) return null;
    const record = agentStore.getAgent(agentId);
    if (!record || record.state !== "running") return null;
    const sessionEntry = activeSessions.get(agentId)!;
    const storedSession = agentStore.getSession(agentId);
    return {
      id: agentId,
      session_id: storedSession?.session_id ?? sessionEntry.session.id ?? "",
      agent: agentRecordToAgent(record),
      session: sessionEntry.session,
    };
  }

  // ── Session Interaction ──────────────────────────────────────

  async function* prompt(
    agentId: AgentId,
    message: string
  ): AsyncIterable<ExtendedSessionUpdate> {
    const activeSession = activeSessions.get(agentId);
    if (!activeSession) {
      throw new AgentManagerError(
        `No active session for agent ${agentId}`,
        "SESSION_NOT_FOUND",
        agentId
      );
    }

    activeSession.isPrompting = true;
    try {
      yield* activeSession.session.prompt(message);
    } finally {
      activeSession.isPrompting = false;
      agentStore.updateAgent(agentId, {
        last_activity_at: Date.now(),
      });
    }
  }

  async function promptUntilDone(
    agentId: AgentId,
    message: string,
    options?: {
      maxFollowUps?: number;
      onUpdate?: (update: ExtendedSessionUpdate) => void;
    }
  ): Promise<{
    doneCalled: boolean;
    doneStatus?: string;
    updates: ExtendedSessionUpdate[];
  }> {
    const maxFollowUps = options?.maxFollowUps ?? 2;
    const allUpdates: ExtendedSessionUpdate[] = [];
    let doneCalled = false;
    let doneStatus: string | undefined;

    let currentMessage = message;

    for (let attempt = 0; attempt <= maxFollowUps; attempt++) {
      for await (const update of prompt(agentId, currentMessage)) {
        allUpdates.push(update);
        options?.onUpdate?.(update);

        // Detect done() tool call from session updates.
        // acp-factory uses { sessionUpdate: "tool_call", title: "mcp__macro-agent__done" }
        const uAny = update as any;

        // Check title field (primary detection)
        if (
          (uAny.sessionUpdate === "tool_call" || uAny.sessionUpdate === "tool_call_update") &&
          typeof uAny.title === "string" &&
          uAny.title.endsWith("__done")
        ) {
          doneCalled = true;
          // Extract status from rawInput (may arrive across multiple updates —
          // first update has rawInput={}, subsequent has full input)
          try {
            const raw = uAny.rawInput;
            const input =
              typeof raw === "string" ? JSON.parse(raw) :
              typeof raw === "object" ? raw :
              uAny.input;
            if (input?.status) {
              doneStatus = input.status;
            }
          } catch {
            // Best effort — rawInput may not be parseable yet
          }
        }

        // Fallback: check older format
        if (
          uAny.type === "result" &&
          uAny.subtype === "tool_result" &&
          uAny.toolName === "done"
        ) {
          doneCalled = true;
          doneStatus = uAny.result?.status;
        }
      }

      if (doneCalled) break;

      if (attempt < maxFollowUps) {
        currentMessage =
          "Please call the done() tool to signal that you have completed your work.";
      }
    }

    // Auto-terminate when done() was called and the handler signaled shouldTerminate.
    // This closes the lifecycle gap: without this, agents stay in "running" state
    // after calling done() because nothing triggers terminate().
    if (doneCalled) {
      const reason = doneStatus === "completed" ? "completed" : (doneStatus ?? "failed");
      try {
        await terminate(agentId, reason as any);
      } catch {
        // Best effort — agent may already be stopping
      }
    }

    return { doneCalled, doneStatus, updates: allUpdates };
  }

  function getSession(agentId: AgentId): Session | null {
    return activeSessions.get(agentId)?.session ?? null;
  }

  function hasActiveSession(agentId: AgentId): boolean {
    return activeSessions.has(agentId);
  }

  function isPrompting(agentId: AgentId): boolean {
    return activeSessions.get(agentId)?.isPrompting ?? false;
  }

  async function supportsInjection(agentId: AgentId): Promise<boolean> {
    const session = activeSessions.get(agentId)?.session;
    if (!session) return false;
    return typeof (session as any).supportsInject === "function"
      ? (session as any).supportsInject()
      : false;
  }

  function isProcessRunning(agentId: AgentId): boolean {
    const session = activeSessions.get(agentId);
    if (!session) return false;
    return typeof (session as any).handle?.isRunning === "function"
      ? (session as any).handle.isRunning()
      : true;
  }

  function respondToPermission(
    agentId: AgentId,
    requestId: string,
    optionId: string
  ): boolean {
    const session = activeSessions.get(agentId)?.session;
    if (!session) return false;
    return (session as any).respondToPermission?.(requestId, optionId) ?? false;
  }

  function cancelPermission(agentId: AgentId, requestId: string): boolean {
    const session = activeSessions.get(agentId)?.session;
    if (!session) return false;
    return (session as any).cancelPermission?.(requestId) ?? false;
  }

  function setPermissionMode(
    agentId: AgentId,
    mode: PermissionMode
  ): boolean {
    const session = activeSessions.get(agentId);
    if (!session) return false;
    if (typeof (session.handle as any).setPermissionMode === "function") {
      (session.handle as any).setPermissionMode(mode);
      return true;
    }
    return false;
  }

  function getPermissionMode(agentId: AgentId): PermissionMode | null {
    const session = activeSessions.get(agentId);
    if (!session) return null;
    return typeof (session.handle as any).getPermissionMode === "function"
      ? (session.handle as any).getPermissionMode()
      : null;
  }

  // ── Lifecycle Callbacks ──────────────────────────────────────

  function onLifecycleEvent(
    callback: AgentLifecycleCallback
  ): () => void {
    lifecycleListeners.add(callback);
    return () => lifecycleListeners.delete(callback);
  }

  function setSpawnInterceptorFn(
    interceptor: SpawnInterceptor | null
  ): void {
    spawnInterceptor = interceptor;
  }

  function getRoleRegistry(): RoleRegistry {
    return roleRegistry;
  }

  // ── Legacy stubs ─────────────────────────────────────────────
  // These methods exist for backward compatibility but are no-ops
  // since messaging and task management are now in subsystems.

  function setOpenTasksSocketPath(_socketPath: string): void {
    // No-op: opentasks client auto-discovers socket
  }

  function setMapServerUrl(url: string): void {
    mapServerUrl = url;
  }

  function setIntegrationConfigs(configs: {
    minimem?: typeof minimemConfig;
    skilltree?: typeof skilltreeConfig;
    sessionlog?: typeof sessionlogConfig;
  }): void {
    if (configs.minimem) minimemConfig = configs.minimem;
    if (configs.skilltree) skilltreeConfig = configs.skilltree;
    if (configs.sessionlog) sessionlogConfig = configs.sessionlog;
  }

  function setSkillLoadout(role: string, content: string): void {
    skillLoadouts.set(role, content);
  }

  function setSidecar(sidecar: { connected: boolean; reportCheckpoint(cp: any): Promise<any> } | null): void {
    sidecarRef = sidecar;
  }

  function setTopologyPolicyFn(
    policy: import('../workspace/topology/types.js').TopologyPolicy | null
  ): void {
    topologyPolicy = policy;
  }

  function setMailServices(): void {
    // No-op: agent-inbox handles conversation tracking
  }

  // ── Cleanup ──────────────────────────────────────────────────

  async function close(): Promise<void> {
    isShuttingDown = true;

    for (const [agentId, session] of activeSessions) {
      try {
        await session.handle.close();
      } catch {
        /* ignore */
      }
      agentStore.updateAgent(agentId, {
        state: "stopped",
        stop_reason: "cancelled",
        stopped_at: Date.now(),
      });
    }
    activeSessions.clear();
    agentWorkspaces.clear();
    lifecycleListeners.clear();

    // Note: isShuttingDown stays true after close() to prevent further spawns
  }

  // ── Return AgentManager interface ────────────────────────────

  return {
    spawn,
    terminate,
    resume,
    continueAgent,
    forkAgent,
    get,
    list,
    getChildren,
    getHierarchy,
    getOrCreateHeadManager,
    listHeadManagers,
    getActiveAgentSession,
    prompt,
    promptUntilDone,
    getSession,
    hasActiveSession,
    isPrompting,
    supportsInjection,
    isProcessRunning,
    respondToPermission,
    cancelPermission,
    setPermissionMode,
    getPermissionMode,
    onLifecycleEvent,
    setSpawnInterceptor: setSpawnInterceptorFn,
    getRoleRegistry,
    setOpenTasksSocketPath,
    setMapServerUrl,
    setIntegrationConfigs,
    setSkillLoadout,
    setSidecar,
    setTopologyPolicy: setTopologyPolicyFn,
    setMailServices,
    close,
  } as AgentManager;
}
