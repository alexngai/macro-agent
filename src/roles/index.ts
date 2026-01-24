/**
 * Role System Module
 *
 * Exports all role-related types, utilities, and built-in definitions.
 *
 * @module roles
 * @see s-60tc Specialized Agent Roles spec
 */

// =============================================================================
// Types
// =============================================================================

export type {
  // Capabilities
  FileCapability,
  GitCapability,
  AgentCapability,
  LifecycleCapability,
  TaskCapability,
  ExecCapability,
  MsgCapability,
  Capability,

  // Enforcement
  WorkspaceEnforcement,
  ToolEnforcement,
  LifecycleEnforcement,
  ProtocolEnforcement,
  CapabilityRestriction,
  PermissionEnforcement,

  // Roles
  RoleDefinition,
  RoleConfig,
  CapabilityOverrides,
  AgentSpawnConfig,
  RoleRegistry,

  // Validation
  ValidationError,
  ValidationWarning,
  RoleValidation,

  // Tools
  Tool,
  CapabilityToolMap,
} from "./types.js";

// =============================================================================
// Capabilities
// =============================================================================

export {
  // Capability constants
  FILE_CAPABILITIES,
  GIT_CAPABILITIES,
  AGENT_CAPABILITIES,
  LIFECYCLE_CAPABILITIES,
  TASK_CAPABILITIES,
  EXEC_CAPABILITIES,
  MSG_CAPABILITIES,
  WILDCARD_CAPABILITY,

  // Capability utilities
  ALL_CAPABILITIES,
  isKnownCapability,
  CAPABILITY_TOOL_MAP,
  getToolsForCapabilities,
  capabilityGrantsTool,
} from "./capabilities.js";

// =============================================================================
// Built-in Roles
// =============================================================================

export {
  // Role definitions
  WorkerRole,
  ResolverWorkerRole,
  IntegratorRole,
  CoordinatorRole,
  MonitorRole,
  GenericRole,

  // Role utilities
  BUILTIN_ROLES,
  getBuiltinRole,
  isBuiltinRole,
  listBuiltinRoleNames,
} from "./builtin/index.js";

// =============================================================================
// Registry
// =============================================================================

export {
  DefaultRoleRegistry,
  defaultRoleRegistry,
  mergeRoles,
  validateRole,
  filterToolsForRole,
  isToolAllowedForRole,
  getRequiredCapabilityForTool,
} from "./registry.js";

export type { RoleRegistryConfig } from "./registry.js";

// =============================================================================
// Config Loader
// =============================================================================

export {
  // Path utilities
  getProjectConfigPath,
  getUserConfigPath,
  CONFIG_FILE_NAME,
  PROJECT_CONFIG_DIR,
  USER_CONFIG_DIR,

  // Config parsing
  parseCapabilities,
  entryToRoleConfig,

  // File loading
  loadConfigFile,
  loadProjectConfig,
  loadUserConfig,
  loadAllConfigs,

  // File watching
  watchConfigFile,
} from "./config-loader.js";

export type {
  RoleConfigFile,
  RoleConfigEntry,
  LoadResult,
  LoadConfigOptions,
  LoadAllResult,
} from "./config-loader.js";
