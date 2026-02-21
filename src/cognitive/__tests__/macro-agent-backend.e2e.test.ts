/**
 * MacroAgentBackend E2E Tests
 *
 * Tests the cognitive backend with REAL Claude Code agents.
 * Spawns an analyst via MacroAgentBackend, runs a workspace template
 * (input/ → analysis → output/), and verifies session lifecycle.
 *
 * REQUIRES: RUN_FULL_AGENT_TESTS=true environment variable
 *
 * Run with:
 *   RUN_FULL_AGENT_TESTS=true npm run test:e2e -- src/cognitive/__tests__/macro-agent-backend.e2e.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

import { createEventStore, type EventStore } from "../../store/event-store.js";
import {
  createAgentManager,
  type AgentManager,
} from "../../agent/agent-manager.js";
import { createMessageRouter, type MessageRouter } from "../../router/message-router.js";
import { MacroAgentBackend } from "../macro-agent-backend.js";

// ─────────────────────────────────────────────────────────────────
// Test Configuration
// ─────────────────────────────────────────────────────────────────

const RUN_FULL_AGENT = !!process.env.RUN_FULL_AGENT_TESTS;
const testFn = RUN_FULL_AGENT ? it : it.skip;

const log = (msg: string) => {
  if (RUN_FULL_AGENT) {
    console.log(`[CognitiveE2E] ${msg}`);
  }
};

// ─────────────────────────────────────────────────────────────────
// Workspace Helpers
// ─────────────────────────────────────────────────────────────────

interface TestWorkspace {
  path: string;
  inputDir: string;
  outputDir: string;
  cleanup: () => void;
}

/**
 * Creates a workspace directory mimicking cognitive-core's AgenticTaskRunner layout.
 * The analyst agent reads from input/ and writes to output/.
 */
function createTestWorkspace(
  inputFiles: Record<string, string> = {},
): TestWorkspace {
  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "cognitive-e2e-workspace-"),
  );
  const inputDir = path.join(tmpDir, "input");
  const outputDir = path.join(tmpDir, "output");

  fs.mkdirSync(inputDir, { recursive: true });
  fs.mkdirSync(outputDir, { recursive: true });

  for (const [fileName, content] of Object.entries(inputFiles)) {
    fs.writeFileSync(path.join(inputDir, fileName), content);
  }

  return {
    path: tmpDir,
    inputDir,
    outputDir,
    cleanup: () => {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    },
  };
}

// ─────────────────────────────────────────────────────────────────
// Wait Helper
// ─────────────────────────────────────────────────────────────────

async function waitForCondition(
  condition: () => boolean | Promise<boolean>,
  options: {
    timeoutMs?: number;
    pollMs?: number;
    description?: string;
  } = {},
): Promise<void> {
  const {
    timeoutMs = 30000,
    pollMs = 500,
    description = "condition",
  } = options;
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    if (await condition()) {
      return;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }

  throw new Error(`Timeout waiting for ${description} after ${timeoutMs}ms`);
}

// ─────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────

describe("MacroAgentBackend E2E", () => {
  let eventStore: EventStore;
  let agentManager: AgentManager;
  let messageRouter: MessageRouter;
  let backend: MacroAgentBackend;
  let workspace: TestWorkspace;
  let tmpDbDir: string;

  beforeEach(async () => {
    if (!RUN_FULL_AGENT) {
      log("Skipping: RUN_FULL_AGENT_TESTS not set");
      return;
    }

    // File-based EventStore so MCP subprocess can access the same DB
    tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), "cognitive-e2e-db-"));
    const instanceId = `test-cognitive-${Date.now()}`;

    eventStore = await createEventStore({ instanceId, baseDir: tmpDbDir });
    messageRouter = createMessageRouter(eventStore);
    agentManager = createAgentManager(eventStore, messageRouter, {
      defaultPermissionMode: "auto-approve",
      defaultCwd: process.cwd(),
    });

    backend = new MacroAgentBackend(agentManager, {
      maxFollowUps: 2,
    });

    log("Services initialized");
  });

  afterEach(async () => {
    if (!RUN_FULL_AGENT) return;

    // Terminate all agents
    try {
      const agents = agentManager.list();
      for (const agent of agents) {
        if (agent.state === "running") {
          try {
            await agentManager.terminate(agent.id, "test_cleanup");
          } catch {
            // Ignore termination errors
          }
        }
      }
    } catch {
      // Ignore errors during cleanup
    }

    await agentManager?.close();
    await eventStore?.close();
    workspace?.cleanup();

    if (tmpDbDir) {
      try {
        fs.rmSync(tmpDbDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    }

    log("Cleanup complete");
  });

  describe("Workspace Template Execution", () => {
    testFn(
      "analyst reads input, writes output, and calls done()",
      async () => {
        // Set up workspace with a simple analysis task
        workspace = createTestWorkspace({
          "data.json": JSON.stringify({
            trajectories: [
              {
                id: "t1",
                steps: [
                  { thought: "Need to read the file", action: "read_file", observation: "file contents" },
                  { thought: "Now write the result", action: "write_file", observation: "success" },
                ],
                outcome: "success",
              },
            ],
          }),
          "task.md": [
            "# Analysis Task",
            "",
            "Analyze the trajectory in data.json.",
            "Write a JSON file to output/analysis.json with:",
            '- "trajectory_id": the trajectory ID',
            '- "step_count": number of steps',
            '- "outcome": the outcome',
            '- "summary": a one-sentence summary',
          ].join("\n"),
        });

        log(`Workspace created: ${workspace.path}`);

        // Spawn analyst via MacroAgentBackend
        const session = await backend.spawn({
          agentType: "claude-code",
          task: {
            description: [
              "You are an analysis agent. Your workspace is set up with input/ and output/ directories.",
              "",
              "1. Read input/task.md for your instructions",
              "2. Read input/data.json for the data to analyze",
              "3. Write your analysis result to output/analysis.json",
              "4. Call done() with status 'completed' when finished",
              "",
              "Focus only on reading input and writing output. Do NOT commit, push, or spawn other agents.",
            ].join("\n"),
          },
          cwd: workspace.path,
        });

        log(`Session created: ${session.id}`);
        expect(session.state).toBe("running");
        expect(session.id).toMatch(/^cognitive_/);

        // Wait for completion
        await waitForCondition(
          async () => {
            const s = await backend.getSession(session.id);
            return s?.state === "completed" || s?.state === "failed";
          },
          {
            timeoutMs: 120000,
            pollMs: 1000,
            description: "analyst session to complete",
          },
        );

        const finalSession = await backend.getSession(session.id);
        log(`Session state: ${finalSession!.state}`);
        log(`Messages: ${finalSession!.messages.length}`);
        log(`Tool calls: ${finalSession!.toolCalls.length}`);

        // Verify session completed successfully
        expect(finalSession!.state).toBe("completed");
        expect(finalSession!.endTime).toBeInstanceOf(Date);
        expect(finalSession!.messages.length).toBeGreaterThan(0);
        expect(finalSession!.toolCalls.length).toBeGreaterThan(0);

        // Verify output was written
        const outputPath = path.join(workspace.outputDir, "analysis.json");
        expect(fs.existsSync(outputPath)).toBe(true);

        const output = JSON.parse(fs.readFileSync(outputPath, "utf-8"));
        log(`Output: ${JSON.stringify(output)}`);
        expect(output).toHaveProperty("trajectory_id");
        expect(output).toHaveProperty("step_count");
        expect(output).toHaveProperty("outcome");
      },
      { timeout: 180000 },
    );
  });

  describe("Session Lifecycle", () => {
    testFn(
      "terminate() stops a running analyst",
      async () => {
        workspace = createTestWorkspace({
          "data.json": JSON.stringify({ items: Array.from({ length: 100 }, (_, i) => ({ id: i })) }),
          "task.md": "Analyze each item in data.json individually. Write detailed analysis for each to output/.",
        });

        const session = await backend.spawn({
          agentType: "claude-code",
          task: {
            description: [
              "Read input/task.md for instructions.",
              "Read input/data.json for data.",
              "Write analysis for each item to output/.",
              "Call done() when finished.",
            ].join("\n"),
          },
          cwd: workspace.path,
        });

        log(`Session created: ${session.id}`);

        // Give the agent a moment to start working
        await new Promise((r) => setTimeout(r, 5000));

        // Terminate
        await backend.terminate(session.id);
        log("Terminate called");

        const s = await backend.getSession(session.id);
        expect(s!.state).toBe("failed");
        expect(s!.error).toBe("Terminated by caller");
      },
      { timeout: 60000 },
    );

    testFn(
      "listSessions() returns all tracked sessions",
      async () => {
        workspace = createTestWorkspace({
          "task.md": "Write 'hello' to output/hello.txt and call done().",
        });

        const session1 = await backend.spawn({
          agentType: "claude-code",
          task: { description: "Read input/task.md. Write 'hello' to output/hello.txt. Call done()." },
          cwd: workspace.path,
        });

        const sessions = await backend.listSessions();
        expect(sessions.length).toBeGreaterThanOrEqual(1);
        expect(sessions.some((s) => s.id === session1.id)).toBe(true);

        // Wait for completion before cleanup
        await waitForCondition(
          async () => {
            const s = await backend.getSession(session1.id);
            return s?.state === "completed" || s?.state === "failed";
          },
          { timeoutMs: 60000, pollMs: 1000, description: "session to finish" },
        );
      },
      { timeout: 120000 },
    );
  });
});
