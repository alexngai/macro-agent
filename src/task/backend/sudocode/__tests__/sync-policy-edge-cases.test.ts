/**
 * Sync Policy Engine Edge Case Tests
 *
 * Tests for edge cases and potential bugs in the sync policy engine.
 *
 * @module task/backend/sudocode/__tests__/sync-policy-edge-cases.test
 * @see s-8472 Pluggable Task Backend Integration
 * @see s-1zcx Multi-Agent Orchestration Testing Strategy
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  SyncPolicyEngine,
  createSyncPolicyEngine,
  defaultSyncPolicy,
  type SyncPolicy,
  type SyncEvent,
  type SyncableTaskBackend,
} from "../sync-policy.js";
import type { IssueChangeEvent } from "../client.js";

// Create a mock backend
function createMockBackend(): SyncableTaskBackend & {
  _tasksByIssue: Map<string, string[]>;
  _tasks: Map<string, { status: string }>;
} {
  const tasksByIssue = new Map<string, string[]>();
  const tasks = new Map<string, { status: string }>();

  return {
    _tasksByIssue: tasksByIssue,
    _tasks: tasks,
    getTasksByIssue: vi.fn((issueId: string) => tasksByIssue.get(issueId) ?? []),
    get: vi.fn(async (taskId: string) => tasks.get(taskId) ?? null),
    complete: vi.fn(async () => {}),
    fail: vi.fn(async () => {}),
    update: vi.fn(async () => ({})),
  };
}

describe("SyncPolicyEngine Edge Cases", () => {
  let backend: ReturnType<typeof createMockBackend>;

  beforeEach(() => {
    backend = createMockBackend();
  });

  describe("default policy values", () => {
    it("should have correct defaults", () => {
      expect(defaultSyncPolicy.onIssueClosed).toBe("notify_only");
      expect(defaultSyncPolicy.onDescriptionChanged).toBe("snapshot");
      expect(defaultSyncPolicy.onBlockerChanged).toBe("update_blocked");
      expect(defaultSyncPolicy.updateIssueOnStart).toBe(true);
      expect(defaultSyncPolicy.updateIssueOnComplete).toBe("never");
    });
  });

  describe("handleIssueChange with no bound tasks", () => {
    it("should do nothing when no tasks are bound to the issue", async () => {
      const engine = createSyncPolicyEngine({}, backend);
      const events: SyncEvent[] = [];
      engine.onSyncEvent((e) => events.push(e));

      await engine.handleIssueChange({
        type: "status_changed",
        issueId: "i-unbound",
        issue: { id: "i-unbound", status: "closed" } as any,
      });

      expect(events).toHaveLength(0);
      expect(backend.complete).not.toHaveBeenCalled();
      expect(backend.fail).not.toHaveBeenCalled();
    });
  });

  describe("onIssueClosed policies", () => {
    beforeEach(() => {
      backend._tasksByIssue.set("i-test", ["task-1", "task-2"]);
      backend._tasks.set("task-1", { status: "in_progress" });
      backend._tasks.set("task-2", { status: "pending" });
    });

    it("complete_task: should complete all bound tasks", async () => {
      const engine = createSyncPolicyEngine(
        { onIssueClosed: "complete_task" },
        backend
      );

      await engine.handleIssueChange({
        type: "status_changed",
        issueId: "i-test",
        issue: { id: "i-test", status: "closed" } as any,
      });

      expect(backend.complete).toHaveBeenCalledTimes(2);
      expect(backend.complete).toHaveBeenCalledWith("task-1", {
        summary: "Issue closed externally",
      });
      expect(backend.complete).toHaveBeenCalledWith("task-2", {
        summary: "Issue closed externally",
      });
    });

    it("fail_task: should fail all bound tasks", async () => {
      const engine = createSyncPolicyEngine(
        { onIssueClosed: "fail_task" },
        backend
      );

      await engine.handleIssueChange({
        type: "status_changed",
        issueId: "i-test",
        issue: { id: "i-test", status: "closed" } as any,
      });

      expect(backend.fail).toHaveBeenCalledTimes(2);
      expect(backend.fail).toHaveBeenCalledWith("task-1", {
        code: "ISSUE_CLOSED",
        message: "Bound issue was closed externally",
      });
    });

    it("notify_only: should only emit events", async () => {
      const engine = createSyncPolicyEngine(
        { onIssueClosed: "notify_only" },
        backend
      );
      const events: SyncEvent[] = [];
      engine.onSyncEvent((e) => events.push(e));

      await engine.handleIssueChange({
        type: "status_changed",
        issueId: "i-test",
        issue: { id: "i-test", status: "closed" } as any,
      });

      expect(backend.complete).not.toHaveBeenCalled();
      expect(backend.fail).not.toHaveBeenCalled();
      expect(events).toHaveLength(2);
      expect(events[0].type).toBe("issue_closed");
    });

    it("should skip already completed tasks", async () => {
      backend._tasks.set("task-1", { status: "completed" });

      const engine = createSyncPolicyEngine(
        { onIssueClosed: "complete_task" },
        backend
      );

      await engine.handleIssueChange({
        type: "status_changed",
        issueId: "i-test",
        issue: { id: "i-test", status: "closed" } as any,
      });

      // Only task-2 should be completed (task-1 is already completed)
      expect(backend.complete).toHaveBeenCalledTimes(1);
      expect(backend.complete).toHaveBeenCalledWith("task-2", expect.anything());
    });

    it("should skip already failed tasks", async () => {
      backend._tasks.set("task-1", { status: "failed" });

      const engine = createSyncPolicyEngine(
        { onIssueClosed: "fail_task" },
        backend
      );

      await engine.handleIssueChange({
        type: "status_changed",
        issueId: "i-test",
        issue: { id: "i-test", status: "closed" } as any,
      });

      // Only task-2 should be failed (task-1 is already failed)
      expect(backend.fail).toHaveBeenCalledTimes(1);
    });
  });

  describe("issue deleted handling", () => {
    beforeEach(() => {
      backend._tasksByIssue.set("i-test", ["task-1"]);
      backend._tasks.set("task-1", { status: "in_progress" });
    });

    it("should always fail orphaned tasks when issue is deleted", async () => {
      const engine = createSyncPolicyEngine(
        { onIssueClosed: "notify_only" }, // Policy shouldn't matter for deleted
        backend
      );
      const events: SyncEvent[] = [];
      engine.onSyncEvent((e) => events.push(e));

      await engine.handleIssueChange({
        type: "deleted",
        issueId: "i-test",
      });

      expect(backend.fail).toHaveBeenCalledWith("task-1", {
        code: "ISSUE_DELETED",
        message: "Bound issue i-test was deleted",
      });
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("issue_deleted");
    });

    it("should skip terminal-state tasks when issue is deleted", async () => {
      backend._tasks.set("task-1", { status: "completed" });

      const engine = createSyncPolicyEngine({}, backend);

      await engine.handleIssueChange({
        type: "deleted",
        issueId: "i-test",
      });

      expect(backend.fail).not.toHaveBeenCalled();
    });
  });

  describe("blocker change handling", () => {
    beforeEach(() => {
      backend._tasksByIssue.set("i-test", ["task-1"]);
      backend._tasks.set("task-1", { status: "pending" });
    });

    it("update_blocked: should emit blocker_added events", async () => {
      const engine = createSyncPolicyEngine(
        { onBlockerChanged: "update_blocked" },
        backend
      );
      const events: SyncEvent[] = [];
      engine.onSyncEvent((e) => events.push(e));

      await engine.handleIssueChange({
        type: "blocked",
        issueId: "i-test",
        issue: { id: "i-test", status: "blocked" } as any,
      });

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("blocker_added");
    });

    it("notify_only: should also emit blocker_added events", async () => {
      const engine = createSyncPolicyEngine(
        { onBlockerChanged: "notify_only" },
        backend
      );
      const events: SyncEvent[] = [];
      engine.onSyncEvent((e) => events.push(e));

      await engine.handleIssueChange({
        type: "blocked",
        issueId: "i-test",
        issue: { id: "i-test", status: "blocked" } as any,
      });

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("blocker_added");
    });

    it("should emit blocker_removed events on unblocked", async () => {
      const engine = createSyncPolicyEngine({}, backend);
      const events: SyncEvent[] = [];
      engine.onSyncEvent((e) => events.push(e));

      await engine.handleIssueChange({
        type: "unblocked",
        issueId: "i-test",
        issue: { id: "i-test", status: "open" } as any,
      });

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("blocker_removed");
    });
  });

  describe("description change handling", () => {
    beforeEach(() => {
      backend._tasksByIssue.set("i-test", ["task-1"]);
      backend._tasks.set("task-1", { status: "pending" });
    });

    it("snapshot: should emit event but not update task", async () => {
      const engine = createSyncPolicyEngine(
        { onDescriptionChanged: "snapshot" },
        backend
      );
      const events: SyncEvent[] = [];
      engine.onSyncEvent((e) => events.push(e));

      await engine.handleIssueChange({
        type: "updated",
        issueId: "i-test",
        issue: { id: "i-test", content: "New description" } as any,
        previousIssue: { id: "i-test", content: "Old description" } as any,
      });

      expect(backend.update).not.toHaveBeenCalled();
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("description_changed");
      expect((events[0] as any).oldDescription).toBe("Old description");
      expect((events[0] as any).newDescription).toBe("New description");
    });

    it("propagate: should update task description", async () => {
      const engine = createSyncPolicyEngine(
        { onDescriptionChanged: "propagate" },
        backend
      );
      const events: SyncEvent[] = [];
      engine.onSyncEvent((e) => events.push(e));

      await engine.handleIssueChange({
        type: "updated",
        issueId: "i-test",
        issue: { id: "i-test", content: "New description" } as any,
        previousIssue: { id: "i-test", content: "Old description" } as any,
      });

      expect(backend.update).toHaveBeenCalledWith("task-1", {
        description: "New description",
      });
      expect(events).toHaveLength(1);
    });

    it("should not trigger when description is unchanged", async () => {
      const engine = createSyncPolicyEngine(
        { onDescriptionChanged: "propagate" },
        backend
      );
      const events: SyncEvent[] = [];
      engine.onSyncEvent((e) => events.push(e));

      await engine.handleIssueChange({
        type: "updated",
        issueId: "i-test",
        issue: { id: "i-test", content: "Same description" } as any,
        previousIssue: { id: "i-test", content: "Same description" } as any,
      });

      expect(backend.update).not.toHaveBeenCalled();
      expect(events).toHaveLength(0);
    });

    it("should handle undefined previous description", async () => {
      const engine = createSyncPolicyEngine(
        { onDescriptionChanged: "propagate" },
        backend
      );
      const events: SyncEvent[] = [];
      engine.onSyncEvent((e) => events.push(e));

      await engine.handleIssueChange({
        type: "updated",
        issueId: "i-test",
        issue: { id: "i-test", content: "New description" } as any,
        // No previousIssue
      });

      expect(backend.update).toHaveBeenCalledWith("task-1", {
        description: "New description",
      });
    });
  });

  describe("event subscription", () => {
    it("should allow multiple subscribers", async () => {
      const engine = createSyncPolicyEngine(
        { onIssueClosed: "notify_only" },
        backend
      );
      backend._tasksByIssue.set("i-test", ["task-1"]);
      backend._tasks.set("task-1", { status: "pending" });

      const events1: SyncEvent[] = [];
      const events2: SyncEvent[] = [];
      engine.onSyncEvent((e) => events1.push(e));
      engine.onSyncEvent((e) => events2.push(e));

      await engine.handleIssueChange({
        type: "status_changed",
        issueId: "i-test",
        issue: { id: "i-test", status: "closed" } as any,
      });

      expect(events1).toHaveLength(1);
      expect(events2).toHaveLength(1);
    });

    it("should unsubscribe correctly", async () => {
      const engine = createSyncPolicyEngine(
        { onIssueClosed: "notify_only" },
        backend
      );
      backend._tasksByIssue.set("i-test", ["task-1"]);
      backend._tasks.set("task-1", { status: "pending" });

      const events: SyncEvent[] = [];
      const unsubscribe = engine.onSyncEvent((e) => events.push(e));

      unsubscribe();

      await engine.handleIssueChange({
        type: "status_changed",
        issueId: "i-test",
        issue: { id: "i-test", status: "closed" } as any,
      });

      expect(events).toHaveLength(0);
    });

    it("should handle callback errors gracefully", async () => {
      const engine = createSyncPolicyEngine(
        { onIssueClosed: "notify_only" },
        backend
      );
      backend._tasksByIssue.set("i-test", ["task-1"]);
      backend._tasks.set("task-1", { status: "pending" });

      const goodEvents: SyncEvent[] = [];

      // First callback throws
      engine.onSyncEvent(() => {
        throw new Error("Callback error");
      });

      // Second callback should still receive events
      engine.onSyncEvent((e) => goodEvents.push(e));

      await engine.handleIssueChange({
        type: "status_changed",
        issueId: "i-test",
        issue: { id: "i-test", status: "closed" } as any,
      });

      expect(goodEvents).toHaveLength(1);
    });
  });

  describe("getPolicy", () => {
    it("should return a copy of the policy", () => {
      const policy: SyncPolicy = {
        onIssueClosed: "complete_task",
        onDescriptionChanged: "propagate",
        onBlockerChanged: "notify_only",
        updateIssueOnStart: false,
        updateIssueOnComplete: "always",
      };
      const engine = new SyncPolicyEngine(policy, backend);

      const returned = engine.getPolicy();

      // Should be equal but not the same object
      expect(returned).toEqual(policy);
      expect(returned).not.toBe(policy);
    });
  });

  describe("multiple tasks bound to same issue", () => {
    it("should handle multiple tasks correctly", async () => {
      backend._tasksByIssue.set("i-test", ["task-1", "task-2", "task-3"]);
      backend._tasks.set("task-1", { status: "pending" });
      backend._tasks.set("task-2", { status: "in_progress" });
      backend._tasks.set("task-3", { status: "completed" }); // Should be skipped

      const engine = createSyncPolicyEngine(
        { onIssueClosed: "complete_task" },
        backend
      );

      await engine.handleIssueChange({
        type: "status_changed",
        issueId: "i-test",
        issue: { id: "i-test", status: "closed" } as any,
      });

      // Only task-1 and task-2 should be completed
      expect(backend.complete).toHaveBeenCalledTimes(2);
      expect(backend.complete).toHaveBeenCalledWith("task-1", expect.anything());
      expect(backend.complete).toHaveBeenCalledWith("task-2", expect.anything());
    });
  });

  describe("non-closed status changes", () => {
    it("should not trigger onIssueClosed for non-closed status", async () => {
      backend._tasksByIssue.set("i-test", ["task-1"]);
      backend._tasks.set("task-1", { status: "pending" });

      const engine = createSyncPolicyEngine(
        { onIssueClosed: "complete_task" },
        backend
      );

      await engine.handleIssueChange({
        type: "status_changed",
        issueId: "i-test",
        issue: { id: "i-test", status: "in_progress" } as any,
      });

      expect(backend.complete).not.toHaveBeenCalled();
    });
  });

  describe("createSyncPolicyEngine factory", () => {
    it("should merge partial policy with defaults", () => {
      const engine = createSyncPolicyEngine(
        { onIssueClosed: "complete_task" },
        backend
      );

      const policy = engine.getPolicy();

      expect(policy.onIssueClosed).toBe("complete_task");
      expect(policy.onDescriptionChanged).toBe("snapshot"); // Default
      expect(policy.onBlockerChanged).toBe("update_blocked"); // Default
    });
  });
});
