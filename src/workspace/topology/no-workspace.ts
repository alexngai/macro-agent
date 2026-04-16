/**
 * NoWorkspaceTopology — null TopologyPolicy.
 *
 * Returns `share-parent-cwd` for every spawn. Used when no team YAML declares
 * `macro_agent.workspace` — agents run in the spawner's cwd with no git-cascade
 * state. Safe default for teams that don't need isolation.
 *
 * @module workspace/topology/no-workspace
 */

import type {
  TopologyPolicy,
  TeamStartContext,
  TeamStartPlan,
  SpawnContext,
  WorkspaceDecision,
  AgentCompleteContext,
  TeamStopContext,
} from './types.js';

export class NoWorkspaceTopology implements TopologyPolicy {
  readonly name = 'no-workspace';

  async onTeamStart(_ctx: TeamStartContext): Promise<TeamStartPlan> {
    return {};
  }

  async onAgentSpawn(_ctx: SpawnContext): Promise<WorkspaceDecision> {
    return { kind: 'share-parent-cwd' };
  }

  async onAgentComplete(_ctx: AgentCompleteContext): Promise<void> {
    // No-op
  }

  async onTeamStop(_ctx: TeamStopContext): Promise<void> {
    // No-op
  }
}
