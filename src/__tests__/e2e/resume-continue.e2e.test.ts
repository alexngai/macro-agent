/**
 * Resume & Continue E2E Tests (V2)
 *
 * Tests that verify agent resume (session restoration) and continue
 * (new agent with same role) work with REAL Claude Code agents.
 *
 * REQUIRES: RUN_FULL_AGENT_TESTS=true
 *
 * Run with:
 *   RUN_FULL_AGENT_TESTS=true npx vitest run --config vitest.e2e.config.ts src/__tests__/e2e/resume-continue.e2e.test.ts
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
} from "vitest";
import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import { execSync } from "child_process";
import { bootV2, type MacroAgentSystemV2 } from "../../boot-v2.js";

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
  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), `resume-continue-${prefix}-`)
  );
  const repoPath = path.join(tmpDir, "test-repo");
  fs.mkdirSync(repoPath);
  execSync("git init", { cwd: repoPath, stdio: "pipe" });
  execSync('git config user.email "test@test.com"', { cwd: repoPath, stdio: "pipe" });
  execSync('git config user.name "Test User"', { cwd: repoPath, stdio: "pipe" });
  fs.writeFileSync(path.join(repoPath, "README.md"), "# Test Repo\n");
  execSync("git add -A", { cwd: repoPath, stdio: "pipe" });
  execSync('git commit -m "Initial commit"', { cwd: repoPath, stdio: "pipe" });

  return {
    path: repoPath,
    cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }),
  };
}

function log(msg: string): void {
  console.log(`[RESUME-E2E] ${msg}`);
}

function getTextContent(updates: any[]): string {
  const parts: string[] = [];
  for (const u of updates) {
    const uAny = u as any;
    if (uAny.sessionUpdate === "agent_message_chunk" && uAny.content?.text) {
      parts.push(uAny.content.text);
    }
  }
  return parts.join("");
}

// ─────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────

describeFn("Resume & Continue E2E (V2)", () => {
  let system: MacroAgentSystemV2;
  let testRepo: { path: string; cleanup: () => void };
  let baseDir: string;

  beforeEach(async () => {
    testRepo = createTestRepo("v2");
    baseDir = path.join(testRepo.path, ".macro-agent");
    fs.mkdirSync(baseDir, { recursive: true });

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
            // Best effort
          }
        }
        await system.shutdown();
      } catch {
        // Best effort
      }
    }
    testRepo?.cleanup();
    log("Cleanup complete");
  });

  // ── Resume restores session ──────────────────────────────────

  it(
    "should resume an agent and restore its session memory",
    async () => {
      log("Spawning agent...");
      const agent = await system.agentManager.spawn({
        task: "You are a memory test agent. Remember any words you are told.",
        role: "worker",
        cwd: testRepo.path,
      });

      log(`Agent spawned: ${agent.id}`);
      expect(agent.id).toBeDefined();

      // Give the agent a fact to remember
      log("Prompting agent to remember BANANA...");
      const rememberUpdates: any[] = [];
      for await (const update of system.agentManager.prompt(
        agent.id,
        'Remember the word BANANA. Reply with "I will remember BANANA." and nothing else.'
      )) {
        rememberUpdates.push(update);
      }
      log(`Got ${rememberUpdates.length} updates from remember prompt`);

      const rememberText = getTextContent(rememberUpdates);
      log(`Remember response: ${rememberText.slice(0, 200)}`);
      expect(rememberText.toUpperCase()).toContain("BANANA");

      // Terminate the agent
      log("Terminating agent...");
      await system.agentManager.terminate(agent.id, "completed");
      expect(system.agentStore.getAgent(agent.id)!.state).toBe("stopped");
      expect(system.agentManager.hasActiveSession(agent.id)).toBe(false);

      // Resume the agent
      log("Resuming agent...");
      const resumed = await system.agentManager.resume(agent.id);
      log(`Resumed agent: ${resumed.id}`);
      expect(resumed.id).toBe(agent.id);
      expect(system.agentManager.hasActiveSession(agent.id)).toBe(true);

      // Ask the resumed agent what the word was
      log("Prompting resumed agent for the remembered word...");
      const recallUpdates: any[] = [];
      for await (const update of system.agentManager.prompt(
        agent.id,
        "What was the word I asked you to remember? Reply with just the word."
      )) {
        recallUpdates.push(update);
      }

      const recallText = getTextContent(recallUpdates);
      log(`Recall response: ${recallText.slice(0, 200)}`);
      expect(recallText.toUpperCase()).toContain("BANANA");

      log("Resume session memory verified!");
    },
    TIMEOUT.MULTI
  );

  // ── Resume preserves conversation history ─────────────────────

  it(
    "should preserve conversation history across resume",
    async () => {
      log("Spawning agent...");
      const agent = await system.agentManager.spawn({
        task: "You are a fact-tracking agent. Store and recall facts precisely.",
        role: "worker",
        cwd: testRepo.path,
      });

      log(`Agent spawned: ${agent.id}`);

      // Give the agent a specific fact
      log("Giving agent a fact...");
      const factUpdates: any[] = [];
      for await (const update of system.agentManager.prompt(
        agent.id,
        'The project code is ALPHA-7. Please confirm you have noted this by replying "Noted: ALPHA-7".'
      )) {
        factUpdates.push(update);
      }

      const factText = getTextContent(factUpdates);
      log(`Fact response: ${factText.slice(0, 200)}`);
      expect(factText.toUpperCase()).toContain("ALPHA-7");

      // Terminate
      log("Terminating agent...");
      await system.agentManager.terminate(agent.id, "completed");
      expect(system.agentStore.getAgent(agent.id)!.state).toBe("stopped");

      // Resume
      log("Resuming agent...");
      const resumed = await system.agentManager.resume(agent.id);
      expect(resumed.id).toBe(agent.id);

      // Ask for the fact
      log("Asking resumed agent for the project code...");
      const recallUpdates: any[] = [];
      for await (const update of system.agentManager.prompt(
        agent.id,
        "What is the project code I told you earlier? Reply with just the code."
      )) {
        recallUpdates.push(update);
      }

      const recallText = getTextContent(recallUpdates);
      log(`Recall response: ${recallText.slice(0, 200)}`);
      expect(recallText.toUpperCase()).toContain("ALPHA-7");

      log("Conversation history preserved across resume!");
    },
    TIMEOUT.MULTI
  );

  // ── Continue creates new agent ────────────────────────────────

  it(
    "should continue a terminated agent as a new agent with same role",
    async () => {
      log("Spawning original worker...");
      const original = await system.agentManager.spawn({
        task: "You are a worker agent performing calculations.",
        role: "worker",
        cwd: testRepo.path,
      });

      log(`Original: ${original.id}`);

      // Give it some context
      log("Prompting original with context...");
      const contextUpdates: any[] = [];
      for await (const update of system.agentManager.prompt(
        original.id,
        "Compute 10 + 20. Reply with the answer."
      )) {
        contextUpdates.push(update);
      }

      const contextText = getTextContent(contextUpdates);
      log(`Context response: ${contextText.slice(0, 200)}`);

      // Terminate
      log("Terminating original...");
      await system.agentManager.terminate(original.id, "completed");
      expect(system.agentStore.getAgent(original.id)!.state).toBe("stopped");

      // Continue
      log("Continuing agent...");
      const continued = await system.agentManager.continueAgent(original.id, {
        additionalContext: "Previous agent computed 10+20=30. Continue from there.",
        task: "Continue previous calculations.",
      });

      log(`Continued: ${continued.id}`);
      expect(continued.id).not.toBe(original.id);
      expect(continued.agent.state).toBe("running");
      expect(continued.agent.role).toBe("worker");

      // Verify in store
      const record = system.agentStore.getAgent(continued.id)!;
      expect(record.state).toBe("running");
      expect(record.role).toBe("worker");

      // Verify in inbox
      const inbox = (system.inboxAdapter as any).getInbox();
      expect(inbox.storage.getAgent(continued.id)).toBeDefined();

      // Prompt the continuation to verify it works
      log("Prompting continuation...");
      const contUpdates: any[] = [];
      for await (const update of system.agentManager.prompt(
        continued.id,
        "What is 30 + 15? Reply briefly."
      )) {
        contUpdates.push(update);
      }

      const contText = getTextContent(contUpdates);
      log(`Continuation response: ${contText.slice(0, 200)}`);
      expect(contUpdates.length).toBeGreaterThan(0);

      log("Continue created new agent with same role!");
    },
    TIMEOUT.MULTI
  );
});
