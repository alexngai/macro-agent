/**
 * Combined Server
 *
 * Single HTTP server that hosts both:
 * - WebSocket ACP protocol on /acp
 * - REST API + WebSocket subscriptions on /api/*
 */

import http from "http";
import express, { Express } from "express";
import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "http";
import type { Duplex } from "stream";
import type { EventStore } from "../store/event-store.js";
import type { AgentManager } from "../agent/agent-manager.js";
import type { TaskManager } from "../task/task-manager.js";
import type { MessageRouter } from "../router/message-router.js";
import type { PeerManager } from "../peer/peer-manager.js";
import type { CapabilityManager } from "../peer/capability-manager.js";
import { setupACPWebSocket } from "../acp/websocket-server.js";
import { createAPIApp, setupAPIWebSocket } from "../api/server.js";

// ─────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────

export interface CombinedServerServices {
  eventStore: EventStore;
  agentManager: AgentManager;
  taskManager: TaskManager;
  messageRouter: MessageRouter;
  peerManager?: PeerManager;
  capabilityManager?: CapabilityManager;
}

export interface CombinedServerConfig {
  /** Port to listen on (default: 3001) */
  port?: number;

  /** Host to bind to (default: "localhost") */
  host?: string;

  /** Default working directory for ACP sessions */
  defaultCwd?: string;

  /** Enable CORS for REST API (default: true) */
  cors?: boolean;
}

export interface CombinedServer {
  /** Start the server */
  start(): Promise<void>;

  /** Stop the server gracefully */
  stop(): Promise<void>;

  /** Get the server URL */
  getUrl(): string;

  /** Get number of ACP connections */
  getACPConnectionCount(): number;

  /** HTTP server */
  readonly httpServer: http.Server;

  /** Express app */
  readonly app: Express;
}

// ─────────────────────────────────────────────────────────────────
// Server Implementation
// ─────────────────────────────────────────────────────────────────

export function createCombinedServer(
  services: CombinedServerServices,
  config: CombinedServerConfig = {}
): CombinedServer {
  const {
    port = 3001,
    host = "localhost",
    defaultCwd = process.cwd(),
    cors = true,
  } = config;

  // Create Express app with API routes
  const app = createAPIApp(services, { cors });

  // Create HTTP server with Express
  const httpServer = http.createServer(app);

  // Create WebSocket servers in noServer mode
  const acpWss = new WebSocketServer({ noServer: true });
  const apiWss = new WebSocketServer({ noServer: true });

  // Set up ACP WebSocket handling
  const acpHandler = setupACPWebSocket(acpWss, services, { defaultCwd });

  // Set up API WebSocket handling (pass app to share state)
  const apiHandler = setupAPIWebSocket(apiWss, services, app);

  // Handle upgrade requests - route by path
  httpServer.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const pathname = new URL(request.url ?? "/", `http://${request.headers.host}`).pathname;

    if (pathname === "/acp") {
      acpWss.handleUpgrade(request, socket, head, (ws) => {
        acpWss.emit("connection", ws, request);
      });
    } else if (pathname === "/api/ws") {
      apiWss.handleUpgrade(request, socket, head, (ws) => {
        apiWss.emit("connection", ws, request);
      });
    } else {
      // Unknown WebSocket path
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
    }
  });

  // Add health endpoint
  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      acp_connections: acpHandler.getConnectionCount(),
      timestamp: Date.now(),
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Server Lifecycle
  // ─────────────────────────────────────────────────────────────────

  async function start(): Promise<void> {
    return new Promise((resolve, reject) => {
      httpServer.on("error", reject);
      httpServer.listen(port, host, () => {
        httpServer.removeListener("error", reject);
        console.error(`[combined] Server listening on http://${host}:${port}`);
        console.error(`[combined]   ACP WebSocket: ws://${host}:${port}/acp`);
        console.error(`[combined]   API WebSocket: ws://${host}:${port}/api/ws`);
        console.error(`[combined]   REST API: http://${host}:${port}/api/*`);
        resolve();
      });
    });
  }

  async function stop(): Promise<void> {
    console.error(`[combined] Shutting down...`);

    // Close ACP connections
    acpHandler.closeAll();

    // Close API WebSocket connections
    apiHandler.closeAll();

    // Close WebSocket servers
    await Promise.all([
      new Promise<void>((resolve) => acpWss.close(() => resolve())),
      new Promise<void>((resolve) => apiWss.close(() => resolve())),
    ]);

    // Close HTTP server
    await new Promise<void>((resolve, reject) => {
      httpServer.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    console.error(`[combined] Server stopped`);
  }

  function getUrl(): string {
    return `http://${host}:${port}`;
  }

  function getACPConnectionCount(): number {
    return acpHandler.getConnectionCount();
  }

  return {
    start,
    stop,
    getUrl,
    getACPConnectionCount,
    httpServer,
    app,
  };
}
