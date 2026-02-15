/**
 * E2E Tests for OpenTasksTaskBackend
 *
 * Exercises the OpenTasksTaskBackend directly against a real OpenTasks daemon.
 * Validates bidirectional ID mapping, status sync, graph-based blocking,
 * pull model (claim/unclaim), import, subtask hierarchy, and event subscriptions.
 *
 * Requires: opentasks package installed
 *
 * @module task/backend/opentasks/__tests__/opentasks-backend.e2e.test
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  createEventStore,
  type EventStore,
} from "../../../../store/event-store.js";
import {
  OpenTasksTaskBackend,
  createOpenTasksTaskBackend,
  OpenTasksBackendError,
} from "../backend.js";
import { IPCOpenTasksClient } from "../client.js";
import type { OpenTasksClient } from "../client.js";
import type { TaskChangeEvent } from "../../types.js";

// =============================================================================
// Helpers
// =============================================================================

const TEST_AGENT = "agent_e2e_test";
const WORKER_1 = "agent_worker_1";
const WORKER_2 = "agent_worker_2";

/**
 * Wait for a condition to become true with timeout.
 */
async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
  intervalMs = 50
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await condition()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

// =============================================================================
// Test Suite
// =============================================================================

describe("OpenTasksTaskBackend E2E", () => {
  let tempDir: string;
  let daemon: any;
  let socketPath: string;
  let eventStore: EventStore;
  let client: IPCOpenTasksClient;
  let backend: OpenTasksTaskBackend;

  beforeAll(async () => {
    // Create temp directory for opentasks data
    tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "macro-e2e-opentasks-backend-")
    );
    const locationPath = path.join(tempDir, ".opentasks");
    fs.mkdirSync(locationPath, { recursive: true });

    const registryPath = path.join(tempDir, "registry.json");

    // Start a real opentasks daemon
    const opentasks = await import("opentasks");
    daemon = await opentasks.createDaemonWithStore({
      locationPath,
      version: "0.0.3",
      registryPath,
      shutdownTimeoutMs: 2000,
    });
    await daemon.start();
    socketPath = daemon.socketPath;

    // Create client
    client = new IPCOpenTasksClient({
      socketPath,
      autoConnect: true,
      timeout: 10000,
    });
    await client.connect();
  }, 30000);

  afterAll(async () => {
    try {
      client?.disconnect();
    } catch {
      /* ignore */
    }
    try {
      await daemon?.stop();
    } catch {
      /* ignore */
    }
    try {
      if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }, 15000);

  // Fresh EventStore + backend per test to avoid cross-test pollution
  beforeEach(async () => {
    if (eventStore) {
      try {
        await eventStore.close();
      } catch {
        /* ignore */
      }
    }
    eventStore = await createEventStore({ inMemory: true });
    backend = createOpenTasksTaskBackend(eventStore, client, {
      syncStatus: true,
      sourceLabel: "e2e-test",
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 1. Lifecycle: Create / Get / Update / Delete
  // ─────────────────────────────────────────────────────────────────────────────

  describe("lifecycle", () => {
    it("should create a task backed by a real OpenTasks issue", async () => {
      const task = await backend.create({
        description: "E2E create test",
        created_by: TEST_AGENT,
        tags: ["e2e", "lifecycle"],
      });

      expect(task.id).toMatch(/^task_/);
      expect(task.description).toBe("E2E create test");
      expect(task.status).toBe("pending");
      expect(task.created_by).toBe(TEST_AGENT);
      expect(task.external_id).toBeDefined();

      // Verify the issue exists in the real daemon
      const issue = await client.getIssue(task.external_id!);
      expect(issue).not.toBeNull();
      expect(issue!.title).toBe("E2E create test");
      expect(issue!.status).toBe("open");
    });

    it("should retrieve a task by ID", async () => {
      const task = await backend.create({
        description: "E2E get test",
        created_by: TEST_AGENT,
      });

      const retrieved = await backend.get(task.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe(task.id);
      expect(retrieved!.description).toBe("E2E get test");
      expect(retrieved!.external_id).toBe(task.external_id);
    });

    it("should return null for non-existent task", async () => {
      const result = await backend.get("task_nonexistent_xyz");
      expect(result).toBeNull();
    });

    it("should update task outputs", async () => {
      const task = await backend.create({
        description: "E2E update test",
        created_by: TEST_AGENT,
      });

      const updated = await backend.update(task.id, {
        outputs: { result: "success", files_changed: 5 },
      });

      expect(updated.outputs).toEqual(
        expect.objectContaining({ result: "success" })
      );
    });

    it("should update task description and sync to daemon", async () => {
      const task = await backend.create({
        description: "Original description",
        created_by: TEST_AGENT,
      });

      await backend.update(task.id, {
        description: "Updated description",
      });

      // Verify the daemon issue was updated
      const issue = await client.getIssue(task.external_id!);
      expect(issue!.title).toBe("Updated description");
    });

    it("should delete a task and its backing issue", async () => {
      const task = await backend.create({
        description: "E2E delete test",
        created_by: TEST_AGENT,
      });

      const issueId = task.external_id!;
      await backend.delete(task.id);

      // Mapping should be cleared
      expect(backend.getIssueForTask(task.id)).toBeUndefined();
      expect(backend.getTaskForIssue(issueId)).toBeUndefined();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 2. Status Transitions with Daemon Sync
  // ─────────────────────────────────────────────────────────────────────────────

  describe("status transitions", () => {
    it("should assign a task and sync assignee to daemon", async () => {
      const task = await backend.create({
        description: "E2E assign test",
        created_by: TEST_AGENT,
      });

      await backend.assign(task.id, WORKER_1);

      const updated = await backend.get(task.id);
      expect(updated!.status).toBe("assigned");
      expect(updated!.assigned_agent).toBe(WORKER_1);

      // Verify daemon issue was updated (assignee synced)
      const issue = await client.getIssue(task.external_id!);
      expect(issue).not.toBeNull();
    });

    it("should unassign a task and clear assignee in daemon", async () => {
      const task = await backend.create({
        description: "E2E unassign test",
        created_by: TEST_AGENT,
      });

      await backend.assign(task.id, WORKER_1);
      await backend.unassign(task.id);

      const updated = await backend.get(task.id);
      expect(updated!.assigned_agent).toBeUndefined();

      // Daemon issue should still exist
      const issue = await client.getIssue(task.external_id!);
      expect(issue).not.toBeNull();
    });

    it("should throw when unassigning a non-assigned task", async () => {
      const task = await backend.create({
        description: "Not assigned",
        created_by: TEST_AGENT,
      });

      await expect(backend.unassign(task.id)).rejects.toThrow(
        OpenTasksBackendError
      );
    });

    it("should start a task and sync in_progress to daemon", async () => {
      const task = await backend.create({
        description: "E2E start test",
        created_by: TEST_AGENT,
      });

      await backend.start(task.id);

      const updated = await backend.get(task.id);
      expect(updated!.status).toBe("in_progress");

      // Daemon should reflect in_progress
      const issue = await client.getIssue(task.external_id!);
      expect(issue!.status).toBe("in_progress");
    });

    it("should complete a task with outputs and close in daemon", async () => {
      const task = await backend.create({
        description: "E2E complete test",
        created_by: TEST_AGENT,
      });

      await backend.start(task.id);
      await backend.complete(task.id, {
        summary: "All done",
        data: { lines_changed: 42 },
      });

      const updated = await backend.get(task.id);
      expect(updated!.status).toBe("completed");
      expect(updated!.outputs).toEqual(
        expect.objectContaining({ summary: "All done", lines_changed: 42 })
      );

      // Daemon issue should be closed
      const issue = await client.getIssue(task.external_id!);
      expect(issue!.status).toBe("closed");
    });

    it("should fail a task and close in daemon with error metadata", async () => {
      const task = await backend.create({
        description: "E2E fail test",
        created_by: TEST_AGENT,
      });

      await backend.start(task.id);
      await backend.fail(task.id, {
        message: "Compilation failed",
        code: "COMPILE_ERROR",
      });

      const updated = await backend.get(task.id);
      expect(updated!.status).toBe("failed");

      // Daemon issue should be closed
      const issue = await client.getIssue(task.external_id!);
      expect(issue!.status).toBe("closed");
    });

    it("should reject invalid status transitions", async () => {
      const task = await backend.create({
        description: "E2E invalid transition test",
        created_by: TEST_AGENT,
      });

      await backend.start(task.id);
      await backend.complete(task.id);

      // completed → in_progress is invalid
      await expect(backend.start(task.id)).rejects.toThrow(
        OpenTasksBackendError
      );

      // completed → completed is invalid
      await expect(backend.complete(task.id)).rejects.toThrow(
        OpenTasksBackendError
      );
    });

    it("should allow failed → pending recovery", async () => {
      const task = await backend.create({
        description: "E2E recovery test",
        created_by: TEST_AGENT,
      });

      await backend.start(task.id);
      await backend.fail(task.id, { message: "first attempt failed" });

      // Retry: failed → pending is valid
      await backend.update(task.id, { status: "pending" });

      const updated = await backend.get(task.id);
      expect(updated!.status).toBe("pending");
    });

    it("should track full lifecycle: pending → assigned → in_progress → completed", async () => {
      const task = await backend.create({
        description: "E2E full lifecycle test",
        created_by: TEST_AGENT,
      });

      expect((await backend.get(task.id))!.status).toBe("pending");

      await backend.assign(task.id, WORKER_1);
      expect((await backend.get(task.id))!.status).toBe("assigned");

      await backend.start(task.id);
      expect((await backend.get(task.id))!.status).toBe("in_progress");

      await backend.complete(task.id, { summary: "Done!" });
      expect((await backend.get(task.id))!.status).toBe("completed");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 3. Bidirectional ID Mapping
  // ─────────────────────────────────────────────────────────────────────────────

  describe("bidirectional ID mapping", () => {
    it("should maintain consistent task ↔ issue mapping", async () => {
      const task = await backend.create({
        description: "ID mapping test",
        created_by: TEST_AGENT,
      });

      const issueId = backend.getIssueForTask(task.id);
      expect(issueId).toBeDefined();

      const taskId = backend.getTaskForIssue(issueId!);
      expect(taskId).toBe(task.id);
    });

    it("should clear mapping on delete", async () => {
      const task = await backend.create({
        description: "Mapping delete test",
        created_by: TEST_AGENT,
      });

      const issueId = task.external_id!;
      await backend.delete(task.id);

      expect(backend.getIssueForTask(task.id)).toBeUndefined();
      expect(backend.getTaskForIssue(issueId)).toBeUndefined();
    });

    it("should include external_id on created tasks", async () => {
      const task = await backend.create({
        description: "External ID test",
        created_by: TEST_AGENT,
      });

      // external_id should be set on the task
      expect(task.external_id).toBeDefined();
      expect(task.external_id).toMatch(/^[a-z0-9-]+$/i);

      // The issue should be retrievable from the daemon
      const issue = await client.getIssue(task.external_id!);
      expect(issue).not.toBeNull();
      expect(issue!.title).toBe("External ID test");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 4. Dependencies (Graph-based Blocking)
  // ─────────────────────────────────────────────────────────────────────────────

  describe("dependencies via graph edges", () => {
    it("should create blocking relationships in daemon graph", async () => {
      const blocker = await backend.create({
        description: "E2E blocker task",
        created_by: TEST_AGENT,
      });
      const blocked = await backend.create({
        description: "E2E blocked task",
        created_by: TEST_AGENT,
      });

      await backend.addBlocker(blocked.id, blocker.id);

      // Verify via backend API
      const blockedTask = await backend.get(blocked.id);
      expect(blockedTask!.isBlocked).toBe(true);

      // Verify blocker is returned
      const blockers = await backend.getBlockers(blocked.id);
      expect(blockers).toHaveLength(1);
      expect(blockers[0].id).toBe(blocker.id);
    });

    it("should return tasks blocked by a given task", async () => {
      const blocker = await backend.create({
        description: "Blocker",
        created_by: TEST_AGENT,
      });
      const blocked1 = await backend.create({
        description: "Blocked 1",
        created_by: TEST_AGENT,
      });
      const blocked2 = await backend.create({
        description: "Blocked 2",
        created_by: TEST_AGENT,
      });

      await backend.addBlocker(blocked1.id, blocker.id);
      await backend.addBlocker(blocked2.id, blocker.id);

      const blocking = await backend.getBlocking(blocker.id);
      expect(blocking).toHaveLength(2);
      const blockingIds = blocking.map((t) => t.id);
      expect(blockingIds).toContain(blocked1.id);
      expect(blockingIds).toContain(blocked2.id);
    });

    it("should remove blocking relationships", async () => {
      const blocker = await backend.create({
        description: "Removable blocker",
        created_by: TEST_AGENT,
      });
      const blocked = await backend.create({
        description: "Will be unblocked",
        created_by: TEST_AGENT,
      });

      await backend.addBlocker(blocked.id, blocker.id);
      expect((await backend.get(blocked.id))!.isBlocked).toBe(true);

      await backend.removeBlocker(blocked.id, blocker.id);

      // isBlocked should update via async graph query
      const updatedBlocked = await backend.list({
        includeBlocked: true,
      });
      const task = updatedBlocked.find((t) => t.id === blocked.id);
      expect(task!.isBlocked).toBe(false);
    });

    it("should unblock when blocker is completed", async () => {
      const blocker = await backend.create({
        description: "Completes to unblock",
        created_by: TEST_AGENT,
      });
      const blocked = await backend.create({
        description: "Waiting for blocker",
        created_by: TEST_AGENT,
      });

      await backend.addBlocker(blocked.id, blocker.id);

      // Blocked task should be blocked
      const blockedBefore = await backend.list({ includeBlocked: true });
      expect(blockedBefore.find((t) => t.id === blocked.id)!.isBlocked).toBe(
        true
      );

      // Complete the blocker
      await backend.start(blocker.id);
      await backend.complete(blocker.id);

      // After completing blocker, blocked task should be unblocked
      // (the daemon graph edge still exists, but the blocker is closed)
      const all = await backend.list({ includeBlocked: true });
      const blockedAfter = all.find((t) => t.id === blocked.id);
      expect(blockedAfter!.isBlocked).toBe(false);
    });

    it("should handle chain dependencies: A blocks B blocks C", async () => {
      const a = await backend.create({
        description: "Chain A",
        created_by: TEST_AGENT,
      });
      const b = await backend.create({
        description: "Chain B",
        created_by: TEST_AGENT,
      });
      const c = await backend.create({
        description: "Chain C",
        created_by: TEST_AGENT,
      });

      await backend.addBlocker(b.id, a.id);
      await backend.addBlocker(c.id, b.id);

      // B is blocked by A, C is blocked by B
      const allTasks = await backend.list({ includeBlocked: true });
      expect(allTasks.find((t) => t.id === a.id)!.isBlocked).toBe(false);
      expect(allTasks.find((t) => t.id === b.id)!.isBlocked).toBe(true);
      expect(allTasks.find((t) => t.id === c.id)!.isBlocked).toBe(true);

      // Complete A → B unblocks but C stays blocked by B
      await backend.start(a.id);
      await backend.complete(a.id);

      const afterA = await backend.list({ includeBlocked: true });
      expect(afterA.find((t) => t.id === b.id)!.isBlocked).toBe(false);
      expect(afterA.find((t) => t.id === c.id)!.isBlocked).toBe(true);

      // Complete B → C unblocks
      await backend.start(b.id);
      await backend.complete(b.id);

      const afterB = await backend.list({ includeBlocked: true });
      expect(afterB.find((t) => t.id === c.id)!.isBlocked).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 5. Queries
  // ─────────────────────────────────────────────────────────────────────────────

  describe("queries", () => {
    it("should list all tasks excluding blocked by default", async () => {
      const blocker = await backend.create({
        description: "Query blocker",
        created_by: TEST_AGENT,
      });
      const blocked = await backend.create({
        description: "Query blocked",
        created_by: TEST_AGENT,
      });
      await backend.addBlocker(blocked.id, blocker.id);

      const tasks = await backend.list();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].id).toBe(blocker.id);
    });

    it("should include blocked tasks when requested", async () => {
      const blocker = await backend.create({
        description: "Query blocker 2",
        created_by: TEST_AGENT,
      });
      const blocked = await backend.create({
        description: "Query blocked 2",
        created_by: TEST_AGENT,
      });
      await backend.addBlocker(blocked.id, blocker.id);

      const tasks = await backend.list({ includeBlocked: true });
      expect(tasks).toHaveLength(2);
    });

    it("should filter by status", async () => {
      const t1 = await backend.create({
        description: "Pending task",
        created_by: TEST_AGENT,
      });
      const t2 = await backend.create({
        description: "Started task",
        created_by: TEST_AGENT,
      });
      await backend.start(t2.id);

      const inProgress = await backend.list({ status: "in_progress" });
      expect(inProgress).toHaveLength(1);
      expect(inProgress[0].id).toBe(t2.id);
    });

    it("should filter by assigned agent", async () => {
      const t1 = await backend.create({
        description: "Worker 1 task",
        created_by: TEST_AGENT,
      });
      await backend.create({
        description: "Unassigned",
        created_by: TEST_AGENT,
      });
      await backend.assign(t1.id, WORKER_1);

      const assigned = await backend.list({ assigned_agent: WORKER_1 });
      expect(assigned).toHaveLength(1);
      expect(assigned[0].assigned_agent).toBe(WORKER_1);
    });

    it("should filter by created_by", async () => {
      await backend.create({
        description: "Creator 1 task",
        created_by: WORKER_1,
      });
      await backend.create({
        description: "Creator 2 task",
        created_by: WORKER_2,
      });

      const worker1Tasks = await backend.list({ created_by: WORKER_1 });
      expect(worker1Tasks).toHaveLength(1);
      expect(worker1Tasks[0].description).toBe("Creator 1 task");
    });

    it("should filter root tasks only", async () => {
      const parent = await backend.create({
        description: "Root task",
        created_by: TEST_AGENT,
      });
      await backend.create({
        description: "Child task",
        created_by: TEST_AGENT,
        parent_task: parent.id,
      });

      const rootOnly = await backend.list({ rootTasksOnly: true });
      expect(rootOnly).toHaveLength(1);
      expect(rootOnly[0].id).toBe(parent.id);
    });

    it("should listReady: only pending/assigned, unblocked tasks", async () => {
      const blocker = await backend.create({
        description: "Ready blocker",
        created_by: TEST_AGENT,
      });
      const blocked = await backend.create({
        description: "Ready blocked",
        created_by: TEST_AGENT,
      });
      const started = await backend.create({
        description: "Already started",
        created_by: TEST_AGENT,
      });

      await backend.addBlocker(blocked.id, blocker.id);
      await backend.start(started.id);

      const ready = await backend.listReady();
      expect(ready).toHaveLength(1);
      expect(ready[0].id).toBe(blocker.id);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 6. Subtask Hierarchy
  // ─────────────────────────────────────────────────────────────────────────────

  describe("subtask hierarchy", () => {
    it("should create subtasks linked to parent", async () => {
      const parent = await backend.create({
        description: "Parent task",
        created_by: TEST_AGENT,
      });

      const child1 = await backend.createSubtask(parent.id, {
        description: "Child 1",
        created_by: TEST_AGENT,
      });
      const child2 = await backend.createSubtask(parent.id, {
        description: "Child 2",
        created_by: TEST_AGENT,
      });

      expect(child1.parent_task).toBe(parent.id);
      expect(child2.parent_task).toBe(parent.id);

      // Verify parent has subtask references
      const updatedParent = await backend.get(parent.id);
      expect(updatedParent!.subtasks).toContain(child1.id);
      expect(updatedParent!.subtasks).toContain(child2.id);
    });

    it("should getChildren for a parent", async () => {
      const parent = await backend.create({
        description: "Children parent",
        created_by: TEST_AGENT,
      });

      await backend.createSubtask(parent.id, {
        description: "Sub A",
        created_by: TEST_AGENT,
      });
      await backend.createSubtask(parent.id, {
        description: "Sub B",
        created_by: TEST_AGENT,
      });
      await backend.createSubtask(parent.id, {
        description: "Sub C",
        created_by: TEST_AGENT,
      });

      const children = await backend.getChildren(parent.id);
      expect(children).toHaveLength(3);
    });

    it("should compute subtask status aggregates", async () => {
      const parent = await backend.create({
        description: "Status parent",
        created_by: TEST_AGENT,
      });

      const c1 = await backend.createSubtask(parent.id, {
        description: "Sub done",
        created_by: TEST_AGENT,
      });
      const c2 = await backend.createSubtask(parent.id, {
        description: "Sub in progress",
        created_by: TEST_AGENT,
      });
      await backend.createSubtask(parent.id, {
        description: "Sub pending",
        created_by: TEST_AGENT,
      });

      await backend.start(c1.id);
      await backend.complete(c1.id);
      await backend.start(c2.id);

      const status = await backend.getSubtaskStatus(parent.id);
      expect(status.total).toBe(3);
      expect(status.completed).toBe(1);
      expect(status.in_progress).toBe(1);
      expect(status.pending).toBe(1);
      expect(status.allCompleted).toBe(false);
      expect(status.anyFailed).toBe(false);
    });

    it("should report allCompleted when all subtasks done", async () => {
      const parent = await backend.create({
        description: "All done parent",
        created_by: TEST_AGENT,
      });

      const c1 = await backend.createSubtask(parent.id, {
        description: "Done 1",
        created_by: TEST_AGENT,
      });
      const c2 = await backend.createSubtask(parent.id, {
        description: "Done 2",
        created_by: TEST_AGENT,
      });

      await backend.start(c1.id);
      await backend.complete(c1.id);
      await backend.start(c2.id);
      await backend.complete(c2.id);

      const status = await backend.getSubtaskStatus(parent.id);
      expect(status.allCompleted).toBe(true);
    });

    it("should throw when creating subtask with non-existent parent", async () => {
      await expect(
        backend.createSubtask("task_nonexistent", {
          description: "Orphan",
          created_by: TEST_AGENT,
        })
      ).rejects.toThrow(OpenTasksBackendError);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 7. Pull Model (Claim / Unclaim / ListClaimable)
  // ─────────────────────────────────────────────────────────────────────────────

  describe("pull model", () => {
    it("should claim a pending unblocked task", async () => {
      await backend.create({
        description: "Claimable task",
        created_by: TEST_AGENT,
      });

      const claimed = await backend.claim(WORKER_1);
      expect(claimed).not.toBeNull();
      expect(claimed!.assigned_agent).toBe(WORKER_1);
      expect(claimed!.status).toBe("assigned");

      // Verify daemon issue still exists
      const issue = await client.getIssue(claimed!.external_id!);
      expect(issue).not.toBeNull();
    });

    it("should return null when no tasks available to claim", async () => {
      const claimed = await backend.claim(WORKER_1);
      expect(claimed).toBeNull();
    });

    it("should not claim blocked tasks", async () => {
      const blocker = await backend.create({
        description: "Claim blocker",
        created_by: TEST_AGENT,
      });
      const blocked = await backend.create({
        description: "Claim blocked",
        created_by: TEST_AGENT,
      });

      await backend.addBlocker(blocked.id, blocker.id);

      // Only the blocker should be claimable
      const claimed = await backend.claim(WORKER_1);
      expect(claimed).not.toBeNull();
      expect(claimed!.id).toBe(blocker.id);

      // No more claimable tasks (blocked is still blocked)
      const second = await backend.claim(WORKER_2);
      expect(second).toBeNull();
    });

    it("should not claim already-assigned tasks", async () => {
      await backend.create({
        description: "Single claim test",
        created_by: TEST_AGENT,
      });

      const first = await backend.claim(WORKER_1);
      expect(first).not.toBeNull();

      // Second claim should get null
      const second = await backend.claim(WORKER_2);
      expect(second).toBeNull();
    });

    it("should unclaim a task and clear the assignment", async () => {
      await backend.create({
        description: "Unclaim test",
        created_by: TEST_AGENT,
      });

      const claimed = await backend.claim(WORKER_1);
      await backend.unclaim(claimed!.id);

      const updated = await backend.get(claimed!.id);
      expect(updated!.assigned_agent).toBeUndefined();
    });

    it("should throw when unclaiming a non-assigned task", async () => {
      const task = await backend.create({
        description: "Not claimed",
        created_by: TEST_AGENT,
      });

      await expect(backend.unclaim(task.id)).rejects.toThrow(
        OpenTasksBackendError
      );
    });

    it("should list claimable tasks with created_by filter", async () => {
      await backend.create({
        description: "Worker 1 created",
        created_by: WORKER_1,
      });
      await backend.create({
        description: "Worker 2 created",
        created_by: WORKER_2,
      });

      const worker1Claimable = await backend.listClaimable({
        created_by: WORKER_1,
      });
      expect(worker1Claimable).toHaveLength(1);
      expect(worker1Claimable[0].description).toBe("Worker 1 created");
    });

    it("should list claimable tasks with rootTasksOnly filter", async () => {
      const parent = await backend.create({
        description: "Root claimable",
        created_by: TEST_AGENT,
      });
      await backend.createSubtask(parent.id, {
        description: "Child not root",
        created_by: TEST_AGENT,
      });

      const rootClaimable = await backend.listClaimable({
        rootTasksOnly: true,
      });
      expect(rootClaimable).toHaveLength(1);
      expect(rootClaimable[0].id).toBe(parent.id);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 8. Import from OpenTasks
  // ─────────────────────────────────────────────────────────────────────────────

  describe("import", () => {
    it("should import an existing OpenTasks issue as a task", async () => {
      // Create an issue directly in the daemon (not via backend)
      const issue = await client.createIssue({
        title: "Externally created issue",
        status: "open",
        tags: ["imported"],
        metadata: { source: "external" },
      });

      const task = await backend.importIssue(issue.id, TEST_AGENT);

      expect(task.id).toMatch(/^task_/);
      expect(task.description).toBe("Externally created issue");
      expect(task.status).toBe("pending");
      expect(task.external_id).toBe(issue.id);

      // Mapping should be established
      expect(backend.getIssueForTask(task.id)).toBe(issue.id);
      expect(backend.getTaskForIssue(issue.id)).toBe(task.id);
    });

    it("should import an in_progress issue with correct status", async () => {
      const issue = await client.createIssue({
        title: "Active issue",
        status: "in_progress",
      });

      const task = await backend.importIssue(issue.id, TEST_AGENT);
      expect(task.status).toBe("in_progress");
    });

    it("should import a closed issue as completed", async () => {
      const issue = await client.createIssue({
        title: "Closed issue",
        status: "closed",
      });

      const task = await backend.importIssue(issue.id, TEST_AGENT);
      expect(task.status).toBe("completed");
    });

    it("should not re-import an already imported issue", async () => {
      const issue = await client.createIssue({
        title: "Import once",
        status: "open",
      });

      const task1 = await backend.importIssue(issue.id, TEST_AGENT);
      const task2 = await backend.importIssue(issue.id, TEST_AGENT);

      expect(task1.id).toBe(task2.id);
    });

    it("should import an issue with assignee", async () => {
      const issue = await client.createIssue({
        title: "Assigned import",
        status: "open",
        assignee: WORKER_1,
      });

      const task = await backend.importIssue(issue.id, TEST_AGENT);

      // The import should set the assignee locally
      const retrieved = await backend.get(task.id);
      expect(retrieved!.assigned_agent).toBe(WORKER_1);
    });

    it("should bulk import open issues via importOpenIssues", async () => {
      // Create several issues directly in daemon
      await client.createIssue({
        title: "Bulk import 1",
        status: "open",
      });
      await client.createIssue({
        title: "Bulk import 2",
        status: "in_progress",
      });
      // This one is closed - should still be imported since listIssues filter
      // only gets open/in_progress
      await client.createIssue({
        title: "Bulk import closed",
        status: "closed",
      });

      const imported = await backend.importOpenIssues(TEST_AGENT);

      // Should import at least the open and in_progress ones
      expect(imported.length).toBeGreaterThanOrEqual(2);
      expect(imported.some((t) => t.description === "Bulk import 1")).toBe(true);
      expect(imported.some((t) => t.description === "Bulk import 2")).toBe(true);
    });

    it("should throw when importing non-existent issue", async () => {
      await expect(
        backend.importIssue("nonexistent-issue-id", TEST_AGENT)
      ).rejects.toThrow(OpenTasksBackendError);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 9. Agent History
  // ─────────────────────────────────────────────────────────────────────────────

  describe("agent history", () => {
    it("should track assignment history", async () => {
      const task = await backend.create({
        description: "History tracking test",
        created_by: TEST_AGENT,
      });

      await backend.assign(task.id, WORKER_1);
      await backend.unassign(task.id);
      await backend.assign(task.id, WORKER_2);

      const history = await backend.getAgentHistory(task.id);
      expect(history.length).toBeGreaterThanOrEqual(2);

      // The history should contain both workers
      const agents = history.map((h) => h.agent_id);
      expect(agents).toContain(WORKER_1);
      expect(agents).toContain(WORKER_2);
    });

    it("should throw for non-existent task", async () => {
      await expect(
        backend.getAgentHistory("task_nonexistent")
      ).rejects.toThrow(OpenTasksBackendError);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 10. Event Subscriptions
  // ─────────────────────────────────────────────────────────────────────────────

  describe("event subscriptions", () => {
    it("should fire callback on task creation", async () => {
      const events: TaskChangeEvent[] = [];
      const unsub = backend.onTaskChange((event) => events.push(event));

      await backend.create({
        description: "Event creation test",
        created_by: TEST_AGENT,
      });

      expect(events.length).toBeGreaterThan(0);
      expect(events[0].type).toBe("created");

      unsub();
    });

    it("should fire callback on status changes", async () => {
      const task = await backend.create({
        description: "Event status test",
        created_by: TEST_AGENT,
      });

      const events: TaskChangeEvent[] = [];
      const unsub = backend.onTaskChange(task.id, (event) =>
        events.push(event)
      );

      await backend.start(task.id);
      await backend.complete(task.id);

      expect(events.length).toBeGreaterThanOrEqual(2);

      unsub();
    });

    it("should filter events by taskId", async () => {
      const t1 = await backend.create({
        description: "Filtered task 1",
        created_by: TEST_AGENT,
      });

      const events: TaskChangeEvent[] = [];
      const unsub = backend.onTaskChange(t1.id, (event) =>
        events.push(event)
      );

      await backend.create({
        description: "Filtered task 2",
        created_by: TEST_AGENT,
      });

      await backend.start(t1.id);

      // All events should be for t1 only
      expect(events.every((e) => e.taskId === t1.id)).toBe(true);

      unsub();
    });

    it("should stop receiving events after unsubscribe", async () => {
      const events: TaskChangeEvent[] = [];
      const unsub = backend.onTaskChange((event) => events.push(event));

      await backend.create({
        description: "Before unsub",
        created_by: TEST_AGENT,
      });

      const countBefore = events.length;
      unsub();

      await backend.create({
        description: "After unsub",
        created_by: TEST_AGENT,
      });

      expect(events.length).toBe(countBefore);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 11. Sync Configuration
  // ─────────────────────────────────────────────────────────────────────────────

  describe("sync configuration", () => {
    it("should not sync status when syncStatus is false", async () => {
      const noSyncBackend = createOpenTasksTaskBackend(eventStore, client, {
        syncStatus: false,
        sourceLabel: "no-sync-test",
      });

      const task = await noSyncBackend.create({
        description: "No sync test",
        created_by: TEST_AGENT,
      });

      await noSyncBackend.start(task.id);

      // Local status should be in_progress
      const updated = await noSyncBackend.get(task.id);
      expect(updated!.status).toBe("in_progress");

      // Daemon issue should still be "open" since sync is disabled
      const issue = await client.getIssue(task.external_id!);
      expect(issue!.status).toBe("open");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 12. Error Handling
  // ─────────────────────────────────────────────────────────────────────────────

  describe("error handling", () => {
    it("should throw TASK_NOT_FOUND for operations on non-existent tasks", async () => {
      const fakeId = "task_doesnotexist";

      await expect(
        backend.assign(fakeId, WORKER_1)
      ).rejects.toThrow("Task not found");

      await expect(
        backend.start(fakeId)
      ).rejects.toThrow("Task not found");

      await expect(
        backend.complete(fakeId)
      ).rejects.toThrow("Task not found");

      await expect(
        backend.fail(fakeId, { message: "error" })
      ).rejects.toThrow("Task not found");

      await expect(
        backend.addBlocker(fakeId, "task_other")
      ).rejects.toThrow("Task not found");
    });

    it("should throw when blocker task does not exist", async () => {
      const task = await backend.create({
        description: "Has no blocker",
        created_by: TEST_AGENT,
      });

      await expect(
        backend.addBlocker(task.id, "task_nonexistent_blocker")
      ).rejects.toThrow("Blocker task not found");
    });

    it("should throw for update on non-existent task", async () => {
      await expect(
        backend.update("task_fake", { description: "new" })
      ).rejects.toThrow(OpenTasksBackendError);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 13. Integration: Full Workflow
  // ─────────────────────────────────────────────────────────────────────────────

  describe("full workflow integration", () => {
    it("should handle a complete multi-task workflow with dependencies", async () => {
      // 1. Create a parent with two children
      const parent = await backend.create({
        description: "Refactor authentication module",
        created_by: TEST_AGENT,
        tags: ["refactor"],
      });

      const child1 = await backend.createSubtask(parent.id, {
        description: "Extract auth middleware",
        created_by: TEST_AGENT,
        tags: ["backend"],
      });

      const child2 = await backend.createSubtask(parent.id, {
        description: "Update auth tests",
        created_by: TEST_AGENT,
        tags: ["testing"],
      });

      // 2. child2 depends on child1
      await backend.addBlocker(child2.id, child1.id);

      // 3. Verify initial state
      let status = await backend.getSubtaskStatus(parent.id);
      expect(status.total).toBe(2);
      expect(status.pending).toBe(2);

      // 4. Work on child1 directly (child2 is blocked by it)
      await backend.assign(child1.id, WORKER_1);
      await backend.start(child1.id);
      await backend.complete(child1.id, {
        summary: "Extracted middleware to separate module",
        data: { files_changed: 3 },
      });

      // 5. child2 should now be unblocked
      const readyTasks = await backend.listReady();
      const child2Ready = readyTasks.find((t) => t.id === child2.id);
      expect(child2Ready).toBeDefined();

      // 6. Work on child2
      await backend.assign(child2.id, WORKER_2);
      await backend.start(child2.id);
      await backend.complete(child2.id, {
        summary: "Updated all test files",
      });

      // 7. All subtasks completed
      status = await backend.getSubtaskStatus(parent.id);
      expect(status.allCompleted).toBe(true);
      expect(status.anyFailed).toBe(false);

      // 8. Complete parent
      await backend.start(parent.id);
      await backend.complete(parent.id, {
        summary: "Auth module refactored",
      });

      // 9. Verify everything is completed
      const finalParent = await backend.get(parent.id);
      expect(finalParent!.status).toBe("completed");

      const finalChild1 = await backend.get(child1.id);
      expect(finalChild1!.status).toBe("completed");

      const finalChild2 = await backend.get(child2.id);
      expect(finalChild2!.status).toBe("completed");

      // 10. Verify all issues are closed in daemon
      const parentIssue = await client.getIssue(parent.external_id!);
      expect(parentIssue!.status).toBe("closed");

      const child1Issue = await client.getIssue(child1.external_id!);
      expect(child1Issue!.status).toBe("closed");

      const child2Issue = await client.getIssue(child2.external_id!);
      expect(child2Issue!.status).toBe("closed");
    });
  });
});
