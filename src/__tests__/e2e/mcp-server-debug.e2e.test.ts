/**
 * MCP Server Debug E2E Test
 *
 * This test debugs why MCP servers aren't being started when agents are spawned.
 * It investigates the flow from AgentManager.spawn() through acp-factory to
 * claude-code-acp to understand where MCP server configuration is lost.
 *
 * REQUIRES: RUN_FULL_AGENT_TESTS=true environment variable
 *
 * Run with:
 *   RUN_FULL_AGENT_TESTS=true npm run test:e2e -- src/__tests__/e2e/mcp-server-debug.e2e.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

import { createEventStore, type EventStore } from "../../store/event-store.js";
import { createAgentManager, type AgentManager } from "../../agent/agent-manager.js";
import { createMessageRouter, type MessageRouter } from "../../router/message-router.js";

// ─────────────────────────────────────────────────────────────────
// Test Configuration
// ─────────────────────────────────────────────────────────────────

const RUN_FULL_AGENT = !!process.env.RUN_FULL_AGENT_TESTS;
const testFn = RUN_FULL_AGENT ? it : it.skip;

const log = (msg: string) => console.log(`[MCP-Debug] ${msg}`);

// ─────────────────────────────────────────────────────────────────
// MCP Server Debug Tests
// ─────────────────────────────────────────────────────────────────

describe("MCP Server Debug", () => {
  let eventStore: EventStore;
  let agentManager: AgentManager;
  let messageRouter: MessageRouter;
  let eventStoreDbPath: string;
  let tmpDir: string;

  beforeEach(async () => {
    if (!RUN_FULL_AGENT) return;

    // Use file-based EventStore with instanceId + baseDir so MCP subprocess can access the same database
    // The MCP subprocess uses MACRO_INSTANCE_ID and MACRO_BASE_DIR to resolve to the same location
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-debug-"));
    const instanceId = `test-mcp-debug-${Date.now()}`;
    log(`EventStore baseDir: ${tmpDir}, instanceId: ${instanceId}`);
    // Store the path for reference (actual DB will be at tmpDir/instances/instanceId/store.sqlite)
    eventStoreDbPath = path.join(tmpDir, "instances", instanceId, "store.sqlite");
    log(`EventStore DB path: ${eventStoreDbPath}`);

    eventStore = await createEventStore({ instanceId, baseDir: tmpDir });
    messageRouter = createMessageRouter(eventStore);
    agentManager = createAgentManager(eventStore, messageRouter, {
      defaultPermissionMode: "auto-approve",
      defaultCwd: process.cwd(),
    });
  });

  afterEach(async () => {
    if (!RUN_FULL_AGENT) return;

    // Terminate all agents
    try {
      for (const agent of agentManager.list()) {
        if (agent.state === "running") {
          await agentManager.terminate(agent.id, "test_cleanup");
        }
      }
    } catch {
      // Ignore
    }

    await agentManager?.close();
    await eventStore?.close();

    // Cleanup temp directory
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  testFn(
    "debug: inspect available tools after agent spawn",
    async () => {
      log("Spawning agent...");

      const spawnResult = await agentManager.spawn({
        task: "List your available MCP tools",
        role: "worker",
        streamId: "debug-stream",
        cwd: process.cwd(),
      });

      log(`Agent spawned: ${spawnResult.id}`);
      log(`Session ID: ${spawnResult.session_id}`);

      // Prompt the agent and collect the available_commands_update
      log("Prompting agent to inspect tools...");

      interface AvailableCommand {
        name: string;
        description?: string;
      }

      let availableCommands: AvailableCommand[] = [];
      let updateCount = 0;

      for await (const update of agentManager.prompt(
        spawnResult.id,
        "What MCP tools do you have available? List all tools that start with 'mcp__'. If you have a 'done' tool, describe it."
      )) {
        updateCount++;
        const updateObj = update as Record<string, unknown>;
        const updateType = updateObj.sessionUpdate as string;

        if (updateType === "available_commands_update") {
          availableCommands = (updateObj.availableCommands ?? []) as AvailableCommand[];

          log(`\n=== Available Commands (${availableCommands.length} total) ===`);

          // Categorize tools
          const mcpTools = availableCommands.filter((c) => c.name.startsWith("mcp__"));
          const builtinTools = availableCommands.filter((c) => !c.name.startsWith("mcp__") && !c.name.startsWith("/"));
          const slashCommands = availableCommands.filter((c) => c.name.startsWith("/"));

          log(`\nMCP Tools (${mcpTools.length}):`);
          if (mcpTools.length === 0) {
            log("  ⚠️  NO MCP TOOLS FOUND - This is the bug!");
          } else {
            for (const tool of mcpTools) {
              log(`  - ${tool.name}`);
            }
          }

          log(`\nBuiltin Tools (${builtinTools.length}):`);
          for (const tool of builtinTools.slice(0, 10)) {
            log(`  - ${tool.name}`);
          }
          if (builtinTools.length > 10) {
            log(`  ... and ${builtinTools.length - 10} more`);
          }

          log(`\nSlash Commands (${slashCommands.length}):`);
          for (const cmd of slashCommands) {
            log(`  - ${cmd.name}`);
          }
        }

        // Log agent's text response about tools
        if (updateType === "agent_message_chunk") {
          const content = updateObj.content as { text?: string } | undefined;
          if (content?.text) {
            process.stdout.write(content.text);
          }
        }
      }

      log(`\n\nTotal updates received: ${updateCount}`);

      // Check for MCP tools
      const mcpTools = availableCommands.filter((c) => c.name.startsWith("mcp__"));
      const hasDoneTool = availableCommands.some((c) =>
        c.name.includes("done") || c.name.includes("macro")
      );

      log(`\n=== Summary ===`);
      log(`MCP tools available: ${mcpTools.length}`);
      log(`Has done-like tool: ${hasDoneTool}`);

      // This test is for debugging - we expect it to fail until MCP is fixed
      if (mcpTools.length === 0) {
        log("\n⚠️  BUG CONFIRMED: No MCP tools available to agent");
        log("The mcpServers configuration passed to createSession() is not being used");
      }

      // Terminate agent
      await agentManager.terminate(spawnResult.id, "debug_complete");
      log("Agent terminated");

      // For now, just verify we got the available_commands_update
      expect(availableCommands.length).toBeGreaterThan(0);
    },
    { timeout: 120000 }
  );

  testFn(
    "debug: verify agent calls done() with promptUntilDone",
    async () => {
      // Test the new promptUntilDone functionality that automatically
      // follows up to ensure agents call done()

      log("Spawning agent...");
      const spawnResult = await agentManager.spawn({
        task: "Create a simple greeting function",
        role: "worker",
        streamId: "debug-stream",
        cwd: process.cwd(),
      });

      log(`Agent spawned: ${spawnResult.id}`);

      // Use promptUntilDone which will follow up if done() isn't called
      log("Prompting agent with follow-up support...");

      const result = await agentManager.promptUntilDone(
        spawnResult.id,
        `Create a file called /tmp/test-greeting-${Date.now()}.ts with a simple function that returns "Hello".
Then commit your changes and call done() with status "completed".

Remember: You MUST call done() when finished.`,
        {
          maxFollowUps: 2,
          onUpdate: (update) => {
            const updateObj = update as Record<string, unknown>;
            if (updateObj.sessionUpdate === "agent_message_chunk") {
              const content = updateObj.content as { text?: string } | undefined;
              if (content?.text) {
                process.stdout.write(content.text);
              }
            }
          },
        }
      );

      log(`\n\n=== promptUntilDone Result ===`);
      log(`done() called: ${result.doneCalled}`);
      log(`done() status: ${result.doneStatus ?? "N/A"}`);
      log(`Total updates: ${result.updates.length}`);

      // Check EventStore for status events
      const statusEvents = eventStore.query({ type: "status" });
      const workerDoneEvent = statusEvents.find(
        (e) =>
          e.source?.agent_id === spawnResult.id &&
          (e.payload?.status_type === "completed" ||
           e.payload?.status_type === "failed")
      );
      log(`Status event in EventStore: ${workerDoneEvent ? "YES" : "NO"}`);
      if (workerDoneEvent) {
        log(`Status: ${workerDoneEvent.payload?.status_type}`);
        log(`Summary: ${workerDoneEvent.payload?.summary}`);
      }

      // Check agent state
      const agent = agentManager.get(spawnResult.id);
      log(`Agent state: ${agent?.state}`);

      // Cleanup
      if (agent?.state === "running") {
        await agentManager.terminate(spawnResult.id, "debug_complete");
      }

      // The test passes if we got updates - done() calling is what we're debugging
      expect(result.updates.length).toBeGreaterThan(0);

      // Report if done() wasn't called even with follow-up
      if (!result.doneCalled) {
        log("\n⚠️  Agent did not call done() even after follow-up prompts");
        log("This indicates the model isn't following done() instructions");
      } else {
        log("\n✓ Agent successfully called done()!");
      }
    },
    { timeout: 180000 }
  );
});
