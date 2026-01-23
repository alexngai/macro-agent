/**
 * Role Registry Implementation
 *
 * Manages role definitions with layered resolution:
 * - Project-level (.macro-agent/roles)
 * - User-level (~/.macro-agent/roles)
 * - Built-in (framework)
 */

import type {
  RoleDefinition,
  RoleConfig,
  RoleRegistry,
  RoleValidation,
  ValidationError,
  ValidationWarning,
  Capability,
  Tool,
} from "./types.js";
import {
  BUILTIN_ROLES,
  getBuiltinRole,
  GenericRole,
} from "./builtin/index.js";
import {
  isKnownCapability,
  CAPABILITY_TOOL_MAP,
  WILDCARD_CAPABILITY,
  ALWAYS_ALLOWED_TOOLS,
  capabilityGrantsTool,
} from "./capabilities.js";

/**
 * Default Role Registry Implementation
 *
 * Provides role resolution with:
 * - Layered override support (project > user > built-in)
 * - Role inheritance via 'extends'
 * - Validation with graceful fallbacks
 */
export class DefaultRoleRegistry implements RoleRegistry {
  /** Custom roles registered at runtime */
  private customRoles: Map<string, RoleDefinition> = new Map();

  /** Project-level role overrides */
  private projectRoles: Map<string, RoleConfig> = new Map();

  /** User-level role overrides */
  private userRoles: Map<string, RoleConfig> = new Map();

  /**
   * Get a role by exact name (no inheritance resolution)
   */
  getRole(name: string): RoleDefinition | undefined {
    // Check custom roles first
    if (this.customRoles.has(name)) {
      return this.customRoles.get(name);
    }

    // Check project-level
    if (this.projectRoles.has(name)) {
      return this.projectRoles.get(name);
    }

    // Check user-level
    if (this.userRoles.has(name)) {
      return this.userRoles.get(name);
    }

    // Check built-in
    return getBuiltinRole(name);
  }

  /**
   * Register a custom role definition
   */
  registerRole(role: RoleDefinition): void {
    if (!role.name) {
      throw new Error("Role name is required");
    }
    this.customRoles.set(role.name, role);
  }

  /**
   * Register a project-level role override
   */
  registerProjectRole(role: RoleConfig): void {
    if (!role.name) {
      throw new Error("Role name is required");
    }
    this.projectRoles.set(role.name, role);
  }

  /**
   * Register a user-level role override
   */
  registerUserRole(role: RoleConfig): void {
    if (!role.name) {
      throw new Error("Role name is required");
    }
    this.userRoles.set(role.name, role);
  }

  /**
   * List all registered roles (custom + built-in)
   */
  listRoles(): RoleDefinition[] {
    const roles = new Map<string, RoleDefinition>();

    // Start with built-in
    for (const [name, role] of BUILTIN_ROLES) {
      roles.set(name, role);
    }

    // Override with user-level
    for (const [name, role] of this.userRoles) {
      roles.set(name, this.applyOverride(role, name));
    }

    // Override with project-level
    for (const [name, role] of this.projectRoles) {
      roles.set(name, this.applyOverride(role, name));
    }

    // Override with custom
    for (const [name, role] of this.customRoles) {
      roles.set(name, role);
    }

    return Array.from(roles.values());
  }

  /**
   * Resolve a role with inheritance and fallback
   */
  resolveRole(name: string): RoleDefinition {
    return this.loadRoleWithFallback(name);
  }

  /**
   * Check if a role has a specific capability
   */
  hasCapability(roleName: string, capability: Capability): boolean {
    const role = this.resolveRole(roleName);
    if (role.capabilities.includes(WILDCARD_CAPABILITY)) {
      return true;
    }
    return role.capabilities.includes(capability);
  }

  /**
   * Load a role with validation and fallback
   */
  private loadRoleWithFallback(roleName: string): RoleDefinition {
    try {
      const role = this.resolveRoleInternal(roleName);
      const validation = validateRole(role);

      if (!validation.isValid) {
        console.error(`Invalid role '${roleName}':`, validation.errors);
        return this.getFallbackRole(roleName);
      }

      if (validation.warnings.length > 0) {
        console.warn(`Role '${roleName}' warnings:`, validation.warnings);
      }

      return role;
    } catch (error) {
      console.error(`Failed to load role '${roleName}':`, error);
      return this.getFallbackRole(roleName);
    }
  }

  /**
   * Internal role resolution (without validation)
   */
  private resolveRoleInternal(roleName: string): RoleDefinition {
    // 1. Check project-level
    const projectRole = this.projectRoles.get(roleName);
    if (projectRole) {
      return this.applyOverride(projectRole, roleName);
    }

    // 2. Check user-level
    const userRole = this.userRoles.get(roleName);
    if (userRole) {
      return this.applyOverride(userRole, roleName);
    }

    // 3. Check custom roles
    const customRole = this.customRoles.get(roleName);
    if (customRole) {
      return customRole;
    }

    // 4. Check built-in
    const builtinRole = getBuiltinRole(roleName);
    if (builtinRole) {
      return builtinRole;
    }

    // 5. Fallback to generic
    console.warn(`Role '${roleName}' not found, falling back to 'generic'`);
    return GenericRole;
  }

  /**
   * Apply override logic to a role config
   */
  private applyOverride(role: RoleConfig, roleName: string): RoleDefinition {
    const builtin = getBuiltinRole(roleName);

    if (!builtin) {
      // New role, check extends
      if (role.extends) {
        const parent = this.resolveRoleInternal(role.extends);
        return mergeRoles(parent, role);
      }
      return role as RoleDefinition;
    }

    // Overriding built-in
    if (role.override === "replace") {
      return role as RoleDefinition;
    }

    if (role.override === "merge") {
      return mergeRoles(builtin, role);
    }

    // Default: treat as new role (doesn't override)
    if (role.extends) {
      const parent = this.resolveRoleInternal(role.extends);
      return mergeRoles(parent, role);
    }

    return role as RoleDefinition;
  }

  /**
   * Get fallback role for invalid/missing roles
   */
  private getFallbackRole(roleName: string): RoleDefinition {
    // Try to fall back to built-in version
    const builtin = getBuiltinRole(roleName);
    if (builtin) {
      console.info(`Falling back to built-in '${roleName}'`);
      return builtin;
    }

    // Fall back to generic
    console.info(`Falling back to 'generic' role`);
    return GenericRole;
  }
}

// =============================================================================
// Role Merging
// =============================================================================

/**
 * Merge a child role with a parent role (section-level override)
 */
export function mergeRoles(
  parent: RoleDefinition,
  child: RoleConfig
): RoleDefinition {
  return {
    // Identity from child
    name: child.name ?? parent.name,
    displayName: child.displayName ?? parent.displayName,
    description: child.description ?? parent.description,

    // Capabilities: child overrides completely (not merged)
    capabilities: child.capabilities ?? parent.capabilities,

    // Enforcement sections: child section replaces parent section entirely
    workspace: child.workspace ?? parent.workspace,
    tools: child.tools ?? parent.tools,
    lifecycle: child.lifecycle ?? parent.lifecycle,
    protocol: child.protocol ?? parent.protocol,
    permissions: child.permissions ?? parent.permissions,

    // Prompts: child overrides
    systemPrompt: child.systemPrompt ?? parent.systemPrompt,
    promptTemplate: child.promptTemplate ?? parent.promptTemplate,
  };
}

// =============================================================================
// Validation
// =============================================================================

/**
 * Validate a role definition
 */
export function validateRole(role: RoleDefinition): RoleValidation {
  const errors: ValidationError[] = [];
  const warnings: ValidationWarning[] = [];

  // Required fields
  if (!role.name) {
    errors.push({ field: "name", message: "Role name is required" });
  }

  if (!role.capabilities || role.capabilities.length === 0) {
    errors.push({
      field: "capabilities",
      message: "At least one capability required",
    });
  }

  // Capability validation
  for (const cap of role.capabilities ?? []) {
    if (cap !== WILDCARD_CAPABILITY && !isKnownCapability(cap)) {
      warnings.push({
        field: "capabilities",
        message: `Unknown capability: ${cap}`,
      });
    }
  }

  // Lifecycle consistency
  if (
    role.lifecycle?.type === "ephemeral" &&
    !role.capabilities?.includes("lifecycle.done")
  ) {
    warnings.push({
      field: "lifecycle",
      message: "Ephemeral role without lifecycle.done capability",
    });
  }

  return {
    errors,
    warnings,
    isValid: errors.length === 0,
  };
}

// =============================================================================
// Tool Filtering
// =============================================================================

/**
 * Filter tools based on role configuration
 */
export function filterToolsForRole(
  allTools: Tool[],
  role: RoleDefinition
): Tool[] {
  const toolConfig = role.tools ?? { mode: "capability" };

  switch (toolConfig.mode) {
    case "all":
      return allTools;

    case "allowlist":
      return allTools.filter((t) => toolConfig.tools?.includes(t.name));

    case "denylist":
      return allTools.filter((t) => !toolConfig.tools?.includes(t.name));

    case "capability":
    default:
      // Map capabilities to allowed tools
      const allowedTools = new Set(
        (role.capabilities ?? []).flatMap((cap) =>
          cap === WILDCARD_CAPABILITY
            ? allTools.map((t) => t.name)
            : CAPABILITY_TOOL_MAP[cap] ?? []
        )
      );
      return allTools.filter((t) => allowedTools.has(t.name));
  }
}

/**
 * Check if a specific tool is allowed for a role
 *
 * Used for runtime tool filtering enforcement.
 *
 * @param toolName - Name of the MCP tool to check
 * @param role - Resolved role definition
 * @returns true if the tool is allowed, false otherwise
 */
export function isToolAllowedForRole(
  toolName: string,
  role: RoleDefinition
): boolean {
  // Always-allowed tools (observability, read-only)
  if (ALWAYS_ALLOWED_TOOLS.includes(toolName)) {
    return true;
  }

  const toolConfig = role.tools ?? { mode: "capability" };

  switch (toolConfig.mode) {
    case "all":
      return true;

    case "allowlist":
      return toolConfig.tools?.includes(toolName) ?? false;

    case "denylist":
      return !toolConfig.tools?.includes(toolName);

    case "capability":
    default:
      // Wildcard capability = all tools allowed
      if (role.capabilities?.includes(WILDCARD_CAPABILITY)) {
        return true;
      }

      // Check if any capability grants this tool
      for (const cap of role.capabilities ?? []) {
        if (capabilityGrantsTool(cap, toolName)) {
          return true;
        }
      }

      return false;
  }
}

/**
 * Get the capability required for a tool (for error messages)
 *
 * @param toolName - Name of the MCP tool
 * @returns Capability string or undefined if no specific capability required
 */
export function getRequiredCapabilityForTool(
  toolName: string
): string | undefined {
  // Check always-allowed tools
  if (ALWAYS_ALLOWED_TOOLS.includes(toolName)) {
    return undefined; // No capability required
  }

  // Find the first capability that grants this tool
  for (const [capability, tools] of Object.entries(CAPABILITY_TOOL_MAP)) {
    if (tools.includes(toolName)) {
      return capability;
    }
  }

  return undefined;
}

// =============================================================================
// Default Instance
// =============================================================================

/**
 * Default role registry instance
 */
export const defaultRoleRegistry = new DefaultRoleRegistry();
