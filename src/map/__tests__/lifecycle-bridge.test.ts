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

/** Flush microtasks and any pending setTimeout(0)-ish waits used by the bridge */
async function flushAsync(iterations = 5): Promise<void> {
  for (let i = 0; i < iterations; i++) {
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("LifecycleBridge", () => {
  let conn: ReturnType<typeof mockConnection>;
  const scope = "swarm:test";

  beforeEach(() => {
    conn = mockConnection();
  });

  it("registers agent with MAP hub on spawn event", async () => {
    const { callback } = createLifecycleBridge(
      conn,
      {} as AgentStore,
      scope,
    );

    callback({
      type: "spawned",
      agent: mockAgent({ id: "agent-1", name: "worker-1", role: "worker" }),
    });

    await flushAsync();

    expect(conn.callExtension).toHaveBeenCalledWith(
      "map/agents/register",
      expect.objectContaining({
        name: "worker-1",
        role: "worker",
      }),
    );
  });

  it("includes per-agent ACP capabilities for coordinators", async () => {
    const { callback } = createLifecycleBridge(
      conn,
      {} as AgentStore,
      scope,
    );

    callback({
      type: "spawned",
      agent: mockAgent({ id: "coord-1", name: "coordinator-1", role: "coordinator" }),
    });

    await flushAsync();

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

  it("does not include ACP capabilities for workers", async () => {
    const { callback } = createLifecycleBridge(
      conn,
      {} as AgentStore,
      scope,
    );

    callback({
      type: "spawned",
      agent: mockAgent({ id: "worker-1", name: "worker-1", role: "worker" }),
    });

    await flushAsync();

    const call = conn.callExtension.mock.calls[0];
    const params = call[1] as Record<string, unknown>;
    const caps = params.capabilities as Record<string, unknown>;
    expect(caps.protocols).toBeUndefined();
    expect(caps.acp).toBeUndefined();
    expect(caps.messaging).toEqual({ canReceive: true });
  });

  it("includes peerMapId in metadata when getLocalMapId resolves", async () => {
    const getLocalMapId = vi.fn((id: string) =>
      id === "coord-1" ? "map-ulid-local" : undefined,
    );
    const { callback } = createLifecycleBridge(
      conn,
      {} as AgentStore,
      scope,
      undefined,
      getLocalMapId,
    );

    callback({
      type: "spawned",
      agent: mockAgent({ id: "coord-1", name: "coordinator-1", role: "coordinator" }),
    });

    await flushAsync();

    const call = conn.callExtension.mock.calls.find(
      (c: any[]) => c[0] === "map/agents/register",
    );
    expect(call).toBeDefined();
    const params = call![1] as Record<string, unknown>;
    const metadata = params.metadata as Record<string, unknown>;
    expect(metadata.peerMapId).toBe("map-ulid-local");
    expect(metadata.peerAgentId).toBe("coord-1");
  });

  it("registers without peerMapId when lookup returns undefined", async () => {
    const getLocalMapId = vi.fn(() => undefined);
    const { callback } = createLifecycleBridge(
      conn,
      {} as AgentStore,
      scope,
      undefined,
      getLocalMapId,
    );

    callback({
      type: "spawned",
      agent: mockAgent({ id: "coord-1", role: "coordinator" }),
    });

    // Use a longer wait since the bridge will poll ~500ms for the local MAP ID
    await new Promise((r) => setTimeout(r, 600));

    const call = conn.callExtension.mock.calls.find(
      (c: any[]) => c[0] === "map/agents/register",
    );
    expect(call).toBeDefined();
    const params = call![1] as Record<string, unknown>;
    const metadata = params.metadata as Record<string, unknown>;
    expect(metadata.peerMapId).toBeUndefined();
  });

  it("unregisters agent from MAP hub on stop event", async () => {
    const { callback } = createLifecycleBridge(
      conn,
      {} as AgentStore,
      scope,
    );

    // First spawn, then stop
    callback({ type: "spawned", agent: mockAgent({ id: "agent-1" }) });
    await flushAsync();
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

    // Wait for spawn registration + mapId capture
    await flushAsync();

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

  it("does nothing when disconnected", async () => {
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

    await flushAsync();

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

    await flushAsync();
    await cleanup();

    const unregisterCalls = conn.callExtension.mock.calls.filter(
      (c: any[]) => c[0] === "map/agents/unregister",
    );
    expect(unregisterCalls).toHaveLength(2);
  });

  it("silently handles MAP call failures", async () => {
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

    await flushAsync();
  });

  it("uses agent.id as fallback name when name is undefined", async () => {
    const { callback } = createLifecycleBridge(
      conn,
      {} as AgentStore,
      scope,
    );

    callback({
      type: "spawned",
      agent: mockAgent({ id: "agent-99", name: undefined }),
    });

    await flushAsync();

    expect(conn.callExtension).toHaveBeenCalledWith(
      "map/agents/register",
      expect.objectContaining({ name: "agent-99" }),
    );
  });

  // ── awaitRegistration() ─────────────────────────────────────────────

  describe("awaitRegistration", () => {
    it("returns true once map/agents/register completes (mapId populated)", async () => {
      // Hub returns a MAP-assigned ULID for the registered agent.
      conn.callExtension.mockResolvedValueOnce({ agent: { id: "map-ulid-A" } });

      const { callback, awaitRegistration } = createLifecycleBridge(
        conn,
        {} as AgentStore,
        scope,
      );

      callback({
        type: "spawned",
        agent: mockAgent({ id: "agent-A", role: "coordinator" }),
      });

      // The async register IIFE inside the bridge does waitForLocalMapId(~500ms)
      // then resolves callExtension. Wait long enough for that to settle.
      const ok = await awaitRegistration("agent-A", 2_000);
      expect(ok).toBe(true);
    });

    it("returns false if timeout elapses before registration completes", async () => {
      // Stall the registration call so mapId is never populated within the window.
      let resolveExt: (value: unknown) => void = () => {};
      conn.callExtension.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveExt = resolve;
          }),
      );

      const { callback, awaitRegistration } = createLifecycleBridge(
        conn,
        {} as AgentStore,
        scope,
      );

      callback({
        type: "spawned",
        agent: mockAgent({ id: "agent-B", role: "coordinator" }),
      });

      const ok = await awaitRegistration("agent-B", 200);
      expect(ok).toBe(false);

      // Cleanup the dangling promise so vitest doesn't warn about leaks.
      resolveExt({ agent: { id: "map-ulid-late" } });
    });

    it("returns false for an agentId that was never spawned", async () => {
      const { awaitRegistration } = createLifecycleBridge(
        conn,
        {} as AgentStore,
        scope,
      );

      const ok = await awaitRegistration("never-spawned-agent", 150);
      expect(ok).toBe(false);
    });
  });
});
