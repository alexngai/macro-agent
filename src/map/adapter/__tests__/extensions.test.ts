/**
 * Tests for MAP Adapter Extensions
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  registerTaskExtensions,
  unregisterTaskExtensions,
  registerWakeExtension,
  unregisterWakeExtension,
  registerWorkspaceExtension,
  unregisterWorkspaceExtension,
  registerResumeExtension,
  unregisterResumeExtension,
  registerAgentDetectionExtensions,
  unregisterAgentDetectionExtensions,
  registerAgentLifecycleExtensions,
  unregisterAgentLifecycleExtensions,
  registerMacroExtensions,
  MACRO_EXTENSION_METHODS,
  EXTENSION_CAPABILITIES,
  type TaskExtensionServices,
  type WakeExtensionServices,
  type WorkspaceExtensionServices,
  type ResumeExtensionServices,
  type AgentDetectionExtensionServices,
  type AgentLifecycleExtensionServices,
} from "../extensions/index.js";
import type { MAPAdapter, ExtensionHandler, ExtensionContext } from "../interface.js";
import type { ParticipantCapabilities } from "../types.js";
import type { ExtendedTask, TaskBackend } from "../../../task/backend/types.js";
import type { AgentId, TaskId } from "../../../store/types/index.js";

// =============================================================================
// Mock Setup
// =============================================================================

function createMockAdapter(): MAPAdapter & {
  handlers: Map<string, ExtensionHandler>;
} {
  const handlers = new Map<string, ExtensionHandler>();

  return {
    handlers,
    registerExtension: vi.fn((method: string, handler: ExtensionHandler) => {
      handlers.set(method, handler);
    }),
    unregisterExtension: vi.fn((method: string) => {
      handlers.delete(method);
    }),
    hasExtension: vi.fn((method: string) => handlers.has(method)),
    getExtensions: vi.fn(() => Array.from(handlers.keys())),
    // Stub other MAPAdapter methods
    start: vi.fn(),
    stop: vi.fn(),
    isRunning: vi.fn().mockReturnValue(true),
    acceptConnection: vi.fn(),
    disconnectParticipant: vi.fn(),
    getParticipant: vi.fn(),
    getParticipants: vi.fn().mockReturnValue([]),
    createSubscription: vi.fn(),
    removeSubscription: vi.fn(),
    pauseSubscription: vi.fn(),
    resumeSubscription: vi.fn(),
    getSubscriptions: vi.fn().mockReturnValue([]),
    emitEvent: vi.fn(),
    listAgents: vi.fn().mockReturnValue([]),
    getAgent: vi.fn(),
    listScopes: vi.fn().mockReturnValue([]),
    getScope: vi.fn(),
    sendMessage: vi.fn(),
    onEvent: vi.fn().mockReturnValue(() => {}),
    config: { name: "test", version: "1.0.0" },
  } as unknown as MAPAdapter & { handlers: Map<string, ExtensionHandler> };
}

function createMockContext(capabilities: Partial<ParticipantCapabilities> = {}): ExtensionContext {
  return {
    participantId: "p-test" as any,
    capabilities: {
      canQuery: true,
      canSubscribe: true,
      canMessage: true,
      canManageTasks: true,
      ...capabilities,
    },
    sessionId: "s-test",
  };
}

function createMockTask(overrides: Partial<ExtendedTask> = {}): ExtendedTask {
  return {
    id: "task-1" as TaskId,
    description: "Test task",
    status: "pending",
    created_by: "agent-1" as AgentId,
    created_at: Date.now(),
    ...overrides,
  } as ExtendedTask;
}

// =============================================================================
// Task Extension Tests
// =============================================================================

describe("Task Extensions", () => {
  let adapter: MAPAdapter & { handlers: Map<string, ExtensionHandler> };
  let mockTaskBackend: TaskBackend;
  let mockSendMessage: ReturnType<typeof vi.fn>;
  let services: TaskExtensionServices;

  beforeEach(() => {
    adapter = createMockAdapter();

    mockTaskBackend = {
      list: vi.fn().mockResolvedValue([]),
      get: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue(createMockTask()),
      assign: vi.fn().mockResolvedValue(undefined),
      complete: vi.fn().mockResolvedValue(undefined),
      update: vi.fn(),
      delete: vi.fn(),
      unassign: vi.fn(),
      start: vi.fn(),
      fail: vi.fn(),
      listReady: vi.fn(),
      getChildren: vi.fn(),
      getSubtaskStatus: vi.fn(),
      createSubtask: vi.fn(),
      addBlocker: vi.fn(),
      removeBlocker: vi.fn(),
      getBlockers: vi.fn(),
      getBlocking: vi.fn(),
      getAgentHistory: vi.fn(),
      onTaskChange: vi.fn(),
    } as unknown as TaskBackend;

    mockSendMessage = vi.fn().mockResolvedValue({ delivered: ["agent-1"] });

    services = {
      taskBackend: mockTaskBackend,
      sendMessage: mockSendMessage,
    };
  });

  describe("registration", () => {
    it("registers all task methods", () => {
      registerTaskExtensions(adapter, services);

      expect(adapter.handlers.has("_macro/task/list")).toBe(true);
      expect(adapter.handlers.has("_macro/task/get")).toBe(true);
      expect(adapter.handlers.has("_macro/task/create")).toBe(true);
      expect(adapter.handlers.has("_macro/task/assign")).toBe(true);
      expect(adapter.handlers.has("_macro/task/complete")).toBe(true);
      expect(adapter.handlers.has("_macro/task/send")).toBe(true);
    });

    it("unregisters all task methods", () => {
      registerTaskExtensions(adapter, services);
      unregisterTaskExtensions(adapter);

      expect(adapter.handlers.has("_macro/task/list")).toBe(false);
      expect(adapter.handlers.has("_macro/task/send")).toBe(false);
    });
  });

  describe("_macro/task/list", () => {
    it("lists tasks", async () => {
      const tasks = [createMockTask({ id: "task-1" as TaskId }), createMockTask({ id: "task-2" as TaskId })];
      (mockTaskBackend.list as ReturnType<typeof vi.fn>).mockResolvedValue(tasks);

      registerTaskExtensions(adapter, services);
      const handler = adapter.handlers.get("_macro/task/list")!;

      const result = await handler(createMockContext(), {});

      expect(result).toHaveProperty("tasks");
      expect((result as any).tasks).toHaveLength(2);
    });

    it("applies filters", async () => {
      registerTaskExtensions(adapter, services);
      const handler = adapter.handlers.get("_macro/task/list")!;

      await handler(createMockContext(), {
        filter: { status: "pending", assignedAgent: "agent-1" },
      });

      expect(mockTaskBackend.list).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "pending",
          assigned_agent: "agent-1",
        })
      );
    });
  });

  describe("_macro/task/get", () => {
    it("returns task info", async () => {
      const task = createMockTask();
      (mockTaskBackend.get as ReturnType<typeof vi.fn>).mockResolvedValue(task);

      registerTaskExtensions(adapter, services);
      const handler = adapter.handlers.get("_macro/task/get")!;

      const result = await handler(createMockContext(), { taskId: "task-1" });

      expect(result).toHaveProperty("task");
      expect((result as any).task.id).toBe("task-1");
    });

    it("throws TASK_NOT_FOUND for missing task", async () => {
      (mockTaskBackend.get as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      registerTaskExtensions(adapter, services);
      const handler = adapter.handlers.get("_macro/task/get")!;

      await expect(handler(createMockContext(), { taskId: "missing" })).rejects.toThrow(
        "Task not found"
      );
    });

    it("throws for missing taskId", async () => {
      registerTaskExtensions(adapter, services);
      const handler = adapter.handlers.get("_macro/task/get")!;

      await expect(handler(createMockContext(), {})).rejects.toThrow("taskId is required");
    });
  });

  describe("_macro/task/create", () => {
    it("creates task", async () => {
      registerTaskExtensions(adapter, services);
      const handler = adapter.handlers.get("_macro/task/create")!;

      const result = await handler(createMockContext(), {
        description: "New task",
      });

      expect(mockTaskBackend.create).toHaveBeenCalledWith(
        expect.objectContaining({
          description: "New task",
          created_by: "external:p-test",
        })
      );
      expect(result).toHaveProperty("task");
    });

    it("throws for missing description", async () => {
      registerTaskExtensions(adapter, services);
      const handler = adapter.handlers.get("_macro/task/create")!;

      await expect(handler(createMockContext(), {})).rejects.toThrow(
        "description is required"
      );
    });
  });

  describe("_macro/task/assign", () => {
    it("assigns task to agent", async () => {
      (mockTaskBackend.get as ReturnType<typeof vi.fn>).mockResolvedValue(createMockTask());

      registerTaskExtensions(adapter, services);
      const handler = adapter.handlers.get("_macro/task/assign")!;

      const result = await handler(createMockContext(), {
        taskId: "task-1",
        agentId: "agent-1",
      });

      expect(mockTaskBackend.assign).toHaveBeenCalledWith("task-1", "agent-1", {});
      expect(result).toEqual({ success: true });
    });

    it("throws for missing task", async () => {
      (mockTaskBackend.get as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      registerTaskExtensions(adapter, services);
      const handler = adapter.handlers.get("_macro/task/assign")!;

      await expect(
        handler(createMockContext(), { taskId: "missing", agentId: "agent-1" })
      ).rejects.toThrow("Task not found");
    });
  });

  describe("_macro/task/complete", () => {
    it("completes task", async () => {
      (mockTaskBackend.get as ReturnType<typeof vi.fn>).mockResolvedValue(createMockTask());

      registerTaskExtensions(adapter, services);
      const handler = adapter.handlers.get("_macro/task/complete")!;

      const result = await handler(createMockContext(), {
        taskId: "task-1",
        outputs: { summary: "Done" },
      });

      expect(mockTaskBackend.complete).toHaveBeenCalledWith("task-1", { summary: "Done" });
      expect(result).toEqual({ success: true });
    });
  });

  describe("_macro/task/send", () => {
    it("sends message to task agent", async () => {
      const task = createMockTask({ assigned_agent: "agent-1" as AgentId });
      (mockTaskBackend.get as ReturnType<typeof vi.fn>).mockResolvedValue(task);

      registerTaskExtensions(adapter, services);
      const handler = adapter.handlers.get("_macro/task/send")!;

      const result = await handler(createMockContext(), {
        taskId: "task-1",
        content: "Hello",
      });

      expect(mockSendMessage).toHaveBeenCalledWith(
        "external:p-test",
        { agent: "agent-1" },
        "Hello",
        { priority: undefined }
      );
      expect(result).toHaveProperty("delivered");
      expect(result).toHaveProperty("agentId", "agent-1");
    });

    it("throws for task with no assigned agent", async () => {
      const task = createMockTask({ assigned_agent: undefined });
      (mockTaskBackend.get as ReturnType<typeof vi.fn>).mockResolvedValue(task);

      registerTaskExtensions(adapter, services);
      const handler = adapter.handlers.get("_macro/task/send")!;

      await expect(
        handler(createMockContext(), { taskId: "task-1", content: "Hello" })
      ).rejects.toThrow("has no assigned agent");
    });
  });
});

// =============================================================================
// Wake Extension Tests
// =============================================================================

describe("Wake Extension", () => {
  let adapter: MAPAdapter & { handlers: Map<string, ExtensionHandler> };
  let services: WakeExtensionServices;

  beforeEach(() => {
    adapter = createMockAdapter();

    services = {
      getAgent: vi.fn().mockReturnValue({ id: "agent-1", state: "running" }),
      getSessionInfo: vi.fn().mockReturnValue({
        hasSession: true,
        isPrompting: false,
        supportsInjection: true,
      }),
      prompt: vi.fn().mockResolvedValue(undefined),
      inject: vi.fn().mockResolvedValue(true),
      interrupt: vi.fn().mockResolvedValue(true),
    };
  });

  describe("registration", () => {
    it("registers wake method", () => {
      registerWakeExtension(adapter, services);
      expect(adapter.handlers.has("_macro/wake")).toBe(true);
    });

    it("unregisters wake method", () => {
      registerWakeExtension(adapter, services);
      unregisterWakeExtension(adapter);
      expect(adapter.handlers.has("_macro/wake")).toBe(false);
    });
  });

  describe("_macro/wake", () => {
    it("wakes sleeping agent", async () => {
      registerWakeExtension(adapter, services);
      const handler = adapter.handlers.get("_macro/wake")!;

      const result = await handler(createMockContext(), {
        agentId: "agent-1",
        message: "Wake up!",
      });

      expect(services.prompt).toHaveBeenCalled();
      expect(result).toEqual({
        success: true,
        alreadyActive: false,
        action: "woken",
      });
    });

    it("returns alreadyActive for prompting agent", async () => {
      (services.getSessionInfo as ReturnType<typeof vi.fn>).mockReturnValue({
        hasSession: true,
        isPrompting: true,
        supportsInjection: true,
      });

      registerWakeExtension(adapter, services);
      const handler = adapter.handlers.get("_macro/wake")!;

      const result = await handler(createMockContext(), { agentId: "agent-1" });

      expect(result).toEqual({
        success: true,
        alreadyActive: true,
      });
    });

    it("interrupts for urgent priority", async () => {
      (services.getSessionInfo as ReturnType<typeof vi.fn>).mockReturnValue({
        hasSession: true,
        isPrompting: true,
        supportsInjection: true,
      });

      registerWakeExtension(adapter, services);
      const handler = adapter.handlers.get("_macro/wake")!;

      const result = await handler(createMockContext(), {
        agentId: "agent-1",
        priority: "urgent",
      });

      expect(services.interrupt).toHaveBeenCalled();
      expect(result).toHaveProperty("action", "interrupted");
    });

    it("throws for missing agent", async () => {
      (services.getAgent as ReturnType<typeof vi.fn>).mockReturnValue(undefined);

      registerWakeExtension(adapter, services);
      const handler = adapter.handlers.get("_macro/wake")!;

      await expect(handler(createMockContext(), { agentId: "missing" })).rejects.toThrow(
        "not found"
      );
    });

    it("throws for stopped agent", async () => {
      (services.getAgent as ReturnType<typeof vi.fn>).mockReturnValue({
        id: "agent-1",
        state: "stopped",
      });

      registerWakeExtension(adapter, services);
      const handler = adapter.handlers.get("_macro/wake")!;

      await expect(handler(createMockContext(), { agentId: "agent-1" })).rejects.toThrow(
        "cannot be woken"
      );
    });
  });
});

// =============================================================================
// Workspace Extension Tests
// =============================================================================

describe("Workspace Extension", () => {
  let adapter: MAPAdapter & { handlers: Map<string, ExtensionHandler> };
  let services: WorkspaceExtensionServices;

  beforeEach(() => {
    adapter = createMockAdapter();

    services = {
      getWorkspace: vi.fn().mockReturnValue(null),
      agentExists: vi.fn().mockReturnValue(true),
    };
  });

  describe("registration", () => {
    it("registers workspace method", () => {
      registerWorkspaceExtension(adapter, services);
      expect(adapter.handlers.has("_macro/workspace/info")).toBe(true);
    });

    it("unregisters workspace method", () => {
      registerWorkspaceExtension(adapter, services);
      unregisterWorkspaceExtension(adapter);
      expect(adapter.handlers.has("_macro/workspace/info")).toBe(false);
    });
  });

  describe("_macro/workspace/info", () => {
    it("returns null for agent without workspace", async () => {
      registerWorkspaceExtension(adapter, services);
      const handler = adapter.handlers.get("_macro/workspace/info")!;

      const result = await handler(createMockContext(), { agentId: "agent-1" });

      expect(result).toEqual({ workspace: null });
    });

    it("returns workspace info without path", async () => {
      (services.getWorkspace as ReturnType<typeof vi.fn>).mockReturnValue({
        agentId: "agent-1",
        path: "/secret/path", // Should not be exposed
        branch: "feature/test",
        streamId: "stream-1",
        role: "worker",
        createdAt: 12345,
        taskId: "task-1",
        baseBranch: "main",
      });

      registerWorkspaceExtension(adapter, services);
      const handler = adapter.handlers.get("_macro/workspace/info")!;

      const result = await handler(createMockContext(), { agentId: "agent-1" });

      const workspace = (result as any).workspace;
      expect(workspace).toBeDefined();
      expect(workspace.agentId).toBe("agent-1");
      expect(workspace.branch).toBe("feature/test");
      expect(workspace.role).toBe("worker");
      expect(workspace.taskId).toBe("task-1");
      expect(workspace).not.toHaveProperty("path"); // Path should not be exposed
    });

    it("includes coordinator childCount", async () => {
      const childPaths = new Map<AgentId, string>();
      childPaths.set("child-1" as AgentId, "/path/1");
      childPaths.set("child-2" as AgentId, "/path/2");

      (services.getWorkspace as ReturnType<typeof vi.fn>).mockReturnValue({
        agentId: "agent-1",
        path: "/path",
        branch: "main",
        streamId: "stream-1",
        role: "coordinator",
        createdAt: 12345,
        childWorkspacePaths: childPaths,
      });

      registerWorkspaceExtension(adapter, services);
      const handler = adapter.handlers.get("_macro/workspace/info")!;

      const result = await handler(createMockContext(), { agentId: "agent-1" });

      expect((result as any).workspace.childCount).toBe(2);
    });

    it("throws for missing agent", async () => {
      (services.agentExists as ReturnType<typeof vi.fn>).mockReturnValue(false);

      registerWorkspaceExtension(adapter, services);
      const handler = adapter.handlers.get("_macro/workspace/info")!;

      await expect(handler(createMockContext(), { agentId: "missing" })).rejects.toThrow(
        "not found"
      );
    });
  });
});

// =============================================================================
// Resume Extension Tests
// =============================================================================

describe("Resume Extension", () => {
  let adapter: MAPAdapter & { handlers: Map<string, ExtensionHandler> };
  let services: ResumeExtensionServices;

  beforeEach(() => {
    adapter = createMockAdapter();

    services = {
      getAgent: vi.fn().mockReturnValue({
        id: "agent-1" as AgentId,
        state: "stopped",
        session_id: "session-1",
      }),
      resume: vi.fn().mockResolvedValue({
        id: "agent-1" as AgentId,
        session_id: "session-1",
      }),
    };
  });

  describe("registration", () => {
    it("registers resume method", () => {
      registerResumeExtension(adapter, services);
      expect(adapter.handlers.has("_macro/resume")).toBe(true);
    });

    it("unregisters resume method", () => {
      registerResumeExtension(adapter, services);
      unregisterResumeExtension(adapter);
      expect(adapter.handlers.has("_macro/resume")).toBe(false);
    });
  });

  describe("_macro/resume", () => {
    it("resumes a stopped agent", async () => {
      registerResumeExtension(adapter, services);
      const handler = adapter.handlers.get("_macro/resume")!;

      const result = await handler(createMockContext(), { agentId: "agent-1" });

      expect(services.resume).toHaveBeenCalledWith("agent-1");
      expect(result).toEqual({
        success: true,
        agentId: "agent-1",
        sessionId: "session-1",
      });
    });

    it("resumes a failed agent", async () => {
      (services.getAgent as ReturnType<typeof vi.fn>).mockReturnValue({
        id: "agent-1",
        state: "failed",
        session_id: "session-1",
      });

      registerResumeExtension(adapter, services);
      const handler = adapter.handlers.get("_macro/resume")!;

      const result = await handler(createMockContext(), { agentId: "agent-1" });

      expect(services.resume).toHaveBeenCalledWith("agent-1");
      expect(result).toHaveProperty("success", true);
    });

    it("throws for missing agentId", async () => {
      registerResumeExtension(adapter, services);
      const handler = adapter.handlers.get("_macro/resume")!;

      await expect(handler(createMockContext(), {})).rejects.toThrow("agentId is required");
    });

    it("throws for non-existent agent", async () => {
      (services.getAgent as ReturnType<typeof vi.fn>).mockReturnValue(undefined);

      registerResumeExtension(adapter, services);
      const handler = adapter.handlers.get("_macro/resume")!;

      await expect(
        handler(createMockContext(), { agentId: "missing" })
      ).rejects.toThrow("not found");
    });

    it("throws for running agent", async () => {
      (services.getAgent as ReturnType<typeof vi.fn>).mockReturnValue({
        id: "agent-1",
        state: "running",
      });

      registerResumeExtension(adapter, services);
      const handler = adapter.handlers.get("_macro/resume")!;

      await expect(
        handler(createMockContext(), { agentId: "agent-1" })
      ).rejects.toThrow("only stopped or failed");
    });
  });
});

// =============================================================================
// Agent Detection Extension Tests
// =============================================================================

describe("Agent Detection Extensions", () => {
  let adapter: MAPAdapter & { handlers: Map<string, ExtensionHandler> };
  let services: AgentDetectionExtensionServices;

  const mockDetectionResult = {
    agents: [
      {
        id: "claude-code",
        name: "Claude Code",
        installed: true,
        version: "1.2.3",
        path: "/usr/local/bin/claude",
        definition: {
          id: "claude-code",
          name: "Claude Code",
          description: "Anthropic Claude Code CLI",
          binary: "claude",
          versionArgs: ["--version"],
          headless: { promptFlag: "-p", defaultFlags: ["--output-format", "stream-json"] },
          vendor: "Anthropic",
        },
        detectedAt: 1000,
      },
      {
        id: "codex",
        name: "Codex CLI",
        installed: false,
        definition: {
          id: "codex",
          name: "Codex CLI",
          description: "OpenAI Codex CLI",
          binary: "codex",
          versionArgs: ["--version"],
          headless: { subcommand: "exec", promptFlag: "", defaultFlags: ["--full-auto"] },
          vendor: "OpenAI",
        },
        detectedAt: 1000,
      },
    ],
    scanned: 2,
    durationMs: 150,
  };

  beforeEach(() => {
    adapter = createMockAdapter();

    services = {
      getAvailableAgents: vi.fn().mockResolvedValue(mockDetectionResult),
      isDetecting: vi.fn().mockReturnValue(false),
      getCachedResult: vi.fn().mockReturnValue(null),
    };
  });

  describe("registration", () => {
    it("registers both agent detection methods", () => {
      registerAgentDetectionExtensions(adapter, services);

      expect(adapter.handlers.has("_macro/agents/available")).toBe(true);
      expect(adapter.handlers.has("_macro/agents/refresh")).toBe(true);
    });

    it("unregisters both agent detection methods", () => {
      registerAgentDetectionExtensions(adapter, services);
      unregisterAgentDetectionExtensions(adapter);

      expect(adapter.handlers.has("_macro/agents/available")).toBe(false);
      expect(adapter.handlers.has("_macro/agents/refresh")).toBe(false);
    });
  });

  describe("_macro/agents/available", () => {
    it("returns detected agents when no cache exists", async () => {
      registerAgentDetectionExtensions(adapter, services);
      const handler = adapter.handlers.get("_macro/agents/available")!;

      const result = await handler(createMockContext(), {});

      expect(services.getAvailableAgents).toHaveBeenCalledWith({
        includeNotInstalled: false,
      });
      expect(result).toHaveProperty("agents");
      expect(result).toHaveProperty("scanned", 2);
      expect(result).toHaveProperty("durationMs", 150);
      expect(result).toHaveProperty("cached", false);
    });

    it("filters out not-installed agents by default", async () => {
      registerAgentDetectionExtensions(adapter, services);
      const handler = adapter.handlers.get("_macro/agents/available")!;

      const result = await handler(createMockContext(), {});

      expect(services.getAvailableAgents).toHaveBeenCalledWith({
        includeNotInstalled: false,
      });
    });

    it("includes not-installed agents when requested", async () => {
      registerAgentDetectionExtensions(adapter, services);
      const handler = adapter.handlers.get("_macro/agents/available")!;

      const result = await handler(createMockContext(), {
        includeNotInstalled: true,
      });

      // No cache, so falls through to getAvailableAgents
      expect(services.getAvailableAgents).toHaveBeenCalledWith({
        includeNotInstalled: true,
      });
    });

    it("uses cached results when available", async () => {
      (services.getCachedResult as ReturnType<typeof vi.fn>).mockReturnValue(
        mockDetectionResult
      );

      registerAgentDetectionExtensions(adapter, services);
      const handler = adapter.handlers.get("_macro/agents/available")!;

      const result = await handler(createMockContext(), {});

      // Should use cache, not call getAvailableAgents
      expect(services.getAvailableAgents).not.toHaveBeenCalled();
      expect(result).toHaveProperty("cached", true);
      // Default excludes not-installed, so only 1 agent
      expect((result as any).agents).toHaveLength(1);
      expect((result as any).agents[0].id).toBe("claude-code");
    });

    it("returns all agents from cache when includeNotInstalled is true", async () => {
      (services.getCachedResult as ReturnType<typeof vi.fn>).mockReturnValue(
        mockDetectionResult
      );

      registerAgentDetectionExtensions(adapter, services);
      const handler = adapter.handlers.get("_macro/agents/available")!;

      const result = await handler(createMockContext(), {
        includeNotInstalled: true,
      });

      expect((result as any).agents).toHaveLength(2);
      expect(result).toHaveProperty("cached", true);
    });

    it("strips binary paths from results", async () => {
      registerAgentDetectionExtensions(adapter, services);
      const handler = adapter.handlers.get("_macro/agents/available")!;

      const result = await handler(createMockContext(), {});

      const agents = (result as any).agents;
      for (const agent of agents) {
        expect(agent).not.toHaveProperty("path");
        expect(agent).not.toHaveProperty("definition");
        expect(agent).not.toHaveProperty("detectedAt");
      }
    });

    it("includes vendor and description in results", async () => {
      registerAgentDetectionExtensions(adapter, services);
      const handler = adapter.handlers.get("_macro/agents/available")!;

      const result = await handler(createMockContext(), {});

      const agents = (result as any).agents;
      expect(agents[0]).toHaveProperty("vendor", "Anthropic");
      expect(agents[0]).toHaveProperty("description", "Anthropic Claude Code CLI");
    });

    it("handles empty params", async () => {
      registerAgentDetectionExtensions(adapter, services);
      const handler = adapter.handlers.get("_macro/agents/available")!;

      const result = await handler(createMockContext(), null);

      expect(result).toHaveProperty("agents");
    });
  });

  describe("_macro/agents/refresh", () => {
    it("forces a fresh detection scan", async () => {
      registerAgentDetectionExtensions(adapter, services);
      const handler = adapter.handlers.get("_macro/agents/refresh")!;

      const result = await handler(createMockContext(), {});

      expect(services.getAvailableAgents).toHaveBeenCalledWith({
        refresh: true,
        includeNotInstalled: true,
      });
      expect(result).toHaveProperty("agents");
      expect(result).toHaveProperty("scanned", 2);
      expect(result).toHaveProperty("durationMs", 150);
    });

    it("always returns all agents including not-installed", async () => {
      registerAgentDetectionExtensions(adapter, services);
      const handler = adapter.handlers.get("_macro/agents/refresh")!;

      const result = await handler(createMockContext(), {});

      expect((result as any).agents).toHaveLength(2);
    });

    it("does not include a cached flag", async () => {
      registerAgentDetectionExtensions(adapter, services);
      const handler = adapter.handlers.get("_macro/agents/refresh")!;

      const result = await handler(createMockContext(), {});

      expect(result).not.toHaveProperty("cached");
    });

    it("strips binary paths from results", async () => {
      registerAgentDetectionExtensions(adapter, services);
      const handler = adapter.handlers.get("_macro/agents/refresh")!;

      const result = await handler(createMockContext(), {});

      const agents = (result as any).agents;
      for (const agent of agents) {
        expect(agent).not.toHaveProperty("path");
        expect(agent).not.toHaveProperty("definition");
      }
    });
  });
});

// =============================================================================
// Agent Lifecycle Extension Tests
// =============================================================================

describe("Agent Lifecycle Extensions", () => {
  let adapter: MAPAdapter & { handlers: Map<string, ExtensionHandler> };
  let services: AgentLifecycleExtensionServices;

  beforeEach(() => {
    adapter = createMockAdapter();

    services = {
      getAgent: vi.fn().mockReturnValue({
        id: "agent-1" as AgentId,
        state: "running",
        session_id: "session-1",
        cwd: "/test/cwd",
      }),
      spawn: vi.fn().mockResolvedValue({
        id: "agent-2" as AgentId,
        session_id: "session-2",
      }),
      forkAgent: vi.fn().mockResolvedValue({
        id: "agent-3" as AgentId,
        session_id: "session-3",
        session: { id: "provider-session-3" },
      }),
      prompt: vi.fn().mockReturnValue((async function* () {})()),
      setPermissionMode: vi.fn().mockReturnValue(true),
      getPermissionMode: vi.fn().mockReturnValue("default"),
      respondToPermission: vi.fn().mockReturnValue(true),
      onAgentRegistered: vi.fn(),
      listHeadManagers: vi.fn().mockReturnValue([{ id: "head-1" as AgentId }]),
      defaultCwd: "/default/cwd",
    };
  });

  describe("registration", () => {
    it("registers all agent lifecycle methods", () => {
      registerAgentLifecycleExtensions(adapter, services);

      expect(adapter.handlers.has("_macro/spawnAgent")).toBe(true);
      expect(adapter.handlers.has("_macro/forkAgent")).toBe(true);
      expect(adapter.handlers.has("_macro/setPermissionMode")).toBe(true);
      expect(adapter.handlers.has("_macro/respondToPermission")).toBe(true);
    });

    it("unregisters all agent lifecycle methods", () => {
      registerAgentLifecycleExtensions(adapter, services);
      unregisterAgentLifecycleExtensions(adapter);

      expect(adapter.handlers.has("_macro/spawnAgent")).toBe(false);
      expect(adapter.handlers.has("_macro/forkAgent")).toBe(false);
      expect(adapter.handlers.has("_macro/setPermissionMode")).toBe(false);
      expect(adapter.handlers.has("_macro/respondToPermission")).toBe(false);
    });
  });

  describe("_macro/spawnAgent", () => {
    it("spawns an agent with explicit parentId", async () => {
      registerAgentLifecycleExtensions(adapter, services);
      const handler = adapter.handlers.get("_macro/spawnAgent")!;
      const ctx = createMockContext({ canManageLifecycle: true });

      const result = await handler(ctx, {
        task: "Do something",
        cwd: "/work/dir",
        parentId: "parent-1",
        topics: ["topic-a"],
        config: { key: "value" },
      });

      expect(services.spawn).toHaveBeenCalledWith({
        parent: "parent-1",
        task: "Do something",
        cwd: "/work/dir",
        role: "worker",
        topics: ["topic-a"],
        config: { key: "value" },
      });
      expect(result).toHaveProperty("agentId", "agent-2");
      expect(result).toHaveProperty("sessionId", "session-2");
    });

    it("falls back to head manager when no parentId provided", async () => {
      registerAgentLifecycleExtensions(adapter, services);
      const handler = adapter.handlers.get("_macro/spawnAgent")!;

      await handler(createMockContext({ canManageLifecycle: true }), {
        task: "Do something",
      });

      expect(services.spawn).toHaveBeenCalledWith(
        expect.objectContaining({ parent: "head-1" })
      );
    });

    it("uses defaultCwd when no cwd provided", async () => {
      registerAgentLifecycleExtensions(adapter, services);
      const handler = adapter.handlers.get("_macro/spawnAgent")!;

      await handler(createMockContext({ canManageLifecycle: true }), {
        task: "Do something",
        parentId: "parent-1",
      });

      expect(services.spawn).toHaveBeenCalledWith(
        expect.objectContaining({ cwd: "/default/cwd" })
      );
    });

    it("throws for missing task", async () => {
      registerAgentLifecycleExtensions(adapter, services);
      const handler = adapter.handlers.get("_macro/spawnAgent")!;

      await expect(
        handler(createMockContext({ canManageLifecycle: true }), {})
      ).rejects.toThrow("task is required");
    });

    it("throws when no parent available", async () => {
      (services.listHeadManagers as ReturnType<typeof vi.fn>).mockReturnValue([]);

      registerAgentLifecycleExtensions(adapter, services);
      const handler = adapter.handlers.get("_macro/spawnAgent")!;

      await expect(
        handler(createMockContext({ canManageLifecycle: true }), {
          task: "Do something",
        })
      ).rejects.toThrow("No parent agent available");
    });

    it("notifies onAgentRegistered after spawn", async () => {
      registerAgentLifecycleExtensions(adapter, services);
      const handler = adapter.handlers.get("_macro/spawnAgent")!;

      await handler(createMockContext({ canManageLifecycle: true }), {
        task: "Do something",
        parentId: "parent-1",
      });

      expect(services.onAgentRegistered).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "agent-2",
          role: "worker",
          parent: "parent-1",
        })
      );
    });
  });

  describe("_macro/forkAgent", () => {
    it("forks an agent", async () => {
      registerAgentLifecycleExtensions(adapter, services);
      const handler = adapter.handlers.get("_macro/forkAgent")!;

      const result = await handler(createMockContext({ canManageLifecycle: true }), {
        agentId: "agent-1",
        name: "forked-agent",
        cwd: "/fork/dir",
      });

      expect(services.forkAgent).toHaveBeenCalledWith("agent-1", {
        name: "forked-agent",
        prompt: undefined,
        cwd: "/fork/dir",
      });
      expect(result).toHaveProperty("newAgentId", "agent-3");
      expect(result).toHaveProperty("newSessionId", "session-3");
      expect(result).toHaveProperty("originalAgentId", "agent-1");
      expect(result).toHaveProperty("providerSessionId", "provider-session-3");
    });

    it("uses source agent cwd as fallback", async () => {
      registerAgentLifecycleExtensions(adapter, services);
      const handler = adapter.handlers.get("_macro/forkAgent")!;

      await handler(createMockContext({ canManageLifecycle: true }), {
        agentId: "agent-1",
      });

      expect(services.forkAgent).toHaveBeenCalledWith("agent-1", {
        name: undefined,
        prompt: undefined,
        cwd: "/test/cwd",
      });
    });

    it("uses defaultCwd when source agent has no cwd", async () => {
      (services.getAgent as ReturnType<typeof vi.fn>).mockReturnValue({
        id: "agent-1" as AgentId,
        state: "running",
        cwd: null,
      });

      registerAgentLifecycleExtensions(adapter, services);
      const handler = adapter.handlers.get("_macro/forkAgent")!;

      await handler(createMockContext({ canManageLifecycle: true }), {
        agentId: "agent-1",
      });

      expect(services.forkAgent).toHaveBeenCalledWith("agent-1",
        expect.objectContaining({ cwd: "/default/cwd" })
      );
    });

    it("throws for missing agentId", async () => {
      registerAgentLifecycleExtensions(adapter, services);
      const handler = adapter.handlers.get("_macro/forkAgent")!;

      await expect(
        handler(createMockContext({ canManageLifecycle: true }), {})
      ).rejects.toThrow("agentId is required");
    });

    it("throws for non-existent agent", async () => {
      (services.getAgent as ReturnType<typeof vi.fn>).mockReturnValue(null);

      registerAgentLifecycleExtensions(adapter, services);
      const handler = adapter.handlers.get("_macro/forkAgent")!;

      await expect(
        handler(createMockContext({ canManageLifecycle: true }), { agentId: "missing" })
      ).rejects.toThrow("not found");
    });

    it("fires prompt after fork when prompt is provided", async () => {
      registerAgentLifecycleExtensions(adapter, services);
      const handler = adapter.handlers.get("_macro/forkAgent")!;

      await handler(createMockContext({ canManageLifecycle: true }), {
        agentId: "agent-1",
        prompt: "Start working",
      });

      // prompt is fire-and-forget but should have been called
      expect(services.prompt).toHaveBeenCalledWith("agent-3", "Start working");
    });

    it("notifies onAgentRegistered after fork", async () => {
      registerAgentLifecycleExtensions(adapter, services);
      const handler = adapter.handlers.get("_macro/forkAgent")!;

      await handler(createMockContext({ canManageLifecycle: true }), {
        agentId: "agent-1",
        name: "forked",
      });

      expect(services.onAgentRegistered).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "agent-3",
          name: "forked",
          parent: "agent-1",
        })
      );
    });
  });

  describe("_macro/setPermissionMode", () => {
    it("sets permission mode successfully", async () => {
      registerAgentLifecycleExtensions(adapter, services);
      const handler = adapter.handlers.get("_macro/setPermissionMode")!;

      const result = await handler(createMockContext({ canManageLifecycle: true }), {
        agentId: "agent-1",
        permissionMode: "trust",
      });

      expect(services.setPermissionMode).toHaveBeenCalledWith("agent-1", "trust");
      expect(result).toEqual({
        success: true,
        agentId: "agent-1",
        previousMode: "default",
        newMode: "trust",
      });
    });

    it("returns error when no active session", async () => {
      (services.setPermissionMode as ReturnType<typeof vi.fn>).mockReturnValue(false);

      registerAgentLifecycleExtensions(adapter, services);
      const handler = adapter.handlers.get("_macro/setPermissionMode")!;

      const result = await handler(createMockContext({ canManageLifecycle: true }), {
        agentId: "agent-1",
        permissionMode: "trust",
      });

      expect(result).toEqual({
        success: false,
        error: "No active session found for agent agent-1",
      });
    });

    it("throws for missing agentId", async () => {
      registerAgentLifecycleExtensions(adapter, services);
      const handler = adapter.handlers.get("_macro/setPermissionMode")!;

      await expect(
        handler(createMockContext({ canManageLifecycle: true }), { permissionMode: "trust" })
      ).rejects.toThrow("agentId and permissionMode are required");
    });

    it("throws for missing permissionMode", async () => {
      registerAgentLifecycleExtensions(adapter, services);
      const handler = adapter.handlers.get("_macro/setPermissionMode")!;

      await expect(
        handler(createMockContext({ canManageLifecycle: true }), { agentId: "agent-1" })
      ).rejects.toThrow("agentId and permissionMode are required");
    });
  });

  describe("_macro/respondToPermission", () => {
    it("responds to permission request successfully", async () => {
      registerAgentLifecycleExtensions(adapter, services);
      const handler = adapter.handlers.get("_macro/respondToPermission")!;

      const result = await handler(createMockContext({ canManageLifecycle: true }), {
        agentId: "agent-1",
        requestId: "req-1",
        optionId: "allow",
      });

      expect(services.respondToPermission).toHaveBeenCalledWith("agent-1", "req-1", "allow");
      expect(result).toEqual({ success: true });
    });

    it("returns failure when respondToPermission returns false", async () => {
      (services.respondToPermission as ReturnType<typeof vi.fn>).mockReturnValue(false);

      registerAgentLifecycleExtensions(adapter, services);
      const handler = adapter.handlers.get("_macro/respondToPermission")!;

      const result = await handler(createMockContext({ canManageLifecycle: true }), {
        agentId: "agent-1",
        requestId: "req-1",
        optionId: "deny",
      });

      expect(result).toEqual({ success: false });
    });

    it("throws for missing agentId", async () => {
      registerAgentLifecycleExtensions(adapter, services);
      const handler = adapter.handlers.get("_macro/respondToPermission")!;

      await expect(
        handler(createMockContext({ canManageLifecycle: true }), {
          requestId: "req-1",
          optionId: "allow",
        })
      ).rejects.toThrow("agentId, requestId, and optionId are required");
    });

    it("throws for missing requestId", async () => {
      registerAgentLifecycleExtensions(adapter, services);
      const handler = adapter.handlers.get("_macro/respondToPermission")!;

      await expect(
        handler(createMockContext({ canManageLifecycle: true }), {
          agentId: "agent-1",
          optionId: "allow",
        })
      ).rejects.toThrow("agentId, requestId, and optionId are required");
    });

    it("throws for missing optionId", async () => {
      registerAgentLifecycleExtensions(adapter, services);
      const handler = adapter.handlers.get("_macro/respondToPermission")!;

      await expect(
        handler(createMockContext({ canManageLifecycle: true }), {
          agentId: "agent-1",
          requestId: "req-1",
        })
      ).rejects.toThrow("agentId, requestId, and optionId are required");
    });
  });
});

// =============================================================================
// Combined Registration Tests
// =============================================================================

describe("registerMacroExtensions", () => {
  it("registers only provided services", () => {
    const adapter = createMockAdapter();

    registerMacroExtensions(adapter, {
      wake: {
        getAgent: vi.fn(),
        getSessionInfo: vi.fn(),
        prompt: vi.fn(),
      },
    });

    expect(adapter.handlers.has("_macro/wake")).toBe(true);
    expect(adapter.handlers.has("_macro/task/list")).toBe(false);
    expect(adapter.handlers.has("_macro/workspace/info")).toBe(false);
  });

  it("registers all when all services provided", () => {
    const adapter = createMockAdapter();

    registerMacroExtensions(adapter, {
      task: {
        taskBackend: {} as TaskBackend,
        sendMessage: vi.fn(),
      },
      wake: {
        getAgent: vi.fn(),
        getSessionInfo: vi.fn(),
        prompt: vi.fn(),
      },
      workspace: {
        getWorkspace: vi.fn(),
        agentExists: vi.fn(),
      },
      resume: {
        getAgent: vi.fn(),
        resume: vi.fn(),
      },
      agentDetection: {
        getAvailableAgents: vi.fn(),
        isDetecting: vi.fn(),
        getCachedResult: vi.fn(),
      },
      agentLifecycle: {
        getAgent: vi.fn(),
        spawn: vi.fn(),
        forkAgent: vi.fn(),
        prompt: vi.fn(),
        setPermissionMode: vi.fn(),
        getPermissionMode: vi.fn(),
        respondToPermission: vi.fn(),
        listHeadManagers: vi.fn(),
      },
    });

    expect(adapter.handlers.has("_macro/task/list")).toBe(true);
    expect(adapter.handlers.has("_macro/wake")).toBe(true);
    expect(adapter.handlers.has("_macro/workspace/info")).toBe(true);
    expect(adapter.handlers.has("_macro/resume")).toBe(true);
    expect(adapter.handlers.has("_macro/agents/available")).toBe(true);
    expect(adapter.handlers.has("_macro/agents/refresh")).toBe(true);
    expect(adapter.handlers.has("_macro/spawnAgent")).toBe(true);
    expect(adapter.handlers.has("_macro/forkAgent")).toBe(true);
    expect(adapter.handlers.has("_macro/setPermissionMode")).toBe(true);
    expect(adapter.handlers.has("_macro/respondToPermission")).toBe(true);
  });
});

describe("MACRO_EXTENSION_METHODS", () => {
  it("lists all extension methods", () => {
    expect(MACRO_EXTENSION_METHODS).toContain("_macro/task/list");
    expect(MACRO_EXTENSION_METHODS).toContain("_macro/task/get");
    expect(MACRO_EXTENSION_METHODS).toContain("_macro/task/create");
    expect(MACRO_EXTENSION_METHODS).toContain("_macro/task/assign");
    expect(MACRO_EXTENSION_METHODS).toContain("_macro/task/complete");
    expect(MACRO_EXTENSION_METHODS).toContain("_macro/task/send");
    expect(MACRO_EXTENSION_METHODS).toContain("_macro/wake");
    expect(MACRO_EXTENSION_METHODS).toContain("_macro/workspace/info");
    expect(MACRO_EXTENSION_METHODS).toContain("_macro/resume");
    expect(MACRO_EXTENSION_METHODS).toContain("_macro/agents/available");
    expect(MACRO_EXTENSION_METHODS).toContain("_macro/agents/refresh");
    expect(MACRO_EXTENSION_METHODS).toContain("_macro/spawnAgent");
    expect(MACRO_EXTENSION_METHODS).toContain("_macro/forkAgent");
    expect(MACRO_EXTENSION_METHODS).toContain("_macro/setPermissionMode");
    expect(MACRO_EXTENSION_METHODS).toContain("_macro/respondToPermission");
  });
});

describe("EXTENSION_CAPABILITIES", () => {
  it("maps methods to capabilities", () => {
    expect(EXTENSION_CAPABILITIES["_macro/task/list"]).toBe("canQuery");
    expect(EXTENSION_CAPABILITIES["_macro/task/create"]).toBe("canManageTasks");
    expect(EXTENSION_CAPABILITIES["_macro/task/send"]).toBe("canMessage");
    expect(EXTENSION_CAPABILITIES["_macro/wake"]).toBe("canMessage");
    expect(EXTENSION_CAPABILITIES["_macro/workspace/info"]).toBe("canQuery");
    expect(EXTENSION_CAPABILITIES["_macro/resume"]).toBe("canManageLifecycle");
    expect(EXTENSION_CAPABILITIES["_macro/agents/available"]).toBe("canQuery");
    expect(EXTENSION_CAPABILITIES["_macro/agents/refresh"]).toBe("canQuery");
    expect(EXTENSION_CAPABILITIES["_macro/spawnAgent"]).toBe("canManageLifecycle");
    expect(EXTENSION_CAPABILITIES["_macro/forkAgent"]).toBe("canManageLifecycle");
    expect(EXTENSION_CAPABILITIES["_macro/setPermissionMode"]).toBe("canManageLifecycle");
    expect(EXTENSION_CAPABILITIES["_macro/respondToPermission"]).toBe("canManageLifecycle");
  });
});
