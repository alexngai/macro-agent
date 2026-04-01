/**
 * ACP (Agent Communication Protocol) — WebSocket-based multi-client sessions.
 *
 * @module acp
 */

export { ACPError } from "./types.js";
export type {
  ACPSessionId,
  ACPErrorCode,
  SessionMapping,
  MacroAgentInitConfig,
} from "./types.js";

export { SessionMapper } from "./session-mapper.js";

export { createMacroAgent } from "./macro-agent.js";
export type { MacroAgentConfig } from "./macro-agent.js";

export { createWebSocketACPServer } from "./websocket-server.js";
export type {
  WebSocketACPServer,
  WebSocketACPServerConfig,
} from "./websocket-server.js";

export { createMAPBridge } from "./map-bridge.js";
export type {
  MAPBridge,
  MAPBridgeConfig,
  MAPBridgeDeps,
  MAPMessage,
} from "./map-bridge.js";
