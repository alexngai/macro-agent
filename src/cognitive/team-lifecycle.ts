/**
 * Cognitive Team Lifecycle
 *
 * Factory and lifecycle helper for initializing the cognitive-ops team.
 * Loads the team manifest, bootstraps the coordinator, and creates a
 * MacroAgentBackend configured to spawn analysts under the coordinator.
 *
 * Usage:
 * ```typescript
 * const handle = await initCognitiveTeam({
 *   agentManager,
 *   messageRouter,
 *   eventStore,
 * });
 *
 * // Use handle.backend as an AgentBackend
 * const session = await handle.backend.spawn({ agentType: 'claude-code', task });
 *
 * // When done, tear down the team
 * await handle.teardown();
 * ```
 */

import type { AgentManager } from "../agent/agent-manager.js";
import type { MessageRouter } from "../router/message-router.js";
import type { EventStore } from "../store/event-store.js";
import type { AgentId } from "../store/types/index.js";
import { loadTeam } from "../teams/team-loader.js";
import { TeamRuntime } from "../teams/team-runtime.js";
import { MacroAgentBackend } from "./macro-agent-backend.js";
import type { MacroAgentBackendConfig } from "./types.js";

// ─────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────

/**
 * Services required to initialize a cognitive team.
 *
 * AgentManager alone doesn't expose messageRouter or eventStore,
 * so callers must provide all three.
 */
export interface CognitiveTeamServices {
  agentManager: AgentManager;
  messageRouter: MessageRouter;
  eventStore: EventStore;
  /** Project root for locating .multiagent/teams/. Default: process.cwd() */
  basePath?: string;
}

/**
 * Handle returned by initCognitiveTeam().
 */
export interface CognitiveTeamHandle {
  /** Backend configured with useTeam: true */
  backend: MacroAgentBackend;
  /** The underlying TeamRuntime */
  runtime: TeamRuntime;
  /** Agent ID of the team coordinator */
  coordinatorId: AgentId;
  /** Tear down the team (removes spawn interceptor, etc.) */
  teardown(): Promise<void>;
}

// ─────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────

const TEAM_NAME = "cognitive-ops";

/**
 * Initialize the cognitive-ops team and return a configured MacroAgentBackend.
 *
 * 1. Loads the cognitive-ops team manifest from .multiagent/teams/cognitive-ops/
 * 2. Creates a TeamRuntime and calls initialize() + bootstrap()
 * 3. Creates a MacroAgentBackend with useTeam: true and coordinatorAgentId
 * 4. Returns a handle with backend, runtime, and teardown
 */
export async function initCognitiveTeam(
  services: CognitiveTeamServices,
  backendConfig?: Omit<MacroAgentBackendConfig, "useTeam" | "coordinatorAgentId">,
): Promise<CognitiveTeamHandle> {
  const { agentManager, messageRouter, eventStore, basePath } = services;
  const roleRegistry = agentManager.getRoleRegistry();

  // 1. Load team manifest
  const manifest = await loadTeam(TEAM_NAME, roleRegistry, basePath);

  // 2. Create and initialize runtime
  const runtime = new TeamRuntime(manifest, {
    agentManager,
    messageRouter,
    eventStore,
  });

  await runtime.initialize();

  // 3. Bootstrap team (spawns coordinator)
  const { rootId } = await runtime.bootstrap();

  // 4. Create backend configured for team mode
  const backend = new MacroAgentBackend(agentManager, {
    ...backendConfig,
    useTeam: true,
    coordinatorAgentId: rootId as AgentId,
  });

  return {
    backend,
    runtime,
    coordinatorId: rootId as AgentId,
    teardown: () => runtime.teardown(),
  };
}
