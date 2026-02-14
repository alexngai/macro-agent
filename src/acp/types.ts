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

  /** Whether the session is currently processing a prompt (for health monitoring) */
  isProcessing: boolean;

  /** When isProcessing last changed (for health monitoring) */
  lastProcessingChangeAt: number;
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

  /**
   * Role for the spawned agent (e.g., 'worker', 'coordinator', 'integrator', 'monitor').
   * Parent must have the appropriate spawn capability for the requested role.
   */
  role?: string;

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

  /** Optional initial prompt to send after fork */
  prompt?: string;

  /** Optional working directory override */
  cwd?: string;
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

  /** Provider session ID (Claude Code UUID) for stream connection */
  providerSessionId?: string;
}

// ─────────────────────────────────────────────────────────────────
// ACP Extension: _macro/sendPeerMessage
// ─────────────────────────────────────────────────────────────────

/**
 * Request for _macro/sendPeerMessage extension
 */
export interface SendPeerMessageACPRequest {
  /** Target peer address ("peerId" or "peerId/agentId") */
  to: string;

  /** Message type for routing */
  type: string;

  /** Message payload */
  payload: unknown;

  /** Optional correlation ID */
  correlationId?: string;
}

/**
 * Response for _macro/sendPeerMessage extension
 */
export interface SendPeerMessageACPResponse {
  success: boolean;
  timestamp: number;
}

// ─────────────────────────────────────────────────────────────────
// ACP Extension: _macro/sendPeerRequest
// ─────────────────────────────────────────────────────────────────

/**
 * Request for _macro/sendPeerRequest extension
 */
export interface SendPeerRequestACPRequest {
  /** Target peer address ("peerId" or "peerId/agentId") */
  to: string;

  /** Request method name */
  method: string;

  /** Request parameters */
  params?: unknown;

  /** Timeout in milliseconds */
  timeout?: number;
}

/**
 * Response for _macro/sendPeerRequest extension
 */
export interface SendPeerRequestACPResponse {
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

// ─────────────────────────────────────────────────────────────────
// ACP Extension: _macro/deliverPeerMessage
// ─────────────────────────────────────────────────────────────────

/**
 * Request for _macro/deliverPeerMessage extension
 * Client calls this to route an inbound message to this macro-agent
 */
export interface DeliverPeerMessageRequest {
  /** Source peer address */
  from: string;

  /** Message type */
  type: string;

  /** Message payload */
  payload: unknown;

  /** Optional correlation ID */
  correlationId?: string;

  /** Target agent ID within this macro-agent (optional, defaults to root) */
  targetAgentId?: AgentId;
}

/**
 * Response for _macro/deliverPeerMessage extension
 */
export interface DeliverPeerMessageResponse {
  success: boolean;
  messageId: string;
}

// ─────────────────────────────────────────────────────────────────
// ACP Extension: _macro/deliverPeerRequest
// ─────────────────────────────────────────────────────────────────

/**
 * Request for _macro/deliverPeerRequest extension
 * Client calls this to route an inbound request to this macro-agent
 */
export interface DeliverPeerRequestRequest {
  /** Source peer address */
  from: string;

  /** Request method name */
  method: string;

  /** Request parameters */
  params?: unknown;

  /** Timeout for the request in milliseconds */
  timeout?: number;

  /** Target agent ID within this macro-agent (optional, defaults to root) */
  targetAgentId?: AgentId;
}

/**
 * Response for _macro/deliverPeerRequest extension
 */
export interface DeliverPeerRequestResponse {
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

// ─────────────────────────────────────────────────────────────────
// ACP Extension: _macro/grantCapability
// ─────────────────────────────────────────────────────────────────

import type {
  CapabilityGrant,
  CapabilityType,
  PeerCapabilities,
} from "../peer/types.js";

/**
 * Request for _macro/grantCapability extension
 */
export interface GrantCapabilityRequest {
  /** Peer ID to grant capabilities to */
  peerId: string;

  /** Capabilities to grant */
  grants: CapabilityGrant[];

  /** Time until expiration in milliseconds (optional) */
  expiresIn?: number;

  /** Issuer identifier for audit trail (optional) */
  issuedBy?: string;
}

/**
 * Response for _macro/grantCapability extension
 */
export interface GrantCapabilityResponse {
  /** Full capability set for the peer after grant */
  capabilities: PeerCapabilities;
}

// ─────────────────────────────────────────────────────────────────
// ACP Extension: _macro/revokeCapability
// ─────────────────────────────────────────────────────────────────

/**
 * Request for _macro/revokeCapability extension
 */
export interface RevokeCapabilityRequest {
  /** Peer ID to revoke capabilities from */
  peerId: string;

  /** Specific capability types to revoke (optional, revokes all if not specified) */
  grantTypes?: CapabilityType[];
}

/**
 * Response for _macro/revokeCapability extension
 */
export interface RevokeCapabilityResponse {
  /** Whether revocation was successful */
  success: boolean;

  /** Remaining capabilities for the peer (null if all revoked) */
  remainingCapabilities: PeerCapabilities | null;
}

// ─────────────────────────────────────────────────────────────────
// ACP Extension: _macro/getCapabilities
// ─────────────────────────────────────────────────────────────────

/**
 * Request for _macro/getCapabilities extension
 */
export interface GetCapabilitiesRequest {
  /** Peer ID to get capabilities for (optional, lists all if not specified) */
  peerId?: string;
}

/**
 * Response for _macro/getCapabilities extension
 */
export interface GetCapabilitiesResponse {
  /** Capabilities for the requested peer (if peerId specified) */
  capabilities?: PeerCapabilities | null;

  /** All authorized peers (if peerId not specified) */
  authorizedPeers?: PeerCapabilities[];
}

// ─────────────────────────────────────────────────────────────────
// ACP Extension: _macro/checkCapability
// ─────────────────────────────────────────────────────────────────

/**
 * Request for _macro/checkCapability extension
 */
export interface CheckCapabilityRequest {
  /** Peer ID to check */
  peerId: string;

  /** Required capability to check */
  required: CapabilityGrant;
}

/**
 * Response for _macro/checkCapability extension
 */
export interface CheckCapabilityResponse {
  /** Whether the peer has the required capability */
  hasCapability: boolean;
}

// ─────────────────────────────────────────────────────────────────
// ACP Extension: _macro/respondToPermission
// ─────────────────────────────────────────────────────────────────

/**
 * Request for _macro/respondToPermission extension
 *
 * Used to respond to permission requests when running in interactive mode.
 */
export interface RespondToPermissionRequest {
  /** ACP session ID that has the pending permission */
  sessionId: ACPSessionId;

  /** The permission request ID from the permission_request update */
  requestId: string;

  /** The selected option ID (e.g., 'allow_once', 'allow_always', 'reject_once') */
  optionId: string;
}

/**
 * Response for _macro/respondToPermission extension
 */
export interface RespondToPermissionResponse {
  /** Whether the permission was found and responded to */
  success: boolean;

  /** Error message if success is false */
  error?: string;
}

// ─────────────────────────────────────────────────────────────────
// ACP Extension: _macro/cancelPermission
// ─────────────────────────────────────────────────────────────────

/**
 * Request for _macro/cancelPermission extension
 *
 * Used to cancel a permission request, which typically aborts the tool call.
 */
export interface CancelPermissionRequest {
  /** ACP session ID that has the pending permission */
  sessionId: ACPSessionId;

  /** The permission request ID from the permission_request update */
  requestId: string;
}

/**
 * Response for _macro/cancelPermission extension
 */
export interface CancelPermissionResponse {
  /** Whether the permission was found and cancelled */
  success: boolean;

  /** Error message if success is false */
  error?: string;
}

// ─────────────────────────────────────────────────────────────────
// ACP Extension: _macro/setPermissionMode
// ─────────────────────────────────────────────────────────────────

/**
 * Request for _macro/setPermissionMode extension
 *
 * Changes the permission mode for a running agent at runtime.
 * Takes effect on the next permission request; in-flight requests use the old mode.
 */
export interface SetPermissionModeRequest {
  /** Agent ID to change (looked up directly, bypassing session mapper) */
  agentId: string;

  /** New permission mode */
  permissionMode: ACPPermissionMode;
}

/**
 * Response for _macro/setPermissionMode extension
 */
export interface SetPermissionModeResponse {
  /** Whether the mode was changed successfully */
  success: boolean;

  /** The previous permission mode (if success) */
  previousMode?: ACPPermissionMode;

  /** Error message if success is false */
  error?: string;
}

// ─────────────────────────────────────────────────────────────────
// ACP Extension: _macro/resume
// ─────────────────────────────────────────────────────────────────

/**
 * Request for _macro/resume extension
 *
 * Resumes a stopped/failed agent by spawning a new process and
 * loading the existing session. Called on the head manager's ACP stream.
 */
export interface ResumeAgentRequest {
  /** Agent ID to resume */
  agentId: AgentId;
}

/**
 * Response for _macro/resume extension
 */
export interface ResumeAgentResponse {
  /** Whether the resume was successful */
  success: boolean;

  /** The resumed agent's ID */
  agentId: AgentId;

  /** The agent's session ID (from resume) */
  sessionId: string;
}

// ─────────────────────────────────────────────────────────────────
// History Extension Types
// ─────────────────────────────────────────────────────────────────

/**
 * A historical turn in a session conversation
 */
export interface HistoryTurn {
  /** Turn role */
  role: "user" | "assistant";
  /** Timestamp of the turn */
  timestamp: number;
  /** Turn content — plain text for user, structured parts for assistant */
  content: unknown;
}

/**
 * Request for _macro/getHistory extension
 */
export interface GetHistoryRequest {
  /** ACP session ID to get history for */
  sessionId: string;
  /** Maximum number of turns to return */
  limit?: number;
}

/**
 * Response for _macro/getHistory extension
 */
export interface GetHistoryResponse {
  /** Conversation turns in chronological order */
  turns: HistoryTurn[];
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
  | "_macro/forkAgent"
  | "_macro/sendPeerMessage"
  | "_macro/sendPeerRequest"
  | "_macro/deliverPeerMessage"
  | "_macro/deliverPeerRequest"
  | "_macro/grantCapability"
  | "_macro/revokeCapability"
  | "_macro/getCapabilities"
  | "_macro/checkCapability"
  | "_macro/respondToPermission"
  | "_macro/cancelPermission"
  | "_macro/setPermissionMode"
  | "_macro/resume"
  | "_macro/getHistory"
  | "_macro/getModels";

/**
 * Map of extension methods to their request types
 */
export interface ACPExtensionRequests {
  "_macro/spawnAgent": SpawnAgentRequest;
  "_macro/getHierarchy": GetHierarchyRequest;
  "_macro/getTask": GetTaskRequest;
  "_macro/mountAgent": MountAgentRequest;
  "_macro/forkAgent": ForkAgentRequest;
  "_macro/sendPeerMessage": SendPeerMessageACPRequest;
  "_macro/sendPeerRequest": SendPeerRequestACPRequest;
  "_macro/deliverPeerMessage": DeliverPeerMessageRequest;
  "_macro/deliverPeerRequest": DeliverPeerRequestRequest;
  "_macro/grantCapability": GrantCapabilityRequest;
  "_macro/revokeCapability": RevokeCapabilityRequest;
  "_macro/getCapabilities": GetCapabilitiesRequest;
  "_macro/checkCapability": CheckCapabilityRequest;
  "_macro/respondToPermission": RespondToPermissionRequest;
  "_macro/cancelPermission": CancelPermissionRequest;
  "_macro/setPermissionMode": SetPermissionModeRequest;
  "_macro/resume": ResumeAgentRequest;
  "_macro/getHistory": GetHistoryRequest;
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
  "_macro/sendPeerMessage": SendPeerMessageACPResponse;
  "_macro/sendPeerRequest": SendPeerRequestACPResponse;
  "_macro/deliverPeerMessage": DeliverPeerMessageResponse;
  "_macro/deliverPeerRequest": DeliverPeerRequestResponse;
  "_macro/grantCapability": GrantCapabilityResponse;
  "_macro/revokeCapability": RevokeCapabilityResponse;
  "_macro/getCapabilities": GetCapabilitiesResponse;
  "_macro/checkCapability": CheckCapabilityResponse;
  "_macro/respondToPermission": RespondToPermissionResponse;
  "_macro/cancelPermission": CancelPermissionResponse;
  "_macro/setPermissionMode": SetPermissionModeResponse;
  "_macro/resume": ResumeAgentResponse;
  "_macro/getHistory": GetHistoryResponse;
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
  | "PERMISSION_DENIED"
  | "CAPABILITY_DENIED"
  | "NO_PEER_MANAGER"
  | "PEER_SEND_FAILED";
