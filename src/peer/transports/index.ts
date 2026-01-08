/**
 * Peer transport implementations
 *
 * Example transports for peer-to-peer communication between macro-agents.
 */

export {
  LocalPeerTransport,
  createLocalTransport,
  type LocalTransportConfig,
} from "./local-transport.js";

export {
  WebSocketPeerTransport,
  createWebSocketTransport,
  type WebSocketTransportConfig,
  type PeerRegistryEntry,
} from "./websocket-transport.js";
