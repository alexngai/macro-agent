/**
 * End-to-End Workflow Tests
 *
 * Tests for complete task lifecycle with sudocode integration.
 * These tests verify the interaction between all components.
 *
 * @module task/backend/sudocode/__tests__/e2e-workflow.test
 * @see s-8472 Pluggable Task Backend Integration
 * @see s-1zcx Multi-Agent Orchestration Testing Strategy
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createEventStore, type EventStore } from "../../../../store/event-store.js";
import {
  SudocodeTaskBackend,
  createSudocodeTaskBackend,
} from "../backend.js";
import type { SudocodeClient, Issue, IssueChangeCallback } from "../client.js";
import type { TaskChangeEvent, SyncEvent } from "../sync-policy.js";

// Create a realistic mock client
function createRealisticMockClient(): SudocodeClient & {
  _issues: Map<string, Issue>;
  _blockers: Map<string, Issue[]>;
  _blocking: Map<string, Issue[]>;
  _callbacks: IssueChangeCallback[];
  _triggerIssueChange: (event: Parameters<IssueChangeCallback>[0]) => void;
  _createIssue: (issue: Issue) => void;
} {
  const issues = new Map<string, Issue>();
  const blockers = new Map<string, Issue[]>();
  const blocking = new Map<string, Issue[]>();
  const callbacks: IssueChangeCallback[] = [];

  return {
    _issues: issues,
    _blockers: blockers,
    _blocking: blocking,
    _callbacks: callbacks,
    _triggerIssueChange: (event) => {
      for (const cb of callbacks) {
        cb(event);
      }
    },
    _createIssue: (issue) => {
      issues.set(issue.id, issue);
    },

    getIssue: vi.fn(async (id: string) => issues.get(id) ?? null),
    listIssues: vi.fn(async () => Array.from(issues.values())),
    createIssue: vi.fn(async (data: Partial<Issue>) => {
      const id = data.id ?? `i-${Date.now()}`;
      const issue: Issue = {
        id,
        uuid: `uuid-${id}`,
        title: data.title ?? "New Issue",
        status: data.status ?? "open",
        priority: data.priority ?? 2,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        ...data,
      } as Issue;
      issues.set(id, issue);
      return issue;
    }),
    updateIssue: vi.fn(async (id: string, updates: Partial<Issue>) => {
      const issue = issues.get(id);
      if (!issue) throw new Error(`Issue not found: ${id}`);
      const previousStatus = issue.status;
      Object.assign(issue, updates);
      issue.updated_at = new Date().toISOString();

      // Trigger status_changed if status changed
      if (updates.status && updates.status !== previousStatus) {
        for (const cb of callbacks) {
          cb({
            type: "status_changed",
            issueId: id,
            issue,
            previousIssue: { ...issue, status: previousStatus },
          });
        }
      }

      return issue;
    }),
    getReadyIssues: vi.fn(async () => {
      return Array.from(issues.values()).filter((i) => {
        const issueBlockers = blockers.get(i.id) ?? [];
        return (
          issueBlockers.every((b) => b.status === "closed") &&
          i.status !== "closed"
        );
      });
    }),
    getBlockers: vi.fn(async (id: string) => blockers.get(id) ?? []),
    getBlocking: vi.fn(async (id: string) => blocking.get(id) ?? []),
    createLink: vi.fn(async (from: string, to: string, type: string) => {
      if (type === "blocks") {
        const fromIssue = issues.get(from);
        if (!fromIssue) return;
        const existing = blockers.get(to) ?? [];
        if (!existing.some((b) => b.id === from)) {
          blockers.set(to, [...existing, fromIssue]);
        }
        const blockingList = blocking.get(from) ?? [];
        const toIssue = issues.get(to);
        if (toIssue && !blockingList.some((b) => b.id === to)) {
          blocking.set(from, [...blockingList, toIssue]);
        }
      }
    }),
    removeLink: vi.fn(async (from: string, to: string, type: string) => {
      if (type === "blocks") {
        const existing = blockers.get(to) ?? [];
        blockers.set(to, existing.filter((b) => b.id !== from));
        const blockingList = blocking.get(from) ?? [];
        blocking.set(from, blockingList.filter((b) => b.id !== to));
      }
    }),
    getSpec: vi.fn(async () => null),
    listSpecs: vi.fn(async () => []),
    addFeedback: vi.fn(async () => {}),
    onIssueChange: vi.fn((callback: IssueChangeCallback) => {
      callbacks.push(callback);
      return () => {
        const idx = callbacks.indexOf(callback);
        if (idx >= 0) callbacks.splice(idx, 1);
      };
    }),
    close: vi.fn(),
    isReady: vi.fn(() => true),
  } as unknown as SudocodeClient & {
    _issues: Map<string, Issue>;
    _blockers: Map<string, Issue[]>;
    _blocking: Map<string, Issue[]>;
    _callbacks: IssueChangeCallback[];
    _triggerIssueChange: (event: Parameters<IssueChangeCallback>[0]) => void;
    _createIssue: (issue: Issue) => void;
  };
}

describe("E2E Workflow", () => {
  let eventStore: EventStore;
  let backend: SudocodeTaskBackend;
  let mockClient: ReturnType<typeof createRealisticMockClient>;
  const testAgentId = "agent_test";

  beforeEach(async () => {
    eventStore = await createEventStore({ inMemory: true });
    mockClient = createRealisticMockClient();
  });

  afterEach(async () => {
    backend?.close();
    await eventStore.close();
  });

  describe("Task creation and issue binding", () => {
    beforeEach(() => {
      backend = createSudocodeTaskBackend(eventStore, mockClient, {
        syncStatus: true,
      });
    });

    it("should create a task bound to an existing issue", async () => {
      // Create an issue first
      mockClient._createIssue({
        id: "i-feature1",
        uuid: "uuid-1",
        title: "Implement feature 1",
        status: "open",
        priority: 1,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      // Create task bound to the issue
      const task = await backend.create({
        description: "Implement feature 1",
        created_by: testAgentId,
        external_id: "i-feature1",
      });

      expect(task.id).toBeDefined();
      expect(task.external_id).toBe("i-feature1");
      expect(backend.getIssueForTask(task.id)).toBe("i-feature1");
      expect(backend.getTasksByIssue("i-feature1")).toContain(task.id);
    });

    it("should fail to create task bound to non-existent issue", async () => {
      await expect(
        backend.create({
          description: "Test",
          created_by: testAgentId,
          external_id: "i-nonexistent",
        })
      ).rejects.toThrow("Issue not found");
    });
  });

  describe("Complete workflow: create -> assign -> start -> complete", () => {
    beforeEach(() => {
      mockClient._createIssue({
        id: "i-workflow",
        uuid: "uuid-workflow",
        title: "Workflow test issue",
        status: "open",
        priority: 2,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      backend = createSudocodeTaskBackend(eventStore, mockClient, {
        syncStatus: true,
        autoCloseIssues: true,
      });
    });

    it("should complete full task lifecycle", async () => {
      // Create task
      const task = await backend.create({
        description: "Complete workflow test",
        created_by: testAgentId,
        external_id: "i-workflow",
      });
      expect(task.status).toBe("pending");

      // Assign task
      await backend.assign(task.id, "worker-1");
      const afterAssign = await backend.get(task.id);
      expect(afterAssign?.status).toBe("assigned");
      expect(afterAssign?.assigned_agent).toBe("worker-1");

      // Start task
      await backend.start(task.id);
      const afterStart = await backend.get(task.id);
      expect(afterStart?.status).toBe("in_progress");

      // Complete task
      await backend.complete(task.id, {
        summary: "Work completed successfully",
        data: { result: "success" },
      });
      const afterComplete = await backend.get(task.id);
      expect(afterComplete?.status).toBe("completed");

      // Issue should have been closed (autoCloseIssues: true)
      expect(mockClient.updateIssue).toHaveBeenCalledWith("i-workflow", {
        status: "closed",
      });
    });

    it("should track status changes correctly", async () => {
      const statusHistory: string[] = [];
      backend.onTaskChange((event) => {
        if (event.task.status) {
          statusHistory.push(event.task.status);
        }
      });

      const task = await backend.create({
        description: "Track status",
        created_by: testAgentId,
      });

      await backend.assign(task.id, "worker-1");
      await backend.start(task.id);
      await backend.complete(task.id);

      // Should have recorded: pending -> assigned -> in_progress -> completed
      expect(statusHistory).toContain("pending");
      expect(statusHistory).toContain("assigned");
      expect(statusHistory).toContain("in_progress");
      expect(statusHistory).toContain("completed");
    });
  });

  describe("Blocker workflow", () => {
    beforeEach(() => {
      mockClient._createIssue({
        id: "i-blocker",
        uuid: "uuid-blocker",
        title: "Blocker issue",
        status: "open",
        priority: 1,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      mockClient._createIssue({
        id: "i-blocked",
        uuid: "uuid-blocked",
        title: "Blocked issue",
        status: "open",
        priority: 2,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      backend = createSudocodeTaskBackend(eventStore, mockClient, {
        syncStatus: true,
      });
    });

    it("should handle task blocked by another task", async () => {
      const blocker = await backend.create({
        description: "Blocker task",
        created_by: testAgentId,
        external_id: "i-blocker",
      });
      const blocked = await backend.create({
        description: "Blocked task",
        created_by: testAgentId,
        external_id: "i-blocked",
      });

      // Add blocker
      await backend.addBlocker(blocked.id, blocker.id);

      // Blocked task should be blocked
      const blockedTask = await backend.get(blocked.id);
      expect(blockedTask?.isBlocked).toBe(true);

      // Should not appear in ready list
      const ready = await backend.listReady();
      expect(ready.find((t) => t.id === blocked.id)).toBeUndefined();
      expect(ready.find((t) => t.id === blocker.id)).toBeDefined();

      // Complete the blocker
      await backend.start(blocker.id);
      await backend.complete(blocker.id);

      // Blocked task should now be unblocked
      const afterComplete = await backend.get(blocked.id);
      expect(afterComplete?.isBlocked).toBe(false);

      // Should now appear in ready list
      const readyAfter = await backend.listReady();
      expect(readyAfter.find((t) => t.id === blocked.id)).toBeDefined();
    });

    it("should sync blocker relationships to sudocode", async () => {
      const blocker = await backend.create({
        description: "Blocker",
        created_by: testAgentId,
        external_id: "i-blocker",
      });
      const blocked = await backend.create({
        description: "Blocked",
        created_by: testAgentId,
        external_id: "i-blocked",
      });

      await backend.addBlocker(blocked.id, blocker.id);

      // Should have created link in sudocode
      expect(mockClient.createLink).toHaveBeenCalledWith(
        "i-blocker",
        "i-blocked",
        "blocks"
      );
    });
  });

  describe("Subtask workflow", () => {
    beforeEach(() => {
      backend = createSudocodeTaskBackend(eventStore, mockClient, {
        syncStatus: false,
      });
    });

    it("should create and track subtasks", async () => {
      const parent = await backend.create({
        description: "Parent task",
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

      expect(child1.parent_task).toBe(parent.id);
      expect(child2.parent_task).toBe(parent.id);

      // Get children
      const children = await backend.getChildren(parent.id);
      expect(children).toHaveLength(2);

      // Get subtask status
      const status = await backend.getSubtaskStatus(parent.id);
      expect(status.total).toBe(2);
      expect(status.pending).toBe(2);
      expect(status.completed).toBe(0);
      expect(status.allCompleted).toBe(false);

      // Complete one child
      await backend.start(child1.id);
      await backend.complete(child1.id);

      const afterOne = await backend.getSubtaskStatus(parent.id);
      expect(afterOne.completed).toBe(1);
      expect(afterOne.pending).toBe(1);
      expect(afterOne.allCompleted).toBe(false);

      // Complete second child
      await backend.start(child2.id);
      await backend.complete(child2.id);

      const afterAll = await backend.getSubtaskStatus(parent.id);
      expect(afterAll.completed).toBe(2);
      expect(afterAll.allCompleted).toBe(true);
    });
  });

  describe("Issue change propagation", () => {
    beforeEach(() => {
      mockClient._createIssue({
        id: "i-sync",
        uuid: "uuid-sync",
        title: "Sync test issue",
        status: "open",
        priority: 2,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      backend = createSudocodeTaskBackend(eventStore, mockClient, {
        syncStatus: true,
      });
    });

    it("should update task when issue status changes", async () => {
      const task = await backend.create({
        description: "Sync test",
        created_by: testAgentId,
        external_id: "i-sync",
      });

      // Initially pending
      expect((await backend.get(task.id))?.status).toBe("pending");

      // Simulate issue status change to in_progress
      mockClient._issues.get("i-sync")!.status = "in_progress";
      mockClient._triggerIssueChange({
        type: "status_changed",
        issueId: "i-sync",
        issue: mockClient._issues.get("i-sync")!,
      });

      // Wait for async handler
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Task should be in_progress
      expect((await backend.get(task.id))?.status).toBe("in_progress");
    });

    it("should not overwrite completed task status", async () => {
      const task = await backend.create({
        description: "Completed task",
        created_by: testAgentId,
        external_id: "i-sync",
      });

      await backend.start(task.id);
      await backend.complete(task.id);
      expect((await backend.get(task.id))?.status).toBe("completed");

      // Simulate issue reopened
      mockClient._issues.get("i-sync")!.status = "open";
      mockClient._triggerIssueChange({
        type: "status_changed",
        issueId: "i-sync",
        issue: mockClient._issues.get("i-sync")!,
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      // Task should remain completed
      expect((await backend.get(task.id))?.status).toBe("completed");
    });
  });

  describe("Error handling in workflows", () => {
    beforeEach(() => {
      backend = createSudocodeTaskBackend(eventStore, mockClient, {
        syncStatus: false,
      });
    });

    it("should handle task failure correctly", async () => {
      const task = await backend.create({
        description: "Will fail",
        created_by: testAgentId,
      });

      await backend.start(task.id);
      await backend.fail(task.id, {
        code: "TEST_ERROR",
        message: "Test failure",
        details: { reason: "testing" },
      });

      const failed = await backend.get(task.id);
      expect(failed?.status).toBe("failed");
      expect((failed?.outputs as any)?.error?.code).toBe("TEST_ERROR");
    });

    it("should reject invalid status transitions", async () => {
      const task = await backend.create({
        description: "Test",
        created_by: testAgentId,
      });

      // Can't complete pending task directly
      await expect(backend.complete(task.id)).rejects.toThrow(
        "Invalid status transition"
      );

      // Start first
      await backend.start(task.id);
      await backend.complete(task.id);

      // Can't start completed task
      await expect(backend.start(task.id)).rejects.toThrow(
        "Invalid status transition"
      );
    });
  });

  describe("Multiple tasks per issue", () => {
    beforeEach(() => {
      mockClient._createIssue({
        id: "i-multi",
        uuid: "uuid-multi",
        title: "Multi-task issue",
        status: "open",
        priority: 2,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      backend = createSudocodeTaskBackend(eventStore, mockClient, {
        syncStatus: true,
      });
    });

    it("should handle multiple tasks bound to same issue", async () => {
      const task1 = await backend.create({
        description: "Task 1",
        created_by: testAgentId,
        external_id: "i-multi",
      });
      const task2 = await backend.create({
        description: "Task 2",
        created_by: testAgentId,
        external_id: "i-multi",
      });

      const tasksByIssue = backend.getTasksByIssue("i-multi");
      expect(tasksByIssue).toHaveLength(2);
      expect(tasksByIssue).toContain(task1.id);
      expect(tasksByIssue).toContain(task2.id);
    });

    it("should update all tasks when issue status changes", async () => {
      const task1 = await backend.create({
        description: "Task 1",
        created_by: testAgentId,
        external_id: "i-multi",
      });
      const task2 = await backend.create({
        description: "Task 2",
        created_by: testAgentId,
        external_id: "i-multi",
      });

      // Simulate issue status change
      mockClient._issues.get("i-multi")!.status = "in_progress";
      mockClient._triggerIssueChange({
        type: "status_changed",
        issueId: "i-multi",
        issue: mockClient._issues.get("i-multi")!,
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect((await backend.get(task1.id))?.status).toBe("in_progress");
      expect((await backend.get(task2.id))?.status).toBe("in_progress");
    });
  });

  describe("listReady with mixed tasks", () => {
    beforeEach(() => {
      mockClient._createIssue({
        id: "i-ready",
        uuid: "uuid-ready",
        title: "Ready issue",
        status: "open",
        priority: 2,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      mockClient._createIssue({
        id: "i-blocked-ext",
        uuid: "uuid-blocked-ext",
        title: "Externally blocked issue",
        status: "blocked",
        priority: 2,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      backend = createSudocodeTaskBackend(eventStore, mockClient, {
        syncStatus: false,
      });
    });

    it("should correctly filter ready tasks", async () => {
      // Unbound task (always ready if not blocked locally)
      const unboundReady = await backend.create({
        description: "Unbound ready",
        created_by: testAgentId,
      });

      // Bound to ready issue
      const boundReady = await backend.create({
        description: "Bound to ready issue",
        created_by: testAgentId,
        external_id: "i-ready",
      });

      // Bound to blocked issue
      const boundBlocked = await backend.create({
        description: "Bound to blocked issue",
        created_by: testAgentId,
        external_id: "i-blocked-ext",
      });

      // Locally blocked (by another task)
      const locallyBlocked = await backend.create({
        description: "Locally blocked",
        created_by: testAgentId,
      });
      const localBlocker = await backend.create({
        description: "Local blocker",
        created_by: testAgentId,
      });
      await backend.addBlocker(locallyBlocked.id, localBlocker.id);

      const ready = await backend.listReady();

      // Should include: unboundReady, boundReady, localBlocker
      // Should exclude: boundBlocked (blocked issue), locallyBlocked (blocked by task)
      expect(ready.find((t) => t.id === unboundReady.id)).toBeDefined();
      expect(ready.find((t) => t.id === boundReady.id)).toBeDefined();
      expect(ready.find((t) => t.id === localBlocker.id)).toBeDefined();
      expect(ready.find((t) => t.id === boundBlocked.id)).toBeUndefined();
      expect(ready.find((t) => t.id === locallyBlocked.id)).toBeUndefined();
    });
  });
});
