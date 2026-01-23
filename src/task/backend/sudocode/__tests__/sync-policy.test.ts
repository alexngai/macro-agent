/**
 * SyncPolicyEngine Tests
 *
 * Tests for the sync policy engine implementation.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  SyncPolicyEngine,
  SyncPolicy,
  defaultSyncPolicy,
  createSyncPolicyEngine,
  SyncEvent,
  SyncableTaskBackend,
} from "../sync-policy.js";
import type { IssueChangeEvent } from "../client.js";

// Mock backend for testing
function createMockBackend(): SyncableTaskBackend & {
  _setTasks: (tasks: Map<string, { status: string }>) => void;
  _setTasksByIssue: (issueId: string, taskIds: string[]) => void;
} {
  const tasks = new Map<string, { status: string }>();
  const tasksByIssue = new Map<string, string[]>();

  return {
    getTasksByIssue: vi.fn((issueId: string) => tasksByIssue.get(issueId) ?? []),
    get: vi.fn(async (taskId: string) => tasks.get(taskId) ?? null),
    complete: vi.fn(async () => {}),
    fail: vi.fn(async () => {}),
    update: vi.fn(async () => ({})),

    // Test helpers
    _setTasks: (newTasks: Map<string, { status: string }>) => {
      tasks.clear();
      for (const [id, task] of newTasks) {
        tasks.set(id, task);
      }
    },
    _setTasksByIssue: (issueId: string, taskIds: string[]) => {
      tasksByIssue.set(issueId, taskIds);
    },
  };
}

describe("SyncPolicyEngine", () => {
  let backend: ReturnType<typeof createMockBackend>;
  let engine: SyncPolicyEngine;

  beforeEach(() => {
    backend = createMockBackend();
  });

  describe("defaultSyncPolicy", () => {
    it("should have correct default values", () => {
      expect(defaultSyncPolicy).toEqual({
        onIssueClosed: "notify_only",
        onDescriptionChanged: "snapshot",
        onBlockerChanged: "update_blocked",
        updateIssueOnStart: true,
        updateIssueOnComplete: "never",
      });
    });
  });

  describe("createSyncPolicyEngine", () => {
    it("should create engine with default policy", () => {
      const engine = createSyncPolicyEngine({}, backend);
      expect(engine.getPolicy()).toEqual(defaultSyncPolicy);
    });

    it("should merge partial policy with defaults", () => {
      const engine = createSyncPolicyEngine(
        { onIssueClosed: "complete_task" },
        backend
      );
      expect(engine.getPolicy().onIssueClosed).toBe("complete_task");
      expect(engine.getPolicy().onDescriptionChanged).toBe("snapshot");
    });
  });

  describe("onIssueClosed policy", () => {
    it("should complete task when policy is complete_task", async () => {
      const policy: SyncPolicy = {
        ...defaultSyncPolicy,
        onIssueClosed: "complete_task",
      };
      engine = new SyncPolicyEngine(policy, backend);

      // Set up a task bound to an issue
      backend._setTasks(
        new Map([["task-1", { status: "in_progress" }]])
      );
      backend._setTasksByIssue("i-test", ["task-1"]);

      const event: IssueChangeEvent = {
        type: "status_changed",
        issueId: "i-test",
        issue: {
          id: "i-test",
          uuid: "uuid-test",
          title: "Test",
          content: "",
          status: "closed",
          priority: 1,
          created_at: "2024-01-01",
          updated_at: "2024-01-01",
        },
      };

      await engine.handleIssueChange(event);

      expect(backend.complete).toHaveBeenCalledWith("task-1", {
        summary: "Issue closed externally",
      });
    });

    it("should fail task when policy is fail_task", async () => {
      const policy: SyncPolicy = {
        ...defaultSyncPolicy,
        onIssueClosed: "fail_task",
      };
      engine = new SyncPolicyEngine(policy, backend);

      backend._setTasks(
        new Map([["task-1", { status: "in_progress" }]])
      );
      backend._setTasksByIssue("i-test", ["task-1"]);

      const event: IssueChangeEvent = {
        type: "status_changed",
        issueId: "i-test",
        issue: {
          id: "i-test",
          uuid: "uuid-test",
          title: "Test",
          content: "",
          status: "closed",
          priority: 1,
          created_at: "2024-01-01",
          updated_at: "2024-01-01",
        },
      };

      await engine.handleIssueChange(event);

      expect(backend.fail).toHaveBeenCalledWith("task-1", {
        code: "ISSUE_CLOSED",
        message: "Bound issue was closed externally",
      });
    });

    it("should emit event when policy is notify_only", async () => {
      const policy: SyncPolicy = {
        ...defaultSyncPolicy,
        onIssueClosed: "notify_only",
      };
      engine = new SyncPolicyEngine(policy, backend);

      backend._setTasks(
        new Map([["task-1", { status: "in_progress" }]])
      );
      backend._setTasksByIssue("i-test", ["task-1"]);

      const events: SyncEvent[] = [];
      engine.onSyncEvent((event) => events.push(event));

      const event: IssueChangeEvent = {
        type: "status_changed",
        issueId: "i-test",
        issue: {
          id: "i-test",
          uuid: "uuid-test",
          title: "Test",
          content: "",
          status: "closed",
          priority: 1,
          created_at: "2024-01-01",
          updated_at: "2024-01-01",
        },
      };

      await engine.handleIssueChange(event);

      expect(backend.complete).not.toHaveBeenCalled();
      expect(backend.fail).not.toHaveBeenCalled();
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("issue_closed");
    });

    it("should not affect completed tasks", async () => {
      const policy: SyncPolicy = {
        ...defaultSyncPolicy,
        onIssueClosed: "complete_task",
      };
      engine = new SyncPolicyEngine(policy, backend);

      backend._setTasks(
        new Map([["task-1", { status: "completed" }]])
      );
      backend._setTasksByIssue("i-test", ["task-1"]);

      const event: IssueChangeEvent = {
        type: "status_changed",
        issueId: "i-test",
        issue: {
          id: "i-test",
          uuid: "uuid-test",
          title: "Test",
          content: "",
          status: "closed",
          priority: 1,
          created_at: "2024-01-01",
          updated_at: "2024-01-01",
        },
      };

      await engine.handleIssueChange(event);

      expect(backend.complete).not.toHaveBeenCalled();
    });
  });

  describe("issue deleted", () => {
    it("should always fail orphaned tasks", async () => {
      engine = createSyncPolicyEngine({}, backend);

      backend._setTasks(
        new Map([
          ["task-1", { status: "in_progress" }],
          ["task-2", { status: "pending" }],
        ])
      );
      backend._setTasksByIssue("i-test", ["task-1", "task-2"]);

      const events: SyncEvent[] = [];
      engine.onSyncEvent((event) => events.push(event));

      const event: IssueChangeEvent = {
        type: "deleted",
        issueId: "i-test",
      };

      await engine.handleIssueChange(event);

      expect(backend.fail).toHaveBeenCalledTimes(2);
      expect(backend.fail).toHaveBeenCalledWith("task-1", {
        code: "ISSUE_DELETED",
        message: "Bound issue i-test was deleted",
      });
      expect(backend.fail).toHaveBeenCalledWith("task-2", {
        code: "ISSUE_DELETED",
        message: "Bound issue i-test was deleted",
      });

      expect(events).toHaveLength(2);
      expect(events[0].type).toBe("issue_deleted");
    });

    it("should not fail completed or failed tasks", async () => {
      engine = createSyncPolicyEngine({}, backend);

      backend._setTasks(
        new Map([
          ["task-1", { status: "completed" }],
          ["task-2", { status: "failed" }],
        ])
      );
      backend._setTasksByIssue("i-test", ["task-1", "task-2"]);

      const event: IssueChangeEvent = {
        type: "deleted",
        issueId: "i-test",
      };

      await engine.handleIssueChange(event);

      expect(backend.fail).not.toHaveBeenCalled();
    });
  });

  describe("blocker events", () => {
    it("should emit blocker_added event when update_blocked policy", async () => {
      const policy: SyncPolicy = {
        ...defaultSyncPolicy,
        onBlockerChanged: "update_blocked",
      };
      engine = new SyncPolicyEngine(policy, backend);

      backend._setTasks(
        new Map([["task-1", { status: "pending" }]])
      );
      backend._setTasksByIssue("i-test", ["task-1"]);

      const events: SyncEvent[] = [];
      engine.onSyncEvent((event) => events.push(event));

      const event: IssueChangeEvent = {
        type: "blocked",
        issueId: "i-test",
      };

      await engine.handleIssueChange(event);

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("blocker_added");
    });

    it("should emit blocker_removed event", async () => {
      engine = createSyncPolicyEngine({}, backend);

      backend._setTasks(
        new Map([["task-1", { status: "pending" }]])
      );
      backend._setTasksByIssue("i-test", ["task-1"]);

      const events: SyncEvent[] = [];
      engine.onSyncEvent((event) => events.push(event));

      const event: IssueChangeEvent = {
        type: "unblocked",
        issueId: "i-test",
      };

      await engine.handleIssueChange(event);

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("blocker_removed");
    });
  });

  describe("description changed", () => {
    it("should propagate description when policy is propagate", async () => {
      const policy: SyncPolicy = {
        ...defaultSyncPolicy,
        onDescriptionChanged: "propagate",
      };
      engine = new SyncPolicyEngine(policy, backend);

      backend._setTasks(
        new Map([["task-1", { status: "pending" }]])
      );
      backend._setTasksByIssue("i-test", ["task-1"]);

      const events: SyncEvent[] = [];
      engine.onSyncEvent((event) => events.push(event));

      const event: IssueChangeEvent = {
        type: "updated",
        issueId: "i-test",
        issue: {
          id: "i-test",
          uuid: "uuid-test",
          title: "Test",
          content: "New description",
          status: "open",
          priority: 1,
          created_at: "2024-01-01",
          updated_at: "2024-01-01",
        },
        previousIssue: {
          id: "i-test",
          uuid: "uuid-test",
          title: "Test",
          content: "Old description",
          status: "open",
          priority: 1,
          created_at: "2024-01-01",
          updated_at: "2024-01-01",
        },
      };

      await engine.handleIssueChange(event);

      expect(backend.update).toHaveBeenCalledWith("task-1", {
        description: "New description",
      });
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("description_changed");
    });

    it("should not propagate description when policy is snapshot", async () => {
      const policy: SyncPolicy = {
        ...defaultSyncPolicy,
        onDescriptionChanged: "snapshot",
      };
      engine = new SyncPolicyEngine(policy, backend);

      backend._setTasks(
        new Map([["task-1", { status: "pending" }]])
      );
      backend._setTasksByIssue("i-test", ["task-1"]);

      const events: SyncEvent[] = [];
      engine.onSyncEvent((event) => events.push(event));

      const event: IssueChangeEvent = {
        type: "updated",
        issueId: "i-test",
        issue: {
          id: "i-test",
          uuid: "uuid-test",
          title: "Test",
          content: "New description",
          status: "open",
          priority: 1,
          created_at: "2024-01-01",
          updated_at: "2024-01-01",
        },
        previousIssue: {
          id: "i-test",
          uuid: "uuid-test",
          title: "Test",
          content: "Old description",
          status: "open",
          priority: 1,
          created_at: "2024-01-01",
          updated_at: "2024-01-01",
        },
      };

      await engine.handleIssueChange(event);

      expect(backend.update).not.toHaveBeenCalled();
      // Event is still emitted for tracking
      expect(events).toHaveLength(1);
    });
  });

  describe("event subscription", () => {
    it("should allow unsubscribing from events", async () => {
      engine = createSyncPolicyEngine({}, backend);

      backend._setTasks(
        new Map([["task-1", { status: "pending" }]])
      );
      backend._setTasksByIssue("i-test", ["task-1"]);

      const events: SyncEvent[] = [];
      const unsubscribe = engine.onSyncEvent((event) => events.push(event));

      // First event
      await engine.handleIssueChange({
        type: "blocked",
        issueId: "i-test",
      });

      expect(events).toHaveLength(1);

      // Unsubscribe
      unsubscribe();

      // Second event should not be received
      await engine.handleIssueChange({
        type: "unblocked",
        issueId: "i-test",
      });

      expect(events).toHaveLength(1);
    });

    it("should handle callback errors gracefully", async () => {
      engine = createSyncPolicyEngine({}, backend);

      backend._setTasks(
        new Map([["task-1", { status: "pending" }]])
      );
      backend._setTasksByIssue("i-test", ["task-1"]);

      const events: SyncEvent[] = [];
      engine.onSyncEvent(() => {
        throw new Error("Callback error");
      });
      engine.onSyncEvent((event) => events.push(event));

      // Should not throw
      await engine.handleIssueChange({
        type: "blocked",
        issueId: "i-test",
      });

      // Second callback should still receive events
      expect(events).toHaveLength(1);
    });
  });

  describe("no bound tasks", () => {
    it("should do nothing when no tasks are bound to the issue", async () => {
      engine = createSyncPolicyEngine(
        { onIssueClosed: "complete_task" },
        backend
      );

      // No tasks set up for this issue
      backend._setTasksByIssue("i-test", []);

      const events: SyncEvent[] = [];
      engine.onSyncEvent((event) => events.push(event));

      await engine.handleIssueChange({
        type: "status_changed",
        issueId: "i-test",
        issue: {
          id: "i-test",
          uuid: "uuid-test",
          title: "Test",
          content: "",
          status: "closed",
          priority: 1,
          created_at: "2024-01-01",
          updated_at: "2024-01-01",
        },
      });

      expect(backend.complete).not.toHaveBeenCalled();
      expect(events).toHaveLength(0);
    });
  });
});
