/**
 * Sudocode Task Tool Provider
 *
 * Provides MCP tools for task operations using SudocodeTaskBackend.
 * Supports native sudocode tools, mapped task tools, or both.
 *
 * @module task/backend/sudocode/tools
 * @see s-8472 Pluggable Task Backend Integration with Sudocode
 * @see i-185b 7B.4: Implement SudocodeTaskToolProvider
 */

import type { AgentId } from "../../../store/types/index.js";
import type {
  TaskToolProvider,
  MCPToolDefinition,
  TaskFilter,
  TaskStatus,
} from "../types.js";
import type { SudocodeTaskBackend } from "./backend.js";
import type { SudocodeClient, ListIssuesOptions } from "./client.js";

// =============================================================================
// Types
// =============================================================================

/**
 * Tool mode for SudocodeTaskToolProvider
 *
 * - `native`: Expose sudocode's native issue tools (default)
 * - `mapped`: Expose generic task tools that map to backend operations
 * - `both`: Expose both native and mapped tools
 */
export type TaskToolMode = "native" | "mapped" | "both";

/**
 * Context needed for tool execution
 */
export interface SudocodeToolContext {
  /** The agent making the tool call */
  agent_id: AgentId;
}

/**
 * Factory function type for getting context
 */
export type GetSudocodeToolContext = () => SudocodeToolContext;

/**
 * Configuration for SudocodeTaskToolProvider
 */
export interface SudocodeTaskToolProviderConfig {
  /** Tool mode (default: 'native') */
  mode?: TaskToolMode;
}

// =============================================================================
// Native Tool Names (for exclusion)
// =============================================================================

const NATIVE_TOOL_NAMES = [
  "upsert_issue",
  "show_issue",
  "list_issues",
  "ready",
  "link",
  "add_feedback",
];

const MAPPED_TOOL_NAMES = [
  "create_task",
  "get_task",
  "list_tasks",
  "list_ready_tasks",
  "get_task_blockers",
  "update_task_status",
  "add_blocker",
  "remove_blocker",
  "assign_task",
  "complete_task",
];

// =============================================================================
// SudocodeTaskToolProvider
// =============================================================================

/**
 * SudocodeTaskToolProvider
 *
 * Provides MCP tools for sudocode-backed task operations.
 * Supports multiple modes:
 * - `native`: Exposes sudocode's native issue tools (upsert_issue, show_issue, etc.)
 * - `mapped`: Exposes generic task tools that map to backend operations
 * - `both`: Exposes all tools from both modes
 */
export class SudocodeTaskToolProvider implements TaskToolProvider {
  private readonly mode: TaskToolMode;

  constructor(
    private readonly backend: SudocodeTaskBackend,
    private readonly client: SudocodeClient,
    private readonly getContext: GetSudocodeToolContext,
    config?: SudocodeTaskToolProviderConfig
  ) {
    this.mode = config?.mode ?? "native";
  }

  /**
   * Get the MCP tools based on the configured mode
   */
  getTools(): MCPToolDefinition[] {
    if (this.mode === "native") {
      return this.getNativeTools();
    } else if (this.mode === "mapped") {
      return this.getMappedTools();
    } else {
      return [...this.getNativeTools(), ...this.getMappedTools()];
    }
  }

  /**
   * Get tools that should be excluded when this provider is active
   */
  getExcludedTools(): string[] {
    if (this.mode === "native") {
      // When using native tools, exclude generic task tools
      return MAPPED_TOOL_NAMES;
    } else if (this.mode === "mapped") {
      // When using mapped tools, exclude native sudocode tools
      return NATIVE_TOOL_NAMES;
    }
    // In 'both' mode, don't exclude anything
    return [];
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Native Sudocode Tools
  // ─────────────────────────────────────────────────────────────────────────────

  private getNativeTools(): MCPToolDefinition[] {
    return [
      this.upsertIssueTool(),
      this.showIssueTool(),
      this.listIssuesTool(),
      this.readyTool(),
      this.linkTool(),
      this.addFeedbackTool(),
    ];
  }

  private upsertIssueTool(): MCPToolDefinition {
    return {
      name: "upsert_issue",
      description: "Create or update a sudocode issue",
      schema: {
        type: "object",
        properties: {
          issue_id: {
            type: "string",
            description:
              "Issue ID (e.g., 'i-abc123'). Omit to create new issue.",
          },
          title: {
            type: "string",
            description: "Issue title (required when creating)",
          },
          content: {
            type: "string",
            description: "Issue content/description in markdown",
          },
          status: {
            type: "string",
            enum: ["open", "in_progress", "blocked", "closed"],
            description: "Issue status",
          },
          priority: {
            type: "number",
            minimum: 0,
            maximum: 4,
            description: "Priority (0=highest, 4=lowest)",
          },
          assignee: {
            type: "string",
            description: "Assignee identifier",
          },
        },
      },
      handler: async (params: unknown) => {
        const args = params as {
          issue_id?: string;
          title?: string;
          content?: string;
          status?: "open" | "in_progress" | "blocked" | "closed";
          priority?: number;
          assignee?: string;
        };

        if (!args.issue_id) {
          // Creating new issue - title is required
          if (!args.title) {
            throw new Error("title is required when creating a new issue");
          }
        }

        const issue = await this.client.updateIssue(
          args.issue_id ?? `i-new-${Date.now()}`,
          {
            title: args.title,
            content: args.content,
            status: args.status,
            priority: args.priority,
            assignee: args.assignee,
          }
        );

        return {
          id: issue.id,
          title: issue.title,
          status: issue.status,
          updated: true,
        };
      },
    };
  }

  private showIssueTool(): MCPToolDefinition {
    return {
      name: "show_issue",
      description: "Get details of a specific issue",
      schema: {
        type: "object",
        properties: {
          issue_id: {
            type: "string",
            description: "Issue ID (e.g., 'i-abc123')",
          },
        },
        required: ["issue_id"],
      },
      handler: async (params: unknown) => {
        const args = params as { issue_id: string };

        const issue = await this.client.getIssue(args.issue_id);
        if (!issue) {
          throw new Error(`Issue not found: ${args.issue_id}`);
        }

        return {
          id: issue.id,
          title: issue.title,
          content: issue.content,
          status: issue.status,
          priority: issue.priority,
          assignee: issue.assignee,
          created_at: issue.created_at,
          updated_at: issue.updated_at,
        };
      },
    };
  }

  private listIssuesTool(): MCPToolDefinition {
    return {
      name: "list_issues",
      description: "List and filter issues",
      schema: {
        type: "object",
        properties: {
          status: {
            type: "string",
            enum: ["open", "in_progress", "blocked", "closed"],
            description: "Filter by status",
          },
          priority: {
            type: "number",
            minimum: 0,
            maximum: 4,
            description: "Filter by priority",
          },
          search: {
            type: "string",
            description: "Search text in title/content",
          },
          archived: {
            type: "boolean",
            description: "Include archived issues (default: false)",
          },
          limit: {
            type: "number",
            description: "Maximum results (default: 50)",
          },
        },
      },
      handler: async (params: unknown) => {
        const args = params as ListIssuesOptions;

        const issues = await this.client.listIssues(args);

        return {
          issues: issues.map((issue) => ({
            id: issue.id,
            title: issue.title,
            status: issue.status,
            priority: issue.priority,
          })),
          total: issues.length,
        };
      },
    };
  }

  private readyTool(): MCPToolDefinition {
    return {
      name: "ready",
      description: "Get issues that are ready to work on (no blockers)",
      schema: {
        type: "object",
        properties: {},
      },
      handler: async () => {
        const issues = await this.client.getReadyIssues();

        return {
          issues: issues.map((issue) => ({
            id: issue.id,
            title: issue.title,
            status: issue.status,
            priority: issue.priority,
          })),
          total: issues.length,
        };
      },
    };
  }

  private linkTool(): MCPToolDefinition {
    return {
      name: "link",
      description: "Create a relationship between issues or specs",
      schema: {
        type: "object",
        properties: {
          from_id: {
            type: "string",
            description: "Source entity ID (issue or spec)",
          },
          to_id: {
            type: "string",
            description: "Target entity ID (issue or spec)",
          },
          type: {
            type: "string",
            enum: [
              "blocks",
              "implements",
              "references",
              "depends-on",
              "discovered-from",
              "related",
            ],
            description: "Relationship type",
          },
        },
        required: ["from_id", "to_id", "type"],
      },
      handler: async (params: unknown) => {
        const args = params as {
          from_id: string;
          to_id: string;
          type:
            | "blocks"
            | "implements"
            | "references"
            | "depends-on"
            | "discovered-from"
            | "related";
        };

        await this.client.createLink(args.from_id, args.to_id, args.type);

        return {
          from_id: args.from_id,
          to_id: args.to_id,
          type: args.type,
          created: true,
        };
      },
    };
  }

  private addFeedbackTool(): MCPToolDefinition {
    return {
      name: "add_feedback",
      description: "Add feedback to a spec or issue",
      schema: {
        type: "object",
        properties: {
          to_id: {
            type: "string",
            description: "Target spec or issue ID",
          },
          issue_id: {
            type: "string",
            description: "Issue providing the feedback (optional)",
          },
          type: {
            type: "string",
            enum: ["comment", "suggestion", "request"],
            description: "Feedback type",
          },
          content: {
            type: "string",
            description: "Feedback content in markdown",
          },
          line: {
            type: "number",
            description: "Line number to anchor feedback",
          },
          text: {
            type: "string",
            description: "Text to anchor feedback to",
          },
        },
        required: ["to_id", "content"],
      },
      handler: async (params: unknown) => {
        const args = params as {
          to_id: string;
          issue_id?: string;
          type?: "comment" | "suggestion" | "request";
          content: string;
          line?: number;
          text?: string;
        };

        await this.client.addFeedback(args.issue_id, args.to_id, {
          type: args.type ?? "comment",
          content: args.content,
          anchor:
            args.line || args.text
              ? { line: args.line, text: args.text }
              : undefined,
        });

        return {
          to_id: args.to_id,
          added: true,
        };
      },
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Mapped Task Tools
  // ─────────────────────────────────────────────────────────────────────────────

  private getMappedTools(): MCPToolDefinition[] {
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

  private createTaskTool(): MCPToolDefinition {
    return {
      name: "create_task",
      description: "Create a new task (optionally bound to a sudocode issue)",
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
            description: "Sudocode issue ID to bind to",
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
          external_id: task.external_id,
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
            description: "Task ID",
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
          external_id: task.external_id,
          assigned_agent: task.assigned_agent,
          parent_task: task.parent_task,
          blockers: task.blockers ?? [],
          created_at: task.created_at,
          started_at: task.started_at,
          completed_at: task.completed_at,
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
            external_id: t.external_id,
            assigned_agent: t.assigned_agent,
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
            external_id: t.external_id,
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
            description: "Task ID",
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
            description: "Task ID",
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
            description: "Task ID",
          },
          agent_id: {
            type: "string",
            description: "Agent ID (defaults to calling agent)",
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
            description: "Task ID",
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
 * Create a SudocodeTaskToolProvider
 */
export function createSudocodeTaskToolProvider(
  backend: SudocodeTaskBackend,
  client: SudocodeClient,
  getContext: GetSudocodeToolContext,
  config?: SudocodeTaskToolProviderConfig
): SudocodeTaskToolProvider {
  return new SudocodeTaskToolProvider(backend, client, getContext, config);
}
