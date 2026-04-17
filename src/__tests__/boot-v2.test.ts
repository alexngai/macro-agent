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
});
