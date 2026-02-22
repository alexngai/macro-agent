/**
 * Cognitive Team Lifecycle
 *
 * Factory and lifecycle helper for initializing the cognitive-ops team.
 * Loads the team manifest, bootstraps the coordinator, and creates a
 * MacroAgentBackend configured to spawn analysts under the coordinator.
 *
 * Supports two modes:
 * - Standalone: Uses TeamRuntime directly (backward compatible with Phase 2)
 * - TeamManager: Delegates to TeamManager.startTeam() for multi-team support
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
 * // Query task status
 * const tasks = await handle.taskBackend.list();
 *
 * // When done, tear down the team
 * await handle.teardown();
 * ```
 */

import path from "node:path";
import type { AgentManager } from "../agent/agent-manager.js";
import type { MessageRouter } from "../router/message-router.js";
import type { EventStore } from "../store/event-store.js";
import type { AgentId } from "../store/types/index.js";
import type { TaskBackend } from "../task/backend/types.js";
import { createInMemoryTaskBackend } from "../task/backend/memory.js";
import { loadTeam } from "../teams/team-loader.js";
import { TeamRuntime } from "../teams/team-runtime.js";
import type { TeamManager } from "../teams/team-manager.js";
import type { AtlasConfig } from "../teams/types.js";
import { MacroAgentBackend } from "./macro-agent-backend.js";
import type { AtlasInstance, MacroAgentBackendConfig } from "./types.js";

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
  /** Optional TeamManager for multi-team management. When provided, uses startTeam(). */
  teamManager?: TeamManager;
  /** Optional Atlas instance for trajectory learning. */
  atlas?: AtlasInstance;
}

/**
 * Handle returned by initCognitiveTeam().
 */
export interface CognitiveTeamHandle {
  /** Backend configured with useTeam: true and task tracking */
  backend: MacroAgentBackend;
  /** The underlying TeamRuntime */
  runtime: TeamRuntime;
  /** Agent ID of the team coordinator */
  coordinatorId: AgentId;
  /** TaskBackend for querying task status */
  taskBackend: TaskBackend;
  /** Atlas instance (if provided) */
  atlas?: AtlasInstance;
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
 * 1. Creates an InMemoryTaskBackend sharing the EventStore
 * 2. Loads team manifest and bootstraps coordinator (via TeamManager or standalone)
 * 3. Creates a MacroAgentBackend with useTeam: true, coordinatorAgentId, and taskBackend
 * 4. Returns a handle with backend, runtime, taskBackend, and teardown
 */
export async function initCognitiveTeam(
  services: CognitiveTeamServices,
  backendConfig?: Omit<MacroAgentBackendConfig, "useTeam" | "coordinatorAgentId" | "taskBackend">,
): Promise<CognitiveTeamHandle> {
  const { agentManager, messageRouter, eventStore, basePath, teamManager, atlas } = services;

  // Create TaskBackend sharing the same EventStore
  const taskBackend = createInMemoryTaskBackend(eventStore);

  let runtime: TeamRuntime;
  let rootId: string;
  let teamInstanceId: string | undefined;

  if (teamManager) {
    // TeamManager mode: delegates to startTeam() for composite dispatch
    const instance = await teamManager.startTeam(TEAM_NAME, basePath);
    runtime = instance.runtime;
    rootId = instance.result.rootId;
    teamInstanceId = instance.id;
  } else {
    // Standalone mode (backward compatible with Phase 2)
    const roleRegistry = agentManager.getRoleRegistry();
    const manifest = await loadTeam(TEAM_NAME, roleRegistry, basePath);

    runtime = new TeamRuntime(manifest, {
      agentManager,
      messageRouter,
      eventStore,
    });

    await runtime.initialize();
    const { rootId: bootstrapRootId } = await runtime.bootstrap();
    rootId = bootstrapRootId;
  }

  // Resolve Atlas instance: explicit injection > team YAML config > none
  let resolvedAtlas = atlas;
  if (!resolvedAtlas) {
    const manifest = runtime.getManifest();
    const atlasConfig = manifest?.macro_agent?.atlas as AtlasConfig | undefined;
    if (atlasConfig?.enabled) {
      try {
        // Dynamic import — cognitive-core is an optional peer dependency
        // @ts-expect-error cognitive-core is not installed; resolved at runtime
        const cogCore = await import("cognitive-core");
        resolvedAtlas = await cogCore.Atlas.create({
          workDir: path.join(basePath ?? process.cwd(), atlasConfig.workDir ?? ".atlas"),
          analysis: { mode: atlasConfig.analysisMode ?? "heuristic" },
        });
      } catch {
        console.warn("[cognitive-team] Atlas enabled in team config but cognitive-core is not available");
      }
    }
  }

  // Create backend with task tracking and optional Atlas
  const backend = new MacroAgentBackend(agentManager, {
    ...backendConfig,
    useTeam: true,
    coordinatorAgentId: rootId as AgentId,
    taskBackend,
    atlas: resolvedAtlas,
  });

  return {
    backend,
    runtime,
    coordinatorId: rootId as AgentId,
    taskBackend,
    atlas: resolvedAtlas,
    teardown: async () => {
      if (resolvedAtlas) {
        await resolvedAtlas.close().catch(() => {});
      }
      if (teamManager && teamInstanceId) {
        await teamManager.stopTeam(teamInstanceId);
      } else {
        await runtime.teardown();
      }
    },
  };
}
