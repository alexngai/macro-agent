/**
 * AgentManager - Service for managing agent lifecycle and sessions
 *
 * Integrates:
 * - acp-factory for Claude Code process/session management
 * - EventStore for persistent agent state
 * - MessageRouter for subscription setup
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
import type { EventStore } from "../store/event-store.js";
import type { MessageRouter } from "../router/message-router.js";
import type {
  Agent,
  AgentId,
  TaskId,
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
  AgentConfig,
  ContinueAgentOptions,
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
import type { HealthCheckService } from "../monitor/health-check-service.js";
import { AgentTokenManager } from "../auth/token.js";

// ─────────────────────────────────────────────────────────────────
// Helper Functions
// ─────────────────────────────────────────────────────────────────

/**
 * Map a child role name to the required spawn capability.
 * Handles subroles like "worker.resolver" by checking base role.
 */
function getSpawnCapability(childRole: string): Capability {
  // Extract base role (e.g., "worker.resolver" -> "worker")
  const baseRole = childRole.split(".")[0];

  switch (baseRole) {
    case "worker":
      return AGENT_CAPABILITIES.SPAWN_WORKER;
    case "integrator":
      return AGENT_CAPABILITIES.SPAWN_INTEGRATOR;
    case "monitor":
      return AGENT_CAPABILITIES.SPAWN_MONITOR;
    case "coordinator":
      // Coordinators require special handling - typically only other coordinators
      // or system-level agents can spawn coordinators
      return AGENT_CAPABILITIES.SPAWN_CUSTOM;
    default:
      // For team-defined roles (e.g., "grinder"), return the specific capability
      // (e.g., "agent.spawn.grinder"). The spawn check also accepts
      // "agent.spawn.custom" as a generic fallback.
      return `agent.spawn.${childRole}` as Capability;
  }
}

// ─────────────────────────────────────────────────────────────────
// AgentManager Interface
// ─────────────────────────────────────────────────────────────────

export interface AgentManager {
  // ── Lifecycle ──────────────────────────────────────────────────

  /**
   * Spawn a new agent with the given options.
   * Creates the acp-factory session and emits spawn event.
   */
  spawn(options: SpawnAgentOptions): Promise<SpawnedAgent>;

  /**
   * Terminate an agent and clean up its session.
   * Emits terminate event and updates task status if assigned.
   */
  terminate(agentId: AgentId, reason: AgentStopReason): Promise<void>;

  /**
   * Resume a stopped agent by loading its existing session.
   * @param permissionMode - Optional permission mode override (defaults to the agent manager's default)
   */
  resume(
    agentId: AgentId,
    permissionMode?: PermissionMode,
  ): Promise<SpawnedAgent>;

  /**
   * Continue a terminated agent by spawning a new agent with the same
   * role and task, injecting the prior conversation context as a
   * resume prefix in the system prompt.
   *
   * @param agentId - ID of the agent to continue
   * @param options - Continuation options
   * @returns The newly spawned continuation agent
   */
  continueAgent(
    agentId: AgentId,
    options?: ContinueAgentOptions,
  ): Promise<SpawnedAgent>;

  /**
   * Fork an agent's session, creating a new agent with the same
   * conversation history. Uses forkWithFlush for active sessions
   * or loadSession for stopped agents with persisted sessions.
   *
   * @param sourceAgentId - ID of the agent to fork from
   * @param options - Fork options (name, prompt, cwd)
   */
  forkAgent(
    sourceAgentId: AgentId,
    options?: { name?: string; prompt?: string; cwd?: string },
  ): Promise<SpawnedAgent>;

  // ── Queries ────────────────────────────────────────────────────

  /**
   * Get agent by ID from materialized view.
   */
  get(agentId: AgentId): Agent | null;

  /**
   * List agents with optional filters.
   */
  list(filter?: AgentFilter): Agent[];

  /**
   * Get direct children of an agent.
   */
  getChildren(agentId: AgentId): Agent[];

  /**
   * Get full hierarchy tree starting from an agent.
   * @param options.depth - Maximum depth to traverse (undefined = full tree)
   */
  getHierarchy(
    agentId: AgentId,
    options?: HierarchyOptions,
  ): AgentHierarchy | null;

  // ── Head Manager ───────────────────────────────────────────────

  /**
   * Get or create a head manager for the given workspace.
   * Head managers are root agents with no parent.
   */
  getOrCreateHeadManager(options: HeadManagerOptions): Promise<SpawnedAgent>;

  /**
   * List all head managers.
   */
  listHeadManagers(): Agent[];

  // ── Session Interaction ────────────────────────────────────────

  /**
   * Send a prompt to an agent and stream responses.
   */
  prompt(
    agentId: AgentId,
    message: string,
  ): AsyncIterable<ExtendedSessionUpdate>;

  /**
   * Send a prompt to an agent and automatically follow up to ensure done() is called.
   * Returns when the agent calls done() or after maxFollowUps attempts.
   *
   * @param agentId - Agent ID to prompt
   * @param message - Initial prompt message
   * @param options - Follow-up options
   * @returns Result indicating whether done() was called
   */
  promptUntilDone(
    agentId: AgentId,
    message: string,
    options?: {
      /** Maximum number of follow-up prompts (default: 2) */
      maxFollowUps?: number;
      /** Callback for each update during prompting */
      onUpdate?: (update: ExtendedSessionUpdate) => void;
    },
  ): Promise<{
    doneCalled: boolean;
    doneStatus?: string;
    updates: ExtendedSessionUpdate[];
  }>;

  /**
   * Get the active session for an agent.
   */
  getSession(agentId: AgentId): Session | null;

  /**
   * Check if an agent has an active session.
   */
  hasActiveSession(agentId: AgentId): boolean;

  /**
   * Check if an agent is currently processing a prompt.
   * Returns false if no session or session is idle.
   */
  isPrompting(agentId: AgentId): boolean;

  /**
   * Check if an agent's session supports context injection.
   * Returns false if no session or injection not supported.
   */
  supportsInjection(agentId: AgentId): Promise<boolean>;

  /**
   * Check if an agent's underlying process is still running.
   * Returns false if no session or process has exited.
   */
  isProcessRunning(agentId: AgentId): boolean;

  // ── Permission Handling ─────────────────────────────────────────

  /**
   * Respond to a permission request for an agent's session.
   * Used when running in interactive permission mode.
   *
   * @param agentId - Agent ID whose session has the pending permission
   * @param requestId - The permission request ID
   * @param optionId - The selected option ID (e.g., 'allow_once')
   * @returns true if permission was found and responded to
   */
  respondToPermission(
    agentId: AgentId,
    requestId: string,
    optionId: string,
  ): boolean;

  /**
   * Cancel a permission request for an agent's session.
   *
   * @param agentId - Agent ID whose session has the pending permission
   * @param requestId - The permission request ID
   * @returns true if permission was found and cancelled
   */
  cancelPermission(agentId: AgentId, requestId: string): boolean;

  /**
   * Change the permission mode for a running agent at runtime.
   * Takes effect on the next permission request.
   *
   * @param agentId - Agent ID to change permission mode for
   * @param mode - New permission mode
   * @returns true if the mode was changed successfully
   */
  setPermissionMode(agentId: AgentId, mode: PermissionMode): boolean;

  /**
   * Get the current permission mode for a running agent.
   *
   * @param agentId - Agent ID to query
   * @returns The current permission mode, or null if no active session
   */
  getPermissionMode(agentId: AgentId): PermissionMode | null;

  // ── Lifecycle Callbacks ────────────────────────────────────────

  /**
   * Register a callback for agent lifecycle events.
   */
  onLifecycleEvent(callback: AgentLifecycleCallback): () => void;

  // ── Team Integration ─────────────────────────────────────────

  /**
   * Set a spawn interceptor that transforms SpawnAgentOptions before spawning.
   * Used by TeamRuntime to inject team topics, prompts, MCP servers, and env vars.
   */
  setSpawnInterceptor(interceptor: SpawnInterceptor | null): void;

  /**
   * Get the RoleRegistry used by this AgentManager.
   */
  getRoleRegistry(): RoleRegistry;

  // ── Mail Services (Late Binding) ─────────────────────────────

  /**
   * Set mail services for conversation tracking.
   * Used for late binding when mailService is created after AgentManager.
   */
  setMailServices(
    mailService: import("../mail/mail-service.js").MailService,
    conversationMap: import("../mail/conversation-map.js").ConversationMap,
  ): void;

  // ── Cleanup ────────────────────────────────────────────────────

  /**
   * Close all active sessions and clean up resources.
   */
  close(): Promise<void>;
}

// ─────────────────────────────────────────────────────────────────
// AgentManager Configuration
// ─────────────────────────────────────────────────────────────────

export interface AgentManagerConfig {
  /** Default permission mode for spawned agents */
  defaultPermissionMode?: PermissionMode;

  /** Default agent type (defaults to "claude-code") */
  defaultAgentType?: string;

  /** Default working directory */
  defaultCwd?: string;

  /**
   * Optional WorkspaceManager for workspace isolation.
   * When provided, agents with workspace-enabled roles will get
   * isolated git worktrees.
   */
  workspaceManager?: WorkspaceManager;

  /**
   * Optional RoleRegistry for capability enforcement.
   * When provided, spawn operations will check if the parent agent
   * has the required capability to spawn the requested child role.
   * Defaults to DefaultRoleRegistry if not provided.
   */
  roleRegistry?: RoleRegistry;

  /**
   * Optional HealthCheckService for monitoring coordinator health.
   * When provided, health checks will automatically start/stop
   * with coordinator agent lifecycle.
   */
  healthCheckService?: HealthCheckService;

  /**
   * Optional MailService for conversation tracking.
   * When provided, spawn creates task conversations and terminate closes them.
   */
  mailService?: import("../mail/mail-service.js").MailService;

  /**
   * Optional ConversationMap for agent-to-conversation tracking.
   * Required when mailService is provided.
   */
  conversationMap?: import("../mail/conversation-map.js").ConversationMap;

  /**
   * Optional server URL for MCP thin-client mode.
   * When set, spawned agents use ephemeral MAP WebSocket calls instead
   * of creating local service stacks.
   */
  serverUrl?: string;

  /**
   * Server authentication token for MCP thin-client connections.
   * Passed to spawned agents as MACRO_SERVER_TOKEN env var.
   */
  serverToken?: string;

  /**
   * Per-agent token manager for MCP bridge authentication.
   * When provided, generates a unique token per agent at spawn time
   * and revokes it on terminate.
   */
  agentTokenManager?: AgentTokenManager;

  /**
   * Task backend type to propagate to child MCP subprocesses.
   * Sourced from merged config. Falls back to MACRO_TASK_BACKEND env var.
   */
  taskBackend?: string;

  /**
   * OpenTasks socket path to propagate to child MCP subprocesses.
   * Sourced from merged config. Falls back to OPENTASKS_SOCKET_PATH env var.
   */
  openTasksSocketPath?: string;
}

// ─────────────────────────────────────────────────────────────────
// Spawn Interceptor
// ─────────────────────────────────────────────────────────────────

/**
 * Function that transforms SpawnAgentOptions before an agent is spawned.
 * Used by TeamRuntime to inject team-specific configuration.
 */
export type SpawnInterceptor = (
  options: SpawnAgentOptions,
) => SpawnAgentOptions | Promise<SpawnAgentOptions>;

// ─────────────────────────────────────────────────────────────────
// AgentManager Implementation
// ─────────────────────────────────────────────────────────────────

export function createAgentManager(
  eventStore: EventStore,
  messageRouter: MessageRouter,
  config: AgentManagerConfig = {},
): AgentManager {
  const {
    defaultPermissionMode = "auto-approve",
    defaultAgentType = "claude-code",
    defaultCwd = process.cwd(),
    workspaceManager,
    roleRegistry = new DefaultRoleRegistry(),
    healthCheckService,
    mailService: initialMailService,
    conversationMap: initialConversationMap,
    serverUrl,
    serverToken,
    agentTokenManager,
    taskBackend: configTaskBackend,
    openTasksSocketPath: configOpenTasksSocketPath,
  } = config;

  // Mutable mail services (support late binding via setMailServices)
  let mailService = initialMailService;
  let conversationMap = initialConversationMap;

  // Mutable spawn interceptor (set by TeamRuntime)
  let spawnInterceptor: SpawnInterceptor | null = null;

  // Active sessions tracked in memory
  const activeSessions = new Map<AgentId, ActiveSession>();

  // Agent workspace mappings (agentId → workspace)
  const agentWorkspaces = new Map<AgentId, Workspace>();

  // Lifecycle event listeners
  const lifecycleListeners = new Set<AgentLifecycleCallback>();

  // Shutdown guard — prevents spawns during close()
  let isShuttingDown = false;

  // ─────────────────────────────────────────────────────────────────
  // MCP Server Config
  // ─────────────────────────────────────────────────────────────────

  /**
   * Build the macro-agent MCP server config for a Claude Code agent session.
   * Used by spawn(), resume(), and forkAgent() to ensure every agent gets
   * access to the macro-agent coordination tools.
   */
  function buildMacroAgentMcp(opts: {
    agentId: string;
    parentId: string;
    taskId: string;
    cwd: string;
    permissionMode: string;
    lineage?: string[];
    sessionId?: string;
  }) {
    // Common env vars for both thin-client and legacy modes
    const env = [
      { name: "MACRO_AGENT_ID", value: opts.agentId },
      { name: "MACRO_PARENT_ID", value: opts.parentId },
      { name: "MACRO_TASK_ID", value: opts.taskId },
      { name: "MACRO_AGENT_CWD", value: opts.cwd },
      { name: "MACRO_PERMISSION_MODE", value: opts.permissionMode },
      {
        name: "MACRO_TASK_BACKEND",
        value: configTaskBackend ?? process.env.MACRO_TASK_BACKEND ?? "",
      },
      {
        name: "OPENTASKS_SOCKET_PATH",
        value: configOpenTasksSocketPath ?? process.env.OPENTASKS_SOCKET_PATH ?? "",
      },
    ];

    if (serverUrl) {
      // Thin-client mode: forward tool calls to main server via MAP WebSocket
      env.push(
        { name: "MACRO_SERVER_URL", value: serverUrl },
        {
          name: "MACRO_AGENT_LINEAGE",
          value: JSON.stringify(opts.lineage ?? []),
        },
        { name: "MACRO_SESSION_ID", value: opts.sessionId ?? "" },
      );

      // Auth tokens for thin-client connections
      if (serverToken) {
        env.push({ name: "MACRO_SERVER_TOKEN", value: serverToken });
      }
      if (agentTokenManager) {
        const agentToken = agentTokenManager.createToken(opts.agentId);
        env.push({ name: "MACRO_AGENT_TOKEN", value: agentToken });
      }
    } else {
      // Legacy mode: create local service stack with shared SQLite
      env.push(
        { name: "MACRO_INSTANCE_ID", value: eventStore.instanceId },
        { name: "MACRO_BASE_DIR", value: eventStore.baseDir },
      );
    }

    return {
      name: "macro-agent",
      command: "npx",
      args: ["multiagent-mcp"],
      env,
    };
  }

  // ─────────────────────────────────────────────────────────────────
  // Lifecycle
  // ─────────────────────────────────────────────────────────────────

  async function spawn(rawOptions: SpawnAgentOptions): Promise<SpawnedAgent> {
    if (isShuttingDown) {
      throw new AgentManagerError(
        "Cannot spawn agent during shutdown",
        "SHUTDOWN_IN_PROGRESS",
      );
    }

    // Apply spawn interceptor if set (used by TeamRuntime for team context injection)
    const options = spawnInterceptor
      ? await spawnInterceptor(rawOptions)
      : rawOptions;

    const {
      task,
      task_id,
      parent,
      cwd = defaultCwd,
      permissionMode = defaultPermissionMode,
      subscribeParent = true,
      topics = [],
      config: agentConfig,
      agentType = defaultAgentType,
      customPrompt,
      interactionPatterns,
      // Workspace-related fields (Phase 2)
      role,
      streamId,
      streamConfig,
      dataplaneTaskId,
    } = options;

    // Generate IDs upfront (including session_id so we can persist before starting MCP)
    const agentId = `agent_${nanoid(12)}`;
    const taskId = task_id ?? `task_${nanoid(12)}`;
    const sessionId = `session_${nanoid(12)}`;

    // Validate parent exists if specified
    if (parent) {
      const parentAgent = eventStore.getAgent(parent);
      if (!parentAgent) {
        throw new AgentManagerError(
          `Parent agent not found: ${parent}`,
          "AGENT_NOT_FOUND",
          parent,
        );
      }

      // Check spawn capability
      const childRole = role ?? "worker";
      const requiredCapability = getSpawnCapability(childRole);
      const parentRole = parentAgent.role ?? "worker";

      // Accept either the specific capability (e.g., agent.spawn.grinder)
      // or the generic agent.spawn.custom as a fallback for non-built-in roles
      const hasSpecific = roleRegistry.hasCapability(
        parentRole,
        requiredCapability,
      );
      const hasGeneric =
        requiredCapability !== AGENT_CAPABILITIES.SPAWN_CUSTOM &&
        roleRegistry.hasCapability(parentRole, AGENT_CAPABILITIES.SPAWN_CUSTOM);

      if (!hasSpecific && !hasGeneric) {
        throw new AgentManagerError(
          `Parent agent with role '${parentRole}' does not have capability to spawn '${childRole}' agents. ` +
            `Required capability: ${requiredCapability}`,
          "CAPABILITY_DENIED",
          parent,
        );
      }
    }

    // Build system prompt context
    const parentAgent = parent ? eventStore.getAgent(parent) : null;
    const promptContext: SystemPromptContext = {
      agentId,
      task,
      taskId,
      parentId: parent ?? null,
      isHeadManager: !parent,
      lineage: parentAgent?.lineage ? [...parentAgent.lineage, parent!] : [],
      role: role ?? "worker",
      mcpTools: [
        "done", // Listed first - most important tool for completion
        "spawn_agent",
        "emit_status",
        "send_message",
        "check_messages",
        "get_hierarchy",
        "get_agent_summary",
        "stop_agent",
        "create_task",
        "get_task",
      ],
    };

    let systemPrompt = generateSystemPrompt(promptContext);

    // Append role prompt: team customPrompt takes precedence over resolvedRole.systemPrompt
    const resolvedRole = roleRegistry.resolveRole(role ?? "worker");
    if (customPrompt) {
      systemPrompt += `\n\n# Role Instructions\n\n${customPrompt}`;
    } else if (resolvedRole.systemPrompt) {
      systemPrompt += `\n\n# Role-Specific Instructions\n\n${resolvedRole.systemPrompt}`;
    }

    // Append team interaction pattern sections (pull mode, trunk integration, etc.)
    if (interactionPatterns && interactionPatterns.length > 0) {
      for (const pattern of interactionPatterns) {
        systemPrompt += `\n\n${pattern}`;
      }
    }

    eventStore.emit({
      type: "spawn",
      source: { agent_id: parent ?? "system" },
      payload: {
        agent_id: agentId,
        session_id: sessionId,
        task,
        task_id: taskId,
        parent: parent ?? null,
        role: role ?? undefined,
        config: agentConfig ?? {},
        cwd,
      },
    });

    // Generate a human-readable default name
    const generatedName = uniqueNamesGenerator({
      dictionaries: [adjectives, animals],
      separator: "-",
      length: 2,
    });
    eventStore.updateAgentMetadata(agentId as AgentId, { name: generatedName });

    // Persist immediately so MCP server subprocess can read the agent
    await eventStore.persist();

    // Verify the agent is now in the store
    const verifyAgent = eventStore.getAgent(agentId);
    const allAgents = eventStore.listAgents();
    console.error(
      `[AgentManager] After persist: agent ${agentId} exists = ${!!verifyAgent}, total agents = ${allAgents.length}, instancePath = ${eventStore.instancePath}`,
    );
    console.error(
      `[AgentManager] All agent IDs: ${allAgents.map((a) => a.id).join(", ")}`,
    );

    try {
      // Spawn agent process via acp-factory
      const handle = await AgentFactory.spawn(agentType, {
        permissionMode,
        env: agentConfig?.env,
      });

      try {
        const macroAgentMcp = buildMacroAgentMcp({
          agentId,
          parentId: parent ?? "",
          taskId,
          cwd,
          permissionMode,
          lineage: parentAgent?.lineage
            ? [...parentAgent.lineage, parent!]
            : [],
          sessionId,
        });

        // Combine with any user-provided MCP servers
        // Note: Like macroAgentMcp, user MCP servers use stdio (no 'type' field)
        const userMcpServers =
          agentConfig?.mcpServers?.map((s) => ({
            name: s.name,
            command: s.command,
            args: s.args ?? [],
            env: s.env
              ? Object.entries(s.env).map(([name, value]) => ({ name, value }))
              : [],
          })) ?? [];

        // Create session with MCP servers
        // Note: The MCP server subprocess will start here and look for the agent
        // in EventStore. We already persisted the spawn event above.
        //
        // When permissionMode is "interactive", we strip settingSources so that
        // the Claude Code subprocess doesn't read pre-approved tool rules from
        // the user's ~/.claude/settings.local.json. This ensures ALL tool calls
        // go through the canUseTool → requestPermission ACP flow.
        const agentMeta =
          permissionMode === "interactive"
            ? { claudeCode: { options: { settingSources: [] } } }
            : undefined;
        const session = await handle.createSession(cwd, {
          mcpServers: [macroAgentMcp, ...userMcpServers],
          ...(agentMeta && { agentMeta }),
        });

        // Emit started status (session is ready)
        // Include the provider's session ID (e.g., Claude Code UUID) so
        // it can be used for handle.loadSession() during resume
        eventStore.emit({
          type: "status",
          source: { agent_id: agentId },
          payload: {
            status_type: "started",
            summary: "Agent session started",
            provider_session_id: session.id,
          },
        });

        // Persist the status event
        await eventStore.persist();

        // Set up default subscriptions via MessageRouter
        messageRouter.setupDefaultSubscriptions({
          agent_id: agentId,
          parent_id: parent ?? undefined,
          task_id: taskId,
          subscribe_parent: subscribeParent,
          additional_topics: topics,
          role: role ?? undefined,
        });

        // ─────────────────────────────────────────────────────────────────
        // Mail: Create task conversation for this agent
        // ─────────────────────────────────────────────────────────────────
        if (mailService && conversationMap) {
          try {
            const parentConversationId = parent
              ? (conversationMap.getAgentConversation(parent) ??
                conversationMap.getSessionConversation(parent))
              : undefined;

            const { conversationId: taskConvId } =
              mailService.createConversation({
                type: "task",
                subject: task?.slice(0, 80),
                createdBy: parent ?? agentId,
                parentConversationId: parentConversationId,
              });

            // Join parent and child as participants
            if (parent) {
              mailService.joinConversation({
                conversationId: taskConvId,
                participantId: parent,
                participantType: "agent",
                role: "initiator",
                agentId: parent,
              });
            }
            mailService.joinConversation({
              conversationId: taskConvId,
              participantId: agentId,
              participantType: "agent",
              role: "worker",
              agentId,
            });

            conversationMap.setAgentConversation(agentId, taskConvId);
          } catch (err) {
            // Never fail spawn due to mail errors
            console.warn(
              `[AgentManager] Failed to create task conversation for ${agentId}:`,
              err,
            );
          }
        }

        // Track active session
        const activeSession: ActiveSession = {
          agentId,
          handle,
          session,
          createdAt: Date.now(),
          isPrompting: false,
        };
        activeSessions.set(agentId, activeSession);

        // Get the agent from materialized view
        const agent = eventStore.getAgent(agentId)!;

        // ─────────────────────────────────────────────────────────────────
        // Workspace Creation (Phase 2)
        // ─────────────────────────────────────────────────────────────────
        let workspace: Workspace | undefined;
        let resolvedStreamId = streamId;

        if (workspaceManager && role) {
          try {
            workspace = await createWorkspaceForRole(
              workspaceManager,
              agentId,
              role,
              {
                streamId,
                streamConfig,
                dataplaneTaskId,
                cwd,
              },
            );

            if (workspace) {
              agentWorkspaces.set(agentId, workspace);
              resolvedStreamId = workspace.streamId;

              // Register with parent coordinator if applicable
              if (parent && (role === "worker" || role === "integrator")) {
                const parentWorkspace = agentWorkspaces.get(parent);
                if (parentWorkspace?.role === "coordinator") {
                  workspaceManager.registerChildWorkspace(
                    parent,
                    agentId,
                    workspace.path,
                  );
                }
              }
            }
          } catch (wsError) {
            console.error(
              `[AgentManager] Failed to create workspace for ${agentId}: ${wsError}`,
            );
            // Continue without workspace - don't fail the spawn
          }
        }

        // Notify lifecycle listeners
        notifyLifecycle({ type: "spawned", agent });
        notifyLifecycle({ type: "started", agent });

        // Start health monitoring for coordinators
        if (healthCheckService && role === "coordinator") {
          healthCheckService.startForCoordinator(agentId);
        }

        return {
          id: agentId,
          session_id: sessionId, // Macro-agent's own session ID for ACP protocol mapping
          agent,
          session,
          workspace,
          streamId: resolvedStreamId,
        };
      } catch (handleError) {
        // Close the spawned process to prevent orphaning
        try {
          await handle.close();
        } catch {
          // Ignore errors during cleanup
        }
        throw handleError;
      }
    } catch (error) {
      // Clean up the spawn event we already emitted
      eventStore.emit({
        type: "stop",
        source: { agent_id: agentId },
        payload: {
          reason: "failed",
        },
      });
      await eventStore.persist();

      throw new AgentManagerError(
        `Failed to spawn agent: ${error}`,
        "SPAWN_FAILED",
        agentId,
      );
    }
  }

  async function terminate(
    agentId: AgentId,
    reason: AgentStopReason,
  ): Promise<void> {
    const agent = eventStore.getAgent(agentId);
    if (!agent) {
      throw new AgentManagerError(
        `Agent not found: ${agentId}`,
        "AGENT_NOT_FOUND",
        agentId,
      );
    }

    // Close active session if exists
    const activeSession = activeSessions.get(agentId);
    if (activeSession) {
      try {
        await activeSession.handle.close();
      } catch {
        // Ignore errors during cleanup
      }
      activeSessions.delete(agentId);
    }

    // Stop health monitoring for coordinators
    if (healthCheckService && agent.role === "coordinator") {
      healthCheckService.stopForCoordinator(agentId);
    }

    // ─────────────────────────────────────────────────────────────────
    // Workspace Cleanup (Phase 2)
    // ─────────────────────────────────────────────────────────────────
    if (workspaceManager && agentWorkspaces.has(agentId)) {
      try {
        workspaceManager.deallocateWorkspace(agentId);
        agentWorkspaces.delete(agentId);
      } catch (wsError) {
        console.error(
          `[AgentManager] Failed to deallocate workspace for ${agentId}: ${wsError}`,
        );
        // Continue with termination even if workspace cleanup fails
      }
    }

    // Revoke agent authentication token
    if (agentTokenManager) {
      agentTokenManager.revokeToken(agentId);
    }

    // ─────────────────────────────────────────────────────────────────
    // Mail: Close task conversation on terminate
    // ─────────────────────────────────────────────────────────────────
    if (mailService && conversationMap) {
      try {
        const convId = conversationMap.getAgentConversation(agentId);
        if (convId) {
          mailService.closeConversation({
            conversationId: convId,
            closedBy: agentId,
            reason: reason === "completed" ? "completed" : "failed",
          });
        }
        // Close any peer conversations
        const peerConvIds = conversationMap.closePeerConversationsFor(agentId);
        for (const peerConvId of peerConvIds) {
          mailService.closeConversation({
            conversationId: peerConvId,
            closedBy: agentId,
            reason: "participant_left",
          });
        }
        conversationMap.removeAgent(agentId);
      } catch (err) {
        console.warn(
          `[AgentManager] Failed to close conversation for ${agentId}:`,
          err,
        );
      }
    }

    // Emit stop event
    eventStore.emit({
      type: "stop",
      source: { agent_id: agentId },
      payload: {
        agent_id: agentId,
        reason,
      },
    });

    // If agent had a task, update task status based on reason
    if (agent.task_id) {
      const taskStatus =
        reason === "completed"
          ? "completed"
          : reason === "failed"
            ? "failed"
            : "pending";

      eventStore.emit({
        type: "task",
        source: { agent_id: agentId },
        payload: {
          task_id: agent.task_id,
          action: reason === "completed" ? "completed" : "status_change",
          details: { status: taskStatus },
        },
      });
    }

    // Persist events to SQLite for cross-process visibility
    await eventStore.persist();

    // Notify lifecycle listeners
    const updatedAgent = eventStore.getAgent(agentId)!;
    notifyLifecycle({ type: "stopped", agent: updatedAgent, reason });

    // Terminate child agents when parent stops (always cascade)
    // Use change consolidation to merge child branches back to parent before terminating
    const children = getChildren(agentId);
    const parentWorkspace = agentWorkspaces.get(agentId);

    for (const child of children) {
      if (child.state === "running" || child.state === "spawning") {
        // Create workspace provider for change consolidation
        const workspaceProvider: WorkspaceProvider | undefined = parentWorkspace
          ? {
              getWorkspace: (id: AgentId) => agentWorkspaces.get(id) ?? null,
            }
          : undefined;

        // Create cascade adapter for termination
        const cascadeAdapter: CascadeAgentManager = {
          getChildren: (id) =>
            getChildren(id).map((c) => ({
              id: c.id,
              state: c.state,
              parent: c.parent,
            })),
          terminate: async (id, terminateReason) => {
            await terminate(id, terminateReason as AgentStopReason);
          },
        };

        // Use terminateWithChangeConsolidation to merge changes before terminating
        await terminateWithChangeConsolidation(
          child.id,
          agentId,
          cascadeAdapter,
          workspaceProvider,
        );
      }
    }
  }

  async function resume(
    agentId: AgentId,
    overridePermissionMode?: PermissionMode,
  ): Promise<SpawnedAgent> {
    if (isShuttingDown) {
      throw new AgentManagerError(
        "Cannot resume agent during shutdown",
        "SHUTDOWN_IN_PROGRESS",
        agentId,
      );
    }

    const agent = eventStore.getAgent(agentId);
    if (!agent) {
      throw new AgentManagerError(
        `Agent not found: ${agentId}`,
        "AGENT_NOT_FOUND",
        agentId,
      );
    }

    // Check if already running
    if (activeSessions.has(agentId)) {
      throw new AgentManagerError(
        `Agent already has active session: ${agentId}`,
        "ALREADY_RUNNING",
        agentId,
      );
    }

    const permissionMode = overridePermissionMode ?? defaultPermissionMode;

    // Spawn new process
    const handle = await AgentFactory.spawn(defaultAgentType, {
      permissionMode,
    });

    try {
      const agentCwd = agent.cwd ?? defaultCwd;
      let session;

      // When interactive mode, strip settings to prevent auto-approval
      const resumeAgentMeta =
        permissionMode === "interactive"
          ? { claudeCode: { options: { settingSources: [] } } }
          : undefined;

      const macroAgentMcp = buildMacroAgentMcp({
        agentId,
        parentId: agent.parent ?? "",
        taskId: agent.task_id ?? "",
        cwd: agentCwd,
        permissionMode,
        lineage: agent.lineage ?? [],
        sessionId: agent.session_id ?? "",
      });
      const mcpServers = [macroAgentMcp];

      if (agent.provider_session_id) {
        // Load existing session using the provider's session ID (e.g., Claude Code UUID)
        // Note: loadSession's TS type for mcpServers is { name, uri }[] but
        // the underlying ACP protocol accepts full McpServerStdio. The JS
        // implementation passes mcpServers through to the connection unchanged.
        session = await handle.loadSession(
          agent.provider_session_id,
          agentCwd,
          mcpServers as any,
          resumeAgentMeta ? { agentMeta: resumeAgentMeta } : undefined,
        );
      } else {
        // No provider session ID available (agent predates this feature or wasn't persisted).
        // Create a new session instead of loading with the macro-agent session_id
        // which is not a valid provider session ID (e.g., Claude Code expects UUIDs).
        session = await handle.createSession(agentCwd, {
          mcpServers,
          ...(resumeAgentMeta && { agentMeta: resumeAgentMeta }),
        });

        // Store the provider session ID for future resumes
        eventStore.emit({
          type: "status",
          source: { agent_id: agentId },
          payload: {
            status_type: "started",
            summary: "Agent session created (no provider session to resume)",
            provider_session_id: session.id,
          },
        });
      }

      // Track active session
      const activeSession: ActiveSession = {
        agentId,
        handle,
        session,
        createdAt: Date.now(),
        isPrompting: false,
      };
      activeSessions.set(agentId, activeSession);

      // Emit status event for resume
      eventStore.emit({
        type: "status",
        source: { agent_id: agentId },
        payload: {
          status_type: "started",
          summary: "Agent session resumed",
          provider_session_id: session.id,
        },
      });

      return {
        id: agentId,
        session_id: agent.session_id, // Macro-agent's own session ID
        agent: eventStore.getAgent(agentId)!,
        session,
      };
    } catch (handleError) {
      // Close the spawned process to prevent orphaning
      try {
        await handle.close();
      } catch {
        // Ignore errors during cleanup
      }
      throw handleError;
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // Fork
  // ─────────────────────────────────────────────────────────────────

  async function forkAgent(
    sourceAgentId: AgentId,
    options?: { name?: string; prompt?: string; cwd?: string },
  ): Promise<SpawnedAgent> {
    if (isShuttingDown) {
      throw new AgentManagerError(
        "Cannot fork agent during shutdown",
        "SHUTDOWN_IN_PROGRESS",
        sourceAgentId,
      );
    }

    const sourceAgent = eventStore.getAgent(sourceAgentId);
    if (!sourceAgent) {
      throw new AgentManagerError(
        `Agent not found: ${sourceAgentId}`,
        "AGENT_NOT_FOUND",
        sourceAgentId,
      );
    }

    // Need either an active session or a persisted provider_session_id
    const activeSession = activeSessions.get(sourceAgentId);
    if (!activeSession && !sourceAgent.provider_session_id) {
      throw new AgentManagerError(
        `Agent has no session to fork: ${sourceAgentId}`,
        "FORK_NOT_SUPPORTED",
        sourceAgentId,
      );
    }

    // Generate new IDs
    const agentId = `agent_${nanoid(12)}`;
    const taskId = `task_${nanoid(12)}`;
    const sessionId = `session_${nanoid(12)}`;
    const cwd = options?.cwd ?? sourceAgent.cwd ?? defaultCwd;

    // Emit spawn event with fork metadata
    eventStore.emit({
      type: "spawn",
      source: { agent_id: sourceAgentId },
      payload: {
        agent_id: agentId,
        session_id: sessionId,
        task: options?.name ?? `[Fork of ${sourceAgentId}]`,
        task_id: taskId,
        parent: sourceAgent.parent ?? null,
        role: sourceAgent.role ?? undefined,
        config: {},
        cwd,
        metadata: { fork_of: sourceAgentId },
      },
    });

    // Generate a human-readable name
    const generatedName = uniqueNamesGenerator({
      dictionaries: [adjectives, animals],
      separator: "-",
      length: 2,
    });
    eventStore.updateAgentMetadata(agentId as AgentId, { name: generatedName });
    await eventStore.persist();

    // Get the provider session ID to fork from
    let forkedProviderSessionId: string;
    if (activeSession) {
      // Active session: fork with flush to ensure data is persisted
      const forkedSession = await activeSession.session.forkWithFlush();
      forkedProviderSessionId = forkedSession.id;
    } else {
      // Stopped agent: use the persisted provider session ID directly
      forkedProviderSessionId = sourceAgent.provider_session_id!;
    }

    // Spawn a new process
    const handle = await AgentFactory.spawn(defaultAgentType, {
      permissionMode: defaultPermissionMode,
    });

    try {
      const macroAgentMcp = buildMacroAgentMcp({
        agentId,
        parentId: sourceAgent.parent ?? "",
        taskId,
        cwd,
        permissionMode: defaultPermissionMode,
        lineage: sourceAgent.lineage ?? [],
        sessionId,
      });

      // Load the forked session on the new process with correct MCP config.
      // Note: loadSession's TS type for mcpServers is { name, uri }[] but
      // the underlying ACP protocol accepts full McpServerStdio. The JS
      // implementation passes mcpServers through to the connection unchanged.
      const session = await handle.loadSession(forkedProviderSessionId, cwd, [
        macroAgentMcp,
      ] as any);

      // Emit started status with provider session ID
      eventStore.emit({
        type: "status",
        source: { agent_id: agentId },
        payload: {
          status_type: "started",
          summary: "Agent session started (forked)",
          provider_session_id: session.id,
        },
      });
      await eventStore.persist();

      // Set up message router subscriptions
      messageRouter.setupDefaultSubscriptions({
        agent_id: agentId,
        parent_id: sourceAgent.parent ?? undefined,
        task_id: taskId,
        subscribe_parent: false,
        additional_topics: [],
        role: sourceAgent.role ?? undefined,
      });

      // Track active session
      const newActiveSession: ActiveSession = {
        agentId,
        handle,
        session,
        createdAt: Date.now(),
        isPrompting: false,
      };
      activeSessions.set(agentId, newActiveSession);

      const agent = eventStore.getAgent(agentId)!;
      notifyLifecycle({ type: "spawned", agent });
      notifyLifecycle({ type: "started", agent });

      return {
        id: agentId,
        session_id: sessionId,
        agent,
        session,
      };
    } catch (handleError) {
      try {
        await handle.close();
      } catch {
        // Ignore errors during cleanup
      }
      throw handleError;
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // Queries
  // ─────────────────────────────────────────────────────────────────

  function get(agentId: AgentId): Agent | null {
    return eventStore.getAgent(agentId);
  }

  function list(filter?: AgentFilter): Agent[] {
    let agents = eventStore.listAgents();

    if (filter) {
      if (filter.state) {
        agents = agents.filter((a) => a.state === filter.state);
      }
      if (filter.parent !== undefined) {
        agents = agents.filter((a) => a.parent === filter.parent);
      }
      if (filter.task_id) {
        agents = agents.filter((a) => a.task_id === filter.task_id);
      }
      if (filter.headManagersOnly) {
        agents = agents.filter((a) => a.parent === null);
      }
    }

    return agents;
  }

  function getChildren(agentId: AgentId): Agent[] {
    return eventStore.listAgents({ parent: agentId });
  }

  function getHierarchy(
    agentId: AgentId,
    options?: HierarchyOptions,
  ): AgentHierarchy | null {
    const agent = eventStore.getAgent(agentId);
    if (!agent) return null;

    const maxDepth = options?.depth;

    function buildNode(a: Agent, currentDepth: number): AgentHierarchyNode {
      const shouldIncludeChildren =
        maxDepth === undefined || currentDepth < maxDepth;
      const children = shouldIncludeChildren ? getChildren(a.id) : [];
      return {
        agent: a,
        children: children.map((c) => buildNode(c, currentDepth + 1)),
      };
    }

    const root = buildNode(agent, 1);

    // Calculate depth and total agents
    function calcDepth(node: AgentHierarchyNode): number {
      if (node.children.length === 0) return 1;
      return 1 + Math.max(...node.children.map(calcDepth));
    }

    function countAgents(node: AgentHierarchyNode): number {
      return 1 + node.children.reduce((sum, c) => sum + countAgents(c), 0);
    }

    return {
      root,
      depth: calcDepth(root),
      totalAgents: countAgents(root),
    };
  }

  // ─────────────────────────────────────────────────────────────────
  // Head Manager
  // ─────────────────────────────────────────────────────────────────

  async function getOrCreateHeadManager(
    options: HeadManagerOptions,
  ): Promise<SpawnedAgent> {
    const {
      cwd,
      systemPrompt,
      permissionMode,
      topics = [],
      sessionId,
      forceNew = false,
    } = options;

    // If not forcing new, attempt to resume an existing session
    if (!forceNew) {
      const headManagers = listHeadManagers()
        .filter((h) => h.state === "running")
        .sort((a, b) => {
          // Sort by started_at descending, then by created_at descending as tiebreaker
          const startDiff = (b.started_at ?? 0) - (a.started_at ?? 0);
          if (startDiff !== 0) return startDiff;
          return b.created_at - a.created_at;
        });

      if (sessionId) {
        // Resume specific session by ID
        const specific = headManagers.find((h) => h.session_id === sessionId);
        if (specific && activeSessions.has(specific.id)) {
          const activeSession = activeSessions.get(specific.id)!;
          return {
            id: specific.id,
            session_id: specific.session_id,
            agent: specific,
            session: activeSession.session,
          };
        }
      } else if (headManagers.length > 0) {
        // Resume latest running session with active session
        const latest = headManagers[0];
        if (activeSessions.has(latest.id)) {
          const activeSession = activeSessions.get(latest.id)!;
          return {
            id: latest.id,
            session_id: latest.session_id,
            agent: latest,
            session: activeSession.session,
          };
        }
      }
    }

    // No existing session found or forceNew requested - create new
    return spawn({
      task:
        systemPrompt ??
        "You are a head manager agent. Coordinate tasks and spawn child agents as needed.",
      parent: null,
      cwd,
      permissionMode,
      topics,
      subscribeParent: false,
    });
  }

  function listHeadManagers(): Agent[] {
    return list({ headManagersOnly: true });
  }

  // ─────────────────────────────────────────────────────────────────
  // Session Interaction
  // ─────────────────────────────────────────────────────────────────

  async function* prompt(
    agentId: AgentId,
    message: string,
  ): AsyncIterable<ExtendedSessionUpdate> {
    const activeSession = activeSessions.get(agentId);
    if (!activeSession) {
      throw new AgentManagerError(
        `No active session for agent: ${agentId}`,
        "SESSION_NOT_FOUND",
        agentId,
      );
    }

    activeSession.isPrompting = true;

    try {
      for await (const update of activeSession.session.prompt(message)) {
        yield update;
      }
    } finally {
      activeSession.isPrompting = false;
    }
  }

  /**
   * Prompt an agent and automatically follow up to ensure done() is called.
   */
  async function promptUntilDone(
    agentId: AgentId,
    message: string,
    options?: {
      maxFollowUps?: number;
      throwOnMaxExceeded?: boolean;
      onUpdate?: (update: ExtendedSessionUpdate) => void;
    },
  ): Promise<{
    doneCalled: boolean;
    doneStatus?: string;
    exceededMax: boolean;
    followUpCount: number;
    updates: ExtendedSessionUpdate[];
  }> {
    const maxFollowUps = options?.maxFollowUps ?? 2;
    const throwOnMaxExceeded = options?.throwOnMaxExceeded ?? false;
    const onUpdate = options?.onUpdate;
    const allUpdates: ExtendedSessionUpdate[] = [];
    let followUpCount = 0;

    // Helper to check if done() was called by looking for status events
    // The done() MCP tool emits status events with status_type completed/failed
    // and includes signal: "WORKER_DONE" in the details
    const checkDoneCalled = async (): Promise<{
      called: boolean;
      status?: string;
    }> => {
      // Reload from disk to see events from MCP subprocess
      await eventStore.reload();
      const statusEvents = eventStore.query({ type: "status" });

      // Look for status events from this agent that indicate completion
      const agentCompletedStatus = statusEvents.find(
        (e) =>
          e.source?.agent_id === agentId &&
          (e.payload?.status_type === "completed" ||
            e.payload?.status_type === "failed" ||
            (e.payload?.details as Record<string, unknown>)?.signal ===
              "WORKER_DONE"),
      );

      if (agentCompletedStatus) {
        return {
          called: true,
          status: agentCompletedStatus.payload?.status_type as string,
        };
      }

      return { called: false };
    };

    // Initial prompt
    for await (const update of prompt(agentId, message)) {
      allUpdates.push(update);
      onUpdate?.(update);
    }

    // Check if done() was called
    let doneResult = await checkDoneCalled();
    if (doneResult.called) {
      return {
        doneCalled: true,
        doneStatus: doneResult.status,
        exceededMax: false,
        followUpCount: 0,
        updates: allUpdates,
      };
    }

    // Follow-up prompts
    const followUpMessages = [
      `Your work appears complete, but you haven't called done() yet. Please call done() now with your completion status.

Example: done({ status: "completed", summary: "Brief description of what you accomplished" })

If you're blocked or need help, call: done({ status: "blocked", summary: "What you need help with" })`,

      `IMPORTANT: You MUST call the done() tool to signal completion. This is required for proper cleanup.

Call done() NOW with status "completed" if your work is finished, or "blocked" if you need assistance.`,
    ];

    for (let i = 0; i < maxFollowUps; i++) {
      followUpCount++;
      const followUpMessage =
        followUpMessages[Math.min(i, followUpMessages.length - 1)];

      // Send follow-up prompt
      for await (const update of prompt(agentId, followUpMessage)) {
        allUpdates.push(update);
        onUpdate?.(update);
      }

      // Check again
      doneResult = await checkDoneCalled();
      if (doneResult.called) {
        return {
          doneCalled: true,
          doneStatus: doneResult.status,
          exceededMax: false,
          followUpCount,
          updates: allUpdates,
        };
      }
    }

    // done() was never called after max follow-ups
    if (throwOnMaxExceeded) {
      throw new Error(
        `Agent ${agentId} did not call done() after ${maxFollowUps} follow-up attempts. ` +
          `Total prompts sent: ${1 + followUpCount}. Consider increasing maxFollowUps or investigating agent behavior.`,
      );
    }

    return {
      doneCalled: false,
      exceededMax: true,
      followUpCount,
      updates: allUpdates,
    };
  }

  function getSession(agentId: AgentId): Session | null {
    const activeSession = activeSessions.get(agentId);
    return activeSession?.session ?? null;
  }

  function hasActiveSession(agentId: AgentId): boolean {
    return activeSessions.has(agentId);
  }

  function isPrompting(agentId: AgentId): boolean {
    const activeSession = activeSessions.get(agentId);
    return activeSession?.isPrompting ?? false;
  }

  async function supportsInjection(agentId: AgentId): Promise<boolean> {
    const session = getSession(agentId);
    if (!session) {
      return false;
    }
    // Check if the session supports injection
    // Uses acp-factory's supportsInject() which returns cached/estimated result
    try {
      return session.supportsInject();
    } catch {
      return false;
    }
  }

  function isProcessRunning(agentId: AgentId): boolean {
    const activeSession = activeSessions.get(agentId);
    if (!activeSession) {
      return false;
    }
    return activeSession.handle.isRunning();
  }

  // ─────────────────────────────────────────────────────────────────
  // Permission Handling
  // ─────────────────────────────────────────────────────────────────

  function respondToPermission(
    agentId: AgentId,
    requestId: string,
    optionId: string,
  ): boolean {
    const activeSession = activeSessions.get(agentId);
    if (!activeSession) {
      console.warn(
        `[AgentManager] Cannot respond to permission: no active session for agent ${agentId}`,
      );
      return false;
    }

    try {
      activeSession.session.respondToPermission(requestId, optionId);
      console.log(
        `[AgentManager] Responded to permission ${requestId} for agent ${agentId} with ${optionId}`,
      );
      return true;
    } catch (err) {
      console.error(
        `[AgentManager] Error responding to permission ${requestId}:`,
        err,
      );
      return false;
    }
  }

  function cancelPermission(agentId: AgentId, requestId: string): boolean {
    const activeSession = activeSessions.get(agentId);
    if (!activeSession) {
      console.warn(
        `[AgentManager] Cannot cancel permission: no active session for agent ${agentId}`,
      );
      return false;
    }

    try {
      activeSession.session.cancelPermission(requestId);
      console.log(
        `[AgentManager] Cancelled permission ${requestId} for agent ${agentId}`,
      );
      return true;
    } catch (err) {
      console.error(
        `[AgentManager] Error cancelling permission ${requestId}:`,
        err,
      );
      return false;
    }
  }

  function setPermissionMode(agentId: AgentId, mode: PermissionMode): boolean {
    const activeSession = activeSessions.get(agentId);
    if (!activeSession) {
      console.warn(
        `[AgentManager] Cannot set permission mode: no active session for agent ${agentId}`,
      );
      return false;
    }

    try {
      activeSession.handle.setPermissionMode(mode);
      console.log(
        `[AgentManager] Set permission mode for agent ${agentId} to ${mode}`,
      );
      return true;
    } catch (err) {
      console.error(
        `[AgentManager] Error setting permission mode for agent ${agentId}:`,
        err,
      );
      return false;
    }
  }

  function getPermissionMode(agentId: AgentId): PermissionMode | null {
    const activeSession = activeSessions.get(agentId);
    if (!activeSession) {
      return null;
    }
    return activeSession.handle.getPermissionMode();
  }

  // ─────────────────────────────────────────────────────────────────
  // Lifecycle Callbacks
  // ─────────────────────────────────────────────────────────────────

  function onLifecycleEvent(callback: AgentLifecycleCallback): () => void {
    lifecycleListeners.add(callback);
    return () => lifecycleListeners.delete(callback);
  }

  function notifyLifecycle(event: Parameters<AgentLifecycleCallback>[0]): void {
    for (const listener of lifecycleListeners) {
      try {
        listener(event);
      } catch {
        // Ignore listener errors
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // Mail Services (Late Binding)
  // ─────────────────────────────────────────────────────────────────

  function setMailServices(
    ms: import("../mail/mail-service.js").MailService,
    cm: import("../mail/conversation-map.js").ConversationMap,
  ): void {
    mailService = ms;
    conversationMap = cm;
  }

  // ─────────────────────────────────────────────────────────────────
  // Cleanup
  // ─────────────────────────────────────────────────────────────────

  async function close(): Promise<void> {
    // Prevent new spawns/resumes from racing with cleanup
    isShuttingDown = true;

    // Stop all health checks
    if (healthCheckService) {
      healthCheckService.stopAll();
    }

    // Close all active sessions
    const closePromises: Promise<void>[] = [];
    for (const [agentId, session] of activeSessions) {
      closePromises.push(
        (async () => {
          try {
            await session.handle.close();
          } catch {
            // Ignore errors during cleanup
          }
        })(),
      );
    }

    await Promise.all(closePromises);
    activeSessions.clear();
    lifecycleListeners.clear();
  }

  function setSpawnInterceptor(interceptor: SpawnInterceptor | null): void {
    spawnInterceptor = interceptor;
  }

  function getRoleRegistry(): RoleRegistry {
    return roleRegistry;
  }

  /**
   * Continue a terminated agent by spawning a new agent with the same
   * role and task, injecting prior conversation context as a resume prefix.
   */
  async function continueAgent(
    agentId: AgentId,
    options?: ContinueAgentOptions,
  ): Promise<SpawnedAgent> {
    const agent = eventStore.getAgent(agentId);
    if (!agent) {
      throw new AgentManagerError(
        `Agent not found: ${agentId}`,
        "AGENT_NOT_FOUND",
        agentId,
      );
    }

    // Build resume context from EventStore events
    const maxMessages = options?.maxMessages ?? 50;
    const events = eventStore.query({
      type: "status",
      source_agent_id: agentId,
      limit: maxMessages,
    });

    // Format conversation turns as resume context
    const contextLines: string[] = [];
    if (options?.additionalContext) {
      contextLines.push(options.additionalContext);
    }

    if (events.length > 0) {
      contextLines.push("## Prior Session Context");
      contextLines.push(
        `Continuing from agent ${agentId} (${events.length} events).`,
      );
      for (const event of events.slice(-20)) {
        const summary = event.payload?.summary;
        if (summary && typeof summary === "string") {
          contextLines.push(`- ${summary}`);
        }
      }
    }

    const resumeContext = contextLines.join("\n");

    // Spawn a continuation agent with same role, task, and context
    const taskDescription =
      options?.task ?? agent.task ?? `Continue work from ${agentId}`;

    const newAgent = await spawn({
      task: taskDescription,
      role: agent.role,
      parent: agent.parent ?? undefined,
      cwd: agent.cwd ?? defaultCwd,
      customPrompt: resumeContext || undefined,
    });

    // Emit continuation event
    eventStore.emit({
      type: "status",
      source: { agent_id: newAgent.id },
      payload: {
        status_type: "started",
        summary: `Continuation of agent ${agentId}`,
        continuation_of: agentId,
      },
    });

    return newAgent;
  }

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
    setSpawnInterceptor,
    getRoleRegistry,
    setMailServices,
    close,
  };
}

// ─────────────────────────────────────────────────────────────────
// Workspace Creation Helper (Phase 2)
// ─────────────────────────────────────────────────────────────────

interface CreateWorkspaceOptions {
  streamId?: string;
  streamConfig?: import("../workspace/types.js").StreamConfig;
  dataplaneTaskId?: string;
  cwd: string;
}

/**
 * Create a workspace for an agent based on their role.
 *
 * @param workspaceManager - WorkspaceManager instance
 * @param agentId - Agent ID
 * @param role - Agent role (e.g., 'worker', 'coordinator', 'integrator')
 * @param options - Additional options
 * @returns Created workspace or undefined
 */
async function createWorkspaceForRole(
  workspaceManager: WorkspaceManager,
  agentId: AgentId,
  role: string,
  options: CreateWorkspaceOptions,
): Promise<Workspace | undefined> {
  const { streamId, streamConfig, dataplaneTaskId } = options;

  switch (role) {
    case "coordinator": {
      // Coordinators create a new integration stream
      if (!streamConfig) {
        console.warn(
          `[AgentManager] Coordinator ${agentId} spawn missing streamConfig, skipping workspace`,
        );
        return undefined;
      }

      const newStreamId = workspaceManager.createIntegrationStream(
        agentId,
        streamConfig,
      );

      return workspaceManager.createCoordinatorWorkspace(agentId, newStreamId);
    }

    case "integrator": {
      // Integrators join an existing stream
      if (!streamId) {
        console.warn(
          `[AgentManager] Integrator ${agentId} spawn missing streamId, skipping workspace`,
        );
        return undefined;
      }

      return workspaceManager.createIntegratorWorkspace(agentId, streamId);
    }

    case "worker":
    case "worker.resolver": {
      // Workers need streamId and either dataplaneTaskId or create a new task
      if (!streamId) {
        console.warn(
          `[AgentManager] Worker ${agentId} spawn missing streamId, skipping workspace`,
        );
        return undefined;
      }

      // Use provided task ID or skip (task should be created separately)
      const taskId = dataplaneTaskId;
      if (!taskId) {
        console.warn(
          `[AgentManager] Worker ${agentId} spawn missing dataplaneTaskId, skipping workspace`,
        );
        return undefined;
      }

      return workspaceManager.createWorkerWorkspace(agentId, taskId, streamId);
    }

    case "monitor":
      // Monitors don't need workspaces
      return undefined;

    default:
      // Unknown role - no workspace
      return undefined;
  }
}
