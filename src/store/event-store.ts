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
import { createFilePersister } from 'tinybase/persisters/persister-file';
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
  Task,
  TaskStatus,
  QueuedMessage,
  Subscription,
  SubscriptionType,
  StoreConfig,
  AgentId,
  TaskId,
  EventId,
  Timestamp,
} from './types/index.js';
import { CURRENT_EVENT_VERSION } from './types/events.js';
import { migrateEvent } from './migrations.js';

// View change callback types
export type AgentChangeCallback = (agentId: AgentId, agent: Agent | null) => void;
export type TaskChangeCallback = (taskId: TaskId, task: Task | null) => void;
export type MessageCallback = (agentId: AgentId, messages: QueuedMessage[]) => void;

// Unsubscribe function type
export type Unsubscribe = () => void;

/**
 * Event Store interface
 */
export interface EventStore {
  // Event operations
  emit(event: EventInput): Event;
  query(filter?: EventFilter): Event[];

  // Agent view
  getAgent(agentId: AgentId): Agent | null;
  listAgents(filter?: { state?: AgentState; parent?: AgentId | null }): Agent[];

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

  // Reactive updates
  onAgentChange(callback: AgentChangeCallback): Unsubscribe;
  onAgentChange(agentId: AgentId, callback: AgentChangeCallback): Unsubscribe;
  onTaskChange(callback: TaskChangeCallback): Unsubscribe;
  onMessageChange(agentId: AgentId, callback: MessageCallback): Unsubscribe;

  // Lifecycle
  persist(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Create an Event Store instance
 */
export async function createEventStore(config: StoreConfig = {}): Promise<EventStore> {
  const store = createStore();

  // Determine storage path
  const storagePath = config.path ?? path.join(os.homedir(), '.multiagent', 'store.json');

  // Ensure directory exists
  if (!config.inMemory) {
    const dir = path.dirname(storagePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  // Set up persister for file-based storage
  let persister: ReturnType<typeof createFilePersister> | null = null;
  if (!config.inMemory) {
    persister = createFilePersister(store, storagePath);
    await persister.load();
  }

  // Initialize tables if they don't exist
  initializeTables(store);

  // Rebuild materialized views from events
  rebuildViews(store);

  // Listener registries
  const agentListeners = new Set<AgentChangeCallback>();
  const agentIdListeners = new Map<AgentId, Set<AgentChangeCallback>>();
  const taskListeners = new Set<TaskChangeCallback>();
  const messageListeners = new Map<AgentId, Set<MessageCallback>>();

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
    applyEventToViews(store, event, notifyAgentChange, notifyTaskChange, notifyMessageChange);

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
   * Persist store to disk
   */
  async function persist(): Promise<void> {
    if (persister) {
      await persister.save();
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
  }

  return {
    emit,
    query,
    getAgent,
    listAgents,
    getTask,
    listTasks,
    getMessages,
    getFullMessage,
    addSubscription,
    removeSubscription,
    getSubscriptions,
    getSubscribers,
    onAgentChange,
    onTaskChange,
    onMessageChange,
    persist,
    close,
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
}

/**
 * Rebuild materialized views from the event log
 */
function rebuildViews(store: Store): void {
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
    applyEventToViews(store, event, noop, noop, noop);
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
    config?: Record<string, unknown>;
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
    session_id: payload.session_id,
    parent: parent ?? '',
    lineage: JSON.stringify(lineage),
    state: 'spawning',
    stop_reason: '',
    task: payload.task,
    task_id: payload.task_id ?? '',
    config: JSON.stringify(payload.config ?? {}),
    created_at: event.timestamp,
    started_at: 0,
    stopped_at: 0,
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

  const payload = event.payload as { status_type: string };

  if (payload.status_type === 'started') {
    store.setPartialRow('agents', agentId, {
      state: 'running',
      started_at: event.timestamp,
    });

    const agent = rowToAgent(store.getRow('agents', agentId));
    notify(agentId, agent);
  }
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

  const payload = event.payload as { content: string; correlation_id?: string };
  const content = payload.content;

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
      };
      store.setRow('tasks', taskId, {
        id: taskId,
        description: details.description,
        status: 'pending',
        assigned_agent: '',
        parent_task: details.parent_task ?? '',
        subtasks: JSON.stringify([]),
        created_at: event.timestamp,
        started_at: 0,
        completed_at: 0,
        created_by: event.source.agent_id ?? '',
        inputs: JSON.stringify(details.inputs ?? {}),
        outputs: JSON.stringify({}),
        artifacts: JSON.stringify([]),
        agent_history: JSON.stringify([]),
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
      store.setPartialRow('tasks', taskId, {
        assigned_agent: '',
        agent_history: JSON.stringify(history),
      });
      break;
    }
    case 'status_change': {
      const details = payload.details as {
        status?: TaskStatus;
        outputs?: Record<string, unknown>;
        artifacts?: unknown[];
        description?: string;
        subtask_added?: TaskId;
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
    session_id: row.session_id as string,
    parent: (row.parent as string) || null,
    lineage: row.lineage ? JSON.parse(row.lineage as string) : [],
    state: row.state as AgentState,
    stop_reason: stopReason ? (stopReason as Agent['stop_reason']) : undefined,
    task: row.task as string,
    task_id: (row.task_id as string) || undefined,
    config: row.config ? JSON.parse(row.config as string) : {},
    created_at: row.created_at as Timestamp,
    started_at: (row.started_at as number) || undefined,
    stopped_at: (row.stopped_at as number) || undefined,
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
    created_at: row.created_at as Timestamp,
    started_at: (row.started_at as number) || undefined,
    completed_at: (row.completed_at as number) || undefined,
    created_by: row.created_by as AgentId,
    inputs: row.inputs ? JSON.parse(row.inputs as string) : undefined,
    outputs: row.outputs ? JSON.parse(row.outputs as string) : undefined,
    artifacts: row.artifacts ? JSON.parse(row.artifacts as string) : undefined,
    agent_history: row.agent_history ? JSON.parse(row.agent_history as string) : undefined,
  };
}
