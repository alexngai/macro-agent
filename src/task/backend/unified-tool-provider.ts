/**
 * Unified Task Tool Provider
 *
 * Single tool provider for all task backends. Provides:
 * - Core CRUD tools (always available): create_task, get_task, list_tasks, assign_task
 * - OpenTasks graph tools (when client available): task, link, annotate
 *
 * Replaces the separate InMemoryTaskToolProvider and OpenTasksTaskToolProvider.
 *
 * @module task/backend/unified-tool-provider
 */

import type { AgentId } from "../../store/types/index.js";
import type {
  TaskBackend,
  TaskToolProvider,
  MCPToolDefinition,
  TaskFilter,
  TaskStatus,
} from "./types.js";
import type { OpenTasksClient } from "./opentasks/client.js";

// =============================================================================
// Types
// =============================================================================

/**
 * Context needed for tool execution
 */
export interface ToolContext {
  /** The agent making the tool call */
  agent_id: AgentId;
}

/**
 * Factory function type for getting context
 */
export type GetToolContext = () => ToolContext;

// =============================================================================
// UnifiedTaskToolProvider
// =============================================================================

/**
 * UnifiedTaskToolProvider
 *
 * Provides MCP tools for task operations, backed by:
 * - TaskBackend for core CRUD (create_task, get_task, list_tasks, assign_task)
 * - OpenTasksClient (optional) for graph operations (task, link, annotate)
 */
export class UnifiedTaskToolProvider implements TaskToolProvider {
  constructor(
    private readonly backend: TaskBackend,
    private readonly getContext: GetToolContext,
    private readonly openTasksClient?: OpenTasksClient
  ) {}

  getTools(): MCPToolDefinition[] {
    const tools: MCPToolDefinition[] = [
      this.createTaskTool(),
      this.getTaskTool(),
      this.listTasksTool(),
      this.assignTaskTool(),
    ];

    if (this.openTasksClient) {
      tools.push(
        this.taskTool(),
        this.linkTool(),
        this.annotateTool(),
        this.listProvidersTool()
      );
    }

    return tools;
  }

  /**
   * Exclude the built-in create_task and get_task from mcp-server.ts
   * since this provider replaces them.
   */
  getExcludedTools(): string[] {
    return ["create_task", "get_task"];
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Core CRUD Tools (backed by TaskBackend)
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
          tags: {
            type: "array",
            items: { type: "string" },
            description: "Tags for categorization",
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
          external_id: task.external_id,
          source_location: task.source_location,
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
    const client = this.openTasksClient;
    return {
      name: "list_tasks",
      description:
        "List tasks with optional filtering. Use federated=true to include " +
        "tasks from connected project locations (requires opentasks backend).",
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
          federated: {
            type: "boolean",
            description:
              "Include tasks from connected project locations (default: false). " +
              "Queries the opentasks daemon for ready tasks across all connected projects.",
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
          federated?: boolean;
        };

        const filter: TaskFilter = {};
        if (args.status) filter.status = args.status;
        if (args.assigned_agent) filter.assigned_agent = args.assigned_agent;
        if (args.parent_task) filter.parent_task = args.parent_task;
        if (args.root_only) filter.rootTasksOnly = true;
        if (args.include_blocked !== undefined)
          filter.includeBlocked = args.include_blocked;

        // Local tasks from EventStore
        const localTasks = await this.backend.list(filter);
        const localTaskItems = localTasks.map((t) => ({
          id: t.id,
          description: t.description,
          status: t.status,
          isBlocked: t.isBlocked,
          external_id: t.external_id,
          assigned_agent: t.assigned_agent,
          parent_task: t.parent_task,
          source_location: t.source_location,
        }));

        // If federated requested and client available, also query daemon
        if (args.federated && client) {
          try {
            const result = await client.taskReady({
              tags: filter.tags,
              assignee: args.assigned_agent,
            });
            if (result.success && result.data) {
              const readyData = result.data as { type: string; items: Array<{ id: string; type: string; title: string; status?: string; priority?: number; archived: boolean }>; total: number };
              // Collect external IDs we already know about
              const knownExternalIds = new Set(
                localTaskItems
                  .map((t) => t.external_id)
                  .filter(Boolean)
              );
              // Add federated items not already in local list
              for (const item of readyData.items ?? []) {
                if (!knownExternalIds.has(item.id)) {
                  localTaskItems.push({
                    id: item.id,
                    description: item.title,
                    status: (item.status ?? "pending") as TaskStatus,
                    isBlocked: false,
                    external_id: item.id,
                    assigned_agent: undefined,
                    parent_task: undefined,
                    source_location: "federated",
                  });
                }
              }
            }
          } catch {
            // Non-fatal — federated query failed, return local results only
          }
        }

        return {
          tasks: localTaskItems,
          total: localTaskItems.length,
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

  // ─────────────────────────────────────────────────────────────────────────────
  // OpenTasks Graph Tools (require OpenTasksClient)
  // ─────────────────────────────────────────────────────────────────────────────

  private taskTool(): MCPToolDefinition {
    const client = this.openTasksClient!;
    const getContext = this.getContext;
    return {
      name: "task",
      description:
        "Provider-agnostic task lifecycle operations. Routes to the correct " +
        "provider based on task ID or URI. " +
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
                description: "Task ID or provider URI",
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
            description:
              "Get tasks ready to work on (no active blockers), federated across providers",
            properties: {
              providers: {
                type: "array",
                items: { type: "string" },
                description: "Only query these providers. Omit for all.",
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
          const result = await client.taskTransition(
            args.transition.id,
            args.transition.action as
              | "start"
              | "complete"
              | "block"
              | "reopen"
              | "close"
          );
          if (!result.success) {
            throw new Error(result.error ?? "Transition failed");
          }

          // Sync the transition back to the EventStore so MAP events are emitted
          // and the TUI task board stays in sync. The opentasks daemon already
          // processed the transition, so syncExternalTransition only updates the
          // EventStore without re-syncing to opentasks.
          if (this.backend.syncExternalTransition) {
            try {
              await this.backend.syncExternalTransition(
                args.transition.id,
                args.transition.action,
                getContext().agent_id,
              );
            } catch (err) {
              console.warn(
                `[UnifiedTaskToolProvider] syncExternalTransition failed for ${args.transition.id}: ${err}`
              );
            }
          }

          return result.data;
        }

        if (args.ready !== undefined) {
          const result = await client.taskReady(args.ready);
          if (!result.success) {
            throw new Error(result.error ?? "Ready query failed");
          }
          return result.data;
        }

        if (args.assign) {
          const assignee = args.assign.assignee ?? getContext().agent_id;
          const result = await client.taskAssign(args.assign.id, assignee);
          if (!result.success) {
            throw new Error(result.error ?? "Assignment failed");
          }

          // Sync assignment back to EventStore
          if (this.backend.syncExternalTransition) {
            try {
              await this.backend.syncExternalTransition(
                args.assign.id,
                "assign",
                assignee,
              );
            } catch (err) {
              console.warn(
                `[UnifiedTaskToolProvider] syncExternalTransition (assign) failed for ${args.assign.id}: ${err}`
              );
            }
          }

          return result.data;
        }

        if (args.validActions) {
          const result = await client.taskValidActions(args.validActions.id);
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

  private linkTool(): MCPToolDefinition {
    const client = this.openTasksClient!;
    return {
      name: "link",
      description:
        "Create or remove a relationship between nodes. " +
        "Supports cross-project references via opentasks:// URIs " +
        "(e.g., opentasks://<location-hash>/i-xxxx). " +
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
          await client.removeEdge(args.from_id, args.to_id, args.type);
          return {
            from_id: args.from_id,
            to_id: args.to_id,
            type: args.type,
            removed: true,
          };
        }

        const edge = await client.createEdge(
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
    const client = this.openTasksClient!;
    const getContext = this.getContext;
    return {
      name: "annotate",
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
          content: {
            type: "string",
            description:
              "Feedback content (markdown). Required for new feedback.",
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
            description:
              "Issue providing the feedback (creates discovered-from link)",
          },
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

        if (args.content) {
          // Create new feedback node
          const feedbackNode = await client.createIssue({
            title: args.content.slice(0, 100),
            content: args.content,
            metadata: {
              _node_type: "feedback",
              target_id: args.target_id,
              feedback_type: args.feedback_type ?? "comment",
              from_id: args.from_id,
              anchor_line: args.line,
              anchor_text: args.text,
              _created_by_agent: getContext().agent_id,
            },
          });

          // Link feedback to target
          if (args.from_id) {
            await client.createEdge(
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
          await client.updateIssue(args.resolve, {
            metadata: { resolved: true, resolved_at: new Date().toISOString() },
          });
          return { feedback_id: args.resolve, resolved: true };
        }

        if (args.dismiss) {
          await client.updateIssue(args.dismiss, {
            metadata: {
              dismissed: true,
              dismissed_at: new Date().toISOString(),
            },
          });
          return { feedback_id: args.dismiss, dismissed: true };
        }

        if (args.reopen) {
          await client.updateIssue(args.reopen, {
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

  private listProvidersTool(): MCPToolDefinition {
    const client = this.openTasksClient!;
    return {
      name: "list_providers",
      description:
        "List all registered providers and their capabilities. " +
        "Shows what task systems are connected (native opentasks, external integrations) " +
        "and what operations each supports.",
      schema: {
        type: "object",
        properties: {},
      },
      handler: async () => {
        const providers = await client.listProviders();
        return {
          providers: providers.map((p) => ({
            name: p.name,
            schemes: p.schemes,
            is_default: p.isDefault,
            capabilities: p.capabilities,
            task_capabilities: p.taskCapabilities
              ? {
                  actions: p.taskCapabilities.actions,
                  supports_assignment: p.taskCapabilities.supportsAssignment,
                  supports_ready_query: p.taskCapabilities.supportsReadyQuery,
                  status_model: p.taskCapabilities.statusModel,
                }
              : undefined,
          })),
          total: providers.length,
        };
      },
    };
  }
}

// =============================================================================
// Factory
// =============================================================================

/**
 * Create a UnifiedTaskToolProvider
 */
export function createUnifiedToolProvider(
  backend: TaskBackend,
  getContext: GetToolContext,
  openTasksClient?: OpenTasksClient
): UnifiedTaskToolProvider {
  return new UnifiedTaskToolProvider(backend, getContext, openTasksClient);
}
