/**
 * Tests for AgentManagerV2's three-level TaskRef resolution:
 *   1. Explicit SpawnAgentOptions.taskRef wins.
 *   2. resolveTaskRef(opts) runs when no explicit ref.
 *   3. Fallback to taskResourceId + options.task_id when both above yield nothing.
 *
 * Verifies the G3/G14 closure: single-graph default via boot config + multi-graph
 * resolver for deployments that touch more than one opentasks graph.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createAgentManagerV2 } from "../agent-manager-v2.js";
import { AgentStore } from "../agent-store.js";
import type { AgentManager } from "../agent-manager.js";
import type { InboxAdapter, TasksAdapter } from "../../adapters/types.js";
import type { SpawnAgentOptions } from "../types.js";
import type { TaskRef } from "git-cascade/events";

vi.mock("acp-factory", () => ({
  AgentFactory: {
    spawn: vi.fn().mockResolvedValue({
      createSession: vi.fn().mockResolvedValue({
        id: "provider-session-1",
        prompt: vi.fn().mockReturnValue({
          [Symbol.asyncIterator]: () => ({
            next: () => Promise.resolve({ done: true, value: undefined }),
          }),
        }),
        forkWithFlush: vi.fn().mockResolvedValue({ id: "forked-session-1" }),
      }),
      loadSession: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
      isRunning: vi.fn().mockReturnValue(true),
    }),
  },
}));

function mockInbox(): InboxAdapter {
  return {
    registerAgent: vi.fn().mockResolvedValue(undefined),
    deregisterAgent: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue("msg-1"),
    onDelivery: vi.fn(),
    offDelivery: vi.fn(),
    checkInbox: vi.fn().mockResolvedValue([]),
    readThread: vi.fn().mockResolvedValue([]),
    setSignalFilter: vi.fn(),
    setEmissionValidator: vi.fn(),
    socketPath: "/tmp/test-inbox.sock",
    stop: vi.fn().mockResolvedValue(undefined),
  } as unknown as InboxAdapter;
}

function mockTasks(): TasksAdapter {
  return {
    createTask: vi.fn().mockResolvedValue("ot-task-1"),
    assignTask: vi.fn().mockResolvedValue(undefined),
    transitionTask: vi.fn().mockResolvedValue(undefined),
    getTask: vi.fn().mockResolvedValue({ id: "t-1", title: "x", status: "open" }),
    queryReady: vi.fn().mockResolvedValue([]),
    listTasks: vi.fn().mockResolvedValue([]),
    addBlocker: vi.fn().mockResolvedValue(undefined),
    removeBlocker: vi.fn().mockResolvedValue(undefined),
    claimTask: vi.fn().mockResolvedValue(null),
    unclaimTask: vi.fn().mockResolvedValue(undefined),
    listClaimable: vi.fn().mockResolvedValue([]),
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
    connected: true,
  } as unknown as TasksAdapter;
}

describe("AgentManagerV2 taskRef resolution", () => {
  let agentStore: AgentStore;
  let inbox: InboxAdapter;
  let tasks: TasksAdapter;
  let manager: AgentManager;

  afterEach(async () => {
    await manager?.close();
    agentStore?.close();
  });

  beforeEach(() => {
    agentStore = new AgentStore(":memory:");
    inbox = mockInbox();
    tasks = mockTasks();
  });

  function getStoredTaskRef(agentId: string): TaskRef | undefined {
    const record = agentStore.getAgent(agentId);
    const meta = record?.metadata as Record<string, unknown> | undefined;
    return meta?.task_ref as TaskRef | undefined;
  }

  it("uses taskResourceId + task_id when no other source resolves a ref", async () => {
    manager = createAgentManagerV2(agentStore, inbox, tasks, {
      defaultCwd: "/tmp/t",
      taskResourceId: "resource-default",
    });

    const result = await manager.spawn({
      task: "work",
      task_id: "node-42" as unknown as SpawnAgentOptions["task_id"],
      role: "worker",
    });

    expect(getStoredTaskRef(result.id)).toEqual({
      resource_id: "resource-default",
      node_id: "node-42",
    });
  });

  it("falls through to no taskRef when neither resolver nor taskResourceId apply", async () => {
    manager = createAgentManagerV2(agentStore, inbox, tasks, {
      defaultCwd: "/tmp/t",
      // No taskResourceId, no resolveTaskRef.
    });

    const result = await manager.spawn({ task: "work", role: "worker" });

    expect(getStoredTaskRef(result.id)).toBeUndefined();
  });

  it("resolveTaskRef wins over the taskResourceId fallback", async () => {
    const resolveTaskRef = vi
      .fn()
      .mockReturnValue({ resource_id: "resource-from-resolver", node_id: "n1" });

    manager = createAgentManagerV2(agentStore, inbox, tasks, {
      defaultCwd: "/tmp/t",
      taskResourceId: "resource-default",
      resolveTaskRef,
    });

    const result = await manager.spawn({ task: "work", role: "worker" });

    expect(resolveTaskRef).toHaveBeenCalledOnce();
    expect(getStoredTaskRef(result.id)).toEqual({
      resource_id: "resource-from-resolver",
      node_id: "n1",
    });
  });

  it("resolveTaskRef returning undefined falls through to taskResourceId", async () => {
    const resolveTaskRef = vi.fn().mockReturnValue(undefined);

    manager = createAgentManagerV2(agentStore, inbox, tasks, {
      defaultCwd: "/tmp/t",
      taskResourceId: "resource-default",
      resolveTaskRef,
    });

    const result = await manager.spawn({
      task: "work",
      task_id: "node-9" as unknown as SpawnAgentOptions["task_id"],
      role: "worker",
    });

    expect(resolveTaskRef).toHaveBeenCalledOnce();
    expect(getStoredTaskRef(result.id)).toEqual({
      resource_id: "resource-default",
      node_id: "node-9",
    });
  });

  it("explicit SpawnAgentOptions.taskRef wins over resolver AND taskResourceId", async () => {
    const resolveTaskRef = vi
      .fn()
      .mockReturnValue({ resource_id: "resource-from-resolver", node_id: "r1" });

    manager = createAgentManagerV2(agentStore, inbox, tasks, {
      defaultCwd: "/tmp/t",
      taskResourceId: "resource-default",
      resolveTaskRef,
    });

    const explicit: TaskRef = { resource_id: "resource-explicit", node_id: "e1" };
    const result = await manager.spawn({
      task: "work",
      role: "worker",
      taskRef: explicit,
    });

    // Resolver should NOT be called when caller already supplied taskRef.
    expect(resolveTaskRef).not.toHaveBeenCalled();
    expect(getStoredTaskRef(result.id)).toEqual(explicit);
  });

  it("resolver receives the intercepted SpawnAgentOptions (post-interceptor)", async () => {
    const resolveTaskRef = vi.fn().mockReturnValue(undefined);

    manager = createAgentManagerV2(agentStore, inbox, tasks, {
      defaultCwd: "/tmp/t",
      resolveTaskRef,
    });
    manager.setSpawnInterceptor((opts) => ({ ...opts, cwd: "/overridden/cwd" }));

    await manager.spawn({ task: "x", role: "worker" });

    expect(resolveTaskRef).toHaveBeenCalledOnce();
    const passed = resolveTaskRef.mock.calls[0][0];
    expect(passed.cwd).toBe("/overridden/cwd");
  });

  it("resolver throwing does not block spawn; falls through to taskResourceId", async () => {
    const resolveTaskRef = vi.fn().mockImplementation(() => {
      throw new Error("resolver exploded");
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    manager = createAgentManagerV2(agentStore, inbox, tasks, {
      defaultCwd: "/tmp/t",
      taskResourceId: "resource-safe",
      resolveTaskRef,
    });

    const result = await manager.spawn({
      task: "x",
      task_id: "safe-node" as unknown as SpawnAgentOptions["task_id"],
      role: "worker",
    });

    expect(warnSpy).toHaveBeenCalled();
    expect(getStoredTaskRef(result.id)).toEqual({
      resource_id: "resource-safe",
      node_id: "safe-node",
    });
    warnSpy.mockRestore();
  });
});
