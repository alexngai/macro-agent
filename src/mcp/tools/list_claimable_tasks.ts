/**
 * list_claimable_tasks() MCP Tool
 *
 * Lists tasks available for claiming. Allows agents to preview
 * what's in the task pool before claiming.
 *
 * @module mcp/tools/list_claimable_tasks
 */

import { z } from "zod";
import type { TaskBackend, ClaimFilter, ExtendedTask } from "../../task/backend/types.js";
import type { ToolContext } from "../types.js";

// =============================================================================
// Schema
// =============================================================================

export const ListClaimableTasksSchema = {
  tags: z
    .array(z.string())
    .optional()
    .describe("Only list tasks with at least one matching tag"),
  root_tasks_only: z
    .boolean()
    .optional()
    .describe("Only list root tasks (no parent)"),
  limit: z
    .number()
    .optional()
    .describe("Maximum number of tasks to return (default: 20)"),
};

// =============================================================================
// Handler
// =============================================================================

export interface ListClaimableTasksDeps {
  taskBackend: TaskBackend;
}

export function createListClaimableTasksHandler(
  _context: ToolContext,
  deps: ListClaimableTasksDeps
) {
  return async (args: {
    tags?: string[];
    root_tasks_only?: boolean;
    limit?: number;
  }): Promise<{
    tasks: ExtendedTask[];
    count: number;
    message: string;
  }> => {
    if (!deps.taskBackend.listClaimable) {
      return {
        tasks: [],
        count: 0,
        message: "Task backend does not support listClaimable operations",
      };
    }

    const filter: ClaimFilter = {};
    if (args.tags) filter.tags = args.tags;
    if (args.root_tasks_only) filter.rootTasksOnly = args.root_tasks_only;

    let tasks = await deps.taskBackend.listClaimable(filter);

    const limit = args.limit ?? 20;
    if (tasks.length > limit) {
      tasks = tasks.slice(0, limit);
    }

    return {
      tasks,
      count: tasks.length,
      message:
        tasks.length > 0
          ? `Found ${tasks.length} claimable task(s)`
          : "No claimable tasks available",
    };
  };
}

// =============================================================================
// Tool Info
// =============================================================================

export const LIST_CLAIMABLE_TASKS_TOOL_INFO = {
  name: "list_claimable_tasks",
  description:
    "List tasks available for claiming. Shows pending, unblocked, unassigned tasks. Requires task.claim capability.",
  schema: ListClaimableTasksSchema,
};
