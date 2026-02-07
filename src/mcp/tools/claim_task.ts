/**
 * claim_task() MCP Tool
 *
 * Allows agents with `task.claim` capability to claim the next available task.
 * Used in the pull model where agents autonomously pick up work.
 *
 * @module mcp/tools/claim_task
 */

import { z } from "zod";
import type { TaskBackend, ClaimFilter, ExtendedTask } from "../../task/backend/types.js";
import type { ToolContext } from "../types.js";

// =============================================================================
// Schema
// =============================================================================

export const ClaimTaskSchema = {
  tags: z
    .array(z.string())
    .optional()
    .describe("Only claim tasks with at least one matching tag"),
  root_tasks_only: z
    .boolean()
    .optional()
    .describe("Only claim root tasks (no parent)"),
};

// =============================================================================
// Handler
// =============================================================================

export interface ClaimTaskDeps {
  taskBackend: TaskBackend;
}

export function createClaimTaskHandler(
  context: ToolContext,
  deps: ClaimTaskDeps
) {
  return async (args: {
    tags?: string[];
    root_tasks_only?: boolean;
  }): Promise<{
    claimed: boolean;
    task?: ExtendedTask;
    message: string;
  }> => {
    if (!deps.taskBackend.claim) {
      return {
        claimed: false,
        message: "Task backend does not support claim operations",
      };
    }

    const filter: ClaimFilter = {};
    if (args.tags) filter.tags = args.tags;
    if (args.root_tasks_only) filter.rootTasksOnly = args.root_tasks_only;

    const task = await deps.taskBackend.claim(context.agent_id, filter);

    if (!task) {
      return {
        claimed: false,
        message: "No claimable tasks available",
      };
    }

    return {
      claimed: true,
      task,
      message: `Claimed task ${task.id}: ${task.description}`,
    };
  };
}

// =============================================================================
// Tool Info
// =============================================================================

export const CLAIM_TASK_TOOL_INFO = {
  name: "claim_task",
  description:
    "Claim the next available task from the task pool. Returns the claimed task or null if none available. Requires task.claim capability.",
  schema: ClaimTaskSchema,
};
