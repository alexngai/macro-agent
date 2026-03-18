/**
 * AgentStore — Minimal SQLite store for agent lifecycle and session state.
 *
 * Replaces the heavy EventStore + TinyBase materialized views with
 * simple CRUD on two tables: agents and sessions.
 *
 * @module agent/agent-store
 */

import Database from "better-sqlite3";
import type {
  AgentId,
  SessionId,
  Timestamp,
} from "../store/types/primitives.js";
import type {
  AgentState,
  StopReason,
} from "../store/types/agents.js";

// Re-export primitives used by agent-store consumers
export type { AgentId, SessionId, Timestamp };
export type { AgentState, StopReason };

// ─────────────────────────────────────────────────────────────────
// Record Types
// ─────────────────────────────────────────────────────────────────

/**
 * Agent record stored in SQLite. Minimal lifecycle state only —
 * messages live in agent-inbox, tasks live in opentasks.
 */
export interface AgentRecord {
  id: AgentId;
  name?: string;
  role: string;
  state: AgentState;
  stop_reason?: StopReason;
  parent_id: AgentId | null;
  lineage: AgentId[];
  team?: string;
  scope: string;
  task: string;
  task_id?: string;
  cwd: string;
  capabilities: string[];
  workspace_path?: string;
  workspace_stream_id?: string;
  config?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  created_at: Timestamp;
  started_at?: Timestamp;
  stopped_at?: Timestamp;
  last_activity_at?: Timestamp;
}

/**
 * Session record mapping agent IDs to acp-factory sessions.
 */
export interface SessionRecord {
  agent_id: AgentId;
  session_id: SessionId;
  provider_session_id?: string;
  created_at: Timestamp;
}

/**
 * Filter options for listing agents.
 */
export interface AgentStoreFilter {
  state?: AgentState;
  role?: string;
  team?: string;
  parent_id?: AgentId | null;
  scope?: string;
}

// ─────────────────────────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────────────────────────

const SCHEMA = `
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT,
  role TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'running',
  stop_reason TEXT,
  parent_id TEXT,
  lineage TEXT NOT NULL DEFAULT '[]',
  team TEXT,
  scope TEXT NOT NULL DEFAULT 'default',
  task TEXT NOT NULL DEFAULT '',
  task_id TEXT,
  cwd TEXT NOT NULL DEFAULT '',
  capabilities TEXT NOT NULL DEFAULT '[]',
  workspace_path TEXT,
  workspace_stream_id TEXT,
  config TEXT,
  metadata TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  stopped_at INTEGER,
  last_activity_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_agents_state ON agents(state);
CREATE INDEX IF NOT EXISTS idx_agents_parent ON agents(parent_id);
CREATE INDEX IF NOT EXISTS idx_agents_team ON agents(team);
CREATE INDEX IF NOT EXISTS idx_agents_role ON agents(role);

CREATE TABLE IF NOT EXISTS sessions (
  agent_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  provider_session_id TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
);
`;

// ─────────────────────────────────────────────────────────────────
// Implementation
// ─────────────────────────────────────────────────────────────────

export class AgentStore {
  private db: Database.Database;

  constructor(dbPath: string = ":memory:") {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(SCHEMA);
  }

  // ── Agents ─────────────────────────────────────────────────────

  putAgent(agent: AgentRecord): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO agents
        (id, name, role, state, stop_reason, parent_id, lineage, team, scope,
         task, task_id, cwd, capabilities, workspace_path, workspace_stream_id,
         config, metadata, created_at, started_at, stopped_at, last_activity_at)
      VALUES
        (@id, @name, @role, @state, @stop_reason, @parent_id, @lineage, @team, @scope,
         @task, @task_id, @cwd, @capabilities, @workspace_path, @workspace_stream_id,
         @config, @metadata, @created_at, @started_at, @stopped_at, @last_activity_at)
    `);
    stmt.run({
      id: agent.id,
      name: agent.name ?? null,
      role: agent.role,
      state: agent.state,
      stop_reason: agent.stop_reason ?? null,
      parent_id: agent.parent_id,
      lineage: JSON.stringify(agent.lineage),
      team: agent.team ?? null,
      scope: agent.scope,
      task: agent.task,
      task_id: agent.task_id ?? null,
      cwd: agent.cwd,
      capabilities: JSON.stringify(agent.capabilities),
      workspace_path: agent.workspace_path ?? null,
      workspace_stream_id: agent.workspace_stream_id ?? null,
      config: agent.config ? JSON.stringify(agent.config) : null,
      metadata: agent.metadata ? JSON.stringify(agent.metadata) : null,
      created_at: agent.created_at,
      started_at: agent.started_at ?? null,
      stopped_at: agent.stopped_at ?? null,
      last_activity_at: agent.last_activity_at ?? null,
    });
  }

  getAgent(id: AgentId): AgentRecord | null {
    const row = this.db
      .prepare("SELECT * FROM agents WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToAgent(row) : null;
  }

  listAgents(filter?: AgentStoreFilter): AgentRecord[] {
    const conditions: string[] = [];
    const params: Record<string, unknown> = {};

    if (filter?.state) {
      conditions.push("state = @state");
      params.state = filter.state;
    }
    if (filter?.role) {
      conditions.push("role = @role");
      params.role = filter.role;
    }
    if (filter?.team) {
      conditions.push("team = @team");
      params.team = filter.team;
    }
    if (filter?.scope) {
      conditions.push("scope = @scope");
      params.scope = filter.scope;
    }
    if (filter?.parent_id !== undefined) {
      if (filter.parent_id === null) {
        conditions.push("parent_id IS NULL");
      } else {
        conditions.push("parent_id = @parent_id");
        params.parent_id = filter.parent_id;
      }
    }

    const where =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM agents ${where} ORDER BY created_at ASC`)
      .all(params) as Record<string, unknown>[];

    return rows.map((r) => this.rowToAgent(r));
  }

  updateAgent(id: AgentId, updates: Partial<AgentRecord>): void {
    const fields: string[] = [];
    const params: Record<string, unknown> = { id };

    for (const [key, value] of Object.entries(updates)) {
      if (key === "id") continue;
      const col = key;
      if (
        col === "lineage" ||
        col === "capabilities" ||
        col === "config" ||
        col === "metadata"
      ) {
        fields.push(`${col} = @${col}`);
        params[col] = JSON.stringify(value);
      } else {
        fields.push(`${col} = @${col}`);
        params[col] = value ?? null;
      }
    }

    if (fields.length === 0) return;

    this.db
      .prepare(`UPDATE agents SET ${fields.join(", ")} WHERE id = @id`)
      .run(params);
  }

  removeAgent(id: AgentId): void {
    this.db.prepare("DELETE FROM agents WHERE id = ?").run(id);
  }

  // ── Hierarchy ──────────────────────────────────────────────────

  getChildren(parentId: AgentId): AgentRecord[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM agents WHERE parent_id = ? ORDER BY created_at ASC"
      )
      .all(parentId) as Record<string, unknown>[];
    return rows.map((r) => this.rowToAgent(r));
  }

  getDescendants(agentId: AgentId): AgentRecord[] {
    const result: AgentRecord[] = [];
    const queue = [agentId];

    while (queue.length > 0) {
      const parentId = queue.shift()!;
      const children = this.getChildren(parentId);
      for (const child of children) {
        result.push(child);
        queue.push(child.id);
      }
    }

    return result;
  }

  getAncestors(agentId: AgentId): AgentRecord[] {
    const ancestors: AgentRecord[] = [];
    let current = this.getAgent(agentId);

    while (current?.parent_id) {
      const parent = this.getAgent(current.parent_id);
      if (!parent) break;
      ancestors.push(parent);
      current = parent;
    }

    return ancestors;
  }

  // ── Sessions ───────────────────────────────────────────────────

  putSession(session: SessionRecord): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO sessions
        (agent_id, session_id, provider_session_id, created_at)
        VALUES (@agent_id, @session_id, @provider_session_id, @created_at)`
      )
      .run({
        agent_id: session.agent_id,
        session_id: session.session_id,
        provider_session_id: session.provider_session_id ?? null,
        created_at: session.created_at,
      });
  }

  getSession(agentId: AgentId): SessionRecord | null {
    const row = this.db
      .prepare("SELECT * FROM sessions WHERE agent_id = ?")
      .get(agentId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      agent_id: row.agent_id as string,
      session_id: row.session_id as string,
      provider_session_id: (row.provider_session_id as string) || undefined,
      created_at: row.created_at as number,
    };
  }

  removeSession(agentId: AgentId): void {
    this.db.prepare("DELETE FROM sessions WHERE agent_id = ?").run(agentId);
  }

  // ── Utility ────────────────────────────────────────────────────

  close(): void {
    this.db.close();
  }

  /** Get the underlying database (for advanced use / testing). */
  get database(): Database.Database {
    return this.db;
  }

  // ── Private ────────────────────────────────────────────────────

  private rowToAgent(row: Record<string, unknown>): AgentRecord {
    return {
      id: row.id as string,
      name: (row.name as string) || undefined,
      role: row.role as string,
      state: row.state as AgentState,
      stop_reason: (row.stop_reason as StopReason) || undefined,
      parent_id: (row.parent_id as string) || null,
      lineage: JSON.parse((row.lineage as string) || "[]"),
      team: (row.team as string) || undefined,
      scope: row.scope as string,
      task: row.task as string,
      task_id: (row.task_id as string) || undefined,
      cwd: row.cwd as string,
      capabilities: JSON.parse((row.capabilities as string) || "[]"),
      workspace_path: (row.workspace_path as string) || undefined,
      workspace_stream_id: (row.workspace_stream_id as string) || undefined,
      config: row.config ? JSON.parse(row.config as string) : undefined,
      metadata: row.metadata ? JSON.parse(row.metadata as string) : undefined,
      created_at: row.created_at as number,
      started_at: (row.started_at as number) || undefined,
      stopped_at: (row.stopped_at as number) || undefined,
      last_activity_at: (row.last_activity_at as number) || undefined,
    };
  }
}
