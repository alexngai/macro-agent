/**
 * Team Template Types
 *
 * TypeScript types for the team manifest schema. Generic multi-agent fields
 * (name, roles, topology, communication) are separated from macro-agent
 * specific extensions under the `macro_agent` namespace for interoperability.
 *
 * @module teams/types
 */

import type { RoleDefinition, Capability } from "../roles/types.js";

// =============================================================================
// Core Manifest
// =============================================================================

/**
 * Fully resolved team manifest.
 *
 * Returned by TeamLoader.load() with all inheritance resolved,
 * capabilities computed, and prompts loaded.
 */
export interface TeamManifest {
  /** Team name (directory name) */
  name: string;

  /** Human-readable description */
  description: string;

  /** Schema version */
  version: number;

  /** Role names used by this team */
  roles: string[];

  /** Agent spawn topology */
  topology: TeamTopology;

  /** Communication topology */
  communication: TeamCommunication;

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
// Topology
// =============================================================================

/**
 * Defines the agent spawn graph for the team.
 */
export interface TeamTopology {
  /** The initial agent spawned when the team starts */
  root: TopologyNode;

  /** Agents spawned alongside root (peers, not children) */
  companions?: TopologyNode[];

  /**
   * Which roles can spawn which other roles.
   * Translated into capability additions by TeamLoader (RD3).
   */
  spawn_rules?: Record<string, string[]>;
}

/**
 * A node in the team's spawn topology.
 */
export interface TopologyNode {
  /** Role name (must be in manifest.roles) */
  role: string;

  /** Path to prompt file relative to team directory */
  prompt?: string;

  /** Agent configuration */
  config?: TopologyNodeConfig;
}

export interface TopologyNodeConfig {
  /** Model to use (e.g., "sonnet", "haiku", "opus") */
  model?: string;

  /** Additional key-value config passed to agent */
  [key: string]: unknown;
}

// =============================================================================
// Communication
// =============================================================================

/**
 * Communication topology for the team.
 *
 * Declares channels (signal groups), per-role subscriptions,
 * emission restrictions, and routing rules.
 */
export interface TeamCommunication {
  /** Named signal channels */
  channels?: Record<string, ChannelDefinition>;

  /** Per-role subscription declarations */
  subscriptions?: Record<string, ChannelSubscription[]>;

  /** Per-role emission declarations (which signals a role can emit) */
  emissions?: Record<string, string[]>;

  /** Routing configuration */
  routing?: CommunicationRouting;

  /** Enforcement level for communication rules */
  enforcement?: CommunicationEnforcement;
}

export type CommunicationEnforcement = "strict" | "permissive" | "audit";

/**
 * A named channel grouping related signals.
 */
export interface ChannelDefinition {
  /** Human-readable description */
  description?: string;

  /** Signals in this channel */
  signals: string[];
}

/**
 * A role's subscription to a channel.
 */
export interface ChannelSubscription {
  /** Channel name (must exist in communication.channels) */
  channel: string;

  /** Specific signals to receive. If omitted, receives all signals in the channel */
  signals?: string[];
}

/**
 * Communication routing configuration.
 */
export interface CommunicationRouting {
  /** Status flow direction */
  status?: "upstream";

  /** Explicit peer connections (non-hierarchical) */
  peers?: PeerConnection[];
}

/**
 * A peer-to-peer connection between two roles.
 */
export interface PeerConnection {
  /** Source role name */
  from: string;

  /** Target role name */
  to: string;

  /** Routing mechanism */
  via: "direct" | "topic" | "scope";

  /** Signals allowed on this connection */
  signals?: string[];
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
// Team Role Definition
// =============================================================================

/**
 * Role definition as declared in a team template's roles/*.yaml file.
 *
 * Supports both full replacement and additive/subtractive capability composition.
 */
export interface TeamRoleDefinition {
  /** Role name */
  name: string;

  /** Built-in role to extend */
  extends?: string;

  /** Display name for UI/logs */
  display_name?: string;

  /** Human-readable description */
  description?: string;

  /**
   * Full replacement capability list.
   * Mutually exclusive with add/remove.
   */
  capabilities?: string[];

  /**
   * Capabilities to add to the parent role's set.
   * Only valid when `extends` is set.
   */
  capabilities_add?: string[];

  /**
   * Capabilities to remove from the parent role's set.
   * Only valid when `extends` is set.
   */
  capabilities_remove?: string[];

  /** Path to prompt file relative to team directory */
  prompt?: string;

  /** macro-agent specific role configuration */
  macro_agent?: TeamRoleMacroAgent;
}

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
// MCP Server Config
// =============================================================================

/**
 * MCP server entry from tools/mcp-servers.json.
 * Follows Claude Code's native format.
 */
export interface McpServerEntry {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
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
