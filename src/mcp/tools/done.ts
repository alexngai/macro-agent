/**
 * done() MCP Tool
 *
 * Allows agents with `lifecycle.done` capability to signal completion
 * and trigger role-appropriate cleanup.
 *
 * @module mcp/tools/done
 * @see s-32xs Self-Cleaning Workers spec
 */

import { z } from "zod";
import type { EventStore } from "../../store/event-store.js";
import type { AgentManager } from "../../agent/agent-manager.js";
import type { MessageRouter } from "../../router/message-router.js";
import type { TaskManager } from "../../task/task-manager.js";
import type { ToolContext } from "../types.js";
import type { DoneArgs, DoneResult, LifecycleContext } from "../../lifecycle/types.js";
import { detectCleanupStatus } from "../../lifecycle/cleanup.js";
import { dispatchDone, type AllHandlerDeps } from "../../lifecycle/handlers/index.js";

// =============================================================================
// Schema Definition
// =============================================================================

/**
 * Zod schema for done() tool input
 */
export const DoneSchema = {
  status: z
    .enum(["completed", "failed", "blocked", "deferred"])
    .describe("Completion status of the agent's work"),
  summary: z
    .string()
    .optional()
    .describe("Summary of work completed or reason for status"),
  details: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Additional structured details"),
  task_id: z
    .string()
    .optional()
    .describe("Task ID to update (defaults to agent's bound task)"),
};

// =============================================================================
// Tool Dependencies
// =============================================================================

/**
 * Dependencies for the done() tool
 */
export interface DoneToolDeps {
  eventStore: EventStore;
  agentManager: AgentManager;
  messageRouter: MessageRouter;
  taskManager: TaskManager;
  workspaceManager?: {
    /** Get workspace for an agent */
    getWorkspace(agentId: string): { integrationBranch?: string } | undefined;
  };
}

// =============================================================================
// Capability Check
// =============================================================================

/**
 * Check if an agent has the lifecycle.done capability
 */
export function hasLifecycleDoneCapability(
  eventStore: EventStore,
  agentId: string
): { hasCapability: boolean; role: string } {
  // Get the agent to find their role
  const agent = eventStore.getAgent(agentId);
  if (!agent) {
    return { hasCapability: false, role: "unknown" };
  }

  // Get the agent's role (set at spawn time) or default to "worker"
  // In the future, this should query the RoleRegistry for full capability lookup
  const role = agent.role ?? "worker";

  // Check if the role has lifecycle.done capability
  // For now, we check based on known roles that have this capability
  // In the future, this should query the RoleRegistry
  const rolesWithDoneCapability = new Set([
    "worker",
    "worker.resolver",
    "integrator",
    "monitor",
  ]);

  // Check exact match or prefix match
  const hasCapability =
    rolesWithDoneCapability.has(role) ||
    rolesWithDoneCapability.has(role.split(".")[0]);

  return { hasCapability, role };
}

// =============================================================================
// Build Lifecycle Context
// =============================================================================

/**
 * Build the lifecycle context for a done() call
 */
export function buildLifecycleContext(
  toolContext: ToolContext,
  eventStore: EventStore,
  role: string,
  workspaceManager?: DoneToolDeps["workspaceManager"]
): LifecycleContext {
  const agent = eventStore.getAgent(toolContext.agent_id);

  // Try to get integration branch from workspace manager
  let integrationBranch: string | undefined;
  if (workspaceManager) {
    const workspace = workspaceManager.getWorkspace(toolContext.agent_id);
    integrationBranch = workspace?.integrationBranch;
  }

  return {
    agentId: toolContext.agent_id,
    role,
    taskId: toolContext.task_id,
    parentId: agent?.parent ?? undefined,
    workspacePath: toolContext.cwd,
    branch: undefined, // Will be detected from workspace if needed
    integrationBranch,
  };
}

// =============================================================================
// Tool Handler
// =============================================================================

/**
 * Create the done() tool handler
 */
export function createDoneHandler(context: ToolContext, deps: DoneToolDeps) {
  return async (args: {
    status: "completed" | "failed" | "blocked" | "deferred";
    summary?: string;
    details?: Record<string, unknown>;
    task_id?: string;
  }): Promise<DoneResult> => {
    const { eventStore, agentManager, messageRouter, taskManager, workspaceManager } = deps;

    // ─────────────────────────────────────────────────────────────────────────
    // Step 1: Check capability
    // ─────────────────────────────────────────────────────────────────────────

    const { hasCapability, role } = hasLifecycleDoneCapability(
      eventStore,
      context.agent_id
    );

    if (!hasCapability) {
      return {
        success: false,
        shouldTerminate: false,
        status: args.status,
        cleanupStatus: { ready: false, reason: "Capability check failed" },
        error: `Agent ${context.agent_id} does not have lifecycle.done capability (role: ${role})`,
      };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Step 2: Build context and detect cleanup status
    // ─────────────────────────────────────────────────────────────────────────

    const lifecycleContext = buildLifecycleContext(
      context,
      eventStore,
      role,
      workspaceManager
    );

    const cleanupStatus = detectCleanupStatus(lifecycleContext, {
      messageRouter,
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Step 3: Update task status via TaskManager
    // ─────────────────────────────────────────────────────────────────────────

    const taskId = args.task_id ?? context.task_id;
    if (taskId) {
      try {
        const taskStatus =
          args.status === "completed"
            ? "completed"
            : args.status === "failed"
              ? "failed"
              : "in_progress";
        taskManager.updateStatus(taskId, taskStatus);
      } catch {
        // Task may not exist - continue anyway
      }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Step 4: Emit status via MessageRouter (for compatibility with emit_status)
    // ─────────────────────────────────────────────────────────────────────────

    try {
      messageRouter.emitStatus({
        from: { agent_id: context.agent_id },
        status_type:
          args.status === "completed"
            ? "completed"
            : args.status === "failed"
              ? "failed"
              : "checkpoint",
        summary: args.summary ?? `Agent done with status: ${args.status}`,
        details: args.details,
      });
    } catch {
      // Continue even if emit fails
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Step 5: Dispatch to role-specific handler
    // ─────────────────────────────────────────────────────────────────────────

    const doneArgs: DoneArgs = {
      status: args.status,
      summary: args.summary,
      details: args.details,
      taskId,
    };

    const handlerDeps: AllHandlerDeps = {
      messageRouter,
      agentManager,
    };

    const handlerResult = await dispatchDone(
      lifecycleContext,
      doneArgs,
      cleanupStatus,
      handlerDeps
    );

    // ─────────────────────────────────────────────────────────────────────────
    // Step 6: Return result
    // ─────────────────────────────────────────────────────────────────────────

    return {
      success: true,
      shouldTerminate: handlerResult.shouldTerminate,
      status: args.status,
      cleanupStatus,
      warnings: handlerResult.warnings,
    };
  };
}

// =============================================================================
// Tool Registration Helper
// =============================================================================

/**
 * Tool registration info for use with MCP server
 */
export const DONE_TOOL_INFO = {
  name: "done",
  description:
    "Signal that the agent has completed its work. Triggers role-appropriate cleanup and termination. Requires lifecycle.done capability.",
  schema: DoneSchema,
};
