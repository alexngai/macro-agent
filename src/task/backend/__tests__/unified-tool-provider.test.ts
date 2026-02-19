/**
 * Tests for UnifiedTaskToolProvider
 *
 * Covers:
 * - Core CRUD tools (create_task, get_task, list_tasks, assign_task) with in-memory backend
 * - OpenTasks graph tools (task, link, annotate) with mock client
 * - Tool exclusion and conditional tool exposure
 *
 * @module task/backend/__tests__/unified-tool-provider.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createEventStore, type EventStore } from "../../../store/event-store.js";
import { InMemoryTaskBackend, createInMemoryTaskBackend } from "../memory.js";
import {
  UnifiedTaskToolProvider,
  createUnifiedToolProvider,
} from "../unified-tool-provider.js";
import type { OpenTasksClient } from "../opentasks/client.js";
import type { MCPToolDefinition } from "../types.js";

// =============================================================================
// Helpers
// =============================================================================

const TEST_AGENT_ID = "agent_test123";
const getContext = () => ({ agent_id: TEST_AGENT_ID });

function findTool(
  tools: MCPToolDefinition[],
  name: string
): MCPToolDefinition | undefined {
  return tools.find((t) => t.name === name);
}

function createMockOpenTasksClient(): OpenTasksClient {
  return {
    createIssue: vi.fn().mockResolvedValue({ id: "i-abc1", title: "test", status: "open" }),
    getIssue: vi.fn().mockResolvedValue({
      id: "i-abc1",
      type: "issue",
      title: "test",
      content: "body",
      status: "open",
      priority: 2,
      tags: [],
      assignee: null,
      parent_id: null,
      claimed_by: null,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      metadata: {},
    }),
    updateIssue: vi.fn().mockResolvedValue({ id: "i-abc1", title: "test", status: "open" }),
    deleteIssue: vi.fn().mockResolvedValue(undefined),
    listIssues: vi.fn().mockResolvedValue([]),
    getReadyIssues: vi.fn().mockResolvedValue([]),
    createEdge: vi.fn().mockResolvedValue({ id: "e-123", from_id: "i-1", to_id: "i-2", type: "blocks" }),
    removeEdge: vi.fn().mockResolvedValue(undefined),
    getBlockers: vi.fn().mockResolvedValue([]),
    getBlocking: vi.fn().mockResolvedValue([]),
    task: vi.fn().mockResolvedValue({ success: true, data: {} }),
    taskTransition: vi.fn().mockResolvedValue({ success: true, data: { id: "i-1", status: "in_progress" } }),
    taskReady: vi.fn().mockResolvedValue({ success: true, data: { type: "ready", items: [], total: 0 } }),
    taskAssign: vi.fn().mockResolvedValue({ success: true, data: { id: "i-1", assignee: TEST_AGENT_ID } }),
    taskValidActions: vi.fn().mockResolvedValue({ success: true, data: { id: "i-1", actions: ["start", "close"] } }),
    listProviders: vi.fn().mockResolvedValue([]),
    isConnected: vi.fn().mockReturnValue(true),
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
  } as unknown as OpenTasksClient;
}

// =============================================================================
// Tests
// =============================================================================

describe("UnifiedTaskToolProvider", () => {
  let eventStore: EventStore;
  let backend: InMemoryTaskBackend;

  beforeEach(async () => {
    eventStore = await createEventStore({ inMemory: true });
    backend = createInMemoryTaskBackend(eventStore);
  });

  afterEach(async () => {
    await eventStore.close();
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Tool Exposure
  // ─────────────────────────────────────────────────────────────────────────────

  describe("tool exposure", () => {
    it("should expose 4 core tools when no OpenTasks client provided", () => {
      const provider = new UnifiedTaskToolProvider(backend, getContext);
      const tools = provider.getTools();

      expect(tools).toHaveLength(4);
      expect(tools.map((t) => t.name)).toEqual([
        "create_task",
        "get_task",
        "list_tasks",
        "assign_task",
      ]);
    });

    it("should expose 8 tools when OpenTasks client is provided", () => {
      const client = createMockOpenTasksClient();
      const provider = new UnifiedTaskToolProvider(backend, getContext, client);
      const tools = provider.getTools();

      expect(tools).toHaveLength(8);
      expect(tools.map((t) => t.name)).toEqual([
        "create_task",
        "get_task",
        "list_tasks",
        "assign_task",
        "task",
        "link",
        "annotate",
        "list_providers",
      ]);
    });

    it("should exclude built-in create_task and get_task", () => {
      const provider = new UnifiedTaskToolProvider(backend, getContext);
      const excluded = provider.getExcludedTools();

      expect(excluded).toEqual(["create_task", "get_task"]);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Factory
  // ─────────────────────────────────────────────────────────────────────────────

  describe("createUnifiedToolProvider", () => {
    it("should create provider without client", () => {
      const provider = createUnifiedToolProvider(backend, getContext);
      expect(provider).toBeInstanceOf(UnifiedTaskToolProvider);
      expect(provider.getTools()).toHaveLength(4);
    });

    it("should create provider with client", () => {
      const client = createMockOpenTasksClient();
      const provider = createUnifiedToolProvider(backend, getContext, client);
      expect(provider).toBeInstanceOf(UnifiedTaskToolProvider);
      expect(provider.getTools()).toHaveLength(8);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Core CRUD Tools (backed by in-memory backend)
  // ─────────────────────────────────────────────────────────────────────────────

  describe("create_task", () => {
    it("should create a task via backend", async () => {
      const provider = new UnifiedTaskToolProvider(backend, getContext);
      const tool = findTool(provider.getTools(), "create_task")!;

      const result = (await tool.handler({
        description: "Test task",
      })) as { task_id: string; status: string };

      expect(result.task_id).toMatch(/^task_/);
      expect(result.status).toBe("pending");
    });

    it("should pass parent_task", async () => {
      const provider = new UnifiedTaskToolProvider(backend, getContext);
      const tool = findTool(provider.getTools(), "create_task")!;

      // Create parent first
      const parent = await backend.create({
        description: "Parent",
        created_by: TEST_AGENT_ID,
      });

      const result = (await tool.handler({
        description: "Child task",
        parent_task: parent.id,
      })) as { task_id: string };

      const task = await backend.get(result.task_id);
      expect(task?.parent_task).toBe(parent.id);
    });
  });

  describe("get_task", () => {
    it("should return task details", async () => {
      const provider = new UnifiedTaskToolProvider(backend, getContext);
      const tool = findTool(provider.getTools(), "get_task")!;

      const task = await backend.create({
        description: "Fetch me",
        created_by: TEST_AGENT_ID,
      });

      const result = (await tool.handler({
        task_id: task.id,
      })) as { id: string; description: string; status: string };

      expect(result.id).toBe(task.id);
      expect(result.description).toBe("Fetch me");
      expect(result.status).toBe("pending");
    });

    it("should throw for non-existent task", async () => {
      const provider = new UnifiedTaskToolProvider(backend, getContext);
      const tool = findTool(provider.getTools(), "get_task")!;

      await expect(tool.handler({ task_id: "task_nonexistent" })).rejects.toThrow(
        "Task not found"
      );
    });
  });

  describe("list_tasks", () => {
    it("should list all tasks", async () => {
      const provider = new UnifiedTaskToolProvider(backend, getContext);
      const tool = findTool(provider.getTools(), "list_tasks")!;

      await backend.create({ description: "Task 1", created_by: TEST_AGENT_ID });
      await backend.create({ description: "Task 2", created_by: TEST_AGENT_ID });

      const result = (await tool.handler({})) as {
        tasks: unknown[];
        total: number;
      };

      expect(result.total).toBe(2);
      expect(result.tasks).toHaveLength(2);
    });

    it("should filter by status", async () => {
      const provider = new UnifiedTaskToolProvider(backend, getContext);
      const tool = findTool(provider.getTools(), "list_tasks")!;

      const task = await backend.create({
        description: "Task 1",
        created_by: TEST_AGENT_ID,
      });
      await backend.assign(task.id, TEST_AGENT_ID);
      await backend.start(task.id);

      await backend.create({ description: "Task 2", created_by: TEST_AGENT_ID });

      const result = (await tool.handler({ status: "in_progress" })) as {
        tasks: unknown[];
        total: number;
      };

      expect(result.total).toBe(1);
    });
  });

  describe("assign_task", () => {
    it("should assign task to calling agent by default", async () => {
      const provider = new UnifiedTaskToolProvider(backend, getContext);
      const tool = findTool(provider.getTools(), "assign_task")!;

      const task = await backend.create({
        description: "Assign me",
        created_by: TEST_AGENT_ID,
      });

      const result = (await tool.handler({
        task_id: task.id,
      })) as { assigned_agent: string; assigned: boolean };

      expect(result.assigned_agent).toBe(TEST_AGENT_ID);
      expect(result.assigned).toBe(true);
    });

    it("should assign task to specified agent", async () => {
      const provider = new UnifiedTaskToolProvider(backend, getContext);
      const tool = findTool(provider.getTools(), "assign_task")!;

      const task = await backend.create({
        description: "Assign me",
        created_by: TEST_AGENT_ID,
      });

      const result = (await tool.handler({
        task_id: task.id,
        agent_id: "agent_other",
      })) as { assigned_agent: string };

      expect(result.assigned_agent).toBe("agent_other");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // OpenTasks Graph Tools (mock client)
  // ─────────────────────────────────────────────────────────────────────────────

  describe("task tool", () => {
    it("should handle transition operation", async () => {
      const client = createMockOpenTasksClient();
      const provider = new UnifiedTaskToolProvider(backend, getContext, client);
      const tool = findTool(provider.getTools(), "task")!;

      const result = await tool.handler({
        transition: { id: "i-abc1", action: "start" },
      });

      expect(client.taskTransition).toHaveBeenCalledWith("i-abc1", "start");
      expect(result).toEqual({ id: "i-1", status: "in_progress" });
    });

    it("should handle ready operation", async () => {
      const client = createMockOpenTasksClient();
      const provider = new UnifiedTaskToolProvider(backend, getContext, client);
      const tool = findTool(provider.getTools(), "task")!;

      const result = await tool.handler({
        ready: { limit: 10 },
      });

      expect(client.taskReady).toHaveBeenCalledWith({ limit: 10 });
      expect(result).toEqual({ type: "ready", items: [], total: 0 });
    });

    it("should handle assign operation with default agent", async () => {
      const client = createMockOpenTasksClient();
      const provider = new UnifiedTaskToolProvider(backend, getContext, client);
      const tool = findTool(provider.getTools(), "task")!;

      await tool.handler({
        assign: { id: "i-abc1" },
      });

      expect(client.taskAssign).toHaveBeenCalledWith("i-abc1", TEST_AGENT_ID);
    });

    it("should handle validActions operation", async () => {
      const client = createMockOpenTasksClient();
      const provider = new UnifiedTaskToolProvider(backend, getContext, client);
      const tool = findTool(provider.getTools(), "task")!;

      const result = await tool.handler({
        validActions: { id: "i-abc1" },
      });

      expect(client.taskValidActions).toHaveBeenCalledWith("i-abc1");
      expect(result).toEqual({ id: "i-1", actions: ["start", "close"] });
    });

    it("should throw when no operation specified", async () => {
      const client = createMockOpenTasksClient();
      const provider = new UnifiedTaskToolProvider(backend, getContext, client);
      const tool = findTool(provider.getTools(), "task")!;

      await expect(tool.handler({})).rejects.toThrow(
        "Specify exactly one operation"
      );
    });

    it("should throw when transition fails", async () => {
      const client = createMockOpenTasksClient();
      (client.taskTransition as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: false,
        error: "Invalid transition",
      });
      const provider = new UnifiedTaskToolProvider(backend, getContext, client);
      const tool = findTool(provider.getTools(), "task")!;

      await expect(
        tool.handler({ transition: { id: "i-1", action: "start" } })
      ).rejects.toThrow("Invalid transition");
    });
  });

  describe("link tool", () => {
    it("should create an edge", async () => {
      const client = createMockOpenTasksClient();
      const provider = new UnifiedTaskToolProvider(backend, getContext, client);
      const tool = findTool(provider.getTools(), "link")!;

      const result = (await tool.handler({
        from_id: "i-1",
        to_id: "i-2",
        type: "blocks",
      })) as { edge_id: string; created: boolean };

      expect(client.createEdge).toHaveBeenCalledWith("i-1", "i-2", "blocks");
      expect(result.edge_id).toBe("e-123");
      expect(result.created).toBe(true);
    });

    it("should remove an edge", async () => {
      const client = createMockOpenTasksClient();
      const provider = new UnifiedTaskToolProvider(backend, getContext, client);
      const tool = findTool(provider.getTools(), "link")!;

      const result = (await tool.handler({
        from_id: "i-1",
        to_id: "i-2",
        type: "blocks",
        remove: true,
      })) as { removed: boolean };

      expect(client.removeEdge).toHaveBeenCalledWith("i-1", "i-2", "blocks");
      expect(result.removed).toBe(true);
    });
  });

  describe("annotate tool", () => {
    it("should create feedback", async () => {
      const client = createMockOpenTasksClient();
      const provider = new UnifiedTaskToolProvider(backend, getContext, client);
      const tool = findTool(provider.getTools(), "annotate")!;

      const result = (await tool.handler({
        target_id: "i-abc1",
        content: "This looks good",
        feedback_type: "comment",
      })) as { feedback_id: string; created: boolean };

      expect(client.createIssue).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "This looks good",
          content: "This looks good",
          metadata: expect.objectContaining({
            _node_type: "feedback",
            target_id: "i-abc1",
            feedback_type: "comment",
            _created_by_agent: TEST_AGENT_ID,
          }),
        })
      );
      expect(result.feedback_id).toBe("i-abc1");
      expect(result.created).toBe(true);
    });

    it("should create discovered-from link when from_id provided", async () => {
      const client = createMockOpenTasksClient();
      const provider = new UnifiedTaskToolProvider(backend, getContext, client);
      const tool = findTool(provider.getTools(), "annotate")!;

      await tool.handler({
        target_id: "i-target",
        content: "Found an issue",
        from_id: "i-source",
      });

      expect(client.createEdge).toHaveBeenCalledWith(
        "i-source",
        "i-target",
        "discovered-from"
      );
    });

    it("should resolve feedback", async () => {
      const client = createMockOpenTasksClient();
      const provider = new UnifiedTaskToolProvider(backend, getContext, client);
      const tool = findTool(provider.getTools(), "annotate")!;

      const result = (await tool.handler({
        target_id: "i-abc1",
        resolve: "f-123",
      })) as { feedback_id: string; resolved: boolean };

      expect(client.updateIssue).toHaveBeenCalledWith(
        "f-123",
        expect.objectContaining({
          metadata: expect.objectContaining({ resolved: true }),
        })
      );
      expect(result.resolved).toBe(true);
    });

    it("should dismiss feedback", async () => {
      const client = createMockOpenTasksClient();
      const provider = new UnifiedTaskToolProvider(backend, getContext, client);
      const tool = findTool(provider.getTools(), "annotate")!;

      const result = (await tool.handler({
        target_id: "i-abc1",
        dismiss: "f-123",
      })) as { feedback_id: string; dismissed: boolean };

      expect(client.updateIssue).toHaveBeenCalledWith(
        "f-123",
        expect.objectContaining({
          metadata: expect.objectContaining({ dismissed: true }),
        })
      );
      expect(result.dismissed).toBe(true);
    });

    it("should reopen feedback", async () => {
      const client = createMockOpenTasksClient();
      const provider = new UnifiedTaskToolProvider(backend, getContext, client);
      const tool = findTool(provider.getTools(), "annotate")!;

      const result = (await tool.handler({
        target_id: "i-abc1",
        reopen: "f-123",
      })) as { feedback_id: string; reopened: boolean };

      expect(client.updateIssue).toHaveBeenCalledWith(
        "f-123",
        expect.objectContaining({
          metadata: expect.objectContaining({
            resolved: false,
            dismissed: false,
          }),
        })
      );
      expect(result.reopened).toBe(true);
    });

    it("should throw when no action specified", async () => {
      const client = createMockOpenTasksClient();
      const provider = new UnifiedTaskToolProvider(backend, getContext, client);
      const tool = findTool(provider.getTools(), "annotate")!;

      await expect(
        tool.handler({ target_id: "i-abc1" })
      ).rejects.toThrow("Must provide content");
    });
  });
});
