/**
 * API Server tests
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import request from "supertest";
import { createAPIServer, type APIServer, type APIServices } from "../server.js";
import type { EventStore } from "../../store/event-store.js";
import type { AgentManager } from "../../agent/agent-manager.js";
import type { TaskManager } from "../../task/task-manager.js";
import type { MessageRouter } from "../../router/message-router.js";
import type { TeamManager, TeamInstance } from "../../teams/team-manager.js";
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
    isPrompting: vi.fn(() => false),
    supportsInjection: vi.fn(async () => false),
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
    sendToAddress: vi.fn(),
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

function createMockTeamInstance(overrides: Partial<TeamInstance> = {}): TeamInstance {
  return {
    id: "test-team-1",
    templateName: "test-team",
    runtime: {
      getTaskMode: vi.fn(() => "push"),
      getStrategyName: vi.fn(() => "queue"),
      getManifest: vi.fn(() => ({
        roles: [{ name: "worker", extends: "worker" }],
        communication: { channels: [] },
      })),
    } as any,
    result: {
      rootId: "agent_root1",
      companionIds: ["agent_comp1"],
    },
    ...overrides,
  };
}

function createMockTeamManager(): TeamManager {
  const instance = createMockTeamInstance();
  return {
    startTeam: vi.fn(async () => instance),
    stopTeam: vi.fn(async () => {}),
    teardownAll: vi.fn(async () => {}),
    getTeamForAgent: vi.fn(() => undefined),
    getInstance: vi.fn((id: string) => (id === instance.id ? instance : undefined)),
    getInstances: vi.fn(() => [instance]),
    hasActiveTeam: vi.fn(() => true),
    install: vi.fn(),
    uninstall: vi.fn(),
  } as unknown as TeamManager;
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

  // Track servers created during tests for cleanup
  let createdServers: APIServer[] = [];

  // Helper to create and track servers
  function createTrackedServer(svc: APIServices = services, config?: Parameters<typeof createAPIServer>[1]): APIServer {
    const server = createAPIServer(svc, config);
    createdServers.push(server);
    return server;
  }

  beforeEach(() => {
    eventStore = createMockEventStore();
    agentManager = createMockAgentManager();
    taskManager = createMockTaskManager();
    messageRouter = createMockMessageRouter();
    services = { eventStore, agentManager, taskManager, messageRouter };
    createdServers = [];
  });

  afterEach(async () => {
    // Close all servers created during the test
    // We close the HTTP server and WebSocket connections directly rather than
    // calling stop() to avoid interacting with mock services in cleanup
    for (const server of createdServers) {
      try {
        // Close WebSocket connections
        for (const client of server.wss.clients) {
          client.terminate();
        }
        server.wss.close();

        // Close HTTP server
        await new Promise<void>((resolve) => {
          server.server.close(() => resolve());
          // Force resolve if server wasn't listening
          setTimeout(resolve, 100);
        });
      } catch {
        // Ignore errors during cleanup
      }
    }
    createdServers = [];
  });

  describe("createAPIServer", () => {
    it("should create a server instance", () => {
      const server = createTrackedServer();
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

      const server = createTrackedServer();
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
      const server = createTrackedServer();
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
      const server = createTrackedServer();

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

      const server = createTrackedServer();
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

      const server = createTrackedServer();
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

      const server = createTrackedServer();
      const res = await request(server.app).get("/api/agents/agent_detail123");

      expect(res.status).toBe(200);
      expect(res.body.id).toBe("agent_detail123");
    });

    it("should return 404 for non-existent agent", async () => {
      (agentManager.get as ReturnType<typeof vi.fn>).mockReturnValue(null);

      const server = createTrackedServer();
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

      const server = createTrackedServer();
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

      const server = createTrackedServer();
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

      const server = createTrackedServer();
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

      const server = createTrackedServer();
      const res = await request(server.app).get("/api/tasks/task_detail123");

      expect(res.status).toBe(200);
      expect(res.body.id).toBe("task_detail123");
    });

    it("should return 404 for non-existent task", async () => {
      (taskManager.get as ReturnType<typeof vi.fn>).mockReturnValue(null);

      const server = createTrackedServer();
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

      const server = createTrackedServer();
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

      const server = createTrackedServer();
      const res = await request(server.app).get("/api/events");

      expect(res.status).toBe(200);
      expect(res.body.events).toHaveLength(50);
      expect(res.body.has_more).toBe(true);
    });
  });

  describe("POST /api/conversation/message", () => {
    it("should require initialization", async () => {
      const server = createTrackedServer();
      const res = await request(server.app)
        .post("/api/conversation/message")
        .send({ message: "Hello" });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("NOT_INITIALIZED");
    });

    it("should require message field", async () => {
      const server = createTrackedServer();

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
      const server = createTrackedServer();
      const res = await request(server.app).get("/api/conversation/history");

      expect(res.status).toBe(200);
      expect(res.body.history).toHaveLength(0);
      expect(res.body.total).toBe(0);
    });
  });

  describe("Graceful Shutdown", () => {
    it("should call eventStore.persist and close on graceful shutdown", async () => {
      const server = createTrackedServer();
      await server.start();
      await server.stop();

      expect(eventStore.persist).toHaveBeenCalled();
      expect(eventStore.close).toHaveBeenCalled();
      expect(agentManager.close).toHaveBeenCalled();
    });

    it("should skip grace period on force shutdown", async () => {
      const server = createTrackedServer(services, { shutdownGracePeriodMs: 5000 });
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
      const server = createTrackedServer();
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
      const server = createTrackedServer();
      expect(typeof server.registerSignalHandlers).toBe("function");
    });

    it("should only shutdown once on multiple stop calls", async () => {
      const server = createTrackedServer();
      await server.start();

      // Call stop twice concurrently
      await Promise.all([server.stop(), server.stop()]);

      // Services should only be closed once
      expect(eventStore.close).toHaveBeenCalledTimes(1);
      expect(agentManager.close).toHaveBeenCalledTimes(1);
    });

    it("should use custom shutdown grace period", async () => {
      const customGracePeriod = 100;
      const server = createTrackedServer(services, {
        shutdownGracePeriodMs: customGracePeriod,
      });
      await server.start();
      await server.stop();

      expect(eventStore.persist).toHaveBeenCalled();
    });
  });

  describe("POST /api/agents/:id/inject", () => {
    it("should return 400 if content is missing", async () => {
      const server = createTrackedServer();
      vi.mocked(agentManager.get).mockReturnValue(createMockAgent());

      const res = await request(server.app)
        .post("/api/agents/agent_test123/inject")
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("MISSING_CONTENT");
    });

    it("should return 404 if agent not found", async () => {
      const server = createTrackedServer();
      vi.mocked(agentManager.get).mockReturnValue(null);

      const res = await request(server.app)
        .post("/api/agents/nonexistent/inject")
        .send({ content: "Test message" });

      expect(res.status).toBe(404);
      expect(res.body.code).toBe("AGENT_NOT_FOUND");
    });

    it("should fall back to message when no session", async () => {
      const server = createTrackedServer();
      vi.mocked(agentManager.get).mockReturnValue(createMockAgent());
      vi.mocked(agentManager.getSession).mockReturnValue(null);
      vi.mocked(messageRouter.sendToAddress).mockResolvedValue({
        id: "evt_123",
        timestamp: Date.now(),
        from: "__human__",
        to: { agent: "agent_test123" },
        content: "Test message",
        delivered: ["agent_test123"],
      });

      const res = await request(server.app)
        .post("/api/agents/agent_test123/inject")
        .send({ content: "Test message" });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.method).toBe("message");
      // The inject module wraps the content with a header
      expect(messageRouter.sendToAddress).toHaveBeenCalledWith({
        from: "__human__",
        to: { agent: "agent_test123" },
        content: "[Context Injection from User]\n\nTest message",
        options: { priority: "high" },
      });
    });

    it("should inject successfully when session supports it", async () => {
      const server = createTrackedServer();
      vi.mocked(agentManager.get).mockReturnValue(createMockAgent());
      vi.mocked(agentManager.isPrompting).mockReturnValue(true);
      vi.mocked(agentManager.getSession).mockReturnValue({
        inject: vi.fn().mockResolvedValue({ success: true }),
        supportsInject: vi.fn().mockReturnValue(true),
        interruptWith: vi.fn(),
      } as any);

      const res = await request(server.app)
        .post("/api/agents/agent_test123/inject")
        .send({ content: "Test message" });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.method).toBe("inject");
    });

    it("should fall back to interrupt when inject not supported", async () => {
      const server = createTrackedServer();
      vi.mocked(agentManager.get).mockReturnValue(createMockAgent());
      vi.mocked(agentManager.isPrompting).mockReturnValue(true);
      vi.mocked(agentManager.getSession).mockReturnValue({
        inject: vi.fn().mockResolvedValue({ success: false, error: "Not supported" }),
        supportsInject: vi.fn().mockReturnValue(false),
        interruptWith: vi.fn().mockImplementation(async function* () {
          yield { type: "update" };
        }),
      } as any);

      const res = await request(server.app)
        .post("/api/agents/agent_test123/inject")
        .send({ content: "Test message", urgent: true });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.method).toBe("interrupt");
    });

    it("should include reason in response when provided", async () => {
      const server = createTrackedServer();
      vi.mocked(agentManager.get).mockReturnValue(createMockAgent());
      vi.mocked(agentManager.isPrompting).mockReturnValue(true);
      vi.mocked(agentManager.getSession).mockReturnValue({
        inject: vi.fn().mockResolvedValue({ success: true }),
        supportsInject: vi.fn().mockReturnValue(true),
        interruptWith: vi.fn(),
      } as any);

      const res = await request(server.app)
        .post("/api/agents/agent_test123/inject")
        .send({ content: "Test message", reason: "Priority change" });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it("should format content with reason when provided", async () => {
      const server = createTrackedServer();
      vi.mocked(agentManager.get).mockReturnValue(createMockAgent());
      vi.mocked(agentManager.getSession).mockReturnValue(null);
      vi.mocked(messageRouter.sendToAddress).mockResolvedValue({
        id: "evt_123",
        timestamp: Date.now(),
        from: "__human__",
        to: { agent: "agent_test123" },
        content: "Test message",
        delivered: ["agent_test123"],
      });

      const res = await request(server.app)
        .post("/api/agents/agent_test123/inject")
        .send({ content: "Test message", reason: "Build is failing" });

      expect(res.status).toBe(200);
      // The content should include the reason in the formatted message
      expect(messageRouter.sendToAddress).toHaveBeenCalledWith({
        from: "__human__",
        to: { agent: "agent_test123" },
        content: "[Context Injection from User]\nReason: Build is failing\n\nTest message",
        options: { priority: "high" },
      });
    });

    it("should use urgent mode to prefer interrupt over inject", async () => {
      const server = createTrackedServer();
      vi.mocked(agentManager.get).mockReturnValue(createMockAgent());
      vi.mocked(agentManager.isPrompting).mockReturnValue(true);
      const interruptWithMock = vi.fn().mockImplementation(async function* () {
        yield { type: "update" };
      });
      vi.mocked(agentManager.getSession).mockReturnValue({
        inject: vi.fn().mockResolvedValue({ success: true }),
        supportsInject: vi.fn().mockReturnValue(true),
        interruptWith: interruptWithMock,
      } as any);

      const res = await request(server.app)
        .post("/api/agents/agent_test123/inject")
        .send({ content: "Urgent message", urgent: true });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.method).toBe("interrupt");
      // Interrupt should have been called
      expect(interruptWithMock).toHaveBeenCalled();
    });

    it("should fall back to inject when urgent interrupt fails", async () => {
      const server = createTrackedServer();
      vi.mocked(agentManager.get).mockReturnValue(createMockAgent());
      vi.mocked(agentManager.isPrompting).mockReturnValue(true);
      vi.mocked(agentManager.getSession).mockReturnValue({
        inject: vi.fn().mockResolvedValue({ success: true }),
        supportsInject: vi.fn().mockReturnValue(true),
        interruptWith: vi.fn().mockImplementation(async function* () {
          throw new Error("Interrupt failed");
        }),
      } as any);

      const res = await request(server.app)
        .post("/api/agents/agent_test123/inject")
        .send({ content: "Urgent message", urgent: true });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.method).toBe("inject");
    });

    it("should fall back to message when inject throws an error", async () => {
      const server = createTrackedServer();
      vi.mocked(agentManager.get).mockReturnValue(createMockAgent());
      vi.mocked(agentManager.isPrompting).mockReturnValue(false);
      vi.mocked(agentManager.getSession).mockReturnValue({
        inject: vi.fn().mockRejectedValue(new Error("Injection error")),
        supportsInject: vi.fn().mockReturnValue(true),
        checkInjectSupport: vi.fn().mockResolvedValue(true),
        interruptWith: vi.fn(),
      } as any);
      vi.mocked(messageRouter.sendToAddress).mockResolvedValue({
        id: "evt_123",
        timestamp: Date.now(),
        from: "__human__",
        to: { agent: "agent_test123" },
        content: "Test message",
        delivered: ["agent_test123"],
      });

      const res = await request(server.app)
        .post("/api/agents/agent_test123/inject")
        .send({ content: "Test message" });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.method).toBe("message");
    });

    it("should return 500 when all fallbacks fail", async () => {
      const server = createTrackedServer();
      vi.mocked(agentManager.get).mockReturnValue(createMockAgent());
      vi.mocked(agentManager.isPrompting).mockReturnValue(false);
      vi.mocked(agentManager.getSession).mockReturnValue({
        inject: vi.fn().mockResolvedValue({ success: false }),
        supportsInject: vi.fn().mockReturnValue(false),
        checkInjectSupport: vi.fn().mockResolvedValue(false),
        interruptWith: vi.fn(),
      } as any);
      vi.mocked(messageRouter.sendToAddress).mockRejectedValue(new Error("Message failed"));

      const res = await request(server.app)
        .post("/api/agents/agent_test123/inject")
        .send({ content: "Test message" });

      expect(res.status).toBe(500);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain("Failed to send message");
    });

    it("should skip interrupt when agent is not prompting", async () => {
      const server = createTrackedServer();
      vi.mocked(agentManager.get).mockReturnValue(createMockAgent());
      vi.mocked(agentManager.isPrompting).mockReturnValue(false);
      const interruptWithMock = vi.fn();
      vi.mocked(agentManager.getSession).mockReturnValue({
        inject: vi.fn().mockResolvedValue({ success: false }),
        supportsInject: vi.fn().mockReturnValue(false),
        checkInjectSupport: vi.fn().mockResolvedValue(false),
        interruptWith: interruptWithMock,
      } as any);
      vi.mocked(messageRouter.sendToAddress).mockResolvedValue({
        id: "evt_123",
        timestamp: Date.now(),
        from: "__human__",
        to: { agent: "agent_test123" },
        content: "Test message",
        delivered: ["agent_test123"],
      });

      const res = await request(server.app)
        .post("/api/agents/agent_test123/inject")
        .send({ content: "Test message" });

      expect(res.status).toBe(200);
      expect(res.body.method).toBe("message");
      // Interrupt should NOT have been called since agent is not prompting
      expect(interruptWithMock).not.toHaveBeenCalled();
    });

    it("should verify inject support when supportsInject returns false initially then true on recheck", async () => {
      const server = createTrackedServer();
      vi.mocked(agentManager.get).mockReturnValue(createMockAgent());
      vi.mocked(agentManager.isPrompting).mockReturnValue(true);
      // First call returns false, second call returns true (simulating support becoming available)
      const supportsInjectMock = vi.fn()
        .mockReturnValueOnce(false)
        .mockReturnValue(true);
      vi.mocked(agentManager.getSession).mockReturnValue({
        inject: vi.fn().mockResolvedValue({ success: true }),
        supportsInject: supportsInjectMock,
        interruptWith: vi.fn(),
      } as any);

      const res = await request(server.app)
        .post("/api/agents/agent_test123/inject")
        .send({ content: "Test message" });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.method).toBe("inject");
      // supportsInject should have been called twice (once for initial check, once for verification)
      expect(supportsInjectMock).toHaveBeenCalledTimes(2);
    });

    it("should include note about injection method", async () => {
      const server = createTrackedServer();
      vi.mocked(agentManager.get).mockReturnValue(createMockAgent());
      vi.mocked(agentManager.isPrompting).mockReturnValue(true);
      vi.mocked(agentManager.getSession).mockReturnValue({
        inject: vi.fn().mockResolvedValue({ success: true }),
        supportsInject: vi.fn().mockReturnValue(true),
        interruptWith: vi.fn(),
      } as any);

      const res = await request(server.app)
        .post("/api/agents/agent_test123/inject")
        .send({ content: "Test message" });

      expect(res.status).toBe(200);
      expect(res.body.note).toBe("Queued for next turn");
    });

    it("should include note for interrupt method", async () => {
      const server = createTrackedServer();
      vi.mocked(agentManager.get).mockReturnValue(createMockAgent());
      vi.mocked(agentManager.isPrompting).mockReturnValue(true);
      vi.mocked(agentManager.getSession).mockReturnValue({
        inject: vi.fn().mockResolvedValue({ success: false }),
        supportsInject: vi.fn().mockReturnValue(false),
        checkInjectSupport: vi.fn().mockResolvedValue(false),
        interruptWith: vi.fn().mockImplementation(async function* () {
          yield { type: "update" };
        }),
      } as any);

      const res = await request(server.app)
        .post("/api/agents/agent_test123/inject")
        .send({ content: "Test message" });

      expect(res.status).toBe(200);
      expect(res.body.note).toBe("Cancelled current work and restarted with context");
    });

    it("should include note for message fallback with no session", async () => {
      const server = createTrackedServer();
      vi.mocked(agentManager.get).mockReturnValue(createMockAgent());
      vi.mocked(agentManager.getSession).mockReturnValue(null);
      vi.mocked(messageRouter.sendToAddress).mockResolvedValue({
        id: "evt_123",
        timestamp: Date.now(),
        from: "__human__",
        to: { agent: "agent_test123" },
        content: "Test message",
        delivered: ["agent_test123"],
      });

      const res = await request(server.app)
        .post("/api/agents/agent_test123/inject")
        .send({ content: "Test message" });

      expect(res.status).toBe(200);
      expect(res.body.note).toContain("Agent has no active session");
    });

    it("should handle empty content string", async () => {
      const server = createTrackedServer();
      vi.mocked(agentManager.get).mockReturnValue(createMockAgent());

      const res = await request(server.app)
        .post("/api/agents/agent_test123/inject")
        .send({ content: "" });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("MISSING_CONTENT");
    });

    it("should handle whitespace-only content as valid", async () => {
      const server = createTrackedServer();
      vi.mocked(agentManager.get).mockReturnValue(createMockAgent());
      vi.mocked(agentManager.isPrompting).mockReturnValue(true);
      vi.mocked(agentManager.getSession).mockReturnValue({
        inject: vi.fn().mockResolvedValue({ success: true }),
        supportsInject: vi.fn().mockReturnValue(true),
        interruptWith: vi.fn(),
      } as any);

      const res = await request(server.app)
        .post("/api/agents/agent_test123/inject")
        .send({ content: "   " });

      // Whitespace-only is still truthy and passes validation
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it("should handle stopped agent by falling back to message", async () => {
      const server = createTrackedServer();
      vi.mocked(agentManager.get).mockReturnValue(createMockAgent({ state: "stopped" }));
      vi.mocked(agentManager.getSession).mockReturnValue(null);
      vi.mocked(messageRouter.sendToAddress).mockResolvedValue({
        id: "evt_123",
        timestamp: Date.now(),
        from: "__human__",
        to: { agent: "agent_test123" },
        content: "Test message",
        delivered: ["agent_test123"],
      });

      const res = await request(server.app)
        .post("/api/agents/agent_test123/inject")
        .send({ content: "Test message" });

      // Should succeed via message fallback even for stopped agent
      expect(res.status).toBe(200);
      expect(res.body.method).toBe("message");
    });

    it("should handle inject returning failure with error", async () => {
      const server = createTrackedServer();
      vi.mocked(agentManager.get).mockReturnValue(createMockAgent());
      vi.mocked(agentManager.isPrompting).mockReturnValue(false);
      vi.mocked(agentManager.getSession).mockReturnValue({
        inject: vi.fn().mockResolvedValue({ success: false, error: "Not supported in this context" }),
        supportsInject: vi.fn().mockReturnValue(true),
        checkInjectSupport: vi.fn().mockResolvedValue(true),
        interruptWith: vi.fn(),
      } as any);
      vi.mocked(messageRouter.sendToAddress).mockResolvedValue({
        id: "evt_123",
        timestamp: Date.now(),
        from: "__human__",
        to: { agent: "agent_test123" },
        content: "Test message",
        delivered: ["agent_test123"],
      });

      const res = await request(server.app)
        .post("/api/agents/agent_test123/inject")
        .send({ content: "Test message" });

      // Should fall back to message when inject returns failure
      expect(res.status).toBe(200);
      expect(res.body.method).toBe("message");
    });

    it("should correctly pass agent_id as __human__ for human source", async () => {
      const server = createTrackedServer();
      vi.mocked(agentManager.get).mockReturnValue(createMockAgent());
      vi.mocked(agentManager.getSession).mockReturnValue(null);
      vi.mocked(messageRouter.sendToAddress).mockResolvedValue({
        id: "evt_123",
        timestamp: Date.now(),
        from: "__human__",
        to: { agent: "agent_test123" },
        content: "Test message",
        delivered: ["agent_test123"],
      });

      const res = await request(server.app)
        .post("/api/agents/agent_test123/inject")
        .send({ content: "Test message" });

      expect(res.status).toBe(200);
      expect(messageRouter.sendToAddress).toHaveBeenCalledWith(
        expect.objectContaining({
          from: "__human__",
        })
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Team Management API Endpoints
  // ─────────────────────────────────────────────────────────────────

  describe("Team Management API", () => {
    let teamManager: TeamManager;

    beforeEach(() => {
      teamManager = createMockTeamManager();
      services = { ...services, teamManager };
    });

    describe("POST /api/teams", () => {
      it("should start a team instance", async () => {
        const server = createTrackedServer();
        const res = await request(server.app)
          .post("/api/teams")
          .send({ template: "test-team" });

        expect(res.status).toBe(201);
        expect(res.body.id).toBe("test-team-1");
        expect(res.body.templateName).toBe("test-team");
        expect(res.body.rootAgentId).toBe("agent_root1");
        expect(res.body.companionAgentIds).toEqual(["agent_comp1"]);
        expect(res.body.taskMode).toBe("push");
        expect(res.body.strategy).toBe("queue");
        expect(teamManager.startTeam).toHaveBeenCalledWith("test-team", expect.any(String));
      });

      it("should return 400 when template is missing", async () => {
        const server = createTrackedServer();
        const res = await request(server.app)
          .post("/api/teams")
          .send({});

        expect(res.status).toBe(400);
        expect(res.body.code).toBe("INVALID_REQUEST");
      });

      it("should allow starting multiple teams", async () => {
        const secondInstance = createMockTeamInstance({
          id: "second-team-1",
          templateName: "second-team",
        });
        (teamManager.startTeam as any)
          .mockResolvedValueOnce(createMockTeamInstance())
          .mockResolvedValueOnce(secondInstance);

        const server = createTrackedServer();

        const res1 = await request(server.app)
          .post("/api/teams")
          .send({ template: "test-team" });
        expect(res1.status).toBe(201);

        const res2 = await request(server.app)
          .post("/api/teams")
          .send({ template: "second-team" });
        expect(res2.status).toBe(201);
        expect(res2.body.id).toBe("second-team-1");
      });

      it("should return 500 on start failure", async () => {
        (teamManager.startTeam as any).mockRejectedValueOnce(
          new Error("Template not found")
        );

        const server = createTrackedServer();
        const res = await request(server.app)
          .post("/api/teams")
          .send({ template: "bad-team" });

        expect(res.status).toBe(500);
        expect(res.body.code).toBe("TEAM_START_FAILED");
      });
    });

    describe("GET /api/teams", () => {
      it("should list running team instances", async () => {
        const server = createTrackedServer();
        const res = await request(server.app).get("/api/teams");

        expect(res.status).toBe(200);
        expect(res.body).toHaveLength(1);
        expect(res.body[0].id).toBe("test-team-1");
        expect(res.body[0].templateName).toBe("test-team");
        expect(res.body[0].rootAgentId).toBe("agent_root1");
      });

      it("should return empty array when no teams running", async () => {
        (teamManager.getInstances as any).mockReturnValue([]);

        const server = createTrackedServer();
        const res = await request(server.app).get("/api/teams");

        expect(res.status).toBe(200);
        expect(res.body).toEqual([]);
      });
    });

    describe("GET /api/teams/:id", () => {
      it("should return team instance details", async () => {
        const server = createTrackedServer();
        const res = await request(server.app).get("/api/teams/test-team-1");

        expect(res.status).toBe(200);
        expect(res.body.id).toBe("test-team-1");
        expect(res.body.roles).toBeDefined();
        expect(res.body.communication).toBeDefined();
      });

      it("should return 404 for unknown team", async () => {
        const server = createTrackedServer();
        const res = await request(server.app).get("/api/teams/nonexistent");

        expect(res.status).toBe(404);
        expect(res.body.code).toBe("TEAM_NOT_FOUND");
      });
    });

    describe("DELETE /api/teams/:id", () => {
      it("should teardown a team instance", async () => {
        const server = createTrackedServer();
        const res = await request(server.app).delete("/api/teams/test-team-1");

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(teamManager.stopTeam).toHaveBeenCalledWith("test-team-1");
      });

      it("should return 404 for unknown team", async () => {
        const server = createTrackedServer();
        const res = await request(server.app).delete("/api/teams/nonexistent");

        expect(res.status).toBe(404);
        expect(res.body.code).toBe("TEAM_NOT_FOUND");
      });

      it("should return 500 on stop failure", async () => {
        (teamManager.stopTeam as any).mockRejectedValueOnce(
          new Error("Teardown failed")
        );

        const server = createTrackedServer();
        const res = await request(server.app).delete("/api/teams/test-team-1");

        expect(res.status).toBe(500);
        expect(res.body.code).toBe("TEAM_STOP_FAILED");
      });
    });

    describe("without teamManager", () => {
      it("should not register team routes when teamManager is not provided", async () => {
        const servicesNoTeam = { eventStore, agentManager, taskManager, messageRouter };
        const server = createTrackedServer(servicesNoTeam);

        const res = await request(server.app).get("/api/teams");
        expect(res.status).toBe(404);
      });
    });
  });
});
