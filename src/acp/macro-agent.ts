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
} from "./types.js";
import { ACPError } from "./types.js";

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
  private sessionMapper: SessionMapper;
  private defaultCwd: string;

  /** Map of ACP session ID to cancellation abort controllers */
  private cancellationControllers: Map<ACPSessionId, AbortController> =
    new Map();

  constructor(connection: AgentSideConnection, config: MacroAgentConfig) {
    this.connection = connection;
    this.agentManager = config.agentManager;
    this.eventStore = config.eventStore;
    this.taskManager = config.taskManager;
    this.sessionMapper = new SessionMapper();
    this.defaultCwd = config.defaultCwd ?? process.cwd();
  }

  // ─────────────────────────────────────────────────────────────────
  // Core ACP Methods
  // ─────────────────────────────────────────────────────────────────

  /**
   * Initialize the connection and advertise capabilities
   */
  async initialize(
    _params: InitializeRequest
  ): Promise<InitializeResponse> {
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        _meta: {
          extensions: SUPPORTED_EXTENSIONS,
          agentType: "macro-agent",
        },
      },
    };
  }

  /**
   * Create a new session by spawning a head manager
   */
  async newSession(
    params: NewSessionRequest
  ): Promise<NewSessionResponse> {
    const cwd = params.cwd ?? this.defaultCwd;

    // Spawn a new head manager for this session
    const spawned = await this.agentManager.getOrCreateHeadManager({
      cwd,
      forceNew: true, // Always create new for newSession
    });

    // Create session mapping
    const acpSessionId = spawned.session_id;
    this.sessionMapper.createMapping(acpSessionId, spawned.id);

    // Create abort controller for cancellation
    this.cancellationControllers.set(acpSessionId, new AbortController());

    return {
      sessionId: acpSessionId,
    };
  }

  /**
   * Load an existing session from EventStore
   */
  async loadSession(
    params: LoadSessionRequest
  ): Promise<LoadSessionResponse> {
    const acpSessionId = params.sessionId;
    const cwd = params.cwd ?? this.defaultCwd;

    // Try to find an existing head manager with this session ID
    const headManagers = this.agentManager.listHeadManagers();
    const existing = headManagers.find((hm) => hm.session_id === acpSessionId);

    if (existing) {
      // Resume the existing session
      const spawned = await this.agentManager.resume(existing.id);

      // Create session mapping
      this.sessionMapper.createMapping(acpSessionId, spawned.id);
      this.cancellationControllers.set(acpSessionId, new AbortController());

      return {};
    }

    // Try to get or create with the specific session ID
    const spawned = await this.agentManager.getOrCreateHeadManager({
      cwd,
      sessionId: acpSessionId,
    });

    // Create session mapping
    this.sessionMapper.createMapping(acpSessionId, spawned.id);
    this.cancellationControllers.set(acpSessionId, new AbortController());

    return {};
  }

  /**
   * Authenticate - macro-agent doesn't require authentication
   */
  async authenticate(
    _params: AuthenticateRequest
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

    try {
      // Stream responses from the agent
      for await (const update of this.agentManager.prompt(
        agentId,
        messageContent
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
          type: "agent_message_chunk",
          textChunk: `Error: ${errorMessage}`,
        },
      });

      return {
        stopReason: "end_turn",
      };
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

    // TODO: Propagate cancellation to child agents if needed
  }

  // ─────────────────────────────────────────────────────────────────
  // Extension Methods
  // ─────────────────────────────────────────────────────────────────

  /**
   * Route extension method calls to handlers
   */
  async extMethod(
    method: string,
    params: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    // Method comes in without the underscore prefix
    const fullMethod = `_${method}` as ACPExtensionMethod;

    switch (fullMethod) {
      case "_macro/spawnAgent":
        return this.handleSpawnAgent(
          params as unknown as SpawnAgentRequest
        ) as unknown as Record<string, unknown>;

      case "_macro/getHierarchy":
        return this.handleGetHierarchy(
          params as unknown as GetHierarchyRequest
        ) as unknown as Record<string, unknown>;

      case "_macro/getTask":
        return this.handleGetTask(
          params as unknown as GetTaskRequest
        ) as unknown as Record<string, unknown>;

      case "_macro/mountAgent":
        return this.handleMountAgent(
          params as unknown as MountAgentRequest
        ) as unknown as Record<string, unknown>;

      case "_macro/forkAgent":
        return this.handleForkAgent(
          params as unknown as ForkAgentRequest
        ) as unknown as Record<string, unknown>;

      default:
        throw new ACPError(
          `Unknown extension method: ${method}`,
          "INVALID_EXTENSION"
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
    params: SpawnAgentRequest
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

    // Spawn the agent
    const spawned = await this.agentManager.spawn({
      task: params.task_description,
      parent: parentId ?? null,
      cwd: params.options?.cwd ?? this.defaultCwd,
      subscribeParent: params.options?.subscribeParent ?? true,
      topics: params.options?.topics,
    });

    return {
      agentId: spawned.id,
      taskId: spawned.agent.task_id!,
      sessionId: spawned.session_id,
    };
  }

  /**
   * Get the agent hierarchy tree
   */
  private async handleGetHierarchy(
    params: GetHierarchyRequest
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
      throw new ACPError(
        `Agent not found: ${rootAgentId}`,
        "AGENT_NOT_FOUND",
        { agentId: rootAgentId }
      );
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
    params: GetTaskRequest
  ): Promise<GetTaskResponse> {
    const task = this.taskManager.get(params.taskId);

    if (!task) {
      throw new ACPError(
        `Task not found: ${params.taskId}`,
        "TASK_NOT_FOUND",
        { taskId: params.taskId }
      );
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
    params: MountAgentRequest
  ): Promise<MountAgentResponse> {
    const { sessionId, agentId } = params;

    // Verify the target agent exists
    const agent = this.agentManager.get(agentId);
    if (!agent) {
      throw new ACPError(
        `Agent not found: ${agentId}`,
        "AGENT_NOT_FOUND",
        { agentId }
      );
    }

    // Verify the session exists in our mapper
    const mapping = this.sessionMapper.getMapping(sessionId);
    if (!mapping) {
      throw new ACPError(
        `Session not found: ${sessionId}`,
        "SESSION_NOT_FOUND",
        { sessionId }
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
    params: ForkAgentRequest
  ): Promise<ForkAgentResponse> {
    const { agentId, name } = params;

    // Get the original agent
    const originalAgent = this.agentManager.get(agentId);
    if (!originalAgent) {
      throw new ACPError(
        `Agent not found: ${agentId}`,
        "AGENT_NOT_FOUND",
        { agentId }
      );
    }

    // Check if the agent has an active session we can fork from
    const hasSession = this.agentManager.hasActiveSession(agentId);
    if (!hasSession) {
      throw new ACPError(
        `Agent has no active session to fork: ${agentId}`,
        "FORK_NOT_SUPPORTED",
        { agentId }
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
  // Helper Methods
  // ─────────────────────────────────────────────────────────────────

  /**
   * Extract text content from prompt content blocks
   */
  private extractMessageContent(
    prompt: PromptRequest["prompt"]
  ): string {
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
   */
  private async forwardSessionUpdate(
    acpSessionId: ACPSessionId,
    update: unknown
  ): Promise<void> {
    // Map internal session updates to ACP SessionNotification format
    const sessionUpdate = update as Record<string, unknown>;

    // Handle different update types from acp-factory
    if ("sessionUpdate" in sessionUpdate) {
      const updateType = sessionUpdate.sessionUpdate as string;

      switch (updateType) {
        case "agent_message_chunk":
          await this.connection.sessionUpdate({
            sessionId: acpSessionId,
            update: {
              type: "agent_message_chunk",
              textChunk: (sessionUpdate.textChunk as string) ?? "",
            },
          });
          break;

        case "tool_call":
          await this.connection.sessionUpdate({
            sessionId: acpSessionId,
            update: {
              type: "tool_call",
              toolCallId: sessionUpdate.toolCallId as string,
              title: sessionUpdate.title as string,
              status: sessionUpdate.status as "pending",
            },
          });
          break;

        case "tool_call_update":
          await this.connection.sessionUpdate({
            sessionId: acpSessionId,
            update: {
              type: "tool_call_update",
              toolCallId: sessionUpdate.toolCallId as string,
              status: sessionUpdate.status as "in_progress" | "completed",
            },
          });
          break;

        // Add more update types as needed
      }
    }
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
}
