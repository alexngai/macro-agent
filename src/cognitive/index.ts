/**
 * Cognitive Module
 *
 * Atlas compute backend for cognitive-core integration.
 * Implements cognitive-core's AgentBackend interface using
 * macro-agent's AgentManager for agent spawning and lifecycle.
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
  CognitiveTrajectory,
  CognitiveStep,
  CognitiveOutcome,
  AtlasInstance,
  CognitiveOperation,
  SessionCompleteEvent,
  SessionEventEmitter,
} from "./types.js";

// Backend
export {
  MacroAgentBackend,
  createMacroAgentBackend,
} from "./macro-agent-backend.js";

// Role
export { AnalystRole } from "./analyst-role.js";

// Session conversion
export {
  convertUpdatesToSession,
  updateSessionFromEvent,
} from "./session-converter.js";

// Trajectory extraction
export { extractTrajectory } from "./trajectory-extractor.js";

// Team lifecycle (Phase 2)
export {
  initCognitiveTeam,
  type CognitiveTeamServices,
  type CognitiveTeamHandle,
} from "./team-lifecycle.js";
