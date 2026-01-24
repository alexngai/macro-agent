/**
 * Role Configuration File Loader
 *
 * Loads role configurations from:
 * - Project-level: .macro-agent/roles.json
 * - User-level: ~/.macro-agent/roles.json
 *
 * Supports layered override with project > user > built-in precedence.
 *
 * @module roles/config-loader
 * @see s-60tc Specialized Agent Roles
 * @see i-7j9m Project Role Config File Loading
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import type { RoleConfig, Capability } from "./types.js";

// =============================================================================
// Configuration Types
// =============================================================================

/**
 * Role configuration file format
 */
export interface RoleConfigFile {
  /** Role definitions keyed by role name */
  roles?: Record<string, RoleConfigEntry>;

  /** Schema version for future compatibility */
  version?: string;
}

/**
 * Individual role entry in config file
 * Supports shorthand capability modifiers (+/-) and full RoleConfig
 */
export interface RoleConfigEntry {
  /** Inherit from another role */
  extends?: string;

  /** Override behavior for built-in roles */
  override?: "replace" | "merge";

  /** Display name */
  displayName?: string;

  /** Description */
  description?: string;

  /**
   * Capabilities - can be:
   * - Array of capability strings (replaces parent)
   * - Array with +/- prefixes (additive/subtractive)
   */
  capabilities?: string[];

  /** Workspace configuration */
  workspace?: RoleConfig["workspace"];

  /** Tool configuration */
  tools?: RoleConfig["tools"];

  /** Lifecycle configuration */
  lifecycle?: RoleConfig["lifecycle"];

  /** Protocol configuration */
  protocol?: RoleConfig["protocol"];

  /** Permission configuration */
  permissions?: RoleConfig["permissions"];

  /** System prompt */
  systemPrompt?: string;

  /** Prompt template path */
  promptTemplate?: string;
}

/**
 * Result of loading a config file
 */
export interface LoadResult {
  /** Successfully loaded roles */
  roles: RoleConfig[];

  /** Warnings encountered during loading */
  warnings: string[];

  /** Path that was loaded (or attempted) */
  path: string;

  /** Whether the file was found */
  found: boolean;
}

// =============================================================================
// Constants
// =============================================================================

/** Default config file name */
export const CONFIG_FILE_NAME = "roles.json";

/** Project-level config directory */
export const PROJECT_CONFIG_DIR = ".macro-agent";

/** User-level config directory */
export const USER_CONFIG_DIR = ".macro-agent";

// =============================================================================
// Path Resolution
// =============================================================================

/**
 * Get the project-level config file path
 *
 * @param projectPath - Project root directory (default: process.cwd())
 * @returns Path to .macro-agent/roles.json
 */
export function getProjectConfigPath(projectPath?: string): string {
  const root = projectPath ?? process.cwd();
  return path.join(root, PROJECT_CONFIG_DIR, CONFIG_FILE_NAME);
}

/**
 * Get the user-level config file path
 *
 * @returns Path to ~/.macro-agent/roles.json
 */
export function getUserConfigPath(): string {
  return path.join(os.homedir(), USER_CONFIG_DIR, CONFIG_FILE_NAME);
}

// =============================================================================
// Config Parsing
// =============================================================================

/**
 * Parse capability string with +/- modifiers
 *
 * @param capabilities - Array of capability strings (may have +/- prefixes)
 * @param parentCapabilities - Parent role's capabilities (for modifier mode)
 * @returns Resolved capability array
 */
export function parseCapabilities(
  capabilities: string[],
  parentCapabilities: Capability[] = []
): Capability[] {
  // Check if using modifier syntax (+/-)
  const hasModifiers = capabilities.some(
    (c) => c.startsWith("+") || c.startsWith("-")
  );

  if (!hasModifiers) {
    // Simple replacement mode - return as-is
    return capabilities as Capability[];
  }

  // Modifier mode - start with parent capabilities
  const result = new Set<string>(parentCapabilities);

  for (const cap of capabilities) {
    if (cap.startsWith("+")) {
      // Add capability
      result.add(cap.slice(1));
    } else if (cap.startsWith("-")) {
      // Remove capability
      result.delete(cap.slice(1));
    } else {
      // No modifier - add as-is
      result.add(cap);
    }
  }

  return Array.from(result) as Capability[];
}

/**
 * Convert a RoleConfigEntry to a full RoleConfig
 *
 * @param name - Role name
 * @param entry - Config entry from file
 * @param parentCapabilities - Parent role's capabilities (if extends)
 * @returns Full RoleConfig
 */
export function entryToRoleConfig(
  name: string,
  entry: RoleConfigEntry,
  parentCapabilities: Capability[] = []
): RoleConfig {
  // If no capabilities specified and role extends another, leave undefined
  // so the registry can properly inherit from parent
  let capabilities: Capability[] | undefined;

  if (entry.capabilities && entry.capabilities.length > 0) {
    capabilities = parseCapabilities(entry.capabilities, parentCapabilities);
  } else if (parentCapabilities.length > 0) {
    // Parent capabilities provided directly (not via extends)
    capabilities = parentCapabilities;
  }
  // If neither, capabilities remains undefined for registry to handle via extends

  return {
    name,
    displayName: entry.displayName,
    description: entry.description,
    extends: entry.extends,
    override: entry.override,
    capabilities: capabilities as Capability[], // Type assertion needed due to interface
    workspace: entry.workspace,
    tools: entry.tools,
    lifecycle: entry.lifecycle,
    protocol: entry.protocol,
    permissions: entry.permissions,
    systemPrompt: entry.systemPrompt,
    promptTemplate: entry.promptTemplate,
  };
}

// =============================================================================
// File Loading
// =============================================================================

/**
 * Load a role config file from disk
 *
 * @param filePath - Path to the config file
 * @returns Load result with roles and warnings
 */
export function loadConfigFile(filePath: string): LoadResult {
  const result: LoadResult = {
    roles: [],
    warnings: [],
    path: filePath,
    found: false,
  };

  // Check if file exists
  if (!fs.existsSync(filePath)) {
    return result;
  }

  result.found = true;

  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const config = JSON.parse(content) as RoleConfigFile;

    // Validate version if present
    if (config.version && config.version !== "1") {
      result.warnings.push(
        `Unknown config version: ${config.version}, expected '1'`
      );
    }

    // Parse roles
    if (config.roles) {
      for (const [name, entry] of Object.entries(config.roles)) {
        try {
          // For now, we don't resolve parent capabilities during file loading
          // The registry will handle inheritance resolution
          const roleConfig = entryToRoleConfig(name, entry);
          result.roles.push(roleConfig);
        } catch (error) {
          result.warnings.push(
            `Failed to parse role '${name}': ${error instanceof Error ? error.message : error}`
          );
        }
      }
    }
  } catch (error) {
    result.warnings.push(
      `Failed to parse config file: ${error instanceof Error ? error.message : error}`
    );
  }

  return result;
}

/**
 * Load project-level role config
 *
 * @param projectPath - Project root directory
 * @returns Load result
 */
export function loadProjectConfig(projectPath?: string): LoadResult {
  return loadConfigFile(getProjectConfigPath(projectPath));
}

/**
 * Load user-level role config
 *
 * @returns Load result
 */
export function loadUserConfig(): LoadResult {
  return loadConfigFile(getUserConfigPath());
}

// =============================================================================
// Registry Integration
// =============================================================================

/**
 * Options for loading configs into a registry
 */
export interface LoadConfigOptions {
  /** Project root directory for project-level config */
  projectPath?: string;

  /** Skip loading user-level config */
  skipUserConfig?: boolean;

  /** Skip loading project-level config */
  skipProjectConfig?: boolean;

  /** Custom config file paths (overrides default paths) */
  configPaths?: {
    project?: string;
    user?: string;
  };
}

/**
 * Result of loading all configs
 */
export interface LoadAllResult {
  /** User-level load result */
  user: LoadResult;

  /** Project-level load result */
  project: LoadResult;

  /** Total roles loaded */
  totalRoles: number;

  /** All warnings */
  allWarnings: string[];
}

/**
 * Load all config files (user and project level)
 *
 * @param options - Load options
 * @returns Combined load results
 */
export function loadAllConfigs(options: LoadConfigOptions = {}): LoadAllResult {
  const userResult: LoadResult = options.skipUserConfig
    ? { roles: [], warnings: [], path: "", found: false }
    : loadConfigFile(options.configPaths?.user ?? getUserConfigPath());

  const projectResult: LoadResult = options.skipProjectConfig
    ? { roles: [], warnings: [], path: "", found: false }
    : loadConfigFile(
        options.configPaths?.project ?? getProjectConfigPath(options.projectPath)
      );

  return {
    user: userResult,
    project: projectResult,
    totalRoles: userResult.roles.length + projectResult.roles.length,
    allWarnings: [...userResult.warnings, ...projectResult.warnings],
  };
}

/**
 * Watch a config file for changes
 *
 * @param filePath - Path to watch
 * @param callback - Called when file changes
 * @returns Unsubscribe function
 */
export function watchConfigFile(
  filePath: string,
  callback: (result: LoadResult) => void
): () => void {
  // Check if file exists before watching
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    // Directory doesn't exist, nothing to watch
    return () => {};
  }

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const watcher = fs.watch(dir, (eventType, filename) => {
    if (filename === path.basename(filePath)) {
      // Debounce to avoid multiple rapid callbacks
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
      debounceTimer = setTimeout(() => {
        callback(loadConfigFile(filePath));
      }, 100);
    }
  });

  return () => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    watcher.close();
  };
}
