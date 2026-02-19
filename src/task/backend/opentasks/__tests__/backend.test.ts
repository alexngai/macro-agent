/**
 * Tests for OpenTasksTaskBackend
 *
 * Uses a mock OpenTasksClient to test the backend without requiring
 * a running OpenTasks daemon.
 *
 * @module task/backend/opentasks/__tests__/backend.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createEventStore, type EventStore } from "../../../../store/event-store.js";
import {
  OpenTasksTaskBackend,
  OpenTasksBackendError,
  createOpenTasksTaskBackend,
} from "../backend.js";
import type { OpenTasksClient, OpenTasksIssue, OpenTasksNodeSummary } from "../client.js";

// =============================================================================
// Mock Client
// =============================================================================

function createMockClient(): OpenTasksClient {
  const issues = new Map<string, OpenTasksIssue>();
  let issueCounter = 0;

  const edges: Array<{ fromId: string; toId: string; type: string }> = [];

  return {
    createIssue: vi.fn(async (input) => {
      issueCounter++;
      const id = `i-mock${issueCounter}`;
      const issue: OpenTasksIssue = {
        id,
        uuid: `uuid-${id}`,
        type: "issue",
        title: input.title,
        content: input.content,
        status: input.status ?? "open",
        assignee: input.assignee,
        priority: input.priority,
        tags: input.tags,
        parent_id: input.parent_id,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        metadata: input.metadata,
      };
      issues.set(id, issue);
      return issue;
    }),

    getIssue: vi.fn(async (id) => {
      return issues.get(id) ?? null;
    }),

    updateIssue: vi.fn(async (id, updates) => {
      const issue = issues.get(id);
      if (!issue) throw new Error(`Issue not found: ${id}`);
      const updated = { ...issue, ...updates, updated_at: new Date().toISOString() };
      // Merge metadata instead of replacing
      if (updates.metadata && issue.metadata) {
        updated.metadata = { ...issue.metadata, ...updates.metadata };
      }
      issues.set(id, updated);
      return updated;
    }),

    deleteIssue: vi.fn(async (id) => {
      issues.delete(id);
    }),

    listIssues: vi.fn(async (filter) => {
      let result = Array.from(issues.values());
      if (filter?.status) {
        const statuses = Array.isArray(filter.status)
          ? filter.status
          : [filter.status];
        result = result.filter((i) => statuses.includes(i.status));
      }
      if (filter?.archived === false) {
        result = result.filter((i) => !i.archived);
      }
      return result;
    }),

    getReadyIssues: vi.fn(async () => {
      return Array.from(issues.values())
        .filter((i) => i.status === "open" && !i.assignee)
        .map((i) => ({
          id: i.id,
          type: "issue",
          title: i.title,
          status: i.status,
          priority: i.priority,
          archived: false,
        }));
    }),

    createEdge: vi.fn(async (fromId, toId, type) => {
      edges.push({ fromId, toId, type });
      return {
        id: `x-edge${edges.length}`,
        uuid: `uuid-edge${edges.length}`,
        from_id: fromId,
        to_id: toId,
        type,
        created_at: new Date().toISOString(),
      };
    }),

    removeEdge: vi.fn(async (fromId, toId, type) => {
      const idx = edges.findIndex(
        (e) => e.fromId === fromId && e.toId === toId && e.type === type
      );
      if (idx >= 0) edges.splice(idx, 1);
    }),

    getBlockers: vi.fn(async (nodeId) => {
      // Find edges where nodeId is the target (blocked by from)
      const blockerIds = edges
        .filter((e) => e.toId === nodeId && e.type === "blocks")
        .map((e) => e.fromId);

      return blockerIds
        .map((id) => {
          const issue = issues.get(id);
          if (!issue) return null;
          return {
            id: issue.id,
            type: "issue",
            title: issue.title,
            status: issue.status,
            priority: issue.priority,
            archived: false,
          } as OpenTasksNodeSummary;
        })
        .filter((s): s is OpenTasksNodeSummary => s !== null);
    }),

    getBlocking: vi.fn(async (nodeId) => {
      const blockedIds = edges
        .filter((e) => e.fromId === nodeId && e.type === "blocks")
        .map((e) => e.toId);

      return blockedIds
        .map((id) => {
          const issue = issues.get(id);
          if (!issue) return null;
          return {
            id: issue.id,
            type: "issue",
            title: issue.title,
            status: issue.status,
            priority: issue.priority,
            archived: false,
          } as OpenTasksNodeSummary;
        })
        .filter((s): s is OpenTasksNodeSummary => s !== null);
    }),

    isConnected: vi.fn(() => true),
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(() => {}),
  };
}

// =============================================================================
// Tests
// =============================================================================

describe("OpenTasksTaskBackend", () => {
  let eventStore: EventStore;
  let client: OpenTasksClient;
  let backend: OpenTasksTaskBackend;
  const testAgentId = "agent_test123";

  beforeEach(async () => {
    eventStore = await createEventStore({ inMemory: true });
    client = createMockClient();
    backend = createOpenTasksTaskBackend(eventStore, client);
  });

  afterEach(async () => {
    await eventStore.close();
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ─────────────────────────────────────────────────────────────────────────────

  describe("create", () => {
    it("should create a task and issue in OpenTasks", async () => {
      const task = await backend.create({
        description: "Test task",
        created_by: testAgentId,
      });

      expect(task.id).toMatch(/^task_/);
      expect(task.description).toBe("Test task");
      expect(task.status).toBe("pending");
      expect(task.created_by).toBe(testAgentId);
      expect(task.external_id).toMatch(/^i-mock/);

      // Verify client was called
      expect(client.createIssue).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Test task",
          status: "open",
          metadata: expect.objectContaining({
            macro_agent_task_id: task.id,
            created_by: testAgentId,
          }),
        })
      );
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

    it("should pass tags to OpenTasks when creating", async () => {
      await backend.create({
        description: "Tagged task",
        created_by: testAgentId,
        tags: ["auth", "backend"],
      });

      // Tags are passed to OpenTasks (EventStore doesn't persist tags natively)
      expect(client.createIssue).toHaveBeenCalledWith(
        expect.objectContaining({
          tags: ["auth", "backend"],
        })
      );
    });
  });

  describe("get", () => {
    it("should return task by ID", async () => {
      const task = await backend.create({
        description: "Test task",
        created_by: testAgentId,
      });

      const retrieved = await backend.get(task.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe(task.id);
      expect(retrieved!.external_id).toBe(task.external_id);
    });

    it("should return null for non-existent task", async () => {
      const result = await backend.get("task_nonexistent");
      expect(result).toBeNull();
    });
  });

  describe("delete", () => {
    it("should delete the task and issue", async () => {
      const task = await backend.create({
        description: "To delete",
        created_by: testAgentId,
      });

      await backend.delete(task.id);
      expect(client.deleteIssue).toHaveBeenCalledWith(task.external_id);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Status Transitions
  // ─────────────────────────────────────────────────────────────────────────────

  describe("assign", () => {
    it("should assign task and sync to OpenTasks", async () => {
      const task = await backend.create({
        description: "Assign me",
        created_by: testAgentId,
      });

      await backend.assign(task.id, "agent_worker1");

      const updated = await backend.get(task.id);
      expect(updated!.status).toBe("assigned");
      expect(updated!.assigned_agent).toBe("agent_worker1");

      // Verify OpenTasks was updated
      expect(client.updateIssue).toHaveBeenCalledWith(
        task.external_id,
        expect.objectContaining({
          assignee: "agent_worker1",
        })
      );
    });
  });

  describe("unassign", () => {
    it("should unassign task and clear in OpenTasks", async () => {
      const task = await backend.create({
        description: "Unassign me",
        created_by: testAgentId,
      });

      await backend.assign(task.id, "agent_worker1");
      await backend.unassign(task.id);

      const updated = await backend.get(task.id);
      expect(updated!.assigned_agent).toBeUndefined();

      // Verify OpenTasks cleared
      expect(client.updateIssue).toHaveBeenCalledWith(
        task.external_id,
        expect.objectContaining({
          assignee: null,
        })
      );
    });

    it("should throw for non-assigned task", async () => {
      const task = await backend.create({
        description: "Not assigned",
        created_by: testAgentId,
      });

      await expect(backend.unassign(task.id)).rejects.toThrow(
        OpenTasksBackendError
      );
    });
  });

  describe("start", () => {
    it("should transition to in_progress and sync", async () => {
      const task = await backend.create({
        description: "Start me",
        created_by: testAgentId,
      });

      await backend.start(task.id);

      const updated = await backend.get(task.id);
      expect(updated!.status).toBe("in_progress");

      expect(client.updateIssue).toHaveBeenCalledWith(
        task.external_id,
        expect.objectContaining({ status: "in_progress" })
      );
    });

    it("should reject invalid transitions", async () => {
      const task = await backend.create({
        description: "Complete me first",
        created_by: testAgentId,
      });

      // Move to completed
      await backend.start(task.id);
      await backend.complete(task.id);

      // Can't start a completed task
      await expect(backend.start(task.id)).rejects.toThrow(
        OpenTasksBackendError
      );
    });
  });

  describe("complete", () => {
    it("should complete task with outputs and close issue", async () => {
      const task = await backend.create({
        description: "Complete me",
        created_by: testAgentId,
      });

      await backend.start(task.id);
      await backend.complete(task.id, {
        summary: "Done!",
        data: { files_changed: 3 },
      });

      const updated = await backend.get(task.id);
      expect(updated!.status).toBe("completed");
      expect(updated!.outputs).toEqual(
        expect.objectContaining({ summary: "Done!" })
      );

      // Verify issue was closed
      expect(client.updateIssue).toHaveBeenCalledWith(
        task.external_id,
        expect.objectContaining({ status: "closed" })
      );
    });
  });

  describe("fail", () => {
    it("should fail task and close issue with error metadata", async () => {
      const task = await backend.create({
        description: "Fail me",
        created_by: testAgentId,
      });

      await backend.start(task.id);
      await backend.fail(task.id, {
        message: "Something went wrong",
        code: "COMPILE_ERROR",
      });

      const updated = await backend.get(task.id);
      expect(updated!.status).toBe("failed");

      // Verify issue was closed with error metadata
      expect(client.updateIssue).toHaveBeenCalledWith(
        task.external_id,
        expect.objectContaining({
          status: "closed",
          metadata: expect.objectContaining({
            macro_agent_failed: true,
            macro_agent_error: "Something went wrong",
          }),
        })
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Dependencies
  // ─────────────────────────────────────────────────────────────────────────────

  describe("addBlocker / removeBlocker", () => {
    it("should create a blocks edge in OpenTasks", async () => {
      const blocker = await backend.create({
        description: "Blocker task",
        created_by: testAgentId,
      });

      const blocked = await backend.create({
        description: "Blocked task",
        created_by: testAgentId,
      });

      await backend.addBlocker(blocked.id, blocker.id);

      // Verify edge was created
      expect(client.createEdge).toHaveBeenCalledWith(
        blocker.external_id,
        blocked.external_id,
        "blocks"
      );

      // Verify task is now blocked
      const updated = await backend.get(blocked.id);
      expect(updated!.isBlocked).toBe(true);
    });

    it("should remove a blocks edge in OpenTasks", async () => {
      const blocker = await backend.create({
        description: "Blocker task",
        created_by: testAgentId,
      });

      const blocked = await backend.create({
        description: "Blocked task",
        created_by: testAgentId,
      });

      await backend.addBlocker(blocked.id, blocker.id);
      await backend.removeBlocker(blocked.id, blocker.id);

      expect(client.removeEdge).toHaveBeenCalledWith(
        blocker.external_id,
        blocked.external_id,
        "blocks"
      );
    });
  });

  describe("getBlockers / getBlocking", () => {
    it("should return blockers from OpenTasks graph", async () => {
      const blocker = await backend.create({
        description: "Blocker",
        created_by: testAgentId,
      });

      const blocked = await backend.create({
        description: "Blocked",
        created_by: testAgentId,
      });

      await backend.addBlocker(blocked.id, blocker.id);

      const blockers = await backend.getBlockers(blocked.id);
      expect(blockers).toHaveLength(1);
      expect(blockers[0].id).toBe(blocker.id);
    });

    it("should return tasks blocked by a given task", async () => {
      const blocker = await backend.create({
        description: "Blocker",
        created_by: testAgentId,
      });

      const blocked = await backend.create({
        description: "Blocked",
        created_by: testAgentId,
      });

      await backend.addBlocker(blocked.id, blocker.id);

      const blocking = await backend.getBlocking(blocker.id);
      expect(blocking).toHaveLength(1);
      expect(blocking[0].id).toBe(blocked.id);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Queries
  // ─────────────────────────────────────────────────────────────────────────────

  describe("list", () => {
    it("should list all non-blocked tasks", async () => {
      await backend.create({ description: "Task 1", created_by: testAgentId });
      await backend.create({ description: "Task 2", created_by: testAgentId });

      const tasks = await backend.list();
      expect(tasks).toHaveLength(2);
    });

    it("should filter by status", async () => {
      const task = await backend.create({
        description: "Task 1",
        created_by: testAgentId,
      });

      await backend.start(task.id);

      await backend.create({
        description: "Task 2",
        created_by: testAgentId,
      });

      const inProgress = await backend.list({ status: "in_progress" });
      expect(inProgress).toHaveLength(1);
      expect(inProgress[0].id).toBe(task.id);
    });

    it("should filter by assigned agent", async () => {
      const t1 = await backend.create({
        description: "Agent 1 task",
        created_by: testAgentId,
      });
      await backend.create({
        description: "Unassigned task",
        created_by: testAgentId,
      });

      await backend.assign(t1.id, "agent_worker1");

      const agentTasks = await backend.list({ assigned_agent: "agent_worker1" });
      expect(agentTasks).toHaveLength(1);
      expect(agentTasks[0].id).toBe(t1.id);
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
      expect(tasks).toHaveLength(1);
      expect(tasks[0].id).toBe(blocker.id);
    });

    it("should include blocked tasks when requested", async () => {
      const blocker = await backend.create({
        description: "Blocker",
        created_by: testAgentId,
      });
      const blocked = await backend.create({
        description: "Blocked",
        created_by: testAgentId,
      });

      await backend.addBlocker(blocked.id, blocker.id);

      const tasks = await backend.list({ includeBlocked: true });
      expect(tasks).toHaveLength(2);
    });
  });

  describe("listReady", () => {
    it("should return only pending/assigned unblocked tasks", async () => {
      const t1 = await backend.create({
        description: "Ready task",
        created_by: testAgentId,
      });
      const t2 = await backend.create({
        description: "Blocked task",
        created_by: testAgentId,
      });

      await backend.addBlocker(t2.id, t1.id);

      const ready = await backend.listReady();
      expect(ready).toHaveLength(1);
      expect(ready[0].id).toBe(t1.id);
    });
  });

  describe("getChildren / getSubtaskStatus", () => {
    it("should return children of a parent task", async () => {
      const parent = await backend.create({
        description: "Parent",
        created_by: testAgentId,
      });

      await backend.create({
        description: "Child 1",
        created_by: testAgentId,
        parent_task: parent.id,
      });
      await backend.create({
        description: "Child 2",
        created_by: testAgentId,
        parent_task: parent.id,
      });

      const children = await backend.getChildren(parent.id);
      expect(children).toHaveLength(2);
    });

    it("should compute subtask status aggregates", async () => {
      const parent = await backend.create({
        description: "Parent",
        created_by: testAgentId,
      });

      const c1 = await backend.create({
        description: "Child 1",
        created_by: testAgentId,
        parent_task: parent.id,
      });
      await backend.create({
        description: "Child 2",
        created_by: testAgentId,
        parent_task: parent.id,
      });

      await backend.start(c1.id);
      await backend.complete(c1.id);

      const status = await backend.getSubtaskStatus(parent.id);
      expect(status.total).toBe(2);
      expect(status.completed).toBe(1);
      expect(status.pending).toBe(1);
      expect(status.allCompleted).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Pull Model
  // ─────────────────────────────────────────────────────────────────────────────

  describe("claim / unclaim / listClaimable", () => {
    it("should claim a pending task", async () => {
      await backend.create({
        description: "Claimable task",
        created_by: testAgentId,
      });

      const claimed = await backend.claim("agent_worker1");
      expect(claimed).not.toBeNull();
      expect(claimed!.assigned_agent).toBe("agent_worker1");
      expect(claimed!.status).toBe("assigned");

      // Verify OpenTasks was updated
      expect(client.updateIssue).toHaveBeenCalledWith(
        claimed!.external_id,
        expect.objectContaining({
          assignee: "agent_worker1",
        })
      );
    });

    it("should return null when no tasks available", async () => {
      const claimed = await backend.claim("agent_worker1");
      expect(claimed).toBeNull();
    });

    it("should not claim blocked tasks", async () => {
      const blocker = await backend.create({
        description: "Blocker",
        created_by: testAgentId,
      });
      const blocked = await backend.create({
        description: "Blocked",
        created_by: testAgentId,
      });

      await backend.addBlocker(blocked.id, blocker.id);

      // Claim should pick the blocker, not the blocked task
      const claimed = await backend.claim("agent_worker1");
      expect(claimed).not.toBeNull();
      expect(claimed!.id).toBe(blocker.id);
    });

    it("should unclaim a task", async () => {
      await backend.create({
        description: "Unclaim me",
        created_by: testAgentId,
      });

      const claimed = await backend.claim("agent_worker1");
      await backend.unclaim(claimed!.id);

      const updated = await backend.get(claimed!.id);
      expect(updated!.assigned_agent).toBeUndefined();

      // Verify OpenTasks cleared
      expect(client.updateIssue).toHaveBeenCalledWith(
        claimed!.external_id,
        expect.objectContaining({
          assignee: null,
        })
      );
    });

    it("should list claimable tasks", async () => {
      await backend.create({
        description: "Available 1",
        created_by: testAgentId,
        tags: ["auth"],
      });
      await backend.create({
        description: "Available 2",
        created_by: testAgentId,
        tags: ["ui"],
      });

      // Claim one
      await backend.claim("agent_worker1");

      const claimable = await backend.listClaimable();
      expect(claimable).toHaveLength(1);
    });

    it("should filter claimable to root tasks only", async () => {
      const parent = await backend.create({
        description: "Parent task",
        created_by: testAgentId,
      });
      await backend.create({
        description: "Child task",
        created_by: testAgentId,
        parent_task: parent.id,
      });

      const claimable = await backend.listClaimable({ rootTasksOnly: true });
      expect(claimable).toHaveLength(1);
      expect(claimable[0].description).toBe("Parent task");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Import
  // ─────────────────────────────────────────────────────────────────────────────

  describe("importIssue", () => {
    it("should import an existing OpenTasks issue as a task", async () => {
      // Create an issue directly in the mock client
      const issue = await client.createIssue({
        title: "External issue",
        status: "open",
        tags: ["imported"],
      });

      const task = await backend.importIssue(issue.id, testAgentId);

      expect(task.id).toMatch(/^task_/);
      expect(task.description).toBe("External issue");
      expect(task.status).toBe("pending");
      expect(task.external_id).toBe(issue.id);

      // Verify ID mapping
      expect(backend.getIssueForTask(task.id)).toBe(issue.id);
      expect(backend.getTaskForIssue(issue.id)).toBe(task.id);
    });

    it("should import an in_progress issue with correct status", async () => {
      const issue = await client.createIssue({
        title: "Active issue",
        status: "in_progress",
      });

      // Update the mock to return in_progress
      (client.getIssue as any).mockResolvedValueOnce({
        ...issue,
        status: "in_progress",
      });

      const task = await backend.importIssue(issue.id, testAgentId);
      expect(task.status).toBe("in_progress");
    });

    it("should not re-import an already imported issue", async () => {
      const issue = await client.createIssue({
        title: "Already imported",
        status: "open",
      });

      const task1 = await backend.importIssue(issue.id, testAgentId);
      const task2 = await backend.importIssue(issue.id, testAgentId);

      expect(task1.id).toBe(task2.id);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // ID Mapping
  // ─────────────────────────────────────────────────────────────────────────────

  describe("ID mapping", () => {
    it("should maintain bidirectional task <-> issue mapping", async () => {
      const task = await backend.create({
        description: "Mapped task",
        created_by: testAgentId,
      });

      const issueId = backend.getIssueForTask(task.id);
      expect(issueId).toBeDefined();
      expect(issueId).toMatch(/^i-mock/);

      const taskId = backend.getTaskForIssue(issueId!);
      expect(taskId).toBe(task.id);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Event Subscriptions
  // ─────────────────────────────────────────────────────────────────────────────

  describe("onTaskChange", () => {
    it("should fire callback on task creation", async () => {
      const events: any[] = [];
      backend.onTaskChange((event) => events.push(event));

      await backend.create({
        description: "New task",
        created_by: testAgentId,
      });

      expect(events.length).toBeGreaterThan(0);
      expect(events[0].type).toBe("created");
    });

    it("should filter by taskId", async () => {
      const task1 = await backend.create({
        description: "Task 1",
        created_by: testAgentId,
      });

      const events: any[] = [];
      backend.onTaskChange(task1.id, (event) => events.push(event));

      await backend.create({
        description: "Task 2",
        created_by: testAgentId,
      });

      await backend.start(task1.id);

      // Should only have events for task1
      expect(events.every((e) => e.taskId === task1.id)).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // close()
  // ─────────────────────────────────────────────────────────────────────────────

  describe("close()", () => {
    it("should mark backend as closed", async () => {
      await backend.close();

      // Write operations should throw BACKEND_CLOSED
      await expect(
        backend.create({ description: "after close", created_by: testAgentId })
      ).rejects.toThrow("Backend is closed");
    });

    it("should throw BACKEND_CLOSED on write operations after close", async () => {
      // Create a task before closing
      const task = await backend.create({
        description: "Test task",
        created_by: testAgentId,
      });

      await backend.close();

      // All write methods should throw with BACKEND_CLOSED code
      const expectClosed = async (fn: () => Promise<unknown>) => {
        try {
          await fn();
          throw new Error("Expected to throw");
        } catch (err: any) {
          expect(err.code).toBe("BACKEND_CLOSED");
          expect(err.message).toBe("Backend is closed");
        }
      };

      await expectClosed(() => backend.create({ description: "x", created_by: testAgentId }));
      await expectClosed(() => backend.update(task.id, { description: "x" }));
      await expectClosed(() => backend.delete(task.id));
      await expectClosed(() => backend.assign(task.id, testAgentId));
      await expectClosed(() => backend.start(task.id));
      await expectClosed(() => backend.complete(task.id));
      await expectClosed(() => backend.fail(task.id, { message: "err" }));
      await expectClosed(() => backend.addBlocker(task.id, task.id));
      await expectClosed(() => backend.removeBlocker(task.id, task.id));
      await expectClosed(() => backend.claim!(testAgentId));
    });

    it("should still allow read operations after close", async () => {
      // Create a task before closing
      const task = await backend.create({
        description: "readable after close",
        created_by: testAgentId,
      });

      await backend.close();

      // Read-only operations should still work
      const fetched = await backend.get(task.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.description).toBe("readable after close");

      const listed = await backend.list();
      expect(listed.length).toBe(1);

      const children = await backend.getChildren(task.id);
      expect(children).toEqual([]);

      const status = await backend.getSubtaskStatus(task.id);
      expect(status.total).toBe(0);

      const history = await backend.getAgentHistory(task.id);
      expect(history).toEqual([]);
    });
  });
});
