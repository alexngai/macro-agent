/**
 * Tests for Task Bridge — task lifecycle → MAP observability.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  createTaskBridge,
  type TaskBridgeConnection,
} from "../task-bridge.js";

function mockConnection(): TaskBridgeConnection & {
  send: ReturnType<typeof vi.fn>;
} {
  return {
    send: vi.fn().mockResolvedValue({}),
    get isConnected() {
      return true;
    },
  };
}

describe("TaskBridge", () => {
  let conn: ReturnType<typeof mockConnection>;
  const scope = "swarm:test";

  beforeEach(() => {
    conn = mockConnection();
  });

  it("emits task.created event", async () => {
    const bridge = createTaskBridge(conn, scope);

    await bridge.taskCreated({
      id: "task-1",
      title: "Implement feature",
      status: "open",
      assignee: "agent-1",
    });

    expect(conn.send).toHaveBeenCalledWith(
      { scope },
      expect.objectContaining({
        type: "task.created",
        task: expect.objectContaining({
          id: "task-1",
          title: "Implement feature",
          status: "open",
          assignee: "agent-1",
        }),
        _origin: "macro-agent",
      }),
    );
  });

  it("emits task.status event", async () => {
    const bridge = createTaskBridge(conn, scope);

    await bridge.taskStatusChanged("task-1", "open", "in_progress", "agent-1");

    expect(conn.send).toHaveBeenCalledWith(
      { scope },
      expect.objectContaining({
        type: "task.status",
        taskId: "task-1",
        previous: "open",
        current: "in_progress",
        agentId: "agent-1",
      }),
    );
  });

  it("emits task.completed on terminal status", async () => {
    const bridge = createTaskBridge(conn, scope);

    await bridge.taskStatusChanged("task-1", "in_progress", "completed", "agent-1");

    // Should emit both task.status and task.completed
    expect(conn.send).toHaveBeenCalledTimes(2);
    expect(conn.send).toHaveBeenCalledWith(
      { scope },
      expect.objectContaining({ type: "task.status", current: "completed" }),
    );
    expect(conn.send).toHaveBeenCalledWith(
      { scope },
      expect.objectContaining({ type: "task.completed", taskId: "task-1" }),
    );
  });

  it("emits task.completed on closed status", async () => {
    const bridge = createTaskBridge(conn, scope);

    await bridge.taskStatusChanged("task-1", "in_progress", "closed");

    expect(conn.send).toHaveBeenCalledWith(
      { scope },
      expect.objectContaining({ type: "task.completed" }),
    );
  });

  it("does not emit task.completed on non-terminal status", async () => {
    const bridge = createTaskBridge(conn, scope);

    await bridge.taskStatusChanged("task-1", "open", "in_progress");

    expect(conn.send).toHaveBeenCalledTimes(1);
    expect(conn.send).toHaveBeenCalledWith(
      { scope },
      expect.objectContaining({ type: "task.status" }),
    );
  });

  it("emits task.assigned event", async () => {
    const bridge = createTaskBridge(conn, scope);

    await bridge.taskAssigned("task-1", "agent-2");

    expect(conn.send).toHaveBeenCalledWith(
      { scope },
      expect.objectContaining({
        type: "task.assigned",
        taskId: "task-1",
        assignee: "agent-2",
      }),
    );
  });

  it("does nothing when disconnected", async () => {
    const disconnected = {
      ...conn,
      get isConnected() {
        return false;
      },
    };
    const bridge = createTaskBridge(disconnected, scope);

    await bridge.taskCreated({ id: "t", title: "t", status: "open" });
    await bridge.taskStatusChanged("t", "open", "closed");
    await bridge.taskAssigned("t", "a");

    expect(conn.send).not.toHaveBeenCalled();
  });

  it("silently handles send failures", async () => {
    conn.send.mockRejectedValue(new Error("network error"));

    const bridge = createTaskBridge(conn, scope);

    // Should not throw
    await expect(
      bridge.taskCreated({ id: "t", title: "t", status: "open" }),
    ).resolves.toBeUndefined();
  });
});
