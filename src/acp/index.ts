/**
 * ACP module - Agent Communication Protocol support for macro-agent
 *
 * Enables macro-agent to run as an ACP-compliant agent that external
 * systems can spawn and control.
 */

// Types
export type {
  ACPSessionId,
  SessionMapping,
  // Extension request/response types
  SpawnAgentRequest,
  SpawnAgentResponse,
  GetHierarchyRequest,
  GetHierarchyResponse,
  GetTaskRequest,
  GetTaskResponse,
  MountAgentRequest,
  MountAgentResponse,
  ForkAgentRequest,
  ForkAgentResponse,
  // Union types
  ACPExtensionMethod,
  ACPExtensionRequests,
  ACPExtensionResponses,
  // Error types
  ACPErrorCode,
} from "./types.js";

export { ACPError } from "./types.js";

// Session mapping
export { SessionMapper } from "./session-mapper.js";

// MacroAgent - ACP-compliant agent implementation
export { MacroAgent, type MacroAgentConfig } from "./macro-agent.js";
