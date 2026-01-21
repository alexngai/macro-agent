import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createTaskDelegationManager,
  generateTaskId,
  type TaskDelegationManager,
  type TaskDelegationParams,
  type TaskProgressPayload,
  type TaskCompletePayload,
  type DelegatedTask,
} from "../task-delegation.js";
import { createCapabilityManager } from "../capability-manager.js";
import type { HierarchyResponse } from "../hierarchy-protocol.js";

describe("TaskDelegation", () => {
  describe("generateTaskId", () => {
    it("should generate unique task IDs", () => {
      const id1 = generateTaskId();
      const id2 = generateTaskId();

      expect(id1).toMatch(/^task_[a-zA-Z0-9_-]{12}$/);
      expect(id2).toMatch(/^task_[a-zA-Z0-9_-]{12}$/);
      expect(id1).not.toBe(id2);
    });
  });

  describe("TaskDelegationManager", () => {
    let manager: TaskDelegationManager;
    let mockSendRequest: ReturnType<typeof vi.fn>;
    let mockSendMessage: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      manager = createTaskDelegationManager();
      mockSendRequest = vi.fn();
      mockSendMessage = vi.fn();
      manager.setSendFunctions({
        sendRequest: mockSendRequest,
        sendMessage: mockSendMessage,
      });
    });

    describe("getHandler", () => {
      it("should return a pattern handler", () => {
        const handler = manager.getHandler();

        expect(handler).toBeDefined();
        expect(handler.handleRequest).toBeInstanceOf(Function);
        expect(handler.handleMessage).toBeInstanceOf(Function);
      });
    });

    describe("handleRequest - task/delegate", () => {
      it("should accept valid task delegation", async () => {
        const handler = manager.getHandler();

        const response = await handler.handleRequest("peer-1", "task/delegate", {
          taskId: "task-123",
          description: "Do something",
          responseMode: "final-only",
        });

        expect(response.result).toEqual({
          accepted: true,
          taskId: "task-123",
        });
      });

      it("should reject task without taskId", async () => {
        const handler = manager.getHandler();

        const response = await handler.handleRequest("peer-1", "task/delegate", {
          description: "Do something",
          responseMode: "final-only",
        });

        expect(response.error).toBeDefined();
        expect(response.error?.code).toBe(4005);
      });

      it("should reject task without description", async () => {
        const handler = manager.getHandler();

        const response = await handler.handleRequest("peer-1", "task/delegate", {
          taskId: "task-123",
          responseMode: "final-only",
        });

        expect(response.error).toBeDefined();
        expect(response.error?.code).toBe(4005);
      });

      it("should handle duplicate taskId idempotently", async () => {
        const handler = manager.getHandler();

        // First request
        await handler.handleRequest("peer-1", "task/delegate", {
          taskId: "task-123",
          description: "Do something",
          responseMode: "final-only",
        });

        // Duplicate request
        const response = await handler.handleRequest("peer-1", "task/delegate", {
          taskId: "task-123",
          description: "Do something",
          responseMode: "final-only",
        });

        expect(response.result).toEqual({
          accepted: true,
          taskId: "task-123",
        });
      });

      it("should reject unknown methods", async () => {
        const handler = manager.getHandler();

        const response = await handler.handleRequest("peer-1", "task/unknown", {});

        expect(response.error).toBeDefined();
        expect(response.error?.code).toBe(4005);
      });
    });

    describe("handleRequest with capability manager", () => {
      it("should reject task from peer without capability", async () => {
        const capabilityManager = createCapabilityManager();
        const managerWithCaps = createTaskDelegationManager({ capabilityManager });
        managerWithCaps.setSendFunctions({
          sendRequest: mockSendRequest,
          sendMessage: mockSendMessage,
        });

        const handler = managerWithCaps.getHandler();

        const response = await handler.handleRequest("peer-1", "task/delegate", {
          taskId: "task-123",
          description: "Do something",
          responseMode: "final-only",
        });

        expect(response.error).toBeDefined();
        expect(response.error?.code).toBe(4001); // CAPABILITY_DENIED
      });

      it("should accept task from peer with capability", async () => {
        const capabilityManager = createCapabilityManager();
        capabilityManager.grant("peer-1", [{ type: "task-delegation" }]);

        const managerWithCaps = createTaskDelegationManager({ capabilityManager });
        managerWithCaps.setSendFunctions({
          sendRequest: mockSendRequest,
          sendMessage: mockSendMessage,
        });

        const handler = managerWithCaps.getHandler();

        const response = await handler.handleRequest("peer-1", "task/delegate", {
          taskId: "task-123",
          description: "Do something",
          responseMode: "final-only",
        });

        expect(response.result).toEqual({
          accepted: true,
          taskId: "task-123",
        });
      });
    });

    describe("handleRequest with maxConcurrentTasks", () => {
      it("should reject tasks when limit reached", async () => {
        const managerWithLimit = createTaskDelegationManager({
          maxConcurrentTasks: 1,
        });
        managerWithLimit.setSendFunctions({
          sendRequest: mockSendRequest,
          sendMessage: mockSendMessage,
        });

        const handler = managerWithLimit.getHandler();

        // First task should be accepted
        await handler.handleRequest("peer-1", "task/delegate", {
          taskId: "task-1",
          description: "Task 1",
          responseMode: "final-only",
        });

        // Second task should be rejected
        const response = await handler.handleRequest("peer-1", "task/delegate", {
          taskId: "task-2",
          description: "Task 2",
          responseMode: "final-only",
        });

        expect(response.error).toBeDefined();
        expect(response.error?.code).toBe(4003); // TASK_REJECTED
      });
    });

    describe("handleRequest with onTaskReceived callback", () => {
      it("should call callback and accept if callback accepts", async () => {
        const onTaskReceived = vi.fn().mockResolvedValue({ accepted: true });

        const managerWithCallback = createTaskDelegationManager({ onTaskReceived });
        managerWithCallback.setSendFunctions({
          sendRequest: mockSendRequest,
          sendMessage: mockSendMessage,
        });

        const handler = managerWithCallback.getHandler();

        const response = await handler.handleRequest("peer-1", "task/delegate", {
          taskId: "task-123",
          description: "Do something",
          responseMode: "final-only",
        });

        expect(onTaskReceived).toHaveBeenCalled();
        expect(response.result).toEqual({
          accepted: true,
          taskId: "task-123",
        });
      });

      it("should reject if callback rejects", async () => {
        const onTaskReceived = vi.fn().mockResolvedValue({
          accepted: false,
          reason: "Queue full",
        });

        const managerWithCallback = createTaskDelegationManager({ onTaskReceived });
        managerWithCallback.setSendFunctions({
          sendRequest: mockSendRequest,
          sendMessage: mockSendMessage,
        });

        const handler = managerWithCallback.getHandler();

        const response = await handler.handleRequest("peer-1", "task/delegate", {
          taskId: "task-123",
          description: "Do something",
          responseMode: "final-only",
        });

        expect(response.error).toBeDefined();
        expect(response.error?.code).toBe(4003);
      });

      it("should reject if callback throws", async () => {
        const onTaskReceived = vi.fn().mockRejectedValue(new Error("Callback error"));

        const managerWithCallback = createTaskDelegationManager({ onTaskReceived });
        managerWithCallback.setSendFunctions({
          sendRequest: mockSendRequest,
          sendMessage: mockSendMessage,
        });

        const handler = managerWithCallback.getHandler();

        const response = await handler.handleRequest("peer-1", "task/delegate", {
          taskId: "task-123",
          description: "Do something",
          responseMode: "final-only",
        });

        expect(response.error).toBeDefined();
        expect(response.error?.code).toBe(4003);
      });
    });

    describe("delegateTask", () => {
      it("should throw if not connected to PeerManager", async () => {
        const freshManager = createTaskDelegationManager();

        await expect(
          freshManager.delegateTask(
            "peer-2",
            {
              taskId: "task-123",
              description: "Do something",
              responseMode: "final-only",
            },
            { onComplete: vi.fn() }
          )
        ).rejects.toThrow("not connected");
      });

      it("should send delegation request", async () => {
        mockSendRequest.mockResolvedValue({
          result: { accepted: true, taskId: "task-123" },
        });

        const result = await manager.delegateTask(
          "peer-2",
          {
            taskId: "task-123",
            description: "Do something",
            responseMode: "final-only",
          },
          { onComplete: vi.fn() }
        );

        expect(mockSendRequest).toHaveBeenCalledWith("peer-2", "task/delegate", {
          taskId: "task-123",
          description: "Do something",
          responseMode: "final-only",
        });
        expect(result).toEqual({ accepted: true, taskId: "task-123" });
      });

      it("should return rejection reason on error", async () => {
        mockSendRequest.mockResolvedValue({
          error: { code: 4003, message: "TASK_REJECTED" },
        });

        const result = await manager.delegateTask(
          "peer-2",
          {
            taskId: "task-123",
            description: "Do something",
            responseMode: "final-only",
          },
          { onComplete: vi.fn() }
        );

        expect(result).toEqual({ accepted: false, reason: "TASK_REJECTED" });
      });

      it("should track outbound task on acceptance", async () => {
        mockSendRequest.mockResolvedValue({
          result: { accepted: true, taskId: "task-123" },
        });

        await manager.delegateTask(
          "peer-2",
          {
            taskId: "task-123",
            description: "Do something",
            responseMode: "final-only",
          },
          { onComplete: vi.fn() }
        );

        const outbound = manager.listOutboundTasks();
        expect(outbound).toHaveLength(1);
        expect(outbound[0].taskId).toBe("task-123");
        expect(outbound[0].toPeerId).toBe("peer-2");
      });

      it("should not track outbound task on rejection", async () => {
        mockSendRequest.mockResolvedValue({
          result: { accepted: false, reason: "Busy" },
        });

        await manager.delegateTask(
          "peer-2",
          {
            taskId: "task-123",
            description: "Do something",
            responseMode: "final-only",
          },
          { onComplete: vi.fn() }
        );

        const outbound = manager.listOutboundTasks();
        expect(outbound).toHaveLength(0);
      });
    });

    describe("handleMessage - task/progress", () => {
      it("should call onProgress callback for tracked task", async () => {
        const onProgress = vi.fn();
        const onComplete = vi.fn();

        mockSendRequest.mockResolvedValue({
          result: { accepted: true, taskId: "task-123" },
        });

        await manager.delegateTask(
          "peer-2",
          {
            taskId: "task-123",
            description: "Do something",
            responseMode: "progress-updates",
          },
          { onProgress, onComplete }
        );

        const handler = manager.getHandler();
        handler.handleMessage("peer-2", "task/progress", {
          taskId: "task-123",
          status: "in_progress",
          progress: 50,
          message: "Halfway done",
        });

        expect(onProgress).toHaveBeenCalledWith({
          taskId: "task-123",
          status: "in_progress",
          progress: 50,
          message: "Halfway done",
        });
      });

      it("should not call callback for unknown task", () => {
        const handler = manager.getHandler();

        // Should not throw
        handler.handleMessage("peer-2", "task/progress", {
          taskId: "unknown-task",
          status: "in_progress",
        });
      });
    });

    describe("handleMessage - task/complete", () => {
      it("should call onComplete callback and remove task", async () => {
        const onComplete = vi.fn();

        mockSendRequest.mockResolvedValue({
          result: { accepted: true, taskId: "task-123" },
        });

        await manager.delegateTask(
          "peer-2",
          {
            taskId: "task-123",
            description: "Do something",
            responseMode: "final-only",
          },
          { onComplete }
        );

        expect(manager.listOutboundTasks()).toHaveLength(1);

        const handler = manager.getHandler();
        handler.handleMessage("peer-2", "task/complete", {
          taskId: "task-123",
          status: "completed",
          result: { output: "success" },
        });

        expect(onComplete).toHaveBeenCalledWith({
          taskId: "task-123",
          status: "completed",
          result: { output: "success" },
        });
        expect(manager.listOutboundTasks()).toHaveLength(0);
      });

      it("should handle task failure", async () => {
        const onComplete = vi.fn();

        mockSendRequest.mockResolvedValue({
          result: { accepted: true, taskId: "task-123" },
        });

        await manager.delegateTask(
          "peer-2",
          {
            taskId: "task-123",
            description: "Do something",
            responseMode: "final-only",
          },
          { onComplete }
        );

        const handler = manager.getHandler();
        handler.handleMessage("peer-2", "task/complete", {
          taskId: "task-123",
          status: "failed",
          error: { code: 500, message: "Internal error" },
        });

        expect(onComplete).toHaveBeenCalledWith({
          taskId: "task-123",
          status: "failed",
          error: { code: 500, message: "Internal error" },
        });
      });
    });

    describe("reportProgress", () => {
      it("should send progress message for progress-updates mode", async () => {
        const handler = manager.getHandler();

        // Accept a task with progress-updates mode
        await handler.handleRequest("peer-1", "task/delegate", {
          taskId: "task-123",
          description: "Do something",
          responseMode: "progress-updates",
        });

        manager.reportProgress("task-123", {
          status: "in_progress",
          progress: 50,
          message: "Halfway",
        });

        expect(mockSendMessage).toHaveBeenCalledWith("peer-1", "task/progress", {
          taskId: "task-123",
          status: "in_progress",
          progress: 50,
          message: "Halfway",
        });
      });

      it("should not send progress for final-only mode", async () => {
        const handler = manager.getHandler();

        await handler.handleRequest("peer-1", "task/delegate", {
          taskId: "task-123",
          description: "Do something",
          responseMode: "final-only",
        });

        manager.reportProgress("task-123", {
          status: "in_progress",
          progress: 50,
        });

        expect(mockSendMessage).not.toHaveBeenCalled();
      });

      it("should not send progress for unknown task", () => {
        manager.reportProgress("unknown-task", {
          status: "in_progress",
          progress: 50,
        });

        expect(mockSendMessage).not.toHaveBeenCalled();
      });
    });

    describe("completeTask", () => {
      it("should send completion message", async () => {
        const handler = manager.getHandler();

        await handler.handleRequest("peer-1", "task/delegate", {
          taskId: "task-123",
          description: "Do something",
          responseMode: "final-only",
        });

        manager.completeTask("task-123", {
          status: "completed",
          result: { output: "done" },
        });

        expect(mockSendMessage).toHaveBeenCalledWith("peer-1", "task/complete", {
          taskId: "task-123",
          status: "completed",
          result: { output: "done" },
        });
      });

      it("should update task status", async () => {
        const handler = manager.getHandler();

        await handler.handleRequest("peer-1", "task/delegate", {
          taskId: "task-123",
          description: "Do something",
          responseMode: "final-only",
        });

        manager.completeTask("task-123", { status: "completed" });

        const task = manager.getTask("task-123");
        expect(task?.status).toBe("completed");
      });

      it("should not send for unknown task", () => {
        manager.completeTask("unknown-task", { status: "completed" });

        expect(mockSendMessage).not.toHaveBeenCalled();
      });
    });

    describe("getTask", () => {
      it("should return undefined for unknown task", () => {
        expect(manager.getTask("unknown")).toBeUndefined();
      });

      it("should return task by ID", async () => {
        const handler = manager.getHandler();

        await handler.handleRequest("peer-1", "task/delegate", {
          taskId: "task-123",
          description: "Do something",
          context: { key: "value" },
          responseMode: "final-only",
        });

        const task = manager.getTask("task-123");
        expect(task).toBeDefined();
        expect(task?.taskId).toBe("task-123");
        expect(task?.description).toBe("Do something");
        expect(task?.context).toEqual({ key: "value" });
        expect(task?.fromPeerId).toBe("peer-1");
        expect(task?.status).toBe("pending");
      });
    });

    describe("listInboundTasks", () => {
      it("should return empty array initially", () => {
        expect(manager.listInboundTasks()).toEqual([]);
      });

      it("should return all inbound tasks", async () => {
        const handler = manager.getHandler();

        await handler.handleRequest("peer-1", "task/delegate", {
          taskId: "task-1",
          description: "Task 1",
          responseMode: "final-only",
        });

        await handler.handleRequest("peer-2", "task/delegate", {
          taskId: "task-2",
          description: "Task 2",
          responseMode: "final-only",
        });

        const tasks = manager.listInboundTasks();
        expect(tasks).toHaveLength(2);
        expect(tasks.map((t) => t.taskId)).toContain("task-1");
        expect(tasks.map((t) => t.taskId)).toContain("task-2");
      });
    });

    describe("listOutboundTasks", () => {
      it("should return empty array initially", () => {
        expect(manager.listOutboundTasks()).toEqual([]);
      });
    });

    describe("timeout handling", () => {
      it("should call onComplete with timeout error", async () => {
        vi.useFakeTimers();

        const onComplete = vi.fn();

        mockSendRequest.mockResolvedValue({
          result: { accepted: true, taskId: "task-123" },
        });

        await manager.delegateTask(
          "peer-2",
          {
            taskId: "task-123",
            description: "Do something",
            responseMode: "final-only",
            timeout: 1000,
          },
          { onComplete }
        );

        // Advance time past timeout
        vi.advanceTimersByTime(1100);

        expect(onComplete).toHaveBeenCalledWith({
          taskId: "task-123",
          status: "failed",
          error: { code: 4004, message: "TASK_TIMEOUT" },
        });
        expect(manager.listOutboundTasks()).toHaveLength(0);

        vi.useRealTimers();
      });

      it("should clear timeout when task completes", async () => {
        vi.useFakeTimers();

        const onComplete = vi.fn();

        mockSendRequest.mockResolvedValue({
          result: { accepted: true, taskId: "task-123" },
        });

        await manager.delegateTask(
          "peer-2",
          {
            taskId: "task-123",
            description: "Do something",
            responseMode: "final-only",
            timeout: 1000,
          },
          { onComplete }
        );

        // Complete the task before timeout
        const handler = manager.getHandler();
        handler.handleMessage("peer-2", "task/complete", {
          taskId: "task-123",
          status: "completed",
        });

        expect(onComplete).toHaveBeenCalledTimes(1);
        expect(onComplete).toHaveBeenCalledWith({
          taskId: "task-123",
          status: "completed",
        });

        // Advance past timeout - should not call again
        vi.advanceTimersByTime(1100);
        expect(onComplete).toHaveBeenCalledTimes(1);

        vi.useRealTimers();
      });
    });

    describe("peer address parsing", () => {
      it("should extract peer ID from simple address", async () => {
        const handler = manager.getHandler();

        await handler.handleRequest("peer-1", "task/delegate", {
          taskId: "task-123",
          description: "Do something",
          responseMode: "final-only",
        });

        const task = manager.getTask("task-123");
        expect(task?.fromPeerId).toBe("peer-1");
      });

      it("should extract peer ID from address with agent path", async () => {
        const handler = manager.getHandler();

        await handler.handleRequest("peer-1/agent-1/sub-agent", "task/delegate", {
          taskId: "task-123",
          description: "Do something",
          responseMode: "final-only",
        });

        const task = manager.getTask("task-123");
        expect(task?.fromPeerId).toBe("peer-1");
      });
    });
  });
});
