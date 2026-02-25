/**
 * Role System Type Definitions
 *
 * Implements the composable role system from s-60tc:
 * - Capability-based permissions
 * - Enforcement mechanisms (workspace, tools, lifecycle, protocol, permissions)
 * - Role definition and registry interfaces
 */

// =============================================================================
// Capabilities (Atomic Permission Units)
// =============================================================================

/** File operation capabilities */
export type FileCapability = "file.read" | "file.write" | "file.delete";

/** Git operation capabilities */
export type GitCapability =
  | "git.commit"
  | "git.merge"
  | "git.push"
  | "git.branch.create"
  | "git.branch.delete";

/** Agent management capabilities */
export type AgentCapability =
  | "agent.spawn.worker"
  | "agent.spawn.integrator"
  | "agent.spawn.monitor"
  | "agent.spawn.custom"
  | "agent.terminate";

/** Lifecycle capabilities */
export type LifecycleCapability =
  | "lifecycle.done"
  | "lifecycle.persistent"
  | "lifecycle.daemon";

/** Task management capabilities (via TaskBackend, see s-8472) */
export type TaskCapability =
  | "task.create"
  | "task.assign"
  | "task.update"
  | "task.close"
  | "task.claim";

/** Execution capabilities */
export type ExecCapability =
  | "exec.command"
  | "exec.build"
  | "exec.test"
  | "exec.lint";

/** Communication capabilities */
export type MsgCapability = "msg.send" | "msg.broadcast" | "msg.subscribe";

/** Workspace capabilities */
export type WorkspaceCapability =
  | "workspace.worktree"
  | "workspace.stream"
  | "workspace.integrate";

/** All capability types combined, plus wildcard */
export type Capability =
  | FileCapability
  | GitCapability
  | AgentCapability
  | LifecycleCapability
  | TaskCapability
  | ExecCapability
  | MsgCapability
  | WorkspaceCapability
  | "*"; // Wildcard for all capabilities

// =============================================================================
// Enforcement Mechanisms
// =============================================================================

/**
 * Workspace Enforcement
 * Controls filesystem access and isolation.
 */
export interface WorkspaceEnforcement {
  /** Workspace type */
  type: "own" | "shared" | "mount" | "none";

  /** For 'own' type: branch naming pattern */
  branchPattern?: string;

  /** For 'own' type: cleanup workspace on agent termination */
  cleanupOnTerminate?: boolean;

  /** For 'own' type: can read child workspace paths (Coordinator) */
  canViewChildWorkspaces?: boolean;

  /** For 'shared' type: role names to share with */
  sharedWith?: string[];

  /** For 'mount' type: branch/path to mount */
  mountTarget?: string;

  /** For 'mount' type: read-only access */
  readonly?: boolean;
}

/**
 * Tool Enforcement
 * Controls which MCP tools are available.
 */
export interface ToolEnforcement {
  /** Mode for tool filtering */
  mode: "capability" | "allowlist" | "denylist" | "all";

  /** For allowlist/denylist modes: explicit tool names */
  tools?: string[];
}

/**
 * Lifecycle Enforcement
 * Controls agent lifecycle behavior.
 */
export interface LifecycleEnforcement {
  /** Lifecycle type */
  type: "ephemeral" | "persistent" | "daemon" | "event-driven";

  /** For ephemeral: terminate when task completes */
  taskBound?: boolean;

  /** For ephemeral: timeout in milliseconds (default: 30 min for workers) */
  maxDurationMs?: number;

  /** For event-driven: terminate when parent terminates */
  parentBound?: boolean;

  /** For all types: terminate children on done */
  cascadeTerminate?: boolean;

  /** For all types: clean own workspace on done */
  selfCleanup?: boolean;
}

/**
 * Protocol Enforcement
 * Controls message routing and subscriptions.
 */
export interface ProtocolEnforcement {
  /** Message patterns to receive */
  subscriptions: string[];

  /** Message patterns allowed to send */
  canEmit: string[];
}

/**
 * Capability restriction for fine-grained control
 */
export interface CapabilityRestriction {
  /** Scope restriction (e.g., "own-workspace" vs "any") */
  scope?: string;

  /** Rate limit (max calls per minute) */
  rateLimit?: number;

  /** Requires human approval */
  requireApproval?: boolean;
}

/**
 * Permission Enforcement
 * Controls capability-level permissions with optional restrictions.
 */
export interface PermissionEnforcement {
  /** List of capability IDs */
  capabilities: Capability[];

  /** Optional restrictions on capabilities */
  restrictions?: Record<string, CapabilityRestriction>;
}

// =============================================================================
// Role Definition
// =============================================================================

/**
 * Role Definition
 * Combines capabilities with enforcement mechanisms.
 */
export interface RoleDefinition {
  // Identity
  /** Unique role identifier (supports dot-notation like 'worker.resolver') */
  name: string;

  /** Human-readable name */
  displayName?: string;

  /** Role purpose description */
  description?: string;

  // Capabilities
  /** List of capability IDs */
  capabilities: Capability[];

  // Enforcement (all optional - defaults applied)
  /** Workspace enforcement configuration */
  workspace?: WorkspaceEnforcement;

  /** Tool enforcement configuration */
  tools?: ToolEnforcement;

  /** Lifecycle enforcement configuration */
  lifecycle?: LifecycleEnforcement;

  /** Protocol enforcement configuration */
  protocol?: ProtocolEnforcement;

  /** Permission enforcement configuration */
  permissions?: PermissionEnforcement;

  // Composition
  /** Inherit from another role */
  extends?: string;

  // Instructions (behavioral guidance via prompts)
  /** Role-specific system prompt */
  systemPrompt?: string;

  /** Path to prompt template file */
  promptTemplate?: string;
}

/**
 * Role Configuration
 * Extends RoleDefinition with override behavior for configuration files.
 */
export interface RoleConfig extends RoleDefinition {
  /** Override behavior (only for roles matching built-in names) */
  override?: "replace" | "merge";
}

// =============================================================================
// Agent Spawn Config with Role
// =============================================================================

/**
 * Capability overrides for per-spawn customization
 */
export interface CapabilityOverrides {
  /** Capabilities to add */
  add?: Capability[];

  /** Capabilities to remove */
  remove?: Capability[];
}

/**
 * Agent spawn configuration including role
 */
export interface AgentSpawnConfig {
  /** Role name */
  role: string;

  /** Task ID to bind to */
  taskId?: string;

  /** Parent agent ID */
  parentId?: string;

  /** Override role's system prompt */
  customPrompt?: string;

  /** Per-spawn capability tweaks */
  capabilityOverrides?: CapabilityOverrides;
}

// =============================================================================
// Role Registry
// =============================================================================

/**
 * Role Registry Interface
 * Manages role definitions with layered resolution.
 */
export interface RoleRegistry {
  /** Get a role by name (exact match, no inheritance) */
  getRole(name: string): RoleDefinition | undefined;

  /** Register a role definition */
  registerRole(role: RoleDefinition): void;

  /** List all registered roles */
  listRoles(): RoleDefinition[];

  /** Resolve a role with inheritance and fallback */
  resolveRole(name: string): RoleDefinition;

  /** Check if a role has a specific capability */
  hasCapability(roleName: string, capability: Capability): boolean;
}

// =============================================================================
// Validation
// =============================================================================

/**
 * Validation error
 */
export interface ValidationError {
  field: string;
  message: string;
}

/**
 * Validation warning
 */
export interface ValidationWarning {
  field: string;
  message: string;
}

/**
 * Role validation result
 */
export interface RoleValidation {
  errors: ValidationError[];
  warnings: ValidationWarning[];
  isValid: boolean;
}

// =============================================================================
// Tool Filtering
// =============================================================================

/**
 * Tool interface for filtering
 */
export interface Tool {
  name: string;
  description?: string;
}

/**
 * Capability to tool mapping type
 */
export type CapabilityToolMap = Record<string, string[]>;
