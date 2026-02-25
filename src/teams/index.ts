export { loadTeam } from "./team-loader.js";
export { TeamRuntime, type TeamServices, type TeamBootstrapResult } from "./team-runtime.js";
export { TeamManager, type TeamInstance, type TeamStartOverrides } from "./team-manager.js";
export { seedDefaultTemplates } from "./seed-defaults.js";
export {
  TeamLoadError,
  // Core types
  type TeamManifest,
  type MacroResolvedTemplate,
  type MacroAgentExtensions,
  type ResolvedTeamRole,
  type TeamLoadErrorCode,
  // Backward-compatible aliases
  type TeamTopology,
  type TeamCommunication,
  type TeamRoleDefinition,
  // openteams canonical types
  type TopologyConfig,
  type TopologyNode,
  type CommunicationConfig,
  type ChannelDefinition,
  type SubscriptionEntry,
  type RoutingConfig,
  type PeerRoute,
  type McpServerEntry,
  type CapabilityComposition,
  type ResolvedTemplate,
  type ResolvedRole,
  type ResolvedPrompts,
  type PromptSection,
} from "./types.js";
