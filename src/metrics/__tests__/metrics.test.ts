import { describe, it, expect, vi } from "vitest";
import { collectMetrics } from "../metrics.js";
import type { MacroAgentSystemV2 } from "../../boot-v2.js";
import type { AgentRecord } from "../../agent/agent-store.js";

// ─────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────

function makeAgent(
  overrides: Partial<AgentRecord> & { id: string; role: string; state: string }
): AgentRecord {
  return {
    parent_id: null,
    lineage: [],
    scope: "default",
    task: "test",
    cwd: "/tmp",
    capabilities: [],
    created_at: Date.now(),
    ...overrides,
  } as AgentRecord;
}

function createMockSystem(
  overrides: {
    agents?: AgentRecord[];
    unhealthy?: Array<{ agentId: string; lastSeen: number; pid: number }>;
    tasksConnected?: boolean;
    tasks?: Array<{ id: string; status: string }>;
    readyTasks?: Array<{ id: string; status: string }>;
    agentsWithEvents?: string[];
    cronJobs?: unknown[];
  } = {}
): MacroAgentSystemV2 {
  const {
    agents = [],
    unhealthy = [],
    tasksConnected = false,
    tasks = [],
    readyTasks = [],
    agentsWithEvents = [],
    cronJobs = [],
  } = overrides;

  return {
    agentManager: {} as any,
    agentStore: {
      listAgents: vi.fn().mockReturnValue(agents),
    } as any,
    inboxAdapter: {} as any,
    tasksAdapter: {
      connected: tasksConnected,
      listTasks: vi.fn().mockResolvedValue(tasks),
      queryReady: vi.fn().mockResolvedValue(readyTasks),
    } as any,
    triggerSystem: {
      queue: {
        getAgentsWithEvents: vi.fn().mockReturnValue(agentsWithEvents),
      },
      cronService: {
        list: vi.fn().mockResolvedValue(cronJobs),
      },
    } as any,
    controlServer: {
      getUnhealthyAgents: vi.fn().mockReturnValue(unhealthy),
    } as any,
    roleRegistry: {} as any,
    controlSocketPath: "/tmp/control.sock",
    shutdown: vi.fn(),
  };
}

// ─────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────

describe("collectMetrics", () => {
  const START_TIME = Date.now() - 10_000; // 10s ago

  it("returns correct agent counts by state", async () => {
    const system = createMockSystem({
      agents: [
        makeAgent({ id: "a1", role: "worker", state: "running" }),
        makeAgent({ id: "a2", role: "worker", state: "running" }),
        makeAgent({ id: "a3", role: "worker", state: "running" }),
        makeAgent({ id: "a4", role: "coordinator", state: "stopped" }),
        makeAgent({ id: "a5", role: "coordinator", state: "stopped" }),
      ],
    });

    const snapshot = await collectMetrics(system, START_TIME);

    expect(snapshot.agents.total).toBe(5);
    expect(snapshot.agents.byState).toEqual({
      running: 3,
      stopped: 2,
    });
  });

  it("returns correct agent counts by role", async () => {
    const system = createMockSystem({
      agents: [
        makeAgent({ id: "a1", role: "worker", state: "running" }),
        makeAgent({ id: "a2", role: "worker", state: "running" }),
        makeAgent({ id: "a3", role: "coordinator", state: "running" }),
      ],
    });

    const snapshot = await collectMetrics(system, START_TIME);

    expect(snapshot.agents.byRole).toEqual({
      worker: 2,
      coordinator: 1,
    });
  });

  it("returns correct agent counts by team", async () => {
    const system = createMockSystem({
      agents: [
        makeAgent({ id: "a1", role: "worker", state: "running", team: "alpha" }),
        makeAgent({ id: "a2", role: "worker", state: "running", team: "alpha" }),
        makeAgent({ id: "a3", role: "worker", state: "running", team: "beta" }),
        makeAgent({ id: "a4", role: "coordinator", state: "running" }), // no team
      ],
    });

    const snapshot = await collectMetrics(system, START_TIME);

    expect(snapshot.agents.byTeam).toEqual({
      alpha: 2,
      beta: 1,
    });
  });

  it("returns unhealthy count from control server", async () => {
    const system = createMockSystem({
      agents: [
        makeAgent({ id: "a1", role: "worker", state: "running" }),
      ],
      unhealthy: [
        { agentId: "a1", lastSeen: Date.now() - 120_000, pid: 1234 },
        { agentId: "a2", lastSeen: Date.now() - 90_000, pid: 5678 },
      ],
    });

    const snapshot = await collectMetrics(system, START_TIME);

    expect(snapshot.agents.unhealthy).toBe(2);
  });

  it("returns task metrics when opentasks is available", async () => {
    const system = createMockSystem({
      tasksConnected: true,
      tasks: [
        { id: "t1", status: "open" },
        { id: "t2", status: "open" },
        { id: "t3", status: "in_progress" },
        { id: "t4", status: "blocked" },
        { id: "t5", status: "closed" },
      ],
      readyTasks: [
        { id: "t1", status: "open" },
        { id: "t2", status: "open" },
      ],
    });

    const snapshot = await collectMetrics(system, START_TIME);

    expect(snapshot.tasks).not.toBeNull();
    expect(snapshot.tasks!.byStatus).toEqual({
      open: 2,
      in_progress: 1,
      blocked: 1,
      closed: 1,
    });
    expect(snapshot.tasks!.ready).toBe(2);
    expect(snapshot.tasks!.blocked).toBe(1);
  });

  it("returns tasks: null when opentasks is unavailable", async () => {
    const system = createMockSystem({
      tasksConnected: false,
    });

    const snapshot = await collectMetrics(system, START_TIME);

    expect(snapshot.tasks).toBeNull();
  });

  it("returns system uptime and queue depth", async () => {
    const system = createMockSystem({
      agentsWithEvents: ["a1", "a2", "a3"],
      cronJobs: [{}, {}, {}], // 3 cron jobs
    });

    const snapshot = await collectMetrics(system, START_TIME);

    // Uptime should be approximately 10_000ms (with some tolerance)
    expect(snapshot.system.uptime).toBeGreaterThanOrEqual(9_900);
    expect(snapshot.system.uptime).toBeLessThan(15_000);
    expect(snapshot.system.triggerQueueDepth).toBe(3);
    expect(snapshot.system.cronJobCount).toBe(3);
  });
});
