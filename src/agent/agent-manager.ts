/**
 * AgentManager - Service for managing agent lifecycle and sessions
 *
 * Integrates:
 * - acp-factory for Claude Code process/session management
 * - EventStore for persistent agent state
 * - MessageRouter for subscription setup
 */

import { nanoid } from "nanoid";
import {
  AgentFactory,
  type Session,
  type AgentHandle,
  type ExtendedSessionUpdate,
  type PermissionMode,
} from "acp-factory";
import type { EventStore } from "../store/event-store.js";
import type { MessageRouter } from "../router/message-router.js";
import type {
  Agent,
  AgentId,
  TaskId,
  AgentState,
} from "../store/types/index.js";
import type {
  SpawnAgentOptions,
  SpawnedAgent,
  AgentFilter,
  AgentHierarchy,
  AgentHierarchyNode,
  HierarchyOptions,
  ActiveSession,
  AgentStopReason,
  HeadManagerOptions,
  SystemPromptContext,
  AgentLifecycleCallback,
  AgentConfig,
} from "./types.js";
import { AgentManagerError } from "./types.js";
import { generateSystemPrompt } from "./system-prompt.js";

// ─────────────────────────────────────────────────────────────────
// AgentManager Interface
// ─────────────────────────────────────────────────────────────────

export interface AgentManager {
  // ── Lifecycle ──────────────────────────────────────────────────

  /**
   * Spawn a new agent with the given options.
   * Creates the acp-factory session and emits spawn event.
   */
  spawn(options: SpawnAgentOptions): Promise<SpawnedAgent>;

  /**
   * Terminate an agent and clean up its session.
   * Emits terminate event and updates task status if assigned.
   */
  terminate(agentId: AgentId, reason: AgentStopReason): Promise<void>;

  /**
   * Resume a stopped agent by loading its existing session.
   */
  resume(agentId: AgentId): Promise<SpawnedAgent>;

  // ── Queries ────────────────────────────────────────────────────

  /**
   * Get agent by ID from materialized view.
   */
  get(agentId: AgentId): Agent | null;

  /**
   * List agents with optional filters.
   */
  list(filter?: AgentFilter): Agent[];

  /**
   * Get direct children of an agent.
   */
  getChildren(agentId: AgentId): Agent[];

  /**
   * Get full hierarchy tree starting from an agent.
   * @param options.depth - Maximum depth to traverse (undefined = full tree)
   */
  getHierarchy(agentId: AgentId, options?: HierarchyOptions): AgentHierarchy | null;

  // ── Head Manager ───────────────────────────────────────────────

  /**
   * Get or create a head manager for the given workspace.
   * Head managers are root agents with no parent.
   */
  getOrCreateHeadManager(options: HeadManagerOptions): Promise<SpawnedAgent>;

  /**
   * List all head managers.
   */
  listHeadManagers(): Agent[];

  // ── Session Interaction ────────────────────────────────────────

  /**
   * Send a prompt to an agent and stream responses.
   */
  prompt(
    agentId: AgentId,
    message: string
  ): AsyncIterable<ExtendedSessionUpdate>;

  /**
   * Get the active session for an agent.
   */
  getSession(agentId: AgentId): Session | null;

  /**
   * Check if an agent has an active session.
   */
  hasActiveSession(agentId: AgentId): boolean;

  // ── Lifecycle Callbacks ────────────────────────────────────────

  /**
   * Register a callback for agent lifecycle events.
   */
  onLifecycleEvent(callback: AgentLifecycleCallback): () => void;

  // ── Cleanup ────────────────────────────────────────────────────

  /**
   * Close all active sessions and clean up resources.
   */
  close(): Promise<void>;
}

// ─────────────────────────────────────────────────────────────────
// AgentManager Configuration
// ─────────────────────────────────────────────────────────────────

export interface AgentManagerConfig {
  /** Default permission mode for spawned agents */
  defaultPermissionMode?: PermissionMode;

  /** Default agent type (defaults to "claude-code") */
  defaultAgentType?: string;

  /** Default working directory */
  defaultCwd?: string;
}

// ─────────────────────────────────────────────────────────────────
// AgentManager Implementation
// ─────────────────────────────────────────────────────────────────

export function createAgentManager(
  eventStore: EventStore,
  messageRouter: MessageRouter,
  config: AgentManagerConfig = {}
): AgentManager {
  const {
    defaultPermissionMode = "auto-approve",
    defaultAgentType = "claude-code",
    defaultCwd = process.cwd(),
  } = config;

  // Active sessions tracked in memory
  const activeSessions = new Map<AgentId, ActiveSession>();

  // Lifecycle event listeners
  const lifecycleListeners = new Set<AgentLifecycleCallback>();

  // ─────────────────────────────────────────────────────────────────
  // Lifecycle
  // ─────────────────────────────────────────────────────────────────

  async function spawn(options: SpawnAgentOptions): Promise<SpawnedAgent> {
    const {
      task,
      task_id,
      parent,
      cwd = defaultCwd,
      permissionMode = defaultPermissionMode,
      subscribeParent = true,
      topics = [],
      config: agentConfig,
      agentType = defaultAgentType,
    } = options;

    // Generate IDs
    const agentId = `agent_${nanoid(12)}`;
    const taskId = task_id ?? `task_${nanoid(12)}`;

    // Validate parent exists if specified
    if (parent) {
      const parentAgent = eventStore.getAgent(parent);
      if (!parentAgent) {
        throw new AgentManagerError(
          `Parent agent not found: ${parent}`,
          "AGENT_NOT_FOUND",
          parent
        );
      }
    }

    // Build system prompt context
    const parentAgent = parent ? eventStore.getAgent(parent) : null;
    const promptContext: SystemPromptContext = {
      agentId,
      task,
      taskId,
      parentId: parent ?? null,
      isHeadManager: !parent,
      lineage: parentAgent?.lineage ? [...parentAgent.lineage, parent!] : [],
      mcpTools: [
        "spawn_agent",
        "emit_status",
        "send_message",
        "check_messages",
        "get_hierarchy",
        "get_agent_summary",
        "stop_agent",
        "create_task",
        "get_task",
      ],
    };

    const systemPrompt = generateSystemPrompt(promptContext);

    try {
      // Spawn agent process via acp-factory
      const handle = await AgentFactory.spawn(agentType, {
        permissionMode,
        env: agentConfig?.env,
      });

      // Create session
      const session = await handle.createSession(cwd, {
        mcpServers: agentConfig?.mcpServers?.map((s) => ({
          type: "stdio" as const,
          name: s.name,
          command: s.command,
          args: s.args ?? [],
          env: s.env
            ? Object.entries(s.env).map(([name, value]) => ({ name, value }))
            : [],
        })),
      });

      // Emit spawn event to EventStore
      eventStore.emit({
        type: "spawn",
        source: { agent_id: parent ?? "system" },
        payload: {
          agent_id: agentId,
          session_id: session.id,
          task,
          task_id: taskId,
          parent: parent ?? null,
          config: agentConfig ?? {},
        },
      });

      // Emit started status (session is ready)
      eventStore.emit({
        type: "status",
        source: { agent_id: agentId },
        payload: {
          status_type: "started",
          summary: "Agent session started",
        },
      });

      // Set up default subscriptions via MessageRouter
      messageRouter.setupDefaultSubscriptions({
        agent_id: agentId,
        parent_id: parent ?? undefined,
        task_id: taskId,
        subscribe_parent: subscribeParent,
        additional_topics: topics,
      });

      // Track active session
      const activeSession: ActiveSession = {
        agentId,
        handle,
        session,
        createdAt: Date.now(),
        isPrompting: false,
      };
      activeSessions.set(agentId, activeSession);

      // Get the agent from materialized view
      const agent = eventStore.getAgent(agentId)!;

      // Notify lifecycle listeners
      notifyLifecycle({ type: "spawned", agent });
      notifyLifecycle({ type: "started", agent });

      return {
        id: agentId,
        session_id: session.id,
        agent,
        session,
      };
    } catch (error) {
      throw new AgentManagerError(
        `Failed to spawn agent: ${error}`,
        "SPAWN_FAILED",
        agentId
      );
    }
  }

  async function terminate(
    agentId: AgentId,
    reason: AgentStopReason
  ): Promise<void> {
    const agent = eventStore.getAgent(agentId);
    if (!agent) {
      throw new AgentManagerError(
        `Agent not found: ${agentId}`,
        "AGENT_NOT_FOUND",
        agentId
      );
    }

    // Close active session if exists
    const activeSession = activeSessions.get(agentId);
    if (activeSession) {
      try {
        await activeSession.handle.close();
      } catch {
        // Ignore errors during cleanup
      }
      activeSessions.delete(agentId);
    }

    // Emit terminate event
    eventStore.emit({
      type: "terminate",
      source: { agent_id: agentId },
      payload: {
        reason,
      },
    });

    // If agent had a task, update task status based on reason
    if (agent.task_id) {
      const taskStatus =
        reason === "completed"
          ? "completed"
          : reason === "failed"
          ? "failed"
          : "pending";

      eventStore.emit({
        type: "task",
        source: { agent_id: agentId },
        payload: {
          task_id: agent.task_id,
          action: reason === "completed" ? "completed" : "status_change",
          details: { status: taskStatus },
        },
      });
    }

    // Notify lifecycle listeners
    const updatedAgent = eventStore.getAgent(agentId)!;
    notifyLifecycle({ type: "stopped", agent: updatedAgent, reason });

    // Terminate child agents if parent stopped
    if (reason !== "parent_stopped") {
      const children = getChildren(agentId);
      for (const child of children) {
        if (child.state === "running" || child.state === "spawning") {
          await terminate(child.id, "parent_stopped");
        }
      }
    }
  }

  async function resume(agentId: AgentId): Promise<SpawnedAgent> {
    const agent = eventStore.getAgent(agentId);
    if (!agent) {
      throw new AgentManagerError(
        `Agent not found: ${agentId}`,
        "AGENT_NOT_FOUND",
        agentId
      );
    }

    // Check if already running
    if (activeSessions.has(agentId)) {
      throw new AgentManagerError(
        `Agent already has active session: ${agentId}`,
        "ALREADY_RUNNING",
        agentId
      );
    }

    // Spawn new process and load existing session
    const handle = await AgentFactory.spawn(defaultAgentType, {
      permissionMode: defaultPermissionMode,
    });

    // Load the existing session by ID
    const session = await handle.loadSession(agent.session_id, defaultCwd);

    // Track active session
    const activeSession: ActiveSession = {
      agentId,
      handle,
      session,
      createdAt: Date.now(),
      isPrompting: false,
    };
    activeSessions.set(agentId, activeSession);

    // Emit status event for resume
    eventStore.emit({
      type: "status",
      source: { agent_id: agentId },
      payload: {
        status_type: "started",
        summary: "Agent session resumed",
      },
    });

    return {
      id: agentId,
      session_id: session.id,
      agent: eventStore.getAgent(agentId)!,
      session,
    };
  }

  // ─────────────────────────────────────────────────────────────────
  // Queries
  // ─────────────────────────────────────────────────────────────────

  function get(agentId: AgentId): Agent | null {
    return eventStore.getAgent(agentId);
  }

  function list(filter?: AgentFilter): Agent[] {
    let agents = eventStore.listAgents();

    if (filter) {
      if (filter.state) {
        agents = agents.filter((a) => a.state === filter.state);
      }
      if (filter.parent !== undefined) {
        agents = agents.filter((a) => a.parent === filter.parent);
      }
      if (filter.task_id) {
        agents = agents.filter((a) => a.task_id === filter.task_id);
      }
      if (filter.headManagersOnly) {
        agents = agents.filter((a) => a.parent === null);
      }
    }

    return agents;
  }

  function getChildren(agentId: AgentId): Agent[] {
    return eventStore.listAgents({ parent: agentId });
  }

  function getHierarchy(
    agentId: AgentId,
    options?: HierarchyOptions
  ): AgentHierarchy | null {
    const agent = eventStore.getAgent(agentId);
    if (!agent) return null;

    const maxDepth = options?.depth;

    function buildNode(a: Agent, currentDepth: number): AgentHierarchyNode {
      const shouldIncludeChildren =
        maxDepth === undefined || currentDepth < maxDepth;
      const children = shouldIncludeChildren ? getChildren(a.id) : [];
      return {
        agent: a,
        children: children.map((c) => buildNode(c, currentDepth + 1)),
      };
    }

    const root = buildNode(agent, 1);

    // Calculate depth and total agents
    function calcDepth(node: AgentHierarchyNode): number {
      if (node.children.length === 0) return 1;
      return 1 + Math.max(...node.children.map(calcDepth));
    }

    function countAgents(node: AgentHierarchyNode): number {
      return 1 + node.children.reduce((sum, c) => sum + countAgents(c), 0);
    }

    return {
      root,
      depth: calcDepth(root),
      totalAgents: countAgents(root),
    };
  }

  // ─────────────────────────────────────────────────────────────────
  // Head Manager
  // ─────────────────────────────────────────────────────────────────

  async function getOrCreateHeadManager(
    options: HeadManagerOptions
  ): Promise<SpawnedAgent> {
    const {
      cwd,
      systemPrompt,
      permissionMode,
      topics = [],
      sessionId,
      forceNew = false,
    } = options;

    // If not forcing new, attempt to resume an existing session
    if (!forceNew) {
      const headManagers = listHeadManagers()
        .filter((h) => h.state === "running")
        .sort((a, b) => {
          // Sort by started_at descending, then by created_at descending as tiebreaker
          const startDiff = (b.started_at ?? 0) - (a.started_at ?? 0);
          if (startDiff !== 0) return startDiff;
          return b.created_at - a.created_at;
        });

      if (sessionId) {
        // Resume specific session by ID
        const specific = headManagers.find((h) => h.session_id === sessionId);
        if (specific && activeSessions.has(specific.id)) {
          const activeSession = activeSessions.get(specific.id)!;
          return {
            id: specific.id,
            session_id: specific.session_id,
            agent: specific,
            session: activeSession.session,
          };
        }
      } else if (headManagers.length > 0) {
        // Resume latest running session with active session
        const latest = headManagers[0];
        if (activeSessions.has(latest.id)) {
          const activeSession = activeSessions.get(latest.id)!;
          return {
            id: latest.id,
            session_id: latest.session_id,
            agent: latest,
            session: activeSession.session,
          };
        }
      }
    }

    // No existing session found or forceNew requested - create new
    return spawn({
      task:
        systemPrompt ??
        "You are a head manager agent. Coordinate tasks and spawn child agents as needed.",
      parent: null,
      cwd,
      permissionMode,
      topics,
      subscribeParent: false,
    });
  }

  function listHeadManagers(): Agent[] {
    return list({ headManagersOnly: true });
  }

  // ─────────────────────────────────────────────────────────────────
  // Session Interaction
  // ─────────────────────────────────────────────────────────────────

  async function* prompt(
    agentId: AgentId,
    message: string
  ): AsyncIterable<ExtendedSessionUpdate> {
    const activeSession = activeSessions.get(agentId);
    if (!activeSession) {
      throw new AgentManagerError(
        `No active session for agent: ${agentId}`,
        "SESSION_NOT_FOUND",
        agentId
      );
    }

    activeSession.isPrompting = true;

    try {
      for await (const update of activeSession.session.prompt(message)) {
        yield update;
      }
    } finally {
      activeSession.isPrompting = false;
    }
  }

  function getSession(agentId: AgentId): Session | null {
    const activeSession = activeSessions.get(agentId);
    return activeSession?.session ?? null;
  }

  function hasActiveSession(agentId: AgentId): boolean {
    return activeSessions.has(agentId);
  }

  // ─────────────────────────────────────────────────────────────────
  // Lifecycle Callbacks
  // ─────────────────────────────────────────────────────────────────

  function onLifecycleEvent(callback: AgentLifecycleCallback): () => void {
    lifecycleListeners.add(callback);
    return () => lifecycleListeners.delete(callback);
  }

  function notifyLifecycle(event: Parameters<AgentLifecycleCallback>[0]): void {
    for (const listener of lifecycleListeners) {
      try {
        listener(event);
      } catch {
        // Ignore listener errors
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // Cleanup
  // ─────────────────────────────────────────────────────────────────

  async function close(): Promise<void> {
    // Close all active sessions
    const closePromises: Promise<void>[] = [];
    for (const [agentId, session] of activeSessions) {
      closePromises.push(
        (async () => {
          try {
            await session.handle.close();
          } catch {
            // Ignore errors during cleanup
          }
        })()
      );
    }

    await Promise.all(closePromises);
    activeSessions.clear();
    lifecycleListeners.clear();
  }

  return {
    spawn,
    terminate,
    resume,
    get,
    list,
    getChildren,
    getHierarchy,
    getOrCreateHeadManager,
    listHeadManagers,
    prompt,
    getSession,
    hasActiveSession,
    onLifecycleEvent,
    close,
  };
}
