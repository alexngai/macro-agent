/**
 * MAP Adapter Module
 *
 * Provides types, interfaces, and implementations for the MAP adapter layer
 * that handles external client connections.
 *
 * @see specs/s-5qir_map_integration_for_macro_agent.md
 */

// Types and interfaces
export * from "./types.js";
export * from "./interface.js";

// Connection management
export {
  createConnectionManager,
  ConnectionManagerImpl,
  ConnectionError,
  type ConnectionManager,
  type ConnectionManagerConfig,
  type ConnectionManagerEvent,
  type ConnectionManagerEventHandler,
  type ConnectOptions,
  type ConnectionErrorCode,
} from "./connection-manager.js";

// Subscription management
export {
  createSubscriptionManager,
  SubscriptionManagerImpl,
  SubscriptionError,
  type SubscriptionManager,
  type SubscriptionManagerConfig,
  type SubscriptionManagerEvent,
  type SubscriptionManagerEventHandler,
  type MatchResult,
  type SubscriptionErrorCode,
} from "./subscription-manager.js";

// JSON-RPC handling
export {
  RPCHandler,
  createRPCHandler,
  RPCError,
  JSON_RPC_ERRORS,
  MAP_ERRORS,
  isRequest,
  isNotification,
  isResponse,
  isErrorResponse,
  createSuccessResponse,
  createErrorResponse,
  createNotification,
  createLoggingMiddleware,
  createCapabilityMiddleware,
  type RequestId,
  type JsonRpcRequest,
  type JsonRpcNotification,
  type JsonRpcError,
  type JsonRpcSuccessResponse,
  type JsonRpcErrorResponse,
  type JsonRpcResponse,
  type JsonRpcMessage,
  type HandlerContext,
  type MethodHandler,
  type HandlerRegistry,
  type Middleware,
  type RPCHandlerConfig,
  type ProcessResult,
} from "./rpc-handler.js";

// MAPAdapter implementation
export {
  MAPAdapterImpl,
  createMAPAdapter,
  type MAPAdapterServices,
} from "./map-adapter.js";

// Event translation
export {
  translateEvent,
  translateEvents,
  createEventStreamAdapter,
  type TranslationResult,
  type TranslationContext,
  type EventStreamAdapterOptions,
} from "./event-translator.js";

// WebSocket integration
export {
  createMAPWebSocketHandler,
  setupMAPWebSocket,
  type MAPWebSocketHandler,
  type MAPWebSocketConfig,
  type MAPWebSocketSetup,
} from "./websocket-integration.js";
