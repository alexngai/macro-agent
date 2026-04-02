/**
 * Lifecycle Bridge — translates AgentManager lifecycle events to MAP agent primitives.
 *
 * When agents are spawned or terminated in macro-agent, this bridge registers/unregisters
 * them with the MAP hub so they appear in OpenHive's agent discovery.
 *
 * @module map/lifecycle-bridge
 */

import type { AgentLifecycleCallback } from "../agent/types.js";
import type { AgentStore } from "../agent/agent-store.js";
import type { TaskBridge } from "./types.js";

/** Minimal interface for the MAP connection methods we need */
export interface LifecycleBridgeConnection {
  spawn(options: {
    agentId?: string | undefined;
    name?: string | undefined;
    role?: string | undefined;
    scopes?: string[];
    metadata?: Record<string, unknown>;
  }): Promise<unknown>;
  callExtension(method: string, params?: unknown): Promise<unknown>;
  get isConnected(): boolean;
}

interface RegisteredAgent {
  id: string;
  name: string;
  role: string;
}

/**
 * Create a lifecycle bridge that translates agent lifecycle events to MAP calls.
 *
 * Returns an `AgentLifecycleCallback` to register via `agentManager.onLifecycleEvent()`,
 * plus a `cleanup()` function to unregister all tracked agents on shutdown.
 */
export function createLifecycleBridge(
  connection: LifecycleBridgeConnection,
  agentStore: AgentStore,
  scope: string,
  taskBridge?: TaskBridge,
): { callback: AgentLifecycleCallback; cleanup: () => Promise<void> } {
  const registered = new Map<string, RegisteredAgent>();

  const callback: AgentLifecycleCallback = (event) => {
    if (!connection.isConnected) return;

    switch (event.type) {
      case "spawned": {
        const agent = event.agent;
        const name = agent.name ?? agent.id;
        const role = agent.role ?? "worker";
        const entry: RegisteredAgent = { id: agent.id, name, role };
        registered.set(agent.id, entry);

        // Register agent with MAP hub
        connection
          .spawn({
            agentId: agent.id,
            name,
            role,
            scopes: [scope],
            metadata: {
              parent: (agent as any).parent_id ?? undefined,
              team: (agent as any).team ?? undefined,
              cwd: (agent as any).cwd ?? undefined,
            },
          })
          .catch(() => {
            // Silent — MAP hub may be temporarily unavailable
          });

        // Bridge task creation if agent has a task
        if (taskBridge && (agent as any).task_id) {
          taskBridge
            .taskCreated({
              id: (agent as any).task_id,
              title: (agent as any).task ?? agent.name,
              status: "open",
              assignee: agent.id,
            })
            .catch(() => {});
        }
        break;
      }

      case "stopped": {
        const agent = event.agent;
        registered.delete(agent.id);

        // Unregister agent from MAP hub
        connection
          .callExtension("map/agents/unregister", {
            agentId: agent.id,
            reason: event.reason ?? "stopped",
          })
          .catch(() => {
            // Silent fallback
          });

        // Bridge task completion
        if (taskBridge && (agent as any).task_id) {
          const status =
            event.reason === "completed" ? "completed" : "failed";
          taskBridge
            .taskStatusChanged(
              (agent as any).task_id,
              "in_progress",
              status,
              agent.id,
            )
            .catch(() => {});
        }
        break;
      }
    }
  };

  const cleanup = async (): Promise<void> => {
    if (!connection.isConnected) {
      registered.clear();
      return;
    }
    // Unregister all tracked agents
    const promises = Array.from(registered.keys()).map((agentId) =>
      connection
        .callExtension("map/agents/unregister", {
          agentId,
          reason: "sidecar_shutdown",
        })
        .catch(() => {}),
    );
    await Promise.allSettled(promises);
    registered.clear();
  };

  return { callback, cleanup };
}
