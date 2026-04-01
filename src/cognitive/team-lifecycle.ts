/**
 * Cognitive Team Lifecycle
 *
 * Factory and lifecycle helper for initializing the cognitive-ops team.
 * Loads the team manifest, bootstraps the coordinator, and creates a
 * MacroAgentBackend configured to spawn analysts under the coordinator.
 *
 * V2 port: Uses TeamManagerV2/TeamRuntimeV2 and TasksAdapter instead of
 * V1 TeamRuntime, EventStore, MessageRouter, and TaskBackend.
 *
 * Supports two modes:
 * - Standalone: Uses TeamRuntimeV2 directly
 * - TeamManager: Delegates to TeamManagerV2.startTeam() for multi-team support
 *
 * Usage:
 * ```typescript
 * const handle = await initCognitiveTeam({
 *   agentManager,
 *   inboxAdapter,
 *   tasksAdapter,
 * });
 *
 * // Use handle.backend as an AgentBackend
 * const session = await handle.backend.spawn({ agentType: 'claude-code', task });
 *
 * // Query task status
 * const tasks = await handle.tasksAdapter.listTasks();
 *
 * // When done, tear down the team
 * await handle.teardown();
 * ```
 */

import path from "node:path";
import type { AgentManager } from "../agent/agent-manager.js";
import type { AgentId } from "../store/types/index.js";
import type { InboxAdapter, TasksAdapter } from "../adapters/types.js";
import type { WorkspaceManager } from "../workspace/types.js";
import { loadTeam } from "../teams/team-loader.js";
import { TeamRuntimeV2, type TeamServicesV2 } from "../teams/team-runtime-v2.js";
import type { TeamManagerV2 } from "../teams/team-manager-v2.js";
import { MacroAgentBackend } from "./macro-agent-backend.js";
import type { AtlasInstance, MacroAgentBackendConfig } from "./types.js";

// ─────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────

/**
 * Services required to initialize a cognitive team.
 */
export interface CognitiveTeamServices {
  agentManager: AgentManager;
  inboxAdapter: InboxAdapter;
  tasksAdapter: TasksAdapter;
  workspaceManager?: WorkspaceManager;
  /** Project root for locating .multiagent/teams/. Default: process.cwd() */
  basePath?: string;
  /** Optional TeamManagerV2 for multi-team management. When provided, uses startTeam(). */
  teamManager?: TeamManagerV2;
  /** Optional Atlas instance for trajectory learning. */
  atlas?: AtlasInstance;
}

/**
 * Handle returned by initCognitiveTeam().
 */
export interface CognitiveTeamHandle {
  /** Backend configured with useTeam: true and task tracking */
  backend: MacroAgentBackend;
  /** The underlying TeamRuntimeV2 */
  runtime: TeamRuntimeV2;
  /** Agent ID of the team coordinator */
  coordinatorId: AgentId;
  /** TasksAdapter for querying task status */
  tasksAdapter: TasksAdapter;
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
 * 1. Uses the provided TasksAdapter (connected to opentasks)
 * 2. Loads team manifest and bootstraps coordinator (via TeamManagerV2 or standalone)
 * 3. Creates a MacroAgentBackend with useTeam: true, coordinatorAgentId, and tasksAdapter
 * 4. Returns a handle with backend, runtime, tasksAdapter, and teardown
 */
export async function initCognitiveTeam(
  services: CognitiveTeamServices,
  backendConfig?: Omit<MacroAgentBackendConfig, "useTeam" | "coordinatorAgentId" | "tasksAdapter">,
): Promise<CognitiveTeamHandle> {
  const {
    agentManager,
    inboxAdapter,
    tasksAdapter,
    workspaceManager,
    basePath,
    teamManager,
    atlas,
  } = services;

  let runtime: TeamRuntimeV2;
  let rootId: string;
  let teamInstanceId: string | undefined;

  if (teamManager) {
    // TeamManagerV2 mode: delegates to startTeam() for composite dispatch
    teamInstanceId = await teamManager.startTeam(TEAM_NAME, basePath);
    const instance = teamManager.getInstance(teamInstanceId);
    if (!instance) {
      throw new Error(`Failed to start cognitive-ops team: instance not found`);
    }
    runtime = instance.runtime;
    rootId = instance.result.rootId;
  } else {
    // Standalone mode: use TeamRuntimeV2 directly
    const roleRegistry = agentManager.getRoleRegistry();
    const manifest = await loadTeam(TEAM_NAME, roleRegistry, basePath);

    const runtimeServices: TeamServicesV2 = {
      agentManager,
      inboxAdapter,
      tasksAdapter,
      workspaceManager,
    };

    runtime = new TeamRuntimeV2(manifest, runtimeServices);

    await runtime.initialize();
    const bootstrapResult = await runtime.bootstrap();
    rootId = bootstrapResult.rootId;
  }

  // Resolve Atlas instance: explicit injection > team YAML config > none
  let resolvedAtlas = atlas;
  if (!resolvedAtlas) {
    const manifest = runtime.getManifest();
    const atlasConfig = manifest?.macro_agent?.atlas as
      | { enabled?: boolean; workDir?: string; analysisMode?: string }
      | undefined;
    if (atlasConfig?.enabled) {
      try {
        // Dynamic import -- cognitive-core is an optional peer dependency
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
    tasksAdapter,
    atlas: resolvedAtlas,
    inboxAdapter,
  });

  return {
    backend,
    runtime,
    coordinatorId: rootId as AgentId,
    tasksAdapter,
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
