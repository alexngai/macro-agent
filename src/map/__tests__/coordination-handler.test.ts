/**
 * Tests for Coordination Handler — inbound MAP task messages + notifications.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  setupCoordinationHandlers,
  type CoordinationConnection,
  type CoordinationDeps,
  type MAPMessage,
} from "../coordination-handler.js";
import type { InboxAdapter, TasksAdapter } from "../../adapters/types.js";

// =============================================================================
// Mock helpers
// =============================================================================

type MessageHandler = (message: MAPMessage) => void | Promise<void>;
type NotificationHandler = (params: unknown) => void | Promise<void>;

function mockConnection() {
  const messageHandlers = new Set<MessageHandler>();
  const notificationHandlers = new Map<string, Set<NotificationHandler>>();

  const conn: CoordinationConnection = {
    onMessage(handler: MessageHandler) {
      messageHandlers.add(handler);
    },
    offMessage(handler: MessageHandler) {
      messageHandlers.delete(handler);
    },
    onNotification(method: string, handler: NotificationHandler) {
      if (!notificationHandlers.has(method)) {
        notificationHandlers.set(method, new Set());
      }
      notificationHandlers.get(method)!.add(handler);
    },
    offNotification(method: string, handler: NotificationHandler) {
      notificationHandlers.get(method)?.delete(handler);
    },
    sendNotification: vi.fn().mockResolvedValue(undefined),
  };

  return {
    conn,
    messageHandlers,
    notificationHandlers,
    /** Simulate an incoming MAP scope message */
    async emitMessage(payload: Record<string, unknown>) {
      const msg: MAPMessage = {
        id: `msg-${Date.now()}`,
        from: "hub",
        to: { scope: "swarm:test" },
        timestamp: new Date().toISOString(),
        payload,
      };
      for (const handler of messageHandlers) {
        await handler(msg);
      }
    },
    /** Simulate an incoming JSON-RPC notification */
    async emitNotification(method: string, params: unknown) {
      const handlers = notificationHandlers.get(method);
      if (handlers) {
        for (const handler of handlers) {
          await handler(params);
        }
      }
    },
  };
}

function mockInboxAdapter() {
  return {
    send: vi.fn().mockResolvedValue("msg-1"),
  } as unknown as InboxAdapter;
}

function mockTasksAdapter() {
  return {
    createTask: vi.fn().mockResolvedValue("task-100"),
    assignTask: vi.fn().mockResolvedValue(undefined),
    transitionTask: vi.fn().mockResolvedValue(undefined),
    connected: true,
  } as unknown as TasksAdapter;
}

function createDeps(overrides: Partial<CoordinationDeps> = {}): CoordinationDeps & {
  mock: ReturnType<typeof mockConnection>;
} {
  const mock = mockConnection();
  return {
    connection: mock.conn,
    inboxAdapter: mockInboxAdapter(),
    tasksAdapter: mockTasksAdapter(),
    ...overrides,
    mock,
  };
}

// =============================================================================
// Tests — Task messages (MAP scope messages)
// =============================================================================

describe("CoordinationHandler — task messages", () => {
  let deps: ReturnType<typeof createDeps>;

  beforeEach(() => {
    deps = createDeps();
    setupCoordinationHandlers(deps);
  });

  describe("task.created", () => {
    it("creates task in opentasks", async () => {
      await deps.mock.emitMessage({
        type: "task.created",
        task: { id: "t-1", title: "Fix bug", status: "open", assignee: "agent-1" },
      });

      expect(deps.tasksAdapter.createTask).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Fix bug",
          assignee: "agent-1",
        }),
      );
    });

    it("notifies assignee via inbox", async () => {
      await deps.mock.emitMessage({
        type: "task.created",
        task: { id: "t-1", title: "Fix bug", status: "open", assignee: "agent-1" },
      });

      expect(deps.inboxAdapter.send).toHaveBeenCalledWith(
        "system",
        "agent-1",
        expect.objectContaining({
          type: "event",
          event: "TASK_ASSIGNED",
          data: expect.objectContaining({ title: "Fix bug" }),
        }),
      );
    });

    it("skips inbox notification when no assignee", async () => {
      await deps.mock.emitMessage({
        type: "task.created",
        task: { id: "t-1", title: "Unassigned task", status: "open" },
      });

      expect(deps.tasksAdapter.createTask).toHaveBeenCalled();
      expect(deps.inboxAdapter.send).not.toHaveBeenCalled();
    });

    it("passes task description to opentasks", async () => {
      await deps.mock.emitMessage({
        type: "task.created",
        task: { id: "t-1", title: "Fix bug", status: "open", description: "Segfault on startup" },
      });

      expect(deps.tasksAdapter.createTask).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Fix bug",
          content: "Segfault on startup",
        }),
      );
    });

    it("ignores messages without a title", async () => {
      await deps.mock.emitMessage({
        type: "task.created",
        task: { id: "t-1", status: "open" },
      });

      expect(deps.tasksAdapter.createTask).not.toHaveBeenCalled();
    });

    it("ignores messages without a task object", async () => {
      await deps.mock.emitMessage({ type: "task.created" });

      expect(deps.tasksAdapter.createTask).not.toHaveBeenCalled();
    });
  });

  describe("task.assigned", () => {
    it("assigns task in opentasks and notifies agent", async () => {
      await deps.mock.emitMessage({
        type: "task.assigned",
        taskId: "t-1",
        assignee: "agent-2",
      });

      expect(deps.tasksAdapter.assignTask).toHaveBeenCalledWith("t-1", "agent-2");
      expect(deps.inboxAdapter.send).toHaveBeenCalledWith(
        "system",
        "agent-2",
        expect.objectContaining({
          event: "TASK_ASSIGNED",
          data: expect.objectContaining({ taskId: "t-1" }),
        }),
      );
    });

    it("ignores messages without taskId", async () => {
      await deps.mock.emitMessage({
        type: "task.assigned",
        assignee: "agent-2",
      });

      expect(deps.tasksAdapter.assignTask).not.toHaveBeenCalled();
    });

    it("ignores messages without assignee", async () => {
      await deps.mock.emitMessage({
        type: "task.assigned",
        taskId: "t-1",
      });

      expect(deps.tasksAdapter.assignTask).not.toHaveBeenCalled();
    });
  });

  describe("task.status", () => {
    it("transitions task to in_progress", async () => {
      await deps.mock.emitMessage({
        type: "task.status",
        taskId: "t-1",
        previous: "open",
        current: "in_progress",
      });

      expect(deps.tasksAdapter.transitionTask).toHaveBeenCalledWith("t-1", "start");
    });

    it("transitions task to completed", async () => {
      await deps.mock.emitMessage({
        type: "task.status",
        taskId: "t-1",
        previous: "in_progress",
        current: "completed",
      });

      expect(deps.tasksAdapter.transitionTask).toHaveBeenCalledWith("t-1", "complete");
    });

    it("transitions task to blocked", async () => {
      await deps.mock.emitMessage({
        type: "task.status",
        taskId: "t-1",
        previous: "in_progress",
        current: "blocked",
      });

      expect(deps.tasksAdapter.transitionTask).toHaveBeenCalledWith("t-1", "block");
    });

    it("transitions task to failed", async () => {
      await deps.mock.emitMessage({
        type: "task.status",
        taskId: "t-1",
        previous: "in_progress",
        current: "failed",
      });

      expect(deps.tasksAdapter.transitionTask).toHaveBeenCalledWith("t-1", "fail");
    });

    it("transitions closed to complete", async () => {
      await deps.mock.emitMessage({
        type: "task.status",
        taskId: "t-1",
        previous: "in_progress",
        current: "closed",
      });

      expect(deps.tasksAdapter.transitionTask).toHaveBeenCalledWith("t-1", "complete");
    });

    it("reopens task", async () => {
      await deps.mock.emitMessage({
        type: "task.status",
        taskId: "t-1",
        previous: "blocked",
        current: "open",
      });

      expect(deps.tasksAdapter.transitionTask).toHaveBeenCalledWith("t-1", "reopen");
    });

    it("ignores unknown status values", async () => {
      await deps.mock.emitMessage({
        type: "task.status",
        taskId: "t-1",
        previous: "open",
        current: "unknown_status",
      });

      expect(deps.tasksAdapter.transitionTask).not.toHaveBeenCalled();
    });

    it("ignores messages without taskId", async () => {
      await deps.mock.emitMessage({
        type: "task.status",
        current: "completed",
      });

      expect(deps.tasksAdapter.transitionTask).not.toHaveBeenCalled();
    });

    it("ignores messages without current status", async () => {
      await deps.mock.emitMessage({
        type: "task.status",
        taskId: "t-1",
      });

      expect(deps.tasksAdapter.transitionTask).not.toHaveBeenCalled();
    });
  });

  describe("echo prevention", () => {
    it("skips messages with _origin macro-agent", async () => {
      await deps.mock.emitMessage({
        type: "task.created",
        task: { id: "t-1", title: "My own task", status: "open" },
        _origin: "macro-agent",
      });

      expect(deps.tasksAdapter.createTask).not.toHaveBeenCalled();
    });

    it("processes messages from other origins", async () => {
      await deps.mock.emitMessage({
        type: "task.created",
        task: { id: "t-1", title: "External task", status: "open" },
        _origin: "cc-swarm",
      });

      expect(deps.tasksAdapter.createTask).toHaveBeenCalled();
    });

    it("processes messages with no origin", async () => {
      await deps.mock.emitMessage({
        type: "task.created",
        task: { id: "t-1", title: "No origin task", status: "open" },
      });

      expect(deps.tasksAdapter.createTask).toHaveBeenCalled();
    });
  });

  describe("error handling", () => {
    it("warns on tasksAdapter failure without throwing", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      (deps.tasksAdapter.createTask as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("opentasks down"),
      );

      await deps.mock.emitMessage({
        type: "task.created",
        task: { id: "t-1", title: "Will fail", status: "open" },
      });

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("opentasks down"),
      );
      warnSpy.mockRestore();
    });

    it("continues processing after inbox send failure", async () => {
      (deps.inboxAdapter.send as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("inbox error"),
      );

      // Should not throw — inbox errors are caught
      await deps.mock.emitMessage({
        type: "task.created",
        task: { id: "t-1", title: "Task", status: "open", assignee: "agent-1" },
      });

      expect(deps.tasksAdapter.createTask).toHaveBeenCalled();
    });
  });

  describe("ignored message types", () => {
    it("ignores task.completed (informational only)", async () => {
      await deps.mock.emitMessage({
        type: "task.completed",
        taskId: "t-1",
      });

      expect(deps.tasksAdapter.createTask).not.toHaveBeenCalled();
      expect(deps.tasksAdapter.transitionTask).not.toHaveBeenCalled();
    });

    it("ignores messages without payload", async () => {
      const msg: MAPMessage = {
        id: "msg-1",
        from: "hub",
        to: { scope: "swarm:test" },
        timestamp: new Date().toISOString(),
      };
      for (const handler of deps.mock.messageHandlers) {
        await handler(msg);
      }

      expect(deps.tasksAdapter.createTask).not.toHaveBeenCalled();
    });

    it("ignores messages without type field", async () => {
      await deps.mock.emitMessage({ taskId: "t-1", status: "open" });

      expect(deps.tasksAdapter.createTask).not.toHaveBeenCalled();
    });
  });
});

// =============================================================================
// Tests — Context and messaging NOT handled here (agent-inbox flow)
// =============================================================================

describe("CoordinationHandler — context/messaging excluded", () => {
  let deps: ReturnType<typeof createDeps>;

  beforeEach(() => {
    deps = createDeps();
    setupCoordinationHandlers(deps);
  });

  it("does not handle context.shared messages (handled by agent-inbox)", async () => {
    await deps.mock.emitMessage({
      type: "context.shared",
      context_type: "code_review",
      data: { file: "main.ts" },
      source_swarm_id: "swarm-A",
    });

    // No task adapter calls
    expect(deps.tasksAdapter.createTask).not.toHaveBeenCalled();
    expect(deps.tasksAdapter.transitionTask).not.toHaveBeenCalled();
    // No inbox calls from coordination handler
    expect(deps.inboxAdapter.send).not.toHaveBeenCalled();
  });

  it("does not handle message type messages (handled by agent-inbox)", async () => {
    await deps.mock.emitMessage({
      type: "message",
      from_swarm_id: "swarm-A",
      to_swarm_id: "agent-1",
      content_type: "text",
      content: "Hello",
    });

    expect(deps.tasksAdapter.createTask).not.toHaveBeenCalled();
    expect(deps.inboxAdapter.send).not.toHaveBeenCalled();
  });

  it("does not register x-openhive/context.share notification handler", () => {
    expect(deps.mock.notificationHandlers.has("x-openhive/context.share")).toBe(false);
  });

  it("does not register x-openhive/message.send notification handler", () => {
    expect(deps.mock.notificationHandlers.has("x-openhive/message.send")).toBe(false);
  });

  it("does not register x-openhive/task.assign notification handler", () => {
    expect(deps.mock.notificationHandlers.has("x-openhive/task.assign")).toBe(false);
  });

  it("does not register x-openhive/task.status notification handler", () => {
    expect(deps.mock.notificationHandlers.has("x-openhive/task.status")).toBe(false);
  });
});

// =============================================================================
// Tests — Workspace notifications
// =============================================================================

describe("CoordinationHandler — workspace notifications", () => {
  let deps: ReturnType<typeof createDeps>;

  describe("workspace.execute", () => {
    it("delegates to workspace handler via x-workspace/task.execute", async () => {
      const handleWorkspaceExecute = vi.fn().mockResolvedValue(undefined);
      deps = createDeps({
        workspaceHandler: {
          handleWorkspaceExecute,
          isWorkspaceExecuteMessage: (msg) => msg.method === "x-workspace/task.execute",
        },
      });
      setupCoordinationHandlers(deps);

      const params = { request_id: "req-1", prompt: "Do thing", cwd: "/tmp" };
      await deps.mock.emitNotification("x-workspace/task.execute", params);

      expect(handleWorkspaceExecute).toHaveBeenCalledWith(params);
    });

    it("delegates legacy x-openhive/learning.workspace.execute", async () => {
      const handleWorkspaceExecute = vi.fn().mockResolvedValue(undefined);
      deps = createDeps({
        workspaceHandler: {
          handleWorkspaceExecute,
          isWorkspaceExecuteMessage: () => true,
        },
      });
      setupCoordinationHandlers(deps);

      const params = { request_id: "req-2", prompt: "Legacy task", cwd: "/tmp" };
      await deps.mock.emitNotification("x-openhive/learning.workspace.execute", params);

      expect(handleWorkspaceExecute).toHaveBeenCalledWith(params);
    });

    it("warns on workspace handler failure without throwing", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const handleWorkspaceExecute = vi.fn().mockRejectedValue(new Error("spawn failed"));
      deps = createDeps({
        workspaceHandler: {
          handleWorkspaceExecute,
          isWorkspaceExecuteMessage: () => true,
        },
      });
      setupCoordinationHandlers(deps);

      await deps.mock.emitNotification("x-workspace/task.execute", {
        request_id: "req-3",
        prompt: "fail",
        cwd: "/tmp",
      });

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("spawn failed"));
      warnSpy.mockRestore();
    });

    it("does not register workspace handlers when no workspace handler provided", () => {
      deps = createDeps();
      setupCoordinationHandlers(deps);

      expect(deps.mock.notificationHandlers.has("x-workspace/task.execute")).toBe(false);
      expect(deps.mock.notificationHandlers.has("x-openhive/learning.workspace.execute")).toBe(false);
    });
  });
});

// =============================================================================
// Tests — Handler registration and cleanup
// =============================================================================

describe("CoordinationHandler — cleanup", () => {
  it("removes all handlers on cleanup", () => {
    const deps = createDeps({
      workspaceHandler: {
        handleWorkspaceExecute: vi.fn(),
        isWorkspaceExecuteMessage: () => true,
      },
    });
    const cleanup = setupCoordinationHandlers(deps);

    // Verify handlers were registered
    expect(deps.mock.messageHandlers.size).toBe(1);
    expect(deps.mock.notificationHandlers.size).toBeGreaterThan(0);

    cleanup();

    // All handlers removed
    expect(deps.mock.messageHandlers.size).toBe(0);
    for (const [, handlers] of deps.mock.notificationHandlers) {
      expect(handlers.size).toBe(0);
    }
  });

  it("only registers message handler and workspace notifications", () => {
    const deps = createDeps({
      workspaceHandler: {
        handleWorkspaceExecute: vi.fn(),
        isWorkspaceExecuteMessage: () => true,
      },
    });
    setupCoordinationHandlers(deps);

    // One message handler for task events
    expect(deps.mock.messageHandlers.size).toBe(1);

    // Two notification handlers: x-workspace/task.execute + legacy
    const registeredMethods = [...deps.mock.notificationHandlers.keys()];
    expect(registeredMethods).toContain("x-workspace/task.execute");
    expect(registeredMethods).toContain("x-openhive/learning.workspace.execute");
    expect(registeredMethods).toHaveLength(2);
  });

  it("registers only message handler when no workspace handler", () => {
    const deps = createDeps();
    setupCoordinationHandlers(deps);

    expect(deps.mock.messageHandlers.size).toBe(1);
    expect(deps.mock.notificationHandlers.size).toBe(0);
  });
});
