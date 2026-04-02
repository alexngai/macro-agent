/**
 * Tests for TeamManagerV2 — multi-team orchestrator
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as path from "path";
import { TeamManagerV2, type TeamManagerV2Services } from "../team-manager-v2.js";
import { DefaultRoleRegistry } from "../../roles/registry.js";
import type { AgentManager, SpawnInterceptor } from "../../agent/agent-manager.js";
import type {
  InboxAdapter,
  TasksAdapter,
  SignalFilterFn,
  EmissionValidatorFn,
} from "../../adapters/types.js";
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

function createMockAgentManager(
  roleRegistry: DefaultRoleRegistry
): AgentManager {
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

      // Notify lifecycle callbacks
      for (const cb of lifecycleCallbacks) {
        cb({
          type: "spawned",
          agent: {
            id,
            session_id: `session_${id}`,
            task: opts.task ?? "test",
            state: "running",
            created_at: Date.now(),
            parent: opts.parent ?? null,
            role: opts.role,
          },
        });
      }

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
      return vi.fn(() => {
        const idx = lifecycleCallbacks.indexOf(callback);
        if (idx >= 0) lifecycleCallbacks.splice(idx, 1);
      });
    }),
    continueAgent: vi.fn().mockResolvedValue({ id: "continued_0" }),
    close: vi.fn().mockResolvedValue(undefined),
    getOrCreateHeadManager: vi.fn(),
    prompt: vi.fn(),
    isPrompting: vi.fn().mockReturnValue(false),
  } as unknown as AgentManager;
}

function createMockInboxAdapter(): InboxAdapter & {
  _signalFilters: Map<string, SignalFilterFn>;
  _emissionValidators: Map<string, EmissionValidatorFn>;
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
    get _signalFilters() {
      return signalFilters;
    },
    get _emissionValidators() {
      return emissionValidators;
    },
  } as unknown as InboxAdapter & {
    _signalFilters: Map<string, SignalFilterFn>;
    _emissionValidators: Map<string, EmissionValidatorFn>;
  };
}

function createMockTasksAdapter(): TasksAdapter {
  return {
    createTask: vi.fn().mockResolvedValue("ot-task-1"),
    assignTask: vi.fn().mockResolvedValue(undefined),
    transitionTask: vi.fn().mockResolvedValue(undefined),
    getTask: vi
      .fn()
      .mockResolvedValue({ id: "t-1", title: "test", status: "open" }),
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

// =============================================================================
// Tests
// =============================================================================

describe("TeamManagerV2", () => {
  let roleRegistry: DefaultRoleRegistry;
  let agentManager: AgentManager;
  let inboxAdapter: ReturnType<typeof createMockInboxAdapter>;
  let tasksAdapter: TasksAdapter;
  let services: TeamManagerV2Services;
  let manager: TeamManagerV2;

  beforeEach(() => {
    roleRegistry = new DefaultRoleRegistry();
    agentManager = createMockAgentManager(roleRegistry);
    inboxAdapter = createMockInboxAdapter();
    tasksAdapter = createMockTasksAdapter();
    services = { agentManager, inboxAdapter, tasksAdapter };
    manager = new TeamManagerV2(services);
  });

  // ── startTeam ───────────────────────────────────────────────

  describe("startTeam", () => {
    it("should load template, create runtime, initialize, and bootstrap", async () => {
      manager.install();
      const instanceId = await manager.startTeam("self-driving", PROJECT_ROOT);

      expect(instanceId).toBeTruthy();
      expect(instanceId).toContain("self-driving");

      const instance = manager.getInstance(instanceId);
      expect(instance).toBeDefined();
      expect(instance!.templateName).toBe("self-driving");
      expect(instance!.result.rootId).toBeDefined();
      expect(instance!.result.companionIds.length).toBeGreaterThanOrEqual(1);

      // Should have spawned root + companions
      expect(agentManager.spawn).toHaveBeenCalled();
    });

    it("should register signal filter and emission validator via add methods", async () => {
      manager.install();
      const instanceId = await manager.startTeam("self-driving", PROJECT_ROOT);

      // Should have used addSignalFilter, not setSignalFilter
      expect(inboxAdapter.addSignalFilter).toHaveBeenCalledWith(
        instanceId,
        expect.any(Function)
      );
      expect(inboxAdapter.addEmissionValidator).toHaveBeenCalledWith(
        instanceId,
        expect.any(Function)
      );

      // Filters should be in the map
      expect(inboxAdapter._signalFilters.has(instanceId)).toBe(true);
      expect(inboxAdapter._emissionValidators.has(instanceId)).toBe(true);
    });
  });

  // ── Multiple concurrent teams ────────────────────────────────

  describe("multiple concurrent teams", () => {
    it("should support two teams active simultaneously", async () => {
      manager.install();
      const id1 = await manager.startTeam("self-driving", PROJECT_ROOT);
      const id2 = await manager.startTeam("self-driving", PROJECT_ROOT);

      expect(id1).not.toBe(id2);
      expect(manager.getInstances()).toHaveLength(2);
      expect(manager.hasActiveTeam()).toBe(true);

      // Both should have their filters registered
      expect(inboxAdapter._signalFilters.has(id1)).toBe(true);
      expect(inboxAdapter._signalFilters.has(id2)).toBe(true);
      expect(inboxAdapter._emissionValidators.has(id1)).toBe(true);
      expect(inboxAdapter._emissionValidators.has(id2)).toBe(true);
    });
  });

  // ── Agent-to-team mapping ───────────────────────────────────

  describe("agent-to-team mapping", () => {
    it("should map bootstrap agents to their team", async () => {
      manager.install();
      const instanceId = await manager.startTeam("self-driving", PROJECT_ROOT);
      const instance = manager.getInstance(instanceId)!;

      // Root and companions should be mapped
      const rootTeam = manager.getTeamForAgent(instance.result.rootId);
      expect(rootTeam).toBe(instance);

      for (const companionId of instance.result.companionIds) {
        expect(manager.getTeamForAgent(companionId)).toBe(instance);
      }
    });

    it("should auto-map dynamic children to parent team", async () => {
      manager.install();
      const instanceId = await manager.startTeam("self-driving", PROJECT_ROOT);
      const instance = manager.getInstance(instanceId)!;

      // Spawn a child of the root agent
      const child = await agentManager.spawn({
        task: "child task",
        role: "grinder",
        parent: instance.result.rootId,
      });

      // Child should be auto-mapped to the same team
      const childTeam = manager.getTeamForAgent(child.id);
      expect(childTeam).toBe(instance);
    });

    it("should not map standalone agents to any team", async () => {
      manager.install();
      await manager.startTeam("self-driving", PROJECT_ROOT);

      // Spawn an agent with no parent
      const standalone = await agentManager.spawn({
        task: "standalone task",
        role: "worker",
        parent: null,
      });

      expect(manager.getTeamForAgent(standalone.id)).toBeUndefined();
    });
  });

  // ── Composite spawn interceptor ─────────────────────────────

  describe("composite spawn interceptor", () => {
    it("should apply team context to children of team agents", async () => {
      manager.install();
      const instanceId = await manager.startTeam("self-driving", PROJECT_ROOT);
      const instance = manager.getInstance(instanceId)!;

      // Spawn a grinder child of the root
      await agentManager.spawn({
        task: "grinder task",
        role: "grinder",
        parent: instance.result.rootId,
      });

      // The intercepted options should have team context
      const lastOpts = interceptedSpawnOptions.at(-1)!;
      expect(lastOpts.config?.env?.MACRO_TEAM_NAME).toBe("self-driving");
      expect(lastOpts.team_instance).toBe("self-driving");
    });

    it("should pass through spawns with no parent", async () => {
      manager.install();
      await manager.startTeam("self-driving", PROJECT_ROOT);

      await agentManager.spawn({
        task: "no parent",
        role: "worker",
        parent: null,
      });

      const lastOpts = interceptedSpawnOptions.at(-1)!;
      // No team context should be injected
      expect(lastOpts.config?.env?.MACRO_TEAM_NAME).toBeUndefined();
    });
  });

  // ── Signal filter composition ────────────────────────────────

  describe("signal filter composition", () => {
    it("should have independent signal filters per team", async () => {
      manager.install();
      const id1 = await manager.startTeam("self-driving", PROJECT_ROOT);
      const id2 = await manager.startTeam("self-driving", PROJECT_ROOT);

      const filter1 = inboxAdapter._signalFilters.get(id1);
      const filter2 = inboxAdapter._signalFilters.get(id2);

      expect(filter1).toBeDefined();
      expect(filter2).toBeDefined();
      expect(filter1).not.toBe(filter2);
    });

    it("should preserve team A filters when team B is added", async () => {
      manager.install();
      const id1 = await manager.startTeam("self-driving", PROJECT_ROOT);
      expect(inboxAdapter._signalFilters.has(id1)).toBe(true);

      const id2 = await manager.startTeam("self-driving", PROJECT_ROOT);

      // Team A's filter should still be there after team B is added
      expect(inboxAdapter._signalFilters.has(id1)).toBe(true);
      expect(inboxAdapter._signalFilters.has(id2)).toBe(true);
      expect(id1).not.toBe(id2); // Different instance IDs
    });
  });

  // ── stopTeam ────────────────────────────────────────────────

  describe("stopTeam", () => {
    it("should remove team filters and clear agent mappings", async () => {
      manager.install();
      const instanceId = await manager.startTeam("self-driving", PROJECT_ROOT);
      const instance = manager.getInstance(instanceId)!;
      const rootId = instance.result.rootId;

      await manager.stopTeam(instanceId);

      // Filters should be removed
      expect(inboxAdapter._signalFilters.has(instanceId)).toBe(false);
      expect(inboxAdapter._emissionValidators.has(instanceId)).toBe(false);
      expect(inboxAdapter.removeSignalFilter).toHaveBeenCalledWith(instanceId);
      expect(inboxAdapter.removeEmissionValidator).toHaveBeenCalledWith(
        instanceId
      );

      // Agent mappings should be cleared
      expect(manager.getTeamForAgent(rootId)).toBeUndefined();

      // Instance should be removed
      expect(manager.getInstance(instanceId)).toBeUndefined();
      expect(manager.hasActiveTeam()).toBe(false);
    });

    it("should not affect other teams when stopping one", async () => {
      manager.install();
      const id1 = await manager.startTeam("self-driving", PROJECT_ROOT);
      const id2 = await manager.startTeam("self-driving", PROJECT_ROOT);

      await manager.stopTeam(id1);

      // Team 2 should still be active
      expect(manager.getInstance(id2)).toBeDefined();
      expect(inboxAdapter._signalFilters.has(id2)).toBe(true);
      expect(inboxAdapter._emissionValidators.has(id2)).toBe(true);
      expect(manager.hasActiveTeam()).toBe(true);
    });
  });

  // ── teardownAll ──────────────────────────────────────────────

  describe("teardownAll", () => {
    it("should stop all teams and uninstall", async () => {
      manager.install();
      const id1 = await manager.startTeam("self-driving", PROJECT_ROOT);
      const id2 = await manager.startTeam("self-driving", PROJECT_ROOT);

      await manager.teardownAll();

      expect(manager.getInstances()).toHaveLength(0);
      expect(manager.hasActiveTeam()).toBe(false);
      expect(inboxAdapter._signalFilters.has(id1)).toBe(false);
      expect(inboxAdapter._signalFilters.has(id2)).toBe(false);

      // Spawn interceptor should be cleared
      expect(agentManager.setSpawnInterceptor).toHaveBeenCalledWith(null);
    });
  });
});
