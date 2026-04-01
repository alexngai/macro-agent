/**
 * Tests for macro-agent ACP handler.
 *
 * Uses mocked V2 services to verify that ACP methods
 * correctly dispatch to agentManager, inboxAdapter, tasksAdapter.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { createMacroAgent } from "../macro-agent.js";
import type { MacroAgentConfig } from "../macro-agent.js";
import type { AgentSideConnection } from "@agentclientprotocol/sdk";
import type { MacroAgentSystemV2 } from "../../boot-v2.js";
import { ACPError } from "../types.js";

// ─────────────────────────────────────────────────────────────────
// Mock Helpers
// ─────────────────────────────────────────────────────────────────

function createMockSystem(): MacroAgentSystemV2 {
  return {
    agentManager: {
      getOrCreateHeadManager: vi.fn().mockResolvedValue({
        id: "head-1",
        session_id: "acp-session-1",
        agent: { id: "head-1", role: "coordinator", state: "running" },
        session: {},
      }),
      spawn: vi.fn().mockResolvedValue({
        id: "worker-1",
        session_id: "worker-session-1",
        agent: { id: "worker-1", role: "worker", state: "running" },
        session: {},
      }),
      get: vi.fn().mockReturnValue({
        id: "agent-1",
        role: "worker",
        state: "running",
      }),
      prompt: vi.fn().mockReturnValue(
        (async function* () {
          yield {
            sessionUpdate: "agent_message_chunk",
            text: "Hello",
            messageId: "msg-1",
          };
          yield {
            sessionUpdate: "agent_message_chunk",
            text: " World",
            messageId: "msg-1",
          };
        })(),
      ),
      terminate: vi.fn().mockResolvedValue(undefined),
      getHierarchy: vi.fn().mockReturnValue({
        root: {
          agent: { id: "head-1", role: "coordinator" },
          children: [],
        },
        depth: 1,
        totalAgents: 1,
      }),
      forkAgent: vi.fn().mockResolvedValue({
        id: "fork-1",
        session_id: "fork-session-1",
        agent: { id: "fork-1", role: "worker", state: "running" },
      }),
      resume: vi.fn().mockResolvedValue({
        id: "resumed-1",
        session_id: "resumed-session-1",
        agent: { id: "resumed-1", role: "worker", state: "running" },
      }),
      respondToPermission: vi.fn().mockReturnValue(true),
      cancelPermission: vi.fn().mockReturnValue(true),
      setPermissionMode: vi.fn().mockReturnValue(true),
    } as any,
    agentStore: {} as any,
    inboxAdapter: {
      checkInbox: vi.fn().mockResolvedValue([
        { id: "msg-1", content: "Hello", from: "agent-1" },
      ]),
      readThread: vi.fn().mockResolvedValue([
        { id: "msg-1", content: "Thread msg" },
      ]),
    } as any,
    tasksAdapter: {
      getTask: vi.fn().mockResolvedValue({
        id: "task-1",
        title: "Test task",
        status: "open",
      }),
    } as any,
    triggerSystem: {} as any,
    controlServer: {} as any,
    roleRegistry: {} as any,
    controlSocketPath: "/tmp/test.sock",
    shutdown: vi.fn(),
  };
}

function createMockConnection(): AgentSideConnection {
  return {
    sessionUpdate: vi.fn().mockResolvedValue(undefined),
    signal: new AbortController().signal,
  } as any;
}

// ─────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────

describe("createMacroAgent", () => {
  let system: MacroAgentSystemV2;
  let connection: AgentSideConnection;
  let config: MacroAgentConfig;

  beforeEach(() => {
    system = createMockSystem();
    connection = createMockConnection();
    config = { system };
  });

  function createAgent() {
    return createMacroAgent(connection, config);
  }

  // ── initialize ──────────────────────────────────────────────

  describe("initialize", () => {
    it("should return protocol version and agent info", async () => {
      const agent = createAgent();
      const result = await agent.initialize({
        protocolVersion: 1,
      });

      expect(result.protocolVersion).toBe(1);
      expect(result.agentInfo?.name).toBe("macro-agent");
      expect(result.agentCapabilities?.loadSession).toBe(true);
    });
  });

  // ── newSession ──────────────────────────────────────────────

  describe("newSession", () => {
    it("should create head manager and return session ID", async () => {
      const agent = createAgent();
      const result = await agent.newSession({
        cwd: "/tmp/test",
        mcpServers: [],
      });

      expect(result.sessionId).toBe("acp-session-1");
      expect(system.agentManager.getOrCreateHeadManager).toHaveBeenCalledWith({
        cwd: "/tmp/test",
      });
    });
  });

  // ── prompt ──────────────────────────────────────────────────

  describe("prompt", () => {
    it("should stream updates from agentManager.prompt()", async () => {
      const agent = createAgent();

      // Create a session first
      await agent.newSession({ cwd: "/tmp/test", mcpServers: [] });

      const result = await agent.prompt({
        sessionId: "acp-session-1",
        prompt: [{ type: "text", text: "Hello" } as any],
      });

      expect(result.stopReason).toBe("end_turn");
      expect(system.agentManager.prompt).toHaveBeenCalledWith(
        "head-1",
        "Hello",
      );
      // sessionUpdate should be called for each yielded update
      expect(connection.sessionUpdate).toHaveBeenCalledTimes(2);
    });

    it("should throw for unknown session", async () => {
      const agent = createAgent();

      await expect(
        agent.prompt({
          sessionId: "nonexistent",
          prompt: [{ type: "text", text: "Hello" } as any],
        }),
      ).rejects.toThrow();
    });
  });

  // ── cancel ──────────────────────────────────────────────────

  describe("cancel", () => {
    it("should terminate the agent for the session", async () => {
      const agent = createAgent();
      await agent.newSession({ cwd: "/tmp/test", mcpServers: [] });

      await agent.cancel({ sessionId: "acp-session-1" });

      expect(system.agentManager.terminate).toHaveBeenCalledWith(
        "head-1",
        "cancelled",
      );
    });
  });

  // ── extMethod: _macro/spawnAgent ────────────────────────────

  describe("extMethod: _macro/spawnAgent", () => {
    it("should call agentManager.spawn with params", async () => {
      const agent = createAgent();
      const result = await agent.extMethod!("_macro/spawnAgent", {
        task: "Do work",
        role: "worker",
      });

      expect(result.agentId).toBe("worker-1");
      expect(system.agentManager.spawn).toHaveBeenCalled();
    });
  });

  // ── extMethod: _macro/getHierarchy ──────────────────────────

  describe("extMethod: _macro/getHierarchy", () => {
    it("should return agent hierarchy", async () => {
      const agent = createAgent();
      const result = await agent.extMethod!("_macro/getHierarchy", {
        agentId: "head-1",
      });

      expect(result.hierarchy).toBeDefined();
      expect(system.agentManager.getHierarchy).toHaveBeenCalledWith(
        "head-1",
        { depth: undefined },
      );
    });
  });

  // ── extMethod: _macro/mountAgent ────────────────────────────

  describe("extMethod: _macro/mountAgent", () => {
    it("should switch session to a different agent", async () => {
      const agent = createAgent();
      await agent.newSession({ cwd: "/tmp/test", mcpServers: [] });

      const result = await agent.extMethod!("_macro/mountAgent", {
        sessionId: "acp-session-1",
        agentId: "agent-1",
      });

      expect(result.mounted).toBe(true);
      expect(result.agentId).toBe("agent-1");
      expect(result.previousAgentId).toBe("head-1");
    });
  });

  // ── extMethod: _macro/forkAgent ─────────────────────────────

  describe("extMethod: _macro/forkAgent", () => {
    it("should create a forked agent", async () => {
      const agent = createAgent();
      const result = await agent.extMethod!("_macro/forkAgent", {
        sourceAgentId: "head-1",
      });

      expect(result.agentId).toBe("fork-1");
      expect(system.agentManager.forkAgent).toHaveBeenCalledWith("head-1", {
        name: undefined,
        prompt: undefined,
        cwd: undefined,
      });
    });
  });

  // ── extMethod: _macro/getTask ───────────────────────────────

  describe("extMethod: _macro/getTask", () => {
    it("should return task from tasks adapter", async () => {
      const agent = createAgent();
      const result = await agent.extMethod!("_macro/getTask", {
        taskId: "task-1",
      });

      expect(result.task).toEqual({
        id: "task-1",
        title: "Test task",
        status: "open",
      });
    });
  });

  // ── extMethod: peer methods → NO_PEER_MANAGER ──────────────

  describe("extMethod: peer methods", () => {
    it("should throw NO_PEER_MANAGER for stubbed peer methods", async () => {
      const agent = createAgent();

      await expect(
        agent.extMethod!("_macro/listPeers", {}),
      ).rejects.toThrow(ACPError);

      try {
        await agent.extMethod!("_macro/listPeers", {});
      } catch (err) {
        expect((err as ACPError).code).toBe("NO_PEER_MANAGER");
      }
    });
  });

  // ── extMethod: unknown extension ────────────────────────────

  describe("extMethod: unknown extension", () => {
    it("should throw INVALID_EXTENSION for unknown methods", async () => {
      const agent = createAgent();

      await expect(
        agent.extMethod!("_macro/nonexistent", {}),
      ).rejects.toThrow(ACPError);

      try {
        await agent.extMethod!("_macro/nonexistent", {});
      } catch (err) {
        expect((err as ACPError).code).toBe("INVALID_EXTENSION");
      }
    });
  });

  // ── extMethod: _macro/respondToPermission ───────────────────

  describe("extMethod: _macro/respondToPermission", () => {
    it("should call agentManager.respondToPermission", async () => {
      const agent = createAgent();
      const result = await agent.extMethod!("_macro/respondToPermission", {
        agentId: "agent-1",
        requestId: "req-1",
        optionId: "allow_once",
      });

      expect(result.success).toBe(true);
      expect(system.agentManager.respondToPermission).toHaveBeenCalledWith(
        "agent-1",
        "req-1",
        "allow_once",
      );
    });
  });
});
