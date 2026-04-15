/**
 * Topology policies — compile team YAML into workspace decisions.
 *
 * @module workspace/topology
 */

export type {
  TopologyPolicy,
  TeamStartContext,
  TeamStartPlan,
  SpawnContext,
  WorkspaceDecision,
  AgentCompleteContext,
  TeamStopContext,
} from './types.js';

export { YamlDrivenTopology } from './yaml-driven.js';
export { NoWorkspaceTopology } from './no-workspace.js';
