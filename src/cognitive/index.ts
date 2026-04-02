/**
 * Cognitive Module — Bridge for cognitive-core integration
 *
 * Provides:
 * - MacroAgentBackend: Implements cognitive-core's AgentBackend interface
 * - AnalystRole: Minimal role for cognitive analysis agents
 * - SessionConverter: Converts ACP updates to cognitive session state
 * - Types: Structural compatibility with cognitive-core (no direct import)
 *
 * Atlas, trajectory extraction, and ACP extensions are handled by OpenHive.
 * This module focuses on: receive task → spawn agent → track session → return result.
 */

// Types
export type {
  CognitiveAgentSession,
  CognitiveAgentMessage,
  CognitiveToolCall,
  CognitiveTask,
  CognitiveAgentState,
  CognitiveAgentSpawnConfig,
  MacroAgentBackendConfig,
  MacroSessionState,
  CognitiveBatchConfig,
  CognitiveBatchHandle,
  CognitiveBatchResult,
  CognitiveBatchTaskResult,
  SessionCompleteEvent,
} from "./types.js";

// Backend
export {
  MacroAgentBackend,
  createMacroAgentBackend,
} from "./macro-agent-backend.js";

// Role
export { AnalystRole } from "./analyst-role.js";

// Session conversion (used internally by MacroAgentBackend)
export { updateSessionFromEvent } from "./session-converter.js";

// Workspace execution handler (bridge for OpenHive workspace.execute messages)
export {
  handleWorkspaceExecute,
  isWorkspaceExecuteMessage,
  type WorkspaceHandlerDeps,
  type WorkspaceExecuteParams,
} from "./workspace-handler.js";
