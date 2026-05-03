/**
 * Team Runtime V2
 *
 * Rewired to use InboxAdapter for signal filtering/emission validation
 * and TasksAdapter for scaling. Drops EventStore and MessageRouter dependencies.
 *
 * Key changes from V1:
 * - Signal filter + emission validator installed on InboxAdapter (adapter-side)
 * - No MERGE_REQUEST polling (handled by AgentManagerV2 terminate flow)
 * - No EventStore team_config event (subsystems don't need cross-process discovery)
 * - One inbox scope per team
 *
 * @module teams/team-runtime-v2
 */

import type { AgentManager, SpawnInterceptor } from "../agent/agent-manager.js";
import type { SpawnAgentOptions } from "../agent/types.js";
import type { AgentId } from "../store/types/index.js";
import type { RoleRegistry } from "../roles/types.js";
import type {
  TeamManifest,
  MacroResolvedTemplate,
  McpServerEntry,
  PeerConnection,
} from "./types.js";
import type { IntegrationStrategy } from "../workspace/strategies/types.js";
import type { InboxAdapter, SignalFilterFn, EmissionValidatorFn } from "../adapters/types.js";
import type { TasksAdapter } from "../adapters/types.js";
import type { WorkspaceManager } from "../workspace/types.js";
import { WORKSPACE_CAPABILITIES } from "../roles/capabilities.js";

// =============================================================================
// Types
// =============================================================================

export interface TeamServicesV2 {
  agentManager: AgentManager;
  inboxAdapter: InboxAdapter;
  tasksAdapter: TasksAdapter;
  workspaceManager?: WorkspaceManager;
}

export interface TeamBootstrapResult {
  rootId: string;
  companionIds: string[];
}

// =============================================================================
// Helper: Convert legacy manifest to resolved template
// =============================================================================

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
      roles: new Map(),
      prompts: new Map(),
      mcpServers: manifest._mcpServers,
      mcpProviders: new Map(),
      loadouts: new Map(),
      sourcePath: "",
    },
    resolvedRoles: manifest._resolvedRoles,
    macroAgent: manifest.macro_agent,
  };
}

function isMacroResolvedTemplate(
  input: TeamManifest | MacroResolvedTemplate
): input is MacroResolvedTemplate {
  return "template" in input && "resolvedRoles" in input;
}

// =============================================================================
// TeamRuntimeV2
// =============================================================================

export class TeamRuntimeV2 {
  private rootAgentId?: string;
  private companionAgentIds: string[] = [];
  private roleRegistry: RoleRegistry;
  private lifecycleUnsubscribe?: () => void;
  private integrationStrategy?: IntegrationStrategy;
  private scalingTimer?: ReturnType<typeof setInterval>;
  private lastScaleUpTime = 0;
  private teamStreamId?: string;

  /** The resolved template */
  private readonly resolved: MacroResolvedTemplate;

  /** Legacy loaded prompts map */
  private readonly loadedPrompts: Map<string, string>;

  /** Role name → spawned agent ID */
  private roleAgentMap = new Map<string, AgentId>();

  /** Per-agent signal filters from peer connections. Key: "fromAgentId→toAgentId" */
  private peerSignalFilters = new Map<string, string[]>();

  /** Agent ID → role name */
  private agentRoleMap = new Map<AgentId, string>();

  /** Pre-computed per-role allowed signals */
  private roleAllowedSignals = new Map<string, Set<string> | "all">();

  /** Pending peer routes for deferred wiring */
  private pendingPeerRoutes: PeerConnection[] = [];

  /** Lifecycle unsubscribe for deferred peer wiring */
  private peerWiringUnsubscribe?: () => void;

  constructor(
    input: TeamManifest | MacroResolvedTemplate,
    private readonly services: TeamServicesV2
  ) {
    this.resolved = isMacroResolvedTemplate(input)
      ? input
      : manifestToResolved(input);

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
   * Wire team configuration: register roles, instantiate integration strategy.
   *
   * Drops EventStore team_config event — subsystems don't need cross-process
   * discovery since messaging is in agent-inbox and tasks in opentasks.
   */
  async initialize(_options?: { teamInstanceId?: string }): Promise<void> {
    // 1. Register team roles into RoleRegistry
    for (const [, resolved] of this.resolved.resolvedRoles) {
      const rd = resolved.roleDefinition;
      const existing = this.roleRegistry.getRole(rd.name);
      if (existing) {
        const existingCaps = [...existing.capabilities].sort();
        const newCaps = [...rd.capabilities].sort();
        if (
          existingCaps.length !== newCaps.length ||
          existingCaps.some((c, i) => c !== newCaps[i])
        ) {
          console.warn(
            `[TeamRuntimeV2] Role '${rd.name}' conflict: team '${this.manifest.name}' ` +
              `re-registers with different capabilities.`
          );
        }
      }
      this.roleRegistry.registerRole(rd);
    }

    // 2. Instantiate integration strategy
    try {
      const { defaultStrategyRegistry } = await import(
        "../workspace/strategies/registry.js"
      );
      const strategyName =
        this.resolved.macroAgent.integration?.strategy ?? "queue";
      const strategyConfig =
        (this.resolved.macroAgent.integration?.config as Record<string, unknown>) ?? {};
      this.integrationStrategy = defaultStrategyRegistry.get(
        strategyName,
        strategyConfig
      );
      if (this.integrationStrategy.initialize) {
        await this.integrationStrategy.initialize();
      }

      // Wire merge queue to queue strategy
      if (
        this.services.workspaceManager &&
        strategyName === "queue" &&
        "setMergeQueue" in this.integrationStrategy
      ) {
        const mergeQueue = this.services.workspaceManager.getMergeQueue();
        (
          this.integrationStrategy as {
            setMergeQueue(q: typeof mergeQueue): void;
          }
        ).setMergeQueue(mergeQueue);
      }
    } catch {
      // Strategy instantiation is best-effort
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Bootstrap
  // ─────────────────────────────────────────────────────────────

  /**
   * Spawn root and companion agents, build role mappings,
   * compute signal filters.
   *
   * Drops MessageRouter peer wiring — agent-inbox handles message delivery.
   * Peer signal filters are still computed for adapter-side enforcement.
   */
  async bootstrap(): Promise<TeamBootstrapResult> {
    const { agentManager } = this.services;
    const { topology } = this.manifest;

    // 1. Spawn root agent (scope = team name)
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
      team_instance: this.manifest.name, // scope = team name
    });
    this.rootAgentId = root.id;

    // 1b. Set up workspace integration
    this.setupWorkspaceIntegration(root.id as AgentId);

    // 2. Spawn companions
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
        team_instance: this.manifest.name,
      });
      companionIds.push(agent.id);
    }
    this.companionAgentIds = companionIds;

    // 3. Build role↔agent mappings
    this.roleAgentMap.set(topology.root.role, root.id as AgentId);
    this.agentRoleMap.set(root.id as AgentId, topology.root.role);
    for (let i = 0; i < (topology.companions ?? []).length; i++) {
      const role = topology.companions![i].role;
      this.roleAgentMap.set(role, companionIds[i] as AgentId);
      this.agentRoleMap.set(companionIds[i] as AgentId, role);
    }

    // 4. Compute peer signal filters (for adapter-side enforcement)
    this.computePeerSignalFilters();

    // 5. Pre-compute role allowed signals
    this.computeRoleAllowedSignals();

    // 6. Continuation monitoring
    this.monitorContinuations();

    // 7. Auto-scaling
    this.monitorScaling();

    return { rootId: root.id, companionIds };
  }

  // ─────────────────────────────────────────────────────────────
  // Teardown
  // ─────────────────────────────────────────────────────────────

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
    if (this.integrationStrategy?.close) {
      try {
        await this.integrationStrategy.close();
      } catch {
        // Best-effort
      }
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Getters
  // ─────────────────────────────────────────────────────────────

  getTaskMode(): "push" | "pull" {
    return this.resolved.macroAgent.task_assignment?.mode ?? "push";
  }

  getStrategyName(): string {
    return this.resolved.macroAgent.integration?.strategy ?? "queue";
  }

  getManifest(): TeamManifest {
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

  getResolvedTemplate(): MacroResolvedTemplate {
    return this.resolved;
  }

  getRootAgentId(): string | undefined {
    return this.rootAgentId;
  }

  getCompanionAgentIds(): string[] {
    return [...this.companionAgentIds];
  }

  getIntegrationStrategy(): IntegrationStrategy | undefined {
    return this.integrationStrategy;
  }

  getTeamStreamId(): string | undefined {
    return this.teamStreamId;
  }

  getPeerSignalFilters(): ReadonlyMap<string, string[]> {
    return this.peerSignalFilters;
  }

  getAgentRoleMap(): ReadonlyMap<AgentId, string> {
    return this.agentRoleMap;
  }

  /**
   * Register an agent's role mapping (dynamic spawn tracking).
   *
   * NOTE: roleAgentMap is 1:1 (last writer wins). This is fine for bootstrap
   * agents (one per role) and peer route wiring. Dynamic workers with the
   * same role will overwrite each other here, but that's acceptable because
   * dynamic lookup uses agentRoleMap (agent→role) not roleAgentMap (role→agent).
   * If multi-instance role→agent resolution is needed in the future, change
   * roleAgentMap to Map<string, Set<AgentId>>.
   */
  registerAgent(agentId: AgentId, roleName: string): void {
    this.agentRoleMap.set(agentId, roleName);
    this.roleAgentMap.set(roleName, agentId);
  }

  hasAgent(agentId: string): boolean {
    return this.agentRoleMap.has(agentId as AgentId);
  }

  /** Get the team's inbox scope (= team name) */
  getScope(): string {
    return this.manifest.name;
  }

  // ─────────────────────────────────────────────────────────────
  // Signal Filter + Emission Validator (adapter-side)
  // ─────────────────────────────────────────────────────────────

  /**
   * Create a signal filter for the InboxAdapter.
   *
   * Same logic as V1 but returns a SignalFilterFn (adapter type)
   * instead of a MessageRouter SignalFilter.
   */
  createSignalFilter(): SignalFilterFn {
    return (from: string, to: string, message) => {
      // Extract signal from message content
      const signal = this.extractSignal(message);
      if (!signal) return true; // No signal → allow

      // Check peer connection filter (directional: from→to)
      const peerFilter = this.peerSignalFilters.get(`${from}→${to}`);
      if (peerFilter) {
        return peerFilter.includes(signal);
      }

      // Check channel subscription filter for recipient's role
      const recipientRole = this.agentRoleMap.get(to as AgentId);
      if (recipientRole) {
        const allowed = this.roleAllowedSignals.get(recipientRole);
        if (allowed && allowed !== "all") {
          return allowed.has(signal);
        }
      }

      return true; // No filter → allow
    };
  }

  /**
   * Create an emission validator for the InboxAdapter.
   *
   * Returns a rejection reason string (or null to allow).
   */
  createEmissionValidator(): EmissionValidatorFn {
    const emissions = this.communication.emissions;
    const enforcement = this.communication.enforcement ?? "permissive";

    if (!emissions || Object.keys(emissions).length === 0) {
      return () => null; // No emissions config → allow all
    }

    return (from: string, message) => {
      const signal = this.extractSignal(message);
      if (!signal) return null; // No signal → allow

      const role = this.agentRoleMap.get(from as AgentId);
      if (!role) return null; // Not a team agent → allow

      const allowedSignals = emissions[role];
      if (!allowedSignals) return null; // No restrictions for this role

      if (allowedSignals.includes(signal)) return null; // Allowed

      const reason = `Agent '${from}' (role: ${role}) emitted disallowed signal '${signal}'. ` +
        `Allowed: [${allowedSignals.join(", ")}]`;

      if (enforcement === "strict") return reason;
      if (enforcement === "permissive") {
        console.warn(`[TeamRuntimeV2] ${reason}`);
        return null; // Warn but allow
      }
      return null; // audit → allow with logging
    };
  }

  /**
   * Install signal filter and emission validator on the InboxAdapter.
   *
   * Uses addSignalFilter/addEmissionValidator with team name as ID
   * so multiple teams can coexist without overwriting each other.
   * Also installs spawn interceptor on the AgentManager.
   */
  installOnServices(): void {
    const { agentManager, inboxAdapter } = this.services;

    agentManager.setSpawnInterceptor(this.createSpawnInterceptor());
    inboxAdapter.addSignalFilter(this.manifest.name, this.createSignalFilter());
    inboxAdapter.addEmissionValidator(this.manifest.name, this.createEmissionValidator());
  }

  uninstallFromServices(): void {
    this.services.agentManager.setSpawnInterceptor(null);
    this.services.inboxAdapter.removeSignalFilter(this.manifest.name);
    this.services.inboxAdapter.removeEmissionValidator(this.manifest.name);
  }

  // ─────────────────────────────────────────────────────────────
  // Spawn Interceptor
  // ─────────────────────────────────────────────────────────────

  createSpawnInterceptor(): SpawnInterceptor {
    return (options: SpawnAgentOptions): SpawnAgentOptions => {
      const roleName = options.role;
      if (!roleName) return options;

      const resolved = this.resolved.resolvedRoles.get(roleName);
      if (!resolved) return options;

      const teamTopics = this.getTopicsForRole(roleName);
      const teamMcpServers = this.getMcpServersForRole(roleName);
      const teamPrompt = this.getPromptForRole(roleName);

      const teamEnv: Record<string, string> = {
        MACRO_TEAM_NAME: this.manifest.name,
        MACRO_TASK_MODE: this.getTaskMode(),
      };
      const strategyName = this.getStrategyName();
      if (strategyName) {
        teamEnv.MACRO_INTEGRATION_STRATEGY = strategyName;
      }

      // Workspace injection
      const capabilities = resolved.capabilities;
      let streamId = options.streamId;
      let streamConfig = options.streamConfig;
      let gitCascadeTaskId = options.gitCascadeTaskId;

      if (this.teamStreamId && capabilities) {
        if (capabilities.includes(WORKSPACE_CAPABILITIES.WORKTREE)) {
          streamId = streamId ?? this.teamStreamId;
          gitCascadeTaskId = gitCascadeTaskId ?? `worker-${Date.now()}`;
        } else if (capabilities.includes(WORKSPACE_CAPABILITIES.INTEGRATE)) {
          streamId = streamId ?? this.teamStreamId;
        }
      }

      return {
        ...options,
        streamId,
        streamConfig,
        gitCascadeTaskId,
        capabilities: capabilities ?? options.capabilities,
        // Set team scope on all team agents
        team_instance: options.team_instance ?? this.manifest.name,
        topics: [...(options.topics ?? []), ...teamTopics],
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
        customPrompt: options.customPrompt ?? teamPrompt,
        interactionPatterns:
          options.interactionPatterns ?? this.getInteractionPatterns(),
      };
    };
  }

  // ─────────────────────────────────────────────────────────────
  // Communication Helpers
  // ─────────────────────────────────────────────────────────────

  private getTopicsForRole(roleName: string): string[] {
    const topics: string[] = [];
    const subs = this.communication.subscriptions?.[roleName] ?? [];
    for (const sub of subs) {
      if (!topics.includes(sub.channel)) {
        topics.push(sub.channel);
      }
    }
    return topics;
  }

  private getMcpServersForRole(roleName: string): McpServerEntry[] {
    return this.resolved.template.mcpServers.get(roleName) ?? [];
  }

  private getPromptForRole(roleName: string): string | undefined {
    const resolved = this.resolved.resolvedRoles.get(roleName);
    if (!resolved?.prompt) return undefined;
    return this.loadedPrompts.get(resolved.prompt);
  }

  private getPromptForTopologyNode(
    node: { role: string; prompt?: string }
  ): string | undefined {
    if (node.prompt) return this.loadedPrompts.get(node.prompt);
    return this.getPromptForRole(node.role);
  }

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
  // Internal: Signal and peer filter computation
  // ─────────────────────────────────────────────────────────────

  /**
   * Extract signal name from a message. Looks at event-type messages
   * and thread tags for signal identification.
   */
  private extractSignal(message: { content?: any; metadata?: any }): string | undefined {
    const content = message.content;
    if (!content) return undefined;

    // Event messages carry signal in event field
    if (content.type === "event" && content.event) {
      return content.event;
    }

    // Check metadata for signal field
    if (message.metadata?.signal) {
      return message.metadata.signal as string;
    }

    return undefined;
  }

  /**
   * Compute peer signal filters from routing.peers config.
   * These are directional: from→to with specific allowed signals.
   */
  private computePeerSignalFilters(): void {
    const peers = this.communication.routing?.peers;
    if (!peers) return;

    for (const peer of peers) {
      const fromAgent = this.roleAgentMap.get(peer.from);
      const toAgent = this.roleAgentMap.get(peer.to);

      if (!fromAgent || !toAgent) {
        this.pendingPeerRoutes.push(peer);
        continue;
      }

      if (peer.signals && peer.signals.length > 0) {
        this.peerSignalFilters.set(`${fromAgent}→${toAgent}`, peer.signals);
      }
    }

    // Set up deferred wiring for peers not yet spawned
    if (this.pendingPeerRoutes.length > 0) {
      this.setupDeferredPeerWiring();
    }
  }

  private setupDeferredPeerWiring(): void {
    const { agentManager } = this.services;

    this.peerWiringUnsubscribe = agentManager.onLifecycleEvent((event) => {
      if (event.type !== "spawned") return;

      const remaining: PeerConnection[] = [];
      for (const peer of this.pendingPeerRoutes) {
        const fromAgent = this.roleAgentMap.get(peer.from);
        const toAgent = this.roleAgentMap.get(peer.to);

        if (fromAgent && toAgent) {
          if (peer.signals && peer.signals.length > 0) {
            this.peerSignalFilters.set(
              `${fromAgent}→${toAgent}`,
              peer.signals
            );
          }
        } else {
          remaining.push(peer);
        }
      }
      this.pendingPeerRoutes = remaining;

      if (remaining.length === 0 && this.peerWiringUnsubscribe) {
        this.peerWiringUnsubscribe();
        this.peerWiringUnsubscribe = undefined;
      }
    });
  }

  private computeRoleAllowedSignals(): void {
    this.roleAllowedSignals.clear();

    for (const [roleName, subs] of Object.entries(
      this.communication.subscriptions ?? {}
    )) {
      let allowed: Set<string> | "all" = new Set<string>();

      for (const sub of subs) {
        if (!sub.signals || sub.signals.length === 0) {
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
  // Continuation Monitoring
  // ─────────────────────────────────────────────────────────────

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

      const reason = (event as { reason?: string }).reason;
      if (reason === "completed" || reason === "cancelled") return;

      setTimeout(async () => {
        try {
          const newAgent = await agentManager.continueAgent(event.agent.id);
          monitoredAgents.delete(event.agent.id);
          monitoredAgents.add(newAgent.id);

          if (event.agent.id === this.rootAgentId) {
            this.rootAgentId = newAgent.id;
          } else {
            const idx = this.companionAgentIds.indexOf(event.agent.id);
            if (idx >= 0) this.companionAgentIds[idx] = newAgent.id;
          }
        } catch {
          // Failed to continue
        }
      }, 1000);
    });
  }

  // ─────────────────────────────────────────────────────────────
  // Auto-Scaling (uses TasksAdapter instead of TaskBackend)
  // ─────────────────────────────────────────────────────────────

  private static readonly SCALE_COOLDOWN_MS = 10_000;
  private static readonly SCALE_CHECK_INTERVAL_MS = 5_000;

  private monitorScaling(): void {
    const scalingConfig = this.resolved.macroAgent.lifecycle?.scaling;
    if (!scalingConfig || scalingConfig.scale_on !== "task_queue_depth") return;

    const { tasksAdapter, agentManager } = this.services;
    if (!tasksAdapter.connected) return;

    const maxWorkers = scalingConfig.max_workers ?? Infinity;

    const workerRoleNames = new Set<string>();
    for (const [name, resolved] of this.resolved.resolvedRoles) {
      if (resolved.baseRole === "worker") {
        workerRoleNames.add(name);
      }
    }
    if (workerRoleNames.size === 0) return;

    const spawnRole = [...workerRoleNames][0];

    this.scalingTimer = setInterval(async () => {
      try {
        const claimable = await tasksAdapter.listClaimable();
        const pendingCount = claimable.length;

        const allAgents = agentManager.list({ state: "running" });
        let activeWorkers = 0;
        for (const agent of allAgents) {
          if (
            agent.role &&
            workerRoleNames.has(agent.role) &&
            this.agentRoleMap.has(agent.id as AgentId)
          ) {
            activeWorkers++;
          }
        }

        if (
          pendingCount > activeWorkers &&
          activeWorkers < maxWorkers
        ) {
          const now = Date.now();
          if (now - this.lastScaleUpTime < TeamRuntimeV2.SCALE_COOLDOWN_MS) {
            return;
          }
          if (!this.rootAgentId) return;

          try {
            await agentManager.spawn({
              task: `[${this.manifest.name}] auto-scaled ${spawnRole}`,
              role: spawnRole,
              parent: this.rootAgentId,
            });
            this.lastScaleUpTime = now;
          } catch {
            // Will retry next tick
          }
        }
      } catch {
        // Best-effort
      }
    }, TeamRuntimeV2.SCALE_CHECK_INTERVAL_MS);

    if (this.scalingTimer.unref) {
      this.scalingTimer.unref();
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Workspace Integration (simplified — no merge request polling)
  // ─────────────────────────────────────────────────────────────

  private setupWorkspaceIntegration(rootAgentId: AgentId): void {
    const { workspaceManager } = this.services;
    if (!workspaceManager || !this.integrationStrategy) return;

    // V3 coexistence: if TeamManagerV2 has already wired a YamlDrivenTopology
    // from `macro_agent.workspace`, that policy owns the team root stream.
    // Don't create a second one via the legacy createIntegrationStream.
    const hasV3Topology =
      typeof (
        this.services.agentManager as {
          getTopologyPolicy?: () => unknown;
        }
      ).getTopologyPolicy === 'function';
    // AgentManager doesn't expose a getter today, so detect indirectly: a
    // V3-wired team has already created a stream owned by `team:<name>`.
    const existingTeamRoot = workspaceManager
      .listStreams({ ownerId: `team:${this.manifest.name}` } as never)
      .find((s: { name: string }) => s.name === this.manifest.name);

    if (existingTeamRoot) {
      this.teamStreamId = existingTeamRoot.id;
      return;
    }

    try {
      this.teamStreamId = workspaceManager.createIntegrationStream(
        rootAgentId,
        { name: this.manifest.name, forkFrom: "main" }
      );
    } catch {
      return; // Workspace isolation unavailable
    }

    // Subscribe to merge queue events — wake integrator on mr:submitted
    try {
      const mergeQueue = workspaceManager.getMergeQueue();
      if (mergeQueue?.onEvent) {
        mergeQueue.onEvent((event) => {
          if (event.type !== "mr:submitted") return;

          for (const [agentId, roleName] of this.agentRoleMap) {
            const resolved = this.resolved.resolvedRoles.get(roleName);
            const caps = resolved?.capabilities ?? [];
            if (caps.includes(WORKSPACE_CAPABILITIES.INTEGRATE)) {
              try {
                // prompt() returns AsyncIterable — drain in background (fire-and-forget)
                const iter = this.services.agentManager.prompt(
                  agentId,
                  `Merge request submitted. Process the merge queue.`
                );
                (async () => {
                  try {
                    for await (const _ of iter) { /* drain */ }
                  } catch {
                    // Best-effort wake — ignore errors
                  }
                })();
              } catch {
                // Best-effort wake
              }
              break;
            }
          }
        });
      }
    } catch {
      // Merge queue not available
    }

    // NOTE: No merge request polling. AgentManagerV2.terminate() handles
    // merge request submission directly when a worker with a workspace
    // completes. This eliminates the 2-second EventStore polling loop.
  }
}
