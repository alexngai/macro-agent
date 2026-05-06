/**
 * done() MCP Tool V2
 *
 * Simplified version that uses InboxAdapter + TasksAdapter instead of
 * EventStore + MessageRouter + TaskManager.
 *
 * @module mcp/tools/done-v2
 */

import { z } from "zod";
import type { InboxAdapter, TasksAdapter } from "../../adapters/types.js";
import type { AgentManager } from "../../agent/agent-manager.js";
import type { AgentStore } from "../../agent/agent-store.js";
import type { RoleRegistry } from "../../roles/types.js";
import type { ToolContext } from "../types.js";
import type { DoneResult, LifecycleContext } from "../../lifecycle/types.js";
import { detectCleanupStatus } from "../../lifecycle/cleanup.js";
import { dispatchDoneV2, type HandlerDepsV2 } from "../../lifecycle/handlers-v2.js";

// =============================================================================
// Schema (unchanged from V1)
// =============================================================================

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
// Dependencies
// =============================================================================

export interface DoneToolDepsV2 {
  agentStore: AgentStore;
  agentManager: AgentManager;
  inboxAdapter: InboxAdapter;
  tasksAdapter: TasksAdapter;
  roleRegistry?: RoleRegistry;
  taskMode?: "push" | "pull";
  mergeQueue?: import("../../workspace/merge-queue/types.js").MergeQueueInterface;
}

// =============================================================================
// Capability Check
// =============================================================================

function hasLifecycleDoneCapability(
  agentStore: AgentStore,
  agentId: string,
  roleRegistry?: RoleRegistry
): { hasCapability: boolean; role: string } {
  const record = agentStore.getAgent(agentId);
  if (!record) {
    return { hasCapability: false, role: "unknown" };
  }

  const role = record.role ?? "worker";

  if (roleRegistry) {
    return {
      hasCapability: roleRegistry.hasCapability(role, "lifecycle.done"),
      role,
    };
  }

  // Fallback
  const rolesWithDone = new Set(["worker", "integrator", "monitor"]);
  return {
    hasCapability:
      rolesWithDone.has(role) || rolesWithDone.has(role.split(".")[0]),
    role,
  };
}

// =============================================================================
// Build Lifecycle Context
// =============================================================================

function buildLifecycleContext(
  toolContext: ToolContext,
  agentStore: AgentStore,
  role: string,
  roleRegistry?: RoleRegistry
): LifecycleContext {
  const record = agentStore.getAgent(toolContext.agent_id);

  const ctx: LifecycleContext = {
    agentId: toolContext.agent_id,
    role,
    taskId: toolContext.task_id,
    parentId: record?.parent_id ?? undefined,
    workspacePath: record?.workspace_path ?? toolContext.cwd,
    streamId: record?.workspace_stream_id ?? process.env.MACRO_STREAM_ID,
  };

  // Pull task_ref out of agent metadata if it was stashed there at spawn
  // time. Validates the shape — bad data is silently dropped rather than
  // pushed downstream into cascade payloads.
  const meta = record?.metadata as Record<string, unknown> | undefined;
  const tr = meta?.task_ref as { resource_id?: unknown; node_id?: unknown } | undefined;
  if (tr && typeof tr.resource_id === "string" && typeof tr.node_id === "string") {
    ctx.taskRef = { resource_id: tr.resource_id, node_id: tr.node_id };
  }

  // Resolve capabilities for dispatch
  if (roleRegistry) {
    try {
      const resolvedRole = roleRegistry.resolveRole(role);
      if (resolvedRole?.capabilities) {
        ctx.capabilities = [...resolvedRole.capabilities];
      }
    } catch {
      // Role not in registry
    }
  }

  return ctx;
}

// =============================================================================
// Tool Handler
// =============================================================================

export function createDoneHandlerV2(
  context: ToolContext,
  deps: DoneToolDepsV2
) {
  return async (args: {
    status: "completed" | "failed" | "blocked" | "deferred";
    summary?: string;
    details?: Record<string, unknown>;
    task_id?: string;
  }): Promise<DoneResult> => {
    const { agentStore, agentManager, inboxAdapter, tasksAdapter, roleRegistry } = deps;

    // Step 1: Check capability
    const { hasCapability, role } = hasLifecycleDoneCapability(
      agentStore,
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

    // Step 2: Build context and detect cleanup status
    const lifecycleContext = buildLifecycleContext(
      context,
      agentStore,
      role,
      roleRegistry
    );

    const cleanupStatus = detectCleanupStatus(lifecycleContext);

    // Step 3: Dispatch to V2 handler
    const handlerDeps: HandlerDepsV2 = {
      inboxAdapter,
      tasksAdapter,
      agentManager,
      agentStore,
      taskMode: deps.taskMode,
      mergeQueue: deps.mergeQueue,
    };

    const handlerResult = await dispatchDoneV2(
      lifecycleContext,
      {
        status: args.status,
        summary: args.summary,
        details: args.details,
        taskId: args.task_id ?? context.task_id,
      },
      cleanupStatus,
      handlerDeps
    );

    return {
      success: true,
      shouldTerminate: handlerResult.shouldTerminate,
      status: args.status,
      cleanupStatus,
      warnings: handlerResult.warnings,
    };
  };
}

export const DONE_TOOL_INFO = {
  name: "done",
  description:
    "Signal that the agent has completed its work. Triggers role-appropriate cleanup and termination.",
  schema: DoneSchema,
};
