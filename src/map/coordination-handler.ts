/**
 * Coordination Handler — dispatches inbound coordination messages from the MAP hub.
 *
 * Task operations use generic MAP scope messages (task.created, task.assigned,
 * task.status) matching the wire format used by cc-swarm and opentasks.
 * Context sharing and messaging use agent-inbox (not MAP).
 * Workspace execution uses x-workspace/* notifications.
 *
 * @module map/coordination-handler
 */

import { WORKSPACE_METHODS, WORKSPACE_METHODS_LEGACY } from "agent-workspace";
import type { InboxAdapter, TasksAdapter } from "../adapters/types.js";

/** MAP Message shape (subset of @multi-agent-protocol/sdk Message) */
export interface MAPMessage {
  id: string;
  from: string;
  to: string | { scope: string };
  timestamp: string;
  payload?: Record<string, unknown>;
  meta?: Record<string, unknown>;
}

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
  onMessage(handler: (message: MAPMessage) => void | Promise<void>): void;
  offMessage(handler: (message: MAPMessage) => void | Promise<void>): void;
}

export interface CoordinationDeps {
  connection: CoordinationConnection;
  /** Used by task handlers to notify assignees */
  inboxAdapter: InboxAdapter;
  tasksAdapter: TasksAdapter;
  /** Workspace handler from cognitive module (if available) */
  workspaceHandler?: {
    handleWorkspaceExecute(params: unknown): Promise<void>;
    isWorkspaceExecuteMessage(msg: { method?: string }): boolean;
  };
}

/** Notification method constants (workspace only — task/context/message use MAP messages) */
const METHODS = {
  WORKSPACE_EXECUTE: WORKSPACE_METHODS.EXECUTE,
  WORKSPACE_EXECUTE_LEGACY: WORKSPACE_METHODS_LEGACY.EXECUTE,
} as const;

/**
 * Register coordination handlers on the MAP connection.
 *
 * Task operations are handled via MAP scope messages (onMessage).
 * Context sharing and messaging are handled by agent-inbox (not here).
 * Workspace execution uses x-workspace/* notifications.
 * Returns a cleanup function that removes all handlers.
 */
export function setupCoordinationHandlers(
  deps: CoordinationDeps,
): () => void {
  const { connection, inboxAdapter, tasksAdapter } = deps;
  const notificationHandlers: Array<{ method: string; handler: (params: unknown) => void | Promise<void> }> = [];

  const register = (
    method: string,
    handler: (params: unknown) => void | Promise<void>,
  ): void => {
    connection.onNotification(method, handler);
    notificationHandlers.push({ method, handler });
  };

  // =========================================================================
  // Task operations — generic MAP scope messages
  // Wire format matches cc-swarm / opentasks MAP Event Bridge:
  //   { type: "task.created",  task: { id, title, status, assignee } }
  //   { type: "task.assigned", taskId, assignee }
  //   { type: "task.status",   taskId, previous, current }
  // =========================================================================

  const messageHandler = async (message: MAPMessage): Promise<void> => {
    const payload = message.payload;
    if (!payload || typeof payload.type !== "string") return;

    // Skip messages we originated (echo prevention)
    const origin = payload._origin as string | undefined;
    if (origin === "macro-agent") return;

    try {
      switch (payload.type) {
        case "task.created": {
          const task = payload.task as
            | { id?: string; title?: string; status?: string; assignee?: string }
            | undefined;
          if (!task?.title) return;

          const taskId = await tasksAdapter.createTask({
            title: task.title,
            content: (task as Record<string, unknown>).description as string | undefined,
            assignee: task.assignee,
          });

          if (task.assignee) {
            await inboxAdapter
              .send("system", task.assignee, {
                type: "event",
                event: "TASK_ASSIGNED",
                data: { taskId, title: task.title },
              })
              .catch(() => {});
          }
          break;
        }

        case "task.assigned": {
          const taskId = payload.taskId as string | undefined;
          const assignee = payload.assignee as string | undefined;
          if (!taskId || !assignee) return;

          await tasksAdapter.assignTask(taskId, assignee);

          await inboxAdapter
            .send("system", assignee, {
              type: "event",
              event: "TASK_ASSIGNED",
              data: { taskId },
            })
            .catch(() => {});
          break;
        }

        case "task.status": {
          const taskId = payload.taskId as string | undefined;
          const current = payload.current as string | undefined;
          if (!taskId || !current) return;

          const actionMap: Record<string, string> = {
            in_progress: "start",
            completed: "complete",
            closed: "complete",
            failed: "fail",
            blocked: "block",
            open: "reopen",
          };
          const action = actionMap[current];
          if (action) {
            await tasksAdapter.transitionTask(taskId, action as any);
          }
          break;
        }

        // Context sharing and messaging are handled by agent-inbox directly
        // (not through MAP scope messages). See InboxAdapter for broadcast
        // scope delivery and agent-to-agent messaging.

        // Ignore other message types (e.g., task.completed is informational)
        default:
          break;
      }
    } catch (err) {
      console.warn(
        `[map-sidecar] Failed to handle ${payload.type}: ${(err as Error).message}`,
      );
    }
  };

  connection.onMessage(messageHandler);

  // =========================================================================
  // Workspace — JSON-RPC notifications (x-workspace protocol)
  // =========================================================================

  // --- Workspace Execute (delegate to cognitive module) ---
  if (deps.workspaceHandler) {
    const wh = deps.workspaceHandler;
    const workspaceHandler = async (params: unknown) => {
      try {
        await wh.handleWorkspaceExecute(params);
      } catch (err) {
        console.warn(
          `[map-sidecar] Failed to handle workspace.execute: ${(err as Error).message}`,
        );
      }
    };
    register(METHODS.WORKSPACE_EXECUTE, workspaceHandler);
    register(METHODS.WORKSPACE_EXECUTE_LEGACY, workspaceHandler);
  }

  // Return cleanup function
  return () => {
    connection.offMessage(messageHandler);
    for (const { method, handler } of notificationHandlers) {
      connection.offNotification(method, handler);
    }
    notificationHandlers.length = 0;
  };
}
