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
    const eventStore = await createEventStore({ inMemory: false, instanceId });
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
      }
    );

    // Start the MCP server (uses stdio transport)
    await mcpServer.start();

    // Handle graceful shutdown
    process.on("SIGINT", async () => {
      await mcpServer.close();
      await eventStore.close();
      process.exit(0);
    });

    process.on("SIGTERM", async () => {
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
