/**
 * MacroAgent - ACP-compliant agent implementation for macro-agent
 *
 * Implements the Agent interface from @agentclientprotocol/sdk to allow
 * macro-agent to be spawned and controlled via the Agent Communication Protocol.
 */

import type {
  Agent,
  AgentSideConnection,
  InitializeRequest,
  InitializeResponse,
  NewSessionRequest,
  NewSessionResponse,
  LoadSessionRequest,
  LoadSessionResponse,
  AuthenticateRequest,
  AuthenticateResponse,
  PromptRequest,
  PromptResponse,
  CancelNotification,
  SessionNotification,
} from "@agentclientprotocol/sdk";
import type { AgentManager } from "../agent/agent-manager.js";
import type { EventStore } from "../store/event-store.js";
import type { TaskManager } from "../task/task-manager.js";
import type { AgentId } from "../store/types/index.js";
import { SessionMapper } from "./session-mapper.js";
import type {
  ACPSessionId,
  ACPExtensionMethod,
  SpawnAgentRequest,
  SpawnAgentResponse,
  GetHierarchyRequest,
  GetHierarchyResponse,
  GetTaskRequest,
  GetTaskResponse,
  MountAgentRequest,
  MountAgentResponse,
  ForkAgentRequest,
  ForkAgentResponse,
  MacroAgentInitConfig,
  SubAgentConfig,
  SendPeerMessageACPRequest,
  SendPeerMessageACPResponse,
  SendPeerRequestACPRequest,
  SendPeerRequestACPResponse,
  DeliverPeerMessageRequest,
  DeliverPeerMessageResponse,
  DeliverPeerRequestRequest,
  DeliverPeerRequestResponse,
  GrantCapabilityRequest,
  GrantCapabilityResponse,
  RevokeCapabilityRequest,
  RevokeCapabilityResponse,
  GetCapabilitiesRequest,
  GetCapabilitiesResponse,
  CheckCapabilityRequest,
  CheckCapabilityResponse,
  RespondToPermissionRequest,
  RespondToPermissionResponse,
  CancelPermissionRequest,
  CancelPermissionResponse,
  ResumeAgentRequest,
  ResumeAgentResponse,
  GetHistoryRequest,
  GetHistoryResponse,
  HistoryTurn,
} from "./types.js";
import { ACPError } from "./types.js";
import type { PeerManager } from "../peer/peer-manager.js";
import type { CapabilityManager } from "../peer/capability-manager.js";
import type { AgentConfig } from "../agent/types.js";
import type { RoleRegistry, Capability } from "../roles/types.js";
import { AGENT_CAPABILITIES } from "../roles/capabilities.js";
import { DefaultRoleRegistry } from "../roles/registry.js";

// ─────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────

/** Extract a plain-text output string from `rawOutput` (string | ContentBlock[] | undefined). */
function extractToolOutput(rawOutput: unknown): string | undefined {
  if (typeof rawOutput === "string") return rawOutput;
  if (Array.isArray(rawOutput)) {
    return rawOutput
      .filter((item: any) => item.type === "text" && typeof item.text === "string")
      .map((item: any) => item.text as string)
      .join("\n") || undefined;
  }
  return undefined;
}

// ─────────────────────────────────────────────────────────────────
// Protocol Constants
// ─────────────────────────────────────────────────────────────────

const PROTOCOL_VERSION = 1;

const SUPPORTED_EXTENSIONS: ACPExtensionMethod[] = [
  "_macro/spawnAgent",
  "_macro/getHierarchy",
  "_macro/getTask",
  "_macro/mountAgent",
  "_macro/forkAgent",
  "_macro/sendPeerMessage",
  "_macro/sendPeerRequest",
  "_macro/deliverPeerMessage",
  "_macro/deliverPeerRequest",
  "_macro/grantCapability",
  "_macro/revokeCapability",
  "_macro/getCapabilities",
  "_macro/checkCapability",
  "_macro/respondToPermission",
  "_macro/cancelPermission",
  "_macro/resume",
  "_macro/getHistory",
];

// ─────────────────────────────────────────────────────────────────
// MacroAgent Configuration
// ─────────────────────────────────────────────────────────────────

export interface MacroAgentConfig {
  /** AgentManager for spawning and managing agents */
  agentManager: AgentManager;

  /** EventStore for persistence */
  eventStore: EventStore;

  /** TaskManager for task operations */
  taskManager: TaskManager;

  /** PeerManager for inter-macro-agent communication (optional) */
  peerManager?: PeerManager;

  /** CapabilityManager for peer capability management (optional) */
  capabilityManager?: CapabilityManager;

  /** RoleRegistry for role-based capability checking (optional, uses default if not provided) */
  roleRegistry?: RoleRegistry;

  /** Default working directory for new sessions */
  defaultCwd?: string;
}

// ─────────────────────────────────────────────────────────────────
// MacroAgent Implementation
// ─────────────────────────────────────────────────────────────────

/**
 * MacroAgent implements the ACP Agent interface to expose macro-agent
 * as an ACP-compliant agent that can be spawned by external systems.
 */
export class MacroAgent implements Agent {
  private connection: AgentSideConnection;
  private agentManager: AgentManager;
  private eventStore: EventStore;
  private taskManager: TaskManager;
  private peerManager: PeerManager | undefined;
  private capabilityManager: CapabilityManager | undefined;
  private roleRegistry: RoleRegistry;
  private sessionMapper: SessionMapper;
  private defaultCwd: string;

  /** Configuration from ACP initialization */
  private initConfig: MacroAgentInitConfig = {};

  /** Map of ACP session ID to cancellation abort controllers */
  private cancellationControllers: Map<ACPSessionId, AbortController> =
    new Map();

  /** Accumulates assistant response parts during prompt streaming for history persistence */
  private promptBuffers: Map<
    ACPSessionId,
    { parts: Array<{ type: "text"; text: string } | ({ type: "tool" } & Record<string, unknown>)> }
  > = new Map();

  /** Caches tool info (title, name, input) from initial tool_call events per session */
  private toolInfoCaches: Map<
    ACPSessionId,
    Map<string, { title?: string; name?: string; input?: unknown }>
  > = new Map();

  constructor(connection: AgentSideConnection, config: MacroAgentConfig) {
    this.connection = connection;
    this.agentManager = config.agentManager;
    this.eventStore = config.eventStore;
    this.taskManager = config.taskManager;
    this.peerManager = config.peerManager;
    this.capabilityManager = config.capabilityManager;
    this.roleRegistry = config.roleRegistry ?? new DefaultRoleRegistry();
    this.sessionMapper = new SessionMapper(config.eventStore);
    this.defaultCwd = config.defaultCwd ?? process.cwd();

    // Recover persisted sessions from the EventStore
    const recovered = this.sessionMapper.recoverFromStore();
    if (recovered > 0) {
      console.log(
        `[MacroAgent] Recovered ${recovered} session(s) from EventStore`,
      );
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // Core ACP Methods
  // ─────────────────────────────────────────────────────────────────

  /**
   * Initialize the connection and advertise capabilities
   *
   * Reads configuration from `params._meta?.macroConfig` if provided.
   * This allows each macro-agent instance to have different settings.
   */
  async initialize(params: InitializeRequest): Promise<InitializeResponse> {
    // Extract macro-agent config from _meta if provided
    const meta = params._meta as Record<string, unknown> | undefined;
    if (meta?.macroConfig) {
      this.initConfig = meta.macroConfig as MacroAgentInitConfig;

      // Apply defaultCwd from init config if provided
      if (this.initConfig.defaultCwd) {
        this.defaultCwd = this.initConfig.defaultCwd;
      }
    }

    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        _meta: {
          extensions: SUPPORTED_EXTENSIONS,
          agentType: "macro-agent",
          // Echo back the config so client knows what was applied
          appliedConfig: this.initConfig,
        },
      },
    };
  }

  /**
   * Create a new session by spawning a head manager
   */
  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    const cwd = params.cwd ?? this.defaultCwd;

    // Build head manager options from init config
    const defaultConfig = this.initConfig.defaultSubAgentConfig;
    const permissionModeToUse = defaultConfig?.permissionMode;

    // Spawn a new head manager for this session
    const spawned = await this.agentManager.getOrCreateHeadManager({
      cwd,
      forceNew: true, // Always create new for newSession
      permissionMode: permissionModeToUse,
      systemPrompt: this.buildSystemPrompt(),
    });

    // Create session mapping
    const acpSessionId = spawned.session_id;
    this.sessionMapper.createMapping(acpSessionId, spawned.id);

    // Create abort controller for cancellation
    this.cancellationControllers.set(acpSessionId, new AbortController());

    // Create a conversation in EventStore for history tracking
    this.ensureConversation(acpSessionId, spawned.id);

    // Emit session_info_update so client has title/timestamps
    await this.emitSessionInfo(acpSessionId);

    return {
      sessionId: acpSessionId,
    };
  }

  /**
   * Load an existing session from EventStore
   */
  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    let acpSessionId = params.sessionId;
    const cwd = params.cwd ?? this.defaultCwd;

    // Extension: If _meta.agentId provided, look up session from agent record
    // This allows resuming a stopped head manager by MAP agent ID
    // when the TUI doesn't know the ACP session ID
    const metaAgentId = (params as { _meta?: Record<string, unknown> })._meta
      ?.agentId as string | undefined;
    if (metaAgentId) {
      const agent = this.eventStore.getAgent(metaAgentId as AgentId);
      if (!agent) {
        throw new Error(`Agent not found: ${metaAgentId}`);
      }
      acpSessionId = agent.session_id;
      console.log(
        `[MacroAgent] loadSession: Resolved agentId ${metaAgentId} to session ${acpSessionId}`,
      );
    }

    // Try to find an existing head manager with this session ID
    const headManagers = this.agentManager.listHeadManagers();
    const existing = headManagers.find((hm) => hm.session_id === acpSessionId);

    if (existing) {
      // Check if the agent already has an active session
      if (this.agentManager.hasActiveSession(existing.id)) {
        console.log(
          `[MacroAgent] loadSession: Agent ${existing.id} already has active session, reusing`,
        );
        // Reuse the existing active session - just update mappings
        this.sessionMapper.createMapping(acpSessionId, existing.id);
        if (!this.cancellationControllers.has(acpSessionId)) {
          this.cancellationControllers.set(acpSessionId, new AbortController());
        }
        this.ensureConversation(acpSessionId, existing.id);
        await this.emitSessionInfo(acpSessionId);
        return {};
      }

      // Agent exists but no active session - resume it
      console.log(
        `[MacroAgent] loadSession: Resuming stopped agent ${existing.id}`,
      );
      const spawned = await this.agentManager.resume(existing.id);

      // Create session mapping
      this.sessionMapper.createMapping(acpSessionId, spawned.id);
      this.cancellationControllers.set(acpSessionId, new AbortController());
      this.ensureConversation(acpSessionId, spawned.id);
      await this.emitSessionInfo(acpSessionId);

      return {};
    }

    // No existing agent found - try to get or create with the specific session ID
    console.log(
      `[MacroAgent] loadSession: No existing agent for session ${acpSessionId}, creating new`,
    );
    const spawned = await this.agentManager.getOrCreateHeadManager({
      cwd,
      sessionId: acpSessionId,
    });

    // Create session mapping
    this.sessionMapper.createMapping(acpSessionId, spawned.id);
    this.cancellationControllers.set(acpSessionId, new AbortController());
    this.ensureConversation(acpSessionId, spawned.id);
    await this.emitSessionInfo(acpSessionId);

    return {};
  }

  /**
   * Authenticate - macro-agent doesn't require authentication
   */
  async authenticate(
    _params: AuthenticateRequest,
  ): Promise<AuthenticateResponse> {
    // No authentication required
    return {};
  }

  /**
   * Process a prompt by routing to the mapped agent
   */
  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const acpSessionId = params.sessionId;

    // Get the mapped agent
    const agentId = this.sessionMapper.getAgentIdOrThrow(acpSessionId);

    // Get or set up abort controller
    let abortController = this.cancellationControllers.get(acpSessionId);
    if (!abortController || abortController.signal.aborted) {
      abortController = new AbortController();
      this.cancellationControllers.set(acpSessionId, abortController);
    }

    // Extract message content from prompt blocks
    const messageContent = this.extractMessageContent(params.prompt);

    // Mark session as processing (for health monitoring)
    this.sessionMapper.setProcessing(acpSessionId, true);

    // Initialize prompt buffer and tool info cache for history accumulation
    this.promptBuffers.set(acpSessionId, { parts: [] });
    this.toolInfoCaches.set(acpSessionId, new Map());

    try {
      // Stream responses from the agent
      for await (const update of this.agentManager.prompt(
        agentId,
        messageContent,
      )) {
        // Check for cancellation
        if (abortController.signal.aborted) {
          return {
            stopReason: "cancelled",
          };
        }

        // Forward session updates to the client
        await this.forwardSessionUpdate(acpSessionId, update);
      }

      // Persist conversation turns for history
      this.recordPromptTurns(acpSessionId, agentId, messageContent);

      // Emit updated session info after prompt completes
      await this.emitSessionInfo(acpSessionId);

      return {
        stopReason: "end_turn",
      };
    } catch (error) {
      // Handle errors
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";

      // Send error as session update
      await this.connection.sessionUpdate({
        sessionId: acpSessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: `Error: ${errorMessage}` },
        },
      });

      return {
        stopReason: "end_turn",
      };
    } finally {
      // Mark session as not processing (for health monitoring)
      this.sessionMapper.setProcessing(acpSessionId, false);
    }
  }

  /**
   * Cancel ongoing operations for a session
   */
  async cancel(params: CancelNotification): Promise<void> {
    const acpSessionId = params.sessionId;

    // Signal cancellation
    const controller = this.cancellationControllers.get(acpSessionId);
    if (controller) {
      controller.abort();
    }

    // Get the mapped agent ID for this session
    const agentId = this.sessionMapper.getAgentId(acpSessionId);
    if (!agentId) {
      // No agent mapped - just clean up the controller
      this.cancellationControllers.delete(acpSessionId);
      return;
    }

    // Terminate the agent (which kills the subprocess)
    try {
      await this.agentManager.terminate(agentId, "cancelled");
    } catch (error) {
      // Agent may already be stopped - log but don't throw
      console.warn(
        `[MacroAgent] Error terminating agent ${agentId}:`,
        error instanceof Error ? error.message : String(error),
      );
    }

    // Clean up resources
    this.cancellationControllers.delete(acpSessionId);
    this.sessionMapper.removeMapping(acpSessionId);
  }

  // ─────────────────────────────────────────────────────────────────
  // Extension Methods
  // ─────────────────────────────────────────────────────────────────

  /**
   * Route extension method calls to handlers
   */
  async extMethod(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    // Method may come with or without underscore prefix depending on caller
    // SDK calls with full name (e.g., "_macro/spawnAgent"), direct calls may omit it
    const fullMethod = (
      method.startsWith("_") ? method : `_${method}`
    ) as ACPExtensionMethod;

    switch (fullMethod) {
      case "_macro/spawnAgent":
        return this.handleSpawnAgent(
          params as unknown as SpawnAgentRequest,
        ) as unknown as Record<string, unknown>;

      case "_macro/getHierarchy":
        return this.handleGetHierarchy(
          params as unknown as GetHierarchyRequest,
        ) as unknown as Record<string, unknown>;

      case "_macro/getTask":
        return this.handleGetTask(
          params as unknown as GetTaskRequest,
        ) as unknown as Record<string, unknown>;

      case "_macro/mountAgent":
        return this.handleMountAgent(
          params as unknown as MountAgentRequest,
        ) as unknown as Record<string, unknown>;

      case "_macro/forkAgent":
        return this.handleForkAgent(
          params as unknown as ForkAgentRequest,
        ) as unknown as Record<string, unknown>;

      case "_macro/sendPeerMessage":
        return this.handleSendPeerMessage(
          params as unknown as SendPeerMessageACPRequest,
        ) as unknown as Record<string, unknown>;

      case "_macro/sendPeerRequest":
        return this.handleSendPeerRequest(
          params as unknown as SendPeerRequestACPRequest,
        ) as unknown as Record<string, unknown>;

      case "_macro/deliverPeerMessage":
        return this.handleDeliverPeerMessage(
          params as unknown as DeliverPeerMessageRequest,
        ) as unknown as Record<string, unknown>;

      case "_macro/deliverPeerRequest":
        return this.handleDeliverPeerRequest(
          params as unknown as DeliverPeerRequestRequest,
        ) as unknown as Record<string, unknown>;

      case "_macro/grantCapability":
        return this.handleGrantCapability(
          params as unknown as GrantCapabilityRequest,
        ) as unknown as Record<string, unknown>;

      case "_macro/revokeCapability":
        return this.handleRevokeCapability(
          params as unknown as RevokeCapabilityRequest,
        ) as unknown as Record<string, unknown>;

      case "_macro/getCapabilities":
        return this.handleGetCapabilities(
          params as unknown as GetCapabilitiesRequest,
        ) as unknown as Record<string, unknown>;

      case "_macro/checkCapability":
        return this.handleCheckCapability(
          params as unknown as CheckCapabilityRequest,
        ) as unknown as Record<string, unknown>;

      case "_macro/respondToPermission":
        return this.handleRespondToPermission(
          params as unknown as RespondToPermissionRequest,
        ) as unknown as Record<string, unknown>;

      case "_macro/cancelPermission":
        return this.handleCancelPermission(
          params as unknown as CancelPermissionRequest,
        ) as unknown as Record<string, unknown>;

      case "_macro/resume":
        return this.handleResumeAgent(
          params as unknown as ResumeAgentRequest,
        ) as unknown as Record<string, unknown>;

      case "_macro/getHistory":
        return this.handleGetHistory(
          params as unknown as GetHistoryRequest,
        ) as unknown as Record<string, unknown>;

      default:
        throw new ACPError(
          `Unknown extension method: ${method}`,
          "INVALID_EXTENSION",
        );
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // Extension Handlers
  // ─────────────────────────────────────────────────────────────────

  /**
   * Spawn a new child agent
   */
  private async handleSpawnAgent(
    params: SpawnAgentRequest,
  ): Promise<SpawnAgentResponse> {
    // Determine parent - use provided parentId or fall back to a session's mapped agent
    let parentId = params.parentId;

    // If no parentId provided, we need to find a suitable parent
    // This would typically come from an ACP session context
    if (!parentId) {
      // Get the first head manager as default parent
      const headManagers = this.agentManager.listHeadManagers();
      if (headManagers.length > 0) {
        parentId = headManagers[0].id;
      }
    }

    // Check spawn capability if parent exists
    if (parentId) {
      const parentAgent = this.eventStore.getAgent(parentId);
      if (parentAgent) {
        const childRole = params.role ?? "worker";
        const requiredCapability = this.getSpawnCapability(childRole);

        // Check if parent has the required spawn capability
        const parentRole = parentAgent.role ?? "worker";
        if (!this.roleRegistry.hasCapability(parentRole, requiredCapability)) {
          throw new ACPError(
            `Parent agent with role '${parentRole}' does not have capability to spawn '${childRole}' agents. ` +
              `Required capability: ${requiredCapability}`,
            "CAPABILITY_DENIED",
            {
              parentId,
              parentRole,
              childRole,
              requiredCapability,
            },
          );
        }
      }
    }

    // Merge default config with per-spawn override
    const mergedConfig = this.mergeSubAgentConfig(
      this.initConfig.defaultSubAgentConfig,
      params.config,
    );

    // Spawn the agent with merged config
    const spawned = await this.agentManager.spawn({
      task: params.task_description,
      parent: parentId ?? null,
      role: params.role,
      cwd: params.options?.cwd ?? this.defaultCwd,
      subscribeParent: params.options?.subscribeParent ?? true,
      topics: params.options?.topics,
      permissionMode: mergedConfig?.permissionMode,
      agentType: mergedConfig?.agentType,
      config: this.toAgentConfig(mergedConfig),
    });

    return {
      agentId: spawned.id,
      taskId: spawned.agent.task_id!,
      sessionId: spawned.session_id,
    };
  }

  /**
   * Map a child role name to the required spawn capability.
   * Handles subroles like "worker.resolver" by checking base role.
   */
  private getSpawnCapability(childRole: string): Capability {
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
        // For custom roles, check against the custom spawn capability
        return AGENT_CAPABILITIES.SPAWN_CUSTOM;
    }
  }

  /**
   * Get the agent hierarchy tree
   */
  private async handleGetHierarchy(
    params: GetHierarchyRequest,
  ): Promise<GetHierarchyResponse> {
    let rootAgentId = params.rootAgentId;

    // If no root specified, use the first head manager
    if (!rootAgentId) {
      const headManagers = this.agentManager.listHeadManagers();
      if (headManagers.length === 0) {
        // Return empty hierarchy if no agents
        return {
          hierarchy: {
            agent: null as unknown as import("../store/types/index.js").Agent,
            children: [],
          },
          totalAgents: 0,
          depth: 0,
        };
      }
      rootAgentId = headManagers[0].id;
    }

    // Get hierarchy from agent manager
    const hierarchy = this.agentManager.getHierarchy(rootAgentId);

    if (!hierarchy) {
      throw new ACPError(`Agent not found: ${rootAgentId}`, "AGENT_NOT_FOUND", {
        agentId: rootAgentId,
      });
    }

    return {
      hierarchy: hierarchy.root,
      totalAgents: hierarchy.totalAgents,
      depth: hierarchy.depth,
    };
  }

  /**
   * Get task details by ID
   */
  private async handleGetTask(
    params: GetTaskRequest,
  ): Promise<GetTaskResponse> {
    const task = this.taskManager.get(params.taskId);

    if (!task) {
      throw new ACPError(`Task not found: ${params.taskId}`, "TASK_NOT_FOUND", {
        taskId: params.taskId,
      });
    }

    return {
      task,
    };
  }

  /**
   * Mount (attach to) an existing agent
   *
   * Remaps an ACP session to point to a different agent.
   * Subsequent prompts will go to the mounted agent.
   */
  private async handleMountAgent(
    params: MountAgentRequest,
  ): Promise<MountAgentResponse> {
    const { sessionId, agentId } = params;

    // Verify the target agent exists
    const agent = this.agentManager.get(agentId);
    if (!agent) {
      throw new ACPError(`Agent not found: ${agentId}`, "AGENT_NOT_FOUND", {
        agentId,
      });
    }

    // Verify the session exists in our mapper
    const mapping = this.sessionMapper.getMapping(sessionId);
    if (!mapping) {
      throw new ACPError(
        `Session not found: ${sessionId}`,
        "SESSION_NOT_FOUND",
        { sessionId },
      );
    }

    // Get the previous agent before mounting
    const previousAgentId = mapping.agentId;

    // Remap the session to the target agent
    this.sessionMapper.mount(sessionId, agentId);

    return {
      sessionId,
      agent,
      previousAgentId,
    };
  }

  /**
   * Fork an agent (create a branch with same conversation context)
   *
   * Creates a new agent that starts from the same point as the original.
   * Uses native fork if available, otherwise falls back to loadSession.
   */
  private async handleForkAgent(
    params: ForkAgentRequest,
  ): Promise<ForkAgentResponse> {
    const { agentId, name } = params;

    // Get the original agent
    const originalAgent = this.agentManager.get(agentId);
    if (!originalAgent) {
      throw new ACPError(`Agent not found: ${agentId}`, "AGENT_NOT_FOUND", {
        agentId,
      });
    }

    // Check if the agent has an active session we can fork from
    const hasSession = this.agentManager.hasActiveSession(agentId);
    if (!hasSession) {
      throw new ACPError(
        `Agent has no active session to fork: ${agentId}`,
        "FORK_NOT_SUPPORTED",
        { agentId },
      );
    }

    // For now, create a new agent with the same task as a "fork"
    // In a full implementation, we would:
    // 1. Check if acp-factory supports native fork
    // 2. Use loadSession to clone the conversation state
    // Since acp-factory doesn't expose these yet, we create a new agent
    // with the same task description as a simplified fork

    const taskDescription = name
      ? `[Fork of ${agentId}] ${name}`
      : `[Fork of ${agentId}] ${originalAgent.task ?? "Forked task"}`;

    const spawned = await this.agentManager.spawn({
      task: taskDescription,
      parent: originalAgent.parent ?? null,
      cwd: this.defaultCwd,
      subscribeParent: false,
    });

    // Emit a fork event for tracking (the EventStore records this via spawn)
    // In a more complete implementation, we'd add a dedicated "fork" event type

    return {
      newAgentId: spawned.id,
      newSessionId: spawned.session_id,
      originalAgentId: agentId,
    };
  }

  // ─────────────────────────────────────────────────────────────────
  // Peer Communication Extension Handlers
  // ─────────────────────────────────────────────────────────────────

  /**
   * Send a peer message (outbound, fire-and-forget)
   *
   * Called by external clients to have an agent send a message to a peer.
   */
  private async handleSendPeerMessage(
    params: SendPeerMessageACPRequest,
  ): Promise<SendPeerMessageACPResponse> {
    if (!this.peerManager) {
      throw new ACPError(
        "PeerManager not configured for this macro-agent",
        "NO_PEER_MANAGER",
      );
    }

    // Determine which agent is sending (use head manager by default)
    const headManagers = this.agentManager.listHeadManagers();
    if (headManagers.length === 0) {
      throw new ACPError(
        "No agents available to send peer message",
        "AGENT_NOT_FOUND",
      );
    }
    const sendingAgentId = headManagers[0].id;

    try {
      await this.peerManager.sendMessage(sendingAgentId, params.to, {
        type: params.type,
        payload: params.payload,
        metadata: params.correlationId
          ? { correlationId: params.correlationId }
          : undefined,
      });

      return {
        success: true,
        timestamp: Date.now(),
      };
    } catch (error) {
      throw new ACPError(
        `Failed to send peer message: ${error instanceof Error ? error.message : String(error)}`,
        "PEER_SEND_FAILED",
        { to: params.to, error },
      );
    }
  }

  /**
   * Send a peer request (outbound, request-response)
   *
   * Called by external clients to have an agent send a request to a peer
   * and wait for a response.
   */
  private async handleSendPeerRequest(
    params: SendPeerRequestACPRequest,
  ): Promise<SendPeerRequestACPResponse> {
    if (!this.peerManager) {
      throw new ACPError(
        "PeerManager not configured for this macro-agent",
        "NO_PEER_MANAGER",
      );
    }

    // Determine which agent is sending (use head manager by default)
    const headManagers = this.agentManager.listHeadManagers();
    if (headManagers.length === 0) {
      throw new ACPError(
        "No agents available to send peer request",
        "AGENT_NOT_FOUND",
      );
    }
    const sendingAgentId = headManagers[0].id;

    try {
      const response = await this.peerManager.sendRequest(
        sendingAgentId,
        params.to,
        {
          method: params.method,
          params: params.params,
          timeout: params.timeout,
        },
      );

      return response;
    } catch (error) {
      throw new ACPError(
        `Failed to send peer request: ${error instanceof Error ? error.message : String(error)}`,
        "PEER_SEND_FAILED",
        { to: params.to, error },
      );
    }
  }

  /**
   * Deliver a peer message (inbound, fire-and-forget)
   *
   * Called by external clients to route an inbound message from a peer
   * to this macro-agent. The message is queued for the target agent.
   */
  private async handleDeliverPeerMessage(
    params: DeliverPeerMessageRequest,
  ): Promise<DeliverPeerMessageResponse> {
    if (!this.peerManager) {
      throw new ACPError(
        "PeerManager not configured for this macro-agent",
        "NO_PEER_MANAGER",
      );
    }

    // Use PeerManager's deliverMessage to queue the message
    const messageId = this.peerManager.deliverMessage(
      params.from,
      {
        type: params.type,
        payload: params.payload,
        metadata: params.correlationId
          ? { correlationId: params.correlationId }
          : undefined,
      },
      params.targetAgentId,
    );

    return {
      success: true,
      messageId,
    };
  }

  /**
   * Deliver a peer request (inbound, request-response)
   *
   * Called by external clients to route an inbound request from a peer
   * to this macro-agent. The request is queued and this waits for the
   * internal agent to respond.
   */
  private async handleDeliverPeerRequest(
    params: DeliverPeerRequestRequest,
  ): Promise<DeliverPeerRequestResponse> {
    if (!this.peerManager) {
      throw new ACPError(
        "PeerManager not configured for this macro-agent",
        "NO_PEER_MANAGER",
      );
    }

    // Use PeerManager's deliverRequest which returns a promise
    // that resolves when the internal agent responds
    const response = await this.peerManager.deliverRequest(
      params.from,
      {
        method: params.method,
        params: params.params,
        timeout: params.timeout,
      },
      params.targetAgentId,
    );

    return response;
  }

  // ─────────────────────────────────────────────────────────────────
  // Capability Extension Handlers
  // ─────────────────────────────────────────────────────────────────

  /**
   * Grant capabilities to a peer
   */
  private async handleGrantCapability(
    params: GrantCapabilityRequest,
  ): Promise<GrantCapabilityResponse> {
    if (!this.capabilityManager) {
      throw new ACPError(
        "CapabilityManager not configured for this macro-agent",
        "NO_PEER_MANAGER",
      );
    }

    const capabilities = this.capabilityManager.grant(
      params.peerId,
      params.grants,
      {
        expiresIn: params.expiresIn,
        issuedBy: params.issuedBy,
      },
    );

    return { capabilities };
  }

  /**
   * Revoke capabilities from a peer
   */
  private async handleRevokeCapability(
    params: RevokeCapabilityRequest,
  ): Promise<RevokeCapabilityResponse> {
    if (!this.capabilityManager) {
      throw new ACPError(
        "CapabilityManager not configured for this macro-agent",
        "NO_PEER_MANAGER",
      );
    }

    this.capabilityManager.revoke(params.peerId, params.grantTypes);

    return {
      success: true,
      remainingCapabilities: this.capabilityManager.getCapabilities(
        params.peerId,
      ),
    };
  }

  /**
   * Get capabilities for a peer or list all authorized peers
   */
  private async handleGetCapabilities(
    params: GetCapabilitiesRequest,
  ): Promise<GetCapabilitiesResponse> {
    if (!this.capabilityManager) {
      throw new ACPError(
        "CapabilityManager not configured for this macro-agent",
        "NO_PEER_MANAGER",
      );
    }

    if (params.peerId) {
      return {
        capabilities: this.capabilityManager.getCapabilities(params.peerId),
      };
    }

    return {
      authorizedPeers: this.capabilityManager.listAuthorizedPeers(),
    };
  }

  /**
   * Check if a peer has a required capability
   */
  private async handleCheckCapability(
    params: CheckCapabilityRequest,
  ): Promise<CheckCapabilityResponse> {
    if (!this.capabilityManager) {
      throw new ACPError(
        "CapabilityManager not configured for this macro-agent",
        "NO_PEER_MANAGER",
      );
    }

    return {
      hasCapability: this.capabilityManager.hasCapability(
        params.peerId,
        params.required,
      ),
    };
  }

  // ─────────────────────────────────────────────────────────────────
  // Permission Extension Handlers
  // ─────────────────────────────────────────────────────────────────

  /**
   * Respond to a permission request for a session
   *
   * Routes the response through the session mapper to find the agent,
   * then calls the agent manager to resolve the pending permission.
   */
  private async handleRespondToPermission(
    params: RespondToPermissionRequest,
  ): Promise<RespondToPermissionResponse> {
    const { sessionId, requestId, optionId } = params;

    // Get the agent ID from session mapper
    const agentId = this.sessionMapper.getAgentId(sessionId);
    if (!agentId) {
      return {
        success: false,
        error: `No agent found for session: ${sessionId}`,
      };
    }

    // Respond via agent manager
    const success = this.agentManager.respondToPermission(
      agentId,
      requestId,
      optionId,
    );

    if (success) {
      console.log(
        `[MacroAgent] Responded to permission ${requestId} for session ${sessionId} with ${optionId}`,
      );
      return { success: true };
    } else {
      return {
        success: false,
        error: `Failed to respond to permission ${requestId} for agent ${agentId}`,
      };
    }
  }

  /**
   * Cancel a permission request for a session
   *
   * Routes the cancellation through the session mapper to find the agent,
   * then calls the agent manager to cancel the pending permission.
   */
  private async handleCancelPermission(
    params: CancelPermissionRequest,
  ): Promise<CancelPermissionResponse> {
    const { sessionId, requestId } = params;

    // Get the agent ID from session mapper
    const agentId = this.sessionMapper.getAgentId(sessionId);
    if (!agentId) {
      return {
        success: false,
        error: `No agent found for session: ${sessionId}`,
      };
    }

    // Cancel via agent manager
    const success = this.agentManager.cancelPermission(agentId, requestId);

    if (success) {
      console.log(
        `[MacroAgent] Cancelled permission ${requestId} for session ${sessionId}`,
      );
      return { success: true };
    } else {
      return {
        success: false,
        error: `Failed to cancel permission ${requestId} for agent ${agentId}`,
      };
    }
  }

  /**
   * Resume a stopped/failed agent
   */
  private async handleResumeAgent(
    params: ResumeAgentRequest,
  ): Promise<ResumeAgentResponse> {
    const { agentId } = params;

    if (!agentId) {
      throw new ACPError("agentId is required", "INVALID_EXTENSION");
    }

    // Verify agent exists
    const agent = this.eventStore.getAgent(agentId);
    if (!agent) {
      throw new ACPError(`Agent not found: ${agentId}`, "AGENT_NOT_FOUND");
    }

    // Only resume stopped/failed agents
    if (agent.state !== "stopped" && agent.state !== "failed") {
      throw new ACPError(
        `Agent ${agentId} is ${agent.state} — only stopped or failed agents can be resumed`,
        "INVALID_EXTENSION",
      );
    }

    console.log(`[MacroAgent] Resuming agent ${agentId}`);
    const spawned = await this.agentManager.resume(agentId);

    return {
      success: true,
      agentId: spawned.id,
      sessionId: spawned.session_id,
    };
  }

  // ─────────────────────────────────────────────────────────────────
  // Helper Methods
  // ─────────────────────────────────────────────────────────────────

  /**
   * Extract text content from prompt content blocks
   */
  private extractMessageContent(prompt: PromptRequest["prompt"]): string {
    // Handle content blocks array
    if (Array.isArray(prompt)) {
      return prompt
        .map((block) => {
          if ("text" in block) {
            return block.text;
          }
          return "";
        })
        .filter(Boolean)
        .join("\n");
    }

    return "";
  }

  /**
   * Forward session updates from child agents to the ACP client
   *
   * acp-factory already sends updates in ACP SDK format, so we forward
   * all updates directly. This handles all update types including:
   * - agent_message_chunk: Text content from agent
   * - agent_thought_chunk: Agent thinking/reasoning (if enabled)
   * - user_message_chunk: Echo of user messages
   * - tool_call: Tool invocation start
   * - tool_call_update: Tool execution progress/completion
   * - plan: Plan updates
   * - available_commands_update: Available slash commands
   * - current_mode_update: Mode changes (code/plan/etc)
   * - config_option_update: Configuration changes
   * - session_info_update: Session title and timestamps
   *
   * Permission requests are handled separately via the requestPermission RPC.
   */
  private async forwardSessionUpdate(
    acpSessionId: ACPSessionId,
    update: unknown,
  ): Promise<void> {
    const sessionUpdate = update as Record<string, unknown>;

    // Check if this is a valid session update with the sessionUpdate discriminator
    if (!("sessionUpdate" in sessionUpdate)) {
      console.warn(
        `[MacroAgent] Received update without sessionUpdate field:`,
        JSON.stringify(update).substring(0, 200),
      );
      return;
    }

    const updateType = sessionUpdate.sessionUpdate as string;

    // Log update details based on type (verbose logging for debugging)
    switch (updateType) {
      case "agent_message_chunk":
      case "agent_thought_chunk":
      case "user_message_chunk": {
        const content = sessionUpdate.content as
          | { type?: string; text?: string }
          | undefined;
        const text = content?.text ?? "";
        if (text) {
          console.log(
            `[MacroAgent] Forwarding ${updateType} (${text.length} chars): "${text.substring(0, 80)}${text.length > 80 ? "..." : ""}"`,
          );
        }
        break;
      }

      case "tool_call": {
        const toolCallId = sessionUpdate.toolCallId as string;
        const title = sessionUpdate.title as string;
        const status = sessionUpdate.status as string;
        console.log(
          `[MacroAgent] Forwarding tool_call: id=${toolCallId}, title="${title}", status=${status}`,
        );
        break;
      }

      case "tool_call_update": {
        const toolCallId = sessionUpdate.toolCallId as string;
        const status = sessionUpdate.status as string;
        console.log(
          `[MacroAgent] Forwarding tool_call_update: id=${toolCallId}, status=${status}`,
        );
        break;
      }

      case "permission_request": {
        // Handle permission_request specially - ACP SDK doesn't recognize it as a session update
        // We need to call requestPermission on the connection to forward to the client

        // Extract permission request data
        const permReq = sessionUpdate as {
          requestId: string;
          sessionId: string;
          toolCall: {
            toolCallId: string;
            title: string;
            status?: string;
            rawInput?: unknown;
          };
          options: Array<{
            kind: string;
            name: string;
            optionId: string;
          }>;
        };

        // Get the agent ID for this session to forward the response back
        const agentId = this.sessionMapper.getAgentId(permReq.sessionId);
        if (!agentId) {
          console.warn(
            `[MacroAgent] No agent found for session ${permReq.sessionId}, cannot forward permission request`,
          );
          return;
        }

        // Forward via requestPermission RPC
        // This will trigger the client's handler which will show the prompt
        try {
          const response = await this.connection.requestPermission({
            sessionId: acpSessionId,
            toolCall: {
              toolCallId: permReq.toolCall.toolCallId,
              title: permReq.toolCall.title,
              status: permReq.toolCall.status as
                | "pending"
                | "in_progress"
                | "completed"
                | "failed"
                | undefined,
              rawInput: permReq.toolCall.rawInput,
            },
            options: permReq.options as Array<{
              kind:
                | "allow_once"
                | "allow_always"
                | "reject_once"
                | "reject_always";
              name: string;
              optionId: string;
            }>,
          });

          // Forward the response back to the sub-agent via agentManager
          if (response.outcome) {
            if (
              response.outcome.outcome === "selected" &&
              response.outcome.optionId
            ) {
              const success = this.agentManager.respondToPermission(
                agentId,
                permReq.requestId,
                response.outcome.optionId,
              );
              if (!success) {
                console.warn(
                  `[MacroAgent] Failed to forward permission response to agent ${agentId}`,
                );
              }
            } else if (response.outcome.outcome === "cancelled") {
              const success = this.agentManager.cancelPermission(
                agentId,
                permReq.requestId,
              );
              if (!success) {
                console.warn(
                  `[MacroAgent] Failed to cancel permission for agent ${agentId}`,
                );
              }
            }
          }
        } catch (err) {
          console.error(
            `[MacroAgent] Failed to forward permission_request:`,
            err instanceof Error ? err.message : err,
          );
          // Cancel the permission request on error
          try {
            this.agentManager.cancelPermission(agentId, permReq.requestId);
          } catch {
            // Ignore cancel errors
          }
        }
        // Don't forward via sessionUpdate - we handled it via requestPermission
        return;
      }

      default:
        // Log other update types at debug level
        console.log(`[MacroAgent] Forwarding ${updateType}`);
    }

    // Accumulate content for history persistence (preserving text/tool interleaving order)
    const buffer = this.promptBuffers.get(acpSessionId);
    if (buffer) {
      if (updateType === "agent_message_chunk") {
        const content = sessionUpdate.content as
          | { type?: string; text?: string }
          | undefined;
        if (content?.text) {
          const last = buffer.parts[buffer.parts.length - 1];
          if (last && last.type === "text") {
            last.text += content.text;
          } else {
            buffer.parts.push({ type: "text", text: content.text });
          }
        }
      } else if (
        updateType === "tool_call" ||
        updateType === "tool_call_update"
      ) {
        const toolCallId = sessionUpdate.toolCallId as string | undefined;
        const status = sessionUpdate.status as string | undefined;
        const meta = sessionUpdate._meta as { claudeCode?: { toolName?: string } } | undefined;
        const toolInfoCache = this.toolInfoCaches.get(acpSessionId);

        // Cache tool info from initial tool_call events
        if (updateType === "tool_call" && toolCallId && toolInfoCache) {
          toolInfoCache.set(toolCallId, {
            title: sessionUpdate.title as string | undefined,
            name: meta?.claudeCode?.toolName,
            input: sessionUpdate.rawInput,
          });
        }

        if (status === "completed" || status === "failed") {
          // Merge cached info for tool_call_update events that lack title/input
          const cached = toolCallId ? toolInfoCache?.get(toolCallId) : undefined;
          buffer.parts.push({
            type: "tool",
            toolCallId,
            title: sessionUpdate.title ?? cached?.title,
            name: meta?.claudeCode?.toolName ?? cached?.name,
            status: sessionUpdate.status,
            input: sessionUpdate.rawInput ?? cached?.input,
            output: extractToolOutput(sessionUpdate.rawOutput),
          });
        }
      }
    }

    // Forward updates via sessionUpdate (except permission_request which is handled above)
    try {
      await this.connection.sessionUpdate({
        sessionId: acpSessionId,
        update: sessionUpdate as Parameters<
          AgentSideConnection["sessionUpdate"]
        >[0]["update"],
      });
    } catch (err) {
      console.error(
        `[MacroAgent] Failed to forward ${updateType}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  /**
   * Emit a session_info_update with title and timestamps.
   * Uses agent task as title and session mapping timestamps.
   */
  private async emitSessionInfo(acpSessionId: ACPSessionId): Promise<void> {
    const mapping = this.sessionMapper.getMapping(acpSessionId);
    const agentId = mapping?.agentId;
    const agent = agentId ? this.eventStore.getAgent(agentId) : null;

    const title = agent?.task ?? null;
    const updatedAt = new Date(mapping?.updatedAt ?? Date.now()).toISOString();

    try {
      await this.connection.sessionUpdate({
        sessionId: acpSessionId,
        update: {
          sessionUpdate: "session_info_update",
          title,
          updatedAt,
        } as Parameters<AgentSideConnection["sessionUpdate"]>[0]["update"],
      });
    } catch (err) {
      console.warn(
        `[MacroAgent] Failed to send session_info_update:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  /**
   * Build system prompt with configured prefix/suffix
   */
  private buildSystemPrompt(): string | undefined {
    const { systemPromptPrefix, systemPromptSuffix } = this.initConfig;

    if (!systemPromptPrefix && !systemPromptSuffix) {
      return undefined;
    }

    const parts: string[] = [];
    if (systemPromptPrefix) {
      parts.push(systemPromptPrefix);
    }
    if (systemPromptSuffix) {
      parts.push(systemPromptSuffix);
    }

    return parts.join("\n\n");
  }

  /**
   * Merge default sub-agent config with per-spawn override
   *
   * Override values take precedence over defaults.
   * Arrays (like mcpServers) are concatenated, not replaced.
   */
  private mergeSubAgentConfig(
    defaults?: SubAgentConfig,
    override?: SubAgentConfig,
  ): SubAgentConfig | undefined {
    if (!defaults && !override) {
      return undefined;
    }

    if (!defaults) {
      return override;
    }

    if (!override) {
      return defaults;
    }

    // Deep merge with override taking precedence
    return {
      model: override.model ?? defaults.model,
      maxTokens: override.maxTokens ?? defaults.maxTokens,
      temperature: override.temperature ?? defaults.temperature,
      permissionMode: override.permissionMode ?? defaults.permissionMode,
      agentType: override.agentType ?? defaults.agentType,
      // Merge env variables (override takes precedence for same keys)
      env:
        defaults.env || override.env
          ? { ...defaults.env, ...override.env }
          : undefined,
      // Concatenate MCP servers (both default and override)
      mcpServers:
        [...(defaults.mcpServers ?? []), ...(override.mcpServers ?? [])]
          .length > 0
          ? [...(defaults.mcpServers ?? []), ...(override.mcpServers ?? [])]
          : undefined,
    };
  }

  /**
   * Convert SubAgentConfig to internal AgentConfig format
   */
  private toAgentConfig(config?: SubAgentConfig): AgentConfig | undefined {
    if (!config) {
      return undefined;
    }

    return {
      model: config.model,
      maxTokens: config.maxTokens,
      temperature: config.temperature,
      env: config.env,
      mcpServers: config.mcpServers?.map((server) => ({
        name: server.name,
        command: server.command,
        args: server.args,
        env: server.env,
      })),
    };
  }

  // ─────────────────────────────────────────────────────────────────
  // History Persistence Helpers
  // ─────────────────────────────────────────────────────────────────

  /**
   * Ensure a conversation exists in the EventStore for a session.
   * Uses the ACP session ID as the conversation ID for direct lookup.
   */
  private ensureConversation(
    acpSessionId: ACPSessionId,
    agentId: AgentId,
  ): void {
    // Guard: EventStore may not support conversations (e.g., in tests with mocks)
    if (typeof this.eventStore.getConversation !== "function") return;

    // Check if conversation already exists
    const existing = this.eventStore.getConversation(acpSessionId);
    if (existing) return;

    try {
      this.eventStore.emit({
        type: "conversation",
        source: { agent_id: agentId },
        payload: {
          action: "created",
          conversation_id: acpSessionId,
          conversation_type: "session",
          subject: `ACP session ${acpSessionId}`,
        },
      });
    } catch (error) {
      console.warn(
        `[MacroAgent] Failed to create conversation for session ${acpSessionId}:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  /**
   * Record user and assistant turns after a prompt completes.
   */
  private recordPromptTurns(
    acpSessionId: ACPSessionId,
    agentId: AgentId,
    userMessage: string,
  ): void {
    const buffer = this.promptBuffers.get(acpSessionId);
    if (!buffer) return;

    const now = Date.now();

    try {
      // Record user turn
      if (userMessage) {
        this.eventStore.emit({
          type: "turn",
          source: { agent_id: agentId },
          payload: {
            action: "recorded",
            turn_id: `turn_user_${now}_${Math.random().toString(36).slice(2, 8)}`,
            conversation_id: acpSessionId,
            participant: "user",
            timestamp: now,
            content_type: "user_prompt",
            content: userMessage,
            source_type: "explicit",
          },
        });
      }

      // Record assistant turn with accumulated content (parts already in order)
      const parts = buffer.parts;

      if (parts.length > 0) {
        this.eventStore.emit({
          type: "turn",
          source: { agent_id: agentId },
          payload: {
            action: "recorded",
            turn_id: `turn_asst_${now}_${Math.random().toString(36).slice(2, 8)}`,
            conversation_id: acpSessionId,
            participant: agentId,
            timestamp: now + 1, // +1ms to ensure ordering after user turn
            content_type: "assistant_response",
            content: { parts },
            source_type: "explicit",
          },
        });
      }
    } catch (error) {
      console.warn(
        `[MacroAgent] Failed to record turns for session ${acpSessionId}:`,
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      // Clean up the buffer and tool info cache
      this.promptBuffers.delete(acpSessionId);
      this.toolInfoCaches.delete(acpSessionId);
    }
  }

  /**
   * Handle _macro/getHistory extension — returns conversation turns for a session
   */
  private handleGetHistory(params: GetHistoryRequest): GetHistoryResponse {
    const { sessionId, limit } = params;

    // Query turns from EventStore (conversation ID = session ID)
    const turns = this.eventStore.listTurns({
      conversationId: sessionId,
      order: "asc",
      limit: limit ?? 200,
    });

    // Convert to HistoryTurn format
    const historyTurns: HistoryTurn[] = turns.map((turn) => ({
      role:
        turn.contentType === "user_prompt"
          ? ("user" as const)
          : ("assistant" as const),
      timestamp: turn.timestamp,
      content: turn.content,
    }));

    return { turns: historyTurns };
  }

  // ─────────────────────────────────────────────────────────────────
  // Accessors
  // ─────────────────────────────────────────────────────────────────

  /**
   * Get the session mapper for testing/debugging
   */
  getSessionMapper(): SessionMapper {
    return this.sessionMapper;
  }

  /**
   * Get mapped agent ID for a session
   */
  getMappedAgentId(acpSessionId: ACPSessionId): AgentId | undefined {
    return this.sessionMapper.getAgentId(acpSessionId);
  }

  /**
   * Get the applied initialization config
   */
  getInitConfig(): MacroAgentInitConfig {
    return this.initConfig;
  }
}
