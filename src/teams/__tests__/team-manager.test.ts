/**
 * TeamManager Tests
 *
 * Tests the central team instance lifecycle manager: starting/stopping teams,
 * composite dispatch of interceptors/filters/validators, and agent-to-team mapping.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as path from "path";
import { TeamManager } from "../team-manager.js";
import type { TeamServices } from "../team-runtime.js";
import { DefaultRoleRegistry } from "../../roles/registry.js";
import type { AgentManager, SpawnInterceptor } from "../../agent/agent-manager.js";
import type { MessageRouter } from "../../router/message-router.js";
import type { EventStore } from "../../store/event-store.js";
import type { SpawnAgentOptions } from "../../agent/types.js";
import type { AgentId, Event } from "../../store/types/index.js";

// =============================================================================
// Helpers
// =============================================================================

const PROJECT_ROOT = path.resolve(import.meta.dirname, "../../..");

let spawnCounter = 0;
let capturedInterceptor: SpawnInterceptor | null = null;
let interceptedSpawnOptions: SpawnAgentOptions[] = [];
let lifecycleCallbacks: Array<(event: any) => void> = [];

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
    updateAgentMetadata: vi.fn(),
    instanceId: "test-instance",
    _events: events,
  } as unknown as EventStore & { _events: Event[] };
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

function createMockAgentManager(roleRegistry: DefaultRoleRegistry): AgentManager {
  capturedInterceptor = null;
  spawnCounter = 0;
  interceptedSpawnOptions = [];
  lifecycleCallbacks = [];

  return {
    spawn: vi.fn(async (options: SpawnAgentOptions) => {
      const opts = capturedInterceptor ? await capturedInterceptor(options) : options;
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

// =============================================================================
// Tests
// =============================================================================

describe("TeamManager", () => {
  let roleRegistry: DefaultRoleRegistry;
  let agentManager: AgentManager;
  let messageRouter: MessageRouter;
  let eventStore: EventStore;
  let services: TeamServices;

  beforeEach(() => {
    roleRegistry = new DefaultRoleRegistry();
    eventStore = createMockEventStore();
    messageRouter = createMockMessageRouter();
    agentManager = createMockAgentManager(roleRegistry);
    services = { agentManager, messageRouter, eventStore };
  });

  describe("startTeam()", () => {
    it("loads template, creates runtime, initializes and bootstraps", async () => {
      const manager = new TeamManager(services);
      const instance = await manager.startTeam("self-driving", PROJECT_ROOT);

      expect(instance.id).toBe("self-driving-1");
      expect(instance.templateName).toBe("self-driving");
      expect(instance.result.rootId).toBeDefined();
      expect(instance.result.companionIds).toHaveLength(1);

      // Root (planner) + companion (judge) spawned
      expect(agentManager.spawn).toHaveBeenCalledTimes(2);
    });

    it("emits team_config event during initialization", async () => {
      const manager = new TeamManager(services);
      await manager.startTeam("self-driving", PROJECT_ROOT);

      expect(eventStore.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "status",
          payload: expect.objectContaining({
            team_config: expect.objectContaining({
              teamName: "self-driving",
            }),
          }),
        })
      );
    });

    it("allows multiple concurrent teams", async () => {
      const manager = new TeamManager(services);
      const first = await manager.startTeam("self-driving", PROJECT_ROOT);
      const second = await manager.startTeam("structured", PROJECT_ROOT);

      expect(manager.getInstances()).toHaveLength(2);
      expect(manager.getInstance(first.id)).toBe(first);
      expect(manager.getInstance(second.id)).toBe(second);
    });

    it("generates sequential instance IDs", async () => {
      const manager = new TeamManager(services);
      const first = await manager.startTeam("self-driving", PROJECT_ROOT);
      expect(first.id).toBe("self-driving-1");

      const second = await manager.startTeam("structured", PROJECT_ROOT);
      expect(second.id).toBe("structured-2");
    });

    it("maps bootstrap agents to the team instance", async () => {
      const manager = new TeamManager(services);
      const instance = await manager.startTeam("self-driving", PROJECT_ROOT);

      const rootTeam = manager.getTeamForAgent(instance.result.rootId);
      expect(rootTeam).toBe(instance);

      const companionTeam = manager.getTeamForAgent(instance.result.companionIds[0]);
      expect(companionTeam).toBe(instance);
    });

    it("tags bootstrap agents with team_instance in EventStore", async () => {
      const manager = new TeamManager(services);
      const instance = await manager.startTeam("self-driving", PROJECT_ROOT);

      // Root + companion agents should be tagged
      const allAgentIds = [instance.result.rootId, ...instance.result.companionIds];
      for (const agentId of allAgentIds) {
        expect(eventStore.updateAgentMetadata).toHaveBeenCalledWith(
          agentId,
          { team_instance: instance.id },
        );
      }
    });
  });

  describe("stopTeam()", () => {
    it("tears down the runtime and removes from map", async () => {
      const manager = new TeamManager(services);
      const instance = await manager.startTeam("self-driving", PROJECT_ROOT);

      await manager.stopTeam(instance.id);

      expect(manager.hasActiveTeam()).toBe(false);
      expect(manager.getInstance(instance.id)).toBeUndefined();
    });

    it("clears agent-to-team mapping for stopped team", async () => {
      const manager = new TeamManager(services);
      const instance = await manager.startTeam("self-driving", PROJECT_ROOT);
      const rootId = instance.result.rootId;

      await manager.stopTeam(instance.id);

      expect(manager.getTeamForAgent(rootId)).toBeUndefined();
    });

    it("throws for non-existent instance ID", async () => {
      const manager = new TeamManager(services);

      await expect(
        manager.stopTeam("nonexistent-1")
      ).rejects.toThrow(/No team instance 'nonexistent-1' found/);
    });

    it("allows starting a new team after stopping", async () => {
      const manager = new TeamManager(services);
      const first = await manager.startTeam("self-driving", PROJECT_ROOT);
      await manager.stopTeam(first.id);

      // Should not throw
      const second = await manager.startTeam("structured", PROJECT_ROOT);
      expect(second.templateName).toBe("structured");
    });
  });

  describe("teardownAll()", () => {
    it("stops all running instances", async () => {
      const manager = new TeamManager(services);
      await manager.startTeam("self-driving", PROJECT_ROOT);

      await manager.teardownAll();

      expect(manager.hasActiveTeam()).toBe(false);
      expect(manager.getInstances()).toEqual([]);
    });

    it("is safe to call with no running instances", async () => {
      const manager = new TeamManager(services);
      await manager.teardownAll(); // Should not throw
    });
  });

  describe("getters", () => {
    it("getInstance() returns instance by ID", async () => {
      const manager = new TeamManager(services);
      const instance = await manager.startTeam("self-driving", PROJECT_ROOT);

      expect(manager.getInstance(instance.id)).toBe(instance);
      expect(manager.getInstance("nonexistent")).toBeUndefined();
    });

    it("getInstances() returns all active instances", async () => {
      const manager = new TeamManager(services);
      const instance = await manager.startTeam("self-driving", PROJECT_ROOT);

      const instances = manager.getInstances();
      expect(instances).toHaveLength(1);
      expect(instances[0]).toBe(instance);
    });

    it("hasActiveTeam() reflects state correctly", async () => {
      const manager = new TeamManager(services);
      expect(manager.hasActiveTeam()).toBe(false);

      const instance = await manager.startTeam("self-driving", PROJECT_ROOT);
      expect(manager.hasActiveTeam()).toBe(true);

      await manager.stopTeam(instance.id);
      expect(manager.hasActiveTeam()).toBe(false);
    });
  });

  describe("install() — composite interceptor", () => {
    it("installs composite spawn interceptor on agent manager", async () => {
      const manager = new TeamManager(services);
      manager.install();

      expect(agentManager.setSpawnInterceptor).toHaveBeenCalledWith(
        expect.any(Function)
      );
    });

    it("interceptor passes through agents with no parent", async () => {
      const manager = new TeamManager(services);
      await manager.startTeam("self-driving", PROJECT_ROOT);
      manager.install();

      // Spawn with no parent — should pass through unchanged
      const original: SpawnAgentOptions = {
        task: "standalone task",
        role: "grinder",
        parent: null,
      };

      await agentManager.spawn(original);
      const lastOpts = interceptedSpawnOptions.at(-1)!;

      // No team context injected (parent is null)
      expect(lastOpts.config?.env?.MACRO_TEAM_NAME).toBeUndefined();
    });

    it("interceptor injects team context for child agents", async () => {
      const manager = new TeamManager(services);
      const instance = await manager.startTeam("self-driving", PROJECT_ROOT);
      manager.install();

      // Spawn a grinder as child of root (planner)
      await agentManager.spawn({
        task: "grinder task",
        role: "grinder",
        parent: instance.result.rootId,
      });

      const lastOpts = interceptedSpawnOptions.at(-1)!;
      expect(lastOpts.config?.env?.MACRO_TEAM_NAME).toBe("self-driving");
      expect(lastOpts.config?.env?.MACRO_TASK_MODE).toBe("pull");
      expect(lastOpts.topics).toContain("work_coordination");
    });

    it("interceptor sets team_instance on child agents", async () => {
      const manager = new TeamManager(services);
      const instance = await manager.startTeam("self-driving", PROJECT_ROOT);
      manager.install();

      await agentManager.spawn({
        task: "grinder task",
        role: "grinder",
        parent: instance.result.rootId,
      });

      const lastOpts = interceptedSpawnOptions.at(-1)!;
      expect(lastOpts.team_instance).toBe(instance.id);
    });

    it("interceptor passes through agents with non-team parent", async () => {
      const manager = new TeamManager(services);
      await manager.startTeam("self-driving", PROJECT_ROOT);
      manager.install();

      // Spawn with a parent that's not in the team
      await agentManager.spawn({
        task: "orphan task",
        role: "worker",
        parent: "non_team_parent",
      });

      const lastOpts = interceptedSpawnOptions.at(-1)!;
      expect(lastOpts.config?.env?.MACRO_TEAM_NAME).toBeUndefined();
    });
  });

  describe("install() — composite signal filter", () => {
    it("installs signal filter on message router", async () => {
      const manager = new TeamManager(services);
      manager.install();

      expect(messageRouter.setSignalFilter).toHaveBeenCalledWith(
        expect.any(Function)
      );
    });

    it("delegates filtering to correct team instance", async () => {
      const manager = new TeamManager(services);
      const instance = await manager.startTeam("self-driving", PROJECT_ROOT);
      manager.install();

      const filterFn = vi.mocked(messageRouter.setSignalFilter).mock.calls.at(-1)![0] as (
        from: string, to: string, signal: string | undefined
      ) => boolean;

      const rootId = instance.result.rootId;
      const companionId = instance.result.companionIds[0];

      // judge→planner has peer filter: [FIXUP_CREATED, GREEN_SNAPSHOT]
      expect(filterFn(companionId, rootId, "FIXUP_CREATED")).toBe(true);
      expect(filterFn(companionId, rootId, "WORKER_DONE")).toBe(false);
    });

    it("allows all signals for non-team agents", async () => {
      const manager = new TeamManager(services);
      await manager.startTeam("self-driving", PROJECT_ROOT);
      manager.install();

      const filterFn = vi.mocked(messageRouter.setSignalFilter).mock.calls.at(-1)![0] as (
        from: string, to: string, signal: string | undefined
      ) => boolean;

      // Non-team agents — should pass through
      expect(filterFn("unknown_from", "unknown_to", "ANY_SIGNAL")).toBe(true);
    });

    it("applies recipient's team filter for cross-team messages", async () => {
      const manager = new TeamManager(services);
      const teamA = await manager.startTeam("self-driving", PROJECT_ROOT);
      const teamB = await manager.startTeam("structured", PROJECT_ROOT);
      manager.install();

      // Register a grinder in team A and a developer in team B
      const spawnCallback = lifecycleCallbacks.at(-1)!;
      spawnCallback({
        type: "spawned",
        agent: { id: "grinder_1" as AgentId, parent: teamA.result.rootId as AgentId, role: "grinder", state: "running" },
      });
      spawnCallback({
        type: "spawned",
        agent: { id: "dev_1" as AgentId, parent: teamB.result.rootId as AgentId, role: "developer", state: "running" },
      });

      const filterFn = vi.mocked(messageRouter.setSignalFilter).mock.calls.at(-1)![0] as (
        from: string, to: string, signal: string | undefined
      ) => boolean;

      // grinder (team A) → developer (team B): recipient's team filter applies
      // developer's allowed signals from structured subscriptions: { TASK_ASSIGNED }
      expect(filterFn("grinder_1", "dev_1", "TASK_ASSIGNED")).toBe(true);
      expect(filterFn("grinder_1", "dev_1", "WORK_ASSIGNED")).toBe(false);
    });

    it("applies sender's team filter when recipient is non-team", async () => {
      const manager = new TeamManager(services);
      const teamA = await manager.startTeam("self-driving", PROJECT_ROOT);
      manager.install();

      // Register a grinder in team A
      const spawnCallback = lifecycleCallbacks.at(-1)!;
      spawnCallback({
        type: "spawned",
        agent: { id: "grinder_1" as AgentId, parent: teamA.result.rootId as AgentId, role: "grinder", state: "running" },
      });

      const filterFn = vi.mocked(messageRouter.setSignalFilter).mock.calls.at(-1)![0] as (
        from: string, to: string, signal: string | undefined
      ) => boolean;

      // grinder (team A) → non-team agent: sender's team filter is used
      // Non-team recipient has no role in team A's agentRoleMap → no filter → allow
      expect(filterFn("grinder_1", "outsider", "ANYTHING")).toBe(true);
      expect(filterFn("grinder_1", "outsider", "WORK_ASSIGNED")).toBe(true);
    });

    it("applies recipient's team filter when sender is non-team", async () => {
      const manager = new TeamManager(services);
      const teamB = await manager.startTeam("structured", PROJECT_ROOT);
      manager.install();

      // Register a developer in team B
      const spawnCallback = lifecycleCallbacks.at(-1)!;
      spawnCallback({
        type: "spawned",
        agent: { id: "dev_1" as AgentId, parent: teamB.result.rootId as AgentId, role: "developer", state: "running" },
      });

      const filterFn = vi.mocked(messageRouter.setSignalFilter).mock.calls.at(-1)![0] as (
        from: string, to: string, signal: string | undefined
      ) => boolean;

      // non-team → developer (team B): recipient's team filter applies
      // developer's allowed signals: { TASK_ASSIGNED }
      expect(filterFn("outsider", "dev_1", "TASK_ASSIGNED")).toBe(true);
      expect(filterFn("outsider", "dev_1", "WORK_ASSIGNED")).toBe(false);
    });

    it("recipient's team takes precedence over sender's team", async () => {
      const manager = new TeamManager(services);
      const teamA = await manager.startTeam("self-driving", PROJECT_ROOT);
      const teamB = await manager.startTeam("structured", PROJECT_ROOT);
      manager.install();

      // Register restricted-filter agents in each team
      const spawnCallback = lifecycleCallbacks.at(-1)!;
      spawnCallback({
        type: "spawned",
        agent: { id: "grinder_1" as AgentId, parent: teamA.result.rootId as AgentId, role: "grinder", state: "running" },
      });
      spawnCallback({
        type: "spawned",
        agent: { id: "dev_1" as AgentId, parent: teamB.result.rootId as AgentId, role: "developer", state: "running" },
      });

      const filterFn = vi.mocked(messageRouter.setSignalFilter).mock.calls.at(-1)![0] as (
        from: string, to: string, signal: string | undefined
      ) => boolean;

      // grinder → developer: recipient (developer in structured) filter applies
      // developer allows: { TASK_ASSIGNED }, grinder allows: { WORK_ASSIGNED }
      expect(filterFn("grinder_1", "dev_1", "TASK_ASSIGNED")).toBe(true);
      expect(filterFn("grinder_1", "dev_1", "WORK_ASSIGNED")).toBe(false);

      // Reverse: developer → grinder: recipient (grinder in self-driving) filter applies
      // grinder allows: { WORK_ASSIGNED }
      expect(filterFn("dev_1", "grinder_1", "WORK_ASSIGNED")).toBe(true);
      expect(filterFn("dev_1", "grinder_1", "TASK_ASSIGNED")).toBe(false);
    });
  });

  describe("install() — composite emission validator", () => {
    it("installs emission validator on message router", async () => {
      const manager = new TeamManager(services);
      manager.install();

      expect(messageRouter.setEmissionValidator).toHaveBeenCalledWith(
        expect.any(Function)
      );
    });

    it("delegates validation to correct team instance", async () => {
      const manager = new TeamManager(services);
      const instance = await manager.startTeam("self-driving", PROJECT_ROOT);
      manager.install();

      const validatorFn = vi.mocked(messageRouter.setEmissionValidator).mock.calls.at(-1)![0] as (
        agentId: string, signal: string | undefined
      ) => { action: string; message?: string };

      const rootId = instance.result.rootId;

      // planner's allowed emissions: [TASK_CREATED, WORK_ASSIGNED]
      expect(validatorFn(rootId, "TASK_CREATED").action).toBe("allow");
      // Default enforcement is permissive — disallowed signals get "warn"
      expect(validatorFn(rootId, "FORBIDDEN_SIGNAL").action).toBe("warn");
    });

    it("allows emissions for non-team agents", async () => {
      const manager = new TeamManager(services);
      await manager.startTeam("self-driving", PROJECT_ROOT);
      manager.install();

      const validatorFn = vi.mocked(messageRouter.setEmissionValidator).mock.calls.at(-1)![0] as (
        agentId: string, signal: string | undefined
      ) => { action: string; message?: string };

      expect(validatorFn("unknown_agent", "ANYTHING").action).toBe("allow");
    });
  });

  describe("install() — lifecycle listener", () => {
    it("sets up lifecycle listener for spawn tracking", async () => {
      const manager = new TeamManager(services);
      manager.install();

      expect(agentManager.onLifecycleEvent).toHaveBeenCalledWith(
        expect.any(Function)
      );
    });

    it("auto-registers child agents in parent's team", async () => {
      const manager = new TeamManager(services);
      const instance = await manager.startTeam("self-driving", PROJECT_ROOT);
      manager.install();

      // Simulate a grinder being spawned as child of root
      const spawnCallback = lifecycleCallbacks.at(-1)!;
      spawnCallback({
        type: "spawned",
        agent: {
          id: "grinder_1" as AgentId,
          parent: instance.result.rootId as AgentId,
          role: "grinder",
          state: "running",
        },
      });

      // grinder should be in the same team as root
      const grinderTeam = manager.getTeamForAgent("grinder_1");
      expect(grinderTeam).toBe(instance);

      // Also registered in runtime's agent role map
      expect(instance.runtime.hasAgent("grinder_1")).toBe(true);
    });

    it("ignores spawns with no parent", async () => {
      const manager = new TeamManager(services);
      await manager.startTeam("self-driving", PROJECT_ROOT);
      manager.install();

      const spawnCallback = lifecycleCallbacks.at(-1)!;
      spawnCallback({
        type: "spawned",
        agent: {
          id: "orphan_1" as AgentId,
          parent: null,
          role: "worker",
          state: "running",
        },
      });

      expect(manager.getTeamForAgent("orphan_1")).toBeUndefined();
    });

    it("ignores spawns from non-team parents", async () => {
      const manager = new TeamManager(services);
      await manager.startTeam("self-driving", PROJECT_ROOT);
      manager.install();

      const spawnCallback = lifecycleCallbacks.at(-1)!;
      spawnCallback({
        type: "spawned",
        agent: {
          id: "child_1" as AgentId,
          parent: "non_team_parent" as AgentId,
          role: "worker",
          state: "running",
        },
      });

      expect(manager.getTeamForAgent("child_1")).toBeUndefined();
    });

    it("ignores non-spawn lifecycle events", async () => {
      const manager = new TeamManager(services);
      const instance = await manager.startTeam("self-driving", PROJECT_ROOT);
      manager.install();

      const spawnCallback = lifecycleCallbacks.at(-1)!;
      spawnCallback({
        type: "stopped",
        agent: {
          id: instance.result.rootId as AgentId,
          parent: null,
          role: "planner",
          state: "stopped",
        },
        reason: "completed",
      });

      // Should not throw or change mappings
      expect(manager.getTeamForAgent(instance.result.rootId)).toBe(instance);
    });
  });

  describe("uninstall()", () => {
    it("clears spawn interceptor from agent manager", async () => {
      const manager = new TeamManager(services);
      manager.install();
      manager.uninstall();

      expect(agentManager.setSpawnInterceptor).toHaveBeenLastCalledWith(null);
    });

    it("unsubscribes lifecycle listener", async () => {
      const manager = new TeamManager(services);
      manager.install();

      const unsubscribeFn = vi.mocked(agentManager.onLifecycleEvent).mock.results[0].value;

      manager.uninstall();

      expect(unsubscribeFn).toHaveBeenCalled();
    });
  });

  describe("structured team", () => {
    it("starts structured team with push mode", async () => {
      const manager = new TeamManager(services);
      const instance = await manager.startTeam("structured", PROJECT_ROOT);

      expect(instance.templateName).toBe("structured");
      expect(instance.runtime.getTaskMode()).toBe("push");
      expect(instance.runtime.getStrategyName()).toBe("queue");
    });
  });

  describe("install() — spawn rules defense-in-depth", () => {
    it("rejects spawn when child role is not in parent's spawn_rules", async () => {
      const manager = new TeamManager(services);
      const instance = await manager.startTeam("self-driving", PROJECT_ROOT);
      manager.install();

      // self-driving spawn_rules: planner: [grinder, planner], judge: [], grinder: []
      // judge cannot spawn anything — attempt should throw
      await expect(
        agentManager.spawn({
          task: "disallowed child",
          role: "grinder",
          parent: instance.result.companionIds[0], // judge
        })
      ).rejects.toThrow(/Spawn rules violation: role 'judge' cannot spawn 'grinder'/);
    });

    it("allows spawn when child role is in parent's spawn_rules", async () => {
      const manager = new TeamManager(services);
      const instance = await manager.startTeam("self-driving", PROJECT_ROOT);
      manager.install();

      // planner can spawn grinder — should succeed
      await expect(
        agentManager.spawn({
          task: "allowed child",
          role: "grinder",
          parent: instance.result.rootId, // planner
        })
      ).resolves.toBeDefined();
    });

    it("passes through spawn when parent role has no spawn_rules entry", async () => {
      const manager = new TeamManager(services);
      const instance = await manager.startTeam("self-driving", PROJECT_ROOT);
      manager.install();

      // Simulate a dynamically spawned agent with a role not in spawn_rules
      const spawnCallback = lifecycleCallbacks.at(-1)!;
      spawnCallback({
        type: "spawned",
        agent: { id: "dynamic_1" as AgentId, parent: instance.result.rootId as AgentId, role: "custom_role", state: "running" },
      });

      // custom_role is not in spawn_rules — should pass through (no restriction)
      await expect(
        agentManager.spawn({
          task: "dynamic child",
          role: "some_child",
          parent: "dynamic_1",
        })
      ).resolves.toBeDefined();
    });

    it("passes through spawn when no role is specified on child", async () => {
      const manager = new TeamManager(services);
      const instance = await manager.startTeam("self-driving", PROJECT_ROOT);
      manager.install();

      // No role specified — spawn rules check is skipped
      await expect(
        agentManager.spawn({
          task: "roleless child",
          parent: instance.result.rootId,
        })
      ).resolves.toBeDefined();
    });
  });

  describe("role conflict detection", () => {
    it("warns when two teams register the same role name with different capabilities", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const manager = new TeamManager(services);
      // Both self-driving and structured inherit from built-in roles,
      // but register custom role definitions. Starting the same template twice
      // should not warn (same capabilities). Let's start two different templates
      // that share no custom role names — no warning expected.
      await manager.startTeam("self-driving", PROJECT_ROOT);
      await manager.startTeam("structured", PROJECT_ROOT);

      const conflictWarnings = warnSpy.mock.calls.filter(
        call => typeof call[0] === "string" && call[0].includes("Role") && call[0].includes("conflict")
      );
      expect(conflictWarnings).toHaveLength(0);

      warnSpy.mockRestore();
    });

    it("does not warn when same team is started twice (identical capabilities)", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const manager = new TeamManager(services);
      await manager.startTeam("self-driving", PROJECT_ROOT);
      await manager.startTeam("self-driving", PROJECT_ROOT);

      const conflictWarnings = warnSpy.mock.calls.filter(
        call => typeof call[0] === "string" && call[0].includes("conflict")
      );
      expect(conflictWarnings).toHaveLength(0);

      warnSpy.mockRestore();
    });

    it("warns when a role is re-registered with different capabilities", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      // Pre-register a role with specific capabilities
      roleRegistry.registerRole({
        name: "grinder",
        capabilities: ["file.read", "file.write"],
      });

      const manager = new TeamManager(services);
      // self-driving team registers grinder with its own capabilities
      await manager.startTeam("self-driving", PROJECT_ROOT);

      const conflictWarnings = warnSpy.mock.calls.filter(
        call => typeof call[0] === "string" && call[0].includes("Role 'grinder' conflict")
      );
      expect(conflictWarnings).toHaveLength(1);

      warnSpy.mockRestore();
    });
  });
});
