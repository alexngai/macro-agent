/**
 * In-Memory Task Tool Provider
 *
 * Provides MCP tools for task operations using InMemoryTaskBackend.
 *
 * @module task/backend
 * @see s-8472 Pluggable Task Backend Integration with Sudocode
 */

import type { AgentId } from "../../store/types/index.js";
import type {
  TaskBackend,
  TaskToolProvider,
  MCPToolDefinition,
  TaskFilter,
  TaskStatus,
} from "./types.js";

// =============================================================================
// Tool Provider Context
// =============================================================================

/**
 * Context needed for tool execution
 */
export interface TaskToolContext {
  /** The agent making the tool call */
  agent_id: AgentId;
}

/**
 * Factory function type for getting context
 */
export type GetToolContext = () => TaskToolContext;

// =============================================================================
// In-Memory Task Tool Provider
// =============================================================================

/**
 * InMemoryTaskToolProvider
 *
 * Provides MCP tools for task operations using the TaskBackend interface.
 * Tools include: create_task, get_task, list_tasks, list_ready_tasks,
 * get_task_blockers, update_task_status, add_blocker, remove_blocker.
 */
export class InMemoryTaskToolProvider implements TaskToolProvider {
  constructor(
    private readonly backend: TaskBackend,
    private readonly getContext: GetToolContext
  ) {}

  /**
   * Get the MCP tools for task operations
   */
  getTools(): MCPToolDefinition[] {
    return [
      this.createTaskTool(),
      this.getTaskTool(),
      this.listTasksTool(),
      this.listReadyTasksTool(),
      this.getTaskBlockersTool(),
      this.updateTaskStatusTool(),
      this.addBlockerTool(),
      this.removeBlockerTool(),
      this.assignTaskTool(),
      this.completeTaskTool(),
    ];
  }

  /**
   * Tools that should be excluded when this provider is active
   */
  getExcludedTools(): string[] {
    // Exclude the built-in task tools from mcp-server.ts
    return ["create_task", "get_task"];
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Tool Definitions
  // ─────────────────────────────────────────────────────────────────────────────

  private createTaskTool(): MCPToolDefinition {
    return {
      name: "create_task",
      description: "Create a new task",
      schema: {
        type: "object",
        properties: {
          description: {
            type: "string",
            description: "Task description",
          },
          parent_task: {
            type: "string",
            description: "Parent task ID for subtasks",
          },
          external_id: {
            type: "string",
            description: "External system binding (e.g., sudocode issue ID)",
          },
        },
        required: ["description"],
      },
      handler: async (params: unknown) => {
        const args = params as {
          description: string;
          parent_task?: string;
          external_id?: string;
        };
        const context = this.getContext();

        const task = await this.backend.create({
          description: args.description,
          created_by: context.agent_id,
          parent_task: args.parent_task,
          external_id: args.external_id,
        });

        return {
          task_id: task.id,
          status: task.status,
          created_at: task.created_at,
        };
      },
    };
  }

  private getTaskTool(): MCPToolDefinition {
    return {
      name: "get_task",
      description: "Get details of a specific task",
      schema: {
        type: "object",
        properties: {
          task_id: {
            type: "string",
            description: "Task ID to look up",
          },
        },
        required: ["task_id"],
      },
      handler: async (params: unknown) => {
        const args = params as { task_id: string };

        const task = await this.backend.get(args.task_id);
        if (!task) {
          throw new Error(`Task not found: ${args.task_id}`);
        }

        return {
          id: task.id,
          description: task.description,
          status: task.status,
          isBlocked: task.isBlocked,
          assigned_agent: task.assigned_agent,
          parent_task: task.parent_task,
          blockers: task.blockers ?? [],
          created_at: task.created_at,
          started_at: task.started_at,
          completed_at: task.completed_at,
          outputs: task.outputs,
          artifacts: task.artifacts,
        };
      },
    };
  }

  private listTasksTool(): MCPToolDefinition {
    return {
      name: "list_tasks",
      description: "List tasks with optional filtering",
      schema: {
        type: "object",
        properties: {
          status: {
            type: "string",
            enum: ["pending", "assigned", "in_progress", "completed", "failed"],
            description: "Filter by task status",
          },
          assigned_agent: {
            type: "string",
            description: "Filter by assigned agent",
          },
          parent_task: {
            type: "string",
            description: "Filter by parent task",
          },
          root_only: {
            type: "boolean",
            description: "Only return root tasks (no parent)",
          },
          include_blocked: {
            type: "boolean",
            description: "Include blocked tasks (default: true)",
          },
        },
      },
      handler: async (params: unknown) => {
        const args = params as {
          status?: TaskStatus;
          assigned_agent?: string;
          parent_task?: string;
          root_only?: boolean;
          include_blocked?: boolean;
        };

        const filter: TaskFilter = {};
        if (args.status) filter.status = args.status;
        if (args.assigned_agent) filter.assigned_agent = args.assigned_agent;
        if (args.parent_task) filter.parent_task = args.parent_task;
        if (args.root_only) filter.rootTasksOnly = true;
        if (args.include_blocked !== undefined)
          filter.includeBlocked = args.include_blocked;

        const tasks = await this.backend.list(filter);

        return {
          tasks: tasks.map((t) => ({
            id: t.id,
            description: t.description,
            status: t.status,
            isBlocked: t.isBlocked,
            assigned_agent: t.assigned_agent,
            parent_task: t.parent_task,
          })),
          total: tasks.length,
        };
      },
    };
  }

  private listReadyTasksTool(): MCPToolDefinition {
    return {
      name: "list_ready_tasks",
      description:
        "List tasks that are ready to work on (pending/assigned, no blockers)",
      schema: {
        type: "object",
        properties: {
          assigned_agent: {
            type: "string",
            description: "Filter by assigned agent",
          },
          parent_task: {
            type: "string",
            description: "Filter by parent task",
          },
        },
      },
      handler: async (params: unknown) => {
        const args = params as {
          assigned_agent?: string;
          parent_task?: string;
        };

        const filter: TaskFilter = {};
        if (args.assigned_agent) filter.assigned_agent = args.assigned_agent;
        if (args.parent_task) filter.parent_task = args.parent_task;

        const tasks = await this.backend.listReady(filter);

        return {
          tasks: tasks.map((t) => ({
            id: t.id,
            description: t.description,
            status: t.status,
            assigned_agent: t.assigned_agent,
          })),
          total: tasks.length,
        };
      },
    };
  }

  private getTaskBlockersTool(): MCPToolDefinition {
    return {
      name: "get_task_blockers",
      description: "Get tasks that block a specific task",
      schema: {
        type: "object",
        properties: {
          task_id: {
            type: "string",
            description: "Task ID to get blockers for",
          },
        },
        required: ["task_id"],
      },
      handler: async (params: unknown) => {
        const args = params as { task_id: string };

        const blockers = await this.backend.getBlockers(args.task_id);

        return {
          task_id: args.task_id,
          blockers: blockers.map((t) => ({
            id: t.id,
            description: t.description,
            status: t.status,
            isCompleted: t.status === "completed",
          })),
          isBlocked: blockers.some((t) => t.status !== "completed"),
        };
      },
    };
  }

  private updateTaskStatusTool(): MCPToolDefinition {
    return {
      name: "update_task_status",
      description: "Update the status of a task",
      schema: {
        type: "object",
        properties: {
          task_id: {
            type: "string",
            description: "Task ID to update",
          },
          status: {
            type: "string",
            enum: ["pending", "assigned", "in_progress", "completed", "failed"],
            description: "New status",
          },
        },
        required: ["task_id", "status"],
      },
      handler: async (params: unknown) => {
        const args = params as { task_id: string; status: TaskStatus };

        const task = await this.backend.update(args.task_id, {
          status: args.status,
        });

        return {
          task_id: task.id,
          status: task.status,
          updated: true,
        };
      },
    };
  }

  private addBlockerTool(): MCPToolDefinition {
    return {
      name: "add_blocker",
      description: "Add a blocking dependency to a task",
      schema: {
        type: "object",
        properties: {
          task_id: {
            type: "string",
            description: "Task that will be blocked",
          },
          blocker_id: {
            type: "string",
            description: "Task that blocks the first task",
          },
        },
        required: ["task_id", "blocker_id"],
      },
      handler: async (params: unknown) => {
        const args = params as { task_id: string; blocker_id: string };

        await this.backend.addBlocker(args.task_id, args.blocker_id);

        return {
          task_id: args.task_id,
          blocker_id: args.blocker_id,
          added: true,
        };
      },
    };
  }

  private removeBlockerTool(): MCPToolDefinition {
    return {
      name: "remove_blocker",
      description: "Remove a blocking dependency from a task",
      schema: {
        type: "object",
        properties: {
          task_id: {
            type: "string",
            description: "Task to remove blocker from",
          },
          blocker_id: {
            type: "string",
            description: "Blocker task to remove",
          },
        },
        required: ["task_id", "blocker_id"],
      },
      handler: async (params: unknown) => {
        const args = params as { task_id: string; blocker_id: string };

        await this.backend.removeBlocker(args.task_id, args.blocker_id);

        return {
          task_id: args.task_id,
          blocker_id: args.blocker_id,
          removed: true,
        };
      },
    };
  }

  private assignTaskTool(): MCPToolDefinition {
    return {
      name: "assign_task",
      description: "Assign a task to an agent",
      schema: {
        type: "object",
        properties: {
          task_id: {
            type: "string",
            description: "Task ID to assign",
          },
          agent_id: {
            type: "string",
            description:
              "Agent ID to assign to (defaults to calling agent if not specified)",
          },
          role: {
            type: "string",
            description: "Optional role for the assignment",
          },
        },
        required: ["task_id"],
      },
      handler: async (params: unknown) => {
        const args = params as {
          task_id: string;
          agent_id?: string;
          role?: string;
        };
        const context = this.getContext();

        const agentId = args.agent_id ?? context.agent_id;
        await this.backend.assign(args.task_id, agentId, { role: args.role });

        return {
          task_id: args.task_id,
          assigned_agent: agentId,
          assigned: true,
        };
      },
    };
  }

  private completeTaskTool(): MCPToolDefinition {
    return {
      name: "complete_task",
      description: "Mark a task as completed with optional outputs",
      schema: {
        type: "object",
        properties: {
          task_id: {
            type: "string",
            description: "Task ID to complete",
          },
          summary: {
            type: "string",
            description: "Summary of work done",
          },
          outputs: {
            type: "object",
            description: "Output data from the task",
          },
        },
        required: ["task_id"],
      },
      handler: async (params: unknown) => {
        const args = params as {
          task_id: string;
          summary?: string;
          outputs?: Record<string, unknown>;
        };

        await this.backend.complete(args.task_id, {
          summary: args.summary,
          data: args.outputs,
        });

        return {
          task_id: args.task_id,
          completed: true,
        };
      },
    };
  }
}

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Create an InMemoryTaskToolProvider
 */
export function createTaskToolProvider(
  backend: TaskBackend,
  getContext: GetToolContext
): InMemoryTaskToolProvider {
  return new InMemoryTaskToolProvider(backend, getContext);
}
