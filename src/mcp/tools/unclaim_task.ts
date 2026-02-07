/**
 * unclaim_task() MCP Tool
 *
 * Allows agents with `task.claim` capability to release a claimed task
 * back to the pending pool.
 *
 * @module mcp/tools/unclaim_task
 */

import { z } from "zod";
import type { TaskBackend } from "../../task/backend/types.js";
import type { ToolContext } from "../types.js";

// =============================================================================
// Schema
// =============================================================================

export const UnclaimTaskSchema = {
  task_id: z.string().describe("ID of the task to unclaim"),
};

// =============================================================================
// Handler
// =============================================================================

export interface UnclaimTaskDeps {
  taskBackend: TaskBackend;
}

export function createUnclaimTaskHandler(
  _context: ToolContext,
  deps: UnclaimTaskDeps
) {
  return async (args: {
    task_id: string;
  }): Promise<{
    success: boolean;
    message: string;
  }> => {
    if (!deps.taskBackend.unclaim) {
      return {
        success: false,
        message: "Task backend does not support unclaim operations",
      };
    }

    try {
      await deps.taskBackend.unclaim(args.task_id);
      return {
        success: true,
        message: `Task ${args.task_id} unclaimed and returned to pending pool`,
      };
    } catch (error) {
      return {
        success: false,
        message: `Failed to unclaim task: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  };
}

// =============================================================================
// Tool Info
// =============================================================================

export const UNCLAIM_TASK_TOOL_INFO = {
  name: "unclaim_task",
  description:
    "Release a claimed task back to the pending pool so another agent can pick it up. Requires task.claim capability.",
  schema: UnclaimTaskSchema,
};
