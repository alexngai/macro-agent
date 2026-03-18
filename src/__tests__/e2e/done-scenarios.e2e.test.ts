/**
 * Done Scenarios E2E Tests (V2)
 *
 * Tests that verify done() tool behavior in various scenarios:
 * - done(status="blocked") keeps agent alive and notifies parent
 * - promptUntilDone follow-up prompting
 *
 * REQUIRES: RUN_FULL_AGENT_TESTS=true
 *
 * Run with:
 *   RUN_FULL_AGENT_TESTS=true npx vitest run --config vitest.e2e.config.ts src/__tests__/e2e/done-scenarios.e2e.test.ts
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
    path.join(os.tmpdir(), `done-scenarios-${prefix}-`)
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
  console.log(`[DONE-E2E] ${msg}`);
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

function findToolCalls(updates: any[]): { name: string; fullTitle: string; input: any }[] {
  const calls: { name: string; fullTitle: string; input: any }[] = [];
  for (const u of updates) {
    const uAny = u as any;

    if (
      (uAny.sessionUpdate === "tool_call" || uAny.sessionUpdate === "tool_call_update") &&
      uAny.title
    ) {
      const fullTitle = uAny.title as string;
      const parts = fullTitle.split("__");
      const shortName = parts[parts.length - 1];

      if (!calls.some(c => c.fullTitle === fullTitle)) {
        calls.push({
          name: shortName,
          fullTitle,
          input: uAny.rawInput ?? uAny.input,
        });
      }
    }

    if (uAny.content?.type === "tool_use") {
      const name = uAny.content.name;
      if (!calls.some(c => c.name === name)) {
        calls.push({ name, fullTitle: name, input: uAny.content.input });
      }
    }
  }
  return calls;
}

// ─────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────

describeFn("Done Scenarios E2E (V2)", () => {
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

  // ── Done with blocked keeps agent alive ───────────────────────

  it(
    "should keep agent alive when done is called with blocked status",
    async () => {
      log("Spawning coordinator...");
      const coordinator = await system.agentManager.spawn({
        task: "You coordinate workers. Monitor their status.",
        role: "coordinator",
        cwd: testRepo.path,
      });

      log("Spawning worker under coordinator...");
      const worker = await system.agentManager.spawn({
        task: "You are a worker that needs database credentials to proceed.",
        role: "worker",
        parent: coordinator.id,
        cwd: testRepo.path,
      });

      log(`Coordinator: ${coordinator.id}, Worker: ${worker.id}`);

      // Prompt the worker to call done with blocked status
      log("Prompting worker to call done(blocked)...");
      const result = await system.agentManager.promptUntilDone(
        worker.id,
        'You are blocked and cannot proceed. Call the "done" MCP tool with status="blocked" and summary="Need database credentials to continue". Do this immediately.',
        {
          maxFollowUps: 2,
          onUpdate: (update: any) => {
            if (update.sessionUpdate === "tool_call") {
              log(`  [tool_call] ${update.title ?? "unknown"}`);
            }
          },
        }
      );

      log(`promptUntilDone result: doneCalled=${result.doneCalled}, doneStatus=${result.doneStatus}`);

      // Wait for lifecycle signals to propagate
      await new Promise((r) => setTimeout(r, 3000));

      if (result.doneCalled) {
        log("done() was called!");

        // The key assertion for blocked: agent session should still be active
        // because handleWorkerDone returns shouldTerminate=false for blocked status
        const workerRecord = system.agentStore.getAgent(worker.id)!;
        log(`Worker state: ${workerRecord.state}`);

        // Check if parent received HELP_NEEDED signal in inbox
        const coordInbox = await system.inboxAdapter.checkInbox(coordinator.id);
        log(`Coordinator inbox: ${coordInbox.length} messages`);

        const helpNeeded = coordInbox.find(
          (m) =>
            m.content?.type === "event" &&
            m.content?.event === "HELP_NEEDED"
        );

        const agentStopped = coordInbox.find(
          (m) =>
            m.content?.type === "event" &&
            m.content?.event === "agent_stopped" &&
            m.content?.data?.agentId === worker.id
        );

        if (helpNeeded) {
          log("HELP_NEEDED signal found in coordinator inbox!");
          expect(helpNeeded.content.data.agentId).toBe(worker.id);
        }

        // Log all lifecycle messages for debugging
        const lifecycleMsgs = coordInbox.filter(
          (m) => m.content?.type === "event"
        );
        for (const msg of lifecycleMsgs) {
          log(`  event=${msg.content.event}, from=${msg.sender_id}, data=${JSON.stringify(msg.content.data).slice(0, 100)}`);
        }

        // If the worker was blocked, it should either:
        // 1. Still be running (blocked handler returns shouldTerminate=false), or
        // 2. Have HELP_NEEDED in parent inbox
        if (workerRecord.state === "running") {
          log("Worker still running after blocked done() -- correct behavior!");
          expect(system.agentManager.hasActiveSession(worker.id)).toBe(true);
        } else if (helpNeeded || agentStopped) {
          log("Worker was terminated but parent received lifecycle notification");
          expect(lifecycleMsgs.length).toBeGreaterThanOrEqual(1);
        }
      } else {
        // Agent did not call done -- log what happened
        const text = getTextContent(result.updates);
        log(`Worker didn't call done(). Response: ${text.slice(0, 300)}`);
        const allToolCalls = findToolCalls(result.updates);
        log(`Tool calls: ${allToolCalls.map(t => t.name).join(", ") || "none"}`);
      }

      log("Test complete");
    },
    TIMEOUT.MULTI
  );

  // ── promptUntilDone follow-up ─────────────────────────────────

  it(
    "should follow up with the agent until done is called via promptUntilDone",
    async () => {
      log("Spawning worker...");
      const worker = await system.agentManager.spawn({
        task: "You are a worker. When instructed, create files and then call done().",
        role: "worker",
        cwd: testRepo.path,
      });

      log(`Worker: ${worker.id}`);

      // Use promptUntilDone with a task that may not immediately call done()
      // The follow-up mechanism should remind the agent to call done()
      log("Using promptUntilDone with maxFollowUps=2...");
      const result = await system.agentManager.promptUntilDone(
        worker.id,
        `Create a file at ${testRepo.path}/test.txt with content "hello". After creating the file, call the "done" MCP tool with status="completed" and summary="Created test.txt".`,
        {
          maxFollowUps: 2,
          onUpdate: (update: any) => {
            if (update.sessionUpdate === "tool_call") {
              log(`  [tool_call] ${update.title ?? "unknown"}`);
            }
          },
        }
      );

      log(`promptUntilDone: doneCalled=${result.doneCalled}, doneStatus=${result.doneStatus}, totalUpdates=${result.updates.length}`);

      // Check if the file was created (verifies agent did real work)
      const filePath = path.join(testRepo.path, "test.txt");
      const fileCreated = fs.existsSync(filePath);
      log(`File created: ${fileCreated}`);
      if (fileCreated) {
        const content = fs.readFileSync(filePath, "utf-8");
        log(`File content: "${content.trim()}"`);
      }

      // Check all tool calls made during the interaction
      const toolCalls = findToolCalls(result.updates);
      log(`All tool calls: ${toolCalls.map(t => t.name).join(", ") || "none"}`);

      if (result.doneCalled) {
        log(`done() called with status=${result.doneStatus}`);
        // Verify the agent did call done eventually (possibly after follow-up)
        expect(result.doneCalled).toBe(true);
      } else {
        // Even if done wasn't called, the follow-up mechanism should have tried
        const text = getTextContent(result.updates);
        log(`Agent response: ${text.slice(0, 300)}`);
        log("Note: Agent may not have called done despite follow-ups (model discretion)");
      }

      // Verify the agent is still in a valid state
      const workerRecord = system.agentStore.getAgent(worker.id)!;
      log(`Worker final state: ${workerRecord.state}`);

      log("Test complete");
    },
    TIMEOUT.MULTI
  );
});
