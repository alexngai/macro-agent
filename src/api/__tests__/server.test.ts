import { describe, it, expect, vi, beforeEach } from "vitest";
import supertest from "supertest";
import { createApiServer } from "../server.js";
import type { MacroAgentSystemV2 } from "../../boot-v2.js";

// =============================================================================
// Mock System
// =============================================================================

function createMockSystem(): MacroAgentSystemV2 {
  return {
    agentManager: {
      get: vi.fn(),
      list: vi.fn().mockReturnValue([]),
      getHierarchy: vi.fn(),
      getChildren: vi.fn().mockReturnValue([]),
      spawn: vi.fn(),
      terminate: vi.fn(),
      resume: vi.fn(),
      continueAgent: vi.fn(),
      forkAgent: vi.fn(),
      prompt: vi.fn(),
      promptUntilDone: vi.fn(),
      getSession: vi.fn(),
      hasActiveSession: vi.fn(),
      isPrompting: vi.fn(),
      supportsInjection: vi.fn(),
      isProcessRunning: vi.fn(),
      respondToPermission: vi.fn(),
      cancelPermission: vi.fn(),
      setPermissionMode: vi.fn(),
      getPermissionMode: vi.fn(),
      getOrCreateHeadManager: vi.fn(),
      listHeadManagers: vi.fn().mockReturnValue([]),
      onLifecycleEvent: vi.fn().mockReturnValue(() => {}),
      setSpawnInterceptor: vi.fn(),
      getRoleRegistry: vi.fn(),
      setOpenTasksSocketPath: vi.fn(),
      close: vi.fn(),
    } as any,
    agentStore: {
      listAgents: vi.fn().mockReturnValue([]),
      getAgent: vi.fn(),
    } as any,
    inboxAdapter: {
      checkInbox: vi.fn().mockResolvedValue([]),
    } as any,
    tasksAdapter: {
      listTasks: vi.fn().mockResolvedValue([]),
      queryReady: vi.fn().mockResolvedValue([]),
      connected: true,
    } as any,
    controlServer: {
      getUnhealthyAgents: vi.fn().mockReturnValue([]),
    } as any,
    triggerSystem: {
      queue: {
        getAgentsWithEvents: vi.fn().mockReturnValue([]),
      },
    } as any,
    roleRegistry: {} as any,
    controlSocketPath: "/tmp/test-control.sock",
    shutdown: vi.fn(),
  };
}

// =============================================================================
// Tests
// =============================================================================

describe("API Server", () => {
  let system: MacroAgentSystemV2;
  let request: supertest.SuperTest<supertest.Test>;

  beforeEach(() => {
    system = createMockSystem();
    const server = createApiServer(system, { port: 0 });
    request = supertest(server.app) as any;
  });

  // ── Health ───────────────────────────────────────────────────────

  it("GET /api/health returns 200 with ok: true", async () => {
    const res = await request.get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.version).toBe("0.1.1");
    expect(typeof res.body.uptime).toBe("number");
  });

  // ── Agents ──────────────────────────────────────────────────────

  it("GET /api/agents returns agent list", async () => {
    const mockAgents = [
      { id: "a1", role: "worker", state: "running", task: "do stuff" },
      { id: "a2", role: "coordinator", state: "running", task: "manage" },
    ];
    (system.agentManager.list as any).mockReturnValue(mockAgents);

    const res = await request.get("/api/agents");
    expect(res.status).toBe(200);
    expect(res.body.agents).toHaveLength(2);
    expect(res.body.total).toBe(2);
  });

  it("GET /api/agents with state filter", async () => {
    const mockAgents = [
      { id: "a1", role: "worker", state: "running", task: "do stuff" },
    ];
    (system.agentManager.list as any).mockReturnValue(mockAgents);

    const res = await request.get("/api/agents?state=running");
    expect(res.status).toBe(200);
    expect((system.agentManager.list as any)).toHaveBeenCalledWith(
      expect.objectContaining({ state: "running" })
    );
    expect(res.body.agents).toHaveLength(1);
  });

  it("GET /api/agents/:id returns agent", async () => {
    const mockAgent = {
      id: "a1",
      role: "worker",
      state: "running",
      task: "do stuff",
    };
    (system.agentManager.get as any).mockReturnValue(mockAgent);

    const res = await request.get("/api/agents/a1");
    expect(res.status).toBe(200);
    expect(res.body.id).toBe("a1");
  });

  it("GET /api/agents/:id returns 404 for missing", async () => {
    (system.agentManager.get as any).mockReturnValue(null);

    const res = await request.get("/api/agents/nonexistent");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Agent not found");
  });

  it("GET /api/agents/:id/hierarchy returns tree", async () => {
    const mockHierarchy = {
      root: {
        agent: { id: "a1", role: "coordinator" },
        children: [
          { agent: { id: "a2", role: "worker" }, children: [] },
        ],
      },
      depth: 2,
      totalAgents: 2,
    };
    (system.agentManager.getHierarchy as any).mockReturnValue(mockHierarchy);

    const res = await request.get("/api/agents/a1/hierarchy");
    expect(res.status).toBe(200);
    expect(res.body.root.agent.id).toBe("a1");
    expect(res.body.totalAgents).toBe(2);
  });

  it("GET /api/agents/:id/hierarchy returns 404 for missing", async () => {
    (system.agentManager.getHierarchy as any).mockReturnValue(null);

    const res = await request.get("/api/agents/nonexistent/hierarchy");
    expect(res.status).toBe(404);
  });

  // ── Spawn / Delete ──────────────────────────────────────────────

  it("POST /api/agents spawns agent", async () => {
    const mockSpawned = { id: "a-new", session_id: "s1" };
    (system.agentManager.spawn as any).mockResolvedValue(mockSpawned);

    const res = await request
      .post("/api/agents")
      .send({ task: "build feature X", role: "worker" });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe("a-new");
    expect((system.agentManager.spawn as any)).toHaveBeenCalledWith(
      expect.objectContaining({ task: "build feature X", role: "worker" })
    );
  });

  it("POST /api/agents returns 400 when task is missing", async () => {
    const res = await request.post("/api/agents").send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("task");
  });

  it("DELETE /api/agents/:id terminates", async () => {
    (system.agentManager.get as any).mockReturnValue({
      id: "a1",
      state: "running",
    });
    (system.agentManager.terminate as any).mockResolvedValue(undefined);

    const res = await request.delete("/api/agents/a1?reason=cancelled");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect((system.agentManager.terminate as any)).toHaveBeenCalledWith(
      "a1",
      "cancelled"
    );
  });

  it("DELETE /api/agents/:id returns 404 for missing", async () => {
    (system.agentManager.get as any).mockReturnValue(null);

    const res = await request.delete("/api/agents/nonexistent");
    expect(res.status).toBe(404);
  });

  // ── Tasks ───────────────────────────────────────────────────────

  it("GET /api/tasks returns tasks", async () => {
    const mockTasks = [
      { id: "t1", title: "Task 1", status: "open" },
      { id: "t2", title: "Task 2", status: "in_progress" },
    ];
    (system.tasksAdapter.listTasks as any).mockResolvedValue(mockTasks);

    const res = await request.get("/api/tasks");
    expect(res.status).toBe(200);
    expect(res.body.tasks).toHaveLength(2);
  });

  it("GET /api/tasks/ready returns ready tasks", async () => {
    const mockTasks = [{ id: "t1", title: "Ready Task", status: "open" }];
    (system.tasksAdapter.queryReady as any).mockResolvedValue(mockTasks);

    const res = await request.get("/api/tasks/ready");
    expect(res.status).toBe(200);
    expect(res.body.tasks).toHaveLength(1);
  });

  // ── Metrics ─────────────────────────────────────────────────────

  it("GET /api/metrics returns snapshot", async () => {
    (system.agentStore.listAgents as any).mockReturnValue([
      { state: "running", role: "worker", team: "alpha" },
      { state: "stopped", role: "coordinator", team: "alpha" },
    ]);
    (system.tasksAdapter.listTasks as any).mockResolvedValue([
      { status: "open" },
      { status: "closed" },
    ]);

    const res = await request.get("/api/metrics");
    expect(res.status).toBe(200);
    expect(res.body.agents).toBeDefined();
    expect(res.body.agents.running).toBe(1);
    expect(res.body.agents.stopped).toBe(1);
    expect(typeof res.body.uptime).toBe("number");
  });

  it("GET /api/metrics/agents returns agent metrics", async () => {
    (system.agentStore.listAgents as any).mockReturnValue([
      { state: "running" },
      { state: "running" },
      { state: "failed" },
    ]);

    const res = await request.get("/api/metrics/agents");
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    expect(res.body.running).toBe(2);
    expect(res.body.failed).toBe(1);
  });

  // ── Teams ───────────────────────────────────────────────────────

  it("GET /api/teams returns team grouping", async () => {
    (system.agentStore.listAgents as any).mockReturnValue([
      { team: "alpha", role: "worker" },
      { team: "alpha", role: "coordinator" },
      { team: "beta", role: "worker" },
    ]);

    const res = await request.get("/api/teams");
    expect(res.status).toBe(200);
    expect(res.body.teams).toHaveLength(2);

    const alpha = res.body.teams.find(
      (t: any) => t.name === "alpha"
    );
    expect(alpha).toBeDefined();
    expect(alpha.agentCount).toBe(2);
    expect(alpha.roles).toContain("worker");
    expect(alpha.roles).toContain("coordinator");
  });
});
