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
});
