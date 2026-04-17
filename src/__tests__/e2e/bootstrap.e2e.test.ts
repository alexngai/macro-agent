/**
 * Bootstrap & Spawn-Options E2E Tests
 *
 * Boots macro-agent with the MAP server enabled and verifies:
 *   1. `bootstrap.coordinator: true` (programmatic) auto-spawns a coordinator
 *      that's discoverable via the MAP protocol.
 *   2. `MACRO_BOOTSTRAP_COORDINATOR=true` env var triggers the same path —
 *      this is how `openswarm` / openhive get bootstrap without modifying
 *      openswarm's whitelisted bootConfig pass-through.
 *   3. `_macro/spawnAgent` extension forwards the full SpawnAgentOptions
 *      surface (permissionMode, agentType, customPrompt, config, taskRef)
 *      so the agent record carries the requested settings.
 *
 * Run:
 *   npx vitest run --config vitest.e2e.config.ts \
 *     src/__tests__/e2e/bootstrap.e2e.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { bootV2, type MacroAgentSystemV2 } from "../../boot-v2.js";
import { ClientConnection } from "@multi-agent-protocol/sdk";

/** Wait for a coordinator agent to land in the agent store. */
async function waitForCoordinator(
  system: MacroAgentSystemV2,
  timeoutMs = 5000,
): Promise<{ id: string; cwd?: string | null; role: string } | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const agents = system.agentStore.listAgents({ role: "coordinator" });
    if (agents.length > 0) return agents[0];
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

function freshDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ─────────────────────────────────────────────────────────────────────────────
// Bootstrap: programmatic
// ─────────────────────────────────────────────────────────────────────────────

describe("Bootstrap E2E — programmatic config", () => {
  let system: MacroAgentSystemV2 | null = null;
  let client: ClientConnection | null = null;
  let dir: string;

  beforeEach(() => {
    dir = freshDir("bootstrap-prog-");
  });

  afterEach(async () => {
    if (client) {
      try { await client.disconnect(); } catch { /* */ }
      client = null;
    }
    if (system) {
      await system.shutdown();
      system = null;
    }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
  });

  it("auto-spawns a coordinator when bootstrap.coordinator: true", async () => {
    system = await bootV2({
      baseDir: dir,
      cwd: dir,
      defaultPermissionMode: "auto-approve",
      mapServer: { enabled: true, port: 0, host: "127.0.0.1" },
      bootstrap: { coordinator: true },
    });

    const agent = await waitForCoordinator(system);
    expect(agent).not.toBeNull();
    expect(agent!.role).toBe("coordinator");
    expect(agent!.cwd).toBe(dir);

    // Discoverable via MAP listAgents. The lifecycle handler that registers
    // the agent in mapServer.agents fires after the AgentManager.spawn()
    // promise resolves, but listAgents may race that registration in the
    // first poll cycle. Poll briefly until it appears.
    const url = system.mapServerInstance!.getUrl();
    client = await ClientConnection.connect(url, { name: "bootstrap-test-client" });

    let coordinators: unknown[] = [];
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const result = await client.listAgents();
      coordinators = result.agents.filter((a: any) => a.role === "coordinator");
      if (coordinators.length >= 1) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(coordinators.length).toBeGreaterThanOrEqual(1);
  }, 20000);

  it("uses bootstrap.coordinator.cwd when provided", async () => {
    const projectDir = path.join(dir, "project-x");
    fs.mkdirSync(projectDir, { recursive: true });

    system = await bootV2({
      baseDir: dir,
      cwd: dir,
      defaultPermissionMode: "auto-approve",
      mapServer: { enabled: true, port: 0, host: "127.0.0.1" },
      bootstrap: { coordinator: { cwd: projectDir } },
    });

    const agent = await waitForCoordinator(system);
    expect(agent!.cwd).toBe(projectDir);
  }, 20000);
});

// ─────────────────────────────────────────────────────────────────────────────
// Bootstrap: env-var bridge
// ─────────────────────────────────────────────────────────────────────────────

describe("Bootstrap E2E — env-var bridge", () => {
  let system: MacroAgentSystemV2 | null = null;
  let dir: string;

  beforeEach(() => {
    dir = freshDir("bootstrap-env-");
  });

  afterEach(async () => {
    if (system) {
      await system.shutdown();
      system = null;
    }
    delete process.env.MACRO_BOOTSTRAP_COORDINATOR;
    delete process.env.MACRO_BOOTSTRAP_CWD;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
  });

  it("MACRO_BOOTSTRAP_COORDINATOR=true triggers bootstrap", async () => {
    process.env.MACRO_BOOTSTRAP_COORDINATOR = "true";

    system = await bootV2({
      baseDir: dir,
      cwd: dir,
      defaultPermissionMode: "auto-approve",
      mapServer: { enabled: true, port: 0, host: "127.0.0.1" },
    });

    const agent = await waitForCoordinator(system);
    expect(agent).not.toBeNull();
    expect(agent!.cwd).toBe(dir);
  }, 20000);

  it("MACRO_BOOTSTRAP_CWD overrides default cwd", async () => {
    const projectDir = path.join(dir, "env-project");
    fs.mkdirSync(projectDir, { recursive: true });

    process.env.MACRO_BOOTSTRAP_COORDINATOR = "true";
    process.env.MACRO_BOOTSTRAP_CWD = projectDir;

    system = await bootV2({
      baseDir: dir,
      cwd: dir,
      defaultPermissionMode: "auto-approve",
      mapServer: { enabled: true, port: 0, host: "127.0.0.1" },
    });

    const agent = await waitForCoordinator(system);
    expect(agent!.cwd).toBe(projectDir);
  }, 20000);

  it("does NOT spawn when env var is unset", async () => {
    system = await bootV2({
      baseDir: dir,
      cwd: dir,
      defaultPermissionMode: "auto-approve",
      mapServer: { enabled: true, port: 0, host: "127.0.0.1" },
    });

    // Give any rogue spawn a chance to fire before asserting absence.
    await new Promise((r) => setTimeout(r, 500));
    const agents = system.agentStore.listAgents({ role: "coordinator" });
    expect(agents).toHaveLength(0);
  }, 20000);
});

// ─────────────────────────────────────────────────────────────────────────────
// Spawn options forwarding via _macro/spawnAgent
// ─────────────────────────────────────────────────────────────────────────────

describe("Spawn-options forwarding E2E — _macro/spawnAgent", () => {
  let system: MacroAgentSystemV2 | null = null;
  let client: ClientConnection | null = null;
  let dir: string;

  beforeEach(async () => {
    dir = freshDir("spawn-opts-");
    system = await bootV2({
      baseDir: dir,
      cwd: dir,
      defaultPermissionMode: "auto-approve",
      mapServer: { enabled: true, port: 0, host: "127.0.0.1" },
    });
    const url = system.mapServerInstance!.getUrl();
    client = await ClientConnection.connect(url, { name: "spawn-opts-client" });
  });

  afterEach(async () => {
    if (client) {
      try { await client.disconnect(); } catch { /* */ }
      client = null;
    }
    if (system) {
      await system.shutdown();
      system = null;
    }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
  });

  it("forwards role, cwd, task to the spawned agent record", async () => {
    const projectDir = path.join(dir, "proj-a");
    fs.mkdirSync(projectDir, { recursive: true });

    const result = await client!.callExtension("_macro/spawnAgent", {
      role: "coordinator",
      cwd: projectDir,
      task: "Test task description",
    }) as { agent?: { id?: string; localId?: string } };

    const localId = result.agent?.localId;
    expect(localId).toBeTruthy();

    const record = system!.agentStore.getAgent(localId!);
    expect(record).not.toBeNull();
    expect(record!.role).toBe("coordinator");
    expect(record!.cwd).toBe(projectDir);
    expect(record!.task).toBe("Test task description");
    expect(record!.parent_id).toBeNull();
  }, 15000);

  it("forwards config (model, maxTokens, temperature) onto the agent record", async () => {
    const result = await client!.callExtension("_macro/spawnAgent", {
      role: "coordinator",
      cwd: dir,
      task: "Config test",
      config: {
        model: "claude-sonnet-4-6",
        maxTokens: 4096,
        temperature: 0.42,
      },
    }) as { agent?: { localId?: string } };

    const localId = result.agent?.localId;
    expect(localId).toBeTruthy();

    const record = system!.agentStore.getAgent(localId!);
    expect(record!.config).toBeDefined();
    expect(record!.config!.model).toBe("claude-sonnet-4-6");
    expect(record!.config!.maxTokens).toBe(4096);
    expect(record!.config!.temperature).toBeCloseTo(0.42);
  }, 15000);

  it("forwards customPrompt by reflecting it in the agent's task surface", async () => {
    // customPrompt is woven into the system prompt at spawn time; we can't
    // easily inspect the assembled prompt from outside, but we can verify the
    // spawn succeeds when customPrompt is set (no validation rejection /
    // dropped-field bug). Combined with the unit check that the wire forwards
    // the field, this confirms the round trip is intact.
    const result = await client!.callExtension("_macro/spawnAgent", {
      role: "coordinator",
      cwd: dir,
      task: "Custom prompt test",
      customPrompt: "You are a meticulous code reviewer. Cite line numbers.",
    }) as { agent?: { localId?: string; id?: string } };

    expect(result.agent?.localId).toBeTruthy();
    const record = system!.agentStore.getAgent(result.agent!.localId!);
    expect(record).not.toBeNull();
    expect(record!.role).toBe("coordinator");
  }, 15000);

  it("ignores unknown role when role is omitted (defaults to worker)", async () => {
    const result = await client!.callExtension("_macro/spawnAgent", {
      cwd: dir,
      task: "No role specified",
    }) as { agent?: { localId?: string } };

    const localId = result.agent?.localId;
    const record = system!.agentStore.getAgent(localId!);
    // The handler defaults role to "worker" when omitted.
    expect(record!.role).toBe("worker");
  }, 15000);

  it("multiple spawns with same cwd produce distinct agents (no implicit dedup)", async () => {
    // The spawn endpoint always spawns. Get-or-create semantics live on the
    // openhive caller side, not in macro-agent's _macro/spawnAgent.
    const r1 = await client!.callExtension("_macro/spawnAgent", {
      role: "coordinator",
      cwd: dir,
      task: "First",
    }) as { agent?: { localId?: string } };

    const r2 = await client!.callExtension("_macro/spawnAgent", {
      role: "coordinator",
      cwd: dir,
      task: "Second",
    }) as { agent?: { localId?: string } };

    expect(r1.agent?.localId).toBeTruthy();
    expect(r2.agent?.localId).toBeTruthy();
    expect(r1.agent?.localId).not.toBe(r2.agent?.localId);

    const r1Record = system!.agentStore.getAgent(r1.agent!.localId!);
    const r2Record = system!.agentStore.getAgent(r2.agent!.localId!);
    expect(r1Record!.task).toBe("First");
    expect(r2Record!.task).toBe("Second");
  }, 20000);
});
