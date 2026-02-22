/**
 * Team Runtime
 *
 * Wires a loaded team template into the running system: registers roles,
 * sets up integration strategy, configures communication topology,
 * and manages the team lifecycle.
 *
 * @module teams/team-runtime
 */

import type { EventStore } from "../store/event-store.js";
import type { MessageRouter } from "../router/message-router.js";
import type { AgentManager, SpawnInterceptor } from "../agent/agent-manager.js";
import type {
  SignalFilter,
  EmissionValidator,
  EmissionValidatorResult,
} from "../router/message-router.js";
import type { RoleRegistry } from "../roles/types.js";
import type { SpawnAgentOptions } from "../agent/types.js";
import type { AgentId } from "../store/types/index.js";
import type {
  TeamManifest,
  MacroResolvedTemplate,
  McpServerEntry,
  PeerConnection,
} from "./types.js";
import type { IntegrationStrategy } from "../workspace/strategies/types.js";
import { WORKSPACE_CAPABILITIES } from "../roles/capabilities.js";

// =============================================================================
// Types
// =============================================================================

export interface TeamServices {
  agentManager: AgentManager;
  messageRouter: MessageRouter;
  eventStore: EventStore;
  /** Optional workspace manager for merge queue wiring */
  workspaceManager?: import("../workspace/types.js").WorkspaceManager;
  /** Optional task backend for auto-scaling queue depth checks */
  taskBackend?: import("../task/backend/types.js").TaskBackend;
}

export interface TeamBootstrapResult {
  rootId: string;
  companionIds: string[];
}

// =============================================================================
// Conversion: TeamManifest → MacroResolvedTemplate
// =============================================================================

/**
 * Convert a legacy TeamManifest (with _ prefixed fields) to MacroResolvedTemplate.
 * Used for backward compatibility when TeamRuntime receives a TeamManifest.
 */
function manifestToResolved(manifest: TeamManifest): MacroResolvedTemplate {
  return {
    template: {
      manifest: {
        name: manifest.name,
        description: manifest.description,
        version: manifest.version,
        roles: manifest.roles,
        topology: manifest.topology,
        communication: manifest.communication,
      },
      roles: new Map(), // Not used — macro-agent uses resolvedRoles
      prompts: new Map(), // Prompts are in _loadedPrompts
      mcpServers: manifest._mcpServers,
      sourcePath: "",
    },
    resolvedRoles: manifest._resolvedRoles,
    macroAgent: manifest.macro_agent,
  };
}

/**
 * Check if input is a MacroResolvedTemplate (has `template` field)
 * vs a legacy TeamManifest (has `_resolvedRoles` field).
 */
function isMacroResolvedTemplate(
  input: TeamManifest | MacroResolvedTemplate
): input is MacroResolvedTemplate {
  return "template" in input && "resolvedRoles" in input;
}

// =============================================================================
// TeamRuntime
// =============================================================================

export class TeamRuntime {
  private rootAgentId?: string;
  private companionAgentIds: string[] = [];
  private roleRegistry: RoleRegistry;
  private lifecycleUnsubscribe?: () => void;
  private integrationStrategy?: IntegrationStrategy;
  private scalingTimer?: ReturnType<typeof setInterval>;
  private lastScaleUpTime = 0;
  private teamStreamId?: string;
  private mergeQueueUnsub?: () => void;
  private mergeRequestPollTimer?: ReturnType<typeof setInterval>;
  private lastMergeRequestSeen = 0;

  /** The resolved template (canonical internal representation) */
  private readonly resolved: MacroResolvedTemplate;

  /** Legacy loaded prompts map (path → content) for backward compat */
  private readonly loadedPrompts: Map<string, string>;

  /** Role name → spawned agent ID mapping (populated during bootstrap) */
  private roleAgentMap = new Map<string, AgentId>();

  /** Peer connections that couldn't be wired at bootstrap (target role not yet spawned) */
  private pendingPeerRoutes: PeerConnection[] = [];

  /** Per-agent signal filters from peer connections. Key: "fromAgentId→toAgentId" */
  private peerSignalFilters = new Map<string, string[]>();

  /** Reverse mapping: agent ID → role name (for signal filter lookups) */
  private agentRoleMap = new Map<AgentId, string>();

  /** Pre-computed per-role allowed signals from channel subscriptions */
  private roleAllowedSignals = new Map<string, Set<string> | "all">();

  /** Lifecycle unsubscribe for deferred peer wiring */
  private peerWiringUnsubscribe?: () => void;

  /**
   * Create a TeamRuntime.
   *
   * Accepts either a MacroResolvedTemplate (new) or a TeamManifest (legacy).
   * Internally always uses MacroResolvedTemplate.
   */
  constructor(
    input: TeamManifest | MacroResolvedTemplate,
    private readonly services: TeamServices
  ) {
    this.resolved = isMacroResolvedTemplate(input)
      ? input
      : manifestToResolved(input);

    // Extract loaded prompts from legacy manifest if available
    this.loadedPrompts = !isMacroResolvedTemplate(input)
      ? input._loadedPrompts
      : new Map();

    this.roleRegistry = services.agentManager.getRoleRegistry();
  }

  // Convenience accessors
  private get manifest() {
    return this.resolved.template.manifest;
  }

  private get communication() {
    return (this.manifest.communication ?? {}) as NonNullable<typeof this.manifest.communication>;
  }

  // ─────────────────────────────────────────────────────────────
  // Initialization
  // ─────────────────────────────────────────────────────────────

  /**
   * Wire team configuration into running services.
   *
   * 1. Register team roles into RoleRegistry
   * 2. Store team_config event in EventStore (for MCP subprocess discovery)
   * 3. Instantiate integration strategy
   *
   * Note: Does NOT install spawn interceptor, signal filter, or emission
   * validator on services. Call installOnServices() for standalone use,
   * or let TeamManager handle composite installation.
   */
  async initialize(options?: { teamInstanceId?: string }): Promise<void> {
    const { eventStore } = this.services;

    // 1. Register team roles into RoleRegistry (custom layer, highest priority)
    for (const [, resolved] of this.resolved.resolvedRoles) {
      const rd = resolved.roleDefinition;
      const existing = this.roleRegistry.getRole(rd.name);
      if (existing) {
        const existingCaps = [...existing.capabilities].sort();
        const newCaps = [...rd.capabilities].sort();
        if (existingCaps.length !== newCaps.length || existingCaps.some((c, i) => c !== newCaps[i])) {
          console.warn(
            `[TeamRuntime] Role '${rd.name}' conflict: team '${this.manifest.name}' re-registers with different capabilities. ` +
            `Existing: [${existingCaps.join(", ")}], New: [${newCaps.join(", ")}]`
          );
        }
      }
      this.roleRegistry.registerRole(rd);
    }

    // 2. Store team config in EventStore for cross-process access (RD2)
    const taskMode = this.resolved.macroAgent.task_assignment?.mode ?? "push";
    const strategyName = this.resolved.macroAgent.integration?.strategy ?? "queue";
    const strategyConfig = this.resolved.macroAgent.integration?.config ?? {};
    const enforcement = this.communication.enforcement ?? "permissive";

    // Serialize resolved roles for MCP subprocess capability checks
    const serializedRoles: Record<string, { name: string; capabilities: string[]; tools?: object; lifecycle?: object; description?: string }> = {};
    for (const [name, resolved] of this.resolved.resolvedRoles) {
      const rd = resolved.roleDefinition;
      serializedRoles[name] = {
        name: rd.name,
        capabilities: [...rd.capabilities],
        ...(rd.tools && { tools: rd.tools }),
        ...(rd.lifecycle && { lifecycle: rd.lifecycle }),
        ...(rd.description && { description: rd.description }),
      };
    }

    eventStore.emit({
      type: "status",
      source: { agent_id: "system" },
      payload: {
        status_type: "discovery",
        summary: `Team '${this.manifest.name}' initialized`,
        team_config: {
          teamName: this.manifest.name,
          ...(options?.teamInstanceId && { team_instance: options.teamInstanceId }),
          strategy: strategyName,
          strategyConfig,
          taskMode,
          enforcement,
          roles: serializedRoles,
          peerRoutes: this.communication.routing?.peers ?? [],
          emissions: this.communication.emissions ?? {},
        },
      },
    });

    await eventStore.persist();

    // 3. Instantiate integration strategy and call lifecycle hook
    try {
      const { defaultStrategyRegistry } = await import("../workspace/strategies/registry.js");
      this.integrationStrategy = defaultStrategyRegistry.get(strategyName, strategyConfig as Record<string, unknown>);
      if (this.integrationStrategy.initialize) {
        await this.integrationStrategy.initialize();
      }

      // Wire merge queue to queue strategy if workspace manager is available
      if (
        this.services.workspaceManager &&
        strategyName === "queue" &&
        "setMergeQueue" in this.integrationStrategy
      ) {
        const mergeQueue = this.services.workspaceManager.getMergeQueue();
        (this.integrationStrategy as { setMergeQueue(q: typeof mergeQueue): void }).setMergeQueue(mergeQueue);
      }
    } catch {
      // Strategy instantiation is best-effort — queue strategy needs merge queue set later
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Bootstrap
  // ─────────────────────────────────────────────────────────────

  /**
   * Spawn root and companion agents per the team topology.
   *
   * Populates internal state (agentRoleMap, peerSignalFilters) used by
   * createSignalFilter() and createEmissionValidator(). Call installOnServices()
   * after bootstrap for standalone use, or let TeamManager handle installation.
   */
  async bootstrap(): Promise<TeamBootstrapResult> {
    const { agentManager } = this.services;
    const { topology } = this.manifest;

    // 1. Spawn root agent
    const rootPrompt = this.getPromptForTopologyNode(topology.root);
    const root = await agentManager.spawn({
      task: rootPrompt
        ? `[${this.manifest.name}] ${topology.root.role}`
        : `Team ${this.manifest.name} root: ${topology.root.role}`,
      parent: null,
      role: topology.root.role,
      config: {
        model: topology.root.config?.model,
      },
      customPrompt: rootPrompt,
      interactionPatterns: this.getInteractionPatterns(),
    });
    this.rootAgentId = root.id;

    // 1b. Set up workspace integration BEFORE companions spawn,
    // so the spawn interceptor has teamStreamId for workspace injection
    this.setupWorkspaceIntegration(root.id as AgentId);

    // 2. Spawn companions (peers, not children)
    const companionIds: string[] = [];
    for (const companion of topology.companions ?? []) {
      const companionPrompt = this.getPromptForTopologyNode(companion);
      const agent = await agentManager.spawn({
        task: `[${this.manifest.name}] ${companion.role}`,
        parent: null,
        role: companion.role,
        config: {
          model: companion.config?.model,
        },
        customPrompt: companionPrompt,
        interactionPatterns: this.getInteractionPatterns(),
      });
      companionIds.push(agent.id);
    }
    this.companionAgentIds = companionIds;

    // 3. Build role↔agent mappings and wire peer subscriptions
    this.roleAgentMap.set(topology.root.role, root.id as AgentId);
    this.agentRoleMap.set(root.id as AgentId, topology.root.role);
    for (let i = 0; i < (topology.companions ?? []).length; i++) {
      this.roleAgentMap.set(topology.companions![i].role, companionIds[i] as AgentId);
      this.agentRoleMap.set(companionIds[i] as AgentId, topology.companions![i].role);
    }
    this.wirePeerRoutes();

    // 4. Pre-compute role allowed signals (used by createSignalFilter)
    this.computeRoleAllowedSignals();

    // 5. Set up continuation monitoring for daemon agents (P4.2)
    this.monitorContinuations();

    // 6. Set up auto-scaling monitoring
    this.monitorScaling();

    return {
      rootId: root.id,
      companionIds,
    };
  }

  // ─────────────────────────────────────────────────────────────
  // Teardown
  // ─────────────────────────────────────────────────────────────

  /**
   * Tear down team: stop continuation monitoring, clean up strategy.
   *
   * Note: Does NOT clear spawn interceptor or filters on services.
   * The caller (TeamManager or standalone code) is responsible for
   * removing the interceptor/filters from shared services.
   */
  async teardown(): Promise<void> {
    if (this.lifecycleUnsubscribe) {
      this.lifecycleUnsubscribe();
      this.lifecycleUnsubscribe = undefined;
    }
    if (this.peerWiringUnsubscribe) {
      this.peerWiringUnsubscribe();
      this.peerWiringUnsubscribe = undefined;
    }
    if (this.scalingTimer) {
      clearInterval(this.scalingTimer);
      this.scalingTimer = undefined;
    }
    if (this.mergeQueueUnsub) {
      this.mergeQueueUnsub();
      this.mergeQueueUnsub = undefined;
    }
    if (this.mergeRequestPollTimer) {
      clearInterval(this.mergeRequestPollTimer);
      this.mergeRequestPollTimer = undefined;
    }
    // Call strategy lifecycle close hook
    if (this.integrationStrategy?.close) {
      try {
        await this.integrationStrategy.close();
      } catch {
        // Best-effort cleanup
      }
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Getters
  // ─────────────────────────────────────────────────────────────

  /** Get task assignment mode */
  getTaskMode(): "push" | "pull" {
    return this.resolved.macroAgent.task_assignment?.mode ?? "push";
  }

  /** Get integration strategy name */
  getStrategyName(): string {
    return this.resolved.macroAgent.integration?.strategy ?? "queue";
  }

  /** Get the active manifest (for API) */
  getManifest(): TeamManifest {
    // Build a backward-compatible TeamManifest from the resolved template
    return {
      ...this.manifest,
      description: this.manifest.description ?? "",
      communication: this.communication,
      macro_agent: this.resolved.macroAgent,
      _resolvedRoles: this.resolved.resolvedRoles,
      _loadedPrompts: this.loadedPrompts,
      _mcpServers: this.resolved.template.mcpServers,
    } as TeamManifest;
  }

  /** Get the resolved template */
  getResolvedTemplate(): MacroResolvedTemplate {
    return this.resolved;
  }

  /** Get root agent ID (after bootstrap) */
  getRootAgentId(): string | undefined {
    return this.rootAgentId;
  }

  /** Get companion agent IDs (after bootstrap) */
  getCompanionAgentIds(): string[] {
    return [...this.companionAgentIds];
  }

  /** Get the instantiated integration strategy (after initialize) */
  getIntegrationStrategy(): IntegrationStrategy | undefined {
    return this.integrationStrategy;
  }

  /** Get team-wide integration stream ID (after bootstrap) */
  getTeamStreamId(): string | undefined {
    return this.teamStreamId;
  }

  /** Get signal filters for peer connections (for use by signal filtering - i-3o8g) */
  getPeerSignalFilters(): ReadonlyMap<string, string[]> {
    return this.peerSignalFilters;
  }

  /** Get the agent → role mapping (for TeamManager agent-team lookups) */
  getAgentRoleMap(): ReadonlyMap<AgentId, string> {
    return this.agentRoleMap;
  }

  /** Register an agent's role mapping (for TeamManager to track dynamically spawned agents) */
  registerAgent(agentId: AgentId, roleName: string): void {
    this.agentRoleMap.set(agentId, roleName);
    this.roleAgentMap.set(roleName, agentId);
  }

  /** Check if this team owns a given agent */
  hasAgent(agentId: string): boolean {
    return this.agentRoleMap.has(agentId as AgentId);
  }

  // ─────────────────────────────────────────────────────────────
  // Continuation Monitoring (P4.2)
  // ─────────────────────────────────────────────────────────────

  /**
   * Monitor agent lifecycle events for auto-continuation of daemon agents.
   *
   * When a root or companion agent terminates unexpectedly and the team's
   * lifecycle config enables continuations, automatically spawn a continuation.
   */
  private monitorContinuations(): void {
    const lifecycleConfig = this.resolved.macroAgent.lifecycle;
    if (!lifecycleConfig?.continuations?.enabled) return;

    const { agentManager } = this.services;
    const monitoredAgents = new Set([
      this.rootAgentId,
      ...this.companionAgentIds,
    ]);

    this.lifecycleUnsubscribe = agentManager.onLifecycleEvent((event) => {
      if (event.type !== "stopped") return;
      if (!monitoredAgents.has(event.agent.id)) return;

      // Only auto-continue on unexpected stops (not explicit completion)
      const reason = (event as { reason?: string }).reason;
      if (reason === "completed" || reason === "cancelled") return;

      // Schedule auto-continuation (async, fire-and-forget)
      setTimeout(async () => {
        try {
          const newAgent = await agentManager.continueAgent(event.agent.id);
          // Update monitoring set
          monitoredAgents.delete(event.agent.id);
          monitoredAgents.add(newAgent.id);

          if (event.agent.id === this.rootAgentId) {
            this.rootAgentId = newAgent.id;
          } else {
            const idx = this.companionAgentIds.indexOf(event.agent.id);
            if (idx >= 0) {
              this.companionAgentIds[idx] = newAgent.id;
            }
          }
        } catch {
          // Failed to continue — agent is gone
        }
      }, 1000);
    });
  }

  // ─────────────────────────────────────────────────────────────
  // Auto-Scaling
  // ─────────────────────────────────────────────────────────────

  /** Minimum interval between scale-up actions (ms) */
  private static readonly SCALE_COOLDOWN_MS = 10_000;

  /** Default scaling check interval (ms) */
  private static readonly SCALE_CHECK_INTERVAL_MS = 5_000;

  /**
   * Monitor task queue depth and auto-scale workers.
   *
   * Follows the same lifecycle pattern as monitorContinuations().
   * Only active when `scaling.scale_on === "task_queue_depth"` and
   * a task backend is available.
   */
  private monitorScaling(): void {
    const scalingConfig = this.resolved.macroAgent.lifecycle?.scaling;
    if (!scalingConfig || scalingConfig.scale_on !== "task_queue_depth") return;

    const { taskBackend } = this.services;
    if (!taskBackend?.listClaimable) return; // Need claimable task counting

    const maxWorkers = scalingConfig.max_workers ?? Infinity;
    const minWorkers = scalingConfig.min_workers ?? 0;

    // Determine which role names are worker-derived (for counting active workers)
    const workerRoleNames = new Set<string>();
    for (const [name, resolved] of this.resolved.resolvedRoles) {
      if (resolved.baseRole === "worker") {
        workerRoleNames.add(name);
      }
    }
    if (workerRoleNames.size === 0) return; // No worker roles to scale

    // Pick the first worker role for spawning (most common pattern: single worker role)
    const spawnRole = [...workerRoleNames][0];

    this.scalingTimer = setInterval(async () => {
      try {
        // Count claimable tasks
        const claimable = await taskBackend.listClaimable!();
        const pendingCount = claimable.length;

        // Count active workers in this team
        const allAgents = this.services.agentManager.list({ state: "running" });
        let activeWorkers = 0;
        for (const agent of allAgents) {
          if (agent.role && workerRoleNames.has(agent.role) && this.agentRoleMap.has(agent.id as AgentId)) {
            activeWorkers++;
          }
        }

        // Scale up: more pending tasks than active workers, under max cap
        if (pendingCount > activeWorkers && activeWorkers < maxWorkers) {
          const now = Date.now();
          if (now - this.lastScaleUpTime < TeamRuntime.SCALE_COOLDOWN_MS) {
            return; // Cooldown not elapsed
          }

          if (!this.rootAgentId) return; // No root to spawn from

          try {
            await this.services.agentManager.spawn({
              task: `[${this.manifest.name}] auto-scaled ${spawnRole}`,
              role: spawnRole,
              parent: this.rootAgentId,
            });
            this.lastScaleUpTime = now;

            // Emit scaling event for observability
            this.services.eventStore.emit({
              type: "status",
              source: { agent_id: "system" },
              payload: {
                status_type: "scaling",
                summary: `Auto-scaled: spawned ${spawnRole} (pending=${pendingCount}, active=${activeWorkers}, max=${maxWorkers})`,
              },
            });
          } catch {
            // Spawn failed — will retry on next tick
          }
        }

        // Scale down is handled by idle_drain: workers self-terminate after idle_timeout_s
        // No active termination needed from the scaling monitor
      } catch {
        // Best-effort — don't crash the scaling loop
      }
    }, TeamRuntime.SCALE_CHECK_INTERVAL_MS);

    // Ensure timer doesn't prevent process exit
    if (this.scalingTimer.unref) {
      this.scalingTimer.unref();
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Workspace Integration
  // ─────────────────────────────────────────────────────────────

  /**
   * Create the team-wide integration stream and subscribe to merge queue events.
   *
   * When a worker submits to the merge queue, the integrator agent is
   * automatically prompted to process it.
   */
  private setupWorkspaceIntegration(rootAgentId: AgentId): void {
    const { workspaceManager } = this.services;
    if (!workspaceManager || !this.integrationStrategy) return;

    // Create integration stream owned by root agent
    try {
      this.teamStreamId = workspaceManager.createIntegrationStream(
        rootAgentId,
        { name: this.manifest.name, forkFrom: "main" }
      );
    } catch {
      // Workspace isolation unavailable (e.g., not a git repo)
      return;
    }

    // Subscribe to merge queue events — wake integrator on mr:submitted
    try {
      const mergeQueue = workspaceManager.getMergeQueue();
      if (mergeQueue?.onEvent) {
        this.mergeQueueUnsub = mergeQueue.onEvent((event) => {
          if (event.type !== "mr:submitted") return;

          // Find agent with workspace.integrate capability in this team
          for (const [agentId, roleName] of this.agentRoleMap) {
            const resolved = this.resolved.resolvedRoles.get(roleName);
            const caps = resolved?.capabilities ?? [];
            if (caps.includes(WORKSPACE_CAPABILITIES.INTEGRATE)) {
              try {
                this.services.agentManager.prompt(
                  agentId,
                  `Merge request ${(event as { data?: Record<string, unknown> }).data?.mrId} submitted ` +
                  `by worker ${(event as { data?: Record<string, unknown> }).data?.workerAgentId} ` +
                  `for branch ${(event as { data?: Record<string, unknown> }).data?.workerBranch}. ` +
                  `Process the merge queue.`
                );
              } catch {
                // Best-effort wake
              }
              break;
            }
          }
        });
      }
    } catch {
      // Merge queue not available — workspace isolation without merge queue
    }

    // Poll EventStore for MERGE_REQUEST signals from worker subprocesses.
    // Workers in MCP subprocess emit to shared SQLite; main process must reload to see them.
    this.startMergeRequestPolling();
  }

  /**
   * Poll EventStore for MERGE_REQUEST signals emitted by worker subprocesses.
   *
   * Workers call done() in their MCP subprocess, which emits MERGE_REQUEST to
   * the shared EventStore. This polling picks up those signals and submits to
   * the merge queue on the main server.
   */
  private startMergeRequestPolling(): void {
    const { workspaceManager, eventStore } = this.services;
    if (!workspaceManager || !this.teamStreamId) return;

    const mergeQueue = workspaceManager.getMergeQueue();
    if (!mergeQueue) return;

    this.mergeRequestPollTimer = setInterval(async () => {
      try {
        // Reload to see events written by subprocesses
        if (eventStore.reload) {
          await eventStore.reload();
        }

        const events = eventStore.query({ type: "status", limit: 100 });
        for (const event of events) {
          // Skip already-processed events
          if (event.timestamp <= this.lastMergeRequestSeen) continue;

          const details = event.payload?.details as Record<string, unknown> | undefined;
          if (details?.signal !== "MERGE_REQUEST") continue;

          // Check this agent belongs to our team
          const sourceAgentId = event.source?.agent_id;
          if (!sourceAgentId) continue;

          // Check if agent is a team member OR a child of a team member
          const isTeamMember = this.agentRoleMap.has(sourceAgentId as AgentId);
          const parentAgent = eventStore.getAgent(sourceAgentId);
          const isChildOfTeamMember = parentAgent?.parent
            ? this.agentRoleMap.has(parentAgent.parent as AgentId)
            : false;

          if (!isTeamMember && !isChildOfTeamMember) continue;

          this.lastMergeRequestSeen = event.timestamp;

          // Extract merge request details
          const sourceBranch = details.sourceBranch as string | undefined;
          const taskId = details.taskId as string | undefined;
          const workerId = details.workerId as string | undefined;

          if (!sourceBranch || !workerId) continue;

          // Submit to merge queue
          try {
            mergeQueue.submit({
              streamId: this.teamStreamId!,
              taskId: taskId ?? `task-${workerId}`,
              workerBranch: sourceBranch,
              workerAgentId: workerId,
            });
          } catch {
            // Already submitted or other error — best-effort
          }
        }
      } catch {
        // Best-effort polling
      }
    }, 2000);

    if (this.mergeRequestPollTimer.unref) {
      this.mergeRequestPollTimer.unref();
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Spawn Interceptor
  // ─────────────────────────────────────────────────────────────

  /**
   * Internal: Create the spawn interceptor that injects team context into spawn options.
   */
  private _createSpawnInterceptor(): SpawnInterceptor {
    return (options: SpawnAgentOptions): SpawnAgentOptions => {
      const roleName = options.role;
      if (!roleName) return options;

      const resolved = this.resolved.resolvedRoles.get(roleName);
      if (!resolved) return options; // Unknown role — pass through

      // Compute topics from communication topology
      const teamTopics = this.getTopicsForRole(roleName);

      // Get MCP servers for this role
      const teamMcpServers = this.getMcpServersForRole(roleName);

      // Get prompt from role definition or topology
      const teamPrompt = this.getPromptForRole(roleName);

      // Build team env vars
      const teamEnv: Record<string, string> = {
        MACRO_TEAM_NAME: this.manifest.name,
        MACRO_TASK_MODE: this.getTaskMode(),
      };
      const strategyName = this.getStrategyName();
      if (strategyName) {
        teamEnv.MACRO_INTEGRATION_STRATEGY = strategyName;
      }
      // Task backend config is propagated by AgentManager.buildMacroAgentMcp()
      // from its taskBackend/openTasksSocketPath config options.

      // Inject workspace fields based on capabilities (never overwrite explicit values)
      const capabilities = resolved.capabilities;
      let streamId = options.streamId;
      let streamConfig = options.streamConfig;
      let dataplaneTaskId = options.dataplaneTaskId;

      if (this.teamStreamId && capabilities) {
        if (capabilities.includes(WORKSPACE_CAPABILITIES.WORKTREE)) {
          streamId = streamId ?? this.teamStreamId;
          // Pull-mode workers use agentId as workspace identifier (one worktree per lifetime)
          dataplaneTaskId = dataplaneTaskId ?? `worker-${Date.now()}`;
        } else if (capabilities.includes(WORKSPACE_CAPABILITIES.INTEGRATE)) {
          streamId = streamId ?? this.teamStreamId;
        }
        // workspace.stream: stream creation is managed by TeamRuntime.setupWorkspaceIntegration(),
        // not auto-injected. Coordinators that need sub-streams pass explicit streamConfig.
      }

      return {
        ...options,
        // Workspace fields
        streamId,
        streamConfig,
        dataplaneTaskId,
        capabilities: capabilities ?? options.capabilities,
        // Merge topics
        topics: [
          ...(options.topics ?? []),
          ...teamTopics,
        ],
        // Merge config
        config: {
          ...options.config,
          mcpServers: [
            ...(options.config?.mcpServers ?? []),
            ...teamMcpServers.map((s) => ({
              name: s.name,
              command: s.command,
              args: s.args,
              env: s.env,
            })),
          ],
          env: {
            ...options.config?.env,
            ...teamEnv,
          },
        },
        // Set team prompt (only if not already provided by caller)
        customPrompt: options.customPrompt ?? teamPrompt,
        // Set interaction patterns (only if not already provided)
        interactionPatterns: options.interactionPatterns ?? this.getInteractionPatterns(),
      };
    };
  }

  // ─────────────────────────────────────────────────────────────
  // Communication Topology Helpers
  // ─────────────────────────────────────────────────────────────

  /**
   * Get topic names a role should subscribe to based on communication config.
   */
  private getTopicsForRole(roleName: string): string[] {
    const topics: string[] = [];
    const subs = this.communication.subscriptions?.[roleName] ?? [];

    for (const sub of subs) {
      // Channel name becomes the topic name
      if (!topics.includes(sub.channel)) {
        topics.push(sub.channel);
      }
    }

    return topics;
  }

  /**
   * Get MCP servers configured for a role.
   */
  private getMcpServersForRole(roleName: string): McpServerEntry[] {
    return this.resolved.template.mcpServers.get(roleName) ?? [];
  }

  /**
   * Get the loaded prompt content for a role.
   */
  private getPromptForRole(roleName: string): string | undefined {
    const resolved = this.resolved.resolvedRoles.get(roleName);
    if (!resolved?.prompt) return undefined;
    return this.loadedPrompts.get(resolved.prompt);
  }

  /**
   * Get the prompt for a topology node (root or companion).
   */
  private getPromptForTopologyNode(
    node: { role: string; prompt?: string }
  ): string | undefined {
    // Prefer topology-level prompt reference
    if (node.prompt) {
      return this.loadedPrompts.get(node.prompt);
    }
    // Fall back to role-level prompt
    return this.getPromptForRole(node.role);
  }

  /**
   * Generate interaction pattern injection sections based on team config.
   */
  private getInteractionPatterns(): string[] {
    const patterns: string[] = [];
    const taskMode = this.getTaskMode();

    if (taskMode === "pull") {
      const pullConfig = this.resolved.macroAgent.task_assignment?.pull;
      const idleTimeout = pullConfig?.idle_timeout_s ?? 300;

      patterns.push(`## Task Claiming

You operate in PULL mode. After completing a task:
1. Call done() with your results
2. Call claim_task() to get your next task
3. If no tasks available, wait briefly and retry
4. After ${idleTimeout} seconds idle, call done() to exit gracefully

Claim and execute independently — do not wait for instructions.`);
    }

    const strategy = this.getStrategyName();
    if (strategy === "trunk") {
      patterns.push(`## Integration

Your changes are integrated via trunk-based development. When you call done(),
your work is pushed directly to the integration branch. If there's a conflict,
the system will rebase and retry automatically. Write small, focused changes
to minimize conflict probability.`);
    } else if (strategy === "optimistic") {
      patterns.push(`## Integration

Your changes are integrated optimistically. They are pushed immediately and
validated asynchronously. If validation fails, a fixup task will be created.
Focus on correctness — your changes go live immediately.`);
    }

    return patterns;
  }

  // ─────────────────────────────────────────────────────────────
  // Exposed Interceptor / Filter / Validator Factories
  // ─────────────────────────────────────────────────────────────

  /**
   * Create the spawn interceptor for this team.
   *
   * Returns a function that injects team context (topics, MCP servers,
   * env vars, prompt, interaction patterns) into spawn options.
   * The caller (TeamManager or installOnServices) is responsible for
   * installing it on AgentManager.
   */
  createSpawnInterceptor(): SpawnInterceptor {
    return this._createSpawnInterceptor();
  }

  /**
   * Create the signal filter for this team.
   *
   * Combines two filter sources:
   * 1. Channel subscription filters (per-role, per-topic)
   * 2. Peer connection filters (per-agent-pair)
   *
   * Must be called after bootstrap() so that agentRoleMap and
   * peerSignalFilters are populated. Returns null if no filtering needed.
   */
  createSignalFilter(): SignalFilter | null {
    return (from: AgentId, to: AgentId, signal: string | undefined): boolean => {
      // Untagged status events always pass through
      if (!signal) return true;

      // Check peer connection filter (directional: from→to)
      const peerFilter = this.peerSignalFilters.get(`${from}→${to}`);
      if (peerFilter) {
        return peerFilter.includes(signal);
      }

      // Check channel subscription filter for recipient's role
      const recipientRole = this.agentRoleMap.get(to);
      if (recipientRole) {
        const allowed = this.roleAllowedSignals.get(recipientRole);
        if (allowed && allowed !== "all") {
          return allowed.has(signal);
        }
      }

      // No filter configured — allow delivery
      return true;
    };
  }

  /**
   * Create the emission validator for this team.
   *
   * Checks whether an agent's emitted signal is in its role's allowed
   * emissions list. Behavior depends on enforcement mode.
   * Returns null if no emissions config exists.
   */
  createEmissionValidator(): EmissionValidator | null {
    const emissions = this.communication.emissions;
    const enforcement = this.communication.enforcement ?? "permissive";

    // No emissions config — nothing to enforce
    if (!emissions || Object.keys(emissions).length === 0) return null;

    return (agentId: AgentId, signal: string | undefined): EmissionValidatorResult => {
      // Untagged status events are always allowed
      if (!signal) return { action: "allow" };

      const role = this.agentRoleMap.get(agentId);
      if (!role) return { action: "allow" };

      const allowedSignals = emissions[role];
      if (!allowedSignals) return { action: "allow" };

      if (allowedSignals.includes(signal)) {
        return { action: "allow" };
      }

      // Signal not in allowed list — enforce
      const message = `Agent '${agentId}' (role: ${role}) emitted disallowed signal '${signal}'. Allowed: [${allowedSignals.join(", ")}]`;

      switch (enforcement) {
        case "strict":
          return { action: "reject", message };
        case "audit":
          return { action: "audit", message };
        case "permissive":
        default:
          return { action: "warn", message };
      }
    };
  }

  /**
   * Convenience method: install interceptor, signal filter, and emission
   * validator directly on the shared services.
   *
   * Use this for standalone operation (without TeamManager).
   * TeamManager uses the individual create* methods for composite dispatch.
   */
  installOnServices(): void {
    const { agentManager, messageRouter } = this.services;

    agentManager.setSpawnInterceptor(this.createSpawnInterceptor());

    const signalFilter = this.createSignalFilter();
    if (signalFilter && messageRouter.setSignalFilter) {
      messageRouter.setSignalFilter(signalFilter);
    }

    const emissionValidator = this.createEmissionValidator();
    if (emissionValidator && messageRouter.setEmissionValidator) {
      messageRouter.setEmissionValidator(emissionValidator);
    }
  }

  /**
   * Convenience method: uninstall interceptor and filters from services.
   * Use on teardown for standalone operation.
   */
  uninstallFromServices(): void {
    this.services.agentManager.setSpawnInterceptor(null);
  }

  // ─────────────────────────────────────────────────────────────
  // Internal: Pre-compute role allowed signals
  // ─────────────────────────────────────────────────────────────

  /**
   * Pre-compute per-role allowed signals from channel subscriptions.
   * Called during bootstrap() so createSignalFilter() can use the result.
   */
  private computeRoleAllowedSignals(): void {
    this.roleAllowedSignals.clear();

    for (const [roleName, subs] of Object.entries(this.communication.subscriptions ?? {})) {
      let allowed: Set<string> | "all" = new Set<string>();

      for (const sub of subs) {
        if (!sub.signals || sub.signals.length === 0) {
          // No filter on this subscription — role receives all signals
          allowed = "all";
          break;
        }
        for (const sig of sub.signals) {
          (allowed as Set<string>).add(sig);
        }
      }

      this.roleAllowedSignals.set(roleName, allowed);
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Peer Routing
  // ─────────────────────────────────────────────────────────────

  /**
   * Wire peer subscriptions from communication config.
   * Falls back to legacy bidirectional subtree subs when no peers config exists.
   */
  private wirePeerRoutes(): void {
    const peers = this.communication.routing?.peers;

    if (!peers || peers.length === 0) {
      // Fallback: hardcoded mutual subtree subscriptions (backwards compat)
      this.setupLegacyPeerSubscriptions();
      return;
    }

    this.pendingPeerRoutes = [];

    for (const peer of peers) {
      const fromAgent = this.roleAgentMap.get(peer.from);
      const toAgent = this.roleAgentMap.get(peer.to);

      if (!fromAgent || !toAgent) {
        // One or both roles not yet spawned — defer
        this.pendingPeerRoutes.push(peer);
        continue;
      }

      this.wireSinglePeerRoute(peer, fromAgent, toAgent);
    }

    // If there are pending routes, set up lifecycle listener for deferred wiring
    if (this.pendingPeerRoutes.length > 0) {
      this.setupDeferredPeerWiring();
    }
  }

  /**
   * Wire a single peer connection based on its `via` type.
   */
  private wireSinglePeerRoute(
    peer: PeerConnection,
    fromAgent: AgentId,
    toAgent: AgentId
  ): void {
    const { messageRouter } = this.services;

    switch (peer.via) {
      case "direct":
        // Directional: from receives status events from to's subtree
        messageRouter.subscribe(fromAgent, { type: "subtree", target: toAgent });
        break;

      case "topic": {
        // Both agents share a named topic
        const topicName = `peer:${peer.from}:${peer.to}`;
        messageRouter.subscribe(fromAgent, { type: "topic", target: topicName });
        messageRouter.subscribe(toAgent, { type: "topic", target: topicName });
        break;
      }

      case "scope":
        // from subscribes to to's role channel
        messageRouter.subscribe(fromAgent, { type: "role", target: peer.to });
        break;
    }

    // Store signal filter if specified
    if (peer.signals && peer.signals.length > 0) {
      const key = `${fromAgent}→${toAgent}`;
      this.peerSignalFilters.set(key, peer.signals);
    }
  }

  /**
   * Legacy bidirectional subtree subscriptions between root and companions.
   * Used when no `routing.peers` config is defined (backwards compat).
   */
  private setupLegacyPeerSubscriptions(): void {
    const { messageRouter } = this.services;

    if (!this.rootAgentId) return;
    for (const companionId of this.companionAgentIds) {
      messageRouter.subscribe(this.rootAgentId as AgentId, { type: "subtree", target: companionId as AgentId });
      messageRouter.subscribe(companionId as AgentId, { type: "subtree", target: this.rootAgentId as AgentId });
    }
  }

  /**
   * Listen for agent spawns and wire pending peer routes when roles become available.
   */
  private setupDeferredPeerWiring(): void {
    const { agentManager } = this.services;

    this.peerWiringUnsubscribe = agentManager.onLifecycleEvent((event) => {
      if (event.type !== "spawned") return;
      const role = event.agent.role;
      if (!role) return;

      // Update role↔agent mappings
      this.roleAgentMap.set(role, event.agent.id as AgentId);
      this.agentRoleMap.set(event.agent.id as AgentId, role);

      // Try to wire any pending routes involving this role
      const stillPending: PeerConnection[] = [];
      for (const peer of this.pendingPeerRoutes) {
        const fromAgent = this.roleAgentMap.get(peer.from);
        const toAgent = this.roleAgentMap.get(peer.to);

        if (fromAgent && toAgent) {
          this.wireSinglePeerRoute(peer, fromAgent, toAgent);
        } else {
          stillPending.push(peer);
        }
      }
      this.pendingPeerRoutes = stillPending;

      // All wired — unsubscribe
      if (stillPending.length === 0 && this.peerWiringUnsubscribe) {
        this.peerWiringUnsubscribe();
        this.peerWiringUnsubscribe = undefined;
      }
    });
  }
}
