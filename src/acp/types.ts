/**
 * ACP module type definitions
 *
 * Types for ACP extensions and session mapping
 */

import type {
  AgentId,
  SessionId,
  TaskId,
  Agent,
  Task,
} from "../store/types/index.js";
import type { AgentHierarchyNode } from "../agent/types.js";

// ─────────────────────────────────────────────────────────────────
// ACP Session Types
// ─────────────────────────────────────────────────────────────────

/**
 * ACP session ID (from the ACP protocol)
 */
export type ACPSessionId = string;

/**
 * Mapping entry for ACP session to macro-agent
 */
export interface SessionMapping {
  /** ACP session ID */
  acpSessionId: ACPSessionId;

  /** Currently mapped macro-agent agent ID */
  agentId: AgentId;

  /** Original head manager agent ID (for unmounting) */
  headManagerId: AgentId;

  /** Whether this session is mounted to a non-head-manager agent */
  isMounted: boolean;

  /** When the mapping was created */
  createdAt: number;

  /** When the mapping was last updated */
  updatedAt: number;
}

// ─────────────────────────────────────────────────────────────────
// ACP Initialization Config
// ─────────────────────────────────────────────────────────────────

/**
 * MCP server configuration for agents
 */
export interface MCPServerConfig {
  /** Server name (identifier) */
  name: string;

  /** Command to run */
  command: string;

  /** Command arguments */
  args?: string[];

  /** Environment variables for the server */
  env?: Record<string, string>;
}

/**
 * Permission mode for agent tool calls
 * Matches acp-factory's PermissionMode type
 */
export type ACPPermissionMode =
  | "auto-approve"
  | "auto-deny"
  | "callback"
  | "interactive";

/**
 * Configuration for spawned sub-agents
 *
 * Used both as defaults during initialization and as overrides
 * when spawning individual agents via _macro/spawnAgent.
 */
export interface SubAgentConfig {
  /** Model to use (e.g., "claude-sonnet-4-20250514", "claude-opus-4-20250514") */
  model?: string;

  /** Maximum tokens per response */
  maxTokens?: number;

  /** Temperature for responses (0.0 - 1.0) */
  temperature?: number;

  /** Additional environment variables passed to agents */
  env?: Record<string, string>;

  /** MCP servers to connect to agents */
  mcpServers?: MCPServerConfig[];

  /** Permission mode for tool calls */
  permissionMode?: ACPPermissionMode;

  /** Agent type (defaults to "claude-code") */
  agentType?: string;
}

/**
 * Configuration passed during ACP initialization
 *
 * This allows each macro-agent instance to have different settings.
 * Passed via the `_meta.macroConfig` field in InitializeRequest.
 *
 * @example
 * ```typescript
 * // Client-side initialization
 * const handle = await AgentFactory.spawn("macro-agent", {
 *   permissionMode: "auto-approve",
 * });
 *
 * // The macro-agent reads config from initialize request:
 * // request._meta?.macroConfig: MacroAgentInitConfig
 * ```
 */
export interface MacroAgentInitConfig {
  /** Default working directory for agents */
  defaultCwd?: string;

  /** Default configuration for all spawned sub-agents */
  defaultSubAgentConfig?: SubAgentConfig;

  /** System prompt prefix added to all agents */
  systemPromptPrefix?: string;

  /** System prompt suffix added to all agents */
  systemPromptSuffix?: string;

  /** Whether to auto-create head manager on first session */
  autoCreateHeadManager?: boolean;
}

// ─────────────────────────────────────────────────────────────────
// ACP Extension: _macro/spawnAgent
// ─────────────────────────────────────────────────────────────────

/**
 * Request for _macro/spawnAgent extension
 */
export interface SpawnAgentRequest {
  /** Optional name for the agent */
  name?: string;

  /** Task description for the agent */
  task_description: string;

  /** Parent agent ID (defaults to current session's mapped agent) */
  parentId?: AgentId;

  /** Spawn options */
  options?: {
    /** Working directory */
    cwd?: string;

    /** Whether parent should subscribe to status updates */
    subscribeParent?: boolean;

    /** Additional topics to subscribe to */
    topics?: string[];
  };

  /**
   * Agent configuration override
   *
   * Merges with defaultSubAgentConfig from initialization.
   * Values here take precedence over defaults.
   */
  config?: SubAgentConfig;
}

/**
 * Response for _macro/spawnAgent extension
 */
export interface SpawnAgentResponse {
  /** Created agent ID */
  agentId: AgentId;

  /** Created task ID */
  taskId: TaskId;

  /** Session ID for the new agent */
  sessionId: SessionId;
}

// ─────────────────────────────────────────────────────────────────
// ACP Extension: _macro/getHierarchy
// ─────────────────────────────────────────────────────────────────

/**
 * Request for _macro/getHierarchy extension
 */
export interface GetHierarchyRequest {
  /** Root agent ID to start from (defaults to head manager) */
  rootAgentId?: AgentId;
}

/**
 * Response for _macro/getHierarchy extension
 */
export interface GetHierarchyResponse {
  /** Hierarchy tree starting from root */
  hierarchy: AgentHierarchyNode;

  /** Total number of agents in the hierarchy */
  totalAgents: number;

  /** Maximum depth of the hierarchy */
  depth: number;
}

// ─────────────────────────────────────────────────────────────────
// ACP Extension: _macro/getTask
// ─────────────────────────────────────────────────────────────────

/**
 * Request for _macro/getTask extension
 */
export interface GetTaskRequest {
  /** Task ID to retrieve */
  taskId: TaskId;
}

/**
 * Response for _macro/getTask extension
 */
export interface GetTaskResponse {
  /** Full task details */
  task: Task;
}

// ─────────────────────────────────────────────────────────────────
// ACP Extension: _macro/mountAgent
// ─────────────────────────────────────────────────────────────────

/**
 * Request for _macro/mountAgent extension
 */
export interface MountAgentRequest {
  /** ACP session ID to remap */
  sessionId: ACPSessionId;

  /** Agent ID to mount/attach to */
  agentId: AgentId;
}

/**
 * Response for _macro/mountAgent extension
 */
export interface MountAgentResponse {
  /** Session ID (unchanged, but confirms mount) */
  sessionId: ACPSessionId;

  /** Current state of the mounted agent */
  agent: Agent;

  /** Previous agent ID (before mount) */
  previousAgentId: AgentId;
}

// ─────────────────────────────────────────────────────────────────
// ACP Extension: _macro/forkAgent
// ─────────────────────────────────────────────────────────────────

/**
 * Request for _macro/forkAgent extension
 */
export interface ForkAgentRequest {
  /** Agent ID to fork */
  agentId: AgentId;

  /** Optional name for the forked agent */
  name?: string;
}

/**
 * Response for _macro/forkAgent extension
 */
export interface ForkAgentResponse {
  /** New agent ID (the fork) */
  newAgentId: AgentId;

  /** New session ID for the forked agent */
  newSessionId: SessionId;

  /** Original agent ID (for reference) */
  originalAgentId: AgentId;
}

// ─────────────────────────────────────────────────────────────────
// Extension Method Types (Union)
// ─────────────────────────────────────────────────────────────────

/**
 * All ACP extension method names
 */
export type ACPExtensionMethod =
  | "_macro/spawnAgent"
  | "_macro/getHierarchy"
  | "_macro/getTask"
  | "_macro/mountAgent"
  | "_macro/forkAgent";

/**
 * Map of extension methods to their request types
 */
export interface ACPExtensionRequests {
  "_macro/spawnAgent": SpawnAgentRequest;
  "_macro/getHierarchy": GetHierarchyRequest;
  "_macro/getTask": GetTaskRequest;
  "_macro/mountAgent": MountAgentRequest;
  "_macro/forkAgent": ForkAgentRequest;
}

/**
 * Map of extension methods to their response types
 */
export interface ACPExtensionResponses {
  "_macro/spawnAgent": SpawnAgentResponse;
  "_macro/getHierarchy": GetHierarchyResponse;
  "_macro/getTask": GetTaskResponse;
  "_macro/mountAgent": MountAgentResponse;
  "_macro/forkAgent": ForkAgentResponse;
}

// ─────────────────────────────────────────────────────────────────
// Error Types
// ─────────────────────────────────────────────────────────────────

/**
 * ACP module error
 */
export class ACPError extends Error {
  constructor(
    message: string,
    public readonly code: ACPErrorCode,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "ACPError";
  }
}

export type ACPErrorCode =
  | "SESSION_NOT_FOUND"
  | "AGENT_NOT_FOUND"
  | "TASK_NOT_FOUND"
  | "MOUNT_FAILED"
  | "FORK_FAILED"
  | "FORK_NOT_SUPPORTED"
  | "INVALID_EXTENSION"
  | "PERMISSION_DENIED";
