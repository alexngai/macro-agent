/**
 * MAP WebSocket Integration
 *
 * Provides WebSocket integration for the MAP adapter, enabling external clients
 * to connect via WebSocket and use the MAP protocol.
 *
 * Reuses the existing webSocketStream() adapter to keep MAPAdapter transport-agnostic.
 *
 * @see specs/s-5qir_map_integration_for_macro_agent.md
 */

import type { WebSocket } from "ws";
import type { MAPAdapter } from "./interface.js";
import type { ConnectedParticipant } from "./types.js";
import { webSocketStream } from "../../acp/websocket-stream.js";

// =============================================================================
// Types
// =============================================================================

/**
 * Tracked MAP WebSocket connection
 */
interface TrackedMAPConnection {
  ws: WebSocket;
  participant: ConnectedParticipant;
  createdAt: number;
}

/**
 * MAP WebSocket handler for managing connections
 */
export interface MAPWebSocketHandler {
  /**
   * Handle a new WebSocket connection.
   * Called when a client connects to the /map path.
   */
  handleConnection(ws: WebSocket, req: { socket: { remoteAddress?: string } }): Promise<void>;

  /**
   * Get the number of active MAP connections.
   */
  getConnectionCount(): number;

  /**
   * Close all MAP connections gracefully.
   */
  closeAll(): void;

  /**
   * Get participant by WebSocket instance.
   */
  getParticipant(ws: WebSocket): ConnectedParticipant | undefined;
}

// =============================================================================
// WebSocket Handler Factory
// =============================================================================

/**
 * Create a MAP WebSocket handler.
 *
 * This handler processes WebSocket connections for the MAP protocol.
 * It creates a stream adapter from the WebSocket and passes it to the MAPAdapter.
 *
 * @param adapter - The MAPAdapter instance to use
 * @returns Handler for managing MAP WebSocket connections
 *
 * @example
 * ```typescript
 * const mapHandler = createMAPWebSocketHandler(mapAdapter);
 *
 * wss.on("connection", (ws, req) => {
 *   if (req.url?.startsWith("/map")) {
 *     mapHandler.handleConnection(ws, req);
 *   }
 * });
 * ```
 */
export function createMAPWebSocketHandler(adapter: MAPAdapter): MAPWebSocketHandler {
  const connections = new Map<WebSocket, TrackedMAPConnection>();

  async function handleConnection(
    ws: WebSocket,
    req: { socket: { remoteAddress?: string } }
  ): Promise<void> {
    const remoteAddress = req.socket.remoteAddress ?? "unknown";
    console.error(`[ws-map] New connection from ${remoteAddress}`);

    // Create stream adapter from WebSocket
    const stream = webSocketStream(ws);

    try {
      // Let MAPAdapter handle the connection
      const participant = await adapter.acceptConnection(stream);

      // Track this connection
      const tracked: TrackedMAPConnection = {
        ws,
        participant,
        createdAt: Date.now(),
      };
      connections.set(ws, tracked);

      console.error(`[ws-map] Participant ${participant.id} connected`);

      // Handle connection close
      ws.on("close", (code, reason) => {
        console.error(
          `[ws-map] Connection closed: participant=${participant.id}, code=${code}, reason=${reason.toString()}`
        );
        connections.delete(ws);
        // MAPAdapter handles cleanup internally via stream close
      });

      // Handle connection errors
      ws.on("error", (err) => {
        console.error(`[ws-map] Connection error: participant=${participant.id}`, err);
        connections.delete(ws);
      });
    } catch (error) {
      console.error(`[ws-map] Failed to accept connection:`, error);
      ws.close(1011, "Connection setup failed");
    }
  }

  function getConnectionCount(): number {
    return connections.size;
  }

  function closeAll(): void {
    console.error(`[ws-map] Closing ${connections.size} connections...`);
    for (const [ws, tracked] of connections) {
      if (ws.readyState === ws.OPEN) {
        // Disconnect via adapter first (for clean subscription cleanup)
        adapter.disconnectParticipant(tracked.participant.id, "Server shutting down")
          .catch((err) => console.error(`[ws-map] Error disconnecting participant:`, err));
        ws.close(1001, "Server shutting down");
      }
    }
    connections.clear();
  }

  function getParticipant(ws: WebSocket): ConnectedParticipant | undefined {
    return connections.get(ws)?.participant;
  }

  return {
    handleConnection,
    getConnectionCount,
    closeAll,
    getParticipant,
  };
}

// =============================================================================
// Combined Server Support
// =============================================================================

/**
 * Configuration for setting up MAP on a WebSocket server.
 */
export interface MAPWebSocketConfig {
  /**
   * The MAPAdapter instance.
   */
  adapter: MAPAdapter;

  /**
   * URL path for MAP connections (default: "/map").
   */
  path?: string;
}

/**
 * Result of setting up MAP WebSocket handling.
 */
export interface MAPWebSocketSetup {
  /**
   * The MAP handler.
   */
  handler: MAPWebSocketHandler;

  /**
   * Check if a request URL matches the MAP path.
   */
  matchesPath: (url?: string) => boolean;
}

/**
 * Set up MAP WebSocket handling configuration.
 *
 * Returns a handler and path matcher for use in a combined server setup.
 *
 * @param config - MAP WebSocket configuration
 * @returns Setup result with handler and path matcher
 *
 * @example
 * ```typescript
 * const mapSetup = setupMAPWebSocket({ adapter: mapAdapter });
 * const acpSetup = setupACPWebSocket(wss, services);
 *
 * // Route connections based on path
 * httpServer.on("upgrade", (req, socket, head) => {
 *   if (mapSetup.matchesPath(req.url)) {
 *     wss.handleUpgrade(req, socket, head, (ws) => {
 *       mapSetup.handler.handleConnection(ws, req);
 *     });
 *   } else {
 *     // ACP or other handling
 *   }
 * });
 * ```
 */
export function setupMAPWebSocket(config: MAPWebSocketConfig): MAPWebSocketSetup {
  const { adapter, path = "/map" } = config;
  const handler = createMAPWebSocketHandler(adapter);

  function matchesPath(url?: string): boolean {
    if (!url) return false;
    // Match exact path or path with query string
    return url === path || url.startsWith(`${path}?`) || url.startsWith(`${path}/`);
  }

  return {
    handler,
    matchesPath,
  };
}
