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
import type { SessionChecker, WakeDecision } from "../router/wake.js";
import type { AgentId, EventId } from "../store/types/index.js";

// ─────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────

import { parseArgs } from "./parse-args.js";
import { getStableInstanceId } from "./stable-instance-id.js";
import { loadMergedConfig } from "../config/project-config.js";

// Re-export utilities for backwards compatibility
export { parseArgs, type ACPServerOptions } from "./parse-args.js";
export { getStableInstanceId } from "./stable-instance-id.js";

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
  // Use explicit --instance-id if provided, otherwise derive a stable ID from the CWD
  // so the same project always reuses the same EventStore across server restarts
  const instanceId = options.instanceId ?? getStableInstanceId(defaultCwd);
  const eventStore = await createEventStore({
    inMemory: false,
    instanceId,
  });

  // We need to create agentManager first (with a placeholder router),
  // then wire the sessionChecker/wakeHandler into the router,
  // then update agentManager with the real router.
  // However, to avoid circular dependency, we'll create the session checker
  // lazily since it only needs agentManager methods.

  // Create a deferred agentManager reference for the session checker
  let agentManager: ReturnType<typeof createAgentManager>;

  // Create session checker that the MessageRouter uses to decide wake actions
  const sessionChecker: SessionChecker = {
    hasActiveSession(agentId: AgentId): boolean {
      return agentManager?.hasActiveSession(agentId) ?? false;
    },
    isPrompting(agentId: AgentId): boolean {
      return agentManager?.isPrompting(agentId) ?? false;
    },
    supportsInjection(_agentId: AgentId): boolean {
      // Default to true; actual injection support is checked during inject()
      return true;
    },
    isStopped(agentId: AgentId): boolean {
      const agent = agentManager?.get(agentId);
      return agent?.state === "stopped";
    },
  };

  // Create wake handler that the MessageRouter calls when messages should wake agents
  const routerWakeHandler = async (
    agentId: AgentId,
    decision: WakeDecision,
    messageId: EventId
  ): Promise<void> => {
    if (!agentManager) return;

    const session = agentManager.getSession(agentId);
    if (!session) {
      // No session, message is queued - agent will see it on next check_messages
      console.error(`[acp] Message ${messageId} queued for agent ${agentId} (no session)`);
      return;
    }

    // Format the message notification
    const message = `[New Message Received]\nMessage ID: ${messageId}\nUse check_messages to read your pending messages.`;

    if (decision.shouldInterrupt) {
      // Interrupt the current work
      try {
        const iterable = session.interruptWith(message);
        const iterator = iterable[Symbol.asyncIterator]();
        await iterator.next(); // Start the interrupt
        console.error(`[acp] Interrupted agent ${agentId} for message ${messageId}`);
      } catch (error) {
        console.error(`[acp] Failed to interrupt agent ${agentId}:`, error);
      }
    } else if (decision.action === "inject") {
      // Try to inject into current session
      try {
        const result = await session.inject(message);
        if (result.success) {
          console.error(`[acp] Injected message notification to agent ${agentId}`);
        } else {
          console.error(`[acp] Injection not supported for agent ${agentId}, message queued`);
        }
      } catch (error) {
        console.error(`[acp] Failed to inject to agent ${agentId}:`, error);
      }
    } else if (decision.shouldWake) {
      // Wake the agent by starting a new prompt
      try {
        const promptIterable = agentManager.prompt(agentId, message);
        // Fire and forget - just start the iteration
        (async () => {
          try {
            for await (const _ of promptIterable) {
              break; // Exit after first update
            }
          } catch {
            // Ignore background errors
          }
        })();
        console.error(`[acp] Woke agent ${agentId} for message ${messageId}`);
      } catch (error) {
        console.error(`[acp] Failed to wake agent ${agentId}:`, error);
      }
    }
  };

  const messageRouter = createMessageRouter(eventStore, {
    sessionChecker,
    wakeHandler: routerWakeHandler,
  });

  // Compute server URL for thin-client MCP mode (only in server mode, not stdio ACP)
  const serverUrl = options.acp
    ? undefined
    : `http://${options.host ?? "localhost"}:${options.port ?? 3001}`;

  // Load merged config (global → project → env vars)
  const mergedConfig = loadMergedConfig(defaultCwd);

  // Set up authentication tokens from merged config
  const noAuth = options.noAuth || mergedConfig.auth?.disabled === true;
  let serverToken: string | undefined;
  let agentTokenManager: import("../auth/token.js").AgentTokenManager | undefined;

  if (!noAuth && mergedConfig.auth?.secret) {
    const { AgentTokenManager } = await import("../auth/token.js");
    serverToken = mergedConfig.auth.secret;
    agentTokenManager = new AgentTokenManager();
  }

  // Now create the agentManager with the real router
  agentManager = createAgentManager(eventStore, messageRouter, {
    serverUrl,
    serverToken: serverUrl ? serverToken : undefined,
    agentTokenManager: serverUrl ? agentTokenManager : undefined,
    taskBackend: mergedConfig.task?.backend,
    openTasksSocketPath: mergedConfig.task?.opentasks?.socket_path,
  });
  const taskManager = createTaskManager(eventStore);

  // Create task backend for dynamic task tools (create_task, get_task, etc.)
  const { createTaskBackend, loadTaskConfigFromMerged } = await import("../task/backend/index.js");
  const { UnifiedTaskToolProvider } = await import("../task/backend/unified-tool-provider.js");

  let taskBackend: import("../task/backend/types.js").TaskBackend | undefined;
  let taskToolProvider: import("../task/backend/types.js").TaskToolProvider | undefined;

  // Mutable context holder for the task tool provider. Bridge handlers set
  // this before each tool call so the provider uses the calling agent's ID.
  // Safe because Node.js is single-threaded.
  const taskToolContext = { agent_id: "" as string };

  try {
    const taskConfig = loadTaskConfigFromMerged(mergedConfig);
    const result = await createTaskBackend(taskConfig, eventStore);
    taskBackend = result.backend;

    taskToolProvider = new UnifiedTaskToolProvider(
      taskBackend,
      () => taskToolContext,
      result.openTasksClient
    );
    console.error(`[acp] Task backend created: ${taskConfig.backend.type}`);
  } catch (err) {
    console.error(`[acp] Failed to create task backend: ${err}. Task tools will be unavailable.`);
  }

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
        { eventStore, agentManager, taskManager, messageRouter, activityWatcher, taskBackend, taskToolProvider, taskToolContext, agentTokenManager },
        { port, host, defaultCwd, serverToken, noAuth }
      );

      await combinedServer.start();
      if (serverToken) {
        console.error(`[acp] Server token: ${serverToken.substring(0, 8)}...`);
      } else {
        console.error(`[acp] Auth disabled (--no-auth)`);
      }

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
