/**
 * SudocodeTaskBackend Tests
 *
 * Tests for the SudocodeTaskBackend implementation.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  SudocodeTaskBackend,
  SudocodeTaskBackendError,
  createSudocodeTaskBackend,
} from "../backend.js";
import type { EventStore } from "../../../../store/event-store.js";
import type { Task, TaskStatus } from "../../../../store/types/index.js";
import type { SudocodeClient, IssueChangeCallback } from "../client.js";
import type { Issue } from "../client.js";

// Mock EventStore
function createMockEventStore(): EventStore {
  const tasks = new Map<string, Task>();
  const taskChangeCallbacks: Array<(taskId: string, task: Task | null) => void> = [];

  return {
    instanceId: "test-instance",
    namespace: "test",
    instancePath: ":memory:",
    backendType: "memory",
    peerVisibility: { level: "none" },

    emit: vi.fn((event) => {
      if (event.type === "task") {
        const payload = event.payload as {
          task_id: string;
          action: string;
          details: Record<string, unknown>;
        };
        const taskId = payload.task_id;

        if (payload.action === "created") {
          const task: Task = {
            id: taskId,
            description: payload.details.description as string,
            status: "pending",
            created_at: new Date().toISOString(),
            created_by: event.source.agent_id,
            parent_task: payload.details.parent_task as string | undefined,
            blockers: [],
            subtasks: [],
            agent_history: [],
            outputs: payload.details.external_id
              ? { external_id: payload.details.external_id }
              : undefined,
          };
          tasks.set(taskId, task);
        } else if (payload.action === "assigned") {
          const task = tasks.get(taskId);
          if (task) {
            task.status = "assigned";
            task.assigned_agent = payload.details.agent_id as string;
            tasks.set(taskId, task);
          }
        } else if (payload.action === "unassigned") {
          const task = tasks.get(taskId);
          if (task) {
            task.status = "pending";
            task.assigned_agent = undefined;
            tasks.set(taskId, task);
          }
        } else if (payload.action === "status_change") {
          const task = tasks.get(taskId);
          if (task) {
            if (payload.details.status) {
              task.status = payload.details.status as TaskStatus;
            }
            if (payload.details.description) {
              task.description = payload.details.description as string;
            }
            if (payload.details.outputs) {
              task.outputs = {
                ...(task.outputs ?? {}),
                ...(payload.details.outputs as Record<string, unknown>),
              };
            }
            if (payload.details.artifacts) {
              task.artifacts = payload.details.artifacts as any[];
            }
            if (payload.details.subtask_added) {
              task.subtasks = [
                ...(task.subtasks ?? []),
                payload.details.subtask_added as string,
              ];
            }
            tasks.set(taskId, task);
          }
        } else if (payload.action === "completed") {
          const task = tasks.get(taskId);
          if (task) {
            task.status = "completed";
            task.completed_at = new Date().toISOString();
            tasks.set(taskId, task);
          }
        } else if (payload.action === "failed") {
          const task = tasks.get(taskId);
          if (task) {
            task.status = "failed";
            tasks.set(taskId, task);
          }
        } else if (payload.action === "blocker_added") {
          const task = tasks.get(taskId);
          if (task) {
            task.blockers = [
              ...(task.blockers ?? []),
              payload.details.blocker_id as string,
            ];
            tasks.set(taskId, task);
          }
        } else if (payload.action === "blocker_removed") {
          const task = tasks.get(taskId);
          if (task) {
            task.blockers = (task.blockers ?? []).filter(
              (b) => b !== payload.details.blocker_id
            );
            tasks.set(taskId, task);
          }
        }

        // Notify listeners
        const updatedTask = tasks.get(taskId) ?? null;
        for (const cb of taskChangeCallbacks) {
          cb(taskId, updatedTask);
        }
      }

      return {
        id: `event_${Date.now()}`,
        type: event.type,
        source: event.source,
        payload: event.payload,
        timestamp: new Date().toISOString(),
        version: 1,
      };
    }),

    query: vi.fn(() => []),

    getAgent: vi.fn(() => null),
    listAgents: vi.fn(() => []),

    getTask: vi.fn((taskId: string) => tasks.get(taskId) ?? null),
    listTasks: vi.fn(() => Array.from(tasks.values())),

    getMessages: vi.fn(() => []),
    getFullMessage: vi.fn(() => null),

    addSubscription: vi.fn(),
    removeSubscription: vi.fn(),
    getSubscriptions: vi.fn(() => []),
    getSubscribers: vi.fn(() => []),

    onAgentChange: vi.fn(() => () => {}),
    onTaskChange: vi.fn((callback: (taskId: string, task: Task | null) => void) => {
      taskChangeCallbacks.push(callback);
      return () => {
        const idx = taskChangeCallbacks.indexOf(callback);
        if (idx >= 0) taskChangeCallbacks.splice(idx, 1);
      };
    }),
    onMessageChange: vi.fn(() => () => {}),

    persist: vi.fn(async () => {}),
    reload: vi.fn(async () => {}),
    close: vi.fn(async () => {}),

    archive: vi.fn(async () => ({
      archivedCount: 0,
      archivePath: "",
      oldestRetained: "",
    })),
    loadArchive: vi.fn(async () => []),
    getArchiveInfo: vi.fn(async () => ({ archives: [], totalArchivedEvents: 0 })),

    exportEvents: vi.fn(() => []),
    importEvents: vi.fn(),

    getBackend: vi.fn(() => ({} as any)),
  } as unknown as EventStore;
}

// Mock SudocodeClient
function createMockSudocodeClient(): SudocodeClient {
  const issues = new Map<string, Issue>();
  const issueBlockers = new Map<string, Issue[]>();
  const issueBlocking = new Map<string, Issue[]>();
  const issueChangeCallbacks: IssueChangeCallback[] = [];

  // Add some test issues
  issues.set("i-test1", {
    id: "i-test1",
    uuid: "uuid-1",
    title: "Test Issue 1",
    content: "Test content",
    status: "open",
    priority: 1,
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
  });
  issues.set("i-test2", {
    id: "i-test2",
    uuid: "uuid-2",
    title: "Test Issue 2",
    content: "Test content",
    status: "open",
    priority: 2,
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
  });

  return {
    getIssue: vi.fn(async (id: string) => issues.get(id) ?? null),
    listIssues: vi.fn(async () => Array.from(issues.values())),
    getReadyIssues: vi.fn(async () => Array.from(issues.values())),
    updateIssue: vi.fn(async (id: string, updates: any) => {
      const issue = issues.get(id);
      if (!issue) throw new Error("Issue not found");
      const updated = { ...issue, ...updates };
      issues.set(id, updated);
      return updated;
    }),

    createLink: vi.fn(async () => {}),
    removeLink: vi.fn(async () => {}),
    getBlockers: vi.fn(async (id: string) => issueBlockers.get(id) ?? []),
    getBlocking: vi.fn(async (id: string) => issueBlocking.get(id) ?? []),

    getSpec: vi.fn(async () => null),
    listSpecs: vi.fn(async () => []),

    addFeedback: vi.fn(async () => {}),

    onIssueChange: vi.fn((callbackOrId: IssueChangeCallback | string, maybeCallback?: IssueChangeCallback) => {
      const callback = typeof callbackOrId === "function" ? callbackOrId : maybeCallback!;
      issueChangeCallbacks.push(callback);
      return () => {
        const idx = issueChangeCallbacks.indexOf(callback);
        if (idx >= 0) issueChangeCallbacks.splice(idx, 1);
      };
    }),

    isReady: vi.fn(() => true),
    close: vi.fn(),

    // Test helpers
    _setIssue: (id: string, issue: Issue) => issues.set(id, issue),
    _setBlockers: (id: string, blockers: Issue[]) => issueBlockers.set(id, blockers),
    _setBlocking: (id: string, blocking: Issue[]) => issueBlocking.set(id, blocking),
    _notifyChange: (event: any) => {
      for (const cb of issueChangeCallbacks) {
        cb(event);
      }
    },
  } as unknown as SudocodeClient & {
    _setIssue: (id: string, issue: Issue) => void;
    _setBlockers: (id: string, blockers: Issue[]) => void;
    _setBlocking: (id: string, blocking: Issue[]) => void;
    _notifyChange: (event: any) => void;
  };
}

describe("SudocodeTaskBackend", () => {
  let eventStore: EventStore;
  let client: SudocodeClient & {
    _setIssue: (id: string, issue: Issue) => void;
    _setBlockers: (id: string, blockers: Issue[]) => void;
    _setBlocking: (id: string, blocking: Issue[]) => void;
    _notifyChange: (event: any) => void;
  };
  let backend: SudocodeTaskBackend;

  beforeEach(() => {
    eventStore = createMockEventStore();
    client = createMockSudocodeClient() as any;
    backend = new SudocodeTaskBackend(eventStore, client, {
      syncStatus: false, // Disable auto-sync for most tests
    });
  });

  afterEach(() => {
    backend.close();
  });

  describe("create", () => {
    it("should create a task", async () => {
      const task = await backend.create({
        description: "Test task",
        created_by: "agent-1",
      });

      expect(task.id).toMatch(/^task_/);
      expect(task.description).toBe("Test task");
      expect(task.status).toBe("pending");
      expect(task.created_by).toBe("agent-1");
    });

    it("should create a task bound to an issue", async () => {
      const task = await backend.create({
        description: "Test task",
        created_by: "agent-1",
        external_id: "i-test1",
      });

      expect(task.external_id).toBe("i-test1");
    });

    it("should throw when issue not found", async () => {
      await expect(
        backend.create({
          description: "Test task",
          created_by: "agent-1",
          external_id: "i-nonexistent",
        })
      ).rejects.toThrow("Issue not found");
    });

    it("should create a subtask", async () => {
      const parent = await backend.create({
        description: "Parent task",
        created_by: "agent-1",
      });

      const child = await backend.create({
        description: "Child task",
        created_by: "agent-1",
        parent_task: parent.id,
      });

      expect(child.parent_task).toBe(parent.id);
    });

    it("should throw when parent not found", async () => {
      await expect(
        backend.create({
          description: "Child task",
          created_by: "agent-1",
          parent_task: "nonexistent",
        })
      ).rejects.toThrow("Parent task not found");
    });
  });

  describe("get", () => {
    it("should get a task by ID", async () => {
      const created = await backend.create({
        description: "Test task",
        created_by: "agent-1",
      });

      const fetched = await backend.get(created.id);

      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe(created.id);
    });

    it("should return null for non-existent task", async () => {
      const fetched = await backend.get("nonexistent");
      expect(fetched).toBeNull();
    });
  });

  describe("update", () => {
    it("should update task description", async () => {
      const task = await backend.create({
        description: "Original",
        created_by: "agent-1",
      });

      const updated = await backend.update(task.id, {
        description: "Updated",
      });

      expect(updated.description).toBe("Updated");
    });

    it("should update task status", async () => {
      const task = await backend.create({
        description: "Test task",
        created_by: "agent-1",
      });

      // Assign first
      await backend.assign(task.id, "agent-1");

      const updated = await backend.update(task.id, {
        status: "in_progress",
      });

      expect(updated.status).toBe("in_progress");
    });

    it("should throw for invalid status transition", async () => {
      const task = await backend.create({
        description: "Test task",
        created_by: "agent-1",
      });

      await expect(
        backend.update(task.id, { status: "completed" })
      ).rejects.toThrow("Invalid status transition");
    });

    it("should throw for non-existent task", async () => {
      await expect(
        backend.update("nonexistent", { description: "Test" })
      ).rejects.toThrow("Task not found");
    });
  });

  describe("delete", () => {
    it("should throw not supported error", async () => {
      const task = await backend.create({
        description: "Test task",
        created_by: "agent-1",
      });

      // Delete is not supported - tasks are immutable in event-sourced system
      await expect(backend.delete(task.id)).rejects.toThrow("not supported");

      // Task should remain unchanged
      const unchanged = await backend.get(task.id);
      expect(unchanged!.status).toBe("pending");
    });

    it("should throw not supported even for tasks bound to issues", async () => {
      const task = await backend.create({
        description: "Test task",
        created_by: "agent-1",
        external_id: "i-test1",
      });

      // Delete is not supported regardless of issue binding
      await expect(backend.delete(task.id)).rejects.toThrow("not supported");

      // Task should still be in the issue index
      const taskIds = backend.getTasksByIssue("i-test1");
      expect(taskIds).toContain(task.id);
    });

    it("should throw not supported even for non-existent task", async () => {
      // Note: We throw "not supported" before checking if task exists
      // This matches InMemoryTaskBackend behavior for consistency
      await expect(backend.delete("nonexistent")).rejects.toThrow(
        "not supported"
      );
    });
  });

  describe("assign", () => {
    it("should assign a task to an agent", async () => {
      const task = await backend.create({
        description: "Test task",
        created_by: "agent-1",
      });

      await backend.assign(task.id, "agent-2");

      const updated = await backend.get(task.id);
      expect(updated!.status).toBe("assigned");
      expect(updated!.assigned_agent).toBe("agent-2");
    });
  });

  describe("unassign", () => {
    it("should unassign a task", async () => {
      const task = await backend.create({
        description: "Test task",
        created_by: "agent-1",
      });

      await backend.assign(task.id, "agent-2");
      await backend.unassign(task.id);

      const updated = await backend.get(task.id);
      expect(updated!.status).toBe("pending");
      expect(updated!.assigned_agent).toBeUndefined();
    });

    it("should throw when task is not assigned", async () => {
      const task = await backend.create({
        description: "Test task",
        created_by: "agent-1",
      });

      await expect(backend.unassign(task.id)).rejects.toThrow("not assigned");
    });
  });

  describe("start", () => {
    it("should start a task", async () => {
      const task = await backend.create({
        description: "Test task",
        created_by: "agent-1",
      });

      await backend.assign(task.id, "agent-1");
      await backend.start(task.id);

      const updated = await backend.get(task.id);
      expect(updated!.status).toBe("in_progress");
    });
  });

  describe("complete", () => {
    it("should complete a task", async () => {
      const task = await backend.create({
        description: "Test task",
        created_by: "agent-1",
      });

      await backend.assign(task.id, "agent-1");
      await backend.start(task.id);
      await backend.complete(task.id, { summary: "Done" });

      const updated = await backend.get(task.id);
      expect(updated!.status).toBe("completed");
    });
  });

  describe("fail", () => {
    it("should fail a task", async () => {
      const task = await backend.create({
        description: "Test task",
        created_by: "agent-1",
      });

      await backend.assign(task.id, "agent-1");
      await backend.start(task.id);
      await backend.fail(task.id, { message: "Something went wrong" });

      const updated = await backend.get(task.id);
      expect(updated!.status).toBe("failed");
    });
  });

  describe("list", () => {
    it("should list all tasks", async () => {
      await backend.create({ description: "Task 1", created_by: "agent-1" });
      await backend.create({ description: "Task 2", created_by: "agent-1" });

      const tasks = await backend.list();
      expect(tasks).toHaveLength(2);
    });

    it("should filter by status", async () => {
      const task1 = await backend.create({
        description: "Task 1",
        created_by: "agent-1",
      });
      await backend.create({ description: "Task 2", created_by: "agent-1" });

      await backend.assign(task1.id, "agent-1");

      const assigned = await backend.list({ status: "assigned" });
      expect(assigned).toHaveLength(1);
      expect(assigned[0].id).toBe(task1.id);
    });

    it("should filter by assigned_agent", async () => {
      const task1 = await backend.create({
        description: "Task 1",
        created_by: "agent-1",
      });
      await backend.create({ description: "Task 2", created_by: "agent-1" });

      await backend.assign(task1.id, "agent-2");

      const tasks = await backend.list({ assigned_agent: "agent-2" });
      expect(tasks).toHaveLength(1);
      expect(tasks[0].id).toBe(task1.id);
    });

    it("should exclude blocked tasks by default", async () => {
      const blocker = await backend.create({
        description: "Blocker",
        created_by: "agent-1",
      });
      const blocked = await backend.create({
        description: "Blocked",
        created_by: "agent-1",
      });

      await backend.addBlocker(blocked.id, blocker.id);

      const tasks = await backend.list();
      expect(tasks.map((t) => t.id)).not.toContain(blocked.id);
    });

    it("should include blocked tasks when requested", async () => {
      const blocker = await backend.create({
        description: "Blocker",
        created_by: "agent-1",
      });
      const blocked = await backend.create({
        description: "Blocked",
        created_by: "agent-1",
      });

      await backend.addBlocker(blocked.id, blocker.id);

      const tasks = await backend.list({ includeBlocked: true });
      expect(tasks.map((t) => t.id)).toContain(blocked.id);
    });
  });

  describe("listReady", () => {
    it("should return unblocked pending tasks", async () => {
      await backend.create({ description: "Task 1", created_by: "agent-1" });
      await backend.create({ description: "Task 2", created_by: "agent-1" });

      const ready = await backend.listReady();
      expect(ready).toHaveLength(2);
    });

    it("should exclude blocked tasks", async () => {
      const blocker = await backend.create({
        description: "Blocker",
        created_by: "agent-1",
      });
      const blocked = await backend.create({
        description: "Blocked",
        created_by: "agent-1",
      });

      await backend.addBlocker(blocked.id, blocker.id);

      const ready = await backend.listReady();
      expect(ready.map((t) => t.id)).not.toContain(blocked.id);
    });
  });

  describe("blockers", () => {
    it("should add and get blockers", async () => {
      const task1 = await backend.create({
        description: "Task 1",
        created_by: "agent-1",
      });
      const task2 = await backend.create({
        description: "Task 2",
        created_by: "agent-1",
      });

      await backend.addBlocker(task2.id, task1.id);

      const blockers = await backend.getBlockers(task2.id);
      expect(blockers).toHaveLength(1);
      expect(blockers[0].id).toBe(task1.id);
    });

    it("should remove blockers", async () => {
      const task1 = await backend.create({
        description: "Task 1",
        created_by: "agent-1",
      });
      const task2 = await backend.create({
        description: "Task 2",
        created_by: "agent-1",
      });

      await backend.addBlocker(task2.id, task1.id);
      await backend.removeBlocker(task2.id, task1.id);

      const blockers = await backend.getBlockers(task2.id);
      expect(blockers).toHaveLength(0);
    });

    it("should get tasks that this task blocks", async () => {
      const task1 = await backend.create({
        description: "Task 1",
        created_by: "agent-1",
      });
      const task2 = await backend.create({
        description: "Task 2",
        created_by: "agent-1",
      });

      await backend.addBlocker(task2.id, task1.id);

      const blocking = await backend.getBlocking(task1.id);
      expect(blocking).toHaveLength(1);
      expect(blocking[0].id).toBe(task2.id);
    });

    it("should compute isBlocked from local blockers", async () => {
      const blocker = await backend.create({
        description: "Blocker",
        created_by: "agent-1",
      });
      const blocked = await backend.create({
        description: "Blocked",
        created_by: "agent-1",
      });

      await backend.addBlocker(blocked.id, blocker.id);

      const task = await backend.get(blocked.id);
      expect(task!.isBlocked).toBe(true);
    });

    it("should not be blocked when blocker is completed", async () => {
      const blocker = await backend.create({
        description: "Blocker",
        created_by: "agent-1",
      });
      const blocked = await backend.create({
        description: "Blocked",
        created_by: "agent-1",
      });

      await backend.addBlocker(blocked.id, blocker.id);

      // Complete the blocker
      await backend.assign(blocker.id, "agent-1");
      await backend.start(blocker.id);
      await backend.complete(blocker.id);

      const task = await backend.get(blocked.id);
      expect(task!.isBlocked).toBe(false);
    });
  });

  describe("getChildren", () => {
    it("should get child tasks", async () => {
      const parent = await backend.create({
        description: "Parent",
        created_by: "agent-1",
      });

      await backend.create({
        description: "Child 1",
        created_by: "agent-1",
        parent_task: parent.id,
      });
      await backend.create({
        description: "Child 2",
        created_by: "agent-1",
        parent_task: parent.id,
      });

      const children = await backend.getChildren(parent.id);
      expect(children).toHaveLength(2);
    });
  });

  describe("getSubtaskStatus", () => {
    it("should aggregate subtask statuses", async () => {
      const parent = await backend.create({
        description: "Parent",
        created_by: "agent-1",
      });

      const child1 = await backend.create({
        description: "Child 1",
        created_by: "agent-1",
        parent_task: parent.id,
      });
      await backend.create({
        description: "Child 2",
        created_by: "agent-1",
        parent_task: parent.id,
      });

      await backend.assign(child1.id, "agent-1");
      await backend.start(child1.id);
      await backend.complete(child1.id);

      const status = await backend.getSubtaskStatus(parent.id);
      expect(status.total).toBe(2);
      expect(status.completed).toBe(1);
      expect(status.pending).toBe(1);
      expect(status.allCompleted).toBe(false);
    });
  });

  describe("getAgentHistory", () => {
    it("should return agent history", async () => {
      const task = await backend.create({
        description: "Test",
        created_by: "agent-1",
      });

      const history = await backend.getAgentHistory(task.id);
      expect(Array.isArray(history)).toBe(true);
    });
  });

  describe("onTaskChange", () => {
    it("should notify on task changes", async () => {
      const callback = vi.fn();
      const unsubscribe = backend.onTaskChange(callback);

      await backend.create({
        description: "Test",
        created_by: "agent-1",
      });

      expect(callback).toHaveBeenCalled();

      unsubscribe();
    });
  });

  describe("issue-bound tasks", () => {
    it("should check issue blockers for bound tasks", async () => {
      // Set up a blocker in sudocode
      const blockerIssue: Issue = {
        id: "i-blocker",
        uuid: "uuid-blocker",
        title: "Blocker Issue",
        content: "Blocks test1",
        status: "open",
        priority: 1,
        created_at: "2024-01-01T00:00:00Z",
        updated_at: "2024-01-01T00:00:00Z",
      };
      client._setIssue("i-blocker", blockerIssue);
      client._setBlockers("i-test1", [blockerIssue]);

      const task = await backend.create({
        description: "Test task",
        created_by: "agent-1",
        external_id: "i-test1",
      });

      const fetched = await backend.get(task.id);
      expect(fetched!.isBlocked).toBe(true);
    });

    it("should not be blocked when issue blocker is closed", async () => {
      const blockerIssue: Issue = {
        id: "i-blocker",
        uuid: "uuid-blocker",
        title: "Blocker Issue",
        content: "Blocks test1",
        status: "closed", // Closed - no longer blocks
        priority: 1,
        created_at: "2024-01-01T00:00:00Z",
        updated_at: "2024-01-01T00:00:00Z",
      };
      client._setIssue("i-blocker", blockerIssue);
      client._setBlockers("i-test1", [blockerIssue]);

      const task = await backend.create({
        description: "Test task",
        created_by: "agent-1",
        external_id: "i-test1",
      });

      const fetched = await backend.get(task.id);
      expect(fetched!.isBlocked).toBe(false);
    });
  });

  describe("task-issue index", () => {
    it("should track tasks by issue", async () => {
      const task1 = await backend.create({
        description: "Task 1",
        created_by: "agent-1",
        external_id: "i-test1",
      });
      const task2 = await backend.create({
        description: "Task 2",
        created_by: "agent-1",
        external_id: "i-test1",
      });

      const taskIds = backend.getTasksByIssue("i-test1");
      expect(taskIds).toHaveLength(2);
      expect(taskIds).toContain(task1.id);
      expect(taskIds).toContain(task2.id);
    });

    it("should track issue for each task", async () => {
      const task = await backend.create({
        description: "Test task",
        created_by: "agent-1",
        external_id: "i-test1",
      });

      const issueId = backend.getIssueForTask(task.id);
      expect(issueId).toBe("i-test1");
    });

    it("should return undefined for unbound task", async () => {
      const task = await backend.create({
        description: "Test task",
        created_by: "agent-1",
      });

      const issueId = backend.getIssueForTask(task.id);
      expect(issueId).toBeUndefined();
    });
  });

  describe("bindToIssue", () => {
    it("should bind a task to an issue", async () => {
      const task = await backend.create({
        description: "Test task",
        created_by: "agent-1",
      });

      await backend.bindToIssue(task.id, "i-test1");

      const issueId = backend.getIssueForTask(task.id);
      expect(issueId).toBe("i-test1");

      const taskIds = backend.getTasksByIssue("i-test1");
      expect(taskIds).toContain(task.id);
    });

    it("should throw when issue not found", async () => {
      const task = await backend.create({
        description: "Test task",
        created_by: "agent-1",
      });

      await expect(
        backend.bindToIssue(task.id, "i-nonexistent")
      ).rejects.toThrow("Issue not found");
    });

    it("should throw when task not found", async () => {
      await expect(
        backend.bindToIssue("nonexistent", "i-test1")
      ).rejects.toThrow("Task not found");
    });

    it("should rebind task to different issue", async () => {
      const task = await backend.create({
        description: "Test task",
        created_by: "agent-1",
        external_id: "i-test1",
      });

      await backend.bindToIssue(task.id, "i-test2");

      const issueId = backend.getIssueForTask(task.id);
      expect(issueId).toBe("i-test2");

      // Should no longer be in old issue's list
      const oldTaskIds = backend.getTasksByIssue("i-test1");
      expect(oldTaskIds).not.toContain(task.id);

      // Should be in new issue's list
      const newTaskIds = backend.getTasksByIssue("i-test2");
      expect(newTaskIds).toContain(task.id);
    });
  });

  describe("unbindFromIssue", () => {
    it("should unbind a task from its issue", async () => {
      const task = await backend.create({
        description: "Test task",
        created_by: "agent-1",
        external_id: "i-test1",
      });

      await backend.unbindFromIssue(task.id);

      const issueId = backend.getIssueForTask(task.id);
      expect(issueId).toBeUndefined();

      const taskIds = backend.getTasksByIssue("i-test1");
      expect(taskIds).not.toContain(task.id);
    });

    it("should do nothing for unbound task", async () => {
      const task = await backend.create({
        description: "Test task",
        created_by: "agent-1",
      });

      // Should not throw
      await backend.unbindFromIssue(task.id);

      const issueId = backend.getIssueForTask(task.id);
      expect(issueId).toBeUndefined();
    });

    it("should throw when task not found", async () => {
      await expect(backend.unbindFromIssue("nonexistent")).rejects.toThrow(
        "Task not found"
      );
    });
  });

  describe("sudocode relationship integration", () => {
    it("should create sudocode link when both tasks are bound to issues", async () => {
      // Create two tasks bound to different issues
      const blocker = await backend.create({
        description: "Blocker task",
        created_by: "agent-1",
        external_id: "i-test1",
      });
      const blocked = await backend.create({
        description: "Blocked task",
        created_by: "agent-1",
        external_id: "i-test2",
      });

      await backend.addBlocker(blocked.id, blocker.id);

      // Verify sudocode createLink was called with correct args
      expect(client.createLink).toHaveBeenCalledWith(
        "i-test1", // blocker issue
        "i-test2", // blocked issue
        "blocks"
      );
    });

    it("should not create sudocode link when tasks are not bound", async () => {
      // Create two tasks without external_id
      const blocker = await backend.create({
        description: "Blocker task",
        created_by: "agent-1",
      });
      const blocked = await backend.create({
        description: "Blocked task",
        created_by: "agent-1",
      });

      await backend.addBlocker(blocked.id, blocker.id);

      // createLink should not be called
      expect(client.createLink).not.toHaveBeenCalled();
    });

    it("should remove sudocode link when both tasks are bound to issues", async () => {
      // Create two tasks bound to different issues
      const blocker = await backend.create({
        description: "Blocker task",
        created_by: "agent-1",
        external_id: "i-test1",
      });
      const blocked = await backend.create({
        description: "Blocked task",
        created_by: "agent-1",
        external_id: "i-test2",
      });

      await backend.addBlocker(blocked.id, blocker.id);
      await backend.removeBlocker(blocked.id, blocker.id);

      // Verify sudocode removeLink was called with correct args
      expect(client.removeLink).toHaveBeenCalledWith(
        "i-test1", // blocker issue
        "i-test2", // blocked issue
        "blocks"
      );
    });

    it("should merge local and sudocode blockers in getBlockers", async () => {
      // Create a task bound to i-test2
      const task = await backend.create({
        description: "Test task",
        created_by: "agent-1",
        external_id: "i-test2",
      });

      // Create a local blocker (unbound task)
      const localBlocker = await backend.create({
        description: "Local blocker",
        created_by: "agent-1",
      });
      await backend.addBlocker(task.id, localBlocker.id);

      // Create a task bound to i-test1 (sudocode blocker)
      const sudocodeBlocker = await backend.create({
        description: "Sudocode blocker",
        created_by: "agent-1",
        external_id: "i-test1",
      });

      // Set up sudocode to report i-test1 as blocking i-test2
      client._setBlockers("i-test2", [
        {
          id: "i-test1",
          uuid: "uuid-1",
          title: "Test Issue 1",
          content: "Test content",
          status: "open",
          priority: 1,
          created_at: "2024-01-01T00:00:00Z",
          updated_at: "2024-01-01T00:00:00Z",
        },
      ]);

      const blockers = await backend.getBlockers(task.id);

      // Should have both local and sudocode blockers
      expect(blockers).toHaveLength(2);
      expect(blockers.map((b) => b.id)).toContain(localBlocker.id);
      expect(blockers.map((b) => b.id)).toContain(sudocodeBlocker.id);
    });

    it("should merge local and sudocode blocking in getBlocking", async () => {
      // Create a task bound to i-test1
      const task = await backend.create({
        description: "Test task",
        created_by: "agent-1",
        external_id: "i-test1",
      });

      // Create a local blocked task (unbound)
      const localBlocked = await backend.create({
        description: "Local blocked",
        created_by: "agent-1",
      });
      await backend.addBlocker(localBlocked.id, task.id);

      // Create a task bound to i-test2 (sudocode blocked)
      const sudocodeBlocked = await backend.create({
        description: "Sudocode blocked",
        created_by: "agent-1",
        external_id: "i-test2",
      });

      // Set up sudocode to report i-test1 blocks i-test2
      client._setBlocking("i-test1", [
        {
          id: "i-test2",
          uuid: "uuid-2",
          title: "Test Issue 2",
          content: "Test content",
          status: "open",
          priority: 2,
          created_at: "2024-01-01T00:00:00Z",
          updated_at: "2024-01-01T00:00:00Z",
        },
      ]);

      const blocking = await backend.getBlocking(task.id);

      // Should have both local and sudocode blocked tasks
      expect(blocking).toHaveLength(2);
      expect(blocking.map((b) => b.id)).toContain(localBlocked.id);
      expect(blocking.map((b) => b.id)).toContain(sudocodeBlocked.id);
    });

    it("should deduplicate when same task is both local and sudocode blocker", async () => {
      // Create blocker bound to i-test1
      const blocker = await backend.create({
        description: "Blocker task",
        created_by: "agent-1",
        external_id: "i-test1",
      });

      // Create blocked task bound to i-test2
      const blocked = await backend.create({
        description: "Blocked task",
        created_by: "agent-1",
        external_id: "i-test2",
      });

      // Add as local blocker
      await backend.addBlocker(blocked.id, blocker.id);

      // Also set up sudocode to report the same relationship
      client._setBlockers("i-test2", [
        {
          id: "i-test1",
          uuid: "uuid-1",
          title: "Test Issue 1",
          content: "Test content",
          status: "open",
          priority: 1,
          created_at: "2024-01-01T00:00:00Z",
          updated_at: "2024-01-01T00:00:00Z",
        },
      ]);

      const blockers = await backend.getBlockers(blocked.id);

      // Should only have one blocker (deduplicated)
      expect(blockers).toHaveLength(1);
      expect(blockers[0].id).toBe(blocker.id);
    });
  });

  describe("createSudocodeTaskBackend", () => {
    it("should create a backend instance", () => {
      const backend = createSudocodeTaskBackend(eventStore, client);
      expect(backend).toBeInstanceOf(SudocodeTaskBackend);
      backend.close();
    });
  });
});
