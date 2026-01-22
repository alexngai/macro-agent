/**
 * Tests for InMemoryTaskToolProvider
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createEventStore, type EventStore } from "../../../store/event-store.js";
import { createInMemoryTaskBackend, type InMemoryTaskBackend } from "../memory.js";
import {
  InMemoryTaskToolProvider,
  createTaskToolProvider,
  type TaskToolContext,
} from "../tool-provider.js";

describe("InMemoryTaskToolProvider", () => {
  let eventStore: EventStore;
  let backend: InMemoryTaskBackend;
  let provider: InMemoryTaskToolProvider;
  const testAgentId = "agent_test";

  const getContext = (): TaskToolContext => ({
    agent_id: testAgentId,
  });

  beforeEach(async () => {
    eventStore = await createEventStore({ inMemory: true });
    backend = createInMemoryTaskBackend(eventStore);
    provider = createTaskToolProvider(backend, getContext);
  });

  afterEach(async () => {
    await eventStore.close();
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Basic Tests
  // ─────────────────────────────────────────────────────────────────────────────

  describe("getTools", () => {
    it("should return all task tools", () => {
      const tools = provider.getTools();
      expect(tools.length).toBeGreaterThan(0);

      const toolNames = tools.map((t) => t.name);
      expect(toolNames).toContain("create_task");
      expect(toolNames).toContain("get_task");
      expect(toolNames).toContain("list_tasks");
      expect(toolNames).toContain("list_ready_tasks");
      expect(toolNames).toContain("get_task_blockers");
      expect(toolNames).toContain("update_task_status");
      expect(toolNames).toContain("add_blocker");
      expect(toolNames).toContain("remove_blocker");
      expect(toolNames).toContain("assign_task");
      expect(toolNames).toContain("complete_task");
    });

    it("should have valid schema for each tool", () => {
      const tools = provider.getTools();

      for (const tool of tools) {
        expect(tool.name).toBeDefined();
        expect(tool.description).toBeDefined();
        expect(tool.schema).toBeDefined();
        expect(tool.handler).toBeDefined();
        expect(typeof tool.handler).toBe("function");
      }
    });
  });

  describe("getExcludedTools", () => {
    it("should return excluded tool names", () => {
      const excluded = provider.getExcludedTools();
      expect(excluded).toContain("create_task");
      expect(excluded).toContain("get_task");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Tool Handler Tests
  // ─────────────────────────────────────────────────────────────────────────────

  describe("create_task handler", () => {
    it("should create a task", async () => {
      const tools = provider.getTools();
      const createTask = tools.find((t) => t.name === "create_task")!;

      const result = (await createTask.handler({
        description: "Test task",
      })) as { task_id: string; status: string };

      expect(result.task_id).toBeDefined();
      expect(result.status).toBe("pending");
    });

    it("should create a subtask with parent", async () => {
      const tools = provider.getTools();
      const createTask = tools.find((t) => t.name === "create_task")!;

      const parent = (await createTask.handler({
        description: "Parent task",
      })) as { task_id: string };

      const child = (await createTask.handler({
        description: "Child task",
        parent_task: parent.task_id,
      })) as { task_id: string };

      expect(child.task_id).toBeDefined();

      // Verify parent-child relationship
      const getTask = tools.find((t) => t.name === "get_task")!;
      const childDetails = (await getTask.handler({
        task_id: child.task_id,
      })) as { parent_task: string };

      expect(childDetails.parent_task).toBe(parent.task_id);
    });
  });

  describe("get_task handler", () => {
    it("should get task details", async () => {
      const tools = provider.getTools();
      const createTask = tools.find((t) => t.name === "create_task")!;
      const getTask = tools.find((t) => t.name === "get_task")!;

      const created = (await createTask.handler({
        description: "Test task",
      })) as { task_id: string };

      const result = (await getTask.handler({
        task_id: created.task_id,
      })) as { id: string; description: string; status: string };

      expect(result.id).toBe(created.task_id);
      expect(result.description).toBe("Test task");
      expect(result.status).toBe("pending");
    });

    it("should throw for non-existent task", async () => {
      const tools = provider.getTools();
      const getTask = tools.find((t) => t.name === "get_task")!;

      await expect(
        getTask.handler({ task_id: "nonexistent" })
      ).rejects.toThrow("Task not found");
    });
  });

  describe("list_tasks handler", () => {
    it("should list all tasks", async () => {
      const tools = provider.getTools();
      const createTask = tools.find((t) => t.name === "create_task")!;
      const listTasks = tools.find((t) => t.name === "list_tasks")!;

      await createTask.handler({ description: "Task 1" });
      await createTask.handler({ description: "Task 2" });

      const result = (await listTasks.handler({})) as {
        tasks: Array<{ id: string }>;
        total: number;
      };

      expect(result.tasks).toHaveLength(2);
      expect(result.total).toBe(2);
    });

    it("should filter by status", async () => {
      const tools = provider.getTools();
      const createTask = tools.find((t) => t.name === "create_task")!;
      const assignTask = tools.find((t) => t.name === "assign_task")!;
      const listTasks = tools.find((t) => t.name === "list_tasks")!;

      const task1 = (await createTask.handler({
        description: "Task 1",
      })) as { task_id: string };
      await createTask.handler({ description: "Task 2" });

      await assignTask.handler({ task_id: task1.task_id });

      const result = (await listTasks.handler({ status: "assigned" })) as {
        tasks: Array<{ id: string }>;
        total: number;
      };

      expect(result.tasks).toHaveLength(1);
      expect(result.tasks[0].id).toBe(task1.task_id);
    });
  });

  describe("list_ready_tasks handler", () => {
    it("should list only unblocked tasks", async () => {
      const tools = provider.getTools();
      const createTask = tools.find((t) => t.name === "create_task")!;
      const addBlocker = tools.find((t) => t.name === "add_blocker")!;
      const listReady = tools.find((t) => t.name === "list_ready_tasks")!;

      const task1 = (await createTask.handler({
        description: "Blocker task",
      })) as { task_id: string };
      const task2 = (await createTask.handler({
        description: "Blocked task",
      })) as { task_id: string };

      await addBlocker.handler({
        task_id: task2.task_id,
        blocker_id: task1.task_id,
      });

      const result = (await listReady.handler({})) as {
        tasks: Array<{ id: string }>;
        total: number;
      };

      // Only task1 should be ready
      expect(result.tasks).toHaveLength(1);
      expect(result.tasks[0].id).toBe(task1.task_id);
    });
  });

  describe("get_task_blockers handler", () => {
    it("should return blockers for a task", async () => {
      const tools = provider.getTools();
      const createTask = tools.find((t) => t.name === "create_task")!;
      const addBlocker = tools.find((t) => t.name === "add_blocker")!;
      const getBlockers = tools.find((t) => t.name === "get_task_blockers")!;

      const blocker = (await createTask.handler({
        description: "Blocker",
      })) as { task_id: string };
      const blocked = (await createTask.handler({
        description: "Blocked",
      })) as { task_id: string };

      await addBlocker.handler({
        task_id: blocked.task_id,
        blocker_id: blocker.task_id,
      });

      const result = (await getBlockers.handler({
        task_id: blocked.task_id,
      })) as {
        task_id: string;
        blockers: Array<{ id: string }>;
        isBlocked: boolean;
      };

      expect(result.blockers).toHaveLength(1);
      expect(result.blockers[0].id).toBe(blocker.task_id);
      expect(result.isBlocked).toBe(true);
    });
  });

  describe("add_blocker handler", () => {
    it("should add a blocker to a task", async () => {
      const tools = provider.getTools();
      const createTask = tools.find((t) => t.name === "create_task")!;
      const addBlocker = tools.find((t) => t.name === "add_blocker")!;
      const getTask = tools.find((t) => t.name === "get_task")!;

      const blocker = (await createTask.handler({
        description: "Blocker",
      })) as { task_id: string };
      const blocked = (await createTask.handler({
        description: "Blocked",
      })) as { task_id: string };

      const result = (await addBlocker.handler({
        task_id: blocked.task_id,
        blocker_id: blocker.task_id,
      })) as { added: boolean };

      expect(result.added).toBe(true);

      const taskDetails = (await getTask.handler({
        task_id: blocked.task_id,
      })) as { isBlocked: boolean; blockers: string[] };

      expect(taskDetails.isBlocked).toBe(true);
      expect(taskDetails.blockers).toContain(blocker.task_id);
    });
  });

  describe("remove_blocker handler", () => {
    it("should remove a blocker from a task", async () => {
      const tools = provider.getTools();
      const createTask = tools.find((t) => t.name === "create_task")!;
      const addBlocker = tools.find((t) => t.name === "add_blocker")!;
      const removeBlocker = tools.find((t) => t.name === "remove_blocker")!;
      const getTask = tools.find((t) => t.name === "get_task")!;

      const blocker = (await createTask.handler({
        description: "Blocker",
      })) as { task_id: string };
      const blocked = (await createTask.handler({
        description: "Blocked",
      })) as { task_id: string };

      await addBlocker.handler({
        task_id: blocked.task_id,
        blocker_id: blocker.task_id,
      });

      const result = (await removeBlocker.handler({
        task_id: blocked.task_id,
        blocker_id: blocker.task_id,
      })) as { removed: boolean };

      expect(result.removed).toBe(true);

      const taskDetails = (await getTask.handler({
        task_id: blocked.task_id,
      })) as { isBlocked: boolean; blockers: string[] };

      expect(taskDetails.isBlocked).toBe(false);
      expect(taskDetails.blockers).not.toContain(blocker.task_id);
    });
  });

  describe("assign_task handler", () => {
    it("should assign task to calling agent by default", async () => {
      const tools = provider.getTools();
      const createTask = tools.find((t) => t.name === "create_task")!;
      const assignTask = tools.find((t) => t.name === "assign_task")!;
      const getTask = tools.find((t) => t.name === "get_task")!;

      const task = (await createTask.handler({
        description: "Test task",
      })) as { task_id: string };

      const result = (await assignTask.handler({
        task_id: task.task_id,
      })) as { assigned_agent: string };

      expect(result.assigned_agent).toBe(testAgentId);

      const taskDetails = (await getTask.handler({
        task_id: task.task_id,
      })) as { assigned_agent: string; status: string };

      expect(taskDetails.assigned_agent).toBe(testAgentId);
      expect(taskDetails.status).toBe("assigned");
    });

    it("should assign task to specified agent", async () => {
      const tools = provider.getTools();
      const createTask = tools.find((t) => t.name === "create_task")!;
      const assignTask = tools.find((t) => t.name === "assign_task")!;

      const task = (await createTask.handler({
        description: "Test task",
      })) as { task_id: string };

      const result = (await assignTask.handler({
        task_id: task.task_id,
        agent_id: "agent_other",
      })) as { assigned_agent: string };

      expect(result.assigned_agent).toBe("agent_other");
    });
  });

  describe("complete_task handler", () => {
    it("should complete a task", async () => {
      const tools = provider.getTools();
      const createTask = tools.find((t) => t.name === "create_task")!;
      const completeTask = tools.find((t) => t.name === "complete_task")!;
      const getTask = tools.find((t) => t.name === "get_task")!;

      const task = (await createTask.handler({
        description: "Test task",
      })) as { task_id: string };

      // Start task first
      await backend.start(task.task_id);

      const result = (await completeTask.handler({
        task_id: task.task_id,
        summary: "Task completed successfully",
      })) as { completed: boolean };

      expect(result.completed).toBe(true);

      const taskDetails = (await getTask.handler({
        task_id: task.task_id,
      })) as { status: string };

      expect(taskDetails.status).toBe("completed");
    });
  });

  describe("update_task_status handler", () => {
    it("should update task status", async () => {
      const tools = provider.getTools();
      const createTask = tools.find((t) => t.name === "create_task")!;
      const updateStatus = tools.find((t) => t.name === "update_task_status")!;
      const getTask = tools.find((t) => t.name === "get_task")!;

      const task = (await createTask.handler({
        description: "Test task",
      })) as { task_id: string };

      const result = (await updateStatus.handler({
        task_id: task.task_id,
        status: "in_progress",
      })) as { status: string };

      expect(result.status).toBe("in_progress");

      const taskDetails = (await getTask.handler({
        task_id: task.task_id,
      })) as { status: string };

      expect(taskDetails.status).toBe("in_progress");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Error Handling Tests
  // ─────────────────────────────────────────────────────────────────────────────

  describe("error handling", () => {
    it("get_task should throw for non-existent task", async () => {
      const tools = provider.getTools();
      const getTask = tools.find((t) => t.name === "get_task")!;

      await expect(
        getTask.handler({ task_id: "task_invalid" })
      ).rejects.toThrow("Task not found");
    });

    it("assign_task should throw for non-existent task", async () => {
      const tools = provider.getTools();
      const assignTask = tools.find((t) => t.name === "assign_task")!;

      await expect(
        assignTask.handler({ task_id: "task_invalid" })
      ).rejects.toThrow();
    });

    it("complete_task should throw for non-existent task", async () => {
      const tools = provider.getTools();
      const completeTask = tools.find((t) => t.name === "complete_task")!;

      await expect(
        completeTask.handler({ task_id: "task_invalid" })
      ).rejects.toThrow();
    });

    it("add_blocker should throw for non-existent task", async () => {
      const tools = provider.getTools();
      const addBlocker = tools.find((t) => t.name === "add_blocker")!;

      await expect(
        addBlocker.handler({
          task_id: "task_invalid",
          blocker_id: "task_also_invalid",
        })
      ).rejects.toThrow();
    });

    it("remove_blocker should throw for non-existent task", async () => {
      const tools = provider.getTools();
      const removeBlocker = tools.find((t) => t.name === "remove_blocker")!;

      await expect(
        removeBlocker.handler({
          task_id: "task_invalid",
          blocker_id: "task_also_invalid",
        })
      ).rejects.toThrow();
    });

    it("get_task_blockers should throw for non-existent task", async () => {
      const tools = provider.getTools();
      const getBlockers = tools.find((t) => t.name === "get_task_blockers")!;

      await expect(
        getBlockers.handler({ task_id: "task_invalid" })
      ).rejects.toThrow();
    });

    it("update_task_status should throw for non-existent task", async () => {
      const tools = provider.getTools();
      const updateStatus = tools.find((t) => t.name === "update_task_status")!;

      await expect(
        updateStatus.handler({ task_id: "task_invalid", status: "in_progress" })
      ).rejects.toThrow();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Edge Case Tests
  // ─────────────────────────────────────────────────────────────────────────────

  describe("edge cases", () => {
    it("list_tasks should return empty array when no tasks exist", async () => {
      const tools = provider.getTools();
      const listTasks = tools.find((t) => t.name === "list_tasks")!;

      const result = (await listTasks.handler({})) as {
        tasks: Array<{ id: string }>;
        total: number;
      };

      expect(result.tasks).toEqual([]);
      expect(result.total).toBe(0);
    });

    it("list_ready_tasks should return empty array when no tasks exist", async () => {
      const tools = provider.getTools();
      const listReady = tools.find((t) => t.name === "list_ready_tasks")!;

      const result = (await listReady.handler({})) as {
        tasks: Array<{ id: string }>;
        total: number;
      };

      expect(result.tasks).toEqual([]);
      expect(result.total).toBe(0);
    });

    it("get_task_blockers should return empty array for unblocked task", async () => {
      const tools = provider.getTools();
      const createTask = tools.find((t) => t.name === "create_task")!;
      const getBlockers = tools.find((t) => t.name === "get_task_blockers")!;

      const task = (await createTask.handler({
        description: "Unblocked task",
      })) as { task_id: string };

      const result = (await getBlockers.handler({
        task_id: task.task_id,
      })) as {
        blockers: Array<{ id: string }>;
        isBlocked: boolean;
      };

      expect(result.blockers).toEqual([]);
      expect(result.isBlocked).toBe(false);
    });

    it("create_task should include created_at timestamp", async () => {
      const tools = provider.getTools();
      const createTask = tools.find((t) => t.name === "create_task")!;

      const result = (await createTask.handler({
        description: "Task with timestamp",
      })) as { task_id: string; created_at: number };

      expect(result.created_at).toBeDefined();
      expect(typeof result.created_at).toBe("number");
    });

    it("get_task should return all expected fields", async () => {
      const tools = provider.getTools();
      const createTask = tools.find((t) => t.name === "create_task")!;
      const getTask = tools.find((t) => t.name === "get_task")!;

      const created = (await createTask.handler({
        description: "Full details task",
      })) as { task_id: string };

      const result = (await getTask.handler({
        task_id: created.task_id,
      })) as Record<string, unknown>;

      expect(result).toHaveProperty("id");
      expect(result).toHaveProperty("description");
      expect(result).toHaveProperty("status");
      expect(result).toHaveProperty("isBlocked");
      expect(result).toHaveProperty("blockers");
      expect(result).toHaveProperty("created_at");
    });

    it("list_tasks should include isBlocked field", async () => {
      const tools = provider.getTools();
      const createTask = tools.find((t) => t.name === "create_task")!;
      const listTasks = tools.find((t) => t.name === "list_tasks")!;

      await createTask.handler({ description: "Task" });

      const result = (await listTasks.handler({ include_blocked: true })) as {
        tasks: Array<{ id: string; isBlocked: boolean }>;
      };

      expect(result.tasks[0]).toHaveProperty("isBlocked");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Complex Filter Tests
  // ─────────────────────────────────────────────────────────────────────────────

  describe("complex filtering", () => {
    it("list_tasks should filter by parent_task", async () => {
      const tools = provider.getTools();
      const createTask = tools.find((t) => t.name === "create_task")!;
      const listTasks = tools.find((t) => t.name === "list_tasks")!;

      const parent = (await createTask.handler({
        description: "Parent",
      })) as { task_id: string };

      await createTask.handler({
        description: "Child 1",
        parent_task: parent.task_id,
      });
      await createTask.handler({
        description: "Child 2",
        parent_task: parent.task_id,
      });
      await createTask.handler({ description: "Orphan" });

      const result = (await listTasks.handler({
        parent_task: parent.task_id,
        include_blocked: true,
      })) as {
        tasks: Array<{ id: string }>;
        total: number;
      };

      expect(result.total).toBe(2);
    });

    it("list_tasks should filter root_only tasks", async () => {
      const tools = provider.getTools();
      const createTask = tools.find((t) => t.name === "create_task")!;
      const listTasks = tools.find((t) => t.name === "list_tasks")!;

      const parent = (await createTask.handler({
        description: "Parent",
      })) as { task_id: string };

      await createTask.handler({
        description: "Child",
        parent_task: parent.task_id,
      });

      const result = (await listTasks.handler({
        root_only: true,
        include_blocked: true,
      })) as {
        tasks: Array<{ id: string }>;
        total: number;
      };

      expect(result.total).toBe(1);
      expect(result.tasks[0].id).toBe(parent.task_id);
    });

    it("list_tasks should filter by assigned_agent", async () => {
      const tools = provider.getTools();
      const createTask = tools.find((t) => t.name === "create_task")!;
      const assignTask = tools.find((t) => t.name === "assign_task")!;
      const listTasks = tools.find((t) => t.name === "list_tasks")!;

      const task1 = (await createTask.handler({
        description: "Task 1",
      })) as { task_id: string };
      const task2 = (await createTask.handler({
        description: "Task 2",
      })) as { task_id: string };
      await createTask.handler({ description: "Task 3" });

      await assignTask.handler({ task_id: task1.task_id, agent_id: "agent_a" });
      await assignTask.handler({ task_id: task2.task_id, agent_id: "agent_b" });

      const result = (await listTasks.handler({
        assigned_agent: "agent_a",
        include_blocked: true,
      })) as {
        tasks: Array<{ id: string }>;
        total: number;
      };

      expect(result.total).toBe(1);
      expect(result.tasks[0].id).toBe(task1.task_id);
    });

    it("list_ready_tasks should filter by assigned_agent", async () => {
      const tools = provider.getTools();
      const createTask = tools.find((t) => t.name === "create_task")!;
      const assignTask = tools.find((t) => t.name === "assign_task")!;
      const listReady = tools.find((t) => t.name === "list_ready_tasks")!;

      const task1 = (await createTask.handler({
        description: "Task 1",
      })) as { task_id: string };
      await createTask.handler({ description: "Task 2" });

      await assignTask.handler({ task_id: task1.task_id, agent_id: "agent_a" });

      const result = (await listReady.handler({
        assigned_agent: "agent_a",
      })) as {
        tasks: Array<{ id: string }>;
        total: number;
      };

      expect(result.total).toBe(1);
      expect(result.tasks[0].id).toBe(task1.task_id);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Context Switching Tests
  // ─────────────────────────────────────────────────────────────────────────────

  describe("context switching", () => {
    it("should use different agent contexts", async () => {
      let currentAgent = "agent_a";
      const dynamicContext = () => ({ agent_id: currentAgent });
      const dynamicProvider = createTaskToolProvider(backend, dynamicContext);
      const tools = dynamicProvider.getTools();
      const createTask = tools.find((t) => t.name === "create_task")!;
      const getTask = tools.find((t) => t.name === "get_task")!;

      // Create task as agent_a
      const task1 = (await createTask.handler({
        description: "Task by A",
      })) as { task_id: string };

      // Switch to agent_b
      currentAgent = "agent_b";

      // Create task as agent_b
      const task2 = (await createTask.handler({
        description: "Task by B",
      })) as { task_id: string };

      // Verify created_by is different
      const details1 = await backend.get(task1.task_id);
      const details2 = await backend.get(task2.task_id);

      expect(details1!.created_by).toBe("agent_a");
      expect(details2!.created_by).toBe("agent_b");
    });

    it("assign_task should default to current context agent", async () => {
      let currentAgent = "agent_context";
      const dynamicContext = () => ({ agent_id: currentAgent });
      const dynamicProvider = createTaskToolProvider(backend, dynamicContext);
      const tools = dynamicProvider.getTools();
      const createTask = tools.find((t) => t.name === "create_task")!;
      const assignTask = tools.find((t) => t.name === "assign_task")!;

      const task = (await createTask.handler({
        description: "Task",
      })) as { task_id: string };

      const result = (await assignTask.handler({
        task_id: task.task_id,
      })) as { assigned_agent: string };

      expect(result.assigned_agent).toBe("agent_context");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Full Workflow Integration Tests
  // ─────────────────────────────────────────────────────────────────────────────

  describe("full workflow integration", () => {
    it("should handle complete task lifecycle via tools", async () => {
      const tools = provider.getTools();
      const createTask = tools.find((t) => t.name === "create_task")!;
      const assignTask = tools.find((t) => t.name === "assign_task")!;
      const updateStatus = tools.find((t) => t.name === "update_task_status")!;
      const completeTask = tools.find((t) => t.name === "complete_task")!;
      const getTask = tools.find((t) => t.name === "get_task")!;

      // Create
      const task = (await createTask.handler({
        description: "Lifecycle test task",
      })) as { task_id: string };

      // Assign
      await assignTask.handler({ task_id: task.task_id });

      // Start
      await updateStatus.handler({
        task_id: task.task_id,
        status: "in_progress",
      });

      // Complete
      await completeTask.handler({
        task_id: task.task_id,
        summary: "Done!",
      });

      // Verify
      const details = (await getTask.handler({
        task_id: task.task_id,
      })) as { status: string; completed_at: number };

      expect(details.status).toBe("completed");
      expect(details.completed_at).toBeDefined();
    });

    it("should handle dependency-based workflow via tools", async () => {
      const tools = provider.getTools();
      const createTask = tools.find((t) => t.name === "create_task")!;
      const addBlocker = tools.find((t) => t.name === "add_blocker")!;
      const listReady = tools.find((t) => t.name === "list_ready_tasks")!;
      const updateStatus = tools.find((t) => t.name === "update_task_status")!;
      const completeTask = tools.find((t) => t.name === "complete_task")!;

      // Create tasks with dependencies
      const taskA = (await createTask.handler({
        description: "Task A (first)",
      })) as { task_id: string };
      const taskB = (await createTask.handler({
        description: "Task B (depends on A)",
      })) as { task_id: string };
      const taskC = (await createTask.handler({
        description: "Task C (depends on B)",
      })) as { task_id: string };

      await addBlocker.handler({
        task_id: taskB.task_id,
        blocker_id: taskA.task_id,
      });
      await addBlocker.handler({
        task_id: taskC.task_id,
        blocker_id: taskB.task_id,
      });

      // Only A should be ready
      let ready = (await listReady.handler({})) as {
        tasks: Array<{ id: string }>;
      };
      expect(ready.tasks).toHaveLength(1);
      expect(ready.tasks[0].id).toBe(taskA.task_id);

      // Complete A
      await updateStatus.handler({
        task_id: taskA.task_id,
        status: "in_progress",
      });
      await completeTask.handler({ task_id: taskA.task_id });

      // Now B should be ready
      ready = (await listReady.handler({})) as {
        tasks: Array<{ id: string }>;
      };
      expect(ready.tasks).toHaveLength(1);
      expect(ready.tasks[0].id).toBe(taskB.task_id);

      // Complete B
      await updateStatus.handler({
        task_id: taskB.task_id,
        status: "in_progress",
      });
      await completeTask.handler({ task_id: taskB.task_id });

      // Now C should be ready
      ready = (await listReady.handler({})) as {
        tasks: Array<{ id: string }>;
      };
      expect(ready.tasks).toHaveLength(1);
      expect(ready.tasks[0].id).toBe(taskC.task_id);
    });

    it("should handle parent-child task relationships via tools", async () => {
      const tools = provider.getTools();
      const createTask = tools.find((t) => t.name === "create_task")!;
      const listTasks = tools.find((t) => t.name === "list_tasks")!;
      const getTask = tools.find((t) => t.name === "get_task")!;

      // Create parent
      const parent = (await createTask.handler({
        description: "Parent task",
      })) as { task_id: string };

      // Create children
      const child1 = (await createTask.handler({
        description: "Child 1",
        parent_task: parent.task_id,
      })) as { task_id: string };
      const child2 = (await createTask.handler({
        description: "Child 2",
        parent_task: parent.task_id,
      })) as { task_id: string };

      // Verify parent-child relationships
      const parentDetails = (await getTask.handler({
        task_id: parent.task_id,
      })) as { id: string };
      const child1Details = (await getTask.handler({
        task_id: child1.task_id,
      })) as { parent_task: string };
      const child2Details = (await getTask.handler({
        task_id: child2.task_id,
      })) as { parent_task: string };

      expect(child1Details.parent_task).toBe(parent.task_id);
      expect(child2Details.parent_task).toBe(parent.task_id);

      // Filter by parent
      const children = (await listTasks.handler({
        parent_task: parent.task_id,
        include_blocked: true,
      })) as {
        tasks: Array<{ id: string }>;
        total: number;
      };

      expect(children.total).toBe(2);
    });

    it("should handle blocker completion unblocking workflow", async () => {
      const tools = provider.getTools();
      const createTask = tools.find((t) => t.name === "create_task")!;
      const addBlocker = tools.find((t) => t.name === "add_blocker")!;
      const getBlockers = tools.find((t) => t.name === "get_task_blockers")!;
      const updateStatus = tools.find((t) => t.name === "update_task_status")!;
      const completeTask = tools.find((t) => t.name === "complete_task")!;

      const blocker = (await createTask.handler({
        description: "Blocker",
      })) as { task_id: string };
      const blocked = (await createTask.handler({
        description: "Blocked",
      })) as { task_id: string };

      await addBlocker.handler({
        task_id: blocked.task_id,
        blocker_id: blocker.task_id,
      });

      // Initially blocked
      let blockerStatus = (await getBlockers.handler({
        task_id: blocked.task_id,
      })) as { isBlocked: boolean; blockers: Array<{ isCompleted: boolean }> };

      expect(blockerStatus.isBlocked).toBe(true);
      expect(blockerStatus.blockers[0].isCompleted).toBe(false);

      // Complete blocker
      await updateStatus.handler({
        task_id: blocker.task_id,
        status: "in_progress",
      });
      await completeTask.handler({ task_id: blocker.task_id });

      // Now unblocked
      blockerStatus = (await getBlockers.handler({
        task_id: blocked.task_id,
      })) as { isBlocked: boolean; blockers: Array<{ isCompleted: boolean }> };

      expect(blockerStatus.isBlocked).toBe(false);
      expect(blockerStatus.blockers[0].isCompleted).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Schema Validation Tests
  // ─────────────────────────────────────────────────────────────────────────────

  describe("schema structure", () => {
    it("each tool should have proper JSON schema structure", () => {
      const tools = provider.getTools();

      for (const tool of tools) {
        expect(tool.schema).toHaveProperty("type");
        expect(tool.schema.type).toBe("object");
        expect(tool.schema).toHaveProperty("properties");
      }
    });

    it("required fields should be specified in schema", () => {
      const tools = provider.getTools();

      const toolsWithRequired = ["create_task", "get_task", "get_task_blockers"];

      for (const toolName of toolsWithRequired) {
        const tool = tools.find((t) => t.name === toolName)!;
        expect(tool.schema).toHaveProperty("required");
      }
    });
  });
});
