/**
 * Adapter interfaces for subsystem integration.
 *
 * InboxAdapter wraps agent-inbox for messaging.
 * TasksAdapter wraps opentasks for task management.
 *
 * These are the only two touch points between macro-agent
 * and the external subsystems.
 *
 * @module adapters/types
 */

import type { Message, MessageContent, Importance } from "agent-inbox";

// ─────────────────────────────────────────────────────────────────
// InboxAdapter
// ─────────────────────────────────────────────────────────────────

/**
 * Event emitted when a message is delivered to an agent's inbox.
 */
export interface InboxDeliveryEvent {
  /** Recipient agent ID */
  agentId: string;
  /** Recipient kind (to, cc, bcc) */
  recipientKind: "to" | "cc" | "bcc";
  /** The delivered message */
  message: Message;
}

/**
 * Signal filter: returns false to suppress delivery to a specific agent.
 * Used by TeamRuntime to enforce subscription-based signal filtering.
 */
export type SignalFilterFn = (
  from: string,
  to: string,
  message: Message
) => boolean;

/**
 * Emission validator: returns a rejection reason string to block the send,
 * or null to allow it. Used by TeamRuntime to enforce per-role emission rules.
 */
export type EmissionValidatorFn = (
  from: string,
  message: Message
) => string | null;

/**
 * Options for registering an agent with agent-inbox.
 */
export interface RegisterAgentOptions {
  name?: string;
  role: string;
  scope: string;
  metadata?: Record<string, unknown>;
}

/**
 * Options for sending a message through agent-inbox.
 */
export interface SendMessageOptions {
  threadTag?: string;
  importance?: Importance;
  scope?: string;
  subject?: string;
  inReplyTo?: string;
}

/**
 * Delivery event handler callback.
 */
export type DeliveryHandler = (event: InboxDeliveryEvent) => void;

/**
 * InboxAdapter — macro-agent's interface to agent-inbox.
 *
 * Owns adapter-side signal filtering and emission validation.
 * Embeds agent-inbox in-process for zero-latency event access,
 * with IPC server running for agent MCP subprocesses.
 */
export interface InboxAdapter {
  // ── Agent Lifecycle ──────────────────────────────────────────

  /** Register an agent in agent-inbox's storage and warm registry. */
  registerAgent(
    agentId: string,
    opts: RegisterAgentOptions
  ): Promise<void>;

  /** Deregister an agent (set status to offline). */
  deregisterAgent(agentId: string): Promise<void>;

  // ── Messaging ────────────────────────────────────────────────

  /**
   * Send a message. Emission validation runs before forwarding
   * to agent-inbox. Returns the message ID on success.
   *
   * @throws if emission validator rejects the send.
   */
  send(
    from: string,
    to: string | string[],
    content: MessageContent | string,
    opts?: SendMessageOptions
  ): Promise<string>;

  // ── Delivery Subscription ────────────────────────────────────

  /**
   * Subscribe to delivery events. Signal filtering runs before
   * invoking the handler — filtered messages are silently dropped.
   */
  onDelivery(handler: DeliveryHandler): void;

  /** Remove a delivery handler. */
  offDelivery(handler: DeliveryHandler): void;

  // ── Queries ──────────────────────────────────────────────────

  /** Check an agent's inbox. */
  checkInbox(
    agentId: string,
    opts?: { unreadOnly?: boolean; limit?: number }
  ): Promise<Message[]>;

  /** Read a message thread by tag. */
  readThread(
    threadTag: string,
    scope?: string
  ): Promise<Message[]>;

  // ── Policy Hooks (set by TeamRuntime) ────────────────────────

  /** Install a signal filter (replaces any existing filter). */
  setSignalFilter(filter: SignalFilterFn): void;

  /** Install an emission validator (replaces any existing validator). */
  setEmissionValidator(validator: EmissionValidatorFn): void;

  // ── Multi-Team Policy Hooks ─────────────────────────────────

  /** Add a named signal filter (for multi-team). */
  addSignalFilter(id: string, filter: SignalFilterFn): void;

  /** Remove a named signal filter. */
  removeSignalFilter(id: string): void;

  /** Add a named emission validator (for multi-team). */
  addEmissionValidator(id: string, validator: EmissionValidatorFn): void;

  /** Remove a named emission validator. */
  removeEmissionValidator(id: string): void;

  // ── Lifecycle ────────────────────────────────────────────────

  /** The IPC socket path for agent subprocesses to connect to. */
  readonly socketPath: string;

  /** Stop the embedded agent-inbox (IPC server, storage, etc.). */
  stop(): Promise<void>;
}

// ─────────────────────────────────────────────────────────────────
// TasksAdapter
// ─────────────────────────────────────────────────────────────────

/**
 * Task status values used by macro-agent.
 * Maps to opentasks canonical statuses.
 */
export type TaskStatus = "open" | "in_progress" | "blocked" | "closed";

/**
 * Semantic actions for task state transitions.
 */
export type TaskAction = "start" | "complete" | "fail" | "block" | "reopen";

/**
 * Options for creating a task.
 */
export interface CreateTaskOptions {
  title: string;
  content?: string;
  assignee?: string;
  parent?: string;
  tags?: string[];
  priority?: number;
}

/**
 * Options for querying tasks.
 */
export interface TaskQueryOptions {
  status?: TaskStatus;
  assignee?: string;
  tags?: string[];
  limit?: number;
}

/**
 * Simplified task record returned by the adapter.
 * Flattened from opentasks' graph node model.
 */
export interface TaskRecord {
  id: string;
  title: string;
  content?: string;
  status: TaskStatus;
  assignee?: string;
  parent?: string;
  tags?: string[];
  priority?: number;
  claimed_by?: string;
  created_at?: string;
  closed_at?: string;
  metadata?: Record<string, unknown>;
}

/**
 * TasksAdapter — macro-agent's interface to opentasks.
 *
 * Wraps OpenTasksClient via IPC to the opentasks daemon.
 * macro-agent ensures the daemon is running at boot.
 */
export interface TasksAdapter {
  // ── Task Lifecycle ───────────────────────────────────────────

  /** Create a new task. Returns the task ID. */
  createTask(opts: CreateTaskOptions): Promise<string>;

  /** Assign a task to an agent. */
  assignTask(taskId: string, agentId: string): Promise<void>;

  /** Transition a task to a new state via semantic action. */
  transitionTask(taskId: string, action: TaskAction): Promise<void>;

  // ── Queries ──────────────────────────────────────────────────

  /** Get a single task by ID. */
  getTask(taskId: string): Promise<TaskRecord>;

  /** Query tasks ready to work on (no active blockers). */
  queryReady(opts?: { tags?: string[]; limit?: number }): Promise<TaskRecord[]>;

  /** List tasks with optional filters. */
  listTasks(filter?: TaskQueryOptions): Promise<TaskRecord[]>;

  // ── Dependencies ─────────────────────────────────────────────

  /** Add a blocking dependency: blockerId blocks taskId. */
  addBlocker(taskId: string, blockerId: string): Promise<void>;

  /** Remove a blocking dependency. */
  removeBlocker(taskId: string, blockerId: string): Promise<void>;

  // ── Pull Mode (claim-based) ──────────────────────────────────

  /** Claim the next available task matching the filter. */
  claimTask(
    agentId: string,
    filter?: { tags?: string[] }
  ): Promise<TaskRecord | null>;

  /** Release a claimed task back to the pool. */
  unclaimTask(taskId: string): Promise<void>;

  /** List tasks available for claiming. */
  listClaimable(
    filter?: { tags?: string[]; limit?: number }
  ): Promise<TaskRecord[]>;

  // ── Connection Lifecycle ─────────────────────────────────────

  /** Connect to the opentasks daemon. Auto-starts if needed. */
  connect(): Promise<void>;

  /** Disconnect from the opentasks daemon. */
  disconnect(): void;

  /** Whether the adapter is connected to the daemon. */
  readonly connected: boolean;
}
