/**
 * Task Integration Tests
 *
 * Tests for task lifecycle, dependency management, and backend integration.
 *
 * @see s-8472 Pluggable Task Backend Integration
 * @see i-9cwb Phase 2f: Steering and Task Integration E2E Tests
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { createEventStore, type EventStore } from "../../store/event-store.js";
import { InMemoryTaskBackend } from "../backend/memory.js";
import type { TaskBackend, ExtendedTask } from "../backend/types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 6a: Worker Claims and Completes Task
// ─────────────────────────────────────────────────────────────────────────────

describe("Task Integration", () => {
  describe("Scenario 6a: Worker claims and completes task", () => {
    let eventStore: EventStore;
    let taskBackend: TaskBackend;

    beforeEach(async () => {
      eventStore = await createEventStore({ inMemory: true });
      taskBackend = new InMemoryTaskBackend(eventStore);
    });

    afterEach(async () => {
      await eventStore.close();
    });

    it("should complete full task lifecycle: pending → assigned → in_progress → completed", async () => {
      // 1. Create task (status: pending)
      const task = await taskBackend.create({
        description: "Implement feature X",
        created_by: "coordinator-1",
      });

      expect(task.status).toBe("pending");
      expect(task.assigned_agent).toBeUndefined();

      // 2. Assign to worker (status: assigned)
      await taskBackend.assign(task.id, "worker-1", { role: "worker" });

      const assignedTask = await taskBackend.get(task.id);
      expect(assignedTask?.status).toBe("assigned");
      expect(assignedTask?.assigned_agent).toBe("worker-1");

      // 3. Worker starts work (status: in_progress)
      await taskBackend.start(task.id);

      const inProgressTask = await taskBackend.get(task.id);
      expect(inProgressTask?.status).toBe("in_progress");

      // 4. Worker completes work (status: completed)
      await taskBackend.complete(task.id, {
        summary: "Feature X implemented",
        data: { filesChanged: 3 },
      });

      const completedTask = await taskBackend.get(task.id);
      expect(completedTask?.status).toBe("completed");
      expect(completedTask?.outputs?.summary).toBe("Feature X implemented");
      expect(completedTask?.outputs?.filesChanged).toBe(3);
    });

    it("should track agent assignment history", async () => {
      const task = await taskBackend.create({
        description: "Test task",
        created_by: "coordinator-1",
      });

      // Assign to worker-1
      await taskBackend.assign(task.id, "worker-1");

      // Unassign
      await taskBackend.unassign(task.id);

      // Assign to worker-2
      await taskBackend.assign(task.id, "worker-2");

      const history = await taskBackend.getAgentHistory(task.id);

      // Should have 2 entries
      expect(history.length).toBe(2);
      expect(history[0].agent_id).toBe("worker-1");
      expect(history[1].agent_id).toBe("worker-2");
    });

    it("should handle task failure", async () => {
      const task = await taskBackend.create({
        description: "Risky task",
        created_by: "coordinator-1",
      });

      await taskBackend.assign(task.id, "worker-1");
      await taskBackend.start(task.id);

      // Task fails
      await taskBackend.fail(task.id, {
        message: "Build failed",
        code: "BUILD_ERROR",
      });

      const failedTask = await taskBackend.get(task.id);
      expect(failedTask?.status).toBe("failed");
    });

    it("should support retry after failure", async () => {
      const task = await taskBackend.create({
        description: "Retry task",
        created_by: "coordinator-1",
      });

      await taskBackend.assign(task.id, "worker-1");
      await taskBackend.start(task.id);
      await taskBackend.fail(task.id, { message: "First attempt failed" });

      // Retry by resetting to pending
      await taskBackend.update(task.id, { status: "pending" });

      const retriedTask = await taskBackend.get(task.id);
      expect(retriedTask?.status).toBe("pending");

      // Can be assigned again
      await taskBackend.assign(task.id, "worker-2");
      await taskBackend.start(task.id);
      await taskBackend.complete(task.id, { summary: "Second attempt succeeded" });

      const completedTask = await taskBackend.get(task.id);
      expect(completedTask?.status).toBe("completed");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Scenario 6b: Blocked Task Not in Ready List
  // ─────────────────────────────────────────────────────────────────────────────

  describe("Scenario 6b: Blocked task not in ready list", () => {
    let eventStore: EventStore;
    let taskBackend: TaskBackend;

    beforeEach(async () => {
      eventStore = await createEventStore({ inMemory: true });
      taskBackend = new InMemoryTaskBackend(eventStore);
    });

    afterEach(async () => {
      await eventStore.close();
    });

    it("should exclude blocked tasks from ready list", async () => {
      // Create prerequisite task
      const prereq = await taskBackend.create({
        description: "Prerequisite task",
        created_by: "coordinator-1",
      });

      // Create dependent task
      const dependent = await taskBackend.create({
        description: "Dependent task",
        created_by: "coordinator-1",
      });

      // Add blocker relationship
      await taskBackend.addBlocker(dependent.id, prereq.id);

      // List ready tasks
      const readyTasks = await taskBackend.listReady();

      // Only prereq should be ready
      expect(readyTasks.length).toBe(1);
      expect(readyTasks[0].id).toBe(prereq.id);

      // Dependent should not be in ready list
      expect(readyTasks.find((t) => t.id === dependent.id)).toBeUndefined();
    });

    it("should include task in ready list after blocker completes", async () => {
      const prereq = await taskBackend.create({
        description: "Prerequisite",
        created_by: "coordinator-1",
      });

      const dependent = await taskBackend.create({
        description: "Dependent",
        created_by: "coordinator-1",
      });

      await taskBackend.addBlocker(dependent.id, prereq.id);

      // Initially, only prereq is ready
      let readyTasks = await taskBackend.listReady();
      expect(readyTasks.map((t) => t.id)).toEqual([prereq.id]);

      // Complete prereq
      await taskBackend.assign(prereq.id, "worker-1");
      await taskBackend.start(prereq.id);
      await taskBackend.complete(prereq.id, { summary: "Done" });

      // Now dependent should be ready
      readyTasks = await taskBackend.listReady();
      expect(readyTasks.map((t) => t.id)).toContain(dependent.id);
    });

    it("should handle multiple blockers", async () => {
      const blocker1 = await taskBackend.create({
        description: "Blocker 1",
        created_by: "coordinator-1",
      });

      const blocker2 = await taskBackend.create({
        description: "Blocker 2",
        created_by: "coordinator-1",
      });

      const blocked = await taskBackend.create({
        description: "Blocked by two",
        created_by: "coordinator-1",
      });

      await taskBackend.addBlocker(blocked.id, blocker1.id);
      await taskBackend.addBlocker(blocked.id, blocker2.id);

      // Blocked should not be ready
      let readyTasks = await taskBackend.listReady();
      expect(readyTasks.find((t) => t.id === blocked.id)).toBeUndefined();

      // Complete blocker1 - still blocked by blocker2
      await taskBackend.assign(blocker1.id, "worker-1");
      await taskBackend.start(blocker1.id);
      await taskBackend.complete(blocker1.id, { summary: "Done" });

      readyTasks = await taskBackend.listReady();
      expect(readyTasks.find((t) => t.id === blocked.id)).toBeUndefined();

      // Complete blocker2 - now unblocked
      await taskBackend.assign(blocker2.id, "worker-2");
      await taskBackend.start(blocker2.id);
      await taskBackend.complete(blocker2.id, { summary: "Done" });

      readyTasks = await taskBackend.listReady();
      expect(readyTasks.find((t) => t.id === blocked.id)).toBeDefined();
    });

    it("should get blockers for a task", async () => {
      const blocker1 = await taskBackend.create({
        description: "Blocker 1",
        created_by: "coordinator-1",
      });

      const blocker2 = await taskBackend.create({
        description: "Blocker 2",
        created_by: "coordinator-1",
      });

      const blocked = await taskBackend.create({
        description: "Blocked task",
        created_by: "coordinator-1",
      });

      await taskBackend.addBlocker(blocked.id, blocker1.id);
      await taskBackend.addBlocker(blocked.id, blocker2.id);

      const blockers = await taskBackend.getBlockers(blocked.id);

      expect(blockers.length).toBe(2);
      expect(blockers.map((t) => t.id)).toContain(blocker1.id);
      expect(blockers.map((t) => t.id)).toContain(blocker2.id);
    });

    it("should get tasks that are blocked by a task", async () => {
      const blocker = await taskBackend.create({
        description: "Blocker",
        created_by: "coordinator-1",
      });

      const blocked1 = await taskBackend.create({
        description: "Blocked 1",
        created_by: "coordinator-1",
      });

      const blocked2 = await taskBackend.create({
        description: "Blocked 2",
        created_by: "coordinator-1",
      });

      await taskBackend.addBlocker(blocked1.id, blocker.id);
      await taskBackend.addBlocker(blocked2.id, blocker.id);

      const blocking = await taskBackend.getBlocking(blocker.id);

      expect(blocking.length).toBe(2);
      expect(blocking.map((t) => t.id)).toContain(blocked1.id);
      expect(blocking.map((t) => t.id)).toContain(blocked2.id);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Subtask Hierarchy Tests
  // ─────────────────────────────────────────────────────────────────────────────

  describe("Subtask hierarchy", () => {
    let eventStore: EventStore;
    let taskBackend: TaskBackend;

    beforeEach(async () => {
      eventStore = await createEventStore({ inMemory: true });
      taskBackend = new InMemoryTaskBackend(eventStore);
    });

    afterEach(async () => {
      await eventStore.close();
    });

    it("should create subtasks under parent", async () => {
      const parent = await taskBackend.create({
        description: "Parent task",
        created_by: "coordinator-1",
      });

      const subtask1 = await taskBackend.createSubtask(parent.id, {
        description: "Subtask 1",
        created_by: "coordinator-1",
      });

      const subtask2 = await taskBackend.createSubtask(parent.id, {
        description: "Subtask 2",
        created_by: "coordinator-1",
      });

      const children = await taskBackend.getChildren(parent.id);

      expect(children.length).toBe(2);
      expect(children.map((t) => t.id)).toContain(subtask1.id);
      expect(children.map((t) => t.id)).toContain(subtask2.id);
    });

    it("should track subtask status aggregate", async () => {
      const parent = await taskBackend.create({
        description: "Parent",
        created_by: "coordinator-1",
      });

      const subtask1 = await taskBackend.createSubtask(parent.id, {
        description: "Subtask 1",
        created_by: "coordinator-1",
      });

      const subtask2 = await taskBackend.createSubtask(parent.id, {
        description: "Subtask 2",
        created_by: "coordinator-1",
      });

      // Initially all pending
      let status = await taskBackend.getSubtaskStatus(parent.id);
      expect(status.total).toBe(2);
      expect(status.pending).toBe(2);
      expect(status.allCompleted).toBe(false);

      // Complete one
      await taskBackend.assign(subtask1.id, "worker-1");
      await taskBackend.start(subtask1.id);
      await taskBackend.complete(subtask1.id, { summary: "Done" });

      status = await taskBackend.getSubtaskStatus(parent.id);
      expect(status.completed).toBe(1);
      expect(status.pending).toBe(1);
      expect(status.allCompleted).toBe(false);

      // Complete second
      await taskBackend.assign(subtask2.id, "worker-2");
      await taskBackend.start(subtask2.id);
      await taskBackend.complete(subtask2.id, { summary: "Done" });

      status = await taskBackend.getSubtaskStatus(parent.id);
      expect(status.completed).toBe(2);
      expect(status.allCompleted).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Task Change Events
  // ─────────────────────────────────────────────────────────────────────────────

  describe("Task change events", () => {
    let eventStore: EventStore;
    let taskBackend: TaskBackend;

    beforeEach(async () => {
      eventStore = await createEventStore({ inMemory: true });
      taskBackend = new InMemoryTaskBackend(eventStore);
    });

    afterEach(async () => {
      await eventStore.close();
    });

    it("should emit events on task status changes", async () => {
      const events: Array<{ type: string; taskId: string }> = [];

      // Subscribe FIRST before creating the task
      const unsubscribe = taskBackend.onTaskChange((event) => {
        events.push({ type: event.type, taskId: event.taskId });
      });

      const task = await taskBackend.create({
        description: "Event test",
        created_by: "coordinator-1",
      });

      await taskBackend.assign(task.id, "worker-1");
      await taskBackend.start(task.id);
      await taskBackend.complete(task.id, { summary: "Done" });

      unsubscribe();

      // Should have events for create, assign, start, complete
      expect(events.length).toBeGreaterThanOrEqual(3);
      // First event should be "created"
      expect(events[0].type).toBe("created");
      expect(events[0].taskId).toBe(task.id);
      // Subsequent events should be "updated"
      expect(events.slice(1).every((e) => e.type === "updated")).toBe(true);
    });

    it("should support task-specific subscriptions", async () => {
      const events: Array<{ type: string; taskId: string }> = [];

      const task1 = await taskBackend.create({
        description: "Task 1",
        created_by: "coordinator-1",
      });

      const task2 = await taskBackend.create({
        description: "Task 2",
        created_by: "coordinator-1",
      });

      // Subscribe only to task1
      const unsubscribe = taskBackend.onTaskChange(task1.id, (event) => {
        events.push({ type: event.type, taskId: event.taskId });
      });

      // Update both tasks
      await taskBackend.assign(task1.id, "worker-1");
      await taskBackend.assign(task2.id, "worker-2");

      unsubscribe();

      // Should only have events for task1
      expect(events.every((e) => e.taskId === task1.id)).toBe(true);
    });
  });
});
