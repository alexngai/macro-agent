/**
 * Team Template Types
 *
 * Imports generic multi-agent schema types from openteams and extends them
 * with macro-agent specific runtime types (extensions, resolved roles, errors).
 *
 * @module teams/types
 */

import type { RoleDefinition, Capability } from "../roles/types.js";

// =============================================================================
// Imports from openteams (canonical schema types)
// =============================================================================

import type {
  TeamManifest as OpenTeamsManifest,
  TopologyConfig,
  TopologyNode,
  TopologyNodeConfig,
  CommunicationConfig,
  ChannelDefinition,
  SubscriptionEntry,
  RoutingConfig,
  PeerRoute,
  RoleDefinition as OpenTeamsRoleDefinition,
  CapabilityComposition,
  McpServerEntry,
  ResolvedTemplate,
  ResolvedRole,
  ResolvedPrompts,
  PromptSection,
} from "openteams";

// =============================================================================
// Re-exports from openteams
// =============================================================================

export type {
  OpenTeamsManifest,
  TopologyConfig,
  TopologyNode,
  TopologyNodeConfig,
  CommunicationConfig,
  ChannelDefinition,
  SubscriptionEntry,
  RoutingConfig,
  PeerRoute,
  OpenTeamsRoleDefinition,
  CapabilityComposition,
  McpServerEntry,
  ResolvedTemplate,
  ResolvedRole,
  ResolvedPrompts,
  PromptSection,
};

// =============================================================================
// Backward-Compatible Aliases
// =============================================================================

/** @deprecated Use TopologyConfig from openteams */
export type TeamTopology = TopologyConfig;

/** @deprecated Use CommunicationConfig from openteams */
export type TeamCommunication = CommunicationConfig;

/** @deprecated Use SubscriptionEntry from openteams */
export type ChannelSubscription = SubscriptionEntry;

/** @deprecated Use RoutingConfig from openteams (now includes "none" status) */
export type CommunicationRouting = RoutingConfig;

/** @deprecated Use PeerRoute from openteams */
export type PeerConnection = PeerRoute;

/** Communication enforcement level */
export type CommunicationEnforcement = "strict" | "permissive" | "audit";

/** @deprecated Use OpenTeamsRoleDefinition from openteams */
export type TeamRoleDefinition = OpenTeamsRoleDefinition;

// =============================================================================
// Core Manifest (macro-agent extension of openteams)
// =============================================================================

/**
 * Fully resolved team manifest for macro-agent.
 *
 * Extends the openteams manifest with typed macro_agent extensions
 * and resolved state fields populated by TeamLoader.
 */
export interface TeamManifest extends OpenTeamsManifest {
  /** Human-readable description */
  description: string;

  /** Communication topology (required in macro-agent) */
  communication: CommunicationConfig;

  /** macro-agent specific extensions */
  macro_agent: MacroAgentExtensions;

  // ─────────────────────────────────────────────────────────────
  // Resolved state (populated by TeamLoader, not in YAML)
  // ─────────────────────────────────────────────────────────────

  /** Resolved role definitions keyed by role name */
  _resolvedRoles: Map<string, ResolvedTeamRole>;

  /** Loaded prompt contents keyed by file path */
  _loadedPrompts: Map<string, string>;

  /** Loaded MCP server configs keyed by role name */
  _mcpServers: Map<string, McpServerEntry[]>;
}

// =============================================================================
// macro-agent Extensions
// =============================================================================

/**
 * macro-agent specific team configuration.
 *
 * Namespaced under `macro_agent` in team.yaml for interoperability.
 */
export interface MacroAgentExtensions {
  /** Task assignment configuration */
  task_assignment?: TaskAssignmentConfig;

  /** Integration strategy configuration */
  integration?: IntegrationConfig;

  /** Agent lifecycle configuration */
  lifecycle?: LifecycleConfig;

  /** Observability configuration */
  observability?: ObservabilityConfig;

  /** Allow extension fields for interop with openteams Record<string, unknown> */
  [key: string]: unknown;
}

export interface TaskAssignmentConfig {
  /** Assignment mode */
  mode: "push" | "pull";

  /** Pull-mode specific settings */
  pull?: {
    /** Seconds before idle worker self-terminates */
    idle_timeout_s?: number;
    /** Milliseconds between claim retries */
    claim_retry_delay_ms?: number;
    /** Max concurrent task claims per agent */
    max_concurrent_per_agent?: number;
  };
}

export interface IntegrationConfig {
  /** Strategy name: 'queue' | 'trunk' | 'optimistic' | custom name */
  strategy: string;

  /** Strategy-specific configuration passed to strategy.initialize() */
  config?: Record<string, unknown>;
}

export interface LifecycleConfig {
  /** Session continuation settings */
  continuations?: {
    enabled: boolean;
    max_history_messages?: number;
    checkpoint_interval?: "round_trip" | "none";
  };

  /** Worker scaling settings */
  scaling?: {
    min_workers?: number;
    max_workers?: number;
    scale_on?: "task_queue_depth" | "manual";
    idle_drain?: boolean;
  };
}

export interface ObservabilityConfig {
  /** Sliding window for metric computation (seconds) */
  metrics_window_s?: number;
  /** Interval between metric snapshots (seconds) */
  snapshot_interval_s?: number;
}

// =============================================================================
// Team Role macro-agent Config
// =============================================================================

export interface TeamRoleMacroAgent {
  /** Workspace configuration */
  workspace?: {
    type?: string;
    branch_pattern?: string;
    cleanup_on_terminate?: boolean;
  };

  /** Lifecycle configuration */
  lifecycle?: {
    type?: "ephemeral" | "persistent" | "daemon" | "event-driven";
    cascade_terminate?: boolean;
    self_cleanup?: boolean;
    task_bound?: boolean;
    parent_bound?: boolean;
    max_duration_ms?: number;
  };
}

// =============================================================================
// Resolved Types
// =============================================================================

/**
 * macro-agent's enriched team resolution result.
 *
 * Wraps openteams' ResolvedTemplate with enforcement-enriched roles
 * and typed macro-agent extensions. Produced by loadTeam(), consumed
 * by TeamRuntime.
 */
export interface MacroResolvedTemplate {
  /** openteams resolved template (manifest + generic roles + prompts + mcpServers) */
  template: ResolvedTemplate;

  /** Enforcement-enriched roles mapped to macro-agent's RoleDefinition */
  resolvedRoles: Map<string, ResolvedTeamRole>;

  /** Parsed macro-agent extensions (typed from manifest.macro_agent) */
  macroAgent: MacroAgentExtensions;
}

/**
 * A team role with inheritance resolved and capabilities computed.
 */
export interface ResolvedTeamRole {
  /** Role name */
  name: string;

  /** The built-in role this extends */
  baseRole: string;

  /** Final computed capability set */
  capabilities: Capability[];

  /** Loaded prompt content (if prompt file specified) */
  prompt?: string;

  /** Full RoleDefinition for RoleRegistry registration */
  roleDefinition: RoleDefinition;
}

// =============================================================================
// Team Loading Errors
// =============================================================================

export type TeamLoadErrorCode =
  | "MANIFEST_NOT_FOUND"
  | "INVALID_MANIFEST"
  | "ROLE_NOT_FOUND"
  | "PROMPT_NOT_FOUND"
  | "INVALID_COMMUNICATION"
  | "INVALID_ROLE";

export class TeamLoadError extends Error {
  constructor(
    message: string,
    public readonly code: TeamLoadErrorCode,
    public readonly teamName?: string
  ) {
    super(message);
    this.name = "TeamLoadError";
  }
}
