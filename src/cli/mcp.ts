#!/usr/bin/env node
/**
 * MCP Server CLI Entry Point
 *
 * Runs the MCP server as a subprocess that agents can connect to.
 * Agent context is passed via environment variables.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { createEventStore } from "../store/event-store.js";
import { createAgentManager } from "../agent/agent-manager.js";
import { createTaskManager } from "../task/task-manager.js";
import { createMessageRouter } from "../router/message-router.js";
import { createMCPServer } from "../mcp/mcp-server.js";
import {
  createActivityWatcher,
  subscribeAgentToEvents,
  MONITOR_DEFAULT_EVENT_TYPES,
} from "../activity/index.js";
import {
  createWakeHandler,
  createSessionProviderFromAgentManager,
} from "../agent/wake.js";

// Debug logging to file (since stderr doesn't show up from MCP subprocess)
const debugLogPath = path.join(os.tmpdir(), "macro-agent-mcp-debug.log");
function debugLog(message: string) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${message}\n`;
  fs.appendFileSync(debugLogPath, line);
  console.error(message); // Also log to stderr in case it's visible
}

async function main() {
  // Get agent context from environment variables
  const agentId = process.env.MACRO_AGENT_ID;
  const parentId = process.env.MACRO_PARENT_ID || null;
  const taskId = process.env.MACRO_TASK_ID;
  const agentCwd = process.env.MACRO_AGENT_CWD || process.cwd();
  const instanceId = process.env.MACRO_INSTANCE_ID;
  const baseDir = process.env.MACRO_BASE_DIR; // Optional: custom base directory for testing

  if (!agentId) {
    console.error("Error: MACRO_AGENT_ID environment variable is required");
    process.exit(1);
  }

  if (!instanceId) {
    console.error("Error: MACRO_INSTANCE_ID environment variable is required");
    process.exit(1);
  }

  debugLog(`[MCP] Starting MCP server for agent ${agentId} with instanceId ${instanceId}`);
  debugLog(`[MCP] Debug log file: ${debugLogPath}`);

  try {
    // Initialize services with shared file-based storage using the same instanceId as the main process
    // If MACRO_BASE_DIR is provided (e.g., for testing), use it to resolve to the correct database location
    const eventStore = await createEventStore({ inMemory: false, instanceId, baseDir });
    debugLog(`[MCP] EventStore created, path: ${eventStore.instancePath}`);
    const messageRouter = createMessageRouter(eventStore);
    const agentManager = createAgentManager(eventStore, messageRouter);
    const taskManager = createTaskManager(eventStore);

    // Get agent lineage for authorization checks
    // Note: The agent may not be in the store yet if the MCP server starts before
    // the spawn event is persisted. This is a race condition - we retry a few times.
    let agent = eventStore.getAgent(agentId);
    const allAgentsInitial = eventStore.listAgents();
    debugLog(`[MCP] Initial check: agent found = ${!!agent}, total agents in store = ${allAgentsInitial.length}`);
    if (allAgentsInitial.length > 0) {
      debugLog(`[MCP] Agents in store: ${allAgentsInitial.map(a => a.id).join(', ')}`);
    }

    if (!agent) {
      // Retry a few times with small delays to handle race condition
      // where MCP server starts before spawn event is persisted
      for (let i = 0; i < 10; i++) {
        await new Promise(resolve => setTimeout(resolve, 100));
        // Reload from SQLite to get fresh data
        await eventStore.reload();
        agent = eventStore.getAgent(agentId);
        const allAgentsRetry = eventStore.listAgents();
        debugLog(`[MCP] Retry ${i + 1}: agent found = ${!!agent}, total agents = ${allAgentsRetry.length}`);
        if (agent) {
          debugLog(`[MCP] Found agent ${agentId} after ${i + 1} retries`);
          break;
        }
      }
    } else {
      debugLog(`[MCP] Agent ${agentId} found immediately (no retry needed)`);
    }

    if (!agent) {
      debugLog(`[MCP] Warning: Agent ${agentId} not found in store after retries. ` +
        `Continuing with limited context. This may affect authorization checks.`);
      // List all events to help debug
      const events = eventStore.query({ limit: 50 });
      debugLog(`[MCP] Events in store (${events.length}): ${events.map(e => `${e.type}:${e.payload?.agent_id || e.source?.agent_id}`).join(', ')}`);
    }

    const lineage = agent?.lineage ?? [];

    // Create ActivityWatcher for wait_for_activity MCP tool
    const sessionProvider = createSessionProviderFromAgentManager(agentManager);
    const wakeHandler = createWakeHandler(sessionProvider, agentManager);
    const activityWatcher = createActivityWatcher(
      {
        listAgents: () => agentManager.list(),
        getAgent: (id) => agentManager.get(id),
      },
      wakeHandler
    );

    // Wire EventStore events to ActivityWatcher
    eventStore.onAgentChange((changedAgentId, changedAgent) => {
      if (!activityWatcher.isRunning()) return;
      if (!changedAgent) return; // Agent was deleted

      // Infer event type from agent state
      const eventType = changedAgent.state === "spawning" ? "agent_spawned"
        : changedAgent.state === "running" ? "agent_started"
        : changedAgent.state === "stopped" ? "agent_terminated"
        : "agent_updated";

      activityWatcher.processActivity({
        id: `evt-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        type: eventType,
        source: { agent_id: changedAgentId, role: changedAgent.role },
        timestamp: Date.now(),
        details: { state: changedAgent.state },
      });
    });

    eventStore.onTaskChange((changedTaskId, task) => {
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
        source: { agent_id: task.assigned_agent ?? undefined, task_id: changedTaskId },
        timestamp: Date.now(),
        details: { status: task.status },
      });
    });

    // Start the ActivityWatcher
    activityWatcher.start();

    // Auto-subscribe Monitor agents to health events when they spawn
    agentManager.onLifecycleEvent((event) => {
      if (event.type === "spawned") {
        const spawnedAgent = event.agent;
        // Check if this is a Monitor agent
        if (spawnedAgent.role === "monitor" || spawnedAgent.role?.startsWith("monitor.")) {
          subscribeAgentToEvents(
            activityWatcher,
            spawnedAgent.id,
            MONITOR_DEFAULT_EVENT_TYPES,
            undefined, // No scope filter - monitor sees all
            "high"     // High priority for health events
          );
          debugLog(`[MCP] Auto-subscribed Monitor ${spawnedAgent.id} to health events`);
        }
      }
    });

    // Read team config from EventStore (stored by TeamRuntime.initialize)
    let teamTaskMode: string | undefined;
    const teamEvents = eventStore.query({ type: "status", limit: 50 });
    const teamConfigEvent = teamEvents.find(
      (e) => e.payload?.team_config != null
    );
    if (teamConfigEvent?.payload?.team_config) {
      const tc = teamConfigEvent.payload.team_config as Record<string, unknown>;
      teamTaskMode = tc.taskMode as string | undefined;
      debugLog(`[MCP] Found team config: team=${tc.teamName}, strategy=${tc.strategy}, taskMode=${tc.taskMode}`);
    }

    // Register team roles in local RoleRegistry for capability checks
    const roleRegistry = agentManager.getRoleRegistry();
    let integrationStrategy: import("../workspace/strategies/types.js").IntegrationStrategy | undefined;

    if (teamConfigEvent?.payload?.team_config) {
      const tc = teamConfigEvent.payload.team_config as Record<string, unknown>;

      // Register serialized team roles (stored by TeamRuntime.initialize)
      const roles = tc.roles as Record<string, { name: string; capabilities: string[] }> | undefined;
      if (roles) {
        for (const roleDef of Object.values(roles)) {
          roleRegistry.registerRole(roleDef as import("../roles/types.js").RoleDefinition);
        }
        debugLog(`[MCP] Registered ${Object.keys(roles).length} team roles in RoleRegistry`);
      }

      // Instantiate integration strategy from team config
      const strategyName = tc.strategy as string | undefined;
      if (strategyName) {
        try {
          const { defaultStrategyRegistry } = await import("../workspace/strategies/registry.js");
          integrationStrategy = defaultStrategyRegistry.get(
            strategyName,
            tc.strategyConfig as Record<string, unknown> | undefined
          );
          debugLog(`[MCP] Instantiated '${strategyName}' integration strategy`);
        } catch (err) {
          debugLog(`[MCP] Failed to instantiate strategy '${strategyName}': ${err}`);
        }
      }
    }

    // Create MCP server with agent context
    const mcpServer = createMCPServer(
      {
        agent_id: agentId,
        session_id: agent?.session_id ?? "",
        task_id: taskId ?? undefined,
        lineage,
        cwd: agentCwd,
      },
      {
        eventStore,
        agentManager,
        taskManager,
        messageRouter,
        activityWatcher,
        taskMode: teamTaskMode as "push" | "pull" | undefined,
        roleRegistry,
        integrationStrategy,
      }
    );

    // Start the MCP server (uses stdio transport)
    await mcpServer.start();

    // Handle graceful shutdown
    process.on("SIGINT", async () => {
      activityWatcher.stop();
      await mcpServer.close();
      await eventStore.close();
      process.exit(0);
    });

    process.on("SIGTERM", async () => {
      activityWatcher.stop();
      await mcpServer.close();
      await eventStore.close();
      process.exit(0);
    });
  } catch (error) {
    console.error(`Failed to start MCP server: ${error}`);
    process.exit(1);
  }
}

main();
