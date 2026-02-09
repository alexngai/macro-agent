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
import { SessionMapper } from "../../acp/session-mapper.js";
import type { ACPSessionId } from "../../acp/types.js";

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
}

// ─────────────────────────────────────────────────────────────────
// ACP-over-MAP Handler
// ─────────────────────────────────────────────────────────────────

export class ACPOverMAPHandler {
  private agentManager: AgentManager;
  private eventStore: EventStore;
  private taskManager: TaskManager;
  private defaultCwd: string;

  /** Stream states by streamId */
  private streams: Map<string, StreamState> = new Map();

  /** Session mapper for ACP session -> Agent mapping */
  private sessionMapper: SessionMapper = new SessionMapper();

  constructor(config: ACPOverMAPConfig) {
    this.agentManager = config.agentManager;
    this.eventStore = config.eventStore;
    this.taskManager = config.taskManager;
    this.defaultCwd = config.defaultCwd ?? process.cwd();
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

    console.error(`[ACP-over-MAP] Processing - streamId=${streamId} method=${method}`);

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
          result = await this.handleNewSession(streamState, acp.params);
          break;

        case "session/load":
          result = await this.handleLoadSession(streamState, acp.params);
          break;

        case "authenticate":
          result = await this.handleAuthenticate(acp.params);
          break;

        case "session/prompt":
          result = await this.handlePrompt(streamState, acp.params, sessionId, emitNotification);
          break;

        case "session/cancel":
          result = await this.handleCancel(streamState, acp.params, sessionId);
          break;

        default:
          // Check for extension methods
          if (method?.startsWith("_")) {
            result = await this.handleExtension(streamState, method, acp.params);
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
  ): Promise<unknown> {
    if (!streamState.initialized) {
      throw new Error("Must call initialize before newSession");
    }

    const { cwd, mcpServers } = (params as { cwd?: string; mcpServers?: unknown[] }) ?? {};
    const workingDir = cwd ?? this.defaultCwd;

    // Spawn a new head manager for this session
    const spawned = await this.agentManager.getOrCreateHeadManager({
      cwd: workingDir,
      forceNew: true,
    });

    const sessionId = spawned.session_id;
    streamState.sessionId = sessionId;
    streamState.agentId = spawned.id;

    // Create session mapping
    this.sessionMapper.createMapping(sessionId as ACPSessionId, spawned.id);

    console.error(`[ACP-over-MAP] Created session ${sessionId} -> agent ${spawned.id}`);

    return { sessionId };
  }

  private async handleLoadSession(
    streamState: StreamState,
    params: unknown,
  ): Promise<unknown> {
    if (!streamState.initialized) {
      throw new Error("Must call initialize before loadSession");
    }

    const { sessionId: rawSessionId, cwd, _meta } = (params as {
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
        `[ACP-over-MAP] loadSession: Resolved agentId ${metaAgentId} to session ${sessionId}`
      );
    }

    const workingDir = cwd ?? this.defaultCwd;

    // Try to find an existing head manager with this session ID
    const headManagers = this.agentManager.listHeadManagers();
    const existing = headManagers.find((hm) => hm.session_id === sessionId);

    if (existing) {
      // Check if the agent already has an active session
      if (this.agentManager.hasActiveSession(existing.id)) {
        console.error(`[ACP-over-MAP] loadSession: Reusing existing session for agent ${existing.id}`);
        streamState.sessionId = sessionId;
        streamState.agentId = existing.id;
        this.sessionMapper.createMapping(sessionId as ACPSessionId, existing.id);
        return {};
      }

      // Agent exists but no active session - resume it
      console.error(`[ACP-over-MAP] loadSession: Resuming stopped agent ${existing.id}`);
      const spawned = await this.agentManager.resume(existing.id);
      streamState.sessionId = sessionId;
      streamState.agentId = spawned.id;
      this.sessionMapper.createMapping(sessionId as ACPSessionId, spawned.id);
      return {};
    }

    // No existing agent found - create new with the specified session ID
    console.error(`[ACP-over-MAP] loadSession: Creating new agent for session ${sessionId}`);
    const spawned = await this.agentManager.getOrCreateHeadManager({
      cwd: workingDir,
      sessionId,
    });

    streamState.sessionId = sessionId;
    streamState.agentId = spawned.id;
    this.sessionMapper.createMapping(sessionId as ACPSessionId, spawned.id);

    return {};
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
    const { prompt, sessionId: paramSessionId } = (params as {
      prompt?: Array<{ type: string; text?: string }>;
      sessionId?: string;
      messages?: Array<{ role: string; content: string }>;
    }) ?? {};

    const sessionId = paramSessionId ?? sessionIdFromContext ?? streamState.sessionId;
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
    } else if ((params as { messages?: Array<{ content: string }> })?.messages) {
      // Handle messages format (role/content array)
      const messages = (params as { messages: Array<{ role: string; content: string }> }).messages;
      messageContent = messages.map((m) => m.content).join("\n");
    } else {
      messageContent = JSON.stringify(params);
    }

    console.error(`[ACP-over-MAP] Prompting agent ${agentId} with: ${messageContent.slice(0, 100)}...`);

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

    try {
      // Stream responses from the agent
      let updateCount = 0;
      for await (const update of this.agentManager.prompt(agentId, messageContent)) {
        // Check for cancellation
        if (streamState.abortController.signal.aborted) {
          return { stopReason: "cancelled" };
        }

        // Stream the update back to the client
        emitSessionUpdate(update);
        updateCount++;
      }

      console.error(`[ACP-over-MAP] Prompt completed for agent ${agentId}, ${updateCount} updates`);

      return { stopReason: "end_turn" };
    } catch (error) {
      console.error(`[ACP-over-MAP] Prompt error:`, error);
      return {
        stopReason: "end_turn",
        error: error instanceof Error ? error.message : String(error),
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
    const { sessionId: paramSessionId } = (params as { sessionId?: string }) ?? {};
    const sessionId = paramSessionId ?? sessionIdFromContext ?? streamState.sessionId;

    // Signal cancellation
    streamState.abortController.abort();

    if (!sessionId) {
      return { cancelled: true };
    }

    // Get the mapped agent
    const agentId = this.sessionMapper.getAgentId(sessionId as ACPSessionId);
    if (!agentId) {
      return { cancelled: true };
    }

    // Terminate the agent
    try {
      await this.agentManager.terminate(agentId, "cancelled");
    } catch (error) {
      console.warn(`[ACP-over-MAP] Error terminating agent ${agentId}:`, error);
    }

    // Clean up
    this.sessionMapper.removeMapping(sessionId as ACPSessionId);

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
    const methodParams = params as Record<string, unknown> ?? {};

    switch (method) {
      case "_macro/spawnAgent": {
        const { task, cwd, topics, config, parentId } = methodParams as {
          task: string;
          cwd?: string;
          topics?: string[];
          config?: Record<string, unknown>;
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
            `Agent ${agentId} is ${agent.state} — only stopped or failed agents can be resumed`
          );
        }

        const spawned = await this.agentManager.resume(agentId as AgentId);
        return {
          success: true,
          agentId: spawned.id,
          sessionId: spawned.session_id,
        };
      }

      default:
        throw new Error(`Unknown extension method: ${method}`);
    }
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
