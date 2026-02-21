#!/usr/bin/env node
/**
 * MCP Server CLI Entry Point
 *
 * Runs the MCP server as a subprocess that agents can connect to.
 * Agent context is passed via environment variables.
 *
 * Two modes:
 * - **Thin-client mode** (MACRO_SERVER_URL set): Tools forward to the main server
 *   via ephemeral MAP WebSocket connections. No local services needed.
 * - **Legacy mode** (MACRO_INSTANCE_ID set): Creates a full local service stack
 *   with shared SQLite. Used as fallback for backward compatibility.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// Debug logging to file (since stderr doesn't show up from MCP subprocess)
const debugLogPath = path.join(os.tmpdir(), "macro-agent-mcp-debug.log");
function debugLog(message: string) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${message}\n`;
  fs.appendFileSync(debugLogPath, line);
  console.error(message); // Also log to stderr in case it's visible
}

// =============================================================================
// Thin-Client Mode (MACRO_SERVER_URL)
// =============================================================================

async function startThinClient() {
  const agentId = process.env.MACRO_AGENT_ID!;
  const taskId = process.env.MACRO_TASK_ID;
  const agentCwd = process.env.MACRO_AGENT_CWD || process.cwd();
  const serverUrl = process.env.MACRO_SERVER_URL!;
  const lineageStr = process.env.MACRO_AGENT_LINEAGE || "[]";
  const sessionId = process.env.MACRO_SESSION_ID || "";
  const serverToken = process.env.MACRO_SERVER_TOKEN || "";
  const agentToken = process.env.MACRO_AGENT_TOKEN || "";

  let lineage: string[];
  try {
    lineage = JSON.parse(lineageStr);
  } catch {
    lineage = [];
  }

  debugLog(`[MCP] Thin-client mode: agent=${agentId}, server=${serverUrl}`);

  const { createMCPServerThinClient } = await import("../mcp/mcp-server.js");
  const { mapCall } = await import("../mcp/map-client.js");

  const context = {
    agent_id: agentId,
    session_id: sessionId,
    task_id: taskId ?? undefined,
    lineage,
    cwd: agentCwd,
    agent_token: agentToken || undefined,
  };

  // Also pass permission mode for spawn_agent forwarding
  const permissionMode = process.env.MACRO_PERMISSION_MODE;

  // Build mapCall options with server token for WebSocket auth
  const callOptions = serverToken ? { serverToken } : undefined;

  const mcpServer = createMCPServerThinClient(
    context,
    async (method, params, options) => {
      // Merge auth options with per-call options
      const mergedOptions = { ...callOptions, ...options };
      // Inject permission_mode into spawn_agent calls
      if (method === "_macro/mcp/spawn_agent" && permissionMode) {
        const p = (params ?? {}) as Record<string, unknown>;
        p.permission_mode = permissionMode;
        return mapCall(serverUrl, method, p, mergedOptions);
      }
      return mapCall(serverUrl, method, params, mergedOptions);
    }
  );

  await mcpServer.start();

  // Handle graceful shutdown
  const shutdown = async () => {
    await mcpServer.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// =============================================================================
// Legacy Mode (MACRO_INSTANCE_ID)
// =============================================================================

async function startLegacy() {
  const agentId = process.env.MACRO_AGENT_ID!;
  const taskId = process.env.MACRO_TASK_ID;
  const agentCwd = process.env.MACRO_AGENT_CWD || process.cwd();
  const instanceId = process.env.MACRO_INSTANCE_ID!;
  const baseDir = process.env.MACRO_BASE_DIR;

  debugLog(`[MCP] Legacy mode: agent=${agentId}, instanceId=${instanceId}`);
  debugLog(`[MCP] Debug log file: ${debugLogPath}`);

  const { createEventStore } = await import("../store/event-store.js");
  const { createAgentManager } = await import("../agent/agent-manager.js");
  const { createTaskManager } = await import("../task/task-manager.js");
  const { createMessageRouter } = await import("../router/message-router.js");
  const { createMCPServer } = await import("../mcp/mcp-server.js");
  const { createTaskBackend, loadTaskConfigFromEnv } = await import("../task/backend/index.js");
  const { UnifiedTaskToolProvider } = await import("../task/backend/unified-tool-provider.js");
  const {
    createActivityWatcher,
    subscribeAgentToEvents,
    MONITOR_DEFAULT_EVENT_TYPES,
  } = await import("../activity/index.js");
  const {
    createWakeHandler,
    createSessionProviderFromAgentManager,
  } = await import("../agent/wake.js");

  // Initialize services with shared file-based storage
  const eventStore = await createEventStore({ inMemory: false, instanceId, baseDir });
  debugLog(`[MCP] EventStore created, path: ${eventStore.instancePath}`);
  const messageRouter = createMessageRouter(eventStore);
  const agentManager = createAgentManager(eventStore, messageRouter);
  const taskManager = createTaskManager(eventStore);

  // Create task backend from env config
  const taskConfig = loadTaskConfigFromEnv();
  let taskBackend: import("../task/backend/types.js").TaskBackend | undefined;
  let taskToolProvider: InstanceType<typeof UnifiedTaskToolProvider> | undefined;
  let openTasksClient: import("../task/backend/opentasks/client.js").OpenTasksClient | undefined;

  try {
    const result = await createTaskBackend(taskConfig, eventStore);
    taskBackend = result.backend;
    openTasksClient = result.openTasksClient;

    taskToolProvider = new UnifiedTaskToolProvider(
      taskBackend,
      () => ({ agent_id: agentId! }),
      openTasksClient
    );
    debugLog(`[MCP] Task backend created: ${taskConfig.backend.type}`);
  } catch (err) {
    debugLog(`[MCP] Failed to create task backend: ${err}. Falling back to legacy TaskManager only.`);
  }

  // Get agent lineage for authorization checks
  let agent = eventStore.getAgent(agentId);
  const allAgentsInitial = eventStore.listAgents();
  debugLog(`[MCP] Initial check: agent found = ${!!agent}, total agents in store = ${allAgentsInitial.length}`);
  if (allAgentsInitial.length > 0) {
    debugLog(`[MCP] Agents in store: ${allAgentsInitial.map(a => a.id).join(', ')}`);
  }

  if (!agent) {
    for (let i = 0; i < 10; i++) {
      await new Promise(resolve => setTimeout(resolve, 100));
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
    if (!changedAgent) return;

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
    if (!task) return;

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

  activityWatcher.start();

  // Auto-subscribe Monitor agents to health events when they spawn
  agentManager.onLifecycleEvent((event) => {
    if (event.type === "spawned") {
      const spawnedAgent = event.agent;
      if (spawnedAgent.role === "monitor" || spawnedAgent.role?.startsWith("monitor.")) {
        subscribeAgentToEvents(
          activityWatcher,
          spawnedAgent.id,
          MONITOR_DEFAULT_EVENT_TYPES,
          undefined,
          "high"
        );
        debugLog(`[MCP] Auto-subscribed Monitor ${spawnedAgent.id} to health events`);
      }
    }
  });

  // Read team config from EventStore (scoped by MACRO_TEAM_NAME for multi-team)
  let teamTaskMode: string | undefined;
  const myTeamName = process.env.MACRO_TEAM_NAME;
  const teamEvents = eventStore.query({ type: "status", limit: 50 });
  const teamConfigEvent = teamEvents.find((e) => {
    const tc = e.payload?.team_config as Record<string, unknown> | undefined;
    if (!tc) return false;
    // If agent has a team name, find that specific team's config
    if (myTeamName) return tc.teamName === myTeamName;
    // Fallback: first team_config found (backward compat)
    return true;
  });
  if (teamConfigEvent?.payload?.team_config) {
    const tc = teamConfigEvent.payload.team_config as Record<string, unknown>;
    teamTaskMode = tc.taskMode as string | undefined;
    debugLog(`[MCP] Found team config: team=${tc.teamName}, strategy=${tc.strategy}, taskMode=${tc.taskMode}`);
  }

  // Register team roles in local RoleRegistry
  const roleRegistry = agentManager.getRoleRegistry();
  let integrationStrategy: import("../workspace/strategies/types.js").IntegrationStrategy | undefined;

  if (teamConfigEvent?.payload?.team_config) {
    const tc = teamConfigEvent.payload.team_config as Record<string, unknown>;

    const roles = tc.roles as Record<string, { name: string; capabilities: string[] }> | undefined;
    if (roles) {
      for (const roleDef of Object.values(roles)) {
        roleRegistry.registerRole(roleDef as import("../roles/types.js").RoleDefinition);
      }
      debugLog(`[MCP] Registered ${Object.keys(roles).length} team roles in RoleRegistry`);
    }

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
      taskBackend,
      taskToolProvider,
    }
  );

  await mcpServer.start();

  // Handle graceful shutdown
  process.on("SIGINT", async () => {
    activityWatcher.stop();
    try { openTasksClient?.disconnect(); } catch { /* ignore */ }
    await mcpServer.close();
    await eventStore.close();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    activityWatcher.stop();
    try { openTasksClient?.disconnect(); } catch { /* ignore */ }
    await mcpServer.close();
    await eventStore.close();
    process.exit(0);
  });
}

// =============================================================================
// Main
// =============================================================================

async function main() {
  const agentId = process.env.MACRO_AGENT_ID;
  const serverUrl = process.env.MACRO_SERVER_URL;
  const instanceId = process.env.MACRO_INSTANCE_ID;

  if (!agentId) {
    console.error("Error: MACRO_AGENT_ID environment variable is required");
    process.exit(1);
  }

  try {
    if (serverUrl) {
      // Thin-client mode: forward tool calls to main server via MAP WebSocket
      await startThinClient();
    } else if (instanceId) {
      // Legacy mode: create full local service stack with shared SQLite
      await startLegacy();
    } else {
      console.error("Error: Either MACRO_SERVER_URL or MACRO_INSTANCE_ID environment variable is required");
      process.exit(1);
    }
  } catch (error) {
    console.error(`Failed to start MCP server: ${error}`);
    process.exit(1);
  }
}

main();
