/**
 * MCP Tools Availability E2E Test
 *
 * Verifies that agents spawned through acp-factory have access to the
 * macro-agent MCP tools. This tests the full chain:
 *   agent-manager → acp-factory → claude-code-acp → Claude Agent SDK → MCP subprocess
 *
 * REQUIRES: RUN_FULL_AGENT_TESTS=true environment variable
 *
 * Run with:
 *   RUN_FULL_AGENT_TESTS=true npm run test:e2e -- src/__tests__/e2e/mcp-tools-available.e2e.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execSync } from "child_process";

import { createEventStore, type EventStore } from "../../store/event-store.js";
import {
  createAgentManager,
  type AgentManager,
} from "../../agent/agent-manager.js";
import {
  createMessageRouter,
  type MessageRouter,
} from "../../router/message-router.js";

// ─────────────────────────────────────────────────────────────────
// Test Configuration
// ─────────────────────────────────────────────────────────────────

const RUN_FULL_AGENT = !!process.env.RUN_FULL_AGENT_TESTS;
const testFn = RUN_FULL_AGENT ? it : it.skip;

// MCP server name as configured in agent-manager.ts
const MCP_SERVER_NAME = "macro-agent";

// Core coordination tools always registered for any agent role
const EXPECTED_CORE_TOOLS = [
  "done",
  "spawn_agent",
  "emit_status",
  "send_message",
  "check_messages",
  "get_hierarchy",
  "get_agent_summary",
  "query_index",
  "inject_context",
  "wait_for_activity",
];

// Peer communication tools (registered when PeerManager is available)
const PEER_TOOLS = [
  "send_peer_message",
  "send_peer_request",
  "respond_to_peer_request",
];

// Role-gated tools that may not be available to all roles
const ROLE_GATED_TOOLS = [
  "stop_agent", // requires agent.terminate capability
];

// Task backend tools (memory backend, push mode) — registered via taskToolProvider
const TASK_BACKEND_TOOLS = [
  "create_task",
  "get_task",
  "list_tasks",
  "assign_task",
];

/**
 * Build the full MCP tool name as it appears in Claude Code.
 * Format: mcp__<server-name>__<tool-name>
 */
function mcpToolName(tool: string): string {
  return `mcp__${MCP_SERVER_NAME}__${tool}`;
}

// ─────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────

interface ToolCallInfo {
  toolName: string;
  toolCallId: string;
  status: string;
}

/**
 * Extract tool_call events from session update stream.
 *
 * Claude Code reports MCP tool usage via session updates:
 *   { sessionUpdate: "tool_call", _meta: { claudeCode: { toolName } }, toolCallId, status }
 */
function extractToolCalls(updates: Record<string, unknown>[]): ToolCallInfo[] {
  const calls: ToolCallInfo[] = [];
  for (const update of updates) {
    if (update.sessionUpdate === "tool_call") {
      const meta = update._meta as
        | { claudeCode?: { toolName?: string } }
        | undefined;
      const toolName = meta?.claudeCode?.toolName ?? (update as { title?: string }).title ?? "unknown";
      calls.push({
        toolName,
        toolCallId: (update.toolCallId as string) ?? "",
        status: (update.status as string) ?? "",
      });
    }
  }
  return calls;
}

// ─────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────

describe("MCP Tools Availability", () => {
  let eventStore: EventStore;
  let agentManager: AgentManager;
  let messageRouter: MessageRouter;
  let tmpDir: string;
  let testRepoPath: string;

  beforeEach(async () => {
    if (!RUN_FULL_AGENT) return;

    // File-based EventStore so MCP subprocess can access the same database
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-tools-e2e-"));
    const instanceId = `test-mcp-tools-${Date.now()}`;

    // Isolated git repo for agent cwd
    testRepoPath = path.join(tmpDir, "test-repo");
    fs.mkdirSync(testRepoPath);
    execSync("git init", { cwd: testRepoPath });
    execSync('git config user.email "test@test.com"', { cwd: testRepoPath });
    execSync('git config user.name "Test User"', { cwd: testRepoPath });
    fs.writeFileSync(path.join(testRepoPath, "README.md"), "# Test Repo\n");
    execSync("git add -A", { cwd: testRepoPath });
    execSync('git commit -m "Initial commit"', { cwd: testRepoPath });

    eventStore = await createEventStore({ instanceId, baseDir: tmpDir });
    messageRouter = createMessageRouter(eventStore);
    agentManager = createAgentManager(eventStore, messageRouter, {
      defaultPermissionMode: "auto-approve",
      defaultCwd: testRepoPath,
    });
  });

  afterEach(async () => {
    if (!RUN_FULL_AGENT) return;

    // Terminate all running agents
    try {
      for (const agent of agentManager.list()) {
        if (agent.state === "running") {
          await agentManager.terminate(agent.id, "cancelled");
        }
      }
    } catch {
      // Ignore cleanup errors
    }

    await agentManager?.close();
    await eventStore?.close();

    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  testFn(
    "spawned agent can use macro-agent MCP tools (emit_status, check_messages, done)",
    async () => {
      // Spawn a worker agent
      const spawnResult = await agentManager.spawn({
        task: "Use MCP tools as instructed.",
        role: "worker",
        cwd: testRepoPath,
      });

      // Prompt the agent to call several MCP tools so we can observe tool_call events
      const allUpdates: Record<string, unknown>[] = [];

      for await (const update of agentManager.prompt(
        spawnResult.id,
        `You have access to MCP tools from the "macro-agent" server. Please do the following steps IN ORDER:

1. Call emit_status with status_type "checkpoint" and summary "mcp tool verification"
2. Call check_messages to check your inbox
3. Call done with status "completed" and summary "all tools verified"

Do these steps now. Do NOT do any other work.`,
      )) {
        allUpdates.push(update as Record<string, unknown>);
      }

      // Extract tool calls from the update stream
      const toolCalls = extractToolCalls(allUpdates);
      const toolNames = toolCalls.map((tc) => tc.toolName);

      // Log for diagnostics
      console.log(`\n[MCP Tools E2E] Total session updates: ${allUpdates.length}`);
      console.log(`[MCP Tools E2E] Tool calls observed: ${toolCalls.length}`);
      for (const tc of toolCalls) {
        console.log(`  - ${tc.toolName} (status: ${tc.status})`);
      }

      // ── Assertions ──────────────────────────────────────────────

      // Agent should have made at least one tool call
      expect(toolCalls.length).toBeGreaterThan(0);

      // Verify the tools used were macro-agent MCP tools
      const macroAgentCalls = toolNames.filter((n) =>
        n.startsWith(`mcp__${MCP_SERVER_NAME}__`),
      );
      expect(
        macroAgentCalls.length,
        "Expected at least one macro-agent MCP tool call",
      ).toBeGreaterThan(0);

      // Verify done() was called via MCP
      expect(toolNames).toContain(mcpToolName("done"));

      // Verify EventStore received the done event from MCP subprocess
      await eventStore.reload();
      const statusEvents = eventStore.query({ type: "status" });
      const doneEvent = statusEvents.find(
        (e) =>
          e.source?.agent_id === spawnResult.id &&
          e.payload?.status_type === "completed",
      );
      expect(doneEvent).toBeDefined();

      // Terminate agent (may already be stopped from done())
      const agent = agentManager.get(spawnResult.id);
      if (agent?.state === "running") {
        await agentManager.terminate(spawnResult.id, "completed");
      }
    },
    { timeout: 120_000 },
  );

  testFn(
    "spawned agent has all expected MCP tools registered",
    async () => {
      // Spawn a worker and ask it to list all its MCP tools by trying to use them.
      // We verify the tool set by asking the agent to describe its mcp__macro-agent__ tools.
      const spawnResult = await agentManager.spawn({
        task: "Report on your available MCP tools.",
        role: "worker",
        cwd: testRepoPath,
      });

      let responseText = "";
      const allUpdates: Record<string, unknown>[] = [];

      for await (const update of agentManager.prompt(
        spawnResult.id,
        `List ALL tools you have that start with "mcp__macro-agent__".
Just list them by name, one per line. Be exhaustive - include every single one.
After listing them, call done() with status "completed".`,
      )) {
        const updateObj = update as Record<string, unknown>;
        allUpdates.push(updateObj);

        // Collect text response
        if (updateObj.sessionUpdate === "agent_message_chunk") {
          const content = updateObj.content as { type?: string; text?: string } | undefined;
          if (content?.type === "text" && content?.text) {
            responseText += content.text;
          }
        }
      }

      const toolCalls = extractToolCalls(allUpdates);
      const toolNames = toolCalls.map((tc) => tc.toolName);

      console.log(`\n[MCP Tools E2E] Agent response about tools:\n${responseText}`);
      console.log(`\n[MCP Tools E2E] Tool calls made: ${toolNames.join(", ")}`);

      // The response should mention macro-agent MCP tools
      const responseLower = responseText.toLowerCase();
      expect(
        responseLower.includes("mcp__macro-agent__") || responseLower.includes("done"),
        "Agent should mention macro-agent MCP tools in response",
      ).toBe(true);

      // Verify the core tools are mentioned in the response.
      const mentionedCoreTools = EXPECTED_CORE_TOOLS.filter(
        (tool) =>
          responseLower.includes(mcpToolName(tool)) ||
          responseLower.includes(tool),
      );

      console.log(
        `[MCP Tools E2E] Core tools mentioned: ${mentionedCoreTools.length}/${EXPECTED_CORE_TOOLS.length}`,
      );
      console.log(`  Mentioned: ${mentionedCoreTools.join(", ")}`);
      const missingCoreTools = EXPECTED_CORE_TOOLS.filter(
        (t) => !mentionedCoreTools.includes(t),
      );
      if (missingCoreTools.length > 0) {
        console.log(`  Missing: ${missingCoreTools.join(", ")}`);
      }

      // All core tools should be mentioned
      expect(mentionedCoreTools.length).toBe(EXPECTED_CORE_TOOLS.length);

      // done() should have been called
      expect(toolNames).toContain(mcpToolName("done"));

      // Terminate
      const agent = agentManager.get(spawnResult.id);
      if (agent?.state === "running") {
        await agentManager.terminate(spawnResult.id, "completed");
      }
    },
    { timeout: 120_000 },
  );
});
