/**
 * OpenTasks Task Tool Provider
 *
 * Provides MCP tools for task operations using OpenTasksTaskBackend.
 * Supports native opentasks tools, mapped abstract tools, or both.
 *
 * Native tools expose the full opentasks surface:
 * - CRUD (create/get/update/delete nodes)
 * - Graph queries (ready, blockers, search, feedback)
 * - Relationships (link/unlink)
 * - Feedback lifecycle (annotate)
 *
 * Mapped tools expose the standard macro-agent task interface
 * (create_task, get_task, list_tasks, etc.)
 *
 * @module task/backend/opentasks/tools
 */

import type { AgentId } from "../../../store/types/index.js";
import type {
  TaskToolProvider,
  MCPToolDefinition,
  TaskFilter,
  TaskStatus,
} from "../types.js";
import type { OpenTasksTaskBackend } from "./backend.js";
import type { OpenTasksClient } from "./client.js";

// =============================================================================
// Types
// =============================================================================

/**
 * Tool mode for OpenTasksTaskToolProvider
 *
 * - `native`: Expose opentasks-native tools (create/get/update/query/link/annotate)
 * - `mapped`: Expose generic task tools that map to backend operations
 * - `both`: Expose both native and mapped tools
 */
export type OpenTasksToolMode = "native" | "mapped" | "both";

/**
 * Context needed for tool execution
 */
export interface OpenTasksToolContext {
  /** The agent making the tool call */
  agent_id: AgentId;
}

/**
 * Factory function type for getting context
 */
export type GetOpenTasksToolContext = () => OpenTasksToolContext;

/**
 * Configuration for OpenTasksTaskToolProvider
 */
export interface OpenTasksToolProviderConfig {
  /** Tool mode (default: 'native') */
  mode?: OpenTasksToolMode;
}

// =============================================================================
// Tool Names
// =============================================================================

const NATIVE_TOOL_NAMES = [
  "opentasks_create",
  "opentasks_get",
  "opentasks_update",
  "opentasks_delete",
  "opentasks_query",
  "opentasks_link",
  "opentasks_annotate",
  "opentasks_task",
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
// OpenTasksTaskToolProvider
// =============================================================================

/**
 * OpenTasksTaskToolProvider
 *
 * Provides MCP tools for opentasks-backed task operations.
 *
 * In `native` mode, agents interact directly with opentasks concepts
 * (issues, specs, edges, feedback) giving them full graph power.
 *
 * In `mapped` mode, agents see the standard macro-agent task tools.
 *
 * In `both` mode, both sets are available.
 */
export class OpenTasksTaskToolProvider implements TaskToolProvider {
  private readonly mode: OpenTasksToolMode;

  constructor(
    private readonly backend: OpenTasksTaskBackend,
    private readonly client: OpenTasksClient,
    private readonly getContext: GetOpenTasksToolContext,
    config?: OpenTasksToolProviderConfig
  ) {
    this.mode = config?.mode ?? "native";
  }

  getTools(): MCPToolDefinition[] {
    if (this.mode === "native") {
      return this.getNativeTools();
    } else if (this.mode === "mapped") {
      return this.getMappedTools();
    } else {
      return [...this.getNativeTools(), ...this.getMappedTools()];
    }
  }

  getExcludedTools(): string[] {
    if (this.mode === "native") {
      return MAPPED_TOOL_NAMES;
    } else if (this.mode === "mapped") {
      return NATIVE_TOOL_NAMES;
    }
    return [];
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Native OpenTasks Tools
  // ─────────────────────────────────────────────────────────────────────────────

  private getNativeTools(): MCPToolDefinition[] {
    return [
      this.createNodeTool(),
      this.getNodeTool(),
      this.updateNodeTool(),
      this.deleteNodeTool(),
      this.queryTool(),
      this.linkTool(),
      this.annotateTool(),
      this.taskTool(),
    ];
  }

  private createNodeTool(): MCPToolDefinition {
    return {
      name: "opentasks_create",
      description:
        "Create a node in the OpenTasks graph. " +
        "Types: issue (actionable work), spec (requirements/plans), " +
        "external (reference to Jira/Linear/etc).",
      schema: {
        type: "object",
        properties: {
          type: {
            type: "string",
            enum: ["issue", "spec", "external"],
            description: "Node type",
          },
          title: {
            type: "string",
            description: "Title (required)",
          },
          content: {
            type: "string",
            description: "Markdown body content",
          },
          status: {
            type: "string",
            description:
              "Status. Issues: open|in_progress|blocked|closed. " +
              "Specs: draft|active|archived.",
          },
          priority: {
            type: "number",
            minimum: 0,
            maximum: 4,
            description: "Priority (0=highest, 4=lowest)",
          },
          tags: {
            type: "array",
            items: { type: "string" },
            description: "Tags for categorization",
          },
          assignee: {
            type: "string",
            description: "Assigned agent/user (issues only)",
          },
          parent_id: {
            type: "string",
            description: "Parent node ID for hierarchy",
          },
          uri: {
            type: "string",
            description: "External URI (required for external nodes, e.g. jira://PROJ-123)",
          },
          source: {
            type: "string",
            description: "Source system (required for external nodes, e.g. jira, linear)",
          },
          metadata: {
            type: "object",
            description: "Additional metadata",
          },
        },
        required: ["type", "title"],
      },
      handler: async (params: unknown) => {
        const args = params as {
          type: "issue" | "spec" | "external";
          title: string;
          content?: string;
          status?: string;
          priority?: number;
          tags?: string[];
          assignee?: string;
          parent_id?: string;
          uri?: string;
          source?: string;
          metadata?: Record<string, unknown>;
        };

        const result = await this.client.createIssue({
          title: args.title,
          content: args.content,
          status: args.status ?? (args.type === "issue" ? "open" : undefined),
          priority: args.priority,
          tags: args.tags,
          assignee: args.assignee,
          parent_id: args.parent_id,
          metadata: {
            ...args.metadata,
            _node_type: args.type,
            _created_by_agent: this.getContext().agent_id,
            // For external nodes, store URI info in metadata
            ...(args.uri ? { uri: args.uri, source: args.source } : {}),
          },
        });

        return {
          id: result.id,
          type: args.type,
          title: result.title,
          status: result.status,
          created: true,
        };
      },
    };
  }

  private getNodeTool(): MCPToolDefinition {
    return {
      name: "opentasks_get",
      description: "Get details of a node by ID (issue, spec, or external)",
      schema: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "Node ID (e.g. i-abc1, s-def2)",
          },
        },
        required: ["id"],
      },
      handler: async (params: unknown) => {
        const args = params as { id: string };

        const node = await this.client.getIssue(args.id);
        if (!node) {
          throw new Error(`Node not found: ${args.id}`);
        }

        return {
          id: node.id,
          type: node.type,
          title: node.title,
          content: node.content,
          status: node.status,
          priority: node.priority,
          tags: node.tags,
          assignee: node.assignee,
          parent_id: node.parent_id,
          claimed_by: node.claimed_by,
          created_at: node.created_at,
          updated_at: node.updated_at,
          metadata: node.metadata,
        };
      },
    };
  }

  private updateNodeTool(): MCPToolDefinition {
    return {
      name: "opentasks_update",
      description:
        "Update a node's fields (status, assignee, content, priority, tags, etc.)",
      schema: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "Node ID to update",
          },
          title: {
            type: "string",
            description: "New title",
          },
          content: {
            type: "string",
            description: "New markdown content",
          },
          status: {
            type: "string",
            description: "New status",
          },
          priority: {
            type: "number",
            minimum: 0,
            maximum: 4,
            description: "New priority",
          },
          assignee: {
            type: "string",
            description: "New assignee (null to unassign)",
          },
          tags: {
            type: "array",
            items: { type: "string" },
            description: "Replace tags",
          },
          archived: {
            type: "boolean",
            description: "Archive/unarchive",
          },
          metadata: {
            type: "object",
            description: "Metadata to merge",
          },
        },
        required: ["id"],
      },
      handler: async (params: unknown) => {
        const args = params as {
          id: string;
          title?: string;
          content?: string;
          status?: string;
          priority?: number;
          assignee?: string | null;
          tags?: string[];
          archived?: boolean;
          metadata?: Record<string, unknown>;
        };

        const { id, ...updates } = args;
        const result = await this.client.updateIssue(id, updates);

        return {
          id: result.id,
          title: result.title,
          status: result.status,
          updated: true,
        };
      },
    };
  }

  private deleteNodeTool(): MCPToolDefinition {
    return {
      name: "opentasks_delete",
      description: "Delete (archive) a node",
      schema: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "Node ID to delete",
          },
        },
        required: ["id"],
      },
      handler: async (params: unknown) => {
        const args = params as { id: string };
        await this.client.deleteIssue(args.id);
        return { id: args.id, deleted: true };
      },
    };
  }

  private queryTool(): MCPToolDefinition {
    return {
      name: "opentasks_query",
      description:
        "Query the OpenTasks graph. Supports: nodes (search/filter), " +
        "ready (unblocked work), blockers/blocking (dependencies), " +
        "feedback (comments on nodes). Specify exactly one query type.",
      schema: {
        type: "object",
        properties: {
          // Node queries
          nodes: {
            type: "object",
            description: "Query nodes with filters",
            properties: {
              type: {
                type: "string",
                enum: ["issue", "spec", "feedback", "external"],
                description: "Filter by type",
              },
              status: {
                type: "string",
                description: "Filter by status (or comma-separated list)",
              },
              tags: {
                type: "array",
                items: { type: "string" },
                description: "Filter by tags (AND)",
              },
              search: {
                type: "string",
                description: "Text search in title and content",
              },
              assignee: {
                type: "string",
                description: "Filter by assignee",
              },
              parent_id: {
                type: "string",
                description: "Filter by parent",
              },
              limit: { type: "number", description: "Max results (default: 50)" },
            },
          },
          // Ready query
          ready: {
            type: "object",
            description: "Get issues ready to work on (no active blockers)",
            properties: {
              tags: {
                type: "array",
                items: { type: "string" },
                description: "Filter by tags",
              },
              assignee: {
                type: "string",
                description: "Filter by assignee",
              },
              limit: { type: "number", description: "Max results" },
            },
          },
          // Blocker queries
          blockers: {
            type: "object",
            description: "Get nodes blocking a specific node",
            properties: {
              nodeId: { type: "string", description: "Node to check" },
              transitive: {
                type: "boolean",
                description: "Include transitive blockers (default: false)",
              },
              activeOnly: {
                type: "boolean",
                description: "Only non-closed blockers (default: true)",
              },
            },
            required: ["nodeId"],
          },
          blocking: {
            type: "object",
            description: "Get nodes blocked by a specific node",
            properties: {
              nodeId: { type: "string", description: "Node to check" },
            },
            required: ["nodeId"],
          },
          // Feedback queries
          feedback: {
            type: "object",
            description: "Get feedback on a node",
            properties: {
              nodeId: { type: "string", description: "Target node" },
              type: {
                type: "string",
                enum: ["comment", "suggestion", "request"],
                description: "Feedback type filter",
              },
              resolved: {
                type: "boolean",
                description: "Filter by resolution status",
              },
            },
            required: ["nodeId"],
          },
          // Options
          verbose: {
            type: "boolean",
            description: "Return full objects instead of summaries (default: false)",
          },
          limit: { type: "number", description: "Max results (default: 50)" },
        },
      },
      handler: async (params: unknown) => {
        const args = params as Record<string, unknown>;

        // Determine which query type was specified
        if (args.ready !== undefined) {
          const ready = (args.ready ?? {}) as Record<string, unknown>;
          // Delegate to tools.task ready for federated provider support
          const result = await this.client.taskReady({
            tags: ready.tags as string[] | undefined,
            assignee: ready.assignee as string | undefined,
            limit: (ready.limit ?? args.limit) as number | undefined,
          });
          if (result.success && result.data && result.data.type === "ready") {
            return { items: result.data.items, total: result.data.total, type: "ready" };
          }
          return { items: [], total: 0, type: "ready" };
        }

        if (args.blockers !== undefined) {
          const q = args.blockers as { nodeId: string };
          const results = await this.client.getBlockers(q.nodeId);
          return { items: results, total: results.length, type: "blockers" };
        }

        if (args.blocking !== undefined) {
          const q = args.blocking as { nodeId: string };
          const results = await this.client.getBlocking(q.nodeId);
          return { items: results, total: results.length, type: "blocking" };
        }

        if (args.nodes !== undefined) {
          const filter = (args.nodes ?? {}) as Record<string, unknown>;
          const statusFilter = filter.status as string | undefined;
          const results = await this.client.listIssues({
            status: statusFilter?.includes(",")
              ? statusFilter.split(",")
              : statusFilter,
            assignee: filter.assignee as string | undefined,
            tags: filter.tags as string[] | undefined,
            parent_id: filter.parent_id as string | undefined,
            limit: (filter.limit ?? args.limit) as number | undefined,
          });
          return {
            items: results.map((n) => ({
              id: n.id,
              type: n.type,
              title: n.title,
              status: n.status,
              priority: n.priority,
              assignee: n.assignee,
              tags: n.tags,
            })),
            total: results.length,
            type: "nodes",
          };
        }

        // Default: list all open issues
        const results = await this.client.listIssues({
          status: ["open", "in_progress"],
          limit: (args.limit as number) ?? 50,
        });
        return {
          items: results.map((n) => ({
            id: n.id,
            type: n.type,
            title: n.title,
            status: n.status,
            priority: n.priority,
          })),
          total: results.length,
          type: "nodes",
        };
      },
    };
  }

  private linkTool(): MCPToolDefinition {
    return {
      name: "opentasks_link",
      description:
        "Create or remove a relationship between nodes. " +
        "Types: blocks, implements, references, related, child-of, " +
        "parent-of, depends-on, discovered-from, duplicates, supersedes.",
      schema: {
        type: "object",
        properties: {
          from_id: {
            type: "string",
            description: "Source node ID or provider URI",
          },
          to_id: {
            type: "string",
            description: "Target node ID or provider URI",
          },
          type: {
            type: "string",
            enum: [
              "blocks",
              "implements",
              "references",
              "related",
              "child-of",
              "parent-of",
              "depends-on",
              "discovered-from",
              "duplicates",
              "supersedes",
            ],
            description: "Relationship type",
          },
          remove: {
            type: "boolean",
            description: "Remove the edge instead of creating (default: false)",
          },
        },
        required: ["from_id", "to_id", "type"],
      },
      handler: async (params: unknown) => {
        const args = params as {
          from_id: string;
          to_id: string;
          type: string;
          remove?: boolean;
        };

        if (args.remove) {
          await this.client.removeEdge(args.from_id, args.to_id, args.type);
          return {
            from_id: args.from_id,
            to_id: args.to_id,
            type: args.type,
            removed: true,
          };
        }

        const edge = await this.client.createEdge(
          args.from_id,
          args.to_id,
          args.type
        );
        return {
          edge_id: edge.id,
          from_id: args.from_id,
          to_id: args.to_id,
          type: args.type,
          created: true,
        };
      },
    };
  }

  private annotateTool(): MCPToolDefinition {
    return {
      name: "opentasks_annotate",
      description:
        "Add feedback to a node, or resolve/dismiss/reopen existing feedback. " +
        "Feedback types: comment, suggestion, request. " +
        "Can anchor to specific line numbers or text.",
      schema: {
        type: "object",
        properties: {
          target_id: {
            type: "string",
            description: "Target node receiving feedback",
          },
          // Create feedback
          content: {
            type: "string",
            description: "Feedback content (markdown). Required for new feedback.",
          },
          feedback_type: {
            type: "string",
            enum: ["comment", "suggestion", "request"],
            description: "Type of feedback (default: comment)",
          },
          line: {
            type: "number",
            description: "Line number to anchor feedback to",
          },
          text: {
            type: "string",
            description: "Text snippet to anchor feedback to",
          },
          from_id: {
            type: "string",
            description: "Issue providing the feedback (creates discovered-from link)",
          },
          // Lifecycle actions
          resolve: {
            type: "string",
            description: "Feedback ID to resolve",
          },
          dismiss: {
            type: "string",
            description: "Feedback ID to dismiss",
          },
          reopen: {
            type: "string",
            description: "Feedback ID to reopen",
          },
        },
        required: ["target_id"],
      },
      handler: async (params: unknown) => {
        const args = params as {
          target_id: string;
          content?: string;
          feedback_type?: "comment" | "suggestion" | "request";
          line?: number;
          text?: string;
          from_id?: string;
          resolve?: string;
          dismiss?: string;
          reopen?: string;
        };

        // Build the annotate params for the daemon
        // We use the generic RPC call since annotate is a tools-layer method
        if (args.content) {
          // Create new feedback - we create a feedback node via the graph API
          const feedbackNode = await this.client.createIssue({
            title: args.content.slice(0, 100),
            content: args.content,
            metadata: {
              _node_type: "feedback",
              target_id: args.target_id,
              feedback_type: args.feedback_type ?? "comment",
              from_id: args.from_id,
              anchor_line: args.line,
              anchor_text: args.text,
              _created_by_agent: this.getContext().agent_id,
            },
          });

          // Link feedback to target
          if (args.from_id) {
            await this.client.createEdge(
              args.from_id,
              args.target_id,
              "discovered-from"
            );
          }

          return {
            feedback_id: feedbackNode.id,
            target_id: args.target_id,
            type: args.feedback_type ?? "comment",
            created: true,
          };
        }

        if (args.resolve) {
          await this.client.updateIssue(args.resolve, {
            metadata: { resolved: true, resolved_at: new Date().toISOString() },
          });
          return { feedback_id: args.resolve, resolved: true };
        }

        if (args.dismiss) {
          await this.client.updateIssue(args.dismiss, {
            metadata: { dismissed: true, dismissed_at: new Date().toISOString() },
          });
          return { feedback_id: args.dismiss, dismissed: true };
        }

        if (args.reopen) {
          await this.client.updateIssue(args.reopen, {
            metadata: { resolved: false, dismissed: false },
          });
          return { feedback_id: args.reopen, reopened: true };
        }

        throw new Error(
          "Must provide content (new feedback), resolve, dismiss, or reopen"
        );
      },
    };
  }

  private taskTool(): MCPToolDefinition {
    return {
      name: "opentasks_task",
      description:
        "Provider-agnostic task lifecycle operations. Routes to the correct " +
        "provider (native, sudocode, etc.) based on task ID or URI. " +
        "Supports: transition (start/complete/block/reopen/close), " +
        "ready (federated across providers), assign, validActions. " +
        "Specify exactly one operation.",
      schema: {
        type: "object",
        properties: {
          transition: {
            type: "object",
            description: "Transition a task's status using a semantic action",
            properties: {
              id: {
                type: "string",
                description: "Task ID (e.g. i-abc1) or provider URI (e.g. sudocode://proj/i-456)",
              },
              action: {
                type: "string",
                enum: ["start", "complete", "block", "reopen", "close"],
                description: "Semantic action to apply",
              },
            },
            required: ["id", "action"],
          },
          ready: {
            type: "object",
            description: "Get tasks ready to work on (no active blockers), federated across providers",
            properties: {
              providers: {
                type: "array",
                items: { type: "string" },
                description: "Only query these providers (e.g. ['native', 'sudocode']). Omit for all.",
              },
              limit: { type: "number", description: "Max results" },
              tags: {
                type: "array",
                items: { type: "string" },
                description: "Filter by tags",
              },
              priority: {
                type: "number",
                description: "Filter by minimum priority",
              },
              assignee: {
                type: "string",
                description: "Filter by assignee",
              },
            },
          },
          assign: {
            type: "object",
            description: "Assign a task to an owner",
            properties: {
              id: {
                type: "string",
                description: "Task ID or provider URI",
              },
              assignee: {
                type: "string",
                description: "Assignee identifier (defaults to calling agent)",
              },
            },
            required: ["id"],
          },
          validActions: {
            type: "object",
            description: "Get valid next actions for a task's current state",
            properties: {
              id: {
                type: "string",
                description: "Task ID or provider URI",
              },
            },
            required: ["id"],
          },
        },
      },
      handler: async (params: unknown) => {
        const args = params as {
          transition?: { id: string; action: string };
          ready?: {
            providers?: string[];
            limit?: number;
            tags?: string[];
            priority?: number;
            assignee?: string;
          };
          assign?: { id: string; assignee?: string };
          validActions?: { id: string };
        };

        if (args.transition) {
          const result = await this.client.taskTransition(
            args.transition.id,
            args.transition.action as "start" | "complete" | "block" | "reopen" | "close"
          );
          if (!result.success) {
            throw new Error(result.error ?? "Transition failed");
          }
          return result.data;
        }

        if (args.ready !== undefined) {
          const result = await this.client.taskReady(args.ready);
          if (!result.success) {
            throw new Error(result.error ?? "Ready query failed");
          }
          return result.data;
        }

        if (args.assign) {
          const assignee = args.assign.assignee ?? this.getContext().agent_id;
          const result = await this.client.taskAssign(args.assign.id, assignee);
          if (!result.success) {
            throw new Error(result.error ?? "Assignment failed");
          }
          return result.data;
        }

        if (args.validActions) {
          const result = await this.client.taskValidActions(args.validActions.id);
          if (!result.success) {
            throw new Error(result.error ?? "Valid actions query failed");
          }
          return result.data;
        }

        throw new Error(
          "Specify exactly one operation: transition, ready, assign, or validActions"
        );
      },
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Mapped Task Tools (abstract interface)
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
      description: "Create a new task (creates an OpenTasks issue)",
      schema: {
        type: "object",
        properties: {
          description: { type: "string", description: "Task description" },
          parent_task: { type: "string", description: "Parent task ID" },
          tags: {
            type: "array",
            items: { type: "string" },
            description: "Tags",
          },
        },
        required: ["description"],
      },
      handler: async (params: unknown) => {
        const args = params as {
          description: string;
          parent_task?: string;
          tags?: string[];
        };
        const context = this.getContext();
        const task = await this.backend.create({
          description: args.description,
          created_by: context.agent_id,
          parent_task: args.parent_task,
          tags: args.tags,
        });
        return {
          task_id: task.id,
          status: task.status,
          external_id: task.external_id,
        };
      },
    };
  }

  private getTaskTool(): MCPToolDefinition {
    return {
      name: "get_task",
      description: "Get details of a task",
      schema: {
        type: "object",
        properties: {
          task_id: { type: "string", description: "Task ID" },
        },
        required: ["task_id"],
      },
      handler: async (params: unknown) => {
        const args = params as { task_id: string };
        const task = await this.backend.get(args.task_id);
        if (!task) throw new Error(`Task not found: ${args.task_id}`);
        return {
          id: task.id,
          description: task.description,
          status: task.status,
          isBlocked: task.isBlocked,
          external_id: task.external_id,
          assigned_agent: task.assigned_agent,
          parent_task: task.parent_task,
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
          },
          assigned_agent: { type: "string" },
          parent_task: { type: "string" },
          root_only: { type: "boolean" },
          include_blocked: { type: "boolean" },
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
      description: "List tasks ready to work on (no blockers)",
      schema: {
        type: "object",
        properties: {
          assigned_agent: { type: "string" },
          parent_task: { type: "string" },
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
          task_id: { type: "string" },
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
          task_id: { type: "string" },
          status: {
            type: "string",
            enum: ["pending", "assigned", "in_progress", "completed", "failed"],
          },
        },
        required: ["task_id", "status"],
      },
      handler: async (params: unknown) => {
        const args = params as { task_id: string; status: TaskStatus };
        const task = await this.backend.update(args.task_id, {
          status: args.status,
        });
        return { task_id: task.id, status: task.status, updated: true };
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
          task_id: { type: "string", description: "Task that will be blocked" },
          blocker_id: { type: "string", description: "Task that blocks" },
        },
        required: ["task_id", "blocker_id"],
      },
      handler: async (params: unknown) => {
        const args = params as { task_id: string; blocker_id: string };
        await this.backend.addBlocker(args.task_id, args.blocker_id);
        return { task_id: args.task_id, blocker_id: args.blocker_id, added: true };
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
          task_id: { type: "string" },
          blocker_id: { type: "string" },
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
          task_id: { type: "string" },
          agent_id: { type: "string", description: "Defaults to calling agent" },
          role: { type: "string" },
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
        return { task_id: args.task_id, assigned_agent: agentId, assigned: true };
      },
    };
  }

  private completeTaskTool(): MCPToolDefinition {
    return {
      name: "complete_task",
      description: "Mark a task as completed",
      schema: {
        type: "object",
        properties: {
          task_id: { type: "string" },
          summary: { type: "string" },
          outputs: { type: "object" },
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
        return { task_id: args.task_id, completed: true };
      },
    };
  }
}

// =============================================================================
// Factory
// =============================================================================

/**
 * Create an OpenTasksTaskToolProvider
 */
export function createOpenTasksToolProvider(
  backend: OpenTasksTaskBackend,
  client: OpenTasksClient,
  getContext: GetOpenTasksToolContext,
  config?: OpenTasksToolProviderConfig
): OpenTasksTaskToolProvider {
  return new OpenTasksTaskToolProvider(backend, client, getContext, config);
}
