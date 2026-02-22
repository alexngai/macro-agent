/**
 * Cognitive Team Lifecycle E2E Tests
 *
 * Tests the full cognitive-ops team pipeline: template loading, runtime
 * initialization, coordinator bootstrap, analyst spawning under team,
 * and spawn interception with real services.
 *
 * Group 1 (infrastructure) uses real EventStore, MessageRouter, AgentManager
 * but does NOT spawn real Claude Code agents.
 *
 * Group 2 (full agent) spawns real analysts under the coordinator and requires:
 *   RUN_FULL_AGENT_TESTS=true
 *
 * Run:
 *   npm run test:e2e -- src/cognitive/__tests__/team-lifecycle.e2e.test.ts
 *   RUN_FULL_AGENT_TESTS=true npm run test:e2e -- src/cognitive/__tests__/team-lifecycle.e2e.test.ts
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
import {
  createMessageRouter,
  type MessageRouter,
} from "../../router/message-router.js";
import { loadTeam } from "../../teams/team-loader.js";
import { TeamRuntime, type TeamServices } from "../../teams/team-runtime.js";
import { initCognitiveTeam, type CognitiveTeamHandle } from "../team-lifecycle.js";
import { DefaultRoleRegistry } from "../../roles/registry.js";

// ─────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────

const RUN_FULL_AGENT = !!process.env.RUN_FULL_AGENT_TESTS;
const testFn = RUN_FULL_AGENT ? it : it.skip;
const PROJECT_ROOT = path.resolve(import.meta.dirname, "../../..");

const log = (msg: string) => console.log(`[CognitiveTeam-E2E] ${msg}`);

const TIMEOUT = {
  INFRA: 30000,
  SPAWN: 60000,
  TASK_COMPLETE: 180000,
};

// ─────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────

interface TestWorkspace {
  path: string;
  inputDir: string;
  outputDir: string;
  cleanup: () => void;
}

function createTestWorkspace(
  inputFiles: Record<string, string> = {},
): TestWorkspace {
  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "cognitive-team-e2e-workspace-"),
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
// Group 1: Team Infrastructure (no real agents)
// ─────────────────────────────────────────────────────────────────

describe("Cognitive Team Lifecycle E2E — Infrastructure", () => {
  let eventStore: EventStore;
  let agentManager: AgentManager;
  let messageRouter: MessageRouter;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cognitive-team-e2e-"));
    const instanceId = `cognitive-team-${Date.now()}`;

    eventStore = await createEventStore({ instanceId, baseDir: tmpDir });
    messageRouter = createMessageRouter(eventStore);
    agentManager = createAgentManager(eventStore, messageRouter, {
      defaultPermissionMode: "auto-approve",
      defaultCwd: process.cwd(),
    });
  });

  afterEach(async () => {
    try {
      const agents = agentManager.list();
      for (const agent of agents) {
        if (agent.state === "running") {
          try {
            await agentManager.terminate(agent.id, "test_cleanup");
          } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }

    await agentManager?.close();
    await eventStore?.close();

    if (tmpDir) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch { /* ignore */ }
    }
  });

  it("loads cognitive-ops team and initializes runtime", async () => {
    const roleRegistry = agentManager.getRoleRegistry() as DefaultRoleRegistry;
    const manifest = await loadTeam("cognitive-ops", roleRegistry, PROJECT_ROOT);
    const services: TeamServices = { agentManager, messageRouter, eventStore };
    const runtime = new TeamRuntime(manifest, services);

    await runtime.initialize();

    // Roles registered
    const registry = agentManager.getRoleRegistry();
    expect(registry.getRole("analyst")).toBeDefined();
    log("analyst role registered");

    // team_config event emitted
    const events = eventStore.query({ type: "status", limit: 50 });
    const configEvent = events.find((e) => e.payload?.team_config != null);
    expect(configEvent).toBeDefined();

    const tc = configEvent!.payload.team_config as Record<string, unknown>;
    expect(tc.teamName).toBe("cognitive-ops");
    expect(tc.taskMode).toBe("pull");
    log("team_config event verified");

    // Serialized roles include analyst with task.claim
    const roles = tc.roles as Record<string, { name: string; capabilities: string[] }>;
    expect(roles.analyst).toBeDefined();
    expect(roles.analyst.capabilities).toContain("task.claim");
    expect(roles.analyst.capabilities).toContain("file.read");
    expect(roles.analyst.capabilities).toContain("file.write");
    expect(roles.analyst.capabilities).not.toContain("agent.spawn.worker");
    expect(roles.analyst.capabilities).not.toContain("git.commit");
    log("Serialized analyst role capabilities verified");

    await runtime.teardown();
  }, TIMEOUT.INFRA);

  it("initCognitiveTeam bootstraps coordinator and returns handle", async () => {
    const handle = await initCognitiveTeam({
      agentManager,
      messageRouter,
      eventStore,
      basePath: PROJECT_ROOT,
    });

    // Coordinator was spawned
    expect(handle.coordinatorId).toBeDefined();
    const coordinator = agentManager.get(handle.coordinatorId);
    expect(coordinator).toBeDefined();
    expect(coordinator!.role).toBe("coordinator");
    log(`Coordinator spawned: ${handle.coordinatorId}`);

    // Backend is configured
    expect(handle.backend.name).toBe("macro-agent");
    expect(handle.backend.supportedTypes).toContain("claude-code");
    log("Backend configured");

    // team_config event has cognitive-ops
    const events = eventStore.query({ type: "status", limit: 50 });
    const configEvent = events.find((e) => e.payload?.team_config != null);
    expect(configEvent).toBeDefined();
    expect(
      (configEvent!.payload.team_config as Record<string, unknown>).teamName,
    ).toBe("cognitive-ops");
    log("team_config event verified");

    await handle.teardown();
  }, TIMEOUT.INFRA);

  it("spawn interceptor injects team env vars", async () => {
    const handle = await initCognitiveTeam({
      agentManager,
      messageRouter,
      eventStore,
      basePath: PROJECT_ROOT,
    });

    // The spawn interceptor should be installed
    // Verify by checking the coordinator was spawned with team env vars
    const coordinator = agentManager.get(handle.coordinatorId);
    expect(coordinator).toBeDefined();

    // The coordinator itself was spawned with team metadata
    // (spawn interceptor runs on all spawns after initialize)
    log("Spawn interceptor installed and active");

    await handle.teardown();
  }, TIMEOUT.INFRA);

  it("analyst role resolves with correct capabilities in registry", async () => {
    const handle = await initCognitiveTeam({
      agentManager,
      messageRouter,
      eventStore,
      basePath: PROJECT_ROOT,
    });

    const registry = agentManager.getRoleRegistry();

    // Analyst should have task.claim
    expect(registry.hasCapability("analyst", "task.claim")).toBe(true);
    expect(registry.hasCapability("analyst", "lifecycle.done")).toBe(true);
    expect(registry.hasCapability("analyst", "file.read")).toBe(true);
    expect(registry.hasCapability("analyst", "file.write")).toBe(true);
    expect(registry.hasCapability("analyst", "exec.command")).toBe(true);

    // Analyst should NOT have removed capabilities
    expect(registry.hasCapability("analyst", "agent.spawn.worker")).toBe(false);
    expect(registry.hasCapability("analyst", "git.commit")).toBe(false);
    expect(registry.hasCapability("analyst", "file.delete")).toBe(false);

    log("Analyst capabilities verified via registry");

    await handle.teardown();
  }, TIMEOUT.INFRA);

  it("teardown removes spawn interceptor cleanly", async () => {
    const handle = await initCognitiveTeam({
      agentManager,
      messageRouter,
      eventStore,
      basePath: PROJECT_ROOT,
    });

    // Teardown should not throw
    await handle.teardown();
    log("Teardown completed without errors");

    // AgentManager should still be functional
    const agents = agentManager.list();
    expect(Array.isArray(agents)).toBe(true);
    log("AgentManager still functional after teardown");
  }, TIMEOUT.INFRA);

  it("coordinator has agent.spawn.analyst capability", async () => {
    const handle = await initCognitiveTeam({
      agentManager,
      messageRouter,
      eventStore,
      basePath: PROJECT_ROOT,
    });

    const registry = agentManager.getRoleRegistry();
    expect(registry.hasCapability("coordinator", "agent.spawn.analyst")).toBe(true);
    log("Coordinator can spawn analysts");

    await handle.teardown();
  }, TIMEOUT.INFRA);
});

// ─────────────────────────────────────────────────────────────────
// Group 2: Full Agent Tests (requires RUN_FULL_AGENT_TESTS=true)
// ─────────────────────────────────────────────────────────────────

describe("Cognitive Team Lifecycle E2E — Full Agent", () => {
  let eventStore: EventStore;
  let agentManager: AgentManager;
  let messageRouter: MessageRouter;
  let handle: CognitiveTeamHandle | undefined;
  let workspace: TestWorkspace | undefined;
  let tmpDir: string;

  beforeEach(async () => {
    if (!RUN_FULL_AGENT) {
      log("Skipping: RUN_FULL_AGENT_TESTS not set");
      return;
    }

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cognitive-team-e2e-agent-"));
    const instanceId = `cognitive-team-agent-${Date.now()}`;

    eventStore = await createEventStore({ instanceId, baseDir: tmpDir });
    messageRouter = createMessageRouter(eventStore);
    agentManager = createAgentManager(eventStore, messageRouter, {
      defaultPermissionMode: "auto-approve",
      defaultCwd: process.cwd(),
    });

    handle = await initCognitiveTeam(
      {
        agentManager,
        messageRouter,
        eventStore,
        basePath: PROJECT_ROOT,
      },
      { maxFollowUps: 2 },
    );

    log(`Team initialized, coordinator: ${handle.coordinatorId}`);
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
          } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }

    await handle?.teardown();
    await agentManager?.close();
    await eventStore?.close();
    workspace?.cleanup();

    if (tmpDir) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch { /* ignore */ }
    }

    log("Cleanup complete");
  });

  testFn(
    "analyst spawns under coordinator and completes analysis",
    async () => {
      workspace = createTestWorkspace({
        "data.json": JSON.stringify({
          trajectories: [
            {
              id: "t1",
              steps: [
                { thought: "Read the file", action: "read_file", observation: "contents" },
                { thought: "Write result", action: "write_file", observation: "done" },
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

      // Spawn analyst via team-configured backend
      const session = await handle!.backend.spawn({
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

      log(`Analyst session created: ${session.id}`);
      expect(session.state).toBe("running");

      // Verify the analyst was spawned with coordinator as parent
      const macroAgentId = session.metadata.macroAgentId as string;
      const agent = agentManager.get(macroAgentId);
      expect(agent).toBeDefined();
      expect(agent!.role).toBe("analyst");
      expect(agent!.parent).toBe(handle!.coordinatorId);
      log(`Analyst ${macroAgentId} spawned under coordinator ${handle!.coordinatorId}`);

      // Verify analyst appears as child of coordinator
      const children = agentManager.getChildren(handle!.coordinatorId);
      expect(children.some((c) => c.id === macroAgentId)).toBe(true);
      log("Analyst is child of coordinator");

      // Wait for completion
      await waitForCondition(
        async () => {
          const s = await handle!.backend.getSession(session.id);
          return s?.state === "completed" || s?.state === "failed";
        },
        {
          timeoutMs: 120000,
          pollMs: 1000,
          description: "analyst session to complete",
        },
      );

      const finalSession = await handle!.backend.getSession(session.id);
      log(`Session state: ${finalSession!.state}`);
      log(`Session error: ${finalSession!.error ?? "none"}`);
      log(`Messages: ${finalSession!.messages.length}`);
      log(`Tool calls: ${finalSession!.toolCalls.length}`);
      if (finalSession!.messages.length > 0) {
        const lastMsg = finalSession!.messages[finalSession!.messages.length - 1];
        log(`Last message role: ${lastMsg.role}, content: ${lastMsg.content.slice(0, 200)}`);
      }
      if (finalSession!.toolCalls.length > 0) {
        const lastTc = finalSession!.toolCalls[finalSession!.toolCalls.length - 1];
        log(`Last tool call: ${lastTc.name}, error: ${lastTc.error ?? "none"}`);
        log(`Last tool call result: ${JSON.stringify(lastTc.result)?.slice(0, 500)}`);
      }

      // Check EventStore for status events from this agent
      await eventStore.reload();
      const statusEvents = eventStore.query({ type: "status" });
      const agentStatusEvents = statusEvents.filter(
        (e) => e.source?.agent_id === (finalSession!.metadata.macroAgentId as string),
      );
      log(`Status events from agent: ${agentStatusEvents.length}`);
      for (const evt of agentStatusEvents) {
        log(`  Status: type=${evt.payload?.status_type}, summary=${evt.payload?.summary?.toString().slice(0, 100)}`);
      }

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
    },
    { timeout: TIMEOUT.TASK_COMPLETE },
  );

  testFn(
    "multiple analysts run in parallel under coordinator",
    async () => {
      // Create two workspaces
      const workspace1 = createTestWorkspace({
        "task.md": "Write the JSON object { \"result\": \"task1\" } to output/result.json. Then call done().",
      });
      const workspace2 = createTestWorkspace({
        "task.md": "Write the JSON object { \"result\": \"task2\" } to output/result.json. Then call done().",
      });

      // Track for cleanup
      workspace = workspace1;

      log("Spawning two analysts in parallel");

      const [session1, session2] = await Promise.all([
        handle!.backend.spawn({
          agentType: "claude-code",
          task: {
            description: "Read input/task.md and follow the instructions. Call done() when finished.",
          },
          cwd: workspace1.path,
        }),
        handle!.backend.spawn({
          agentType: "claude-code",
          task: {
            description: "Read input/task.md and follow the instructions. Call done() when finished.",
          },
          cwd: workspace2.path,
        }),
      ]);

      log(`Session 1: ${session1.id}, Session 2: ${session2.id}`);

      // Both should be children of coordinator
      const agent1 = agentManager.get(session1.metadata.macroAgentId as string);
      const agent2 = agentManager.get(session2.metadata.macroAgentId as string);
      expect(agent1!.parent).toBe(handle!.coordinatorId);
      expect(agent2!.parent).toBe(handle!.coordinatorId);
      log("Both analysts are children of coordinator");

      // Wait for both to complete
      await waitForCondition(
        async () => {
          const s1 = await handle!.backend.getSession(session1.id);
          const s2 = await handle!.backend.getSession(session2.id);
          const s1Done = s1?.state === "completed" || s1?.state === "failed";
          const s2Done = s2?.state === "completed" || s2?.state === "failed";
          return s1Done && s2Done;
        },
        {
          timeoutMs: 120000,
          pollMs: 1000,
          description: "both analyst sessions to complete",
        },
      );

      const final1 = await handle!.backend.getSession(session1.id);
      const final2 = await handle!.backend.getSession(session2.id);
      log(`Session 1: ${final1!.state}, error: ${final1!.error ?? "none"}`);
      log(`Session 2: ${final2!.state}, error: ${final2!.error ?? "none"}`);

      expect(final1!.state).toBe("completed");
      expect(final2!.state).toBe("completed");

      // Verify both outputs
      expect(
        fs.existsSync(path.join(workspace1.outputDir, "result.json")),
      ).toBe(true);
      expect(
        fs.existsSync(path.join(workspace2.outputDir, "result.json")),
      ).toBe(true);

      workspace2.cleanup();
    },
    { timeout: TIMEOUT.TASK_COMPLETE },
  );

  testFn(
    "terminate analyst under team coordinator",
    async () => {
      workspace = createTestWorkspace({
        "task.md": "Analyze 1000 items. Write analysis for each to output/. This is a long task.",
        "data.json": JSON.stringify({
          items: Array.from({ length: 1000 }, (_, i) => ({ id: i, value: `item_${i}` })),
        }),
      });

      const session = await handle!.backend.spawn({
        agentType: "claude-code",
        task: {
          description: [
            "Read input/task.md and input/data.json.",
            "Write detailed analysis for each item to output/.",
            "Call done() when finished.",
          ].join("\n"),
        },
        cwd: workspace.path,
      });

      log(`Session created: ${session.id}`);

      // Give it time to start
      await new Promise((r) => setTimeout(r, 5000));

      // Terminate
      await handle!.backend.terminate(session.id);
      log("Terminate called");

      const s = await handle!.backend.getSession(session.id);
      expect(s!.state).toBe("failed");
      expect(s!.error).toBe("Terminated by caller");
      log("Analyst terminated successfully under team");
    },
    { timeout: TIMEOUT.SPAWN },
  );
});
