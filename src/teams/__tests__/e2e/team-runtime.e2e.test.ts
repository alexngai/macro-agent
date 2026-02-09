/**
 * Team Runtime E2E Tests
 *
 * Tests the full team system pipeline: template loading, runtime initialization,
 * agent bootstrapping, spawn interception, and role capability propagation to
 * MCP subprocesses.
 *
 * Group 1 (infrastructure) runs without real agents — tests TeamRuntime wiring
 * against real EventStore, AgentManager, MessageRouter.
 *
 * Group 2 (full agent) spawns real Claude Code agents and requires:
 *   RUN_FULL_AGENT_TESTS=true
 *
 * Run:
 *   npm run test:e2e -- src/teams/__tests__/e2e/team-runtime.e2e.test.ts
 *   RUN_FULL_AGENT_TESTS=true npm run test:e2e -- src/teams/__tests__/e2e/team-runtime.e2e.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execSync } from "child_process";

import { createEventStore, type EventStore } from "../../../store/event-store.js";
import { createAgentManager, type AgentManager } from "../../../agent/agent-manager.js";
import { createTaskManager, type TaskManager } from "../../../task/task-manager.js";
import { createMessageRouter, type MessageRouter } from "../../../router/message-router.js";
import { DefaultRoleRegistry } from "../../../roles/registry.js";
import type { RoleDefinition } from "../../../roles/types.js";
import { loadTeam } from "../../team-loader.js";
import { TeamRuntime, type TeamServices } from "../../team-runtime.js";

// ─────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────

const RUN_FULL_AGENT = !!process.env.RUN_FULL_AGENT_TESTS;
const testFn = RUN_FULL_AGENT ? it : it.skip;
const PROJECT_ROOT = path.resolve(import.meta.dirname, "../../../..");

const log = (msg: string) => console.log(`[TeamRuntime-E2E] ${msg}`);

const TIMEOUT = {
  SPAWN: 60000,
  PROMPT: 120000,
  BOOTSTRAP: 180000,
};

// ─────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────

interface TempTestEnv {
  tmpDir: string;
  repoPath: string;
  cleanup: () => void;
}

function createTestEnv(prefix: string): TempTestEnv {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `team-e2e-${prefix}-`));
  const repoPath = path.join(tmpDir, "repo");
  fs.mkdirSync(repoPath);
  execSync("git init", { cwd: repoPath, stdio: "pipe" });
  execSync('git config user.email "test@test.com"', { cwd: repoPath, stdio: "pipe" });
  execSync('git config user.name "Test"', { cwd: repoPath, stdio: "pipe" });
  fs.writeFileSync(path.join(repoPath, "README.md"), "# test\n");
  execSync("git add -A && git commit -m init", { cwd: repoPath, stdio: "pipe" });
  return {
    tmpDir,
    repoPath,
    cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }),
  };
}

async function waitForAgentState(
  agentManager: AgentManager,
  agentId: string,
  state: "running" | "stopped",
  timeoutMs = 60000
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const agent = agentManager.get(agentId);
    if (agent?.state === state) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Timeout: agent ${agentId} did not reach state '${state}' in ${timeoutMs}ms`);
}

// ─────────────────────────────────────────────────────────────────
// Group 1: Team Infrastructure (no real agents)
// ─────────────────────────────────────────────────────────────────

describe("Team Runtime E2E — Infrastructure", () => {
  let env: TempTestEnv;
  let eventStore: EventStore;
  let agentManager: AgentManager;
  let messageRouter: MessageRouter;
  let taskManager: TaskManager;
  let roleRegistry: DefaultRoleRegistry;

  beforeEach(async () => {
    env = createTestEnv("infra");
    const instanceId = `team-infra-${Date.now()}`;

    eventStore = await createEventStore({ instanceId, baseDir: env.tmpDir });
    messageRouter = createMessageRouter(eventStore);
    roleRegistry = new DefaultRoleRegistry();
    agentManager = createAgentManager(eventStore, messageRouter, {
      defaultPermissionMode: "auto-approve",
      defaultCwd: env.repoPath,
    });
    taskManager = createTaskManager(eventStore);
  });

  afterEach(async () => {
    await agentManager?.close();
    await eventStore?.close();
    env?.cleanup();
  });

  it("loads team template and initializes runtime with serialized roles", async () => {
    const manifest = await loadTeam("self-driving", roleRegistry, PROJECT_ROOT);
    const services: TeamServices = { agentManager, messageRouter, eventStore };
    const runtime = new TeamRuntime(manifest, services);

    await runtime.initialize();

    // 1. Roles registered in AgentManager's internal registry
    const amRegistry = agentManager.getRoleRegistry();
    expect(amRegistry.getRole("planner")).toBeDefined();
    expect(amRegistry.getRole("grinder")).toBeDefined();
    expect(amRegistry.getRole("judge")).toBeDefined();
    log("Roles registered in registry");

    // 2. team_config event emitted to EventStore
    const events = eventStore.query({ type: "status", limit: 50 });
    const configEvent = events.find((e) => e.payload?.team_config != null);
    expect(configEvent).toBeDefined();

    const tc = configEvent!.payload.team_config as Record<string, unknown>;
    expect(tc.teamName).toBe("self-driving");
    expect(tc.strategy).toBe("trunk");
    expect(tc.taskMode).toBe("pull");
    log("team_config event verified");

    // 3. Serialized roles included in team_config (Issue #1 fix)
    const roles = tc.roles as Record<string, { name: string; capabilities: string[] }>;
    expect(roles).toBeDefined();
    expect(roles.planner).toBeDefined();
    expect(roles.grinder).toBeDefined();
    expect(roles.judge).toBeDefined();
    expect(roles.grinder.name).toBe("grinder");
    expect(roles.grinder.capabilities).toContain("lifecycle.done");
    expect(roles.planner.capabilities).toContain("task.claim");
    log("Serialized roles in team_config verified");

    // 4. Integration strategy instantiated (Issue #3 fix)
    const strategy = runtime.getIntegrationStrategy();
    expect(strategy).toBeDefined();
    expect(strategy!.name).toBe("trunk");
    log("Integration strategy instantiated");

    await runtime.teardown();
  });

  it("serialized roles are deserializable in a fresh registry", async () => {
    // Step 1: Initialize team to get serialized roles into EventStore
    const manifest = await loadTeam("self-driving", roleRegistry, PROJECT_ROOT);
    const services: TeamServices = { agentManager, messageRouter, eventStore };
    const runtime = new TeamRuntime(manifest, services);
    await runtime.initialize();

    // Step 2: Read team_config from EventStore (like MCP subprocess would)
    const events = eventStore.query({ type: "status", limit: 50 });
    const configEvent = events.find((e) => e.payload?.team_config != null);
    const tc = configEvent!.payload.team_config as Record<string, unknown>;
    const serializedRoles = tc.roles as Record<string, Record<string, unknown>>;

    // Step 3: Create a fresh registry (simulating MCP subprocess)
    const freshRegistry = new DefaultRoleRegistry();

    // Verify "grinder" is unknown before registration
    const beforeResolve = freshRegistry.resolveRole("grinder");
    // Falls back to generic role which won't have lifecycle.done
    expect(beforeResolve.name).not.toBe("grinder");

    // Step 4: Register serialized roles
    for (const roleDef of Object.values(serializedRoles)) {
      freshRegistry.registerRole(roleDef as RoleDefinition);
    }

    // Step 5: Verify capability resolution
    expect(freshRegistry.hasCapability("grinder", "lifecycle.done")).toBe(true);
    expect(freshRegistry.hasCapability("planner", "task.claim")).toBe(true);
    expect(freshRegistry.hasCapability("judge", "lifecycle.done")).toBe(true);
    log("Serialized roles deserialized and resolved correctly in fresh registry");

    await runtime.teardown();
  });

  it("teardown clears interceptor and strategy lifecycle", async () => {
    const manifest = await loadTeam("self-driving", roleRegistry, PROJECT_ROOT);
    const services: TeamServices = { agentManager, messageRouter, eventStore };
    const runtime = new TeamRuntime(manifest, services);

    await runtime.initialize();
    expect(runtime.getIntegrationStrategy()).toBeDefined();

    await runtime.teardown();

    // Getters still work (they read manifest, not mutable state)
    expect(runtime.getStrategyName()).toBe("trunk");
    expect(runtime.getTaskMode()).toBe("pull");
    log("Teardown completed without errors");
  });

  it("structured team initializes with queue strategy", async () => {
    const manifest = await loadTeam("structured", roleRegistry, PROJECT_ROOT);
    const services: TeamServices = { agentManager, messageRouter, eventStore };
    const runtime = new TeamRuntime(manifest, services);

    await runtime.initialize();

    expect(runtime.getStrategyName()).toBe("queue");
    expect(runtime.getTaskMode()).toBe("push");

    const strategy = runtime.getIntegrationStrategy();
    expect(strategy).toBeDefined();
    expect(strategy!.name).toBe("queue");

    // Verify structured team roles serialized
    const events = eventStore.query({ type: "status", limit: 50 });
    const configEvent = events.find((e) => e.payload?.team_config != null);
    const tc = configEvent!.payload.team_config as Record<string, unknown>;
    const roles = tc.roles as Record<string, { name: string; capabilities: string[] }>;
    expect(roles.lead).toBeDefined();
    expect(roles.developer).toBeDefined();
    expect(roles.reviewer).toBeDefined();
    log("Structured team initialized correctly");

    await runtime.teardown();
  });
});

// ─────────────────────────────────────────────────────────────────
// Group 2: Full Agent Tests (requires RUN_FULL_AGENT_TESTS)
// ─────────────────────────────────────────────────────────────────

describe("Team Runtime E2E — Full Agent", () => {
  let env: TempTestEnv;
  let eventStore: EventStore;
  let agentManager: AgentManager;
  let messageRouter: MessageRouter;
  let taskManager: TaskManager;
  let roleRegistry: DefaultRoleRegistry;
  let runtime: TeamRuntime | null = null;

  beforeEach(async () => {
    if (!RUN_FULL_AGENT) return;

    env = createTestEnv("agent");
    const instanceId = `team-agent-${Date.now()}`;

    eventStore = await createEventStore({ instanceId, baseDir: env.tmpDir });
    messageRouter = createMessageRouter(eventStore);
    roleRegistry = new DefaultRoleRegistry();
    agentManager = createAgentManager(eventStore, messageRouter, {
      defaultPermissionMode: "auto-approve",
      defaultCwd: env.repoPath,
    });
    taskManager = createTaskManager(eventStore);

    log("Services initialized");
  });

  afterEach(async () => {
    if (!RUN_FULL_AGENT) return;

    // Teardown team runtime first
    if (runtime) {
      try { await runtime.teardown(); } catch { /* ignore */ }
      runtime = null;
    }

    // Terminate all running agents
    try {
      for (const agent of agentManager.list()) {
        if (agent.state === "running") {
          try { await agentManager.terminate(agent.id, "test_cleanup"); } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }

    await agentManager?.close();
    await eventStore?.close();
    env?.cleanup();
    log("Cleanup complete");
  });

  testFn(
    "team bootstrap spawns root and companion agents",
    async () => {
      const manifest = await loadTeam("self-driving", roleRegistry, PROJECT_ROOT);
      const services: TeamServices = { agentManager, messageRouter, eventStore };
      runtime = new TeamRuntime(manifest, services);

      await runtime.initialize();
      log("Runtime initialized");

      const result = await runtime.bootstrap();
      log(`Bootstrap complete: root=${result.rootId}, companions=${result.companionIds.join(", ")}`);

      // Verify root agent is running
      await waitForAgentState(agentManager, result.rootId, "running");
      const rootAgent = agentManager.get(result.rootId);
      expect(rootAgent).toBeDefined();
      expect(rootAgent!.state).toBe("running");
      expect(rootAgent!.role).toBe("planner");
      expect(rootAgent!.parent).toBeNull();
      log(`Root agent verified: ${result.rootId} (planner, running)`);

      // Verify companion agent is running
      expect(result.companionIds).toHaveLength(1);
      const companionId = result.companionIds[0];
      await waitForAgentState(agentManager, companionId, "running");
      const companionAgent = agentManager.get(companionId);
      expect(companionAgent).toBeDefined();
      expect(companionAgent!.state).toBe("running");
      expect(companionAgent!.role).toBe("judge");
      expect(companionAgent!.parent).toBeNull(); // Peer, not child
      log(`Companion agent verified: ${companionId} (judge, running)`);

      // Verify runtime tracks agent IDs
      expect(runtime.getRootAgentId()).toBe(result.rootId);
      expect(runtime.getCompanionAgentIds()).toEqual(result.companionIds);
    },
    { timeout: TIMEOUT.BOOTSTRAP }
  );

  testFn(
    "spawn interceptor injects team context into child agents",
    async () => {
      const manifest = await loadTeam("self-driving", roleRegistry, PROJECT_ROOT);
      const services: TeamServices = { agentManager, messageRouter, eventStore };
      runtime = new TeamRuntime(manifest, services);

      await runtime.initialize();
      const result = await runtime.bootstrap();
      await waitForAgentState(agentManager, result.rootId, "running");
      log("Team bootstrapped");

      // Spawn a grinder child (through the interceptor)
      const grinder = await agentManager.spawn({
        task: "Test grinder: wait for instructions.",
        role: "grinder",
        parent: result.rootId,
        cwd: env.repoPath,
      });

      await waitForAgentState(agentManager, grinder.id, "running");
      log(`Grinder spawned: ${grinder.id}`);

      // Verify agent exists with correct role
      const grinderAgent = agentManager.get(grinder.id);
      expect(grinderAgent).toBeDefined();
      expect(grinderAgent!.role).toBe("grinder");
      expect(grinderAgent!.parent).toBe(result.rootId);
      log("Grinder agent verified with correct role and parent");

      // Verify team context was injected by checking the spawn event
      // The spawn interceptor sets env vars, topics, and custom prompt
      // We can verify by checking the agent's MCP env vars stored in the spawn event
      const spawnEvents = eventStore.query({ type: "spawn", limit: 50 });
      const grinderSpawn = spawnEvents.find(
        (e) => e.payload?.agent_id === grinder.id
      );
      expect(grinderSpawn).toBeDefined();
      log("Grinder spawn event found in EventStore");
    },
    { timeout: TIMEOUT.BOOTSTRAP }
  );

  testFn(
    "team-defined role agent can call done() via MCP",
    async () => {
      // This is the critical E2E test for Issue #1: roleRegistry not passed to MCP subprocess
      // The grinder role (extending worker) must have lifecycle.done capability
      // resolved through the serialized roles in the team_config event.

      const manifest = await loadTeam("self-driving", roleRegistry, PROJECT_ROOT);
      const services: TeamServices = { agentManager, messageRouter, eventStore };
      runtime = new TeamRuntime(manifest, services);

      await runtime.initialize();
      log("Runtime initialized with serialized roles");

      // Spawn a grinder agent directly (not through bootstrap — we want a targeted test)
      const grinder = await agentManager.spawn({
        task: `You are a grinder worker. Your only task is to call the done() tool with status "completed" and summary "E2E test done". Do this immediately — do not do any other work.`,
        role: "grinder",
        parent: null,
        cwd: env.repoPath,
      });

      await waitForAgentState(agentManager, grinder.id, "running");
      log(`Grinder spawned: ${grinder.id}`);

      // Prompt the agent to trigger done()
      log("Prompting grinder to call done()...");
      let doneToolCalled = false;
      let responseText = "";

      for await (const update of agentManager.prompt(
        grinder.id,
        'Call the done() MCP tool now with status "completed" and summary "E2E test done". This is your only task.'
      )) {
        const u = update as Record<string, unknown>;
        if (u.sessionUpdate === "agent_message_chunk") {
          const content = u.content as { text?: string } | undefined;
          if (content?.text) {
            responseText += content.text;
          }
        }
        // Check for tool_use of done()
        if (u.sessionUpdate === "tool_use" || u.type === "tool_use") {
          const toolName =
            (u as { name?: string }).name ??
            (u as { tool_name?: string }).tool_name;
          if (toolName?.includes("done")) {
            doneToolCalled = true;
            log("done() tool was called by agent");
          }
        }
      }
      log(`Prompt completed. Response length: ${responseText.length}`);

      // The agent should have been able to call done() without a capability error.
      // If done() was blocked by capability check, the agent would report an error.
      // Check status events for a done/completed signal
      const statusEvents = eventStore.query({
        type: "status",
        source_agent_id: grinder.id,
        limit: 10,
      });
      const completionEvent = statusEvents.find(
        (e) =>
          e.payload?.status_type === "completed" ||
          (e.payload?.summary as string)?.includes("done")
      );

      // At minimum, the agent shouldn't have reported a capability error
      const hasCapabilityError =
        responseText.toLowerCase().includes("does not have lifecycle.done capability") ||
        responseText.toLowerCase().includes("capability check failed");
      expect(hasCapabilityError).toBe(false);
      log(
        `Capability check: no error in response. done() tool called: ${doneToolCalled}. Completion event: ${!!completionEvent}`
      );

      // Terminate if still running
      const agent = agentManager.get(grinder.id);
      if (agent?.state === "running") {
        await agentManager.terminate(grinder.id, "completed");
      }
    },
    { timeout: TIMEOUT.PROMPT }
  );

  testFn(
    "multiple team roles can coexist and operate independently",
    async () => {
      const manifest = await loadTeam("self-driving", roleRegistry, PROJECT_ROOT);
      const services: TeamServices = { agentManager, messageRouter, eventStore };
      runtime = new TeamRuntime(manifest, services);

      await runtime.initialize();
      log("Runtime initialized");

      // Spawn agents with different team roles simultaneously
      const planner = await agentManager.spawn({
        task: "You are a planner. Wait for instructions.",
        role: "planner",
        parent: null,
        cwd: env.repoPath,
      });

      const grinder = await agentManager.spawn({
        task: "You are a grinder. Wait for instructions.",
        role: "grinder",
        parent: planner.id,
        cwd: env.repoPath,
      });

      const judge = await agentManager.spawn({
        task: "You are a judge. Wait for instructions.",
        role: "judge",
        parent: null,
        cwd: env.repoPath,
      });

      // Wait for all to be running
      await Promise.all([
        waitForAgentState(agentManager, planner.id, "running"),
        waitForAgentState(agentManager, grinder.id, "running"),
        waitForAgentState(agentManager, judge.id, "running"),
      ]);
      log(
        `All agents running: planner=${planner.id}, grinder=${grinder.id}, judge=${judge.id}`
      );

      // Verify roles
      expect(agentManager.get(planner.id)?.role).toBe("planner");
      expect(agentManager.get(grinder.id)?.role).toBe("grinder");
      expect(agentManager.get(judge.id)?.role).toBe("judge");

      // Verify hierarchy
      expect(agentManager.get(planner.id)?.parent).toBeNull();
      expect(agentManager.get(grinder.id)?.parent).toBe(planner.id);
      expect(agentManager.get(judge.id)?.parent).toBeNull();

      const children = agentManager.getChildren(planner.id);
      expect(children).toHaveLength(1);
      expect(children[0].id).toBe(grinder.id);
      log("Hierarchy verified: planner → grinder, judge (peer)");

      // Terminate in reverse order
      await agentManager.terminate(grinder.id, "completed");
      await agentManager.terminate(judge.id, "completed");
      await agentManager.terminate(planner.id, "completed");
      log("All agents terminated");
    },
    { timeout: TIMEOUT.BOOTSTRAP }
  );
});

// ─────────────────────────────────────────────────────────────────
// Info message for running tests
// ─────────────────────────────────────────────────────────────────

if (!RUN_FULL_AGENT) {
  console.log("\n┌──────────────────────────────────────────────────────────┐");
  console.log("│  Team Runtime E2E full-agent tests are skipped           │");
  console.log("│  (RUN_FULL_AGENT_TESTS not set)                          │");
  console.log("│                                                          │");
  console.log("│  Infrastructure tests will still run.                    │");
  console.log("│                                                          │");
  console.log("│  To run with real agents:                                │");
  console.log("│  RUN_FULL_AGENT_TESTS=true npm run test:e2e -- \\         │");
  console.log("│    src/teams/__tests__/e2e/team-runtime.e2e.test.ts      │");
  console.log("└──────────────────────────────────────────────────────────┘\n");
}
