/**
 * ACP module - Agent Communication Protocol support for macro-agent
 *
 * Enables macro-agent to run as an ACP-compliant agent that external
 * systems can spawn and control.
 */

import { AgentFactory } from "acp-factory";

// ─────────────────────────────────────────────────────────────────
// Registration Helper
// ─────────────────────────────────────────────────────────────────

export interface RegisterOptions {
  /**
   * Custom command to run macro-agent ACP server.
   * Defaults to "npx" with args ["multiagent-acp"]
   */
  command?: string;

  /**
   * Custom arguments for the command.
   * Defaults to ["multiagent-acp"]
   */
  args?: string[];

  /**
   * Environment variables to pass to the process.
   */
  env?: Record<string, string>;
}

/**
 * Register macro-agent with acp-factory for easy spawning.
 *
 * After calling this, you can spawn macro-agent via:
 * ```typescript
 * const handle = await AgentFactory.spawn("macro-agent", { ... });
 * ```
 *
 * @example
 * ```typescript
 * import { registerMacroAgent } from "macro-agent";
 *
 * // Register with defaults
 * registerMacroAgent();
 *
 * // Or with custom options
 * registerMacroAgent({
 *   command: "node",
 *   args: ["./dist/cli/acp.js"],
 * });
 *
 * // Now spawn it
 * const handle = await AgentFactory.spawn("macro-agent", {
 *   permissionMode: "auto-approve",
 * });
 * ```
 */
export function registerMacroAgent(options: RegisterOptions = {}): void {
  const {
    command = "npx",
    args = ["multiagent-acp"],
    env,
  } = options;

  AgentFactory.register("macro-agent", {
    command,
    args,
    env,
  });
}

// ─────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────

// Types
export type {
  ACPSessionId,
  SessionMapping,
  // Initialization config
  MacroAgentInitConfig,
  SubAgentConfig,
  MCPServerConfig as ACPMCPServerConfig,
  ACPPermissionMode,
  // Extension request/response types
  SpawnAgentRequest,
  SpawnAgentResponse,
  GetHierarchyRequest,
  GetHierarchyResponse,
  GetTaskRequest,
  GetTaskResponse,
  MountAgentRequest,
  MountAgentResponse,
  ForkAgentRequest,
  ForkAgentResponse,
  // Union types
  ACPExtensionMethod,
  ACPExtensionRequests,
  ACPExtensionResponses,
  // Error types
  ACPErrorCode,
} from "./types.js";

export { ACPError } from "./types.js";

// Session mapping
export { SessionMapper } from "./session-mapper.js";

// MacroAgent - ACP-compliant agent implementation
export { MacroAgent, type MacroAgentConfig } from "./macro-agent.js";
