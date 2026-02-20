/**
 * Agent Lifecycle Extension Methods (_macro/spawnAgent, _macro/forkAgent, etc.)
 *
 * Exposes agent lifecycle management to external MAP clients via direct
 * JSON-RPC extension calls, replacing the need for ACP-over-MAP streams.
 *
 * Methods:
 * - _macro/spawnAgent - Spawn a child agent
 * - _macro/forkAgent - Fork an agent's session
 * - _macro/setPermissionMode - Change an agent's permission mode
 * - _macro/respondToPermission - Respond to a pending permission request
 */

import type { MAPAdapter, ExtensionHandler, ExtensionContext } from "../interface.js";
import type { AgentId } from "../../../store/types/index.js";
import { RPCError } from "../rpc-handler.js";

// =============================================================================
// Extension Services
// =============================================================================

/**
 * Services required for agent lifecycle extensions
 */
export interface AgentLifecycleExtensionServices {
  /** Get agent by ID */
  getAgent: (id: AgentId) => { id: AgentId; state: string; session_id?: string; cwd?: string | null } | null;

  /** Spawn a child agent under a parent */
  spawn: (opts: {
    parent: AgentId;
    task: string;
    cwd?: string;
    role?: string;
    topics?: string[];
    config?: Record<string, unknown>;
  }) => Promise<{ id: AgentId; session_id: string }>;

  /** Fork an agent's session */
  forkAgent: (agentId: AgentId, opts: {
    name?: string;
    prompt?: string;
    cwd?: string;
  }) => Promise<{ id: AgentId; session_id: string; session?: { id: string } }>;

  /** Send a prompt to an agent (for fire-and-forget initial prompt on fork) */
  prompt: (agentId: AgentId, message: string) => AsyncIterable<unknown>;

  /** Set the permission mode for an agent's session */
  setPermissionMode: (agentId: AgentId, mode: string) => boolean;

  /** Get the current permission mode for an agent */
  getPermissionMode: (agentId: AgentId) => string | null;

  /** Respond to a pending permission request */
  respondToPermission: (agentId: AgentId, requestId: string, optionId: string) => boolean;

  /** Callback to notify subscribers that a new agent was registered */
  onAgentRegistered?: (agent: { id: string; name?: string; role?: string; parent?: string }) => void;

  /** List head manager agents (fallback parent for spawn) */
  listHeadManagers: () => Array<{ id: AgentId }>;

  /** Default working directory */
  defaultCwd?: string;
}

// =============================================================================
// Handler Implementations
// =============================================================================

function createSpawnHandler(services: AgentLifecycleExtensionServices): ExtensionHandler {
  return async (_context: ExtensionContext, params: unknown) => {
    const { task, cwd, topics, config, parentId } = (params ?? {}) as {
      task: string;
      cwd?: string;
      topics?: string[];
      config?: Record<string, unknown>;
      parentId?: string;
    };

    if (!task) {
      throw RPCError.invalidParams("task is required");
    }

    // Determine parent: explicit parentId, or fall back to head manager
    let parent: AgentId | undefined;
    if (parentId) {
      parent = parentId as AgentId;
    } else {
      const headManagers = services.listHeadManagers();
      if (headManagers.length > 0) {
        parent = headManagers[0].id;
      }
    }

    if (!parent) {
      throw RPCError.invalidParams("No parent agent available for spawning");
    }

    const spawned = await services.spawn({
      parent,
      task,
      cwd: cwd ?? services.defaultCwd,
      role: "worker",
      topics,
      config,
    });

    // Notify subscribers that a new agent was registered
    if (services.onAgentRegistered) {
      const agent = services.getAgent(spawned.id);
      services.onAgentRegistered({
        id: spawned.id as string,
        name: agent?.id as string,
        role: "worker",
        parent: parent as string,
      });
    }

    return {
      agentId: spawned.id,
      sessionId: spawned.session_id,
    };
  };
}

function createForkHandler(services: AgentLifecycleExtensionServices): ExtensionHandler {
  return async (_context: ExtensionContext, params: unknown) => {
    const { agentId, name, prompt, cwd } = (params ?? {}) as {
      agentId: string;
      name?: string;
      prompt?: string;
      cwd?: string;
    };

    if (!agentId) {
      throw RPCError.invalidParams("agentId is required");
    }

    const sourceAgent = services.getAgent(agentId as AgentId);
    if (!sourceAgent) {
      throw RPCError.notFound("agent", agentId);
    }

    const forked = await services.forkAgent(agentId as AgentId, {
      name,
      prompt,
      cwd: cwd ?? sourceAgent.cwd ?? services.defaultCwd,
    });

    // Notify subscribers
    if (services.onAgentRegistered) {
      services.onAgentRegistered({
        id: forked.id as string,
        name,
        parent: sourceAgent.id as string,
      });
    }

    // Fire-and-forget initial prompt if provided
    if (prompt && forked.id) {
      (async () => {
        try {
          for await (const _chunk of services.prompt(forked.id, prompt)) {
            // drain iterator
          }
        } catch {
          // best-effort
        }
      })();
    }

    return {
      newAgentId: forked.id,
      newSessionId: forked.session_id,
      originalAgentId: agentId,
      providerSessionId: forked.session?.id,
    };
  };
}

function createSetPermissionModeHandler(services: AgentLifecycleExtensionServices): ExtensionHandler {
  return async (_context: ExtensionContext, params: unknown) => {
    const { agentId, permissionMode } = (params ?? {}) as {
      agentId: string;
      permissionMode: string;
    };

    if (!agentId || !permissionMode) {
      throw RPCError.invalidParams("agentId and permissionMode are required");
    }

    const previousMode = services.getPermissionMode(agentId as AgentId);
    const success = services.setPermissionMode(agentId as AgentId, permissionMode);

    if (!success) {
      return {
        success: false,
        error: `No active session found for agent ${agentId}`,
      };
    }

    return {
      success: true,
      agentId,
      previousMode,
      newMode: permissionMode,
    };
  };
}

function createRespondToPermissionHandler(services: AgentLifecycleExtensionServices): ExtensionHandler {
  return async (_context: ExtensionContext, params: unknown) => {
    const { agentId, requestId, optionId } = (params ?? {}) as {
      agentId: string;
      requestId: string;
      optionId: string;
    };

    if (!agentId || !requestId || !optionId) {
      throw RPCError.invalidParams("agentId, requestId, and optionId are required");
    }

    const success = services.respondToPermission(
      agentId as AgentId,
      requestId,
      optionId,
    );

    return { success };
  };
}

// =============================================================================
// Registration
// =============================================================================

/** All agent lifecycle extension method names */
export const AGENT_LIFECYCLE_METHODS = [
  "_macro/spawnAgent",
  "_macro/forkAgent",
  "_macro/setPermissionMode",
  "_macro/respondToPermission",
] as const;

/**
 * Register agent lifecycle extension methods with the MAPAdapter.
 */
export function registerAgentLifecycleExtensions(
  adapter: MAPAdapter,
  services: AgentLifecycleExtensionServices,
): void {
  adapter.registerExtension("_macro/spawnAgent", createSpawnHandler(services));
  adapter.registerExtension("_macro/forkAgent", createForkHandler(services));
  adapter.registerExtension("_macro/setPermissionMode", createSetPermissionModeHandler(services));
  adapter.registerExtension("_macro/respondToPermission", createRespondToPermissionHandler(services));
}

/**
 * Unregister agent lifecycle extension methods.
 */
export function unregisterAgentLifecycleExtensions(adapter: MAPAdapter): void {
  for (const method of AGENT_LIFECYCLE_METHODS) {
    adapter.unregisterExtension(method);
  }
}
