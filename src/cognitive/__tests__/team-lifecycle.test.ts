/**
 * Cognitive Team Lifecycle Tests
 *
 * Tests the initCognitiveTeam() factory function that wires up
 * the cognitive-ops team before MacroAgentBackend starts spawning.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as path from "path";
import {
  initCognitiveTeam,
  type CognitiveTeamServices,
} from "../team-lifecycle.js";
import { DefaultRoleRegistry } from "../../roles/registry.js";
import type { AgentManager, SpawnInterceptor } from "../../agent/agent-manager.js";
import type { MessageRouter } from "../../router/message-router.js";
import type { EventStore } from "../../store/event-store.js";
import type { SpawnAgentOptions } from "../../agent/types.js";
import type { Event } from "../../store/types/index.js";

// =============================================================================
// Helpers (matching patterns from teams/__tests__/team-system.test.ts)
// =============================================================================

const PROJECT_ROOT = path.resolve(import.meta.dirname, "../../..");

function createMockEventStore(): EventStore {
  const events: Event[] = [];
  return {
    emit: vi.fn((input: Record<string, unknown>) => {
      const event = {
        id: `evt_${events.length}`,
        type: input.type,
        timestamp: Date.now(),
        source: input.source,
        target: input.target,
        payload: input.payload,
      } as unknown as Event;
      events.push(event);
      return event;
    }),
    persist: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockReturnValue([]),
    getAgent: vi.fn().mockReturnValue(null),
    getTask: vi.fn().mockReturnValue(null),
    listAgents: vi.fn().mockReturnValue([]),
    onAgentChange: vi.fn(),
    onTaskChange: vi.fn(),
    instanceId: "test-instance",
  } as unknown as EventStore;
}

function createMockMessageRouter(): MessageRouter {
  return {
    sendToAddress: vi.fn().mockResolvedValue({ delivered: true }),
    emitStatus: vi.fn(),
    getMessages: vi.fn().mockReturnValue([]),
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    getSubscriptions: vi.fn().mockReturnValue([]),
    setupDefaultSubscriptions: vi.fn(),
    setSignalFilter: vi.fn(),
    setEmissionValidator: vi.fn(),
  } as unknown as MessageRouter;
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
      messageRouter: createMockMessageRouter(),
      eventStore: createMockEventStore(),
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

    // Verify by spawning an analyst — should pass coordinator as parent
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

  it("stores team_config event in EventStore", async () => {
    await initCognitiveTeam(services);

    expect(services.eventStore.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "status",
        payload: expect.objectContaining({
          status_type: "discovery",
          team_config: expect.objectContaining({
            teamName: "cognitive-ops",
            taskMode: "pull",
          }),
        }),
      }),
    );
  });

  it("installs spawn interceptor on AgentManager", async () => {
    await initCognitiveTeam(services);

    expect(services.agentManager.setSpawnInterceptor).toHaveBeenCalled();
    expect(capturedInterceptor).not.toBeNull();
  });

  it("teardown removes spawn interceptor", async () => {
    const handle = await initCognitiveTeam(services);

    await handle.teardown();

    // setSpawnInterceptor should have been called with null during teardown
    const calls = vi.mocked(services.agentManager.setSpawnInterceptor).mock.calls;
    const lastCall = calls[calls.length - 1];
    expect(lastCall[0]).toBeNull();
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
});
