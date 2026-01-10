#!/usr/bin/env node
/**
 * ACP Server CLI Entry Point
 *
 * Runs macro-agent as an ACP-compliant agent that can be spawned
 * and controlled via the Agent Communication Protocol.
 *
 * Usage:
 *   multiagent-acp [options]
 *
 * Options:
 *   --cwd <path>       Working directory for agents
 *   --api              Enable HTTP API server alongside ACP
 *   --port <port>      Port for HTTP API server (auto-discovers if not specified)
 *   --host <host>      Host for HTTP API server (default: localhost)
 *   --ws               Enable WebSocket ACP server for multi-client support
 *   --ws-port <port>   Port for WebSocket ACP server (default: 3001)
 *   --ws-host <host>   Host for WebSocket ACP server (default: localhost)
 *
 * Examples:
 *   # Stdio ACP only (default)
 *   multiagent-acp
 *
 *   # WebSocket ACP for multi-client support
 *   multiagent-acp --ws --ws-port 3001
 *
 *   # All transports: stdio + WebSocket ACP + HTTP API
 *   multiagent-acp --ws --ws-port 3001 --api --port 3000
 *
 * Or register with acp-factory:
 *   AgentFactory.register('macro-agent', {
 *     command: 'npx',
 *     args: ['multiagent-acp'],
 *   });
 */

import { Readable, Writable } from "node:stream";
import { createServer } from "node:net";
import {
  AgentSideConnection,
  ndJsonStream,
} from "@agentclientprotocol/sdk";
import { createEventStore } from "../store/event-store.js";
import { createAgentManager } from "../agent/agent-manager.js";
import { createTaskManager } from "../task/task-manager.js";
import { createMessageRouter } from "../router/message-router.js";
import { MacroAgent } from "../acp/macro-agent.js";
import { createAPIServer, type APIServer } from "../api/server.js";
import {
  createWebSocketACPServer,
  type WebSocketACPServer,
} from "../acp/websocket-server.js";

// ─────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────

export interface ACPServerOptions {
  /** Working directory for agents */
  cwd?: string;
  /** Enable HTTP API server */
  api?: boolean;
  /** Port for HTTP API server (auto-discovers if not specified) */
  port?: number;
  /** Host for HTTP API server */
  host?: string;
  /** Enable WebSocket ACP server for multi-client support */
  ws?: boolean;
  /** Port for WebSocket ACP server */
  wsPort?: number;
  /** Host for WebSocket ACP server */
  wsHost?: string;
}

/**
 * Parse command line arguments.
 * @param argv Optional array of arguments (defaults to process.argv.slice(2))
 */
export function parseArgs(argv?: string[]): ACPServerOptions {
  const args = argv ?? process.argv.slice(2);
  const options: ACPServerOptions = {};

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--cwd" && args[i + 1]) {
      options.cwd = args[i + 1];
      i++;
    } else if (args[i] === "--api") {
      options.api = true;
    } else if (args[i] === "--port" && args[i + 1]) {
      options.port = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === "--host" && args[i + 1]) {
      options.host = args[i + 1];
      i++;
    } else if (args[i] === "--ws") {
      options.ws = true;
    } else if (args[i] === "--ws-port" && args[i + 1]) {
      options.wsPort = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === "--ws-host" && args[i + 1]) {
      options.wsHost = args[i + 1];
      i++;
    }
  }

  return options;
}

// ─────────────────────────────────────────────────────────────────
// Port Auto-Discovery
// ─────────────────────────────────────────────────────────────────

/**
 * Find an available port by letting the OS assign one.
 * Creates a temporary server, gets the assigned port, then closes it.
 */
export async function findAvailablePort(host: string = "localhost"): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, host, () => {
      const address = server.address();
      if (address && typeof address === "object") {
        const port = address.port;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error("Failed to get port")));
      }
    });
    server.on("error", reject);
  });
}

// ─────────────────────────────────────────────────────────────────
// Stream Setup
// ─────────────────────────────────────────────────────────────────

/**
 * Create web streams from Node.js stdin/stdout
 */
function createStdioStreams(): {
  input: ReadableStream<Uint8Array>;
  output: WritableStream<Uint8Array>;
} {
  // Convert Node.js streams to Web Streams
  const input = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;

  const output = new WritableStream<Uint8Array>({
    write(chunk) {
      return new Promise((resolve, reject) => {
        const canContinue = process.stdout.write(chunk, (err) => {
          if (err) reject(err);
          else if (canContinue) resolve();
        });
        if (!canContinue) {
          process.stdout.once("drain", resolve);
        }
      });
    },
  });

  return { input, output };
}

// ─────────────────────────────────────────────────────────────────
// Main Entry Point
// ─────────────────────────────────────────────────────────────────

async function main() {
  const options = parseArgs();
  const defaultCwd = options.cwd ?? process.cwd();

  // Initialize services
  const eventStore = await createEventStore({ inMemory: false });
  const messageRouter = createMessageRouter(eventStore);
  const agentManager = createAgentManager(eventStore, messageRouter);
  const taskManager = createTaskManager(eventStore);

  // Optional servers
  let apiServer: APIServer | undefined;
  let wsAcpServer: WebSocketACPServer | undefined;

  // Cleanup function
  const cleanup = async () => {
    // Stop WebSocket ACP server first if running
    if (wsAcpServer) {
      await wsAcpServer.stop();
    }
    // Stop API server if running
    if (apiServer) {
      await apiServer.stop();
    }
    await agentManager.close();
    await eventStore.close();
  };

  try {
    // Start WebSocket ACP server if enabled
    if (options.ws) {
      const wsHost = options.wsHost ?? "localhost";
      const wsPort = options.wsPort ?? 3001;

      wsAcpServer = createWebSocketACPServer(
        { eventStore, agentManager, taskManager },
        { port: wsPort, host: wsHost, defaultCwd }
      );

      await wsAcpServer.start();

      // Log to stderr (stdout is reserved for ACP protocol)
      console.error(`WebSocket ACP server listening on ${wsAcpServer.getUrl()}`);
    }

    // Start HTTP API server if enabled
    if (options.api) {
      const host = options.host ?? "localhost";
      const port = options.port ?? (await findAvailablePort(host));

      apiServer = createAPIServer(
        { eventStore, agentManager, taskManager, messageRouter },
        { port, host }
      );

      await apiServer.start();

      // Log port to stderr (stdout is reserved for ACP protocol)
      console.error(`HTTP API server listening on http://${host}:${port}`);
    }

    // Create stdio streams for ACP communication
    const { input, output } = createStdioStreams();
    const stream = ndJsonStream(output, input);

    // Create ACP connection with MacroAgent
    const connection = new AgentSideConnection(
      (conn) =>
        new MacroAgent(conn, {
          agentManager,
          eventStore,
          taskManager,
          defaultCwd,
        }),
      stream
    );

    // Handle graceful shutdown
    process.on("SIGINT", async () => {
      await cleanup();
      process.exit(0);
    });

    process.on("SIGTERM", async () => {
      await cleanup();
      process.exit(0);
    });

    // Wait for connection to close
    await connection.closed;

    // Clean up on normal close
    await cleanup();
  } catch (error) {
    // Log errors to stderr (not stdout, which is used for ACP)
    console.error(`ACP server error: ${error}`);

    // Attempt cleanup
    try {
      await cleanup();
    } catch {
      // Ignore cleanup errors
    }

    process.exit(1);
  }
}

main();
