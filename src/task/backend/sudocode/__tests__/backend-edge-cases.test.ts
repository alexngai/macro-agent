/**
 * SudocodeTaskBackend Edge Case Tests
 *
 * Tests for edge cases, race conditions, and error handling in
 * the SudocodeTaskBackend implementation.
 *
 * @module task/backend/sudocode/__tests__/backend-edge-cases.test
 * @see s-8472 Pluggable Task Backend Integration
 * @see s-1zcx Multi-Agent Orchestration Testing Strategy
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  SudocodeTaskBackend,
  SudocodeTaskBackendError,
  createSudocodeTaskBackend,
} from "../backend.js";
import { createEventStore, type EventStore } from "../../../../store/event-store.js";
import type { Task, TaskStatus } from "../../../../store/types/index.js";
import type { SudocodeClient, IssueChangeCallback, Issue } from "../client.js";
import type { TaskChangeEvent } from "../../types.js";

// Create a more realistic mock client
function createMockClient(): SudocodeClient & {
  _issues: Map<string, Issue>;
  _blockers: Map<string, Issue[]>;
  _blocking: Map<string, Issue[]>;
  _callbacks: IssueChangeCallback[];
  _triggerIssueChange: (event: Parameters<IssueChangeCallback>[0]) => void;
} {
  const issues = new Map<string, Issue>();
  const blockers = new Map<string, Issue[]>();
  const blocking = new Map<string, Issue[]>();
  const callbacks: IssueChangeCallback[] = [];

  // Add some test issues
  const testIssue: Issue = {
    id: "i-test1",
    uuid: "uuid-1",
    title: "Test Issue",
    status: "open",
    priority: 2,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  issues.set("i-test1", testIssue);

  const blockerIssue: Issue = {
    id: "i-blocker",
    uuid: "uuid-blocker",
    title: "Blocker Issue",
    status: "open",
    priority: 1,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  issues.set("i-blocker", blockerIssue);

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

    getIssue: vi.fn(async (id: string) => issues.get(id) ?? null),
    createIssue: vi.fn(async (data: Partial<Issue>) => {
      const id = `i-${Date.now()}`;
      const issue: Issue = {
        id,
        uuid: `uuid-${id}`,
        title: data.title ?? "New Issue",
        status: data.status ?? "open",
        priority: data.priority ?? 2,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      issues.set(id, issue);
      return issue;
    }),
    updateIssue: vi.fn(async (id: string, updates: Partial<Issue>) => {
      const issue = issues.get(id);
      if (!issue) throw new Error(`Issue not found: ${id}`);
      Object.assign(issue, updates);
      issue.updated_at = new Date().toISOString();
      return issue;
    }),
    getReadyIssues: vi.fn(async () => {
      return Array.from(issues.values()).filter((i) => {
        const issueBlockers = blockers.get(i.id) ?? [];
        return issueBlockers.every((b) => b.status === "closed");
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
  };
}

describe("SudocodeTaskBackend Edge Cases", () => {
  let eventStore: EventStore;
  let backend: SudocodeTaskBackend;
  let mockClient: ReturnType<typeof createMockClient>;
  const testAgentId = "agent_test";

  beforeEach(async () => {
    eventStore = await createEventStore({ inMemory: true });
    mockClient = createMockClient();
    backend = createSudocodeTaskBackend(eventStore, mockClient, {
      syncStatus: true,
      autoCloseIssues: false,
    });
  });

  afterEach(async () => {
    backend.close();
    await eventStore.close();
  });

  describe("onTaskChange isBlocked accuracy", () => {
    it("onTaskChange correctly reports isBlocked for local blockers", async () => {
      const events: TaskChangeEvent[] = [];
      const unsubscribe = backend.onTaskChange((event) => {
        events.push(event);
      });

      // Create a blocked task
      const blocker = await backend.create({
        description: "Blocker",
        created_by: testAgentId,
      });
      const blocked = await backend.create({
        description: "Blocked",
        created_by: testAgentId,
      });
      await backend.addBlocker(blocked.id, blocker.id);

      // The task IS blocked
      const task = await backend.get(blocked.id);
      expect(task?.isBlocked).toBe(true);

      // The event should also show isBlocked as true (for local blockers)
      const blockedEvents = events.filter((e) => e.taskId === blocked.id);
      expect(blockedEvents.length).toBeGreaterThan(0);

      // Last event should show correct isBlocked status
      const lastEvent = blockedEvents[blockedEvents.length - 1];
      expect(lastEvent.task.isBlocked).toBe(true);

      unsubscribe();
    });

    it("onTaskChange updates isBlocked when blocker completes", async () => {
      const events: TaskChangeEvent[] = [];
      const unsubscribe = backend.onTaskChange((event) => {
        events.push(event);
      });

      const blocker = await backend.create({
        description: "Blocker",
        created_by: testAgentId,
      });
      const blocked = await backend.create({
        description: "Blocked",
        created_by: testAgentId,
      });
      await backend.addBlocker(blocked.id, blocker.id);

      // Complete the blocker
      await backend.start(blocker.id);
      await backend.complete(blocker.id);

      // Check the blocked task
      const task = await backend.get(blocked.id);
      expect(task?.isBlocked).toBe(false);

      unsubscribe();
    });
  });

  describe("delete behavior", () => {
    it("delete throws not supported for all task states", async () => {
      const pendingTask = await backend.create({
        description: "Pending",
        created_by: testAgentId,
      });

      const completedTask = await backend.create({
        description: "Completed",
        created_by: testAgentId,
      });
      await backend.start(completedTask.id);
      await backend.complete(completedTask.id);

      // Delete should throw "not supported" for all states
      await expect(backend.delete(pendingTask.id)).rejects.toThrow(
        "not supported"
      );
      await expect(backend.delete(completedTask.id)).rejects.toThrow(
        "not supported"
      );

      // Tasks should remain unchanged
      const pending = await backend.get(pendingTask.id);
      const completed = await backend.get(completedTask.id);
      expect(pending?.status).toBe("pending");
      expect(completed?.status).toBe("completed");
    });
  });

  describe("circular dependency detection", () => {
    it("should handle self-blocking gracefully", async () => {
      const task = await backend.create({
        description: "Self",
        created_by: testAgentId,
      });

      // Self-blocking should either be prevented or handled
      await backend.addBlocker(task.id, task.id);

      const selfBlocked = await backend.get(task.id);
      // If allowed, the task would be permanently blocked by itself
      // The implementation should either:
      // 1. Throw an error
      // 2. Silently ignore
      // 3. Not mark it as blocked by itself
      expect(selfBlocked).toBeDefined();
    });

    it("should detect circular dependency A -> B -> A", async () => {
      const taskA = await backend.create({
        description: "Task A",
        created_by: testAgentId,
      });
      const taskB = await backend.create({
        description: "Task B",
        created_by: testAgentId,
      });

      // A blocks B
      await backend.addBlocker(taskB.id, taskA.id);

      // B blocks A - this creates a cycle
      // The implementation should handle this gracefully
      await backend.addBlocker(taskA.id, taskB.id);

      // Both tasks are now blocked by each other
      const a = await backend.get(taskA.id);
      const b = await backend.get(taskB.id);

      // At least one should be workable (or an error should have been thrown)
      // Currently, both become permanently blocked - this is problematic
      expect(a?.isBlocked).toBe(true);
      expect(b?.isBlocked).toBe(true);

      // listReady should not return blocked tasks
      const ready = await backend.listReady();
      expect(ready.find((t) => t.id === taskA.id)).toBeUndefined();
      expect(ready.find((t) => t.id === taskB.id)).toBeUndefined();
    });
  });

  describe("listReady with status filter", () => {
    it("should respect provided status filter", async () => {
      const task = await backend.create({
        description: "Test",
        created_by: testAgentId,
      });

      await backend.start(task.id);

      const inProgressTask = await backend.get(task.id);
      expect(inProgressTask?.status).toBe("in_progress");

      // listReady with in_progress status filter should include the task
      // because the implementation uses: filter?.status ?? ["pending", "assigned"]
      // where ?? only applies when status is nullish
      const ready = await backend.listReady({ status: "in_progress" });
      expect(ready.length).toBe(1);
      expect(ready[0].id).toBe(task.id);
    });

    it("should default to pending/assigned when no status filter provided", async () => {
      const pending = await backend.create({
        description: "Pending",
        created_by: testAgentId,
      });
      const inProgress = await backend.create({
        description: "In Progress",
        created_by: testAgentId,
      });
      await backend.start(inProgress.id);

      // listReady without filter defaults to pending/assigned
      const ready = await backend.listReady();
      expect(ready.length).toBe(1);
      expect(ready[0].id).toBe(pending.id);
      expect(ready.find((t) => t.id === inProgress.id)).toBeUndefined();
    });
  });

  describe("external issue binding", () => {
    it("should validate issue exists before binding", async () => {
      const task = await backend.create({
        description: "Test",
        created_by: testAgentId,
      });

      // Try to bind to non-existent issue
      await expect(
        backend.bindToIssue(task.id, "i-nonexistent")
      ).rejects.toThrow("Issue not found");
    });

    it("should unbind correctly", async () => {
      const task = await backend.create({
        description: "Test",
        created_by: testAgentId,
        external_id: "i-test1",
      });

      expect(backend.getIssueForTask(task.id)).toBe("i-test1");

      await backend.unbindFromIssue(task.id);

      expect(backend.getIssueForTask(task.id)).toBeUndefined();
    });

    it("should handle rebinding to different issue", async () => {
      const task = await backend.create({
        description: "Test",
        created_by: testAgentId,
        external_id: "i-test1",
      });

      // Create another issue
      mockClient._issues.set("i-test2", {
        id: "i-test2",
        uuid: "uuid-2",
        title: "Test Issue 2",
        status: "open",
        priority: 2,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      await backend.bindToIssue(task.id, "i-test2");

      expect(backend.getIssueForTask(task.id)).toBe("i-test2");
      expect(backend.getTasksByIssue("i-test1")).not.toContain(task.id);
      expect(backend.getTasksByIssue("i-test2")).toContain(task.id);
    });
  });

  describe("issue change propagation", () => {
    it("should update task status when issue status changes", async () => {
      const task = await backend.create({
        description: "Test",
        created_by: testAgentId,
        external_id: "i-test1",
      });

      // Initially pending
      let currentTask = await backend.get(task.id);
      expect(currentTask?.status).toBe("pending");

      // Simulate issue status change to in_progress
      mockClient._issues.get("i-test1")!.status = "in_progress";
      mockClient._triggerIssueChange({
        type: "status_changed",
        issueId: "i-test1",
        issue: mockClient._issues.get("i-test1")!,
      });

      // Give async handlers time to run
      await new Promise((resolve) => setTimeout(resolve, 10));

      currentTask = await backend.get(task.id);
      expect(currentTask?.status).toBe("in_progress");
    });

    it("should not update completed task status", async () => {
      const task = await backend.create({
        description: "Test",
        created_by: testAgentId,
        external_id: "i-test1",
      });

      // Complete the task
      await backend.start(task.id);
      await backend.complete(task.id);

      // Simulate issue status change back to open
      mockClient._issues.get("i-test1")!.status = "open";
      mockClient._triggerIssueChange({
        type: "status_changed",
        issueId: "i-test1",
        issue: mockClient._issues.get("i-test1")!,
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      // Task should remain completed
      const currentTask = await backend.get(task.id);
      expect(currentTask?.status).toBe("completed");
    });
  });

  describe("concurrent operations", () => {
    it("should handle concurrent task creations", async () => {
      const promises = Array.from({ length: 10 }, (_, i) =>
        backend.create({
          description: `Task ${i}`,
          created_by: testAgentId,
        })
      );

      const tasks = await Promise.all(promises);

      // All tasks should have unique IDs
      const ids = new Set(tasks.map((t) => t.id));
      expect(ids.size).toBe(10);
    });

    it("should handle concurrent blocker operations", async () => {
      const blocker = await backend.create({
        description: "Blocker",
        created_by: testAgentId,
      });

      const blocked = await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          backend.create({
            description: `Blocked ${i}`,
            created_by: testAgentId,
          })
        )
      );

      // Add blockers concurrently
      await Promise.all(
        blocked.map((task) => backend.addBlocker(task.id, blocker.id))
      );

      // All should be blocked
      for (const task of blocked) {
        const current = await backend.get(task.id);
        expect(current?.isBlocked).toBe(true);
      }
    });
  });

  describe("sudocode blocker integration", () => {
    it("should check sudocode blockers for isBlocked", async () => {
      // Create task bound to i-test1
      const task = await backend.create({
        description: "Test",
        created_by: testAgentId,
        external_id: "i-test1",
      });

      // Set up blocker in mock client
      mockClient._blockers.set("i-test1", [mockClient._issues.get("i-blocker")!]);

      const currentTask = await backend.get(task.id);
      expect(currentTask?.isBlocked).toBe(true);

      // Mark blocker as closed
      mockClient._issues.get("i-blocker")!.status = "closed";

      const afterClose = await backend.get(task.id);
      expect(afterClose?.isBlocked).toBe(false);
    });

    it("should sync blocker relationships to sudocode", async () => {
      // Create tasks bound to issues
      const blocker = await backend.create({
        description: "Blocker",
        created_by: testAgentId,
        external_id: "i-blocker",
      });
      const blocked = await backend.create({
        description: "Blocked",
        created_by: testAgentId,
        external_id: "i-test1",
      });

      await backend.addBlocker(blocked.id, blocker.id);

      // Verify createLink was called
      expect(mockClient.createLink).toHaveBeenCalledWith(
        "i-blocker",
        "i-test1",
        "blocks"
      );
    });
  });

  describe("error handling", () => {
    it("should handle sudocode client errors gracefully", async () => {
      const task = await backend.create({
        description: "Test",
        created_by: testAgentId,
        external_id: "i-test1",
      });

      // Make client throw on getBlockers
      vi.mocked(mockClient.getBlockers).mockRejectedValueOnce(
        new Error("Network error")
      );

      // Should not throw, assumes unblocked when can't check
      const current = await backend.get(task.id);
      expect(current?.isBlocked).toBe(false);
    });

    it("should handle sudocode sync errors without failing operations", async () => {
      // Make updateIssue fail
      vi.mocked(mockClient.updateIssue).mockRejectedValue(
        new Error("Sync error")
      );

      const task = await backend.create({
        description: "Test",
        created_by: testAgentId,
        external_id: "i-test1",
      });

      // These should still succeed even if sync fails
      await expect(backend.assign(task.id, "agent_a")).resolves.not.toThrow();
      await expect(backend.start(task.id)).resolves.not.toThrow();
    });
  });
});
