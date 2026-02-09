/**
 * MCP Server Factory
 *
 * Creates per-agent MCP server instances with context baked in.
 * Each agent gets its own MCP server with tools that know the calling agent's identity.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { EventStore } from "../store/event-store.js";
import type { AgentManager } from "../agent/agent-manager.js";
import type { TaskManager } from "../task/task-manager.js";
import type { MessageRouter } from "../router/message-router.js";
import type { PeerManager } from "../peer/peer-manager.js";
import type { ToolContext, HierarchyNode } from "./types.js";
import { MCPToolError } from "./types.js";
import type { Agent, AgentId } from "../store/types/index.js";
import {
  DoneSchema,
  createDoneHandler,
  DONE_TOOL_INFO,
} from "./tools/done.js";
import type { ActivityWatcher } from "../activity/watcher.js";
import {
  WaitForActivitySchema,
  createWaitForActivityHandler,
  WAIT_FOR_ACTIVITY_TOOL_INFO,
} from "./tools/wait_for_activity.js";
import {
  InjectContextSchema,
  createInjectContextHandler,
  formatInjectContextResult,
  INJECT_CONTEXT_TOOL_INFO,
} from "./tools/inject_context.js";
import {
  ClaimTaskSchema,
  createClaimTaskHandler,
  CLAIM_TASK_TOOL_INFO,
} from "./tools/claim_task.js";
import {
  UnclaimTaskSchema,
  createUnclaimTaskHandler,
  UNCLAIM_TASK_TOOL_INFO,
} from "./tools/unclaim_task.js";
import {
  ListClaimableTasksSchema,
  createListClaimableTasksHandler,
  LIST_CLAIMABLE_TASKS_TOOL_INFO,
} from "./tools/list_claimable_tasks.js";
import type { TaskToolProvider } from "../task/backend/types.js";
import type { RoleRegistry, RoleDefinition } from "../roles/types.js";
import { DefaultRoleRegistry } from "../roles/registry.js";
import {
  isToolAllowedForRole,
  getRequiredCapabilityForTool,
} from "../roles/registry.js";

// Debug logging to file (since stderr doesn't show up from MCP subprocess)
const debugLogPath = path.join(os.tmpdir(), "macro-agent-mcp-debug.log");
function debugLog(message: string) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${message}\n`;
  fs.appendFileSync(debugLogPath, line);
  console.error(message); // Also log to stderr in case it's visible
}

// ─────────────────────────────────────────────────────────────────
// MCP Server Configuration
// ─────────────────────────────────────────────────────────────────

export interface MCPServerConfig {
  /** Server name */
  name?: string;

  /** Server version */
  version?: string;
}

// ─────────────────────────────────────────────────────────────────
// Services Container
// ─────────────────────────────────────────────────────────────────

export interface MCPServices {
  eventStore: EventStore;
  agentManager: AgentManager;
  taskManager: TaskManager;
  messageRouter: MessageRouter;
  /** Optional peer manager for inter-macro-agent communication */
  peerManager?: PeerManager;
  /** Optional activity watcher for event-driven waking */
  activityWatcher?: ActivityWatcher;
  /** Optional task tool provider for backend-specific task tools */
  taskToolProvider?: TaskToolProvider;
  /** Optional role registry for role-based tool filtering */
  roleRegistry?: RoleRegistry;
  /** Optional task mode from team config (push or pull) */
  taskMode?: "push" | "pull";
  /** Optional integration strategy from team config */
  integrationStrategy?: import("../workspace/strategies/types.js").IntegrationStrategy;
  /** Optional task backend for pull model tools (claim/unclaim) */
  taskBackend?: import("../task/backend/types.js").TaskBackend;
}

// ─────────────────────────────────────────────────────────────────
// MCP Server Instance
// ─────────────────────────────────────────────────────────────────

export interface MCPServerInstance {
  /** The MCP server */
  server: McpServer;

  /** Start the server with stdio transport */
  start(): Promise<void>;

  /** Close the server */
  close(): Promise<void>;
}

// ─────────────────────────────────────────────────────────────────
// Schema Definitions (using Zod for MCP SDK compatibility)
// ─────────────────────────────────────────────────────────────────

const SpawnAgentSchema = {
  task: z.string().describe("Task description for the child agent"),
  subscribe_parent: z
    .boolean()
    .optional()
    .default(true)
    .describe("Whether parent subscribes to child's subtree"),
  topics: z
    .array(z.string())
    .optional()
    .describe("Additional topics for child to subscribe to"),
  config: z
    .object({
      model: z.string().optional(),
      maxTokens: z.number().optional(),
      temperature: z.number().optional(),
    })
    .optional()
    .describe("Custom config for the child agent"),
  cwd: z
    .string()
    .optional()
    .describe("Working directory for the spawned agent (defaults to parent's cwd)"),
};

const EmitStatusSchema = {
  status_type: z
    .enum(["started", "checkpoint", "completed", "failed", "blocked"])
    .describe("Type of status update"),
  summary: z.string().describe("Human-readable summary"),
  details: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Additional structured details"),
  complete_task: z
    .boolean()
    .optional()
    .describe("If true and status_type is 'completed', also mark task as completed"),
};

const SendMessageSchema = {
  to: z
    .object({
      agent_id: z.string().optional(),
      task_id: z.string().optional(),
      topic: z.string().optional(),
    })
    .describe("Message target"),
  content: z.string().describe("Message content"),
  correlation_id: z.string().optional().describe("Optional correlation ID for threading"),
};

const CheckMessagesSchema = {
  limit: z
    .number()
    .optional()
    .default(10)
    .describe("Maximum number of messages to return"),
  include_acknowledged: z
    .boolean()
    .optional()
    .default(false)
    .describe("Include acknowledged messages"),
};

const QueryIndexSchema = {
  type: z.enum(["agents", "tasks", "all"]).describe("Type of entities to search"),
  filter: z
    .object({
      state: z.enum(["running", "stopped", "spawning"]).optional(),
      status: z
        .enum(["pending", "assigned", "in_progress", "completed", "failed"])
        .optional(),
      parent: z.string().nullable().optional(),
    })
    .optional()
    .describe("Filter criteria"),
  search: z.string().optional().describe("Text search query"),
  limit: z.number().optional().default(20).describe("Maximum results"),
  offset: z.number().optional().default(0).describe("Offset for pagination"),
};

const GetHierarchySchema = {
  root: z.string().optional().describe("Root agent ID (defaults to caller's hierarchy root)"),
  depth: z.number().optional().describe("Maximum depth to traverse"),
};

const GetAgentSummarySchema = {
  agent_id: z.string().describe("Agent ID to look up"),
};

const StopAgentSchema = {
  agent_id: z.string().describe("Agent ID to stop (must be in caller's subtree)"),
  reason: z
    .enum(["completed", "failed", "cancelled"])
    .optional()
    .default("cancelled")
    .describe("Reason for stopping"),
};

const CreateTaskSchema = {
  description: z.string().describe("Task description"),
  parent_task: z.string().optional().describe("Parent task ID for subtasks"),
  inputs: z.record(z.string(), z.unknown()).optional().describe("Initial inputs for the task"),
};

const GetTaskSchema = {
  task_id: z.string().describe("Task ID to look up"),
};

// ─────────────────────────────────────────────────────────────────
// Peer Communication Schemas
// ─────────────────────────────────────────────────────────────────

const SendPeerMessageSchema = {
  to: z.string().describe("Target peer address ('peerId' or 'peerId/agentId')"),
  type: z.string().describe("Message type for routing/handling"),
  payload: z.unknown().describe("Message payload"),
  correlation_id: z.string().optional().describe("Optional correlation ID for relating messages"),
};

const SendPeerRequestSchema = {
  to: z.string().describe("Target peer address ('peerId' or 'peerId/agentId')"),
  method: z.string().describe("Request method name"),
  params: z.unknown().optional().describe("Request parameters"),
  timeout: z.number().optional().describe("Timeout hint in milliseconds"),
};

const RespondToPeerRequestSchema = {
  request_id: z.string().describe("ID of the request to respond to"),
  result: z.unknown().optional().describe("Success result (mutually exclusive with error)"),
  error: z
    .object({
      code: z.number(),
      message: z.string(),
      data: z.unknown().optional(),
    })
    .optional()
    .describe("Error response (mutually exclusive with result)"),
};

// ─────────────────────────────────────────────────────────────────
// Factory Function
// ─────────────────────────────────────────────────────────────────

/**
 * Creates an MCP server instance for a specific agent.
 * The context (agent_id, session_id, etc.) is baked into all tool handlers.
 */
export function createMCPServer(
  context: ToolContext,
  services: MCPServices,
  config: MCPServerConfig = {}
): MCPServerInstance {
  const { name = "macro-agent-mcp", version = "1.0.0" } = config;
  const { eventStore, agentManager, taskManager, messageRouter, peerManager, activityWatcher, taskToolProvider, roleRegistry = new DefaultRoleRegistry() } = services;

  // Get excluded tools from tool provider (if any)
  const excludedTools = new Set(taskToolProvider?.getExcludedTools?.() ?? []);

  // ─────────────────────────────────────────────────────────────────
  // Role-Based Tool Filtering
  // ─────────────────────────────────────────────────────────────────

  // Get agent's role and resolve it
  const agent = eventStore.getAgent(context.agent_id);
  const agentRole = agent?.role ?? "worker"; // Default to worker if no role
  const resolvedRole: RoleDefinition = roleRegistry.resolveRole(agentRole);

  debugLog(`[MCP] Agent ${context.agent_id} has role '${agentRole}'`);
  debugLog(`[MCP] Resolved role capabilities: ${resolvedRole.capabilities?.join(", ") ?? "none"}`);

  /**
   * Check if a tool should be registered based on role permissions
   */
  function shouldRegisterTool(toolName: string): boolean {
    // Check backend exclusions first
    if (excludedTools.has(toolName)) {
      return false;
    }

    // Check role-based permissions
    const allowed = isToolAllowedForRole(toolName, resolvedRole);
    if (!allowed) {
      const requiredCapability = getRequiredCapabilityForTool(toolName);
      debugLog(
        `[MCP] Tool '${toolName}' not allowed for role '${agentRole}'` +
          (requiredCapability ? ` (requires: ${requiredCapability})` : "")
      );
    }
    return allowed;
  }

  // Create MCP server
  const server = new McpServer(
    { name, version },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // ─────────────────────────────────────────────────────────────────
  // Tool: spawn_agent
  // ─────────────────────────────────────────────────────────────────

  if (shouldRegisterTool("spawn_agent")) {
    server.registerTool("spawn_agent", {
      description: "Spawn a child agent to work on a subtask",
      inputSchema: SpawnAgentSchema,
    }, async (args) => {
    try {
      // Diagnostic logging to help debug parent-not-found issues
      // First, reload from SQLite to ensure we have the latest data
      await eventStore.reload();

      const parentAgent = eventStore.getAgent(context.agent_id);
      const allAgents = eventStore.listAgents();
      debugLog(`[MCP spawn_agent] Called by agent ${context.agent_id}`);
      debugLog(`[MCP spawn_agent] Parent exists in eventStore (after reload): ${!!parentAgent}`);
      debugLog(`[MCP spawn_agent] Total agents in eventStore: ${allAgents.length}`);
      debugLog(`[MCP spawn_agent] instancePath: ${eventStore.instancePath}`);
      if (allAgents.length > 0) {
        debugLog(`[MCP spawn_agent] Agent IDs: ${allAgents.map(a => a.id).join(', ')}`);
      }

      const spawned = await agentManager.spawn({
        task: args.task,
        parent: context.agent_id,
        subscribeParent: args.subscribe_parent ?? true,
        topics: args.topics ?? [],
        config: args.config,
        cwd: args.cwd ?? context.cwd,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              agent_id: spawned.id,
              task_id: spawned.agent.task_id,
              session_id: spawned.session_id,
            }),
          },
        ],
      };
    } catch (error) {
      // Log more details on failure
      debugLog(`[MCP spawn_agent] FAILED: ${error}`);
      const allAgentsOnError = eventStore.listAgents();
      debugLog(`[MCP spawn_agent] Agents at time of error: ${allAgentsOnError.map(a => a.id).join(', ')}`);
      throw new MCPToolError(
        `Failed to spawn agent: ${error}`,
        "SPAWN_FAILED"
      );
    }
    });
  }

  // ─────────────────────────────────────────────────────────────────
  // Tool: emit_status
  // ─────────────────────────────────────────────────────────────────

  if (shouldRegisterTool("emit_status")) {
    server.registerTool("emit_status", {
    description: "Report a status milestone (started, checkpoint, completed, failed, blocked)",
    inputSchema: EmitStatusSchema,
  }, async (args) => {
    // Emit status event
    const event = eventStore.emit({
      type: "status",
      source: { agent_id: context.agent_id },
      payload: {
        status_type: args.status_type,
        summary: args.summary,
        details: args.details,
      },
    });

    let taskUpdated = false;

    // If complete_task is true and status is completed, update task
    if (args.complete_task && args.status_type === "completed" && context.task_id) {
      try {
        taskManager.updateStatus(context.task_id, "completed");
        taskUpdated = true;
      } catch {
        // Task may not exist or already completed
      }
    }

    // Also update task for failed status if complete_task is true
    if (args.complete_task && args.status_type === "failed" && context.task_id) {
      try {
        taskManager.updateStatus(context.task_id, "failed");
        taskUpdated = true;
      } catch {
        // Task may not exist
      }
    }

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            event_id: event.id,
            task_updated: taskUpdated,
          }),
        },
      ],
    };
    });
  }

  // ─────────────────────────────────────────────────────────────────
  // Tool: send_message
  // ─────────────────────────────────────────────────────────────────

  if (shouldRegisterTool("send_message")) {
    server.registerTool("send_message", {
      description: "Send a message to another agent, task, or topic",
      inputSchema: SendMessageSchema,
    }, async (args) => {
      try {
        // Convert legacy target format to MAP Address
        const to = args.to.agent_id
          ? { agent: args.to.agent_id }
          : args.to.task_id
            ? { task: args.to.task_id }
            : args.to.topic
              ? { scope: args.to.topic }
              : null;

        if (!to) {
          throw new MCPToolError(
            "Must specify one of: agent_id, task_id, or topic",
            "INVALID_INPUT"
          );
        }

        const result = await messageRouter.sendToAddress({
          from: context.agent_id,
          to,
          content: args.content,
          options: args.correlation_id ? { correlationId: args.correlation_id } : undefined,
        });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                message_id: result.id,
                delivered_to: result.delivered.length,
              }),
            },
          ],
        };
      } catch (error) {
        throw new MCPToolError(
          `Failed to send message: ${error}`,
          "ROUTING_FAILED"
        );
      }
    });
  }

  // ─────────────────────────────────────────────────────────────────
  // Tool: check_messages
  // ─────────────────────────────────────────────────────────────────

  if (shouldRegisterTool("check_messages")) {
    server.registerTool("check_messages", {
    description: "Check pending messages in your inbox (includes both internal and peer messages)",
    inputSchema: CheckMessagesSchema,
  }, async (args) => {
    const limit = args.limit ?? 10;

    // Get internal messages
    const internalMessages = messageRouter.getMessages(context.agent_id, {
      limit: limit,
      includeAcknowledged: args.include_acknowledged ?? false,
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

    if (peerManager) {
      const peerMessages = peerManager.getPeerMessages(context.agent_id);
      formattedPeerMessages = peerMessages.map((msg) => ({
        id: msg.id,
        from: msg.from, // Already prefixed with "peer:"
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

    // Combine and sort by timestamp
    const allFormattedMessages = [...formattedInternalMessages, ...formattedPeerMessages]
      .sort((a, b) => a.timestamp - b.timestamp)
      .slice(0, limit);

    // Get total pending counts
    const allInternalMessages = messageRouter.getMessages(context.agent_id, {
      limit: 1000,
      includeAcknowledged: false,
    });
    const allPeerMessages = peerManager ? peerManager.getPeerMessages(context.agent_id) : [];

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            messages: allFormattedMessages,
            total_pending: allInternalMessages.length + allPeerMessages.length,
          }),
        },
      ],
    };
    });
  }

  // ─────────────────────────────────────────────────────────────────
  // Tool: query_index (always allowed - observability)
  // ─────────────────────────────────────────────────────────────────

  if (shouldRegisterTool("query_index")) {
    server.registerTool("query_index", {
    description: "Search for agents and tasks",
    inputSchema: QueryIndexSchema,
  }, async (args) => {
    const entries: Array<{
      type: "agent" | "task";
      id: string;
      summary: string;
      state?: string;
      status?: string;
    }> = [];

    const limit = args.limit ?? 20;
    const offset = args.offset ?? 0;
    const search = args.search?.toLowerCase();

    // Query agents
    if (args.type === "agents" || args.type === "all") {
      let agents = agentManager.list();

      // Apply filters
      if (args.filter?.state) {
        agents = agents.filter((a) => a.state === args.filter!.state);
      }
      if (args.filter?.parent !== undefined) {
        agents = agents.filter((a) => a.parent === args.filter!.parent);
      }

      // Apply search
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

    // Query tasks
    if (args.type === "tasks" || args.type === "all") {
      let tasks = taskManager.list();

      // Apply filters
      if (args.filter?.status) {
        tasks = tasks.filter((t) => t.status === args.filter!.status);
      }

      // Apply search
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

    // Apply pagination
    const paginatedEntries = entries.slice(offset, offset + limit);

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            entries: paginatedEntries,
            total: entries.length,
            has_more: offset + limit < entries.length,
          }),
        },
      ],
    };
    });
  }

  // ─────────────────────────────────────────────────────────────────
  // Tool: get_hierarchy (always allowed - observability)
  // ─────────────────────────────────────────────────────────────────

  if (shouldRegisterTool("get_hierarchy")) {
    server.registerTool("get_hierarchy", {
      description: "View the agent hierarchy tree",
      inputSchema: GetHierarchySchema,
    }, async (args) => {
      // Determine root
      let rootId: AgentId;
      if (args.root) {
        rootId = args.root;
      } else {
        // Use caller's root (walk up lineage)
        rootId = context.lineage.length > 0 ? context.lineage[0] : context.agent_id;
      }

      const hierarchy = agentManager.getHierarchy(rootId);
      if (!hierarchy) {
        throw new MCPToolError(
          `Agent not found: ${rootId}`,
          "AGENT_NOT_FOUND"
        );
      }

      // Convert to output format with depth limit
      function buildNode(node: { agent: Agent; children: Array<{ agent: Agent; children: any[] }> }, currentDepth: number): HierarchyNode {
        const shouldIncludeChildren = args.depth === undefined || currentDepth < args.depth;

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
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              tree,
              depth: hierarchy.depth,
              total_agents: hierarchy.totalAgents,
            }),
          },
        ],
      };
    });
  }

  // ─────────────────────────────────────────────────────────────────
  // Tool: get_agent_summary (always allowed - observability)
  // ─────────────────────────────────────────────────────────────────

  if (shouldRegisterTool("get_agent_summary")) {
    server.registerTool("get_agent_summary", {
      description: "Get detailed summary of a specific agent",
      inputSchema: GetAgentSummarySchema,
    }, async (args) => {
      const agent = agentManager.get(args.agent_id);
      if (!agent) {
        throw new MCPToolError(
          `Agent not found: ${args.agent_id}`,
          "AGENT_NOT_FOUND"
        );
      }

      // Get children count
      const children = agentManager.getChildren(args.agent_id);

      // Get recent status from events
      const statusEvents = eventStore.query({
        type: "status",
        source_agent_id: args.agent_id,
        limit: 1,
      });

      const recentStatus = statusEvents.length > 0
        ? {
            type: statusEvents[0].payload.status_type as string,
            summary: statusEvents[0].payload.summary as string,
            timestamp: statusEvents[0].timestamp,
          }
        : undefined;

      // Use stopped_at, started_at, or created_at as last activity
      const lastActivity = agent.stopped_at ?? agent.started_at ?? agent.created_at;

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              id: agent.id,
              session_id: agent.session_id,
              task: agent.task ?? "No task",
              state: agent.state,
              parent: agent.parent,
              children_count: children.length,
              last_activity: lastActivity,
              recent_status: recentStatus,
            }),
          },
        ],
      };
    });
  }

  // ─────────────────────────────────────────────────────────────────
  // Tool: stop_agent (requires agent.terminate capability)
  // ─────────────────────────────────────────────────────────────────

  if (shouldRegisterTool("stop_agent")) {
    server.registerTool("stop_agent", {
      description: "Stop a child agent in your subtree",
      inputSchema: StopAgentSchema,
    }, async (args) => {
    const targetAgent = agentManager.get(args.agent_id);
    if (!targetAgent) {
      throw new MCPToolError(
        `Agent not found: ${args.agent_id}`,
        "AGENT_NOT_FOUND"
      );
    }

    // Check if target is in caller's subtree
    // Target must have caller in its lineage
    const isInSubtree =
      args.agent_id === context.agent_id || // Can stop self
      targetAgent.lineage?.includes(context.agent_id);

    if (!isInSubtree) {
      throw new MCPToolError(
        `Cannot stop agent outside your subtree: ${args.agent_id}`,
        "NOT_IN_SUBTREE"
      );
    }

    // Collect all agents that will be stopped (target + descendants)
    const stoppedAgents: AgentId[] = [];

    async function stopRecursive(agentId: AgentId): Promise<void> {
      const agent = agentManager.get(agentId);
      if (!agent || agent.state === "stopped") return;

      // Stop children first
      const children = agentManager.getChildren(agentId);
      for (const child of children) {
        await stopRecursive(child.id);
      }

      // Stop this agent
      await agentManager.terminate(agentId, args.reason ?? "cancelled");
      stoppedAgents.push(agentId);
    }

    await stopRecursive(args.agent_id);

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            success: true,
            stopped_agents: stoppedAgents,
          }),
        },
      ],
    };
    });
  }

  // ─────────────────────────────────────────────────────────────────
  // Tool: create_task (requires task.create capability)
  // ─────────────────────────────────────────────────────────────────

  if (shouldRegisterTool("create_task")) {
    server.registerTool("create_task", {
      description: "Create a new task",
      inputSchema: CreateTaskSchema,
    }, async (args) => {
      try {
        const task = taskManager.create({
          description: args.description,
          created_by: context.agent_id,
          parent_task: args.parent_task,
          inputs: args.inputs,
        });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                task_id: task.id,
              }),
            },
          ],
        };
      } catch (error) {
        throw new MCPToolError(
          `Failed to create task: ${error}`,
          "INVALID_INPUT"
        );
      }
    });
  }

  // ─────────────────────────────────────────────────────────────────
  // Tool: get_task (always allowed - observability)
  // ─────────────────────────────────────────────────────────────────

  if (shouldRegisterTool("get_task")) {
    server.registerTool("get_task", {
      description: "Get details of a specific task",
      inputSchema: GetTaskSchema,
    }, async (args) => {
      const task = taskManager.get(args.task_id);
      if (!task) {
        throw new MCPToolError(
          `Task not found: ${args.task_id}`,
          "TASK_NOT_FOUND"
        );
      }

      // Use completed_at, started_at, or created_at as last update
      const updatedAt = task.completed_at ?? task.started_at ?? task.created_at;

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              id: task.id,
              description: task.description,
              status: task.status,
              assigned_agent: task.assigned_agent,
              parent_task: task.parent_task,
              subtasks: task.subtasks ?? [],
              inputs: task.inputs,
              outputs: task.outputs,
              artifacts: task.artifacts,
              created_at: task.created_at,
              updated_at: updatedAt,
            }),
          },
        ],
      };
    });
  }

  // ─────────────────────────────────────────────────────────────────
  // Tool: send_peer_message (requires msg.send capability)
  // ─────────────────────────────────────────────────────────────────

  if (shouldRegisterTool("send_peer_message")) {
    server.registerTool("send_peer_message", {
      description: "Send a fire-and-forget message to another macro-agent (peer)",
      inputSchema: SendPeerMessageSchema,
    }, async (args) => {
    if (!peerManager || !peerManager.hasTransport()) {
      throw new MCPToolError(
        "Peer communication not available - no transport registered",
        "NO_PEER_TRANSPORT"
      );
    }

    try {
      await peerManager.sendMessage(context.agent_id, args.to, {
        type: args.type,
        payload: args.payload,
        metadata: args.correlation_id ? { correlationId: args.correlation_id } : undefined,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              timestamp: Date.now(),
            }),
          },
        ],
      };
    } catch (error) {
      throw new MCPToolError(
        `Failed to send peer message: ${error}`,
        "ROUTING_FAILED"
      );
    }
    });
  }

  // ─────────────────────────────────────────────────────────────────
  // Tool: send_peer_request (always allowed - needs response)
  // ─────────────────────────────────────────────────────────────────

  if (shouldRegisterTool("send_peer_request")) {
    server.registerTool("send_peer_request", {
      description: "Send a request to another macro-agent (peer) and wait for response",
      inputSchema: SendPeerRequestSchema,
    }, async (args) => {
      if (!peerManager || !peerManager.hasTransport()) {
        throw new MCPToolError(
          "Peer communication not available - no transport registered",
          "NO_PEER_TRANSPORT"
        );
      }

      try {
        const response = await peerManager.sendRequest(context.agent_id, args.to, {
          method: args.method,
          params: args.params,
          timeout: args.timeout,
        });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(response),
            },
          ],
        };
      } catch (error) {
        throw new MCPToolError(
          `Failed to send peer request: ${error}`,
          "ROUTING_FAILED"
        );
      }
    });
  }

  // ─────────────────────────────────────────────────────────────────
  // Tool: respond_to_peer_request (always allowed - needs to respond)
  // ─────────────────────────────────────────────────────────────────

  if (shouldRegisterTool("respond_to_peer_request")) {
    server.registerTool("respond_to_peer_request", {
      description: "Respond to an incoming peer request",
      inputSchema: RespondToPeerRequestSchema,
    }, async (args) => {
      if (!peerManager) {
        throw new MCPToolError(
          "Peer communication not available - no transport registered",
          "NO_PEER_TRANSPORT"
        );
      }

      try {
        peerManager.respondToRequest(context.agent_id, args.request_id, {
          result: args.result,
          error: args.error,
        });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: true,
              }),
            },
          ],
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (errorMessage.includes("not found")) {
          throw new MCPToolError(
            `Request not found: ${args.request_id}`,
            "PEER_REQUEST_NOT_FOUND"
          );
        }
        throw new MCPToolError(
          `Failed to respond to peer request: ${error}`,
          "INVALID_INPUT"
        );
      }
    });
  }

  // ─────────────────────────────────────────────────────────────────
  // Tool: wait_for_activity (always allowed - observability)
  // ─────────────────────────────────────────────────────────────────

  if (activityWatcher && shouldRegisterTool("wait_for_activity")) {
    server.registerTool(WAIT_FOR_ACTIVITY_TOOL_INFO.name, {
      description: WAIT_FOR_ACTIVITY_TOOL_INFO.description,
      inputSchema: WaitForActivitySchema,
    }, async (args) => {
      const handler = createWaitForActivityHandler(context, { activityWatcher });

      try {
        const result = await handler(args as {
          event_types?: string[];
          timeout_ms?: number;
          scope?: {
            subtree?: string;
            role?: string;
            target_agent?: string;
          };
        });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result),
            },
          ],
        };
      } catch (error) {
        throw new MCPToolError(
          `Failed to wait for activity: ${error instanceof Error ? error.message : error}`,
          "WAIT_FAILED"
        );
      }
    });
  }

  // ─────────────────────────────────────────────────────────────────
  // Tool: done (requires lifecycle.done capability)
  // ─────────────────────────────────────────────────────────────────

  if (shouldRegisterTool("done")) {
    server.registerTool(DONE_TOOL_INFO.name, {
      description: DONE_TOOL_INFO.description,
      inputSchema: DoneSchema,
    }, async (args) => {
      debugLog(`[MCP done] Tool called by agent ${context.agent_id} with args: ${JSON.stringify(args)}`);
      const doneHandler = createDoneHandler(context, {
        eventStore,
        agentManager,
        messageRouter,
        taskManager,
        roleRegistry,
        integrationStrategy: services.integrationStrategy,
        taskMode: services.taskMode,
      });

      try {
        const result = await doneHandler(args as {
          status: "completed" | "failed" | "blocked" | "deferred";
          summary?: string;
          details?: Record<string, unknown>;
          task_id?: string;
        });

        // If shouldTerminate is true, schedule termination after this tool returns
        // The agent will be terminated after the tool execution completes
        if (result.shouldTerminate) {
          // Schedule termination via agentManager
          // We use setImmediate to ensure the tool response is sent first
          setImmediate(async () => {
            try {
              await agentManager.terminate(context.agent_id, "completed");
            } catch (error) {
              debugLog(`[MCP done] Failed to terminate agent ${context.agent_id}: ${error}`);
            }
          });
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result),
            },
          ],
        };
      } catch (error) {
        throw new MCPToolError(
          `Failed to execute done: ${error instanceof Error ? error.message : error}`,
          "INVALID_INPUT"
        );
      }
    });
  }

  // ─────────────────────────────────────────────────────────────────
  // Tools: claim_task, unclaim_task, list_claimable_tasks (pull model)
  // ─────────────────────────────────────────────────────────────────

  if (services.taskBackend && shouldRegisterTool("claim_task")) {
    server.registerTool(CLAIM_TASK_TOOL_INFO.name, {
      description: CLAIM_TASK_TOOL_INFO.description,
      inputSchema: ClaimTaskSchema,
    }, async (args) => {
      const handler = createClaimTaskHandler(context, {
        taskBackend: services.taskBackend!,
      });
      const result = await handler(args as { tags?: string[]; root_tasks_only?: boolean });
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    });
  }

  if (services.taskBackend && shouldRegisterTool("unclaim_task")) {
    server.registerTool(UNCLAIM_TASK_TOOL_INFO.name, {
      description: UNCLAIM_TASK_TOOL_INFO.description,
      inputSchema: UnclaimTaskSchema,
    }, async (args) => {
      const handler = createUnclaimTaskHandler(context, {
        taskBackend: services.taskBackend!,
      });
      const result = await handler(args as { task_id: string });
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    });
  }

  if (services.taskBackend && shouldRegisterTool("list_claimable_tasks")) {
    server.registerTool(LIST_CLAIMABLE_TASKS_TOOL_INFO.name, {
      description: LIST_CLAIMABLE_TASKS_TOOL_INFO.description,
      inputSchema: ListClaimableTasksSchema,
    }, async (args) => {
      const handler = createListClaimableTasksHandler(context, {
        taskBackend: services.taskBackend!,
      });
      const result = await handler(args as { tags?: string[]; root_tasks_only?: boolean; limit?: number });
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    });
  }

  // ─────────────────────────────────────────────────────────────────
  // Tool: inject_context (always allowed - parent-to-child communication)
  // ─────────────────────────────────────────────────────────────────

  if (shouldRegisterTool("inject_context")) {
    server.registerTool(INJECT_CONTEXT_TOOL_INFO.name, {
      description: INJECT_CONTEXT_TOOL_INFO.description,
      inputSchema: InjectContextSchema,
    }, async (args) => {
    const handler = createInjectContextHandler(
      { agentManager, messageRouter },
      context.agent_id
    );

    try {
      const result = await handler(args as {
        target_agent_id: string;
        content: string;
        urgent?: boolean;
        reason?: string;
      });

      return formatInjectContextResult(result);
    } catch (error) {
      throw new MCPToolError(
        `Failed to inject context: ${error instanceof Error ? error.message : error}`,
        "ROUTING_FAILED"
      );
    }
    });
  }

  // ─────────────────────────────────────────────────────────────────
  // Task Tool Provider (dynamic tools from backend)
  // ─────────────────────────────────────────────────────────────────

  if (taskToolProvider) {
    const providerTools = taskToolProvider.getTools();
    let registeredCount = 0;
    for (const tool of providerTools) {
      // Check role permissions for each dynamic tool
      if (!shouldRegisterTool(tool.name)) {
        continue;
      }

      // Use z.record for flexible input since tool providers define their own schemas
      // The actual validation is done by the tool handler
      server.registerTool(tool.name, {
        description: tool.description,
        inputSchema: {
          params: z.record(z.string(), z.unknown()).optional()
            .describe("Tool parameters (validated by the tool handler)"),
        },
      }, async (args: { params?: Record<string, unknown> }) => {
        try {
          // Pass the params to the handler, or an empty object if not provided
          const result = await tool.handler(args.params ?? args);
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(result),
              },
            ],
          };
        } catch (error) {
          throw new MCPToolError(
            `Failed to execute ${tool.name}: ${error instanceof Error ? error.message : error}`,
            "INVALID_INPUT"
          );
        }
      });
      registeredCount++;
    }
    debugLog(`[MCP] Registered ${registeredCount}/${providerTools.length} tools from task tool provider (filtered by role)`);
  }

  // ─────────────────────────────────────────────────────────────────
  // Server Lifecycle
  // ─────────────────────────────────────────────────────────────────

  let transport: StdioServerTransport | null = null;

  async function start(): Promise<void> {
    transport = new StdioServerTransport();
    await server.connect(transport);
  }

  async function close(): Promise<void> {
    if (transport) {
      await server.close();
      transport = null;
    }
  }

  return {
    server,
    start,
    close,
  };
}
