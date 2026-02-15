/**
 * Capability Constants and Tool Mappings
 *
 * Defines all available capabilities and their mapping to MCP tools.
 */

import type { Capability, CapabilityToolMap } from "./types.js";

// =============================================================================
// Capability Constants
// =============================================================================

/** File operation capabilities */
export const FILE_CAPABILITIES = {
  READ: "file.read" as const,
  WRITE: "file.write" as const,
  DELETE: "file.delete" as const,
};

/** Git operation capabilities */
export const GIT_CAPABILITIES = {
  COMMIT: "git.commit" as const,
  MERGE: "git.merge" as const,
  PUSH: "git.push" as const,
  BRANCH_CREATE: "git.branch.create" as const,
  BRANCH_DELETE: "git.branch.delete" as const,
};

/** Agent management capabilities */
export const AGENT_CAPABILITIES = {
  SPAWN_WORKER: "agent.spawn.worker" as const,
  SPAWN_INTEGRATOR: "agent.spawn.integrator" as const,
  SPAWN_MONITOR: "agent.spawn.monitor" as const,
  SPAWN_CUSTOM: "agent.spawn.custom" as const,
  TERMINATE: "agent.terminate" as const,
};

/** Lifecycle capabilities */
export const LIFECYCLE_CAPABILITIES = {
  DONE: "lifecycle.done" as const,
  PERSISTENT: "lifecycle.persistent" as const,
  DAEMON: "lifecycle.daemon" as const,
};

/** Task management capabilities */
export const TASK_CAPABILITIES = {
  CREATE: "task.create" as const,
  ASSIGN: "task.assign" as const,
  UPDATE: "task.update" as const,
  CLOSE: "task.close" as const,
  CLAIM: "task.claim" as const,
};

/** Execution capabilities */
export const EXEC_CAPABILITIES = {
  COMMAND: "exec.command" as const,
  BUILD: "exec.build" as const,
  TEST: "exec.test" as const,
  LINT: "exec.lint" as const,
};

/** Communication capabilities */
export const MSG_CAPABILITIES = {
  SEND: "msg.send" as const,
  BROADCAST: "msg.broadcast" as const,
  SUBSCRIBE: "msg.subscribe" as const,
};

/** Wildcard capability */
export const WILDCARD_CAPABILITY = "*" as const;

// =============================================================================
// All Known Capabilities
// =============================================================================

/**
 * Set of all known capability strings for validation
 */
export const ALL_CAPABILITIES: Set<Capability> = new Set([
  // File
  FILE_CAPABILITIES.READ,
  FILE_CAPABILITIES.WRITE,
  FILE_CAPABILITIES.DELETE,
  // Git
  GIT_CAPABILITIES.COMMIT,
  GIT_CAPABILITIES.MERGE,
  GIT_CAPABILITIES.PUSH,
  GIT_CAPABILITIES.BRANCH_CREATE,
  GIT_CAPABILITIES.BRANCH_DELETE,
  // Agent
  AGENT_CAPABILITIES.SPAWN_WORKER,
  AGENT_CAPABILITIES.SPAWN_INTEGRATOR,
  AGENT_CAPABILITIES.SPAWN_MONITOR,
  AGENT_CAPABILITIES.SPAWN_CUSTOM,
  AGENT_CAPABILITIES.TERMINATE,
  // Lifecycle
  LIFECYCLE_CAPABILITIES.DONE,
  LIFECYCLE_CAPABILITIES.PERSISTENT,
  LIFECYCLE_CAPABILITIES.DAEMON,
  // Task
  TASK_CAPABILITIES.CREATE,
  TASK_CAPABILITIES.ASSIGN,
  TASK_CAPABILITIES.UPDATE,
  TASK_CAPABILITIES.CLOSE,
  TASK_CAPABILITIES.CLAIM,
  // Exec
  EXEC_CAPABILITIES.COMMAND,
  EXEC_CAPABILITIES.BUILD,
  EXEC_CAPABILITIES.TEST,
  EXEC_CAPABILITIES.LINT,
  // Msg
  MSG_CAPABILITIES.SEND,
  MSG_CAPABILITIES.BROADCAST,
  MSG_CAPABILITIES.SUBSCRIBE,
  // Wildcard
  WILDCARD_CAPABILITY,
]);

/**
 * Check if a capability string is known
 */
export function isKnownCapability(capability: string): capability is Capability {
  return ALL_CAPABILITIES.has(capability as Capability);
}

// =============================================================================
// Capability to Tool Mapping
// =============================================================================

/**
 * Maps capabilities to their corresponding MCP tools.
 * Used for capability-based tool filtering.
 *
 * NOTE: Tool names must match actual MCP tool registration names in mcp-server.ts
 */
export const CAPABILITY_TOOL_MAP: CapabilityToolMap = {
  // File operations (Claude Code tools, if available)
  [FILE_CAPABILITIES.READ]: ["read", "glob", "grep"],
  [FILE_CAPABILITIES.WRITE]: ["write", "edit"],
  [FILE_CAPABILITIES.DELETE]: ["bash"], // rm via bash

  // Git operations (via bash)
  [GIT_CAPABILITIES.COMMIT]: ["bash"],
  [GIT_CAPABILITIES.MERGE]: ["bash"],
  [GIT_CAPABILITIES.PUSH]: ["bash"],
  [GIT_CAPABILITIES.BRANCH_CREATE]: ["bash"],
  [GIT_CAPABILITIES.BRANCH_DELETE]: ["bash"],

  // Agent operations - MCP tool names
  [AGENT_CAPABILITIES.SPAWN_WORKER]: ["spawn_agent"],
  [AGENT_CAPABILITIES.SPAWN_INTEGRATOR]: ["spawn_agent"],
  [AGENT_CAPABILITIES.SPAWN_MONITOR]: ["spawn_agent"],
  [AGENT_CAPABILITIES.SPAWN_CUSTOM]: ["spawn_agent"],
  [AGENT_CAPABILITIES.TERMINATE]: ["stop_agent"],

  // Lifecycle operations
  [LIFECYCLE_CAPABILITIES.DONE]: ["done"],

  // Task operations (via TaskBackend + OpenTasks tools)
  [TASK_CAPABILITIES.CREATE]: ["create_task"],
  [TASK_CAPABILITIES.ASSIGN]: ["assign_task", "task"],
  [TASK_CAPABILITIES.UPDATE]: ["update_task", "task", "link", "annotate"],
  [TASK_CAPABILITIES.CLOSE]: ["close_task", "task"],
  [TASK_CAPABILITIES.CLAIM]: ["claim_task", "unclaim_task", "list_claimable_tasks"],

  // Execution operations
  [EXEC_CAPABILITIES.COMMAND]: ["bash"],
  [EXEC_CAPABILITIES.BUILD]: ["bash"],
  [EXEC_CAPABILITIES.TEST]: ["bash"],
  [EXEC_CAPABILITIES.LINT]: ["bash"],

  // Communication operations - MCP tool names
  [MSG_CAPABILITIES.SEND]: ["send_message", "check_messages", "send_peer_message"],
  [MSG_CAPABILITIES.BROADCAST]: ["send_message"],
  [MSG_CAPABILITIES.SUBSCRIBE]: ["check_messages"],
};

// =============================================================================
// Workspace/Query Tools (always available)
// =============================================================================

/**
 * Tools that are always available regardless of capabilities.
 * These are read-only observability tools that don't require special permissions.
 */
export const ALWAYS_ALLOWED_TOOLS: string[] = [
  "emit_status",
  "query_index",
  "get_hierarchy",
  "get_agent_summary",
  "get_task",
  "inject_context",
  "wait_for_activity",
  "send_peer_request",
  "respond_to_peer_request",
];

/**
 * Get the tools allowed for a set of capabilities
 */
export function getToolsForCapabilities(
  capabilities: Capability[],
  allToolNames: string[]
): string[] {
  // Wildcard means all tools
  if (capabilities.includes(WILDCARD_CAPABILITY)) {
    return allToolNames;
  }

  const allowedTools = new Set<string>();

  for (const cap of capabilities) {
    const tools = CAPABILITY_TOOL_MAP[cap];
    if (tools) {
      for (const tool of tools) {
        allowedTools.add(tool);
      }
    }
  }

  return Array.from(allowedTools);
}

/**
 * Check if a capability grants access to a specific tool
 */
export function capabilityGrantsTool(
  capability: Capability,
  toolName: string
): boolean {
  if (capability === WILDCARD_CAPABILITY) {
    return true;
  }
  const tools = CAPABILITY_TOOL_MAP[capability];
  return tools ? tools.includes(toolName) : false;
}
