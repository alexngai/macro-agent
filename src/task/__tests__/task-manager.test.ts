/**
 * TaskManager tests
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createEventStore, EventStore } from "../../store/event-store.js";
import { createTaskManager, TaskManager } from "../task-manager.js";
import { TaskManagerError, VALID_STATUS_TRANSITIONS } from "../types.js";

describe("TaskManager", () => {
  let eventStore: EventStore;
  let taskManager: TaskManager;

  beforeEach(async () => {
    eventStore = await createEventStore({ inMemory: true });
    taskManager = createTaskManager(eventStore);
  });

  afterEach(async () => {
    await eventStore.close();
  });

  describe("Task Creation", () => {
    describe("create()", () => {
      it("should create a new task with unique ID", () => {
        const task = taskManager.create({
          description: "Implement user authentication",
          created_by: "agent_1",
        });

        expect(task.id).toMatch(/^task_/);
        expect(task.description).toBe("Implement user authentication");
        expect(task.created_by).toBe("agent_1");
        expect(task.status).toBe("pending");
      });

      it("should emit task created event", () => {
        taskManager.create({
          description: "Test task",
          created_by: "agent_1",
        });

        const events = eventStore.query({ type: "task" });
        expect(events).toHaveLength(1);
        expect(events[0].payload).toMatchObject({
          action: "created",
          details: { description: "Test task" },
        });
      });

      it("should create task with inputs", () => {
        const task = taskManager.create({
          description: "Review PR #123",
          created_by: "manager_1",
          inputs: { pr_number: 123, repo: "my-repo" },
        });

        expect(task.inputs).toEqual({ pr_number: 123, repo: "my-repo" });
      });

      it("should set timestamps correctly", () => {
        const before = Date.now();
        const task = taskManager.create({
          description: "Test task",
          created_by: "agent_1",
        });
        const after = Date.now();

        expect(task.created_at).toBeGreaterThanOrEqual(before);
        expect(task.created_at).toBeLessThanOrEqual(after);
        expect(task.started_at).toBeUndefined();
        expect(task.completed_at).toBeUndefined();
      });
    });
  });

  describe("Task Retrieval", () => {
    describe("get()", () => {
      it("should return task by ID", () => {
        const created = taskManager.create({
          description: "Test task",
          created_by: "agent_1",
        });

        const retrieved = taskManager.get(created.id);

        expect(retrieved).toBeDefined();
        expect(retrieved?.id).toBe(created.id);
        expect(retrieved?.description).toBe("Test task");
      });

      it("should return null for non-existent task", () => {
        const task = taskManager.get("nonexistent");
        expect(task).toBeNull();
      });
    });

    describe("list()", () => {
      it("should list all tasks", () => {
        taskManager.create({ description: "Task 1", created_by: "agent_1" });
        taskManager.create({ description: "Task 2", created_by: "agent_1" });
        taskManager.create({ description: "Task 3", created_by: "agent_1" });

        const tasks = taskManager.list();
        expect(tasks).toHaveLength(3);
      });

      it("should filter by status", () => {
        const task1 = taskManager.create({
          description: "Task 1",
          created_by: "agent_1",
        });
        const task2 = taskManager.create({
          description: "Task 2",
          created_by: "agent_1",
        });
        taskManager.create({ description: "Task 3", created_by: "agent_1" });

        // Assign and start task1
        taskManager.assign(task1.id, "worker_1");
        taskManager.updateStatus(task1.id, "in_progress");

        // Assign task2
        taskManager.assign(task2.id, "worker_2");

        const inProgress = taskManager.list({ status: "in_progress" });
        expect(inProgress).toHaveLength(1);
        expect(inProgress[0].id).toBe(task1.id);

        const assigned = taskManager.list({ status: "assigned" });
        expect(assigned).toHaveLength(1);
        expect(assigned[0].id).toBe(task2.id);
      });

      it("should filter by assigned agent", () => {
        const task1 = taskManager.create({
          description: "Task 1",
          created_by: "agent_1",
        });
        const task2 = taskManager.create({
          description: "Task 2",
          created_by: "agent_1",
        });
        taskManager.create({ description: "Task 3", created_by: "agent_1" });

        taskManager.assign(task1.id, "worker_1");
        taskManager.assign(task2.id, "worker_1");

        const workerTasks = taskManager.list({ assigned_agent: "worker_1" });
        expect(workerTasks).toHaveLength(2);
      });

      it("should filter root tasks only", () => {
        const parent = taskManager.create({
          description: "Parent",
          created_by: "agent_1",
        });
        taskManager.createSubtask(parent.id, {
          description: "Child 1",
          created_by: "agent_1",
        });
        taskManager.createSubtask(parent.id, {
          description: "Child 2",
          created_by: "agent_1",
        });

        const rootTasks = taskManager.list({ rootTasksOnly: true });
        expect(rootTasks).toHaveLength(1);
        expect(rootTasks[0].id).toBe(parent.id);
      });
    });
  });

  describe("Task Assignment", () => {
    describe("assign()", () => {
      it("should assign agent to task", () => {
        const task = taskManager.create({
          description: "Test task",
          created_by: "agent_1",
        });

        taskManager.assign(task.id, "worker_1");

        const updated = taskManager.get(task.id);
        expect(updated?.assigned_agent).toBe("worker_1");
        expect(updated?.status).toBe("assigned");
      });

      it("should emit assigned event", () => {
        const task = taskManager.create({
          description: "Test task",
          created_by: "agent_1",
        });

        taskManager.assign(task.id, "worker_1");

        const events = eventStore.query({ type: "task" });
        const assignedEvent = events.find(
          (e) => (e.payload as any).action === "assigned",
        );
        expect(assignedEvent).toBeDefined();
        expect((assignedEvent?.payload as any).details.agent_id).toBe(
          "worker_1",
        );
      });

      it("should add entry to agent history", () => {
        const task = taskManager.create({
          description: "Test task",
          created_by: "agent_1",
        });

        taskManager.assign(task.id, "worker_1");

        const updated = taskManager.get(task.id);
        expect(updated?.agent_history).toHaveLength(1);
        expect(updated?.agent_history?.[0].agent_id).toBe("worker_1");
        expect(updated?.agent_history?.[0].assigned_at).toBeDefined();
      });

      it("should include role in agent history", () => {
        const task = taskManager.create({
          description: "Test task",
          created_by: "agent_1",
        });

        taskManager.assign(task.id, "reviewer_1", "reviewer");

        const updated = taskManager.get(task.id);
        expect(updated?.agent_history?.[0].role).toBe("reviewer");
      });

      it("should throw error if task not found", () => {
        expect(() => {
          taskManager.assign("nonexistent", "worker_1");
        }).toThrow(TaskManagerError);
      });
    });

    describe("unassign()", () => {
      it("should unassign agent from task", () => {
        const task = taskManager.create({
          description: "Test task",
          created_by: "agent_1",
        });
        taskManager.assign(task.id, "worker_1");

        taskManager.unassign(task.id);

        const updated = taskManager.get(task.id);
        expect(updated?.assigned_agent).toBeUndefined();
      });

      it("should emit unassigned event", () => {
        const task = taskManager.create({
          description: "Test task",
          created_by: "agent_1",
        });
        taskManager.assign(task.id, "worker_1");

        taskManager.unassign(task.id);

        const events = eventStore.query({ type: "task" });
        const unassignedEvent = events.find(
          (e) => (e.payload as any).action === "unassigned",
        );
        expect(unassignedEvent).toBeDefined();
      });

      it("should set ended_at in agent history", () => {
        const task = taskManager.create({
          description: "Test task",
          created_by: "agent_1",
        });
        taskManager.assign(task.id, "worker_1");

        taskManager.unassign(task.id);

        const updated = taskManager.get(task.id);
        expect(updated?.agent_history?.[0].ended_at).toBeDefined();
      });

      it("should throw error if task not assigned", () => {
        const task = taskManager.create({
          description: "Test task",
          created_by: "agent_1",
        });

        expect(() => {
          taskManager.unassign(task.id);
        }).toThrow(TaskManagerError);
      });
    });
  });

  describe("Task Status Updates", () => {
    describe("updateStatus()", () => {
      it("should update status to in_progress", () => {
        const task = taskManager.create({
          description: "Test task",
          created_by: "agent_1",
        });
        taskManager.assign(task.id, "worker_1");

        taskManager.updateStatus(task.id, "in_progress");

        const updated = taskManager.get(task.id);
        expect(updated?.status).toBe("in_progress");
      });

      it("should set started_at when transitioning to in_progress", () => {
        const task = taskManager.create({
          description: "Test task",
          created_by: "agent_1",
        });
        taskManager.assign(task.id, "worker_1");

        const before = Date.now();
        taskManager.updateStatus(task.id, "in_progress");
        const after = Date.now();

        const updated = taskManager.get(task.id);
        expect(updated?.started_at).toBeGreaterThanOrEqual(before);
        expect(updated?.started_at).toBeLessThanOrEqual(after);
      });

      it("should complete task", () => {
        const task = taskManager.create({
          description: "Test task",
          created_by: "agent_1",
        });
        taskManager.assign(task.id, "worker_1");
        taskManager.updateStatus(task.id, "in_progress");

        taskManager.updateStatus(task.id, "completed");

        const updated = taskManager.get(task.id);
        expect(updated?.status).toBe("completed");
        expect(updated?.completed_at).toBeDefined();
      });

      it("should fail task", () => {
        const task = taskManager.create({
          description: "Test task",
          created_by: "agent_1",
        });
        taskManager.assign(task.id, "worker_1");
        taskManager.updateStatus(task.id, "in_progress");

        taskManager.updateStatus(task.id, "failed");

        const updated = taskManager.get(task.id);
        expect(updated?.status).toBe("failed");
      });

      it("should throw error for invalid transition", () => {
        const task = taskManager.create({
          description: "Test task",
          created_by: "agent_1",
        });
        taskManager.assign(task.id, "worker_1");
        taskManager.updateStatus(task.id, "in_progress");
        taskManager.updateStatus(task.id, "completed");

        // completed -> in_progress is invalid
        expect(() => {
          taskManager.updateStatus(task.id, "in_progress");
        }).toThrow(TaskManagerError);
      });

      it("should allow retry from failed state", () => {
        const task = taskManager.create({
          description: "Test task",
          created_by: "agent_1",
        });
        taskManager.assign(task.id, "worker_1");
        taskManager.updateStatus(task.id, "in_progress");
        taskManager.updateStatus(task.id, "failed");

        // failed -> pending is valid (retry)
        taskManager.updateStatus(task.id, "pending");

        const updated = taskManager.get(task.id);
        expect(updated?.status).toBe("pending");
      });
    });
  });

  describe("Task Updates", () => {
    describe("update()", () => {
      it("should update task outputs", () => {
        const task = taskManager.create({
          description: "Test task",
          created_by: "agent_1",
        });

        taskManager.update(task.id, {
          outputs: { result: "success", files_changed: 5 },
        });

        const updated = taskManager.get(task.id);
        expect(updated?.outputs).toEqual({
          result: "success",
          files_changed: 5,
        });
      });

      it("should add artifacts to task", () => {
        const task = taskManager.create({
          description: "Test task",
          created_by: "agent_1",
        });

        taskManager.update(task.id, {
          artifacts: [{ type: "file", ref: "src/auth.ts" }],
        });

        const updated = taskManager.get(task.id);
        expect(updated?.artifacts).toContainEqual({
          type: "file",
          ref: "src/auth.ts",
        });
      });

      it("should append artifacts", () => {
        const task = taskManager.create({
          description: "Test task",
          created_by: "agent_1",
        });

        taskManager.update(task.id, {
          artifacts: [{ type: "file", ref: "src/auth.ts" }],
        });

        taskManager.update(task.id, {
          artifacts: [{ type: "file", ref: "src/user.ts" }],
        });

        const updated = taskManager.get(task.id);
        expect(updated?.artifacts).toHaveLength(2);
      });

      it("should update description", () => {
        const task = taskManager.create({
          description: "Old description",
          created_by: "agent_1",
        });

        taskManager.update(task.id, {
          description: "New description",
        });

        const updated = taskManager.get(task.id);
        expect(updated?.description).toBe("New description");
      });

      it("should throw error if task not found", () => {
        expect(() => {
          taskManager.update("nonexistent", { outputs: {} });
        }).toThrow(TaskManagerError);
      });
    });
  });

  describe("Subtask Management", () => {
    describe("createSubtask()", () => {
      it("should create subtask with parent reference", () => {
        const parent = taskManager.create({
          description: "Parent task",
          created_by: "manager_1",
        });

        const subtask = taskManager.createSubtask(parent.id, {
          description: "Implement JWT validation",
          created_by: "manager_1",
        });

        expect(subtask.parent_task).toBe(parent.id);
      });

      it("should add subtask ID to parent subtasks array", () => {
        const parent = taskManager.create({
          description: "Parent task",
          created_by: "manager_1",
        });

        const subtask = taskManager.createSubtask(parent.id, {
          description: "Subtask 1",
          created_by: "manager_1",
        });

        const updatedParent = taskManager.get(parent.id);
        expect(updatedParent?.subtasks).toContain(subtask.id);
      });

      it("should throw error if parent not found", () => {
        expect(() => {
          taskManager.createSubtask("nonexistent", {
            description: "Orphan subtask",
            created_by: "agent_1",
          });
        }).toThrow(TaskManagerError);
      });
    });

    describe("getSubtasks()", () => {
      it("should return all subtasks of a task", () => {
        const parent = taskManager.create({
          description: "Parent",
          created_by: "manager_1",
        });

        taskManager.createSubtask(parent.id, {
          description: "Subtask 1",
          created_by: "manager_1",
        });
        taskManager.createSubtask(parent.id, {
          description: "Subtask 2",
          created_by: "manager_1",
        });
        taskManager.createSubtask(parent.id, {
          description: "Subtask 3",
          created_by: "manager_1",
        });

        const subtasks = taskManager.getSubtasks(parent.id);
        expect(subtasks).toHaveLength(3);
      });

      it("should return empty array for task with no subtasks", () => {
        const task = taskManager.create({
          description: "Leaf task",
          created_by: "agent_1",
        });

        const subtasks = taskManager.getSubtasks(task.id);
        expect(subtasks).toHaveLength(0);
      });
    });

    describe("getSubtaskStatus()", () => {
      it("should aggregate subtask statuses", () => {
        const parent = taskManager.create({
          description: "Parent",
          created_by: "manager_1",
        });

        const sub1 = taskManager.createSubtask(parent.id, {
          description: "Sub 1",
          created_by: "manager_1",
        });
        const sub2 = taskManager.createSubtask(parent.id, {
          description: "Sub 2",
          created_by: "manager_1",
        });
        const sub3 = taskManager.createSubtask(parent.id, {
          description: "Sub 3",
          created_by: "manager_1",
        });

        // Complete sub1
        taskManager.assign(sub1.id, "worker_1");
        taskManager.updateStatus(sub1.id, "in_progress");
        taskManager.updateStatus(sub1.id, "completed");

        // Start sub2
        taskManager.assign(sub2.id, "worker_2");
        taskManager.updateStatus(sub2.id, "in_progress");

        // Leave sub3 pending

        const status = taskManager.getSubtaskStatus(parent.id);

        expect(status.total).toBe(3);
        expect(status.completed).toBe(1);
        expect(status.in_progress).toBe(1);
        expect(status.pending).toBe(1);
        expect(status.allCompleted).toBe(false);
        expect(status.anyFailed).toBe(false);
      });

      it("should detect all completed", () => {
        const parent = taskManager.create({
          description: "Parent",
          created_by: "manager_1",
        });

        const sub1 = taskManager.createSubtask(parent.id, {
          description: "Sub 1",
          created_by: "manager_1",
        });
        const sub2 = taskManager.createSubtask(parent.id, {
          description: "Sub 2",
          created_by: "manager_1",
        });

        // Complete both
        taskManager.assign(sub1.id, "worker_1");
        taskManager.updateStatus(sub1.id, "in_progress");
        taskManager.updateStatus(sub1.id, "completed");

        taskManager.assign(sub2.id, "worker_2");
        taskManager.updateStatus(sub2.id, "in_progress");
        taskManager.updateStatus(sub2.id, "completed");

        const status = taskManager.getSubtaskStatus(parent.id);
        expect(status.allCompleted).toBe(true);
      });

      it("should detect any failed", () => {
        const parent = taskManager.create({
          description: "Parent",
          created_by: "manager_1",
        });

        const sub1 = taskManager.createSubtask(parent.id, {
          description: "Sub 1",
          created_by: "manager_1",
        });

        // Fail sub1
        taskManager.assign(sub1.id, "worker_1");
        taskManager.updateStatus(sub1.id, "in_progress");
        taskManager.updateStatus(sub1.id, "failed");

        const status = taskManager.getSubtaskStatus(parent.id);
        expect(status.anyFailed).toBe(true);
      });
    });
  });

  describe("Status Transition Validation", () => {
    it("should define valid transitions for each status", () => {
      expect(VALID_STATUS_TRANSITIONS.pending).toContain("assigned");
      expect(VALID_STATUS_TRANSITIONS.assigned).toContain("in_progress");
      expect(VALID_STATUS_TRANSITIONS.in_progress).toContain("completed");
      expect(VALID_STATUS_TRANSITIONS.in_progress).toContain("failed");
      expect(VALID_STATUS_TRANSITIONS.completed).toHaveLength(0);
      expect(VALID_STATUS_TRANSITIONS.failed).toContain("pending");
    });
  });

  describe("Retry Support", () => {
    describe("create() with retryPolicy", () => {
      it("should create task with retry policy", () => {
        const task = taskManager.create({
          description: "Retriable task",
          created_by: "agent_1",
          retryPolicy: {
            maxRetries: 3,
            retryOn: ["failed", "stalled"],
            backoffMs: 1000,
            backoffMultiplier: 2,
            maxBackoffMs: 60000,
          },
        });

        expect(task.retryPolicy).toBeDefined();
        expect(task.retryPolicy?.maxRetries).toBe(3);
        expect(task.retryPolicy?.retryOn).toEqual(["failed", "stalled"]);
      });

      it("should create task without retry policy by default", () => {
        const task = taskManager.create({
          description: "Non-retriable task",
          created_by: "agent_1",
        });

        expect(task.retryPolicy).toBeUndefined();
      });
    });

    describe("prepareForRetry()", () => {
      it("should reset task status to pending", () => {
        const task = taskManager.create({
          description: "Failed task",
          created_by: "agent_1",
          retryPolicy: {
            maxRetries: 3,
            retryOn: ["failed"],
            backoffMs: 1000,
            backoffMultiplier: 2,
            maxBackoffMs: 60000,
          },
        });

        taskManager.assign(task.id, "worker_1");
        taskManager.updateStatus(task.id, "in_progress");
        taskManager.updateStatus(task.id, "failed");

        taskManager.prepareForRetry(task.id, "Connection timeout");

        const updated = taskManager.get(task.id);
        expect(updated?.status).toBe("pending");
      });

      it("should increment retry state attempt count", () => {
        const task = taskManager.create({
          description: "Failed task",
          created_by: "agent_1",
          retryPolicy: {
            maxRetries: 3,
            retryOn: ["failed"],
            backoffMs: 1000,
            backoffMultiplier: 2,
            maxBackoffMs: 60000,
          },
        });

        taskManager.assign(task.id, "worker_1");
        taskManager.updateStatus(task.id, "in_progress");
        taskManager.updateStatus(task.id, "failed");

        taskManager.prepareForRetry(task.id, "Connection timeout");

        const updated = taskManager.get(task.id);
        expect(updated?.retryState?.attemptCount).toBe(1);
        expect(updated?.retryState?.lastError).toBe("Connection timeout");
      });

      it("should accumulate retry attempts", () => {
        const task = taskManager.create({
          description: "Flaky task",
          created_by: "agent_1",
          retryPolicy: {
            maxRetries: 5,
            retryOn: ["failed"],
            backoffMs: 1000,
            backoffMultiplier: 2,
            maxBackoffMs: 60000,
          },
        });

        // First attempt + retry
        taskManager.assign(task.id, "worker_1");
        taskManager.updateStatus(task.id, "in_progress");
        taskManager.updateStatus(task.id, "failed");
        taskManager.prepareForRetry(task.id, "Error 1");

        // Second attempt + retry
        taskManager.assign(task.id, "worker_2");
        taskManager.updateStatus(task.id, "in_progress");
        taskManager.updateStatus(task.id, "failed");
        taskManager.prepareForRetry(task.id, "Error 2");

        const updated = taskManager.get(task.id);
        expect(updated?.retryState?.attemptCount).toBe(2);
        expect(updated?.retryState?.lastError).toBe("Error 2");
      });

      it("should set nextRetryAt if provided", () => {
        const task = taskManager.create({
          description: "Failed task",
          created_by: "agent_1",
        });

        const nextRetryAt = Date.now() + 5000;
        taskManager.prepareForRetry(task.id, "Error", nextRetryAt);

        const updated = taskManager.get(task.id);
        expect(updated?.retryState?.nextRetryAt).toBe(nextRetryAt);
      });

      it("should throw for non-existent task", () => {
        expect(() => {
          taskManager.prepareForRetry("nonexistent");
        }).toThrow(TaskManagerError);
      });

      it("should clear assigned agent", () => {
        const task = taskManager.create({
          description: "Failed task",
          created_by: "agent_1",
        });

        taskManager.assign(task.id, "worker_1");
        taskManager.updateStatus(task.id, "in_progress");
        taskManager.updateStatus(task.id, "failed");

        taskManager.prepareForRetry(task.id);

        const updated = taskManager.get(task.id);
        expect(updated?.assigned_agent).toBeUndefined();
      });
    });

    describe("updateRetryState()", () => {
      it("should update retry state", () => {
        const task = taskManager.create({
          description: "Test task",
          created_by: "agent_1",
        });

        taskManager.updateRetryState(task.id, {
          attemptCount: 2,
          lastAttemptAt: Date.now(),
          lastError: "Some error",
        });

        const updated = taskManager.get(task.id);
        expect(updated?.retryState?.attemptCount).toBe(2);
        expect(updated?.retryState?.lastError).toBe("Some error");
      });

      it("should throw for non-existent task", () => {
        expect(() => {
          taskManager.updateRetryState("nonexistent", {
            attemptCount: 1,
            lastAttemptAt: Date.now(),
          });
        }).toThrow(TaskManagerError);
      });
    });
  });
});
