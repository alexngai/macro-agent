/**
 * SudocodeTaskToolProvider Tests
 *
 * Tests for the sudocode task tool provider implementation.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  SudocodeTaskToolProvider,
  createSudocodeTaskToolProvider,
  TaskToolMode,
  GetSudocodeToolContext,
} from "../tools.js";
import type { SudocodeTaskBackend } from "../backend.js";
import type { SudocodeClient } from "../client.js";

// Mock backend
function createMockBackend(): SudocodeTaskBackend {
  return {
    create: vi.fn(async () => ({
      id: "task-1",
      status: "pending",
      description: "Test",
      created_at: "2024-01-01T00:00:00Z",
      created_by: "agent-1",
      isBlocked: false,
    })),
    get: vi.fn(async () => ({
      id: "task-1",
      status: "pending",
      description: "Test",
      created_at: "2024-01-01T00:00:00Z",
      created_by: "agent-1",
      isBlocked: false,
    })),
    list: vi.fn(async () => []),
    listReady: vi.fn(async () => []),
    update: vi.fn(async () => ({
      id: "task-1",
      status: "in_progress",
      description: "Test",
      created_at: "2024-01-01T00:00:00Z",
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
      created_at: "2024-01-01T00:00:00Z",
      created_by: "agent-1",
      isBlocked: false,
    })),
    getAgentHistory: vi.fn(async () => []),
    onTaskChange: vi.fn(() => () => {}),
    getSyncPolicy: vi.fn(() => ({
      onIssueClosed: "notify_only" as const,
      onDescriptionChanged: "snapshot" as const,
      onBlockerChanged: "update_blocked" as const,
      updateIssueOnStart: true,
      updateIssueOnComplete: "never" as const,
    })),
    onSyncEvent: vi.fn(() => () => {}),
    getTasksByIssue: vi.fn(() => []),
    getIssueForTask: vi.fn(() => undefined),
    bindToIssue: vi.fn(async () => {}),
    unbindFromIssue: vi.fn(async () => {}),
    close: vi.fn(),
  } as unknown as SudocodeTaskBackend;
}

// Mock client
function createMockClient(): SudocodeClient {
  return {
    getIssue: vi.fn(async () => ({
      id: "i-test",
      uuid: "uuid-test",
      title: "Test Issue",
      content: "Test content",
      status: "open",
      priority: 1,
      created_at: "2024-01-01T00:00:00Z",
      updated_at: "2024-01-01T00:00:00Z",
    })),
    listIssues: vi.fn(async () => []),
    getReadyIssues: vi.fn(async () => []),
    updateIssue: vi.fn(async () => ({
      id: "i-test",
      uuid: "uuid-test",
      title: "Test Issue",
      content: "Test content",
      status: "open",
      priority: 1,
      created_at: "2024-01-01T00:00:00Z",
      updated_at: "2024-01-01T00:00:00Z",
    })),
    createLink: vi.fn(async () => {}),
    removeLink: vi.fn(async () => {}),
    getBlockers: vi.fn(async () => []),
    getBlocking: vi.fn(async () => []),
    getSpec: vi.fn(async () => null),
    listSpecs: vi.fn(async () => []),
    addFeedback: vi.fn(async () => {}),
    onIssueChange: vi.fn(() => () => {}),
    isReady: vi.fn(() => true),
    close: vi.fn(),
  } as unknown as SudocodeClient;
}

describe("SudocodeTaskToolProvider", () => {
  let backend: SudocodeTaskBackend;
  let client: SudocodeClient;
  let getContext: GetSudocodeToolContext;

  beforeEach(() => {
    backend = createMockBackend();
    client = createMockClient();
    getContext = () => ({ agent_id: "test-agent" });
  });

  describe("tool modes", () => {
    it("should expose native tools in native mode", () => {
      const provider = new SudocodeTaskToolProvider(
        backend,
        client,
        getContext,
        { mode: "native" }
      );

      const tools = provider.getTools();
      const toolNames = tools.map((t) => t.name);

      expect(toolNames).toContain("upsert_issue");
      expect(toolNames).toContain("show_issue");
      expect(toolNames).toContain("list_issues");
      expect(toolNames).toContain("ready");
      expect(toolNames).toContain("link");
      expect(toolNames).toContain("add_feedback");

      // Should not have mapped tools
      expect(toolNames).not.toContain("create_task");
      expect(toolNames).not.toContain("get_task");
    });

    it("should expose mapped tools in mapped mode", () => {
      const provider = new SudocodeTaskToolProvider(
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
      expect(toolNames).toContain("complete_task");

      // Should not have native tools
      expect(toolNames).not.toContain("upsert_issue");
      expect(toolNames).not.toContain("show_issue");
    });

    it("should expose all tools in both mode", () => {
      const provider = new SudocodeTaskToolProvider(
        backend,
        client,
        getContext,
        { mode: "both" }
      );

      const tools = provider.getTools();
      const toolNames = tools.map((t) => t.name);

      // Native tools
      expect(toolNames).toContain("upsert_issue");
      expect(toolNames).toContain("show_issue");

      // Mapped tools
      expect(toolNames).toContain("create_task");
      expect(toolNames).toContain("get_task");
    });

    it("should default to native mode", () => {
      const provider = new SudocodeTaskToolProvider(
        backend,
        client,
        getContext
      );

      const tools = provider.getTools();
      const toolNames = tools.map((t) => t.name);

      expect(toolNames).toContain("upsert_issue");
      expect(toolNames).not.toContain("create_task");
    });
  });

  describe("getExcludedTools", () => {
    it("should exclude mapped tools in native mode", () => {
      const provider = new SudocodeTaskToolProvider(
        backend,
        client,
        getContext,
        { mode: "native" }
      );

      const excluded = provider.getExcludedTools();

      expect(excluded).toContain("create_task");
      expect(excluded).toContain("get_task");
      expect(excluded).toContain("list_tasks");
      expect(excluded).not.toContain("upsert_issue");
    });

    it("should exclude native tools in mapped mode", () => {
      const provider = new SudocodeTaskToolProvider(
        backend,
        client,
        getContext,
        { mode: "mapped" }
      );

      const excluded = provider.getExcludedTools();

      expect(excluded).toContain("upsert_issue");
      expect(excluded).toContain("show_issue");
      expect(excluded).not.toContain("create_task");
    });

    it("should not exclude any tools in both mode", () => {
      const provider = new SudocodeTaskToolProvider(
        backend,
        client,
        getContext,
        { mode: "both" }
      );

      const excluded = provider.getExcludedTools();

      expect(excluded).toHaveLength(0);
    });
  });

  describe("native tool handlers", () => {
    let provider: SudocodeTaskToolProvider;

    beforeEach(() => {
      provider = new SudocodeTaskToolProvider(backend, client, getContext, {
        mode: "native",
      });
    });

    it("show_issue should call client.getIssue", async () => {
      const tools = provider.getTools();
      const showIssue = tools.find((t) => t.name === "show_issue");

      await showIssue!.handler({ issue_id: "i-test" });

      expect(client.getIssue).toHaveBeenCalledWith("i-test");
    });

    it("show_issue should throw when issue not found", async () => {
      (client.getIssue as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const tools = provider.getTools();
      const showIssue = tools.find((t) => t.name === "show_issue");

      await expect(
        showIssue!.handler({ issue_id: "i-nonexistent" })
      ).rejects.toThrow("Issue not found");
    });

    it("list_issues should call client.listIssues", async () => {
      const tools = provider.getTools();
      const listIssues = tools.find((t) => t.name === "list_issues");

      await listIssues!.handler({ status: "open" });

      expect(client.listIssues).toHaveBeenCalledWith({ status: "open" });
    });

    it("ready should call client.getReadyIssues", async () => {
      const tools = provider.getTools();
      const ready = tools.find((t) => t.name === "ready");

      await ready!.handler({});

      expect(client.getReadyIssues).toHaveBeenCalled();
    });

    it("link should call client.createLink", async () => {
      const tools = provider.getTools();
      const link = tools.find((t) => t.name === "link");

      await link!.handler({
        from_id: "i-1",
        to_id: "i-2",
        type: "blocks",
      });

      expect(client.createLink).toHaveBeenCalledWith("i-1", "i-2", "blocks");
    });

    it("add_feedback should call client.addFeedback", async () => {
      const tools = provider.getTools();
      const addFeedback = tools.find((t) => t.name === "add_feedback");

      await addFeedback!.handler({
        to_id: "s-test",
        content: "This is feedback",
        type: "comment",
      });

      expect(client.addFeedback).toHaveBeenCalledWith(undefined, "s-test", {
        type: "comment",
        content: "This is feedback",
        anchor: undefined,
      });
    });
  });

  describe("mapped tool handlers", () => {
    let provider: SudocodeTaskToolProvider;

    beforeEach(() => {
      provider = new SudocodeTaskToolProvider(backend, client, getContext, {
        mode: "mapped",
      });
    });

    it("create_task should call backend.create", async () => {
      const tools = provider.getTools();
      const createTask = tools.find((t) => t.name === "create_task");

      await createTask!.handler({
        description: "Test task",
        external_id: "i-test",
      });

      expect(backend.create).toHaveBeenCalledWith({
        description: "Test task",
        created_by: "test-agent",
        parent_task: undefined,
        external_id: "i-test",
      });
    });

    it("get_task should call backend.get", async () => {
      const tools = provider.getTools();
      const getTask = tools.find((t) => t.name === "get_task");

      await getTask!.handler({ task_id: "task-1" });

      expect(backend.get).toHaveBeenCalledWith("task-1");
    });

    it("get_task should throw when task not found", async () => {
      (backend.get as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const tools = provider.getTools();
      const getTask = tools.find((t) => t.name === "get_task");

      await expect(
        getTask!.handler({ task_id: "nonexistent" })
      ).rejects.toThrow("Task not found");
    });

    it("list_ready_tasks should call backend.listReady", async () => {
      const tools = provider.getTools();
      const listReady = tools.find((t) => t.name === "list_ready_tasks");

      await listReady!.handler({ assigned_agent: "agent-1" });

      expect(backend.listReady).toHaveBeenCalledWith({
        assigned_agent: "agent-1",
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

    it("complete_task should call backend.complete", async () => {
      const tools = provider.getTools();
      const completeTask = tools.find((t) => t.name === "complete_task");

      await completeTask!.handler({
        task_id: "task-1",
        summary: "Done",
      });

      expect(backend.complete).toHaveBeenCalledWith("task-1", {
        summary: "Done",
        data: undefined,
      });
    });

    it("assign_task should use context agent_id by default", async () => {
      const tools = provider.getTools();
      const assignTask = tools.find((t) => t.name === "assign_task");

      await assignTask!.handler({ task_id: "task-1" });

      expect(backend.assign).toHaveBeenCalledWith("task-1", "test-agent", {
        role: undefined,
      });
    });

    it("assign_task should use provided agent_id", async () => {
      const tools = provider.getTools();
      const assignTask = tools.find((t) => t.name === "assign_task");

      await assignTask!.handler({
        task_id: "task-1",
        agent_id: "other-agent",
        role: "reviewer",
      });

      expect(backend.assign).toHaveBeenCalledWith("task-1", "other-agent", {
        role: "reviewer",
      });
    });
  });

  describe("createSudocodeTaskToolProvider", () => {
    it("should create a tool provider instance", () => {
      const provider = createSudocodeTaskToolProvider(
        backend,
        client,
        getContext,
        { mode: "both" }
      );

      expect(provider).toBeInstanceOf(SudocodeTaskToolProvider);
      expect(provider.getTools().length).toBeGreaterThan(0);
    });
  });
});
