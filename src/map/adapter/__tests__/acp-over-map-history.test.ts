/**
 * ACP-over-MAP History Persistence Tests
 *
 * Verifies that prompts sent through the ACP-over-MAP handler
 * correctly record conversation turns in the EventStore, and that
 * _macro/getHistory returns them.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { ACPOverMAPHandler } from "../acp-over-map.js";
import type { ACPEnvelope } from "../acp-over-map.js";
import { createEventStore, type EventStore } from "../../../store/event-store.js";
import type { AgentManager } from "../../../agent/agent-manager.js";
import type { TaskManager } from "../../../task/task-manager.js";
import type { Agent, Task } from "../../../store/types/index.js";
import type { AgentId } from "../../../store/types/index.js";

// ─────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────

function createMockAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent-1" as AgentId,
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

function createMockAgentManager(
  promptUpdates: unknown[] = [],
): AgentManager {
  const mockAgent = createMockAgent();

  return {
    spawn: vi.fn().mockResolvedValue({
      id: "agent-new",
      session_id: "session-new",
      agent: createMockAgent({ id: "agent-new" as AgentId, session_id: "session-new" }),
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

/** Build an ACP envelope for processRequest */
function envelope(
  streamId: string,
  method: string,
  params?: unknown,
  sessionId?: string,
): ACPEnvelope {
  return {
    acp: {
      jsonrpc: "2.0",
      id: `${streamId}-${method}-${Date.now()}`,
      method,
      params,
    },
    acpContext: {
      streamId,
      sessionId,
      direction: "client-to-agent",
    },
  };
}

// ─────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────

describe("ACP-over-MAP history persistence", () => {
  let eventStore: EventStore;
  let handler: ACPOverMAPHandler;

  afterEach(async () => {
    await eventStore.close();
  });

  async function setup(promptUpdates: unknown[] = []) {
    eventStore = await createEventStore({ inMemory: true });
    const agentManager = createMockAgentManager(promptUpdates);
    const taskManager = createMockTaskManager();

    handler = new ACPOverMAPHandler({
      agentManager,
      eventStore,
      taskManager,
      defaultCwd: "/test/cwd",
    });

    return { agentManager, taskManager };
  }

  /** Register an agent in the EventStore so loadSession can resolve it */
  function registerAgent(agentId: string, sessionId: string): void {
    eventStore.emit({
      type: "spawn",
      source: { agent_id: agentId },
      payload: {
        agent_id: agentId,
        session_id: sessionId,
        task: "Test task",
        task_id: "task-1",
        cwd: "/test/cwd",
      },
    });
    // Mark as running
    eventStore.emit({
      type: "lifecycle",
      source: { agent_id: agentId },
      payload: {
        agent_id: agentId,
        action: "started",
      },
    });
  }

  /** Initialize a stream and create a session, returning the sessionId */
  async function initAndCreateSession(
    streamId: string,
    targetAgentId: AgentId = "agent-1" as AgentId,
  ): Promise<string> {
    // Initialize
    await handler.processRequest(
      targetAgentId,
      envelope(streamId, "initialize", {
        protocolVersion: 1,
        capabilities: {},
        clientInfo: { name: "test", version: "1.0" },
      }),
    );

    // Create session
    const sessionResult = await handler.processRequest(
      targetAgentId,
      envelope(streamId, "session/new", {
        cwd: "/test",
        mcpServers: [],
      }),
    );

    const sessionId = (sessionResult.acp.result as { sessionId?: string })?.sessionId;
    if (!sessionId) throw new Error("session/new did not return sessionId");

    // Register the agent in EventStore so loadSession can resolve it later
    registerAgent(targetAgentId, sessionId);

    return sessionId;
  }

  it("should record user and assistant text turns after prompt via ACP-over-MAP", async () => {
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

    const streamId = "test-stream-1";
    const agentId = "agent-1" as AgentId;
    const sessionId = await initAndCreateSession(streamId, agentId);

    // Send prompt
    await handler.processRequest(
      agentId,
      envelope(streamId, "session/prompt", {
        prompt: [{ type: "text", text: "Say hello" }],
      }, sessionId),
    );

    // Get history via extension
    const historyResult = await handler.processRequest(
      agentId,
      envelope(streamId, "_macro/getHistory", { sessionId }),
    );

    const turns = (historyResult.acp.result as { turns: { role: string; content: unknown }[] }).turns;

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
        content: { type: "text", text: "Let me check." },
      },
      {
        sessionUpdate: "tool_call",
        toolCallId: "tc-1",
        title: "Read file",
        status: "completed",
        rawInput: { path: "/test.txt" },
        output: "file contents",
      },
    ]);

    const streamId = "test-stream-2";
    const agentId = "agent-1" as AgentId;
    const sessionId = await initAndCreateSession(streamId, agentId);

    await handler.processRequest(
      agentId,
      envelope(streamId, "session/prompt", {
        prompt: [{ type: "text", text: "Read test.txt" }],
      }, sessionId),
    );

    const historyResult = await handler.processRequest(
      agentId,
      envelope(streamId, "_macro/getHistory", { sessionId }),
    );

    const turns = (historyResult.acp.result as { turns: { role: string; content: unknown }[] }).turns;

    expect(turns).toHaveLength(2);

    const assistantContent = turns[1].content as {
      parts: { type: string; text?: string; toolCallId?: string; title?: string; output?: unknown }[];
    };
    expect(assistantContent.parts).toHaveLength(2);
    expect(assistantContent.parts[0]).toEqual({ type: "text", text: "Let me check." });
    expect(assistantContent.parts[1]).toMatchObject({
      type: "tool",
      toolCallId: "tc-1",
      title: "Read file",
      status: "completed",
      output: "file contents",
    });
  });

  it("should accumulate history across multiple prompts", async () => {
    const { agentManager } = await setup([
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Hello" },
      },
    ]);

    const streamId = "test-stream-3";
    const agentId = "agent-1" as AgentId;
    const sessionId = await initAndCreateSession(streamId, agentId);

    // First prompt
    await handler.processRequest(
      agentId,
      envelope(streamId, "session/prompt", {
        prompt: [{ type: "text", text: "Hi" }],
      }, sessionId),
    );

    // Update mock for second prompt
    (agentManager.prompt as ReturnType<typeof vi.fn>).mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        yield {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Goodbye" },
        };
      },
    } as any);

    // Second prompt
    await handler.processRequest(
      agentId,
      envelope(streamId, "session/prompt", {
        prompt: [{ type: "text", text: "Bye" }],
      }, sessionId),
    );

    const historyResult = await handler.processRequest(
      agentId,
      envelope(streamId, "_macro/getHistory", { sessionId }),
    );

    const turns = (historyResult.acp.result as { turns: { role: string; content: unknown }[] }).turns;

    // 2 prompts × 2 turns = 4 turns total
    expect(turns).toHaveLength(4);
    expect(turns[0].role).toBe("user");
    expect(turns[0].content).toBe("Hi");
    expect(turns[1].role).toBe("assistant");
    expect(turns[2].role).toBe("user");
    expect(turns[2].content).toBe("Bye");
    expect(turns[3].role).toBe("assistant");
  });

  it("should return empty turns for session with no history", async () => {
    await setup();

    const streamId = "test-stream-4";
    const agentId = "agent-1" as AgentId;
    const sessionId = await initAndCreateSession(streamId, agentId);

    const historyResult = await handler.processRequest(
      agentId,
      envelope(streamId, "_macro/getHistory", { sessionId }),
    );

    const turns = (historyResult.acp.result as { turns: unknown[] }).turns;
    expect(turns).toEqual([]);
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

    const streamId = "test-stream-5";
    const agentId = "agent-1" as AgentId;
    const sessionId = await initAndCreateSession(streamId, agentId);

    await handler.processRequest(
      agentId,
      envelope(streamId, "session/prompt", {
        prompt: [{ type: "text", text: "Run tools" }],
      }, sessionId),
    );

    const historyResult = await handler.processRequest(
      agentId,
      envelope(streamId, "_macro/getHistory", { sessionId }),
    );

    const turns = (historyResult.acp.result as { turns: { role: string; content: unknown }[] }).turns;
    const assistantContent = turns[1].content as {
      parts: { type: string; toolCallId?: string }[];
    };

    const toolParts = assistantContent.parts.filter((p) => p.type === "tool");
    expect(toolParts).toHaveLength(1);
    expect(toolParts[0].toolCallId).toBe("tc-done");
  });

  it("should restore history after reconnection via _resolve_ pattern (full TUI flow)", async () => {
    // This test simulates the full TUI reconnection scenario:
    // 1. Stream 1: Create session, send prompt (records turns)
    // 2. Stream 2: Reconnect with _resolve_, loadSession returns sessionId, getHistory returns turns

    const { agentManager } = await setup([
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Hello from agent!" },
      },
    ]);

    const agentId = "agent-1" as AgentId;

    // ── Stream 1: Initial session ──
    const stream1 = "stream-reconnect-1";
    const sessionId = await initAndCreateSession(stream1, agentId);

    // Send a prompt (records turns in EventStore)
    await handler.processRequest(
      agentId,
      envelope(stream1, "session/prompt", {
        prompt: [{ type: "text", text: "Hello agent" }],
      }, sessionId),
    );

    // Verify turns exist
    const check = await handler.processRequest(
      agentId,
      envelope(stream1, "_macro/getHistory", { sessionId }),
    );
    expect((check.acp.result as { turns: unknown[] }).turns).toHaveLength(2);

    // ── Stream 2: Simulates TUI restart / reconnection ──
    const stream2 = "stream-reconnect-2";

    // Initialize the new stream
    await handler.processRequest(
      agentId,
      envelope(stream2, "initialize", {
        protocolVersion: 1,
        capabilities: {},
        clientInfo: { name: "test-reconnect", version: "1.0" },
      }),
    );

    // loadSession with _resolve_ pattern (TUI sends agentId in _meta)
    // The mock agent has session_id: "session-1", so loadSession should resolve it
    const loadResult = await handler.processRequest(
      agentId,
      envelope(stream2, "session/load", {
        sessionId: "_resolve_",
        cwd: "/test",
        mcpServers: [],
        _meta: { agentId },
      }),
    );

    // The loadResult MUST include the resolved sessionId
    const resolvedSessionId = (loadResult.acp.result as { sessionId?: string })?.sessionId;
    expect(resolvedSessionId).toBeDefined();
    expect(resolvedSessionId).toBe(sessionId);
    expect(resolvedSessionId).not.toBe("_resolve_");

    // Now the TUI uses the resolved sessionId to call getHistory
    const historyResult = await handler.processRequest(
      agentId,
      envelope(stream2, "_macro/getHistory", { sessionId: resolvedSessionId }),
    );

    const turns = (historyResult.acp.result as { turns: { role: string; content: unknown }[] }).turns;
    expect(turns).toHaveLength(2);
    expect(turns[0].role).toBe("user");
    expect(turns[0].content).toBe("Hello agent");
    expect(turns[1].role).toBe("assistant");
    const content = turns[1].content as { parts: { type: string; text: string }[] };
    expect(content.parts[0].text).toBe("Hello from agent!");
  });

  it("should return sessionId from loadSession on all code paths", async () => {
    // Verify that loadSession always returns { sessionId } so the TUI
    // never falls back to using agentId for history queries.
    await setup();

    const agentId = "agent-1" as AgentId;
    const streamId = "stream-sessionid-test";

    // Initialize
    await handler.processRequest(
      agentId,
      envelope(streamId, "initialize", {
        protocolVersion: 1,
        capabilities: {},
        clientInfo: { name: "test", version: "1.0" },
      }),
    );

    // Create a session first so the agent exists
    const newResult = await handler.processRequest(
      agentId,
      envelope(streamId, "session/new", {
        cwd: "/test",
        mcpServers: [],
      }),
    );
    const sessionId = (newResult.acp.result as { sessionId?: string })?.sessionId;
    expect(sessionId).toBeDefined();

    // Register the agent in EventStore so loadSession can resolve it
    registerAgent(agentId, sessionId!);

    // Now loadSession on a new stream — should return the sessionId
    const stream2 = "stream-sessionid-test-2";
    await handler.processRequest(
      agentId,
      envelope(stream2, "initialize", {
        protocolVersion: 1,
        capabilities: {},
        clientInfo: { name: "test", version: "1.0" },
      }),
    );

    const loadResult = await handler.processRequest(
      agentId,
      envelope(stream2, "session/load", {
        sessionId: "_resolve_",
        cwd: "/test",
        mcpServers: [],
        _meta: { agentId },
      }),
    );

    const resolved = (loadResult.acp.result as { sessionId?: string })?.sessionId;
    expect(resolved).toBe(sessionId);
  });

  it("should stream notifications back via emitNotification callback", async () => {
    await setup([
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Hello" },
      },
    ]);

    const streamId = "test-stream-6";
    const agentId = "agent-1" as AgentId;
    const sessionId = await initAndCreateSession(streamId, agentId);

    const notifications: ACPEnvelope[] = [];
    const emitNotification = (n: ACPEnvelope) => notifications.push(n);

    await handler.processRequest(
      agentId,
      envelope(streamId, "session/prompt", {
        prompt: [{ type: "text", text: "Say hello" }],
      }, sessionId),
      emitNotification,
    );

    // Should have at least the session update notification
    const sessionUpdates = notifications.filter(
      (n) => n.acp.method === "session/update",
    );
    expect(sessionUpdates.length).toBeGreaterThan(0);

    // AND history should still be recorded
    const historyResult = await handler.processRequest(
      agentId,
      envelope(streamId, "_macro/getHistory", { sessionId }),
    );

    const turns = (historyResult.acp.result as { turns: unknown[] }).turns;
    expect(turns).toHaveLength(2);
  });

  it("should resolve history via agentId when sessionId is different (restart scenario)", async () => {
    // This test simulates the scenario where:
    // 1. Session is created, prompt is sent (history recorded under sessionId)
    // 2. Server restarts, resume() fails, TUI creates a NEW session
    // 3. TUI calls _macro/getHistory with the NEW sessionId + agentId
    // 4. Server uses agentId to resolve the OLD session and return its history

    await setup([
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "I remember you!" },
      },
    ]);

    const agentId = "agent-1" as AgentId;
    const streamId = "stream-agentid-lookup";
    const originalSessionId = await initAndCreateSession(streamId, agentId);

    // Send a prompt (records turns under originalSessionId)
    await handler.processRequest(
      agentId,
      envelope(streamId, "session/prompt", {
        prompt: [{ type: "text", text: "Remember me" }],
      }, originalSessionId),
    );

    // Verify turns exist under original session
    const check = await handler.processRequest(
      agentId,
      envelope(streamId, "_macro/getHistory", { sessionId: originalSessionId }),
    );
    expect((check.acp.result as { turns: unknown[] }).turns).toHaveLength(2);

    // Simulate calling getHistory with a DIFFERENT sessionId + agentId
    // (as happens when resume fails and TUI creates a new session).
    // agentId takes priority — resolves to the original session with history.
    const newSessionId = "completely-different-session-id";
    const historyResult = await handler.processRequest(
      agentId,
      envelope(streamId, "_macro/getHistory", {
        sessionId: newSessionId,
        agentId,
      }),
    );

    // agentId resolves to the OLD session, so we should get history
    const turns = (historyResult.acp.result as { turns: { role: string; content: unknown }[] }).turns;
    expect(turns).toHaveLength(2);
    expect(turns[0].role).toBe("user");
    expect(turns[0].content).toBe("Remember me");
    expect(turns[1].role).toBe("assistant");
    const content = turns[1].content as { parts: { text: string }[] };
    expect(content.parts[0].text).toBe("I remember you!");

    // Without agentId, only sessionId is used — new session has no turns
    const historyNoAgent = await handler.processRequest(
      agentId,
      envelope(streamId, "_macro/getHistory", {
        sessionId: newSessionId,
      }),
    );
    const turnsNoAgent = (historyNoAgent.acp.result as { turns: unknown[] }).turns;
    expect(turnsNoAgent).toHaveLength(0);
  });
});
