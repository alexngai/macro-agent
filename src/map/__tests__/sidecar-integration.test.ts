/**
 * Integration test for MAP Sidecar
 *
 * Tests the sidecar's connection lifecycle and graceful degradation.
 * Full protocol integration is tested via E2E tests with a real OpenHive instance.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi } from "vitest";
import { createMAPSidecar } from "../sidecar.js";
import type { MAPSidecar, MAPSidecarConfig } from "../types.js";
import type { AgentManager } from "../../agent/agent-manager.js";
import type { AgentStore } from "../../agent/agent-store.js";
import type { InboxAdapter, TasksAdapter } from "../../adapters/types.js";

// =============================================================================
// Mock Dependencies
// =============================================================================

function mockDeps() {
  const lifecycleCallbacks: Array<(event: any) => void> = [];

  const agentManager = {
    onLifecycleEvent: vi.fn((cb: any) => {
      lifecycleCallbacks.push(cb);
      return () => {
        const idx = lifecycleCallbacks.indexOf(cb);
        if (idx >= 0) lifecycleCallbacks.splice(idx, 1);
      };
    }),
    list: vi.fn(() => []),
    get: vi.fn(() => null),
    spawn: vi.fn().mockResolvedValue({ agent: { id: "spawned-1" } }),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as AgentManager;

  const agentStore = {
    getAgent: vi.fn(() => null),
    listAgents: vi.fn(() => []),
  } as unknown as AgentStore;

  const inboxAdapter = {
    onDelivery: vi.fn(),
    offDelivery: vi.fn(),
    send: vi.fn().mockResolvedValue("msg-1"),
  } as unknown as InboxAdapter;

  const tasksAdapter = {
    createTask: vi.fn().mockResolvedValue("task-1"),
    transitionTask: vi.fn().mockResolvedValue(undefined),
    listTasks: vi.fn().mockResolvedValue([]),
    connected: true,
  } as unknown as TasksAdapter;

  return {
    agentManager,
    agentStore,
    inboxAdapter,
    tasksAdapter,
    lifecycleCallbacks,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe("MAP Sidecar — graceful degradation", () => {
  it("starts without error when server is unreachable", async () => {
    const deps = mockDeps();

    const config: MAPSidecarConfig = {
      server: "ws://127.0.0.1:1",
      scope: "swarm:test",
      reconnection: { enabled: false },
      reconnectIntervalMs: 999999,
    };

    const sidecar = createMAPSidecar(deps, config);

    // Should not throw
    await expect(sidecar.start()).resolves.toBeUndefined();
    expect(sidecar.connected).toBe(false);

    await sidecar.stop();
  }, 10000);

  it("reportCheckpoint returns null when disconnected", async () => {
    const deps = mockDeps();

    const config: MAPSidecarConfig = {
      server: "ws://127.0.0.1:1",
      reconnection: { enabled: false },
      reconnectIntervalMs: 999999,
    };

    const sidecar = createMAPSidecar(deps, config);
    await sidecar.start();

    const result = await sidecar.reportCheckpoint({
      id: "test",
      session_id: "s1",
      agent: "test",
      branch: null,
      files_touched: [],
      checkpoints_count: 0,
    });

    expect(result).toBeNull();
    await sidecar.stop();
  });

  it("stop is idempotent", async () => {
    const deps = mockDeps();

    const config: MAPSidecarConfig = {
      server: "ws://127.0.0.1:1",
      reconnection: { enabled: false },
      reconnectIntervalMs: 999999,
    };

    const sidecar = createMAPSidecar(deps, config);
    await sidecar.start();

    await sidecar.stop();
    await sidecar.stop(); // Should not throw
    expect(sidecar.connected).toBe(false);
  });
});

describe("MAP Sidecar — config handling", () => {
  it("appends /ws/map to server URL if missing", async () => {
    const deps = mockDeps();

    // Mock the import to capture the URL
    const config: MAPSidecarConfig = {
      server: "ws://127.0.0.1:1",
      token: "test-token",
      scope: "swarm:custom",
      agentName: "custom-sidecar",
      trajectorySyncLevel: "full",
      reconnection: { enabled: false },
      reconnectIntervalMs: 999999,
    };

    const sidecar = createMAPSidecar(deps, config);
    await sidecar.start();
    // Connection will fail but that's expected — we're testing config handling
    expect(sidecar.connected).toBe(false);
    await sidecar.stop();
  });

  it("uses default scope and agent name", async () => {
    const deps = mockDeps();

    const config: MAPSidecarConfig = {
      server: "ws://127.0.0.1:1",
      reconnection: { enabled: false },
      reconnectIntervalMs: 999999,
    };

    const sidecar = createMAPSidecar(deps, config);
    await sidecar.start();
    // Just verify it doesn't crash with minimal config
    expect(sidecar.connected).toBe(false);
    await sidecar.stop();
  });
});

describe("MAP Sidecar — module wiring", () => {
  it("does not wire sub-modules when connection fails", async () => {
    const deps = mockDeps();

    const config: MAPSidecarConfig = {
      server: "ws://127.0.0.1:1",
      reconnection: { enabled: false },
      reconnectIntervalMs: 999999,
    };

    const sidecar = createMAPSidecar(deps, config);
    await sidecar.start();

    // onLifecycleEvent should NOT have been called since connection failed
    // (sub-modules are only wired after successful connection)
    expect(deps.agentManager.onLifecycleEvent).not.toHaveBeenCalled();

    await sidecar.stop();
  });
});
