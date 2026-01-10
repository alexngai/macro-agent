/**
 * WebSocket ACP Server
 *
 * Manages multiple WebSocket connections, each representing an independent
 * ACP session that can mount to agents in the shared hierarchy.
 */

import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import { AgentSideConnection } from "@agentclientprotocol/sdk";
import type { AgentManager } from "../agent/agent-manager.js";
import type { EventStore } from "../store/event-store.js";
import type { TaskManager } from "../task/task-manager.js";
import type { PeerManager } from "../peer/peer-manager.js";
import type { CapabilityManager } from "../peer/capability-manager.js";
import { MacroAgent } from "./macro-agent.js";
import { webSocketStream } from "./websocket-stream.js";

// ─────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────

/**
 * Services shared across all WebSocket ACP connections
 */
export interface ACPServices {
  agentManager: AgentManager;
  eventStore: EventStore;
  taskManager: TaskManager;
  peerManager?: PeerManager;
  capabilityManager?: CapabilityManager;
}

/**
 * Configuration for the WebSocket ACP server
 */
export interface WebSocketACPServerConfig {
  /** Port to listen on */
  port: number;

  /** Host to bind to (default: "localhost") */
  host?: string;

  /** URL path for WebSocket connections (default: "/acp") */
  path?: string;

  /** Default working directory for new sessions */
  defaultCwd?: string;
}

/**
 * WebSocket ACP Server interface
 */
export interface WebSocketACPServer {
  /** Start the server */
  start(): Promise<void>;

  /** Stop the server gracefully */
  stop(): Promise<void>;

  /** Get the number of active connections */
  getConnectionCount(): number;

  /** Get the server URL */
  getUrl(): string;

  /** HTTP server (for testing or mounting on existing server) */
  readonly httpServer: http.Server;

  /** WebSocket server */
  readonly wss: WebSocketServer;
}

// ─────────────────────────────────────────────────────────────────
// Connection Tracking
// ─────────────────────────────────────────────────────────────────

interface TrackedConnection {
  ws: WebSocket;
  acpConnection: AgentSideConnection;
  macroAgent: MacroAgent;
  createdAt: number;
}

// ─────────────────────────────────────────────────────────────────
// Server Implementation
// ─────────────────────────────────────────────────────────────────

/**
 * Create a WebSocket ACP server
 *
 * Each WebSocket connection gets its own ACP session that can independently:
 * - Create new sessions (spawning head managers)
 * - Mount to any agent in the shared hierarchy
 * - Send prompts to their mounted agent
 *
 * All connections share the same AgentManager, EventStore, etc., so agents
 * spawned by one client are visible to all other clients.
 */
export function createWebSocketACPServer(
  services: ACPServices,
  config: WebSocketACPServerConfig
): WebSocketACPServer {
  const {
    port,
    host = "localhost",
    path = "/acp",
    defaultCwd = process.cwd(),
  } = config;

  // Track active connections
  const connections = new Set<TrackedConnection>();

  // Create HTTP server
  const httpServer = http.createServer((req, res) => {
    // Health check endpoint
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          connections: connections.size,
          timestamp: Date.now(),
        })
      );
      return;
    }

    // Default response for non-WebSocket requests
    res.writeHead(426, { "Content-Type": "text/plain" });
    res.end("Upgrade Required - This endpoint accepts WebSocket connections");
  });

  // Create WebSocket server attached to HTTP server
  const wss = new WebSocketServer({
    server: httpServer,
    path,
  });

  // Handle new WebSocket connections
  wss.on("connection", (ws: WebSocket, req) => {
    console.error(
      `[ws-acp] New connection from ${req.socket.remoteAddress}`
    );

    // Create the ACP stream adapter
    const stream = webSocketStream(ws);

    // Create the MacroAgent for this connection
    // Each connection gets its own MacroAgent with its own SessionMapper,
    // but they all share the same AgentManager (shared agent hierarchy)
    let macroAgent: MacroAgent | null = null;

    const acpConnection = new AgentSideConnection(
      (conn) => {
        macroAgent = new MacroAgent(conn, {
          agentManager: services.agentManager,
          eventStore: services.eventStore,
          taskManager: services.taskManager,
          peerManager: services.peerManager,
          capabilityManager: services.capabilityManager,
          defaultCwd,
        });
        return macroAgent;
      },
      stream
    );

    // Track this connection
    const tracked: TrackedConnection = {
      ws,
      acpConnection,
      macroAgent: macroAgent!,
      createdAt: Date.now(),
    };
    connections.add(tracked);

    // Handle connection close
    ws.on("close", (code, reason) => {
      console.error(
        `[ws-acp] Connection closed: code=${code}, reason=${reason.toString()}`
      );
      connections.delete(tracked);
    });

    // Handle connection errors
    ws.on("error", (err) => {
      console.error(`[ws-acp] Connection error:`, err);
      connections.delete(tracked);
    });
  });

  // Handle server errors
  wss.on("error", (err) => {
    console.error(`[ws-acp] WebSocket server error:`, err);
  });

  // ─────────────────────────────────────────────────────────────────
  // Server Lifecycle
  // ─────────────────────────────────────────────────────────────────

  async function start(): Promise<void> {
    return new Promise((resolve, reject) => {
      httpServer.on("error", reject);
      httpServer.listen(port, host, () => {
        httpServer.removeListener("error", reject);
        console.error(`[ws-acp] Server listening on ws://${host}:${port}${path}`);
        resolve();
      });
    });
  }

  async function stop(): Promise<void> {
    console.error(`[ws-acp] Shutting down, closing ${connections.size} connections...`);

    // Close all WebSocket connections gracefully
    for (const tracked of connections) {
      if (tracked.ws.readyState === WebSocket.OPEN) {
        tracked.ws.close(1001, "Server shutting down");
      }
    }
    connections.clear();

    // Close the WebSocket server
    await new Promise<void>((resolve) => {
      wss.close(() => resolve());
    });

    // Close the HTTP server
    await new Promise<void>((resolve, reject) => {
      httpServer.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    console.error(`[ws-acp] Server stopped`);
  }

  function getConnectionCount(): number {
    return connections.size;
  }

  function getUrl(): string {
    return `ws://${host}:${port}${path}`;
  }

  return {
    start,
    stop,
    getConnectionCount,
    getUrl,
    httpServer,
    wss,
  };
}
