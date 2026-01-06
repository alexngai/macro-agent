#!/usr/bin/env node
/**
 * ACP Server CLI Entry Point
 *
 * Runs macro-agent as an ACP-compliant agent that can be spawned
 * and controlled via the Agent Communication Protocol.
 *
 * Usage:
 *   multiagent-acp [--cwd <path>]
 *
 * Or register with acp-factory:
 *   AgentFactory.register('macro-agent', {
 *     command: 'npx',
 *     args: ['multiagent-acp'],
 *   });
 */

import { Readable, Writable } from "node:stream";
import {
  AgentSideConnection,
  ndJsonStream,
} from "@agentclientprotocol/sdk";
import { createEventStore } from "../store/event-store.js";
import { createAgentManager } from "../agent/agent-manager.js";
import { createTaskManager } from "../task/task-manager.js";
import { createMessageRouter } from "../router/message-router.js";
import { MacroAgent } from "../acp/macro-agent.js";

// ─────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────

interface ACPServerOptions {
  /** Working directory for agents */
  cwd?: string;
}

function parseArgs(): ACPServerOptions {
  const args = process.argv.slice(2);
  const options: ACPServerOptions = {};

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--cwd" && args[i + 1]) {
      options.cwd = args[i + 1];
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

  // Cleanup function
  const cleanup = async () => {
    await agentManager.close();
    await eventStore.close();
  };

  try {
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
