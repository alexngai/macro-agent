/**
 * History persistence and retrieval tests
 *
 * Tests the _macro/getHistory extension method and the underlying
 * conversation/turn persistence that records prompt interactions.
 *
 * Uses a real in-memory EventStore to verify the full flow:
 *   ensureConversation → recordPromptTurns → handleGetHistory
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { MacroAgent } from "../macro-agent.js";
import { createEventStore, type EventStore } from "../../store/event-store.js";
import type { AgentSideConnection } from "@agentclientprotocol/sdk";
import type { AgentManager } from "../../agent/agent-manager.js";
import type { TaskManager } from "../../task/task-manager.js";
import type { Agent, Task } from "../../store/types/index.js";

// ─────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────

function createMockAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent-1",
    session_id: "session-1",
    state: "running",
    task: "Test task",
    task_id: "task-1",
    parent: null,
    lineage: [],
    config: {},
    cwd: "/test/cwd",
    created_at: Date.now(),
    started_at: Date.now(),
    ...overrides,
  };
}

function createMockTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    description: "Test task",
    status: "in_progress",
    created_by: "agent-1",
    created_at: Date.now(),
    ...overrides,
  };
}

function createMockConnection(): AgentSideConnection {
  return {
    sessionUpdate: vi.fn().mockResolvedValue(undefined),
    requestPermission: vi.fn().mockResolvedValue({ outcome: "allow_once" }),
    closed: Promise.resolve(),
  } as unknown as AgentSideConnection;
}

/**
 * Create a mock AgentManager that yields the given streaming updates
 * from its `prompt()` method.
 */
function createMockAgentManager(
  promptUpdates: unknown[] = []
): AgentManager {
  const mockAgent = createMockAgent();

  return {
    spawn: vi.fn().mockResolvedValue({
      id: "agent-new",
      session_id: "session-new",
      agent: createMockAgent({ id: "agent-new", session_id: "session-new" }),
      session: {},
    }),
    get: vi.fn().mockReturnValue(mockAgent),
    list: vi.fn().mockReturnValue([mockAgent]),
    listHeadManagers: vi.fn().mockReturnValue([mockAgent]),
    getChildren: vi.fn().mockReturnValue([]),
    getHierarchy: vi.fn().mockReturnValue({
      root: { agent: mockAgent, children: [] },
      depth: 1,
      totalAgents: 1,
    }),
    getOrCreateHeadManager: vi.fn().mockResolvedValue({
      id: "agent-1",
      session_id: "session-1",
      agent: mockAgent,
      session: {},
    }),
    hasActiveSession: vi.fn().mockReturnValue(true),
    resume: vi.fn().mockResolvedValue({
      id: "agent-1",
      session_id: "session-1",
      agent: mockAgent,
      session: {},
    }),
    terminate: vi.fn().mockResolvedValue(undefined),
    prompt: vi.fn().mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        for (const update of promptUpdates) {
          yield update;
        }
      },
    }),
    getSession: vi.fn().mockReturnValue(null),
    onLifecycleEvent: vi.fn().mockReturnValue(() => {}),
    close: vi.fn().mockResolvedValue(undefined),
    respondToPermission: vi.fn().mockReturnValue(true),
    cancelPermission: vi.fn().mockReturnValue(true),
  } as unknown as AgentManager;
}

function createMockTaskManager(): TaskManager {
  return {
    get: vi.fn().mockReturnValue(createMockTask()),
    list: vi.fn().mockReturnValue([createMockTask()]),
    create: vi.fn().mockReturnValue(createMockTask()),
  } as unknown as TaskManager;
}

// ─────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────

describe("_macro/getHistory", () => {
  let eventStore: EventStore;
  let macroAgent: MacroAgent;
  let mockConnection: AgentSideConnection;

  afterEach(async () => {
    await eventStore.close();
  });

  /**
   * Helper to set up a MacroAgent with given prompt streaming updates.
   */
  async function setup(promptUpdates: unknown[] = []) {
    eventStore = await createEventStore({ inMemory: true });
    mockConnection = createMockConnection();

    const agentManager = createMockAgentManager(promptUpdates);
    const taskManager = createMockTaskManager();

    macroAgent = new MacroAgent(mockConnection, {
      agentManager,
      eventStore,
      taskManager,
      defaultCwd: "/test/cwd",
    });

    await macroAgent.initialize({
      protocolVersion: 1,
      clientCapabilities: {},
    });

    return { agentManager, taskManager };
  }

  it("should return empty turns for a session with no history", async () => {
    await setup();

    // Create a session so it has a conversation
    await macroAgent.newSession({ cwd: "/test" });
    const sessionId =
      macroAgent.getSessionMapper().getAllMappings()[0]?.acpSessionId;

    const response = await macroAgent.extMethod("_macro/getHistory", {
      sessionId,
    });

    expect(response).toHaveProperty("turns");
    expect((response as { turns: unknown[] }).turns).toEqual([]);
  });

  it("should record and return user + assistant text turns after prompt", async () => {
    await setup([
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Hello " },
      },
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "world!" },
      },
    ]);

    // Create session
    await macroAgent.newSession({ cwd: "/test" });
    const sessionId =
      macroAgent.getSessionMapper().getAllMappings()[0]?.acpSessionId;

    // Send a prompt — this triggers recording
    await macroAgent.prompt({
      sessionId,
      prompt: [{ type: "text", text: "Say hello" }],
    });

    // Retrieve history
    const response = await macroAgent.extMethod("_macro/getHistory", {
      sessionId,
    });

    const turns = (response as { turns: { role: string; content: unknown }[] })
      .turns;

    expect(turns).toHaveLength(2);

    // User turn
    expect(turns[0].role).toBe("user");
    expect(turns[0].content).toBe("Say hello");

    // Assistant turn — accumulated text chunks
    expect(turns[1].role).toBe("assistant");
    const content = turns[1].content as { parts: { type: string; text?: string }[] };
    expect(content.parts[0].type).toBe("text");
    expect(content.parts[0].text).toBe("Hello world!");
  });

  it("should record tool calls in assistant turns", async () => {
    await setup([
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Let me check that." },
      },
      {
        sessionUpdate: "tool_call",
        toolCallId: "tc-1",
        title: "Read file",
        status: "completed",
        rawInput: { path: "/test.txt" },
        output: "file contents here",
      },
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: " Done!" },
      },
    ]);

    await macroAgent.newSession({ cwd: "/test" });
    const sessionId =
      macroAgent.getSessionMapper().getAllMappings()[0]?.acpSessionId;

    await macroAgent.prompt({
      sessionId,
      prompt: [{ type: "text", text: "Read test.txt" }],
    });

    const response = await macroAgent.extMethod("_macro/getHistory", {
      sessionId,
    });

    const turns = (response as { turns: { role: string; content: unknown }[] })
      .turns;

    expect(turns).toHaveLength(2);

    // Assistant turn should have text + tool parts
    const assistantContent = turns[1].content as {
      parts: { type: string; text?: string; toolCallId?: string; title?: string; output?: unknown }[];
    };
    expect(assistantContent.parts).toHaveLength(3);
    expect(assistantContent.parts[0]).toEqual({
      type: "text",
      text: "Let me check that.",
    });
    expect(assistantContent.parts[1]).toMatchObject({
      type: "tool",
      toolCallId: "tc-1",
      title: "Read file",
      status: "completed",
      output: "file contents here",
    });
    expect(assistantContent.parts[2]).toEqual({
      type: "text",
      text: " Done!",
    });
  });

  it("should accumulate history across multiple prompts", async () => {
    // First prompt returns "Hello"
    const { agentManager } = await setup([
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Hello" },
      },
    ]);

    await macroAgent.newSession({ cwd: "/test" });
    const sessionId =
      macroAgent.getSessionMapper().getAllMappings()[0]?.acpSessionId;

    // First prompt
    await macroAgent.prompt({
      sessionId,
      prompt: [{ type: "text", text: "Hi" }],
    });

    // Second prompt — update mock to return different content
    vi.mocked(agentManager.prompt).mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        yield {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Goodbye" },
        };
      },
    } as any);

    await macroAgent.prompt({
      sessionId,
      prompt: [{ type: "text", text: "Bye" }],
    });

    const response = await macroAgent.extMethod("_macro/getHistory", {
      sessionId,
    });

    const turns = (response as { turns: { role: string; content: unknown }[] })
      .turns;

    // 2 prompts × 2 turns each = 4 turns total
    expect(turns).toHaveLength(4);
    expect(turns[0].role).toBe("user");
    expect(turns[0].content).toBe("Hi");
    expect(turns[1].role).toBe("assistant");
    expect(turns[2].role).toBe("user");
    expect(turns[2].content).toBe("Bye");
    expect(turns[3].role).toBe("assistant");
  });

  it("should respect the limit parameter", async () => {
    const { agentManager } = await setup([
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Response 1" },
      },
    ]);

    await macroAgent.newSession({ cwd: "/test" });
    const sessionId =
      macroAgent.getSessionMapper().getAllMappings()[0]?.acpSessionId;

    // Send 3 prompts
    for (let i = 0; i < 3; i++) {
      vi.mocked(agentManager.prompt).mockReturnValue({
        [Symbol.asyncIterator]: async function* () {
          yield {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: `Response ${i + 1}` },
          };
        },
      } as any);

      await macroAgent.prompt({
        sessionId,
        prompt: [{ type: "text", text: `Message ${i + 1}` }],
      });
    }

    // Request only 2 turns
    const response = await macroAgent.extMethod("_macro/getHistory", {
      sessionId,
      limit: 2,
    });

    const turns = (response as { turns: unknown[] }).turns;
    expect(turns).toHaveLength(2);
  });

  it("should not record turns when prompt has no text content", async () => {
    await setup([
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Response" },
      },
    ]);

    await macroAgent.newSession({ cwd: "/test" });
    const sessionId =
      macroAgent.getSessionMapper().getAllMappings()[0]?.acpSessionId;

    // Empty prompt — no text blocks
    await macroAgent.prompt({
      sessionId,
      prompt: [],
    });

    const response = await macroAgent.extMethod("_macro/getHistory", {
      sessionId,
    });

    const turns = (response as { turns: { role: string }[] }).turns;

    // Should only have the assistant turn (no user turn since message was empty)
    expect(turns).toHaveLength(1);
    expect(turns[0].role).toBe("assistant");
  });

  it("should only record completed tool calls, not running ones", async () => {
    await setup([
      {
        sessionUpdate: "tool_call",
        toolCallId: "tc-running",
        title: "Running tool",
        status: "running",
        rawInput: {},
      },
      {
        sessionUpdate: "tool_call",
        toolCallId: "tc-done",
        title: "Done tool",
        status: "completed",
        rawInput: { x: 1 },
        output: "result",
      },
    ]);

    await macroAgent.newSession({ cwd: "/test" });
    const sessionId =
      macroAgent.getSessionMapper().getAllMappings()[0]?.acpSessionId;

    await macroAgent.prompt({
      sessionId,
      prompt: [{ type: "text", text: "Run tools" }],
    });

    const response = await macroAgent.extMethod("_macro/getHistory", {
      sessionId,
    });

    const turns = (response as { turns: { role: string; content: unknown }[] })
      .turns;

    const assistantContent = turns[1].content as {
      parts: { type: string; toolCallId?: string }[];
    };

    // Only the completed tool call should be recorded
    const toolParts = assistantContent.parts.filter((p) => p.type === "tool");
    expect(toolParts).toHaveLength(1);
    expect(toolParts[0].toolCallId).toBe("tc-done");
  });

  it("should return turns ordered by timestamp (ascending)", async () => {
    const { agentManager } = await setup([
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "First" },
      },
    ]);

    await macroAgent.newSession({ cwd: "/test" });
    const sessionId =
      macroAgent.getSessionMapper().getAllMappings()[0]?.acpSessionId;

    await macroAgent.prompt({
      sessionId,
      prompt: [{ type: "text", text: "Q1" }],
    });

    // Small delay to ensure distinct timestamps
    await new Promise((r) => setTimeout(r, 5));

    vi.mocked(agentManager.prompt).mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        yield {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Second" },
        };
      },
    } as any);

    await macroAgent.prompt({
      sessionId,
      prompt: [{ type: "text", text: "Q2" }],
    });

    const response = await macroAgent.extMethod("_macro/getHistory", {
      sessionId,
    });

    const turns = (
      response as { turns: { timestamp: number; content: unknown }[] }
    ).turns;

    // Verify timestamps are in ascending order
    for (let i = 1; i < turns.length; i++) {
      expect(turns[i].timestamp).toBeGreaterThanOrEqual(turns[i - 1].timestamp);
    }
  });

  it("should isolate history between different sessions", async () => {
    await setup([
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Session 1 response" },
      },
    ]);

    // Create first session and prompt
    await macroAgent.newSession({ cwd: "/test" });
    const session1Id =
      macroAgent.getSessionMapper().getAllMappings()[0]?.acpSessionId;

    await macroAgent.prompt({
      sessionId: session1Id,
      prompt: [{ type: "text", text: "Session 1 message" }],
    });

    // Create second session
    await macroAgent.newSession({ cwd: "/test2" });
    const allMappings = macroAgent.getSessionMapper().getAllMappings();
    const session2Id = allMappings.find(
      (m) => m.acpSessionId !== session1Id
    )?.acpSessionId;

    // Session 2 should have no history
    const response = await macroAgent.extMethod("_macro/getHistory", {
      sessionId: session2Id,
    });

    const turns = (response as { turns: unknown[] }).turns;
    expect(turns).toHaveLength(0);

    // Session 1 should still have its history
    const response1 = await macroAgent.extMethod("_macro/getHistory", {
      sessionId: session1Id,
    });
    expect((response1 as { turns: unknown[] }).turns).toHaveLength(2);
  });
});
