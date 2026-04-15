/**
 * YamlDrivenTopology — primary TopologyPolicy implementation.
 *
 * Compiles `TeamWorkspaceConfig` into per-spawn workspace decisions. Covers
 * all 6 workflows in `docs/git-cascade-integration-gaps.md` §5 through YAML
 * alone.
 *
 * @module workspace/topology/yaml-driven
 * @see docs/workspace-redesign-plan.md Phase 3
 */

import type { AgentId, StreamId, Principal } from '../types-v3.js';
import type {
  TeamWorkspaceConfig,
  RoleWorkspaceConfig,
  StreamLineage,
} from '../yaml-schema.js';
import type {
  TopologyPolicy,
  TeamStartContext,
  TeamStartPlan,
  SpawnContext,
  WorkspaceDecision,
  AgentCompleteContext,
  TeamStopContext,
} from './types.js';

/**
 * Topology policy driven entirely by `macro_agent.workspace` YAML.
 */
export class YamlDrivenTopology implements TopologyPolicy {
  readonly name = 'yaml-driven';

  private teamStreamId?: StreamId;
  private readonly agentStreams: Map<AgentId, StreamId> = new Map();

  constructor(private readonly config: TeamWorkspaceConfig) {}

  /**
   * Look up per-role config. Returns null for roles not declared in YAML.
   */
  getRoleConfig(role: string): RoleWorkspaceConfig | null {
    return this.config.roles[role] ?? null;
  }

  async onTeamStart(ctx: TeamStartContext): Promise<TeamStartPlan> {
    const needsTeamRoot = this.teamNeedsRootStream();
    if (!needsTeamRoot) {
      return {};
    }

    const forkFrom = this.config.default_stream?.fork_from ?? 'main';
    const nameTemplate = this.config.default_stream?.name_template ?? '{team}';
    const streamName = nameTemplate.replace('{team}', ctx.teamName);

    this.teamStreamId = ctx.workspaceManager.createStreamV3({
      name: streamName,
      ownerId: `team:${ctx.teamName}` as const,
      forkFrom,
      metadata: { kind: 'team_root', teamInstanceId: ctx.teamInstanceId },
    });

    return { teamStreamId: this.teamStreamId };
  }

  async onAgentSpawn(ctx: SpawnContext): Promise<WorkspaceDecision> {
    const roleConfig = this.getRoleConfig(ctx.role);
    if (!roleConfig) {
      // Role not declared in macro_agent.workspace → conservative default:
      // inherit parent's cwd (no isolation, no stream).
      return { kind: 'share-parent-cwd' };
    }

    switch (roleConfig.workspace) {
      case 'none':
        return { kind: 'none' };

      case 'share_parent_cwd':
        return { kind: 'share-parent-cwd' };

      case 'share_with_agent': {
        if (!roleConfig.share_with) {
          // Schema guarantees this, but double-check
          return { kind: 'share-parent-cwd' };
        }
        const partnerId = ctx.getAgentByRole?.(roleConfig.share_with);
        if (!partnerId) {
          // Partner role not yet spawned; fall back to share-parent-cwd.
          return { kind: 'share-parent-cwd' };
        }
        return { kind: 'share-with-agent', agentId: partnerId };
      }

      case 'attach_to_team_root': {
        if (!this.teamStreamId) {
          // Should have been created in onTeamStart; defensive fallback
          return { kind: 'share-parent-cwd' };
        }
        return {
          kind: 'attach-to-stream',
          streamId: this.teamStreamId,
          allocateWorktree: roleConfig.allocation !== 'inherit_parent_cwd',
        };
      }

      case 'new_stream': {
        const parent = this.resolveParentStream(roleConfig, ctx);
        const forkFrom =
          roleConfig.stream_lineage === 'independent'
            ? this.config.default_stream?.fork_from ?? 'main'
            : undefined;
        const streamName = this.buildStreamName(ctx.role, ctx.agentId);

        const spec = {
          name: streamName,
          ownerId: ctx.agentId,
          parent,
          forkFrom,
          metadata: { role: ctx.role },
        };

        return {
          kind: 'new-stream',
          streamSpec: spec,
          allocateWorktree: roleConfig.allocation !== 'inherit_parent_cwd',
        };
      }
    }
  }

  async onAgentComplete(ctx: AgentCompleteContext): Promise<void> {
    // Deallocate the agent's worktree (if any). Landing was already handled
    // by the LandingStrategy invoked from done(); this is pure cleanup.
    try {
      ctx.workspaceManager.deallocateWorkspace(ctx.agentId);
    } catch {
      // Non-fatal — agent may not have had a worktree
    }
    this.agentStreams.delete(ctx.agentId);
  }

  async onTeamStop(ctx: TeamStopContext): Promise<void> {
    if (!this.teamStreamId) return;

    const action = this.config.on_team_complete;
    switch (action) {
      case 'abandon':
        ctx.workspaceManager.abandonStream(this.teamStreamId, {
          cascade: true,
          reason: 'team stopped',
        });
        break;
      case 'merge_to_main':
        // Requires a landing strategy configured for the team stream.
        // Deferred to Phase 5 (LandingStrategy integration); log a warning.
        // Leaving stream active for now.
        break;
      case 'keep':
      default:
        // Leave the stream active for human review / PR.
        break;
    }
  }

  /**
   * Track agent→stream mapping after a successful spawn. Called externally
   * after the WorkspaceDecision is executed; lets the policy record state.
   */
  recordAgentStream(agentId: AgentId, streamId: StreamId): void {
    this.agentStreams.set(agentId, streamId);
  }

  /**
   * Get the stream attached to an agent (from our local tracking).
   */
  getAgentStream(agentId: AgentId): StreamId | null {
    return this.agentStreams.get(agentId) ?? null;
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  /**
   * A team needs a root stream if any role uses team-root-relative lineage or
   * attaches to the team root.
   */
  private teamNeedsRootStream(): boolean {
    for (const roleConfig of Object.values(this.config.roles)) {
      if (roleConfig.workspace === 'attach_to_team_root') return true;
      if (
        roleConfig.workspace === 'new_stream' &&
        (roleConfig.stream_lineage === 'from_team_root' ||
          roleConfig.stream_lineage === 'fork_from_team_root')
      ) {
        return true;
      }
    }
    return false;
  }

  private resolveParentStream(
    roleConfig: RoleWorkspaceConfig,
    ctx: SpawnContext
  ): StreamId | undefined {
    const lineage = roleConfig.stream_lineage;
    switch (lineage) {
      case 'fork_from_team_root':
      case 'from_team_root':
        return this.teamStreamId;
      case 'fork_from_parent':
        return ctx.parentStreamId ?? this.teamStreamId;
      case 'independent':
        return undefined;
      case 'track_existing_branch':
        return undefined; // Caller uses track_branch directly
      default:
        return undefined;
    }
  }

  private buildStreamName(role: string, agentId: AgentId): string {
    const shortId = agentId.slice(-8);
    return `${role}-${shortId}`;
  }
}
