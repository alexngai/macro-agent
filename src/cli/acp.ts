#!/usr/bin/env node
/**
 * Multi-Agent Server Entry Point
 *
 * Runs macro-agent as a full server with ACP + MAP + REST support.
 * This is the primary entry point for running macro-agent.
 *
 * Usage:
 *   multiagent [options]
 *
 * Options:
 *   --cwd <path>       Working directory for agents
 *   --port <port>      Port for server (default: 3001)
 *   --host <host>      Host for server (default: localhost)
 *   --acp              Stdio ACP-only mode (for embedded use with acp-factory)
 *
 * Examples:
 *   # Full server mode (default): WebSocket ACP + MAP + REST API
 *   multiagent
 *   multiagent --port 8080
 *   multiagent --host 0.0.0.0 --port 3001
 *
 *   # Stdio ACP-only mode (for spawning via acp-factory)
 *   multiagent --acp
 *   multiagent --acp --cwd /path/to/project
 *
 * Server endpoints (default mode):
 *   ws://host:port/acp      - ACP protocol (WebSocket)
 *   ws://host:port/map      - MAP protocol (WebSocket)
 *   ws://host:port/api/ws   - Real-time subscriptions (WebSocket)
 *   http://host:port/api/*  - REST API endpoints
 *   http://host:port/health - Health check
 *
 * For embedded use with acp-factory:
 *   AgentFactory.register('macro-agent', {
 *     command: 'npx',
 *     args: ['multiagent', '--acp'],
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
import {
  createActivityWatcher,
  subscribeAgentToEvents,
  MONITOR_DEFAULT_EVENT_TYPES,
  type ActivityWatcher,
} from "../activity/index.js";
import {
  createWakeHandler,
  createSessionProviderFromAgentManager,
} from "../agent/wake.js";

// ─────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────

export interface ACPServerOptions {
  /** Working directory for agents */
  cwd?: string;
  /** Stdio ACP-only mode (for embedded use with acp-factory) */
  acp?: boolean;
  /** Port for server (default: 3001) */
  port?: number;
  /** Host for server (default: localhost) */
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
    } else if (args[i] === "--acp") {
      options.acp = true;
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

  // Create ActivityWatcher for event-driven agent waking
  const sessionProvider = createSessionProviderFromAgentManager(agentManager);
  const wakeHandler = createWakeHandler(sessionProvider, agentManager);
  const activityWatcher: ActivityWatcher = createActivityWatcher(
    {
      listAgents: () => agentManager.list(),
      getAgent: (id) => agentManager.get(id),
    },
    wakeHandler
  );

  // Wire EventStore events to ActivityWatcher
  eventStore.onAgentChange((agentId, agent) => {
    if (!activityWatcher.isRunning()) return;
    if (!agent) return; // Agent was deleted

    // Infer event type from agent state
    const eventType = agent.state === "spawning" ? "agent_spawned"
      : agent.state === "running" ? "agent_started"
      : agent.state === "stopped" ? "agent_terminated"
      : "agent_updated";

    activityWatcher.processActivity({
      id: `evt-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      type: eventType,
      source: { agent_id: agentId, role: agent.role },
      timestamp: Date.now(),
      details: { state: agent.state },
    });
  });

  eventStore.onTaskChange((taskId, task) => {
    if (!activityWatcher.isRunning()) return;
    if (!task) return; // Task was deleted

    // Infer event type from task status
    const eventType = task.status === "pending" ? "task_created"
      : task.status === "assigned" ? "task_assigned"
      : task.status === "in_progress" ? "task_started"
      : task.status === "completed" ? "task_completed"
      : task.status === "failed" ? "task_failed"
      : "task_updated";

    activityWatcher.processActivity({
      id: `evt-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      type: eventType,
      source: { agent_id: task.assigned_agent ?? undefined, task_id: taskId },
      timestamp: Date.now(),
      details: { status: task.status },
    });
  });

  // Start the ActivityWatcher
  activityWatcher.start();

  // Auto-subscribe Monitor agents to health events when they spawn
  agentManager.onLifecycleEvent((event) => {
    if (event.type === "spawned") {
      const agent = event.agent;
      // Check if this is a Monitor agent
      if (agent.role === "monitor" || agent.role?.startsWith("monitor.")) {
        subscribeAgentToEvents(
          activityWatcher,
          agent.id,
          MONITOR_DEFAULT_EVENT_TYPES,
          undefined, // No scope filter - monitor sees all
          "high"     // High priority for health events
        );
        console.error(`[acp] Auto-subscribed Monitor ${agent.id} to health events`);
      }
    }
  });

  // Combined server (when --ws is enabled)
  let combinedServer: CombinedServer | undefined;

  // Cleanup function
  const cleanup = async () => {
    // Stop ActivityWatcher
    activityWatcher.stop();

    // Stop combined server if running
    if (combinedServer) {
      await combinedServer.stop();
    }
    await agentManager.close();
    await eventStore.close();
  };

  try {
    // Handle graceful shutdown
    process.on("SIGINT", async () => {
      await cleanup();
      process.exit(0);
    });

    process.on("SIGTERM", async () => {
      await cleanup();
      process.exit(0);
    });

    if (options.acp) {
      // Stdio ACP-only mode (for embedded use with acp-factory)
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
    } else {
      // Full server mode (default): WebSocket ACP + MAP + REST API
      const host = options.host ?? "localhost";
      const port = options.port ?? 3001;

      combinedServer = createCombinedServer(
        { eventStore, agentManager, taskManager, messageRouter, activityWatcher },
        { port, host, defaultCwd }
      );

      await combinedServer.start();

      // Keep process alive - will exit via SIGINT/SIGTERM handlers
      await new Promise<void>(() => {
        // Never resolves - process stays alive until signal
      });
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
