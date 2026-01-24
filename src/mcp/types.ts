/**
 * MCP Server type definitions for multi-agent tools
 */

import type { AgentId, TaskId } from "../store/types/index.js";

// ─────────────────────────────────────────────────────────────────
// Tool Context
// ─────────────────────────────────────────────────────────────────

/**
 * Context injected into every tool handler.
 * Identifies the calling agent and their session.
 */
export interface ToolContext {
  /** ID of the agent making the tool call */
  agent_id: AgentId;

  /** Session ID from acp-factory */
  session_id: string;

  /** Task ID the agent is working on */
  task_id?: TaskId;

  /** Agent's lineage (ancestors) for authorization checks */
  lineage: AgentId[];

  /** Working directory for the agent */
  cwd: string;
}

// ─────────────────────────────────────────────────────────────────
// Tool Input Types
// ─────────────────────────────────────────────────────────────────

/**
 * spawn_agent tool input
 */
export interface SpawnAgentInput {
  /** Task description for the child agent */
  task: string;

  /** Whether parent subscribes to child's subtree (default: true) */
  subscribe_parent?: boolean;

  /** Additional topics for child to subscribe to */
  topics?: string[];

  /** Custom config for the child agent */
  config?: {
    model?: string;
    maxTokens?: number;
    temperature?: number;
  };

  /** Working directory for the spawned agent (defaults to parent's cwd) */
  cwd?: string;
}

/**
 * emit_status tool input
 */
export interface EmitStatusInput {
  /** Type of status update */
  status_type: "started" | "checkpoint" | "completed" | "failed" | "blocked";

  /** Human-readable summary */
  summary: string;

  /** Additional structured details */
  details?: Record<string, unknown>;

  /** If true and status_type is 'completed', also mark task as completed */
  complete_task?: boolean;
}

/**
 * send_message tool input
 */
export interface SendMessageInput {
  /** Message target */
  to: {
    agent_id?: AgentId;
    task_id?: TaskId;
    topic?: string;
  };

  /** Message content */
  content: string;

  /** Optional correlation ID for threading */
  correlation_id?: string;

  /** Message priority */
  priority?: "normal" | "high" | "low";
}

/**
 * check_messages tool input
 */
export interface CheckMessagesInput {
  /** Maximum number of messages to return (default: 10) */
  limit?: number;

  /** Include acknowledged messages */
  include_acknowledged?: boolean;
}

/**
 * query_index tool input
 */
export interface QueryIndexInput {
  /** Type of entities to search */
  type: "agents" | "tasks" | "all";

  /** Filter criteria */
  filter?: {
    /** For agents: filter by state */
    state?: "running" | "stopped" | "spawning";

    /** For tasks: filter by status */
    status?: "pending" | "assigned" | "in_progress" | "completed" | "failed";

    /** For agents: filter by parent */
    parent?: AgentId | null;
  };

  /** Text search query */
  search?: string;

  /** Maximum results (default: 20) */
  limit?: number;

  /** Offset for pagination */
  offset?: number;
}

/**
 * get_hierarchy tool input
 */
export interface GetHierarchyInput {
  /** Root agent ID (defaults to caller's hierarchy root) */
  root?: AgentId;

  /** Maximum depth to traverse (default: unlimited) */
  depth?: number;
}

/**
 * get_agent_summary tool input
 */
export interface GetAgentSummaryInput {
  /** Agent ID to look up */
  agent_id: AgentId;
}

/**
 * stop_agent tool input
 */
export interface StopAgentInput {
  /** Agent ID to stop (must be in caller's subtree) */
  agent_id: AgentId;

  /** Reason for stopping */
  reason?: "completed" | "failed" | "cancelled";
}

/**
 * create_task tool input
 */
export interface CreateTaskInput {
  /** Task description */
  description: string;

  /** Parent task ID for subtasks */
  parent_task?: TaskId;

  /** Initial inputs for the task */
  inputs?: Record<string, unknown>;
}

/**
 * get_task tool input
 */
export interface GetTaskInput {
  /** Task ID to look up */
  task_id: TaskId;
}

// ─────────────────────────────────────────────────────────────────
// Tool Output Types
// ─────────────────────────────────────────────────────────────────

/**
 * spawn_agent tool output
 */
export interface SpawnAgentOutput {
  agent_id: AgentId;
  task_id: TaskId;
  session_id: string;
}

/**
 * emit_status tool output
 */
export interface EmitStatusOutput {
  event_id: string;
  task_updated?: boolean;
}

/**
 * send_message tool output
 */
export interface SendMessageOutput {
  message_id: string;
  delivered_to: number;
}

/**
 * check_messages tool output
 */
export interface CheckMessagesOutput {
  messages: Array<{
    id: string;
    from: AgentId;
    content: string;
    timestamp: number;
    truncated: boolean;
    correlation_id?: string;
    priority?: string;
  }>;
  total_pending: number;
}

/**
 * query_index tool output
 */
export interface QueryIndexOutput {
  entries: Array<{
    type: "agent" | "task";
    id: string;
    summary: string;
    state?: string;
    status?: string;
  }>;
  total: number;
  has_more: boolean;
}

/**
 * get_hierarchy tool output
 */
export interface GetHierarchyOutput {
  tree: HierarchyNode;
  depth: number;
  total_agents: number;
}

export interface HierarchyNode {
  agent_id: AgentId;
  task: string;
  state: string;
  children: HierarchyNode[];
}

/**
 * get_agent_summary tool output
 */
export interface GetAgentSummaryOutput {
  id: AgentId;
  session_id: string;
  task: string;
  state: string;
  parent: AgentId | null;
  children_count: number;
  last_activity: number;
  recent_status?: {
    type: string;
    summary: string;
    timestamp: number;
  };
}

/**
 * stop_agent tool output
 */
export interface StopAgentOutput {
  success: boolean;
  stopped_agents: AgentId[];
}

/**
 * create_task tool output
 */
export interface CreateTaskOutput {
  task_id: TaskId;
}

/**
 * get_task tool output
 */
export interface GetTaskOutput {
  id: TaskId;
  description: string;
  status: string;
  assigned_agent?: AgentId;
  parent_task?: TaskId;
  subtasks: TaskId[];
  inputs?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  artifacts?: Array<{ name: string; path: string }>;
  created_at: number;
  updated_at: number;
}

// ─────────────────────────────────────────────────────────────────
// Error Types
// ─────────────────────────────────────────────────────────────────

/**
 * MCP tool error
 */
export class MCPToolError extends Error {
  constructor(
    message: string,
    public readonly code: MCPToolErrorCode,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "MCPToolError";
  }
}

export type MCPToolErrorCode =
  | "AGENT_NOT_FOUND"
  | "TASK_NOT_FOUND"
  | "PERMISSION_DENIED"
  | "INVALID_INPUT"
  | "SPAWN_FAILED"
  | "ROUTING_FAILED"
  | "NOT_IN_SUBTREE"
  | "NO_PEER_TRANSPORT"
  | "PEER_REQUEST_NOT_FOUND"
  | "WAIT_FAILED";

// ─────────────────────────────────────────────────────────────────
// Peer Communication Tool Types
// ─────────────────────────────────────────────────────────────────

/**
 * send_peer_message tool input
 */
export interface SendPeerMessageInput {
  /** Target peer address ("peerId" or "peerId/agentId") */
  to: string;

  /** Message type for routing */
  type: string;

  /** Message payload */
  payload: unknown;

  /** Optional correlation ID for relating messages */
  correlation_id?: string;
}

/**
 * send_peer_message tool output
 */
export interface SendPeerMessageOutput {
  success: boolean;
  timestamp: number;
}

/**
 * send_peer_request tool input
 */
export interface SendPeerRequestInput {
  /** Target peer address ("peerId" or "peerId/agentId") */
  to: string;

  /** Request method name */
  method: string;

  /** Request parameters */
  params?: unknown;

  /** Timeout hint in milliseconds */
  timeout?: number;
}

/**
 * send_peer_request tool output
 */
export interface SendPeerRequestOutput {
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

/**
 * respond_to_peer_request tool input
 */
export interface RespondToPeerRequestInput {
  /** Request ID to respond to */
  request_id: string;

  /** Success result (mutually exclusive with error) */
  result?: unknown;

  /** Error response (mutually exclusive with result) */
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

/**
 * respond_to_peer_request tool output
 */
export interface RespondToPeerRequestOutput {
  success: boolean;
}
