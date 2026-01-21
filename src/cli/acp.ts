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
 *   --api              Enable API server (WebSocket ACP + REST API on same port)
 *   --port <port>      Port for API server (default: 3001)
 *   --host <host>      Host for API server (default: localhost)
 *
 * Examples:
 *   # Stdio ACP only (default, for embedded use)
 *   multiagent-acp
 *
 *   # API server: WebSocket ACP + REST API
 *   multiagent-acp --api
 *   multiagent-acp --api --port 8080
 *   multiagent-acp --api --host 0.0.0.0 --port 3001
 *
 * API server endpoints:
 *   ws://host:port/acp      - ACP protocol (WebSocket)
 *   ws://host:port/api/ws   - Real-time subscriptions (WebSocket)
 *   http://host:port/api/*  - REST API endpoints
 *   http://host:port/health - Health check
 *
 * Or register with acp-factory:
 *   AgentFactory.register('macro-agent', {
 *     command: 'npx',
 *     args: ['multiagent-acp'],
 *   });
 */

import { Readable } from "node:stream";
import {
  AgentSideConnection,
  ndJsonStream,
} from "@agentclientprotocol/sdk";
import { createEventStore } from "../store/event-store.js";
import { createAgentManager } from "../agent/agent-manager.js";
import { createTaskManager } from "../task/task-manager.js";
import { createMessageRouter } from "../router/message-router.js";
import { MacroAgent } from "../acp/macro-agent.js";
import {
  createCombinedServer,
  type CombinedServer,
} from "../server/combined-server.js";

// ─────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────

export interface ACPServerOptions {
  /** Working directory for agents */
  cwd?: string;
  /** Enable API server (WebSocket ACP + REST API) */
  api?: boolean;
  /** Port for API server (default: 3001) */
  port?: number;
  /** Host for API server (default: localhost) */
  host?: string;
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
    }
  }

  return options;
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

  // Combined server (when --ws is enabled)
  let combinedServer: CombinedServer | undefined;

  // Cleanup function
  const cleanup = async () => {
    // Stop combined server if running
    if (combinedServer) {
      await combinedServer.stop();
    }
    await agentManager.close();
    await eventStore.close();
  };

  try {
    // Start combined server if --api is enabled
    if (options.api) {
      const host = options.host ?? "localhost";
      const port = options.port ?? 3001;

      combinedServer = createCombinedServer(
        { eventStore, agentManager, taskManager, messageRouter },
        { port, host, defaultCwd }
      );

      await combinedServer.start();
    }

    // Handle graceful shutdown
    process.on("SIGINT", async () => {
      await cleanup();
      process.exit(0);
    });

    process.on("SIGTERM", async () => {
      await cleanup();
      process.exit(0);
    });

    // Determine if we should run stdio ACP
    // Skip stdio ACP if:
    // 1. MACRO_AGENT_SERVER_ONLY env var is set (spawned by MacroAgentServerManager)
    // 2. Or stdin detection fails (fallback)
    const serverOnlyEnv = process.env.MACRO_AGENT_SERVER_ONLY === "1";
    const skipStdioAcp = options.api && serverOnlyEnv;

    if (skipStdioAcp) {
      // WebSocket-only mode: just keep the process alive until shutdown signal
      console.error("[acp] Running in server-only mode (stdin not connected)");

      // Keep process alive - will exit via SIGINT/SIGTERM handlers
      await new Promise<void>(() => {
        // Never resolves - process stays alive until signal
      });
    } else {
      // Standard mode: set up stdio ACP connection
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

      // Wait for connection to close
      await connection.closed;

      // Clean up on normal close
      await cleanup();
    }
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
