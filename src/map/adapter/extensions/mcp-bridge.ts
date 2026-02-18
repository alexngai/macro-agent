/**
 * MCP Bridge Extensions (_macro/mcp/*)
 *
 * Server-side extension handlers that mirror each MCP tool.
 * When MCP subprocesses run in thin-client mode, their tool calls
 * are routed here via ephemeral MAP WebSocket connections.
 *
 * Each handler receives agent context via `params.context` since the
 * MAP ExtensionContext only has participant info, not agent identity.
 */

import type { MAPAdapter, ExtensionHandler, ExtensionContext } from "../interface.js";
import type { EventStore } from "../../../store/event-store.js";
import type { AgentManager } from "../../../agent/agent-manager.js";
import type { TaskManager } from "../../../task/task-manager.js";
import type { MessageRouter } from "../../../router/message-router.js";
import type { PeerManager } from "../../../peer/peer-manager.js";
import type { ActivityWatcher } from "../../../activity/watcher.js";
import type { RoleRegistry } from "../../../roles/types.js";
import type { TaskBackend } from "../../../task/backend/types.js";
import type { AgentId } from "../../../store/types/index.js";
import type { ToolContext } from "../../../mcp/types.js";
import type { Agent } from "../../../store/types/index.js";
import type { AgentStopReason } from "../../../agent/types.js";
import type { EventNotification, MAPEventType } from "../types.js";
import { RPCError } from "../rpc-handler.js";
import type { AgentTokenManager } from "../../../auth/token.js";
import { ulid } from "ulid";
import { createDoneHandler, type DoneToolDeps } from "../../../mcp/tools/done.js";
import { createInjectContextHandler } from "../../../mcp/tools/inject_context.js";
import {
  createWaitForActivityHandler,
} from "../../../mcp/tools/wait_for_activity.js";
import { createClaimTaskHandler } from "../../../mcp/tools/claim_task.js";
import { createUnclaimTaskHandler } from "../../../mcp/tools/unclaim_task.js";
import { createListClaimableTasksHandler } from "../../../mcp/tools/list_claimable_tasks.js";

// =============================================================================
// Services
// =============================================================================

/**
 * Services required for MCP bridge extensions.
 */
export interface MCPBridgeServices {
  eventStore: EventStore;
  agentManager: AgentManager;
  taskManager: TaskManager;
  messageRouter: MessageRouter;
  peerManager?: PeerManager;
  activityWatcher?: ActivityWatcher;
  roleRegistry?: RoleRegistry;
  taskBackend?: TaskBackend;
  taskToolProvider?: import("../../../task/backend/types.js").TaskToolProvider;
  /** Mutable context holder for task tool provider agent_id injection */
  taskToolContext?: { agent_id: string };
  integrationStrategy?: import("../../../workspace/strategies/types.js").IntegrationStrategy;
  /** Optional agent token manager for per-agent authentication */
  agentTokenManager?: AgentTokenManager;
}

// =============================================================================
// Agent Token Validation (module-level, set by registerMCPBridgeExtensions)
// =============================================================================

let _agentTokenManager: AgentTokenManager | undefined;

// =============================================================================
// Agent Context Extraction
// =============================================================================

/**
 * Agent context passed in params.context by thin-client MCP tools.
 */
interface AgentContext {
  agent_id: string;
  session_id: string;
  task_id?: string;
  lineage: string[];
  cwd: string;
  agent_token?: string;
}

/**
 * Extract and validate agent context from params.
 */
function extractContext(params: unknown): { context: AgentContext; args: Record<string, unknown> } {
  const p = (params ?? {}) as Record<string, unknown>;
  const context = p.context as AgentContext | undefined;

  if (!context?.agent_id) {
    throw RPCError.invalidParams("params.context.agent_id is required");
  }

  // Validate per-agent token if token manager is configured
  if (_agentTokenManager) {
    if (!context.agent_token || !_agentTokenManager.verifyToken(context.agent_id, context.agent_token)) {
      throw RPCError.invalidParams("Invalid or missing agent token");
    }
  }

  // Return everything except context as args
  const { context: _, ...args } = p;
  return { context, args };
}

/**
 * Build a ToolContext from the agent context.
 */
function toToolContext(ctx: AgentContext): ToolContext {
  return {
    agent_id: ctx.agent_id,
    session_id: ctx.session_id,
    task_id: ctx.task_id,
    lineage: ctx.lineage ?? [],
    cwd: ctx.cwd ?? process.cwd(),
  };
}

// =============================================================================
// Handler Implementations
// =============================================================================

function createSpawnAgentBridge(
  services: MCPBridgeServices,
  emitMAPEvent: (event: EventNotification) => void,
): ExtensionHandler {
  return async (_extCtx: ExtensionContext, params: unknown) => {
    const { context, args } = extractContext(params);

    const task = args.task as string;
    const spawned = await services.agentManager.spawn({
      task,
      parent: context.agent_id,
      subscribeParent: (args.subscribe_parent as boolean) ?? true,
      topics: (args.topics as string[]) ?? [],
      config: args.config as Record<string, unknown> | undefined,
      cwd: (args.cwd as string) ?? context.cwd,
      permissionMode: (args.permission_mode as string | undefined) as import("acp-factory").PermissionMode | undefined,
    });

    // Fire-and-forget initial prompt so the agent starts working on its task.
    // Without this, the agent process is running but idle — waiting for a message.
    if (task) {
      (async () => {
        // Accumulate assistant response parts for history persistence
        const buffer: {
          parts: Array<
            | { type: "text"; text: string }
            | ({ type: "tool" } & Record<string, unknown>)
          >;
        } = { parts: [] };
        const toolInfoCache = new Map<
          string,
          { title?: string; name?: string; input?: unknown }
        >();

        // Emit user message event so TUI clients can show the task prompt
        emitMAPEvent({
          eventId: ulid(),
          type: "session_user_message" as MAPEventType,
          timestamp: Date.now(),
          agentId: spawned.id as AgentId,
          data: {
            agentId: spawned.id,
            sessionId: spawned.session_id,
            content: task,
          },
        });

        try {
          for await (const update of services.agentManager.prompt(
            spawned.id,
            task,
          )) {
            // Accumulate content for turn recording (mirrors acp-over-map.ts handlePrompt)
            const u = update as Record<string, unknown>;
            const updateType = (u.sessionUpdate as string) ?? (u.type as string);

            if (updateType === "agent_message_chunk") {
              const content = u.content as { type?: string; text?: string } | undefined;
              if (content?.text) {
                const last = buffer.parts[buffer.parts.length - 1];
                if (last && last.type === "text") {
                  last.text += content.text;
                } else {
                  buffer.parts.push({ type: "text", text: content.text });
                }
              }
            } else if (updateType === "tool_call" || updateType === "tool_call_update") {
              const toolCallId = u.toolCallId as string | undefined;
              const status = u.status as string | undefined;
              const meta = u._meta as { claudeCode?: { toolName?: string } } | undefined;

              if (updateType === "tool_call" && toolCallId) {
                toolInfoCache.set(toolCallId, {
                  title: u.title as string | undefined,
                  name: meta?.claudeCode?.toolName,
                  input: u.rawInput,
                });
              }

              if (status === "completed" || status === "failed") {
                const cached = toolCallId ? toolInfoCache.get(toolCallId) : undefined;
                const rawOutput = u.rawOutput;
                let output: string | undefined;
                if (typeof rawOutput === "string") output = rawOutput;
                else if (Array.isArray(rawOutput)) {
                  output = rawOutput
                    .filter((item: any) => item.type === "text" && typeof item.text === "string")
                    .map((item: any) => item.text as string)
                    .join("\n") || undefined;
                }
                buffer.parts.push({
                  type: "tool",
                  toolCallId,
                  title: u.title ?? cached?.title,
                  name: meta?.claudeCode?.toolName ?? cached?.name,
                  status: u.status,
                  input: u.rawInput ?? cached?.input,
                  output,
                });
              }
            }

            // Emit each session update as a MAP event for live streaming
            emitMAPEvent({
              eventId: ulid(),
              type: "session_update" as MAPEventType,
              timestamp: Date.now(),
              agentId: spawned.id as AgentId,
              data: {
                agentId: spawned.id,
                sessionId: spawned.session_id,
                update,
              },
            });
          }

          // Emit prompt done event
          emitMAPEvent({
            eventId: ulid(),
            type: "session_prompt_done" as MAPEventType,
            timestamp: Date.now(),
            agentId: spawned.id as AgentId,
            data: {
              agentId: spawned.id,
              sessionId: spawned.session_id,
              stopReason: "end_turn",
            },
          });

          // Record turns so history is available when TUI reconnects
          const now = Date.now();
          const conversationId = spawned.session_id;

          // Record user turn (the initial task prompt)
          services.eventStore.emit({
            type: "turn",
            source: { agent_id: spawned.id },
            payload: {
              action: "recorded",
              turn_id: `turn_user_${now}_${Math.random().toString(36).slice(2, 8)}`,
              conversation_id: conversationId,
              participant: "user",
              timestamp: now,
              content_type: "user_prompt",
              content: task,
              source_type: "explicit",
            },
          });

          // Record assistant turn with accumulated content
          if (buffer.parts.length > 0) {
            services.eventStore.emit({
              type: "turn",
              source: { agent_id: spawned.id },
              payload: {
                action: "recorded",
                turn_id: `turn_asst_${now}_${Math.random().toString(36).slice(2, 8)}`,
                conversation_id: conversationId,
                participant: spawned.id,
                timestamp: now + 1,
                content_type: "assistant_response",
                content: { parts: buffer.parts },
                source_type: "explicit",
              },
            });
          }
        } catch (err) {
          // Emit prompt done with error so TUI stops spinner
          emitMAPEvent({
            eventId: ulid(),
            type: "session_prompt_done" as MAPEventType,
            timestamp: Date.now(),
            agentId: spawned.id as AgentId,
            data: {
              agentId: spawned.id,
              sessionId: spawned.session_id,
              stopReason: "error",
            },
          });
          console.error(
            `[MCP Bridge] Failed to send initial prompt to spawned agent ${spawned.id}:`,
            err,
          );
        }
      })();
    }

    return {
      agent_id: spawned.id,
      task_id: spawned.agent.task_id,
      session_id: spawned.session_id,
    };
  };
}

function createEmitStatusBridge(
  services: MCPBridgeServices,
  emitMAPEvent: (event: EventNotification) => void,
): ExtensionHandler {
  return async (_extCtx: ExtensionContext, params: unknown) => {
    const { context, args } = extractContext(params);

    const event = services.eventStore.emit({
      type: "status",
      source: { agent_id: context.agent_id },
      payload: {
        status_type: args.status_type,
        summary: args.summary,
        details: args.details,
      },
    });

    // Emit MAP event so TUI subscribers see the status update
    const now = Date.now();
    emitMAPEvent({
      eventId: ulid(),
      type: "status_emitted" as MAPEventType,
      timestamp: now,
      agentId: context.agent_id as AgentId,
      data: {
        id: event.id,
        agentId: context.agent_id,
        taskId: context.task_id,
        statusType: args.status_type,
        summary: args.summary,
        details: args.details,
        timestamp: now,
      },
    });

    let taskUpdated = false;

    if (args.complete_task && args.status_type === "completed" && context.task_id) {
      try {
        services.taskManager.updateStatus(context.task_id, "completed");
        taskUpdated = true;
      } catch { /* Task may not exist */ }
    }

    if (args.complete_task && args.status_type === "failed" && context.task_id) {
      try {
        services.taskManager.updateStatus(context.task_id, "failed");
        taskUpdated = true;
      } catch { /* Task may not exist */ }
    }

    return { event_id: event.id, task_updated: taskUpdated };
  };
}

function createSendMessageBridge(services: MCPBridgeServices): ExtensionHandler {
  return async (_extCtx: ExtensionContext, params: unknown) => {
    const { context, args } = extractContext(params);
    const to = args.to as { agent_id?: string; task_id?: string; topic?: string } | undefined;

    if (!to) {
      throw RPCError.invalidParams("params.to is required");
    }

    const address = to.agent_id
      ? { agent: to.agent_id }
      : to.task_id
        ? { task: to.task_id }
        : to.topic
          ? { scope: to.topic }
          : null;

    if (!address) {
      throw RPCError.invalidParams("Must specify one of: agent_id, task_id, or topic");
    }

    const result = await services.messageRouter.sendToAddress({
      from: context.agent_id,
      to: address,
      content: args.content as string,
      options: args.correlation_id ? { correlationId: args.correlation_id as string } : undefined,
    });

    return {
      message_id: result.id,
      delivered_to: result.delivered.length,
    };
  };
}

function createCheckMessagesBridge(services: MCPBridgeServices): ExtensionHandler {
  return async (_extCtx: ExtensionContext, params: unknown) => {
    const { context, args } = extractContext(params);
    const limit = (args.limit as number) ?? 10;

    const internalMessages = services.messageRouter.getMessages(context.agent_id, {
      limit,
      includeAcknowledged: (args.include_acknowledged as boolean) ?? false,
    });

    const formattedInternalMessages = internalMessages.map((msg) => ({
      id: msg.id,
      from: `agent:${msg.from.agent_id}`,
      content: msg.content.length > 500 ? msg.content.substring(0, 500) : msg.content,
      timestamp: msg.timestamp,
      truncated: msg.truncated || msg.content.length > 500,
      correlation_id: msg.correlation_id,
    }));

    // Get peer messages if peerManager is available
    let formattedPeerMessages: Array<{
      id: string;
      from: string;
      content: string;
      timestamp: number;
      truncated: boolean;
      correlation_id?: string;
      is_request?: boolean;
      request_id?: string;
    }> = [];

    if (services.peerManager) {
      const peerMessages = services.peerManager.getPeerMessages(context.agent_id);
      formattedPeerMessages = peerMessages.map((msg) => ({
        id: msg.id,
        from: msg.from,
        content: typeof msg.payload === "string"
          ? msg.payload.length > 500 ? msg.payload.substring(0, 500) : msg.payload
          : JSON.stringify(msg.payload).substring(0, 500),
        timestamp: msg.timestamp,
        truncated: typeof msg.payload === "string" ? msg.payload.length > 500 : false,
        correlation_id: msg.correlationId,
        is_request: msg.isRequest,
        request_id: msg.requestId,
      }));
    }

    const allFormattedMessages = [...formattedInternalMessages, ...formattedPeerMessages]
      .sort((a, b) => a.timestamp - b.timestamp)
      .slice(0, limit);

    const allInternalMessages = services.messageRouter.getMessages(context.agent_id, {
      limit: 1000,
      includeAcknowledged: false,
    });
    const allPeerMessages = services.peerManager ? services.peerManager.getPeerMessages(context.agent_id) : [];

    return {
      messages: allFormattedMessages,
      total_pending: allInternalMessages.length + allPeerMessages.length,
    };
  };
}

function createQueryIndexBridge(services: MCPBridgeServices): ExtensionHandler {
  return async (_extCtx: ExtensionContext, params: unknown) => {
    const { context: _context, args } = extractContext(params);

    const entries: Array<{
      type: "agent" | "task";
      id: string;
      summary: string;
      state?: string;
      status?: string;
    }> = [];

    const limit = (args.limit as number) ?? 20;
    const offset = (args.offset as number) ?? 0;
    const search = (args.search as string)?.toLowerCase();
    const filter = args.filter as { state?: string; status?: string; parent?: string | null } | undefined;
    const queryType = args.type as string;

    if (queryType === "agents" || queryType === "all") {
      let agents = services.agentManager.list();

      if (filter?.state) {
        agents = agents.filter((a) => a.state === filter!.state);
      }
      if (filter?.parent !== undefined) {
        agents = agents.filter((a) => a.parent === filter!.parent);
      }
      if (search) {
        agents = agents.filter(
          (a) =>
            a.id.toLowerCase().includes(search) ||
            a.task?.toLowerCase().includes(search)
        );
      }

      for (const agent of agents) {
        entries.push({
          type: "agent",
          id: agent.id,
          summary: agent.task ?? "No task description",
          state: agent.state,
        });
      }
    }

    if (queryType === "tasks" || queryType === "all") {
      let tasks = services.taskManager.list();

      if (filter?.status) {
        tasks = tasks.filter((t) => t.status === filter!.status);
      }
      if (search) {
        tasks = tasks.filter((t) =>
          t.id.toLowerCase().includes(search) ||
          t.description.toLowerCase().includes(search)
        );
      }

      for (const task of tasks) {
        entries.push({
          type: "task",
          id: task.id,
          summary: task.description,
          status: task.status,
        });
      }
    }

    const paginatedEntries = entries.slice(offset, offset + limit);

    return {
      entries: paginatedEntries,
      total: entries.length,
      has_more: offset + limit < entries.length,
    };
  };
}

function createGetHierarchyBridge(services: MCPBridgeServices): ExtensionHandler {
  return async (_extCtx: ExtensionContext, params: unknown) => {
    const { context, args } = extractContext(params);

    let rootId: AgentId;
    if (args.root) {
      rootId = args.root as string;
    } else {
      rootId = context.lineage.length > 0 ? context.lineage[0] : context.agent_id;
    }

    const hierarchy = services.agentManager.getHierarchy(rootId);
    if (!hierarchy) {
      throw RPCError.notFound("agent", rootId);
    }

    function buildNode(node: { agent: Agent; children: Array<{ agent: Agent; children: any[] }> }, currentDepth: number): {
      agent_id: string;
      task: string;
      state: string;
      children: any[];
    } {
      const shouldIncludeChildren = args.depth === undefined || currentDepth < (args.depth as number);
      return {
        agent_id: node.agent.id,
        task: node.agent.task ?? "No task",
        state: node.agent.state,
        children: shouldIncludeChildren
          ? node.children.map((c) => buildNode(c, currentDepth + 1))
          : [],
      };
    }

    const tree = buildNode(hierarchy.root, 1);

    return {
      tree,
      depth: hierarchy.depth,
      total_agents: hierarchy.totalAgents,
    };
  };
}

function createGetAgentSummaryBridge(services: MCPBridgeServices): ExtensionHandler {
  return async (_extCtx: ExtensionContext, params: unknown) => {
    const { context: _context, args } = extractContext(params);
    const agentId = args.agent_id as string;

    const agent = services.agentManager.get(agentId);
    if (!agent) {
      throw RPCError.notFound("agent", agentId);
    }

    const children = services.agentManager.getChildren(agentId);

    const statusEvents = services.eventStore.query({
      type: "status",
      source_agent_id: agentId,
      limit: 1,
    });

    const recentStatus = statusEvents.length > 0
      ? {
          type: statusEvents[0].payload.status_type as string,
          summary: statusEvents[0].payload.summary as string,
          timestamp: statusEvents[0].timestamp,
        }
      : undefined;

    const lastActivity = agent.stopped_at ?? agent.started_at ?? agent.created_at;

    return {
      id: agent.id,
      session_id: agent.session_id,
      task: agent.task ?? "No task",
      state: agent.state,
      parent: agent.parent,
      children_count: children.length,
      last_activity: lastActivity,
      recent_status: recentStatus,
    };
  };
}

function createStopAgentBridge(services: MCPBridgeServices): ExtensionHandler {
  return async (_extCtx: ExtensionContext, params: unknown) => {
    const { context, args } = extractContext(params);
    const targetAgentId = args.agent_id as string;
    const reason = ((args.reason as string) ?? "cancelled") as AgentStopReason;

    const targetAgent = services.agentManager.get(targetAgentId);
    if (!targetAgent) {
      throw RPCError.notFound("agent", targetAgentId);
    }

    // Check subtree authorization
    const isInSubtree =
      targetAgentId === context.agent_id ||
      targetAgent.lineage?.includes(context.agent_id);

    if (!isInSubtree) {
      throw RPCError.permissionDenied(
        `Cannot stop agent outside your subtree: ${targetAgentId}`
      );
    }

    const stoppedAgents: AgentId[] = [];

    async function stopRecursive(agentId: AgentId): Promise<void> {
      const agent = services.agentManager.get(agentId);
      if (!agent || agent.state === "stopped") return;

      const children = services.agentManager.getChildren(agentId);
      for (const child of children) {
        await stopRecursive(child.id);
      }

      await services.agentManager.terminate(agentId, reason);
      stoppedAgents.push(agentId);
    }

    await stopRecursive(targetAgentId);

    return {
      success: true,
      stopped_agents: stoppedAgents,
    };
  };
}

function createDoneBridge(services: MCPBridgeServices): ExtensionHandler {
  return async (_extCtx: ExtensionContext, params: unknown) => {
    const { context, args } = extractContext(params);
    const toolContext = toToolContext(context);

    const doneDeps: DoneToolDeps = {
      eventStore: services.eventStore,
      agentManager: services.agentManager,
      messageRouter: services.messageRouter,
      taskManager: services.taskManager,
      roleRegistry: services.roleRegistry,
      integrationStrategy: services.integrationStrategy,
    };

    const doneHandler = createDoneHandler(toolContext, doneDeps);
    const result = await doneHandler(args as {
      status: "completed" | "failed" | "blocked" | "deferred";
      summary?: string;
      details?: Record<string, unknown>;
      task_id?: string;
    });

    // Handle termination if needed
    if (result.shouldTerminate) {
      setImmediate(async () => {
        try {
          await services.agentManager.terminate(context.agent_id, "completed");
        } catch { /* ignore */ }
      });
    }

    return result;
  };
}

function createInjectContextBridge(services: MCPBridgeServices): ExtensionHandler {
  return async (_extCtx: ExtensionContext, params: unknown) => {
    const { context, args } = extractContext(params);

    const handler = createInjectContextHandler(
      { agentManager: services.agentManager, messageRouter: services.messageRouter },
      context.agent_id
    );

    return handler(args as {
      target_agent_id: string;
      content: string;
      urgent?: boolean;
      reason?: string;
    });
  };
}

function createWaitForActivityBridge(services: MCPBridgeServices): ExtensionHandler {
  return async (_extCtx: ExtensionContext, params: unknown) => {
    const { context, args } = extractContext(params);

    if (!services.activityWatcher) {
      throw RPCError.internalError("ActivityWatcher not available");
    }

    const toolContext = toToolContext(context);
    const handler = createWaitForActivityHandler(toolContext, {
      activityWatcher: services.activityWatcher,
    });

    return handler(args as {
      event_types?: string[];
      timeout_ms?: number;
      scope?: {
        subtree?: string;
        role?: string;
        target_agent?: string;
      };
    });
  };
}

function createClaimTaskBridge(services: MCPBridgeServices): ExtensionHandler {
  return async (_extCtx: ExtensionContext, params: unknown) => {
    const { context, args } = extractContext(params);

    if (!services.taskBackend) {
      throw RPCError.internalError("Task backend not available");
    }

    const toolContext = toToolContext(context);
    const handler = createClaimTaskHandler(toolContext, {
      taskBackend: services.taskBackend,
    });

    return handler(args as { tags?: string[]; root_tasks_only?: boolean });
  };
}

function createUnclaimTaskBridge(services: MCPBridgeServices): ExtensionHandler {
  return async (_extCtx: ExtensionContext, params: unknown) => {
    const { context, args } = extractContext(params);

    if (!services.taskBackend) {
      throw RPCError.internalError("Task backend not available");
    }

    const toolContext = toToolContext(context);
    const handler = createUnclaimTaskHandler(toolContext, {
      taskBackend: services.taskBackend,
    });

    return handler(args as { task_id: string });
  };
}

function createListClaimableTasksBridge(services: MCPBridgeServices): ExtensionHandler {
  return async (_extCtx: ExtensionContext, params: unknown) => {
    const { context, args } = extractContext(params);

    if (!services.taskBackend) {
      throw RPCError.internalError("Task backend not available");
    }

    const toolContext = toToolContext(context);
    const handler = createListClaimableTasksHandler(toolContext, {
      taskBackend: services.taskBackend,
    });

    return handler(args as { tags?: string[]; root_tasks_only?: boolean; limit?: number });
  };
}

// Peer communication bridges

function createSendPeerMessageBridge(services: MCPBridgeServices): ExtensionHandler {
  return async (_extCtx: ExtensionContext, params: unknown) => {
    const { context, args } = extractContext(params);

    if (!services.peerManager || !services.peerManager.hasTransport()) {
      throw RPCError.internalError("Peer communication not available");
    }

    await services.peerManager.sendMessage(context.agent_id, args.to as string, {
      type: args.type as string,
      payload: args.payload,
      metadata: args.correlation_id ? { correlationId: args.correlation_id as string } : undefined,
    });

    return { success: true, timestamp: Date.now() };
  };
}

function createSendPeerRequestBridge(services: MCPBridgeServices): ExtensionHandler {
  return async (_extCtx: ExtensionContext, params: unknown) => {
    const { context, args } = extractContext(params);

    if (!services.peerManager || !services.peerManager.hasTransport()) {
      throw RPCError.internalError("Peer communication not available");
    }

    return services.peerManager.sendRequest(context.agent_id, args.to as string, {
      method: args.method as string,
      params: args.params,
      timeout: args.timeout as number | undefined,
    });
  };
}

function createRespondToPeerRequestBridge(services: MCPBridgeServices): ExtensionHandler {
  return async (_extCtx: ExtensionContext, params: unknown) => {
    const { context, args } = extractContext(params);

    if (!services.peerManager) {
      throw RPCError.internalError("Peer communication not available");
    }

    services.peerManager.respondToRequest(context.agent_id, args.request_id as string, {
      result: args.result,
      error: args.error as { code: number; message: string; data?: unknown } | undefined,
    });

    return { success: true };
  };
}

// =============================================================================
// Dynamic Task Tool Bridge
// =============================================================================

/**
 * Creates a bridge handler for a dynamic task tool from the TaskToolProvider.
 * The handler extracts agent context from params and delegates to the tool's
 * handler. The TaskToolProvider's getContext() is backed by a mutable holder
 * that we update here before each call (safe since Node.js is single-threaded).
 */
function createTaskToolBridge(
  tool: import("../../../task/backend/types.js").MCPToolDefinition,
  contextHolder: { agent_id: string },
): ExtensionHandler {
  return async (_extCtx: ExtensionContext, params: unknown) => {
    const { context, args } = extractContext(params);

    // Set the calling agent's ID so the tool provider's getContext() returns it
    contextHolder.agent_id = context.agent_id;

    // The tool handler receives the params directly (or unwrapped from the
    // `params` envelope that the thin-client MCP server wraps them in)
    const toolParams = (args as Record<string, unknown>).params ?? args;

    return tool.handler(toolParams);
  };
}

// =============================================================================
// Registration
// =============================================================================

/**
 * All MCP bridge extension method names.
 */
export const MCP_BRIDGE_METHODS = [
  "_macro/mcp/spawn_agent",
  "_macro/mcp/emit_status",
  "_macro/mcp/send_message",
  "_macro/mcp/check_messages",
  "_macro/mcp/query_index",
  "_macro/mcp/get_hierarchy",
  "_macro/mcp/get_agent_summary",
  "_macro/mcp/stop_agent",
  "_macro/mcp/done",
  "_macro/mcp/inject_context",
  "_macro/mcp/wait_for_activity",
  "_macro/mcp/claim_task",
  "_macro/mcp/unclaim_task",
  "_macro/mcp/list_claimable_tasks",
  "_macro/mcp/send_peer_message",
  "_macro/mcp/send_peer_request",
  "_macro/mcp/respond_to_peer_request",
  "_macro/mcp/task_tools_list",
] as const;

/**
 * Register all MCP bridge extension methods with the MAP adapter.
 *
 * These handlers mirror each MCP tool, allowing thin-client MCP subprocesses
 * to execute tool logic on the main server via ephemeral WebSocket calls.
 */
export function registerMCPBridgeExtensions(
  adapter: MAPAdapter,
  services: MCPBridgeServices
): void {
  // Set module-level agent token manager for extractContext() validation
  _agentTokenManager = services.agentTokenManager;

  const emitMAPEvent = (event: EventNotification) => adapter.emitEvent(event);

  adapter.registerExtension("_macro/mcp/spawn_agent", createSpawnAgentBridge(services, emitMAPEvent));
  adapter.registerExtension("_macro/mcp/emit_status", createEmitStatusBridge(services, emitMAPEvent));
  adapter.registerExtension("_macro/mcp/send_message", createSendMessageBridge(services));
  adapter.registerExtension("_macro/mcp/check_messages", createCheckMessagesBridge(services));
  adapter.registerExtension("_macro/mcp/query_index", createQueryIndexBridge(services));
  adapter.registerExtension("_macro/mcp/get_hierarchy", createGetHierarchyBridge(services));
  adapter.registerExtension("_macro/mcp/get_agent_summary", createGetAgentSummaryBridge(services));
  adapter.registerExtension("_macro/mcp/stop_agent", createStopAgentBridge(services));
  adapter.registerExtension("_macro/mcp/done", createDoneBridge(services));
  adapter.registerExtension("_macro/mcp/inject_context", createInjectContextBridge(services));

  if (services.activityWatcher) {
    adapter.registerExtension("_macro/mcp/wait_for_activity", createWaitForActivityBridge(services));
  }

  if (services.taskBackend) {
    adapter.registerExtension("_macro/mcp/claim_task", createClaimTaskBridge(services));
    adapter.registerExtension("_macro/mcp/unclaim_task", createUnclaimTaskBridge(services));
    adapter.registerExtension("_macro/mcp/list_claimable_tasks", createListClaimableTasksBridge(services));
  }

  if (services.peerManager) {
    adapter.registerExtension("_macro/mcp/send_peer_message", createSendPeerMessageBridge(services));
    adapter.registerExtension("_macro/mcp/send_peer_request", createSendPeerRequestBridge(services));
    adapter.registerExtension("_macro/mcp/respond_to_peer_request", createRespondToPeerRequestBridge(services));
  }

  // Register dynamic task tool bridges from the TaskToolProvider
  if (services.taskToolProvider) {
    const contextHolder = services.taskToolContext ?? { agent_id: "" };
    const tools = services.taskToolProvider.getTools();
    for (const tool of tools) {
      const method = `_macro/mcp/task_tool/${tool.name}`;
      adapter.registerExtension(method, createTaskToolBridge(tool, contextHolder));
    }

    // Discovery endpoint: returns list of available task tool names so
    // thin-client MCP subprocesses only register tools the server supports
    adapter.registerExtension("_macro/mcp/task_tools_list", async () => {
      return { tools: tools.map((t) => ({ name: t.name, description: t.description })) };
    });
  } else {
    // No task tools available — return empty list
    adapter.registerExtension("_macro/mcp/task_tools_list", async () => {
      return { tools: [] };
    });
  }
}

/**
 * Unregister all MCP bridge extension methods.
 */
export function unregisterMCPBridgeExtensions(adapter: MAPAdapter): void {
  for (const method of MCP_BRIDGE_METHODS) {
    try {
      adapter.unregisterExtension(method);
    } catch { /* ignore */ }
  }
}
