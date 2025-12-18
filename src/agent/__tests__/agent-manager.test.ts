/**
 * AgentManager tests
 *
 * Note: Tests that require acp-factory integration are marked with .skip
 * as they would spawn real Claude Code processes. These should be run
 * in integration tests with proper setup.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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

    // Set up mocks
    mockSession = {
      id: "mock_session_123",
      prompt: vi.fn(),
    };

    mockHandle = {
      createSession: vi.fn().mockResolvedValue(mockSession),
      loadSession: vi.fn().mockResolvedValue(mockSession),
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
      expect(result.session_id).toBe("mock_session_123");
      expect(result.session).toBe(mockSession);

      // Verify agent in EventStore
      const agent = agentManager.get(result.id);
      expect(agent).toBeDefined();
      expect(agent?.state).toBe("running");
      expect(agent?.task).toBe("Test task");
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
    it("should create a head manager", async () => {
      const head = await agentManager.getOrCreateHeadManager({
        cwd: "/tmp",
      });

      expect(head.agent.parent).toBeNull();
      expect(agentManager.listHeadManagers()).toContainEqual(
        expect.objectContaining({ id: head.id }),
      );
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
});
