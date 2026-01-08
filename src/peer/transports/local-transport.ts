/**
 * LocalPeerTransport - Unix socket-based transport for same-machine peer communication
 *
 * Provides an IPC-based implementation of PeerTransport for macro-agents
 * running on the same machine but in different processes.
 *
 * Each peer creates a Unix socket server at a known path (based on peer ID).
 * To communicate with a peer, it connects to that peer's socket.
 */

import * as net from "net";
import * as fs from "fs";
import * as path from "path";
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

export interface LocalTransportConfig {
  /** This peer's unique ID */
  peerId: string;

  /** Directory for socket files (defaults to /tmp/macro-agent-peers) */
  socketDir?: string;

  /** Timeout for requests in ms (defaults to 30000) */
  requestTimeout?: number;
}

interface WireMessage {
  type: "message" | "request" | "response";
  id: string;
  from: PeerAddress;
  payload: PeerMessage | PeerRequest | PeerResponse;
}

interface PendingOutboundRequest {
  resolve: (response: PeerResponse) => void;
  timeout: NodeJS.Timeout;
}

// ─────────────────────────────────────────────────────────────────
// LocalPeerTransport
// ─────────────────────────────────────────────────────────────────

export class LocalPeerTransport implements PeerTransport {
  private peerId: string;
  private socketDir: string;
  private requestTimeout: number;

  private server: net.Server | null = null;
  private connections: Map<string, net.Socket> = new Map();
  private pendingRequests: Map<string, PendingOutboundRequest> = new Map();
  private handler: PeerHandler | null = null;

  constructor(config: LocalTransportConfig) {
    this.peerId = config.peerId;
    this.socketDir = config.socketDir ?? "/tmp/macro-agent-peers";
    this.requestTimeout = config.requestTimeout ?? 30000;
  }

  /**
   * Start the transport server and begin listening for connections
   */
  async start(handler: PeerHandler): Promise<void> {
    this.handler = handler;

    // Ensure socket directory exists
    if (!fs.existsSync(this.socketDir)) {
      fs.mkdirSync(this.socketDir, { recursive: true });
    }

    const socketPath = this.getSocketPath(this.peerId);

    // Remove stale socket file if it exists
    if (fs.existsSync(socketPath)) {
      fs.unlinkSync(socketPath);
    }

    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => {
        this.handleIncomingConnection(socket);
      });

      this.server.on("error", (err) => {
        reject(err);
      });

      this.server.listen(socketPath, () => {
        resolve();
      });
    });
  }

  /**
   * Stop the transport server and close all connections
   */
  async stop(): Promise<void> {
    // Close all peer connections
    for (const [peerId, socket] of this.connections) {
      socket.destroy();
      this.connections.delete(peerId);
    }

    // Close server
    if (this.server) {
      return new Promise((resolve) => {
        this.server!.close(() => {
          // Clean up socket file
          const socketPath = this.getSocketPath(this.peerId);
          if (fs.existsSync(socketPath)) {
            fs.unlinkSync(socketPath);
          }
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

    this.writeMessage(socket, wireMessage);
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
      this.writeMessage(socket, wireMessage);
    });
  }

  // ─────────────────────────────────────────────────────────────────
  // Private Methods
  // ─────────────────────────────────────────────────────────────────

  private getSocketPath(peerId: string): string {
    // Sanitize peer ID for use in filename
    const safePeerId = peerId.replace(/[^a-zA-Z0-9_-]/g, "_");
    return path.join(this.socketDir, `${safePeerId}.sock`);
  }

  private extractPeerId(address: PeerAddress): string {
    // Address format: "peerId" or "peerId/agentId"
    const slashIndex = address.indexOf("/");
    return slashIndex === -1 ? address : address.substring(0, slashIndex);
  }

  private async getOrCreateConnection(peerId: string): Promise<net.Socket> {
    // Check for existing connection
    const existing = this.connections.get(peerId);
    if (existing && !existing.destroyed) {
      return existing;
    }

    // Create new connection
    const socketPath = this.getSocketPath(peerId);

    return new Promise((resolve, reject) => {
      const socket = net.createConnection(socketPath, () => {
        this.connections.set(peerId, socket);
        this.setupSocketHandlers(socket, peerId);
        resolve(socket);
      });

      socket.on("error", (err) => {
        reject(new Error(`Failed to connect to peer ${peerId}: ${err.message}`));
      });
    });
  }

  private handleIncomingConnection(socket: net.Socket): void {
    let buffer = "";
    let remotePeerId: string | null = null;

    socket.on("data", (data) => {
      buffer += data.toString();

      // Process complete messages (newline-delimited JSON)
      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
        const messageStr = buffer.substring(0, newlineIndex);
        buffer = buffer.substring(newlineIndex + 1);

        try {
          const wireMessage: WireMessage = JSON.parse(messageStr);

          // Track the remote peer ID from first message
          if (!remotePeerId) {
            remotePeerId = this.extractPeerId(wireMessage.from);
            this.connections.set(remotePeerId, socket);
          }

          this.handleWireMessage(wireMessage, socket);
        } catch (err) {
          console.error("Failed to parse incoming message:", err);
        }
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

  private setupSocketHandlers(socket: net.Socket, peerId: string): void {
    let buffer = "";

    socket.on("data", (data) => {
      buffer += data.toString();

      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
        const messageStr = buffer.substring(0, newlineIndex);
        buffer = buffer.substring(newlineIndex + 1);

        try {
          const wireMessage: WireMessage = JSON.parse(messageStr);
          this.handleWireMessage(wireMessage, socket);
        } catch (err) {
          console.error("Failed to parse message:", err);
        }
      }
    });

    socket.on("close", () => {
      this.connections.delete(peerId);
    });

    socket.on("error", (err) => {
      console.error(`Socket error for peer ${peerId}:`, err);
      this.connections.delete(peerId);
    });
  }

  private handleWireMessage(wireMessage: WireMessage, socket: net.Socket): void {
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
              // Send response back
              const responseMessage: WireMessage = {
                type: "response",
                id: wireMessage.id, // Use same ID for correlation
                from: this.peerId,
                payload: response,
              };
              this.writeMessage(socket, responseMessage);
            });
        }
        break;

      case "response":
        // Resolve pending request
        const pending = this.pendingRequests.get(wireMessage.id);
        if (pending) {
          clearTimeout(pending.timeout);
          this.pendingRequests.delete(wireMessage.id);
          pending.resolve(wireMessage.payload as PeerResponse);
        }
        break;
    }
  }

  private writeMessage(socket: net.Socket, message: WireMessage): void {
    // Newline-delimited JSON
    socket.write(JSON.stringify(message) + "\n");
  }
}

/**
 * Create a LocalPeerTransport instance
 */
export function createLocalTransport(
  config: LocalTransportConfig
): LocalPeerTransport {
  return new LocalPeerTransport(config);
}
