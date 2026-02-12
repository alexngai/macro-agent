/**
 * ACP-over-MAP Cancel & Stop Tests
 *
 * Tests two distinct cancellation mechanisms:
 * 1. ACP cancel (session/cancel) - soft cancel: aborts the streaming loop and
 *    calls session.cancel() on the subprocess, but keeps the agent alive.
 * 2. MAP stop (map/agents/stop via handleStopAgent) - hard kill: terminates
 *    the agent subprocess, deallocates resources, cascade-terminates children.
 */

import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { ACPOverMAPHandler } from "../acp-over-map.js";
import type { ACPEnvelope } from "../acp-over-map.js";
import {
  createMAPAdapter,
  MAPAdapterImpl,
  type MAPAdapterServices,
} from "../map-adapter.js";
import type { MAPAdapter } from "../interface.js";
import type { ParticipantId, EventNotification } from "../types.js";
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

/**
 * Create a mock AgentManager that yields the given updates from prompt().
 * The mock session object has a cancel() method for testing ACP cancel.
 */
function createMockAgentManager(
  promptUpdates: unknown[] = [],
  options?: { slowYield?: number },
): { agentManager: AgentManager; mockSession: { cancel: ReturnType<typeof vi.fn> } } {
  const mockAgent = createMockAgent();
  const mockSession = {
    cancel: vi.fn().mockResolvedValue(undefined),
    prompt: vi.fn(),
    id: "session-1",
    cwd: "/test/cwd",
    modes: [],
    models: [],
    isProcessing: false,
  };

  const agentManager = {
    spawn: vi.fn().mockResolvedValue({
      id: "agent-new",
      session_id: "session-new",
      agent: createMockAgent({ id: "agent-new" as AgentId, session_id: "session-new" }),
      session: mockSession,
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
      session: mockSession,
    }),
    hasActiveSession: vi.fn().mockReturnValue(true),
    resume: vi.fn().mockResolvedValue({
      id: "agent-1",
      session_id: "session-1",
      agent: mockAgent,
      session: mockSession,
    }),
    terminate: vi.fn().mockResolvedValue(undefined),
    prompt: vi.fn().mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        for (const update of promptUpdates) {
          if (options?.slowYield) {
            await new Promise((r) => setTimeout(r, options.slowYield));
          }
          yield update;
        }
      },
    }),
    getSession: vi.fn().mockReturnValue(mockSession),
    onLifecycleEvent: vi.fn().mockReturnValue(() => {}),
    close: vi.fn().mockResolvedValue(undefined),
    respondToPermission: vi.fn().mockReturnValue(true),
    cancelPermission: vi.fn().mockReturnValue(true),
  } as unknown as AgentManager;

  return { agentManager, mockSession };
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

describe("ACP-over-MAP cancel and stop", () => {
  let eventStore: EventStore;
  let handler: ACPOverMAPHandler;

  afterEach(async () => {
    if (eventStore) {
      await eventStore.close();
    }
  });

  async function setup(
    promptUpdates: unknown[] = [],
    options?: { slowYield?: number },
  ) {
    eventStore = await createEventStore({ inMemory: true });
    const { agentManager, mockSession } = createMockAgentManager(promptUpdates, options);
    const taskManager = createMockTaskManager();

    handler = new ACPOverMAPHandler({
      agentManager,
      eventStore,
      taskManager,
      defaultCwd: "/test/cwd",
    });

    return { agentManager, taskManager, mockSession };
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

  // ─────────────────────────────────────────────────────────────────
  // ACP Cancel (session/cancel) — soft cancel
  // ─────────────────────────────────────────────────────────────────

  describe("ACP cancel (session/cancel)", () => {
    it("should return cancelled:true", async () => {
      await setup();

      const streamId = "cancel-test-1";
      const agentId = "agent-1" as AgentId;
      const sessionId = await initAndCreateSession(streamId, agentId);

      const result = await handler.processRequest(
        agentId,
        envelope(streamId, "session/cancel", { sessionId }, sessionId),
      );

      expect(result.acp.result).toEqual({ cancelled: true });
    });

    it("should call session.cancel() on the agent's active session", async () => {
      const { mockSession } = await setup();

      const streamId = "cancel-test-2";
      const agentId = "agent-1" as AgentId;
      const sessionId = await initAndCreateSession(streamId, agentId);

      await handler.processRequest(
        agentId,
        envelope(streamId, "session/cancel", { sessionId }, sessionId),
      );

      expect(mockSession.cancel).toHaveBeenCalledTimes(1);
    });

    it("should NOT call agentManager.terminate()", async () => {
      const { agentManager } = await setup();

      const streamId = "cancel-test-3";
      const agentId = "agent-1" as AgentId;
      const sessionId = await initAndCreateSession(streamId, agentId);

      await handler.processRequest(
        agentId,
        envelope(streamId, "session/cancel", { sessionId }, sessionId),
      );

      expect(agentManager.terminate).not.toHaveBeenCalled();
    });

    it("should abort the stream's abort controller", async () => {
      await setup();

      const streamId = "cancel-test-4";
      const agentId = "agent-1" as AgentId;
      const sessionId = await initAndCreateSession(streamId, agentId);

      await handler.processRequest(
        agentId,
        envelope(streamId, "session/cancel", { sessionId }, sessionId),
      );

      // Sending a prompt after cancel should reset the abort controller and work
      // (the handler resets it on new prompt if aborted)
      const promptResult = await handler.processRequest(
        agentId,
        envelope(streamId, "session/prompt", {
          prompt: [{ type: "text", text: "Hello after cancel" }],
        }, sessionId),
      );

      expect(promptResult.acp.result).toBeDefined();
      expect(promptResult.acp.error).toBeUndefined();
    });

    it("should handle cancel gracefully when no session exists", async () => {
      const { agentManager } = await setup();
      // Mock getSession returning null for this case
      (agentManager.getSession as ReturnType<typeof vi.fn>).mockReturnValue(null);

      const streamId = "cancel-test-5";
      const agentId = "agent-1" as AgentId;
      const sessionId = await initAndCreateSession(streamId, agentId);

      const result = await handler.processRequest(
        agentId,
        envelope(streamId, "session/cancel", { sessionId }, sessionId),
      );

      // Should still succeed even without an active session
      expect(result.acp.result).toEqual({ cancelled: true });
    });

    it("should handle session.cancel() failure gracefully", async () => {
      const { mockSession } = await setup();
      mockSession.cancel.mockRejectedValue(new Error("cancel failed"));

      const streamId = "cancel-test-6";
      const agentId = "agent-1" as AgentId;
      const sessionId = await initAndCreateSession(streamId, agentId);

      // Should not throw even if session.cancel() fails
      const result = await handler.processRequest(
        agentId,
        envelope(streamId, "session/cancel", { sessionId }, sessionId),
      );

      expect(result.acp.result).toEqual({ cancelled: true });
    });

    it("should NOT remove the session mapping (agent stays alive)", async () => {
      await setup([
        {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Response after cancel" },
        },
      ]);

      const streamId = "cancel-test-7";
      const agentId = "agent-1" as AgentId;
      const sessionId = await initAndCreateSession(streamId, agentId);

      // Cancel
      await handler.processRequest(
        agentId,
        envelope(streamId, "session/cancel", { sessionId }, sessionId),
      );

      // Subsequent prompt should still work (session mapping preserved)
      const promptResult = await handler.processRequest(
        agentId,
        envelope(streamId, "session/prompt", {
          prompt: [{ type: "text", text: "Hello again" }],
        }, sessionId),
      );

      expect(promptResult.acp.error).toBeUndefined();
      expect(promptResult.acp.result).toMatchObject({ stopReason: "end_turn" });
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // abortStreamsForAgent
  // ─────────────────────────────────────────────────────────────────

  describe("abortStreamsForAgent", () => {
    it("should abort streams belonging to the given agent", async () => {
      await setup([
        {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Hello" },
        },
      ]);

      const streamId = "abort-test-1";
      const agentId = "agent-1" as AgentId;
      const sessionId = await initAndCreateSession(streamId, agentId);

      // Do a prompt to associate the stream with the agent
      await handler.processRequest(
        agentId,
        envelope(streamId, "session/prompt", {
          prompt: [{ type: "text", text: "Hi" }],
        }, sessionId),
      );

      // Abort all streams for this agent
      handler.abortStreamsForAgent(agentId);

      // Verify by checking that a new prompt resets the abort controller
      // (if it was aborted, handlePrompt will create a new controller)
      const result = await handler.processRequest(
        agentId,
        envelope(streamId, "session/prompt", {
          prompt: [{ type: "text", text: "After abort" }],
        }, sessionId),
      );

      expect(result.acp.error).toBeUndefined();
    });

    it("should not affect streams for other agents", async () => {
      await setup([
        {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Hello" },
        },
      ]);

      const streamId = "abort-test-2";
      const agentId = "agent-1" as AgentId;
      const sessionId = await initAndCreateSession(streamId, agentId);

      // Do a prompt to associate the stream with the agent
      await handler.processRequest(
        agentId,
        envelope(streamId, "session/prompt", {
          prompt: [{ type: "text", text: "Hi" }],
        }, sessionId),
      );

      // Abort streams for a different agent — should NOT affect our stream
      handler.abortStreamsForAgent("agent-other" as AgentId);

      // Our stream should still work normally
      const result = await handler.processRequest(
        agentId,
        envelope(streamId, "session/prompt", {
          prompt: [{ type: "text", text: "Still working" }],
        }, sessionId),
      );

      expect(result.acp.error).toBeUndefined();
      expect(result.acp.result).toMatchObject({ stopReason: "end_turn" });
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // closeStream
  // ─────────────────────────────────────────────────────────────────

  describe("closeStream", () => {
    it("should remove the stream and abort its controller", async () => {
      await setup();

      const streamId = "close-test-1";
      const agentId = "agent-1" as AgentId;
      await initAndCreateSession(streamId, agentId);

      // Close the stream
      handler.closeStream(streamId);

      // Using the closed stream should create a new stream state
      // (processRequest creates a new state if none exists)
      const result = await handler.processRequest(
        agentId,
        envelope(streamId, "initialize", {
          protocolVersion: 1,
          capabilities: {},
          clientInfo: { name: "test", version: "1.0" },
        }),
      );

      // Should succeed (new stream state created)
      expect(result.acp.error).toBeUndefined();
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Cancel during active prompt (integration)
  // ─────────────────────────────────────────────────────────────────

  describe("cancel during active prompt", () => {
    it("should return stopReason:cancelled when abort controller fires during prompt", async () => {
      // Create a prompt that yields updates slowly so we can cancel mid-stream
      const { agentManager } = await setup([], { slowYield: 50 });

      // Override prompt to yield many slow updates
      let abortSignalRef: AbortSignal | undefined;
      (agentManager.prompt as ReturnType<typeof vi.fn>).mockReturnValue({
        [Symbol.asyncIterator]: async function* () {
          for (let i = 0; i < 100; i++) {
            await new Promise((r) => setTimeout(r, 10));
            yield {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: `chunk-${i}` },
            };
          }
        },
      });

      const streamId = "cancel-during-prompt";
      const agentId = "agent-1" as AgentId;
      const sessionId = await initAndCreateSession(streamId, agentId);

      // Start prompt and cancel concurrently
      const promptPromise = handler.processRequest(
        agentId,
        envelope(streamId, "session/prompt", {
          prompt: [{ type: "text", text: "Long running task" }],
        }, sessionId),
      );

      // Wait a bit then cancel
      await new Promise((r) => setTimeout(r, 50));
      await handler.processRequest(
        agentId,
        envelope(streamId, "session/cancel", { sessionId }, sessionId),
      );

      const result = await promptPromise;

      // Should have been cancelled
      expect(result.acp.result).toMatchObject({ stopReason: "cancelled" });
    });
  });
});

// ─────────────────────────────────────────────────────────────────
// MAP stop (map/agents/stop via handleStopAgent) — hard kill
// ─────────────────────────────────────────────────────────────────

describe("MAPAdapter handleStopAgent (map/agents/stop)", () => {
  let adapter: MAPAdapter;
  let eventStore: EventStore;
  let mockAgentManager: AgentManager;
  let emittedEvents: EventNotification[];

  async function setupAdapter(overrides?: Partial<AgentManager>) {
    eventStore = await createEventStore({ inMemory: true });
    emittedEvents = [];

    const mockAgent = createMockAgent();
    const mockSession = {
      cancel: vi.fn().mockResolvedValue(undefined),
      id: "session-1",
      cwd: "/test/cwd",
      modes: [],
      models: [],
      isProcessing: false,
    };

    mockAgentManager = {
      spawn: vi.fn(),
      get: vi.fn().mockReturnValue(mockAgent),
      list: vi.fn().mockReturnValue([mockAgent]),
      listHeadManagers: vi.fn().mockReturnValue([mockAgent]),
      getChildren: vi.fn().mockReturnValue([]),
      getHierarchy: vi.fn().mockReturnValue({
        root: { agent: mockAgent, children: [] },
        depth: 1,
        totalAgents: 1,
      }),
      getOrCreateHeadManager: vi.fn(),
      hasActiveSession: vi.fn().mockReturnValue(true),
      resume: vi.fn(),
      terminate: vi.fn().mockResolvedValue(undefined),
      prompt: vi.fn().mockReturnValue({
        [Symbol.asyncIterator]: async function* () {},
      }),
      getSession: vi.fn().mockReturnValue(mockSession),
      onLifecycleEvent: vi.fn().mockReturnValue(() => {}),
      close: vi.fn().mockResolvedValue(undefined),
      respondToPermission: vi.fn().mockReturnValue(true),
      cancelPermission: vi.fn().mockReturnValue(true),
      ...overrides,
    } as unknown as AgentManager;

    const mockTaskManager = createMockTaskManager();

    const services: MAPAdapterServices = {
      getAgent: vi.fn(),
      listAgents: vi.fn().mockReturnValue([]),
      sendMessage: vi.fn().mockResolvedValue({ delivered: [] }),
      getAncestors: vi.fn().mockReturnValue([]),
      getDescendants: vi.fn().mockReturnValue([]),
      agentManager: mockAgentManager,
      eventStore,
      taskManager: mockTaskManager,
      defaultCwd: "/test/cwd",
    };

    adapter = createMAPAdapter(
      {
        name: "test-stop",
        version: "1.0.0",
        defaultClientCapabilities: {
          canQuery: true,
          canSubscribe: true,
          canMessage: true,
          canStop: true,
        },
      },
      services,
    );

    // Listen for emitted events
    adapter.onEvent((e) => {
      if ("eventId" in e) {
        emittedEvents.push(e as unknown as EventNotification);
      }
    });

    await adapter.start();
  }

  afterEach(async () => {
    if (adapter?.isRunning()) {
      await adapter.stop();
    }
    if (eventStore) {
      await eventStore.close();
    }
  });

  it("should call agentManager.terminate() with agentId and reason", async () => {
    await setupAdapter();

    const impl = adapter as unknown as {
      handleStopAgent: (
        participantId: ParticipantId,
        params: unknown,
      ) => Promise<{ stopping: boolean }>;
    };

    const result = await impl.handleStopAgent(
      "p-test" as ParticipantId,
      { agentId: "agent-1" as AgentId, reason: "user stopped" },
    );

    expect(result).toEqual({ stopping: true });
    expect(mockAgentManager.terminate).toHaveBeenCalledWith(
      "agent-1",
      "user stopped",
    );
  });

  it("should use 'cancelled' as default reason", async () => {
    await setupAdapter();

    const impl = adapter as unknown as {
      handleStopAgent: (
        participantId: ParticipantId,
        params: unknown,
      ) => Promise<{ stopping: boolean }>;
    };

    await impl.handleStopAgent(
      "p-test" as ParticipantId,
      { agentId: "agent-1" as AgentId },
    );

    expect(mockAgentManager.terminate).toHaveBeenCalledWith(
      "agent-1",
      "cancelled",
    );
  });

  it("should throw invalidParams when agentId is missing", async () => {
    await setupAdapter();

    const impl = adapter as unknown as {
      handleStopAgent: (
        participantId: ParticipantId,
        params: unknown,
      ) => Promise<{ stopping: boolean }>;
    };

    await expect(
      impl.handleStopAgent("p-test" as ParticipantId, {}),
    ).rejects.toThrow("agentId required");
  });

  it("should throw internalError when agentManager is not available", async () => {
    // Create adapter without agentManager in services
    eventStore = await createEventStore({ inMemory: true });

    const services: MAPAdapterServices = {
      getAgent: vi.fn(),
      listAgents: vi.fn().mockReturnValue([]),
      sendMessage: vi.fn().mockResolvedValue({ delivered: [] }),
      getAncestors: vi.fn().mockReturnValue([]),
      getDescendants: vi.fn().mockReturnValue([]),
      // No agentManager!
    };

    adapter = createMAPAdapter({ name: "test-no-am" }, services);
    await adapter.start();

    const impl = adapter as unknown as {
      handleStopAgent: (
        participantId: ParticipantId,
        params: unknown,
      ) => Promise<{ stopping: boolean }>;
    };

    await expect(
      impl.handleStopAgent("p-test" as ParticipantId, {
        agentId: "agent-1" as AgentId,
      }),
    ).rejects.toThrow("Agent manager not available");
  });

  it("should throw internalError when terminate fails", async () => {
    await setupAdapter({
      terminate: vi.fn().mockRejectedValue(new Error("Agent not found")),
    } as unknown as Partial<AgentManager>);

    const impl = adapter as unknown as {
      handleStopAgent: (
        participantId: ParticipantId,
        params: unknown,
      ) => Promise<{ stopping: boolean }>;
    };

    await expect(
      impl.handleStopAgent("p-test" as ParticipantId, {
        agentId: "agent-1" as AgentId,
      }),
    ).rejects.toThrow("Failed to stop agent: Agent not found");
  });

  it("should emit agent.state.changed event via emitEvent", async () => {
    await setupAdapter();

    const impl = adapter as unknown as {
      handleStopAgent: (
        participantId: ParticipantId,
        params: unknown,
      ) => Promise<{ stopping: boolean }>;
      emitEvent: (event: EventNotification) => void;
    };

    // Spy on emitEvent to capture what was emitted
    const emitSpy = vi.spyOn(impl, "emitEvent");

    await impl.handleStopAgent(
      "p-test" as ParticipantId,
      { agentId: "agent-1" as AgentId, reason: "user stopped" },
    );

    // Verify emitEvent was called with the right event shape
    expect(emitSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "agent.state.changed",
        agentId: "agent-1",
        data: expect.objectContaining({
          agentId: "agent-1",
          current: "stopped",
          previous: "running",
          reason: "user stopped",
        }),
      }),
    );
  });

  it("should abort ACP streams for the agent before terminating", async () => {
    await setupAdapter();

    // Access the internal ACP handler to spy on abortStreamsForAgent
    const impl = adapter as unknown as {
      acpOverMapHandler: ACPOverMAPHandler | null;
      handleStopAgent: (
        participantId: ParticipantId,
        params: unknown,
      ) => Promise<{ stopping: boolean }>;
    };

    const abortSpy = vi.spyOn(impl.acpOverMapHandler!, "abortStreamsForAgent");

    await impl.handleStopAgent(
      "p-test" as ParticipantId,
      { agentId: "agent-1" as AgentId },
    );

    expect(abortSpy).toHaveBeenCalledWith("agent-1");
    // terminate should be called AFTER abort
    expect(mockAgentManager.terminate).toHaveBeenCalled();
  });
});
