/**
 * AgentManager tests
 *
 * Note: Tests that require acp-factory integration are marked with .skip
 * as they would spawn real Claude Code processes. These should be run
 * in integration tests with proper setup.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { AgentFactory } from "acp-factory";
import { createEventStore, EventStore } from "../../store/event-store.js";
import { createMessageRouter, MessageRouter } from "../../router/message-router.js";
import { createAgentManager, AgentManager } from "../agent-manager.js";
import { generateSystemPrompt } from "../system-prompt.js";
import type { SystemPromptContext } from "../types.js";

// Mock acp-factory for unit tests
vi.mock("acp-factory", () => ({
  AgentFactory: {
    spawn: vi.fn(),
  },
}));

describe("AgentManager", () => {
  let eventStore: EventStore;
  let messageRouter: MessageRouter;
  let agentManager: AgentManager;

  beforeEach(async () => {
    eventStore = await createEventStore({ inMemory: true });
    messageRouter = createMessageRouter(eventStore);
    agentManager = createAgentManager(eventStore, messageRouter);
  });

  afterEach(async () => {
    await agentManager.close();
    await eventStore.close();
    vi.clearAllMocks();
  });

  // Helper to create an agent directly in EventStore (for query tests)
  function createAgentDirectly(
    id: string,
    parent?: string | null,
    task?: string,
    taskId?: string,
  ) {
    eventStore.emit({
      type: "spawn",
      source: { agent_id: parent ?? "system" },
      payload: {
        agent_id: id,
        session_id: `session_${id}`,
        task: task ?? `Task for ${id}`,
        task_id: taskId,
        parent: parent ?? null,
      },
    });
    // Emit started status
    eventStore.emit({
      type: "status",
      source: { agent_id: id },
      payload: { status_type: "started" },
    });
  }

  describe("Query Operations (no acp-factory)", () => {
    describe("get()", () => {
      it("should return agent by ID", () => {
        createAgentDirectly("agent_1");

        const agent = agentManager.get("agent_1");

        expect(agent).toBeDefined();
        expect(agent?.id).toBe("agent_1");
      });

      it("should return null for non-existent agent", () => {
        const agent = agentManager.get("nonexistent");
        expect(agent).toBeNull();
      });
    });

    describe("list()", () => {
      it("should list all agents", () => {
        createAgentDirectly("agent_1");
        createAgentDirectly("agent_2");
        createAgentDirectly("agent_3");

        const agents = agentManager.list();
        expect(agents).toHaveLength(3);
      });

      it("should filter by state", () => {
        createAgentDirectly("agent_1");
        createAgentDirectly("agent_2");

        // Terminate one
        eventStore.emit({
          type: "terminate",
          source: { agent_id: "agent_2" },
          payload: { reason: "completed" },
        });

        const running = agentManager.list({ state: "running" });
        expect(running).toHaveLength(1);
        expect(running[0].id).toBe("agent_1");

        const stopped = agentManager.list({ state: "stopped" });
        expect(stopped).toHaveLength(1);
        expect(stopped[0].id).toBe("agent_2");
      });

      it("should filter by parent", () => {
        createAgentDirectly("parent_1", null);
        createAgentDirectly("child_1", "parent_1");
        createAgentDirectly("child_2", "parent_1");
        createAgentDirectly("other", null);

        const children = agentManager.list({ parent: "parent_1" });
        expect(children).toHaveLength(2);
        expect(children.map((a) => a.id).sort()).toEqual(["child_1", "child_2"]);
      });

      it("should filter head managers only", () => {
        createAgentDirectly("head_1", null);
        createAgentDirectly("head_2", null);
        createAgentDirectly("child_1", "head_1");

        const headManagers = agentManager.list({ headManagersOnly: true });
        expect(headManagers).toHaveLength(2);
        expect(headManagers.map((a) => a.id).sort()).toEqual([
          "head_1",
          "head_2",
        ]);
      });
    });

    describe("getChildren()", () => {
      it("should return direct children", () => {
        createAgentDirectly("parent", null);
        createAgentDirectly("child_1", "parent");
        createAgentDirectly("child_2", "parent");
        createAgentDirectly("grandchild", "child_1");

        const children = agentManager.getChildren("parent");
        expect(children).toHaveLength(2);
        expect(children.map((a) => a.id).sort()).toEqual(["child_1", "child_2"]);
      });

      it("should return empty array for no children", () => {
        createAgentDirectly("leaf");
        const children = agentManager.getChildren("leaf");
        expect(children).toHaveLength(0);
      });
    });

    describe("getHierarchy()", () => {
      it("should return full hierarchy tree", () => {
        createAgentDirectly("root", null);
        createAgentDirectly("child_1", "root");
        createAgentDirectly("child_2", "root");
        createAgentDirectly("grandchild_1", "child_1");
        createAgentDirectly("grandchild_2", "child_1");

        const hierarchy = agentManager.getHierarchy("root");

        expect(hierarchy).toBeDefined();
        expect(hierarchy!.totalAgents).toBe(5);
        expect(hierarchy!.depth).toBe(3);
        expect(hierarchy!.root.agent.id).toBe("root");
        expect(hierarchy!.root.children).toHaveLength(2);
      });

      it("should return null for non-existent agent", () => {
        const hierarchy = agentManager.getHierarchy("nonexistent");
        expect(hierarchy).toBeNull();
      });

      it("should return full hierarchy when no depth specified", () => {
        createAgentDirectly("root", null);
        createAgentDirectly("child_1", "root");
        createAgentDirectly("grandchild_1", "child_1");
        createAgentDirectly("great_grandchild_1", "grandchild_1");

        const hierarchy = agentManager.getHierarchy("root");

        expect(hierarchy).toBeDefined();
        expect(hierarchy!.depth).toBe(4);
        expect(hierarchy!.totalAgents).toBe(4);
        // Verify full tree is present
        expect(hierarchy!.root.children).toHaveLength(1);
        expect(hierarchy!.root.children[0].children).toHaveLength(1);
        expect(hierarchy!.root.children[0].children[0].children).toHaveLength(1);
      });

      it("should limit hierarchy with depth=1 (root only)", () => {
        createAgentDirectly("root", null);
        createAgentDirectly("child_1", "root");
        createAgentDirectly("child_2", "root");
        createAgentDirectly("grandchild_1", "child_1");

        const hierarchy = agentManager.getHierarchy("root", { depth: 1 });

        expect(hierarchy).toBeDefined();
        expect(hierarchy!.root.agent.id).toBe("root");
        expect(hierarchy!.root.children).toHaveLength(0);
        expect(hierarchy!.totalAgents).toBe(1);
        expect(hierarchy!.depth).toBe(1);
      });

      it("should limit hierarchy with depth=2 (root + children)", () => {
        createAgentDirectly("root", null);
        createAgentDirectly("child_1", "root");
        createAgentDirectly("child_2", "root");
        createAgentDirectly("grandchild_1", "child_1");
        createAgentDirectly("grandchild_2", "child_2");

        const hierarchy = agentManager.getHierarchy("root", { depth: 2 });

        expect(hierarchy).toBeDefined();
        expect(hierarchy!.root.agent.id).toBe("root");
        expect(hierarchy!.root.children).toHaveLength(2);
        // Children should have no children (depth limit reached)
        expect(hierarchy!.root.children[0].children).toHaveLength(0);
        expect(hierarchy!.root.children[1].children).toHaveLength(0);
        expect(hierarchy!.totalAgents).toBe(3);
        expect(hierarchy!.depth).toBe(2);
      });

      it("should respect depth limit on deep hierarchy", () => {
        createAgentDirectly("root", null);
        createAgentDirectly("level2", "root");
        createAgentDirectly("level3", "level2");
        createAgentDirectly("level4", "level3");
        createAgentDirectly("level5", "level4");

        const hierarchy = agentManager.getHierarchy("root", { depth: 3 });

        expect(hierarchy).toBeDefined();
        expect(hierarchy!.root.agent.id).toBe("root");
        expect(hierarchy!.root.children).toHaveLength(1);
        expect(hierarchy!.root.children[0].children).toHaveLength(1);
        // Level 3 should have no children due to depth limit
        expect(hierarchy!.root.children[0].children[0].children).toHaveLength(0);
        expect(hierarchy!.totalAgents).toBe(3);
        expect(hierarchy!.depth).toBe(3);
      });
    });

    describe("listHeadManagers()", () => {
      it("should list all head managers", () => {
        createAgentDirectly("head_1", null);
        createAgentDirectly("head_2", null);
        createAgentDirectly("child", "head_1");

        const heads = agentManager.listHeadManagers();
        expect(heads).toHaveLength(2);
      });
    });
  });

  describe("Session State (no acp-factory)", () => {
    describe("hasActiveSession()", () => {
      it("should return false when no session", () => {
        createAgentDirectly("agent_1");
        expect(agentManager.hasActiveSession("agent_1")).toBe(false);
      });
    });

    describe("getSession()", () => {
      it("should return null when no session", () => {
        createAgentDirectly("agent_1");
        expect(agentManager.getSession("agent_1")).toBeNull();
      });
    });
  });

  describe("Lifecycle Callbacks", () => {
    it("should register and unregister callbacks", () => {
      const callback = vi.fn();

      const unsubscribe = agentManager.onLifecycleEvent(callback);
      expect(typeof unsubscribe).toBe("function");

      unsubscribe();
      // Callback should be removed (can't easily verify without spawning)
    });
  });
});

describe("System Prompt Generator", () => {
  describe("generateSystemPrompt()", () => {
    it("should generate head manager prompt", () => {
      const context: SystemPromptContext = {
        agentId: "agent_123",
        task: "Build a REST API",
        taskId: "task_456",
        parentId: null,
        isHeadManager: true,
        lineage: [],
        mcpTools: ["spawn_agent", "emit_status"],
      };

      const prompt = generateSystemPrompt(context);

      expect(prompt).toContain("Head Manager");
      expect(prompt).toContain("agent_123");
      expect(prompt).toContain("task_456");
      expect(prompt).toContain("Build a REST API");
      expect(prompt).toContain("spawn_agent");
      expect(prompt).toContain("emit_status");
    });

    it("should generate worker prompt", () => {
      const context: SystemPromptContext = {
        agentId: "worker_1",
        task: "Implement authentication",
        taskId: "task_789",
        parentId: "manager_1",
        isHeadManager: false,
        lineage: ["manager_1"],
        mcpTools: ["emit_status", "send_message"],
      };

      const prompt = generateSystemPrompt(context);

      expect(prompt).toContain("Worker Agent");
      expect(prompt).toContain("worker_1");
      expect(prompt).toContain("manager_1");
      expect(prompt).toContain("Implement authentication");
    });

    it("should include lineage information", () => {
      const context: SystemPromptContext = {
        agentId: "grandchild",
        task: "Subtask",
        parentId: "child",
        isHeadManager: false,
        lineage: ["root", "child"],
      };

      const prompt = generateSystemPrompt(context);

      expect(prompt).toContain("root");
      expect(prompt).toContain("child");
    });

    it("should include MCP tools when provided", () => {
      const context: SystemPromptContext = {
        agentId: "agent_1",
        task: "Task",
        isHeadManager: true,
        lineage: [],
        mcpTools: ["spawn_agent", "get_hierarchy", "create_task"],
      };

      const prompt = generateSystemPrompt(context);

      expect(prompt).toContain("spawn_agent");
      expect(prompt).toContain("get_hierarchy");
      expect(prompt).toContain("create_task");
    });

    it("should include signal handling section for coordinator role", () => {
      const context: SystemPromptContext = {
        agentId: "coordinator_1",
        task: "Orchestrate workers",
        isHeadManager: true,
        lineage: [],
        role: "coordinator",
        mcpTools: ["spawn_agent", "stop_agent", "emit_status"],
      };

      const prompt = generateSystemPrompt(context);

      // Should include signal handling section
      expect(prompt).toContain("Signal Handling");
      expect(prompt).toContain("STALE_AGENT");
      expect(prompt).toContain("Decision flow");
      expect(prompt).toContain("Retry Flow");
      expect(prompt).toContain("Failure Flow");
      expect(prompt).toContain("retryPolicy");
    });

    it("should not include signal handling section for worker role", () => {
      const context: SystemPromptContext = {
        agentId: "worker_1",
        task: "Do work",
        parentId: "coordinator_1",
        isHeadManager: false,
        lineage: ["coordinator_1"],
        role: "worker",
        mcpTools: ["emit_status"],
      };

      const prompt = generateSystemPrompt(context);

      // Should NOT include coordinator-specific signal handling
      expect(prompt).not.toContain("STALE_AGENT Signal");
      expect(prompt).not.toContain("Retry Flow");
    });
  });
});

describe("AgentManager Integration (with mocked acp-factory)", () => {
  // These tests verify the spawn/terminate flow with mocked acp-factory

  let eventStore: EventStore;
  let messageRouter: MessageRouter;
  let agentManager: AgentManager;
  let mockHandle: any;
  let mockSession: any;

  beforeEach(async () => {
    eventStore = await createEventStore({ inMemory: true });
    messageRouter = createMessageRouter(eventStore);

    // Counter for unique session IDs
    let sessionCounter = 0;

    // Set up mocks with unique session IDs per call
    mockHandle = {
      createSession: vi.fn().mockImplementation(() => {
        sessionCounter++;
        mockSession = {
          id: `mock_session_${sessionCounter}`,
          prompt: vi.fn(),
        };
        return Promise.resolve(mockSession);
      }),
      loadSession: vi.fn().mockImplementation(() => {
        return Promise.resolve(mockSession);
      }),
      close: vi.fn().mockResolvedValue(undefined),
    };

    const { AgentFactory } = await import("acp-factory");
    vi.mocked(AgentFactory.spawn).mockResolvedValue(mockHandle);

    agentManager = createAgentManager(eventStore, messageRouter);
  });

  afterEach(async () => {
    await agentManager.close();
    await eventStore.close();
    vi.clearAllMocks();
  });

  describe("spawn()", () => {
    it("should spawn agent and emit events", async () => {
      const result = await agentManager.spawn({
        task: "Test task",
        cwd: "/tmp",
      });

      expect(result.id).toMatch(/^agent_/);
      // session_id is macro-agent's own ID (pre-generated before createSession)
      expect(result.session_id).toMatch(/^session_/);
      expect(result.session).toBeDefined();

      // Verify agent in EventStore
      const agent = agentManager.get(result.id);
      expect(agent).toBeDefined();
      expect(agent?.state).toBe("running");
      expect(agent?.task).toBe("Test task");
      // provider_session_id should be set from createSession's returned session.id
      expect(agent?.provider_session_id).toBe("mock_session_1");
    });

    it("should set up default subscriptions", async () => {
      const result = await agentManager.spawn({
        task: "Test task",
        topics: ["errors"],
      });

      const subs = messageRouter.getSubscriptions(result.id);
      expect(subs).toContainEqual({ type: "agent", target: result.id });
      expect(subs).toContainEqual({ type: "lineage", target: result.id });
      expect(subs).toContainEqual({ type: "topic", target: "errors" });
    });

    it("should subscribe parent to subtree", async () => {
      // Create parent first
      const parent = await agentManager.spawn({
        task: "Parent task",
      });

      const child = await agentManager.spawn({
        task: "Child task",
        parent: parent.id,
      });

      const parentSubs = messageRouter.getSubscriptions(parent.id);
      expect(parentSubs).toContainEqual({
        type: "subtree",
        target: child.id,
      });
    });

    it("should throw if parent not found", async () => {
      await expect(
        agentManager.spawn({
          task: "Test task",
          parent: "nonexistent",
        }),
      ).rejects.toThrow("Parent agent not found");
    });

    it("should configure MCP server with MACRO_INSTANCE_ID", async () => {
      await agentManager.spawn({
        task: "Test task",
        cwd: "/tmp",
      });

      // Verify createSession was called with MCP server config
      expect(mockHandle.createSession).toHaveBeenCalled();
      const createSessionArgs = mockHandle.createSession.mock.calls[0];
      const sessionOptions = createSessionArgs[1];

      // Find the macro-agent MCP server in the config
      const mcpServers = sessionOptions?.mcpServers;
      expect(mcpServers).toBeDefined();

      const macroAgentMcp = mcpServers.find(
        (s: any) => s.name === "macro-agent"
      );
      expect(macroAgentMcp).toBeDefined();

      // Verify MACRO_INSTANCE_ID is in the env vars
      const instanceIdEnv = macroAgentMcp.env.find(
        (e: any) => e.name === "MACRO_INSTANCE_ID"
      );
      expect(instanceIdEnv).toBeDefined();
      expect(instanceIdEnv.value).toBe(eventStore.instanceId);
    });

    it("should include all required env vars for MCP server", async () => {
      await agentManager.spawn({
        task: "Test task",
        cwd: "/test/cwd",
      });

      const createSessionArgs = mockHandle.createSession.mock.calls[0];
      const sessionOptions = createSessionArgs[1];
      const macroAgentMcp = sessionOptions.mcpServers.find(
        (s: any) => s.name === "macro-agent"
      );

      // Verify all required env vars are present
      const envNames = macroAgentMcp.env.map((e: any) => e.name);
      expect(envNames).toContain("MACRO_AGENT_ID");
      expect(envNames).toContain("MACRO_PARENT_ID");
      expect(envNames).toContain("MACRO_TASK_ID");
      expect(envNames).toContain("MACRO_AGENT_CWD");
      expect(envNames).toContain("MACRO_INSTANCE_ID");

      // Verify cwd is passed correctly
      const cwdEnv = macroAgentMcp.env.find(
        (e: any) => e.name === "MACRO_AGENT_CWD"
      );
      expect(cwdEnv.value).toBe("/test/cwd");
    });

    it("should persist events after spawning for cross-process visibility", async () => {
      // Spy on eventStore.persist
      const persistSpy = vi.spyOn(eventStore, "persist");

      await agentManager.spawn({
        task: "Test task",
        cwd: "/tmp",
      });

      // Verify persist was called after spawn
      expect(persistSpy).toHaveBeenCalled();
    });

    it("should persist spawn event BEFORE creating session (race condition fix)", async () => {
      // Track the order of persist() calls relative to createSession()
      const callOrder: string[] = [];

      const persistSpy = vi.spyOn(eventStore, "persist").mockImplementation(async () => {
        callOrder.push("persist");
      });

      mockHandle.createSession = vi.fn().mockImplementation(async () => {
        callOrder.push("createSession");
        return { id: "test_session" };
      });

      await agentManager.spawn({
        task: "Test task",
        cwd: "/tmp",
      });

      // persist should be called BEFORE createSession
      // (This ensures MCP server subprocess can find the agent when it starts)
      const persistIndex = callOrder.indexOf("persist");
      const createSessionIndex = callOrder.indexOf("createSession");

      expect(persistIndex).toBeLessThan(createSessionIndex);
      expect(callOrder).toEqual(["persist", "createSession", "persist"]);
    });

    it("should clean up spawn event if createSession fails", async () => {
      // Make createSession fail
      mockHandle.createSession = vi.fn().mockRejectedValue(new Error("Session creation failed"));

      await expect(
        agentManager.spawn({
          task: "Test task",
          cwd: "/tmp",
        })
      ).rejects.toThrow("Failed to spawn agent");

      // The agent should be marked as terminated (cleanup)
      const agents = agentManager.list();
      const testAgent = agents.find(a => a.task === "Test task");
      expect(testAgent?.state).toBe("stopped");
      expect(testAgent?.stop_reason).toBe("failed");
    });
  });

  describe("terminate()", () => {
    it("should terminate agent and emit events", async () => {
      const spawned = await agentManager.spawn({ task: "Test" });

      await agentManager.terminate(spawned.id, "completed");

      const agent = agentManager.get(spawned.id);
      expect(agent?.state).toBe("stopped");
      expect(agent?.stop_reason).toBe("completed");
      expect(mockHandle.close).toHaveBeenCalled();
    });

    it("should cascade terminate to children", async () => {
      const parent = await agentManager.spawn({ task: "Parent" });
      const child = await agentManager.spawn({
        task: "Child",
        parent: parent.id,
      });

      await agentManager.terminate(parent.id, "completed");

      const childAgent = agentManager.get(child.id);
      expect(childAgent?.state).toBe("stopped");
      expect(childAgent?.stop_reason).toBe("parent_stopped");
    });

    it("should throw if agent not found", async () => {
      await expect(
        agentManager.terminate("nonexistent", "completed"),
      ).rejects.toThrow("Agent not found");
    });

    it("should persist events after terminating for cross-process visibility", async () => {
      const spawned = await agentManager.spawn({ task: "Test" });

      // Clear previous calls and spy on persist
      const persistSpy = vi.spyOn(eventStore, "persist");
      persistSpy.mockClear();

      await agentManager.terminate(spawned.id, "completed");

      // Verify persist was called after terminate
      expect(persistSpy).toHaveBeenCalled();
    });
  });

  describe("resume()", () => {
    it("should resume stopped agent", async () => {
      const spawned = await agentManager.spawn({ task: "Test" });
      await agentManager.terminate(spawned.id, "completed");

      const resumed = await agentManager.resume(spawned.id);

      expect(resumed.id).toBe(spawned.id);
      expect(agentManager.hasActiveSession(spawned.id)).toBe(true);
      expect(mockHandle.loadSession).toHaveBeenCalled();
    });

    it("should throw if already running", async () => {
      const spawned = await agentManager.spawn({ task: "Test" });

      await expect(agentManager.resume(spawned.id)).rejects.toThrow(
        "already has active session",
      );
    });
  });

  describe("getOrCreateHeadManager()", () => {
    it("should create a head manager when none exist", async () => {
      const head = await agentManager.getOrCreateHeadManager({
        cwd: "/tmp",
      });

      expect(head.agent.parent).toBeNull();
      expect(agentManager.listHeadManagers()).toContainEqual(
        expect.objectContaining({ id: head.id }),
      );
    });

    it("should resume latest session when calling without options", async () => {
      // Create first head manager
      const first = await agentManager.getOrCreateHeadManager({
        cwd: "/tmp",
      });

      // Small delay to ensure different timestamp
      await new Promise((r) => setTimeout(r, 5));

      // Create second head manager
      const second = await agentManager.getOrCreateHeadManager({
        cwd: "/tmp",
        forceNew: true,
      });

      // Call again without forceNew - should resume the latest (second)
      const resumed = await agentManager.getOrCreateHeadManager({
        cwd: "/tmp",
      });

      expect(resumed.id).toBe(second.id);
      expect(resumed.session_id).toBe(second.session_id);
    });

    it("should create new session with forceNew: true", async () => {
      // Create initial head manager
      const first = await agentManager.getOrCreateHeadManager({
        cwd: "/tmp",
      });

      // Force create new one
      const second = await agentManager.getOrCreateHeadManager({
        cwd: "/tmp",
        forceNew: true,
      });

      expect(second.id).not.toBe(first.id);
      expect(second.session_id).not.toBe(first.session_id);
      expect(agentManager.listHeadManagers()).toHaveLength(2);
    });

    it("should resume specific session with sessionId", async () => {
      // Create first head manager
      const first = await agentManager.getOrCreateHeadManager({
        cwd: "/tmp",
      });

      // Create second head manager
      const second = await agentManager.getOrCreateHeadManager({
        cwd: "/tmp",
        forceNew: true,
      });

      // Resume specific session by ID
      const resumed = await agentManager.getOrCreateHeadManager({
        cwd: "/tmp",
        sessionId: first.session_id,
      });

      expect(resumed.id).toBe(first.id);
      expect(resumed.session_id).toBe(first.session_id);
    });

    it("should create new session when specified sessionId not found", async () => {
      // Create a head manager
      const first = await agentManager.getOrCreateHeadManager({
        cwd: "/tmp",
      });

      // Try to resume non-existent session
      const newOne = await agentManager.getOrCreateHeadManager({
        cwd: "/tmp",
        sessionId: "nonexistent_session",
      });

      // Should create a new session since the specified one doesn't exist
      expect(newOne.id).not.toBe(first.id);
    });
  });

  describe("prompt()", () => {
    it("should throw if no active session", async () => {
      // Create agent without spawning (no session)
      eventStore.emit({
        type: "spawn",
        source: { agent_id: "system" },
        payload: {
          agent_id: "agent_no_session",
          session_id: "session_1",
          task: "Test",
          parent: null,
        },
      });

      await expect(async () => {
        for await (const _ of agentManager.prompt("agent_no_session", "Hello")) {
          // Should not reach here
        }
      }).rejects.toThrow("No active session");
    });
  });

  describe("respondToPermission()", () => {
    it("should call session.respondToPermission with correct params", async () => {
      // Spawn an agent to create a session
      const spawned = await agentManager.spawn({
        task: "Test task",
        cwd: "/tmp",
      });

      // Add respondToPermission to the mock session
      mockSession.respondToPermission = vi.fn();

      // Call respondToPermission
      const result = agentManager.respondToPermission(
        spawned.id,
        "perm-req-123",
        "allow_once"
      );

      expect(result).toBe(true);
      expect(mockSession.respondToPermission).toHaveBeenCalledWith(
        "perm-req-123",
        "allow_once"
      );
    });

    it("should return false when no active session exists", async () => {
      // Create agent directly without spawning (no session)
      eventStore.emit({
        type: "spawn",
        source: { agent_id: "system" },
        payload: {
          agent_id: "agent_no_session",
          session_id: "session_1",
          task: "Test",
          parent: null,
        },
      });

      const result = agentManager.respondToPermission(
        "agent_no_session",
        "perm-req-123",
        "allow_once"
      );

      expect(result).toBe(false);
    });

    it("should return false when session.respondToPermission throws", async () => {
      // Spawn an agent to create a session
      const spawned = await agentManager.spawn({
        task: "Test task",
        cwd: "/tmp",
      });

      // Make respondToPermission throw
      mockSession.respondToPermission = vi.fn().mockImplementation(() => {
        throw new Error("Permission not found");
      });

      const result = agentManager.respondToPermission(
        spawned.id,
        "invalid-req",
        "allow_once"
      );

      expect(result).toBe(false);
    });
  });

  describe("cancelPermission()", () => {
    it("should call session.cancelPermission with correct params", async () => {
      // Spawn an agent to create a session
      const spawned = await agentManager.spawn({
        task: "Test task",
        cwd: "/tmp",
      });

      // Add cancelPermission to the mock session
      mockSession.cancelPermission = vi.fn();

      // Call cancelPermission
      const result = agentManager.cancelPermission(
        spawned.id,
        "perm-req-123"
      );

      expect(result).toBe(true);
      expect(mockSession.cancelPermission).toHaveBeenCalledWith("perm-req-123");
    });

    it("should return false when no active session exists", async () => {
      // Create agent directly without spawning (no session)
      eventStore.emit({
        type: "spawn",
        source: { agent_id: "system" },
        payload: {
          agent_id: "agent_no_session",
          session_id: "session_1",
          task: "Test",
          parent: null,
        },
      });

      const result = agentManager.cancelPermission(
        "agent_no_session",
        "perm-req-123"
      );

      expect(result).toBe(false);
    });

    it("should return false when session.cancelPermission throws", async () => {
      // Spawn an agent to create a session
      const spawned = await agentManager.spawn({
        task: "Test task",
        cwd: "/tmp",
      });

      // Make cancelPermission throw
      mockSession.cancelPermission = vi.fn().mockImplementation(() => {
        throw new Error("Permission not found");
      });

      const result = agentManager.cancelPermission(
        spawned.id,
        "invalid-req"
      );

      expect(result).toBe(false);
    });
  });
});

describe("AgentManager HealthCheckService Integration", () => {
  let eventStore: EventStore;
  let messageRouter: MessageRouter;
  let mockHealthCheckService: {
    startForCoordinator: ReturnType<typeof vi.fn>;
    stopForCoordinator: ReturnType<typeof vi.fn>;
    stopAll: ReturnType<typeof vi.fn>;
  };
  let agentManager: AgentManager;
  let mockHandle: any;
  let mockSession: any;

  beforeEach(async () => {
    eventStore = await createEventStore({ inMemory: true });
    messageRouter = createMessageRouter(eventStore);

    // Create mock HealthCheckService
    mockHealthCheckService = {
      startForCoordinator: vi.fn(),
      stopForCoordinator: vi.fn(),
      stopAll: vi.fn(),
    };

    // Counter for unique session IDs
    let sessionCounter = 0;

    // Set up mocks with unique session IDs per call (matching existing tests)
    mockHandle = {
      createSession: vi.fn().mockImplementation(() => {
        sessionCounter++;
        mockSession = {
          id: `mock_session_${sessionCounter}`,
          prompt: vi.fn(),
        };
        return Promise.resolve(mockSession);
      }),
      loadSession: vi.fn().mockImplementation(() => {
        return Promise.resolve(mockSession);
      }),
      close: vi.fn().mockResolvedValue(undefined),
    };

    vi.mocked(AgentFactory.spawn).mockResolvedValue(mockHandle);

    agentManager = createAgentManager(eventStore, messageRouter, {
      healthCheckService: mockHealthCheckService as any,
    });
  });

  afterEach(async () => {
    await agentManager.close();
    await eventStore.close();
    vi.clearAllMocks();
  });

  describe("spawn() with coordinator role", () => {
    it("should start health checks when spawning a coordinator", async () => {
      const spawned = await agentManager.spawn({
        task: "Coordinate work",
        role: "coordinator",
        cwd: "/tmp",
      });

      expect(mockHealthCheckService.startForCoordinator).toHaveBeenCalledWith(
        spawned.id
      );
    });

    it("should not start health checks when spawning a worker", async () => {
      // First spawn a coordinator as parent
      const coordinator = await agentManager.spawn({
        task: "Coordinate",
        role: "coordinator",
        cwd: "/tmp",
      });

      // Clear the call from coordinator spawn
      mockHealthCheckService.startForCoordinator.mockClear();

      // Now spawn a worker
      await agentManager.spawn({
        task: "Do work",
        role: "worker",
        parent: coordinator.id,
        cwd: "/tmp",
      });

      expect(mockHealthCheckService.startForCoordinator).not.toHaveBeenCalled();
    });
  });

  describe("terminate() with coordinator role", () => {
    it("should stop health checks when terminating a coordinator", async () => {
      const spawned = await agentManager.spawn({
        task: "Coordinate work",
        role: "coordinator",
        cwd: "/tmp",
      });

      await agentManager.terminate(spawned.id, "completed");

      expect(mockHealthCheckService.stopForCoordinator).toHaveBeenCalledWith(
        spawned.id
      );
    });

    it("should not stop health checks when terminating a worker", async () => {
      // First spawn a coordinator
      const coordinator = await agentManager.spawn({
        task: "Coordinate",
        role: "coordinator",
        cwd: "/tmp",
      });

      // Spawn a worker
      const worker = await agentManager.spawn({
        task: "Do work",
        role: "worker",
        parent: coordinator.id,
        cwd: "/tmp",
      });

      // Terminate the worker
      await agentManager.terminate(worker.id, "completed");

      // stopForCoordinator should NOT have been called for the worker
      // (it may have been called for the coordinator spawn, so check the last call)
      const calls = mockHealthCheckService.stopForCoordinator.mock.calls;
      const workerStopCalls = calls.filter(
        (call: any) => call[0] === worker.id
      );
      expect(workerStopCalls).toHaveLength(0);
    });
  });

  describe("close()", () => {
    it("should stop all health checks on close", async () => {
      // Spawn some coordinators
      await agentManager.spawn({
        task: "Coordinate 1",
        role: "coordinator",
        cwd: "/tmp",
      });

      await agentManager.spawn({
        task: "Coordinate 2",
        role: "coordinator",
        cwd: "/tmp",
      });

      // Close the manager
      await agentManager.close();

      expect(mockHealthCheckService.stopAll).toHaveBeenCalled();
    });
  });
});
