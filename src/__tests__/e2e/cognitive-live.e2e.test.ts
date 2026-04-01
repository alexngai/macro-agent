/**
 * Cognitive Live Agent E2E Tests
 *
 * Tests MacroAgentBackend with REAL Claude Code agents via acp-factory.
 * Validates that analyst agents produce trajectories with tool calls,
 * complete via done(), and that mock Atlas receives trajectory data.
 *
 * REQUIRES: RUN_FULL_AGENT_TESTS=true (real Claude Code agents)
 *
 * Run with:
 *   RUN_FULL_AGENT_TESTS=true npx vitest run --config vitest.e2e.config.ts src/__tests__/e2e/cognitive-live.e2e.test.ts
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import { execSync } from "child_process";
import { bootV2, type MacroAgentSystemV2 } from "../../boot-v2.js";
import { MacroAgentBackend } from "../../cognitive/macro-agent-backend.js";
import type {
  AtlasInstance,
  CognitiveTrajectory,
  SessionCompleteEvent,
} from "../../cognitive/types.js";

// ─────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────

const RUN_FULL_AGENT = !!process.env.RUN_FULL_AGENT_TESTS;
const describeFn = RUN_FULL_AGENT ? describe : describe.skip;

const TIMEOUT = {
  SPAWN: 60_000,
  PROMPT: 90_000,
  MULTI: 180_000,
};

// ─────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────

function createTestRepo(prefix: string): { path: string; cleanup: () => void } {
  // Short prefix to avoid macOS 104-char UNIX socket path limit
  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), `cog-${prefix.slice(0, 4)}-`)
  );
  const repoPath = path.join(tmpDir, "repo");
  fs.mkdirSync(repoPath);
  execSync("git init", { cwd: repoPath, stdio: "pipe" });
  execSync('git config user.email "test@test.com"', {
    cwd: repoPath,
    stdio: "pipe",
  });
  execSync('git config user.name "Test User"', {
    cwd: repoPath,
    stdio: "pipe",
  });
  fs.writeFileSync(path.join(repoPath, "README.md"), "# Test Repo\n");
  execSync("git add -A", { cwd: repoPath, stdio: "pipe" });
  execSync('git commit -m "Initial commit"', { cwd: repoPath, stdio: "pipe" });

  return {
    path: repoPath,
    cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }),
  };
}

function log(msg: string): void {
  console.log(`[COGNITIVE-LIVE-E2E] ${msg}`);
}

/**
 * Wait for a backend session to reach a terminal state.
 */
async function waitForSession(
  backend: MacroAgentBackend,
  sessionId: string,
  timeoutMs = 120_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = await backend.getSession(sessionId);
    if (s && (s.state === "completed" || s.state === "failed")) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(
    `Session ${sessionId} did not complete within ${timeoutMs}ms`
  );
}

/**
 * Create a mock Atlas instance that records processTrajectory calls.
 */
function createMockAtlas(): AtlasInstance & {
  trajectories: CognitiveTrajectory[];
} {
  const trajectories: CognitiveTrajectory[] = [];
  return {
    trajectories,
    processTrajectory: vi.fn().mockImplementation(async (t: CognitiveTrajectory) => {
      trajectories.push(t);
      return { trajectoryId: t.id, stored: true };
    }),
    runBatchLearning: vi.fn().mockResolvedValue({
      trajectoriesProcessed: 0,
      playbooksExtracted: 0,
    }),
    queryMemory: vi.fn().mockResolvedValue(null),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

// ─────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────

describeFn("Cognitive Live Agent E2E", () => {
  let system: MacroAgentSystemV2;
  let testRepo: { path: string; cleanup: () => void };
  let baseDir: string;

  beforeEach(async () => {
    testRepo = createTestRepo("cognitive");
    baseDir = path.join(testRepo.path, ".ma");
    fs.mkdirSync(baseDir, { recursive: true });

    // Boot V2 with real acp-factory (no mocking)
    system = await bootV2({
      cwd: testRepo.path,
      baseDir,
      defaultPermissionMode: "auto-approve",
      inbox: {
        socketPath: path.join(baseDir, "inbox.sock"),
      },
    });
    log("System booted");
  });

  afterEach(async () => {
    if (system) {
      try {
        const running = system.agentManager.list({ state: "running" });
        for (const agent of running) {
          try {
            await system.agentManager.terminate(agent.id, "cancelled");
          } catch {
            // Best effort cleanup
          }
        }
      } catch {
        // Ignore cleanup errors
      }
      await system.shutdown();
    }
    if (testRepo) {
      testRepo.cleanup();
    }
  });

  // ── Test 1: Real analyst produces trajectory with tool calls ──

  it(
    "should produce trajectory with tool calls from real analyst",
    async () => {
      const completionEvents: SessionCompleteEvent[] = [];

      const backend = new MacroAgentBackend(system.agentManager, {
        onSessionComplete: (event) => completionEvents.push(event),
      });

      log("Spawning analyst with file listing task");
      const session = await backend.spawn({
        agentType: "claude-code",
        task: {
          description:
            "List the files in the current directory and report what you find. Then call done with a summary.",
        },
        cwd: testRepo.path,
      });

      log(`Session ${session.id} spawned, waiting for completion...`);
      await waitForSession(backend, session.id, TIMEOUT.PROMPT);

      const completed = await backend.getSession(session.id);
      log(`Session state: ${completed?.state}`);

      // Session should have completed
      expect(completed).toBeDefined();
      expect(completed!.state).toBe("completed");

      // Session should have messages (assistant responses)
      expect(completed!.messages.length).toBeGreaterThan(0);
      log(`Messages: ${completed!.messages.length}`);

      // Session should have tool calls (agent should call Bash or Glob)
      expect(completed!.toolCalls.length).toBeGreaterThan(0);
      log(`Tool calls: ${completed!.toolCalls.length}`);

      // Trajectory should have been extracted
      expect(completionEvents.length).toBe(1);
      const trajectory = completionEvents[0].trajectory;
      expect(trajectory).toBeDefined();

      // Trajectory should have ReAct steps
      expect(trajectory!.steps.length).toBeGreaterThan(0);
      log(`Trajectory steps: ${trajectory!.steps.length}`);

      // At least one step should have action + observation
      const validStep = trajectory!.steps.find(
        (s) => s.action && s.observation
      );
      expect(validStep).toBeDefined();
      log(
        `Valid step found: action=${validStep!.action.slice(0, 80)}, observation length=${validStep!.observation.length}`
      );
    },
    TIMEOUT.MULTI
  );

  // ── Test 2: Real analyst with done() integration ──────────────

  it(
    "should complete with done() and create file on disk",
    async () => {
      const backend = new MacroAgentBackend(system.agentManager);

      log("Spawning analyst with file creation task");
      const session = await backend.spawn({
        agentType: "claude-code",
        task: {
          description:
            'Create a file called cognitive-test.txt with the content "hello" in the current directory, then call done with status "completed" and a brief summary.',
        },
        cwd: testRepo.path,
      });

      log(`Session ${session.id} spawned, waiting for completion...`);
      await waitForSession(backend, session.id, TIMEOUT.PROMPT);

      const completed = await backend.getSession(session.id);
      log(`Session state: ${completed?.state}`);

      expect(completed!.state).toBe("completed");

      // File should exist on disk
      const filePath = path.join(testRepo.path, "cognitive-test.txt");
      expect(fs.existsSync(filePath)).toBe(true);
      const content = fs.readFileSync(filePath, "utf-8");
      expect(content).toContain("hello");
      log(`File created: ${filePath}, content: ${content.trim()}`);

      // Trajectory should have steps reflecting the file creation
      const completionEvents: SessionCompleteEvent[] = [];
      // We need to re-spawn to capture trajectory via callback,
      // but the session already completed. Use extractTrajectory directly.
      const { extractTrajectory } = await import(
        "../../cognitive/trajectory-extractor.js"
      );
      const trajectory = extractTrajectory(completed!);
      expect(trajectory.steps.length).toBeGreaterThan(0);
      log(`Trajectory steps: ${trajectory.steps.length}`);
    },
    TIMEOUT.MULTI
  );

  // ── Test 3: Mock Atlas receives trajectory ────────────────────

  it(
    "should feed trajectory to mock Atlas on completion",
    async () => {
      const mockAtlas = createMockAtlas();

      const backend = new MacroAgentBackend(system.agentManager, {
        atlas: mockAtlas,
      });

      log("Spawning analyst with Atlas integration");
      const session = await backend.spawn({
        agentType: "claude-code",
        task: {
          description:
            'Read the README.md file in the current directory and call done with status "completed" and a summary of what you found.',
        },
        cwd: testRepo.path,
      });

      log(`Session ${session.id} spawned, waiting for completion...`);
      await waitForSession(backend, session.id, TIMEOUT.PROMPT);

      const completed = await backend.getSession(session.id);
      log(`Session state: ${completed?.state}`);
      expect(completed!.state).toBe("completed");

      // Atlas.processTrajectory should have been called
      expect(mockAtlas.processTrajectory).toHaveBeenCalledTimes(1);

      const trajectory = mockAtlas.trajectories[0];
      expect(trajectory).toBeDefined();
      log(`Atlas received trajectory: ${trajectory.id}`);

      // Trajectory should have correct task
      expect(trajectory.task.description).toContain("README.md");

      // Trajectory should have steps and outcome
      expect(trajectory.steps.length).toBeGreaterThan(0);
      expect(trajectory.outcome.success).toBe(true);

      // Should have agentId matching macro-agent's agent
      expect(trajectory.agentId).toBeDefined();
      expect(typeof trajectory.agentId).toBe("string");

      // Should have non-negative llmCalls
      expect(trajectory.llmCalls).toBeGreaterThanOrEqual(0);
      log(
        `Trajectory: ${trajectory.steps.length} steps, ${trajectory.llmCalls} LLM calls, wallTime=${trajectory.wallTimeSeconds}s`
      );
    },
    TIMEOUT.MULTI
  );
});
