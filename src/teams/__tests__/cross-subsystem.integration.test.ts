/**
 * Cross-Subsystem Integration Tests
 *
 * Tests interactions between subsystems:
 * - Strategy ↔ Worker Handler
 * - Task Backend claim/unclaim cycle
 * - Team Config → Spawn Interceptor → Worker Done pipeline
 * - Metrics ↔ EventStore realistic events
 * - Pull mode lifecycle ↔ handler dispatch
 * - Role resolution ↔ capability gating
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as path from "path";
import { loadTeam } from "../team-loader.js";
import { TeamRuntime, type TeamServices } from "../team-runtime.js";
import { DefaultRoleRegistry } from "../../roles/registry.js";
import {
  handleWorkerDone,
  type WorkerHandlerDeps,
} from "../../lifecycle/handlers/worker.js";
import {
  dispatchDone,
  createHandlerRegistry,
  type AllHandlerDeps,
} from "../../lifecycle/handlers/index.js";
import type {
  LifecycleContext,
  DoneArgs,
  CleanupStatus,
} from "../../lifecycle/types.js";
import type {
  IntegrationStrategy,
  LandRequest,
  LandResult,
} from "../../workspace/strategies/types.js";
import { defaultStrategyRegistry } from "../../workspace/strategies/registry.js";
import {
  createClaimTaskHandler,
  type ClaimTaskDeps,
} from "../../mcp/tools/claim_task.js";
import {
  createUnclaimTaskHandler,
  type UnclaimTaskDeps,
} from "../../mcp/tools/unclaim_task.js";
import {
  createListClaimableTasksHandler,
} from "../../mcp/tools/list_claimable_tasks.js";
import type { TaskBackend, ClaimFilter, ExtendedTask } from "../../task/backend/types.js";
import type { ToolContext } from "../../mcp/types.js";
import {
  getThroughputMetrics,
  getUtilizationMetrics,
  getErrorMetrics,
} from "../../metrics/index.js";
import {
  TASK_CAPABILITIES,
  CAPABILITY_TOOL_MAP,
} from "../../roles/capabilities.js";
import type { AgentManager, SpawnInterceptor } from "../../agent/agent-manager.js";
import type { MessageRouter } from "../../router/message-router.js";
import type { EventStore } from "../../store/event-store.js";
import type { SpawnAgentOptions } from "../../agent/types.js";
import type { Event, Agent } from "../../store/types/index.js";

// =============================================================================
// Shared Helpers
// =============================================================================

const PROJECT_ROOT = path.resolve(import.meta.dirname, "../../..");

function createMockEventStore(events: Event[] = []): EventStore & { _events: Event[] } {
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
    query: vi.fn((filter: { type?: string; after?: number }) => {
      return events.filter((e) => {
        if (filter.type && e.type !== filter.type) return false;
        if (filter.after && e.timestamp < filter.after) return false;
        return true;
      });
    }),
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

function createMockStrategy(
  name: string,
  landResult: LandResult = { status: "landed", commitHash: "abc123" }
): IntegrationStrategy & { land: ReturnType<typeof vi.fn> } {
  return {
    name,
    land: vi.fn().mockResolvedValue(landResult),
  };
}

function createWorkerContext(overrides: Partial<LifecycleContext> = {}): LifecycleContext {
  return {
    agentId: "worker-1",
    role: "worker",
    taskId: "task-1",
    workspacePath: "/tmp/test-workspace",
    branch: "feature/test",
    integrationBranch: "integration",
    streamId: "stream-1",
    ...overrides,
  };
}

function createCleanupStatus(): CleanupStatus {
  return { ready: true };
}

// =============================================================================
// Tests: Strategy ↔ Worker Handler Integration
// =============================================================================

describe("Strategy ↔ Worker Handler", () => {
  let messageRouter: MessageRouter;
  let agentManager: AgentManager;

  beforeEach(() => {
    messageRouter = createMockMessageRouter();
    agentManager = {
      getChildren: vi.fn().mockReturnValue([]),
    } as unknown as AgentManager;
  });

  it("dispatches to integration strategy when configured", async () => {
    const strategy = createMockStrategy("trunk");
    const deps: WorkerHandlerDeps = {
      messageRouter,
      agentManager,
      integrationStrategy: strategy,
    };

    const context = createWorkerContext();
    const args: DoneArgs = { status: "completed", summary: "Done" };

    const result = await handleWorkerDone(context, args, createCleanupStatus(), deps);

    expect(strategy.land).toHaveBeenCalledTimes(1);
    expect(strategy.land).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceBranch: "feature/test",
        targetBranch: "integration",
        workspacePath: "/tmp/test-workspace",
        agentId: "worker-1",
        taskId: "task-1",
        streamId: "stream-1",
      })
    );
    expect(result.signalsEmitted).toContain("WORKER_INTEGRATED");
    expect(result.shouldTerminate).toBe(true);
  });

  it("falls back to merge queue when no strategy configured", async () => {
    const mergeQueue = {
      submit: vi.fn().mockReturnValue("mr-1"),
    };
    const deps: WorkerHandlerDeps = {
      messageRouter,
      agentManager,
      mergeQueue: mergeQueue as any,
      // No integrationStrategy
    };

    const context = createWorkerContext();
    const args: DoneArgs = { status: "completed" };

    const result = await handleWorkerDone(context, args, createCleanupStatus(), deps);

    expect(mergeQueue.submit).toHaveBeenCalledTimes(1);
    expect(result.signalsEmitted).toContain("MERGE_REQUEST");
  });

  it("strategy takes priority over merge queue", async () => {
    const strategy = createMockStrategy("trunk");
    const mergeQueue = { submit: vi.fn() };
    const deps: WorkerHandlerDeps = {
      messageRouter,
      agentManager,
      integrationStrategy: strategy,
      mergeQueue: mergeQueue as any,
    };

    const context = createWorkerContext();
    const args: DoneArgs = { status: "completed" };

    await handleWorkerDone(context, args, createCleanupStatus(), deps);

    expect(strategy.land).toHaveBeenCalledTimes(1);
    expect(mergeQueue.submit).not.toHaveBeenCalled();
  });

  it("handles strategy conflict result gracefully", async () => {
    const strategy = createMockStrategy("trunk", {
      status: "conflict",
      conflictFiles: ["src/foo.ts"],
      error: "Rebase conflict after 3 retries",
    });
    const deps: WorkerHandlerDeps = {
      messageRouter,
      agentManager,
      integrationStrategy: strategy,
    };

    const context = createWorkerContext();
    const args: DoneArgs = { status: "completed" };

    const result = await handleWorkerDone(context, args, createCleanupStatus(), deps);

    expect(result.warnings).toBeDefined();
    expect(result.warnings!.some((w) => w.includes("conflict"))).toBe(true);
    expect(result.signalsEmitted).not.toContain("WORKER_INTEGRATED");
  });

  it("handles strategy failure result gracefully", async () => {
    const strategy = createMockStrategy("trunk", {
      status: "failed",
      error: "Push rejected",
    });
    const deps: WorkerHandlerDeps = {
      messageRouter,
      agentManager,
      integrationStrategy: strategy,
    };

    const context = createWorkerContext();
    const args: DoneArgs = { status: "completed" };

    const result = await handleWorkerDone(context, args, createCleanupStatus(), deps);

    expect(result.warnings).toBeDefined();
    expect(result.warnings!.some((w) => w.includes("failed"))).toBe(true);
  });

  it("handles strategy exception gracefully", async () => {
    const strategy = createMockStrategy("trunk");
    strategy.land.mockRejectedValue(new Error("Git process crashed"));
    const deps: WorkerHandlerDeps = {
      messageRouter,
      agentManager,
      integrationStrategy: strategy,
    };

    const context = createWorkerContext();
    const args: DoneArgs = { status: "completed" };

    const result = await handleWorkerDone(context, args, createCleanupStatus(), deps);

    // Should not throw — graceful degradation
    expect(result.warnings).toBeDefined();
    expect(result.warnings!.some((w) => w.includes("Git process crashed"))).toBe(true);
  });

  it("skips strategy when status is not completed", async () => {
    const strategy = createMockStrategy("trunk");
    const deps: WorkerHandlerDeps = {
      messageRouter,
      agentManager,
      integrationStrategy: strategy,
    };

    const context = createWorkerContext();
    const args: DoneArgs = { status: "failed", summary: "Build failed" };

    await handleWorkerDone(context, args, createCleanupStatus(), deps);

    expect(strategy.land).not.toHaveBeenCalled();
  });
});

// =============================================================================
// Tests: Pull Mode Lifecycle
// =============================================================================

describe("Pull Mode ↔ Worker Handler", () => {
  let messageRouter: MessageRouter;
  let agentManager: AgentManager;

  beforeEach(() => {
    messageRouter = createMockMessageRouter();
    agentManager = {
      getChildren: vi.fn().mockReturnValue([]),
    } as unknown as AgentManager;
  });

  it("pull mode workers stay alive after completion", async () => {
    const strategy = createMockStrategy("trunk");
    const deps: WorkerHandlerDeps = {
      messageRouter,
      agentManager,
      integrationStrategy: strategy,
      taskMode: "pull",
    };

    const context = createWorkerContext();
    const args: DoneArgs = { status: "completed" };

    const result = await handleWorkerDone(context, args, createCleanupStatus(), deps);

    expect(result.shouldTerminate).toBe(false);
  });

  it("pull mode workers still terminate on failure", async () => {
    const strategy = createMockStrategy("trunk");
    const deps: WorkerHandlerDeps = {
      messageRouter,
      agentManager,
      integrationStrategy: strategy,
      taskMode: "pull",
    };

    const context = createWorkerContext();
    const args: DoneArgs = { status: "failed", summary: "Error" };

    const result = await handleWorkerDone(context, args, createCleanupStatus(), deps);

    expect(result.shouldTerminate).toBe(true);
  });

  it("push mode workers always terminate", async () => {
    const strategy = createMockStrategy("trunk");
    const deps: WorkerHandlerDeps = {
      messageRouter,
      agentManager,
      integrationStrategy: strategy,
      taskMode: "push",
    };

    const context = createWorkerContext();
    const args: DoneArgs = { status: "completed" };

    const result = await handleWorkerDone(context, args, createCleanupStatus(), deps);

    expect(result.shouldTerminate).toBe(true);
  });

  it("undefined taskMode defaults to terminate (push behavior)", async () => {
    const strategy = createMockStrategy("trunk");
    const deps: WorkerHandlerDeps = {
      messageRouter,
      agentManager,
      integrationStrategy: strategy,
      // taskMode undefined
    };

    const context = createWorkerContext();
    const args: DoneArgs = { status: "completed" };

    const result = await handleWorkerDone(context, args, createCleanupStatus(), deps);

    expect(result.shouldTerminate).toBe(true);
  });
});

// =============================================================================
// Tests: Handler Registry ↔ Team Roles
// =============================================================================

describe("Handler Registry ↔ Team Roles", () => {
  it("team-defined roles dispatch to correct base handler", async () => {
    const messageRouter = createMockMessageRouter();
    const agentManager = {
      getChildren: vi.fn().mockReturnValue([]),
    } as unknown as AgentManager;

    const strategy = createMockStrategy("trunk");
    const deps: AllHandlerDeps = {
      messageRouter,
      agentManager,
      integrationStrategy: strategy,
      taskMode: "pull",
    };

    // "grinder" extends "worker" — should get the worker handler
    const context = createWorkerContext({ role: "worker", agentId: "grinder-1" });
    const args: DoneArgs = { status: "completed" };

    const result = await dispatchDone(context, args, createCleanupStatus(), deps);

    expect(strategy.land).toHaveBeenCalledTimes(1);
    expect(result.shouldTerminate).toBe(false); // pull mode
  });

  it("monitor roles do not trigger strategy dispatch", async () => {
    const messageRouter = createMockMessageRouter();
    const agentManager = {
      getChildren: vi.fn().mockReturnValue([]),
    } as unknown as AgentManager;

    const strategy = createMockStrategy("trunk");
    const deps: AllHandlerDeps = {
      messageRouter,
      agentManager,
      integrationStrategy: strategy,
    };

    const context: LifecycleContext = {
      agentId: "judge-1",
      role: "monitor",
    };
    const args: DoneArgs = { status: "completed", summary: "Health OK" };

    const result = await dispatchDone(context, args, createCleanupStatus(), deps);

    expect(strategy.land).not.toHaveBeenCalled();
    expect(result.shouldTerminate).toBe(true);
  });
});

// =============================================================================
// Tests: Task Backend Claim/Unclaim Cycle
// =============================================================================

describe("Task Claim/Unclaim Cycle via MCP Tools", () => {
  function createMockTaskBackend(): TaskBackend {
    const tasks: ExtendedTask[] = [
      {
        id: "task-1",
        description: "Fix auth bug",
        status: "pending",
        created_at: Date.now() - 5000,
        tags: ["bugfix"],
        isBlocked: false,
      } as ExtendedTask,
      {
        id: "task-2",
        description: "Add feature X",
        status: "pending",
        created_at: Date.now() - 3000,
        tags: ["feature"],
        isBlocked: false,
      } as ExtendedTask,
      {
        id: "task-3",
        description: "Blocked task",
        status: "pending",
        created_at: Date.now() - 1000,
        tags: ["bugfix"],
        isBlocked: true,
      } as ExtendedTask,
    ];

    return {
      claim: vi.fn(async (agentId: string, filter?: ClaimFilter) => {
        const candidates = tasks.filter((t) => {
          if (t.status !== "pending" || t.isBlocked) return false;
          if (t.assigned_agent) return false;
          if (filter?.tags) {
            const taskTags = t.tags ?? [];
            if (!filter.tags.some((ft) => taskTags.includes(ft))) return false;
          }
          return true;
        });
        if (candidates.length === 0) return null;
        const claimed = candidates[0];
        claimed.status = "in_progress";
        claimed.assigned_agent = agentId;
        return claimed;
      }),
      unclaim: vi.fn(async (taskId: string) => {
        const task = tasks.find((t) => t.id === taskId);
        if (task) {
          task.status = "pending";
          task.assigned_agent = undefined;
        }
      }),
      listClaimable: vi.fn(async (filter?: ClaimFilter) => {
        return tasks.filter((t) => {
          if (t.status !== "pending" || t.isBlocked) return false;
          if (t.assigned_agent) return false;
          if (filter?.tags) {
            const taskTags = t.tags ?? [];
            if (!filter.tags.some((ft) => taskTags.includes(ft))) return false;
          }
          return true;
        });
      }),
    } as unknown as TaskBackend;
  }

  const toolContext: ToolContext = {
    agent_id: "grinder-1",
    session_id: "session-1",
  } as ToolContext;

  it("claim_task claims the first available task", async () => {
    const backend = createMockTaskBackend();
    const handler = createClaimTaskHandler(toolContext, { taskBackend: backend });

    const result = await handler({});

    expect(result.claimed).toBe(true);
    expect(result.task).toBeDefined();
    expect(result.task!.id).toBe("task-1");
    expect(backend.claim).toHaveBeenCalledWith("grinder-1", {});
  });

  it("claim_task filters by tags", async () => {
    const backend = createMockTaskBackend();
    const handler = createClaimTaskHandler(toolContext, { taskBackend: backend });

    const result = await handler({ tags: ["feature"] });

    expect(result.claimed).toBe(true);
    expect(result.task!.id).toBe("task-2");
  });

  it("claim_task returns not claimed when no tasks available", async () => {
    const backend = createMockTaskBackend();
    (backend.claim as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const handler = createClaimTaskHandler(toolContext, { taskBackend: backend });
    const result = await handler({});

    expect(result.claimed).toBe(false);
    expect(result.task).toBeUndefined();
  });

  it("unclaim_task returns task to pending pool", async () => {
    const backend = createMockTaskBackend();
    const unclaimHandler = createUnclaimTaskHandler(toolContext, {
      taskBackend: backend,
    });

    const result = await unclaimHandler({ task_id: "task-1" });

    expect(result.success).toBe(true);
    expect(backend.unclaim).toHaveBeenCalledWith("task-1");
  });

  it("list_claimable_tasks returns only claimable tasks", async () => {
    const backend = createMockTaskBackend();
    const listHandler = createListClaimableTasksHandler(toolContext, {
      taskBackend: backend,
    });

    const result = await listHandler({});

    expect(result.tasks.length).toBe(2); // task-3 is blocked
    expect(result.tasks.every((t: ExtendedTask) => !t.isBlocked)).toBe(true);
  });

  it("claim → unclaim → re-claim cycle works", async () => {
    const backend = createMockTaskBackend();
    const claimHandler = createClaimTaskHandler(toolContext, {
      taskBackend: backend,
    });
    const unclaimHandler = createUnclaimTaskHandler(toolContext, {
      taskBackend: backend,
    });

    // Claim task-1
    const claim1 = await claimHandler({});
    expect(claim1.claimed).toBe(true);
    expect(claim1.task!.id).toBe("task-1");

    // Unclaim task-1
    await unclaimHandler({ task_id: "task-1" });

    // Re-claim should get task-1 again (it's back to pending)
    const claim2 = await claimHandler({});
    expect(claim2.claimed).toBe(true);
    expect(claim2.task!.id).toBe("task-1");
  });

  it("claim_task fails gracefully when backend lacks claim support", async () => {
    const backend = {} as TaskBackend; // No claim method
    const handler = createClaimTaskHandler(toolContext, { taskBackend: backend });

    const result = await handler({});

    expect(result.claimed).toBe(false);
    expect(result.message).toContain("does not support");
  });
});

// =============================================================================
// Tests: Metrics ↔ Realistic EventStore Events
// =============================================================================

describe("Metrics ↔ EventStore Integration", () => {
  it("throughput metrics count task events correctly", () => {
    const events: Event[] = [];
    const now = Date.now();

    // Simulate task events
    events.push({
      id: "e1", type: "task", timestamp: now - 1000,
      source: { agent_id: "planner-1" },
      payload: { action: "created", task_id: "t1" },
    } as unknown as Event);
    events.push({
      id: "e2", type: "task", timestamp: now - 800,
      source: { agent_id: "planner-1" },
      payload: { action: "created", task_id: "t2" },
    } as unknown as Event);
    events.push({
      id: "e3", type: "task", timestamp: now - 500,
      source: { agent_id: "grinder-1" },
      payload: { action: "completed", task_id: "t1" },
    } as unknown as Event);
    events.push({
      id: "e4", type: "task", timestamp: now - 200,
      source: { agent_id: "grinder-2" },
      payload: { action: "failed", task_id: "t2" },
    } as unknown as Event);

    const store = createMockEventStore(events);

    const metrics = getThroughputMetrics(store, 60000);

    expect(metrics.tasksCreated).toBe(2);
    expect(metrics.tasksCompleted).toBe(1);
    expect(metrics.tasksFailed).toBe(1);
  });

  it("utilization metrics reflect active agents", () => {
    const events: Event[] = [];
    const now = Date.now();

    events.push({
      id: "e1", type: "spawn", timestamp: now - 5000,
      source: { agent_id: "system" },
      payload: { agent_id: "planner-1" },
    } as unknown as Event);
    events.push({
      id: "e2", type: "spawn", timestamp: now - 3000,
      source: { agent_id: "planner-1" },
      payload: { agent_id: "grinder-1" },
    } as unknown as Event);
    events.push({
      id: "e3", type: "stop", timestamp: now - 1000,
      source: { agent_id: "grinder-1" },
      payload: { reason: "completed" },
    } as unknown as Event);

    const agents: Agent[] = [
      { id: "planner-1", state: "running", role: "planner" } as unknown as Agent,
      { id: "grinder-1", state: "stopped", role: "grinder" } as unknown as Agent,
    ];

    const store = createMockEventStore(events);
    vi.mocked(store.listAgents).mockReturnValue(agents);

    const metrics = getUtilizationMetrics(store, 60000);

    expect(metrics.activeAgents).toBe(1);
    expect(metrics.totalSpawned).toBe(2);
    expect(metrics.totalStopped).toBe(1);
    expect(metrics.agentsByRole).toEqual({ planner: 1 });
    expect(metrics.agentsByState).toEqual({ running: 1, stopped: 1 });
  });

  it("error metrics capture both status and task failures", () => {
    const events: Event[] = [];
    const now = Date.now();

    events.push({
      id: "e1", type: "status", timestamp: now - 2000,
      source: { agent_id: "grinder-1" },
      payload: { status_type: "failed", summary: "OOM killed", details: { signal: "SIGKILL" } },
    } as unknown as Event);
    events.push({
      id: "e2", type: "status", timestamp: now - 1500,
      source: { agent_id: "grinder-2" },
      payload: { status_type: "completed", summary: "Done" }, // Not an error
    } as unknown as Event);
    events.push({
      id: "e3", type: "task", timestamp: now - 1000,
      source: { agent_id: "grinder-3" },
      payload: { action: "failed", task_id: "t5" },
    } as unknown as Event);

    const store = createMockEventStore(events);

    const metrics = getErrorMetrics(store, 60000, 10);

    expect(metrics.totalErrors).toBe(2);
    expect(metrics.errorsByType["SIGKILL"]).toBe(1);
    expect(metrics.errorsByType["task_failed"]).toBe(1);
    expect(metrics.recentErrors).toHaveLength(2);
    // Most recent first
    expect(metrics.recentErrors[0].type).toBe("task_failed");
    expect(metrics.recentErrors[1].type).toBe("SIGKILL");
  });

  it("metrics respect time window boundaries", () => {
    const events: Event[] = [];
    const now = Date.now();

    // Event inside 10-second window
    events.push({
      id: "e1", type: "task", timestamp: now - 5000,
      source: { agent_id: "a1" },
      payload: { action: "completed", task_id: "t1" },
    } as unknown as Event);
    // Event outside 10-second window
    events.push({
      id: "e2", type: "task", timestamp: now - 30000,
      source: { agent_id: "a1" },
      payload: { action: "completed", task_id: "t2" },
    } as unknown as Event);

    const store = createMockEventStore(events);

    const metrics = getThroughputMetrics(store, 10000);

    expect(metrics.tasksCompleted).toBe(1); // Only the recent one
  });
});

// =============================================================================
// Tests: Strategy Registry ↔ Team Config
// =============================================================================

describe("Strategy Registry ↔ Team Config", () => {
  it("strategy registry can instantiate all strategies referenced by templates", async () => {
    const roleRegistry = new DefaultRoleRegistry();

    // Load self-driving template
    const selfDriving = await loadTeam("self-driving", roleRegistry, PROJECT_ROOT);
    const sdStrategy = selfDriving.macro_agent.integration!.strategy;
    expect(defaultStrategyRegistry.has(sdStrategy)).toBe(true);

    // Load structured template
    const structured = await loadTeam("structured", roleRegistry, PROJECT_ROOT);
    const stStrategy = structured.macro_agent.integration!.strategy;
    expect(defaultStrategyRegistry.has(stStrategy)).toBe(true);

    // Instantiate each
    const trunkStrategy = defaultStrategyRegistry.get(sdStrategy, selfDriving.macro_agent.integration!.config);
    expect(trunkStrategy.name).toBe("trunk");

    const queueStrategy = defaultStrategyRegistry.get(stStrategy, structured.macro_agent.integration!.config);
    expect(queueStrategy.name).toBe("queue");
  });

  it("custom strategy can be registered and resolved", () => {
    defaultStrategyRegistry.register("custom-ci", (config) => ({
      name: "custom-ci",
      async land(request: LandRequest): Promise<LandResult> {
        return { status: "landed", commitHash: "custom-hash" };
      },
    }));

    expect(defaultStrategyRegistry.has("custom-ci")).toBe(true);
    const strategy = defaultStrategyRegistry.get("custom-ci");
    expect(strategy.name).toBe("custom-ci");
  });
});

// =============================================================================
// Tests: Role Capability ↔ Tool Gating
// =============================================================================

describe("Role Capability ↔ Tool Gating", () => {
  it("task.claim capability maps to all claim-related tools", () => {
    const tools = CAPABILITY_TOOL_MAP[TASK_CAPABILITIES.CLAIM as keyof typeof CAPABILITY_TOOL_MAP];
    expect(tools).toBeDefined();
    expect(tools).toContain("claim_task");
    expect(tools).toContain("unclaim_task");
    expect(tools).toContain("list_claimable_tasks");
  });

  it("self-driving grinder role has task.claim capability", async () => {
    const roleRegistry = new DefaultRoleRegistry();
    const manifest = await loadTeam("self-driving", roleRegistry, PROJECT_ROOT);

    const grinder = manifest._resolvedRoles.get("grinder");
    expect(grinder!.capabilities).toContain("task.claim");

    // Grinder inherits from worker — should still have worker capabilities
    expect(grinder!.capabilities).toContain("file.read");
    expect(grinder!.capabilities).toContain("file.write");
  });

  it("structured developer role does NOT have task.claim capability", async () => {
    const roleRegistry = new DefaultRoleRegistry();
    const manifest = await loadTeam("structured", roleRegistry, PROJECT_ROOT);

    const developer = manifest._resolvedRoles.get("developer");
    expect(developer!.capabilities).not.toContain("task.claim");
  });

  it("registered team roles are resolvable from RoleRegistry", async () => {
    const roleRegistry = new DefaultRoleRegistry();
    const eventStore = createMockEventStore();
    const messageRouter = createMockMessageRouter();
    let capturedInterceptor: SpawnInterceptor | null = null;
    const agentManager = {
      spawn: vi.fn().mockResolvedValue({ id: "agent_0" }),
      getRoleRegistry: () => roleRegistry,
      setSpawnInterceptor: vi.fn((i: SpawnInterceptor | null) => { capturedInterceptor = i; }),
      onLifecycleEvent: vi.fn(() => () => {}),
      getChildren: vi.fn().mockReturnValue([]),
    } as unknown as AgentManager;

    const manifest = await loadTeam("self-driving", roleRegistry, PROJECT_ROOT);
    const runtime = new TeamRuntime(manifest, {
      agentManager,
      messageRouter,
      eventStore,
    });

    await runtime.initialize();

    // After initialization, team roles should be in the registry
    const planner = roleRegistry.resolveRole("planner");
    expect(planner).toBeDefined();
    expect(planner.capabilities).toContain("task.claim");

    const grinder = roleRegistry.resolveRole("grinder");
    expect(grinder).toBeDefined();
    expect(grinder.capabilities).toContain("task.claim");
    expect(grinder.capabilities).toContain("git.push");
  });
});

// =============================================================================
// Tests: Team Config → Worker Done Pipeline (end-to-end wiring)
// =============================================================================

describe("Team Config → Worker Done Pipeline", () => {
  it("full pipeline: team config flows through handler registry to strategy", async () => {
    const messageRouter = createMockMessageRouter();
    const agentManager = {
      getChildren: vi.fn().mockReturnValue([]),
    } as unknown as AgentManager;
    const strategy = createMockStrategy("trunk");

    // Build deps as they would be wired from MCPServices → DoneToolDeps → AllHandlerDeps
    const allDeps: AllHandlerDeps = {
      messageRouter,
      agentManager,
      integrationStrategy: strategy,
      taskMode: "pull",
    };

    // Create registry (this is what createDoneHandler does internally)
    const registry = createHandlerRegistry(allDeps);

    // Dispatch as a "grinder" (extends worker)
    const context: LifecycleContext = {
      agentId: "grinder-42",
      role: "worker", // resolved base role
      taskId: "task-99",
      workspacePath: "/workspace/grinder-42",
      branch: "feature/task-99",
      integrationBranch: "main",
      streamId: "stream-main",
    };
    const args: DoneArgs = { status: "completed", summary: "Implemented task-99" };

    const result = await dispatchDone(
      context,
      args,
      createCleanupStatus(),
      allDeps,
      registry
    );

    // Strategy should have been called
    expect(strategy.land).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "grinder-42",
        taskId: "task-99",
        sourceBranch: "feature/task-99",
        targetBranch: "main",
      })
    );

    // Pull mode: should not terminate
    expect(result.shouldTerminate).toBe(false);

    // Integration signal emitted
    expect(result.signalsEmitted).toContain("WORKER_DONE");
    expect(result.signalsEmitted).toContain("WORKER_INTEGRATED");
  });

  it("no strategy and no queue: emits signal but warns about missing queue", async () => {
    const messageRouter = createMockMessageRouter();
    const agentManager = {
      getChildren: vi.fn().mockReturnValue([]),
    } as unknown as AgentManager;

    const allDeps: AllHandlerDeps = {
      messageRouter,
      agentManager,
      // No strategy, no mergeQueue
    };

    const context = createWorkerContext();
    const args: DoneArgs = { status: "completed" };

    const result = await dispatchDone(
      context,
      args,
      createCleanupStatus(),
      allDeps
    );

    expect(result.signalsEmitted).toContain("WORKER_DONE");
    expect(result.signalsEmitted).toContain("MERGE_REQUEST");
    // Should mention "no queue configured" in cleanup actions
    expect(result.cleanupActions?.some((a) => a.includes("no queue configured"))).toBe(true);
  });
});

// =============================================================================
// Tests: Communication Topology Validation
// =============================================================================

describe("Communication Topology Validation", () => {
  it("rejects templates with unknown role in subscriptions", async () => {
    // This tests the loader's validation — not a runtime test
    const roleRegistry = new DefaultRoleRegistry();

    // self-driving template is valid — should load without error
    const manifest = await loadTeam("self-driving", roleRegistry, PROJECT_ROOT);

    // Verify all subscription roles exist in the roles list
    for (const roleName of Object.keys(manifest.communication.subscriptions ?? {})) {
      expect(manifest.roles).toContain(roleName);
    }

    // Verify all emission roles exist in the roles list
    for (const roleName of Object.keys(manifest.communication.emissions ?? {})) {
      expect(manifest.roles).toContain(roleName);
    }

    // Verify all peer routing roles exist
    for (const peer of manifest.communication.routing?.peers ?? []) {
      expect(manifest.roles).toContain(peer.from);
      expect(manifest.roles).toContain(peer.to);
    }
  });

  it("all subscribed channels exist in channel definitions", async () => {
    const roleRegistry = new DefaultRoleRegistry();
    const manifest = await loadTeam("self-driving", roleRegistry, PROJECT_ROOT);

    const channelNames = new Set(Object.keys(manifest.communication.channels ?? {}));

    for (const [, subs] of Object.entries(manifest.communication.subscriptions ?? {})) {
      for (const sub of subs) {
        expect(channelNames.has(sub.channel)).toBe(true);
      }
    }
  });
});
