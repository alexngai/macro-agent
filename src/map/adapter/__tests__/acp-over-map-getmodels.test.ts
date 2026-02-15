/**
 * ACP-over-MAP _macro/getModels Tests
 *
 * Verifies that the _macro/getModels extension method correctly returns
 * model information from the agent's session via the ACP-over-MAP handler.
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
    plan: [],
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
  sessionOverride?: unknown,
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
      [Symbol.asyncIterator]: async function* () {},
    }),
    getSession: vi.fn().mockReturnValue(sessionOverride ?? null),
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

describe("ACP-over-MAP _macro/getModels", () => {
  let eventStore: EventStore;
  let handler: ACPOverMAPHandler;

  afterEach(async () => {
    await eventStore.close();
  });

  async function setup(sessionOverride?: unknown) {
    eventStore = await createEventStore({ inMemory: true });
    const agentManager = createMockAgentManager(sessionOverride);
    const taskManager = createMockTaskManager();

    handler = new ACPOverMAPHandler({
      agentManager,
      eventStore,
      taskManager,
      defaultCwd: "/test/cwd",
    });

    return { agentManager, taskManager };
  }

  /** Register an agent in the EventStore so session mapper can resolve it */
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
    await handler.processRequest(
      targetAgentId,
      envelope(streamId, "initialize", {
        protocolVersion: 1,
        capabilities: {},
        clientInfo: { name: "test", version: "1.0" },
      }),
    );

    const sessionResult = await handler.processRequest(
      targetAgentId,
      envelope(streamId, "session/new", {
        cwd: "/test",
        mcpServers: [],
      }),
    );

    const sessionId = (sessionResult.acp.result as { sessionId?: string })?.sessionId;
    if (!sessionId) throw new Error("session/new did not return sessionId");

    registerAgent(targetAgentId, sessionId);

    return sessionId;
  }

  it("should return empty models when session is not found", async () => {
    // getSession returns null — no session available
    await setup(null);

    const streamId = "test-stream-1";
    const agentId = "agent-1" as AgentId;
    const sessionId = await initAndCreateSession(streamId, agentId);

    const result = await handler.processRequest(
      agentId,
      envelope(streamId, "_macro/getModels", { sessionId }),
    );

    expect(result.acp.error).toBeUndefined();
    const data = result.acp.result as {
      currentModelId: string | null;
      availableModels: Array<{ modelId: string; name: string }>;
    };
    expect(data.currentModelId).toBeNull();
    expect(data.availableModels).toEqual([]);
  });

  it("should return models from session.models when available", async () => {
    // Mock session with models array (like Claude Code returns)
    const mockSession = {
      id: "acp-session-123",
      models: ["default", "sonnet"],
    };
    await setup(mockSession);

    const streamId = "test-stream-2";
    const agentId = "agent-1" as AgentId;
    const sessionId = await initAndCreateSession(streamId, agentId);

    const result = await handler.processRequest(
      agentId,
      envelope(streamId, "_macro/getModels", { sessionId }),
    );

    expect(result.acp.error).toBeUndefined();
    const data = result.acp.result as {
      currentModelId: string | null;
      availableModels: Array<{ modelId: string; name: string }>;
    };
    expect(data.currentModelId).toBe("default");
    expect(data.availableModels).toEqual([
      { modelId: "default", name: "default" },
      { modelId: "sonnet", name: "sonnet" },
    ]);
  });

  it("should return models from clientHandler when available", async () => {
    // Mock session with clientHandler.getSessionModelInfo
    const mockSession = {
      id: "acp-session-456",
      models: ["fallback-model"],
      clientHandler: {
        getSessionModelInfo: (_id: string) => ({
          currentModelId: "opus",
          availableModels: [
            { modelId: "opus", name: "Claude Opus 4" },
            { modelId: "sonnet", name: "Claude Sonnet 4.5" },
          ],
        }),
      },
    };
    await setup(mockSession);

    const streamId = "test-stream-3";
    const agentId = "agent-1" as AgentId;
    const sessionId = await initAndCreateSession(streamId, agentId);

    const result = await handler.processRequest(
      agentId,
      envelope(streamId, "_macro/getModels", { sessionId }),
    );

    expect(result.acp.error).toBeUndefined();
    const data = result.acp.result as {
      currentModelId: string | null;
      availableModels: Array<{ modelId: string; name: string }>;
    };
    // clientHandler should take priority over session.models
    expect(data.currentModelId).toBe("opus");
    expect(data.availableModels).toEqual([
      { modelId: "opus", name: "Claude Opus 4" },
      { modelId: "sonnet", name: "Claude Sonnet 4.5" },
    ]);
  });

  it("should fall back to session.models when clientHandler returns empty", async () => {
    // clientHandler returns empty, should fall back to session.models
    const mockSession = {
      id: "acp-session-789",
      models: ["haiku"],
      clientHandler: {
        getSessionModelInfo: () => ({
          currentModelId: null,
          availableModels: [],
        }),
      },
    };
    await setup(mockSession);

    const streamId = "test-stream-4";
    const agentId = "agent-1" as AgentId;
    const sessionId = await initAndCreateSession(streamId, agentId);

    const result = await handler.processRequest(
      agentId,
      envelope(streamId, "_macro/getModels", { sessionId }),
    );

    expect(result.acp.error).toBeUndefined();
    const data = result.acp.result as {
      currentModelId: string | null;
      availableModels: Array<{ modelId: string; name: string }>;
    };
    expect(data.currentModelId).toBe("haiku");
    expect(data.availableModels).toEqual([
      { modelId: "haiku", name: "haiku" },
    ]);
  });

  it("should return empty when session has no models and no clientHandler", async () => {
    // Session exists but has no models
    const mockSession = {
      id: "acp-session-empty",
      models: [],
    };
    await setup(mockSession);

    const streamId = "test-stream-5";
    const agentId = "agent-1" as AgentId;
    const sessionId = await initAndCreateSession(streamId, agentId);

    const result = await handler.processRequest(
      agentId,
      envelope(streamId, "_macro/getModels", { sessionId }),
    );

    expect(result.acp.error).toBeUndefined();
    const data = result.acp.result as {
      currentModelId: string | null;
      availableModels: Array<{ modelId: string; name: string }>;
    };
    expect(data.currentModelId).toBeNull();
    expect(data.availableModels).toEqual([]);
  });
});
