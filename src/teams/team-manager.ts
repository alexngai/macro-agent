/**
 * Team Manager
 *
 * Central owner of team instance lifecycle. Holds active team instances,
 * manages composite dispatch of spawn interceptors, signal filters, and
 * emission validators to the correct TeamRuntime.
 *
 * Supports multiple concurrent teams (Option A). Each team instance has
 * its own runtime, agent-to-team mapping, and cached filter/validator.
 *
 * @module teams/team-manager
 */

import type { SpawnInterceptor } from "../agent/agent-manager.js";
import type {
  SignalFilter,
  EmissionValidator,
} from "../router/message-router.js";
import type { AgentId } from "../store/types/index.js";
import { loadTeam } from "./team-loader.js";
import { TeamRuntime, type TeamServices, type TeamBootstrapResult } from "./team-runtime.js";

// =============================================================================
// Types
// =============================================================================

export interface TeamInstance {
  /** Unique instance ID (format: "{templateName}-{counter}") */
  id: string;
  /** Team template name */
  templateName: string;
  /** The running TeamRuntime */
  runtime: TeamRuntime;
  /** Bootstrap result (root + companion agent IDs) */
  result: TeamBootstrapResult;
}

// =============================================================================
// TeamManager
// =============================================================================

export class TeamManager {
  /** Active team instances by instance ID */
  private instances = new Map<string, TeamInstance>();

  /** Agent ID → instance ID mapping (cache for fast lookup) */
  private agentToTeam = new Map<string, string>();

  /** Monotonic counter for instance ID generation */
  private instanceCounter = 0;

  /** Lifecycle event unsubscribe function */
  private lifecycleUnsubscribe?: () => void;

  /** Cached composite interceptor/filter/validator per instance */
  private cachedInterceptors = new Map<string, SpawnInterceptor>();
  private cachedFilters = new Map<string, SignalFilter | null>();
  private cachedValidators = new Map<string, EmissionValidator | null>();

  constructor(private readonly services: TeamServices) {}

  // ─────────────────────────────────────────────────────────────
  // Team Lifecycle
  // ─────────────────────────────────────────────────────────────

  /**
   * Start a team from a template.
   *
   * Loads the team template, creates a TeamRuntime, initializes and bootstraps.
   * Multiple teams can run concurrently.
   *
   * @param templateName - Team template directory name
   * @param basePath - Project root (default: process.cwd())
   * @returns The created team instance
   */
  async startTeam(templateName: string, basePath?: string): Promise<TeamInstance> {
    const instanceId = `${templateName}-${++this.instanceCounter}`;

    const roleRegistry = this.services.agentManager.getRoleRegistry();
    const manifest = await loadTeam(templateName, roleRegistry, basePath);
    const runtime = new TeamRuntime(manifest, this.services);

    await runtime.initialize({ teamInstanceId: instanceId });

    let result: TeamBootstrapResult;
    try {
      result = await runtime.bootstrap();
    } catch (err) {
      await runtime.teardown();
      throw err;
    }
    const instance: TeamInstance = { id: instanceId, templateName, runtime, result };

    this.instances.set(instanceId, instance);

    // Populate agent-to-team mapping for bootstrap agents
    this.agentToTeam.set(result.rootId, instanceId);
    for (const companionId of result.companionIds) {
      this.agentToTeam.set(companionId, instanceId);
    }

    // Tag bootstrap agents with team_instance in EventStore for durability
    const { eventStore } = this.services;
    if (eventStore.updateAgentMetadata) {
      const agentIds = [result.rootId, ...result.companionIds];
      for (const agentId of agentIds) {
        eventStore.updateAgentMetadata(agentId as AgentId, { team_instance: instanceId });
      }
    }

    // Cache factory outputs for composite dispatch
    this.cachedInterceptors.set(instanceId, runtime.createSpawnInterceptor());
    this.cachedFilters.set(instanceId, runtime.createSignalFilter());
    this.cachedValidators.set(instanceId, runtime.createEmissionValidator());

    return instance;
  }

  /**
   * Stop a running team instance.
   *
   * Tears down the TeamRuntime, cleans up agent-to-team mapping,
   * and removes cached interceptors/filters.
   */
  async stopTeam(instanceId: string): Promise<void> {
    const instance = this.instances.get(instanceId);
    if (!instance) {
      throw new Error(`No team instance '${instanceId}' found`);
    }

    await instance.runtime.teardown();

    // Clean up agent-to-team mapping
    for (const [agentId, team] of this.agentToTeam) {
      if (team === instanceId) {
        this.agentToTeam.delete(agentId);
      }
    }

    // Clean up caches
    this.cachedInterceptors.delete(instanceId);
    this.cachedFilters.delete(instanceId);
    this.cachedValidators.delete(instanceId);

    this.instances.delete(instanceId);
  }

  /**
   * Tear down all running team instances and clean up.
   *
   * Also removes the lifecycle listener for spawn tracking.
   */
  async teardownAll(): Promise<void> {
    const ids = [...this.instances.keys()];
    for (const id of ids) {
      await this.stopTeam(id);
    }

    if (this.lifecycleUnsubscribe) {
      this.lifecycleUnsubscribe();
      this.lifecycleUnsubscribe = undefined;
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Agent-Team Mapping
  // ─────────────────────────────────────────────────────────────

  /**
   * Look up which team instance an agent belongs to.
   */
  getTeamForAgent(agentId: string): TeamInstance | undefined {
    const instanceId = this.agentToTeam.get(agentId);
    return instanceId ? this.instances.get(instanceId) : undefined;
  }

  /**
   * Get a team instance by ID.
   */
  getInstance(instanceId: string): TeamInstance | undefined {
    return this.instances.get(instanceId);
  }

  /**
   * Get all active team instances.
   */
  getInstances(): TeamInstance[] {
    return [...this.instances.values()];
  }

  /**
   * Check if any team is currently running.
   */
  hasActiveTeam(): boolean {
    return this.instances.size > 0;
  }

  // ─────────────────────────────────────────────────────────────
  // Composite Installation
  // ─────────────────────────────────────────────────────────────

  /**
   * Install composite spawn interceptor, signal filter, and emission
   * validator on the shared services.
   *
   * These composites delegate to the correct TeamRuntime based on
   * agent-to-team mapping. Also sets up a lifecycle listener to
   * auto-register newly spawned agents.
   */
  install(): void {
    const { agentManager, messageRouter } = this.services;

    // Composite spawn interceptor
    agentManager.setSpawnInterceptor(async (options) => {
      if (!options.parent) return options; // No parent — pass through

      const parentTeam = this.getTeamForAgent(options.parent);
      if (!parentTeam) return options; // Parent not in any team

      const interceptor = this.cachedInterceptors.get(parentTeam.id);
      const result = interceptor ? await interceptor(options) : options;
      // Tag spawned agent with team instance for durable tracking
      return { ...result, team_instance: parentTeam.id };
    });

    // Composite signal filter
    if (messageRouter.setSignalFilter) {
      messageRouter.setSignalFilter((from, to, signal) => {
        // Use the recipient's team filter (signals are filtered at delivery point)
        const recipientTeam = this.getTeamForAgent(to as string);
        const senderTeam = this.getTeamForAgent(from as string);
        const team = recipientTeam ?? senderTeam;

        if (team) {
          const filter = this.cachedFilters.get(team.id);
          if (filter) return filter(from, to, signal);
        }

        return true; // No team context — allow
      });
    }

    // Composite emission validator
    if (messageRouter.setEmissionValidator) {
      messageRouter.setEmissionValidator((agentId, signal) => {
        const senderTeam = this.getTeamForAgent(agentId as string);
        if (senderTeam) {
          const validator = this.cachedValidators.get(senderTeam.id);
          if (validator) return validator(agentId, signal);
        }
        return { action: "allow" as const };
      });
    }

    // Set up lifecycle listener for auto-registering spawned agents
    this.setupLifecycleListener();
  }

  /**
   * Uninstall composite interceptor and filters from shared services.
   */
  uninstall(): void {
    this.services.agentManager.setSpawnInterceptor(null);

    if (this.lifecycleUnsubscribe) {
      this.lifecycleUnsubscribe();
      this.lifecycleUnsubscribe = undefined;
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Lifecycle Listener
  // ─────────────────────────────────────────────────────────────

  /**
   * Listen for agent lifecycle events to auto-register newly spawned
   * agents in the agent-to-team mapping.
   *
   * When an agent is spawned, check if its parent belongs to a team.
   * If so, register the new agent in the same team.
   */
  private setupLifecycleListener(): void {
    if (this.lifecycleUnsubscribe) return; // Already listening

    this.lifecycleUnsubscribe = this.services.agentManager.onLifecycleEvent((event) => {
      if (event.type !== "spawned") return;

      const agent = event.agent;
      if (!agent.parent) return; // No parent — bootstrap agents handled explicitly

      const parentTeam = this.getTeamForAgent(agent.parent);
      if (!parentTeam) return; // Parent not in any team

      // Register agent in the same team as its parent
      this.agentToTeam.set(agent.id, parentTeam.id);

      // Also register in the TeamRuntime's internal maps (for filter lookups)
      if (agent.role) {
        parentTeam.runtime.registerAgent(agent.id as AgentId, agent.role);
      }
    });
  }
}
