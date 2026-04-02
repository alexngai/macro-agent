/**
 * Tests for TeamRuntimeV2 — uses InboxAdapter + TasksAdapter
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as path from "path";
import { TeamRuntimeV2, type TeamServicesV2 } from "../team-runtime-v2.js";
import { DefaultRoleRegistry } from "../../roles/registry.js";
import type { AgentManager, SpawnInterceptor } from "../../agent/agent-manager.js";
import type { InboxAdapter, TasksAdapter, SignalFilterFn, EmissionValidatorFn } from "../../adapters/types.js";
import type { SpawnAgentOptions } from "../../agent/types.js";
import type { AgentId } from "../../store/types/index.js";

// =============================================================================
// Helpers
// =============================================================================

const PROJECT_ROOT = path.resolve(import.meta.dirname, "../../..");

let spawnCounter = 0;
let capturedInterceptor: SpawnInterceptor | null = null;
let interceptedSpawnOptions: SpawnAgentOptions[] = [];
let lifecycleCallbacks: Array<(event: any) => void> = [];

function createMockAgentManager(roleRegistry: DefaultRoleRegistry): AgentManager {
  capturedInterceptor = null;
  spawnCounter = 0;
  interceptedSpawnOptions = [];
  lifecycleCallbacks = [];

  return {
    spawn: vi.fn(async (options: SpawnAgentOptions) => {
      const opts = capturedInterceptor
        ? await capturedInterceptor(options)
        : options;
      interceptedSpawnOptions.push(opts);
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
    onLifecycleEvent: vi.fn((callback: (event: any) => void) => {
      lifecycleCallbacks.push(callback);
      return vi.fn(); // unsubscribe
    }),
    continueAgent: vi.fn().mockResolvedValue({ id: "continued_0" }),
    close: vi.fn().mockResolvedValue(undefined),
    getOrCreateHeadManager: vi.fn(),
    prompt: vi.fn(),
    isPrompting: vi.fn().mockReturnValue(false),
  } as unknown as AgentManager;
}

function createMockInboxAdapter(): InboxAdapter & {
  _signalFilter: SignalFilterFn | null;
  _emissionValidator: EmissionValidatorFn | null;
} {
  const signalFilters = new Map<string, SignalFilterFn>();
  const emissionValidators = new Map<string, EmissionValidatorFn>();

  return {
    registerAgent: vi.fn().mockResolvedValue(undefined),
    deregisterAgent: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue("msg-1"),
    onDelivery: vi.fn(),
    offDelivery: vi.fn(),
    checkInbox: vi.fn().mockResolvedValue([]),
    readThread: vi.fn().mockResolvedValue([]),
    setSignalFilter: vi.fn((f: SignalFilterFn) => {
      signalFilters.set("default", f);
    }),
    setEmissionValidator: vi.fn((v: EmissionValidatorFn) => {
      emissionValidators.set("default", v);
    }),
    addSignalFilter: vi.fn((id: string, f: SignalFilterFn) => {
      signalFilters.set(id, f);
    }),
    removeSignalFilter: vi.fn((id: string) => {
      signalFilters.delete(id);
    }),
    addEmissionValidator: vi.fn((id: string, v: EmissionValidatorFn) => {
      emissionValidators.set(id, v);
    }),
    removeEmissionValidator: vi.fn((id: string) => {
      emissionValidators.delete(id);
    }),
    socketPath: "/tmp/test-inbox.sock",
    stop: vi.fn().mockResolvedValue(undefined),
    get _signalFilter() {
      // Return the most recently added filter (for backward compat with existing tests)
      const values = [...signalFilters.values()];
      return values.length > 0 ? values[values.length - 1] : null;
    },
    get _emissionValidator() {
      const values = [...emissionValidators.values()];
      return values.length > 0 ? values[values.length - 1] : null;
    },
  } as unknown as InboxAdapter & {
    _signalFilter: SignalFilterFn | null;
    _emissionValidator: EmissionValidatorFn | null;
  };
}

function createMockTasksAdapter(): TasksAdapter {
  return {
    createTask: vi.fn().mockResolvedValue("ot-task-1"),
    assignTask: vi.fn().mockResolvedValue(undefined),
    transitionTask: vi.fn().mockResolvedValue(undefined),
    getTask: vi.fn().mockResolvedValue({ id: "t-1", title: "test", status: "open" }),
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

async function loadTeamTemplate(teamName: string, roleRegistry: DefaultRoleRegistry) {
  const { loadTeam } = await import("../team-loader.js");
  return loadTeam(teamName, roleRegistry, PROJECT_ROOT);
}

// =============================================================================
// Tests
// =============================================================================

describe("TeamRuntimeV2", () => {
  let roleRegistry: DefaultRoleRegistry;
  let agentManager: AgentManager;
  let inboxAdapter: ReturnType<typeof createMockInboxAdapter>;
  let tasksAdapter: TasksAdapter;
  let services: TeamServicesV2;

  beforeEach(() => {
    roleRegistry = new DefaultRoleRegistry();
    agentManager = createMockAgentManager(roleRegistry);
    inboxAdapter = createMockInboxAdapter();
    tasksAdapter = createMockTasksAdapter();
    services = { agentManager, inboxAdapter, tasksAdapter };
  });

  describe("initialize()", () => {
    it("should register team roles in role registry", async () => {
      const manifest = await loadTeamTemplate("self-driving", roleRegistry);
      const runtime = new TeamRuntimeV2(manifest, services);
      await runtime.initialize();

      expect(roleRegistry.getRole("planner")).toBeDefined();
      expect(roleRegistry.getRole("grinder")).toBeDefined();
      expect(roleRegistry.getRole("judge")).toBeDefined();
    });

    it("should not require eventStore", async () => {
      const manifest = await loadTeamTemplate("self-driving", roleRegistry);
      const runtime = new TeamRuntimeV2(manifest, services);
      // Should not throw — no EventStore dependency
      await expect(runtime.initialize()).resolves.toBeUndefined();
    });
  });

  describe("bootstrap()", () => {
    it("should spawn root and companion agents", async () => {
      const manifest = await loadTeamTemplate("self-driving", roleRegistry);
      const runtime = new TeamRuntimeV2(manifest, services);
      await runtime.initialize();
      const result = await runtime.bootstrap();

      expect(result.rootId).toBeDefined();
      expect(result.companionIds).toHaveLength(1);
      expect(agentManager.spawn).toHaveBeenCalledTimes(2);
    });

    it("should pass team_instance as scope", async () => {
      const manifest = await loadTeamTemplate("self-driving", roleRegistry);
      const runtime = new TeamRuntimeV2(manifest, services);
      await runtime.initialize();
      await runtime.bootstrap();

      // Root agent should have team_instance set
      const rootSpawnOpts = interceptedSpawnOptions[0];
      expect(rootSpawnOpts.team_instance).toBe("self-driving");
    });

    it("should build agent↔role mappings", async () => {
      const manifest = await loadTeamTemplate("self-driving", roleRegistry);
      const runtime = new TeamRuntimeV2(manifest, services);
      await runtime.initialize();
      const result = await runtime.bootstrap();

      expect(runtime.hasAgent(result.rootId)).toBe(true);
      expect(runtime.hasAgent(result.companionIds[0])).toBe(true);
      expect(runtime.hasAgent("nonexistent")).toBe(false);
    });
  });

  describe("signal filtering (adapter-side)", () => {
    it("should install signal filter on InboxAdapter", async () => {
      const manifest = await loadTeamTemplate("self-driving", roleRegistry);
      const runtime = new TeamRuntimeV2(manifest, services);
      await runtime.initialize();
      await runtime.bootstrap();
      runtime.installOnServices();

      expect(inboxAdapter.addSignalFilter).toHaveBeenCalledWith(
        "self-driving",
        expect.any(Function)
      );
    });

    it("should filter signals based on peer routes", async () => {
      const manifest = await loadTeamTemplate("self-driving", roleRegistry);
      const runtime = new TeamRuntimeV2(manifest, services);
      await runtime.initialize();
      const result = await runtime.bootstrap();
      runtime.installOnServices();

      const filter = inboxAdapter._signalFilter!;
      const companionId = result.companionIds[0];
      const rootId = result.rootId;

      // judge→planner peer route allows FIXUP_CREATED and GREEN_SNAPSHOT
      const makeMsg = (event: string) => ({
        content: { type: "event", event },
        metadata: {},
      });

      expect(filter(companionId, rootId, makeMsg("FIXUP_CREATED") as any)).toBe(true);
      expect(filter(companionId, rootId, makeMsg("GREEN_SNAPSHOT") as any)).toBe(true);
      expect(filter(companionId, rootId, makeMsg("WORKER_DONE") as any)).toBe(false);
    });

    it("should allow signals for non-team agents", async () => {
      const manifest = await loadTeamTemplate("self-driving", roleRegistry);
      const runtime = new TeamRuntimeV2(manifest, services);
      await runtime.initialize();
      await runtime.bootstrap();
      runtime.installOnServices();

      const filter = inboxAdapter._signalFilter!;
      const makeMsg = (event: string) => ({
        content: { type: "event", event },
        metadata: {},
      });

      expect(filter("unknown_from", "unknown_to", makeMsg("ANY_SIGNAL") as any)).toBe(true);
    });
  });

  describe("emission validation (adapter-side)", () => {
    it("should install emission validator on InboxAdapter", async () => {
      const manifest = await loadTeamTemplate("self-driving", roleRegistry);
      const runtime = new TeamRuntimeV2(manifest, services);
      await runtime.initialize();
      await runtime.bootstrap();
      runtime.installOnServices();

      expect(inboxAdapter.addEmissionValidator).toHaveBeenCalledWith(
        "self-driving",
        expect.any(Function)
      );
    });

    it("should allow valid emissions", async () => {
      const manifest = await loadTeamTemplate("self-driving", roleRegistry);
      const runtime = new TeamRuntimeV2(manifest, services);
      await runtime.initialize();
      const result = await runtime.bootstrap();
      runtime.installOnServices();

      const validator = inboxAdapter._emissionValidator!;
      const makeMsg = (event: string) => ({
        content: { type: "event", event },
        metadata: {},
      });

      // planner's allowed emissions: [TASK_CREATED, WORK_ASSIGNED]
      expect(validator(result.rootId, makeMsg("TASK_CREATED") as any)).toBeNull();
    });

    it("should allow emissions from non-team agents", async () => {
      const manifest = await loadTeamTemplate("self-driving", roleRegistry);
      const runtime = new TeamRuntimeV2(manifest, services);
      await runtime.initialize();
      await runtime.bootstrap();
      runtime.installOnServices();

      const validator = inboxAdapter._emissionValidator!;
      const makeMsg = (event: string) => ({
        content: { type: "event", event },
        metadata: {},
      });

      expect(validator("unknown_agent", makeMsg("ANYTHING") as any)).toBeNull();
    });
  });

  describe("spawn interceptor", () => {
    it("should inject team context into spawn options", async () => {
      const manifest = await loadTeamTemplate("self-driving", roleRegistry);
      const runtime = new TeamRuntimeV2(manifest, services);
      await runtime.initialize();
      await runtime.bootstrap();
      runtime.installOnServices();

      // Spawn a grinder via interceptor
      await agentManager.spawn({
        task: "grinder task",
        role: "grinder",
        parent: runtime.getRootAgentId(),
      });

      const lastOpts = interceptedSpawnOptions.at(-1)!;
      expect(lastOpts.config?.env?.MACRO_TEAM_NAME).toBe("self-driving");
      expect(lastOpts.config?.env?.MACRO_TASK_MODE).toBe("pull");
      expect(lastOpts.team_instance).toBe("self-driving");
      expect(lastOpts.topics).toContain("work_coordination");
    });

    it("should pass through agents with unknown roles", async () => {
      const manifest = await loadTeamTemplate("self-driving", roleRegistry);
      const runtime = new TeamRuntimeV2(manifest, services);
      await runtime.initialize();
      await runtime.bootstrap();
      runtime.installOnServices();

      await agentManager.spawn({
        task: "unknown role",
        role: "unknown_role",
        parent: null,
      });

      const lastOpts = interceptedSpawnOptions.at(-1)!;
      // Unknown role → no team context injected
      expect(lastOpts.config?.env?.MACRO_TEAM_NAME).toBeUndefined();
    });
  });

  describe("getters", () => {
    it("should return task mode and strategy", async () => {
      const manifest = await loadTeamTemplate("self-driving", roleRegistry);
      const runtime = new TeamRuntimeV2(manifest, services);
      await runtime.initialize();

      expect(runtime.getTaskMode()).toBe("pull");
      expect(runtime.getStrategyName()).toBe("trunk");
    });

    it("should return scope = team name", async () => {
      const manifest = await loadTeamTemplate("self-driving", roleRegistry);
      const runtime = new TeamRuntimeV2(manifest, services);

      expect(runtime.getScope()).toBe("self-driving");
    });
  });

  describe("agent registration", () => {
    it("should track dynamically registered agents", async () => {
      const manifest = await loadTeamTemplate("self-driving", roleRegistry);
      const runtime = new TeamRuntimeV2(manifest, services);
      await runtime.initialize();
      await runtime.bootstrap();

      runtime.registerAgent("dynamic_1" as AgentId, "grinder");

      expect(runtime.hasAgent("dynamic_1")).toBe(true);
    });
  });

  describe("teardown", () => {
    it("should clean up without errors", async () => {
      const manifest = await loadTeamTemplate("self-driving", roleRegistry);
      const runtime = new TeamRuntimeV2(manifest, services);
      await runtime.initialize();
      await runtime.bootstrap();

      await expect(runtime.teardown()).resolves.toBeUndefined();
    });
  });
});
