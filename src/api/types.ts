/**
 * API type definitions
 */

import type { AgentId, TaskId, EventId, Timestamp } from "../store/types/index.js";

// ─────────────────────────────────────────────────────────────────
// System State
// ─────────────────────────────────────────────────────────────────

export interface SystemStatus {
  initialized: boolean;
  head_manager_id?: AgentId;
  agents: {
    total: number;
    running: number;
    stopped: number;
  };
  tasks: {
    total: number;
    pending: number;
    in_progress: number;
    completed: number;
    failed: number;
  };
  uptime: number;
  started_at?: Timestamp;
}

// ─────────────────────────────────────────────────────────────────
// Init Request/Response
// ─────────────────────────────────────────────────────────────────

export interface InitRequest {
  /** Working directory for agents */
  cwd?: string;

  /** Custom system prompt for head manager */
  system_prompt?: string;

  /** Permission mode for agents */
  permission_mode?: "auto-approve" | "auto-deny" | "callback" | "interactive";
}

export interface InitResponse {
  success: boolean;
  head_manager_id: AgentId;
  session_id: string;
}

// ─────────────────────────────────────────────────────────────────
// Conversation
// ─────────────────────────────────────────────────────────────────

export interface ConversationMessageRequest {
  /** Message content */
  message: string;

  /** Stream response (default: true) */
  stream?: boolean;
}

export interface ConversationMessageResponse {
  /** Response content */
  content: string;

  /** Agent that responded */
  agent_id: AgentId;

  /** Message ID */
  message_id: string;
}

export interface ConversationHistoryEntry {
  role: "user" | "assistant";
  content: string;
  agent_id?: AgentId;
  timestamp: Timestamp;
}

export interface ConversationHistoryResponse {
  history: ConversationHistoryEntry[];
  total: number;
}

// ─────────────────────────────────────────────────────────────────
// Agent Responses
// ─────────────────────────────────────────────────────────────────

export interface AgentSummary {
  id: AgentId;
  session_id: string;
  task: string;
  state: string;
  parent: AgentId | null;
  children_count: number;
  created_at: Timestamp;
}

export interface AgentDetail extends AgentSummary {
  lineage: AgentId[];
  task_id?: TaskId;
  config: Record<string, unknown>;
  started_at?: Timestamp;
  stopped_at?: Timestamp;
  stop_reason?: string;
}

export interface AgentListResponse {
  agents: AgentSummary[];
  total: number;
}

export interface HierarchyNode {
  agent_id: AgentId;
  task: string;
  state: string;
  children: HierarchyNode[];
}

export interface HierarchyResponse {
  tree: HierarchyNode;
  depth: number;
  total_agents: number;
}

// ─────────────────────────────────────────────────────────────────
// Task Responses
// ─────────────────────────────────────────────────────────────────

export interface TaskSummary {
  id: TaskId;
  description: string;
  status: string;
  assigned_agent?: AgentId;
  created_at: Timestamp;
}

export interface TaskDetail extends TaskSummary {
  parent_task?: TaskId;
  subtasks: TaskId[];
  created_by: AgentId;
  inputs?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  artifacts?: Array<{ type: string; ref: string; description?: string }>;
  started_at?: Timestamp;
  completed_at?: Timestamp;
}

export interface TaskListResponse {
  tasks: TaskSummary[];
  total: number;
}

// ─────────────────────────────────────────────────────────────────
// Event Responses
// ─────────────────────────────────────────────────────────────────

export interface EventSummary {
  id: EventId;
  type: string;
  timestamp: Timestamp;
  source_agent_id?: AgentId;
  target_agent_id?: AgentId;
  summary: string;
}

export interface EventListResponse {
  events: EventSummary[];
  total: number;
  has_more: boolean;
}

// ─────────────────────────────────────────────────────────────────
// WebSocket Messages
// ─────────────────────────────────────────────────────────────────

export type WSMessageType =
  | "subscribe"
  | "unsubscribe"
  | "agent_update"
  | "task_update"
  | "message"
  | "status"
  | "error"
  | "conversation_update"
  | "turn_added";

export interface WSMessage {
  type: WSMessageType;
  channel?: string;
  data?: unknown;
  error?: string;
}

export interface WSSubscribeMessage {
  type: "subscribe";
  channel: "agents" | "tasks" | "conversation" | "events";
  filter?: {
    agent_id?: AgentId;
    task_id?: TaskId;
  };
}

export interface WSAgentUpdate {
  type: "agent_update";
  action: "spawned" | "started" | "stopped" | "status";
  agent: AgentSummary;
}

export interface WSTaskUpdate {
  type: "task_update";
  action: "created" | "assigned" | "status_change" | "completed" | "failed";
  task: TaskSummary;
}

export interface WSConversationMessage {
  type: "message";
  role: "user" | "assistant";
  content: string;
  agent_id?: AgentId;
  timestamp: Timestamp;
}

// ─────────────────────────────────────────────────────────────────
// Query Parameters
// ─────────────────────────────────────────────────────────────────

export interface AgentQueryParams {
  state?: "running" | "stopped" | "spawning";
  parent?: AgentId | "null";
  limit?: number;
  offset?: number;
}

export interface TaskQueryParams {
  status?: "pending" | "assigned" | "in_progress" | "completed" | "failed";
  assigned_agent?: AgentId;
  limit?: number;
  offset?: number;
}

export interface EventQueryParams {
  type?: string;
  source_agent_id?: AgentId;
  target_agent_id?: AgentId;
  after?: Timestamp;
  before?: Timestamp;
  limit?: number;
  offset?: number;
}

// ─────────────────────────────────────────────────────────────────
// Context Injection
// ─────────────────────────────────────────────────────────────────

export interface InjectContextRequest {
  /** The context message to inject */
  content: string;

  /** If true, interrupts current work immediately instead of queueing */
  urgent?: boolean;

  /** Optional reason for the injection (for audit logs) */
  reason?: string;
}

export interface InjectContextResponse {
  /** Whether the injection succeeded */
  success: boolean;

  /** The method used: inject, interrupt, message, or queued */
  method?: "inject" | "interrupt" | "message" | "queued";

  /** Error message if failed */
  error?: string;

  /** Additional notes */
  note?: string;
}

// ─────────────────────────────────────────────────────────────────
// Mail Conversations
// ─────────────────────────────────────────────────────────────────

export interface MailConversationSummary {
  id: string;
  type: string;
  status: string;
  subject: string;
  created_by: string;
  created_at: Timestamp;
  updated_at: Timestamp;
  participant_count: number;
  parent_conversation_id?: string;
}

export interface MailConversationDetail extends MailConversationSummary {
  closed_at?: Timestamp;
  closed_by?: string;
  close_reason?: string;
}

export interface MailConversationListResponse {
  conversations: MailConversationSummary[];
  total: number;
}

export interface MailTurnSummary {
  id: string;
  conversation_id: string;
  participant: string;
  content_type: string;
  content: unknown;
  timestamp: Timestamp;
  source_type?: string;
  source_message_id?: string;
}

export interface MailTurnListResponse {
  turns: MailTurnSummary[];
  total: number;
}

export interface MailConversationQueryParams {
  type?: string;
  status?: string;
  limit?: number;
  offset?: number;
}

export interface WSTurnAdded {
  type: "turn_added";
  conversation_id: string;
  turn: MailTurnSummary;
}

export interface WSConversationUpdate {
  type: "conversation_update";
  conversation: MailConversationSummary;
}

// ─────────────────────────────────────────────────────────────────
// Error Response
// ─────────────────────────────────────────────────────────────────

export interface APIError {
  error: string;
  code: string;
  details?: Record<string, unknown>;
}
