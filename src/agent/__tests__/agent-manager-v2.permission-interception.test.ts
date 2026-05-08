/**
 * Unit tests for AgentManagerV2's prompt iterator permission overlay
 * interception (Phase 3). Pins the contract that:
 *
 *   - When a `permission_request` session update fires AND a per-agent
 *     overlay is set, the iterator intercepts, evaluates against the
 *     overlay, and answers via `respondToPermission`. The update is
 *     NOT yielded to the consumer.
 *   - When NO overlay is set, the update IS yielded through (chat
 *     surfaces' UI permission dialogs depend on this).
 *   - Overlay errors fail closed (deny).
 *   - Non-permission_request updates pass through unchanged.
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from "vitest";

const createSessionSpy = vi.fn();
let mockSessionPrompt: ((message: string) => AsyncIterable<unknown>) | null =
  null;
const respondToPermissionSpy = vi.fn();

vi.mock("acp-factory", () => ({
  AgentFactory: {
    spawn: vi.fn().mockResolvedValue({
      createSession: (...args: unknown[]) => {
        createSessionSpy(...args);
        return Promise.resolve({
          id: "provider-session-1",
          prompt: vi.fn().mockImplementation(
            (message: string) => mockSessionPrompt?.(message) ?? emptyIterable(),
          ),
          respondToPermission: respondToPermissionSpy,
        });
      },
      close: vi.fn().mockResolvedValue(undefined),
      isRunning: vi.fn().mockReturnValue(true),
    }),
  },
}));

import { createAgentManagerV2 } from "../agent-manager-v2.js";
import { AgentStore } from "../agent-store.js";
import type { AgentManager } from "../agent-manager.js";
import type { InboxAdapter, TasksAdapter } from "../../adapters/types.js";
import {
  setPermissionOverlay,
  clearPermissionOverlay,
} from "../../dispatch/permission-overlay.js";

function emptyIterable<T>(): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]: () => ({
      next: () => Promise.resolve({ done: true, value: undefined as never }),
    }),
  };
}

function fromArray<T>(items: T[]): AsyncIterable<T> {
  let i = 0;
  return {
    [Symbol.asyncIterator]: () => ({
      next: () => {
        if (i < items.length) {
          return Promise.resolve({ done: false, value: items[i++]! });
        }
        return Promise.resolve({ done: true, value: undefined as never });
      },
    }),
  };
}

function permRequest(opts: {
  requestId: string;
  toolTitle: string;
  toolKind?: string;
  rawInput?: unknown;
}): unknown {
  return {
    sessionUpdate: "permission_request",
    requestId: opts.requestId,
    toolCall: {
      toolCallId: "tc-1",
      title: opts.toolTitle,
      kind: opts.toolKind ?? "read",
      status: "pending",
      rawInput: opts.rawInput ?? {},
    },
    options: [
      { kind: "allow_always", optionId: "allow_always" },
      { kind: "allow_once", optionId: "allow" },
      { kind: "reject_once", optionId: "reject" },
    ],
  };
}

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

describe("AgentManagerV2 prompt iterator — permission overlay interception", () => {
  let agentStore: AgentStore;
  let inboxAdapter: InboxAdapter;
  let tasksAdapter: TasksAdapter;
  let manager: AgentManager;

  beforeEach(() => {
    createSessionSpy.mockClear();
    respondToPermissionSpy.mockClear();
    mockSessionPrompt = null;
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

  it("overlay set + deny rule matches → respondToPermission called with reject; update NOT yielded", async () => {
    const spawned = await manager.spawn({ task: "Test", role: "worker" });
    setPermissionOverlay(spawned.id, {
      deny: ["Read(/tmp/secret.txt)"],
    });
    try {
      mockSessionPrompt = () =>
        fromArray([
          permRequest({
            requestId: "req-1",
            toolTitle: "Read /tmp/secret.txt",
            toolKind: "read",
            rawInput: { file_path: "/tmp/secret.txt" },
          }),
        ]);

      const yielded: unknown[] = [];
      for await (const update of manager.prompt(spawned.id, "do it")) {
        yielded.push(update);
      }

      expect(respondToPermissionSpy).toHaveBeenCalledTimes(1);
      expect(respondToPermissionSpy).toHaveBeenCalledWith("req-1", "reject");
      expect(yielded).toHaveLength(0);
    } finally {
      clearPermissionOverlay(spawned.id);
    }
  });

  it("overlay set + no rule matches → respondToPermission called with allow; update NOT yielded", async () => {
    const spawned = await manager.spawn({ task: "Test", role: "worker" });
    setPermissionOverlay(spawned.id, {
      deny: ["Read(/etc/*)"],
    });
    try {
      mockSessionPrompt = () =>
        fromArray([
          permRequest({
            requestId: "req-2",
            toolTitle: "Read /tmp/safe.txt",
            toolKind: "read",
            rawInput: { file_path: "/tmp/safe.txt" },
          }),
        ]);

      const yielded: unknown[] = [];
      for await (const update of manager.prompt(spawned.id, "do it")) {
        yielded.push(update);
      }

      expect(respondToPermissionSpy).toHaveBeenCalledTimes(1);
      expect(respondToPermissionSpy).toHaveBeenCalledWith("req-2", "allow");
      expect(yielded).toHaveLength(0);
    } finally {
      clearPermissionOverlay(spawned.id);
    }
  });

  it("no overlay → permission_request IS yielded to consumer (chat path)", async () => {
    const spawned = await manager.spawn({ task: "Test", role: "worker" });
    // No overlay set on this agent.
    mockSessionPrompt = () =>
      fromArray([
        permRequest({
          requestId: "req-3",
          toolTitle: "Read /tmp/anything.txt",
          toolKind: "read",
          rawInput: { file_path: "/tmp/anything.txt" },
        }),
      ]);

    const yielded: Array<{ sessionUpdate?: string; requestId?: string }> = [];
    for await (const update of manager.prompt(spawned.id, "do it")) {
      yielded.push(update as { sessionUpdate?: string; requestId?: string });
    }

    expect(respondToPermissionSpy).not.toHaveBeenCalled();
    expect(yielded).toHaveLength(1);
    expect(yielded[0]?.sessionUpdate).toBe("permission_request");
    expect(yielded[0]?.requestId).toBe("req-3");
  });

  it("non-permission_request updates always pass through to consumer", async () => {
    const spawned = await manager.spawn({ task: "Test", role: "worker" });
    setPermissionOverlay(spawned.id, { deny: ["Read(/secret)"] });
    try {
      mockSessionPrompt = () =>
        fromArray([
          { sessionUpdate: "agent_message_chunk", text: "hello" },
          { sessionUpdate: "tool_call", title: "Read /tmp/x" },
          { sessionUpdate: "agent_thought_chunk", text: "thinking" },
        ]);

      const yielded: Array<{ sessionUpdate?: string }> = [];
      for await (const update of manager.prompt(spawned.id, "do it")) {
        yielded.push(update as { sessionUpdate?: string });
      }

      expect(respondToPermissionSpy).not.toHaveBeenCalled();
      expect(yielded).toHaveLength(3);
      expect(yielded.map((u) => u.sessionUpdate)).toEqual([
        "agent_message_chunk",
        "tool_call",
        "agent_thought_chunk",
      ]);
    } finally {
      clearPermissionOverlay(spawned.id);
    }
  });

  it("MCP tool — overlay rule matches by canonical mcp__ name", async () => {
    const spawned = await manager.spawn({ task: "Test", role: "worker" });
    setPermissionOverlay(spawned.id, {
      deny: ["mcp__agent-inbox__list_agents"],
    });
    try {
      mockSessionPrompt = () =>
        fromArray([
          permRequest({
            requestId: "req-mcp",
            toolTitle: "mcp__agent-inbox__list_agents",
            toolKind: "other",
            rawInput: {},
          }),
        ]);

      for await (const _ of manager.prompt(spawned.id, "do it")) {
        /* drain */
      }

      expect(respondToPermissionSpy).toHaveBeenCalledWith("req-mcp", "reject");
    } finally {
      clearPermissionOverlay(spawned.id);
    }
  });
});
