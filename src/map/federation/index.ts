/**
 * MAP Federation Module
 *
 * Provides federation capabilities for cross-system communication
 * between MAP-compliant systems.
 *
 * @see specs/s-5qir_map_integration_for_macro_agent.md
 */

// Types
export type {
  // Configuration
  MAPPeerConfig,
  MAPFederationConfig,
  // Capabilities
  MessagingCapabilities,
  LifecycleCapabilities,
  QueryCapabilities,
  FederationCapabilities,
  // State
  PeerConnectionStatus,
  ConnectedPeer,
  // Events
  FederationEventType,
  FederationEventBase,
  PeerConnectingEvent,
  PeerConnectedEvent,
  PeerDisconnectedEvent,
  PeerErrorEvent,
  PeerCapabilitiesUpdatedEvent,
  FederationEvent,
  FederationEventHandler,
  // Interface
  FederationHandler,
  // Errors
  FederationErrorCode,
} from "./types.js";

export { FederationError } from "./types.js";

// Envelope handling
export type {
  FederationMetadata,
  FederationEnvelope,
} from "./envelope.js";

export {
  wrapMessage,
  unwrapMessage,
  getMetadata,
  isEnvelope,
  validateEnvelope,
  createResponseEnvelope,
  isResponseTo,
  getEnvelopeAge,
} from "./envelope.js";

// Federation handler
export {
  createFederationHandler,
  federatedAddressToPeerAddress,
  getSystemFromAddress,
  createCapabilityExchangeHandler,
  unwrapFederatedMessage,
} from "./federation-handler.js";
