/**
 * AgentManager - Interface and types for managing agent lifecycle and sessions
 *
 * The V1 implementation has been removed. The V2 implementation lives in
 * agent-manager-v2.ts and is wired via boot-v2.ts.
 *
 * This file retains:
 * - The AgentManager interface (used everywhere)
 * - The AgentManagerConfig interface
 * - The SpawnInterceptor type
 * - A re-export of createAgentManagerV2 as createAgentManager for backward compat
 */

import type { PermissionMode } from "acp-factory";
import type { ExtendedSessionUpdate, Session } from "acp-factory";
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
  ContinueAgentOptions,
} from "./types.js";
import type { RoleRegistry } from "../roles/types.js";
import type { WorkspaceManager } from "../workspace/types.js";

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
   * @param permissionMode - Optional permission mode override (defaults to the agent manager's default)
   */
  resume(
    agentId: AgentId,
    permissionMode?: PermissionMode,
  ): Promise<SpawnedAgent>;

  /**
   * Continue a terminated agent by spawning a new agent with the same
   * role and task, injecting the prior conversation context as a
   * resume prefix in the system prompt.
   *
   * @param agentId - ID of the agent to continue
   * @param options - Continuation options
   * @returns The newly spawned continuation agent
   */
  continueAgent(
    agentId: AgentId,
    options?: ContinueAgentOptions,
  ): Promise<SpawnedAgent>;

  /**
   * Fork an agent's session, creating a new agent with the same
   * conversation history. Uses forkWithFlush for active sessions
   * or loadSession for stopped agents with persisted sessions.
   *
   * @param sourceAgentId - ID of the agent to fork from
   * @param options - Fork options (name, prompt, cwd)
   */
  forkAgent(
    sourceAgentId: AgentId,
    options?: { name?: string; prompt?: string; cwd?: string },
  ): Promise<SpawnedAgent>;

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
  getHierarchy(
    agentId: AgentId,
    options?: HierarchyOptions,
  ): AgentHierarchy | null;

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
    message: string,
  ): AsyncIterable<ExtendedSessionUpdate>;

  /**
   * Send a prompt to an agent and automatically follow up to ensure done() is called.
   * Returns when the agent calls done() or after maxFollowUps attempts.
   *
   * @param agentId - Agent ID to prompt
   * @param message - Initial prompt message
   * @param options - Follow-up options
   * @returns Result indicating whether done() was called
   */
  promptUntilDone(
    agentId: AgentId,
    message: string,
    options?: {
      /** Maximum number of follow-up prompts (default: 2) */
      maxFollowUps?: number;
      /** Callback for each update during prompting */
      onUpdate?: (update: ExtendedSessionUpdate) => void;
    },
  ): Promise<{
    doneCalled: boolean;
    doneStatus?: string;
    updates: ExtendedSessionUpdate[];
  }>;

  /**
   * Get the active session for an agent.
   */
  getSession(agentId: AgentId): Session | null;

  /**
   * Check if an agent has an active session.
   */
  hasActiveSession(agentId: AgentId): boolean;

  /**
   * Check if an agent is currently processing a prompt.
   * Returns false if no session or session is idle.
   */
  isPrompting(agentId: AgentId): boolean;

  /**
   * Check if an agent's session supports context injection.
   * Returns false if no session or injection not supported.
   */
  supportsInjection(agentId: AgentId): Promise<boolean>;

  /**
   * Check if an agent's underlying process is still running.
   * Returns false if no session or process has exited.
   */
  isProcessRunning(agentId: AgentId): boolean;

  // ── Permission Handling ─────────────────────────────────────────

  /**
   * Respond to a permission request for an agent's session.
   * Used when running in interactive permission mode.
   *
   * @param agentId - Agent ID whose session has the pending permission
   * @param requestId - The permission request ID
   * @param optionId - The selected option ID (e.g., 'allow_once')
   * @returns true if permission was found and responded to
   */
  respondToPermission(
    agentId: AgentId,
    requestId: string,
    optionId: string,
  ): boolean;

  /**
   * Cancel a permission request for an agent's session.
   *
   * @param agentId - Agent ID whose session has the pending permission
   * @param requestId - The permission request ID
   * @returns true if permission was found and cancelled
   */
  cancelPermission(agentId: AgentId, requestId: string): boolean;

  /**
   * Change the permission mode for a running agent at runtime.
   * Takes effect on the next permission request.
   *
   * @param agentId - Agent ID to change permission mode for
   * @param mode - New permission mode
   * @returns true if the mode was changed successfully
   */
  setPermissionMode(agentId: AgentId, mode: PermissionMode): boolean;

  /**
   * Get the current permission mode for a running agent.
   *
   * @param agentId - Agent ID to query
   * @returns The current permission mode, or null if no active session
   */
  getPermissionMode(agentId: AgentId): PermissionMode | null;

  // ── Lifecycle Callbacks ────────────────────────────────────────

  /**
   * Register a callback for agent lifecycle events.
   */
  onLifecycleEvent(callback: AgentLifecycleCallback): () => void;

  // ── Team Integration ─────────────────────────────────────────

  /**
   * Set a spawn interceptor that transforms SpawnAgentOptions before spawning.
   * Used by TeamRuntime to inject team topics, prompts, MCP servers, and env vars.
   */
  setSpawnInterceptor(interceptor: SpawnInterceptor | null): void;

  /**
   * Get the RoleRegistry used by this AgentManager.
   */
  getRoleRegistry(): RoleRegistry;

  // ── OpenTasks Socket Path (Late Binding) ─────────────────────

  /**
   * Set the runtime OpenTasks socket path for propagation to child agents.
   * Used when createTaskBackend() discovers the daemon socket path after
   * AgentManager is already created.
   */
  setOpenTasksSocketPath(socketPath: string): void;

  /**
   * Set the MAP server URL for propagation to child agents via SWARM_MAP_SERVER.
   * When set, spawned agents with cc-swarm hooks will connect to macro-agent's
   * local MAP server instead of directly to an external hub.
   */
  setMapServerUrl(url: string): void;

  /**
   * Configure swarmkit integrations (minimem, skill-tree, sessionlog).
   * Called by boot-v2 after system initialization.
   */
  setIntegrationConfigs(configs: {
    minimem?: { enabled: boolean; dir?: string; provider?: string; global?: boolean };
    skilltree?: { enabled: boolean; basePath?: string; defaultProfile?: string };
    sessionlog?: { enabled: boolean; sync?: string };
  }): void;

  /**
   * Set a compiled skill-tree loadout for a role.
   * Called by TeamRuntime during team bootstrap.
   */
  setSkillLoadout(role: string, content: string): void;

  /**
   * Set the MAP sidecar reference for trajectory reporting.
   * Called by boot-v2 after the sidecar is created.
   * Enables session-end checkpoint emission on terminate.
   */
  setSidecar(sidecar: { connected: boolean; reportCheckpoint(cp: any): Promise<any> } | null): void;

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

  /**
   * Optional WorkspaceManager for workspace isolation.
   * When provided, agents with workspace-enabled roles will get
   * isolated git worktrees.
   */
  workspaceManager?: WorkspaceManager;

  /**
   * Optional RoleRegistry for capability enforcement.
   * When provided, spawn operations will check if the parent agent
   * has the required capability to spawn the requested child role.
   * Defaults to DefaultRoleRegistry if not provided.
   */
  roleRegistry?: RoleRegistry;

  /**
   * Optional server URL for MCP thin-client mode.
   * When set, spawned agents use ephemeral MAP WebSocket calls instead
   * of creating local service stacks.
   */
  serverUrl?: string;

  /**
   * Server authentication token for MCP thin-client connections.
   * Passed to spawned agents as MACRO_SERVER_TOKEN env var.
   */
  serverToken?: string;

  /**
   * OpenTasks socket path to propagate to child MCP subprocesses.
   * Sourced from merged config. Falls back to OPENTASKS_SOCKET_PATH env var.
   */
  openTasksSocketPath?: string;
}

// ─────────────────────────────────────────────────────────────────
// Spawn Interceptor
// ─────────────────────────────────────────────────────────────────

/**
 * Function that transforms SpawnAgentOptions before an agent is spawned.
 * Used by TeamRuntime to inject team-specific configuration.
 */
export type SpawnInterceptor = (
  options: SpawnAgentOptions,
) => SpawnAgentOptions | Promise<SpawnAgentOptions>;

// ─────────────────────────────────────────────────────────────────
// Re-export V2 implementation as createAgentManager for backward compat
// ─────────────────────────────────────────────────────────────────

export { createAgentManagerV2, createAgentManagerV2 as createAgentManager } from "./agent-manager-v2.js";
