/**
 * Event Store implementation using TinyBase
 *
 * Provides an append-only event log with materialized views for:
 * - Agents
 * - Tasks
 * - Messages (per-agent queues)
 * - Subscriptions
 */

import { createStore, Store } from 'tinybase';
import { createCustomPersister, createCustomSqlitePersister } from 'tinybase/persisters';
import type { DatabasePersisterConfig } from 'tinybase/persisters';
import Database from 'better-sqlite3';
import { nanoid } from 'nanoid';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

import type {
  Event,
  EventInput,
  EventFilter,
  Agent,
  AgentState,
  AgentMetadataUpdate,
  Task,
  TaskStatus,
  QueuedMessage,
  Subscription,
  SubscriptionType,
  AgentId,
  TaskId,
  EventId,
  Timestamp,
  Conversation,
  ConversationTurn,
  ConversationThread,
  ConversationParticipant,
  ConversationFilter,
  TurnFilter,
  ConversationChangeCallback,
  TurnChangeCallback,
  ConversationType,
  ConversationStatus,
  Session,
  SessionState,
} from './types/index.js';
import { CURRENT_EVENT_VERSION } from './types/events.js';
import { migrateEvent } from './migrations.js';
import {
  type StoreConfig,
  type PeerVisibilityConfig,
  resolveInstancePath,
  ensureInstanceDir,
  createInstanceMeta,
  writeInstanceMeta,
  readInstanceMeta,
  touchInstance,
  registerInstance,
  DEFAULT_NAMESPACE,
  DEFAULT_PEER_VISIBILITY,
  filterEventsForPeer,
} from './instance.js';
import type { StorageBackend, ExportedEvent } from './backends/types.js';
import { createTinyBaseBackend } from './backends/tinybase-backend.js';

// ─────────────────────────────────────────────────────────────────────────────
// Tabular better-sqlite3 Persister
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build tabular config for the 10 TinyBase tables.
 * Identity mapping: TinyBase table name === SQLite table name.
 */
function getTabularConfig(): DatabasePersisterConfig {
  const tableNames = [
    'events', 'agents', 'tasks', 'messages',
    'sessions', 'conversations', 'turns',
    'threads', 'subscriptions', 'participants',
  ];

  const load: Record<string, string> = {};
  const save: Record<string, string> = {};
  for (const t of tableNames) {
    load[t] = t;   // SQLite table -> TinyBase table (same name)
    save[t] = t;   // TinyBase table -> SQLite table (same name)
  }

  return {
    mode: 'tabular',
    tables: { load, save },
    autoLoadIntervalSeconds: 1,
  };
}

/**
 * Creates a tabular TinyBase persister backed by better-sqlite3.
 *
 * Unlike the old JSON blob approach (entire store as one JSON string in a
 * single row), tabular mode maps each TinyBase table to a real SQLite table
 * and only writes changed rows on autoSave — making persistence O(delta)
 * instead of O(total).
 */
function createTabularBetterSqlite3Persister(
  store: Store,
  db: ReturnType<typeof Database>,
) {
  // Wrap better-sqlite3's sync API as the async DatabaseExecuteCommand.
  // TinyBase generates SQL with $1, $2, ... placeholders (PostgreSQL-style),
  // but better-sqlite3 uses ? for positional array binding. Convert them.
  const executeCommand = async (sql: string, params?: any[]): Promise<Record<string, any>[]> => {
    const convertedSql = sql.replace(/\$\d+/g, '?');
    const trimmed = convertedSql.trimStart().toUpperCase();
    const stmt = db.prepare(convertedSql);
    if (trimmed.startsWith('SELECT') || trimmed.startsWith('PRAGMA')) {
      return (params ? stmt.all(...params) : stmt.all()) as Record<string, any>[];
    }
    params ? stmt.run(...params) : stmt.run();
    return [];
  };

  return createCustomSqlitePersister(
    store,
    getTabularConfig(),
    executeCommand,
    // addChangeListener — better-sqlite3 has no native change events
    (_listener: (tableName: string) => void) => null as any,
    // delChangeListener — no-op
    (_handle: any) => {},
    // onSqlCommand
    undefined,
    // onIgnoredError
    (error: any) => console.warn('[EventStore] Persister error:', error),
    // destroy
    () => db.close(),
    // persist mode (1 = StoreOnly)
    1 as any,
    // thing (the db instance)
    db,
    // getThing accessor name
    'getDb',
  );
}

// View change callback types
export type AgentChangeCallback = (agentId: AgentId, agent: Agent | null) => void;
export type TaskChangeCallback = (taskId: TaskId, task: Task | null) => void;
export type MessageCallback = (agentId: AgentId, messages: QueuedMessage[]) => void;
export type SessionChangeCallback = (sessionId: string, session: Session | null) => void;

// Unsubscribe function type
export type Unsubscribe = () => void;

// Archive-related types
export interface ArchiveOptions {
  olderThan?: string; // "7d", "30d"
  before?: Timestamp;
}

export interface ArchiveResult {
  archivedCount: number;
  archivePath: string;
  oldestRetained: Timestamp;
}

export interface ArchiveInfo {
  archives: Array<{ path: string; from: Timestamp; to: Timestamp; eventCount: number }>;
  totalArchivedEvents: number;
}

interface ArchiveManifest {
  version: number;
  archives: Array<{ path: string; from: Timestamp; to: Timestamp; eventCount: number }>;
}

interface LoadArchiveOptions {
  from?: Timestamp;
  to?: Timestamp;
}

/**
 * Event Store interface
 */
export interface EventStore {
  // ─── Instance Info ───
  /** Instance identifier */
  readonly instanceId: string;
  /** Namespace for discovery */
  readonly namespace: string;
  /** Path to instance directory (or ':memory:') */
  readonly instancePath: string;
  /** Base directory for all storage */
  readonly baseDir: string;
  /** Backend type being used */
  readonly backendType: string;
  /** Peer visibility configuration */
  readonly peerVisibility: import('./instance.js').PeerVisibilityConfig;

  // Event operations
  emit(event: EventInput): Event;
  query(filter?: EventFilter): Event[];

  // Agent view
  getAgent(agentId: AgentId): Agent | null;
  listAgents(filter?: { state?: AgentState; parent?: AgentId | null }): Agent[];
  updateAgentPlan(agentId: AgentId, plan: Array<{ content: string; priority: string; status: string }>): void;
  updateAgentMetadata(agentId: AgentId, updates: AgentMetadataUpdate): void;

  // Task view
  getTask(taskId: TaskId): Task | null;
  listTasks(filter?: { status?: TaskStatus; assigned_agent?: AgentId }): Task[];

  // Message queue
  getMessages(agentId: AgentId, limit?: number): QueuedMessage[];
  getFullMessage(messageId: EventId): string | null;

  // Subscriptions
  addSubscription(agentId: AgentId, subscription: Subscription): void;
  removeSubscription(agentId: AgentId, subscription: Subscription): void;
  getSubscriptions(agentId: AgentId): Subscription[];
  getSubscribers(subscription: Subscription): AgentId[];

  // Session views
  getSession(sessionId: string): Session | null;
  listSessions(filter?: { state?: SessionState; agent_id?: AgentId }): Session[];

  // Conversation views
  getConversation(conversationId: string): Conversation | null;
  listConversations(filter?: ConversationFilter): Conversation[];
  listTurns(filter: TurnFilter): ConversationTurn[];
  listParticipants(conversationId: string, active?: boolean): ConversationParticipant[];

  // Reactive updates
  onAgentChange(callback: AgentChangeCallback): Unsubscribe;
  onAgentChange(agentId: AgentId, callback: AgentChangeCallback): Unsubscribe;
  onTaskChange(callback: TaskChangeCallback): Unsubscribe;
  onMessageChange(agentId: AgentId, callback: MessageCallback): Unsubscribe;
  onSessionChange(callback: SessionChangeCallback): Unsubscribe;
  onConversationChange(callback: ConversationChangeCallback): Unsubscribe;
  onTurnChange(callback: TurnChangeCallback): Unsubscribe;

  // Lifecycle
  persist(): Promise<void>;
  reload(): Promise<void>;
  close(): Promise<void>;

  // Archival
  archive(options?: ArchiveOptions): Promise<ArchiveResult>;
  loadArchive(options?: LoadArchiveOptions): Promise<Event[]>;
  getArchiveInfo(): Promise<ArchiveInfo>;

  // ─── Export/Import (for sync) ───
  /**
   * Export events for peer sync.
   * @param filter Optional event filter
   * @param options Export options
   * @param options.forPeer If true, filter by peerVisibility config
   */
  exportEvents(filter?: EventFilter, options?: { forPeer?: boolean }): ExportedEvent[];
  /** Import events from peer */
  importEvents(events: ExportedEvent[]): void;

  // ─── Advanced ───
  /**
   * Get underlying storage backend (for advanced use).
   * Returns a StorageBackend wrapper around the internal TinyBase store.
   */
  getBackend(): import('./backends/types.js').StorageBackend;
}

/**
 * Parse a duration string (e.g., "30d", "7d") to milliseconds
 */
export function parseDuration(duration: string): number {
  const match = duration.match(/^(\d+)([dhms])$/);
  if (!match) {
    throw new Error(`Invalid duration format: "${duration}". Use format like "30d", "7d", "24h", "60m", "30s".`);
  }

  const value = parseInt(match[1], 10);
  const unit = match[2];

  const multipliers: Record<string, number> = {
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
  };

  return value * multipliers[unit];
}

/**
 * Create an Event Store instance
 */
export async function createEventStore(config: StoreConfig = {}): Promise<EventStore> {
  // Resolve instance configuration
  const resolved = resolveInstancePath(config);
  const { instanceId, instancePath, namespace, isNew, backendType } = resolved;

  // Reject deprecated legacy path option
  if (config.path) {
    throw new Error(
      '[macro-agent] The `path` option has been removed. ' +
        'Use `instanceId` and `baseDir` instead for per-instance isolation.'
    );
  }

  // Track baseDir for MCP subprocess communication
  const baseDir = config.baseDir ?? path.join(os.homedir(), '.multiagent');

  // Get peer visibility config (default is restrictive)
  const peerVisibility: PeerVisibilityConfig =
    config.peerVisibility ?? DEFAULT_PEER_VISIBILITY;

  // Emit warning for in-memory mode (only in non-test environments)
  if (config.inMemory && process.env.NODE_ENV !== 'test') {
    console.warn(
      '[macro-agent] WARNING: Using in-memory EventStore. MCP tools (done, spawn_agent, etc.) will not work ' +
        'because MCP servers run as separate subprocesses that cannot access in-memory data. ' +
        'Use file-based storage (remove inMemory option) for real agent workflows.'
    );
  }

  const store = createStore();

  // Set up persister based on backend type
  let persister: ReturnType<typeof createTabularBetterSqlite3Persister> | null = null;
  let db: ReturnType<typeof Database> | null = null;

  if (!config.inMemory) {
    ensureInstanceDir(instancePath);
    const dbPath = path.join(instancePath, 'store.sqlite');
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');

    // Migration: if old JSON blob table exists, load data from it first
    const oldTableExists = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='tinybase_store'"
    ).get();

    if (oldTableExists) {
      const oldPersister = createCustomPersister(
        store,
        async () => {
          const row = db!.prepare("SELECT store FROM tinybase_store WHERE _id = '_'").get() as { store: string } | undefined;
          return row ? JSON.parse(row.store) : undefined;
        },
        async () => {},
        (listener) => setInterval(listener, 1000),
        (interval: ReturnType<typeof setInterval>) => clearInterval(interval),
      );
      await oldPersister.load();
      oldPersister.destroy();
    }

    persister = createTabularBetterSqlite3Persister(store, db);

    if (oldTableExists) {
      // Save migrated data to new tabular format, then drop old table
      await persister.save();
      db.exec('DROP TABLE IF EXISTS tinybase_store');
    }

    await persister.load();
    // Auto-save: persist to disk whenever the in-memory store changes.
    // Without this, emit() only writes to TinyBase's in-memory store and
    // data is lost if the server is killed before an explicit persist().
    await persister.startAutoSave();
  }

  // Initialize/update instance metadata
  if (!config.inMemory) {
    if (isNew) {
      const meta = createInstanceMeta(resolved, config);
      writeInstanceMeta(instancePath, meta);
    } else {
      touchInstance(instancePath);
    }

    // Register in namespace for discovery
    registerInstance(
      config.baseDir ?? path.join(os.homedir(), '.multiagent'),
      namespace,
      instanceId,
      { label: config.label }
    );
  }

  // Initialize tables if they don't exist
  initializeTables(store);

  // Rebuild materialized views from events
  rebuildViews(store);

  // Listener registries
  const agentListeners = new Set<AgentChangeCallback>();
  const agentIdListeners = new Map<AgentId, Set<AgentChangeCallback>>();
  const taskListeners = new Set<TaskChangeCallback>();
  const sessionListeners = new Set<SessionChangeCallback>();
  const messageListeners = new Map<AgentId, Set<MessageCallback>>();
  const conversationListeners = new Set<ConversationChangeCallback>();
  const turnListeners = new Set<TurnChangeCallback>();

  /**
   * Emit a new event to the store
   */
  function emit(input: EventInput): Event {
    const event: Event = {
      ...input,
      id: `evt_${nanoid(12)}`,
      version: CURRENT_EVENT_VERSION,
      timestamp: Date.now(),
    };

    // Store the event
    // Note: Use empty object for undefined source to avoid JSON.parse errors in query
    store.setRow('events', event.id, {
      id: event.id,
      version: event.version,
      timestamp: event.timestamp,
      type: event.type,
      source: JSON.stringify(event.source ?? {}),
      target: event.target ? JSON.stringify(event.target) : '',
      payload: JSON.stringify(event.payload),
      metadata: event.metadata ? JSON.stringify(event.metadata) : '',
    });

    // Update materialized views
    applyEventToViews(store, event, notifyAgentChange, notifyTaskChange, notifyMessageChange, notifySessionChange, notifyConversationChange, notifyTurnChange);

    return event;
  }

  /**
   * Query events with filters
   */
  function query(filter?: EventFilter): Event[] {
    const events: Event[] = [];
    const rowIds = store.getRowIds('events');

    for (const rowId of rowIds) {
      const row = store.getRow('events', rowId);
      if (!row.id) continue;

      // Parse raw event data
      // Handle legacy data where source might be stored as "undefined" string
      const sourceStr = row.source as string;
      const parsedSource = sourceStr && sourceStr !== 'undefined'
        ? JSON.parse(sourceStr)
        : {};

      const rawEvent = {
        id: row.id as string,
        version: row.version as number | undefined,
        timestamp: row.timestamp as number,
        type: row.type as string,
        source: parsedSource,
        target: row.target ? JSON.parse(row.target as string) : undefined,
        payload: JSON.parse(row.payload as string),
        metadata: row.metadata ? JSON.parse(row.metadata as string) : undefined,
      };

      // Migrate event to current version if needed
      const event = migrateEvent(rawEvent);

      // Apply filters
      if (filter) {
        if (filter.type && event.type !== filter.type) continue;
        if (filter.source_agent_id && event.source.agent_id !== filter.source_agent_id) continue;
        if (filter.target_agent_id && event.target?.agent_id !== filter.target_agent_id) continue;
        if (filter.after && event.timestamp <= filter.after) continue;
        if (filter.before && event.timestamp >= filter.before) continue;
      }

      events.push(event);
    }

    // Sort by timestamp
    events.sort((a, b) => a.timestamp - b.timestamp);

    // Apply limit
    if (filter?.limit) {
      return events.slice(0, filter.limit);
    }

    return events;
  }

  /**
   * Get agent by ID
   */
  function getAgent(agentId: AgentId): Agent | null {
    const row = store.getRow('agents', agentId);
    if (!row.id) return null;
    return rowToAgent(row);
  }

  /**
   * List agents with optional filter
   */
  function listAgents(filter?: { state?: AgentState; parent?: AgentId | null }): Agent[] {
    const agents: Agent[] = [];
    const rowIds = store.getRowIds('agents');

    for (const rowId of rowIds) {
      const row = store.getRow('agents', rowId);
      if (!row.id) continue;

      const agent = rowToAgent(row);

      if (filter) {
        if (filter.state && agent.state !== filter.state) continue;
        if (filter.parent !== undefined && agent.parent !== filter.parent) continue;
      }

      agents.push(agent);
    }

    return agents;
  }

  /**
   * Update agent metadata fields (name, plan, metadata).
   * Only provided fields are updated. Metadata is shallow-merged with existing.
   */
  function updateAgentMetadata(
    agentId: AgentId,
    updates: AgentMetadataUpdate,
  ): void {
    const row = store.getRow('agents', agentId);
    if (!row.id) return;

    const partial: Record<string, string | number | boolean> = {
      last_activity_at: Date.now(),
    };

    if (updates.name !== undefined) {
      partial.name = updates.name;
    }
    if (updates.plan !== undefined) {
      partial.plan = JSON.stringify(updates.plan);
    }
    if (updates.metadata !== undefined) {
      // Shallow merge with existing metadata
      const existing = row.metadata ? JSON.parse(row.metadata as string) : {};
      partial.metadata = JSON.stringify({ ...existing, ...updates.metadata });
    }

    store.setPartialRow('agents', agentId, partial);

    const agent = rowToAgent(store.getRow('agents', agentId));
    notifyAgentChange(agentId, agent);
  }

  /**
   * Update an agent's plan entries (persisted to SQLite via TinyBase).
   * Convenience wrapper around updateAgentMetadata.
   */
  function updateAgentPlan(
    agentId: AgentId,
    plan: Array<{ content: string; priority: string; status: string }>,
  ): void {
    updateAgentMetadata(agentId, { plan });
  }


  /**
   * Get task by ID
   */
  function getTask(taskId: TaskId): Task | null {
    const row = store.getRow('tasks', taskId);
    if (!row.id) return null;
    return rowToTask(row);
  }

  /**
   * List tasks with optional filter
   */
  function listTasks(filter?: { status?: TaskStatus; assigned_agent?: AgentId }): Task[] {
    const tasks: Task[] = [];
    const rowIds = store.getRowIds('tasks');

    for (const rowId of rowIds) {
      const row = store.getRow('tasks', rowId);
      if (!row.id) continue;

      const task = rowToTask(row);

      if (filter) {
        if (filter.status && task.status !== filter.status) continue;
        if (filter.assigned_agent && task.assigned_agent !== filter.assigned_agent) continue;
      }

      tasks.push(task);
    }

    return tasks;
  }

  /**
   * Get pending messages for an agent
   */
  function getMessages(agentId: AgentId, limit?: number): QueuedMessage[] {
    const messages: QueuedMessage[] = [];
    const rowIds = store.getRowIds('messages');

    for (const rowId of rowIds) {
      const row = store.getRow('messages', rowId);
      if (!row.id || row.recipient !== agentId) continue;

      messages.push({
        id: row.id as string,
        from: JSON.parse(row.from as string),
        content: row.content as string,
        timestamp: row.timestamp as number,
        truncated: row.truncated as boolean,
        correlation_id: row.correlation_id as string | undefined,
      });
    }

    // Sort by timestamp
    messages.sort((a, b) => a.timestamp - b.timestamp);

    if (limit) {
      return messages.slice(0, limit);
    }

    return messages;
  }

  /**
   * Get full message content by ID
   */
  function getFullMessage(messageId: EventId): string | null {
    // Look up the original event
    const row = store.getRow('events', messageId);
    if (!row.id || row.type !== 'message') return null;

    const payload = JSON.parse(row.payload as string);
    return payload.content ?? null;
  }

  /**
   * Add a subscription for an agent
   */
  function addSubscription(agentId: AgentId, subscription: Subscription): void {
    const subId = `${agentId}:${subscription.type}:${subscription.target}`;
    store.setRow('subscriptions', subId, {
      id: subId,
      agent_id: agentId,
      type: subscription.type,
      target: subscription.target,
    });
  }

  /**
   * Remove a subscription for an agent
   */
  function removeSubscription(agentId: AgentId, subscription: Subscription): void {
    const subId = `${agentId}:${subscription.type}:${subscription.target}`;
    store.delRow('subscriptions', subId);
  }

  /**
   * Get all subscriptions for an agent
   */
  function getSubscriptions(agentId: AgentId): Subscription[] {
    const subscriptions: Subscription[] = [];
    const rowIds = store.getRowIds('subscriptions');

    for (const rowId of rowIds) {
      const row = store.getRow('subscriptions', rowId);
      if (row.agent_id !== agentId) continue;

      subscriptions.push({
        type: row.type as SubscriptionType,
        target: row.target as string,
      });
    }

    return subscriptions;
  }

  /**
   * Get all agents subscribed to a given subscription
   */
  function getSubscribers(subscription: Subscription): AgentId[] {
    const subscribers: AgentId[] = [];
    const rowIds = store.getRowIds('subscriptions');

    for (const rowId of rowIds) {
      const row = store.getRow('subscriptions', rowId);
      if (row.type !== subscription.type || row.target !== subscription.target) continue;

      subscribers.push(row.agent_id as AgentId);
    }

    return subscribers;
  }

  /**
   * Notify agent change listeners
   */
  function notifyAgentChange(agentId: AgentId, agent: Agent | null): void {
    // Global listeners
    for (const callback of agentListeners) {
      callback(agentId, agent);
    }

    // Specific agent listeners
    const specificListeners = agentIdListeners.get(agentId);
    if (specificListeners) {
      for (const callback of specificListeners) {
        callback(agentId, agent);
      }
    }
  }

  /**
   * Notify task change listeners
   */
  function notifyTaskChange(taskId: TaskId, task: Task | null): void {
    for (const callback of taskListeners) {
      callback(taskId, task);
    }
  }

  /**
   * Notify message change listeners
   */
  function notifyMessageChange(agentId: AgentId): void {
    const listeners = messageListeners.get(agentId);
    if (listeners) {
      const messages = getMessages(agentId);
      for (const callback of listeners) {
        callback(agentId, messages);
      }
    }
  }

  /**
   * Subscribe to agent changes (all agents or specific agent)
   */
  function onAgentChange(callbackOrId: AgentChangeCallback | AgentId, callback?: AgentChangeCallback): Unsubscribe {
    if (typeof callbackOrId === 'function') {
      // Global subscription
      agentListeners.add(callbackOrId);
      return () => agentListeners.delete(callbackOrId);
    } else {
      // Specific agent subscription
      const agentId = callbackOrId;
      const cb = callback!;
      if (!agentIdListeners.has(agentId)) {
        agentIdListeners.set(agentId, new Set());
      }
      agentIdListeners.get(agentId)!.add(cb);
      return () => agentIdListeners.get(agentId)?.delete(cb);
    }
  }

  /**
   * Subscribe to task changes
   */
  function onTaskChange(callback: TaskChangeCallback): Unsubscribe {
    taskListeners.add(callback);
    return () => taskListeners.delete(callback);
  }

  /**
   * Subscribe to message changes for an agent
   */
  function onMessageChange(agentId: AgentId, callback: MessageCallback): Unsubscribe {
    if (!messageListeners.has(agentId)) {
      messageListeners.set(agentId, new Set());
    }
    messageListeners.get(agentId)!.add(callback);
    return () => messageListeners.get(agentId)?.delete(callback);
  }

  /**
   * Notify conversation change listeners
   */
  function notifyConversationChange(conversationId: string, conversation: Conversation | null): void {
    for (const callback of conversationListeners) {
      callback(conversationId, conversation);
    }
  }

  /**
   * Notify turn change listeners
   */
  function notifyTurnChange(conversationId: string, turn: ConversationTurn): void {
    for (const callback of turnListeners) {
      callback(conversationId, turn);
    }
  }

  /**
   * Subscribe to conversation changes
   */
  function onConversationChange(callback: ConversationChangeCallback): Unsubscribe {
    conversationListeners.add(callback);
    return () => conversationListeners.delete(callback);
  }

  /**
   * Subscribe to turn changes
   */
  function onTurnChange(callback: TurnChangeCallback): Unsubscribe {
    turnListeners.add(callback);
    return () => turnListeners.delete(callback);
  }

  // ─── Session View Queries ───

  function getSession(sessionId: string): Session | null {
    const row = store.getRow('sessions', sessionId);
    if (!row.id) return null;
    return rowToSession(row);
  }

  function listSessions(filter?: { state?: SessionState; agent_id?: AgentId }): Session[] {
    const sessions: Session[] = [];
    const rowIds = store.getRowIds('sessions');

    for (const rowId of rowIds) {
      const row = store.getRow('sessions', rowId);
      if (!row.id) continue;

      const session = rowToSession(row);

      if (filter) {
        if (filter.state && session.state !== filter.state) continue;
        if (filter.agent_id && session.current_agent_id !== filter.agent_id && session.head_manager_id !== filter.agent_id) continue;
      }

      sessions.push(session);
    }

    return sessions;
  }

  /**
   * Notify session change listeners
   */
  function notifySessionChange(sessionId: string, session: Session | null): void {
    for (const callback of sessionListeners) {
      callback(sessionId, session);
    }
  }

  /**
   * Subscribe to session changes
   */
  function onSessionChange(callback: SessionChangeCallback): Unsubscribe {
    sessionListeners.add(callback);
    return () => sessionListeners.delete(callback);
  }

  // ─── Conversation View Queries ───

  function getConversation(conversationId: string): Conversation | null {
    const row = store.getRow('conversations', conversationId);
    if (!row.id) return null;
    return rowToConversation(row);
  }

  function listConversations(filter?: ConversationFilter): Conversation[] {
    const conversations: Conversation[] = [];
    const rowIds = store.getRowIds('conversations');

    for (const rowId of rowIds) {
      const row = store.getRow('conversations', rowId);
      if (!row.id) continue;

      const conversation = rowToConversation(row);

      if (filter) {
        if (filter.type && conversation.type !== filter.type) continue;
        if (filter.status && conversation.status !== filter.status) continue;
        if (filter.parentConversationId && conversation.parentConversationId !== filter.parentConversationId) continue;
        if (filter.participantId) {
          // Check participants table for membership
          const partRow = store.getRow('participants', `${conversation.id}:${filter.participantId}`);
          if (!partRow.id) continue;
          // Skip if participant has left
          if (partRow.left_at && (partRow.left_at as number) > 0) continue;
        }
      }

      conversations.push(conversation);
    }

    return conversations;
  }

  function listTurns(filter: TurnFilter): ConversationTurn[] {
    const turns: ConversationTurn[] = [];
    const rowIds = store.getRowIds('turns');

    for (const rowId of rowIds) {
      const row = store.getRow('turns', rowId);
      if (!row.id) continue;

      const turn = rowToTurn(row);

      // Filter by conversation (required)
      if (turn.conversationId !== filter.conversationId) continue;

      // Optional filters
      if (filter.threadId && turn.threadId !== filter.threadId) continue;
      if (filter.contentType && turn.contentType !== filter.contentType) continue;
      if (filter.participantId && turn.participant !== filter.participantId) continue;

      turns.push(turn);
    }

    // Sort
    const order = filter.order ?? 'asc';
    turns.sort((a, b) => order === 'asc' ? a.timestamp - b.timestamp : b.timestamp - a.timestamp);

    // Limit
    if (filter.limit) {
      return turns.slice(0, filter.limit);
    }

    return turns;
  }

  function listParticipants(conversationId: string, active?: boolean): ConversationParticipant[] {
    const participants: ConversationParticipant[] = [];
    const rowIds = store.getRowIds('participants');

    for (const rowId of rowIds) {
      const row = store.getRow('participants', rowId);
      if (!row.id) continue;

      if (row.conversation_id !== conversationId) continue;

      const participant = rowToParticipant(row);

      if (active && participant.leftAt) continue;

      participants.push(participant);
    }

    return participants;
  }

  /**
   * Persist store to disk
   */
  async function persist(): Promise<void> {
    if (persister) {
      await persister.save();
    }
  }

  /**
   * Reload store from disk (refresh data from SQLite)
   */
  async function reload(): Promise<void> {
    if (persister) {
      await persister.load();
      // Rebuild materialized views from freshly loaded events
      rebuildViews(store);
    }
  }

  /**
   * Close the store
   */
  async function close(): Promise<void> {
    if (persister) {
      await persister.save();
      persister.destroy();
    }
    if (db) {
      db.close();
    }
  }

  /**
   * Get archives directory path
   */
  function getArchivesDir(): string {
    return path.join(instancePath, 'archives');
  }

  /**
   * Get manifest file path
   */
  function getManifestPath(): string {
    return path.join(getArchivesDir(), 'manifest.json');
  }

  /**
   * Read archive manifest
   */
  function readManifest(): ArchiveManifest {
    const manifestPath = getManifestPath();
    if (fs.existsSync(manifestPath)) {
      return JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    }
    return { version: 1, archives: [] };
  }

  /**
   * Write archive manifest
   */
  function writeManifest(manifest: ArchiveManifest): void {
    const manifestPath = getManifestPath();
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  }

  /**
   * Archive old events to prevent unbounded store growth
   */
  async function archive(options: ArchiveOptions = {}): Promise<ArchiveResult> {
    // Calculate cutoff timestamp
    let cutoff: Timestamp;
    if (options.before !== undefined) {
      cutoff = options.before;
    } else if (options.olderThan) {
      cutoff = Date.now() - parseDuration(options.olderThan);
    } else {
      // Default to 30 days
      cutoff = Date.now() - parseDuration('30d');
    }

    // Query events older than cutoff
    const allEvents = query();
    const eventsToArchive = allEvents.filter((e) => e.timestamp < cutoff);
    const eventsToRetain = allEvents.filter((e) => e.timestamp >= cutoff);

    if (eventsToArchive.length === 0) {
      return {
        archivedCount: 0,
        archivePath: '',
        oldestRetained: eventsToRetain.length > 0 ? eventsToRetain[0].timestamp : Date.now(),
      };
    }

    // Ensure archives directory exists
    const archivesDir = getArchivesDir();
    if (!fs.existsSync(archivesDir)) {
      fs.mkdirSync(archivesDir, { recursive: true });
    }

    // Group events by month
    const eventsByMonth = new Map<string, Event[]>();
    for (const event of eventsToArchive) {
      const date = new Date(event.timestamp);
      const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
      if (!eventsByMonth.has(monthKey)) {
        eventsByMonth.set(monthKey, []);
      }
      eventsByMonth.get(monthKey)!.push(event);
    }

    // Read existing manifest
    const manifest = readManifest();

    // Write archive files and update manifest
    let lastArchivePath = '';
    for (const [monthKey, monthEvents] of eventsByMonth) {
      const archivePath = path.join(archivesDir, `${monthKey}.json`);
      lastArchivePath = archivePath;

      // Read existing archive if it exists and merge
      let existingEvents: Event[] = [];
      if (fs.existsSync(archivePath)) {
        existingEvents = JSON.parse(fs.readFileSync(archivePath, 'utf-8'));
      }

      // Merge and deduplicate by event ID
      const mergedEvents = [...existingEvents, ...monthEvents];
      const uniqueEvents = Array.from(new Map(mergedEvents.map((e) => [e.id, e])).values());
      uniqueEvents.sort((a, b) => a.timestamp - b.timestamp);

      // Write archive file
      fs.writeFileSync(archivePath, JSON.stringify(uniqueEvents, null, 2));

      // Update manifest entry
      const existingIndex = manifest.archives.findIndex((a) => a.path === archivePath);
      const archiveEntry = {
        path: archivePath,
        from: uniqueEvents[0].timestamp,
        to: uniqueEvents[uniqueEvents.length - 1].timestamp,
        eventCount: uniqueEvents.length,
      };

      if (existingIndex >= 0) {
        manifest.archives[existingIndex] = archiveEntry;
      } else {
        manifest.archives.push(archiveEntry);
      }
    }

    // Sort manifest archives by date
    manifest.archives.sort((a, b) => a.from - b.from);

    // Write updated manifest
    writeManifest(manifest);

    // Remove archived events from active store
    for (const event of eventsToArchive) {
      store.delRow('events', event.id);
    }

    // Persist the updated store
    await persist();

    return {
      archivedCount: eventsToArchive.length,
      archivePath: lastArchivePath,
      oldestRetained: eventsToRetain.length > 0 ? eventsToRetain[0].timestamp : Date.now(),
    };
  }

  /**
   * Load archived events by date range
   */
  async function loadArchive(options: LoadArchiveOptions = {}): Promise<Event[]> {
    const manifest = readManifest();
    const events: Event[] = [];

    for (const archive of manifest.archives) {
      // Skip archives outside the requested range
      if (options.from !== undefined && archive.to < options.from) continue;
      if (options.to !== undefined && archive.from > options.to) continue;

      // Read archive file
      if (!fs.existsSync(archive.path)) continue;
      const archiveEvents: Event[] = JSON.parse(fs.readFileSync(archive.path, 'utf-8'));

      // Filter by date range
      for (const event of archiveEvents) {
        if (options.from !== undefined && event.timestamp < options.from) continue;
        if (options.to !== undefined && event.timestamp > options.to) continue;
        events.push(event);
      }
    }

    // Sort by timestamp
    events.sort((a, b) => a.timestamp - b.timestamp);

    return events;
  }

  /**
   * Get information about available archives
   */
  async function getArchiveInfo(): Promise<ArchiveInfo> {
    const manifest = readManifest();
    const totalArchivedEvents = manifest.archives.reduce((sum, a) => sum + a.eventCount, 0);

    return {
      archives: manifest.archives,
      totalArchivedEvents,
    };
  }

  /**
   * Export events for peer sync
   * @param filter Optional event filter
   * @param options Export options
   * @param options.forPeer If true, filter by peerVisibility config
   */
  function exportEvents(
    filter?: EventFilter,
    options?: { forPeer?: boolean }
  ): ExportedEvent[] {
    let events = query(filter);

    // If exporting for peer, apply visibility filter
    if (options?.forPeer) {
      events = filterEventsForPeer(events, peerVisibility);
    }

    return events.map((event) => ({
      ...event,
      sourceInstance: instanceId,
    }));
  }

  /**
   * Import events from peer
   */
  function importEvents(events: ExportedEvent[]): void {
    for (const event of events) {
      // Skip if event already exists
      const existing = store.getRow('events', event.id);
      if (existing.id) continue;

      // Store the event
      store.setRow('events', event.id, {
        id: event.id,
        version: event.version,
        timestamp: event.timestamp,
        type: event.type,
        source: JSON.stringify(event.source),
        target: event.target ? JSON.stringify(event.target) : '',
        payload: JSON.stringify(event.payload),
        metadata: event.metadata ? JSON.stringify(event.metadata) : '',
      });

      // Update materialized views
      applyEventToViews(store, event, notifyAgentChange, notifyTaskChange, notifyMessageChange, notifySessionChange, notifyConversationChange, notifyTurnChange);
    }
  }

  /**
   * Get underlying storage backend (for advanced use)
   */
  function getBackend(): StorageBackend {
    return createTinyBaseBackend(store, {
      onFlush: async () => {
        if (persister) {
          await persister.save();
        }
      },
      onClose: async () => {
        if (persister) {
          await persister.save();
          persister.destroy();
        }
        if (db) {
          db.close();
        }
      },
    });
  }

  return {
    // Instance info
    instanceId,
    namespace,
    instancePath,
    baseDir,
    backendType,
    peerVisibility,

    // Event operations
    emit,
    query,

    // Views
    getAgent,
    listAgents,
    updateAgentPlan,
    updateAgentMetadata,
    getTask,
    listTasks,
    getMessages,
    getFullMessage,
    getSession,
    listSessions,
    getConversation,
    listConversations,
    listTurns,
    listParticipants,

    // Subscriptions
    addSubscription,
    removeSubscription,
    getSubscriptions,
    getSubscribers,

    // Reactive updates
    onAgentChange,
    onTaskChange,
    onMessageChange,
    onSessionChange,
    onConversationChange,
    onTurnChange,

    // Lifecycle
    persist,
    reload,
    close,

    // Archival
    archive,
    loadArchive,
    getArchiveInfo,

    // Export/Import
    exportEvents,
    importEvents,

    // Advanced
    getBackend,
  };
}

/**
 * Initialize empty tables in the store
 */
function initializeTables(store: Store): void {
  // Events table is created implicitly when rows are added
  // We just ensure the tables exist by checking row IDs
  store.getRowIds('events');
  store.getRowIds('agents');
  store.getRowIds('tasks');
  store.getRowIds('messages');
  store.getRowIds('subscriptions');
  store.getRowIds('sessions');
  store.getRowIds('conversations');
  store.getRowIds('turns');
  store.getRowIds('threads');
  store.getRowIds('participants');
}

/**
 * Rebuild materialized views from the event log
 */
function rebuildViews(store: Store): void {
  // Preserve out-of-band agent fields that aren't derived from events.
  // These fields are written directly (not through events),
  // so they would be lost when we clear and replay.
  const OUT_OF_BAND_FIELDS = ['plan', 'name', 'metadata'] as const;
  const savedOutOfBand = new Map<string, Record<string, string>>();
  for (const rowId of store.getRowIds('agents')) {
    const row = store.getRow('agents', rowId);
    const saved: Record<string, string> = {};
    for (const field of OUT_OF_BAND_FIELDS) {
      const val = row[field] as string | undefined;
      if (val && val !== '' && val !== '[]') {
        saved[field] = val;
      }
    }
    if (Object.keys(saved).length > 0) {
      savedOutOfBand.set(rowId, saved);
    }
  }

  // Clear existing views
  for (const rowId of store.getRowIds('agents')) {
    store.delRow('agents', rowId);
  }
  for (const rowId of store.getRowIds('tasks')) {
    store.delRow('tasks', rowId);
  }
  for (const rowId of store.getRowIds('messages')) {
    store.delRow('messages', rowId);
  }
  for (const rowId of store.getRowIds('sessions')) {
    store.delRow('sessions', rowId);
  }
  for (const rowId of store.getRowIds('conversations')) {
    store.delRow('conversations', rowId);
  }
  for (const rowId of store.getRowIds('turns')) {
    store.delRow('turns', rowId);
  }
  for (const rowId of store.getRowIds('threads')) {
    store.delRow('threads', rowId);
  }
  for (const rowId of store.getRowIds('participants')) {
    store.delRow('participants', rowId);
  }

  // Replay all events to rebuild views
  const events: Event[] = [];
  for (const rowId of store.getRowIds('events')) {
    const row = store.getRow('events', rowId);
    if (!row.id) continue;

    // Parse raw event and migrate to current version
    const rawEvent = {
      id: row.id as string,
      version: row.version as number | undefined,
      timestamp: row.timestamp as number,
      type: row.type as string,
      source: JSON.parse(row.source as string),
      target: row.target ? JSON.parse(row.target as string) : undefined,
      payload: JSON.parse(row.payload as string),
      metadata: row.metadata ? JSON.parse(row.metadata as string) : undefined,
    };

    events.push(migrateEvent(rawEvent));
  }

  // Sort by timestamp
  events.sort((a, b) => a.timestamp - b.timestamp);

  // Apply each event (no-op callbacks since we're rebuilding)
  const noop = () => {};
  for (const event of events) {
    applyEventToViews(store, event, noop, noop, noop, noop, noop, noop);
  }

  // Restore out-of-band agent fields preserved before the wipe
  for (const [agentId, fields] of savedOutOfBand) {
    const row = store.getRow('agents', agentId);
    if (row.id) {
      store.setPartialRow('agents', agentId, fields);
    }
  }
}

/**
 * Apply a single event to materialized views
 */
function applyEventToViews(
  store: Store,
  event: Event,
  notifyAgentChange: (agentId: AgentId, agent: Agent | null) => void,
  notifyTaskChange: (taskId: TaskId, task: Task | null) => void,
  notifyMessageChange: (agentId: AgentId) => void,
  notifySessionChange: (sessionId: string, session: Session | null) => void,
  notifyConversationChange: (conversationId: string, conversation: Conversation | null) => void,
  notifyTurnChange: (conversationId: string, turn: ConversationTurn) => void,
): void {
  switch (event.type) {
    case 'spawn':
      applySpawnEvent(store, event, notifyAgentChange);
      break;
    case 'terminate':
      applyTerminateEvent(store, event, notifyAgentChange);
      break;
    case 'status':
      applyStatusEvent(store, event, notifyAgentChange);
      break;
    case 'message':
      applyMessageEvent(store, event, notifyMessageChange);
      break;
    case 'task':
      applyTaskEvent(store, event, notifyTaskChange);
      break;
    case 'session':
      applySessionEvent(store, event, notifySessionChange);
      break;
    case 'conversation':
      applyConversationEvent(store, event, notifyConversationChange);
      break;
    case 'turn':
      applyTurnEvent(store, event, notifyTurnChange);
      break;
    case 'thread':
      applyThreadEvent(store, event);
      break;
    case 'peer_message':
    case 'peer_request':
      // Peer events are stored in the event log for audit trail
      // but not materialized into views since PeerManager handles
      // in-memory queues. Events can be queried via eventStore.query().
      break;
  }
}

/**
 * Apply spawn event to agents view
 */
function applySpawnEvent(
  store: Store,
  event: Event,
  notify: (agentId: AgentId, agent: Agent | null) => void,
): void {
  const payload = event.payload as {
    agent_id: AgentId;
    session_id: string;
    task: string;
    task_id?: TaskId;
    parent?: AgentId | null;
    role?: string;
    config?: Record<string, unknown>;
    cwd?: string;
  };

  const agentId = payload.agent_id;
  const parent = payload.parent ?? null;

  // Compute lineage
  let lineage: AgentId[] = [];
  if (parent) {
    const parentRow = store.getRow('agents', parent);
    if (parentRow.lineage) {
      lineage = [...JSON.parse(parentRow.lineage as string), parent];
    } else {
      lineage = [parent];
    }
  }

  store.setRow('agents', agentId, {
    id: agentId,
    name: '',
    session_id: payload.session_id,
    provider_session_id: '',
    parent: parent ?? '',
    lineage: JSON.stringify(lineage),
    state: 'spawning',
    stop_reason: '',
    task: payload.task,
    task_id: payload.task_id ?? '',
    role: payload.role ?? '',
    config: JSON.stringify(payload.config ?? {}),
    cwd: payload.cwd ?? process.cwd(),
    plan: '[]',
    metadata: '',
    created_at: event.timestamp,
    started_at: 0,
    stopped_at: 0,
    last_activity_at: event.timestamp,
  });

  const agent = rowToAgent(store.getRow('agents', agentId));
  notify(agentId, agent);
}

/**
 * Apply terminate event to agents view
 */
function applyTerminateEvent(
  store: Store,
  event: Event,
  notify: (agentId: AgentId, agent: Agent | null) => void,
): void {
  const agentId = event.source.agent_id;
  if (!agentId) return;

  const payload = event.payload as { reason: string };

  store.setPartialRow('agents', agentId, {
    state: 'stopped',
    stop_reason: payload.reason,
    stopped_at: event.timestamp,
    last_activity_at: event.timestamp,
  });

  const agent = rowToAgent(store.getRow('agents', agentId));
  notify(agentId, agent);
}

/**
 * Apply status event to agents view
 */
function applyStatusEvent(
  store: Store,
  event: Event,
  notify: (agentId: AgentId, agent: Agent | null) => void,
): void {
  const agentId = event.source.agent_id;
  if (!agentId) return;

  const payload = event.payload as { status_type: string; provider_session_id?: string };

  // Handle specific status types
  if (payload.status_type === 'started') {
    const updates: Record<string, string | number> = {
      state: 'running',
      started_at: event.timestamp,
      last_activity_at: event.timestamp,
    };
    // Store the provider's session ID (e.g., Claude Code UUID for --resume)
    if (payload.provider_session_id) {
      updates.provider_session_id = payload.provider_session_id;
    }
    store.setPartialRow('agents', agentId, updates);
  } else {
    // Always update last_activity_at on any status event
    store.setPartialRow('agents', agentId, {
      last_activity_at: event.timestamp,
    });
  }

  const agent = rowToAgent(store.getRow('agents', agentId));
  notify(agentId, agent);
}

/**
 * Apply message event to messages view
 */
function applyMessageEvent(
  store: Store,
  event: Event,
  notify: (agentId: AgentId) => void,
): void {
  const target = event.target;
  if (!target) return;

  const payload = event.payload as { content?: unknown; correlation_id?: string };
  // Handle various payload formats - content may be a string, object, or missing
  const rawContent = payload.content;
  const content = typeof rawContent === 'string'
    ? rawContent
    : rawContent != null
      ? JSON.stringify(rawContent)
      : '[no content]';

  // Truncate if needed (1000 chars limit)
  const MAX_CONTENT_LENGTH = 1000;
  const truncated = content.length > MAX_CONTENT_LENGTH;
  const displayContent = truncated ? content.slice(0, MAX_CONTENT_LENGTH) + '...' : content;

  // Route to direct agent target
  if (target.agent_id) {
    const messageId = `${event.id}:${target.agent_id}`;
    store.setRow('messages', messageId, {
      id: event.id,
      recipient: target.agent_id,
      from: JSON.stringify(event.source),
      content: displayContent,
      timestamp: event.timestamp,
      truncated,
      correlation_id: payload.correlation_id ?? '',
    });
    notify(target.agent_id);
  }

  // Route to topic subscribers
  if (target.topic) {
    const rowIds = store.getRowIds('subscriptions');
    for (const rowId of rowIds) {
      const row = store.getRow('subscriptions', rowId);
      if (row.type === 'topic' && row.target === target.topic) {
        const recipientId = row.agent_id as AgentId;
        const messageId = `${event.id}:${recipientId}`;
        store.setRow('messages', messageId, {
          id: event.id,
          recipient: recipientId,
          from: JSON.stringify(event.source),
          content: displayContent,
          timestamp: event.timestamp,
          truncated,
          correlation_id: payload.correlation_id ?? '',
        });
        notify(recipientId);
      }
    }
  }
}

/**
 * Apply task event to tasks view
 */
function applyTaskEvent(
  store: Store,
  event: Event,
  notify: (taskId: TaskId, task: Task | null) => void,
): void {
  const payload = event.payload as {
    task_id: TaskId;
    action: string;
    details?: Record<string, unknown>;
  };

  const taskId = payload.task_id;

  switch (payload.action) {
    case 'created': {
      const details = payload.details as {
        description: string;
        parent_task?: TaskId;
        inputs?: Record<string, unknown>;
        tags?: string[];
        retryPolicy?: unknown;
      };
      store.setRow('tasks', taskId, {
        id: taskId,
        description: details.description,
        status: 'pending',
        assigned_agent: '',
        parent_task: details.parent_task ?? '',
        subtasks: JSON.stringify([]),
        blockers: JSON.stringify([]),
        tags: details.tags ? JSON.stringify(details.tags) : '',
        created_at: event.timestamp,
        started_at: 0,
        completed_at: 0,
        created_by: event.source.agent_id ?? '',
        inputs: JSON.stringify(details.inputs ?? {}),
        outputs: JSON.stringify({}),
        artifacts: JSON.stringify([]),
        agent_history: JSON.stringify([]),
        retry_policy: details.retryPolicy
          ? JSON.stringify(details.retryPolicy)
          : '',
        retry_state: '',
      });
      break;
    }
    case 'assigned': {
      const details = payload.details as { agent_id: AgentId; role?: string };
      const existing = store.getRow('tasks', taskId);
      const history = existing.agent_history
        ? JSON.parse(existing.agent_history as string)
        : [];
      history.push({
        agent_id: details.agent_id,
        role: details.role,
        assigned_at: event.timestamp,
      });
      store.setPartialRow('tasks', taskId, {
        status: 'assigned',
        assigned_agent: details.agent_id,
        agent_history: JSON.stringify(history),
      });
      break;
    }
    case 'unassigned': {
      const details = payload.details as { agent_id: AgentId };
      const existing = store.getRow('tasks', taskId);
      const history = existing.agent_history
        ? JSON.parse(existing.agent_history as string)
        : [];
      // Update the last entry for this agent with ended_at
      for (let i = history.length - 1; i >= 0; i--) {
        if (history[i].agent_id === details.agent_id && !history[i].ended_at) {
          history[i].ended_at = event.timestamp;
          break;
        }
      }
      const updates: Record<string, string | number | boolean> = {
        assigned_agent: '',
        agent_history: JSON.stringify(history),
      };
      // Reset to pending if task was only assigned (not yet started)
      if (existing.status === 'assigned') {
        updates.status = 'pending';
      }
      store.setPartialRow('tasks', taskId, updates);
      break;
    }
    case 'status_change': {
      const details = payload.details as {
        status?: TaskStatus;
        outputs?: Record<string, unknown>;
        artifacts?: unknown[];
        description?: string;
        subtask_added?: TaskId;
        retryState?: unknown;
        agent_id?: AgentId | null;
      };
      const updates: Record<string, unknown> = {};

      if (details.status) {
        updates.status = details.status;
        if (details.status === 'in_progress') {
          const existing = store.getRow('tasks', taskId);
          if (!existing.started_at) {
            updates.started_at = event.timestamp;
          }
        }
      }

      if (details.outputs !== undefined) {
        updates.outputs = JSON.stringify(details.outputs);
      }

      if (details.artifacts !== undefined) {
        const existing = store.getRow('tasks', taskId);
        const currentArtifacts = existing.artifacts
          ? JSON.parse(existing.artifacts as string)
          : [];
        updates.artifacts = JSON.stringify([
          ...currentArtifacts,
          ...details.artifacts,
        ]);
      }

      if (details.description !== undefined) {
        updates.description = details.description;
      }

      if (details.subtask_added) {
        const existing = store.getRow('tasks', taskId);
        const subtasks = existing.subtasks
          ? JSON.parse(existing.subtasks as string)
          : [];
        subtasks.push(details.subtask_added);
        updates.subtasks = JSON.stringify(subtasks);
      }

      if (details.retryState !== undefined) {
        updates.retry_state = JSON.stringify(details.retryState);
      }

      // Allow clearing the assigned agent (for retry)
      if (details.agent_id === null) {
        updates.assigned_agent = '';
      }

      if (Object.keys(updates).length > 0) {
        store.setPartialRow('tasks', taskId, updates as Record<string, string | number | boolean>);
      }
      break;
    }
    case 'completed': {
      store.setPartialRow('tasks', taskId, {
        status: 'completed',
        completed_at: event.timestamp,
      });
      break;
    }
    case 'failed': {
      store.setPartialRow('tasks', taskId, {
        status: 'failed',
        completed_at: event.timestamp,
      });
      break;
    }
    case 'blocker_added': {
      const details = payload.details as { blocker_id: TaskId };
      const existing = store.getRow('tasks', taskId);
      const blockers = existing.blockers
        ? JSON.parse(existing.blockers as string)
        : [];
      if (!blockers.includes(details.blocker_id)) {
        blockers.push(details.blocker_id);
        store.setPartialRow('tasks', taskId, {
          blockers: JSON.stringify(blockers),
        });
      }
      break;
    }
    case 'blocker_removed': {
      const details = payload.details as { blocker_id: TaskId };
      const existing = store.getRow('tasks', taskId);
      const blockers = existing.blockers
        ? JSON.parse(existing.blockers as string)
        : [];
      const idx = blockers.indexOf(details.blocker_id);
      if (idx >= 0) {
        blockers.splice(idx, 1);
        store.setPartialRow('tasks', taskId, {
          blockers: JSON.stringify(blockers),
        });
      }
      break;
    }
  }

  const task = rowToTask(store.getRow('tasks', taskId));
  notify(taskId, task);
}

/**
 * Convert a TinyBase row to an Agent object
 */
function rowToAgent(row: Record<string, unknown>): Agent {
  const stopReason = row.stop_reason as string;
  return {
    id: row.id as AgentId,
    name: (row.name as string) || undefined,
    session_id: row.session_id as string,
    provider_session_id: (row.provider_session_id as string) || undefined,
    parent: (row.parent as string) || null,
    lineage: row.lineage ? JSON.parse(row.lineage as string) : [],
    state: row.state as AgentState,
    stop_reason: stopReason ? (stopReason as Agent['stop_reason']) : undefined,
    task: row.task as string,
    task_id: (row.task_id as string) || undefined,
    role: (row.role as string) || undefined,
    config: row.config ? JSON.parse(row.config as string) : {},
    cwd: (row.cwd as string) || process.cwd(),
    plan: row.plan ? JSON.parse(row.plan as string) : [],
    metadata: row.metadata ? JSON.parse(row.metadata as string) : undefined,
    created_at: row.created_at as Timestamp,
    started_at: (row.started_at as number) || undefined,
    stopped_at: (row.stopped_at as number) || undefined,
    last_activity_at: (row.last_activity_at as number) || undefined,
  };
}

/**
 * Convert a TinyBase row to a Task object
 */
function rowToTask(row: Record<string, unknown>): Task {
  return {
    id: row.id as TaskId,
    description: row.description as string,
    status: row.status as TaskStatus,
    assigned_agent: (row.assigned_agent as string) || undefined,
    parent_task: (row.parent_task as string) || undefined,
    subtasks: row.subtasks ? JSON.parse(row.subtasks as string) : undefined,
    blockers: row.blockers ? JSON.parse(row.blockers as string) : undefined,
    created_at: row.created_at as Timestamp,
    started_at: (row.started_at as number) || undefined,
    completed_at: (row.completed_at as number) || undefined,
    created_by: row.created_by as AgentId,
    inputs: row.inputs ? JSON.parse(row.inputs as string) : undefined,
    outputs: row.outputs ? JSON.parse(row.outputs as string) : undefined,
    artifacts: row.artifacts ? JSON.parse(row.artifacts as string) : undefined,
    agent_history: row.agent_history ? JSON.parse(row.agent_history as string) : undefined,
    tags: row.tags ? JSON.parse(row.tags as string) : undefined,
    retryPolicy: row.retry_policy ? JSON.parse(row.retry_policy as string) : undefined,
    retryState: row.retry_state ? JSON.parse(row.retry_state as string) : undefined,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Session Event Handlers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Apply session event to sessions view
 */
function applySessionEvent(
  store: Store,
  event: Event,
  notify: (sessionId: string, session: Session | null) => void,
): void {
  const payload = event.payload as {
    action: string;
    session_id: string;
    head_manager_id?: AgentId;
    agent_id?: AgentId;
    target_agent_id?: AgentId;
    previous_agent_id?: AgentId;
  };

  const sessionId = payload.session_id;

  switch (payload.action) {
    case 'created': {
      store.setRow('sessions', sessionId, {
        id: sessionId,
        head_manager_id: payload.head_manager_id ?? '',
        current_agent_id: payload.head_manager_id ?? '',
        state: 'active',
        created_at: event.timestamp,
        updated_at: event.timestamp,
        closed_at: 0,
      });
      break;
    }
    case 'mounted': {
      store.setPartialRow('sessions', sessionId, {
        current_agent_id: payload.target_agent_id ?? '',
        state: 'mounted',
        updated_at: event.timestamp,
      });
      break;
    }
    case 'unmounted': {
      const existing = store.getRow('sessions', sessionId);
      store.setPartialRow('sessions', sessionId, {
        current_agent_id: existing.head_manager_id as string,
        state: 'active',
        updated_at: event.timestamp,
      });
      break;
    }
    case 'closed': {
      store.setPartialRow('sessions', sessionId, {
        state: 'closed',
        updated_at: event.timestamp,
        closed_at: event.timestamp,
      });
      break;
    }
  }

  const session = rowToSession(store.getRow('sessions', sessionId));
  notify(sessionId, session);
}

/**
 * Convert a TinyBase row to a Session object
 */
function rowToSession(row: Record<string, unknown>): Session {
  return {
    id: row.id as string,
    head_manager_id: row.head_manager_id as AgentId,
    current_agent_id: row.current_agent_id as AgentId,
    state: row.state as SessionState,
    created_at: row.created_at as Timestamp,
    updated_at: row.updated_at as Timestamp,
    closed_at: (row.closed_at as number) || undefined,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Conversation Event Handlers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Apply conversation event to conversations view
 */
function applyConversationEvent(
  store: Store,
  event: Event,
  notify: (conversationId: string, conversation: Conversation | null) => void,
): void {
  const payload = event.payload;
  const conversationId = payload.conversation_id as string;

  switch (payload.action) {
    case 'created': {
      store.setRow('conversations', conversationId, {
        id: conversationId,
        type: payload.conversation_type as string,
        status: 'active',
        subject: (payload.subject as string) ?? '',
        parent_conversation_id: (payload.parent_conversation_id as string) ?? '',
        created_by: event.source.agent_id ?? 'unknown',
        created_at: event.timestamp,
        updated_at: event.timestamp,
        closed_at: 0,
        closed_by: '',
        close_reason: '',
        participant_count: 0,
        metadata: payload.metadata ? JSON.stringify(payload.metadata) : '',
      });
      break;
    }
    case 'closed': {
      const closeReason = (payload.close_reason as string) ?? '';
      // Map close_reason to valid ConversationStatus
      const validStatuses = new Set(['completed', 'failed', 'archived']);
      const closedStatus = validStatuses.has(closeReason) ? closeReason : 'completed';
      store.setPartialRow('conversations', conversationId, {
        status: closedStatus,
        closed_at: event.timestamp,
        updated_at: event.timestamp,
        closed_by: (payload.closed_by as string) ?? event.source.agent_id ?? '',
        close_reason: closeReason,
      });
      break;
    }
    case 'participant_joined': {
      const participantId = payload.participant_id as string;
      const partId = `${conversationId}:${participantId}`;
      store.setRow('participants', partId, {
        id: participantId,
        conversation_id: conversationId,
        type: (payload.participant_type as string) ?? 'agent',
        role: (payload.participant_role as string) ?? 'worker',
        joined_at: event.timestamp,
        left_at: 0,
        agent_id: (payload.agent_id as string) ?? '',
      });
      // Increment participant count
      const existing = store.getRow('conversations', conversationId);
      if (existing.id) {
        const count = (existing.participant_count as number) || 0;
        store.setPartialRow('conversations', conversationId, {
          participant_count: count + 1,
          updated_at: event.timestamp,
        });
      }
      break;
    }
    case 'participant_left': {
      const leftParticipantId = payload.participant_id as string;
      const partId = `${conversationId}:${leftParticipantId}`;
      store.setPartialRow('participants', partId, {
        left_at: event.timestamp,
      });
      // Decrement participant count
      const existing = store.getRow('conversations', conversationId);
      if (existing.id) {
        const count = (existing.participant_count as number) || 0;
        store.setPartialRow('conversations', conversationId, {
          participant_count: Math.max(0, count - 1),
          updated_at: event.timestamp,
        });
      }
      break;
    }
  }

  const conversation = rowToConversation(store.getRow('conversations', conversationId));
  notify(conversationId, conversation);
}

/**
 * Apply turn event to turns view
 */
function applyTurnEvent(
  store: Store,
  event: Event,
  notify: (conversationId: string, turn: ConversationTurn) => void,
): void {
  const payload = event.payload;

  if (payload.action !== 'recorded') return;

  const turnId = payload.turn_id as string;
  const conversationId = payload.conversation_id as string;
  const content = payload.content;

  store.setRow('turns', turnId, {
    id: turnId,
    conversation_id: conversationId,
    participant: (payload.participant as string) ?? event.source.agent_id ?? '',
    timestamp: event.timestamp,
    content_type: (payload.content_type as string) ?? 'text',
    content: typeof content === 'string' ? content : JSON.stringify(content),
    thread_id: (payload.thread_id as string) ?? '',
    in_reply_to: (payload.in_reply_to as string) ?? '',
    source_type: (payload.source_type as string) ?? 'explicit',
    source_message_id: (payload.source_message_id as string) ?? '',
    metadata: payload.metadata ? JSON.stringify(payload.metadata) : '',
  });

  // Update conversation's updatedAt
  const convRow = store.getRow('conversations', conversationId);
  if (convRow.id) {
    store.setPartialRow('conversations', conversationId, {
      updated_at: event.timestamp,
    });
  }

  const turn = rowToTurn(store.getRow('turns', turnId));
  notify(conversationId, turn);
}

/**
 * Apply thread event to threads view
 */
function applyThreadEvent(
  store: Store,
  event: Event,
): void {
  const payload = event.payload;

  if (payload.action !== 'created') return;

  const threadId = payload.thread_id as string;
  store.setRow('threads', threadId, {
    id: threadId,
    conversation_id: (payload.conversation_id as string) ?? '',
    root_turn_id: (payload.root_turn_id as string) ?? '',
    subject: (payload.subject as string) ?? '',
    parent_thread_id: (payload.parent_thread_id as string) ?? '',
    created_by: event.source.agent_id ?? 'unknown',
    created_at: event.timestamp,
    turn_count: 0,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Conversation Row Conversion Functions
// ─────────────────────────────────────────────────────────────────────────────

function rowToConversation(row: Record<string, unknown>): Conversation {
  return {
    id: row.id as string,
    type: row.type as ConversationType,
    status: row.status as ConversationStatus,
    subject: (row.subject as string) || undefined,
    parentConversationId: (row.parent_conversation_id as string) || undefined,
    createdBy: row.created_by as string,
    createdAt: row.created_at as Timestamp,
    updatedAt: row.updated_at as Timestamp,
    closedAt: (row.closed_at as number) || undefined,
    closedBy: (row.closed_by as string) || undefined,
    closeReason: (row.close_reason as string) || undefined,
    participantCount: (row.participant_count as number) || 0,
    metadata: row.metadata ? JSON.parse(row.metadata as string) : undefined,
  };
}

function rowToTurn(row: Record<string, unknown>): ConversationTurn {
  const rawContent = row.content as string;
  let content: unknown;
  try {
    content = JSON.parse(rawContent);
  } catch {
    content = rawContent;
  }

  return {
    id: row.id as string,
    conversationId: row.conversation_id as string,
    participant: row.participant as string,
    timestamp: row.timestamp as Timestamp,
    contentType: row.content_type as string,
    content,
    threadId: (row.thread_id as string) || undefined,
    inReplyTo: (row.in_reply_to as string) || undefined,
    sourceType: (row.source_type as string) as ConversationTurn['sourceType'],
    sourceMessageId: (row.source_message_id as string) || undefined,
    metadata: row.metadata ? JSON.parse(row.metadata as string) : undefined,
  };
}

function rowToParticipant(row: Record<string, unknown>): ConversationParticipant {
  return {
    id: row.id as string,
    conversationId: row.conversation_id as string,
    type: row.type as ConversationParticipant['type'],
    role: row.role as ConversationParticipant['role'],
    joinedAt: row.joined_at as Timestamp,
    leftAt: (row.left_at as number) || undefined,
    agentId: (row.agent_id as string) || undefined,
  };
}
