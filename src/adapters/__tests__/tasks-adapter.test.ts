/**
 * Tests for TasksAdapter — wraps opentasks client.
 *
 * These tests use mocked opentasks client since the adapter is a thin
 * wrapper. Integration tests with a real opentasks daemon would go
 * in the e2e test suite.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { DefaultTasksAdapter } from "../tasks-adapter.js";

// Mock the opentasks module
vi.mock("opentasks", () => ({
  OpenTasksClient: vi.fn().mockImplementation(() => mockClient),
}));

// Shared mock client
let mockClient: MockOpenTasksClient;

interface MockOpenTasksClient {
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  query: ReturnType<typeof vi.fn>;
  link: ReturnType<typeof vi.fn>;
  task: ReturnType<typeof vi.fn>;
}

function createMockClient(): MockOpenTasksClient {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
    query: vi.fn().mockResolvedValue({ items: [] }),
    link: vi.fn().mockResolvedValue({ success: true }),
    task: vi.fn().mockResolvedValue({ id: "t-new", success: true }),
  };
}

describe("TasksAdapter", () => {
  let adapter: DefaultTasksAdapter;

  beforeEach(async () => {
    mockClient = createMockClient();
    adapter = new DefaultTasksAdapter();
    await adapter.connect();
  });

  // ── Connection ─────────────────────────────────────────────

  describe("connection lifecycle", () => {
    it("should connect to opentasks daemon", () => {
      expect(adapter.connected).toBe(true);
      expect(mockClient.connect).toHaveBeenCalledOnce();
    });

    it("should not reconnect if already connected", async () => {
      await adapter.connect();
      expect(mockClient.connect).toHaveBeenCalledOnce();
    });

    it("should disconnect", () => {
      adapter.disconnect();
      expect(adapter.connected).toBe(false);
    });

    it("should throw when not connected", async () => {
      adapter.disconnect();
      await expect(adapter.getTask("t-1")).rejects.toThrow("not connected");
    });
  });

  // ── createTask ─────────────────────────────────────────────

  describe("createTask", () => {
    it("should create a task and return ID", async () => {
      mockClient.task.mockResolvedValue({ id: "t-abc123" });

      const id = await adapter.createTask({
        title: "Implement feature X",
        assignee: "worker-1",
        tags: ["backend"],
      });

      expect(id).toBe("t-abc123");
      expect(mockClient.task).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            title: "Implement feature X",
            assignee: "worker-1",
            tags: ["backend"],
          }),
        })
      );
    });
  });

  // ── assignTask ─────────────────────────────────────────────

  describe("assignTask", () => {
    it("should assign a task to an agent", async () => {
      await adapter.assignTask("t-1", "worker-1");

      expect(mockClient.task).toHaveBeenCalledWith({
        assign: { id: "t-1", assignee: "worker-1" },
      });
    });
  });

  // ── transitionTask ─────────────────────────────────────────

  describe("transitionTask", () => {
    it("should transition task state", async () => {
      await adapter.transitionTask("t-1", "complete");

      expect(mockClient.task).toHaveBeenCalledWith({
        transition: { id: "t-1", action: "complete" },
      });
    });

    it("should support all actions", async () => {
      for (const action of [
        "start",
        "complete",
        "fail",
        "block",
        "reopen",
      ] as const) {
        mockClient.task.mockClear();
        await adapter.transitionTask("t-1", action);
        expect(mockClient.task).toHaveBeenCalledWith({
          transition: { id: "t-1", action },
        });
      }
    });
  });

  // ── getTask ────────────────────────────────────────────────

  describe("getTask", () => {
    it("should return a task record", async () => {
      mockClient.query.mockResolvedValue({
        items: [
          {
            id: "t-1",
            title: "Test Task",
            status: "in_progress",
            assignee: "worker-1",
            tags: ["urgent"],
            priority: 1,
          },
        ],
      });

      const task = await adapter.getTask("t-1");
      expect(task.id).toBe("t-1");
      expect(task.title).toBe("Test Task");
      expect(task.status).toBe("in_progress");
      expect(task.assignee).toBe("worker-1");
      expect(task.tags).toEqual(["urgent"]);
    });

    it("should throw for non-existent task", async () => {
      mockClient.query.mockResolvedValue({ items: [] });
      await expect(adapter.getTask("t-missing")).rejects.toThrow(
        "Task not found"
      );
    });
  });

  // ── queryReady ─────────────────────────────────────────────

  describe("queryReady", () => {
    it("should return ready tasks", async () => {
      mockClient.query.mockResolvedValue({
        items: [
          { id: "t-1", title: "Ready task", status: "open" },
          { id: "t-2", title: "Another ready", status: "open" },
        ],
      });

      const ready = await adapter.queryReady({ limit: 10 });
      expect(ready).toHaveLength(2);
      expect(ready[0].status).toBe("open");
    });

    it("should pass filter options", async () => {
      await adapter.queryReady({ tags: ["backend"], limit: 5 });

      expect(mockClient.query).toHaveBeenCalledWith({
        ready: { tags: ["backend"], limit: 5 },
      });
    });
  });

  // ── Dependencies ───────────────────────────────────────────

  describe("addBlocker / removeBlocker", () => {
    it("should add a blocking edge", async () => {
      await adapter.addBlocker("t-impl", "t-spec");

      expect(mockClient.link).toHaveBeenCalledWith({
        from_id: "t-spec",
        to_id: "t-impl",
        type: "blocks",
      });
    });

    it("should remove a blocking edge", async () => {
      await adapter.removeBlocker("t-impl", "t-spec");

      expect(mockClient.link).toHaveBeenCalledWith({
        from_id: "t-spec",
        to_id: "t-impl",
        type: "blocks",
        remove: true,
      });
    });
  });

  // ── Pull Mode ──────────────────────────────────────────────

  describe("claimTask", () => {
    it("should claim the first ready task", async () => {
      mockClient.query.mockResolvedValue({
        items: [{ id: "t-1", title: "Claimable", status: "open" }],
      });

      const claimed = await adapter.claimTask("worker-1");
      expect(claimed).not.toBeNull();
      expect(claimed!.id).toBe("t-1");
      expect(claimed!.status).toBe("in_progress");

      // Should assign then start
      expect(mockClient.task).toHaveBeenCalledWith({
        assign: { id: "t-1", assignee: "worker-1" },
      });
      expect(mockClient.task).toHaveBeenCalledWith({
        transition: { id: "t-1", action: "start" },
      });
    });

    it("should return null when no tasks available", async () => {
      mockClient.query.mockResolvedValue({ items: [] });
      const claimed = await adapter.claimTask("worker-1");
      expect(claimed).toBeNull();
    });
  });

  describe("unclaimTask", () => {
    it("should reopen and unassign", async () => {
      await adapter.unclaimTask("t-1");

      expect(mockClient.task).toHaveBeenCalledWith({
        transition: { id: "t-1", action: "reopen" },
      });
      expect(mockClient.task).toHaveBeenCalledWith({
        assign: { id: "t-1", assignee: "" },
      });
    });
  });

  describe("listClaimable", () => {
    it("should delegate to queryReady", async () => {
      mockClient.query.mockResolvedValue({
        items: [{ id: "t-1", title: "Available", status: "open" }],
      });

      const claimable = await adapter.listClaimable({ limit: 5 });
      expect(claimable).toHaveLength(1);
    });
  });
});
