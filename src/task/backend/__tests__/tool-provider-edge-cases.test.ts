/**
 * Tool Provider Edge Case Tests
 *
 * Tests for edge cases in the InMemoryTaskToolProvider.
 *
 * @module task/backend/__tests__/tool-provider-edge-cases.test
 * @see s-8472 Pluggable Task Backend Integration
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createEventStore, type EventStore } from "../../../store/event-store.js";
import { createInMemoryTaskBackend, InMemoryTaskBackend } from "../memory.js";
import {
  InMemoryTaskToolProvider,
  createTaskToolProvider,
  type TaskToolContext,
} from "../tool-provider.js";

describe("InMemoryTaskToolProvider Edge Cases", () => {
  let eventStore: EventStore;
  let backend: InMemoryTaskBackend;
  let toolProvider: InMemoryTaskToolProvider;
  const testAgentId = "agent_test";

  beforeEach(async () => {
    eventStore = await createEventStore({ inMemory: true });
    backend = createInMemoryTaskBackend(eventStore);
    toolProvider = createTaskToolProvider(backend, () => ({
      agent_id: testAgentId,
    }));
  });

  afterEach(async () => {
    await eventStore.close();
  });

  function getToolByName(name: string) {
    const tools = toolProvider.getTools();
    return tools.find((t) => t.name === name);
  }

  describe("list_tasks include_blocked default behavior", () => {
    it("should have consistent include_blocked behavior", async () => {
      // Create blocker and blocked tasks
      const createTool = getToolByName("create_task")!;
      const listTool = getToolByName("list_tasks")!;
      const addBlockerTool = getToolByName("add_blocker")!;

      const blocker = (await createTool.handler({
        description: "Blocker",
      })) as { task_id: string };
      const blocked = (await createTool.handler({
        description: "Blocked",
      })) as { task_id: string };

      await addBlockerTool.handler({
        task_id: blocked.task_id,
        blocker_id: blocker.task_id,
      });

      // Default list_tasks (include_blocked not specified)
      const defaultResult = (await listTool.handler({})) as {
        tasks: { id: string }[];
        total: number;
      };

      // The tool description says "Include blocked tasks (default: true)"
      // but the backend defaults to excluding blocked tasks
      // This creates confusion about expected behavior

      // Current behavior: blocked tasks are excluded by default
      // because includeBlocked is undefined, which backend treats as false
      expect(defaultResult.tasks.find((t) => t.id === blocked.task_id)).toBeUndefined();

      // Explicit include_blocked: true
      const includedResult = (await listTool.handler({
        include_blocked: true,
      })) as { tasks: { id: string }[]; total: number };
      expect(includedResult.tasks.find((t) => t.id === blocked.task_id)).toBeDefined();

      // Explicit include_blocked: false
      const excludedResult = (await listTool.handler({
        include_blocked: false,
      })) as { tasks: { id: string }[]; total: number };
      expect(excludedResult.tasks.find((t) => t.id === blocked.task_id)).toBeUndefined();
    });
  });

  describe("complete_task without start", () => {
    it("should fail if task not started first", async () => {
      const createTool = getToolByName("create_task")!;
      const completeTool = getToolByName("complete_task")!;

      const task = (await createTool.handler({
        description: "Test",
      })) as { task_id: string };

      // Try to complete without starting
      await expect(
        completeTool.handler({ task_id: task.task_id })
      ).rejects.toThrow("Invalid status transition");
    });
  });

  describe("complete_task from assigned state", () => {
    it("should fail if only assigned (not in_progress)", async () => {
      const createTool = getToolByName("create_task")!;
      const assignTool = getToolByName("assign_task")!;
      const completeTool = getToolByName("complete_task")!;

      const task = (await createTool.handler({
        description: "Test",
      })) as { task_id: string };

      await assignTool.handler({ task_id: task.task_id });

      // Try to complete from assigned state
      await expect(
        completeTool.handler({ task_id: task.task_id })
      ).rejects.toThrow("Invalid status transition");
    });
  });

  describe("missing tools", () => {
    it("should NOT have a start_task tool", () => {
      // Note: There's no start_task tool, you have to use update_task_status
      const startTool = getToolByName("start_task");
      expect(startTool).toBeUndefined();
    });

    it("should NOT have an unassign_task tool", () => {
      // Note: There's no unassign_task tool, even though backend supports it
      const unassignTool = getToolByName("unassign_task");
      expect(unassignTool).toBeUndefined();
    });

    it("should NOT have a fail_task tool", () => {
      // Note: There's no fail_task tool
      const failTool = getToolByName("fail_task");
      expect(failTool).toBeUndefined();
    });

    it("should NOT have a delete_task tool", () => {
      // Note: There's no delete_task tool
      const deleteTool = getToolByName("delete_task");
      expect(deleteTool).toBeUndefined();
    });

    it("should NOT have a get_subtask_status tool", () => {
      // Note: There's no get_subtask_status tool
      const subtaskTool = getToolByName("get_subtask_status");
      expect(subtaskTool).toBeUndefined();
    });
  });

  describe("update_task_status validation", () => {
    it("should reject invalid status transitions", async () => {
      const createTool = getToolByName("create_task")!;
      const updateTool = getToolByName("update_task_status")!;

      const task = (await createTool.handler({
        description: "Test",
      })) as { task_id: string };

      // pending -> completed is invalid (must go through in_progress)
      await expect(
        updateTool.handler({ task_id: task.task_id, status: "completed" })
      ).rejects.toThrow("Invalid status transition");
    });

    it("should allow pending -> in_progress", async () => {
      const createTool = getToolByName("create_task")!;
      const updateTool = getToolByName("update_task_status")!;
      const getTool = getToolByName("get_task")!;

      const task = (await createTool.handler({
        description: "Test",
      })) as { task_id: string };

      await updateTool.handler({
        task_id: task.task_id,
        status: "in_progress",
      });

      const result = (await getTool.handler({
        task_id: task.task_id,
      })) as { status: string };
      expect(result.status).toBe("in_progress");
    });

    it("should allow pending -> assigned via assign_task", async () => {
      const createTool = getToolByName("create_task")!;
      const assignTool = getToolByName("assign_task")!;
      const getTool = getToolByName("get_task")!;

      const task = (await createTool.handler({
        description: "Test",
      })) as { task_id: string };

      await assignTool.handler({ task_id: task.task_id });

      const result = (await getTool.handler({
        task_id: task.task_id,
      })) as { status: string; assigned_agent: string };
      expect(result.status).toBe("assigned");
      expect(result.assigned_agent).toBe(testAgentId);
    });
  });

  describe("add_blocker error handling", () => {
    it("should fail for non-existent task", async () => {
      const createTool = getToolByName("create_task")!;
      const addBlockerTool = getToolByName("add_blocker")!;

      const blocker = (await createTool.handler({
        description: "Blocker",
      })) as { task_id: string };

      await expect(
        addBlockerTool.handler({
          task_id: "task_nonexistent",
          blocker_id: blocker.task_id,
        })
      ).rejects.toThrow();
    });

    it("should fail for non-existent blocker", async () => {
      const createTool = getToolByName("create_task")!;
      const addBlockerTool = getToolByName("add_blocker")!;

      const task = (await createTool.handler({
        description: "Task",
      })) as { task_id: string };

      await expect(
        addBlockerTool.handler({
          task_id: task.task_id,
          blocker_id: "task_nonexistent",
        })
      ).rejects.toThrow();
    });
  });

  describe("get_task_blockers response format", () => {
    it("should return isBlocked based on blocker statuses", async () => {
      const createTool = getToolByName("create_task")!;
      const addBlockerTool = getToolByName("add_blocker")!;
      const getBlockersTool = getToolByName("get_task_blockers")!;
      const updateTool = getToolByName("update_task_status")!;

      const blocker = (await createTool.handler({
        description: "Blocker",
      })) as { task_id: string };
      const task = (await createTool.handler({
        description: "Task",
      })) as { task_id: string };

      await addBlockerTool.handler({
        task_id: task.task_id,
        blocker_id: blocker.task_id,
      });

      // Check blockers while blocker is pending
      const beforeComplete = (await getBlockersTool.handler({
        task_id: task.task_id,
      })) as { isBlocked: boolean; blockers: { isCompleted: boolean }[] };

      expect(beforeComplete.isBlocked).toBe(true);
      expect(beforeComplete.blockers[0].isCompleted).toBe(false);

      // Complete the blocker
      await updateTool.handler({
        task_id: blocker.task_id,
        status: "in_progress",
      });
      await backend.complete(blocker.task_id);

      // Check blockers after completion
      const afterComplete = (await getBlockersTool.handler({
        task_id: task.task_id,
      })) as { isBlocked: boolean; blockers: { isCompleted: boolean }[] };

      expect(afterComplete.isBlocked).toBe(false);
      expect(afterComplete.blockers[0].isCompleted).toBe(true);
    });
  });

  describe("list_ready_tasks filtering", () => {
    it("should only return pending/assigned tasks", async () => {
      const createTool = getToolByName("create_task")!;
      const listReadyTool = getToolByName("list_ready_tasks")!;
      const updateTool = getToolByName("update_task_status")!;

      // Create tasks in various states
      const pending = (await createTool.handler({
        description: "Pending",
      })) as { task_id: string };

      const inProgress = (await createTool.handler({
        description: "In Progress",
      })) as { task_id: string };
      await updateTool.handler({
        task_id: inProgress.task_id,
        status: "in_progress",
      });

      const completed = (await createTool.handler({
        description: "Completed",
      })) as { task_id: string };
      await updateTool.handler({
        task_id: completed.task_id,
        status: "in_progress",
      });
      await backend.complete(completed.task_id);

      const ready = (await listReadyTool.handler({})) as {
        tasks: { id: string; description: string }[];
      };

      // Should only have pending task
      expect(ready.tasks.length).toBe(1);
      expect(ready.tasks[0].id).toBe(pending.task_id);
    });
  });

  describe("create_task with external_id", () => {
    it("should pass external_id to backend", async () => {
      const createTool = getToolByName("create_task")!;
      const getTool = getToolByName("get_task")!;

      const task = (await createTool.handler({
        description: "External task",
        external_id: "i-test123",
      })) as { task_id: string };

      // Note: The response doesn't include external_id
      // But get_task also doesn't include external_id in response
      // This could be a gap - how do users know what external_id is bound?
      const fetched = (await getTool.handler({
        task_id: task.task_id,
      })) as Record<string, unknown>;

      // external_id is not in the get_task response
      expect(fetched.external_id).toBeUndefined();
      // It's stored in outputs if you check there
      expect((fetched.outputs as Record<string, unknown>)?.external_id).toBeUndefined();
    });
  });

  describe("assign_task with agent_id parameter", () => {
    it("should use provided agent_id", async () => {
      const createTool = getToolByName("create_task")!;
      const assignTool = getToolByName("assign_task")!;
      const getTool = getToolByName("get_task")!;

      const task = (await createTool.handler({
        description: "Test",
      })) as { task_id: string };

      await assignTool.handler({
        task_id: task.task_id,
        agent_id: "other_agent",
      });

      const fetched = (await getTool.handler({
        task_id: task.task_id,
      })) as { assigned_agent: string };

      expect(fetched.assigned_agent).toBe("other_agent");
    });

    it("should default to context agent_id if not provided", async () => {
      const createTool = getToolByName("create_task")!;
      const assignTool = getToolByName("assign_task")!;
      const getTool = getToolByName("get_task")!;

      const task = (await createTool.handler({
        description: "Test",
      })) as { task_id: string };

      await assignTool.handler({ task_id: task.task_id });

      const fetched = (await getTool.handler({
        task_id: task.task_id,
      })) as { assigned_agent: string };

      expect(fetched.assigned_agent).toBe(testAgentId);
    });
  });

  describe("complete_task with outputs", () => {
    it("should store summary and outputs", async () => {
      const createTool = getToolByName("create_task")!;
      const updateTool = getToolByName("update_task_status")!;
      const completeTool = getToolByName("complete_task")!;
      const getTool = getToolByName("get_task")!;

      const task = (await createTool.handler({
        description: "Test",
      })) as { task_id: string };

      await updateTool.handler({
        task_id: task.task_id,
        status: "in_progress",
      });

      await completeTool.handler({
        task_id: task.task_id,
        summary: "Work completed",
        outputs: { result: "success", count: 42 },
      });

      const fetched = (await getTool.handler({
        task_id: task.task_id,
      })) as { status: string; outputs: Record<string, unknown> };

      expect(fetched.status).toBe("completed");
      expect(fetched.outputs?.result).toBe("success");
      expect(fetched.outputs?.count).toBe(42);
    });
  });

  describe("getExcludedTools", () => {
    it("should return correct excluded tools", () => {
      const excluded = toolProvider.getExcludedTools();
      expect(excluded).toContain("create_task");
      expect(excluded).toContain("get_task");
    });
  });
});
