/**
 * Control Socket Types
 *
 * NDJSON protocol for MCP subprocess → main process lifecycle RPC.
 * Separate from agent-inbox (messaging) — this is the control plane.
 *
 * @module control/types
 */

import type { AgentId } from "../store/types/primitives.js";
import type { AgentStopReason } from "../agent/types.js";

// =============================================================================
// Commands (subprocess → main process)
// =============================================================================

export type ControlCommand =
  | SpawnCommand
  | TerminateCommand
  | GetAgentCommand
  | ListAgentsCommand
  | GetChildrenCommand
  | GetHierarchyCommand
  | PingCommand
  | HealthCheckCommand;

export interface SpawnCommand {
  action: "spawn";
  task: string;
  parent?: string | null;
  role?: string;
  cwd?: string;
  team_instance?: string;
  customPrompt?: string;
}

export interface TerminateCommand {
  action: "terminate";
  agentId: string;
  reason: AgentStopReason;
}

export interface GetAgentCommand {
  action: "get_agent";
  agentId: string;
}

export interface ListAgentsCommand {
  action: "list_agents";
  filter?: {
    state?: string;
    parent?: string | null;
    headManagersOnly?: boolean;
  };
}

export interface GetChildrenCommand {
  action: "get_children";
  agentId: string;
}

export interface GetHierarchyCommand {
  action: "get_hierarchy";
  agentId: string;
  depth?: number;
}

export interface PingCommand {
  action: "ping";
}

export interface HealthCheckCommand {
  action: "health_check";
  agentId: string;
  mcpPid: number;
}

// =============================================================================
// Responses (main process → subprocess)
// =============================================================================

export type ControlResponse =
  | ControlSuccessResponse
  | ControlErrorResponse;

export interface ControlSuccessResponse {
  ok: true;
  result?: unknown;
}

export interface ControlErrorResponse {
  ok: false;
  error: string;
  code?: string;
}
