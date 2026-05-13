/**
 * TeamManagerV2 — Multi-team orchestrator.
 *
 * Manages multiple concurrent team instances, each with its own
 * TeamRuntimeV2. Uses composite signal filters and emission validators
 * (via addSignalFilter/addEmissionValidator) so teams don't overwrite
 * each other's policy hooks.
 *
 * Key responsibilities:
 * - Hold multiple team instances with agent-to-team mapping
 * - Install a composite spawn interceptor on AgentManager
 * - Auto-register child agents in parent's team via lifecycle listener
 * - Provide API for starting/stopping teams
 *
 * @module teams/team-manager-v2
 */

import type { AgentManager, SpawnInterceptor } from "../agent/agent-manager.js";
import type { SpawnAgentOptions } from "../agent/types.js";
import type { AgentId } from "../store/types/index.js";
import type { InboxAdapter, TasksAdapter } from "../adapters/types.js";
import type { WorkspaceManager } from "../workspace/types.js";
import { TeamRuntimeV2, type TeamBootstrapResult, type TeamServicesV2 } from "./team-runtime-v2.js";
import type { TeamManifest } from "./types.js";

// =============================================================================
// Types
// =============================================================================

export interface TeamManagerV2Services {
  agentManager: AgentManager;
  inboxAdapter: InboxAdapter;
  tasksAdapter: TasksAdapter;
  workspaceManager?: WorkspaceManager;
}

export interface TeamInstance {
  id: string;
  templateName: string;
  runtime: TeamRuntimeV2;
  result: TeamBootstrapResult;
}

// =============================================================================
// TeamManagerV2
// =============================================================================

export class TeamManagerV2 {
  /** Active team instances by instance ID */
  private instances = new Map<string, TeamInstance>();

  /** Agent ID → TeamInstance mapping */
  private agentTeamMap = new Map<string, TeamInstance>();

  /** Lifecycle listener unsubscribe */
  private lifecycleUnsubscribe?: () => void;

  /** Whether install() has been called */
  private installed = false;

  /** Counter for unique instance IDs */
  private instanceCounter = 0;

  constructor(private readonly services: TeamManagerV2Services) {}

  // ─────────────────────────────────────────────────────────────
  // Installation
  // ─────────────────────────────────────────────────────────────

  /**
   * Install composite spawn interceptor and lifecycle listener.
   * Must be called once before starting any teams.
   */
  install(): void {
    if (this.installed) return;

    const { agentManager } = this.services;

    // Install composite spawn interceptor that delegates to the correct team
    agentManager.setSpawnInterceptor(this.createCompositeSpawnInterceptor());

    // Listen for lifecycle events to auto-register children
    this.lifecycleUnsubscribe = agentManager.onLifecycleEvent((event) => {
      if (event.type !== "spawned") return;

      const parentId = event.agent.parent;
      if (!parentId) return;

      const parentTeam = this.agentTeamMap.get(parentId);
      if (!parentTeam) return;

      // Auto-register child in parent's team
      this.agentTeamMap.set(event.agent.id, parentTeam);
      const roleName = event.agent.role;
      if (roleName) {
        parentTeam.runtime.registerAgent(event.agent.id as AgentId, roleName);
      }
    });

    this.installed = true;
  }

  /**
   * Uninstall composite interceptor and lifecycle listener.
   */
  uninstall(): void {
    if (!this.installed) return;

    this.services.agentManager.setSpawnInterceptor(null);

    if (this.lifecycleUnsubscribe) {
      this.lifecycleUnsubscribe();
      this.lifecycleUnsubscribe = undefined;
    }

    this.installed = false;
  }

  // ─────────────────────────────────────────────────────────────
  // Team Lifecycle
  // ─────────────────────────────────────────────────────────────

  /**
   * Start a team from a template name.
   *
   * Loads the template, creates a TeamRuntimeV2, initializes,
   * bootstraps, and registers filters via addSignalFilter/addEmissionValidator.
   *
   * @param name - Team template name
   * @param basePath - Project root for template loading
   * @returns The team instance ID
   */
  async startTeam(name: string, basePath?: string): Promise<string> {
    const { agentManager } = this.services;
    const { loadTeam } = await import("./team-loader.js");
    const roleRegistry = agentManager.getRoleRegistry();
    const manifest: TeamManifest = await loadTeam(
      name,
      roleRegistry,
      basePath ?? process.cwd()
    );
    return this.startTeamWithManifest(name, manifest);
  }

  /**
   * Start a team from an in-memory manifest snapshot — used by hosts
   * that ship the team config inline at boot (OpenHive's spawn manager
   * packing `bootstrap.openteams.team_content` into the bootstrap
   * token, for example). Skips disk I/O entirely; otherwise identical
   * to {@link startTeam}.
   */
  async startTeamFromContent(
    name: string,
    content: {
      manifest: import("openteams").TeamManifest;
      roles?: Record<string, import("../roles/types.js").RoleDefinition>;
      loadouts?: Record<string, unknown>;
      prompts?: Record<string, unknown>;
    },
  ): Promise<string> {
    const { agentManager } = this.services;
    const { loadTeamFromContent } = await import("./team-loader.js");
    const roleRegistry = agentManager.getRoleRegistry();
    const manifest: TeamManifest = await loadTeamFromContent(
      name,
      content,
      roleRegistry,
    );
    return this.startTeamWithManifest(name, manifest);
  }

  /**
   * Shared post-load flow: wire optional topology, build the runtime,
   * bootstrap the team's root + companions, install scoped filters,
   * and register the instance. Callable from any loader path
   * (disk-based `startTeam` or wire-based `startTeamFromContent`).
   */
  private async startTeamWithManifest(
    name: string,
    manifest: TeamManifest,
  ): Promise<string> {
    const { agentManager, inboxAdapter, tasksAdapter, workspaceManager } = this.services;
    // V3: auto-wire TopologyPolicy when the team declares
    // `macro_agent.workspace`. Requires a WorkspaceManager to be present.
    if (workspaceManager) {
      try {
        const { extractWorkspaceConfig } = await import(
          "../workspace/yaml-schema.js"
        );
        const workspaceConfig = extractWorkspaceConfig(
          manifest as unknown as { macro_agent?: Record<string, unknown> }
        );
        if (workspaceConfig) {
          const { YamlDrivenTopology } = await import(
            "../workspace/topology/yaml-driven.js"
          );
          const policy = new YamlDrivenTopology(workspaceConfig);
          agentManager.setTopologyPolicy(policy);

          // Kick the topology's onTeamStart so team-root streams get
          // created before any agents spawn.
          await policy.onTeamStart({
            teamName: name,
            teamInstanceId: `${name}-${this.instanceCounter + 1}`,
            workspaceConfig,
            workspaceManager,
          });
        }
      } catch (err) {
        // Non-fatal: topology wiring is a progressive enhancement. Log and
        // fall through to legacy capability-based dispatch.
        console.warn(
          `[TeamManagerV2] topology auto-wire skipped for team "${name}": ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    }

    // Create runtime
    const runtimeServices: TeamServicesV2 = {
      agentManager,
      inboxAdapter,
      tasksAdapter,
      workspaceManager,
    };
    const runtime = new TeamRuntimeV2(manifest, runtimeServices);

    // Generate instance ID
    const instanceId = `${name}-${++this.instanceCounter}`;

    // Initialize and bootstrap
    await runtime.initialize({ teamInstanceId: instanceId });
    const result = await runtime.bootstrap();

    // Register filters via composite methods (not set — avoids overwrite)
    inboxAdapter.addSignalFilter(instanceId, runtime.createSignalFilter());
    inboxAdapter.addEmissionValidator(instanceId, runtime.createEmissionValidator());

    // Build instance
    const instance: TeamInstance = {
      id: instanceId,
      templateName: name,
      runtime,
      result,
    };

    // Track in instances map
    this.instances.set(instanceId, instance);

    // Map bootstrap agents to this team
    this.agentTeamMap.set(result.rootId, instance);
    for (const companionId of result.companionIds) {
      this.agentTeamMap.set(companionId, instance);
    }

    return instanceId;
  }

  /**
   * Stop a team instance.
   *
   * Tears down the runtime, removes signal filters/validators,
   * and clears agent mappings.
   */
  async stopTeam(instanceId: string): Promise<void> {
    const instance = this.instances.get(instanceId);
    if (!instance) return;

    // Teardown runtime
    await instance.runtime.teardown();

    // Remove filters
    this.services.inboxAdapter.removeSignalFilter(instanceId);
    this.services.inboxAdapter.removeEmissionValidator(instanceId);

    // Clear agent mappings for this team
    for (const [agentId, team] of this.agentTeamMap) {
      if (team === instance) {
        this.agentTeamMap.delete(agentId);
      }
    }

    // Remove from instances
    this.instances.delete(instanceId);
  }

  /**
   * Stop all active teams and uninstall.
   */
  async teardownAll(): Promise<void> {
    const instanceIds = [...this.instances.keys()];
    for (const id of instanceIds) {
      await this.stopTeam(id);
    }
    this.uninstall();
  }

  // ─────────────────────────────────────────────────────────────
  // Queries
  // ─────────────────────────────────────────────────────────────

  /** Get the team instance an agent belongs to. */
  getTeamForAgent(agentId: string): TeamInstance | undefined {
    return this.agentTeamMap.get(agentId);
  }

  /** Get a team instance by ID. */
  getInstance(id: string): TeamInstance | undefined {
    return this.instances.get(id);
  }

  /** Get all active team instances. */
  getInstances(): TeamInstance[] {
    return [...this.instances.values()];
  }

  /** Whether any team is currently active. */
  hasActiveTeam(): boolean {
    return this.instances.size > 0;
  }

  // ─────────────────────────────────────────────────────────────
  // Private: Composite Spawn Interceptor
  // ─────────────────────────────────────────────────────────────

  private createCompositeSpawnInterceptor(): SpawnInterceptor {
    return (
      options: SpawnAgentOptions
    ): SpawnAgentOptions | Promise<SpawnAgentOptions> => {
      // Find the parent's team
      const parentId = options.parent;
      if (!parentId) return options;

      const parentTeam = this.agentTeamMap.get(parentId);
      if (!parentTeam) return options;

      // Delegate to team's spawn interceptor
      const teamInterceptor = parentTeam.runtime.createSpawnInterceptor();
      return teamInterceptor(options);
    };
  }
}
