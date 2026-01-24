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
    "debug: verify agent can actually call done() MCP tool",
    async () => {
      // The previous test showed the agent KNOWS about MCP tools but they
      // don't appear in available_commands_update. Let's verify the agent
      // can actually CALL the done() tool.

      log("Spawning agent...");
      const spawnResult = await agentManager.spawn({
        task: "Test done() tool",
        role: "worker",
        streamId: "debug-stream",
        cwd: process.cwd(),
      });

      log(`Agent spawned: ${spawnResult.id}`);

      // Track tool calls
      const toolCalls: Array<{ name: string; status: string }> = [];
      let doneToolCalled = false;

      log("Prompting agent to call done()...");

      for await (const update of agentManager.prompt(
        spawnResult.id,
        `You MUST call the mcp__macro-agent__done tool right now with status "completed" and summary "Test complete".

Do not do anything else. Just call done() immediately.

Call: mcp__macro-agent__done with {"status": "completed", "summary": "Test complete"}`
      )) {
        const updateObj = update as Record<string, unknown>;
        const updateType = updateObj.sessionUpdate as string;

        // Track tool calls
        if (updateType === "tool_call") {
          const toolName = (updateObj.tool as { name?: string })?.name ?? "unknown";
          toolCalls.push({ name: toolName, status: "started" });
          log(`Tool call started: ${toolName}`);

          if (toolName.includes("done") || toolName.includes("macro")) {
            doneToolCalled = true;
            log(`✓ done() tool was called!`);
          }
        }

        if (updateType === "tool_call_update") {
          const status = updateObj.status as string;
          const toolCallId = updateObj.toolCallId as string;
          if (status === "completed" || status === "error") {
            log(`Tool ${toolCallId} ${status}`);
          }
        }

        // Log agent text
        if (updateType === "agent_message_chunk") {
          const content = updateObj.content as { text?: string } | undefined;
          if (content?.text) {
            process.stdout.write(content.text);
          }
        }
      }

      log(`\n\n=== Tool Calls Summary ===`);
      for (const tc of toolCalls) {
        log(`  - ${tc.name}`);
      }
      log(`done() called: ${doneToolCalled}`);

      // Check if agent state changed
      const agent = agentManager.get(spawnResult.id);
      log(`Agent state after prompt: ${agent?.state}`);

      // Check EventStore for done event
      const doneEvents = eventStore.query({ type: "done" });
      const agentDoneEvent = doneEvents.find(
        (e) => e.payload?.agentId === spawnResult.id
      );
      log(`Done event in EventStore: ${agentDoneEvent ? "YES" : "NO"}`);

      if (agentDoneEvent) {
        log(`Done event payload: ${JSON.stringify(agentDoneEvent.payload)}`);
      }

      // Cleanup
      if (agent?.state === "running") {
        await agentManager.terminate(spawnResult.id, "debug_complete");
      }

      // Report findings
      if (!doneToolCalled) {
        log("\n⚠️  Agent did not call done() tool");
        log("Tool calls made: " + toolCalls.map((t) => t.name).join(", "));
      }

      expect(toolCalls.length).toBeGreaterThan(0);
    },
    { timeout: 120000 }
  );
});
