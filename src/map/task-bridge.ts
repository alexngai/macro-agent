/**
 * Task Bridge — emits task lifecycle events to the MAP hub for observability.
 *
 * Bridges internal opentasks state changes to MAP-visible events so that
 * OpenHive's UI can display task progress across swarms.
 *
 * @module map/task-bridge
 */

import type { TaskBridge } from "./types.js";

/** Minimal interface for the MAP connection methods we need */
export interface TaskBridgeConnection {
  send(
    to: { scope: string } | string,
    payload?: unknown,
    meta?: Record<string, unknown>,
  ): Promise<unknown>;
  get isConnected(): boolean;
}

/**
 * Create a task bridge that emits task events to the MAP hub.
 * Wire format matches cc-swarm's bridge-task-* commands.
 */
export function createTaskBridge(
  connection: TaskBridgeConnection,
  scope: string,
): TaskBridge {
  const send = async (payload: Record<string, unknown>): Promise<void> => {
    if (!connection.isConnected) return;
    try {
      await connection.send({ scope }, payload);
    } catch {
      // Silent — MAP hub may be temporarily unavailable
    }
  };

  return {
    async taskCreated(task): Promise<void> {
      await send({
        type: "task.created",
        task: {
          id: task.id,
          title: task.title,
          status: task.status,
          assignee: task.assignee,
        },
        _origin: "macro-agent",
      });
    },

    async taskStatusChanged(
      taskId,
      previous,
      current,
      agentId,
    ): Promise<void> {
      await send({
        type: "task.status",
        taskId,
        previous,
        current,
        agentId,
        _origin: "macro-agent",
      });

      // Also emit task.completed if terminal status
      if (current === "completed" || current === "closed") {
        await send({
          type: "task.completed",
          taskId,
          agentId,
          timestamp: Date.now(),
          _origin: "macro-agent",
        });
      }
    },

    async taskAssigned(taskId, assignee): Promise<void> {
      await send({
        type: "task.assigned",
        taskId,
        assignee,
        _origin: "macro-agent",
      });
    },
  };
}
