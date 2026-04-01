/**
 * Cognitive Backend E2E Tests
 *
 * Tests the MacroAgentBackend — the bridge between macro-agent and
 * cognitive-core — end-to-end with mocked acp-factory and opentasks.
 *
 * Verifies: spawn, session tracking, completion callbacks, trajectory
 * extraction, batch submission with concurrency, termination, task
 * adapter integration, and inbox adapter notification.
 *
 * REQUIRES: RUN_E2E_TESTS=true (no real Claude Code agents)
 *
 * Run with:
 *   RUN_E2E_TESTS=true npx vitest run --config vitest.e2e.config.ts src/__tests__/e2e/cognitive-backend.e2e.test.ts
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import { bootV2, type MacroAgentSystemV2 } from "../../boot-v2.js";
import { MacroAgentBackend } from "../../cognitive/macro-agent-backend.js";
import type {
  MacroAgentBackendConfig,
  CognitiveAgentSpawnConfig,
  SessionCompleteEvent,
} from "../../cognitive/types.js";
import type { TasksAdapter, InboxAdapter } from "../../adapters/types.js";

// ─────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────

const RUN_E2E = !!process.env.RUN_E2E_TESTS;
const describeFn = RUN_E2E ? describe : describe.skip;

// Mock acp-factory — each call to spawn() returns a fresh handle
let mockPromptUntilDone: ReturnType<typeof vi.fn>;
let mockTerminate: ReturnType<typeof vi.fn>;

vi.mock("acp-factory", () => ({
  AgentFactory: {
    spawn: vi.fn().mockImplementation(async () => ({
      createSession: vi.fn().mockResolvedValue({
        id: `session-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        prompt: vi.fn().mockReturnValue({
          [Symbol.asyncIterator]: () => ({
            next: () => Promise.resolve({ done: true, value: undefined }),
          }),
        }),
        forkWithFlush: vi.fn().mockResolvedValue({
          id: `forked-${Date.now()}`,
        }),
      }),
      loadSession: vi.fn().mockResolvedValue({
        id: `loaded-${Date.now()}`,
      }),
      close: vi.fn().mockResolvedValue(undefined),
      isRunning: vi.fn().mockReturnValue(true),
    })),
  },
}));

// Mock opentasks (daemon not available in CI)
vi.mock("opentasks", () => ({
  OpenTasksClient: vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockRejectedValue(new Error("No daemon")),
    disconnect: vi.fn(),
    query: vi.fn().mockResolvedValue({ items: [] }),
    link: vi.fn().mockResolvedValue({ success: true }),
    task: vi.fn().mockResolvedValue({ id: "t-1" }),
  })),
}));

// ─────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────

function createTestDir(): string {
  const dir = path.join(
    os.tmpdir(),
    `cognitive-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function makeSpawnConfig(
  overrides?: Partial<CognitiveAgentSpawnConfig>
): CognitiveAgentSpawnConfig {
  return {
    agentType: "claude-code",
    task: { description: "Analyze test patterns" },
    ...overrides,
  };
}

/**
 * Wait for a backend session to reach a terminal state.
 */
async function waitForSession(
  backend: MacroAgentBackend,
  sessionId: string,
  timeoutMs = 10_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = await backend.getSession(sessionId);
    if (s && (s.state === "completed" || s.state === "failed")) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Session ${sessionId} did not complete within ${timeoutMs}ms`);
}

/**
 * Create a mock TasksAdapter with vi.fn() methods.
 */
function createMockTasksAdapter(): TasksAdapter {
  let taskCounter = 0;
  return {
    createTask: vi.fn().mockImplementation(async () => `task-${++taskCounter}`),
    assignTask: vi.fn().mockResolvedValue(undefined),
    transitionTask: vi.fn().mockResolvedValue(undefined),
    getTask: vi.fn().mockResolvedValue({ id: "task-1", title: "test", status: "open" }),
    queryReady: vi.fn().mockResolvedValue([]),
    listTasks: vi.fn().mockResolvedValue([]),
    addBlocker: vi.fn().mockResolvedValue(undefined),
    removeBlocker: vi.fn().mockResolvedValue(undefined),
    claimTask: vi.fn().mockResolvedValue(null),
    unclaimTask: vi.fn().mockResolvedValue(undefined),
    listClaimable: vi.fn().mockResolvedValue([]),
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
    connected: true,
  } as unknown as TasksAdapter;
}

// ─────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────

describeFn("Cognitive Backend E2E", () => {
  let system: MacroAgentSystemV2;
  let testDir: string;
  let promptSpy: ReturnType<typeof vi.spyOn>;
  let terminateSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    testDir = createTestDir();

    // Reset mocks
    mockPromptUntilDone = vi.fn().mockResolvedValue({
      doneCalled: true,
      doneStatus: "completed",
      updates: [],
    });
    mockTerminate = vi.fn().mockResolvedValue(undefined);

    system = await bootV2({
      cwd: testDir,
      baseDir: testDir,
      inbox: {
        socketPath: path.join(testDir, "inbox.sock"),
      },
    });

    // Patch agentManager.promptUntilDone and terminate for controlled behavior
    const originalTerminate = system.agentManager.terminate.bind(
      system.agentManager
    );

    promptSpy = vi.spyOn(system.agentManager, "promptUntilDone").mockImplementation(
      mockPromptUntilDone
    );
    terminateSpy = vi.spyOn(system.agentManager, "terminate").mockImplementation(
      async (agentId, reason) => {
        mockTerminate(agentId, reason);
        try {
          await originalTerminate(agentId, reason);
        } catch {
          // Agent may already be stopped
        }
      }
    );
  });

  afterEach(async () => {
    // Restore only our spies (not module-level mocks)
    promptSpy?.mockRestore();
    terminateSpy?.mockRestore();
    if (system) {
      await system.shutdown();
    }
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  // ── Test 1: Spawn analyst and track session ──────────────────

  it("should spawn analyst and track session", async () => {
    const backend = new MacroAgentBackend(system.agentManager);

    const session = await backend.spawn(makeSpawnConfig());

    // Session created with correct state
    expect(session.state).toBe("running");
    expect(session.task.description).toBe("Analyze test patterns");
    expect(session.agentType).toBe("claude-code");
    expect(session.id).toMatch(/^cognitive_/);

    // Session has macroAgentId in metadata
    expect(session.metadata.macroAgentId).toBeDefined();
    expect(typeof session.metadata.macroAgentId).toBe("string");

    // Retrievable by ID
    const retrieved = await backend.getSession(session.id);
    expect(retrieved).toBeDefined();
    expect(retrieved!.id).toBe(session.id);

    // Appears in list
    const list = await backend.listSessions();
    expect(list.some((s) => s.id === session.id)).toBe(true);

    // Wait for background run to complete
    await waitForSession(backend, session.id);
  });

  // ── Test 2: Session completion triggers callback ─────────────

  it("should trigger onSessionComplete callback", async () => {
    const completionEvents: SessionCompleteEvent[] = [];

    const backend = new MacroAgentBackend(system.agentManager, {
      onSessionComplete: (event) => completionEvents.push(event),
    });

    const session = await backend.spawn(makeSpawnConfig());
    await waitForSession(backend, session.id);

    // Callback should have been invoked
    expect(completionEvents.length).toBe(1);
    expect(completionEvents[0].sessionId).toBe(session.id);
    expect(completionEvents[0].state).toBe("completed");
    expect(completionEvents[0].agentId).toBeDefined();
    expect(completionEvents[0].duration_ms).toBeGreaterThanOrEqual(0);
  });

  // ── Test 3: Trajectory extraction from completed session ─────

  it("should extract trajectory from completed session", async () => {
    const completionEvents: SessionCompleteEvent[] = [];

    const backend = new MacroAgentBackend(system.agentManager, {
      onSessionComplete: (event) => completionEvents.push(event),
    });

    const session = await backend.spawn(makeSpawnConfig());
    await waitForSession(backend, session.id);

    const event = completionEvents[0];
    expect(event.trajectory).toBeDefined();

    const trajectory = event.trajectory!;
    expect(trajectory.task.description).toBe("Analyze test patterns");
    expect(trajectory.outcome.success).toBe(true);
    expect(trajectory.agentId).toBe(session.metadata.macroAgentId);
    // wallTimeSeconds may be 0 or positive depending on timing
    expect(trajectory.wallTimeSeconds).toBeGreaterThanOrEqual(0);
    expect(trajectory.id).toMatch(/^traj_/);
  });

  // ── Test 4: Batch submission with concurrency ────────────────

  it("should submit batch with concurrency limit", async () => {
    // Track how many sessions are running concurrently
    let currentConcurrent = 0;
    let maxConcurrent = 0;

    mockPromptUntilDone.mockImplementation(async () => {
      currentConcurrent++;
      maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
      // Simulate some work
      await new Promise((r) => setTimeout(r, 50));
      currentConcurrent--;
      return { doneCalled: true, doneStatus: "completed", updates: [] };
    });

    const backend = new MacroAgentBackend(system.agentManager);

    const tasks: CognitiveAgentSpawnConfig[] = Array.from(
      { length: 5 },
      (_, i) => ({
        agentType: "claude-code",
        task: { description: `Batch task ${i + 1}` },
      })
    );

    const handle = await backend.submitBatch({
      tasks,
      maxConcurrency: 2,
    });

    expect(handle.totalTasks).toBe(5);

    // waitForAll resolves the initial batch of promises; additional tasks
    // may be spawned in the background as slots free up. Wait for all
    // sessions to reach terminal state.
    const result = await handle.waitForAll();

    // Give background spawns time to complete
    await new Promise((r) => setTimeout(r, 500));

    // Count completed sessions from the backend directly
    const allSessions = await backend.listSessions();
    const completedSessions = allSessions.filter(
      (s) => s.state === "completed"
    );

    // All 5 should eventually complete
    expect(completedSessions.length).toBe(5);
    expect(result.results).toHaveLength(5);

    // Concurrency should never have exceeded 2
    expect(maxConcurrent).toBeLessThanOrEqual(2);
  });

  // ── Test 5: Terminate running session ────────────────────────

  it("should terminate a running session", async () => {
    // Make promptUntilDone hang so we can terminate mid-flight
    let resolvePrompt: (() => void) | undefined;
    mockPromptUntilDone.mockImplementation(
      () =>
        new Promise<{ doneCalled: boolean; doneStatus?: string; updates: unknown[] }>(
          (resolve) => {
            resolvePrompt = () =>
              resolve({ doneCalled: false, doneStatus: undefined, updates: [] });
          }
        )
    );

    const backend = new MacroAgentBackend(system.agentManager);
    const session = await backend.spawn(makeSpawnConfig());

    // Session should be running
    expect(session.state).toBe("running");

    // Terminate it
    await backend.terminate(session.id);

    // Session should now be failed
    const terminated = await backend.getSession(session.id);
    expect(terminated!.state).toBe("failed");
    expect(terminated!.error).toContain("Terminated");

    // agentManager.terminate should have been called
    expect(mockTerminate).toHaveBeenCalledWith(
      session.metadata.macroAgentId,
      "cancelled"
    );

    // Clean up the hanging promise
    resolvePrompt?.();
  });

  // ── Test 6: Task tracking with TasksAdapter ──────────────────

  it("should track tasks via TasksAdapter", async () => {
    const mockTasks = createMockTasksAdapter();

    const backend = new MacroAgentBackend(system.agentManager, {
      tasksAdapter: mockTasks,
    });

    const session = await backend.spawn(
      makeSpawnConfig({
        task: { description: "Tracked task", domain: "testing" },
      })
    );

    // createTask should be called with title and tags
    expect(mockTasks.createTask).toHaveBeenCalledWith({
      title: "Tracked task",
      tags: ["testing"],
    });

    // assignTask should be called with taskId and agentId
    expect(mockTasks.assignTask).toHaveBeenCalledWith(
      "task-1",
      expect.any(String)
    );

    // transitionTask("start") should be called
    expect(mockTasks.transitionTask).toHaveBeenCalledWith("task-1", "start");

    // Wait for completion
    await waitForSession(backend, session.id);

    // transitionTask("complete") should be called on success
    expect(mockTasks.transitionTask).toHaveBeenCalledWith(
      "task-1",
      "complete"
    );
  });

  // ── Test 7: InboxAdapter notification on completion ──────────

  it("should notify via InboxAdapter on session completion", async () => {
    const coordinatorId = "coord-123";

    // We spy on the real inboxAdapter.send to verify the call
    const sendSpy = vi.spyOn(system.inboxAdapter, "send");

    const backend = new MacroAgentBackend(system.agentManager, {
      inboxAdapter: system.inboxAdapter,
      coordinatorAgentId: coordinatorId as any,
    });

    const session = await backend.spawn(makeSpawnConfig());
    await waitForSession(backend, session.id);

    // inboxAdapter.send should have been called with session.complete
    const sessionCompleteCalls = sendSpy.mock.calls.filter(
      (call) => {
        const opts = call[3] as { subject?: string } | undefined;
        return opts?.subject === "session.complete";
      }
    );

    expect(sessionCompleteCalls.length).toBe(1);
    const [from, to, content] = sessionCompleteCalls[0];
    expect(to).toBe(coordinatorId);
    expect((content as any).type).toBe("session.complete");
    expect((content as any).sessionId).toBe(session.id);
    expect((content as any).outcome).toBe("success");
  });
});
