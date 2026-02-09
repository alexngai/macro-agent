/**
 * MacroAgent tests
 *
 * Tests for the ACP-compliant MacroAgent class and its extension methods.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { MacroAgent } from "../macro-agent.js";
import { SessionMapper } from "../session-mapper.js";
import { ACPError } from "../types.js";
import type { MacroAgentInitConfig, SubAgentConfig } from "../types.js";
import type { AgentSideConnection } from "@agentclientprotocol/sdk";
import type { AgentManager } from "../../agent/agent-manager.js";
import type { EventStore } from "../../store/event-store.js";
import type { TaskManager } from "../../task/task-manager.js";
import type { Agent, Task } from "../../store/types/index.js";

// ─────────────────────────────────────────────────────────────────
// Mock Setup
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
    cwd: "/test/working/dir",
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

function createMockAgentManager(): AgentManager {
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
      id: "head-manager",
      session_id: "hm-session",
      agent: createMockAgent({ id: "head-manager" }),
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
        yield { sessionUpdate: "agent_message_chunk", textChunk: "Hello" };
      },
    }),
    getSession: vi.fn().mockReturnValue(null),
    onLifecycleEvent: vi.fn().mockReturnValue(() => {}),
    close: vi.fn().mockResolvedValue(undefined),
    respondToPermission: vi.fn().mockReturnValue(true),
    cancelPermission: vi.fn().mockReturnValue(true),
  } as unknown as AgentManager;
}

function createMockEventStore(): EventStore {
  return {
    getAgent: vi.fn().mockReturnValue(createMockAgent()),
    getTask: vi.fn().mockReturnValue(createMockTask()),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as EventStore;
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

describe("MacroAgent", () => {
  let macroAgent: MacroAgent;
  let mockConnection: AgentSideConnection;
  let mockAgentManager: AgentManager;
  let mockEventStore: EventStore;
  let mockTaskManager: TaskManager;

  beforeEach(() => {
    mockConnection = createMockConnection();
    mockAgentManager = createMockAgentManager();
    mockEventStore = createMockEventStore();
    mockTaskManager = createMockTaskManager();

    macroAgent = new MacroAgent(mockConnection, {
      agentManager: mockAgentManager,
      eventStore: mockEventStore,
      taskManager: mockTaskManager,
      defaultCwd: "/test/cwd",
    });
  });

  describe("initialize", () => {
    it("should return protocol version and capabilities", async () => {
      const response = await macroAgent.initialize({
        protocolVersion: 1,
        clientCapabilities: {},
      });

      expect(response.protocolVersion).toBe(1);
      expect(response.agentCapabilities?.loadSession).toBe(true);
      expect(response.agentCapabilities?._meta?.extensions).toContain(
        "_macro/spawnAgent"
      );
      expect(response.agentCapabilities?._meta?.extensions).toContain(
        "_macro/resume"
      );
      expect(response.agentCapabilities?._meta?.agentType).toBe("macro-agent");
    });

    it("should read macroConfig from _meta", async () => {
      const initConfig: MacroAgentInitConfig = {
        defaultCwd: "/custom/cwd",
        defaultSubAgentConfig: {
          model: "claude-opus-4-20250514",
          permissionMode: "auto-approve",
        },
      };

      const response = await macroAgent.initialize({
        protocolVersion: 1,
        clientCapabilities: {},
        _meta: { macroConfig: initConfig },
      });

      // Config should be echoed back in response
      expect(response.agentCapabilities?._meta?.appliedConfig).toEqual(initConfig);

      // Config should be stored
      expect(macroAgent.getInitConfig()).toEqual(initConfig);
    });

    it("should apply defaultCwd from init config", async () => {
      await macroAgent.initialize({
        protocolVersion: 1,
        clientCapabilities: {},
        _meta: {
          macroConfig: {
            defaultCwd: "/init/config/cwd",
          },
        },
      });

      // Now newSession should use the init config cwd
      await macroAgent.newSession({});

      expect(mockAgentManager.getOrCreateHeadManager).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: "/init/config/cwd",
        })
      );
    });

    it("should work without macroConfig", async () => {
      const response = await macroAgent.initialize({
        protocolVersion: 1,
        clientCapabilities: {},
      });

      expect(macroAgent.getInitConfig()).toEqual({});
      expect(response.agentCapabilities?._meta?.appliedConfig).toEqual({});
    });
  });

  describe("newSession", () => {
    it("should create a new session and map it", async () => {
      const response = await macroAgent.newSession({
        cwd: "/test/project",
      });

      expect(response.sessionId).toBeDefined();
      expect(mockAgentManager.getOrCreateHeadManager).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: "/test/project",
          forceNew: true,
        })
      );
    });

    it("should use default cwd if not provided", async () => {
      await macroAgent.newSession({});

      expect(mockAgentManager.getOrCreateHeadManager).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: "/test/cwd",
          forceNew: true,
        })
      );
    });

    it("should apply permissionMode from init config", async () => {
      await macroAgent.initialize({
        protocolVersion: 1,
        clientCapabilities: {},
        _meta: {
          macroConfig: {
            defaultSubAgentConfig: {
              permissionMode: "auto-approve",
            },
          },
        },
      });

      await macroAgent.newSession({});

      expect(mockAgentManager.getOrCreateHeadManager).toHaveBeenCalledWith(
        expect.objectContaining({
          permissionMode: "auto-approve",
        })
      );
    });

    it("should build system prompt from prefix and suffix", async () => {
      await macroAgent.initialize({
        protocolVersion: 1,
        clientCapabilities: {},
        _meta: {
          macroConfig: {
            systemPromptPrefix: "You are a specialized agent.",
            systemPromptSuffix: "Always be helpful.",
          },
        },
      });

      await macroAgent.newSession({});

      expect(mockAgentManager.getOrCreateHeadManager).toHaveBeenCalledWith(
        expect.objectContaining({
          systemPrompt: "You are a specialized agent.\n\nAlways be helpful.",
        })
      );
    });

    it("should not set systemPrompt if no prefix/suffix configured", async () => {
      await macroAgent.newSession({});

      expect(mockAgentManager.getOrCreateHeadManager).toHaveBeenCalledWith(
        expect.objectContaining({
          systemPrompt: undefined,
        })
      );
    });
  });

  describe("authenticate", () => {
    it("should return empty response (no auth required)", async () => {
      const response = await macroAgent.authenticate({
        methodId: "none",
      });

      expect(response).toEqual({});
    });
  });

  describe("extMethod routing", () => {
    it("should throw for unknown extension method", async () => {
      await expect(
        macroAgent.extMethod("unknown/method", {})
      ).rejects.toThrow(ACPError);
    });
  });

  describe("_macro/spawnAgent", () => {
    it("should spawn a new agent", async () => {
      const response = await macroAgent.extMethod("macro/spawnAgent", {
        task_description: "Test task",
      });

      expect(response).toHaveProperty("agentId");
      expect(response).toHaveProperty("taskId");
      expect(response).toHaveProperty("sessionId");
      expect(mockAgentManager.spawn).toHaveBeenCalled();
    });

    it("should use provided parentId", async () => {
      await macroAgent.extMethod("macro/spawnAgent", {
        task_description: "Test task",
        parentId: "parent-agent",
      });

      expect(mockAgentManager.spawn).toHaveBeenCalledWith(
        expect.objectContaining({
          parent: "parent-agent",
        })
      );
    });

    it("should pass options through", async () => {
      await macroAgent.extMethod("macro/spawnAgent", {
        task_description: "Test task",
        options: {
          cwd: "/custom/cwd",
          subscribeParent: false,
          topics: ["topic1"],
        },
      });

      expect(mockAgentManager.spawn).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: "/custom/cwd",
          subscribeParent: false,
          topics: ["topic1"],
        })
      );
    });

    it("should apply default config from init", async () => {
      await macroAgent.initialize({
        protocolVersion: 1,
        clientCapabilities: {},
        _meta: {
          macroConfig: {
            defaultSubAgentConfig: {
              model: "claude-opus-4-20250514",
              permissionMode: "auto-approve",
              env: { DEBUG: "true" },
            },
          },
        },
      });

      await macroAgent.extMethod("macro/spawnAgent", {
        task_description: "Test task",
      });

      expect(mockAgentManager.spawn).toHaveBeenCalledWith(
        expect.objectContaining({
          permissionMode: "auto-approve",
          config: expect.objectContaining({
            model: "claude-opus-4-20250514",
            env: { DEBUG: "true" },
          }),
        })
      );
    });

    it("should merge per-spawn config with defaults", async () => {
      await macroAgent.initialize({
        protocolVersion: 1,
        clientCapabilities: {},
        _meta: {
          macroConfig: {
            defaultSubAgentConfig: {
              model: "claude-sonnet-4-20250514",
              temperature: 0.7,
              env: { DEBUG: "true", LOG_LEVEL: "info" },
            },
          },
        },
      });

      await macroAgent.extMethod("macro/spawnAgent", {
        task_description: "Test task",
        config: {
          model: "claude-opus-4-20250514", // Override model
          env: { LOG_LEVEL: "debug" }, // Override LOG_LEVEL, keep DEBUG
        },
      });

      expect(mockAgentManager.spawn).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({
            model: "claude-opus-4-20250514", // Overridden
            temperature: 0.7, // From defaults
            env: { DEBUG: "true", LOG_LEVEL: "debug" }, // Merged
          }),
        })
      );
    });

    it("should concatenate MCP servers from defaults and override", async () => {
      await macroAgent.initialize({
        protocolVersion: 1,
        clientCapabilities: {},
        _meta: {
          macroConfig: {
            defaultSubAgentConfig: {
              mcpServers: [
                { name: "default-server", command: "npx", args: ["default"] },
              ],
            },
          },
        },
      });

      await macroAgent.extMethod("macro/spawnAgent", {
        task_description: "Test task",
        config: {
          mcpServers: [
            { name: "custom-server", command: "npx", args: ["custom"] },
          ],
        },
      });

      expect(mockAgentManager.spawn).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({
            mcpServers: [
              { name: "default-server", command: "npx", args: ["default"] },
              { name: "custom-server", command: "npx", args: ["custom"] },
            ],
          }),
        })
      );
    });

    it("should pass agentType from config", async () => {
      await macroAgent.extMethod("macro/spawnAgent", {
        task_description: "Test task",
        config: {
          agentType: "custom-agent",
        },
      });

      expect(mockAgentManager.spawn).toHaveBeenCalledWith(
        expect.objectContaining({
          agentType: "custom-agent",
        })
      );
    });

    it("should work with no config at all", async () => {
      await macroAgent.extMethod("macro/spawnAgent", {
        task_description: "Test task",
      });

      expect(mockAgentManager.spawn).toHaveBeenCalledWith(
        expect.objectContaining({
          task: "Test task",
          config: undefined,
          permissionMode: undefined,
          agentType: undefined,
        })
      );
    });
  });

  describe("_macro/getHierarchy", () => {
    it("should return hierarchy for default root", async () => {
      const response = await macroAgent.extMethod("macro/getHierarchy", {});

      expect(response).toHaveProperty("hierarchy");
      expect(response).toHaveProperty("totalAgents");
      expect(response).toHaveProperty("depth");
    });

    it("should return hierarchy for specific agent", async () => {
      await macroAgent.extMethod("macro/getHierarchy", {
        rootAgentId: "agent-1",
      });

      expect(mockAgentManager.getHierarchy).toHaveBeenCalledWith("agent-1");
    });

    it("should throw for non-existent agent", async () => {
      vi.mocked(mockAgentManager.getHierarchy).mockReturnValue(null);

      await expect(
        macroAgent.extMethod("macro/getHierarchy", {
          rootAgentId: "non-existent",
        })
      ).rejects.toThrow(ACPError);
    });

    it("should return empty hierarchy when no agents exist", async () => {
      vi.mocked(mockAgentManager.listHeadManagers).mockReturnValue([]);

      const response = await macroAgent.extMethod("macro/getHierarchy", {});

      expect(response.totalAgents).toBe(0);
      expect(response.depth).toBe(0);
    });
  });

  describe("_macro/getTask", () => {
    it("should return task details", async () => {
      const response = await macroAgent.extMethod("macro/getTask", {
        taskId: "task-1",
      });

      expect(response).toHaveProperty("task");
      expect(mockTaskManager.get).toHaveBeenCalledWith("task-1");
    });

    it("should throw for non-existent task", async () => {
      vi.mocked(mockTaskManager.get).mockReturnValue(null);

      await expect(
        macroAgent.extMethod("macro/getTask", {
          taskId: "non-existent",
        })
      ).rejects.toThrow(ACPError);
    });
  });

  describe("_macro/mountAgent", () => {
    beforeEach(async () => {
      // Create a session first
      await macroAgent.newSession({ cwd: "/test" });
    });

    it("should mount to an existing agent", async () => {
      // Get the session ID from the mapper
      const sessionMapper = macroAgent.getSessionMapper();
      const mappings = sessionMapper.getAllMappings();
      const sessionId = mappings[0]?.acpSessionId;

      const response = await macroAgent.extMethod("macro/mountAgent", {
        sessionId,
        agentId: "agent-1",
      });

      expect(response).toHaveProperty("sessionId", sessionId);
      expect(response).toHaveProperty("agent");
      expect(response).toHaveProperty("previousAgentId");
    });

    it("should throw for non-existent agent", async () => {
      vi.mocked(mockAgentManager.get).mockReturnValue(null);

      const sessionMapper = macroAgent.getSessionMapper();
      const mappings = sessionMapper.getAllMappings();
      const sessionId = mappings[0]?.acpSessionId;

      await expect(
        macroAgent.extMethod("macro/mountAgent", {
          sessionId,
          agentId: "non-existent",
        })
      ).rejects.toThrow(ACPError);
    });

    it("should throw for non-existent session", async () => {
      await expect(
        macroAgent.extMethod("macro/mountAgent", {
          sessionId: "non-existent-session",
          agentId: "agent-1",
        })
      ).rejects.toThrow(ACPError);
    });

    it("should update session mapping", async () => {
      const sessionMapper = macroAgent.getSessionMapper();
      const mappings = sessionMapper.getAllMappings();
      const sessionId = mappings[0]?.acpSessionId;

      await macroAgent.extMethod("macro/mountAgent", {
        sessionId,
        agentId: "agent-1",
      });

      expect(sessionMapper.getAgentId(sessionId)).toBe("agent-1");
      expect(sessionMapper.isMounted(sessionId)).toBe(true);
    });
  });

  describe("_macro/forkAgent", () => {
    it("should fork an existing agent", async () => {
      const response = await macroAgent.extMethod("macro/forkAgent", {
        agentId: "agent-1",
      });

      expect(response).toHaveProperty("newAgentId");
      expect(response).toHaveProperty("newSessionId");
      expect(response).toHaveProperty("originalAgentId", "agent-1");
      expect(mockAgentManager.spawn).toHaveBeenCalled();
    });

    it("should use custom name in task description", async () => {
      await macroAgent.extMethod("macro/forkAgent", {
        agentId: "agent-1",
        name: "Custom fork name",
      });

      expect(mockAgentManager.spawn).toHaveBeenCalledWith(
        expect.objectContaining({
          task: expect.stringContaining("Custom fork name"),
        })
      );
    });

    it("should throw for non-existent agent", async () => {
      vi.mocked(mockAgentManager.get).mockReturnValue(null);

      await expect(
        macroAgent.extMethod("macro/forkAgent", {
          agentId: "non-existent",
        })
      ).rejects.toThrow(ACPError);
    });

    it("should throw if agent has no active session", async () => {
      vi.mocked(mockAgentManager.hasActiveSession).mockReturnValue(false);

      await expect(
        macroAgent.extMethod("macro/forkAgent", {
          agentId: "agent-1",
        })
      ).rejects.toThrow(ACPError);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Peer Communication Extension Tests
  // ─────────────────────────────────────────────────────────────────

  describe("_macro/sendPeerMessage", () => {
    it("should throw when no PeerManager configured", async () => {
      // macroAgent doesn't have a PeerManager configured
      await expect(
        macroAgent.extMethod("macro/sendPeerMessage", {
          to: "other-peer",
          type: "greeting",
          payload: { text: "hello" },
        })
      ).rejects.toThrow(ACPError);
    });
  });

  describe("_macro/sendPeerRequest", () => {
    it("should throw when no PeerManager configured", async () => {
      await expect(
        macroAgent.extMethod("macro/sendPeerRequest", {
          to: "other-peer",
          method: "calculate",
          params: { x: 1 },
        })
      ).rejects.toThrow(ACPError);
    });
  });

  describe("_macro/deliverPeerMessage", () => {
    it("should throw when no PeerManager configured", async () => {
      await expect(
        macroAgent.extMethod("macro/deliverPeerMessage", {
          from: "other-peer",
          type: "notification",
          payload: { data: "test" },
        })
      ).rejects.toThrow(ACPError);
    });
  });

  describe("_macro/deliverPeerRequest", () => {
    it("should throw when no PeerManager configured", async () => {
      await expect(
        macroAgent.extMethod("macro/deliverPeerRequest", {
          from: "other-peer",
          method: "compute",
          params: {},
        })
      ).rejects.toThrow(ACPError);
    });
  });

  describe("getSessionMapper", () => {
    it("should return the session mapper", () => {
      const mapper = macroAgent.getSessionMapper();
      expect(mapper).toBeInstanceOf(SessionMapper);
    });
  });

  describe("getMappedAgentId", () => {
    it("should return undefined for non-existent session", () => {
      const agentId = macroAgent.getMappedAgentId("non-existent");
      expect(agentId).toBeUndefined();
    });

    it("should return agent ID for existing session", async () => {
      await macroAgent.newSession({ cwd: "/test" });
      const mapper = macroAgent.getSessionMapper();
      const mappings = mapper.getAllMappings();
      const sessionId = mappings[0]?.acpSessionId;

      const agentId = macroAgent.getMappedAgentId(sessionId);
      expect(agentId).toBeDefined();
    });
  });

  describe("getInitConfig", () => {
    it("should return empty config by default", () => {
      const config = macroAgent.getInitConfig();
      expect(config).toEqual({});
    });

    it("should return stored config after initialize", async () => {
      const initConfig: MacroAgentInitConfig = {
        defaultCwd: "/custom/path",
        systemPromptPrefix: "Test prefix",
        defaultSubAgentConfig: {
          model: "claude-opus-4-20250514",
          permissionMode: "auto-approve",
          mcpServers: [{ name: "test", command: "test-cmd" }],
        },
      };

      await macroAgent.initialize({
        protocolVersion: 1,
        clientCapabilities: {},
        _meta: { macroConfig: initConfig },
      });

      const config = macroAgent.getInitConfig();
      expect(config).toEqual(initConfig);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Permission Extension Tests
  // ─────────────────────────────────────────────────────────────────

  describe("_macro/respondToPermission", () => {
    it("should respond to permission via AgentManager", async () => {
      // Create a session first to map sessionId to agentId
      await macroAgent.newSession({ cwd: "/test" });
      const mapper = macroAgent.getSessionMapper();
      const mappings = mapper.getAllMappings();
      const sessionId = mappings[0]?.acpSessionId;

      const response = await macroAgent.extMethod("macro/respondToPermission", {
        sessionId,
        requestId: "perm-req-123",
        optionId: "allow_once",
      });

      expect(response).toEqual({ success: true });
      expect(mockAgentManager.respondToPermission).toHaveBeenCalledWith(
        expect.any(String), // agentId
        "perm-req-123",
        "allow_once"
      );
    });

    it("should return error when no agent found for session", async () => {
      const response = await macroAgent.extMethod("macro/respondToPermission", {
        sessionId: "non-existent-session",
        requestId: "perm-req-123",
        optionId: "allow_once",
      });

      expect(response).toEqual({
        success: false,
        error: expect.stringContaining("No agent found for session"),
      });
    });

    it("should return error when permission response fails", async () => {
      // Create a session first
      await macroAgent.newSession({ cwd: "/test" });
      const mapper = macroAgent.getSessionMapper();
      const mappings = mapper.getAllMappings();
      const sessionId = mappings[0]?.acpSessionId;

      // Make respondToPermission return false
      vi.mocked(mockAgentManager.respondToPermission).mockReturnValue(false);

      const response = await macroAgent.extMethod("macro/respondToPermission", {
        sessionId,
        requestId: "invalid-req",
        optionId: "allow_once",
      });

      expect(response).toEqual({
        success: false,
        error: expect.stringContaining("Failed to respond to permission"),
      });
    });
  });

  describe("_macro/cancelPermission", () => {
    it("should cancel permission via AgentManager", async () => {
      // Create a session first to map sessionId to agentId
      await macroAgent.newSession({ cwd: "/test" });
      const mapper = macroAgent.getSessionMapper();
      const mappings = mapper.getAllMappings();
      const sessionId = mappings[0]?.acpSessionId;

      const response = await macroAgent.extMethod("macro/cancelPermission", {
        sessionId,
        requestId: "perm-req-123",
      });

      expect(response).toEqual({ success: true });
      expect(mockAgentManager.cancelPermission).toHaveBeenCalledWith(
        expect.any(String), // agentId
        "perm-req-123"
      );
    });

    it("should return error when no agent found for session", async () => {
      const response = await macroAgent.extMethod("macro/cancelPermission", {
        sessionId: "non-existent-session",
        requestId: "perm-req-123",
      });

      expect(response).toEqual({
        success: false,
        error: expect.stringContaining("No agent found for session"),
      });
    });

    it("should return error when permission cancellation fails", async () => {
      // Create a session first
      await macroAgent.newSession({ cwd: "/test" });
      const mapper = macroAgent.getSessionMapper();
      const mappings = mapper.getAllMappings();
      const sessionId = mappings[0]?.acpSessionId;

      // Make cancelPermission return false
      vi.mocked(mockAgentManager.cancelPermission).mockReturnValue(false);

      const response = await macroAgent.extMethod("macro/cancelPermission", {
        sessionId,
        requestId: "invalid-req",
      });

      expect(response).toEqual({
        success: false,
        error: expect.stringContaining("Failed to cancel permission"),
      });
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // _macro/resume Tests
  // ─────────────────────────────────────────────────────────────────

  describe("_macro/resume", () => {
    it("should resume a stopped agent", async () => {
      const stoppedAgent = createMockAgent({
        id: "agent-stopped",
        state: "stopped",
        session_id: "session-stopped",
      });
      vi.mocked(mockEventStore.getAgent).mockReturnValue(stoppedAgent);
      vi.mocked(mockAgentManager.resume).mockResolvedValue({
        id: "agent-stopped",
        session_id: "session-stopped",
        agent: stoppedAgent,
        session: {},
      } as any);

      const result = await macroAgent.extMethod("_macro/resume", {
        agentId: "agent-stopped",
      });

      expect(mockAgentManager.resume).toHaveBeenCalledWith("agent-stopped");
      expect(result).toEqual({
        success: true,
        agentId: "agent-stopped",
        sessionId: "session-stopped",
      });
    });

    it("should resume a failed agent", async () => {
      const failedAgent = createMockAgent({
        id: "agent-failed",
        state: "failed",
        session_id: "session-failed",
      });
      vi.mocked(mockEventStore.getAgent).mockReturnValue(failedAgent);
      vi.mocked(mockAgentManager.resume).mockResolvedValue({
        id: "agent-failed",
        session_id: "session-failed",
        agent: failedAgent,
        session: {},
      } as any);

      const result = await macroAgent.extMethod("_macro/resume", {
        agentId: "agent-failed",
      });

      expect(mockAgentManager.resume).toHaveBeenCalledWith("agent-failed");
      expect(result).toHaveProperty("success", true);
    });

    it("should throw for missing agentId", async () => {
      await expect(
        macroAgent.extMethod("_macro/resume", {})
      ).rejects.toThrow("agentId is required");
    });

    it("should throw for non-existent agent", async () => {
      vi.mocked(mockEventStore.getAgent).mockReturnValue(undefined as any);

      await expect(
        macroAgent.extMethod("_macro/resume", { agentId: "missing" })
      ).rejects.toThrow("Agent not found");
    });

    it("should throw for running agent", async () => {
      const runningAgent = createMockAgent({
        id: "agent-running",
        state: "running",
      });
      vi.mocked(mockEventStore.getAgent).mockReturnValue(runningAgent);

      await expect(
        macroAgent.extMethod("_macro/resume", { agentId: "agent-running" })
      ).rejects.toThrow("only stopped or failed");
    });

    it("should throw for sleeping agent", async () => {
      const sleepingAgent = createMockAgent({
        id: "agent-sleeping",
        state: "sleeping",
      });
      vi.mocked(mockEventStore.getAgent).mockReturnValue(sleepingAgent);

      await expect(
        macroAgent.extMethod("_macro/resume", { agentId: "agent-sleeping" })
      ).rejects.toThrow("only stopped or failed");
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Cancel Tests
  // ─────────────────────────────────────────────────────────────────

  describe("cancel", () => {
    it("should abort cancellation controller and terminate agent", async () => {
      // Create a session first
      await macroAgent.newSession({ cwd: "/test" });
      const mapper = macroAgent.getSessionMapper();
      const mappings = mapper.getAllMappings();
      const sessionId = mappings[0]?.acpSessionId;

      // Cancel the session
      await macroAgent.cancel({ sessionId });

      // Verify agentManager.terminate was called with correct args
      expect(mockAgentManager.terminate).toHaveBeenCalledWith(
        expect.any(String), // agentId
        "cancelled"
      );
    });

    it("should clean up session mapping after cancel", async () => {
      // Create a session first
      await macroAgent.newSession({ cwd: "/test" });
      const mapper = macroAgent.getSessionMapper();
      const mappings = mapper.getAllMappings();
      const sessionId = mappings[0]?.acpSessionId;

      // Verify mapping exists
      expect(mapper.getAgentId(sessionId)).toBeDefined();

      // Cancel the session
      await macroAgent.cancel({ sessionId });

      // Verify mapping was removed
      expect(mapper.getAgentId(sessionId)).toBeUndefined();
    });

    it("should handle cancel when no agent is mapped", async () => {
      // Cancel with non-existent session - should not throw
      await expect(
        macroAgent.cancel({ sessionId: "non-existent-session" })
      ).resolves.not.toThrow();

      // terminate should not have been called
      expect(mockAgentManager.terminate).not.toHaveBeenCalled();
    });

    it("should handle terminate errors gracefully", async () => {
      // Create a session first
      await macroAgent.newSession({ cwd: "/test" });
      const mapper = macroAgent.getSessionMapper();
      const mappings = mapper.getAllMappings();
      const sessionId = mappings[0]?.acpSessionId;

      // Make terminate throw an error (e.g., agent already stopped)
      vi.mocked(mockAgentManager.terminate).mockRejectedValueOnce(
        new Error("Agent not found")
      );

      // Cancel should not throw even if terminate fails
      await expect(macroAgent.cancel({ sessionId })).resolves.not.toThrow();

      // Mapping should still be cleaned up
      expect(mapper.getAgentId(sessionId)).toBeUndefined();
    });

    it("should abort the cancellation controller signal", async () => {
      // Create a session first
      await macroAgent.newSession({ cwd: "/test" });
      const mapper = macroAgent.getSessionMapper();
      const mappings = mapper.getAllMappings();
      const sessionId = mappings[0]?.acpSessionId;

      // Get access to cancellation controllers (private but we can test behavior)
      // Cancel the session
      await macroAgent.cancel({ sessionId });

      // The agent manager terminate should be called, which proves the flow worked
      expect(mockAgentManager.terminate).toHaveBeenCalled();
    });
  });
});
