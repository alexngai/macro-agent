/**
 * Unit tests for AgentManagerV2's permission + fullAutonomous spawn-config
 * wiring. Pins the contract that `SpawnAgentOptions.permissions` is forwarded
 * to `agentMeta.claudeCode.options.settings.permissions` on the Claude Code
 * session, and that `ask` rules collapse based on `fullAutonomous`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// IMPORTANT: vi.mock must run before agent-manager-v2 imports acp-factory.
//
// We intercept handle.createSession with a spy so each test can read back the
// `agentMeta` argument and assert against it. Re-using a mock fn means the
// first .mock.calls[0] always points to the most recent spawn() call.
const createSessionSpy = vi.fn();

vi.mock("acp-factory", () => ({
  AgentFactory: {
    spawn: vi.fn().mockResolvedValue({
      createSession: (...args: unknown[]) => {
        createSessionSpy(...args);
        return Promise.resolve({
          id: "provider-session-1",
          prompt: vi.fn().mockReturnValue({
            [Symbol.asyncIterator]: () => ({
              next: () => Promise.resolve({ done: true, value: undefined }),
            }),
          }),
          forkWithFlush: vi.fn().mockResolvedValue({ id: "forked-session-1" }),
        });
      },
      loadSession: vi.fn().mockResolvedValue({
        id: "loaded-session-1",
        prompt: vi.fn().mockReturnValue({
          [Symbol.asyncIterator]: () => ({
            next: () => Promise.resolve({ done: true, value: undefined }),
          }),
        }),
      }),
      close: vi.fn().mockResolvedValue(undefined),
      isRunning: vi.fn().mockReturnValue(true),
    }),
  },
}));

import { createAgentManagerV2 } from "../agent-manager-v2.js";
import { AgentStore } from "../agent-store.js";
import type { AgentManager } from "../agent-manager.js";
import type { InboxAdapter, TasksAdapter } from "../../adapters/types.js";

function createMockInboxAdapter(): InboxAdapter {
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

function createMockTasksAdapter(): TasksAdapter {
  return {
    createTask: vi.fn().mockResolvedValue("ot-task-1"),
    assignTask: vi.fn().mockResolvedValue(undefined),
    transitionTask: vi.fn().mockResolvedValue(undefined),
    getTask: vi.fn().mockResolvedValue({ id: "t-1", title: "test", status: "open" }),
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

/**
 * Read back the second argument to handle.createSession from the most recent
 * spawn() call. Returns the `agentMeta` field if present.
 */
function readLastSpawnAgentMeta(): Record<string, unknown> | undefined {
  const calls = createSessionSpy.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  const lastCall = calls[calls.length - 1];
  // createSession(cwd, options)
  const sessionOpts = lastCall[1] as Record<string, unknown> | undefined;
  return sessionOpts?.agentMeta as Record<string, unknown> | undefined;
}

describe("AgentManagerV2 permissions + fullAutonomous spawn config", () => {
  let agentStore: AgentStore;
  let inboxAdapter: InboxAdapter;
  let tasksAdapter: TasksAdapter;
  let manager: AgentManager;

  beforeEach(() => {
    createSessionSpy.mockClear();
    agentStore = new AgentStore(":memory:");
    inboxAdapter = createMockInboxAdapter();
    tasksAdapter = createMockTasksAdapter();
    manager = createAgentManagerV2(agentStore, inboxAdapter, tasksAdapter, {
      defaultCwd: "/tmp/test",
    });
  });

  afterEach(async () => {
    await manager.close();
    agentStore.close();
  });

  it("permissions present + fullAutonomous: true → ask rules collapse into allow", async () => {
    await manager.spawn({
      task: "Test",
      role: "worker",
      permissions: {
        deny: ["Bash(rm -rf:*)"],
        ask: ["Write(*.env)"],
      },
      fullAutonomous: true,
    });

    const agentMeta = readLastSpawnAgentMeta();
    expect(agentMeta).toBeDefined();
    const cc = agentMeta!.claudeCode as {
      options: { settings?: { permissions?: Record<string, string[]> } };
    };
    const perms = cc.options.settings?.permissions;
    expect(perms).toBeDefined();
    expect(perms!.deny).toContain("Bash(rm -rf:*)");
    // fullAutonomous: true → ask collapses into allow
    expect(perms!.allow).toContain("Write(*.env)");
    // ask should NOT also be a literal field
    expect(perms!.ask).toBeUndefined();
  });

  it("permissions present + fullAutonomous: false → ask rules collapse into deny", async () => {
    await manager.spawn({
      task: "Test",
      role: "worker",
      permissions: {
        deny: ["Bash(rm -rf:*)"],
        ask: ["Write(*.env)"],
      },
      fullAutonomous: false,
    });

    const agentMeta = readLastSpawnAgentMeta();
    expect(agentMeta).toBeDefined();
    const cc = agentMeta!.claudeCode as {
      options: { settings?: { permissions?: Record<string, string[]> } };
    };
    const perms = cc.options.settings?.permissions;
    expect(perms).toBeDefined();
    // Both original deny AND collapsed ask end up in deny
    expect(perms!.deny).toContain("Bash(rm -rf:*)");
    expect(perms!.deny).toContain("Write(*.env)");
    expect(perms!.allow).toBeUndefined();
    expect(perms!.ask).toBeUndefined();
  });

  it("no permissions → no agentMeta.claudeCode.options.settings.permissions", async () => {
    await manager.spawn({
      task: "Test",
      role: "worker",
    });

    const agentMeta = readLastSpawnAgentMeta();
    // agentMeta should be entirely absent (no settingSources, no settings)
    if (agentMeta) {
      const cc = agentMeta.claudeCode as
        | { options: { settings?: { permissions?: unknown } } }
        | undefined;
      expect(cc?.options?.settings?.permissions).toBeUndefined();
    }
  });

  it("isolatedSettings: true + permissions → both settingSources=[] AND settings.permissions present", async () => {
    await manager.spawn({
      task: "Test",
      role: "worker",
      isolatedSettings: true,
      permissions: { deny: ["Bash(rm -rf:*)"] },
      fullAutonomous: true,
    });

    const agentMeta = readLastSpawnAgentMeta();
    expect(agentMeta).toBeDefined();
    const cc = agentMeta!.claudeCode as {
      options: {
        settingSources?: unknown[];
        settings?: { permissions?: Record<string, string[]> };
      };
    };
    expect(cc.options.settingSources).toEqual([]);
    expect(cc.options.settings?.permissions?.deny).toContain("Bash(rm -rf:*)");
  });

  it("permissions with all empty arrays → no settings.permissions key written", async () => {
    await manager.spawn({
      task: "Test",
      role: "worker",
      permissions: { allow: [], deny: [], ask: [] },
      fullAutonomous: true,
    });

    const agentMeta = readLastSpawnAgentMeta();
    // The spawn handler always writes a `settings` object when permissions are
    // truthy, but with empty allow/deny it should NOT include the rule keys —
    // i.e. settings.permissions has no `allow` and no `deny`.
    if (agentMeta) {
      const cc = agentMeta.claudeCode as {
        options: { settings?: { permissions?: Record<string, string[]> } };
      };
      const perms = cc.options.settings?.permissions;
      // perms is either undefined or an empty object — both acceptable.
      // Critically: no allow/deny/ask arrays leak through with empty content.
      if (perms) {
        expect(perms.allow).toBeUndefined();
        expect(perms.deny).toBeUndefined();
        expect(perms.ask).toBeUndefined();
      }
    }
  });
});
