/**
 * Task Extension Methods (_macro/task/*)
 *
 * Exposes macro-agent's task management features to external MAP clients.
 *
 * Methods:
 * - _macro/task/list - List tasks with filters
 * - _macro/task/get - Get task details
 * - _macro/task/create - Create new task
 * - _macro/task/assign - Assign task to agent
 * - _macro/task/complete - Mark task completed
 * - _macro/task/send - Send message to task's assigned agent
 *
 * @see specs/s-5qir_map_integration_for_macro_agent.md
 */

import type { MAPAdapter, ExtensionHandler, ExtensionContext } from "../interface.js";
import type {
  TaskBackend,
  ExtendedTask,
  TaskFilter,
  CreateTaskOptions,
  TaskOutputs,
} from "../../../task/backend/types.js";
import type { AgentId, TaskId } from "../../../store/types/index.js";
import type { Address } from "../../types.js";
import { RPCError } from "../rpc-handler.js";

// =============================================================================
// Error Codes
// =============================================================================

const TASK_NOT_FOUND = -32020;

// =============================================================================
// Request/Response Types
// =============================================================================

interface ListTasksParams {
  filter?: {
    status?: string | string[];
    assignedAgent?: string;
    parentTask?: string;
    createdBy?: string;
    rootTasksOnly?: boolean;
    includeBlocked?: boolean;
  };
}

interface GetTaskParams {
  taskId: string;
}

interface CreateTaskParams {
  description: string;
  parentTask?: string;
  externalId?: string;
}

interface AssignTaskParams {
  taskId: string;
  agentId: string;
  role?: string;
  leaseMs?: number;
}

interface CompleteTaskParams {
  taskId: string;
  outputs?: {
    summary?: string;
    data?: Record<string, unknown>;
  };
}

interface SendToTaskParams {
  taskId: string;
  content: unknown;
  priority?: "low" | "normal" | "high" | "urgent";
}

// =============================================================================
// Response Types
// =============================================================================

interface TaskInfo {
  id: string;
  description: string;
  status: string;
  assignedAgent?: string;
  createdBy: string;
  createdAt: number;
  parentTask?: string;
  isBlocked?: boolean;
  externalId?: string;
}

function taskToInfo(task: ExtendedTask): TaskInfo {
  return {
    id: task.id,
    description: task.description,
    status: task.status,
    assignedAgent: task.assigned_agent,
    createdBy: task.created_by,
    createdAt: task.created_at,
    parentTask: task.parent_task,
    isBlocked: task.isBlocked,
    externalId: task.external_id,
  };
}

// =============================================================================
// Extension Services
// =============================================================================

export interface TaskExtensionServices {
  taskBackend: TaskBackend;
  sendMessage: (
    from: string,
    to: Address,
    content: unknown,
    options?: { priority?: string }
  ) => Promise<{ delivered: string[] }>;
}

// =============================================================================
// Handler Implementations
// =============================================================================

function createListHandler(services: TaskExtensionServices): ExtensionHandler {
  return async (_context: ExtensionContext, params: unknown) => {
    const { filter } = (params ?? {}) as ListTasksParams;

    const taskFilter: TaskFilter | undefined = filter
      ? {
          status: filter.status as TaskFilter["status"],
          assigned_agent: filter.assignedAgent as AgentId | undefined,
          parent_task: filter.parentTask as TaskId | undefined,
          created_by: filter.createdBy as AgentId | undefined,
          rootTasksOnly: filter.rootTasksOnly,
          includeBlocked: filter.includeBlocked,
        }
      : undefined;

    const tasks = await services.taskBackend.list(taskFilter);
    return { tasks: tasks.map(taskToInfo) };
  };
}

function createGetHandler(services: TaskExtensionServices): ExtensionHandler {
  return async (_context: ExtensionContext, params: unknown) => {
    const { taskId } = params as GetTaskParams;

    if (!taskId) {
      throw RPCError.invalidParams("taskId is required");
    }

    const task = await services.taskBackend.get(taskId as TaskId);
    if (!task) {
      throw new RPCError(TASK_NOT_FOUND, `Task not found: ${taskId}`);
    }

    return { task: taskToInfo(task) };
  };
}

function createCreateHandler(services: TaskExtensionServices): ExtensionHandler {
  return async (context: ExtensionContext, params: unknown) => {
    const { description, parentTask, externalId } = params as CreateTaskParams;

    if (!description) {
      throw RPCError.invalidParams("description is required");
    }

    // Use participant ID as creator (external client)
    const createdBy = `external:${context.participantId}` as AgentId;

    const options: CreateTaskOptions = {
      description,
      created_by: createdBy,
      parent_task: parentTask as TaskId | undefined,
      external_id: externalId,
    };

    const task = await services.taskBackend.create(options);
    return { task: taskToInfo(task) };
  };
}

function createAssignHandler(services: TaskExtensionServices): ExtensionHandler {
  return async (_context: ExtensionContext, params: unknown) => {
    const { taskId, agentId, role, leaseMs } = params as AssignTaskParams;

    if (!taskId) {
      throw RPCError.invalidParams("taskId is required");
    }
    if (!agentId) {
      throw RPCError.invalidParams("agentId is required");
    }

    // Verify task exists
    const task = await services.taskBackend.get(taskId as TaskId);
    if (!task) {
      throw new RPCError(TASK_NOT_FOUND, `Task not found: ${taskId}`);
    }

    await services.taskBackend.assign(taskId as TaskId, agentId as AgentId, {
      role,
      leaseMs,
    });

    return { success: true };
  };
}

function createCompleteHandler(services: TaskExtensionServices): ExtensionHandler {
  return async (_context: ExtensionContext, params: unknown) => {
    const { taskId, outputs } = params as CompleteTaskParams;

    if (!taskId) {
      throw RPCError.invalidParams("taskId is required");
    }

    // Verify task exists
    const task = await services.taskBackend.get(taskId as TaskId);
    if (!task) {
      throw new RPCError(TASK_NOT_FOUND, `Task not found: ${taskId}`);
    }

    // Auto-transition through intermediate states if needed.
    // Valid path to "completed" requires in_progress status.
    // pending → assigned → in_progress → completed
    if (task.status === "pending" || task.status === "assigned") {
      if (task.status === "pending" && !task.assigned_agent) {
        // Assign to creator if not assigned yet
        await services.taskBackend.assign(taskId as TaskId, task.created_by, {});
      }
      await services.taskBackend.start(taskId as TaskId);
    }

    const taskOutputs: TaskOutputs | undefined = outputs
      ? {
          summary: outputs.summary,
          data: outputs.data,
        }
      : undefined;

    await services.taskBackend.complete(taskId as TaskId, taskOutputs);

    return { success: true };
  };
}

function createSendHandler(services: TaskExtensionServices): ExtensionHandler {
  return async (context: ExtensionContext, params: unknown) => {
    const { taskId, content, priority } = params as SendToTaskParams;

    if (!taskId) {
      throw RPCError.invalidParams("taskId is required");
    }
    if (content === undefined) {
      throw RPCError.invalidParams("content is required");
    }

    // Get task to find assigned agent
    const task = await services.taskBackend.get(taskId as TaskId);
    if (!task) {
      throw new RPCError(TASK_NOT_FOUND, `Task not found: ${taskId}`);
    }

    if (!task.assigned_agent) {
      throw RPCError.invalidParams(`Task ${taskId} has no assigned agent`);
    }

    // Route message to the assigned agent
    const from = `external:${context.participantId}`;
    const to: Address = { agent: task.assigned_agent };

    const result = await services.sendMessage(from, to, content, { priority });

    return {
      delivered: result.delivered,
      agentId: task.assigned_agent,
    };
  };
}

// =============================================================================
// Registration
// =============================================================================

/**
 * Register task extension methods with the MAPAdapter.
 *
 * @param adapter - MAPAdapter instance
 * @param services - Task extension services
 */
export function registerTaskExtensions(
  adapter: MAPAdapter,
  services: TaskExtensionServices
): void {
  // Query operations (require canQuery)
  adapter.registerExtension("_macro/task/list", createListHandler(services));
  adapter.registerExtension("_macro/task/get", createGetHandler(services));

  // Management operations (require canManageTasks)
  adapter.registerExtension("_macro/task/create", createCreateHandler(services));
  adapter.registerExtension("_macro/task/assign", createAssignHandler(services));
  adapter.registerExtension("_macro/task/complete", createCompleteHandler(services));

  // Messaging operation (require canMessage)
  adapter.registerExtension("_macro/task/send", createSendHandler(services));
}

/**
 * Unregister task extension methods.
 *
 * @param adapter - MAPAdapter instance
 */
export function unregisterTaskExtensions(adapter: MAPAdapter): void {
  adapter.unregisterExtension("_macro/task/list");
  adapter.unregisterExtension("_macro/task/get");
  adapter.unregisterExtension("_macro/task/create");
  adapter.unregisterExtension("_macro/task/assign");
  adapter.unregisterExtension("_macro/task/complete");
  adapter.unregisterExtension("_macro/task/send");
}
