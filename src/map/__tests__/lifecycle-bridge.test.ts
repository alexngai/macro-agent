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
  callExtension: ReturnType<typeof vi.fn>;
} {
  return {
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

    expect(conn.callExtension).toHaveBeenCalledWith(
      "map/agents/register",
      expect.objectContaining({
        name: "worker-1",
        role: "worker",
      }),
    );
  });

  it("includes per-agent ACP capabilities for coordinators", () => {
    const { callback } = createLifecycleBridge(
      conn,
      {} as AgentStore,
      scope,
    );

    callback({
      type: "spawned",
      agent: mockAgent({ id: "coord-1", name: "coordinator-1", role: "coordinator" }),
    });

    expect(conn.callExtension).toHaveBeenCalledWith(
      "map/agents/register",
      expect.objectContaining({
        name: "coordinator-1",
        role: "coordinator",
        capabilities: expect.objectContaining({
          protocols: ["acp"],
          acp: { version: "2024-10-07" },
          messaging: { canReceive: true },
        }),
      }),
    );
  });

  it("does not include ACP capabilities for workers", () => {
    const { callback } = createLifecycleBridge(
      conn,
      {} as AgentStore,
      scope,
    );

    callback({
      type: "spawned",
      agent: mockAgent({ id: "worker-1", name: "worker-1", role: "worker" }),
    });

    const call = conn.callExtension.mock.calls[0];
    const params = call[1] as Record<string, unknown>;
    const caps = params.capabilities as Record<string, unknown>;
    expect(caps.protocols).toBeUndefined();
    expect(caps.acp).toBeUndefined();
    expect(caps.messaging).toEqual({ canReceive: true });
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
        reason: "completed",
      }),
    );
  });

  it("uses MAP-assigned ID for unregistration when available", async () => {
    conn.callExtension.mockResolvedValueOnce({ agent: { id: "map-ulid-1" } });

    const { callback } = createLifecycleBridge(
      conn,
      {} as AgentStore,
      scope,
    );

    callback({ type: "spawned", agent: mockAgent({ id: "agent-1" }) });

    // Wait for the .then() that stores mapId
    await new Promise(r => setTimeout(r, 10));

    callback({
      type: "stopped",
      agent: mockAgent({ id: "agent-1" }),
      reason: "completed",
    });

    expect(conn.callExtension).toHaveBeenLastCalledWith(
      "map/agents/unregister",
      expect.objectContaining({
        agentId: "map-ulid-1",
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

    expect(conn.callExtension).not.toHaveBeenCalled();
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

    // 2 register calls + 2 unregister calls
    const unregisterCalls = conn.callExtension.mock.calls.filter(
      (c: any[]) => c[0] === "map/agents/unregister",
    );
    expect(unregisterCalls).toHaveLength(2);
  });

  it("silently handles MAP call failures", () => {
    conn.callExtension.mockRejectedValue(new Error("network error"));

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

    expect(conn.callExtension).toHaveBeenCalledWith(
      "map/agents/register",
      expect.objectContaining({ name: "agent-99" }),
    );
  });
});
