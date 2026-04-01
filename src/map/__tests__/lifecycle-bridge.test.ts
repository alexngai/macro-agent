/**
 * Tests for Lifecycle Bridge — agent lifecycle → MAP agent registration.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  createLifecycleBridge,
  type LifecycleBridgeConnection,
} from "../lifecycle-bridge.js";
import type { AgentStore } from "../../agent/agent-store.js";
import type { TaskBridge } from "../types.js";
import type { Agent } from "../../store/types/index.js";

function mockConnection(): LifecycleBridgeConnection & {
  spawn: ReturnType<typeof vi.fn>;
  callExtension: ReturnType<typeof vi.fn>;
} {
  return {
    spawn: vi.fn().mockResolvedValue({}),
    callExtension: vi.fn().mockResolvedValue({}),
    get isConnected() {
      return true;
    },
  };
}

function mockAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent-1",
    name: "test-agent",
    session_id: "session-1",
    parent: null,
    lineage: [],
    state: "running",
    task: "Test task",
    role: "worker",
    ...overrides,
  } as Agent;
}

function mockTaskBridge(): TaskBridge & {
  taskCreated: ReturnType<typeof vi.fn>;
  taskStatusChanged: ReturnType<typeof vi.fn>;
  taskAssigned: ReturnType<typeof vi.fn>;
} {
  return {
    taskCreated: vi.fn().mockResolvedValue(undefined),
    taskStatusChanged: vi.fn().mockResolvedValue(undefined),
    taskAssigned: vi.fn().mockResolvedValue(undefined),
  };
}

describe("LifecycleBridge", () => {
  let conn: ReturnType<typeof mockConnection>;
  const scope = "swarm:test";

  beforeEach(() => {
    conn = mockConnection();
  });

  it("registers agent with MAP hub on spawn event", () => {
    const { callback } = createLifecycleBridge(
      conn,
      {} as AgentStore,
      scope,
    );

    callback({
      type: "spawned",
      agent: mockAgent({ id: "agent-1", name: "worker-1", role: "worker" }),
    });

    expect(conn.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agent-1",
        name: "worker-1",
        role: "worker",
        scopes: [scope],
      }),
    );
  });

  it("unregisters agent from MAP hub on stop event", () => {
    const { callback } = createLifecycleBridge(
      conn,
      {} as AgentStore,
      scope,
    );

    // First spawn, then stop
    callback({ type: "spawned", agent: mockAgent({ id: "agent-1" }) });
    callback({
      type: "stopped",
      agent: mockAgent({ id: "agent-1" }),
      reason: "completed",
    });

    expect(conn.callExtension).toHaveBeenCalledWith(
      "map/agents/unregister",
      expect.objectContaining({
        agentId: "agent-1",
        reason: "completed",
      }),
    );
  });

  it("does nothing when disconnected", () => {
    const disconnected = {
      ...conn,
      get isConnected() {
        return false;
      },
    };
    const { callback } = createLifecycleBridge(
      disconnected,
      {} as AgentStore,
      scope,
    );

    callback({ type: "spawned", agent: mockAgent() });

    expect(conn.spawn).not.toHaveBeenCalled();
  });

  it("bridges task creation on spawn when agent has task_id", () => {
    const tb = mockTaskBridge();
    const { callback } = createLifecycleBridge(
      conn,
      {} as AgentStore,
      scope,
      tb,
    );

    const agent = mockAgent({ id: "agent-1", name: "worker-1" });
    (agent as any).task_id = "task-42";
    callback({ type: "spawned", agent });

    expect(tb.taskCreated).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "task-42",
        status: "open",
        assignee: "agent-1",
      }),
    );
  });

  it("bridges task completion on stop when agent has task_id", () => {
    const tb = mockTaskBridge();
    const { callback } = createLifecycleBridge(
      conn,
      {} as AgentStore,
      scope,
      tb,
    );

    const agent = mockAgent({ id: "agent-1" });
    (agent as any).task_id = "task-42";
    callback({ type: "spawned", agent });
    callback({ type: "stopped", agent, reason: "completed" });

    expect(tb.taskStatusChanged).toHaveBeenCalledWith(
      "task-42",
      "in_progress",
      "completed",
      "agent-1",
    );
  });

  it("cleanup unregisters all tracked agents", async () => {
    const { callback, cleanup } = createLifecycleBridge(
      conn,
      {} as AgentStore,
      scope,
    );

    callback({ type: "spawned", agent: mockAgent({ id: "a1" }) });
    callback({ type: "spawned", agent: mockAgent({ id: "a2" }) });

    await cleanup();

    expect(conn.callExtension).toHaveBeenCalledTimes(2);
    expect(conn.callExtension).toHaveBeenCalledWith(
      "map/agents/unregister",
      expect.objectContaining({ agentId: "a1" }),
    );
    expect(conn.callExtension).toHaveBeenCalledWith(
      "map/agents/unregister",
      expect.objectContaining({ agentId: "a2" }),
    );
  });

  it("silently handles MAP call failures", () => {
    conn.spawn.mockRejectedValue(new Error("network error"));

    const { callback } = createLifecycleBridge(
      conn,
      {} as AgentStore,
      scope,
    );

    // Should not throw
    expect(() => {
      callback({ type: "spawned", agent: mockAgent() });
    }).not.toThrow();
  });

  it("uses agent.id as fallback name when name is undefined", () => {
    const { callback } = createLifecycleBridge(
      conn,
      {} as AgentStore,
      scope,
    );

    callback({
      type: "spawned",
      agent: mockAgent({ id: "agent-99", name: undefined }),
    });

    expect(conn.spawn).toHaveBeenCalledWith(
      expect.objectContaining({ name: "agent-99" }),
    );
  });
});
