/**
 * Task Pool E2E Tests
 *
 * Tests that MacroAgentBackend creates tracked tasks in a real
 * InMemoryTaskBackend backed by EventStore, and that batch submission
 * works end-to-end with real services.
 *
 * Group 1 (infrastructure) uses real EventStore + InMemoryTaskBackend
 * but does NOT spawn real Claude Code agents (uses mocked AgentManager).
 *
 * Group 2 (full agent) spawns real analysts and requires:
 *   RUN_FULL_AGENT_TESTS=true
 *
 * Run:
 *   npx vitest run --config vitest.e2e.config.ts src/cognitive/__tests__/task-pool.e2e.test.ts
 *   RUN_FULL_AGENT_TESTS=true npx vitest run --config vitest.e2e.config.ts src/cognitive/__tests__/task-pool.e2e.test.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

import { createEventStore, type EventStore } from "../../store/event-store.js";
import type { AgentManager } from "../../agent/agent-manager.js";
import { createInMemoryTaskBackend } from "../../task/backend/memory.js";
import type { TaskBackend } from "../../task/backend/types.js";
import { MacroAgentBackend } from "../macro-agent-backend.js";

// ─────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────

const RUN_FULL_AGENT = !!process.env.RUN_FULL_AGENT_TESTS;
const testFn = RUN_FULL_AGENT ? it : it.skip;
const PROJECT_ROOT = path.resolve(import.meta.dirname, "../../..");

const log = (msg: string) => console.log(`[TaskPool-E2E] ${msg}`);

const TIMEOUT = {
  INFRA: 30000,
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
    path.join(os.tmpdir(), "task-pool-e2e-workspace-"),
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

function createMockAgentManager(overrides?: Record<string, unknown>): AgentManager {
  return {
    spawn: vi.fn().mockResolvedValue({ id: "agent_1", session_id: "s1" }),
    promptUntilDone: vi.fn().mockResolvedValue({
      doneCalled: true,
      doneStatus: "completed",
      exceededMax: false,
      followUpCount: 0,
      updates: [],
    }),
    terminate: vi.fn().mockResolvedValue(undefined),
    getRoleRegistry: vi.fn().mockReturnValue({
      resolveRole: vi.fn().mockImplementation(() => { throw new Error("not found"); }),
      registerRole: vi.fn(),
    }),
    supportsInjection: vi.fn().mockResolvedValue(false),
    ...overrides,
  } as unknown as AgentManager;
}

// ─────────────────────────────────────────────────────────────────
// Group 1: Infrastructure Tests (no real agents)
// ─────────────────────────────────────────────────────────────────

describe("Task Pool E2E — Infrastructure", () => {
  let eventStore: EventStore;
  let taskBackend: TaskBackend;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-pool-e2e-"));
    const instanceId = `task-pool-${Date.now()}`;

    eventStore = await createEventStore({ instanceId, baseDir: tmpDir });
    taskBackend = createInMemoryTaskBackend(eventStore);
  });

  afterEach(async () => {
    await eventStore?.close();

    if (tmpDir) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch { /* ignore */ }
    }
  });

  it("spawn creates tracked task in EventStore via InMemoryTaskBackend", async () => {
    const mockAgentManager = createMockAgentManager({
      spawn: vi.fn().mockResolvedValue({ id: "agent_test_1", session_id: "s1" }),
    });
    const backend = new MacroAgentBackend(mockAgentManager, { taskBackend });

    const session = await backend.spawn({
      agentType: "claude-code",
      task: { description: "Test task for pool" },
    });

    expect(session.state).toBe("running");

    // Verify task was created in the real TaskBackend
    const tasks = await taskBackend.list();
    expect(tasks.length).toBe(1);
    expect(tasks[0].description).toBe("Test task for pool");
    expect(tasks[0].status).toBe("in_progress");
    log(`Task created: ${tasks[0].id}, status: ${tasks[0].status}`);

    // Wait for session to complete
    await new Promise((r) => setTimeout(r, 100));

    // Verify task was completed
    const updatedTasks = await taskBackend.list();
    const task = updatedTasks[0];
    expect(task.status).toBe("completed");
    log(`Task completed: ${task.id}, status: ${task.status}`);
  }, TIMEOUT.INFRA);

  it("task is assigned to spawned agent", async () => {
    const mockAgentManager = createMockAgentManager({
      spawn: vi.fn().mockResolvedValue({ id: "agent_assign_1", session_id: "s1" }),
    });
    const backend = new MacroAgentBackend(mockAgentManager, { taskBackend });

    await backend.spawn({
      agentType: "claude-code",
      task: { description: "Assigned task" },
    });

    // Check the task was assigned to the agent
    const tasks = await taskBackend.list();
    expect(tasks[0].assigned_agent).toBe("agent_assign_1");
    log(`Task assigned to: ${tasks[0].assigned_agent}`);
  }, TIMEOUT.INFRA);

  it("failed session marks task as failed in TaskBackend", async () => {
    const mockAgentManager = createMockAgentManager({
      spawn: vi.fn().mockResolvedValue({ id: "agent_fail_1", session_id: "s1" }),
      promptUntilDone: vi.fn().mockRejectedValue(new Error("Agent crashed")),
    });
    const backend = new MacroAgentBackend(mockAgentManager, { taskBackend });

    const session = await backend.spawn({
      agentType: "claude-code",
      task: { description: "Failing task" },
    });

    // Wait for session to fail
    await new Promise((r) => setTimeout(r, 100));

    expect(session.state).toBe("failed");
    expect(session.error).toBe("Agent crashed");

    const tasks = await taskBackend.list();
    expect(tasks[0].status).toBe("failed");
    log(`Task failed: ${tasks[0].id}, status: ${tasks[0].status}`);
  }, TIMEOUT.INFRA);

  it("submitBatch creates all tasks upfront in real TaskBackend", async () => {
    const mockAgentManager = createMockAgentManager();
    const backend = new MacroAgentBackend(mockAgentManager, { taskBackend });

    const handle = await backend.submitBatch({
      tasks: [
        { agentType: "claude-code", task: { description: "Batch task 1" } },
        { agentType: "claude-code", task: { description: "Batch task 2" } },
        { agentType: "claude-code", task: { description: "Batch task 3" } },
      ],
    });

    // All 3 tasks should exist in TaskBackend immediately
    const tasks = await taskBackend.list();
    expect(tasks.length).toBe(3);
    log(`Batch tasks created: ${tasks.map(t => `${t.id}(${t.status})`).join(", ")}`);

    const result = await handle.waitForAll();
    expect(result.completed).toBe(3);
    expect(result.failed).toBe(0);

    // All tasks should be completed
    const finalTasks = await taskBackend.list();
    for (const task of finalTasks) {
      expect(task.status).toBe("completed");
    }
    log("All batch tasks completed");
  }, TIMEOUT.INFRA);
});

// ─────────────────────────────────────────────────────────────────
// Group 2: Full Agent Tests (requires RUN_FULL_AGENT_TESTS=true)
//
// These tests use dynamic import for team-lifecycle to avoid
// the transitive openteams dependency at module load time.
// ─────────────────────────────────────────────────────────────────

describe("Task Pool E2E — Full Agent", () => {
  let eventStore: EventStore;
  let agentManager: AgentManager;
  let messageRouter: any;
  let handle: any;
  let workspace: TestWorkspace | undefined;
  let tmpDir: string;

  beforeEach(async () => {
    if (!RUN_FULL_AGENT) {
      log("Skipping: RUN_FULL_AGENT_TESTS not set");
      return;
    }

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-pool-e2e-agent-"));
    const instanceId = `task-pool-agent-${Date.now()}`;

    eventStore = await createEventStore({ instanceId, baseDir: tmpDir });

    const { createMessageRouter } = await import("../../router/message-router.js");
    const { createAgentManager } = await import("../../agent/agent-manager.js");
    const { initCognitiveTeam } = await import("../team-lifecycle.js");

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
    "spawn creates tracked task and analyst completes it",
    async () => {
      workspace = createTestWorkspace({
        "task.md": "Write { \"result\": \"done\" } to output/result.json. Then call done().",
      });

      log(`Workspace created: ${workspace.path}`);

      const session = await handle!.backend.spawn({
        agentType: "claude-code",
        task: {
          description: "Read input/task.md and follow the instructions. Call done() when finished.",
        },
        cwd: workspace.path,
      });

      log(`Session created: ${session.id}`);
      expect(session.state).toBe("running");

      // Verify task was created in the team's TaskBackend
      const initialTasks = await handle!.taskBackend.list();
      expect(initialTasks.length).toBeGreaterThanOrEqual(1);
      const ourTask = initialTasks.find((t: any) => t.description?.includes("Read input/task.md"));
      expect(ourTask).toBeDefined();
      expect(ourTask!.status).toBe("in_progress");
      log(`Task created: ${ourTask!.id}, status: ${ourTask!.status}`);

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
      log(`Session state: ${finalSession!.state}, error: ${finalSession!.error ?? "none"}`);

      expect(finalSession!.state).toBe("completed");

      // Verify task status in TaskBackend
      const finalTasks = await handle!.taskBackend.list();
      const finalTask = finalTasks.find((t: any) => t.id === ourTask!.id);
      expect(finalTask).toBeDefined();
      expect(finalTask!.status).toBe("completed");
      log(`Task final status: ${finalTask!.status}`);

      // Verify output
      const outputPath = path.join(workspace.outputDir, "result.json");
      expect(fs.existsSync(outputPath)).toBe(true);
    },
    { timeout: TIMEOUT.TASK_COMPLETE },
  );

  testFn(
    "submitBatch runs multiple tasks with bounded concurrency",
    async () => {
      const workspace1 = createTestWorkspace({
        "task.md": "Write { \"result\": \"batch1\" } to output/result.json. Then call done().",
      });
      const workspace2 = createTestWorkspace({
        "task.md": "Write { \"result\": \"batch2\" } to output/result.json. Then call done().",
      });
      workspace = workspace1; // Track for cleanup

      log("Submitting batch of 2 tasks");

      const batchHandle = await handle!.backend.submitBatch({
        tasks: [
          {
            agentType: "claude-code",
            task: { description: "Read input/task.md and follow the instructions. Call done() when finished." },
            cwd: workspace1.path,
          },
          {
            agentType: "claude-code",
            task: { description: "Read input/task.md and follow the instructions. Call done() when finished." },
            cwd: workspace2.path,
          },
        ],
        maxConcurrency: 2,
      });

      expect(batchHandle.totalTasks).toBe(2);

      // Tasks should be created immediately in TaskBackend
      const initialTasks = await handle!.taskBackend.list();
      expect(initialTasks.length).toBeGreaterThanOrEqual(2);
      log(`Initial tasks: ${initialTasks.map((t: any) => `${t.id}(${t.status})`).join(", ")}`);

      const result = await batchHandle.waitForAll();

      log(`Batch result: completed=${result.completed}, failed=${result.failed}`);
      expect(result.completed).toBe(2);
      expect(result.failed).toBe(0);
      expect(result.cancelled).toBe(false);

      // Verify outputs
      expect(fs.existsSync(path.join(workspace1.outputDir, "result.json"))).toBe(true);
      expect(fs.existsSync(path.join(workspace2.outputDir, "result.json"))).toBe(true);

      workspace2.cleanup();
    },
    { timeout: TIMEOUT.TASK_COMPLETE },
  );
});
