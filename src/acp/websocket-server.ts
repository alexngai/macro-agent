/**
 * WebSocket ACP Server
 *
 * Manages multiple WebSocket connections, each representing an independent
 * ACP session that can mount to agents in the shared hierarchy.
 *
 * Can be used in two modes:
 * 1. Standalone: createWebSocketACPServer() creates its own HTTP server
 * 2. Shared: setupACPWebSocket() attaches to an existing WebSocketServer
 *
 * Also supports MAP protocol via createCombinedWebSocketServer() which handles
 * both ACP (/acp) and MAP (/map) paths on the same server.
 */

import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import { AgentSideConnection } from "@agentclientprotocol/sdk";
import type { AgentManager } from "../agent/agent-manager.js";
import type { EventStore } from "../store/event-store.js";
import type { TaskManager } from "../task/task-manager.js";
import type { PeerManager } from "../peer/peer-manager.js";
import type { CapabilityManager } from "../peer/capability-manager.js";
import type { MAPAdapter } from "../map/adapter/interface.js";
import { MacroAgent } from "./macro-agent.js";
import { webSocketStream } from "./websocket-stream.js";
import { createMAPWebSocketHandler, type MAPWebSocketHandler } from "../map/adapter/websocket-integration.js";

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
 * WebSocket ACP Server interface (standalone mode)
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

/**
 * WebSocket ACP handler interface (shared server mode)
 */
export interface ACPWebSocketHandler {
  /** Get the number of active connections */
  getConnectionCount(): number;

  /** Close all connections gracefully */
  closeAll(): void;
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
// Shared Server Mode (setupACPWebSocket)
// ─────────────────────────────────────────────────────────────────

/**
 * Set up ACP WebSocket handling on an existing WebSocketServer.
 *
 * Use this when you want to share an HTTP server with other services.
 * The WebSocketServer should be created with `noServer: true`.
 *
 * @param wss - WebSocketServer instance (noServer mode)
 * @param services - Shared services (AgentManager, EventStore, etc.)
 * @param config - Configuration options
 * @returns Handler for managing connections
 */
export function setupACPWebSocket(
  wss: WebSocketServer,
  services: ACPServices,
  config: { defaultCwd?: string } = {}
): ACPWebSocketHandler {
  const { defaultCwd = process.cwd() } = config;
  const connections = new Set<TrackedConnection>();

  // Handle new WebSocket connections
  wss.on("connection", (ws: WebSocket, req) => {
    console.error(
      `[ws-acp] New connection from ${req.socket.remoteAddress}`
    );

    // Create the ACP stream adapter
    const stream = webSocketStream(ws);

    // Create the MacroAgent for this connection
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

  return {
    getConnectionCount(): number {
      return connections.size;
    },

    closeAll(): void {
      console.error(`[ws-acp] Closing ${connections.size} connections...`);
      for (const tracked of connections) {
        if (tracked.ws.readyState === WebSocket.OPEN) {
          tracked.ws.close(1001, "Server shutting down");
        }
      }
      connections.clear();
    },
  };
}

// ─────────────────────────────────────────────────────────────────
// Standalone Server Mode (createWebSocketACPServer)
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

// ─────────────────────────────────────────────────────────────────
// Combined Server Mode (ACP + MAP)
// ─────────────────────────────────────────────────────────────────

/**
 * Configuration for the combined WebSocket server
 */
export interface CombinedWebSocketServerConfig {
  /** Port to listen on */
  port: number;

  /** Host to bind to (default: "localhost") */
  host?: string;

  /** URL path for ACP connections (default: "/acp") */
  acpPath?: string;

  /** URL path for MAP connections (default: "/map") */
  mapPath?: string;

  /** Default working directory for ACP sessions */
  defaultCwd?: string;
}

/**
 * Combined WebSocket Server interface
 */
export interface CombinedWebSocketServer {
  /** Start the server */
  start(): Promise<void>;

  /** Stop the server gracefully */
  stop(): Promise<void>;

  /** Get the number of active ACP connections */
  getACPConnectionCount(): number;

  /** Get the number of active MAP connections */
  getMAPConnectionCount(): number;

  /** Get the total number of connections */
  getConnectionCount(): number;

  /** Get the ACP server URL */
  getACPUrl(): string;

  /** Get the MAP server URL */
  getMAPUrl(): string;

  /** HTTP server */
  readonly httpServer: http.Server;

  /** WebSocket server */
  readonly wss: WebSocketServer;

  /** MAP handler (for testing) */
  readonly mapHandler: MAPWebSocketHandler;
}

/**
 * Create a combined WebSocket server that handles both ACP and MAP protocols.
 *
 * This server listens on a single port and routes connections based on URL path:
 * - /acp -> ACP protocol (internal agent communication)
 * - /map -> MAP protocol (external client access)
 *
 * @param services - Shared services for ACP
 * @param mapAdapter - MAPAdapter instance for MAP protocol
 * @param config - Server configuration
 */
export function createCombinedWebSocketServer(
  services: ACPServices,
  mapAdapter: MAPAdapter,
  config: CombinedWebSocketServerConfig
): CombinedWebSocketServer {
  const {
    port,
    host = "localhost",
    acpPath = "/acp",
    mapPath = "/map",
    defaultCwd = process.cwd(),
  } = config;

  // Track ACP connections
  const acpConnections = new Set<TrackedConnection>();

  // Create MAP handler
  const mapHandler = createMAPWebSocketHandler(mapAdapter);

  // Create HTTP server
  const httpServer = http.createServer((req, res) => {
    // Health check endpoint
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          acpConnections: acpConnections.size,
          mapConnections: mapHandler.getConnectionCount(),
          timestamp: Date.now(),
        })
      );
      return;
    }

    // Default response for non-WebSocket requests
    res.writeHead(426, { "Content-Type": "text/plain" });
    res.end("Upgrade Required - This endpoint accepts WebSocket connections on /acp or /map");
  });

  // Create WebSocket server with noServer for manual upgrade handling
  const wss = new WebSocketServer({ noServer: true });

  // Handle upgrade requests manually to route by path
  httpServer.on("upgrade", (req, socket, head) => {
    const url = req.url ?? "";

    if (url === mapPath || url.startsWith(`${mapPath}?`) || url.startsWith(`${mapPath}/`)) {
      // MAP protocol connection
      wss.handleUpgrade(req, socket, head, (ws) => {
        mapHandler.handleConnection(ws, req);
      });
    } else if (url === acpPath || url.startsWith(`${acpPath}?`) || url.startsWith(`${acpPath}/`)) {
      // ACP protocol connection
      wss.handleUpgrade(req, socket, head, (ws) => {
        handleACPConnection(ws, req);
      });
    } else {
      // Unknown path - reject
      console.error(`[ws] Rejected connection to unknown path: ${url}`);
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
    }
  });

  // Handle ACP connection (extracted for clarity)
  function handleACPConnection(ws: WebSocket, req: http.IncomingMessage): void {
    console.error(`[ws-acp] New connection from ${req.socket.remoteAddress}`);

    const stream = webSocketStream(ws);

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

    const tracked: TrackedConnection = {
      ws,
      acpConnection,
      macroAgent: macroAgent!,
      createdAt: Date.now(),
    };
    acpConnections.add(tracked);

    ws.on("close", (code, reason) => {
      console.error(
        `[ws-acp] Connection closed: code=${code}, reason=${reason.toString()}`
      );
      acpConnections.delete(tracked);
    });

    ws.on("error", (err) => {
      console.error(`[ws-acp] Connection error:`, err);
      acpConnections.delete(tracked);
    });
  }

  // Handle server errors
  wss.on("error", (err) => {
    console.error(`[ws] WebSocket server error:`, err);
  });

  // ─────────────────────────────────────────────────────────────────
  // Server Lifecycle
  // ─────────────────────────────────────────────────────────────────

  async function start(): Promise<void> {
    // Ensure MAPAdapter is running
    if (!mapAdapter.isRunning()) {
      await mapAdapter.start();
    }

    return new Promise((resolve, reject) => {
      httpServer.on("error", reject);
      httpServer.listen(port, host, () => {
        httpServer.removeListener("error", reject);
        console.error(`[ws] Combined server listening on ${host}:${port}`);
        console.error(`[ws]   ACP: ws://${host}:${port}${acpPath}`);
        console.error(`[ws]   MAP: ws://${host}:${port}${mapPath}`);
        resolve();
      });
    });
  }

  async function stop(): Promise<void> {
    console.error(
      `[ws] Shutting down, closing ${acpConnections.size} ACP and ${mapHandler.getConnectionCount()} MAP connections...`
    );

    // Close ACP connections
    for (const tracked of acpConnections) {
      if (tracked.ws.readyState === WebSocket.OPEN) {
        tracked.ws.close(1001, "Server shutting down");
      }
    }
    acpConnections.clear();

    // Close MAP connections
    mapHandler.closeAll();

    // Stop MAPAdapter
    if (mapAdapter.isRunning()) {
      await mapAdapter.stop();
    }

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

    console.error(`[ws] Server stopped`);
  }

  function getACPConnectionCount(): number {
    return acpConnections.size;
  }

  function getMAPConnectionCount(): number {
    return mapHandler.getConnectionCount();
  }

  function getConnectionCount(): number {
    return acpConnections.size + mapHandler.getConnectionCount();
  }

  function getACPUrl(): string {
    return `ws://${host}:${port}${acpPath}`;
  }

  function getMAPUrl(): string {
    return `ws://${host}:${port}${mapPath}`;
  }

  return {
    start,
    stop,
    getACPConnectionCount,
    getMAPConnectionCount,
    getConnectionCount,
    getACPUrl,
    getMAPUrl,
    httpServer,
    wss,
    mapHandler,
  };
}
