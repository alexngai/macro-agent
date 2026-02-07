/**
 * Project Configuration Loader
 *
 * Reads .macro-agent/config.json for project-level settings.
 *
 * @module config/project-config
 */

import * as fs from "fs";
import * as path from "path";

// =============================================================================
// Types
// =============================================================================

/**
 * Project-level configuration schema.
 *
 * Loaded from .macro-agent/config.json in the project root.
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
export const CONFIG_DIR = ".macro-agent";

/** Config file name */
export const CONFIG_FILE = "config.json";

// =============================================================================
// Loader
// =============================================================================

/**
 * Get the project config file path.
 *
 * @param projectPath - Project root directory (default: process.cwd())
 * @returns Absolute path to .macro-agent/config.json
 */
export function getProjectConfigPath(projectPath?: string): string {
  const root = projectPath ?? process.cwd();
  return path.join(root, CONFIG_DIR, CONFIG_FILE);
}

/**
 * Load project configuration from .macro-agent/config.json.
 *
 * Returns empty config if the file doesn't exist.
 * Throws on invalid JSON.
 *
 * @param projectPath - Project root directory (default: process.cwd())
 * @returns Parsed ProjectConfig
 */
export function loadProjectConfig(projectPath?: string): ProjectConfig {
  const configPath = getProjectConfigPath(projectPath);

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
    return parsed as ProjectConfig;
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
