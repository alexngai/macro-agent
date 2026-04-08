/**
 * Tests for MAPSidecar.emitEvent() — custom event emission to MAP hub.
 */

import { describe, it, expect, vi } from "vitest";
import { createMAPSidecar } from "../sidecar.js";
import type { MAPSidecarConfig } from "../types.js";
import type { AgentManager } from "../../agent/agent-manager.js";
import type { AgentStore } from "../../agent/agent-store.js";
import type { InboxAdapter, TasksAdapter } from "../../adapters/types.js";

function mockDeps() {
  return {
    agentManager: {
      onLifecycleEvent: vi.fn(() => () => {}),
      list: vi.fn(() => []),
      get: vi.fn(() => null),
      spawn: vi.fn().mockResolvedValue({ agent: { id: "spawned-1" } }),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as AgentManager,
    agentStore: {
      getAgent: vi.fn(() => null),
      listAgents: vi.fn(() => []),
    } as unknown as AgentStore,
    inboxAdapter: {
      onDelivery: vi.fn(),
      offDelivery: vi.fn(),
      send: vi.fn().mockResolvedValue("msg-1"),
    } as unknown as InboxAdapter,
    tasksAdapter: {
      createTask: vi.fn().mockResolvedValue("task-1"),
      transitionTask: vi.fn().mockResolvedValue(undefined),
      listTasks: vi.fn().mockResolvedValue([]),
      connected: true,
    } as unknown as TasksAdapter,
  };
}

describe("MAPSidecar.emitEvent", () => {
  it("is a no-op when disconnected", async () => {
    const deps = mockDeps();
    const config: MAPSidecarConfig = {
      server: "ws://127.0.0.1:1",
      scope: "swarm:test",
      reconnection: { enabled: false },
      reconnectIntervalMs: 999999,
    };

    const sidecar = createMAPSidecar(deps, config);
    await sidecar.start();
    expect(sidecar.connected).toBe(false);

    // Should not throw when disconnected
    await sidecar.emitEvent!({ type: "dispatch.poll", dispatched: 0 });

    await sidecar.stop();
  }, 10000);

  it("is defined on the sidecar", () => {
    const deps = mockDeps();
    const config: MAPSidecarConfig = {
      server: "ws://127.0.0.1:1",
      reconnection: { enabled: false },
      reconnectIntervalMs: 999999,
    };

    const sidecar = createMAPSidecar(deps, config);
    expect(sidecar.emitEvent).toBeDefined();
    expect(typeof sidecar.emitEvent).toBe("function");
  });
});
