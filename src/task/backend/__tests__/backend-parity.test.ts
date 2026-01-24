/**
 * Backend Parity Tests
 *
 * Tests that verify InMemoryTaskBackend and SudocodeTaskBackend produce
 * identical results for the same operations. This ensures the pluggable
 * backend contract is maintained.
 *
 * @module task/backend/__tests__/backend-parity.test
 * @see s-8472 Pluggable Task Backend Integration
 * @see s-1zcx Multi-Agent Orchestration Testing Strategy
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createEventStore, type EventStore } from "../../../store/event-store.js";
import { InMemoryTaskBackend, createInMemoryTaskBackend } from "../memory.js";
import {
  SudocodeTaskBackend,
  createSudocodeTaskBackend,
} from "../sudocode/backend.js";
import type { SudocodeClient, Issue, IssueChangeCallback } from "../sudocode/client.js";
import type { TaskBackend, ExtendedTask } from "../types.js";

// Mock SudocodeClient that mimics InMemory behavior
function createMinimalMockClient(): SudocodeClient {
  const issues = new Map<string, Issue>();
  const issueBlockers = new Map<string, Issue[]>();
  const issueBlocking = new Map<string, Issue[]>();
  const issueChangeCallbacks: IssueChangeCallback[] = [];

  return {
    getIssue: vi.fn(async (id: string) => issues.get(id) ?? null),
    createIssue: vi.fn(async (data: Partial<Issue>) => {
      const id = `i-${Date.now()}`;
      const issue: Issue = {
        id,
        uuid: `uuid-${id}`,
        title: data.title ?? "Test Issue",
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
        const blockers = issueBlockers.get(i.id) ?? [];
        return blockers.every((b) => b.status === "closed");
      });
    }),
    getBlockers: vi.fn(async (id: string) => issueBlockers.get(id) ?? []),
    getBlocking: vi.fn(async (id: string) => issueBlocking.get(id) ?? []),
    createLink: vi.fn(async (from: string, to: string, type: string) => {
      if (type === "blocks") {
        const fromIssue = issues.get(from);
        if (!fromIssue) throw new Error(`Issue not found: ${from}`);
        const existing = issueBlockers.get(to) ?? [];
        issueBlockers.set(to, [...existing, fromIssue]);
        const blocking = issueBlocking.get(from) ?? [];
        issueBlocking.set(from, [...blocking, issues.get(to)!]);
      }
    }),
    removeLink: vi.fn(async (from: string, to: string, type: string) => {
      if (type === "blocks") {
        const blockers = issueBlockers.get(to) ?? [];
        issueBlockers.set(to, blockers.filter((b) => b.id !== from));
        const blocking = issueBlocking.get(from) ?? [];
        issueBlocking.set(from, blocking.filter((b) => b.id !== to));
      }
    }),
    onIssueChange: vi.fn((callback: IssueChangeCallback) => {
      issueChangeCallbacks.push(callback);
      return () => {
        const idx = issueChangeCallbacks.indexOf(callback);
        if (idx >= 0) issueChangeCallbacks.splice(idx, 1);
      };
    }),
    close: vi.fn(),
    isReady: vi.fn(() => true),
  } as unknown as SudocodeClient;
}

describe("Backend Parity", () => {
  let memoryEventStore: EventStore;
  let sudocodeEventStore: EventStore;
  let memoryBackend: InMemoryTaskBackend;
  let sudocodeBackend: SudocodeTaskBackend;
  let mockClient: SudocodeClient;
  const testAgentId = "agent_test";

  beforeEach(async () => {
    memoryEventStore = await createEventStore({ inMemory: true });
    sudocodeEventStore = await createEventStore({ inMemory: true });
    mockClient = createMinimalMockClient();

    memoryBackend = createInMemoryTaskBackend(memoryEventStore);
    sudocodeBackend = createSudocodeTaskBackend(
      sudocodeEventStore,
      mockClient,
      { syncStatus: false }
    );
  });

  afterEach(async () => {
    sudocodeBackend.close();
    await memoryEventStore.close();
    await sudocodeEventStore.close();
  });

  /**
   * Run the same operation on both backends and compare results
   */
  async function runOnBoth<T>(
    operation: (backend: TaskBackend) => Promise<T>
  ): Promise<{ memory: T; sudocode: T }> {
    const [memory, sudocode] = await Promise.all([
      operation(memoryBackend),
      operation(sudocodeBackend),
    ]);
    return { memory, sudocode };
  }

  /**
   * Compare task objects, ignoring timestamps and IDs
   */
  function compareTasks(a: ExtendedTask | null, b: ExtendedTask | null): void {
    if (!a && !b) return;
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    if (!a || !b) return;

    expect(a.description).toBe(b.description);
    expect(a.status).toBe(b.status);
    expect(a.isBlocked).toBe(b.isBlocked);
    expect(a.assigned_agent).toBe(b.assigned_agent);
  }

  describe("create operations", () => {
    it("should produce tasks with same fields", async () => {
      const memoryTask = await memoryBackend.create({
        description: "Test task",
        created_by: testAgentId,
      });
      const sudocodeTask = await sudocodeBackend.create({
        description: "Test task",
        created_by: testAgentId,
      });

      compareTasks(memoryTask, sudocodeTask);
    });

    it("should handle subtasks the same way", async () => {
      const memParent = await memoryBackend.create({
        description: "Parent",
        created_by: testAgentId,
      });
      const sudParent = await sudocodeBackend.create({
        description: "Parent",
        created_by: testAgentId,
      });

      const memChild = await memoryBackend.createSubtask(memParent.id, {
        description: "Child",
        created_by: testAgentId,
      });
      const sudChild = await sudocodeBackend.createSubtask(sudParent.id, {
        description: "Child",
        created_by: testAgentId,
      });

      expect(memChild.parent_task).toBe(memParent.id);
      expect(sudChild.parent_task).toBe(sudParent.id);
    });
  });

  describe("status transitions", () => {
    it("should follow same transition rules", async () => {
      // Create tasks
      const memTask = await memoryBackend.create({
        description: "Test",
        created_by: testAgentId,
      });
      const sudTask = await sudocodeBackend.create({
        description: "Test",
        created_by: testAgentId,
      });

      // Assign
      await memoryBackend.assign(memTask.id, "agent_a");
      await sudocodeBackend.assign(sudTask.id, "agent_a");

      const memAfterAssign = await memoryBackend.get(memTask.id);
      const sudAfterAssign = await sudocodeBackend.get(sudTask.id);
      compareTasks(memAfterAssign, sudAfterAssign);

      // Start
      await memoryBackend.start(memTask.id);
      await sudocodeBackend.start(sudTask.id);

      const memAfterStart = await memoryBackend.get(memTask.id);
      const sudAfterStart = await sudocodeBackend.get(sudTask.id);
      compareTasks(memAfterStart, sudAfterStart);

      // Complete
      await memoryBackend.complete(memTask.id);
      await sudocodeBackend.complete(sudTask.id);

      const memAfterComplete = await memoryBackend.get(memTask.id);
      const sudAfterComplete = await sudocodeBackend.get(sudTask.id);
      compareTasks(memAfterComplete, sudAfterComplete);
    });

    it("should reject same invalid transitions", async () => {
      // Create and complete a task
      const memTask = await memoryBackend.create({
        description: "Test",
        created_by: testAgentId,
      });
      const sudTask = await sudocodeBackend.create({
        description: "Test",
        created_by: testAgentId,
      });

      await memoryBackend.start(memTask.id);
      await sudocodeBackend.start(sudTask.id);
      await memoryBackend.complete(memTask.id);
      await sudocodeBackend.complete(sudTask.id);

      // Try to start completed task - both should reject
      await expect(memoryBackend.start(memTask.id)).rejects.toThrow(
        "Invalid status transition"
      );
      await expect(sudocodeBackend.start(sudTask.id)).rejects.toThrow(
        "Invalid status transition"
      );
    });
  });

  describe("delete behavior", () => {
    it("both backends throw 'not supported' on delete", async () => {
      const memTask = await memoryBackend.create({
        description: "Test",
        created_by: testAgentId,
      });
      const sudTask = await sudocodeBackend.create({
        description: "Test",
        created_by: testAgentId,
      });

      // Both backends should throw "not supported"
      await expect(memoryBackend.delete(memTask.id)).rejects.toThrow(
        "not supported"
      );
      await expect(sudocodeBackend.delete(sudTask.id)).rejects.toThrow(
        "not supported"
      );
    });

    it("delete throws for all task states", async () => {
      // Test that delete throws regardless of task state
      const pendingTask = await sudocodeBackend.create({
        description: "Pending",
        created_by: testAgentId,
      });

      const completedTask = await sudocodeBackend.create({
        description: "Completed",
        created_by: testAgentId,
      });
      await sudocodeBackend.start(completedTask.id);
      await sudocodeBackend.complete(completedTask.id);

      // Both should throw
      await expect(sudocodeBackend.delete(pendingTask.id)).rejects.toThrow(
        "not supported"
      );
      await expect(sudocodeBackend.delete(completedTask.id)).rejects.toThrow(
        "not supported"
      );
    });
  });

  describe("blocker operations", () => {
    it("should handle blockers identically", async () => {
      const memBlocker = await memoryBackend.create({
        description: "Blocker",
        created_by: testAgentId,
      });
      const memBlocked = await memoryBackend.create({
        description: "Blocked",
        created_by: testAgentId,
      });

      const sudBlocker = await sudocodeBackend.create({
        description: "Blocker",
        created_by: testAgentId,
      });
      const sudBlocked = await sudocodeBackend.create({
        description: "Blocked",
        created_by: testAgentId,
      });

      await memoryBackend.addBlocker(memBlocked.id, memBlocker.id);
      await sudocodeBackend.addBlocker(sudBlocked.id, sudBlocker.id);

      const memBlockedTask = await memoryBackend.get(memBlocked.id);
      const sudBlockedTask = await sudocodeBackend.get(sudBlocked.id);

      expect(memBlockedTask?.isBlocked).toBe(true);
      expect(sudBlockedTask?.isBlocked).toBe(true);
    });

    it("should unblock when blocker completes", async () => {
      const memBlocker = await memoryBackend.create({
        description: "Blocker",
        created_by: testAgentId,
      });
      const memBlocked = await memoryBackend.create({
        description: "Blocked",
        created_by: testAgentId,
      });

      const sudBlocker = await sudocodeBackend.create({
        description: "Blocker",
        created_by: testAgentId,
      });
      const sudBlocked = await sudocodeBackend.create({
        description: "Blocked",
        created_by: testAgentId,
      });

      await memoryBackend.addBlocker(memBlocked.id, memBlocker.id);
      await sudocodeBackend.addBlocker(sudBlocked.id, sudBlocker.id);

      // Complete blockers
      await memoryBackend.start(memBlocker.id);
      await memoryBackend.complete(memBlocker.id);
      await sudocodeBackend.start(sudBlocker.id);
      await sudocodeBackend.complete(sudBlocker.id);

      const memBlockedTask = await memoryBackend.get(memBlocked.id);
      const sudBlockedTask = await sudocodeBackend.get(sudBlocked.id);

      expect(memBlockedTask?.isBlocked).toBe(false);
      expect(sudBlockedTask?.isBlocked).toBe(false);
    });
  });

  describe("listReady operations", () => {
    it("should return same tasks for identical blocker configurations", async () => {
      // Create tasks in both backends
      const memReady = await memoryBackend.create({
        description: "Ready",
        created_by: testAgentId,
      });
      const memBlocker = await memoryBackend.create({
        description: "Blocker",
        created_by: testAgentId,
      });
      const memBlocked = await memoryBackend.create({
        description: "Blocked",
        created_by: testAgentId,
      });

      const sudReady = await sudocodeBackend.create({
        description: "Ready",
        created_by: testAgentId,
      });
      const sudBlocker = await sudocodeBackend.create({
        description: "Blocker",
        created_by: testAgentId,
      });
      const sudBlocked = await sudocodeBackend.create({
        description: "Blocked",
        created_by: testAgentId,
      });

      await memoryBackend.addBlocker(memBlocked.id, memBlocker.id);
      await sudocodeBackend.addBlocker(sudBlocked.id, sudBlocker.id);

      const memReadyTasks = await memoryBackend.listReady();
      const sudReadyTasks = await sudocodeBackend.listReady();

      // Should have same number of ready tasks
      expect(memReadyTasks.length).toBe(sudReadyTasks.length);

      // Ready and Blocker should be in ready lists
      expect(memReadyTasks.map((t) => t.description)).toContain("Ready");
      expect(memReadyTasks.map((t) => t.description)).toContain("Blocker");
      expect(memReadyTasks.map((t) => t.description)).not.toContain("Blocked");

      expect(sudReadyTasks.map((t) => t.description)).toContain("Ready");
      expect(sudReadyTasks.map((t) => t.description)).toContain("Blocker");
      expect(sudReadyTasks.map((t) => t.description)).not.toContain("Blocked");
    });
  });

  describe("subtask status operations", () => {
    it("should aggregate subtask status identically", async () => {
      const memParent = await memoryBackend.create({
        description: "Parent",
        created_by: testAgentId,
      });
      const sudParent = await sudocodeBackend.create({
        description: "Parent",
        created_by: testAgentId,
      });

      // Create subtasks
      const memChild1 = await memoryBackend.createSubtask(memParent.id, {
        description: "Child 1",
        created_by: testAgentId,
      });
      const memChild2 = await memoryBackend.createSubtask(memParent.id, {
        description: "Child 2",
        created_by: testAgentId,
      });

      const sudChild1 = await sudocodeBackend.createSubtask(sudParent.id, {
        description: "Child 1",
        created_by: testAgentId,
      });
      const sudChild2 = await sudocodeBackend.createSubtask(sudParent.id, {
        description: "Child 2",
        created_by: testAgentId,
      });

      // Complete one child
      await memoryBackend.start(memChild1.id);
      await memoryBackend.complete(memChild1.id);
      await sudocodeBackend.start(sudChild1.id);
      await sudocodeBackend.complete(sudChild1.id);

      const memStatus = await memoryBackend.getSubtaskStatus(memParent.id);
      const sudStatus = await sudocodeBackend.getSubtaskStatus(sudParent.id);

      expect(memStatus.total).toBe(sudStatus.total);
      expect(memStatus.completed).toBe(sudStatus.completed);
      expect(memStatus.pending).toBe(sudStatus.pending);
      expect(memStatus.allCompleted).toBe(sudStatus.allCompleted);
    });
  });
});
