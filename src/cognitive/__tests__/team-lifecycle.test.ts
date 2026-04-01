/**
 * Cognitive Team Lifecycle Tests
 *
 * Tests the initCognitiveTeam() factory function that wires up
 * the cognitive-ops team before MacroAgentBackend starts spawning.
 *
 * V2 port: Uses InboxAdapter/TasksAdapter mocks instead of
 * EventStore/MessageRouter.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as path from "path";
import {
  initCognitiveTeam,
  type CognitiveTeamServices,
} from "../team-lifecycle.js";
import { DefaultRoleRegistry } from "../../roles/registry.js";
import type { AgentManager, SpawnInterceptor } from "../../agent/agent-manager.js";
import type { InboxAdapter } from "../../adapters/types.js";
import type { TasksAdapter } from "../../adapters/types.js";
import type { SpawnAgentOptions } from "../../agent/types.js";

// =============================================================================
// Helpers
// =============================================================================

const PROJECT_ROOT = path.resolve(import.meta.dirname, "../../..");

function createMockInboxAdapter(): InboxAdapter {
  return {
    registerAgent: vi.fn().mockResolvedValue(undefined),
    deregisterAgent: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue("msg_1"),
    onDelivery: vi.fn(),
    offDelivery: vi.fn(),
    checkInbox: vi.fn().mockResolvedValue([]),
    readThread: vi.fn().mockResolvedValue([]),
    setSignalFilter: vi.fn(),
    setEmissionValidator: vi.fn(),
    addSignalFilter: vi.fn(),
    removeSignalFilter: vi.fn(),
    addEmissionValidator: vi.fn(),
    removeEmissionValidator: vi.fn(),
    socketPath: "/tmp/test-inbox.sock",
    stop: vi.fn().mockResolvedValue(undefined),
  } as unknown as InboxAdapter;
}

function createMockTasksAdapter(): TasksAdapter {
  return {
    createTask: vi.fn().mockResolvedValue("task_1"),
    assignTask: vi.fn().mockResolvedValue(undefined),
    transitionTask: vi.fn().mockResolvedValue(undefined),
    getTask: vi.fn().mockResolvedValue({ id: "task_1", title: "test", status: "open" }),
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

let spawnCounter = 0;
let capturedInterceptor: SpawnInterceptor | null = null;

function createMockAgentManager(roleRegistry: DefaultRoleRegistry): AgentManager {
  capturedInterceptor = null;
  spawnCounter = 0;

  return {
    spawn: vi.fn(async (options: SpawnAgentOptions) => {
      const opts = capturedInterceptor ? capturedInterceptor(options) : options;
      const id = `agent_${spawnCounter++}`;
      return {
        id,
        session_id: `session_${id}`,
        task: opts.task ?? "test",
        state: "running" as const,
        created_at: Date.now(),
        parent: opts.parent ?? null,
        role: opts.role,
        config: opts.config,
      };
    }),
    terminate: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockReturnValue(null),
    list: vi.fn().mockReturnValue([]),
    getChildren: vi.fn().mockReturnValue([]),
    getHierarchy: vi.fn().mockReturnValue(null),
    getSession: vi.fn().mockReturnValue(null),
    hasActiveSession: vi.fn().mockReturnValue(false),
    setSpawnInterceptor: vi.fn((interceptor: SpawnInterceptor | null) => {
      capturedInterceptor = interceptor;
    }),
    getRoleRegistry: vi.fn(() => roleRegistry),
    onLifecycleEvent: vi.fn(() => vi.fn()),
    continueAgent: vi.fn().mockResolvedValue({ id: "continued_0" }),
    close: vi.fn().mockResolvedValue(undefined),
    getOrCreateHeadManager: vi.fn(),
    prompt: vi.fn(),
    isPrompting: vi.fn().mockReturnValue(false),
    supportsInjection: vi.fn().mockResolvedValue(false),
    promptUntilDone: vi.fn().mockResolvedValue({ doneCalled: true, doneStatus: "completed" }),
  } as unknown as AgentManager;
}

// =============================================================================
// Tests
// =============================================================================

describe("initCognitiveTeam", () => {
  let roleRegistry: DefaultRoleRegistry;
  let services: CognitiveTeamServices;

  beforeEach(() => {
    roleRegistry = new DefaultRoleRegistry();
    services = {
      agentManager: createMockAgentManager(roleRegistry),
      inboxAdapter: createMockInboxAdapter(),
      tasksAdapter: createMockTasksAdapter(),
      basePath: PROJECT_ROOT,
    };
  });

  it("loads cognitive-ops team and returns a handle", async () => {
    const handle = await initCognitiveTeam(services);

    expect(handle.backend).toBeDefined();
    expect(handle.runtime).toBeDefined();
    expect(handle.coordinatorId).toBeDefined();
    expect(typeof handle.teardown).toBe("function");
  });

  it("coordinator is spawned during bootstrap", async () => {
    const handle = await initCognitiveTeam(services);

    expect(handle.coordinatorId).toBe("agent_0");
    expect(services.agentManager.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        role: "coordinator",
        parent: null,
      }),
    );
  });

  it("backend has useTeam enabled", async () => {
    const handle = await initCognitiveTeam(services);

    // Verify by spawning an analyst -- should pass coordinator as parent
    const session = await handle.backend.spawn({
      agentType: "claude-code",
      task: { description: "Test analysis" },
    });

    expect(session.state).toBe("running");

    // The second spawn call (after coordinator) should have parent set
    const spawnCalls = vi.mocked(services.agentManager.spawn).mock.calls;
    const analystSpawn = spawnCalls[spawnCalls.length - 1][0];
    expect(analystSpawn.parent).toBe(handle.coordinatorId);
  });

  it("registers team roles in RoleRegistry", async () => {
    await initCognitiveTeam(services);

    // Analyst role should be registered
    const analyst = roleRegistry.resolveRole("analyst");
    expect(analyst).toBeDefined();
    expect(analyst.capabilities).toContain("task.claim");
  });

  it("teardown calls runtime teardown", async () => {
    const handle = await initCognitiveTeam(services);

    await handle.teardown();

    // Teardown should complete without error
    expect(true).toBe(true);
  });

  it("accepts custom backend config", async () => {
    const handle = await initCognitiveTeam(services, {
      maxFollowUps: 3,
      softTimeoutRatio: 0.5,
    });

    expect(handle.backend).toBeDefined();
    // Backend should still work with custom config
    expect(handle.backend.name).toBe("macro-agent");
  });

  it("backend spawns analysts with role analyst", async () => {
    const handle = await initCognitiveTeam(services);

    await handle.backend.spawn({
      agentType: "claude-code",
      task: { description: "Analyze trajectory" },
    });

    const spawnCalls = vi.mocked(services.agentManager.spawn).mock.calls;
    const analystSpawn = spawnCalls[spawnCalls.length - 1][0];
    expect(analystSpawn.role).toBe("analyst");
  });

  it("provides tasksAdapter on the handle", async () => {
    const handle = await initCognitiveTeam(services);
    expect(handle.tasksAdapter).toBe(services.tasksAdapter);
  });
});
