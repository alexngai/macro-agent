/**
 * AgentManager type definitions
 */

import type { Session, AgentHandle, PermissionMode } from "acp-factory";
import type {
  AgentId,
  TaskId,
  Timestamp,
  Agent,
  AgentState,
} from "../store/types/index.js";

// ─────────────────────────────────────────────────────────────────
// Spawn Options
// ─────────────────────────────────────────────────────────────────

/**
 * Options for spawning a new agent
 */
export interface SpawnAgentOptions {
  /** Task description for the agent */
  task: string;

  /** Optional task ID (auto-generated if not provided) */
  task_id?: TaskId;

  /** Parent agent ID (null for head managers) */
  parent?: AgentId | null;

  /** Working directory for the agent */
  cwd?: string;

  /** Permission mode for tool calls */
  permissionMode?: PermissionMode;

  /** Whether parent should subscribe to this agent's subtree */
  subscribeParent?: boolean;

  /** Additional topics for the agent to subscribe to */
  topics?: string[];

  /** Custom configuration passed to agent */
  config?: AgentConfig;

  /** Optional agent type (defaults to "claude-code") */
  agentType?: string;
}

/**
 * Custom agent configuration
 */
export interface AgentConfig {
  /** Model to use (if configurable) */
  model?: string;

  /** Maximum tokens per response */
  maxTokens?: number;

  /** Temperature for responses */
  temperature?: number;

  /** Additional environment variables */
  env?: Record<string, string>;

  /** MCP servers to connect */
  mcpServers?: MCPServerConfig[];
}

/**
 * MCP server configuration
 */
export interface MCPServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

// ─────────────────────────────────────────────────────────────────
// Spawned Agent Result
// ─────────────────────────────────────────────────────────────────

/**
 * Result of spawning an agent
 */
export interface SpawnedAgent {
  /** Agent ID */
  id: AgentId;

  /** Session ID from acp-factory */
  session_id: string;

  /** Agent state from materialized view */
  agent: Agent;

  /** Active session for interaction */
  session: Session;
}

// ─────────────────────────────────────────────────────────────────
// Query Types
// ─────────────────────────────────────────────────────────────────

/**
 * Filter options for listing agents
 */
export interface AgentFilter {
  /** Filter by state */
  state?: AgentState;

  /** Filter by parent */
  parent?: AgentId | null;

  /** Filter by task ID */
  task_id?: TaskId;

  /** Only head managers (no parent) */
  headManagersOnly?: boolean;
}

/**
 * Agent hierarchy node
 */
export interface AgentHierarchyNode {
  agent: Agent;
  children: AgentHierarchyNode[];
}

/**
 * Full agent hierarchy from root
 */
export interface AgentHierarchy {
  root: AgentHierarchyNode;
  depth: number;
  totalAgents: number;
}

/**
 * Options for getHierarchy
 */
export interface HierarchyOptions {
  /** Maximum depth to traverse (undefined = full tree) */
  depth?: number;
}

// ─────────────────────────────────────────────────────────────────
// Session Management
// ─────────────────────────────────────────────────────────────────

/**
 * Active session info tracked in memory
 */
export interface ActiveSession {
  /** Agent ID */
  agentId: AgentId;

  /** acp-factory agent handle (process) */
  handle: AgentHandle;

  /** acp-factory session */
  session: Session;

  /** When the session was created */
  createdAt: Timestamp;

  /** Whether session is currently prompting */
  isPrompting: boolean;
}

/**
 * Stop reason for agent termination
 * Named AgentStopReason to avoid conflict with ACP SDK's StopReason
 */
export type AgentStopReason =
  | "completed" // Task finished successfully
  | "failed" // Task failed with error
  | "cancelled" // Manually cancelled
  | "timeout" // Exceeded time limit
  | "parent_stopped" // Parent agent was stopped
  | "system"; // System shutdown

// ─────────────────────────────────────────────────────────────────
// Head Manager
// ─────────────────────────────────────────────────────────────────

/**
 * Options for creating a head manager
 */
export interface HeadManagerOptions {
  /** Working directory */
  cwd: string;

  /** Optional custom system prompt */
  systemPrompt?: string;

  /** Permission mode */
  permissionMode?: PermissionMode;

  /** Initial topics to subscribe to */
  topics?: string[];

  /** Resume a specific session by ID */
  sessionId?: string;

  /** Force creation of a new session, ignoring existing ones */
  forceNew?: boolean;
}

// ─────────────────────────────────────────────────────────────────
// System Prompt
// ─────────────────────────────────────────────────────────────────

/**
 * Context for generating system prompts
 */
export interface SystemPromptContext {
  /** Agent ID */
  agentId: AgentId;

  /** Task description */
  task: string;

  /** Task ID if assigned */
  taskId?: TaskId;

  /** Parent agent ID */
  parentId?: AgentId | null;

  /** Whether this is a head manager */
  isHeadManager: boolean;

  /** Agent lineage (ancestors) */
  lineage: AgentId[];

  /** Available MCP tools */
  mcpTools?: string[];
}

/**
 * System prompt template parts
 */
export interface SystemPromptTemplate {
  /** Role description */
  role: string;

  /** Task context */
  taskContext: string;

  /** Available tools */
  toolsSection: string;

  /** Communication instructions */
  communicationSection: string;

  /** Hierarchy context */
  hierarchySection: string;
}

// ─────────────────────────────────────────────────────────────────
// Events
// ─────────────────────────────────────────────────────────────────

/**
 * Agent lifecycle events (for callbacks)
 */
export type AgentLifecycleEvent =
  | { type: "spawned"; agent: Agent }
  | { type: "started"; agent: Agent }
  | { type: "stopped"; agent: Agent; reason: AgentStopReason }
  | { type: "status"; agent: Agent; status: string };

/**
 * Callback for agent lifecycle events
 */
export type AgentLifecycleCallback = (event: AgentLifecycleEvent) => void;

// ─────────────────────────────────────────────────────────────────
// Error Types
// ─────────────────────────────────────────────────────────────────

/**
 * Agent manager error
 */
export class AgentManagerError extends Error {
  constructor(
    message: string,
    public readonly code: AgentManagerErrorCode,
    public readonly agentId?: AgentId
  ) {
    super(message);
    this.name = "AgentManagerError";
  }
}

export type AgentManagerErrorCode =
  | "AGENT_NOT_FOUND"
  | "SESSION_NOT_FOUND"
  | "SPAWN_FAILED"
  | "ALREADY_RUNNING"
  | "NOT_RUNNING"
  | "INVALID_STATE"
  | "PERMISSION_DENIED";
