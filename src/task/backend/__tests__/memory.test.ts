/**
 * Tests for InMemoryTaskBackend
 *
 * @module task/backend/__tests__/memory.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createEventStore, type EventStore } from "../../../store/event-store.js";
import {
  InMemoryTaskBackend,
  createInMemoryTaskBackend,
  TaskBackendError,
} from "../memory.js";
import type { ExtendedTask, TaskChangeEvent } from "../types.js";

describe("InMemoryTaskBackend", () => {
  let eventStore: EventStore;
  let backend: InMemoryTaskBackend;
  const testAgentId = "agent_test123";

  beforeEach(async () => {
    eventStore = await createEventStore({ inMemory: true });
    backend = createInMemoryTaskBackend(eventStore);
  });

  afterEach(async () => {
    await eventStore.close();
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Lifecycle Tests
  // ─────────────────────────────────────────────────────────────────────────────

  describe("create", () => {
    it("should create a task with pending status", async () => {
      const task = await backend.create({
        description: "Test task",
        created_by: testAgentId,
      });

      expect(task.id).toMatch(/^task_/);
      expect(task.description).toBe("Test task");
      expect(task.status).toBe("pending");
      expect(task.created_by).toBe(testAgentId);
      expect(task.isBlocked).toBe(false);
    });

    it("should create a subtask with parent reference", async () => {
      const parent = await backend.create({
        description: "Parent task",
        created_by: testAgentId,
      });

      const child = await backend.create({
        description: "Child task",
        created_by: testAgentId,
        parent_task: parent.id,
      });

      expect(child.parent_task).toBe(parent.id);

      // Verify parent's subtasks array is updated
      const updatedParent = await backend.get(parent.id);
      expect(updatedParent?.subtasks).toContain(child.id);
    });

    it("should throw error for non-existent parent", async () => {
      await expect(
        backend.create({
          description: "Orphan task",
          created_by: testAgentId,
          parent_task: "task_nonexistent",
        })
      ).rejects.toThrow(TaskBackendError);
    });
  });

  describe("get", () => {
    it("should return task with isBlocked computed", async () => {
      const task = await backend.create({
        description: "Test task",
        created_by: testAgentId,
      });

      const retrieved = await backend.get(task.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.isBlocked).toBe(false);
    });

    it("should return null for non-existent task", async () => {
      const result = await backend.get("task_nonexistent");
      expect(result).toBeNull();
    });
  });

  describe("update", () => {
    it("should update task outputs", async () => {
      const task = await backend.create({
        description: "Test task",
        created_by: testAgentId,
      });

      const updated = await backend.update(task.id, {
        outputs: { result: "success" },
      });

      expect(updated.outputs).toEqual({ result: "success" });
    });

    it("should update task description", async () => {
      const task = await backend.create({
        description: "Original",
        created_by: testAgentId,
      });

      const updated = await backend.update(task.id, {
        description: "Updated description",
      });

      expect(updated.description).toBe("Updated description");
    });

    it("should throw error for non-existent task", async () => {
      await expect(
        backend.update("task_nonexistent", { description: "test" })
      ).rejects.toThrow(TaskBackendError);
    });
  });

  describe("delete", () => {
    it("should throw not supported error", async () => {
      const task = await backend.create({
        description: "Test task",
        created_by: testAgentId,
      });

      await expect(backend.delete(task.id)).rejects.toThrow("not supported");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Status Transition Tests
  // ─────────────────────────────────────────────────────────────────────────────

  describe("assign", () => {
    it("should assign agent to task", async () => {
      const task = await backend.create({
        description: "Test task",
        created_by: testAgentId,
      });

      await backend.assign(task.id, "agent_worker");

      const updated = await backend.get(task.id);
      expect(updated!.status).toBe("assigned");
      expect(updated!.assigned_agent).toBe("agent_worker");
    });

    it("should add to agent history", async () => {
      const task = await backend.create({
        description: "Test task",
        created_by: testAgentId,
      });

      await backend.assign(task.id, "agent_worker", { role: "implementer" });

      const history = await backend.getAgentHistory(task.id);
      expect(history).toHaveLength(1);
      expect(history[0].agent_id).toBe("agent_worker");
      expect(history[0].role).toBe("implementer");
    });
  });

  describe("unassign", () => {
    it("should unassign agent from task", async () => {
      const task = await backend.create({
        description: "Test task",
        created_by: testAgentId,
      });

      await backend.assign(task.id, "agent_worker");
      await backend.unassign(task.id);

      const updated = await backend.get(task.id);
      expect(updated!.assigned_agent).toBeUndefined();
    });

    it("should throw error if task not assigned", async () => {
      const task = await backend.create({
        description: "Test task",
        created_by: testAgentId,
      });

      await expect(backend.unassign(task.id)).rejects.toThrow(
        "Task is not assigned"
      );
    });
  });

  describe("start", () => {
    it("should transition to in_progress", async () => {
      const task = await backend.create({
        description: "Test task",
        created_by: testAgentId,
      });

      await backend.start(task.id);

      const updated = await backend.get(task.id);
      expect(updated!.status).toBe("in_progress");
      expect(updated!.started_at).toBeDefined();
    });

    it("should throw error for invalid transition", async () => {
      const task = await backend.create({
        description: "Test task",
        created_by: testAgentId,
      });

      await backend.start(task.id);
      await backend.complete(task.id);

      await expect(backend.start(task.id)).rejects.toThrow(
        "Invalid status transition"
      );
    });
  });

  describe("complete", () => {
    it("should mark task as completed", async () => {
      const task = await backend.create({
        description: "Test task",
        created_by: testAgentId,
      });

      await backend.start(task.id);
      await backend.complete(task.id, {
        summary: "Done",
        data: { result: "success" },
      });

      const updated = await backend.get(task.id);
      expect(updated!.status).toBe("completed");
      expect(updated!.completed_at).toBeDefined();
    });
  });

  describe("fail", () => {
    it("should mark task as failed with error info", async () => {
      const task = await backend.create({
        description: "Test task",
        created_by: testAgentId,
      });

      await backend.start(task.id);
      await backend.fail(task.id, {
        message: "Something went wrong",
        code: "TEST_ERROR",
      });

      const updated = await backend.get(task.id);
      expect(updated!.status).toBe("failed");
      expect(updated!.outputs?.error).toBeDefined();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Query Tests
  // ─────────────────────────────────────────────────────────────────────────────

  describe("list", () => {
    it("should filter by status", async () => {
      await backend.create({ description: "Task 1", created_by: testAgentId });
      const task2 = await backend.create({
        description: "Task 2",
        created_by: testAgentId,
      });
      await backend.start(task2.id);

      const pending = await backend.list({ status: "pending" });
      expect(pending).toHaveLength(1);
      expect(pending[0].description).toBe("Task 1");

      const inProgress = await backend.list({ status: "in_progress" });
      expect(inProgress).toHaveLength(1);
      expect(inProgress[0].description).toBe("Task 2");
    });

    it("should filter by assigned agent", async () => {
      const task1 = await backend.create({
        description: "Task 1",
        created_by: testAgentId,
      });
      const task2 = await backend.create({
        description: "Task 2",
        created_by: testAgentId,
      });

      await backend.assign(task1.id, "agent_a");
      await backend.assign(task2.id, "agent_b");

      const agentATasks = await backend.list({
        assigned_agent: "agent_a",
        includeBlocked: true,
      });
      expect(agentATasks).toHaveLength(1);
      expect(agentATasks[0].id).toBe(task1.id);
    });

    it("should filter root tasks only", async () => {
      const parent = await backend.create({
        description: "Parent",
        created_by: testAgentId,
      });
      await backend.createSubtask(parent.id, {
        description: "Child",
        created_by: testAgentId,
      });

      const rootTasks = await backend.list({ rootTasksOnly: true });
      expect(rootTasks).toHaveLength(1);
      expect(rootTasks[0].id).toBe(parent.id);
    });

    it("should exclude blocked tasks by default", async () => {
      const blocker = await backend.create({
        description: "Blocker",
        created_by: testAgentId,
      });
      const blocked = await backend.create({
        description: "Blocked",
        created_by: testAgentId,
      });

      await backend.addBlocker(blocked.id, blocker.id);

      const tasks = await backend.list();
      expect(tasks.find((t) => t.id === blocked.id)).toBeUndefined();

      const allTasks = await backend.list({ includeBlocked: true });
      expect(allTasks.find((t) => t.id === blocked.id)).toBeDefined();
    });
  });

  describe("listReady", () => {
    it("should return only unblocked pending/assigned tasks", async () => {
      const task1 = await backend.create({
        description: "Ready task",
        created_by: testAgentId,
      });
      const blocker = await backend.create({
        description: "Blocker",
        created_by: testAgentId,
      });
      const blockedTask = await backend.create({
        description: "Blocked task",
        created_by: testAgentId,
      });

      await backend.addBlocker(blockedTask.id, blocker.id);

      const readyTasks = await backend.listReady();
      expect(readyTasks.map((t) => t.id)).toContain(task1.id);
      expect(readyTasks.map((t) => t.id)).toContain(blocker.id);
      expect(readyTasks.map((t) => t.id)).not.toContain(blockedTask.id);
    });

    it("should not return completed blockers' blocked tasks as blocked", async () => {
      const blocker = await backend.create({
        description: "Blocker",
        created_by: testAgentId,
      });
      const blocked = await backend.create({
        description: "Blocked",
        created_by: testAgentId,
      });

      await backend.addBlocker(blocked.id, blocker.id);

      // Initially blocked
      let readyTasks = await backend.listReady();
      expect(readyTasks.find((t) => t.id === blocked.id)).toBeUndefined();

      // Complete the blocker
      await backend.start(blocker.id);
      await backend.complete(blocker.id);

      // Now should be ready
      readyTasks = await backend.listReady();
      expect(readyTasks.find((t) => t.id === blocked.id)).toBeDefined();
    });
  });

  describe("getChildren", () => {
    it("should return child tasks", async () => {
      const parent = await backend.create({
        description: "Parent",
        created_by: testAgentId,
      });
      const child1 = await backend.createSubtask(parent.id, {
        description: "Child 1",
        created_by: testAgentId,
      });
      const child2 = await backend.createSubtask(parent.id, {
        description: "Child 2",
        created_by: testAgentId,
      });

      const children = await backend.getChildren(parent.id);
      expect(children).toHaveLength(2);
      expect(children.map((c) => c.id)).toContain(child1.id);
      expect(children.map((c) => c.id)).toContain(child2.id);
    });
  });

  describe("getSubtaskStatus", () => {
    it("should aggregate subtask statuses", async () => {
      const parent = await backend.create({
        description: "Parent",
        created_by: testAgentId,
      });
      const child1 = await backend.createSubtask(parent.id, {
        description: "Child 1",
        created_by: testAgentId,
      });
      const child2 = await backend.createSubtask(parent.id, {
        description: "Child 2",
        created_by: testAgentId,
      });

      await backend.start(child1.id);
      await backend.complete(child1.id);

      const status = await backend.getSubtaskStatus(parent.id);
      expect(status.total).toBe(2);
      expect(status.completed).toBe(1);
      expect(status.pending).toBe(1);
      expect(status.allCompleted).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Dependency Tests
  // ─────────────────────────────────────────────────────────────────────────────

  describe("addBlocker", () => {
    it("should add blocker to task", async () => {
      const task = await backend.create({
        description: "Task",
        created_by: testAgentId,
      });
      const blocker = await backend.create({
        description: "Blocker",
        created_by: testAgentId,
      });

      await backend.addBlocker(task.id, blocker.id);

      const updated = await backend.get(task.id);
      expect(updated!.blockers).toContain(blocker.id);
      expect(updated!.isBlocked).toBe(true);
    });

    it("should not duplicate blockers", async () => {
      const task = await backend.create({
        description: "Task",
        created_by: testAgentId,
      });
      const blocker = await backend.create({
        description: "Blocker",
        created_by: testAgentId,
      });

      await backend.addBlocker(task.id, blocker.id);
      await backend.addBlocker(task.id, blocker.id);

      const updated = await backend.get(task.id);
      expect(updated!.blockers?.filter((b) => b === blocker.id)).toHaveLength(1);
    });
  });

  describe("removeBlocker", () => {
    it("should remove blocker from task", async () => {
      const task = await backend.create({
        description: "Task",
        created_by: testAgentId,
      });
      const blocker = await backend.create({
        description: "Blocker",
        created_by: testAgentId,
      });

      await backend.addBlocker(task.id, blocker.id);
      await backend.removeBlocker(task.id, blocker.id);

      const updated = await backend.get(task.id);
      expect(updated!.blockers).not.toContain(blocker.id);
      expect(updated!.isBlocked).toBe(false);
    });
  });

  describe("getBlockers", () => {
    it("should return blocking tasks", async () => {
      const task = await backend.create({
        description: "Task",
        created_by: testAgentId,
      });
      const blocker1 = await backend.create({
        description: "Blocker 1",
        created_by: testAgentId,
      });
      const blocker2 = await backend.create({
        description: "Blocker 2",
        created_by: testAgentId,
      });

      await backend.addBlocker(task.id, blocker1.id);
      await backend.addBlocker(task.id, blocker2.id);

      const blockers = await backend.getBlockers(task.id);
      expect(blockers).toHaveLength(2);
      expect(blockers.map((b) => b.id)).toContain(blocker1.id);
      expect(blockers.map((b) => b.id)).toContain(blocker2.id);
    });
  });

  describe("getBlocking", () => {
    it("should return tasks blocked by this task", async () => {
      const blocker = await backend.create({
        description: "Blocker",
        created_by: testAgentId,
      });
      const blocked1 = await backend.create({
        description: "Blocked 1",
        created_by: testAgentId,
      });
      const blocked2 = await backend.create({
        description: "Blocked 2",
        created_by: testAgentId,
      });

      await backend.addBlocker(blocked1.id, blocker.id);
      await backend.addBlocker(blocked2.id, blocker.id);

      const blocking = await backend.getBlocking(blocker.id);
      expect(blocking).toHaveLength(2);
      expect(blocking.map((b) => b.id)).toContain(blocked1.id);
      expect(blocking.map((b) => b.id)).toContain(blocked2.id);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // History Tests
  // ─────────────────────────────────────────────────────────────────────────────

  describe("getAgentHistory", () => {
    it("should return assignment history", async () => {
      const task = await backend.create({
        description: "Task",
        created_by: testAgentId,
      });

      await backend.assign(task.id, "agent_a", { role: "first" });
      await backend.unassign(task.id);
      await backend.assign(task.id, "agent_b", { role: "second" });

      const history = await backend.getAgentHistory(task.id);
      expect(history).toHaveLength(2);
      expect(history[0].agent_id).toBe("agent_a");
      expect(history[0].role).toBe("first");
      expect(history[0].ended_at).toBeDefined();
      expect(history[1].agent_id).toBe("agent_b");
      expect(history[1].role).toBe("second");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Event Subscription Tests
  // ─────────────────────────────────────────────────────────────────────────────

  describe("onTaskChange", () => {
    it("should fire callback on task changes", async () => {
      const events: TaskChangeEvent[] = [];
      const unsubscribe = backend.onTaskChange((event) => {
        events.push(event);
      });

      const task = await backend.create({
        description: "Task",
        created_by: testAgentId,
      });
      await backend.start(task.id);

      // Should have received events for create and start
      expect(events.length).toBeGreaterThanOrEqual(2);

      unsubscribe();
    });

    it("should filter by taskId when specified", async () => {
      const task1 = await backend.create({
        description: "Task 1",
        created_by: testAgentId,
      });
      const task2 = await backend.create({
        description: "Task 2",
        created_by: testAgentId,
      });

      const events: TaskChangeEvent[] = [];
      const unsubscribe = backend.onTaskChange(task1.id, (event) => {
        events.push(event);
      });

      await backend.start(task1.id);
      await backend.start(task2.id);

      // Should only have received events for task1
      expect(events.every((e) => e.taskId === task1.id)).toBe(true);

      unsubscribe();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Edge Case Tests
  // ─────────────────────────────────────────────────────────────────────────────

  describe("edge cases", () => {
    describe("empty results", () => {
      it("should return empty list when no tasks exist", async () => {
        const tasks = await backend.list();
        expect(tasks).toEqual([]);
      });

      it("should return empty ready list when no tasks exist", async () => {
        const tasks = await backend.listReady();
        expect(tasks).toEqual([]);
      });

      it("should return empty children for task with no subtasks", async () => {
        const task = await backend.create({
          description: "Task",
          created_by: testAgentId,
        });
        const children = await backend.getChildren(task.id);
        expect(children).toEqual([]);
      });

      it("should return empty blockers for task with no blockers", async () => {
        const task = await backend.create({
          description: "Task",
          created_by: testAgentId,
        });
        const blockers = await backend.getBlockers(task.id);
        expect(blockers).toEqual([]);
      });

      it("should return empty blocking list for task not blocking anything", async () => {
        const task = await backend.create({
          description: "Task",
          created_by: testAgentId,
        });
        const blocking = await backend.getBlocking(task.id);
        expect(blocking).toEqual([]);
      });

      it("should return empty history for new task", async () => {
        const task = await backend.create({
          description: "Task",
          created_by: testAgentId,
        });
        const history = await backend.getAgentHistory(task.id);
        expect(history).toEqual([]);
      });
    });

    describe("external_id support", () => {
      it("should create task with external_id passed through", async () => {
        // Note: external_id support depends on EventStore implementation
        // For now, verify the create call doesn't throw
        const task = await backend.create({
          description: "Task with external ID",
          created_by: testAgentId,
          external_id: "i-abc123",
        });

        expect(task.id).toBeDefined();
        expect(task.description).toBe("Task with external ID");
      });
    });

    describe("multiple status filter", () => {
      it("should filter by multiple statuses", async () => {
        const task1 = await backend.create({
          description: "Pending task",
          created_by: testAgentId,
        });
        const task2 = await backend.create({
          description: "Assigned task",
          created_by: testAgentId,
        });
        const task3 = await backend.create({
          description: "In progress task",
          created_by: testAgentId,
        });

        await backend.assign(task2.id, "agent_a");
        await backend.start(task3.id);

        const result = await backend.list({
          status: ["pending", "assigned"],
          includeBlocked: true,
        });

        expect(result).toHaveLength(2);
        expect(result.map((t) => t.id)).toContain(task1.id);
        expect(result.map((t) => t.id)).toContain(task2.id);
        expect(result.map((t) => t.id)).not.toContain(task3.id);
      });
    });

    describe("created_by filter", () => {
      it("should filter by creator", async () => {
        await backend.create({
          description: "Task by agent A",
          created_by: "agent_a",
        });
        const taskB = await backend.create({
          description: "Task by agent B",
          created_by: "agent_b",
        });

        const result = await backend.list({
          created_by: "agent_b",
          includeBlocked: true,
        });

        expect(result).toHaveLength(1);
        expect(result[0].id).toBe(taskB.id);
      });
    });

    describe("complex filter combinations", () => {
      it("should apply multiple filters together", async () => {
        const parent = await backend.create({
          description: "Parent",
          created_by: "agent_a",
        });

        const child1 = await backend.createSubtask(parent.id, {
          description: "Child 1",
          created_by: "agent_a",
        });
        await backend.createSubtask(parent.id, {
          description: "Child 2",
          created_by: "agent_b",
        });

        await backend.assign(child1.id, "agent_worker");

        const result = await backend.list({
          parent_task: parent.id,
          created_by: "agent_a",
          status: "assigned",
          includeBlocked: true,
        });

        expect(result).toHaveLength(1);
        expect(result[0].id).toBe(child1.id);
      });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Error Handling Tests
  // ─────────────────────────────────────────────────────────────────────────────

  describe("error handling", () => {
    describe("assign errors", () => {
      it("should throw for non-existent task", async () => {
        await expect(
          backend.assign("task_nonexistent", "agent_a")
        ).rejects.toThrow(TaskBackendError);
      });

      it("should allow reassignment of already assigned task", async () => {
        // Current implementation allows reassignment
        const task = await backend.create({
          description: "Task",
          created_by: testAgentId,
        });
        await backend.assign(task.id, "agent_a");

        // Reassignment should work (adds to history)
        await backend.assign(task.id, "agent_b");

        const updated = await backend.get(task.id);
        expect(updated!.assigned_agent).toBe("agent_b");

        const history = await backend.getAgentHistory(task.id);
        expect(history).toHaveLength(2);
      });
    });

    describe("start errors", () => {
      it("should throw for non-existent task", async () => {
        await expect(backend.start("task_nonexistent")).rejects.toThrow(
          TaskBackendError
        );
      });

      it("should throw when starting from failed status", async () => {
        const task = await backend.create({
          description: "Task",
          created_by: testAgentId,
        });
        await backend.start(task.id);
        await backend.fail(task.id, { message: "Failed" });

        await expect(backend.start(task.id)).rejects.toThrow(
          "Invalid status transition"
        );
      });
    });

    describe("complete errors", () => {
      it("should throw for non-existent task", async () => {
        await expect(backend.complete("task_nonexistent")).rejects.toThrow(
          TaskBackendError
        );
      });

      it("should throw when completing pending task", async () => {
        const task = await backend.create({
          description: "Task",
          created_by: testAgentId,
        });

        await expect(backend.complete(task.id)).rejects.toThrow(
          "Invalid status transition"
        );
      });
    });

    describe("fail errors", () => {
      it("should throw for non-existent task", async () => {
        await expect(
          backend.fail("task_nonexistent", { message: "Error" })
        ).rejects.toThrow(TaskBackendError);
      });

      it("should throw when failing completed task", async () => {
        const task = await backend.create({
          description: "Task",
          created_by: testAgentId,
        });
        await backend.start(task.id);
        await backend.complete(task.id);

        await expect(backend.fail(task.id, { message: "Error" })).rejects.toThrow(
          "Invalid status transition"
        );
      });
    });

    describe("blocker errors", () => {
      it("should throw when adding blocker for non-existent task", async () => {
        const blocker = await backend.create({
          description: "Blocker",
          created_by: testAgentId,
        });

        await expect(
          backend.addBlocker("task_nonexistent", blocker.id)
        ).rejects.toThrow(TaskBackendError);
      });

      it("should throw when adding non-existent blocker", async () => {
        const task = await backend.create({
          description: "Task",
          created_by: testAgentId,
        });

        await expect(
          backend.addBlocker(task.id, "task_nonexistent")
        ).rejects.toThrow(TaskBackendError);
      });

      it("should handle self-blocking attempt gracefully", async () => {
        const task = await backend.create({
          description: "Task",
          created_by: testAgentId,
        });

        // Should either throw or ignore self-blocking
        await backend.addBlocker(task.id, task.id);
        const blockers = await backend.getBlockers(task.id);
        // Verify it doesn't cause infinite loop - task blocks itself
        expect(blockers.length).toBeLessThanOrEqual(1);
      });
    });

    describe("getAgentHistory errors", () => {
      it("should throw for non-existent task", async () => {
        await expect(
          backend.getAgentHistory("task_nonexistent")
        ).rejects.toThrow(TaskBackendError);
      });
    });

    describe("getSubtaskStatus errors", () => {
      it("should return empty status for non-existent parent", async () => {
        // Current implementation returns empty status for non-existent task
        const status = await backend.getSubtaskStatus("task_nonexistent");
        expect(status.total).toBe(0);
        expect(status.allCompleted).toBe(false);
      });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Complex Dependency Tests
  // ─────────────────────────────────────────────────────────────────────────────

  describe("complex dependencies", () => {
    it("should handle diamond dependency pattern", async () => {
      // Diamond: A -> B, A -> C, B -> D, C -> D
      const taskA = await backend.create({
        description: "Task A",
        created_by: testAgentId,
      });
      const taskB = await backend.create({
        description: "Task B",
        created_by: testAgentId,
      });
      const taskC = await backend.create({
        description: "Task C",
        created_by: testAgentId,
      });
      const taskD = await backend.create({
        description: "Task D",
        created_by: testAgentId,
      });

      await backend.addBlocker(taskB.id, taskA.id);
      await backend.addBlocker(taskC.id, taskA.id);
      await backend.addBlocker(taskD.id, taskB.id);
      await backend.addBlocker(taskD.id, taskC.id);

      // Only A should be ready
      let ready = await backend.listReady();
      expect(ready.map((t) => t.id)).toContain(taskA.id);
      expect(ready.map((t) => t.id)).not.toContain(taskB.id);
      expect(ready.map((t) => t.id)).not.toContain(taskC.id);
      expect(ready.map((t) => t.id)).not.toContain(taskD.id);

      // Complete A
      await backend.start(taskA.id);
      await backend.complete(taskA.id);

      // B and C should be ready
      ready = await backend.listReady();
      expect(ready.map((t) => t.id)).toContain(taskB.id);
      expect(ready.map((t) => t.id)).toContain(taskC.id);
      expect(ready.map((t) => t.id)).not.toContain(taskD.id);

      // Complete B only
      await backend.start(taskB.id);
      await backend.complete(taskB.id);

      // D still blocked by C
      ready = await backend.listReady();
      expect(ready.map((t) => t.id)).not.toContain(taskD.id);

      // Complete C
      await backend.start(taskC.id);
      await backend.complete(taskC.id);

      // D should be ready now
      ready = await backend.listReady();
      expect(ready.map((t) => t.id)).toContain(taskD.id);
    });

    it("should handle multiple blockers for single task", async () => {
      const blockers = await Promise.all(
        [1, 2, 3, 4, 5].map((i) =>
          backend.create({
            description: `Blocker ${i}`,
            created_by: testAgentId,
          })
        )
      );

      const blocked = await backend.create({
        description: "Blocked task",
        created_by: testAgentId,
      });

      for (const blocker of blockers) {
        await backend.addBlocker(blocked.id, blocker.id);
      }

      const blockersResult = await backend.getBlockers(blocked.id);
      expect(blockersResult).toHaveLength(5);

      // Verify task is blocked
      const task = await backend.get(blocked.id);
      expect(task!.isBlocked).toBe(true);

      // Complete all blockers except one
      for (let i = 0; i < 4; i++) {
        await backend.start(blockers[i].id);
        await backend.complete(blockers[i].id);
      }

      // Still blocked
      let ready = await backend.listReady();
      expect(ready.map((t) => t.id)).not.toContain(blocked.id);

      // Complete last blocker
      await backend.start(blockers[4].id);
      await backend.complete(blockers[4].id);

      // Now unblocked
      ready = await backend.listReady();
      expect(ready.map((t) => t.id)).toContain(blocked.id);
    });

    it("should track blocking relationships correctly", async () => {
      const blocker = await backend.create({
        description: "Blocker",
        created_by: testAgentId,
      });
      const blocked1 = await backend.create({
        description: "Blocked 1",
        created_by: testAgentId,
      });
      const blocked2 = await backend.create({
        description: "Blocked 2",
        created_by: testAgentId,
      });
      const blocked3 = await backend.create({
        description: "Blocked 3",
        created_by: testAgentId,
      });

      await backend.addBlocker(blocked1.id, blocker.id);
      await backend.addBlocker(blocked2.id, blocker.id);
      await backend.addBlocker(blocked3.id, blocker.id);

      const blocking = await backend.getBlocking(blocker.id);
      expect(blocking).toHaveLength(3);
      expect(blocking.map((t) => t.id)).toContain(blocked1.id);
      expect(blocking.map((t) => t.id)).toContain(blocked2.id);
      expect(blocking.map((t) => t.id)).toContain(blocked3.id);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Event Subscription Extended Tests
  // ─────────────────────────────────────────────────────────────────────────────

  describe("event subscription details", () => {
    it("should fire events for task operations", async () => {
      const events: TaskChangeEvent[] = [];
      const unsubscribe = backend.onTaskChange((event) => {
        events.push(event);
      });

      const task = await backend.create({
        description: "Task",
        created_by: testAgentId,
      });
      await backend.assign(task.id, "agent_a");
      await backend.start(task.id);
      await backend.complete(task.id);

      // Should have received events for each operation
      expect(events.length).toBeGreaterThanOrEqual(4);

      // All events should have taskId
      expect(events.every((e) => e.taskId === task.id)).toBe(true);

      // All events should have task data
      expect(events.every((e) => e.task !== undefined)).toBe(true);

      unsubscribe();
    });

    it("should unsubscribe correctly", async () => {
      const events: TaskChangeEvent[] = [];
      const unsubscribe = backend.onTaskChange((event) => {
        events.push(event);
      });

      await backend.create({
        description: "Task 1",
        created_by: testAgentId,
      });
      const countBefore = events.length;

      unsubscribe();

      await backend.create({
        description: "Task 2",
        created_by: testAgentId,
      });

      expect(events.length).toBe(countBefore);
    });

    it("should handle multiple subscribers", async () => {
      const events1: TaskChangeEvent[] = [];
      const events2: TaskChangeEvent[] = [];

      const unsub1 = backend.onTaskChange((event) => events1.push(event));
      const unsub2 = backend.onTaskChange((event) => events2.push(event));

      await backend.create({
        description: "Task",
        created_by: testAgentId,
      });

      expect(events1.length).toBeGreaterThan(0);
      expect(events2.length).toBeGreaterThan(0);
      expect(events1.length).toBe(events2.length);

      unsub1();
      unsub2();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Subtask Status Extended Tests
  // ─────────────────────────────────────────────────────────────────────────────

  describe("subtask status extended", () => {
    it("should detect any failed subtask", async () => {
      const parent = await backend.create({
        description: "Parent",
        created_by: testAgentId,
      });
      const child1 = await backend.createSubtask(parent.id, {
        description: "Child 1",
        created_by: testAgentId,
      });
      const child2 = await backend.createSubtask(parent.id, {
        description: "Child 2",
        created_by: testAgentId,
      });

      await backend.start(child1.id);
      await backend.complete(child1.id);
      await backend.start(child2.id);
      await backend.fail(child2.id, { message: "Failed" });

      const status = await backend.getSubtaskStatus(parent.id);
      expect(status.anyFailed).toBe(true);
      expect(status.allCompleted).toBe(false);
      expect(status.completed).toBe(1);
      expect(status.failed).toBe(1);
    });

    it("should handle all status types", async () => {
      const parent = await backend.create({
        description: "Parent",
        created_by: testAgentId,
      });
      const pending = await backend.createSubtask(parent.id, {
        description: "Pending",
        created_by: testAgentId,
      });
      const assigned = await backend.createSubtask(parent.id, {
        description: "Assigned",
        created_by: testAgentId,
      });
      const inProgress = await backend.createSubtask(parent.id, {
        description: "In Progress",
        created_by: testAgentId,
      });
      const completed = await backend.createSubtask(parent.id, {
        description: "Completed",
        created_by: testAgentId,
      });
      const failed = await backend.createSubtask(parent.id, {
        description: "Failed",
        created_by: testAgentId,
      });

      await backend.assign(assigned.id, "agent_a");
      await backend.start(inProgress.id);
      await backend.start(completed.id);
      await backend.complete(completed.id);
      await backend.start(failed.id);
      await backend.fail(failed.id, { message: "Failed" });

      const status = await backend.getSubtaskStatus(parent.id);
      expect(status.total).toBe(5);
      expect(status.pending).toBe(1);
      expect(status.assigned).toBe(1);
      expect(status.in_progress).toBe(1);
      expect(status.completed).toBe(1);
      expect(status.failed).toBe(1);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Integration Test
  // ─────────────────────────────────────────────────────────────────────────────

  describe("full workflow", () => {
    it("should handle complete task lifecycle with dependencies", async () => {
      // Create parent task
      const parent = await backend.create({
        description: "Feature implementation",
        created_by: testAgentId,
      });

      // Create subtasks with dependencies
      const designTask = await backend.createSubtask(parent.id, {
        description: "Design phase",
        created_by: testAgentId,
      });
      const implTask = await backend.createSubtask(parent.id, {
        description: "Implementation phase",
        created_by: testAgentId,
      });
      const testTask = await backend.createSubtask(parent.id, {
        description: "Testing phase",
        created_by: testAgentId,
      });

      // Set up dependencies: impl depends on design, test depends on impl
      await backend.addBlocker(implTask.id, designTask.id);
      await backend.addBlocker(testTask.id, implTask.id);

      // Check ready tasks - only design should be ready
      let ready = await backend.listReady();
      expect(ready.find((t) => t.id === designTask.id)).toBeDefined();
      expect(ready.find((t) => t.id === implTask.id)).toBeUndefined();
      expect(ready.find((t) => t.id === testTask.id)).toBeUndefined();

      // Complete design
      await backend.assign(designTask.id, "agent_designer");
      await backend.start(designTask.id);
      await backend.complete(designTask.id, { summary: "Design complete" });

      // Now impl should be ready
      ready = await backend.listReady();
      expect(ready.find((t) => t.id === implTask.id)).toBeDefined();
      expect(ready.find((t) => t.id === testTask.id)).toBeUndefined();

      // Complete impl
      await backend.assign(implTask.id, "agent_developer");
      await backend.start(implTask.id);
      await backend.complete(implTask.id, { summary: "Implementation complete" });

      // Now test should be ready
      ready = await backend.listReady();
      expect(ready.find((t) => t.id === testTask.id)).toBeDefined();

      // Complete test
      await backend.assign(testTask.id, "agent_tester");
      await backend.start(testTask.id);
      await backend.complete(testTask.id, { summary: "Tests passing" });

      // Check subtask status
      const status = await backend.getSubtaskStatus(parent.id);
      expect(status.allCompleted).toBe(true);
      expect(status.completed).toBe(3);
    });
  });
});
