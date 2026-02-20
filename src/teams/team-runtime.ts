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

// =============================================================================
// Types
// =============================================================================

export interface TeamServices {
  agentManager: AgentManager;
  messageRouter: MessageRouter;
  eventStore: EventStore;
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
   * 3. Register spawn interceptor on AgentManager
   */
  async initialize(): Promise<void> {
    const { agentManager, eventStore } = this.services;

    // 1. Register team roles into RoleRegistry (custom layer, highest priority)
    for (const [, resolved] of this.resolved.resolvedRoles) {
      this.roleRegistry.registerRole(resolved.roleDefinition);
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

    // 2b. Instantiate integration strategy and call lifecycle hook
    try {
      const { defaultStrategyRegistry } = await import("../workspace/strategies/registry.js");
      this.integrationStrategy = defaultStrategyRegistry.get(strategyName, strategyConfig as Record<string, unknown>);
      if (this.integrationStrategy.initialize) {
        await this.integrationStrategy.initialize();
      }
    } catch {
      // Strategy instantiation is best-effort — queue strategy needs merge queue set later
    }

    // 3. Register spawn interceptor
    agentManager.setSpawnInterceptor(this.createSpawnInterceptor());
  }

  // ─────────────────────────────────────────────────────────────
  // Bootstrap
  // ─────────────────────────────────────────────────────────────

  /**
   * Spawn root and companion agents per the team topology.
   */
  async bootstrap(): Promise<TeamBootstrapResult> {
    const { agentManager, messageRouter } = this.services;
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

    // 4. Install signal filter on message router
    this.installSignalFilter();

    // 5. Install emission validator on message router
    this.installEmissionValidator();

    // 6. Set up continuation monitoring for daemon agents (P4.2)
    this.monitorContinuations();

    return {
      rootId: root.id,
      companionIds,
    };
  }

  // ─────────────────────────────────────────────────────────────
  // Teardown
  // ─────────────────────────────────────────────────────────────

  /**
   * Tear down team: remove spawn interceptor, stop continuation monitoring.
   */
  async teardown(): Promise<void> {
    this.services.agentManager.setSpawnInterceptor(null);
    if (this.lifecycleUnsubscribe) {
      this.lifecycleUnsubscribe();
      this.lifecycleUnsubscribe = undefined;
    }
    if (this.peerWiringUnsubscribe) {
      this.peerWiringUnsubscribe();
      this.peerWiringUnsubscribe = undefined;
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

  /** Get signal filters for peer connections (for use by signal filtering - i-3o8g) */
  getPeerSignalFilters(): ReadonlyMap<string, string[]> {
    return this.peerSignalFilters;
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
  // Spawn Interceptor
  // ─────────────────────────────────────────────────────────────

  /**
   * Create the spawn interceptor that injects team context into spawn options.
   */
  private createSpawnInterceptor(): SpawnInterceptor {
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

      return {
        ...options,
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
  // Signal Filtering
  // ─────────────────────────────────────────────────────────────

  /**
   * Install a signal filter on the message router.
   *
   * Combines two filter sources:
   * 1. Channel subscription filters (per-role, per-topic): from communication.subscriptions
   * 2. Peer connection filters (per-agent-pair): from communication.routing.peers
   *
   * Status events with no details.signal always pass through (backwards compat).
   */
  private installSignalFilter(): void {
    const { messageRouter } = this.services;

    // Pre-compute per-role allowed signals from channel subscriptions.
    // Key: role name, Value: Set of allowed signal names.
    // If a role has any subscription without a signals filter, it receives all signals.
    const roleAllowedSignals = new Map<string, Set<string> | "all">();

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

      roleAllowedSignals.set(roleName, allowed);
    }

    if (messageRouter.setSignalFilter) {
      messageRouter.setSignalFilter((from, to, signal) => {
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
          const allowed = roleAllowedSignals.get(recipientRole);
          if (allowed && allowed !== "all") {
            return allowed.has(signal);
          }
        }

        // No filter configured — allow delivery
        return true;
      });
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Emission Validation
  // ─────────────────────────────────────────────────────────────

  /**
   * Install emission validator on the message router.
   * Checks whether an agent's emitted signal is in its role's allowed emissions list.
   * Behavior depends on enforcement mode: strict (reject), permissive (warn), audit (record).
   */
  private installEmissionValidator(): void {
    const { messageRouter } = this.services;
    const emissions = this.communication.emissions;
    const enforcement = this.communication.enforcement ?? "permissive";

    // No emissions config — nothing to enforce
    if (!emissions || Object.keys(emissions).length === 0) return;

    if (messageRouter.setEmissionValidator) {
      messageRouter.setEmissionValidator((agentId, signal) => {
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
      });
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
