/**
 * OpenTasks Client Interface
 *
 * Defines the client interface for communicating with the OpenTasks daemon.
 * This abstracts over the IPC transport so the backend doesn't depend on
 * opentasks internals.
 *
 * @module task/backend/opentasks/client
 */

import { OpenTasksClient as OTClient } from "opentasks";

// =============================================================================
// OpenTasks Data Types (mirrored from opentasks schema)
// =============================================================================

/**
 * OpenTasks issue node.
 * Represents an actionable work item in the OpenTasks graph.
 */
export interface OpenTasksIssue {
  id: string;
  uuid: string;
  type: "task";
  title: string;
  content?: string;
  status: string;
  assignee?: string;
  closed_at?: string;
  priority?: number;
  tags?: string[];
  parent_id?: string;
  created_at: string;
  updated_at: string;
  claimed_by?: string;
  claimed_at?: string;
  lock_until?: string;
  archived?: boolean;
  archived_at?: string;
  metadata?: Record<string, unknown>;
  source?: string;
  branch?: string;
}

/**
 * OpenTasks edge (relationship between nodes).
 */
export interface OpenTasksEdge {
  id: string;
  uuid: string;
  from_id: string;
  to_id: string;
  type: string;
  created_at: string;
  created_by?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Reduced node summary from queries.
 */
export interface OpenTasksNodeSummary {
  id: string;
  type: string;
  title: string;
  status?: string;
  priority?: number;
  archived: boolean;
}

// =============================================================================
// Client Configuration
// =============================================================================

/**
 * Configuration for the OpenTasks client
 */
export interface OpenTasksClientConfig {
  /** Path to the daemon Unix socket */
  socketPath?: string;

  /** Auto-connect on first request (default: true) */
  autoConnect?: boolean;

  /** Request timeout in milliseconds (default: 30000) */
  timeout?: number;
}

// =============================================================================
// Input Types
// =============================================================================

/**
 * Input for creating a new issue in OpenTasks
 */
export interface CreateIssueInput {
  title: string;
  content?: string;
  status?: string;
  assignee?: string;
  priority?: number;
  tags?: string[];
  parent_id?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Input for updating an issue in OpenTasks
 */
export interface UpdateIssueInput {
  title?: string;
  content?: string;
  status?: string;
  assignee?: string | null;
  priority?: number;
  tags?: string[];
  parent_id?: string | null;
  archived?: boolean;
  metadata?: Record<string, unknown>;
}

// =============================================================================
// Task Lifecycle Types (mirrors opentasks tools.task interface)
// =============================================================================

/**
 * Semantic task actions supported by TaskManageable providers
 */
export type TaskAction = "start" | "complete" | "block" | "reopen" | "close";

/**
 * Parameters for the tools.task IPC method.
 * Exactly one operation must be specified.
 */
export interface TaskParams {
  /** Transition a task's status using a semantic action */
  transition?: {
    /** Task ID or provider URI */
    id: string;
    /** Semantic action */
    action: TaskAction;
  };

  /** Get tasks ready to work on (federated across TaskManageable providers) */
  ready?: {
    /** Only query these providers (by name). Omit to query all. */
    providers?: string[];
    /** Maximum results */
    limit?: number;
    /** Filter by tags */
    tags?: string[];
    /** Filter by minimum priority */
    priority?: number;
    /** Filter by assignee */
    assignee?: string;
  };

  /** Assign a task to an owner */
  assign?: {
    /** Task ID or provider URI */
    id: string;
    /** Assignee identifier */
    assignee: string;
  };

  /** Get valid next actions for a task in its current state */
  validActions?: {
    /** Task ID or provider URI */
    id: string;
  };

  /** Return full objects instead of summaries (default: false) */
  verbose?: boolean;
}

/**
 * Result from tools.task operations
 */
export interface TaskResult {
  /** Whether the operation succeeded */
  success: boolean;
  /** Result data (shape depends on operation) */
  data?: TaskTransitionData | TaskReadyData | TaskAssignData | TaskValidActionsData;
  /** Error message if operation failed */
  error?: string;
}

export interface TaskTransitionData {
  type: "transition";
  node: TaskNodeSummary;
  provider: string;
  action: string;
}

export interface TaskReadyData {
  type: "ready";
  items: TaskNodeSummary[];
  total: number;
}

export interface TaskAssignData {
  type: "assign";
  node: TaskNodeSummary;
  provider: string;
}

export interface TaskValidActionsData {
  type: "validActions";
  actions: string[];
}

/**
 * Node summary returned by task operations
 */
export interface TaskNodeSummary {
  id: string;
  type: string;
  title: string;
  status?: string;
  priority?: number;
  archived: boolean;
}

/**
 * Provider summary from provider.list
 */
export interface ProviderSummary {
  name: string;
  schemes: string[];
  capabilities: Record<string, boolean>;
  isDefault: boolean;
  taskCapabilities?: {
    actions: TaskAction[];
    supportsAssignment: boolean;
    supportsReadyQuery: boolean;
    statusModel: string[];
  };
}

// =============================================================================
// Event Types
// =============================================================================

/**
 * Issue change event types
 */
export type IssueChangeType =
  | "created"
  | "updated"
  | "deleted"
  | "status_changed";

/**
 * Issue change event
 */
export interface IssueChangeEvent {
  type: IssueChangeType;
  issueId: string;
  issue?: OpenTasksIssue;
  previousIssue?: OpenTasksIssue;
}

/**
 * Callback for issue change events
 */
export type IssueChangeCallback = (event: IssueChangeEvent) => void;

/**
 * Unsubscribe function
 */
export type ClientUnsubscribe = () => void;

// =============================================================================
// OpenTasksClient Interface
// =============================================================================

/**
 * Client interface for interacting with the OpenTasks daemon.
 *
 * This defines only the operations needed by the macro-agent task backend.
 * It can be implemented by:
 * - The opentasks package's OpenTasksClient (when available)
 * - A custom IPC client
 * - A mock for testing
 */
export interface OpenTasksClient {
  // ─── Issue CRUD ──────────────────────────────────────────────

  /** Create a new issue */
  createIssue(input: CreateIssueInput): Promise<OpenTasksIssue>;

  /** Get an issue by ID */
  getIssue(id: string): Promise<OpenTasksIssue | null>;

  /** Update an issue */
  updateIssue(id: string, updates: UpdateIssueInput): Promise<OpenTasksIssue>;

  /** Delete an issue (soft delete / archive) */
  deleteIssue(id: string): Promise<void>;

  /** List issues with optional filters */
  listIssues(filter?: {
    status?: string | string[];
    assignee?: string;
    tags?: string[];
    parent_id?: string;
    archived?: boolean;
    limit?: number;
  }): Promise<OpenTasksIssue[]>;

  // ─── Ready / Claimable Queries ───────────────────────────────

  /** Get issues that are ready to work on (no blocking dependencies) */
  getReadyIssues(options?: {
    tags?: string[];
    assignee?: string;
    limit?: number;
  }): Promise<OpenTasksNodeSummary[]>;

  // ─── Relationship Operations ─────────────────────────────────

  /** Create an edge between two nodes */
  createEdge(
    fromId: string,
    toId: string,
    type: string
  ): Promise<OpenTasksEdge>;

  /** Remove an edge between two nodes */
  removeEdge(
    fromId: string,
    toId: string,
    type: string
  ): Promise<void>;

  /** Get nodes that block the given node */
  getBlockers(nodeId: string): Promise<OpenTasksNodeSummary[]>;

  /** Get nodes that the given node blocks */
  getBlocking(nodeId: string): Promise<OpenTasksNodeSummary[]>;

  // ─── Task Lifecycle (provider-agnostic via tools.task) ──────

  /** Execute a task lifecycle operation (tools.task IPC) */
  task(params: TaskParams): Promise<TaskResult>;

  /** Transition a task's status using a semantic action */
  taskTransition(id: string, action: TaskAction): Promise<TaskResult>;

  /** Get tasks ready to work on across all TaskManageable providers */
  taskReady(options?: TaskParams["ready"]): Promise<TaskResult>;

  /** Assign a task to an owner */
  taskAssign(id: string, assignee: string): Promise<TaskResult>;

  /** Get valid next actions for a task in its current state */
  taskValidActions(id: string): Promise<TaskResult>;

  // ─── Provider Introspection ───────────────────────────────

  /** List all registered providers and their capabilities */
  listProviders(): Promise<ProviderSummary[]>;

  // ─── Lifecycle ───────────────────────────────────────────────

  /** Check if the client is connected */
  isConnected(): boolean;

  /** Connect to the daemon */
  connect(): Promise<void>;

  /** Disconnect from the daemon */
  disconnect(): void;
}

// =============================================================================
// IPC-based Client Implementation
// =============================================================================

/**
 * Default OpenTasks client implementation using the opentasks package.
 *
 * Wraps the opentasks client library to implement the OpenTasksClient interface.
 */
export class IPCOpenTasksClient implements OpenTasksClient {
  private client: any = null;
  private readonly config: OpenTasksClientConfig;

  constructor(config?: OpenTasksClientConfig) {
    this.config = {
      autoConnect: true,
      timeout: 30000,
      ...config,
    };
  }

  async connect(): Promise<void> {
    if (this.client?.connected) return;

    try {
      this.client = new OTClient({
        socketPath: this.config.socketPath,
        autoConnect: false,
        timeout: this.config.timeout,
      });
      await this.client.connect();
    } catch (error: any) {
      throw new OpenTasksClientError(
        `Failed to connect to OpenTasks daemon: ${error.message}`,
        "CONNECTION_FAILED"
      );
    }
  }

  disconnect(): void {
    if (this.client) {
      this.client.disconnect();
      this.client = null;
    }
  }

  isConnected(): boolean {
    return this.client?.connected ?? false;
  }

  private async ensureConnected(): Promise<void> {
    if (this.isConnected()) return;
    if (this.config.autoConnect) {
      await this.connect();
      return;
    }
    throw new OpenTasksClientError(
      "Not connected to OpenTasks daemon",
      "NOT_CONNECTED"
    );
  }

  async createIssue(input: CreateIssueInput): Promise<OpenTasksIssue> {
    await this.ensureConnected();
    return this.client.createNode({
      type: "task",
      title: input.title,
      content: input.content,
      status: input.status ?? "open",
      assignee: input.assignee,
      priority: input.priority,
      tags: input.tags,
      parent_id: input.parent_id,
      metadata: input.metadata,
    }) as Promise<OpenTasksIssue>;
  }

  async getIssue(id: string): Promise<OpenTasksIssue | null> {
    await this.ensureConnected();
    try {
      const node = await this.client.getNode(id);
      if (!node || (node as any).type !== "task") return null;
      return node as OpenTasksIssue;
    } catch {
      return null;
    }
  }

  async updateIssue(
    id: string,
    updates: UpdateIssueInput
  ): Promise<OpenTasksIssue> {
    await this.ensureConnected();
    return this.client.updateNode(id, updates) as Promise<OpenTasksIssue>;
  }

  async deleteIssue(id: string): Promise<void> {
    await this.ensureConnected();
    await this.client.deleteNode(id, { hard: false });
  }

  async listIssues(filter?: {
    status?: string | string[];
    assignee?: string;
    tags?: string[];
    parent_id?: string;
    archived?: boolean;
    limit?: number;
  }): Promise<OpenTasksIssue[]> {
    await this.ensureConnected();
    const result = await this.client.query({
      nodes: {
        type: "task",
        status: filter?.status,
        assignee: filter?.assignee,
        tags: filter?.tags,
        parent_id: filter?.parent_id,
        archived: filter?.archived ?? false,
        limit: filter?.limit ?? 100,
      },
      verbose: true,
    });
    return (result.items ?? []) as OpenTasksIssue[];
  }

  async getReadyIssues(options?: {
    tags?: string[];
    assignee?: string;
    limit?: number;
  }): Promise<OpenTasksNodeSummary[]> {
    await this.ensureConnected();
    const result = await this.client.query({
      ready: {
        tags: options?.tags,
        assignee: options?.assignee,
        limit: options?.limit,
      },
    });
    return (result.items ?? []) as OpenTasksNodeSummary[];
  }

  async createEdge(
    fromId: string,
    toId: string,
    type: string
  ): Promise<OpenTasksEdge> {
    await this.ensureConnected();
    const result = await this.client.link({
      fromId,
      toId,
      type,
    });
    return {
      id: result.edgeId ?? "",
      uuid: "",
      from_id: fromId,
      to_id: toId,
      type,
      created_at: new Date().toISOString(),
    };
  }

  async removeEdge(
    fromId: string,
    toId: string,
    type: string
  ): Promise<void> {
    await this.ensureConnected();
    await this.client.link({
      fromId,
      toId,
      type,
      remove: true,
    });
  }

  async getBlockers(nodeId: string): Promise<OpenTasksNodeSummary[]> {
    await this.ensureConnected();
    const result = await this.client.query({
      blockers: {
        nodeId,
        activeOnly: true,
      },
    });
    return (result.items ?? []) as OpenTasksNodeSummary[];
  }

  async getBlocking(nodeId: string): Promise<OpenTasksNodeSummary[]> {
    await this.ensureConnected();
    const result = await this.client.query({
      blocking: {
        nodeId,
        activeOnly: true,
      },
    });
    return (result.items ?? []) as OpenTasksNodeSummary[];
  }

  // ─── Task Lifecycle (tools.task) ──────────────────────────────

  async task(params: TaskParams): Promise<TaskResult> {
    await this.ensureConnected();
    return this.client.call("tools.task", params) as Promise<TaskResult>;
  }

  async taskTransition(id: string, action: TaskAction): Promise<TaskResult> {
    return this.task({ transition: { id, action } });
  }

  async taskReady(options?: TaskParams["ready"]): Promise<TaskResult> {
    return this.task({ ready: options ?? {} });
  }

  async taskAssign(id: string, assignee: string): Promise<TaskResult> {
    return this.task({ assign: { id, assignee } });
  }

  async taskValidActions(id: string): Promise<TaskResult> {
    return this.task({ validActions: { id } });
  }

  // ─── Provider Introspection ─────────────────────────────────

  async listProviders(): Promise<ProviderSummary[]> {
    await this.ensureConnected();
    const result = await this.client.call("provider.list", {}) as {
      providers: ProviderSummary[];
    };
    return result.providers ?? [];
  }

  // ─── Generic IPC Call ──────────────────────────────────────

  async call(method: string, params: Record<string, unknown>): Promise<unknown> {
    await this.ensureConnected();
    return this.client.call(method, params);
  }
}

// =============================================================================
// Error Types
// =============================================================================

/**
 * Error thrown by OpenTasks client operations
 */
export class OpenTasksClientError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "NOT_CONNECTED"
      | "CONNECTION_FAILED"
      | "REQUEST_FAILED"
      | "NOT_FOUND"
  ) {
    super(message);
    this.name = "OpenTasksClientError";
  }
}

// =============================================================================
// Factory
// =============================================================================

/**
 * Create an OpenTasks client.
 *
 * @param config - Client configuration
 * @returns An OpenTasksClient instance
 */
export async function createOpenTasksClient(
  config?: OpenTasksClientConfig
): Promise<OpenTasksClient> {
  const client = new IPCOpenTasksClient(config);
  await client.connect();
  return client;
}
