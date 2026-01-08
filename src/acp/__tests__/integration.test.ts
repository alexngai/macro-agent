/**
 * ACP Mode Integration Tests
 *
 * Tests the MacroAgent with mocked services to verify the integration
 * between MacroAgent and its dependencies.
 *
 * Note: These tests use mocked AgentManager to avoid spawning real
 * Claude Code processes. For end-to-end tests with real processes,
 * see src/__tests__/integration.test.ts.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { MacroAgent } from "../macro-agent.js";
import { ACPError } from "../types.js";
import type { AgentSideConnection } from "@agentclientprotocol/sdk";
import type { AgentManager } from "../../agent/agent-manager.js";
import type { EventStore } from "../../store/event-store.js";
import type { TaskManager } from "../../task/task-manager.js";
import type { Agent, Task } from "../../store/types/index.js";

// ─────────────────────────────────────────────────────────────────
// Mock Setup
// ─────────────────────────────────────────────────────────────────

let agentCounter = 0;
let taskCounter = 0;
let sessionCounter = 0;

function createMockAgent(overrides: Partial<Agent> = {}): Agent {
  const id = overrides.id ?? `agent-${++agentCounter}`;
  return {
    id,
    session_id: `session-${++sessionCounter}`,
    state: "running",
    task: "Test task",
    task_id: `task-${++taskCounter}`,
    parent: null,
    lineage: [],
    config: {},
    cwd: "/test/working/dir",
    created_at: Date.now(),
    started_at: Date.now(),
    ...overrides,
  };
}

function createMockTask(overrides: Partial<Task> = {}): Task {
  return {
    id: overrides.id ?? `task-${++taskCounter}`,
    description: "Test task",
    status: "in_progress",
    created_by: "agent-1",
    created_at: Date.now(),
    ...overrides,
  };
}

function createMockConnection(): AgentSideConnection {
  return {
    sessionUpdate: vi.fn().mockResolvedValue(undefined),
    requestPermission: vi.fn().mockResolvedValue({ outcome: "allow_once" }),
    closed: Promise.resolve(),
  } as unknown as AgentSideConnection;
}

// Store for tracking agents/tasks created during tests
let agentStore: Map<string, Agent>;
let taskStore: Map<string, Task>;
let headManagers: Agent[];

function createMockAgentManager(): AgentManager {
  return {
    spawn: vi.fn().mockImplementation((opts) => {
      const agentId = `agent-${++agentCounter}`;
      const sessionId = `session-${++sessionCounter}`;
      const taskId = `task-${++taskCounter}`;
      const agent: Agent = {
        id: agentId,
        session_id: sessionId,
        state: "running",
        task: opts.task,
        task_id: taskId,
        parent: opts.parent ?? null,
        lineage: [],
        created_at: Date.now(),
        started_at: Date.now(),
      };
      const task = createMockTask({
        id: taskId,
        description: opts.task,
        created_by: agentId,
      });
      agentStore.set(agent.id, agent);
      taskStore.set(task.id, task);
      return Promise.resolve({
        id: agent.id,
        session_id: agent.session_id,
        agent,
        session: {},
      });
    }),
    get: vi.fn().mockImplementation((id) => agentStore.get(id) ?? null),
    list: vi.fn().mockImplementation(() => Array.from(agentStore.values())),
    listHeadManagers: vi.fn().mockImplementation(() => headManagers),
    getChildren: vi.fn().mockReturnValue([]),
    getHierarchy: vi.fn().mockImplementation((id) => {
      const agent = agentStore.get(id);
      if (!agent) return null;
      return {
        root: { agent, children: [] },
        depth: 1,
        totalAgents: 1,
      };
    }),
    getOrCreateHeadManager: vi.fn().mockImplementation((opts) => {
      const agentId = `agent-${++agentCounter}`;
      const sessionId = opts.sessionId ?? `session-${++sessionCounter}`;
      const taskId = `task-${++taskCounter}`;
      const agent: Agent = {
        id: agentId,
        session_id: sessionId,
        state: "running",
        task: "Head Manager",
        task_id: taskId,
        parent: null,
        lineage: [],
        created_at: Date.now(),
        started_at: Date.now(),
      };
      const task = createMockTask({
        id: taskId,
        description: "Head Manager",
        created_by: agentId,
      });
      agentStore.set(agent.id, agent);
      taskStore.set(task.id, task);
      headManagers.push(agent);
      return Promise.resolve({
        id: agent.id,
        session_id: agent.session_id,
        agent,
        session: {},
      });
    }),
    hasActiveSession: vi.fn().mockReturnValue(true),
    resume: vi.fn().mockImplementation((id) => {
      const agent = agentStore.get(id);
      return Promise.resolve({
        id: agent?.id ?? id,
        session_id: agent?.session_id ?? "resumed-session",
        agent: agent ?? createMockAgent({ id }),
        session: {},
      });
    }),
    terminate: vi.fn().mockResolvedValue(undefined),
    prompt: vi.fn().mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        yield { sessionUpdate: "agent_message_chunk", textChunk: "Hello" };
      },
    }),
    getSession: vi.fn().mockReturnValue(null),
    onLifecycleEvent: vi.fn().mockReturnValue(() => {}),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as AgentManager;
}

function createMockEventStore(): EventStore {
  return {
    getAgent: vi.fn().mockImplementation((id) => agentStore.get(id) ?? null),
    getTask: vi.fn().mockImplementation((id) => taskStore.get(id) ?? null),
    query: vi.fn().mockReturnValue([]),
    emit: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as EventStore;
}

function createMockTaskManager(): TaskManager {
  return {
    get: vi.fn().mockImplementation((id) => taskStore.get(id) ?? null),
    list: vi.fn().mockImplementation(() => Array.from(taskStore.values())),
    create: vi.fn().mockImplementation((opts) => {
      const task = createMockTask({
        description: opts.description,
        created_by: opts.created_by,
      });
      taskStore.set(task.id, task);
      return task;
    }),
  } as unknown as TaskManager;
}

// ─────────────────────────────────────────────────────────────────
// Integration Tests
// ─────────────────────────────────────────────────────────────────

describe("ACP Mode Integration", () => {
  let macroAgent: MacroAgent;
  let mockConnection: AgentSideConnection;
  let mockAgentManager: AgentManager;
  let mockEventStore: EventStore;
  let mockTaskManager: TaskManager;

  beforeEach(() => {
    // Reset counters and stores
    agentCounter = 0;
    taskCounter = 0;
    sessionCounter = 0;
    agentStore = new Map();
    taskStore = new Map();
    headManagers = [];

    mockConnection = createMockConnection();
    mockAgentManager = createMockAgentManager();
    mockEventStore = createMockEventStore();
    mockTaskManager = createMockTaskManager();

    macroAgent = new MacroAgent(mockConnection, {
      agentManager: mockAgentManager,
      eventStore: mockEventStore,
      taskManager: mockTaskManager,
      defaultCwd: "/test/integration",
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Core ACP Protocol Tests
  // ─────────────────────────────────────────────────────────────────

  describe("Core ACP Protocol", () => {
    it("should complete full initialize → newSession flow", async () => {
      // Step 1: Initialize
      const initResponse = await macroAgent.initialize({
        protocolVersion: 1,
        clientCapabilities: {},
      });

      expect(initResponse.protocolVersion).toBe(1);
      expect(initResponse.agentCapabilities).toBeDefined();
      expect(initResponse.agentCapabilities?.loadSession).toBe(true);
      expect(initResponse.agentCapabilities?._meta?.extensions).toContain(
        "_macro/spawnAgent"
      );

      // Step 2: Create new session
      const sessionResponse = await macroAgent.newSession({
        cwd: "/test/project",
      });

      expect(sessionResponse.sessionId).toBeDefined();
      expect(typeof sessionResponse.sessionId).toBe("string");

      // Verify session is mapped
      const agentId = macroAgent.getMappedAgentId(sessionResponse.sessionId);
      expect(agentId).toBeDefined();

      // Verify AgentManager was called correctly
      expect(mockAgentManager.getOrCreateHeadManager).toHaveBeenCalledWith({
        cwd: "/test/project",
        forceNew: true,
      });
    });

    it("should load existing session", async () => {
      // Create a session first
      const newResponse = await macroAgent.newSession({
        cwd: "/test/project",
      });

      const originalSessionId = newResponse.sessionId;
      const originalAgentId = macroAgent.getMappedAgentId(originalSessionId);

      // Simulate the agent being in headManagers for loadSession to find
      // (already added by getOrCreateHeadManager mock)

      // Create a new MacroAgent instance (simulating restart)
      const newMacroAgent = new MacroAgent(mockConnection, {
        agentManager: mockAgentManager,
        eventStore: mockEventStore,
        taskManager: mockTaskManager,
        defaultCwd: "/test/integration",
      });

      // Load the session
      const loadResponse = await newMacroAgent.loadSession({
        sessionId: originalSessionId,
        cwd: "/test/project",
      });

      // loadSession returns empty object on success
      expect(loadResponse).toEqual({});
    });

    it("should handle authenticate (no-op)", async () => {
      const response = await macroAgent.authenticate({
        methodId: "none",
      });

      expect(response).toEqual({});
    });

    it("should handle cancel notification", async () => {
      // Create a session first
      const sessionResponse = await macroAgent.newSession({
        cwd: "/test/project",
      });

      // Cancel should not throw
      await expect(
        macroAgent.cancel({
          sessionId: sessionResponse.sessionId,
        })
      ).resolves.toBeUndefined();
    });

    it("should advertise correct capabilities", async () => {
      const initResponse = await macroAgent.initialize({
        protocolVersion: 1,
        clientCapabilities: {},
      });

      const extensions = initResponse.agentCapabilities?._meta?.extensions;
      expect(extensions).toContain("_macro/spawnAgent");
      expect(extensions).toContain("_macro/getHierarchy");
      expect(extensions).toContain("_macro/getTask");
      expect(extensions).toContain("_macro/mountAgent");
      expect(extensions).toContain("_macro/forkAgent");
      expect(extensions).toContain("_macro/sendPeerMessage");
      expect(extensions).toContain("_macro/sendPeerRequest");
      expect(extensions).toContain("_macro/deliverPeerMessage");
      expect(extensions).toContain("_macro/deliverPeerRequest");
      expect(extensions).toContain("_macro/grantCapability");
      expect(extensions).toContain("_macro/revokeCapability");
      expect(extensions).toContain("_macro/getCapabilities");
      expect(extensions).toContain("_macro/checkCapability");
      expect(extensions?.length).toBe(13);

      expect(initResponse.agentCapabilities?._meta?.agentType).toBe(
        "macro-agent"
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Session Mapper Integration Tests
  // ─────────────────────────────────────────────────────────────────

  describe("Session Mapper Integration", () => {
    it("should track multiple sessions correctly", async () => {
      // Create multiple sessions
      const session1 = await macroAgent.newSession({ cwd: "/project1" });
      const session2 = await macroAgent.newSession({ cwd: "/project2" });
      const session3 = await macroAgent.newSession({ cwd: "/project3" });

      // All sessions should be tracked
      const mapper = macroAgent.getSessionMapper();
      const mappings = mapper.getAllMappings();

      expect(mappings.length).toBe(3);

      // Each session should have unique agent IDs
      const agentIds = mappings.map((m) => m.agentId);
      const uniqueAgentIds = new Set(agentIds);
      expect(uniqueAgentIds.size).toBe(3);

      // Session IDs should be unique
      expect(session1.sessionId).not.toBe(session2.sessionId);
      expect(session2.sessionId).not.toBe(session3.sessionId);
    });

    it("should update mappings on mount", async () => {
      // Create a session
      const sessionResponse = await macroAgent.newSession({
        cwd: "/test/project",
      });
      const sessionId = sessionResponse.sessionId;

      // Get the original agent ID
      const originalAgentId = macroAgent.getMappedAgentId(sessionId);
      expect(originalAgentId).toBeDefined();

      // Spawn a new agent to mount to
      const spawnResponse = await macroAgent.extMethod("macro/spawnAgent", {
        task_description: "Test agent for mounting",
      });

      const newAgentId = spawnResponse.agentId as string;

      // Mount to the new agent
      await macroAgent.extMethod("macro/mountAgent", {
        sessionId,
        agentId: newAgentId,
      });

      // Verify mapping updated
      const currentAgentId = macroAgent.getMappedAgentId(sessionId);
      expect(currentAgentId).toBe(newAgentId);
      expect(currentAgentId).not.toBe(originalAgentId);

      // Verify mount state
      const mapper = macroAgent.getSessionMapper();
      expect(mapper.isMounted(sessionId)).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Extension Integration Tests
  // ─────────────────────────────────────────────────────────────────

  describe("Extension: _macro/spawnAgent", () => {
    it("should spawn agent and track in store", async () => {
      // Create a session first (to have a parent)
      await macroAgent.newSession({ cwd: "/test/project" });

      // Spawn an agent
      const response = await macroAgent.extMethod("macro/spawnAgent", {
        task_description: "Integration test task",
        options: {
          cwd: "/test/spawn",
        },
      });

      expect(response.agentId).toBeDefined();
      expect(response.taskId).toBeDefined();
      expect(response.sessionId).toBeDefined();

      // Verify agent was recorded in store
      const agent = agentStore.get(response.agentId as string);
      expect(agent).not.toBeNull();
      expect(agent?.task).toBe("Integration test task");

      // Verify AgentManager.spawn was called
      expect(mockAgentManager.spawn).toHaveBeenCalledWith(
        expect.objectContaining({
          task: "Integration test task",
          cwd: "/test/spawn",
        })
      );
    });

    it("should create proper parent-child relationship", async () => {
      // Create head manager session
      const sessionResponse = await macroAgent.newSession({
        cwd: "/test/project",
      });

      const parentId = macroAgent.getMappedAgentId(sessionResponse.sessionId);

      // Spawn child with explicit parent
      await macroAgent.extMethod("macro/spawnAgent", {
        task_description: "Child agent task",
        parentId,
      });

      // Verify spawn was called with correct parent
      expect(mockAgentManager.spawn).toHaveBeenCalledWith(
        expect.objectContaining({
          task: "Child agent task",
          parent: parentId,
        })
      );
    });
  });

  describe("Extension: _macro/getHierarchy", () => {
    it("should return empty hierarchy when no agents exist", async () => {
      // Fresh MacroAgent with no sessions/agents
      headManagers.length = 0; // Clear head managers
      const freshAgent = new MacroAgent(mockConnection, {
        agentManager: mockAgentManager,
        eventStore: mockEventStore,
        taskManager: mockTaskManager,
        defaultCwd: "/test",
      });

      const response = await freshAgent.extMethod("macro/getHierarchy", {});

      expect(response.totalAgents).toBe(0);
      expect(response.depth).toBe(0);
    });

    it("should build correct hierarchy tree", async () => {
      // Create session (creates head manager)
      const sessionResponse = await macroAgent.newSession({
        cwd: "/test/project",
      });

      const parentId = macroAgent.getMappedAgentId(sessionResponse.sessionId);

      // Get hierarchy
      const response = await macroAgent.extMethod("macro/getHierarchy", {
        rootAgentId: parentId,
      });

      expect(response.hierarchy).toBeDefined();
      expect(response.totalAgents).toBeGreaterThanOrEqual(1);
      expect(response.depth).toBeGreaterThanOrEqual(1);

      // Root should be the parent agent
      const hierarchy = response.hierarchy as { agent: { id: string } };
      expect(hierarchy.agent.id).toBe(parentId);
    });

    it("should throw for non-existent agent", async () => {
      await expect(
        macroAgent.extMethod("macro/getHierarchy", {
          rootAgentId: "non-existent-agent",
        })
      ).rejects.toThrow(ACPError);
    });
  });

  describe("Extension: _macro/getTask", () => {
    it("should retrieve task created by spawn", async () => {
      await macroAgent.newSession({ cwd: "/test/project" });

      // Spawn agent (creates task)
      const spawnResponse = await macroAgent.extMethod("macro/spawnAgent", {
        task_description: "Task for retrieval test",
      });

      const taskId = spawnResponse.taskId as string;

      // Get the task
      const taskResponse = await macroAgent.extMethod("macro/getTask", {
        taskId,
      });

      expect(taskResponse.task).toBeDefined();
      const task = taskResponse.task as { id: string; description: string };
      expect(task.id).toBe(taskId);
      expect(task.description).toBe("Task for retrieval test");
    });

    it("should throw for non-existent task", async () => {
      await expect(
        macroAgent.extMethod("macro/getTask", {
          taskId: "non-existent-task",
        })
      ).rejects.toThrow(ACPError);
    });
  });

  describe("Extension: _macro/mountAgent", () => {
    it("should mount to spawned agent", async () => {
      // Create session
      const sessionResponse = await macroAgent.newSession({
        cwd: "/test/project",
      });
      const sessionId = sessionResponse.sessionId;
      const originalAgentId = macroAgent.getMappedAgentId(sessionId);

      // Spawn a new agent
      const spawnResponse = await macroAgent.extMethod("macro/spawnAgent", {
        task_description: "Agent to mount to",
      });

      const targetAgentId = spawnResponse.agentId as string;

      // Mount to the new agent
      const mountResponse = await macroAgent.extMethod("macro/mountAgent", {
        sessionId,
        agentId: targetAgentId,
      });

      expect(mountResponse.sessionId).toBe(sessionId);
      expect(mountResponse.previousAgentId).toBe(originalAgentId);

      // Verify current agent is the mounted one
      expect(macroAgent.getMappedAgentId(sessionId)).toBe(targetAgentId);
    });

    it("should preserve head manager ID for unmount", async () => {
      // Create session
      const sessionResponse = await macroAgent.newSession({
        cwd: "/test/project",
      });
      const sessionId = sessionResponse.sessionId;

      const originalAgentId = macroAgent.getMappedAgentId(sessionId);

      // Spawn and mount
      const spawnResponse = await macroAgent.extMethod("macro/spawnAgent", {
        task_description: "Temporary mount target",
      });

      await macroAgent.extMethod("macro/mountAgent", {
        sessionId,
        agentId: spawnResponse.agentId as string,
      });

      // Verify head manager ID is preserved
      const mapper = macroAgent.getSessionMapper();
      const mapping = mapper.getMapping(sessionId);
      expect(mapping?.headManagerId).toBe(originalAgentId);
    });

    it("should throw for non-existent session", async () => {
      await expect(
        macroAgent.extMethod("macro/mountAgent", {
          sessionId: "non-existent-session",
          agentId: "some-agent",
        })
      ).rejects.toThrow(ACPError);
    });

    it("should throw for non-existent agent", async () => {
      const sessionResponse = await macroAgent.newSession({
        cwd: "/test/project",
      });

      await expect(
        macroAgent.extMethod("macro/mountAgent", {
          sessionId: sessionResponse.sessionId,
          agentId: "non-existent-agent",
        })
      ).rejects.toThrow(ACPError);
    });
  });

  describe("Extension: _macro/forkAgent", () => {
    it("should fork an agent", async () => {
      // Create session
      const sessionResponse = await macroAgent.newSession({
        cwd: "/test/project",
      });

      const originalAgentId = macroAgent.getMappedAgentId(
        sessionResponse.sessionId
      );

      // Fork the agent
      const forkResponse = await macroAgent.extMethod("macro/forkAgent", {
        agentId: originalAgentId,
        name: "Forked for testing",
      });

      expect(forkResponse.newAgentId).toBeDefined();
      expect(forkResponse.newSessionId).toBeDefined();
      expect(forkResponse.originalAgentId).toBe(originalAgentId);

      // Verify forked agent exists
      const forkedAgent = agentStore.get(forkResponse.newAgentId as string);
      expect(forkedAgent).not.toBeNull();
      expect(forkedAgent?.task).toContain("Forked for testing");
    });

    it("should throw for non-existent agent", async () => {
      await expect(
        macroAgent.extMethod("macro/forkAgent", {
          agentId: "non-existent-agent",
        })
      ).rejects.toThrow(ACPError);
    });
  });

  describe("Extension Error Handling", () => {
    it("should throw for unknown extension method", async () => {
      await expect(macroAgent.extMethod("unknown/method", {})).rejects.toThrow(
        ACPError
      );

      try {
        await macroAgent.extMethod("unknown/method", {});
      } catch (error) {
        expect(error).toBeInstanceOf(ACPError);
        expect((error as ACPError).code).toBe("INVALID_EXTENSION");
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Multi-Session Workflow Tests
  // ─────────────────────────────────────────────────────────────────

  describe("Multi-Session Workflows", () => {
    it("should handle spawn → mount → fork workflow", async () => {
      // 1. Create initial session
      const session1 = await macroAgent.newSession({ cwd: "/project1" });
      const headManagerId = macroAgent.getMappedAgentId(session1.sessionId);

      // 2. Spawn a child agent
      const childSpawn = await macroAgent.extMethod("macro/spawnAgent", {
        task_description: "Worker agent",
        parentId: headManagerId,
      });

      // 3. Create second session for different workflow
      const session2 = await macroAgent.newSession({ cwd: "/project2" });

      // 4. Mount session2 to the spawned child
      await macroAgent.extMethod("macro/mountAgent", {
        sessionId: session2.sessionId,
        agentId: childSpawn.agentId as string,
      });

      // Verify session2 is now controlling the child agent
      expect(macroAgent.getMappedAgentId(session2.sessionId)).toBe(
        childSpawn.agentId
      );

      // 5. Fork the child from session2's perspective
      const forkResult = await macroAgent.extMethod("macro/forkAgent", {
        agentId: childSpawn.agentId as string,
        name: "Parallel exploration",
      });

      // Verify fork succeeded
      expect(forkResult.newAgentId).toBeDefined();
      expect(forkResult.originalAgentId).toBe(childSpawn.agentId);
    });

    it("should isolate sessions from each other", async () => {
      // Create two independent sessions
      const session1 = await macroAgent.newSession({ cwd: "/workspace1" });
      const session2 = await macroAgent.newSession({ cwd: "/workspace2" });

      // Spawn agents in session1's context
      const spawn1 = await macroAgent.extMethod("macro/spawnAgent", {
        task_description: "Session 1 worker",
        parentId: macroAgent.getMappedAgentId(session1.sessionId),
      });

      // Get session2's original agent
      const session2AgentBefore = macroAgent.getMappedAgentId(
        session2.sessionId
      );

      // Mount session1 to new agent
      await macroAgent.extMethod("macro/mountAgent", {
        sessionId: session1.sessionId,
        agentId: spawn1.agentId as string,
      });

      // Session2 should still point to its original head manager
      expect(macroAgent.getMappedAgentId(session1.sessionId)).toBe(
        spawn1.agentId
      );
      expect(macroAgent.getMappedAgentId(session2.sessionId)).toBe(
        session2AgentBefore
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Store Integration Tests
  // ─────────────────────────────────────────────────────────────────

  describe("Store Integration", () => {
    it("should track agents in store", async () => {
      await macroAgent.newSession({ cwd: "/test/project" });

      const spawn = await macroAgent.extMethod("macro/spawnAgent", {
        task_description: "Stored agent",
      });

      // Agent should be in store
      expect(agentStore.has(spawn.agentId as string)).toBe(true);
    });

    it("should track tasks in store", async () => {
      await macroAgent.newSession({ cwd: "/test/project" });

      const spawn = await macroAgent.extMethod("macro/spawnAgent", {
        task_description: "Persistent task test",
      });

      // Task should be in store
      const task = taskStore.get(spawn.taskId as string);
      expect(task).toBeDefined();
      expect(task?.description).toBe("Persistent task test");
    });
  });
});

// ─────────────────────────────────────────────────────────────────
// Protocol Compliance Tests
// ─────────────────────────────────────────────────────────────────

describe("ACP Protocol Compliance", () => {
  let macroAgent: MacroAgent;
  let mockConnection: AgentSideConnection;
  let mockAgentManager: AgentManager;
  let mockEventStore: EventStore;
  let mockTaskManager: TaskManager;

  beforeEach(() => {
    // Reset stores
    agentCounter = 0;
    taskCounter = 0;
    sessionCounter = 0;
    agentStore = new Map();
    taskStore = new Map();
    headManagers = [];

    mockConnection = createMockConnection();
    mockAgentManager = createMockAgentManager();
    mockEventStore = createMockEventStore();
    mockTaskManager = createMockTaskManager();

    macroAgent = new MacroAgent(mockConnection, {
      agentManager: mockAgentManager,
      eventStore: mockEventStore,
      taskManager: mockTaskManager,
      defaultCwd: "/test",
    });
  });

  it("should return protocol version as number", async () => {
    const response = await macroAgent.initialize({
      protocolVersion: 1,
      clientCapabilities: {},
    });

    expect(typeof response.protocolVersion).toBe("number");
    expect(response.protocolVersion).toBe(1);
  });

  it("should accept various protocol versions", async () => {
    // The agent should echo back the same version
    const response = await macroAgent.initialize({
      protocolVersion: 1,
      clientCapabilities: {},
    });

    // We always return our version, regardless of client
    expect(response.protocolVersion).toBe(1);
  });

  it("should return sessionId as string", async () => {
    const response = await macroAgent.newSession({});

    expect(typeof response.sessionId).toBe("string");
    expect(response.sessionId.length).toBeGreaterThan(0);
  });

  it("should handle empty params gracefully", async () => {
    // newSession with empty params
    const sessionResponse = await macroAgent.newSession({});
    expect(sessionResponse.sessionId).toBeDefined();

    // getHierarchy with empty params (no head managers)
    headManagers.length = 0;
    const hierarchyResponse = await macroAgent.extMethod(
      "macro/getHierarchy",
      {}
    );
    expect(hierarchyResponse).toBeDefined();
    expect(hierarchyResponse.totalAgents).toBe(0);
  });

  it("should use underscore prefix correctly in extensions", async () => {
    const initResponse = await macroAgent.initialize({
      protocolVersion: 1,
      clientCapabilities: {},
    });

    // Extensions should be advertised with underscore prefix
    const extensions = initResponse.agentCapabilities?._meta?.extensions;
    expect(extensions?.every((e: string) => e.startsWith("_"))).toBe(true);
  });
});
