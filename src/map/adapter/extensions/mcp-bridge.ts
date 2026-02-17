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
  integrationStrategy?: import("../../../workspace/strategies/types.js").IntegrationStrategy;
}

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

function createSpawnAgentBridge(services: MCPBridgeServices): ExtensionHandler {
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
        try {
          for await (const _update of services.agentManager.prompt(
            spawned.id,
            task,
          )) {
            // drain iterator — updates flow via event subscriptions
          }
        } catch (err) {
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
  const emitMAPEvent = (event: EventNotification) => adapter.emitEvent(event);

  adapter.registerExtension("_macro/mcp/spawn_agent", createSpawnAgentBridge(services));
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
