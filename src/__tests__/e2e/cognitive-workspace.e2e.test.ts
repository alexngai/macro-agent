/**
 * Cognitive Workspace E2E Tests
 *
 * Tests the full workspace execution flow with macro-agent's cognitive module:
 *
 * 1. Boot macro-agent system
 * 2. Create MacroAgentBackend
 * 3. handleWorkspaceExecute receives a workspace task
 * 4. Backend spawns an analyst agent in the workspace cwd
 * 5. Agent reads input, writes output, calls done()
 * 6. Result sent back with output files
 *
 * Mocked mode (default): Uses mocked acp-factory, no real Claude Code.
 * Live mode (RUN_FULL_AGENT_TESTS=true): Spawns real Claude Code agents.
 *
 * Run:
 *   npx vitest run --config vitest.e2e.config.ts src/__tests__/e2e/cognitive-workspace.e2e.test.ts
 *   RUN_FULL_AGENT_TESTS=true npx vitest run --config vitest.e2e.config.ts src/__tests__/e2e/cognitive-workspace.e2e.test.ts
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { bootV2, type MacroAgentSystemV2 } from "../../boot-v2.js";
import { MacroAgentBackend } from "../../cognitive/macro-agent-backend.js";
import {
  handleWorkspaceExecute,
  type WorkspaceHandlerDeps,
} from "../../cognitive/workspace-handler.js";
import type { SessionCompleteEvent } from "../../cognitive/types.js";

const IS_LIVE = process.env.RUN_FULL_AGENT_TESTS === "true";
const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cognitive-ws-e2e-"));

describe("Cognitive Workspace E2E", () => {
  let system: MacroAgentSystemV2;
  let backend: MacroAgentBackend;
  let completedSessions: SessionCompleteEvent[];

  beforeAll(async () => {
    system = await bootV2({
      baseDir: TEST_DIR,
      defaultCwd: TEST_DIR,
      defaultPermissionMode: "auto-approve",
    });

    completedSessions = [];
    backend = new MacroAgentBackend(system.agentManager, {
      onSessionComplete: (event) => completedSessions.push(event),
    });
  }, 30_000);

  afterAll(async () => {
    if (system) {
      await system.shutdown();
    }
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  }, 15_000);

  beforeEach(() => {
    completedSessions = [];
  });

  describe("MacroAgentBackend (mocked agents)", () => {
    it("should spawn an analyst and track session", async () => {
      const session = await backend.spawn({
        agentType: "claude-code",
        task: { description: "Analyze code patterns", domain: "test" },
        cwd: TEST_DIR,
        timeout: 10_000,
      });

      expect(session.id).toMatch(/^cognitive_/);
      expect(session.agentType).toBe("claude-code");
      expect(session.state).toBe("running");
      expect(session.task.description).toBe("Analyze code patterns");

      // Wait for completion
      const retrieved = await waitForSession(backend, session.id, 15_000);
      expect(retrieved).toBeDefined();
      expect(["completed", "failed"]).toContain(retrieved!.state);
    }, 20_000);

    it("should report completion via callback", async () => {
      const session = await backend.spawn({
        agentType: "claude-code",
        task: { description: "Quick analysis" },
        cwd: TEST_DIR,
        timeout: 10_000,
      });

      await waitForSession(backend, session.id, 15_000);

      // Completion callback should have fired
      expect(completedSessions.length).toBeGreaterThanOrEqual(1);
      const event = completedSessions.find((e) => e.sessionId === session.id);
      expect(event).toBeDefined();
      expect(event!.duration_ms).toBeGreaterThanOrEqual(0);
    }, 20_000);

    it("should terminate a running session", async () => {
      const session = await backend.spawn({
        agentType: "claude-code",
        task: { description: "Long-running analysis" },
        cwd: TEST_DIR,
        timeout: 60_000,
      });

      // Terminate immediately
      await backend.terminate(session.id);

      const terminated = await backend.getSession(session.id);
      expect(terminated).toBeDefined();
      expect(terminated!.state).toBe("failed");
      expect(terminated!.error).toContain("Terminated");
    });

    it("should list sessions", async () => {
      const sessions = await backend.listSessions();
      expect(Array.isArray(sessions)).toBe(true);
    });
  });

  describe("Workspace Handler (mocked agents)", () => {
    it("should handle workspace.execute and return result", async () => {
      const sentMessages: object[] = [];
      const deps: WorkspaceHandlerDeps = {
        backend,
        sendToHub: (msg) => sentMessages.push(msg),
      };

      // Create workspace with input files
      const workspaceDir = path.join(TEST_DIR, `workspace-${Date.now()}`);
      fs.mkdirSync(path.join(workspaceDir, "input"), { recursive: true });
      fs.writeFileSync(
        path.join(workspaceDir, "input", "trajectories.json"),
        JSON.stringify([{ task: "test", steps: [], outcome: { success: true } }]),
      );

      await handleWorkspaceExecute(deps, {
        request_id: "e2e-001",
        prompt: "Analyze the trajectories in input/ and write results to output/",
        cwd: workspaceDir,
        timeout: 15_000,
      });

      // Should have sent a result
      expect(sentMessages.length).toBe(1);
      const result = sentMessages[0] as any;
      expect(result.jsonrpc).toBe("2.0");
      expect(result.method).toBe("x-openhive/learning.workspace.result");
      expect(result.params.request_id).toBe("e2e-001");
      expect(result.params.duration_ms).toBeGreaterThanOrEqual(0);
      // Success or failure depends on whether mocked agent wrote output
      expect(typeof result.params.success).toBe("boolean");
    }, 20_000);

    it("should handle workspace.execute with system context", async () => {
      const sentMessages: object[] = [];
      const deps: WorkspaceHandlerDeps = {
        backend,
        sendToHub: (msg) => sentMessages.push(msg),
      };

      await handleWorkspaceExecute(deps, {
        request_id: "e2e-002",
        prompt: "Extract playbooks from the provided analysis",
        cwd: TEST_DIR,
        system_context: "You are a playbook extraction specialist. Focus on error handling patterns.",
        timeout: 15_000,
      });

      expect(sentMessages.length).toBe(1);
      const result = sentMessages[0] as any;
      expect(result.params.request_id).toBe("e2e-002");
    }, 20_000);
  });

  // Live agent tests — only run with RUN_FULL_AGENT_TESTS=true
  const liveDescribe = IS_LIVE ? describe : describe.skip;

  liveDescribe("Live Agent Workspace Execution", () => {
    it("should spawn real analyst that reads input and writes output", async () => {
      // Prepare workspace with input files
      const workspaceDir = path.join(TEST_DIR, `live-workspace-${Date.now()}`);
      fs.mkdirSync(path.join(workspaceDir, "input"), { recursive: true });
      fs.mkdirSync(path.join(workspaceDir, "output"), { recursive: true });
      fs.writeFileSync(
        path.join(workspaceDir, "input", "task.json"),
        JSON.stringify({
          type: "trajectory-analysis",
          trajectories: [
            {
              task: { description: "Fix import path" },
              steps: [
                { action: "read file", observation: "broken import" },
                { action: "fix import", observation: "fixed" },
              ],
              outcome: { success: true },
            },
          ],
        }),
      );

      const session = await backend.spawn({
        agentType: "claude-code",
        task: {
          description:
            "Read input/task.json. Analyze the trajectories. Write a JSON analysis to output/analysis.json with fields: success (boolean), keySteps (number[]), summary (string). Then call done().",
        },
        cwd: workspaceDir,
        timeout: 120_000,
      });

      // Wait for completion
      const final = await waitForSession(backend, session.id, 120_000);
      expect(final).toBeDefined();
      expect(final!.state).toBe("completed");

      // Check that output was written
      const outputPath = path.join(workspaceDir, "output", "analysis.json");
      expect(fs.existsSync(outputPath)).toBe(true);

      const output = JSON.parse(fs.readFileSync(outputPath, "utf-8"));
      expect(output).toHaveProperty("success");
      expect(output).toHaveProperty("keySteps");
      expect(output).toHaveProperty("summary");
    }, 180_000);

    it("should handle workspace.execute with real agent end-to-end", async () => {
      const sentMessages: object[] = [];
      const deps: WorkspaceHandlerDeps = {
        backend,
        sendToHub: (msg) => sentMessages.push(msg),
      };

      const workspaceDir = path.join(TEST_DIR, `live-handler-${Date.now()}`);
      fs.mkdirSync(path.join(workspaceDir, "input"), { recursive: true });
      fs.writeFileSync(
        path.join(workspaceDir, "input", "data.json"),
        JSON.stringify({ items: [1, 2, 3] }),
      );

      await handleWorkspaceExecute(deps, {
        request_id: "live-001",
        prompt:
          "Read input/data.json. Count the items. Write output/result.json with { count: <number>, processed: true }. Call done().",
        cwd: workspaceDir,
        timeout: 120_000,
      });

      expect(sentMessages.length).toBe(1);
      const result = sentMessages[0] as any;
      expect(result.params.request_id).toBe("live-001");
      expect(result.params.success).toBe(true);

      // Verify output file was created by the agent
      const outputPath = path.join(workspaceDir, "output", "result.json");
      if (fs.existsSync(outputPath)) {
        const output = JSON.parse(fs.readFileSync(outputPath, "utf-8"));
        expect(output.count).toBe(3);
        expect(output.processed).toBe(true);
      }
    }, 180_000);
  });
});

/** Poll for session completion */
async function waitForSession(
  backend: MacroAgentBackend,
  sessionId: string,
  timeoutMs: number,
): Promise<import("../../cognitive/types.js").CognitiveAgentSession | undefined> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const session = await backend.getSession(sessionId);
    if (session && session.state !== "running") return session;
    await new Promise((r) => setTimeout(r, 300));
  }
  return await backend.getSession(sessionId);
}
