/**
 * Task Pool Integration Tests
 *
 * Tests that MacroAgentBackend creates tracked tasks in TaskBackend
 * when configured, and that submitBatch() dispatches multiple tasks
 * with bounded concurrency.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { MacroAgentBackend } from "../macro-agent-backend.js";
import type { AgentManager } from "../../agent/agent-manager.js";
import type { RoleRegistry, RoleDefinition } from "../../roles/types.js";
import type { TaskBackend, ExtendedTask } from "../../task/backend/types.js";
import type { CognitiveAgentSpawnConfig } from "../types.js";

// ── Mock Helpers ─────────────────────────────────────────────────

function createMockRoleRegistry(): RoleRegistry {
  const roles = new Map<string, RoleDefinition>();
  return {
    registerRole: vi.fn((role: RoleDefinition) => {
      roles.set(role.name, role);
    }),
    resolveRole: vi.fn((name: string) => {
      const role = roles.get(name);
      if (!role) throw new Error(`Role not found: ${name}`);
      return role;
    }),
    getRole: vi.fn((name: string) => roles.get(name)),
    hasCapability: vi.fn(() => true),
    loadConfigs: vi.fn(),
    loadProjectConfig: vi.fn(),
    loadUserConfig: vi.fn(),
    loadFromFile: vi.fn(),
    clearLoadedRoles: vi.fn(),
    dispose: vi.fn(),
  } as unknown as RoleRegistry;
}

let spawnCounter = 0;

function createMockAgentManager(
  overrides?: Partial<AgentManager>,
): AgentManager {
  const registry = createMockRoleRegistry();

  return {
    spawn: vi.fn().mockImplementation(async () => ({
      id: `agent_${spawnCounter++}`,
      session_id: `session_${spawnCounter}`,
    })),
    prompt: vi.fn().mockReturnValue({
      [Symbol.asyncIterator]: async function* () {},
    }),
    promptUntilDone: vi.fn().mockResolvedValue({
      doneCalled: true,
      doneStatus: "completed",
      exceededMax: false,
      followUpCount: 0,
      updates: [],
    }),
    terminate: vi.fn().mockResolvedValue(undefined),
    getRoleRegistry: vi.fn().mockReturnValue(registry),
    supportsInjection: vi.fn().mockResolvedValue(false),
    get: vi.fn(),
    list: vi.fn(),
    getChildren: vi.fn(),
    getHierarchy: vi.fn(),
    getOrCreateHeadManager: vi.fn(),
    listHeadManagers: vi.fn(),
    getSession: vi.fn(),
    hasActiveSession: vi.fn(),
    isPrompting: vi.fn(),
    isProcessRunning: vi.fn(),
    respondToPermission: vi.fn(),
    cancelPermission: vi.fn(),
    setPermissionMode: vi.fn(),
    getPermissionMode: vi.fn(),
    onLifecycleEvent: vi.fn(),
    setSpawnInterceptor: vi.fn(),
    setOpenTasksSocketPath: vi.fn(),
    setMailServices: vi.fn(),
    close: vi.fn(),
    continue: vi.fn(),
    forkAgent: vi.fn(),
    ...overrides,
  } as unknown as AgentManager;
}

let taskCounter = 0;

function createMockTaskBackend(): TaskBackend {
  return {
    create: vi.fn().mockImplementation(async () => ({
      id: `task_${taskCounter++}`,
      status: "pending",
      description: "",
    } as ExtendedTask)),
    start: vi.fn().mockResolvedValue(undefined),
    assign: vi.fn().mockResolvedValue(undefined),
    complete: vi.fn().mockResolvedValue(undefined),
    fail: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockResolvedValue(null),
    update: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue(undefined),
    unassign: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue([]),
    listReady: vi.fn().mockResolvedValue([]),
    getChildren: vi.fn().mockResolvedValue([]),
    getSubtaskStatus: vi.fn().mockResolvedValue({
      total: 0, pending: 0, assigned: 0, in_progress: 0, completed: 0, failed: 0,
      allCompleted: true, anyFailed: false,
    }),
    createSubtask: vi.fn().mockResolvedValue({}),
    addBlocker: vi.fn().mockResolvedValue(undefined),
    removeBlocker: vi.fn().mockResolvedValue(undefined),
    getBlockers: vi.fn().mockResolvedValue([]),
    getBlocking: vi.fn().mockResolvedValue([]),
    getAgentHistory: vi.fn().mockResolvedValue([]),
    onTaskChange: vi.fn().mockReturnValue(() => {}),
  } as unknown as TaskBackend;
}

function makeSpawnConfig(desc = "Analyze data"): CognitiveAgentSpawnConfig {
  return {
    agentType: "claude-code",
    task: { description: desc },
  };
}

// ── Tests ────────────────────────────────────────────────────────

describe("MacroAgentBackend — Task Pool Integration", () => {
  beforeEach(() => {
    spawnCounter = 0;
    taskCounter = 0;
  });

  // ── spawn() with task tracking ──────────────────────────────

  describe("spawn() with taskBackend", () => {
    it("creates task in TaskBackend when configured", async () => {
      const agentManager = createMockAgentManager();
      const taskBackend = createMockTaskBackend();
      const backend = new MacroAgentBackend(agentManager, { taskBackend });

      await backend.spawn(makeSpawnConfig("Analyze trajectory"));

      expect(taskBackend.create).toHaveBeenCalledWith(
        expect.objectContaining({
          description: "Analyze trajectory",
        }),
      );
    });

    it("passes task_id to agentManager.spawn()", async () => {
      const agentManager = createMockAgentManager();
      const taskBackend = createMockTaskBackend();
      const backend = new MacroAgentBackend(agentManager, { taskBackend });

      await backend.spawn(makeSpawnConfig());

      expect(agentManager.spawn).toHaveBeenCalledWith(
        expect.objectContaining({
          task_id: "task_0",
        }),
      );
    });

    it("assigns task to spawned agent and marks in_progress", async () => {
      const agentManager = createMockAgentManager();
      const taskBackend = createMockTaskBackend();
      const backend = new MacroAgentBackend(agentManager, { taskBackend });

      await backend.spawn(makeSpawnConfig());

      // assign() then start() — order: pending → assigned → in_progress
      expect(taskBackend.assign).toHaveBeenCalledWith("task_0", "agent_0");
      expect(taskBackend.start).toHaveBeenCalledWith("task_0");
    });

    it("includes domain as tag when provided", async () => {
      const agentManager = createMockAgentManager();
      const taskBackend = createMockTaskBackend();
      const backend = new MacroAgentBackend(agentManager, { taskBackend });

      await backend.spawn({
        agentType: "claude-code",
        task: { description: "Analyze", domain: "trajectory_analysis" },
      });

      expect(taskBackend.create).toHaveBeenCalledWith(
        expect.objectContaining({
          tags: ["trajectory_analysis"],
        }),
      );
    });

    it("uses coordinatorAgentId as created_by when in team mode", async () => {
      const agentManager = createMockAgentManager();
      const taskBackend = createMockTaskBackend();
      const backend = new MacroAgentBackend(agentManager, {
        taskBackend,
        useTeam: true,
        coordinatorAgentId: "coord_123" as any,
      });

      await backend.spawn(makeSpawnConfig());

      expect(taskBackend.create).toHaveBeenCalledWith(
        expect.objectContaining({
          created_by: "coord_123",
        }),
      );
    });
  });

  // ── spawn() backward compatibility ──────────────────────────

  describe("spawn() without taskBackend", () => {
    it("works without taskBackend (backward compatible)", async () => {
      const agentManager = createMockAgentManager();
      const backend = new MacroAgentBackend(agentManager);

      const session = await backend.spawn(makeSpawnConfig());

      expect(session.state).toBe("running");
      expect(session.metadata.macroAgentId).toBe("agent_0");
      expect(agentManager.spawn).toHaveBeenCalledWith(
        expect.objectContaining({
          task_id: undefined,
        }),
      );
    });
  });

  // ── runSession completion ───────────────────────────────────

  describe("task status on completion", () => {
    it("calls taskBackend.complete() when session completes", async () => {
      const agentManager = createMockAgentManager();
      const taskBackend = createMockTaskBackend();
      const backend = new MacroAgentBackend(agentManager, { taskBackend });

      const session = await backend.spawn(makeSpawnConfig());

      // Wait for runSession to complete (fire-and-forget)
      await new Promise((r) => setTimeout(r, 50));

      expect(session.state).toBe("completed");
      expect(taskBackend.complete).toHaveBeenCalledWith(
        "task_0",
        expect.objectContaining({}),
      );
    });

    it("calls taskBackend.fail() when session fails", async () => {
      const agentManager = createMockAgentManager({
        promptUntilDone: vi.fn().mockRejectedValue(new Error("Agent crashed")),
      });
      const taskBackend = createMockTaskBackend();
      const backend = new MacroAgentBackend(agentManager, { taskBackend });

      const session = await backend.spawn(makeSpawnConfig());

      // Wait for runSession to complete
      await new Promise((r) => setTimeout(r, 50));

      expect(session.state).toBe("failed");
      expect(session.error).toBe("Agent crashed");
      expect(taskBackend.fail).toHaveBeenCalledWith(
        "task_0",
        expect.objectContaining({ message: "Agent crashed" }),
      );
    });

    it("calls taskBackend.fail() when agent does not call done()", async () => {
      const agentManager = createMockAgentManager({
        promptUntilDone: vi.fn().mockResolvedValue({
          doneCalled: false,
          doneStatus: undefined,
          exceededMax: true,
          followUpCount: 1,
          updates: [],
        }),
      });
      const taskBackend = createMockTaskBackend();
      const backend = new MacroAgentBackend(agentManager, { taskBackend });

      await backend.spawn(makeSpawnConfig());
      await new Promise((r) => setTimeout(r, 50));

      expect(taskBackend.fail).toHaveBeenCalledWith(
        "task_0",
        expect.objectContaining({ message: "Agent did not call done()" }),
      );
    });
  });

  // ── terminate() ─────────────────────────────────────────────

  describe("terminate()", () => {
    it("fails task in TaskBackend when terminated", async () => {
      const agentManager = createMockAgentManager({
        // Make promptUntilDone hang so session stays running
        promptUntilDone: vi.fn().mockReturnValue(new Promise(() => {})),
      });
      const taskBackend = createMockTaskBackend();
      const backend = new MacroAgentBackend(agentManager, { taskBackend });

      const session = await backend.spawn(makeSpawnConfig());
      await backend.terminate(session.id);

      expect(taskBackend.fail).toHaveBeenCalledWith(
        "task_0",
        expect.objectContaining({ message: "Terminated by caller" }),
      );
    });
  });

  // ── submitBatch() ───────────────────────────────────────────

  describe("submitBatch()", () => {
    it("creates all tasks upfront in TaskBackend", async () => {
      const agentManager = createMockAgentManager();
      const taskBackend = createMockTaskBackend();
      const backend = new MacroAgentBackend(agentManager, { taskBackend });

      const handle = await backend.submitBatch({
        tasks: [
          makeSpawnConfig("Task 1"),
          makeSpawnConfig("Task 2"),
          makeSpawnConfig("Task 3"),
        ],
      });

      // All 3 tasks should be created upfront
      expect(taskBackend.create).toHaveBeenCalledTimes(3);

      await handle.waitForAll();
    });

    it("spawns up to maxConcurrency initially", async () => {
      let resolvers: (() => void)[] = [];
      const agentManager = createMockAgentManager({
        promptUntilDone: vi.fn().mockImplementation(() =>
          new Promise<{
            doneCalled: boolean;
            doneStatus: string;
            exceededMax: boolean;
            followUpCount: number;
            updates: unknown[];
          }>((resolve) => {
            resolvers.push(() =>
              resolve({
                doneCalled: true,
                doneStatus: "completed",
                exceededMax: false,
                followUpCount: 0,
                updates: [],
              }),
            );
          }),
        ),
      });
      const taskBackend = createMockTaskBackend();
      const backend = new MacroAgentBackend(agentManager, { taskBackend });

      await backend.submitBatch({
        tasks: [
          makeSpawnConfig("Task 1"),
          makeSpawnConfig("Task 2"),
          makeSpawnConfig("Task 3"),
          makeSpawnConfig("Task 4"),
          makeSpawnConfig("Task 5"),
        ],
        maxConcurrency: 2,
      });

      // Only 2 should be spawned initially
      expect(agentManager.spawn).toHaveBeenCalledTimes(2);

      // Resolve first two to trigger more spawns
      resolvers[0]();
      resolvers[1]();
      await new Promise((r) => setTimeout(r, 50));

      // Should have spawned 2 more (total 4, but 5th needs one more to complete)
      expect((agentManager.spawn as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(4);

      // Resolve remaining
      for (const r of resolvers.slice(2)) r();
      await new Promise((r) => setTimeout(r, 50));
    });

    it("waitForAll() returns correct counts", async () => {
      const callCount = { n: 0 };
      const agentManager = createMockAgentManager({
        promptUntilDone: vi.fn().mockImplementation(async () => {
          const idx = callCount.n++;
          if (idx === 1) throw new Error("fail");
          return {
            doneCalled: true,
            doneStatus: "completed",
            exceededMax: false,
            followUpCount: 0,
            updates: [],
          };
        }),
      });
      const taskBackend = createMockTaskBackend();
      const backend = new MacroAgentBackend(agentManager, { taskBackend });

      const handle = await backend.submitBatch({
        tasks: [
          makeSpawnConfig("Task 1"),
          makeSpawnConfig("Task 2"),
          makeSpawnConfig("Task 3"),
        ],
      });

      const result = await handle.waitForAll();

      expect(result.completed).toBe(2);
      expect(result.failed).toBe(1);
      expect(result.cancelled).toBe(false);
      expect(result.results).toHaveLength(3);
    });

    it("cancel() terminates running sessions", async () => {
      // promptUntilDone resolves when terminate is called (simulates real behavior)
      const pendingResolvers: (() => void)[] = [];
      const mockTerminate = vi.fn().mockImplementation(async () => {
        // Resolve any pending promptUntilDone calls
        for (const r of pendingResolvers) r();
      });

      const agentManager = createMockAgentManager({
        promptUntilDone: vi.fn().mockImplementation(
          () =>
            new Promise((resolve) => {
              pendingResolvers.push(() =>
                resolve({
                  doneCalled: false,
                  doneStatus: undefined,
                  exceededMax: false,
                  followUpCount: 0,
                  updates: [],
                }),
              );
            }),
        ),
        terminate: mockTerminate,
      });
      const taskBackend = createMockTaskBackend();
      const backend = new MacroAgentBackend(agentManager, { taskBackend });

      const handle = await backend.submitBatch({
        tasks: [makeSpawnConfig("Task 1"), makeSpawnConfig("Task 2")],
        maxConcurrency: 2,
      });

      const result = await handle.cancel();

      expect(result.cancelled).toBe(true);
      expect(mockTerminate).toHaveBeenCalled();
    });

    it("works without taskBackend", async () => {
      const agentManager = createMockAgentManager();
      const backend = new MacroAgentBackend(agentManager);

      const handle = await backend.submitBatch({
        tasks: [makeSpawnConfig("Task 1"), makeSpawnConfig("Task 2")],
      });

      const result = await handle.waitForAll();

      expect(result.completed).toBe(2);
      expect(result.failed).toBe(0);
    });
  });
});
