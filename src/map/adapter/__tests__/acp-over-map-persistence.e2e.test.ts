/**
 * ACP-over-MAP History Persistence E2E Test
 *
 * Tests the full lifecycle of history persistence across server restarts:
 * 1. Start server → create session → send prompt (history recorded)
 * 2. Shut down server
 * 3. Restart server (same data directory) → reconnect → load history
 *
 * Uses a real file-backed EventStore to verify data survives restarts.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { ACPOverMAPHandler } from "../acp-over-map.js";
import type { ACPEnvelope } from "../acp-over-map.js";
import { createEventStore, type EventStore } from "../../../store/event-store.js";
import type { AgentManager } from "../../../agent/agent-manager.js";
import type { TaskManager } from "../../../task/task-manager.js";
import type { Agent, Task } from "../../../store/types/index.js";
import type { AgentId } from "../../../store/types/index.js";
import { vi } from "vitest";

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

function createMockAgentManager(promptUpdates: unknown[] = []): AgentManager {
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
// E2E Tests
// ─────────────────────────────────────────────────────────────────

describe("ACP-over-MAP history persistence (E2E with file-backed store)", () => {
  let tmpDir: string;
  const instanceId = "test-persist-instance";
  const agentId = "agent-1" as AgentId;
  const sessionId = "session-1";

  afterEach(() => {
    // Clean up temp directory
    if (tmpDir) {
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  /**
   * Register an agent in the EventStore so loadSession can resolve it.
   */
  function registerAgent(eventStore: EventStore): void {
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
    eventStore.emit({
      type: "lifecycle",
      source: { agent_id: agentId },
      payload: {
        agent_id: agentId,
        action: "started",
      },
    });
  }

  it("should persist history across server restarts", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "acp-persist-"));

    // ════════════════════════════════════════════════════════════════
    // LIFECYCLE 1: Create session, send prompt, record history
    // ════════════════════════════════════════════════════════════════

    let eventStore1 = await createEventStore({
      instanceId,
      baseDir: tmpDir,
    });

    // Register agent in the store
    registerAgent(eventStore1);

    const handler1 = new ACPOverMAPHandler({
      agentManager: createMockAgentManager([
        {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Hello! I'm your assistant. " },
        },
        {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "How can I help you today?" },
        },
        {
          sessionUpdate: "tool_call",
          toolCallId: "tc-1",
          title: "ListFiles",
          status: "completed",
          rawInput: { path: "/src" },
          output: "index.ts\napp.ts",
        },
      ]),
      eventStore: eventStore1,
      taskManager: createMockTaskManager(),
      defaultCwd: "/test/cwd",
    });

    // Initialize stream
    const streamId1 = "lifecycle-1-stream";
    await handler1.processRequest(
      agentId,
      envelope(streamId1, "initialize", {
        protocolVersion: 1,
        capabilities: {},
        clientInfo: { name: "test-tui", version: "1.0" },
      }),
    );

    // Create session
    const newResult = await handler1.processRequest(
      agentId,
      envelope(streamId1, "session/new", {
        cwd: "/test",
        mcpServers: [],
      }),
    );
    const createdSessionId = (newResult.acp.result as { sessionId?: string })?.sessionId;
    expect(createdSessionId).toBe(sessionId);

    // Send a prompt — this should record turns in the EventStore
    const promptResult = await handler1.processRequest(
      agentId,
      envelope(streamId1, "session/prompt", {
        prompt: [{ type: "text", text: "List the files in /src" }],
      }, createdSessionId),
    );
    expect((promptResult.acp.result as { stopReason: string }).stopReason).toBe("end_turn");

    // Verify history exists in lifecycle 1
    const historyCheck = await handler1.processRequest(
      agentId,
      envelope(streamId1, "_macro/getHistory", { sessionId: createdSessionId }),
    );
    const checkTurns = (historyCheck.acp.result as { turns: unknown[] }).turns;
    expect(checkTurns).toHaveLength(2); // user + assistant

    // ════════════════════════════════════════════════════════════════
    // SHUTDOWN: Close the EventStore (simulates server shutdown)
    // ════════════════════════════════════════════════════════════════

    await eventStore1.close();

    // ════════════════════════════════════════════════════════════════
    // LIFECYCLE 2: Restart with same data dir, reconnect, load history
    // ════════════════════════════════════════════════════════════════

    const eventStore2 = await createEventStore({
      instanceId,
      baseDir: tmpDir,
    });

    // Verify agent data survived restart
    const restoredAgent = eventStore2.getAgent(agentId);
    expect(restoredAgent).not.toBeNull();
    expect(restoredAgent?.session_id).toBe(sessionId);

    const handler2 = new ACPOverMAPHandler({
      agentManager: createMockAgentManager(), // Fresh agent manager
      eventStore: eventStore2,
      taskManager: createMockTaskManager(),
      defaultCwd: "/test/cwd",
    });

    // Initialize new stream (simulates TUI restart)
    const streamId2 = "lifecycle-2-stream";
    await handler2.processRequest(
      agentId,
      envelope(streamId2, "initialize", {
        protocolVersion: 1,
        capabilities: {},
        clientInfo: { name: "test-tui-reconnect", version: "1.0" },
      }),
    );

    // Load session with _resolve_ pattern (like the TUI does)
    const loadResult = await handler2.processRequest(
      agentId,
      envelope(streamId2, "session/load", {
        sessionId: "_resolve_",
        cwd: "/test",
        mcpServers: [],
        _meta: { agentId },
      }),
    );

    // Verify loadSession returns the resolved session ID
    const resolvedSessionId = (loadResult.acp.result as { sessionId?: string })?.sessionId;
    expect(resolvedSessionId).toBeDefined();
    expect(resolvedSessionId).toBe(sessionId);
    expect(resolvedSessionId).not.toBe("_resolve_");

    // Load history using the resolved session ID (exactly like the TUI does)
    const historyResult = await handler2.processRequest(
      agentId,
      envelope(streamId2, "_macro/getHistory", { sessionId: resolvedSessionId }),
    );

    // ════════════════════════════════════════════════════════════════
    // VERIFY: History is restored correctly
    // ════════════════════════════════════════════════════════════════

    const turns = (historyResult.acp.result as {
      turns: { role: string; timestamp: number; content: unknown }[];
    }).turns;

    expect(turns).toHaveLength(2);

    // User turn
    expect(turns[0].role).toBe("user");
    expect(turns[0].content).toBe("List the files in /src");

    // Assistant turn — accumulated text + tool call
    expect(turns[1].role).toBe("assistant");
    const assistantContent = turns[1].content as {
      parts: { type: string; text?: string; toolCallId?: string; title?: string; output?: unknown }[];
    };
    expect(assistantContent.parts).toHaveLength(2);
    expect(assistantContent.parts[0]).toEqual({
      type: "text",
      text: "Hello! I'm your assistant. How can I help you today?",
    });
    expect(assistantContent.parts[1]).toMatchObject({
      type: "tool",
      toolCallId: "tc-1",
      title: "ListFiles",
      status: "completed",
      output: "index.ts\napp.ts",
    });

    // Timestamps should be in order (assistant is +1ms from user)
    expect(turns[1].timestamp).toBeGreaterThanOrEqual(turns[0].timestamp);

    await eventStore2.close();
  }, 30000);

  it("should persist multiple prompt rounds across restarts", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "acp-persist-multi-"));

    // ── Lifecycle 1: Two prompts ──
    let eventStore1 = await createEventStore({ instanceId, baseDir: tmpDir });
    registerAgent(eventStore1);

    const agentManager1 = createMockAgentManager([
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "First reply" } },
    ]);

    const handler1 = new ACPOverMAPHandler({
      agentManager: agentManager1,
      eventStore: eventStore1,
      taskManager: createMockTaskManager(),
      defaultCwd: "/test/cwd",
    });

    const stream1 = "multi-stream-1";
    await handler1.processRequest(agentId, envelope(stream1, "initialize", {
      protocolVersion: 1, capabilities: {}, clientInfo: { name: "test", version: "1.0" },
    }));
    await handler1.processRequest(agentId, envelope(stream1, "session/new", {
      cwd: "/test", mcpServers: [],
    }));

    // First prompt
    await handler1.processRequest(agentId, envelope(stream1, "session/prompt", {
      prompt: [{ type: "text", text: "Question 1" }],
    }, sessionId));

    // Second prompt with different response
    vi.mocked(agentManager1.prompt).mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        yield { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Second reply" } };
      },
    } as any);

    await handler1.processRequest(agentId, envelope(stream1, "session/prompt", {
      prompt: [{ type: "text", text: "Question 2" }],
    }, sessionId));

    await eventStore1.close();

    // ── Lifecycle 2: Verify all 4 turns survived ──
    const eventStore2 = await createEventStore({ instanceId, baseDir: tmpDir });

    const handler2 = new ACPOverMAPHandler({
      agentManager: createMockAgentManager(),
      eventStore: eventStore2,
      taskManager: createMockTaskManager(),
      defaultCwd: "/test/cwd",
    });

    const stream2 = "multi-stream-2";
    await handler2.processRequest(agentId, envelope(stream2, "initialize", {
      protocolVersion: 1, capabilities: {}, clientInfo: { name: "test", version: "1.0" },
    }));

    const loadResult = await handler2.processRequest(agentId, envelope(stream2, "session/load", {
      sessionId: "_resolve_", cwd: "/test", mcpServers: [], _meta: { agentId },
    }));
    const resolved = (loadResult.acp.result as { sessionId?: string })?.sessionId;
    expect(resolved).toBe(sessionId);

    const historyResult = await handler2.processRequest(agentId, envelope(stream2, "_macro/getHistory", {
      sessionId: resolved,
    }));

    const turns = (historyResult.acp.result as { turns: { role: string; content: unknown }[] }).turns;
    expect(turns).toHaveLength(4);
    expect(turns[0].role).toBe("user");
    expect(turns[0].content).toBe("Question 1");
    expect(turns[1].role).toBe("assistant");
    expect(turns[2].role).toBe("user");
    expect(turns[2].content).toBe("Question 2");
    expect(turns[3].role).toBe("assistant");

    const reply2 = turns[3].content as { parts: { text: string }[] };
    expect(reply2.parts[0].text).toBe("Second reply");

    await eventStore2.close();
  }, 30000);
});
