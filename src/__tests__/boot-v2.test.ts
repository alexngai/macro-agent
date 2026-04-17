/**
 * Boot V2 Integration Test
 *
 * Verifies that all V2 components wire together correctly.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import { bootV2, type MacroAgentSystemV2 } from "../boot-v2.js";

// Mock acp-factory (no real agent processes in unit tests)
vi.mock("acp-factory", () => ({
  AgentFactory: {
    spawn: vi.fn().mockResolvedValue({
      createSession: vi.fn().mockResolvedValue({
        id: "provider-session-1",
        prompt: vi.fn().mockReturnValue({
          [Symbol.asyncIterator]: () => ({
            next: () => Promise.resolve({ done: true, value: undefined }),
          }),
        }),
        forkWithFlush: vi.fn().mockResolvedValue({ id: "forked-1" }),
      }),
      loadSession: vi.fn().mockResolvedValue({
        id: "loaded-session-1",
      }),
      close: vi.fn().mockResolvedValue(undefined),
    }),
  },
}));

// Mock opentasks (daemon may not be available)
vi.mock("opentasks", () => ({
  OpenTasksClient: vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockRejectedValue(new Error("No daemon")),
    disconnect: vi.fn(),
    query: vi.fn().mockResolvedValue({ items: [] }),
    link: vi.fn().mockResolvedValue({ success: true }),
    task: vi.fn().mockResolvedValue({ id: "t-1" }),
  })),
}));

describe("Boot V2", () => {
  let system: MacroAgentSystemV2 | null = null;
  let testDir: string;

  function createTestDir(): string {
    const dir = path.join(
      os.tmpdir(),
      `boot-v2-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  afterEach(async () => {
    if (system) {
      await system.shutdown();
      system = null;
    }
    if (testDir && fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("should boot all V2 components", async () => {
    testDir = createTestDir();

    system = await bootV2({
      cwd: testDir,
      baseDir: testDir,
      inbox: {
        socketPath: path.join(testDir, "inbox.sock"),
      },
    });

    expect(system.agentManager).toBeDefined();
    expect(system.agentStore).toBeDefined();
    expect(system.inboxAdapter).toBeDefined();
    expect(system.tasksAdapter).toBeDefined();
    expect(system.triggerSystem).toBeDefined();
    expect(system.roleRegistry).toBeDefined();
  });

  it("should spawn and terminate an agent through V2 stack", async () => {
    testDir = createTestDir();

    system = await bootV2({
      cwd: testDir,
      baseDir: testDir,
      inbox: {
        socketPath: path.join(testDir, "inbox.sock"),
      },
    });

    // Spawn
    const spawned = await system.agentManager.spawn({
      task: "Integration test task",
      role: "worker",
    });

    expect(spawned.id).toBeDefined();
    expect(spawned.agent.state).toBe("running");

    // Verify in AgentStore
    const record = system.agentStore.getAgent(spawned.id);
    expect(record).not.toBeNull();
    expect(record!.role).toBe("worker");

    // Terminate
    await system.agentManager.terminate(spawned.id, "completed");

    const stopped = system.agentStore.getAgent(spawned.id);
    expect(stopped!.state).toBe("stopped");
  });

  it("should register agents in inbox on spawn", async () => {
    testDir = createTestDir();

    system = await bootV2({
      cwd: testDir,
      baseDir: testDir,
      inbox: {
        socketPath: path.join(testDir, "inbox.sock"),
      },
    });

    const spawned = await system.agentManager.spawn({
      task: "Test",
      role: "coordinator",
    });

    // Agent should be registered in inbox
    const inbox = (system.inboxAdapter as any).getInbox();
    const agent = inbox.storage.getAgent(spawned.id);
    expect(agent).toBeDefined();
    expect(agent.status).toBe("active");
  });

  it("should handle opentasks unavailability gracefully", async () => {
    testDir = createTestDir();

    // Boot should succeed even if opentasks daemon is not running
    system = await bootV2({
      cwd: testDir,
      baseDir: testDir,
      inbox: {
        socketPath: path.join(testDir, "inbox.sock"),
      },
    });

    expect(system.tasksAdapter.connected).toBe(false);

    // Agent spawn should still work (opentasks task creation is non-fatal)
    const spawned = await system.agentManager.spawn({
      task: "Works without opentasks",
      role: "worker",
    });
    expect(spawned.id).toBeDefined();
  });

  it("should wire trigger system to inbox delivery", async () => {
    testDir = createTestDir();

    system = await bootV2({
      cwd: testDir,
      baseDir: testDir,
      inbox: {
        socketPath: path.join(testDir, "inbox.sock"),
      },
    });

    expect(system.triggerSystem.isRunning()).toBe(true);
  });

  it("should shut down cleanly", async () => {
    testDir = createTestDir();

    system = await bootV2({
      cwd: testDir,
      baseDir: testDir,
      inbox: {
        socketPath: path.join(testDir, "inbox.sock"),
      },
    });

    await system.shutdown();

    expect(system.triggerSystem.isRunning()).toBe(false);

    // Prevent double-shutdown in afterEach
    system = null;
  });

  describe("bootstrap", () => {
    /**
     * Wait for a coordinator to appear in the agent store. The bootstrap
     * spawn is fired non-blocking (so boot doesn't gate on agent process
     * startup), so direct `await bootV2(...)` returns before the coordinator
     * exists. Poll with a short timeout to bridge the gap.
     */
    async function waitForCoordinator(
      sys: MacroAgentSystemV2,
      timeoutMs = 2000,
    ): Promise<{ id: string; cwd?: string | null } | null> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const agents = sys.agentStore.listAgents({ role: "coordinator" });
        if (agents.length > 0) return agents[0];
        await new Promise((r) => setTimeout(r, 25));
      }
      return null;
    }

    afterEach(() => {
      delete process.env.MACRO_BOOTSTRAP_COORDINATOR;
      delete process.env.MACRO_BOOTSTRAP_CWD;
    });

    it("does not spawn when bootstrap is unset", async () => {
      testDir = createTestDir();
      system = await bootV2({
        cwd: testDir,
        baseDir: testDir,
        inbox: { socketPath: path.join(testDir, "inbox.sock") },
      });
      // Give any rogue spawn a chance to fire before asserting absence.
      await new Promise((r) => setTimeout(r, 250));
      const agents = system.agentStore.listAgents({ role: "coordinator" });
      expect(agents).toHaveLength(0);
    });

    it("spawns a coordinator when bootstrap.coordinator: true", async () => {
      testDir = createTestDir();
      system = await bootV2({
        cwd: testDir,
        baseDir: testDir,
        inbox: { socketPath: path.join(testDir, "inbox.sock") },
        bootstrap: { coordinator: true },
      });
      const agent = await waitForCoordinator(system);
      expect(agent).not.toBeNull();
      expect(agent!.cwd).toBe(testDir);
    });

    it("uses bootstrap.coordinator.cwd when provided", async () => {
      testDir = createTestDir();
      const projectDir = path.join(testDir, "project");
      fs.mkdirSync(projectDir, { recursive: true });

      system = await bootV2({
        cwd: testDir,
        baseDir: testDir,
        inbox: { socketPath: path.join(testDir, "inbox.sock") },
        bootstrap: { coordinator: { cwd: projectDir } },
      });
      const agent = await waitForCoordinator(system);
      expect(agent).not.toBeNull();
      expect(agent!.cwd).toBe(projectDir);
    });

    it("env-var bridge: MACRO_BOOTSTRAP_COORDINATOR=true triggers bootstrap", async () => {
      testDir = createTestDir();
      process.env.MACRO_BOOTSTRAP_COORDINATOR = "true";

      system = await bootV2({
        cwd: testDir,
        baseDir: testDir,
        inbox: { socketPath: path.join(testDir, "inbox.sock") },
      });
      const agent = await waitForCoordinator(system);
      expect(agent).not.toBeNull();
      expect(agent!.cwd).toBe(testDir);
    });

    it("env-var bridge: MACRO_BOOTSTRAP_CWD overrides default cwd", async () => {
      testDir = createTestDir();
      const projectDir = path.join(testDir, "project");
      fs.mkdirSync(projectDir, { recursive: true });

      process.env.MACRO_BOOTSTRAP_COORDINATOR = "true";
      process.env.MACRO_BOOTSTRAP_CWD = projectDir;

      system = await bootV2({
        cwd: testDir,
        baseDir: testDir,
        inbox: { socketPath: path.join(testDir, "inbox.sock") },
      });
      const agent = await waitForCoordinator(system);
      expect(agent!.cwd).toBe(projectDir);
    });

    it("programmatic bootstrap wins over env var", async () => {
      testDir = createTestDir();
      const programmaticDir = path.join(testDir, "programmatic");
      const envDir = path.join(testDir, "env");
      fs.mkdirSync(programmaticDir, { recursive: true });
      fs.mkdirSync(envDir, { recursive: true });

      process.env.MACRO_BOOTSTRAP_COORDINATOR = "true";
      process.env.MACRO_BOOTSTRAP_CWD = envDir;

      system = await bootV2({
        cwd: testDir,
        baseDir: testDir,
        inbox: { socketPath: path.join(testDir, "inbox.sock") },
        bootstrap: { coordinator: { cwd: programmaticDir } },
      });
      const agent = await waitForCoordinator(system);
      // Programmatic value wins; env-bridge skipped because field already set.
      expect(agent!.cwd).toBe(programmaticDir);
    });
  });

  // ─── default baseDir isolation ─────────────────────────────────────
  //
  // Regression guard: without an explicit `baseDir`, macro-agent used to
  // default to `~/.macro-agent/` — a singleton directory shared across
  // every run on the box. Two instances in different projects would
  // collide on `agents.db`, `inbox.db`, and `control.sock` (only one can
  // bind the sockets). The default now compartmentalizes per-cwd via a
  // stable hash, so sibling projects stay isolated while restarts in the
  // same project still reuse their previous store.

  describe("default baseDir (per-cwd isolation)", () => {
    it("derives a stable cwd-hashed baseDir when none is provided", async () => {
      testDir = createTestDir();
      system = await bootV2({
        cwd: testDir,
        // baseDir omitted — want to verify the default picks a unique,
        // stable path under ~/.macro-agent rather than the singleton.
        inbox: { socketPath: path.join(testDir, "inbox.sock") },
      });

      // The expected path is `~/.macro-agent/inst_<12-hex>` where the hex
      // is sha256(resolved(cwd)).slice(0, 12). Reproduce the computation
      // here and assert the agent store landed there.
      const crypto = await import("node:crypto");
      const expectedId =
        "inst_" +
        crypto
          .createHash("sha256")
          .update(path.resolve(testDir))
          .digest("hex")
          .slice(0, 12);
      const expectedDir = path.join(os.homedir(), ".macro-agent", expectedId);

      expect(fs.existsSync(path.join(expectedDir, "agents.db"))).toBe(true);
      expect(fs.existsSync(path.join(expectedDir, "inbox.db"))).toBe(true);

      // Clean up the derived dir so repeated test runs don't leave state behind.
      await system.shutdown();
      system = null;
      try { fs.rmSync(expectedDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    });

    it("two instances in sibling cwds get distinct stores", async () => {
      const a = createTestDir();
      const b = createTestDir();

      // Keep a reference to clean up afterwards; the outer afterEach only
      // tracks `system` and a single `testDir`.
      const sysA = await bootV2({
        cwd: a,
        inbox: { socketPath: path.join(a, "inbox.sock") },
      });
      const sysB = await bootV2({
        cwd: b,
        inbox: { socketPath: path.join(b, "inbox.sock") },
      });

      const crypto = await import("node:crypto");
      const hash = (p: string) =>
        "inst_" + crypto.createHash("sha256").update(path.resolve(p)).digest("hex").slice(0, 12);
      const dirA = path.join(os.homedir(), ".macro-agent", hash(a));
      const dirB = path.join(os.homedir(), ".macro-agent", hash(b));

      expect(dirA).not.toBe(dirB);
      expect(fs.existsSync(path.join(dirA, "agents.db"))).toBe(true);
      expect(fs.existsSync(path.join(dirB, "agents.db"))).toBe(true);

      await sysA.shutdown();
      await sysB.shutdown();
      for (const d of [dirA, dirB, a, b]) {
        try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
      }
    });

    it("explicit baseDir still overrides the derived default", async () => {
      testDir = createTestDir();
      const explicit = createTestDir();
      system = await bootV2({
        cwd: testDir,
        baseDir: explicit,
        inbox: { socketPath: path.join(explicit, "inbox.sock") },
      });

      // Store landed in the explicit dir, not under ~/.macro-agent/.
      expect(fs.existsSync(path.join(explicit, "agents.db"))).toBe(true);

      const crypto = await import("node:crypto");
      const derivedId =
        "inst_" +
        crypto.createHash("sha256").update(path.resolve(testDir)).digest("hex").slice(0, 12);
      const derivedDir = path.join(os.homedir(), ".macro-agent", derivedId);
      // Ensure the default path wasn't touched.
      expect(fs.existsSync(path.join(derivedDir, "agents.db"))).toBe(false);

      try { fs.rmSync(explicit, { recursive: true, force: true }); } catch { /* best-effort */ }
    });

    it("explicit instanceId wins over the cwd-hash fallback", async () => {
      testDir = createTestDir();
      // Pick an id that starts with `test-` so a stray leak is easy to spot.
      const id = `test-inst-${Date.now().toString(36)}`;
      system = await bootV2({
        cwd: testDir,
        instanceId: id,
        inbox: { socketPath: path.join(testDir, "inbox.sock") },
      });

      const explicitDir = path.join(os.homedir(), ".macro-agent", id);
      expect(fs.existsSync(path.join(explicitDir, "agents.db"))).toBe(true);

      // The cwd-hash default should NOT have been used.
      const crypto = await import("node:crypto");
      const derivedId =
        "inst_" +
        crypto.createHash("sha256").update(path.resolve(testDir)).digest("hex").slice(0, 12);
      const derivedDir = path.join(os.homedir(), ".macro-agent", derivedId);
      expect(fs.existsSync(path.join(derivedDir, "agents.db"))).toBe(false);

      await system.shutdown();
      system = null;
      try { fs.rmSync(explicitDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    });

    it("falls through to map.swarmId when no instanceId is set", async () => {
      testDir = createTestDir();
      const swarmId = `swarm-test-${Date.now().toString(36)}`;
      system = await bootV2({
        cwd: testDir,
        // No instanceId — map.swarmId should win over the cwd hash.
        // `map.enabled: false` keeps the sidecar from actually trying
        // to connect; we only need the id to flow into baseDir selection.
        map: { enabled: false, swarmId },
        inbox: { socketPath: path.join(testDir, "inbox.sock") },
      });

      const swarmDir = path.join(os.homedir(), ".macro-agent", swarmId);
      expect(fs.existsSync(path.join(swarmDir, "agents.db"))).toBe(true);

      await system.shutdown();
      system = null;
      try { fs.rmSync(swarmDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    });

    it("prefers explicit instanceId over map.swarmId", async () => {
      testDir = createTestDir();
      const id = `explicit-${Date.now().toString(36)}`;
      const swarmId = `map-${Date.now().toString(36)}`;
      system = await bootV2({
        cwd: testDir,
        instanceId: id,
        map: { enabled: false, swarmId },
        inbox: { socketPath: path.join(testDir, "inbox.sock") },
      });

      expect(fs.existsSync(
        path.join(os.homedir(), ".macro-agent", id, "agents.db"),
      )).toBe(true);
      expect(fs.existsSync(
        path.join(os.homedir(), ".macro-agent", swarmId, "agents.db"),
      )).toBe(false);

      await system.shutdown();
      system = null;
      try {
        fs.rmSync(path.join(os.homedir(), ".macro-agent", id), { recursive: true, force: true });
      } catch { /* best-effort */ }
    });
  });
});
