/**
 * WebSocket ACP Server — Multi-client WebSocket transport for the ACP protocol.
 *
 * Accepts WebSocket connections, creates a bidirectional Stream for each,
 * and wires up an AgentSideConnection with the macro-agent ACP handler.
 *
 * Also provides a /health HTTP endpoint.
 *
 * @module acp/websocket-server
 */

import { WebSocketServer, WebSocket } from "ws";
import * as http from "node:http";
import {
  AgentSideConnection,
  type Stream,
  type AnyMessage,
} from "@agentclientprotocol/sdk";
import { createMacroAgent } from "./macro-agent.js";
import type { MacroAgentSystemV2 } from "../boot-v2.js";
import type { MacroAgentInitConfig } from "./types.js";

// ─────────────────────────────────────────────────────────────────
// Public Interface
// ─────────────────────────────────────────────────────────────────

export interface WebSocketACPServer {
  /** Start listening for connections */
  start(): Promise<void>;

  /** Stop the server and close all connections */
  stop(): Promise<void>;

  /** Number of active WebSocket connections */
  getConnectionCount(): number;

  /** The URL the server is listening on */
  getUrl(): string;
}

export interface WebSocketACPServerConfig {
  port?: number;
  host?: string;
  path?: string;
  initConfig?: MacroAgentInitConfig;
}

// ─────────────────────────────────────────────────────────────────
// Stream Adapter
// ─────────────────────────────────────────────────────────────────

/**
 * Adapt a WebSocket into an ACP Stream (readable + writable).
 */
function webSocketStream(ws: WebSocket): Stream {
  const readable = new ReadableStream<AnyMessage>({
    start(controller) {
      ws.on("message", (data: Buffer | string) => {
        try {
          const parsed = JSON.parse(data.toString()) as AnyMessage;
          controller.enqueue(parsed);
        } catch {
          // Ignore malformed messages
        }
      });
      ws.on("close", () => {
        try {
          controller.close();
        } catch {
          // Already closed
        }
      });
      ws.on("error", (err) => {
        try {
          controller.error(err);
        } catch {
          // Already errored
        }
      });
    },
  });

  const writable = new WritableStream<AnyMessage>({
    write(chunk) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(chunk));
      }
    },
  });

  return { readable, writable };
}

// ─────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────

export function createWebSocketACPServer(
  system: MacroAgentSystemV2,
  config?: WebSocketACPServerConfig,
): WebSocketACPServer {
  const port = config?.port ?? 3001;
  const host = config?.host ?? "127.0.0.1";
  const wsPath = config?.path ?? "/acp";
  const initConfig = config?.initConfig;

  let httpServer: http.Server | null = null;
  let wss: WebSocketServer | null = null;
  const connections = new Set<AgentSideConnection>();
  const webSockets = new Set<WebSocket>();
  let resolvedUrl = "";

  return {
    async start(): Promise<void> {
      httpServer = http.createServer((req, res) => {
        if (req.url === "/health" && req.method === "GET") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              status: "ok",
              connections: webSockets.size,
              timestamp: new Date().toISOString(),
            }),
          );
          return;
        }
        res.writeHead(404);
        res.end("Not Found");
      });

      wss = new WebSocketServer({
        server: httpServer,
        path: wsPath,
      });

      wss.on("connection", (ws: WebSocket) => {
        webSockets.add(ws);

        const stream = webSocketStream(ws);

        const conn = new AgentSideConnection(
          (agentConn) =>
            createMacroAgent(agentConn, {
              system,
              initConfig,
            }),
          stream,
        );
        connections.add(conn);

        ws.on("close", () => {
          webSockets.delete(ws);
          connections.delete(conn);
        });

        ws.on("error", () => {
          webSockets.delete(ws);
          connections.delete(conn);
        });
      });

      await new Promise<void>((resolve, reject) => {
        httpServer!.on("error", reject);
        httpServer!.listen(port, host, () => {
          const addr = httpServer!.address();
          if (addr && typeof addr === "object") {
            resolvedUrl = `ws://${addr.address}:${addr.port}${wsPath}`;
          } else {
            resolvedUrl = `ws://${host}:${port}${wsPath}`;
          }
          resolve();
        });
      });
    },

    async stop(): Promise<void> {
      // Close all WebSocket connections
      for (const ws of webSockets) {
        try {
          ws.close(1001, "Server shutting down");
        } catch {
          // Best effort
        }
      }
      webSockets.clear();
      connections.clear();

      // Close WebSocket server
      if (wss) {
        await new Promise<void>((resolve) => {
          wss!.close(() => resolve());
        });
        wss = null;
      }

      // Close HTTP server
      if (httpServer) {
        await new Promise<void>((resolve) => {
          httpServer!.close(() => resolve());
        });
        httpServer = null;
      }
    },

    getConnectionCount(): number {
      return webSockets.size;
    },

    getUrl(): string {
      return resolvedUrl;
    },
  };
}
