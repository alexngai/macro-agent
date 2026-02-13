/**
 * OpenTasksTaskToolProvider Tests
 *
 * Tests for the opentasks task tool provider implementation.
 *
 * @module task/backend/opentasks/__tests__/tools.test
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  OpenTasksTaskToolProvider,
  createOpenTasksToolProvider,
} from "../tools.js";
import type { GetOpenTasksToolContext } from "../tools.js";
import type { OpenTasksTaskBackend } from "../backend.js";
import type { OpenTasksClient, OpenTasksIssue } from "../client.js";

// =============================================================================
// Mock Backend
// =============================================================================

function createMockBackend(): OpenTasksTaskBackend {
  return {
    create: vi.fn(async () => ({
      id: "task-1",
      status: "pending",
      description: "Test",
      created_at: Date.now(),
      created_by: "agent-1",
      isBlocked: false,
      external_id: "i-mock1",
    })),
    get: vi.fn(async () => ({
      id: "task-1",
      status: "pending",
      description: "Test",
      created_at: Date.now(),
      created_by: "agent-1",
      isBlocked: false,
      external_id: "i-mock1",
    })),
    list: vi.fn(async () => []),
    listReady: vi.fn(async () => []),
    update: vi.fn(async () => ({
      id: "task-1",
      status: "in_progress",
      description: "Test",
      created_at: Date.now(),
      created_by: "agent-1",
      isBlocked: false,
    })),
    delete: vi.fn(async () => {}),
    assign: vi.fn(async () => {}),
    unassign: vi.fn(async () => {}),
    start: vi.fn(async () => {}),
    complete: vi.fn(async () => {}),
    fail: vi.fn(async () => {}),
    addBlocker: vi.fn(async () => {}),
    removeBlocker: vi.fn(async () => {}),
    getBlockers: vi.fn(async () => []),
    getBlocking: vi.fn(async () => []),
    getChildren: vi.fn(async () => []),
    getSubtaskStatus: vi.fn(async () => ({
      total: 0,
      pending: 0,
      assigned: 0,
      in_progress: 0,
      completed: 0,
      failed: 0,
      allCompleted: false,
      anyFailed: false,
    })),
    createSubtask: vi.fn(async () => ({
      id: "task-2",
      status: "pending",
      description: "Subtask",
      created_at: Date.now(),
      created_by: "agent-1",
      isBlocked: false,
    })),
    getAgentHistory: vi.fn(async () => []),
    onTaskChange: vi.fn(() => () => {}),
    claim: vi.fn(async () => ({
      id: "task-1",
      status: "assigned",
      description: "Claimed",
      created_at: Date.now(),
      created_by: "agent-1",
      isBlocked: false,
    })),
    unclaim: vi.fn(async () => {}),
    listClaimable: vi.fn(async () => []),
  } as unknown as OpenTasksTaskBackend;
}

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
      if (updates.metadata && issue.metadata) {
        updated.metadata = { ...issue.metadata, ...updates.metadata };
      }
      issues.set(id, updated);
      return updated;
    }),

    deleteIssue: vi.fn(async (id) => {
      issues.delete(id);
    }),

    listIssues: vi.fn(async () => {
      return Array.from(issues.values());
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
        id: `edge-${edges.length}`,
        uuid: `uuid-edge-${edges.length}`,
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

    getBlockers: vi.fn(async () => []),
    getBlocking: vi.fn(async () => []),

    isConnected: vi.fn(() => true),
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(),
  };
}

// =============================================================================
// Tests
// =============================================================================

describe("OpenTasksTaskToolProvider", () => {
  let backend: OpenTasksTaskBackend;
  let client: OpenTasksClient;
  let getContext: GetOpenTasksToolContext;

  beforeEach(() => {
    backend = createMockBackend();
    client = createMockClient();
    getContext = () => ({ agent_id: "test-agent" });
  });

  // ─── Tool Mode Tests ────────────────────────────────────────────────────

  describe("tool modes", () => {
    it("should expose native tools in native mode", () => {
      const provider = new OpenTasksTaskToolProvider(
        backend,
        client,
        getContext,
        { mode: "native" }
      );

      const tools = provider.getTools();
      const toolNames = tools.map((t) => t.name);

      expect(toolNames).toContain("opentasks_create");
      expect(toolNames).toContain("opentasks_get");
      expect(toolNames).toContain("opentasks_update");
      expect(toolNames).toContain("opentasks_delete");
      expect(toolNames).toContain("opentasks_query");
      expect(toolNames).toContain("opentasks_link");
      expect(toolNames).toContain("opentasks_annotate");

      // Should not have mapped tools
      expect(toolNames).not.toContain("create_task");
      expect(toolNames).not.toContain("get_task");
    });

    it("should expose mapped tools in mapped mode", () => {
      const provider = new OpenTasksTaskToolProvider(
        backend,
        client,
        getContext,
        { mode: "mapped" }
      );

      const tools = provider.getTools();
      const toolNames = tools.map((t) => t.name);

      expect(toolNames).toContain("create_task");
      expect(toolNames).toContain("get_task");
      expect(toolNames).toContain("list_tasks");
      expect(toolNames).toContain("list_ready_tasks");
      expect(toolNames).toContain("get_task_blockers");
      expect(toolNames).toContain("update_task_status");
      expect(toolNames).toContain("add_blocker");
      expect(toolNames).toContain("remove_blocker");
      expect(toolNames).toContain("assign_task");
      expect(toolNames).toContain("complete_task");

      // Should not have native tools
      expect(toolNames).not.toContain("opentasks_create");
      expect(toolNames).not.toContain("opentasks_get");
    });

    it("should expose all tools in both mode", () => {
      const provider = new OpenTasksTaskToolProvider(
        backend,
        client,
        getContext,
        { mode: "both" }
      );

      const tools = provider.getTools();
      const toolNames = tools.map((t) => t.name);

      // Native tools
      expect(toolNames).toContain("opentasks_create");
      expect(toolNames).toContain("opentasks_get");
      expect(toolNames).toContain("opentasks_query");
      expect(toolNames).toContain("opentasks_link");
      expect(toolNames).toContain("opentasks_annotate");

      // Mapped tools
      expect(toolNames).toContain("create_task");
      expect(toolNames).toContain("get_task");
      expect(toolNames).toContain("complete_task");
    });

    it("should default to native mode", () => {
      const provider = new OpenTasksTaskToolProvider(
        backend,
        client,
        getContext
      );

      const tools = provider.getTools();
      const toolNames = tools.map((t) => t.name);

      expect(toolNames).toContain("opentasks_create");
      expect(toolNames).not.toContain("create_task");
    });
  });

  // ─── Excluded Tools Tests ──────────────────────────────────────────────

  describe("getExcludedTools", () => {
    it("should exclude mapped tools in native mode", () => {
      const provider = new OpenTasksTaskToolProvider(
        backend,
        client,
        getContext,
        { mode: "native" }
      );

      const excluded = provider.getExcludedTools();

      expect(excluded).toContain("create_task");
      expect(excluded).toContain("get_task");
      expect(excluded).toContain("list_tasks");
      expect(excluded).toContain("complete_task");
      expect(excluded).not.toContain("opentasks_create");
    });

    it("should exclude native tools in mapped mode", () => {
      const provider = new OpenTasksTaskToolProvider(
        backend,
        client,
        getContext,
        { mode: "mapped" }
      );

      const excluded = provider.getExcludedTools();

      expect(excluded).toContain("opentasks_create");
      expect(excluded).toContain("opentasks_get");
      expect(excluded).toContain("opentasks_query");
      expect(excluded).not.toContain("create_task");
    });

    it("should not exclude any tools in both mode", () => {
      const provider = new OpenTasksTaskToolProvider(
        backend,
        client,
        getContext,
        { mode: "both" }
      );

      const excluded = provider.getExcludedTools();

      expect(excluded).toHaveLength(0);
    });
  });

  // ─── Native Tool Handler Tests ─────────────────────────────────────────

  describe("native tool handlers", () => {
    let provider: OpenTasksTaskToolProvider;

    beforeEach(() => {
      provider = new OpenTasksTaskToolProvider(backend, client, getContext, {
        mode: "native",
      });
    });

    it("opentasks_create should create an issue via client", async () => {
      const tools = provider.getTools();
      const create = tools.find((t) => t.name === "opentasks_create");

      const result = await create!.handler({
        type: "issue",
        title: "Fix bug",
        content: "The login form crashes",
        priority: 1,
      });

      expect(client.createIssue).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Fix bug",
          content: "The login form crashes",
          status: "open",
          priority: 1,
        })
      );
      expect(result).toEqual(
        expect.objectContaining({
          type: "issue",
          title: "Fix bug",
          created: true,
        })
      );
    });

    it("opentasks_create should store agent_id in metadata", async () => {
      const tools = provider.getTools();
      const create = tools.find((t) => t.name === "opentasks_create");

      await create!.handler({ type: "issue", title: "Test" });

      expect(client.createIssue).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            _created_by_agent: "test-agent",
          }),
        })
      );
    });

    it("opentasks_get should return node details", async () => {
      const tools = provider.getTools();
      const create = tools.find((t) => t.name === "opentasks_create");
      const get = tools.find((t) => t.name === "opentasks_get");

      // Create first so it exists in the mock
      await create!.handler({ type: "issue", title: "Test issue" });

      const result = await get!.handler({ id: "i-mock1" });

      expect(client.getIssue).toHaveBeenCalledWith("i-mock1");
      expect(result).toEqual(
        expect.objectContaining({
          id: "i-mock1",
          title: "Test issue",
        })
      );
    });

    it("opentasks_get should throw when node not found", async () => {
      const tools = provider.getTools();
      const get = tools.find((t) => t.name === "opentasks_get");

      await expect(get!.handler({ id: "i-nonexistent" })).rejects.toThrow(
        "Node not found"
      );
    });

    it("opentasks_update should update issue via client", async () => {
      const tools = provider.getTools();
      const create = tools.find((t) => t.name === "opentasks_create");
      const update = tools.find((t) => t.name === "opentasks_update");

      await create!.handler({ type: "issue", title: "Original" });
      const result = await update!.handler({
        id: "i-mock1",
        status: "in_progress",
        priority: 0,
      });

      expect(client.updateIssue).toHaveBeenCalledWith("i-mock1", {
        status: "in_progress",
        priority: 0,
      });
      expect(result).toEqual(
        expect.objectContaining({
          id: "i-mock1",
          updated: true,
        })
      );
    });

    it("opentasks_delete should delete issue via client", async () => {
      const tools = provider.getTools();
      const create = tools.find((t) => t.name === "opentasks_create");
      const del = tools.find((t) => t.name === "opentasks_delete");

      await create!.handler({ type: "issue", title: "To delete" });
      const result = await del!.handler({ id: "i-mock1" });

      expect(client.deleteIssue).toHaveBeenCalledWith("i-mock1");
      expect(result).toEqual({ id: "i-mock1", deleted: true });
    });

    it("opentasks_query with ready should call getReadyIssues", async () => {
      const tools = provider.getTools();
      const query = tools.find((t) => t.name === "opentasks_query");

      const result = await query!.handler({ ready: {} });

      expect(client.getReadyIssues).toHaveBeenCalled();
      expect(result).toEqual(
        expect.objectContaining({ type: "ready" })
      );
    });

    it("opentasks_query with blockers should call getBlockers", async () => {
      const tools = provider.getTools();
      const query = tools.find((t) => t.name === "opentasks_query");

      await query!.handler({ blockers: { nodeId: "i-test" } });

      expect(client.getBlockers).toHaveBeenCalledWith("i-test");
    });

    it("opentasks_query with blocking should call getBlocking", async () => {
      const tools = provider.getTools();
      const query = tools.find((t) => t.name === "opentasks_query");

      await query!.handler({ blocking: { nodeId: "i-test" } });

      expect(client.getBlocking).toHaveBeenCalledWith("i-test");
    });

    it("opentasks_query with nodes should call listIssues", async () => {
      const tools = provider.getTools();
      const query = tools.find((t) => t.name === "opentasks_query");

      await query!.handler({
        nodes: { status: "open", assignee: "agent-1" },
      });

      expect(client.listIssues).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "open",
          assignee: "agent-1",
        })
      );
    });

    it("opentasks_query without specific type should default to listing open issues", async () => {
      const tools = provider.getTools();
      const query = tools.find((t) => t.name === "opentasks_query");

      await query!.handler({});

      expect(client.listIssues).toHaveBeenCalledWith(
        expect.objectContaining({
          status: ["open", "in_progress"],
        })
      );
    });

    it("opentasks_link should create an edge", async () => {
      const tools = provider.getTools();
      const link = tools.find((t) => t.name === "opentasks_link");

      const result = await link!.handler({
        from_id: "i-a",
        to_id: "i-b",
        type: "blocks",
      });

      expect(client.createEdge).toHaveBeenCalledWith("i-a", "i-b", "blocks");
      expect(result).toEqual(
        expect.objectContaining({
          from_id: "i-a",
          to_id: "i-b",
          type: "blocks",
          created: true,
        })
      );
    });

    it("opentasks_link with remove should remove an edge", async () => {
      const tools = provider.getTools();
      const link = tools.find((t) => t.name === "opentasks_link");

      const result = await link!.handler({
        from_id: "i-a",
        to_id: "i-b",
        type: "blocks",
        remove: true,
      });

      expect(client.removeEdge).toHaveBeenCalledWith("i-a", "i-b", "blocks");
      expect(result).toEqual(
        expect.objectContaining({
          from_id: "i-a",
          to_id: "i-b",
          removed: true,
        })
      );
    });

    it("opentasks_annotate should create feedback node", async () => {
      const tools = provider.getTools();
      const annotate = tools.find((t) => t.name === "opentasks_annotate");

      const result = await annotate!.handler({
        target_id: "i-target",
        content: "This needs work",
        feedback_type: "suggestion",
      });

      expect(client.createIssue).toHaveBeenCalledWith(
        expect.objectContaining({
          content: "This needs work",
          metadata: expect.objectContaining({
            _node_type: "feedback",
            target_id: "i-target",
            feedback_type: "suggestion",
            _created_by_agent: "test-agent",
          }),
        })
      );
      expect(result).toEqual(
        expect.objectContaining({
          target_id: "i-target",
          type: "suggestion",
          created: true,
        })
      );
    });

    it("opentasks_annotate with resolve should update feedback node", async () => {
      const tools = provider.getTools();
      const create = tools.find((t) => t.name === "opentasks_create");
      const annotate = tools.find((t) => t.name === "opentasks_annotate");

      // Create feedback node first
      await create!.handler({ type: "issue", title: "Feedback" });

      const result = await annotate!.handler({
        target_id: "i-target",
        resolve: "i-mock1",
      });

      expect(client.updateIssue).toHaveBeenCalledWith(
        "i-mock1",
        expect.objectContaining({
          metadata: expect.objectContaining({ resolved: true }),
        })
      );
      expect(result).toEqual({ feedback_id: "i-mock1", resolved: true });
    });

    it("opentasks_annotate with dismiss should update feedback node", async () => {
      const tools = provider.getTools();
      const create = tools.find((t) => t.name === "opentasks_create");
      const annotate = tools.find((t) => t.name === "opentasks_annotate");

      await create!.handler({ type: "issue", title: "Feedback" });

      const result = await annotate!.handler({
        target_id: "i-target",
        dismiss: "i-mock1",
      });

      expect(client.updateIssue).toHaveBeenCalledWith(
        "i-mock1",
        expect.objectContaining({
          metadata: expect.objectContaining({ dismissed: true }),
        })
      );
      expect(result).toEqual({ feedback_id: "i-mock1", dismissed: true });
    });

    it("opentasks_annotate with reopen should clear resolved/dismissed", async () => {
      const tools = provider.getTools();
      const create = tools.find((t) => t.name === "opentasks_create");
      const annotate = tools.find((t) => t.name === "opentasks_annotate");

      await create!.handler({ type: "issue", title: "Feedback" });

      const result = await annotate!.handler({
        target_id: "i-target",
        reopen: "i-mock1",
      });

      expect(client.updateIssue).toHaveBeenCalledWith(
        "i-mock1",
        expect.objectContaining({
          metadata: expect.objectContaining({
            resolved: false,
            dismissed: false,
          }),
        })
      );
      expect(result).toEqual({ feedback_id: "i-mock1", reopened: true });
    });

    it("opentasks_annotate without content or lifecycle action should throw", async () => {
      const tools = provider.getTools();
      const annotate = tools.find((t) => t.name === "opentasks_annotate");

      await expect(
        annotate!.handler({ target_id: "i-target" })
      ).rejects.toThrow("Must provide content");
    });

    it("opentasks_annotate with from_id should create discovered-from edge", async () => {
      const tools = provider.getTools();
      const annotate = tools.find((t) => t.name === "opentasks_annotate");

      await annotate!.handler({
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
  });

  // ─── Mapped Tool Handler Tests ─────────────────────────────────────────

  describe("mapped tool handlers", () => {
    let provider: OpenTasksTaskToolProvider;

    beforeEach(() => {
      provider = new OpenTasksTaskToolProvider(backend, client, getContext, {
        mode: "mapped",
      });
    });

    it("create_task should call backend.create", async () => {
      const tools = provider.getTools();
      const createTask = tools.find((t) => t.name === "create_task");

      const result = await createTask!.handler({
        description: "Do something",
      });

      expect(backend.create).toHaveBeenCalledWith(
        expect.objectContaining({
          description: "Do something",
          created_by: "test-agent",
        })
      );
      expect(result).toEqual(
        expect.objectContaining({ task_id: "task-1" })
      );
    });

    it("get_task should call backend.get", async () => {
      const tools = provider.getTools();
      const getTask = tools.find((t) => t.name === "get_task");

      const result = await getTask!.handler({ task_id: "task-1" });

      expect(backend.get).toHaveBeenCalledWith("task-1");
      expect(result).toEqual(
        expect.objectContaining({
          id: "task-1",
          status: "pending",
        })
      );
    });

    it("get_task should throw when task not found", async () => {
      (backend.get as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const tools = provider.getTools();
      const getTask = tools.find((t) => t.name === "get_task");

      await expect(
        getTask!.handler({ task_id: "nonexistent" })
      ).rejects.toThrow("Task not found");
    });

    it("list_tasks should call backend.list", async () => {
      const tools = provider.getTools();
      const listTasks = tools.find((t) => t.name === "list_tasks");

      await listTasks!.handler({ status: "pending" });

      expect(backend.list).toHaveBeenCalledWith(
        expect.objectContaining({ status: "pending" })
      );
    });

    it("list_ready_tasks should call backend.listReady", async () => {
      const tools = provider.getTools();
      const listReady = tools.find((t) => t.name === "list_ready_tasks");

      await listReady!.handler({});

      expect(backend.listReady).toHaveBeenCalled();
    });

    it("update_task_status should call backend.update", async () => {
      const tools = provider.getTools();
      const updateStatus = tools.find((t) => t.name === "update_task_status");

      await updateStatus!.handler({
        task_id: "task-1",
        status: "in_progress",
      });

      expect(backend.update).toHaveBeenCalledWith("task-1", {
        status: "in_progress",
      });
    });

    it("add_blocker should call backend.addBlocker", async () => {
      const tools = provider.getTools();
      const addBlocker = tools.find((t) => t.name === "add_blocker");

      await addBlocker!.handler({
        task_id: "task-1",
        blocker_id: "task-2",
      });

      expect(backend.addBlocker).toHaveBeenCalledWith("task-1", "task-2");
    });

    it("remove_blocker should call backend.removeBlocker", async () => {
      const tools = provider.getTools();
      const removeBlocker = tools.find((t) => t.name === "remove_blocker");

      await removeBlocker!.handler({
        task_id: "task-1",
        blocker_id: "task-2",
      });

      expect(backend.removeBlocker).toHaveBeenCalledWith("task-1", "task-2");
    });

    it("assign_task should call backend.assign with default agent_id", async () => {
      const tools = provider.getTools();
      const assignTask = tools.find((t) => t.name === "assign_task");

      await assignTask!.handler({ task_id: "task-1" });

      expect(backend.assign).toHaveBeenCalledWith(
        "task-1",
        "test-agent",
        { role: undefined }
      );
    });

    it("assign_task should use provided agent_id", async () => {
      const tools = provider.getTools();
      const assignTask = tools.find((t) => t.name === "assign_task");

      await assignTask!.handler({
        task_id: "task-1",
        agent_id: "other-agent",
        role: "worker",
      });

      expect(backend.assign).toHaveBeenCalledWith(
        "task-1",
        "other-agent",
        { role: "worker" }
      );
    });

    it("complete_task should call backend.complete", async () => {
      const tools = provider.getTools();
      const completeTask = tools.find((t) => t.name === "complete_task");

      await completeTask!.handler({
        task_id: "task-1",
        summary: "Done",
        outputs: { file: "result.txt" },
      });

      expect(backend.complete).toHaveBeenCalledWith("task-1", {
        summary: "Done",
        data: { file: "result.txt" },
      });
    });

    it("get_task_blockers should call backend.getBlockers", async () => {
      const tools = provider.getTools();
      const getBlockers = tools.find((t) => t.name === "get_task_blockers");

      await getBlockers!.handler({ task_id: "task-1" });

      expect(backend.getBlockers).toHaveBeenCalledWith("task-1");
    });
  });

  // ─── Factory Tests ─────────────────────────────────────────────────────

  describe("createOpenTasksToolProvider", () => {
    it("should create provider with default config", () => {
      const provider = createOpenTasksToolProvider(
        backend,
        client,
        getContext
      );

      expect(provider).toBeInstanceOf(OpenTasksTaskToolProvider);
      const tools = provider.getTools();
      // Default is native mode
      expect(tools.map((t) => t.name)).toContain("opentasks_create");
    });

    it("should create provider with custom config", () => {
      const provider = createOpenTasksToolProvider(
        backend,
        client,
        getContext,
        { mode: "mapped" }
      );

      expect(provider).toBeInstanceOf(OpenTasksTaskToolProvider);
      const tools = provider.getTools();
      expect(tools.map((t) => t.name)).toContain("create_task");
      expect(tools.map((t) => t.name)).not.toContain("opentasks_create");
    });
  });

  // ─── Tool Schema Tests ─────────────────────────────────────────────────

  describe("tool schemas", () => {
    it("all tools should have name, description, schema, and handler", () => {
      const provider = new OpenTasksTaskToolProvider(
        backend,
        client,
        getContext,
        { mode: "both" }
      );

      const tools = provider.getTools();

      for (const tool of tools) {
        expect(tool.name).toBeTruthy();
        expect(tool.description).toBeTruthy();
        expect(tool.schema).toBeTruthy();
        expect(typeof tool.handler).toBe("function");
      }
    });

    it("native tools should have unique names", () => {
      const provider = new OpenTasksTaskToolProvider(
        backend,
        client,
        getContext,
        { mode: "both" }
      );

      const tools = provider.getTools();
      const names = tools.map((t) => t.name);
      const uniqueNames = new Set(names);

      expect(names.length).toBe(uniqueNames.size);
    });

    it("should have 7 native tools", () => {
      const provider = new OpenTasksTaskToolProvider(
        backend,
        client,
        getContext,
        { mode: "native" }
      );

      expect(provider.getTools()).toHaveLength(7);
    });

    it("should have 10 mapped tools", () => {
      const provider = new OpenTasksTaskToolProvider(
        backend,
        client,
        getContext,
        { mode: "mapped" }
      );

      expect(provider.getTools()).toHaveLength(10);
    });

    it("should have 17 tools in both mode", () => {
      const provider = new OpenTasksTaskToolProvider(
        backend,
        client,
        getContext,
        { mode: "both" }
      );

      expect(provider.getTools()).toHaveLength(17);
    });
  });
});
