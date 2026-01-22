/**
 * Tests for done() MCP tool
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  hasLifecycleDoneCapability,
  buildLifecycleContext,
  createDoneHandler,
  DoneSchema,
  DONE_TOOL_INFO,
} from "../done.js";
import type { ToolContext } from "../../types.js";

// Mock lifecycle modules
vi.mock("../../../lifecycle/cleanup.js", () => ({
  detectCleanupStatus: vi.fn().mockReturnValue({ ready: true }),
}));

vi.mock("../../../lifecycle/handlers/index.js", () => ({
  dispatchDone: vi.fn().mockResolvedValue({
    shouldTerminate: true,
    signalsEmitted: ["WORKER_DONE"],
    cleanupActions: ["Action 1"],
  }),
}));

import { detectCleanupStatus } from "../../../lifecycle/cleanup.js";
import { dispatchDone } from "../../../lifecycle/handlers/index.js";

const mockDetectCleanupStatus = vi.mocked(detectCleanupStatus);
const mockDispatchDone = vi.mocked(dispatchDone);

// Create mock event store
function createMockEventStore(options?: { role?: string }) {
  return {
    getAgent: vi.fn().mockReturnValue({
      id: "agent-1",
      parent: "parent-1",
      role: options?.role,
      config: {},
    }),
  };
}

// Create mock dependencies
function createMockDeps(eventStore?: any) {
  return {
    eventStore: eventStore ?? createMockEventStore(),
    agentManager: {
      getChildren: vi.fn().mockResolvedValue([]),
    },
    messageRouter: {
      emitStatus: vi.fn(),
      getMessages: vi.fn().mockReturnValue([]),
    },
    taskManager: {
      updateStatus: vi.fn(),
    },
  };
}

describe("done tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDetectCleanupStatus.mockReturnValue({ ready: true });
    mockDispatchDone.mockResolvedValue({
      shouldTerminate: true,
      signalsEmitted: ["WORKER_DONE"],
      cleanupActions: ["Action 1"],
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Tool Info
  // ─────────────────────────────────────────────────────────────────────────────

  describe("DONE_TOOL_INFO", () => {
    it("should have correct name", () => {
      expect(DONE_TOOL_INFO.name).toBe("done");
    });

    it("should have description", () => {
      expect(DONE_TOOL_INFO.description).toBeTruthy();
      expect(DONE_TOOL_INFO.description).toContain("lifecycle.done");
    });
  });

  describe("DoneSchema", () => {
    it("should have status field with valid values", () => {
      expect(DoneSchema.status).toBeDefined();
    });

    it("should have optional summary field", () => {
      expect(DoneSchema.summary).toBeDefined();
    });

    it("should have optional details field", () => {
      expect(DoneSchema.details).toBeDefined();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Capability Check
  // ─────────────────────────────────────────────────────────────────────────────

  describe("hasLifecycleDoneCapability", () => {
    it("should return false for unknown agent", () => {
      const eventStore = { getAgent: vi.fn().mockReturnValue(null) };

      const result = hasLifecycleDoneCapability(eventStore as any, "unknown");

      expect(result.hasCapability).toBe(false);
      expect(result.role).toBe("unknown");
    });

    it("should return true for worker role", () => {
      const eventStore = createMockEventStore({ role: "worker" });

      const result = hasLifecycleDoneCapability(eventStore as any, "agent-1");

      expect(result.hasCapability).toBe(true);
      expect(result.role).toBe("worker");
    });

    it("should return true for worker.resolver role", () => {
      const eventStore = createMockEventStore({ role: "worker.resolver" });

      const result = hasLifecycleDoneCapability(eventStore as any, "agent-1");

      expect(result.hasCapability).toBe(true);
      expect(result.role).toBe("worker.resolver");
    });

    it("should return true for integrator role", () => {
      const eventStore = createMockEventStore({ role: "integrator" });

      const result = hasLifecycleDoneCapability(eventStore as any, "agent-1");

      expect(result.hasCapability).toBe(true);
      expect(result.role).toBe("integrator");
    });

    it("should return true for monitor role", () => {
      const eventStore = createMockEventStore({ role: "monitor" });

      const result = hasLifecycleDoneCapability(eventStore as any, "agent-1");

      expect(result.hasCapability).toBe(true);
      expect(result.role).toBe("monitor");
    });

    it("should default to worker when no role specified", () => {
      const eventStore = createMockEventStore({});

      const result = hasLifecycleDoneCapability(eventStore as any, "agent-1");

      expect(result.hasCapability).toBe(true);
      expect(result.role).toBe("worker");
    });

    it("should return false for unknown role", () => {
      const eventStore = createMockEventStore({ role: "coordinator" });

      const result = hasLifecycleDoneCapability(eventStore as any, "agent-1");

      expect(result.hasCapability).toBe(false);
      expect(result.role).toBe("coordinator");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Context Building
  // ─────────────────────────────────────────────────────────────────────────────

  describe("buildLifecycleContext", () => {
    it("should build context from tool context", () => {
      const eventStore = createMockEventStore();
      const toolContext: ToolContext = {
        agent_id: "agent-1",
        session_id: "session-1",
        task_id: "task-1",
        cwd: "/path/to/workspace",
      };

      const result = buildLifecycleContext(toolContext, eventStore as any, "worker");

      expect(result.agentId).toBe("agent-1");
      expect(result.role).toBe("worker");
      expect(result.taskId).toBe("task-1");
      expect(result.parentId).toBe("parent-1");
      expect(result.workspacePath).toBe("/path/to/workspace");
    });

    it("should handle missing parent", () => {
      const eventStore = {
        getAgent: vi.fn().mockReturnValue({
          id: "agent-1",
          parent: null,
          config: {},
        }),
      };
      const toolContext: ToolContext = {
        agent_id: "agent-1",
        session_id: "session-1",
        cwd: "/workspace",
      };

      const result = buildLifecycleContext(toolContext, eventStore as any, "worker");

      expect(result.parentId).toBeUndefined();
    });

    it("should include integrationBranch from workspace manager", () => {
      const eventStore = createMockEventStore();
      const toolContext: ToolContext = {
        agent_id: "agent-1",
        session_id: "session-1",
        cwd: "/workspace",
      };
      const workspaceManager = {
        getWorkspace: vi.fn().mockReturnValue({
          integrationBranch: "stream/abc123",
        }),
      };

      const result = buildLifecycleContext(
        toolContext,
        eventStore as any,
        "worker",
        workspaceManager
      );

      expect(result.integrationBranch).toBe("stream/abc123");
      expect(workspaceManager.getWorkspace).toHaveBeenCalledWith("agent-1");
    });

    it("should handle missing workspace manager", () => {
      const eventStore = createMockEventStore();
      const toolContext: ToolContext = {
        agent_id: "agent-1",
        session_id: "session-1",
        cwd: "/workspace",
      };

      const result = buildLifecycleContext(toolContext, eventStore as any, "worker");

      expect(result.integrationBranch).toBeUndefined();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Done Handler
  // ─────────────────────────────────────────────────────────────────────────────

  describe("createDoneHandler", () => {
    it("should return success result on completion", async () => {
      const deps = createMockDeps(createMockEventStore({ role: "worker" }));
      const toolContext: ToolContext = {
        agent_id: "agent-1",
        session_id: "session-1",
        task_id: "task-1",
        cwd: "/workspace",
      };

      const handler = createDoneHandler(toolContext, deps as any);
      const result = await handler({
        status: "completed",
        summary: "Work done",
      });

      expect(result.success).toBe(true);
      expect(result.shouldTerminate).toBe(true);
      expect(result.status).toBe("completed");
    });

    it("should fail when agent lacks capability", async () => {
      const eventStore = createMockEventStore({ role: "coordinator" });
      const deps = createMockDeps(eventStore);
      const toolContext: ToolContext = {
        agent_id: "agent-1",
        session_id: "session-1",
        cwd: "/workspace",
      };

      const handler = createDoneHandler(toolContext, deps as any);
      const result = await handler({ status: "completed" });

      expect(result.success).toBe(false);
      expect(result.shouldTerminate).toBe(false);
      expect(result.error).toContain("lifecycle.done capability");
    });

    it("should update task status when task_id provided", async () => {
      const deps = createMockDeps(createMockEventStore({ role: "worker" }));
      const toolContext: ToolContext = {
        agent_id: "agent-1",
        session_id: "session-1",
        task_id: "task-1",
        cwd: "/workspace",
      };

      const handler = createDoneHandler(toolContext, deps as any);
      await handler({ status: "completed" });

      expect(deps.taskManager.updateStatus).toHaveBeenCalledWith("task-1", "completed");
    });

    it("should update task with failed status", async () => {
      const deps = createMockDeps(createMockEventStore({ role: "worker" }));
      const toolContext: ToolContext = {
        agent_id: "agent-1",
        session_id: "session-1",
        task_id: "task-1",
        cwd: "/workspace",
      };

      const handler = createDoneHandler(toolContext, deps as any);
      await handler({ status: "failed" });

      expect(deps.taskManager.updateStatus).toHaveBeenCalledWith("task-1", "failed");
    });

    it("should emit status via message router", async () => {
      const deps = createMockDeps(createMockEventStore({ role: "worker" }));
      const toolContext: ToolContext = {
        agent_id: "agent-1",
        session_id: "session-1",
        cwd: "/workspace",
      };

      const handler = createDoneHandler(toolContext, deps as any);
      await handler({
        status: "completed",
        summary: "Done working",
      });

      expect(deps.messageRouter.emitStatus).toHaveBeenCalledWith(
        expect.objectContaining({
          from: { agent_id: "agent-1" },
          status_type: "completed",
          summary: "Done working",
        })
      );
    });

    it("should dispatch to role-specific handler", async () => {
      const deps = createMockDeps(createMockEventStore({ role: "worker" }));
      const toolContext: ToolContext = {
        agent_id: "agent-1",
        session_id: "session-1",
        cwd: "/workspace",
      };

      const handler = createDoneHandler(toolContext, deps as any);
      await handler({ status: "completed" });

      expect(mockDispatchDone).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: "agent-1",
          role: "worker",
        }),
        expect.objectContaining({
          status: "completed",
        }),
        expect.any(Object),
        expect.any(Object)
      );
    });

    it("should detect cleanup status", async () => {
      const deps = createMockDeps(createMockEventStore({ role: "worker" }));
      const toolContext: ToolContext = {
        agent_id: "agent-1",
        session_id: "session-1",
        cwd: "/workspace",
      };

      const handler = createDoneHandler(toolContext, deps as any);
      await handler({ status: "completed" });

      expect(mockDetectCleanupStatus).toHaveBeenCalled();
    });

    it("should return cleanup status in result", async () => {
      mockDetectCleanupStatus.mockReturnValue({
        ready: false,
        reason: "Uncommitted changes",
        uncommittedFiles: ["file.ts"],
      });

      const deps = createMockDeps(createMockEventStore({ role: "worker" }));
      const toolContext: ToolContext = {
        agent_id: "agent-1",
        session_id: "session-1",
        cwd: "/workspace",
      };

      const handler = createDoneHandler(toolContext, deps as any);
      const result = await handler({ status: "completed" });

      expect(result.cleanupStatus.ready).toBe(false);
      expect(result.cleanupStatus.reason).toBe("Uncommitted changes");
    });

    it("should use explicit task_id when provided", async () => {
      const deps = createMockDeps(createMockEventStore({ role: "worker" }));
      const toolContext: ToolContext = {
        agent_id: "agent-1",
        session_id: "session-1",
        task_id: "context-task",
        cwd: "/workspace",
      };

      const handler = createDoneHandler(toolContext, deps as any);
      await handler({
        status: "completed",
        task_id: "explicit-task",
      });

      expect(deps.taskManager.updateStatus).toHaveBeenCalledWith(
        "explicit-task",
        "completed"
      );
    });

    it("should continue when task update fails", async () => {
      const deps = createMockDeps(createMockEventStore({ role: "worker" }));
      deps.taskManager.updateStatus.mockImplementation(() => {
        throw new Error("Task not found");
      });

      const toolContext: ToolContext = {
        agent_id: "agent-1",
        session_id: "session-1",
        task_id: "task-1",
        cwd: "/workspace",
      };

      const handler = createDoneHandler(toolContext, deps as any);
      const result = await handler({ status: "completed" });

      expect(result.success).toBe(true);
    });

    it("should continue when emit status fails", async () => {
      const deps = createMockDeps(createMockEventStore({ role: "worker" }));
      deps.messageRouter.emitStatus.mockImplementation(() => {
        throw new Error("Emit failed");
      });

      const toolContext: ToolContext = {
        agent_id: "agent-1",
        session_id: "session-1",
        cwd: "/workspace",
      };

      const handler = createDoneHandler(toolContext, deps as any);
      const result = await handler({ status: "completed" });

      expect(result.success).toBe(true);
    });

    it("should return warnings from handler result", async () => {
      mockDispatchDone.mockResolvedValue({
        shouldTerminate: true,
        signalsEmitted: ["WORKER_DONE"],
        warnings: ["Warning 1", "Warning 2"],
      });

      const deps = createMockDeps(createMockEventStore({ role: "worker" }));
      const toolContext: ToolContext = {
        agent_id: "agent-1",
        session_id: "session-1",
        cwd: "/workspace",
      };

      const handler = createDoneHandler(toolContext, deps as any);
      const result = await handler({ status: "completed" });

      expect(result.warnings).toEqual(["Warning 1", "Warning 2"]);
    });
  });
});
