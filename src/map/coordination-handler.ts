/**
 * Coordination Handler — dispatches inbound coordination messages from the MAP hub.
 *
 * Handles x-openhive/* JSON-RPC notifications for task assignment, status updates,
 * context sharing, messaging, and workspace execution.
 *
 * @module map/coordination-handler
 */

import type { AgentManager } from "../agent/agent-manager.js";
import type { InboxAdapter, TasksAdapter } from "../adapters/types.js";
import type {
  CoordinationTaskAssign,
  CoordinationTaskStatus,
  CoordinationContextShare,
  CoordinationMessage,
  TrajectoryReporter,
} from "./types.js";

export interface CoordinationConnection {
  onNotification(
    method: string,
    handler: (params: unknown) => void | Promise<void>,
  ): void;
  offNotification(
    method: string,
    handler: (params: unknown) => void | Promise<void>,
  ): void;
  sendNotification(method: string, params: unknown): Promise<void>;
}

export interface CoordinationDeps {
  connection: CoordinationConnection;
  agentManager: AgentManager;
  inboxAdapter: InboxAdapter;
  tasksAdapter: TasksAdapter;
  trajectoryReporter?: TrajectoryReporter;
  /** Workspace handler from cognitive module (if available) */
  workspaceHandler?: {
    handleWorkspaceExecute(params: unknown): Promise<void>;
    isWorkspaceExecuteMessage(msg: { method?: string }): boolean;
  };
}

/** Coordination method constants */
const METHODS = {
  TASK_ASSIGN: "x-openhive/task.assign",
  TASK_STATUS: "x-openhive/task.status",
  CONTEXT_SHARE: "x-openhive/context.share",
  MESSAGE_SEND: "x-openhive/message.send",
  WORKSPACE_EXECUTE: "x-openhive/learning.workspace.execute",
} as const;

/**
 * Register coordination notification handlers on the MAP connection.
 * Returns a cleanup function that removes all handlers.
 */
export function setupCoordinationHandlers(
  deps: CoordinationDeps,
): () => void {
  const { connection, agentManager, inboxAdapter, tasksAdapter } = deps;
  const handlers: Array<{ method: string; handler: (params: unknown) => void | Promise<void> }> = [];

  const register = (
    method: string,
    handler: (params: unknown) => void | Promise<void>,
  ): void => {
    connection.onNotification(method, handler);
    handlers.push({ method, handler });
  };

  // --- Task Assignment ---
  register(METHODS.TASK_ASSIGN, async (params: unknown) => {
    const p = params as CoordinationTaskAssign;
    if (!p?.title) return;

    try {
      // Extract tags and metadata from OpenHive context
      const context = p.context ?? {};
      const tags = Array.isArray(context.tags) ? context.tags as string[] : undefined;
      const metadata: Record<string, unknown> = {
        ...context,
        ...(p.assigned_by ? { assigned_by: p.assigned_by } : {}),
        ...(p.deadline ? { deadline: p.deadline } : {}),
      };
      // Remove tags from metadata (already a top-level field)
      delete metadata.tags;

      const taskId = await tasksAdapter.createTask({
        title: p.title,
        content: p.description,
        assignee: p.assigned_to,
        tags,
        priority: p.priority === "critical" ? 1 : p.priority === "high" ? 2 : p.priority === "low" ? 4 : 3,
        metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
      });

      // Optionally spawn an agent to work on the task
      if (p.assigned_to) {
        try {
          await inboxAdapter.send("system", p.assigned_to, {
            type: "event",
            event: "TASK_ASSIGNED",
            data: { taskId, title: p.title, description: p.description },
          });
        } catch {
          // Agent may not exist locally — that's fine
        }
      }
    } catch (err) {
      console.warn(
        `[map-sidecar] Failed to handle task.assign: ${(err as Error).message}`,
      );
    }
  });

  // --- Task Status ---
  register(METHODS.TASK_STATUS, async (params: unknown) => {
    const p = params as CoordinationTaskStatus;
    if (!p?.task_id || !p?.status) return;

    try {
      const actionMap: Record<string, string> = {
        in_progress: "start",
        completed: "complete",
        closed: "complete",
        failed: "fail",
        blocked: "block",
        open: "reopen",
      };
      const action = actionMap[p.status];
      if (action) {
        await tasksAdapter.transitionTask(p.task_id, action as any);
      }
    } catch (err) {
      console.warn(
        `[map-sidecar] Failed to handle task.status: ${(err as Error).message}`,
      );
    }
  });

  // --- Context Share ---
  register(METHODS.CONTEXT_SHARE, async (params: unknown) => {
    const p = params as CoordinationContextShare;
    if (!p?.context_type || !p?.data) return;

    try {
      // Deliver context to all running agents via inbox
      const agents = agentManager.list()
        .filter((a: any) => a.state === "running");
      for (const agent of agents) {
        await inboxAdapter
          .send("system", agent.id, {
            type: "event",
            event: "CONTEXT_SHARED",
            data: {
              context_type: p.context_type,
              data: p.data,
              source: p.source_swarm_id,
            },
          })
          .catch(() => {});
      }
    } catch (err) {
      console.warn(
        `[map-sidecar] Failed to handle context.share: ${(err as Error).message}`,
      );
    }
  });

  // --- Message Send ---
  register(METHODS.MESSAGE_SEND, async (params: unknown) => {
    const p = params as CoordinationMessage;
    if (!p?.content) return;

    try {
      const agents = agentManager.list()
        .filter((a: any) => a.state === "running");
      if (agents.length === 0) return;

      // Route to the best target:
      // 1. If to_swarm_id matches a local agent ID, send directly
      // 2. If metadata has a target_agent hint, use it
      // 3. Otherwise, send to the coordinator/head manager (parentless agent)
      // 4. Fallback: first running agent
      const targetId = p.to_swarm_id;
      const directTarget = targetId
        ? agents.find((a: any) => a.id === targetId)
        : undefined;
      const coordinator = agents.find((a: any) => !a.parent);
      const target = directTarget ?? coordinator ?? agents[0];

      await inboxAdapter.send("system", target.id, {
        type: "event",
        event: "EXTERNAL_MESSAGE",
        data: {
          from: p.from_swarm_id,
          content_type: p.content_type,
          content: p.content,
          reply_to: p.reply_to,
          metadata: p.metadata,
        },
      });
    } catch (err) {
      console.warn(
        `[map-sidecar] Failed to handle message.send: ${(err as Error).message}`,
      );
    }
  });

  // --- Workspace Execute (delegate to cognitive module) ---
  if (deps.workspaceHandler) {
    const wh = deps.workspaceHandler;
    register(METHODS.WORKSPACE_EXECUTE, async (params: unknown) => {
      try {
        await wh.handleWorkspaceExecute(params);
      } catch (err) {
        console.warn(
          `[map-sidecar] Failed to handle workspace.execute: ${(err as Error).message}`,
        );
      }
    });
  }

  // Return cleanup function
  return () => {
    for (const { method, handler } of handlers) {
      connection.offNotification(method, handler);
    }
    handlers.length = 0;
  };
}
