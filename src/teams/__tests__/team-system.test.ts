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
    setSignalFilter: vi.fn(),
    setEmissionValidator: vi.fn(),
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
    onLifecycleEvent: vi.fn(() => vi.fn()),
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

    it("wires config-driven peer subscriptions from routing.peers", async () => {
      const manifest = await loadTeam("self-driving", roleRegistry, PROJECT_ROOT);
      const runtime = new TeamRuntime(manifest, services);

      await runtime.initialize();
      const result = await runtime.bootstrap();

      // self-driving has 2 peer entries: judge→planner + planner→judge, both via: "direct"
      // Each creates one directional subtree subscription
      expect(messageRouter.subscribe).toHaveBeenCalledTimes(2);

      // judge (agent_1) subscribes to planner's (agent_0) subtree
      expect(messageRouter.subscribe).toHaveBeenCalledWith(
        result.companionIds[0], // judge = agent_1
        { type: "subtree", target: result.rootId } // planner = agent_0
      );

      // planner (agent_0) subscribes to judge's (agent_1) subtree
      expect(messageRouter.subscribe).toHaveBeenCalledWith(
        result.rootId, // planner = agent_0
        { type: "subtree", target: result.companionIds[0] } // judge = agent_1
      );
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

  describe("peer routing", () => {
    it("stores signal filters from peer connections", async () => {
      const manifest = await loadTeam("self-driving", roleRegistry, PROJECT_ROOT);
      const runtime = new TeamRuntime(manifest, services);

      await runtime.initialize();
      const result = await runtime.bootstrap();

      const filters = runtime.getPeerSignalFilters();

      // judge→planner has signals: [FIXUP_CREATED, GREEN_SNAPSHOT]
      const judgeToPlanner = filters.get(`${result.companionIds[0]}→${result.rootId}`);
      expect(judgeToPlanner).toEqual(["FIXUP_CREATED", "GREEN_SNAPSHOT"]);

      // planner→judge has signals: [CONVERGENCE_CHECK]
      const plannerToJudge = filters.get(`${result.rootId}→${result.companionIds[0]}`);
      expect(plannerToJudge).toEqual(["CONVERGENCE_CHECK"]);
    });

    it("falls back to legacy subtree subscriptions when no peers config", async () => {
      const manifest = await loadTeam("self-driving", roleRegistry, PROJECT_ROOT);

      // Remove routing.peers to test fallback
      manifest.communication.routing = { status: "upstream" };

      const runtime = new TeamRuntime(manifest, services);

      await runtime.initialize();
      const result = await runtime.bootstrap();

      // Legacy: 2 bidirectional subtree subs (root→companion + companion→root)
      expect(messageRouter.subscribe).toHaveBeenCalledTimes(2);
      expect(messageRouter.subscribe).toHaveBeenCalledWith(
        result.rootId,
        { type: "subtree", target: result.companionIds[0] }
      );
      expect(messageRouter.subscribe).toHaveBeenCalledWith(
        result.companionIds[0],
        { type: "subtree", target: result.rootId }
      );
    });

    it("defers wiring for roles not spawned at bootstrap", async () => {
      const manifest = await loadTeam("self-driving", roleRegistry, PROJECT_ROOT);

      // Add a peer connection involving grinder (not spawned at bootstrap)
      manifest.communication.routing!.peers!.push({
        from: "grinder",
        to: "planner",
        via: "direct",
        signals: ["WORKER_DONE"],
      });

      const runtime = new TeamRuntime(manifest, services);

      await runtime.initialize();
      const result = await runtime.bootstrap();

      // 2 wired at bootstrap (judge↔planner) + 1 deferred (grinder→planner)
      expect(messageRouter.subscribe).toHaveBeenCalledTimes(2);

      // onLifecycleEvent should have been called twice: once for deferred wiring, once for continuations
      expect(agentManager.onLifecycleEvent).toHaveBeenCalledTimes(2);

      // Simulate grinder spawn via lifecycle event
      const lifecycleCallbacks = vi.mocked(agentManager.onLifecycleEvent).mock.calls;
      // The deferred wiring callback is the first one registered (wirePeerRoutes before monitorContinuations)
      const deferredCallback = lifecycleCallbacks[0][0];

      deferredCallback({
        type: "spawned",
        agent: { id: "grinder_agent", role: "grinder", state: "running" },
      } as any);

      // Now the deferred route should be wired
      expect(messageRouter.subscribe).toHaveBeenCalledTimes(3);
      expect(messageRouter.subscribe).toHaveBeenCalledWith(
        "grinder_agent",
        { type: "subtree", target: result.rootId }
      );

      // Signal filter should be stored
      const filters = runtime.getPeerSignalFilters();
      expect(filters.get(`grinder_agent→${result.rootId}`)).toEqual(["WORKER_DONE"]);
    });

    it("serializes peerRoutes in team_config event", async () => {
      const manifest = await loadTeam("self-driving", roleRegistry, PROJECT_ROOT);
      const runtime = new TeamRuntime(manifest, services);

      await runtime.initialize();

      expect(eventStore.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "status",
          payload: expect.objectContaining({
            team_config: expect.objectContaining({
              peerRoutes: expect.arrayContaining([
                expect.objectContaining({
                  from: "judge",
                  to: "planner",
                  via: "direct",
                  signals: ["FIXUP_CREATED", "GREEN_SNAPSHOT"],
                }),
              ]),
            }),
          }),
        })
      );
    });

    it("teardown cleans up deferred wiring listener", async () => {
      const manifest = await loadTeam("self-driving", roleRegistry, PROJECT_ROOT);

      // Add a deferred route to ensure the wiring listener is set up
      manifest.communication.routing!.peers!.push({
        from: "grinder",
        to: "judge",
        via: "direct",
      });

      const runtime = new TeamRuntime(manifest, services);

      await runtime.initialize();
      await runtime.bootstrap();

      // onLifecycleEvent called twice: deferred wiring + continuations
      expect(agentManager.onLifecycleEvent).toHaveBeenCalledTimes(2);

      // Both return unsubscribe fns (index 0 = deferred wiring, index 1 = continuations)
      const peerWiringUnsub = vi.mocked(agentManager.onLifecycleEvent).mock.results[0].value;
      const continuationsUnsub = vi.mocked(agentManager.onLifecycleEvent).mock.results[1].value;

      await runtime.teardown();

      // Both unsubscribe fns should be called
      expect(peerWiringUnsub).toHaveBeenCalled();
      expect(continuationsUnsub).toHaveBeenCalled();
    });

    it("via topic creates shared topic subscription", async () => {
      const manifest = await loadTeam("self-driving", roleRegistry, PROJECT_ROOT);

      // Replace peers with a topic-based connection
      manifest.communication.routing!.peers = [
        { from: "planner", to: "judge", via: "topic" },
      ];

      const runtime = new TeamRuntime(manifest, services);

      await runtime.initialize();
      const result = await runtime.bootstrap();

      // Topic creates 2 subscriptions: both agents to the same topic
      expect(messageRouter.subscribe).toHaveBeenCalledTimes(2);
      expect(messageRouter.subscribe).toHaveBeenCalledWith(
        result.rootId, // planner
        { type: "topic", target: "peer:planner:judge" }
      );
      expect(messageRouter.subscribe).toHaveBeenCalledWith(
        result.companionIds[0], // judge
        { type: "topic", target: "peer:planner:judge" }
      );
    });

    it("via scope creates role subscription", async () => {
      const manifest = await loadTeam("self-driving", roleRegistry, PROJECT_ROOT);

      // Replace peers with a scope-based connection
      manifest.communication.routing!.peers = [
        { from: "planner", to: "judge", via: "scope" },
      ];

      const runtime = new TeamRuntime(manifest, services);

      await runtime.initialize();
      const result = await runtime.bootstrap();

      // Scope creates 1 subscription: from subscribes to to's role channel
      expect(messageRouter.subscribe).toHaveBeenCalledTimes(1);
      expect(messageRouter.subscribe).toHaveBeenCalledWith(
        result.rootId, // planner
        { type: "role", target: "judge" }
      );
    });
  });

  describe("signal filtering", () => {
    it("installs signal filter on message router after bootstrap", async () => {
      const manifest = await loadTeam("self-driving", roleRegistry, PROJECT_ROOT);
      const runtime = new TeamRuntime(manifest, services);

      await runtime.initialize();
      await runtime.bootstrap();

      expect(messageRouter.setSignalFilter).toHaveBeenCalledTimes(1);
      expect(messageRouter.setSignalFilter).toHaveBeenCalledWith(expect.any(Function));
    });

    it("peer connection filter allows matching signals", async () => {
      const manifest = await loadTeam("self-driving", roleRegistry, PROJECT_ROOT);
      const runtime = new TeamRuntime(manifest, services);

      await runtime.initialize();
      const result = await runtime.bootstrap();

      // Extract the installed filter
      const filterFn = vi.mocked(messageRouter.setSignalFilter).mock.calls[0][0] as (
        from: string, to: string, signal: string | undefined
      ) => boolean;

      const judgeId = result.companionIds[0]; // judge
      const plannerId = result.rootId; // planner

      // judge→planner peer has signals: [FIXUP_CREATED, GREEN_SNAPSHOT]
      expect(filterFn(judgeId, plannerId, "FIXUP_CREATED")).toBe(true);
      expect(filterFn(judgeId, plannerId, "GREEN_SNAPSHOT")).toBe(true);
    });

    it("peer connection filter blocks non-matching signals", async () => {
      const manifest = await loadTeam("self-driving", roleRegistry, PROJECT_ROOT);
      const runtime = new TeamRuntime(manifest, services);

      await runtime.initialize();
      const result = await runtime.bootstrap();

      const filterFn = vi.mocked(messageRouter.setSignalFilter).mock.calls[0][0] as (
        from: string, to: string, signal: string | undefined
      ) => boolean;

      const judgeId = result.companionIds[0];
      const plannerId = result.rootId;

      // judge→planner peer does NOT include WORKER_DONE
      expect(filterFn(judgeId, plannerId, "WORKER_DONE")).toBe(false);
    });

    it("untagged status events always pass through", async () => {
      const manifest = await loadTeam("self-driving", roleRegistry, PROJECT_ROOT);
      const runtime = new TeamRuntime(manifest, services);

      await runtime.initialize();
      const result = await runtime.bootstrap();

      const filterFn = vi.mocked(messageRouter.setSignalFilter).mock.calls[0][0] as (
        from: string, to: string, signal: string | undefined
      ) => boolean;

      const judgeId = result.companionIds[0];
      const plannerId = result.rootId;

      // No signal (undefined) should always pass
      expect(filterFn(judgeId, plannerId, undefined)).toBe(true);
    });

    it("channel subscription filter allows role's configured signals", async () => {
      const manifest = await loadTeam("self-driving", roleRegistry, PROJECT_ROOT);
      const runtime = new TeamRuntime(manifest, services);

      await runtime.initialize();
      const result = await runtime.bootstrap();

      const filterFn = vi.mocked(messageRouter.setSignalFilter).mock.calls[0][0] as (
        from: string, to: string, signal: string | undefined
      ) => boolean;

      // Use a "grinder" agent as recipient - grinder only allows WORK_ASSIGNED
      // Simulate spawning a grinder by triggering deferred wiring
      // But grinder has no peer connection, so we test channel sub filter directly
      // by spawning through the lifecycle event to populate agentRoleMap

      // Add a grinder peer route so deferred wiring populates agentRoleMap
      manifest.communication.routing!.peers!.push({
        from: "grinder",
        to: "planner",
        via: "direct",
      });

      // Re-bootstrap with updated manifest
      const runtime2 = new TeamRuntime(manifest, services);
      await runtime2.initialize();
      const result2 = await runtime2.bootstrap();

      // Simulate grinder spawn via lifecycle event
      const deferredCallback = vi.mocked(agentManager.onLifecycleEvent).mock.calls.at(-2)![0];
      deferredCallback({
        type: "spawned",
        agent: { id: "grinder_1", role: "grinder", state: "running" },
      } as any);

      // Get the latest filter (from runtime2's installSignalFilter)
      const filterFn2 = vi.mocked(messageRouter.setSignalFilter).mock.calls.at(-1)![0] as (
        from: string, to: string, signal: string | undefined
      ) => boolean;

      // grinder allows WORK_ASSIGNED from channel subs
      // But grinder→planner is a peer route (no signal filter), so test from a non-peer source
      // From planner to grinder_1 (no peer filter exists for this direction)
      expect(filterFn2(result2.rootId, "grinder_1", "WORK_ASSIGNED")).toBe(true);
      expect(filterFn2(result2.rootId, "grinder_1", "WORKER_DONE")).toBe(false);
    });

    it("roles with any unfiltered subscription receive all signals", async () => {
      const manifest = await loadTeam("self-driving", roleRegistry, PROJECT_ROOT);
      const runtime = new TeamRuntime(manifest, services);

      await runtime.initialize();
      const result = await runtime.bootstrap();

      const filterFn = vi.mocked(messageRouter.setSignalFilter).mock.calls[0][0] as (
        from: string, to: string, signal: string | undefined
      ) => boolean;

      // planner has task_updates subscription with no signals filter → receives all
      // But planner's peer connections have explicit filters, so test from a non-peer agent
      // From an unknown agent to planner — falls through to channel sub filter
      expect(filterFn("unknown_agent", result.rootId, "ANY_SIGNAL")).toBe(true);
      expect(filterFn("unknown_agent", result.rootId, "RANDOM")).toBe(true);
    });

    it("peer filter takes precedence over channel subscription filter", async () => {
      const manifest = await loadTeam("self-driving", roleRegistry, PROJECT_ROOT);
      const runtime = new TeamRuntime(manifest, services);

      await runtime.initialize();
      const result = await runtime.bootstrap();

      const filterFn = vi.mocked(messageRouter.setSignalFilter).mock.calls[0][0] as (
        from: string, to: string, signal: string | undefined
      ) => boolean;

      const judgeId = result.companionIds[0];
      const plannerId = result.rootId;

      // judge→planner peer only allows FIXUP_CREATED, GREEN_SNAPSHOT
      // Even though planner's channel subs allow "all" (via unfiltered task_updates),
      // the peer filter takes precedence
      expect(filterFn(judgeId, plannerId, "TASK_CREATED")).toBe(false);
    });
  });

  describe("emission validation", () => {
    it("installs emission validator on message router after bootstrap", async () => {
      const manifest = await loadTeam("self-driving", roleRegistry, PROJECT_ROOT);
      const runtime = new TeamRuntime(manifest, services);

      await runtime.initialize();
      await runtime.bootstrap();

      expect(messageRouter.setEmissionValidator).toHaveBeenCalledTimes(1);
      expect(messageRouter.setEmissionValidator).toHaveBeenCalledWith(expect.any(Function));
    });

    it("allows emissions in role's allowed list", async () => {
      const manifest = await loadTeam("self-driving", roleRegistry, PROJECT_ROOT);
      const runtime = new TeamRuntime(manifest, services);

      await runtime.initialize();
      const result = await runtime.bootstrap();

      const validatorFn = vi.mocked(messageRouter.setEmissionValidator).mock.calls[0][0] as (
        agentId: string, signal: string | undefined
      ) => { action: string; message?: string };

      const plannerId = result.rootId;

      // planner's emissions: [TASK_CREATED, WORK_ASSIGNED]
      expect(validatorFn(plannerId, "TASK_CREATED").action).toBe("allow");
      expect(validatorFn(plannerId, "WORK_ASSIGNED").action).toBe("allow");
    });

    it("rejects disallowed emissions in strict mode", async () => {
      const manifest = await loadTeam("self-driving", roleRegistry, PROJECT_ROOT);
      manifest.communication.enforcement = "strict";
      const runtime = new TeamRuntime(manifest, services);

      await runtime.initialize();
      const result = await runtime.bootstrap();

      const validatorFn = vi.mocked(messageRouter.setEmissionValidator).mock.calls[0][0] as (
        agentId: string, signal: string | undefined
      ) => { action: string; message?: string };

      const plannerId = result.rootId;

      // WORKER_DONE is not in planner's allowed emissions
      const res = validatorFn(plannerId, "WORKER_DONE");
      expect(res.action).toBe("reject");
      expect(res.message).toContain("WORKER_DONE");
      expect(res.message).toContain("planner");
    });

    it("warns on disallowed emissions in permissive mode", async () => {
      const manifest = await loadTeam("self-driving", roleRegistry, PROJECT_ROOT);
      manifest.communication.enforcement = "permissive";
      const runtime = new TeamRuntime(manifest, services);

      await runtime.initialize();
      const result = await runtime.bootstrap();

      const validatorFn = vi.mocked(messageRouter.setEmissionValidator).mock.calls[0][0] as (
        agentId: string, signal: string | undefined
      ) => { action: string; message?: string };

      const plannerId = result.rootId;

      const res = validatorFn(plannerId, "HEALTH_CHECK");
      expect(res.action).toBe("warn");
      expect(res.message).toContain("HEALTH_CHECK");
    });

    it("audits disallowed emissions in audit mode", async () => {
      const manifest = await loadTeam("self-driving", roleRegistry, PROJECT_ROOT);
      manifest.communication.enforcement = "audit";
      const runtime = new TeamRuntime(manifest, services);

      await runtime.initialize();
      const result = await runtime.bootstrap();

      const validatorFn = vi.mocked(messageRouter.setEmissionValidator).mock.calls[0][0] as (
        agentId: string, signal: string | undefined
      ) => { action: string; message?: string };

      const plannerId = result.rootId;

      const res = validatorFn(plannerId, "FORBIDDEN");
      expect(res.action).toBe("audit");
      expect(res.message).toContain("FORBIDDEN");
    });

    it("allows untagged emissions for any role", async () => {
      const manifest = await loadTeam("self-driving", roleRegistry, PROJECT_ROOT);
      manifest.communication.enforcement = "strict";
      const runtime = new TeamRuntime(manifest, services);

      await runtime.initialize();
      const result = await runtime.bootstrap();

      const validatorFn = vi.mocked(messageRouter.setEmissionValidator).mock.calls[0][0] as (
        agentId: string, signal: string | undefined
      ) => { action: string; message?: string };

      // Undefined signal always passes even in strict mode
      expect(validatorFn(result.rootId, undefined).action).toBe("allow");
      expect(validatorFn(result.companionIds[0], undefined).action).toBe("allow");
    });

    it("allows emissions from agents with no role mapping", async () => {
      const manifest = await loadTeam("self-driving", roleRegistry, PROJECT_ROOT);
      manifest.communication.enforcement = "strict";
      const runtime = new TeamRuntime(manifest, services);

      await runtime.initialize();
      await runtime.bootstrap();

      const validatorFn = vi.mocked(messageRouter.setEmissionValidator).mock.calls[0][0] as (
        agentId: string, signal: string | undefined
      ) => { action: string; message?: string };

      // Unknown agent — no role mapping, so allowed
      expect(validatorFn("unknown_agent", "ANYTHING").action).toBe("allow");
    });

    it("does not install validator when no emissions config", async () => {
      const manifest = await loadTeam("self-driving", roleRegistry, PROJECT_ROOT);
      manifest.communication.emissions = undefined;
      const runtime = new TeamRuntime(manifest, services);

      await runtime.initialize();
      await runtime.bootstrap();

      expect(messageRouter.setEmissionValidator).not.toHaveBeenCalled();
    });

    it("serializes emissions in team_config event", async () => {
      const manifest = await loadTeam("self-driving", roleRegistry, PROJECT_ROOT);
      const runtime = new TeamRuntime(manifest, services);

      await runtime.initialize();

      expect(eventStore.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "status",
          payload: expect.objectContaining({
            team_config: expect.objectContaining({
              emissions: expect.objectContaining({
                planner: ["TASK_CREATED", "WORK_ASSIGNED"],
                judge: ["HEALTH_CHECK", "GREEN_SNAPSHOT", "FIXUP_CREATED"],
                grinder: ["WORKER_DONE"],
              }),
            }),
          }),
        })
      );
    });
  });

  describe("monitorContinuations()", () => {
    it("auto-continues root agent on unexpected stop", async () => {
      const manifest = await loadTeam("self-driving", roleRegistry, PROJECT_ROOT);
      const runtime = new TeamRuntime(manifest, services);

      await runtime.initialize();
      const result = await runtime.bootstrap();

      // Capture the lifecycle callback registered during bootstrap
      const onLifecycleEventMock = vi.mocked(agentManager.onLifecycleEvent);
      expect(onLifecycleEventMock).toHaveBeenCalled();
      const lifecycleCallback = onLifecycleEventMock.mock.calls[0][0];

      // Simulate unexpected stop of root agent (no reason = unexpected)
      lifecycleCallback({
        type: "stopped",
        agent: { id: result.rootId, role: "planner", state: "stopped" },
      } as any);

      // Wait for the setTimeout (1s) + async continuation
      await vi.waitFor(
        () => {
          expect(agentManager.continueAgent).toHaveBeenCalledWith(result.rootId);
        },
        { timeout: 3000 }
      );

      // Root agent ID should be updated to the continued agent
      expect(runtime.getRootAgentId()).toBe("continued_0");
    });

    it("auto-continues companion agent on unexpected stop", async () => {
      const manifest = await loadTeam("self-driving", roleRegistry, PROJECT_ROOT);
      const runtime = new TeamRuntime(manifest, services);

      await runtime.initialize();
      const result = await runtime.bootstrap();
      const companionId = result.companionIds[0];

      const lifecycleCallback = vi.mocked(agentManager.onLifecycleEvent).mock.calls[0][0];

      // Simulate unexpected stop of companion
      lifecycleCallback({
        type: "stopped",
        agent: { id: companionId, role: "judge", state: "stopped" },
      } as any);

      await vi.waitFor(
        () => {
          expect(agentManager.continueAgent).toHaveBeenCalledWith(companionId);
        },
        { timeout: 3000 }
      );

      // Companion ID should be updated
      expect(runtime.getCompanionAgentIds()).toContain("continued_0");
    });

    it("does NOT auto-continue on completed stop", async () => {
      const manifest = await loadTeam("self-driving", roleRegistry, PROJECT_ROOT);
      const runtime = new TeamRuntime(manifest, services);

      await runtime.initialize();
      const result = await runtime.bootstrap();

      const lifecycleCallback = vi.mocked(agentManager.onLifecycleEvent).mock.calls[0][0];

      // Simulate completed stop (should NOT trigger continuation)
      lifecycleCallback({
        type: "stopped",
        agent: { id: result.rootId, role: "planner", state: "stopped" },
        reason: "completed",
      } as any);

      // Wait a bit to ensure no continuation is triggered
      await new Promise((resolve) => setTimeout(resolve, 1500));
      expect(agentManager.continueAgent).not.toHaveBeenCalled();
    });

    it("does NOT auto-continue on cancelled stop", async () => {
      const manifest = await loadTeam("self-driving", roleRegistry, PROJECT_ROOT);
      const runtime = new TeamRuntime(manifest, services);

      await runtime.initialize();
      const result = await runtime.bootstrap();

      const lifecycleCallback = vi.mocked(agentManager.onLifecycleEvent).mock.calls[0][0];

      lifecycleCallback({
        type: "stopped",
        agent: { id: result.rootId, role: "planner", state: "stopped" },
        reason: "cancelled",
      } as any);

      await new Promise((resolve) => setTimeout(resolve, 1500));
      expect(agentManager.continueAgent).not.toHaveBeenCalled();
    });

    it("does NOT trigger for non-monitored agents", async () => {
      const manifest = await loadTeam("self-driving", roleRegistry, PROJECT_ROOT);
      const runtime = new TeamRuntime(manifest, services);

      await runtime.initialize();
      await runtime.bootstrap();

      const lifecycleCallback = vi.mocked(agentManager.onLifecycleEvent).mock.calls[0][0];

      // Simulate stop of an unrelated agent
      lifecycleCallback({
        type: "stopped",
        agent: { id: "unrelated_agent", role: "worker", state: "stopped" },
      } as any);

      await new Promise((resolve) => setTimeout(resolve, 1500));
      expect(agentManager.continueAgent).not.toHaveBeenCalled();
    });

    it("unsubscribes lifecycle listener on teardown", async () => {
      const manifest = await loadTeam("self-driving", roleRegistry, PROJECT_ROOT);
      const runtime = new TeamRuntime(manifest, services);

      await runtime.initialize();
      await runtime.bootstrap();

      // onLifecycleEvent returns an unsubscribe function
      const unsubscribeFn = vi.mocked(agentManager.onLifecycleEvent).mock.results[0].value;

      await runtime.teardown();

      // The unsubscribe function should have been called
      expect(unsubscribeFn).toHaveBeenCalled();
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
