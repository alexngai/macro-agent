/**
 * ACP-over-MAP Handler
 *
 * Handles ACP protocol messages that arrive via MAP instead of direct WebSocket.
 * Provides a bridge between MAP messaging and the MacroAgent ACP implementation.
 *
 * This allows external clients to communicate with macro-agent agents using
 * ACP protocol semantics over the MAP transport layer.
 */

import type { AgentManager } from "../../agent/agent-manager.js";
import type { EventStore } from "../../store/event-store.js";
import type { TaskManager } from "../../task/task-manager.js";
import type { AgentId } from "../../store/types/index.js";
import type { AgentConfig } from "../../agent/types.js";
import { SessionMapper } from "../../acp/session-mapper.js";
import type { ACPSessionId } from "../../acp/types.js";

// ─────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────

/** Extract a plain-text output string from `rawOutput` (string | ContentBlock[] | undefined). */
function extractToolOutput(rawOutput: unknown): string | undefined {
  if (typeof rawOutput === "string") return rawOutput;
  if (Array.isArray(rawOutput)) {
    return (
      rawOutput
        .filter(
          (item: any) => item.type === "text" && typeof item.text === "string",
        )
        .map((item: any) => item.text as string)
        .join("\n") || undefined
    );
  }
  return undefined;
}

// ─────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────

export interface ACPEnvelope {
  acp: {
    jsonrpc: string;
    id?: string | number;
    method?: string;
    params?: unknown;
    result?: unknown;
    error?: { code: number; message: string; data?: unknown };
  };
  acpContext: {
    streamId: string;
    sessionId?: string;
    direction: string;
  };
}

export interface ACPOverMAPConfig {
  agentManager: AgentManager;
  eventStore: EventStore;
  taskManager: TaskManager;
  defaultCwd?: string;

  /**
   * Callback when a new agent is created via session/new or session/loadSession.
   * Used by MAPAdapter to emit agent.registered events to all subscribers.
   */
  onAgentRegistered?: (agent: {
    id: string;
    name?: string;
    role?: string;
    parent?: string;
    metadata?: Record<string, unknown>;
  }) => void;
}

/**
 * Callback for emitting ACP notifications during request processing.
 * Used to stream session updates back to the client.
 */
export type ACPNotificationEmitter = (notification: ACPEnvelope) => void;

interface StreamState {
  initialized: boolean;
  streamId: string;
  sessionId?: string;
  agentId?: AgentId;
  abortController: AbortController;
  /** Permission mode from initialization _meta */
  permissionMode?: "auto-approve" | "auto-deny" | "callback" | "interactive";
}

// ─────────────────────────────────────────────────────────────────
// ACP-over-MAP Handler
// ─────────────────────────────────────────────────────────────────

export class ACPOverMAPHandler {
  private agentManager: AgentManager;
  private eventStore: EventStore;
  private taskManager: TaskManager;
  private defaultCwd: string;
  private onAgentRegistered?: ACPOverMAPConfig["onAgentRegistered"];

  /** Stream states by streamId */
  private streams: Map<string, StreamState> = new Map();

  /** Session mapper for ACP session -> Agent mapping */
  private sessionMapper: SessionMapper;

  constructor(config: ACPOverMAPConfig) {
    this.agentManager = config.agentManager;
    this.eventStore = config.eventStore;
    this.taskManager = config.taskManager;
    this.defaultCwd = config.defaultCwd ?? process.cwd();
    this.onAgentRegistered = config.onAgentRegistered;

    // Initialize session mapper with EventStore for persistence and recovery
    this.sessionMapper = new SessionMapper(this.eventStore);
    const recovered = this.sessionMapper.recoverFromStore();
    if (recovered > 0) {
      console.error(
        `[ACP-over-MAP] Recovered ${recovered} session(s) from store`,
      );
    }
  }

  /**
   * Notify subscribers that a new agent was registered.
   * Looks up agent details from EventStore and calls the onAgentRegistered callback.
   */
  private notifyAgentRegistered(agentId: string): void {
    if (!this.onAgentRegistered) return;
    const agent = this.eventStore.getAgent(agentId as AgentId);
    this.onAgentRegistered({
      id: agentId,
      name: agent?.name,
      role: agent?.role,
      parent: agent?.parent ?? undefined,
      metadata: agent?.metadata,
    });
  }

  /**
   * Abort all active streams targeting a specific agent.
   * Called when an agent is stopped via MAP protocol to interrupt
   * any in-progress ACP prompt streaming.
   */
  abortStreamsForAgent(agentId: AgentId): void {
    for (const [streamId, streamState] of this.streams) {
      if (streamState.agentId === agentId) {
        console.error(
          `[ACP-over-MAP] Aborting stream ${streamId} for stopped agent ${agentId}`,
        );
        streamState.abortController.abort();
      }
    }
  }

  /**
   * Process an ACP request and return the response.
   * @param targetAgentId - Target agent for the request
   * @param envelope - ACP request envelope
   * @param emitNotification - Optional callback to emit notifications (for streaming updates)
   */
  async processRequest(
    targetAgentId: AgentId,
    envelope: ACPEnvelope,
    emitNotification?: ACPNotificationEmitter,
  ): Promise<ACPEnvelope> {
    const { acp, acpContext } = envelope;
    const { streamId, sessionId } = acpContext;
    const method = acp.method;

    console.error(
      `[ACP-over-MAP] Processing - streamId=${streamId} method=${method}`,
    );

    // Get or create stream state
    let streamState = this.streams.get(streamId);
    if (!streamState) {
      streamState = {
        initialized: false,
        streamId,
        abortController: new AbortController(),
      };
      this.streams.set(streamId, streamState);
    }

    let result: unknown;
    let error: { code: number; message: string; data?: unknown } | undefined;

    try {
      switch (method) {
        case "initialize":
          result = await this.handleInitialize(streamState, acp.params);
          break;

        case "session/new":
          result = await this.handleNewSession(
            streamState,
            acp.params,
            emitNotification,
          );
          break;

        case "session/load":
          result = await this.handleLoadSession(
            streamState,
            acp.params,
            emitNotification,
          );
          break;

        case "authenticate":
          result = await this.handleAuthenticate(acp.params);
          break;

        case "session/prompt":
          result = await this.handlePrompt(
            streamState,
            acp.params,
            sessionId,
            emitNotification,
          );
          break;

        case "session/cancel":
          result = await this.handleCancel(streamState, acp.params, sessionId);
          break;

        default:
          // Check for extension methods
          if (method?.startsWith("_")) {
            result = await this.handleExtension(
              streamState,
              method,
              acp.params,
            );
          } else {
            throw new Error(`Unknown ACP method: ${method}`);
          }
      }
    } catch (e) {
      console.error(`[ACP-over-MAP] Error processing ${method}:`, e);
      error = {
        code: -32603,
        message: e instanceof Error ? e.message : String(e),
      };
    }

    // Build response envelope
    return {
      acp: {
        jsonrpc: "2.0",
        id: acp.id,
        ...(error ? { error } : { result }),
      },
      acpContext: {
        streamId,
        sessionId: streamState.sessionId,
        direction: "agent-to-client",
      },
    };
  }

  // ─────────────────────────────────────────────────────────────────
  // Core ACP Methods
  // ─────────────────────────────────────────────────────────────────

  private async handleInitialize(
    streamState: StreamState,
    params: unknown,
  ): Promise<unknown> {
    if (streamState.initialized) {
      throw new Error("Stream already initialized");
    }

    streamState.initialized = true;

    // Extract permission mode from _meta.macroConfig if provided
    const meta = (params as Record<string, unknown> | undefined)?._meta as
      | Record<string, unknown>
      | undefined;
    const macroConfig = meta?.macroConfig as
      | Record<string, unknown>
      | undefined;
    const defaultSubAgentConfig = macroConfig?.defaultSubAgentConfig as
      | Record<string, unknown>
      | undefined;
    if (defaultSubAgentConfig?.permissionMode) {
      streamState.permissionMode =
        defaultSubAgentConfig.permissionMode as StreamState["permissionMode"];
    }

    return {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        _meta: {
          extensions: [
            "_macro/spawnAgent",
            "_macro/getHierarchy",
            "_macro/getTask",
          ],
          agentType: "macro-agent",
          transport: "acp-over-map",
        },
      },
    };
  }

  private async handleNewSession(
    streamState: StreamState,
    params: unknown,
    emitNotification?: ACPNotificationEmitter,
  ): Promise<unknown> {
    if (!streamState.initialized) {
      throw new Error("Must call initialize before newSession");
    }

    const { cwd, mcpServers } =
      (params as { cwd?: string; mcpServers?: unknown[] }) ?? {};
    const workingDir = cwd ?? this.defaultCwd;

    // Spawn a new head manager for this session
    const spawned = await this.agentManager.getOrCreateHeadManager({
      cwd: workingDir,
      forceNew: true,
      permissionMode: streamState.permissionMode,
    });

    const sessionId = spawned.session_id;
    streamState.sessionId = sessionId;
    streamState.agentId = spawned.id;

    // Create session mapping
    this.sessionMapper.createMapping(sessionId as ACPSessionId, spawned.id);

    console.error(
      `[ACP-over-MAP] Created session ${sessionId} -> agent ${spawned.id}`,
    );

    // Notify subscribers that a new agent was registered
    this.notifyAgentRegistered(spawned.id);

    // Emit session_info_update so client has title/timestamps
    this.emitSessionInfo(streamState, sessionId, emitNotification);

    return { sessionId };
  }

  private async handleLoadSession(
    streamState: StreamState,
    params: unknown,
    emitNotification?: ACPNotificationEmitter,
  ): Promise<unknown> {
    if (!streamState.initialized) {
      throw new Error("Must call initialize before loadSession");
    }

    const {
      sessionId: rawSessionId,
      cwd,
      _meta,
    } = (params as {
      sessionId: string;
      cwd?: string;
      _meta?: Record<string, unknown>;
    }) ?? {};
    if (!rawSessionId) {
      throw new Error("sessionId required");
    }

    // Extension: If _meta.agentId provided, look up session from agent record
    let sessionId = rawSessionId;
    const metaAgentId = _meta?.agentId as string | undefined;
    if (metaAgentId) {
      const agent = this.eventStore.getAgent(metaAgentId as AgentId);
      if (!agent) {
        throw new Error(`Agent not found: ${metaAgentId}`);
      }
      sessionId = agent.session_id;
      console.error(
        `[ACP-over-MAP] loadSession: Resolved agentId ${metaAgentId} to session ${sessionId}`,
      );
    }

    const workingDir = cwd ?? this.defaultCwd;

    // Try to find an existing head manager with this session ID
    const headManagers = this.agentManager.listHeadManagers();
    const existing = headManagers.find((hm) => hm.session_id === sessionId);

    if (existing) {
      // Check if the agent already has an active session
      if (this.agentManager.hasActiveSession(existing.id)) {
        console.error(
          `[ACP-over-MAP] loadSession: Reusing existing session for agent ${existing.id}`,
        );
        streamState.sessionId = sessionId;
        streamState.agentId = existing.id;
        this.sessionMapper.createMapping(
          sessionId as ACPSessionId,
          existing.id,
        );
        this.emitSessionInfo(streamState, sessionId, emitNotification);
        return { sessionId };
      }

      // Agent exists but no active session - resume it
      console.error(
        `[ACP-over-MAP] loadSession: Resuming stopped agent ${existing.id}`,
      );
      const spawned = await this.agentManager.resume(
        existing.id,
        streamState.permissionMode,
      );
      streamState.sessionId = sessionId;
      streamState.agentId = spawned.id;
      this.sessionMapper.createMapping(sessionId as ACPSessionId, spawned.id);
      this.emitSessionInfo(streamState, sessionId, emitNotification);
      return { sessionId };
    }

    // No existing agent found - create new with the specified session ID
    console.error(
      `[ACP-over-MAP] loadSession: Creating new agent for session ${sessionId}`,
    );
    const spawned = await this.agentManager.getOrCreateHeadManager({
      cwd: workingDir,
      sessionId,
      permissionMode: streamState.permissionMode,
    });

    streamState.sessionId = sessionId;
    streamState.agentId = spawned.id;
    this.sessionMapper.createMapping(sessionId as ACPSessionId, spawned.id);

    // Notify subscribers that a new agent was registered
    this.notifyAgentRegistered(spawned.id);

    this.emitSessionInfo(streamState, sessionId, emitNotification);

    return { sessionId };
  }

  private async handleAuthenticate(_params: unknown): Promise<unknown> {
    // No authentication required
    return {};
  }

  private async handlePrompt(
    streamState: StreamState,
    params: unknown,
    sessionIdFromContext?: string,
    emitNotification?: ACPNotificationEmitter,
  ): Promise<unknown> {
    const { prompt, sessionId: paramSessionId } =
      (params as {
        prompt?: Array<{ type: string; text?: string }>;
        sessionId?: string;
        messages?: Array<{ role: string; content: string }>;
      }) ?? {};

    // Prefer the server's resolved session ID (set during loadSession) over the
    // client's acpContext.sessionId which may be stale (e.g., "_resolve_" sentinel)
    const sessionId =
      streamState.sessionId ?? paramSessionId ?? sessionIdFromContext;
    if (!sessionId) {
      throw new Error("No session - call newSession or loadSession first");
    }

    // Get the mapped agent
    const agentId = this.sessionMapper.getAgentId(sessionId as ACPSessionId);
    if (!agentId) {
      throw new Error(`No agent mapped for session ${sessionId}`);
    }

    // Reset abort controller if needed
    if (streamState.abortController.signal.aborted) {
      streamState.abortController = new AbortController();
    }

    // Extract message content
    let messageContent: string;
    if (prompt && Array.isArray(prompt)) {
      messageContent = prompt
        .filter((block) => block.type === "text" && block.text)
        .map((block) => block.text)
        .join("\n");
    } else if (
      (params as { messages?: Array<{ content: string }> })?.messages
    ) {
      // Handle messages format (role/content array)
      const messages = (
        params as { messages: Array<{ role: string; content: string }> }
      ).messages;
      messageContent = messages.map((m) => m.content).join("\n");
    } else {
      messageContent = JSON.stringify(params);
    }

    console.error(
      `[ACP-over-MAP] Prompting agent ${agentId} with: ${messageContent.slice(0, 100)}...`,
    );

    // Mark session as processing
    this.sessionMapper.setProcessing(sessionId as ACPSessionId, true);

    // Helper to emit session update notifications
    const emitSessionUpdate = (update: unknown) => {
      if (!emitNotification) return;

      const notification: ACPEnvelope = {
        acp: {
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: sessionId,
            update: update,
          },
        },
        acpContext: {
          streamId: streamState.streamId,
          sessionId: sessionId,
          direction: "agent-to-client",
        },
      };
      emitNotification(notification);
    };

    // Ensure conversation exists in EventStore for history persistence
    this.ensureConversation(sessionId as ACPSessionId, agentId);

    // Accumulate response content for history recording
    const buffer: {
      parts: Array<
        | { type: "text"; text: string }
        | ({ type: "tool" } & Record<string, unknown>)
      >;
    } = {
      parts: [],
    };

    // Track latest plan for persistence
    let latestPlan: Array<{
      content: string;
      priority: string;
      status: string;
    }> | null = null;

    // Track tool info from initial tool_call events (title, name, input)
    // so we can merge them when tool_call_update arrives with status "completed"
    const toolInfoCache = new Map<
      string,
      { title?: string; name?: string; input?: unknown }
    >();

    try {
      // Stream responses from the agent
      let updateCount = 0;
      for await (const update of this.agentManager.prompt(
        agentId,
        messageContent,
      )) {
        // Check for cancellation
        if (streamState.abortController.signal.aborted) {
          return { stopReason: "cancelled" };
        }

        // Accumulate content for history persistence (preserving text/tool interleaving order)
        const u = update as Record<string, unknown>;
        const updateType = (u.sessionUpdate as string) ?? (u.type as string);

        // Annotate permission_request updates with agentId so clients can respond
        if (updateType === "permission_request") {
          u._agentId = agentId;
        }
        if (updateType === "agent_message_chunk") {
          const content = u.content as
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
        } else if (updateType === "plan") {
          const entries = (
            u as {
              entries?: Array<{
                content: string;
                priority: string;
                status: string;
              }>;
            }
          ).entries;
          if (entries) {
            latestPlan = entries;
          }
        } else if (
          updateType === "tool_call" ||
          updateType === "tool_call_update"
        ) {
          const toolCallId = u.toolCallId as string | undefined;
          const status = u.status as string | undefined;
          const meta = u._meta as
            | { claudeCode?: { toolName?: string } }
            | undefined;

          // Cache tool info from initial tool_call events
          if (updateType === "tool_call" && toolCallId) {
            toolInfoCache.set(toolCallId, {
              title: u.title as string | undefined,
              name: meta?.claudeCode?.toolName,
              input: u.rawInput,
            });
          }

          if (status === "completed" || status === "failed") {
            // Merge cached info for tool_call_update events that lack title/input
            const cached = toolCallId
              ? toolInfoCache.get(toolCallId)
              : undefined;
            buffer.parts.push({
              type: "tool",
              toolCallId,
              title: u.title ?? cached?.title,
              name: meta?.claudeCode?.toolName ?? cached?.name,
              status: u.status,
              input: u.rawInput ?? cached?.input,
              output: extractToolOutput(u.rawOutput),
            });
          }
        }

        // Stream the update back to the client
        emitSessionUpdate(update);
        updateCount++;
      }

      // Check if the loop ended because of cancellation
      const wasCancelled = streamState.abortController.signal.aborted;
      const stopReason = wasCancelled ? "cancelled" : "end_turn";

      console.error(
        `[ACP-over-MAP] Prompt completed for agent ${agentId}, ${updateCount} updates, stopReason=${stopReason}`,
      );

      // Persist conversation turns for history
      this.recordPromptTurns(
        sessionId as ACPSessionId,
        agentId,
        messageContent,
        buffer,
      );

      // Persist latest plan in EventStore for history loading across restarts
      if (latestPlan) {
        this.eventStore.updateAgentPlan(agentId as AgentId, latestPlan);
      }

      // Emit updated session info after prompt completes
      this.emitSessionInfo(streamState, sessionId, emitNotification);

      return { stopReason };
    } catch (error) {
      // Extract a meaningful error message — errors from the ACP SDK may be
      // plain objects ({code, message}) rather than Error instances.
      let errorMessage: string;
      if (error instanceof Error) {
        errorMessage = error.message;
      } else if (
        typeof error === "object" &&
        error !== null &&
        "message" in error &&
        typeof (error as { message: unknown }).message === "string"
      ) {
        errorMessage = (error as { message: string }).message;
      } else {
        try {
          errorMessage = JSON.stringify(error);
        } catch {
          errorMessage = String(error);
        }
      }
      console.error(
        `[ACP-over-MAP] Prompt error for agent ${agentId}:`,
        errorMessage,
      );
      return {
        stopReason: "end_turn",
        error: errorMessage,
      };
    } finally {
      this.sessionMapper.setProcessing(sessionId as ACPSessionId, false);
    }
  }

  private async handleCancel(
    streamState: StreamState,
    params: unknown,
    sessionIdFromContext?: string,
  ): Promise<unknown> {
    const { sessionId: paramSessionId } =
      (params as { sessionId?: string }) ?? {};
    // Prefer server's resolved session ID over client's potentially stale one
    const sessionId =
      streamState.sessionId ?? paramSessionId ?? sessionIdFromContext;

    const agentId = sessionId
      ? this.sessionMapper.getAgentId(sessionId as ACPSessionId)
      : streamState.agentId;

    console.error(
      `[ACP-over-MAP] Cancel - streamId=${streamState.streamId} sessionId=${sessionId} agentId=${agentId}`,
    );

    // 1. Abort the for-await loop in handlePrompt so it stops yielding updates
    streamState.abortController.abort();

    // 2. Cancel the agent's active session (sends session/cancel to the subprocess)
    // This does NOT terminate the agent — it only interrupts the current prompt.
    // The subprocess stays alive and can accept new prompts.
    // Use map/agents/stop for full agent termination.
    if (agentId) {
      const session = this.agentManager.getSession(agentId);
      if (session) {
        try {
          await session.cancel();
          console.error(
            `[ACP-over-MAP] Session cancelled for agent ${agentId}`,
          );
        } catch (error) {
          console.warn(
            `[ACP-over-MAP] session.cancel() failed for ${agentId}:`,
            error,
          );
        }
      }
    }

    return { cancelled: true };
  }

  // ─────────────────────────────────────────────────────────────────
  // Extension Methods
  // ─────────────────────────────────────────────────────────────────

  private async handleExtension(
    streamState: StreamState,
    method: string,
    params: unknown,
  ): Promise<unknown> {
    const methodParams = (params as Record<string, unknown>) ?? {};

    switch (method) {
      case "_macro/spawnAgent": {
        const { task, cwd, topics, config, parentId } = methodParams as {
          task: string;
          cwd?: string;
          topics?: string[];
          config?: AgentConfig;
          parentId?: string;
        };

        // Use the stream's agent as parent, or find head manager
        let parent = streamState.agentId;
        if (parentId) {
          parent = parentId as AgentId;
        } else if (!parent) {
          const headManagers = this.agentManager.listHeadManagers();
          if (headManagers.length > 0) {
            parent = headManagers[0].id;
          }
        }

        if (!parent) {
          throw new Error("No parent agent available for spawning");
        }

        const spawned = await this.agentManager.spawn({
          parent,
          task,
          cwd: cwd ?? this.defaultCwd,
          role: "worker",
          topics,
          config,
        });

        return {
          agentId: spawned.id,
          sessionId: spawned.session_id,
        };
      }

      case "_macro/getHierarchy": {
        const agents = this.agentManager.list();
        return {
          agents: agents.map((a) => ({
            id: a.id,
            role: a.role,
            state: a.state,
            parent: a.parent,
            createdAt: a.created_at,
          })),
        };
      }

      case "_macro/getTask": {
        const { taskId } = methodParams as { taskId: string };
        const task = await this.taskManager.get(taskId);
        return { task };
      }

      case "_macro/resume": {
        const { agentId } = methodParams as { agentId: string };
        if (!agentId) {
          throw new Error("agentId is required");
        }

        const agent = this.eventStore.getAgent(agentId as AgentId);
        if (!agent) {
          throw new Error(`Agent not found: ${agentId}`);
        }

        if (agent.state !== "stopped" && agent.state !== "failed") {
          throw new Error(
            `Agent ${agentId} is ${agent.state} — only stopped or failed agents can be resumed`,
          );
        }

        const spawned = await this.agentManager.resume(agentId as AgentId);
        return {
          success: true,
          agentId: spawned.id,
          sessionId: spawned.session_id,
        };
      }

      case "_macro/getHistory": {
        const {
          sessionId,
          agentId: historyAgentId,
          limit,
        } = methodParams as {
          sessionId?: string;
          agentId?: string;
          limit?: number;
        };

        // Resolve conversationId: prefer agentId lookup (resolves to the
        // original session_id where turns were recorded), fall back to
        // explicit sessionId. This allows history to survive across server
        // restarts even when the ACP session ID changes (e.g., resume()
        // fails → TUI creates new session with different ID).
        const agent = historyAgentId
          ? this.eventStore.getAgent(historyAgentId as AgentId)
          : undefined;
        let conversationId: string | undefined;
        if (agent) {
          conversationId = agent.session_id;
        }
        if (!conversationId) {
          conversationId = sessionId;
        }
        if (!conversationId) {
          return { turns: [] };
        }

        // For forked agents, include the source agent's conversation history
        // (pre-fork turns) followed by this agent's own turns.
        // Only include source turns from before the fork to avoid leaking
        // turns that the source recorded after the fork point.
        const sourceAgentId = agent?.metadata?.fork_of as string | undefined;
        let turns;
        if (sourceAgentId) {
          const sourceAgent = this.eventStore.getAgent(
            sourceAgentId as AgentId,
          );
          const sourceConversationId = sourceAgent?.session_id;
          const forkTimestamp = agent!.created_at;
          const sourceTurns = sourceConversationId
            ? this.eventStore
                .listTurns({
                  conversationId: sourceConversationId,
                  order: "asc",
                  limit: limit ?? 200,
                })
                .filter((t) => t.timestamp <= forkTimestamp)
            : [];
          const ownTurns = this.eventStore.listTurns({
            conversationId,
            order: "asc",
            limit: limit ?? 200,
          });
          turns = [...sourceTurns, ...ownTurns];
        } else {
          turns = this.eventStore.listTurns({
            conversationId,
            order: "asc",
            limit: limit ?? 200,
          });
        }

        const plan = agent?.plan ?? [];

        return {
          turns: turns.map((turn) => ({
            role:
              turn.contentType === "user_prompt"
                ? ("user" as const)
                : ("assistant" as const),
            timestamp: turn.timestamp,
            content: turn.content,
          })),
          plan,
          cwd: agent?.cwd ?? null,
        };
      }

      case "_macro/respondToPermission": {
        const {
          agentId: targetAgentId,
          requestId,
          optionId,
        } = methodParams as {
          agentId: string;
          requestId: string;
          optionId: string;
        };
        if (!targetAgentId || !requestId || !optionId) {
          throw new Error("agentId, requestId, and optionId are required");
        }
        const success = this.agentManager.respondToPermission(
          targetAgentId as AgentId,
          requestId,
          optionId,
        );
        return { success };
      }

      case "_macro/cancelPermission": {
        const { agentId: targetAgentId, requestId } = methodParams as {
          agentId: string;
          requestId: string;
        };
        if (!targetAgentId || !requestId) {
          throw new Error("agentId and requestId are required");
        }
        const success = this.agentManager.cancelPermission(
          targetAgentId as AgentId,
          requestId,
        );
        return { success };
      }

      case "_macro/setPermissionMode": {
        const { agentId: targetAgentId, permissionMode } = methodParams as {
          agentId: string;
          permissionMode: string;
        };
        if (!targetAgentId || !permissionMode) {
          throw new Error("agentId and permissionMode are required");
        }
        const previousMode = this.agentManager.getPermissionMode(
          targetAgentId as AgentId,
        );
        const success = this.agentManager.setPermissionMode(
          targetAgentId as AgentId,
          permissionMode as
            | "auto-approve"
            | "auto-deny"
            | "callback"
            | "interactive",
        );
        if (success) {
          return { success: true, previousMode: previousMode ?? undefined };
        }
        return {
          success: false,
          error: `No active session found for agent ${targetAgentId}`,
        };
      }

      case "_macro/forkAgent": {
        const { agentId, name, prompt, cwd } = methodParams as {
          agentId: string;
          name?: string;
          prompt?: string;
          cwd?: string;
        };
        if (!agentId) {
          throw new Error("agentId is required");
        }

        const sourceAgent = this.eventStore.getAgent(agentId as AgentId);
        if (!sourceAgent) {
          throw new Error(`Agent not found: ${agentId}`);
        }

        const forked = await this.agentManager.forkAgent(agentId as AgentId, {
          name,
          prompt,
          cwd: cwd ?? sourceAgent.cwd ?? this.defaultCwd,
        });

        // Fire-and-forget initial prompt if provided
        if (prompt) {
          (async () => {
            try {
              for await (const _update of this.agentManager.prompt(
                forked.id,
                prompt,
              )) {
                // drain iterator
              }
            } catch {
              // best-effort
            }
          })();
        }

        return {
          newAgentId: forked.id,
          newSessionId: forked.session_id,
          originalAgentId: agentId,
          providerSessionId: forked.session?.id,
        };
      }

      case "_macro/agents/update": {
        const { agentId, name, plan, metadata } = methodParams as {
          agentId?: string;
          name?: string;
          plan?: Array<{ content: string; priority: string; status: string }>;
          metadata?: Record<string, unknown>;
        };
        if (!agentId) {
          throw new Error("agentId is required");
        }
        if (
          name === undefined &&
          plan === undefined &&
          metadata === undefined
        ) {
          throw new Error(
            "At least one field to update is required (name, plan, or metadata)",
          );
        }
        if (name !== undefined && !name.trim()) {
          throw new Error("name must not be empty");
        }

        const agent = this.eventStore.getAgent(agentId as AgentId);
        if (!agent) {
          throw new Error(`Agent not found: ${agentId}`);
        }

        const updates: Record<string, unknown> = {};
        const updatedFields: string[] = [];

        if (name !== undefined) {
          updates.name = name.trim();
          updatedFields.push("name");
        }
        if (plan !== undefined) {
          updates.plan = plan;
          updatedFields.push("plan");
        }
        if (metadata !== undefined) {
          updates.metadata = metadata;
          updatedFields.push("metadata");
        }

        this.eventStore.updateAgentMetadata(agentId as AgentId, updates);

        return {
          success: true,
          agentId,
          updated: updatedFields,
        };
      }

      case "_macro/getModels": {
        const { sessionId } = methodParams as { sessionId: string };
        const agentId = this.sessionMapper.getAgentId(
          sessionId as ACPSessionId,
        );
        if (!agentId) {
          return { currentModelId: null, availableModels: [] };
        }
        const session = this.agentManager.getSession(agentId);
        if (!session) {
          return { currentModelId: null, availableModels: [] };
        }
        // Try clientHandler's model info store first (from _model_state_update notification)
        const clientHandler = (
          session as unknown as {
            clientHandler?: {
              getSessionModelInfo?: (id: string) => {
                currentModelId: string | null;
                availableModels: Array<{ modelId: string; name: string }>;
              } | null;
            };
          }
        ).clientHandler;
        const modelInfo = clientHandler?.getSessionModelInfo?.(session.id);
        if (modelInfo && modelInfo.availableModels.length > 0) {
          return modelInfo;
        }
        // Fall back to Session.models (from initial session response — just IDs)
        if (session.models && session.models.length > 0) {
          return {
            currentModelId: session.models[0],
            availableModels: session.models.map((id: string) => ({
              modelId: id,
              name: id,
            })),
          };
        }
        return { currentModelId: null, availableModels: [] };
      }

      case "_session/setCompaction": {
        // Compaction is handled internally by the agent process.
        // Accept the request as a no-op so the client doesn't get an error.
        // TODO: Make sure this overrides if needed.
        return { success: true };
      }

      default:
        throw new Error(`Unknown extension method: ${method}`);
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // History Persistence
  // ─────────────────────────────────────────────────────────────────

  /**
   * Ensure a conversation exists in the EventStore for a given session.
   * This must be called before recording turns.
   */
  private ensureConversation(
    acpSessionId: ACPSessionId,
    agentId: AgentId,
  ): void {
    if (typeof this.eventStore.getConversation !== "function") {
      return;
    }

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
        `[ACP-over-MAP] Failed to create conversation for session ${acpSessionId}:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  /**
   * Record user and assistant turns after a prompt completes.
   * Mirrors MacroAgent.recordPromptTurns() for the ACP-over-MAP path.
   */
  private recordPromptTurns(
    acpSessionId: ACPSessionId,
    agentId: AgentId,
    userMessage: string,
    buffer: {
      parts: Array<
        | { type: "text"; text: string }
        | ({ type: "tool" } & Record<string, unknown>)
      >;
    },
  ): void {
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
            timestamp: now + 1,
            content_type: "assistant_response",
            content: { parts },
            source_type: "explicit",
          },
        });
      }
    } catch (error) {
      console.warn(
        `[ACP-over-MAP] Failed to record turns for session ${acpSessionId}:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // Session Info
  // ─────────────────────────────────────────────────────────────────

  /**
   * Emit a session_info_update notification with title and timestamps.
   * Uses agent task as title and session mapping timestamps.
   */
  private emitSessionInfo(
    streamState: StreamState,
    sessionId: string,
    emitNotification?: ACPNotificationEmitter,
  ): void {
    if (!emitNotification) return;

    const mapping = this.sessionMapper.getMapping(sessionId as ACPSessionId);
    const agentId = streamState.agentId;
    const agent = agentId ? this.eventStore.getAgent(agentId as AgentId) : null;

    const title = agent?.task ?? null;
    const updatedAt = new Date(mapping?.updatedAt ?? Date.now()).toISOString();

    const notification: ACPEnvelope = {
      acp: {
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "session_info_update",
            title,
            updatedAt,
          },
        },
      },
      acpContext: {
        streamId: streamState.streamId,
        sessionId,
        direction: "agent-to-client",
      },
    };
    emitNotification(notification);
  }

  // ─────────────────────────────────────────────────────────────────
  // Cleanup
  // ─────────────────────────────────────────────────────────────────

  /**
   * Clean up a stream when it's closed.
   */
  closeStream(streamId: string): void {
    const state = this.streams.get(streamId);
    if (state) {
      state.abortController.abort();
      this.streams.delete(streamId);
    }
  }

  /**
   * Clean up all streams.
   */
  closeAll(): void {
    for (const [streamId, state] of this.streams) {
      state.abortController.abort();
    }
    this.streams.clear();
  }
}
