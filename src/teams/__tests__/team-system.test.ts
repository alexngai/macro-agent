/**
 * Team System Tests
 *
 * Tests loading team templates, runtime initialization, bootstrap,
 * and integration between team subsystems (roles, communication,
 * strategies, task modes).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as path from "path";
import { loadTeam } from "../team-loader.js";
import { TeamRuntime, type TeamServices } from "../team-runtime.js";
import { DefaultRoleRegistry } from "../../roles/registry.js";
import type { RoleDefinition } from "../../roles/types.js";
import type { AgentManager, SpawnInterceptor } from "../../agent/agent-manager.js";
import type { MessageRouter } from "../../router/message-router.js";
import type { EventStore } from "../../store/event-store.js";
import type { SpawnAgentOptions } from "../../agent/types.js";
import type { AgentId, Event } from "../../store/types/index.js";

// =============================================================================
// Helpers
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
  } as unknown as MessageRouter;
}

let spawnCounter = 0;
let capturedInterceptor: SpawnInterceptor | null = null;
let interceptedSpawnOptions: SpawnAgentOptions[] = [];

function createMockAgentManager(roleRegistry: DefaultRoleRegistry): AgentManager {
  capturedInterceptor = null;
  spawnCounter = 0;
  interceptedSpawnOptions = [];

  return {
    spawn: vi.fn(async (options: SpawnAgentOptions) => {
      // Apply interceptor if set and record the intercepted options
      const opts = capturedInterceptor ? capturedInterceptor(options) : options;
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
        _spawnOptions: opts,
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
    onLifecycleEvent: vi.fn(() => () => {}),
    continueAgent: vi.fn().mockResolvedValue({ id: "continued_0" }),
    close: vi.fn().mockResolvedValue(undefined),
    getOrCreateHeadManager: vi.fn(),
    prompt: vi.fn(),
    isPrompting: vi.fn().mockReturnValue(false),
  } as unknown as AgentManager;
}

// =============================================================================
// Tests: Team Loading
// =============================================================================

describe("Team Template Loading", () => {
  let roleRegistry: DefaultRoleRegistry;

  beforeEach(() => {
    roleRegistry = new DefaultRoleRegistry();
  });

  it("loads self-driving team template", async () => {
    const manifest = await loadTeam("self-driving", roleRegistry, PROJECT_ROOT);

    expect(manifest.name).toBe("self-driving");
    expect(manifest.version).toBe(1);
    expect(manifest.roles).toEqual(["planner", "grinder", "judge"]);
  });

  it("resolves self-driving roles with correct base roles", async () => {
    const manifest = await loadTeam("self-driving", roleRegistry, PROJECT_ROOT);

    const planner = manifest._resolvedRoles.get("planner");
    expect(planner).toBeDefined();
    expect(planner!.baseRole).toBe("coordinator");

    const grinder = manifest._resolvedRoles.get("grinder");
    expect(grinder).toBeDefined();
    expect(grinder!.baseRole).toBe("worker");

    const judge = manifest._resolvedRoles.get("judge");
    expect(judge).toBeDefined();
    expect(judge!.baseRole).toBe("monitor");
  });

  it("resolves capability additions and removals", async () => {
    const manifest = await loadTeam("self-driving", roleRegistry, PROJECT_ROOT);

    const planner = manifest._resolvedRoles.get("planner");
    expect(planner!.capabilities).toContain("task.claim");
    expect(planner!.capabilities).not.toContain("agent.spawn.integrator");
    expect(planner!.capabilities).not.toContain("agent.spawn.monitor");

    const grinder = manifest._resolvedRoles.get("grinder");
    expect(grinder!.capabilities).toContain("task.claim");
    expect(grinder!.capabilities).toContain("git.push");
  });

  it("translates spawn_rules into capabilities", async () => {
    const manifest = await loadTeam("self-driving", roleRegistry, PROJECT_ROOT);

    const planner = manifest._resolvedRoles.get("planner");
    expect(planner!.capabilities).toContain("agent.spawn.grinder");
    expect(planner!.capabilities).toContain("agent.spawn.planner");

    // Judge and grinder have no spawn rules → no spawn capabilities
    const judge = manifest._resolvedRoles.get("judge");
    expect(judge!.capabilities.filter((c) => c.startsWith("agent.spawn."))).toEqual([]);
  });

  it("loads prompt files", async () => {
    const manifest = await loadTeam("self-driving", roleRegistry, PROJECT_ROOT);

    expect(manifest._loadedPrompts.has("prompts/planner.md")).toBe(true);
    expect(manifest._loadedPrompts.has("prompts/grinder.md")).toBe(true);
    expect(manifest._loadedPrompts.has("prompts/judge.md")).toBe(true);

    const plannerPrompt = manifest._loadedPrompts.get("prompts/planner.md")!;
    expect(plannerPrompt).toContain("Planner");
  });

  it("parses macro_agent extensions", async () => {
    const manifest = await loadTeam("self-driving", roleRegistry, PROJECT_ROOT);

    expect(manifest.macro_agent.task_assignment?.mode).toBe("pull");
    expect(manifest.macro_agent.integration?.strategy).toBe("trunk");
    expect(manifest.macro_agent.lifecycle?.continuations?.enabled).toBe(true);
    expect(manifest.macro_agent.lifecycle?.scaling?.max_workers).toBe(20);
  });

  it("validates communication topology", async () => {
    const manifest = await loadTeam("self-driving", roleRegistry, PROJECT_ROOT);

    expect(manifest.communication.channels).toBeDefined();
    expect(Object.keys(manifest.communication.channels!)).toContain("task_updates");
    expect(Object.keys(manifest.communication.channels!)).toContain("work_coordination");
    expect(Object.keys(manifest.communication.channels!)).toContain("health");

    expect(manifest.communication.subscriptions?.planner).toBeDefined();
    expect(manifest.communication.emissions?.planner).toContain("TASK_CREATED");
  });

  it("loads structured team template", async () => {
    const manifest = await loadTeam("structured", roleRegistry, PROJECT_ROOT);

    expect(manifest.name).toBe("structured");
    expect(manifest.roles).toEqual(["lead", "developer", "reviewer"]);
    expect(manifest.macro_agent.task_assignment?.mode).toBe("push");
    expect(manifest.macro_agent.integration?.strategy).toBe("queue");
  });

  it("resolves structured roles", async () => {
    const manifest = await loadTeam("structured", roleRegistry, PROJECT_ROOT);

    const lead = manifest._resolvedRoles.get("lead");
    expect(lead!.baseRole).toBe("coordinator");

    const developer = manifest._resolvedRoles.get("developer");
    expect(developer!.baseRole).toBe("worker");

    const reviewer = manifest._resolvedRoles.get("reviewer");
    expect(reviewer!.baseRole).toBe("monitor");
    expect(reviewer!.capabilities).toContain("exec.build");
    expect(reviewer!.capabilities).toContain("exec.test");
  });
});

// =============================================================================
// Tests: TeamRuntime
// =============================================================================

describe("TeamRuntime", () => {
  let roleRegistry: DefaultRoleRegistry;
  let agentManager: AgentManager;
  let messageRouter: MessageRouter;
  let eventStore: EventStore & { _events: Event[] };
  let services: TeamServices;

  beforeEach(() => {
    roleRegistry = new DefaultRoleRegistry();
    eventStore = createMockEventStore() as EventStore & { _events: Event[] };
    messageRouter = createMockMessageRouter();
    agentManager = createMockAgentManager(roleRegistry);
    services = { agentManager, messageRouter, eventStore };
  });

  describe("initialize()", () => {
    it("registers team roles in the role registry", async () => {
      const manifest = await loadTeam("self-driving", roleRegistry, PROJECT_ROOT);
      const runtime = new TeamRuntime(manifest, services);

      await runtime.initialize();

      // Roles should be registered in the registry
      expect(roleRegistry.getRole("planner")).toBeDefined();
      expect(roleRegistry.getRole("grinder")).toBeDefined();
      expect(roleRegistry.getRole("judge")).toBeDefined();
    });

    it("emits team_config event to EventStore", async () => {
      const manifest = await loadTeam("self-driving", roleRegistry, PROJECT_ROOT);
      const runtime = new TeamRuntime(manifest, services);

      await runtime.initialize();

      expect(eventStore.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "status",
          payload: expect.objectContaining({
            status_type: "discovery",
            team_config: expect.objectContaining({
              teamName: "self-driving",
              strategy: "trunk",
              taskMode: "pull",
            }),
          }),
        })
      );
    });

    it("sets spawn interceptor on agent manager", async () => {
      const manifest = await loadTeam("self-driving", roleRegistry, PROJECT_ROOT);
      const runtime = new TeamRuntime(manifest, services);

      await runtime.initialize();

      expect(agentManager.setSpawnInterceptor).toHaveBeenCalledWith(
        expect.any(Function)
      );
    });
  });

  describe("bootstrap()", () => {
    it("spawns root and companion agents", async () => {
      const manifest = await loadTeam("self-driving", roleRegistry, PROJECT_ROOT);
      const runtime = new TeamRuntime(manifest, services);

      await runtime.initialize();
      const result = await runtime.bootstrap();

      expect(result.rootId).toBeDefined();
      expect(result.companionIds).toHaveLength(1); // judge is the companion

      // Two spawn calls: planner (root) + judge (companion)
      expect(agentManager.spawn).toHaveBeenCalledTimes(2);
    });

    it("spawns root with correct role and model", async () => {
      const manifest = await loadTeam("self-driving", roleRegistry, PROJECT_ROOT);
      const runtime = new TeamRuntime(manifest, services);

      await runtime.initialize();
      await runtime.bootstrap();

      const spawnCalls = vi.mocked(agentManager.spawn).mock.calls;
      const rootCall = spawnCalls[0][0];

      expect(rootCall.role).toBe("planner");
      expect(rootCall.config?.model).toBe("sonnet");
      expect(rootCall.parent).toBeNull();
    });

    it("spawns companion as peer (not child)", async () => {
      const manifest = await loadTeam("self-driving", roleRegistry, PROJECT_ROOT);
      const runtime = new TeamRuntime(manifest, services);

      await runtime.initialize();
      await runtime.bootstrap();

      const spawnCalls = vi.mocked(agentManager.spawn).mock.calls;
      const companionCall = spawnCalls[1][0];

      expect(companionCall.role).toBe("judge");
      expect(companionCall.config?.model).toBe("haiku");
      expect(companionCall.parent).toBeNull();
    });

    it("sets up peer subscriptions between root and companions", async () => {
      const manifest = await loadTeam("self-driving", roleRegistry, PROJECT_ROOT);
      const runtime = new TeamRuntime(manifest, services);

      await runtime.initialize();
      await runtime.bootstrap();

      // Should have 2 subscribe calls: root→companion + companion→root
      expect(messageRouter.subscribe).toHaveBeenCalledTimes(2);
    });

    it("injects interaction patterns for pull mode", async () => {
      const manifest = await loadTeam("self-driving", roleRegistry, PROJECT_ROOT);
      const runtime = new TeamRuntime(manifest, services);

      await runtime.initialize();
      await runtime.bootstrap();

      const spawnCalls = vi.mocked(agentManager.spawn).mock.calls;
      const rootCall = spawnCalls[0][0];

      expect(rootCall.interactionPatterns).toBeDefined();
      expect(rootCall.interactionPatterns!.length).toBeGreaterThan(0);
      expect(rootCall.interactionPatterns!.some((p) => p.includes("PULL mode"))).toBe(true);
      expect(rootCall.interactionPatterns!.some((p) => p.includes("trunk"))).toBe(true);
    });

    it("provides team prompts to spawned agents", async () => {
      const manifest = await loadTeam("self-driving", roleRegistry, PROJECT_ROOT);
      const runtime = new TeamRuntime(manifest, services);

      await runtime.initialize();
      await runtime.bootstrap();

      const spawnCalls = vi.mocked(agentManager.spawn).mock.calls;
      const rootCall = spawnCalls[0][0];

      expect(rootCall.customPrompt).toBeDefined();
      expect(rootCall.customPrompt).toContain("Planner");
    });
  });

  describe("spawn interceptor", () => {
    it("injects team topics into spawned agent options", async () => {
      const manifest = await loadTeam("self-driving", roleRegistry, PROJECT_ROOT);
      const runtime = new TeamRuntime(manifest, services);

      await runtime.initialize();
      await runtime.bootstrap();

      // Now spawn a grinder through the interceptor
      await agentManager.spawn({
        task: "test grinder task",
        role: "grinder",
        parent: "agent_0",
      });

      // Check the intercepted options (not the original args)
      const lastOpts = interceptedSpawnOptions.at(-1)!;
      // Interceptor should have added topics for grinder subscriptions
      expect(lastOpts.topics).toBeDefined();
      expect(lastOpts.topics).toContain("work_coordination");
    });

    it("injects team environment variables", async () => {
      const manifest = await loadTeam("self-driving", roleRegistry, PROJECT_ROOT);
      const runtime = new TeamRuntime(manifest, services);

      await runtime.initialize();
      await runtime.bootstrap();

      // Spawn a grinder
      await agentManager.spawn({
        task: "test task",
        role: "grinder",
        parent: "agent_0",
      });

      const lastOpts = interceptedSpawnOptions.at(-1)!;
      expect(lastOpts.config?.env?.MACRO_TEAM_NAME).toBe("self-driving");
      expect(lastOpts.config?.env?.MACRO_TASK_MODE).toBe("pull");
      expect(lastOpts.config?.env?.MACRO_INTEGRATION_STRATEGY).toBe("trunk");
    });

    it("does not override caller-provided options", async () => {
      const manifest = await loadTeam("self-driving", roleRegistry, PROJECT_ROOT);
      const runtime = new TeamRuntime(manifest, services);

      await runtime.initialize();
      await runtime.bootstrap();

      const customPrompt = "My custom prompt";
      await agentManager.spawn({
        task: "test task",
        role: "grinder",
        parent: "agent_0",
        customPrompt,
      });

      const lastOpts = interceptedSpawnOptions.at(-1)!;
      expect(lastOpts.customPrompt).toBe(customPrompt);
    });
  });

  describe("getters", () => {
    it("returns task mode and strategy", async () => {
      const manifest = await loadTeam("self-driving", roleRegistry, PROJECT_ROOT);
      const runtime = new TeamRuntime(manifest, services);

      expect(runtime.getTaskMode()).toBe("pull");
      expect(runtime.getStrategyName()).toBe("trunk");
    });

    it("returns agent IDs after bootstrap", async () => {
      const manifest = await loadTeam("self-driving", roleRegistry, PROJECT_ROOT);
      const runtime = new TeamRuntime(manifest, services);

      await runtime.initialize();
      const result = await runtime.bootstrap();

      expect(runtime.getRootAgentId()).toBe(result.rootId);
      expect(runtime.getCompanionAgentIds()).toEqual(result.companionIds);
    });
  });

  describe("teardown()", () => {
    it("clears spawn interceptor", async () => {
      const manifest = await loadTeam("self-driving", roleRegistry, PROJECT_ROOT);
      const runtime = new TeamRuntime(manifest, services);

      await runtime.initialize();
      await runtime.bootstrap();
      await runtime.teardown();

      expect(agentManager.setSpawnInterceptor).toHaveBeenLastCalledWith(null);
    });
  });

  describe("structured team", () => {
    it("bootstraps with push mode and queue strategy", async () => {
      const manifest = await loadTeam("structured", roleRegistry, PROJECT_ROOT);
      const runtime = new TeamRuntime(manifest, services);

      expect(runtime.getTaskMode()).toBe("push");
      expect(runtime.getStrategyName()).toBe("queue");

      await runtime.initialize();
      const result = await runtime.bootstrap();

      // Root (lead) + 1 companion (reviewer)
      expect(agentManager.spawn).toHaveBeenCalledTimes(2);
      expect(result.companionIds).toHaveLength(1);

      // Verify no pull-mode interaction patterns injected
      const rootCall = vi.mocked(agentManager.spawn).mock.calls[0][0];
      const pullPatterns = rootCall.interactionPatterns?.filter((p) =>
        p.includes("PULL mode")
      ) ?? [];
      expect(pullPatterns).toHaveLength(0);
    });
  });
});

// =============================================================================
// Tests: Integration Strategies
// =============================================================================

describe("Integration Strategies", () => {
  it("imports trunk strategy module", async () => {
    const { TrunkIntegrationStrategy } = await import(
      "../../workspace/strategies/trunk.js"
    );
    const strategy = new TrunkIntegrationStrategy();
    expect(strategy.name).toBe("trunk");
  });

  it("imports optimistic strategy module", async () => {
    const { OptimisticIntegrationStrategy } = await import(
      "../../workspace/strategies/optimistic.js"
    );
    const strategy = new OptimisticIntegrationStrategy();
    expect(strategy.name).toBe("optimistic");
  });

  it("imports queue strategy module", async () => {
    const { QueueIntegrationStrategy } = await import(
      "../../workspace/strategies/queue.js"
    );
    const strategy = new QueueIntegrationStrategy();
    expect(strategy.name).toBe("queue");
  });

  it("registry provides all built-in strategies", async () => {
    const { defaultStrategyRegistry } = await import(
      "../../workspace/strategies/registry.js"
    );
    expect(defaultStrategyRegistry.has("queue")).toBe(true);
    expect(defaultStrategyRegistry.has("trunk")).toBe(true);
    expect(defaultStrategyRegistry.has("optimistic")).toBe(true);
  });
});

// =============================================================================
// Tests: Task Pull Model
// =============================================================================

describe("Task Pull Model", () => {
  it("claim_task tool module exports correctly", async () => {
    const { CLAIM_TASK_TOOL_INFO, ClaimTaskSchema, createClaimTaskHandler } =
      await import("../../mcp/tools/claim_task.js");

    expect(CLAIM_TASK_TOOL_INFO.name).toBe("claim_task");
    expect(createClaimTaskHandler).toBeInstanceOf(Function);
    expect(ClaimTaskSchema).toBeDefined();
  });

  it("unclaim_task tool module exports correctly", async () => {
    const { UNCLAIM_TASK_TOOL_INFO, createUnclaimTaskHandler } = await import(
      "../../mcp/tools/unclaim_task.js"
    );

    expect(UNCLAIM_TASK_TOOL_INFO.name).toBe("unclaim_task");
    expect(createUnclaimTaskHandler).toBeInstanceOf(Function);
  });

  it("list_claimable_tasks tool module exports correctly", async () => {
    const { LIST_CLAIMABLE_TASKS_TOOL_INFO, createListClaimableTasksHandler } =
      await import("../../mcp/tools/list_claimable_tasks.js");

    expect(LIST_CLAIMABLE_TASKS_TOOL_INFO.name).toBe("list_claimable_tasks");
    expect(createListClaimableTasksHandler).toBeInstanceOf(Function);
  });

  it("task.claim capability is registered", async () => {
    const { TASK_CAPABILITIES, ALL_CAPABILITIES } = await import(
      "../../roles/capabilities.js"
    );

    expect(TASK_CAPABILITIES.CLAIM).toBe("task.claim");
    expect(ALL_CAPABILITIES.has("task.claim")).toBe(true);
  });
});

// =============================================================================
// Tests: Metrics Module
// =============================================================================

describe("Metrics Module", () => {
  it("exports all metric functions", async () => {
    const {
      getThroughputMetrics,
      getUtilizationMetrics,
      getErrorMetrics,
    } = await import("../../metrics/index.js");

    expect(getThroughputMetrics).toBeInstanceOf(Function);
    expect(getUtilizationMetrics).toBeInstanceOf(Function);
    expect(getErrorMetrics).toBeInstanceOf(Function);
  });

  it("computes throughput metrics from empty store", async () => {
    const { getThroughputMetrics } = await import("../../metrics/index.js");
    const store = createMockEventStore();

    const metrics = getThroughputMetrics(store, 60000);

    expect(metrics.tasksCompleted).toBe(0);
    expect(metrics.tasksFailed).toBe(0);
    expect(metrics.tasksCreated).toBe(0);
    expect(metrics.completedPerMinute).toBe(0);
    expect(metrics.avgCompletionTimeMs).toBeNull();
  });

  it("computes utilization metrics from empty store", async () => {
    const { getUtilizationMetrics } = await import("../../metrics/index.js");
    const store = createMockEventStore();

    const metrics = getUtilizationMetrics(store);

    expect(metrics.activeAgents).toBe(0);
    expect(metrics.totalSpawned).toBe(0);
    expect(metrics.totalStopped).toBe(0);
  });

  it("computes error metrics from empty store", async () => {
    const { getErrorMetrics } = await import("../../metrics/index.js");
    const store = createMockEventStore();

    const metrics = getErrorMetrics(store);

    expect(metrics.totalErrors).toBe(0);
    expect(metrics.recentErrors).toEqual([]);
  });
});
