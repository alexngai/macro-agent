#!/usr/bin/env node
/**
 * MCP Server CLI Entry Point
 *
 * Runs the MCP server as a subprocess that agents can connect to.
 * Agent context is passed via environment variables.
 */

import { createEventStore } from "../store/event-store.js";
import { createAgentManager } from "../agent/agent-manager.js";
import { createTaskManager } from "../task/task-manager.js";
import { createMessageRouter } from "../router/message-router.js";
import { createMCPServer } from "../mcp/mcp-server.js";

async function main() {
  // Get agent context from environment variables
  const agentId = process.env.MACRO_AGENT_ID;
  const parentId = process.env.MACRO_PARENT_ID || null;
  const taskId = process.env.MACRO_TASK_ID;
  const agentCwd = process.env.MACRO_AGENT_CWD || process.cwd();

  if (!agentId) {
    console.error("Error: MACRO_AGENT_ID environment variable is required");
    process.exit(1);
  }

  try {
    // Initialize services with shared file-based storage
    const eventStore = await createEventStore({ inMemory: false });
    const messageRouter = createMessageRouter(eventStore);
    const agentManager = createAgentManager(eventStore, messageRouter);
    const taskManager = createTaskManager(eventStore);

    // Get agent lineage for authorization checks
    const agent = eventStore.getAgent(agentId);
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
