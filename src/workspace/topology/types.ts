/**
 * TopologyPolicy — compiles team YAML into per-spawn workspace decisions.
 *
 * A topology policy sits between AgentManagerV2 and WorkspaceManager. It
 * translates declarative team configuration (role shape, stream lineage,
 * landing strategy) into imperative `WorkspaceDecision`s that AgentManager
 * executes via the WorkspaceManager v3 surface.
 *
 * Three built-in policies:
 * - `YamlDrivenTopology` — primary; compiles TeamWorkspaceConfig (default)
 * - `NoWorkspaceTopology` — null policy; returns `none` for every agent
 * - `CognitiveCoreTopology` — programmatic policy for cognitive-core style
 *   callers that bypass YAML (deferred; stub for now)
 *
 * @module workspace/topology/types
 * @see docs/workspace-interfaces.md §7
 * @see docs/workspace-redesign-plan.md Phase 3
 */

import type { AgentId, StreamId, Principal, StreamSpec } from '../types-v3.js';
import type { WorkspaceManager } from '../types.js';
import type {
  TeamWorkspaceConfig,
  RoleWorkspaceConfig,
} from '../yaml-schema.js';

// ─────────────────────────────────────────────────────────────────────────────
// Context types
// ─────────────────────────────────────────────────────────────────────────────

export interface TeamStartContext {
  teamName: string;
  teamInstanceId: string;
  workspaceConfig: TeamWorkspaceConfig | null;
  workspaceManager: WorkspaceManager;
}

export interface TeamStartPlan {
  teamStreamId?: StreamId;
  additionalStreams?: StreamId[];
}

export interface SpawnContext {
  agentId: AgentId;
  role: string;
  parentAgentId?: AgentId;
  parentStreamId?: StreamId;
  teamStreamId?: StreamId;
  workspaceManager: WorkspaceManager;
  /** Look up a live agent ID by role (for workspace: share_with_agent). */
  getAgentByRole?: (role: string) => AgentId | null;
}

export interface AgentCompleteContext {
  agentId: AgentId;
  role: string;
  reason: 'completed' | 'failed' | 'cascade' | 'interrupted';
  streamId?: StreamId;
  workspaceManager: WorkspaceManager;
}

export interface TeamStopContext {
  teamName: string;
  teamInstanceId: string;
  teamStreamId?: StreamId;
  workspaceManager: WorkspaceManager;
}

// ─────────────────────────────────────────────────────────────────────────────
// Decision type
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Declarative description of what workspace the spawning agent should get.
 * AgentManagerV2 executes this via WorkspaceManager calls.
 */
export type WorkspaceDecision =
  | { kind: 'none' }
  | { kind: 'share-parent-cwd' }
  | { kind: 'share-with-agent'; agentId: AgentId }
  | { kind: 'attach-to-stream'; streamId: StreamId; allocateWorktree: boolean }
  | {
      kind: 'new-stream';
      streamSpec: StreamSpec;
      allocateWorktree: boolean;
    };

// ─────────────────────────────────────────────────────────────────────────────
// Policy interface
// ─────────────────────────────────────────────────────────────────────────────

export interface TopologyPolicy {
  readonly name: string;

  onTeamStart(ctx: TeamStartContext): Promise<TeamStartPlan>;
  onAgentSpawn(ctx: SpawnContext): Promise<WorkspaceDecision>;
  onAgentComplete(ctx: AgentCompleteContext): Promise<void>;
  onTeamStop(ctx: TeamStopContext): Promise<void>;

  /**
   * Optional: subscribed when the topology cares about parent-stream updates.
   * Used by roles with `on_parent_advanced: sync_with_parent`.
   */
  onParentStreamAdvanced?(ctx: {
    parentStreamId: StreamId;
    affectedAgents: AgentId[];
    workspaceManager: WorkspaceManager;
  }): Promise<void>;

  /**
   * Look up the per-role config if this policy is YAML-driven. Other code
   * (e.g., the conflict recovery dispatcher) consults this to find
   * `on_conflict_recovery` overrides at dispatch time.
   */
  getRoleConfig?(role: string): RoleWorkspaceConfig | null;
}
