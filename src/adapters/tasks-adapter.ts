/**
 * TasksAdapter — Wraps opentasks client for macro-agent's task management.
 *
 * Connects to the opentasks daemon via IPC. Uses autoConnect to
 * auto-start the daemon if it's not running.
 *
 * Translates between macro-agent's domain types and opentasks'
 * graph model (nodes, edges, semantic actions).
 *
 * @module adapters/tasks-adapter
 */

import type {
  TasksAdapter as ITasksAdapter,
  CreateTaskOptions,
  TaskAction,
  TaskRecord,
  TaskQueryOptions,
} from "./types.js";

// ─────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────

export interface TasksAdapterConfig {
  /** Path to opentasks daemon socket (auto-discovered if not set). */
  socketPath?: string;
  /** Request timeout in milliseconds (default: 30000). */
  timeout?: number;
}

// ─────────────────────────────────────────────────────────────────
// Implementation
// ─────────────────────────────────────────────────────────────────

export class DefaultTasksAdapter implements ITasksAdapter {
  private client: OpenTasksClientLike | null = null;
  private readonly config: TasksAdapterConfig;
  private _connected = false;

  constructor(config: TasksAdapterConfig = {}) {
    this.config = config;
  }

  get connected(): boolean {
    return this._connected;
  }

  // ── Connection Lifecycle ─────────────────────────────────────

  async connect(): Promise<void> {
    if (this._connected) return;

    // Dynamically import opentasks to avoid hard compile-time dep issues
    const { OpenTasksClient } = await import("opentasks");
    this.client = new OpenTasksClient({
      socketPath: this.config.socketPath,
      autoConnect: true,
      timeout: this.config.timeout ?? 30000,
    }) as any as OpenTasksClientLike;

    await this.client!.connect();
    this._connected = true;
  }

  disconnect(): void {
    if (this.client) {
      this.client.disconnect();
      this.client = null;
      this._connected = false;
    }
  }

  // ── Task Lifecycle ───────────────────────────────────────────

  async createTask(opts: CreateTaskOptions): Promise<string> {
    const client = this.requireClient();

    const result = await client.query({
      nodes: { type: "task" },
    });

    // Create via the task tool's semantic interface
    const createResult = await client.task({
      create: {
        title: opts.title,
        content: opts.content,
        status: "open",
        assignee: opts.assignee,
        parent_id: opts.parent,
        tags: opts.tags,
        priority: opts.priority,
      },
    });

    return createResult.id ?? createResult.node_id ?? "";
  }

  async assignTask(taskId: string, agentId: string): Promise<void> {
    const client = this.requireClient();
    await client.task({
      assign: { id: taskId, assignee: agentId },
    });
  }

  async transitionTask(taskId: string, action: TaskAction): Promise<void> {
    const client = this.requireClient();
    await client.task({
      transition: { id: taskId, action },
    });
  }

  // ── Queries ──────────────────────────────────────────────────

  async getTask(taskId: string): Promise<TaskRecord> {
    const client = this.requireClient();
    const result = await client.query({
      nodes: { id: taskId },
    });

    const items = result.items ?? [];
    if (items.length === 0) {
      throw new Error(`Task not found: ${taskId}`);
    }

    return this.nodeToTaskRecord(items[0]);
  }

  async queryReady(
    opts?: { tags?: string[]; limit?: number }
  ): Promise<TaskRecord[]> {
    const client = this.requireClient();
    const result = await client.query({
      ready: {
        limit: opts?.limit,
        tags: opts?.tags,
      },
    });

    return (result.items ?? []).map((n: NodeSummaryLike) =>
      this.nodeToTaskRecord(n)
    );
  }

  async listTasks(filter?: TaskQueryOptions): Promise<TaskRecord[]> {
    const client = this.requireClient();
    const result = await client.query({
      nodes: {
        type: "task",
        status: filter?.status,
        assignee: filter?.assignee,
        tags: filter?.tags,
        limit: filter?.limit,
      },
    });

    return (result.items ?? []).map((n: NodeSummaryLike) =>
      this.nodeToTaskRecord(n)
    );
  }

  // ── Dependencies ─────────────────────────────────────────────

  async addBlocker(taskId: string, blockerId: string): Promise<void> {
    const client = this.requireClient();
    await client.link({
      from_id: blockerId,
      to_id: taskId,
      type: "blocks",
    });
  }

  async removeBlocker(taskId: string, blockerId: string): Promise<void> {
    const client = this.requireClient();
    await client.link({
      from_id: blockerId,
      to_id: taskId,
      type: "blocks",
      remove: true,
    });
  }

  // ── Pull Mode ────────────────────────────────────────────────

  async claimTask(
    agentId: string,
    filter?: { tags?: string[] }
  ): Promise<TaskRecord | null> {
    const client = this.requireClient();

    // Query ready tasks, then claim the first one
    const result = await client.query({
      ready: {
        limit: 1,
        tags: filter?.tags,
      },
    });

    const items = result.items ?? [];
    if (items.length === 0) return null;

    const task = items[0];
    const taskId = task.id;

    // Assign + transition to claim
    await client.task({
      assign: { id: taskId, assignee: agentId },
    });
    await client.task({
      transition: { id: taskId, action: "start" },
    });

    return this.nodeToTaskRecord({ ...task, status: "in_progress", assignee: agentId });
  }

  async unclaimTask(taskId: string): Promise<void> {
    const client = this.requireClient();
    // Reopen and unassign
    await client.task({
      transition: { id: taskId, action: "reopen" },
    });
    await client.task({
      assign: { id: taskId, assignee: "" },
    });
  }

  async listClaimable(
    filter?: { tags?: string[]; limit?: number }
  ): Promise<TaskRecord[]> {
    return this.queryReady(filter);
  }

  // ── Private ──────────────────────────────────────────────────

  private requireClient(): OpenTasksClientLike {
    if (!this.client || !this._connected) {
      throw new Error(
        "TasksAdapter not connected. Call connect() first."
      );
    }
    return this.client;
  }

  private nodeToTaskRecord(node: NodeSummaryLike): TaskRecord {
    return {
      id: node.id ?? "",
      title: node.title ?? "",
      content: node.content,
      status: mapOpenTasksStatus(node.status),
      assignee: node.assignee,
      parent: node.parent_id,
      tags: node.tags,
      priority: node.priority,
      claimed_by: node.claimed_by ?? node.assignee,
      created_at: node.created_at,
      closed_at: node.closed_at,
      metadata: node.metadata,
    };
  }
}

// ─────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────

/**
 * Map opentasks canonical status to our TaskStatus type.
 */
function mapOpenTasksStatus(
  status?: string
): "open" | "in_progress" | "blocked" | "closed" {
  switch (status) {
    case "open":
      return "open";
    case "in_progress":
      return "in_progress";
    case "blocked":
      return "blocked";
    case "closed":
      return "closed";
    default:
      return "open";
  }
}

// ─────────────────────────────────────────────────────────────────
// Internal types for opentasks client duck typing
// ─────────────────────────────────────────────────────────────────

/**
 * Minimal interface for the opentasks client.
 * Avoids hard compile-time dependency on opentasks types.
 */
interface OpenTasksClientLike {
  connect(): Promise<void>;
  disconnect(): void;
  query(params: Record<string, unknown>): Promise<QueryResultLike>;
  link(params: Record<string, unknown>): Promise<unknown>;
  task(params: Record<string, unknown>): Promise<TaskResultLike>;
}

interface QueryResultLike {
  items?: NodeSummaryLike[];
  hasMore?: boolean;
  total?: number;
}

interface TaskResultLike {
  id?: string;
  node_id?: string;
  success?: boolean;
  [key: string]: unknown;
}

interface NodeSummaryLike {
  id?: string;
  title?: string;
  content?: string;
  status?: string;
  assignee?: string;
  parent_id?: string;
  tags?: string[];
  priority?: number;
  claimed_by?: string;
  created_at?: string;
  closed_at?: string;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}
