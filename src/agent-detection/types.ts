/**
 * CLI Agent Auto-Detection Types
 *
 * Type definitions for detecting installed CLI coding agents
 * and constructing headless invocation commands.
 */

// =============================================================================
// Agent Definition
// =============================================================================

/**
 * Headless invocation configuration for a CLI agent.
 */
export interface HeadlessConfig {
  /** Subcommand before prompt (e.g., "exec" for codex, "run" for goose) */
  subcommand?: string;

  /** Flag to pass the prompt. Empty string means prompt is positional. */
  promptFlag: string;

  /** Default flags always included in headless mode */
  defaultFlags?: string[];
}

/**
 * Definition of a known CLI coding agent.
 * Describes how to detect and invoke the agent in headless mode.
 */
export interface CLIAgentDefinition {
  /** Unique identifier (e.g., "claude-code", "codex") */
  id: string;

  /** Human-readable display name */
  name: string;

  /** Short description */
  description: string;

  /** The binary/command name to invoke */
  binary: string;

  /** Arguments to check version (typically ["--version"]) */
  versionArgs: string[];

  /** Headless invocation configuration */
  headless: HeadlessConfig;

  /** Flag for model selection (e.g., "--model") */
  modelFlag?: string;

  /** Flag for working directory (e.g., "--cwd", "--path") */
  cwdFlag?: string;

  /** Provider/vendor name */
  vendor: string;
}

// =============================================================================
// Detection Results
// =============================================================================

/**
 * Result of detecting a single CLI agent on the system.
 */
export interface DetectedAgent {
  /** Agent definition ID */
  id: string;

  /** Human-readable name */
  name: string;

  /** Whether the binary was found on PATH */
  installed: boolean;

  /** Parsed version string (e.g., "1.2.3") */
  version?: string;

  /** Absolute path to binary */
  path?: string;

  /** The full agent definition (for client display) */
  definition: CLIAgentDefinition;

  /** When detection was performed (epoch ms) */
  detectedAt: number;
}

/**
 * Result of a full detection scan across all known agents.
 */
export interface DetectionResult {
  /** All agents (installed and not installed) */
  agents: DetectedAgent[];

  /** Number of agents scanned */
  scanned: number;

  /** Detection duration in milliseconds */
  durationMs: number;

  /** Whether detection is still in progress */
  pending?: boolean;
}

// =============================================================================
// Command Builder
// =============================================================================

/**
 * Options for building a spawn command.
 */
export interface SpawnCommandOptions {
  /** Model to use (passed via modelFlag) */
  model?: string;

  /** Working directory (passed via cwdFlag) */
  cwd?: string;
}

/**
 * Result of building a spawn command.
 */
export interface SpawnCommand {
  /** The binary/command to execute */
  command: string;

  /** Arguments to pass to the command */
  args: string[];
}

// =============================================================================
// Detection Configuration
// =============================================================================

/**
 * Configuration for the agent detection system.
 */
export interface AgentDetectionConfig {
  /** Whether agent detection is enabled (default: true) */
  enabled?: boolean;

  /** Cache TTL in milliseconds (default: 60000) */
  cacheTtlMs?: number;

  /** Timeout for `which` calls in milliseconds (default: 5000) */
  whichTimeoutMs?: number;

  /** Timeout for version checks in milliseconds (default: 10000) */
  versionTimeoutMs?: number;

  /** Additional custom agent definitions to include */
  additionalAgents?: CLIAgentDefinition[];

  /** Agent IDs to exclude from detection */
  disabledAgents?: string[];
}

// =============================================================================
// Errors
// =============================================================================

/**
 * Error codes for agent detection operations.
 */
export type AgentDetectionErrorCode =
  | "UNKNOWN_AGENT"
  | "AGENT_NOT_INSTALLED"
  | "DETECTION_FAILED"
  | "DETECTION_TIMEOUT";

/**
 * Error thrown by agent detection operations.
 */
export class AgentDetectionError extends Error {
  constructor(
    message: string,
    public readonly code: AgentDetectionErrorCode,
    public readonly agentId?: string
  ) {
    super(message);
    this.name = "AgentDetectionError";
  }
}
