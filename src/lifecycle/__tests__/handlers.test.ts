/**
 * Tests for lifecycle handlers
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleWorkerDone } from "../handlers/worker.js";
import { handleIntegratorDone } from "../handlers/integrator.js";
import { handleMonitorDone } from "../handlers/monitor.js";
import { handleGenericDone } from "../handlers/generic.js";
import { createHandlerRegistry, getHandler, dispatchDone } from "../handlers/index.js";
import type { LifecycleContext, DoneArgs, CleanupStatus } from "../types.js";

// Mock cleanup module
vi.mock("../cleanup.js", () => ({
  commitChanges: vi.fn(),
  getCurrentBranch: vi.fn(),
}));

import { commitChanges, getCurrentBranch } from "../cleanup.js";

const mockCommitChanges = vi.mocked(commitChanges);
const mockGetCurrentBranch = vi.mocked(getCurrentBranch);

// Create mock dependencies
function createMockDeps() {
  return {
    messageRouter: {
      emitStatus: vi.fn(),
      getSubscriptions: vi.fn().mockReturnValue([]),
      unsubscribe: vi.fn(),
    },
    agentManager: {
      getChildren: vi.fn().mockReturnValue([]),
    },
  };
}

describe("handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Worker Handler
  // ─────────────────────────────────────────────────────────────────────────────

  describe("handleWorkerDone", () => {
    it("should emit WORKER_DONE signal", async () => {
      const deps = createMockDeps();
      const context: LifecycleContext = {
        agentId: "worker-1",
        role: "worker",
        taskId: "task-1",
        workspacePath: "/path/to/workspace",
      };
      const args: DoneArgs = {
        status: "completed",
        summary: "Work done",
      };
      const cleanupStatus: CleanupStatus = { ready: true };

      const result = await handleWorkerDone(context, args, cleanupStatus, deps as any);

      expect(result.shouldTerminate).toBe(true);
      expect(result.signalsEmitted).toContain("WORKER_DONE");
      expect(deps.messageRouter.emitStatus).toHaveBeenCalledWith(
        expect.objectContaining({
          from: { agent_id: "worker-1" },
          status_type: "completed",
        })
      );
    });

    it("should emit MERGE_REQUEST when completed", async () => {
      mockGetCurrentBranch.mockReturnValue("feature/test");

      const deps = createMockDeps();
      const context: LifecycleContext = {
        agentId: "worker-1",
        role: "worker",
        workspacePath: "/path/to/workspace",
      };
      const args: DoneArgs = { status: "completed" };
      const cleanupStatus: CleanupStatus = { ready: true };

      const result = await handleWorkerDone(context, args, cleanupStatus, deps as any);

      expect(result.signalsEmitted).toContain("MERGE_REQUEST");
    });

    it("should not emit MERGE_REQUEST when failed", async () => {
      const deps = createMockDeps();
      const context: LifecycleContext = {
        agentId: "worker-1",
        role: "worker",
        workspacePath: "/path/to/workspace",
      };
      const args: DoneArgs = { status: "failed" };
      const cleanupStatus: CleanupStatus = { ready: true };

      const result = await handleWorkerDone(context, args, cleanupStatus, deps as any);

      expect(result.signalsEmitted).not.toContain("MERGE_REQUEST");
    });

    it("should commit changes when cleanup not ready", async () => {
      mockCommitChanges.mockReturnValue("abc123");

      const deps = createMockDeps();
      const context: LifecycleContext = {
        agentId: "worker-1",
        role: "worker",
        workspacePath: "/path/to/workspace",
      };
      const args: DoneArgs = {
        status: "completed",
        summary: "Work done",
      };
      const cleanupStatus: CleanupStatus = {
        ready: false,
        uncommittedFiles: ["file1.ts", "file2.ts"],
      };

      const result = await handleWorkerDone(context, args, cleanupStatus, deps as any);

      expect(mockCommitChanges).toHaveBeenCalledWith(
        "/path/to/workspace",
        "WIP: Work done"
      );
      expect(result.cleanupActions).toEqual(
        expect.arrayContaining([expect.stringContaining("Committed")])
      );
    });

    it("should signal children to terminate", async () => {
      const deps = createMockDeps();
      // Mock getChildren to return children only for the parent, not for the children
      deps.agentManager.getChildren.mockImplementation((agentId: string) => {
        if (agentId === "worker-1") {
          return [
            { id: "child-1", state: "running" },
            { id: "child-2", state: "running" },
          ];
        }
        return [];
      });

      const context: LifecycleContext = {
        agentId: "worker-1",
        role: "worker",
      };
      const args: DoneArgs = { status: "completed" };
      const cleanupStatus: CleanupStatus = { ready: true };

      const result = await handleWorkerDone(context, args, cleanupStatus, deps as any);

      expect(result.cleanupActions).toEqual(
        expect.arrayContaining([expect.stringContaining("descendant")])
      );
      // Should emit termination signal for each descendant
      expect(deps.messageRouter.emitStatus).toHaveBeenCalledTimes(3); // WORKER_DONE + 2 descendants
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Integrator Handler
  // ─────────────────────────────────────────────────────────────────────────────

  describe("handleIntegratorDone", () => {
    it("should emit INTEGRATOR_DONE signal", async () => {
      const deps = createMockDeps();
      const context: LifecycleContext = {
        agentId: "integrator-1",
        role: "integrator",
        branch: "integration",
      };
      const args: DoneArgs = {
        status: "completed",
        summary: "Integration complete",
      };
      const cleanupStatus: CleanupStatus = { ready: true };

      const result = await handleIntegratorDone(context, args, cleanupStatus, deps as any);

      expect(result.shouldTerminate).toBe(true);
      expect(result.signalsEmitted).toContain("INTEGRATOR_DONE");
      expect(deps.messageRouter.emitStatus).toHaveBeenCalledWith(
        expect.objectContaining({
          from: { agent_id: "integrator-1" },
          status_type: "completed",
          details: expect.objectContaining({
            signal: "INTEGRATOR_DONE",
            queueEmpty: true, // Stub returns true
          }),
        })
      );
    });

    it("should include merge queue status in cleanup actions", async () => {
      const deps = createMockDeps();
      const context: LifecycleContext = {
        agentId: "integrator-1",
        role: "integrator",
      };
      const args: DoneArgs = { status: "completed" };
      const cleanupStatus: CleanupStatus = { ready: true };

      const result = await handleIntegratorDone(context, args, cleanupStatus, deps as any);

      expect(result.cleanupActions).toEqual(
        expect.arrayContaining([expect.stringContaining("Merge queue")])
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Monitor Handler
  // ─────────────────────────────────────────────────────────────────────────────

  describe("handleMonitorDone", () => {
    it("should unsubscribe from all channels", async () => {
      const deps = createMockDeps();
      deps.messageRouter.getSubscriptions.mockReturnValue([
        { type: "topic", target: "events" },
        { type: "subtree", target: "parent-1" },
      ]);

      const context: LifecycleContext = {
        agentId: "monitor-1",
        role: "monitor",
      };
      const args: DoneArgs = { status: "completed" };
      const cleanupStatus: CleanupStatus = { ready: true };

      const result = await handleMonitorDone(context, args, cleanupStatus, deps as any);

      expect(result.shouldTerminate).toBe(true);
      expect(deps.messageRouter.unsubscribe).toHaveBeenCalledTimes(2);
      expect(result.cleanupActions).toEqual(
        expect.arrayContaining([expect.stringContaining("Unsubscribed")])
      );
    });

    it("should handle no subscriptions gracefully", async () => {
      const deps = createMockDeps();
      deps.messageRouter.getSubscriptions.mockReturnValue([]);

      const context: LifecycleContext = {
        agentId: "monitor-1",
        role: "monitor",
      };
      const args: DoneArgs = { status: "completed" };
      const cleanupStatus: CleanupStatus = { ready: true };

      const result = await handleMonitorDone(context, args, cleanupStatus, deps as any);

      expect(result.cleanupActions).toContain("No subscriptions to clean up");
    });

    it("should emit STATUS signal", async () => {
      const deps = createMockDeps();
      const context: LifecycleContext = {
        agentId: "monitor-1",
        role: "monitor",
      };
      const args: DoneArgs = { status: "completed" };
      const cleanupStatus: CleanupStatus = { ready: true };

      const result = await handleMonitorDone(context, args, cleanupStatus, deps as any);

      expect(result.signalsEmitted).toContain("STATUS");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Generic Handler
  // ─────────────────────────────────────────────────────────────────────────────

  describe("handleGenericDone", () => {
    it("should emit STATUS signal with role info", async () => {
      const deps = createMockDeps();
      const context: LifecycleContext = {
        agentId: "agent-1",
        role: "custom-role",
      };
      const args: DoneArgs = { status: "completed" };
      const cleanupStatus: CleanupStatus = { ready: true };

      const result = await handleGenericDone(context, args, cleanupStatus, deps as any);

      expect(result.shouldTerminate).toBe(true);
      expect(result.signalsEmitted).toContain("STATUS");
      expect(deps.messageRouter.emitStatus).toHaveBeenCalledWith(
        expect.objectContaining({
          details: expect.objectContaining({
            role: "custom-role",
          }),
        })
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Handler Registry
  // ─────────────────────────────────────────────────────────────────────────────

  describe("createHandlerRegistry", () => {
    it("should create registry with built-in handlers", () => {
      const deps = createMockDeps();
      const registry = createHandlerRegistry(deps as any);

      expect(registry.has("worker")).toBe(true);
      expect(registry.has("integrator")).toBe(true);
      expect(registry.has("monitor")).toBe(true);
    });
  });

  describe("getHandler", () => {
    it("should return exact match handler", () => {
      const deps = createMockDeps();
      const registry = createHandlerRegistry(deps as any);

      const handler = getHandler("worker", registry, deps as any);

      expect(handler).toBeDefined();
    });

    it("should return base role handler for dot-notation roles", () => {
      const deps = createMockDeps();
      const registry = createHandlerRegistry(deps as any);

      const handler = getHandler("worker.resolver", registry, deps as any);

      expect(handler).toBeDefined();
    });

    it("should return generic handler for unknown roles", () => {
      const deps = createMockDeps();
      const registry = createHandlerRegistry(deps as any);

      const handler = getHandler("custom-role", registry, deps as any);

      expect(handler).toBeDefined();
    });
  });

  describe("dispatchDone", () => {
    it("should dispatch to correct handler based on role", async () => {
      const deps = createMockDeps();
      const context: LifecycleContext = {
        agentId: "worker-1",
        role: "worker",
      };
      const args: DoneArgs = { status: "completed" };
      const cleanupStatus: CleanupStatus = { ready: true };

      const result = await dispatchDone(context, args, cleanupStatus, deps as any);

      expect(result.shouldTerminate).toBe(true);
      expect(result.signalsEmitted).toContain("WORKER_DONE");
    });

    it("should use generic handler for unknown roles", async () => {
      const deps = createMockDeps();
      const context: LifecycleContext = {
        agentId: "agent-1",
        role: "unknown-role",
      };
      const args: DoneArgs = { status: "completed" };
      const cleanupStatus: CleanupStatus = { ready: true };

      const result = await dispatchDone(context, args, cleanupStatus, deps as any);

      expect(result.shouldTerminate).toBe(true);
      expect(result.signalsEmitted).toContain("STATUS");
    });

    it("should use custom registry when provided", async () => {
      const deps = createMockDeps();
      const customHandler = vi.fn().mockResolvedValue({
        shouldTerminate: false,
        signalsEmitted: ["CUSTOM"],
      });
      const customRegistry = new Map([["custom", customHandler]]);

      const context: LifecycleContext = {
        agentId: "agent-1",
        role: "custom",
      };
      const args: DoneArgs = { status: "completed" };
      const cleanupStatus: CleanupStatus = { ready: true };

      const result = await dispatchDone(
        context,
        args,
        cleanupStatus,
        deps as any,
        customRegistry
      );

      expect(customHandler).toHaveBeenCalled();
      expect(result.shouldTerminate).toBe(false);
      expect(result.signalsEmitted).toContain("CUSTOM");
    });
  });
});
