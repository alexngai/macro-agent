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
    getWorkspace(agentId: string): {
      integrationBranch?: string;
      path?: string;
      streamId?: string;
    } | null;
    /** Get merge queue for coordinating worker merges */
    getMergeQueue?(): AllHandlerDeps["mergeQueue"];
  };
  /** Optional RoleRegistry for capability-based done() checks */
  roleRegistry?: import("../../roles/types.js").RoleRegistry;
  /** Optional MailService for recording completion turns */
  mailService?: import("../../mail/mail-service.js").MailService;
  /** Optional ConversationMap for agent-to-conversation lookup */
  conversationMap?: import("../../mail/conversation-map.js").ConversationMap;
  /** Optional integration strategy (from team config) */
  integrationStrategy?: import("../../workspace/strategies/types.js").IntegrationStrategy;
  /** Optional task mode from team config */
  taskMode?: "push" | "pull";
}

// =============================================================================
// Capability Check
// =============================================================================

/**
 * Check if an agent has the lifecycle.done capability.
 *
 * Uses RoleRegistry for capability resolution, supporting both built-in
 * roles and team-defined roles that extend them.
 */
export function hasLifecycleDoneCapability(
  eventStore: EventStore,
  agentId: string,
  roleRegistry?: import("../../roles/types.js").RoleRegistry
): { hasCapability: boolean; role: string } {
  // Get the agent to find their role
  const agent = eventStore.getAgent(agentId);
  const role = agent?.role ?? "worker";

  // Use RoleRegistry for capability lookup when available
  if (roleRegistry) {
    const hasCapability = roleRegistry.hasCapability(role, "lifecycle.done");
    return { hasCapability, role };
  }

  // Fallback: check base role via prefix match against known built-in roles
  const rolesWithDoneCapability = new Set([
    "worker",
    "worker.resolver",
    "integrator",
    "monitor",
  ]);

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

  // Try to get workspace info from workspace manager
  let integrationBranch: string | undefined;
  let workspacePath: string | undefined;
  let streamId: string | undefined;
  if (workspaceManager) {
    const workspace = workspaceManager.getWorkspace(toolContext.agent_id);
    integrationBranch = workspace?.integrationBranch;
    workspacePath = workspace?.path;
    streamId = workspace?.streamId;
  }

  // Fallback: read streamId from env var (set by buildMacroAgentMcp during spawn).
  // WorkspaceManager is not available in MCP subprocesses, but the streamId is
  // needed for MERGE_REQUEST signal details so the team runtime can submit to the merge queue.
  if (!streamId && process.env.MACRO_STREAM_ID) {
    streamId = process.env.MACRO_STREAM_ID;
  }

  return {
    agentId: toolContext.agent_id,
    role,
    taskId: toolContext.task_id,
    parentId: agent?.parent ?? undefined,
    workspacePath: workspacePath ?? toolContext.cwd,
    branch: undefined, // Will be detected from workspace if needed
    integrationBranch,
    streamId,
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
    const { eventStore, agentManager, messageRouter, taskManager, workspaceManager, roleRegistry, mailService, conversationMap } = deps;

    // ─────────────────────────────────────────────────────────────────────────
    // Step 1: Check capability
    // ─────────────────────────────────────────────────────────────────────────

    const { hasCapability, role } = hasLifecycleDoneCapability(
      eventStore,
      context.agent_id,
      roleRegistry
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

    // Resolve capabilities for capability-based handler dispatch (team roles)
    if (roleRegistry) {
      try {
        const resolvedRole = roleRegistry.resolveRole(role);
        if (resolvedRole?.capabilities) {
          lifecycleContext.capabilities = [...resolvedRole.capabilities];
        }
      } catch {
        // Role not in registry — capabilities stay undefined
      }
    }

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
      // Persist immediately so the parent process can detect done() via EventStore reload.
      // MCP subprocesses run with disableAutoSave to prevent cross-process data corruption,
      // so this explicit persist is required for the status event to reach the parent.
      await eventStore.persist();
    } catch {
      // Continue even if emit fails
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Step 4b: Record completion turn and close conversation (Mail)
    // ─────────────────────────────────────────────────────────────────────────
    if (mailService && conversationMap) {
      try {
        const convId = conversationMap.getAgentConversation(context.agent_id);
        if (convId) {
          // Record completion turn
          mailService.recordTurn({
            conversationId: convId,
            participant: context.agent_id,
            contentType: "event",
            content: {
              event: `agent.${args.status}`,
              summary: args.summary,
              details: args.details,
            },
          });

          // Close the conversation
          mailService.closeConversation({
            conversationId: convId,
            closedBy: context.agent_id,
            reason: args.status,
          });
        }
      } catch {
        // Never fail done() due to mail errors
      }
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
      mergeQueue: workspaceManager?.getMergeQueue?.(),
      getWorkspacePath: workspaceManager
        ? (agentId: string) => workspaceManager.getWorkspace(agentId)?.path
        : undefined,
      integrationStrategy: deps.integrationStrategy,
      taskMode: deps.taskMode,
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
