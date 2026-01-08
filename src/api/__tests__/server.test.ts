/**
 * API Server tests
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import request from "supertest";
import { createAPIServer, type APIServices } from "../server.js";
import type { EventStore } from "../../store/event-store.js";
import type { AgentManager } from "../../agent/agent-manager.js";
import type { TaskManager } from "../../task/task-manager.js";
import type { MessageRouter } from "../../router/message-router.js";
import type { Agent, Task, Event } from "../../store/types/index.js";

// ─────────────────────────────────────────────────────────────────
// Mock Factories
// ─────────────────────────────────────────────────────────────────

function createMockAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent_test123",
    session_id: "sess_test123",
    parent: null,
    lineage: [],
    state: "running",
    task: "Test task",
    task_id: "task_test123",
    config: {},
    cwd: "/test/working/dir",
    created_at: Date.now(),
    started_at: Date.now(),
    ...overrides,
  };
}

function createMockTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task_test123",
    description: "Test task",
    status: "pending",
    created_at: Date.now(),
    created_by: "agent_test123",
    ...overrides,
  };
}

function createMockEvent(overrides: Partial<Event> = {}): Event {
  return {
    id: "evt_test123",
    version: 1,
    timestamp: Date.now(),
    type: "status",
    source: { agent_id: "agent_test123" },
    payload: { status_type: "started", summary: "Test" },
    ...overrides,
  };
}

function createMockEventStore(): EventStore {
  return {
    emit: vi.fn((input) => ({
      id: `evt_${Date.now()}`,
      version: 1,
      timestamp: Date.now(),
      ...input,
    })),
    query: vi.fn(() => []),
    getAgent: vi.fn(() => null),
    listAgents: vi.fn(() => []),
    getTask: vi.fn(() => null),
    listTasks: vi.fn(() => []),
    getMessages: vi.fn(() => []),
    getFullMessage: vi.fn(() => null),
    addSubscription: vi.fn(),
    removeSubscription: vi.fn(),
    getSubscriptions: vi.fn(() => []),
    getSubscribers: vi.fn(() => []),
    onAgentChange: vi.fn(() => () => {}),
    onTaskChange: vi.fn(() => () => {}),
    onMessageChange: vi.fn(() => () => {}),
    persist: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
}

function createMockAgentManager(): AgentManager {
  return {
    spawn: vi.fn(async () => ({
      id: "agent_spawned123",
      session_id: "sess_spawned123",
      agent: createMockAgent({ id: "agent_spawned123" }),
      session: {} as any,
    })),
    terminate: vi.fn(async () => {}),
    resume: vi.fn(async () => ({} as any)),
    get: vi.fn(() => null),
    list: vi.fn(() => []),
    getChildren: vi.fn(() => []),
    getHierarchy: vi.fn(() => null),
    getOrCreateHeadManager: vi.fn(async () => ({
      id: "agent_head123",
      session_id: "sess_head123",
      agent: createMockAgent({ id: "agent_head123" }),
      session: {} as any,
    })),
    listHeadManagers: vi.fn(() => []),
    prompt: vi.fn(async function* () {}),
    getSession: vi.fn(() => null),
    hasActiveSession: vi.fn(() => false),
    onLifecycleEvent: vi.fn(() => () => {}),
    close: vi.fn(async () => {}),
  };
}

function createMockTaskManager(): TaskManager {
  return {
    create: vi.fn((options) => createMockTask({ description: options.description })),
    createSubtask: vi.fn(),
    get: vi.fn(() => null),
    list: vi.fn(() => []),
    getSubtasks: vi.fn(() => []),
    getSubtaskStatus: vi.fn(() => ({
      total: 0,
      pending: 0,
      assigned: 0,
      in_progress: 0,
      completed: 0,
      failed: 0,
      allCompleted: false,
      anyFailed: false,
    })),
    assign: vi.fn(),
    unassign: vi.fn(),
    updateStatus: vi.fn(),
    update: vi.fn(),
  };
}

function createMockMessageRouter(): MessageRouter {
  return {
    send: vi.fn(),
    emitStatus: vi.fn(),
    getMessages: vi.fn(() => []),
    getFullMessage: vi.fn(() => null),
    acknowledgeMessage: vi.fn(),
    acknowledgeMessages: vi.fn(),
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    getSubscriptions: vi.fn(() => []),
    getSubscribers: vi.fn(() => []),
    setupDefaultSubscriptions: vi.fn(),
  };
}

// ─────────────────────────────────────────────────────────────────
// Test Suite
// ─────────────────────────────────────────────────────────────────

describe("API Server", () => {
  let eventStore: EventStore;
  let agentManager: AgentManager;
  let taskManager: TaskManager;
  let messageRouter: MessageRouter;
  let services: APIServices;

  beforeEach(() => {
    eventStore = createMockEventStore();
    agentManager = createMockAgentManager();
    taskManager = createMockTaskManager();
    messageRouter = createMockMessageRouter();
    services = { eventStore, agentManager, taskManager, messageRouter };
  });

  describe("createAPIServer", () => {
    it("should create a server instance", () => {
      const server = createAPIServer(services);
      expect(server).toBeDefined();
      expect(server.app).toBeDefined();
      expect(server.server).toBeDefined();
      expect(server.wss).toBeDefined();
    });
  });

  describe("GET /api/status", () => {
    it("should return system status", async () => {
      (agentManager.list as ReturnType<typeof vi.fn>).mockReturnValue([
        createMockAgent({ state: "running" }),
        createMockAgent({ id: "agent_2", state: "stopped" }),
      ]);
      (taskManager.list as ReturnType<typeof vi.fn>).mockReturnValue([
        createMockTask({ status: "pending" }),
        createMockTask({ id: "task_2", status: "completed" }),
      ]);

      const server = createAPIServer(services);
      const res = await request(server.app).get("/api/status");

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        initialized: false,
        agents: {
          total: 2,
          running: 1,
          stopped: 1,
        },
        tasks: {
          total: 2,
          pending: 1,
          completed: 1,
        },
      });
    });
  });

  describe("POST /api/init", () => {
    it("should initialize the system", async () => {
      const server = createAPIServer(services);
      const res = await request(server.app)
        .post("/api/init")
        .send({ cwd: "/tmp" });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        success: true,
        head_manager_id: "agent_head123",
        session_id: "sess_head123",
      });
      expect(agentManager.getOrCreateHeadManager).toHaveBeenCalled();
    });

    it("should reject double initialization", async () => {
      const server = createAPIServer(services);

      // First init
      await request(server.app).post("/api/init").send({});

      // Second init should fail
      const res = await request(server.app).post("/api/init").send({});

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("ALREADY_INITIALIZED");
    });
  });

  describe("GET /api/agents", () => {
    it("should list all agents", async () => {
      const agents = [
        createMockAgent({ id: "agent_1" }),
        createMockAgent({ id: "agent_2" }),
      ];
      (agentManager.list as ReturnType<typeof vi.fn>).mockReturnValue(agents);
      (agentManager.getChildren as ReturnType<typeof vi.fn>).mockReturnValue([]);

      const server = createAPIServer(services);
      const res = await request(server.app).get("/api/agents");

      expect(res.status).toBe(200);
      expect(res.body.agents).toHaveLength(2);
      expect(res.body.total).toBe(2);
    });

    it("should filter agents by state", async () => {
      const agents = [
        createMockAgent({ id: "agent_1", state: "running" }),
        createMockAgent({ id: "agent_2", state: "stopped" }),
      ];
      (agentManager.list as ReturnType<typeof vi.fn>).mockReturnValue(agents);
      (agentManager.getChildren as ReturnType<typeof vi.fn>).mockReturnValue([]);

      const server = createAPIServer(services);
      const res = await request(server.app).get("/api/agents?state=running");

      expect(res.status).toBe(200);
      expect(res.body.agents).toHaveLength(1);
      expect(res.body.agents[0].id).toBe("agent_1");
    });
  });

  describe("GET /api/agents/:id", () => {
    it("should return agent details", async () => {
      const agent = createMockAgent({ id: "agent_detail123" });
      (agentManager.get as ReturnType<typeof vi.fn>).mockReturnValue(agent);
      (agentManager.getChildren as ReturnType<typeof vi.fn>).mockReturnValue([]);

      const server = createAPIServer(services);
      const res = await request(server.app).get("/api/agents/agent_detail123");

      expect(res.status).toBe(200);
      expect(res.body.id).toBe("agent_detail123");
    });

    it("should return 404 for non-existent agent", async () => {
      (agentManager.get as ReturnType<typeof vi.fn>).mockReturnValue(null);

      const server = createAPIServer(services);
      const res = await request(server.app).get("/api/agents/nonexistent");

      expect(res.status).toBe(404);
      expect(res.body.code).toBe("AGENT_NOT_FOUND");
    });
  });

  describe("GET /api/agents/:id/hierarchy", () => {
    it("should return agent hierarchy", async () => {
      const agent = createMockAgent({ id: "agent_root" });
      (agentManager.get as ReturnType<typeof vi.fn>).mockReturnValue(agent);
      (agentManager.getHierarchy as ReturnType<typeof vi.fn>).mockReturnValue({
        root: { agent, children: [] },
        depth: 1,
        totalAgents: 1,
      });
      (agentManager.getChildren as ReturnType<typeof vi.fn>).mockReturnValue([]);

      const server = createAPIServer(services);
      const res = await request(server.app).get("/api/agents/agent_root/hierarchy");

      expect(res.status).toBe(200);
      expect(res.body.tree).toBeDefined();
      expect(res.body.depth).toBe(1);
      expect(res.body.total_agents).toBe(1);
    });
  });

  describe("GET /api/tasks", () => {
    it("should list all tasks", async () => {
      const tasks = [
        createMockTask({ id: "task_1" }),
        createMockTask({ id: "task_2" }),
      ];
      (taskManager.list as ReturnType<typeof vi.fn>).mockReturnValue(tasks);

      const server = createAPIServer(services);
      const res = await request(server.app).get("/api/tasks");

      expect(res.status).toBe(200);
      expect(res.body.tasks).toHaveLength(2);
      expect(res.body.total).toBe(2);
    });

    it("should filter tasks by status", async () => {
      const tasks = [
        createMockTask({ id: "task_1", status: "pending" }),
        createMockTask({ id: "task_2", status: "completed" }),
      ];
      (taskManager.list as ReturnType<typeof vi.fn>).mockReturnValue(tasks);

      const server = createAPIServer(services);
      const res = await request(server.app).get("/api/tasks?status=completed");

      expect(res.status).toBe(200);
      expect(res.body.tasks).toHaveLength(1);
      expect(res.body.tasks[0].id).toBe("task_2");
    });
  });

  describe("GET /api/tasks/:id", () => {
    it("should return task details", async () => {
      const task = createMockTask({ id: "task_detail123" });
      (taskManager.get as ReturnType<typeof vi.fn>).mockReturnValue(task);

      const server = createAPIServer(services);
      const res = await request(server.app).get("/api/tasks/task_detail123");

      expect(res.status).toBe(200);
      expect(res.body.id).toBe("task_detail123");
    });

    it("should return 404 for non-existent task", async () => {
      (taskManager.get as ReturnType<typeof vi.fn>).mockReturnValue(null);

      const server = createAPIServer(services);
      const res = await request(server.app).get("/api/tasks/nonexistent");

      expect(res.status).toBe(404);
      expect(res.body.code).toBe("TASK_NOT_FOUND");
    });
  });

  describe("GET /api/events", () => {
    it("should list events", async () => {
      const events = [
        createMockEvent({ id: "evt_1" }),
        createMockEvent({ id: "evt_2" }),
      ];
      (eventStore.query as ReturnType<typeof vi.fn>).mockReturnValue(events);

      const server = createAPIServer(services);
      const res = await request(server.app).get("/api/events");

      expect(res.status).toBe(200);
      expect(res.body.events).toHaveLength(2);
      expect(res.body.has_more).toBe(false);
    });

    it("should indicate has_more when more events exist", async () => {
      const events = Array.from({ length: 51 }, (_, i) =>
        createMockEvent({ id: `evt_${i}` })
      );
      (eventStore.query as ReturnType<typeof vi.fn>).mockReturnValue(events);

      const server = createAPIServer(services);
      const res = await request(server.app).get("/api/events");

      expect(res.status).toBe(200);
      expect(res.body.events).toHaveLength(50);
      expect(res.body.has_more).toBe(true);
    });
  });

  describe("POST /api/conversation/message", () => {
    it("should require initialization", async () => {
      const server = createAPIServer(services);
      const res = await request(server.app)
        .post("/api/conversation/message")
        .send({ message: "Hello" });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("NOT_INITIALIZED");
    });

    it("should require message field", async () => {
      const server = createAPIServer(services);

      // Initialize first
      await request(server.app).post("/api/init").send({});

      // Send without message
      const res = await request(server.app)
        .post("/api/conversation/message")
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("MISSING_MESSAGE");
    });
  });

  describe("GET /api/conversation/history", () => {
    it("should return empty history initially", async () => {
      const server = createAPIServer(services);
      const res = await request(server.app).get("/api/conversation/history");

      expect(res.status).toBe(200);
      expect(res.body.history).toHaveLength(0);
      expect(res.body.total).toBe(0);
    });
  });

  describe("Graceful Shutdown", () => {
    it("should call eventStore.persist and close on graceful shutdown", async () => {
      const server = createAPIServer(services);
      await server.start();
      await server.stop();

      expect(eventStore.persist).toHaveBeenCalled();
      expect(eventStore.close).toHaveBeenCalled();
      expect(agentManager.close).toHaveBeenCalled();
    });

    it("should skip grace period on force shutdown", async () => {
      const server = createAPIServer(services, { shutdownGracePeriodMs: 5000 });
      await server.start();

      const startTime = Date.now();
      await server.stop({ force: true });
      const elapsed = Date.now() - startTime;

      // Force shutdown should complete quickly (well under grace period)
      expect(elapsed).toBeLessThan(1000);
      expect(eventStore.persist).toHaveBeenCalled();
      expect(eventStore.close).toHaveBeenCalled();
    });

    it("should reject new messages during shutdown", async () => {
      const server = createAPIServer(services);
      await server.start();

      // Initialize first
      await request(server.app).post("/api/init").send({});

      // Start shutdown but don't await it yet
      const stopPromise = server.stop();

      // Try to send a message during shutdown
      const res = await request(server.app)
        .post("/api/conversation/message")
        .send({ message: "Hello" });

      expect(res.status).toBe(503);
      expect(res.body.code).toBe("SHUTTING_DOWN");

      await stopPromise;
    });

    it("should have registerSignalHandlers method", () => {
      const server = createAPIServer(services);
      expect(typeof server.registerSignalHandlers).toBe("function");
    });

    it("should only shutdown once on multiple stop calls", async () => {
      const server = createAPIServer(services);
      await server.start();

      // Call stop twice concurrently
      await Promise.all([server.stop(), server.stop()]);

      // Services should only be closed once
      expect(eventStore.close).toHaveBeenCalledTimes(1);
      expect(agentManager.close).toHaveBeenCalledTimes(1);
    });

    it("should use custom shutdown grace period", async () => {
      const customGracePeriod = 100;
      const server = createAPIServer(services, {
        shutdownGracePeriodMs: customGracePeriod,
      });
      await server.start();
      await server.stop();

      expect(eventStore.persist).toHaveBeenCalled();
    });
  });
});
