/**
 * WebSocketPeerTransport - WebSocket-based transport for distributed peer communication
 *
 * Provides a WebSocket implementation of PeerTransport for macro-agents
 * running on different machines across a network.
 *
 * Features:
 * - Config-based peer registry for peer discovery
 * - Connection pooling and automatic reconnection
 * - Graceful error handling for network failures
 */

import { WebSocket, WebSocketServer } from "ws";
import { nanoid } from "nanoid";
import type {
  PeerTransport,
  PeerHandler,
  PeerMessage,
  PeerRequest,
  PeerResponse,
  PeerAddress,
} from "../types.js";

// ─────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────

export interface PeerRegistryEntry {
  /** Peer's unique ID */
  peerId: string;

  /** WebSocket URL to connect to this peer (e.g., "ws://host:port") */
  url: string;
}

export interface WebSocketTransportConfig {
  /** This peer's unique ID */
  peerId: string;

  /** Port to listen on for incoming connections */
  port: number;

  /** Host to bind to (defaults to "0.0.0.0") */
  host?: string;

  /** Registry of known peers */
  peerRegistry?: PeerRegistryEntry[];

  /** Timeout for requests in ms (defaults to 30000) */
  requestTimeout?: number;

  /** Reconnection delay in ms (defaults to 5000) */
  reconnectDelay?: number;

  /** Maximum reconnection attempts (defaults to 3) */
  maxReconnectAttempts?: number;
}

interface WireMessage {
  type: "message" | "request" | "response" | "identify";
  id: string;
  from: PeerAddress;
  payload: PeerMessage | PeerRequest | PeerResponse | { peerId: string };
}

interface PendingOutboundRequest {
  resolve: (response: PeerResponse) => void;
  timeout: NodeJS.Timeout;
}

interface ConnectionInfo {
  socket: WebSocket;
  peerId: string | null;
  reconnectAttempts: number;
}

// ─────────────────────────────────────────────────────────────────
// WebSocketPeerTransport
// ─────────────────────────────────────────────────────────────────

export class WebSocketPeerTransport implements PeerTransport {
  private peerId: string;
  private port: number;
  private host: string;
  private peerRegistry: Map<string, string> = new Map(); // peerId -> url
  private requestTimeout: number;
  private reconnectDelay: number;
  private maxReconnectAttempts: number;

  private server: WebSocketServer | null = null;
  private connections: Map<string, ConnectionInfo> = new Map();
  private pendingRequests: Map<string, PendingOutboundRequest> = new Map();
  private handler: PeerHandler | null = null;
  private stopped: boolean = false;

  constructor(config: WebSocketTransportConfig) {
    this.peerId = config.peerId;
    this.port = config.port;
    this.host = config.host ?? "0.0.0.0";
    this.requestTimeout = config.requestTimeout ?? 30000;
    this.reconnectDelay = config.reconnectDelay ?? 5000;
    this.maxReconnectAttempts = config.maxReconnectAttempts ?? 3;

    // Populate peer registry
    if (config.peerRegistry) {
      for (const entry of config.peerRegistry) {
        this.peerRegistry.set(entry.peerId, entry.url);
      }
    }
  }

  /**
   * Add or update a peer in the registry
   */
  registerPeer(peerId: string, url: string): void {
    this.peerRegistry.set(peerId, url);
  }

  /**
   * Remove a peer from the registry
   */
  unregisterPeer(peerId: string): void {
    this.peerRegistry.delete(peerId);
    const conn = this.connections.get(peerId);
    if (conn) {
      conn.socket.close();
      this.connections.delete(peerId);
    }
  }

  /**
   * Start the transport server and begin listening for connections
   */
  async start(handler: PeerHandler): Promise<void> {
    this.handler = handler;
    this.stopped = false;

    return new Promise((resolve, reject) => {
      this.server = new WebSocketServer({
        port: this.port,
        host: this.host,
      });

      this.server.on("connection", (socket) => {
        this.handleIncomingConnection(socket);
      });

      this.server.on("error", (err) => {
        reject(err);
      });

      this.server.on("listening", () => {
        resolve();
      });
    });
  }

  /**
   * Stop the transport server and close all connections
   */
  async stop(): Promise<void> {
    // Mark as stopped to prevent reconnection attempts
    this.stopped = true;

    // Close all peer connections
    for (const [peerId, conn] of this.connections) {
      conn.socket.close();
      this.connections.delete(peerId);
    }

    // Close server
    if (this.server) {
      return new Promise((resolve) => {
        this.server!.close(() => {
          this.server = null;
          resolve();
        });
      });
    }
  }

  /**
   * Send a message to a peer (fire-and-forget)
   */
  async sendMessage(to: PeerAddress, message: PeerMessage): Promise<void> {
    const peerId = this.extractPeerId(to);
    const socket = await this.getOrCreateConnection(peerId);

    const wireMessage: WireMessage = {
      type: "message",
      id: `msg_${nanoid(12)}`,
      from: this.peerId,
      payload: message,
    };

    this.sendWireMessage(socket, wireMessage);
  }

  /**
   * Send a request to a peer and wait for response
   */
  async sendRequest(to: PeerAddress, request: PeerRequest): Promise<PeerResponse> {
    const peerId = this.extractPeerId(to);
    const socket = await this.getOrCreateConnection(peerId);

    const requestId = `req_${nanoid(12)}`;
    const wireMessage: WireMessage = {
      type: "request",
      id: requestId,
      from: this.peerId,
      payload: request,
    };

    return new Promise((resolve) => {
      // Set up timeout
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        resolve({
          error: {
            code: -32000,
            message: "Request timeout",
          },
        });
      }, request.timeout ?? this.requestTimeout);

      // Store pending request
      this.pendingRequests.set(requestId, { resolve, timeout });

      // Send request
      this.sendWireMessage(socket, wireMessage);
    });
  }

  // ─────────────────────────────────────────────────────────────────
  // Private Methods
  // ─────────────────────────────────────────────────────────────────

  private extractPeerId(address: PeerAddress): string {
    const slashIndex = address.indexOf("/");
    return slashIndex === -1 ? address : address.substring(0, slashIndex);
  }

  private async getOrCreateConnection(peerId: string): Promise<WebSocket> {
    // Check for existing connection
    const existing = this.connections.get(peerId);
    if (existing && existing.socket.readyState === WebSocket.OPEN) {
      return existing.socket;
    }

    // Look up peer URL in registry
    const url = this.peerRegistry.get(peerId);
    if (!url) {
      throw new Error(`Unknown peer: ${peerId}. Add to peer registry first.`);
    }

    return this.connectToPeer(peerId, url);
  }

  private connectToPeer(peerId: string, url: string): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);

      socket.on("open", () => {
        // Send identification message
        const identifyMessage: WireMessage = {
          type: "identify",
          id: `id_${nanoid(12)}`,
          from: this.peerId,
          payload: { peerId: this.peerId },
        };
        this.sendWireMessage(socket, identifyMessage);

        this.connections.set(peerId, {
          socket,
          peerId,
          reconnectAttempts: 0,
        });

        this.setupSocketHandlers(socket, peerId);
        resolve(socket);
      });

      socket.on("error", (err) => {
        reject(new Error(`Failed to connect to peer ${peerId}: ${err.message}`));
      });
    });
  }

  private handleIncomingConnection(socket: WebSocket): void {
    let remotePeerId: string | null = null;

    socket.on("message", (data) => {
      try {
        const wireMessage: WireMessage = JSON.parse(data.toString());

        // Handle identification
        if (wireMessage.type === "identify") {
          const payload = wireMessage.payload as { peerId: string };
          remotePeerId = payload.peerId;
          this.connections.set(remotePeerId, {
            socket,
            peerId: remotePeerId,
            reconnectAttempts: 0,
          });
          return;
        }

        // Track peer ID from messages
        if (!remotePeerId) {
          remotePeerId = this.extractPeerId(wireMessage.from);
          this.connections.set(remotePeerId, {
            socket,
            peerId: remotePeerId,
            reconnectAttempts: 0,
          });
        }

        this.handleWireMessage(wireMessage, socket);
      } catch (err) {
        console.error("Failed to parse incoming message:", err);
      }
    });

    socket.on("close", () => {
      if (remotePeerId) {
        this.connections.delete(remotePeerId);
      }
    });

    socket.on("error", (err) => {
      console.error("Socket error:", err);
      if (remotePeerId) {
        this.connections.delete(remotePeerId);
      }
    });
  }

  private setupSocketHandlers(socket: WebSocket, peerId: string): void {
    socket.on("message", (data) => {
      try {
        const wireMessage: WireMessage = JSON.parse(data.toString());
        this.handleWireMessage(wireMessage, socket);
      } catch (err) {
        console.error("Failed to parse message:", err);
      }
    });

    socket.on("close", () => {
      this.connections.delete(peerId);
      this.scheduleReconnect(peerId);
    });

    socket.on("error", (err) => {
      console.error(`Socket error for peer ${peerId}:`, err);
      this.connections.delete(peerId);
    });
  }

  private scheduleReconnect(peerId: string): void {
    // Don't reconnect if transport is stopped
    if (this.stopped) return;

    const url = this.peerRegistry.get(peerId);
    if (!url) return;

    const existingConn = this.connections.get(peerId);
    const attempts = existingConn?.reconnectAttempts ?? 0;

    if (attempts >= this.maxReconnectAttempts) {
      console.log(`Max reconnection attempts reached for peer ${peerId}`);
      return;
    }

    setTimeout(async () => {
      // Check again in case transport was stopped while waiting
      if (this.stopped) return;

      try {
        await this.connectToPeer(peerId, url);
        console.log(`Reconnected to peer ${peerId}`);
      } catch (err) {
        console.error(`Reconnection failed for peer ${peerId}:`, err);
        // Update reconnect attempts
        const conn = this.connections.get(peerId);
        if (conn) {
          conn.reconnectAttempts = attempts + 1;
        }
        this.scheduleReconnect(peerId);
      }
    }, this.reconnectDelay);
  }

  private handleWireMessage(wireMessage: WireMessage, socket: WebSocket): void {
    switch (wireMessage.type) {
      case "message":
        if (this.handler) {
          this.handler.handleMessage(
            wireMessage.from,
            wireMessage.payload as PeerMessage
          );
        }
        break;

      case "request":
        if (this.handler) {
          const request = wireMessage.payload as PeerRequest;
          this.handler
            .handleRequest(wireMessage.from, request)
            .then((response) => {
              const responseMessage: WireMessage = {
                type: "response",
                id: wireMessage.id,
                from: this.peerId,
                payload: response,
              };
              this.sendWireMessage(socket, responseMessage);
            });
        }
        break;

      case "response":
        const pending = this.pendingRequests.get(wireMessage.id);
        if (pending) {
          clearTimeout(pending.timeout);
          this.pendingRequests.delete(wireMessage.id);
          pending.resolve(wireMessage.payload as PeerResponse);
        }
        break;

      case "identify":
        // Already handled in connection setup
        break;
    }
  }

  private sendWireMessage(socket: WebSocket, message: WireMessage): void {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    } else {
      console.error("Cannot send message: socket not open");
    }
  }
}

/**
 * Create a WebSocketPeerTransport instance
 */
export function createWebSocketTransport(
  config: WebSocketTransportConfig
): WebSocketPeerTransport {
  return new WebSocketPeerTransport(config);
}
