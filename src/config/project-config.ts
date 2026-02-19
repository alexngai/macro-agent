/**
 * Configuration Loader
 *
 * Layered configuration system with priority (highest to lowest):
 * 1. Environment variables (MACRO_*, OPENTASKS_*)
 * 2. Project config: .multiagent/config.json
 * 3. Global config: ~/.multiagent/config.json
 *
 * @module config/project-config
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// =============================================================================
// Types
// =============================================================================

/**
 * Typed configuration schema for multiagent.
 *
 * Loaded from .multiagent/config.json (project or global).
 * Environment variables override file-based config.
 */
export interface MultiagentConfig {
  /** Team template name to load on startup */
  team?: string;

  /** Server port (default: 3001) */
  port?: number;

  /** Server host (default: "localhost") */
  host?: string;

  /** Authentication config */
  auth?: {
    /** Disable auth entirely */
    disabled?: boolean;
    /** Server secret token */
    secret?: string;
  };

  /** Task backend config */
  task?: {
    /** Backend type: "memory" | "opentasks" */
    backend?: string;
    /** OpenTasks-specific config */
    opentasks?: {
      /** Path to OpenTasks daemon socket */
      socket_path?: string;
      /** Auto-start central daemon (default: true) */
      auto_start?: boolean;
      /** Central daemon location (default: ~/.multiagent/opentasks) */
      central_path?: string;
      /** Auto-connect project .opentasks/ on agent spawn (default: true) */
      connect_on_spawn?: boolean;
    };
  };
}

/**
 * Legacy project config interface (backwards compatibility).
 */
export interface ProjectConfig {
  /** Team template name to load on startup */
  team?: string;

  /** Additional project-level settings (extensible) */
  [key: string]: unknown;
}

// =============================================================================
// Constants
// =============================================================================

/** Config directory name */
export const CONFIG_DIR = ".multiagent";

/** Config file name */
export const CONFIG_FILE = "config.json";

// =============================================================================
// JSON Loader (shared)
// =============================================================================

/**
 * Load and parse a JSON config file.
 * Returns empty object if file doesn't exist.
 * Throws on invalid JSON.
 */
function loadJsonConfig(configPath: string): Record<string, unknown> {
  if (!fs.existsSync(configPath)) {
    return {};
  }

  const raw = fs.readFileSync(configPath, "utf-8");

  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new ProjectConfigError(
        `Config must be a JSON object, got ${Array.isArray(parsed) ? "array" : typeof parsed}`,
        "INVALID_FORMAT",
        configPath
      );
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof ProjectConfigError) throw error;
    throw new ProjectConfigError(
      `Failed to parse ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
      "PARSE_ERROR",
      configPath
    );
  }
}

// =============================================================================
// Path Resolution
// =============================================================================

/**
 * Get the project config file path.
 *
 * @param projectPath - Project root directory (default: process.cwd())
 * @returns Absolute path to .multiagent/config.json
 */
export function getProjectConfigPath(projectPath?: string): string {
  const root = projectPath ?? process.cwd();
  return path.join(root, CONFIG_DIR, CONFIG_FILE);
}

/**
 * Get the global config file path.
 *
 * @returns Absolute path to ~/.multiagent/config.json
 */
export function getGlobalConfigPath(): string {
  return path.join(os.homedir(), CONFIG_DIR, CONFIG_FILE);
}

// =============================================================================
// Individual Loaders
// =============================================================================

/**
 * Load project configuration from .multiagent/config.json.
 *
 * Returns empty config if the file doesn't exist.
 * Throws on invalid JSON.
 *
 * @param projectPath - Project root directory (default: process.cwd())
 * @returns Parsed ProjectConfig
 */
export function loadProjectConfig(projectPath?: string): ProjectConfig {
  return loadJsonConfig(getProjectConfigPath(projectPath)) as ProjectConfig;
}

/**
 * Load global configuration from ~/.multiagent/config.json.
 *
 * Returns empty config if the file doesn't exist.
 * Throws on invalid JSON.
 *
 * @returns Parsed config
 */
export function loadGlobalConfig(): MultiagentConfig {
  return loadJsonConfig(getGlobalConfigPath()) as MultiagentConfig;
}

// =============================================================================
// Merged Config (layered)
// =============================================================================

/**
 * Deep merge two objects. Source values override target values.
 * Only merges plain objects recursively; arrays and primitives are replaced.
 */
function deepMerge<T extends Record<string, unknown>>(target: T, source: Record<string, unknown>): T {
  const result = { ...target };

  for (const key of Object.keys(source)) {
    const sourceVal = source[key];
    const targetVal = (result as Record<string, unknown>)[key];

    if (
      sourceVal !== undefined &&
      sourceVal !== null &&
      typeof sourceVal === "object" &&
      !Array.isArray(sourceVal) &&
      typeof targetVal === "object" &&
      targetVal !== null &&
      !Array.isArray(targetVal)
    ) {
      (result as Record<string, unknown>)[key] = deepMerge(
        targetVal as Record<string, unknown>,
        sourceVal as Record<string, unknown>
      );
    } else if (sourceVal !== undefined) {
      (result as Record<string, unknown>)[key] = sourceVal;
    }
  }

  return result;
}

/**
 * Load merged configuration with layered priority:
 * 1. Environment variables (highest)
 * 2. Project .multiagent/config.json
 * 3. Global ~/.multiagent/config.json (lowest)
 *
 * Only server-level settings are merged. Agent-level env vars
 * (MACRO_AGENT_ID, MACRO_SERVER_URL, etc.) are internal wiring
 * and not part of this config.
 *
 * @param projectPath - Project root directory (default: process.cwd())
 * @returns Fully merged MultiagentConfig
 */
export function loadMergedConfig(projectPath?: string): MultiagentConfig {
  const globalConfig = loadGlobalConfig();
  const projectConfig = loadProjectConfig(projectPath);

  // Layer 1: global (lowest priority)
  // Layer 2: project overrides global
  const merged: MultiagentConfig = deepMerge(
    globalConfig as Record<string, unknown>,
    projectConfig as Record<string, unknown>,
  ) as MultiagentConfig;

  // Layer 3: env vars override everything (server-level only)
  if (process.env.MACRO_TASK_BACKEND) {
    merged.task = { ...(merged.task ?? {}), backend: process.env.MACRO_TASK_BACKEND };
  }
  if (process.env.OPENTASKS_SOCKET_PATH) {
    merged.task = {
      ...(merged.task ?? {}),
      opentasks: {
        ...(merged.task?.opentasks ?? {}),
        socket_path: process.env.OPENTASKS_SOCKET_PATH,
      },
    };
  }
  if (process.env.MACRO_SERVER_SECRET) {
    merged.auth = { ...(merged.auth ?? {}), secret: process.env.MACRO_SERVER_SECRET };
  }
  if (process.env.MACRO_NO_AUTH === "true") {
    merged.auth = { ...(merged.auth ?? {}), disabled: true };
  }

  return merged;
}

// =============================================================================
// Errors
// =============================================================================

export type ProjectConfigErrorCode = "PARSE_ERROR" | "INVALID_FORMAT";

export class ProjectConfigError extends Error {
  constructor(
    message: string,
    public readonly code: ProjectConfigErrorCode,
    public readonly configPath: string
  ) {
    super(message);
    this.name = "ProjectConfigError";
  }
}
