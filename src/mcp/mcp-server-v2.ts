/**
 * MCP Server V2 Factory
 *
 * Dramatically simplified — only registers macro-agent-specific tools:
 * - done: Signal completion and trigger lifecycle cleanup
 * - inject_context: Steer another agent's session
 * - spawn_agent: Spawn a child agent
 * - stop_agent: Stop a child agent
 * - get_hierarchy: Query agent hierarchy
 *
 * Tools that moved to subsystems:
 * - send_message, check_messages → agent-inbox MCP server (via IPC)
 * - create_task, get_task, query_index (tasks) → opentasks MCP server (via IPC)
 * - claim_task, unclaim_task, list_claimable_tasks → opentasks MCP server
 * - emit_status → replaced by inbox send (event messages)
 *
 * @module mcp/mcp-server-v2
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { AgentManager } from "../agent/agent-manager.js";
import type { AgentStore } from "../agent/agent-store.js";
import type { InboxAdapter } from "../adapters/types.js";
import type { TasksAdapter } from "../adapters/types.js";
import type { RoleRegistry, RoleDefinition } from "../roles/types.js";
import { DefaultRoleRegistry, isToolAllowedForRole } from "../roles/registry.js";
import type { ToolContext, HierarchyNode } from "./types.js";
import { MCPToolError } from "./types.js";
import {
  DoneSchema,
  createDoneHandlerV2,
  DONE_TOOL_INFO,
  type DoneToolDepsV2,
} from "./tools/done-v2.js";

// =============================================================================
// Configuration
// =============================================================================

export interface MCPServerV2Config {
  name?: string;
  version?: string;
}

export interface MCPServicesV2 {
  agentStore: AgentStore;
  agentManager: AgentManager;
  inboxAdapter: InboxAdapter;
  tasksAdapter: TasksAdapter;
  roleRegistry?: RoleRegistry;
  taskMode?: "push" | "pull";
}

export interface MCPServerV2Instance {
  server: McpServer;
  start(): Promise<void>;
  close(): Promise<void>;
}

// =============================================================================
// Schemas
// =============================================================================

const SpawnAgentSchema = {
  task: z.string().describe("Task description for the child agent"),
  role: z.string().optional().describe("Role for the child agent"),
  cwd: z.string().optional().describe("Working directory (defaults to parent's cwd)"),
  config: z.object({
    model: z.string().optional(),
  }).optional().describe("Custom config"),
};

const StopAgentSchema = {
  agent_id: z.string().describe("Agent ID to stop (must be in caller's subtree)"),
  reason: z.enum(["completed", "failed", "cancelled"]).optional().default("cancelled"),
};

const GetHierarchySchema = {
  root: z.string().optional().describe("Root agent ID (defaults to caller)"),
  depth: z.number().optional().describe("Max depth"),
};

const InjectContextSchema = {
  target_agent_id: z.string().describe("Agent ID to inject into"),
  content: z.string().describe("Context to inject"),
  urgent: z.boolean().optional().default(false).describe("If true, interrupts immediately"),
};

// =============================================================================
// Factory
// =============================================================================

export function createMCPServerV2(
  context: ToolContext,
  services: MCPServicesV2,
  config: MCPServerV2Config = {}
): MCPServerV2Instance {
  const { name = "macro-agent-mcp", version = "2.0.0" } = config;
  const {
    agentStore,
    agentManager,
    inboxAdapter,
    tasksAdapter,
    roleRegistry = new DefaultRoleRegistry(),
    taskMode,
  } = services;

  // Resolve agent's role for tool filtering
  const agentRecord = agentStore.getAgent(context.agent_id);
  const agentRole = agentRecord?.role ?? "worker";
  let resolvedRole: RoleDefinition;
  try {
    resolvedRole = roleRegistry.resolveRole(agentRole);
  } catch {
    // Fallback to worker role if resolution fails (e.g., unknown custom role)
    resolvedRole = roleRegistry.resolveRole("worker");
  }

  function shouldRegister(toolName: string): boolean {
    return isToolAllowedForRole(toolName, resolvedRole);
  }

  const server = new McpServer(
    { name, version },
    { capabilities: { tools: {} } }
  );

  // ── Tool: done ───────────────────────────────────────────────

  if (shouldRegister("done")) {
    const doneDeps: DoneToolDepsV2 = {
      agentStore,
      agentManager,
      inboxAdapter,
      tasksAdapter,
      roleRegistry,
      taskMode,
    };
    const doneHandler = createDoneHandlerV2(context, doneDeps);

    server.registerTool(DONE_TOOL_INFO.name, {
      description: DONE_TOOL_INFO.description,
      inputSchema: DoneSchema,
    }, async (args) => {
      const result = await doneHandler(args as any);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(result),
        }],
      };
    });
  }

  // ── Tool: spawn_agent ────────────────────────────────────────

  if (shouldRegister("spawn_agent")) {
    server.registerTool("spawn_agent", {
      description: "Spawn a child agent to work on a subtask",
      inputSchema: SpawnAgentSchema,
    }, async (args) => {
      try {
        const spawned = await agentManager.spawn({
          task: args.task,
          parent: context.agent_id,
          role: args.role,
          cwd: args.cwd ?? context.cwd,
          config: args.config,
        });

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              agent_id: spawned.id,
              name: spawned.agent.name,
              task_id: spawned.agent.task_id,
              session_id: spawned.session_id,
            }),
          }],
        };
      } catch (error) {
        throw new MCPToolError(
          `Failed to spawn agent: ${error}`,
          "SPAWN_FAILED"
        );
      }
    });
  }

  // ── Tool: stop_agent ─────────────────────────────────────────

  if (shouldRegister("stop_agent")) {
    server.registerTool("stop_agent", {
      description: "Stop a child agent in your subtree",
      inputSchema: StopAgentSchema,
    }, async (args) => {
      const targetId = args.agent_id;
      const target = agentStore.getAgent(targetId);
      if (!target) {
        throw new MCPToolError(`Agent ${targetId} not found`, "AGENT_NOT_FOUND");
      }

      // Verify target is in caller's subtree
      const descendants = agentStore.getDescendants(context.agent_id);
      const isInSubtree = descendants.some((d) => d.id === targetId);
      if (!isInSubtree && targetId !== context.agent_id) {
        throw new MCPToolError(
          `Agent ${targetId} is not in your subtree`,
          "NOT_IN_SUBTREE"
        );
      }

      await agentManager.terminate(targetId, args.reason ?? "cancelled");

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            success: true,
            stopped_agents: [{ agent_id: targetId, name: target.name }],
          }),
        }],
      };
    });
  }

  // ── Tool: get_hierarchy ──────────────────────────────────────

  if (shouldRegister("get_hierarchy")) {
    server.registerTool("get_hierarchy", {
      description: "Get the agent hierarchy tree",
      inputSchema: GetHierarchySchema,
    }, async (args) => {
      const rootId = args.root ?? context.agent_id;
      const hierarchy = agentManager.getHierarchy(rootId, {
        depth: args.depth,
      });

      if (!hierarchy) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ tree: null, depth: 0, total_agents: 0 }),
          }],
        };
      }

      function toNode(h: { agent: any; children: any[] }): HierarchyNode {
        return {
          agent_id: h.agent.id,
          name: h.agent.name,
          task: h.agent.task,
          state: h.agent.state,
          children: h.children.map(toNode),
        };
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            tree: toNode(hierarchy.root),
            depth: hierarchy.depth,
            total_agents: hierarchy.totalAgents,
          }),
        }],
      };
    });
  }

  // ── Tool: inject_context ─────────────────────────────────────

  if (shouldRegister("inject_context")) {
    server.registerTool("inject_context", {
      description: "Inject context into another agent's session for time-sensitive steering",
      inputSchema: InjectContextSchema,
    }, async (args) => {
      const targetId = args.target_agent_id;

      // Try sending as high-priority inbox message (agent-inbox handles delivery)
      try {
        const importance = args.urgent ? "urgent" : "high";
        const msgId = await inboxAdapter.send(
          context.agent_id,
          targetId,
          { type: "text", text: args.content },
          {
            importance,
            subject: "Context injection",
            threadTag: `inject:${context.agent_id}`,
          }
        );

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              method: "inbox",
              message_id: msgId,
              target_agent_id: targetId,
            }),
          }],
        };
      } catch (error) {
        throw new MCPToolError(
          `Failed to inject context: ${error}`,
          "ROUTING_FAILED"
        );
      }
    });
  }

  // ── Tool: claim_task (pull mode) ─────────────────────────────

  if (shouldRegister("claim_task")) {
    server.registerTool("claim_task", {
      description: "Claim the next available task from the pool (pull mode). Returns the claimed task or null if none available.",
      inputSchema: {
        tags: z.array(z.string()).optional().describe("Filter tasks by tags"),
        root_tasks_only: z.boolean().optional().describe("Only claim root-level tasks (no subtasks)"),
      },
    }, async (args) => {
      try {
        const filter: { tags?: string[] } = {};
        if (args.tags) filter.tags = args.tags;

        const task = await tasksAdapter.claimTask(context.agent_id, filter);

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify(task ?? { claimed: false, task: null }),
          }],
        };
      } catch (error) {
        throw new MCPToolError(
          `Failed to claim task: ${error}`,
          "TASK_NOT_FOUND"
        );
      }
    });
  }

  // ── Tool: unclaim_task (pull mode) ─────────────────────────

  if (shouldRegister("unclaim_task")) {
    server.registerTool("unclaim_task", {
      description: "Release a previously claimed task back to the pool.",
      inputSchema: {
        task_id: z.string().describe("ID of the task to unclaim"),
      },
    }, async (args) => {
      try {
        await tasksAdapter.unclaimTask(args.task_id);

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ success: true, task_id: args.task_id }),
          }],
        };
      } catch (error) {
        throw new MCPToolError(
          `Failed to unclaim task: ${error}`,
          "TASK_NOT_FOUND"
        );
      }
    });
  }

  // ── Tool: list_claimable_tasks (pull mode) ─────────────────

  if (shouldRegister("list_claimable_tasks")) {
    server.registerTool("list_claimable_tasks", {
      description: "List tasks available for claiming from the pool.",
      inputSchema: {
        tags: z.array(z.string()).optional().describe("Filter tasks by tags"),
        limit: z.number().optional().describe("Maximum number of tasks to return"),
      },
    }, async (args) => {
      try {
        const filter: { tags?: string[]; limit?: number } = {};
        if (args.tags) filter.tags = args.tags;
        if (args.limit) filter.limit = args.limit;

        const tasks = await tasksAdapter.listClaimable(filter);

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ tasks, count: tasks.length }),
          }],
        };
      } catch (error) {
        throw new MCPToolError(
          `Failed to list claimable tasks: ${error}`,
          "TASK_NOT_FOUND"
        );
      }
    });
  }

  // ── Start / Close ────────────────────────────────────────────

  return {
    server,
    async start(): Promise<void> {
      const transport = new StdioServerTransport();
      await server.connect(transport);
    },
    async close(): Promise<void> {
      await server.close();
    },
  };
}
