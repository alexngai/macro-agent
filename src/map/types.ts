/**
 * MAP Sidecar Types
 *
 * Configuration, interfaces, and wire format types for the MAP hub sidecar.
 * The sidecar connects macro-agent to an OpenHive MAP hub for agent observability,
 * trajectory reporting, task bridging, and cross-swarm coordination.
 *
 * @module map/types
 */

import type { AgentManager } from "../agent/agent-manager.js";
import type { AgentStore } from "../agent/agent-store.js";
import type { InboxAdapter, TasksAdapter } from "../adapters/types.js";

// =============================================================================
// Configuration
// =============================================================================

export interface MAPSidecarConfig {
  /** MAP hub WebSocket URL (e.g., "ws://localhost:8080" or "wss://hub.openhive.dev") */
  server: string;

  /** Authentication token (appended as ?token= query param) */
  token?: string;

  /** MAP scope for broadcasting events (default: "swarm:macro-agent") */
  scope?: string;

  /** System ID for federation (default: "macro-agent") */
  systemId?: string;

  /** Opaque credential for server-driven auth (verified mode) */
  credential?: string;

  /** Agent name for MAP registration (default: "macro-agent-sidecar") */
  agentName?: string;

  /** Swarm ID for stable identity across reconnections */
  swarmId?: string;

  /** Trajectory sync level */
  trajectorySyncLevel?: "off" | "lifecycle" | "metrics" | "full";

  /** Mesh transport (agentic-mesh P2P) */
  mesh?: {
    enabled?: boolean;
    peerId?: string;
  };

  /** Reconnection settings (SDK-level) */
  reconnection?: {
    enabled?: boolean;
    maxRetries?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
  };

  /** Slow reconnect interval after SDK retries exhausted (ms, default: 60000) */
  reconnectIntervalMs?: number;
}

// =============================================================================
// Dependencies
// =============================================================================

export interface MAPSidecarDeps {
  agentManager: AgentManager;
  agentStore: AgentStore;
  inboxAdapter: InboxAdapter;
  tasksAdapter: TasksAdapter;
  /**
   * Optional lookup for the local MAP server's ULID for a given local agent ID.
   * When provided, the lifecycle bridge includes this ID in hub registration
   * metadata so clients (e.g., SwarmCraft) can target the agent correctly on
   * the macro-agent's own MAP server.
   */
  getLocalMapId?: (localAgentId: string) => string | undefined;
  /**
   * Optional GitCascadeAdapter. When provided, the sidecar wires a cascade
   * bridge that forwards the adapter's event stream to the hub as
   * `x-cascade/*` MAP notifications. Leave undefined to disable cascade
   * event forwarding (macro-agent will still use cascade internally, just
   * without hub observability).
   */
  gitCascadeAdapter?: import("../workspace/git-cascade-adapter.js").GitCascadeAdapter;

  /**
   * The swarm-dispatch dispatcher agent ID (e.g. "dispatcher:<claimantId>").
   * When provided, the mail bridge delivers hub-forwarded mail turns directly
   * to this inbox recipient so createAgentInboxPort.onIncoming fires
   * correctly. Without it, bridged turns land in BRIDGE_RECIPIENT_ID and the
   * MessagePort never sees them.
   */
  dispatcherAgentId?: string;
}

// =============================================================================
// Sidecar Interface
// =============================================================================

export interface MAPSidecar {
  /** Start the sidecar (connect to hub, subscribe to events) */
  start(): Promise<void>;

  /** Stop the sidecar (disconnect, unsubscribe) */
  stop(): Promise<void>;

  /** Whether the sidecar is connected to the hub */
  readonly connected: boolean;

  /** Report a trajectory checkpoint manually */
  reportCheckpoint(
    checkpoint: TrajectoryCheckpointPayload,
  ): Promise<TrajectoryCheckpointResult | null>;

  /** Emit a custom event to the MAP hub scope (best-effort, no-op if disconnected) */
  emitEvent?(event: Record<string, unknown>): Promise<void>;

  /**
   * Post a mail turn back to the hub via the `mail/turn` MAP notification.
   * Used by the dispatch reply bridge to forward worker output into the hub's
   * mail conversation after a mail-inbound task completes.
   * No-op if disconnected.
   */
  postMailTurn?(
    conversationId: string,
    participantId: string,
    content: string,
  ): Promise<void>;
}

// =============================================================================
// Trajectory Wire Format
// =============================================================================

/**
 * Trajectory checkpoint payload — matches cc-swarm wire format.
 * Top-level fields are snake_case per the OpenHive trajectory protocol.
 */
export interface TrajectoryCheckpointPayload {
  /** Checkpoint ID (e.g., "<sessionId>-step<N>") */
  id: string;
  /** Session identifier */
  session_id: string;
  /** Agent name (e.g., "macro-agent-sidecar") */
  agent: string;
  /** Git branch (nullable) */
  branch: string | null;
  /** Files touched in this checkpoint period */
  files_touched: string[];
  /** Total checkpoint count in session */
  checkpoints_count: number;
  /** Token usage metrics (when sync level >= "metrics") */
  token_usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_tokens?: number;
    cache_read_tokens?: number;
    api_call_count?: number;
  };
  /** Additional metadata */
  metadata?: {
    project?: string;
    projectPath?: string;
    template?: string;
    firstPrompt?: string;
    phase?: string;
    [key: string]: unknown;
  };
}

/** Response from trajectory/checkpoint extension call */
export interface TrajectoryCheckpointResult {
  ok: boolean;
  resource_id?: string;
  created?: boolean;
  checkpoint_id?: string;
}

/** Inbound content request from the hub */
export interface TrajectoryContentRequest {
  request_id: string;
  checkpoint_id: string;
}

// =============================================================================
// Coordination Wire Format
// =============================================================================

/** Inbound task assignment from hub */
export interface CoordinationTaskAssign {
  title: string;
  description?: string;
  assigned_to?: string;
  assigned_by: string;
  priority?: string;
  context?: Record<string, unknown>;
  deadline?: string;
}

/** Inbound task status update from hub */
export interface CoordinationTaskStatus {
  task_id: string;
  status: string;
  progress?: number;
  result?: unknown;
  error?: string;
}

/** Inbound context share from hub */
export interface CoordinationContextShare {
  hive_id?: string;
  source_swarm_id: string;
  context_type: string;
  data: unknown;
  target_swarm_ids?: string[];
  ttl_seconds?: number;
}

/** Inbound message from hub */
export interface CoordinationMessage {
  hive_id?: string;
  from_swarm_id: string;
  to_swarm_id: string;
  content_type: string;
  content: unknown;
  reply_to?: string;
  metadata?: Record<string, unknown>;
}

// =============================================================================
// Internal Bridge Types
// =============================================================================

/** Task bridge interface for emitting task events to MAP */
export interface TaskBridge {
  taskCreated(task: {
    id: string;
    title: string;
    status: string;
    assignee?: string;
  }): Promise<void>;
  taskStatusChanged(
    taskId: string,
    previous: string,
    current: string,
    agentId?: string,
  ): Promise<void>;
  taskAssigned(taskId: string, assignee: string): Promise<void>;
}

/** Trajectory reporter interface */
export interface TrajectoryReporter {
  reportCheckpoint(
    checkpoint: TrajectoryCheckpointPayload,
  ): Promise<TrajectoryCheckpointResult | null>;
  stop(): void;
}

// =============================================================================
// MAP Server Types (inbound connections)
// =============================================================================

/** Configuration for the MAP server that accepts inbound connections */
export interface MapServerConfig {
  /** Port for MAP WebSocket server (default: 3002) */
  port?: number;
  /** Host to bind (default: "127.0.0.1") */
  host?: string;
  /** WebSocket path (default: "/map") */
  path?: string;
  /** Server name for MAP protocol (default: "macro-agent") */
  name?: string;
}

/** MAP server instance for accepting inbound MAP connections */
export interface MAPServerInstance {
  /** Start the server */
  start(): Promise<void>;
  /** Stop the server */
  stop(): Promise<void>;
  /** Get the WebSocket URL */
  getUrl(): string;
  /** Get number of active connections */
  getConnectionCount(): number;
  /**
   * Resolve a local agent ID (macro-agent internal) to its MAP server-assigned ULID.
   * Returns undefined if the agent is not registered on the MAP server yet.
   */
  getLocalMapId(localAgentId: string): string | undefined;
}
