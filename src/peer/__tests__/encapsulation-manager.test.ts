import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createEncapsulationManager,
  generateProxyAgentId,
  type EncapsulationManager,
  type EncapsulatedStatusPayload,
  type EncapsulatedResult,
} from "../encapsulation-manager.js";
import { createCapabilityManager } from "../capability-manager.js";
import type { FacadeConfig } from "../types.js";

describe("EncapsulationManager", () => {
  describe("generateProxyAgentId", () => {
    it("should generate unique proxy agent IDs", () => {
      const id1 = generateProxyAgentId();
      const id2 = generateProxyAgentId();

      expect(id1).toMatch(/^proxy_[a-zA-Z0-9_-]{12}$/);
      expect(id2).toMatch(/^proxy_[a-zA-Z0-9_-]{12}$/);
      expect(id1).not.toBe(id2);
    });
  });

  describe("createEncapsulationManager", () => {
    let manager: EncapsulationManager;
    let mockSendRequest: ReturnType<typeof vi.fn>;
    let mockSendMessage: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      manager = createEncapsulationManager();
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

    describe("handleRequest - encapsulation/register", () => {
      it("should accept valid registration", async () => {
        const handler = manager.getHandler();

        const response = await handler.handleRequest("peer-1", "encapsulation/register", {
          facadeConfig: {
            name: "MyAgent",
            capabilities: ["task"],
            errorDetail: "summary",
          },
        });

        expect(response.result).toBeDefined();
        const result = response.result as { proxyAgentId: string; accepted: boolean };
        expect(result.accepted).toBe(true);
        expect(result.proxyAgentId).toMatch(/^proxy_/);
      });

      it("should reject duplicate registration", async () => {
        const handler = manager.getHandler();

        // First registration
        await handler.handleRequest("peer-1", "encapsulation/register", {
          facadeConfig: { errorDetail: "summary" },
        });

        // Duplicate
        const response = await handler.handleRequest("peer-1", "encapsulation/register", {
          facadeConfig: { errorDetail: "summary" },
        });

        expect(response.error).toBeDefined();
        expect(response.error?.code).toBe(4203); // ALREADY_REGISTERED
      });

      it("should respect maxChildren limit", async () => {
        const limitedManager = createEncapsulationManager({ maxChildren: 1 });
        limitedManager.setSendFunctions({
          sendRequest: mockSendRequest,
          sendMessage: mockSendMessage,
        });

        const handler = limitedManager.getHandler();

        // First should succeed
        await handler.handleRequest("peer-1", "encapsulation/register", {
          facadeConfig: { errorDetail: "summary" },
        });

        // Second should fail
        const response = await handler.handleRequest("peer-2", "encapsulation/register", {
          facadeConfig: { errorDetail: "summary" },
        });

        expect(response.error).toBeDefined();
        expect(response.error?.code).toBe(4201); // REGISTRATION_REJECTED
      });

      it("should call onRegistrationRequested callback", async () => {
        const onRegistrationRequested = vi.fn().mockResolvedValue({ accepted: true });

        const callbackManager = createEncapsulationManager({
          callbacks: { onRegistrationRequested },
        });
        callbackManager.setSendFunctions({
          sendRequest: mockSendRequest,
          sendMessage: mockSendMessage,
        });

        const handler = callbackManager.getHandler();

        await handler.handleRequest("peer-1", "encapsulation/register", {
          facadeConfig: { name: "Test", errorDetail: "summary" },
        });

        expect(onRegistrationRequested).toHaveBeenCalledWith(
          "peer-1",
          expect.objectContaining({ name: "Test" })
        );
      });

      it("should reject if callback rejects", async () => {
        const onRegistrationRequested = vi.fn().mockResolvedValue({
          accepted: false,
          reason: "Not authorized",
        });

        const callbackManager = createEncapsulationManager({
          callbacks: { onRegistrationRequested },
        });
        callbackManager.setSendFunctions({
          sendRequest: mockSendRequest,
          sendMessage: mockSendMessage,
        });

        const handler = callbackManager.getHandler();

        const response = await handler.handleRequest("peer-1", "encapsulation/register", {
          facadeConfig: { errorDetail: "summary" },
        });

        expect(response.error).toBeDefined();
        expect(response.error?.code).toBe(4201);
      });

      it("should call onChildCreated callback", async () => {
        const onChildCreated = vi.fn();

        const callbackManager = createEncapsulationManager({
          callbacks: { onChildCreated },
        });
        callbackManager.setSendFunctions({
          sendRequest: mockSendRequest,
          sendMessage: mockSendMessage,
        });

        const handler = callbackManager.getHandler();

        await handler.handleRequest("peer-1", "encapsulation/register", {
          facadeConfig: { errorDetail: "summary" },
        });

        expect(onChildCreated).toHaveBeenCalledWith(
          expect.objectContaining({
            peerId: "peer-1",
            status: "idle",
          })
        );
      });
    });

    describe("handleRequest - encapsulation/unregister", () => {
      it("should unregister existing child", async () => {
        const handler = manager.getHandler();

        // Register first
        const regResponse = await handler.handleRequest("peer-1", "encapsulation/register", {
          facadeConfig: { errorDetail: "summary" },
        });

        const { proxyAgentId } = regResponse.result as { proxyAgentId: string };

        // Unregister
        const response = await handler.handleRequest("peer-1", "encapsulation/unregister", {
          proxyAgentId,
        });

        expect(response.result).toEqual({ unregistered: true });
        expect(manager.getChild(proxyAgentId)).toBeUndefined();
      });

      it("should reject unknown proxy agent", async () => {
        const handler = manager.getHandler();

        const response = await handler.handleRequest("peer-1", "encapsulation/unregister", {
          proxyAgentId: "unknown",
        });

        expect(response.error).toBeDefined();
        expect(response.error?.code).toBe(4202); // PROXY_NOT_FOUND
      });

      it("should reject unregister from wrong peer", async () => {
        const handler = manager.getHandler();

        // Register from peer-1
        const regResponse = await handler.handleRequest("peer-1", "encapsulation/register", {
          facadeConfig: { errorDetail: "summary" },
        });

        const { proxyAgentId } = regResponse.result as { proxyAgentId: string };

        // Try to unregister from peer-2
        const response = await handler.handleRequest("peer-2", "encapsulation/unregister", {
          proxyAgentId,
        });

        expect(response.error).toBeDefined();
        expect(response.error?.code).toBe(4202);
      });

      it("should call onChildRemoved callback", async () => {
        const onChildRemoved = vi.fn();

        const callbackManager = createEncapsulationManager({
          callbacks: { onChildRemoved },
        });
        callbackManager.setSendFunctions({
          sendRequest: mockSendRequest,
          sendMessage: mockSendMessage,
        });

        const handler = callbackManager.getHandler();

        const regResponse = await handler.handleRequest("peer-1", "encapsulation/register", {
          facadeConfig: { errorDetail: "summary" },
        });

        const { proxyAgentId } = regResponse.result as { proxyAgentId: string };

        await handler.handleRequest("peer-1", "encapsulation/unregister", { proxyAgentId });

        expect(onChildRemoved).toHaveBeenCalledWith(proxyAgentId);
      });
    });

    describe("handleRequest - encapsulation/task", () => {
      it("should accept task when registered with parent", async () => {
        mockSendRequest.mockResolvedValue({
          result: { proxyAgentId: "proxy-123", accepted: true },
        });

        // Register with parent
        await manager.registerWithParent("parent-1", { errorDetail: "summary" });

        const handler = manager.getHandler();

        const response = await handler.handleRequest("parent-1", "encapsulation/task", {
          proxyAgentId: "proxy-123",
          task: "Do something",
          context: { key: "value" },
        });

        expect(response.result).toBeDefined();
        const result = response.result as { accepted: boolean; taskId: string };
        expect(result.accepted).toBe(true);
        expect(result.taskId).toMatch(/^enc_task_/);
      });

      it("should reject task if not registered with sender", async () => {
        const handler = manager.getHandler();

        const response = await handler.handleRequest("unknown-parent", "encapsulation/task", {
          proxyAgentId: "proxy-123",
          task: "Do something",
        });

        expect(response.error).toBeDefined();
        expect(response.error?.code).toBe(4204); // NOT_REGISTERED
      });

      it("should reject task with wrong proxy ID", async () => {
        mockSendRequest.mockResolvedValue({
          result: { proxyAgentId: "proxy-123", accepted: true },
        });

        await manager.registerWithParent("parent-1", { errorDetail: "summary" });

        const handler = manager.getHandler();

        const response = await handler.handleRequest("parent-1", "encapsulation/task", {
          proxyAgentId: "wrong-proxy",
          task: "Do something",
        });

        expect(response.error).toBeDefined();
        expect(response.error?.code).toBe(4202);
      });

      it("should reject task without task field", async () => {
        mockSendRequest.mockResolvedValue({
          result: { proxyAgentId: "proxy-123", accepted: true },
        });

        await manager.registerWithParent("parent-1", { errorDetail: "summary" });

        const handler = manager.getHandler();

        const response = await handler.handleRequest("parent-1", "encapsulation/task", {
          proxyAgentId: "proxy-123",
        });

        expect(response.error).toBeDefined();
        expect(response.error?.code).toBe(4005);
      });

      it("should call onTaskReceived callback", async () => {
        const onTaskReceived = vi.fn();

        const callbackManager = createEncapsulationManager({
          callbacks: { onTaskReceived },
        });
        callbackManager.setSendFunctions({
          sendRequest: mockSendRequest,
          sendMessage: mockSendMessage,
        });

        mockSendRequest.mockResolvedValue({
          result: { proxyAgentId: "proxy-123", accepted: true },
        });

        await callbackManager.registerWithParent("parent-1", { errorDetail: "summary" });

        const handler = callbackManager.getHandler();

        await handler.handleRequest("parent-1", "encapsulation/task", {
          proxyAgentId: "proxy-123",
          task: "Do something",
        });

        expect(onTaskReceived).toHaveBeenCalledWith(
          expect.objectContaining({
            proxyAgentId: "proxy-123",
            task: "Do something",
          })
        );
      });
    });

    describe("handleRequest with capability manager", () => {
      it("should check encapsulation capability", async () => {
        const capabilityManager = createCapabilityManager();
        // No capability granted

        const capManager = createEncapsulationManager({ capabilityManager });
        capManager.setSendFunctions({
          sendRequest: mockSendRequest,
          sendMessage: mockSendMessage,
        });

        const handler = capManager.getHandler();

        const response = await handler.handleRequest("peer-1", "encapsulation/register", {
          facadeConfig: { errorDetail: "summary" },
        });

        expect(response.error).toBeDefined();
        expect(response.error?.code).toBe(4001);
      });

      it("should accept with proper capability", async () => {
        const capabilityManager = createCapabilityManager();
        capabilityManager.grant("peer-1", [
          { type: "encapsulation", canActAsChild: true, canActAsParent: false },
        ]);

        const capManager = createEncapsulationManager({ capabilityManager });
        capManager.setSendFunctions({
          sendRequest: mockSendRequest,
          sendMessage: mockSendMessage,
        });

        const handler = capManager.getHandler();

        const response = await handler.handleRequest("peer-1", "encapsulation/register", {
          facadeConfig: { errorDetail: "summary" },
        });

        expect(response.result).toBeDefined();
      });
    });

    describe("handleMessage - encapsulation/status", () => {
      it("should update child status", async () => {
        const handler = manager.getHandler();

        // Register child
        const regResponse = await handler.handleRequest("peer-1", "encapsulation/register", {
          facadeConfig: { errorDetail: "summary" },
        });

        const { proxyAgentId } = regResponse.result as { proxyAgentId: string };

        // Send status
        handler.handleMessage("peer-1", "encapsulation/status", {
          proxyAgentId,
          status: "running",
          message: "Processing...",
        });

        const child = manager.getChild(proxyAgentId);
        expect(child?.status).toBe("running");
      });

      it("should call onStatusUpdate callback", () => {
        const onStatusUpdate = vi.fn();

        const callbackManager = createEncapsulationManager({
          callbacks: { onStatusUpdate },
        });
        callbackManager.setSendFunctions({
          sendRequest: mockSendRequest,
          sendMessage: mockSendMessage,
        });

        const handler = callbackManager.getHandler();

        handler.handleMessage("peer-1", "encapsulation/status", {
          proxyAgentId: "proxy-123",
          status: "running",
        });

        expect(onStatusUpdate).toHaveBeenCalledWith(
          expect.objectContaining({
            proxyAgentId: "proxy-123",
            status: "running",
          })
        );
      });
    });

    describe("handleMessage - encapsulation/result", () => {
      it("should call onResultReceived callback", () => {
        const onResultReceived = vi.fn();

        const callbackManager = createEncapsulationManager({
          callbacks: { onResultReceived },
        });
        callbackManager.setSendFunctions({
          sendRequest: mockSendRequest,
          sendMessage: mockSendMessage,
        });

        const handler = callbackManager.getHandler();

        handler.handleMessage("peer-1", "encapsulation/result", {
          proxyAgentId: "proxy-123",
          taskId: "task-123",
          status: "completed",
          result: { output: "done" },
        });

        expect(onResultReceived).toHaveBeenCalledWith(
          expect.objectContaining({
            proxyAgentId: "proxy-123",
            taskId: "task-123",
            status: "completed",
          })
        );
      });
    });

    describe("registerWithParent", () => {
      it("should throw if not connected", async () => {
        const freshManager = createEncapsulationManager();

        await expect(
          freshManager.registerWithParent("parent-1", { errorDetail: "summary" })
        ).rejects.toThrow("not connected");
      });

      it("should send registration request", async () => {
        mockSendRequest.mockResolvedValue({
          result: { proxyAgentId: "proxy-123", accepted: true },
        });

        const result = await manager.registerWithParent("parent-1", {
          name: "MyAgent",
          errorDetail: "summary",
        });

        expect(mockSendRequest).toHaveBeenCalledWith("parent-1", "encapsulation/register", {
          facadeConfig: { name: "MyAgent", errorDetail: "summary" },
        });
        expect(result.accepted).toBe(true);
        expect(result.proxyAgentId).toBe("proxy-123");
      });

      it("should store parent registration on success", async () => {
        mockSendRequest.mockResolvedValue({
          result: { proxyAgentId: "proxy-123", accepted: true },
        });

        await manager.registerWithParent("parent-1", { errorDetail: "summary" });

        const reg = manager.getParentRegistration();
        expect(reg).toBeDefined();
        expect(reg?.parentPeerId).toBe("parent-1");
        expect(reg?.proxyAgentId).toBe("proxy-123");
      });

      it("should reject if already registered", async () => {
        mockSendRequest.mockResolvedValue({
          result: { proxyAgentId: "proxy-123", accepted: true },
        });

        await manager.registerWithParent("parent-1", { errorDetail: "summary" });

        const result = await manager.registerWithParent("parent-2", { errorDetail: "summary" });

        expect(result.accepted).toBe(false);
        expect(result.reason).toContain("Already");
      });
    });

    describe("unregisterFromParent", () => {
      it("should send unregister request", async () => {
        mockSendRequest.mockResolvedValueOnce({
          result: { proxyAgentId: "proxy-123", accepted: true },
        });

        await manager.registerWithParent("parent-1", { errorDetail: "summary" });

        mockSendRequest.mockResolvedValueOnce({
          result: { unregistered: true },
        });

        const result = await manager.unregisterFromParent("parent-1");

        expect(result.unregistered).toBe(true);
        expect(manager.getParentRegistration()).toBeUndefined();
      });

      it("should return false if not registered with that parent", async () => {
        const result = await manager.unregisterFromParent("unknown");
        expect(result.unregistered).toBe(false);
      });
    });

    describe("reportStatus", () => {
      it("should send status to parent", async () => {
        mockSendRequest.mockResolvedValue({
          result: { proxyAgentId: "proxy-123", accepted: true },
        });

        await manager.registerWithParent("parent-1", { errorDetail: "summary" });

        manager.reportStatus("running", "Processing...");

        expect(mockSendMessage).toHaveBeenCalledWith(
          "parent-1",
          "encapsulation/status",
          expect.objectContaining({
            proxyAgentId: "proxy-123",
            status: "running",
            message: "Processing...",
          })
        );
      });

      it("should not send if not registered", () => {
        manager.reportStatus("running");
        expect(mockSendMessage).not.toHaveBeenCalled();
      });
    });

    describe("reportResult", () => {
      it("should send result to parent", async () => {
        mockSendRequest.mockResolvedValue({
          result: { proxyAgentId: "proxy-123", accepted: true },
        });

        await manager.registerWithParent("parent-1", { errorDetail: "summary" });

        manager.reportResult("task-123", {
          status: "completed",
          result: { output: "done" },
        });

        expect(mockSendMessage).toHaveBeenCalledWith(
          "parent-1",
          "encapsulation/result",
          expect.objectContaining({
            proxyAgentId: "proxy-123",
            taskId: "task-123",
            status: "completed",
          })
        );
      });

      it("should apply error detail level (opaque)", async () => {
        mockSendRequest.mockResolvedValue({
          result: { proxyAgentId: "proxy-123", accepted: true },
        });

        await manager.registerWithParent("parent-1", { errorDetail: "opaque" });

        manager.reportResult("task-123", {
          status: "failed",
          error: { code: 500, message: "Internal error", details: { stack: "..." } },
        });

        expect(mockSendMessage).toHaveBeenCalledWith(
          "parent-1",
          "encapsulation/result",
          expect.objectContaining({
            error: { code: 500, message: "Operation failed" },
          })
        );
      });

      it("should apply error detail level (summary)", async () => {
        mockSendRequest.mockResolvedValue({
          result: { proxyAgentId: "proxy-123", accepted: true },
        });

        await manager.registerWithParent("parent-1", { errorDetail: "summary" });

        manager.reportResult("task-123", {
          status: "failed",
          error: { code: 404, message: "Not found", details: { path: "/foo" } },
        });

        expect(mockSendMessage).toHaveBeenCalledWith(
          "parent-1",
          "encapsulation/result",
          expect.objectContaining({
            error: { code: 404, message: "Not found" },
          })
        );
      });

      it("should apply error detail level (full)", async () => {
        mockSendRequest.mockResolvedValue({
          result: { proxyAgentId: "proxy-123", accepted: true },
        });

        await manager.registerWithParent("parent-1", { errorDetail: "full" });

        manager.reportResult("task-123", {
          status: "failed",
          error: { code: 404, message: "Not found", details: { path: "/foo" } },
        });

        expect(mockSendMessage).toHaveBeenCalledWith(
          "parent-1",
          "encapsulation/result",
          expect.objectContaining({
            error: { code: 404, message: "Not found", details: { path: "/foo" } },
          })
        );
      });
    });

    describe("sendTask", () => {
      it("should send task to encapsulated child", async () => {
        const handler = manager.getHandler();

        // Register a child
        const regResponse = await handler.handleRequest("peer-1", "encapsulation/register", {
          facadeConfig: { errorDetail: "summary" },
        });

        const { proxyAgentId } = regResponse.result as { proxyAgentId: string };

        mockSendRequest.mockResolvedValue({
          result: { accepted: true, taskId: "task-123" },
        });

        const result = await manager.sendTask(proxyAgentId, "Do something", { key: "value" });

        expect(mockSendRequest).toHaveBeenCalledWith("peer-1", "encapsulation/task", {
          proxyAgentId,
          task: "Do something",
          context: { key: "value" },
        });
        expect(result.accepted).toBe(true);
        expect(result.taskId).toBe("task-123");
      });

      it("should throw for unknown proxy agent", async () => {
        await expect(manager.sendTask("unknown", "Do something")).rejects.toThrow();
      });
    });

    describe("removeChild", () => {
      it("should remove child and call callback", async () => {
        const onChildRemoved = vi.fn();

        const callbackManager = createEncapsulationManager({
          callbacks: { onChildRemoved },
        });
        callbackManager.setSendFunctions({
          sendRequest: mockSendRequest,
          sendMessage: mockSendMessage,
        });

        const handler = callbackManager.getHandler();

        const regResponse = await handler.handleRequest("peer-1", "encapsulation/register", {
          facadeConfig: { errorDetail: "summary" },
        });

        const { proxyAgentId } = regResponse.result as { proxyAgentId: string };

        callbackManager.removeChild(proxyAgentId);

        expect(callbackManager.getChild(proxyAgentId)).toBeUndefined();
        expect(onChildRemoved).toHaveBeenCalledWith(proxyAgentId);
      });
    });

    describe("listChildren", () => {
      it("should return empty array initially", () => {
        expect(manager.listChildren()).toEqual([]);
      });

      it("should return all children", async () => {
        const handler = manager.getHandler();

        await handler.handleRequest("peer-1", "encapsulation/register", {
          facadeConfig: { name: "Child1", errorDetail: "summary" },
        });

        await handler.handleRequest("peer-2", "encapsulation/register", {
          facadeConfig: { name: "Child2", errorDetail: "full" },
        });

        const children = manager.listChildren();
        expect(children).toHaveLength(2);
      });
    });

    describe("peer address parsing", () => {
      it("should extract peer ID from simple address", async () => {
        const handler = manager.getHandler();

        await handler.handleRequest("peer-1", "encapsulation/register", {
          facadeConfig: { errorDetail: "summary" },
        });

        const children = manager.listChildren();
        expect(children[0].peerId).toBe("peer-1");
      });

      it("should extract peer ID from address with path", async () => {
        const handler = manager.getHandler();

        await handler.handleRequest("peer-1/agent-1/sub", "encapsulation/register", {
          facadeConfig: { errorDetail: "summary" },
        });

        const children = manager.listChildren();
        expect(children[0].peerId).toBe("peer-1");
      });
    });

    describe("unknown methods", () => {
      it("should reject unknown encapsulation methods", async () => {
        const handler = manager.getHandler();

        const response = await handler.handleRequest("peer-1", "encapsulation/unknown", {});

        expect(response.error).toBeDefined();
        expect(response.error?.code).toBe(4005);
      });
    });
  });
});
