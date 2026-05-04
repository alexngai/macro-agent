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
  callExtension(method: string, params?: unknown): Promise<unknown>;
  get isConnected(): boolean;
}

interface RegisteredAgent {
  id: string;
  name: string;
  role: string;
  /** MAP-assigned agent ID (ULID) from the hub, used for unregistration */
  mapId?: string;
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
  getLocalMapId?: (localAgentId: string) => string | undefined,
): {
  callback: AgentLifecycleCallback;
  cleanup: () => Promise<void>;
  /**
   * Resolve true once the named agent has completed `map/agents/register`
   * with the hub (its entry.mapId is populated). Used by the dispatch
   * spawn-agent handler to barrier-wait for hub-side registration before
   * returning, so the orchestrator's subsequent `findAcpAgentInfo` lookup
   * doesn't race the registration.
   *
   * Returns false if the timeout elapses before registration completes.
   */
  awaitRegistration: (agentId: string, timeoutMs?: number) => Promise<boolean>;
  /**
   * Reverse-lookup: hub-assigned MAP ULID → local agent id. Used by the
   * `map/dispatch/message` handler in the sidecar to translate envelope
   * recipients (which the hub addresses by MAP ULID) into local agent ids
   * (which the inbox addresses messages by). Returns undefined when no
   * registered agent matches.
   */
  findLocalAgentByMapId: (mapId: string) => string | undefined;
} {
  const registered = new Map<string, RegisteredAgent>();

  /**
   * Poll for the local MAP server's assigned ID for an agent.
   * The local MAP server and the lifecycle bridge both listen to the same
   * lifecycle callback, so they may fire in any order. Poll briefly to handle
   * the race.
   */
  async function waitForLocalMapId(localAgentId: string, timeoutMs = 500): Promise<string | undefined> {
    if (!getLocalMapId) return undefined;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const id = getLocalMapId(localAgentId);
      if (id) return id;
      await new Promise((r) => setTimeout(r, 20));
    }
    return getLocalMapId(localAgentId);
  }

  const callback: AgentLifecycleCallback = (event) => {
    if (!connection.isConnected) return;

    switch (event.type) {
      case "spawned": {
        const agent = event.agent;
        const name = agent.name ?? agent.id;
        const role = agent.role ?? "worker";
        const entry: RegisteredAgent = { id: agent.id, name, role };
        registered.set(agent.id, entry);

        // Build per-agent capabilities.
        // Coordinators (head managers) support ACP for interactive chat.
        const capabilities: Record<string, unknown> = {
          messaging: { canReceive: true },
        };
        if (role === "coordinator") {
          capabilities.protocols = ["acp"];
          capabilities.acp = { version: "2024-10-07" };
        }

        // Register agent with MAP hub (use map/agents/register to preserve
        // per-agent capabilities; map/agents/spawn drops them).
        // Include the local MAP server's ID in metadata so clients can route
        // ACP messages to the correct agent on the macro-agent's own MAP server.
        // Also include provider_session_id so OpenHive can find the underlying
        // Claude Code JSONL transcript on disk for history recovery.
        const agentMetadata = (agent as any).metadata as Record<string, unknown> | undefined;
        const providerSessionId =
          typeof agentMetadata?.provider_session_id === "string"
            ? agentMetadata.provider_session_id
            : undefined;
        (async () => {
          const peerMapId = await waitForLocalMapId(agent.id);
          try {
            const result: any = await connection.callExtension("map/agents/register", {
              name,
              role,
              capabilities,
              metadata: {
                // From the hub's perspective these IDs identify this agent on
                // the macro-agent (peer) side. `peerAgentId` is macro-agent's
                // internal store id; `peerMapId` is its local MAP server ULID.
                // Hub callers use these to address the agent in routing
                // (ACP streams target peerMapId, lifecycle ops use peerAgentId).
                peerAgentId: agent.id,
                peerMapId,
                provider_session_id: providerSessionId,
                parent: (agent as any).parent_id ?? undefined,
                team: (agent as any).team ?? undefined,
                cwd: (agent as any).cwd ?? undefined,
              },
            });
            // Track the MAP-assigned agent ID for unregistration
            const mapId = result?.agent?.id ?? result?.id;
            if (mapId) {
              entry.mapId = mapId;
            }
          } catch {
            // Silent — MAP hub may be temporarily unavailable
          }
        })();

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
        const entry = registered.get(agent.id);
        registered.delete(agent.id);

        // Unregister agent from MAP hub (use MAP-assigned ID if available)
        const unregId = entry?.mapId ?? agent.id;
        connection
          .callExtension("map/agents/unregister", {
            agentId: unregId,
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
    // Unregister all tracked agents (use MAP-assigned IDs)
    const promises = Array.from(registered.values()).map((entry) =>
      connection
        .callExtension("map/agents/unregister", {
          agentId: entry.mapId ?? entry.id,
          reason: "sidecar_shutdown",
        })
        .catch(() => {}),
    );
    await Promise.allSettled(promises);
    registered.clear();
  };

  /**
   * Block until the named agent's hub-side registration completes (entry
   * has been assigned a mapId by the `map/agents/register` response) or
   * the timeout elapses. Polls the local `registered` map.
   */
  const awaitRegistration = async (
    agentId: string,
    timeoutMs = 5000,
  ): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const entry = registered.get(agentId);
      if (entry?.mapId) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return Boolean(registered.get(agentId)?.mapId);
  };

  const findLocalAgentByMapId = (mapId: string): string | undefined => {
    for (const [localId, entry] of registered) {
      if (entry.mapId === mapId) return localId;
    }
    return undefined;
  };

  return { callback, cleanup, awaitRegistration, findLocalAgentByMapId };
}
