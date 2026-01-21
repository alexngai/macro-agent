import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createFederationManager,
  generateFederationId,
  type FederationManager,
  type EstablishFederationParams,
  type HierarchyQueryParams,
  type FederationStatusPayload,
} from "../federation-manager.js";
import { createCapabilityManager } from "../capability-manager.js";

describe("FederationManager", () => {
  describe("generateFederationId", () => {
    it("should generate unique federation IDs", () => {
      const id1 = generateFederationId();
      const id2 = generateFederationId();

      expect(id1).toMatch(/^fed_[a-zA-Z0-9_-]{12}$/);
      expect(id2).toMatch(/^fed_[a-zA-Z0-9_-]{12}$/);
      expect(id1).not.toBe(id2);
    });
  });

  describe("createFederationManager", () => {
    let manager: FederationManager;
    let mockSendRequest: ReturnType<typeof vi.fn>;
    let mockSendMessage: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      manager = createFederationManager();
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

    describe("handleRequest - federation/establish", () => {
      it("should accept valid federation as parent", async () => {
        const handler = manager.getHandler();

        const response = await handler.handleRequest("peer-1", "federation/establish", {
          role: "child",
          parentAgentId: "agent-1",
          subscribeToStatus: false,
        });

        expect(response.result).toBeDefined();
        const result = response.result as { federationId: string; accepted: boolean };
        expect(result.accepted).toBe(true);
        expect(result.federationId).toMatch(/^fed_/);
      });

      it("should accept valid federation as child", async () => {
        const handler = manager.getHandler();

        const response = await handler.handleRequest("peer-1", "federation/establish", {
          role: "parent",
          subscribeToStatus: true,
        });

        expect(response.result).toBeDefined();
        const result = response.result as { federationId: string; accepted: boolean };
        expect(result.accepted).toBe(true);
      });

      it("should reject invalid role", async () => {
        const handler = manager.getHandler();

        const response = await handler.handleRequest("peer-1", "federation/establish", {
          role: "invalid",
          subscribeToStatus: false,
        });

        expect(response.error).toBeDefined();
        expect(response.error?.code).toBe(4005);
      });

      it("should reject child role without parentAgentId", async () => {
        const handler = manager.getHandler();

        const response = await handler.handleRequest("peer-1", "federation/establish", {
          role: "child",
          subscribeToStatus: false,
        });

        expect(response.error).toBeDefined();
        expect(response.error?.code).toBe(4005);
      });

      it("should reject duplicate federation", async () => {
        const handler = manager.getHandler();

        // First federation
        await handler.handleRequest("peer-1", "federation/establish", {
          role: "child",
          parentAgentId: "agent-1",
          subscribeToStatus: false,
        });

        // Duplicate attempt
        const response = await handler.handleRequest("peer-1", "federation/establish", {
          role: "child",
          parentAgentId: "agent-1",
          subscribeToStatus: false,
        });

        expect(response.error).toBeDefined();
        expect(response.error?.code).toBe(4105); // ALREADY_FEDERATED
      });

      it("should respect maxFederations limit", async () => {
        const limitedManager = createFederationManager({ maxFederations: 1 });
        limitedManager.setSendFunctions({
          sendRequest: mockSendRequest,
          sendMessage: mockSendMessage,
        });

        const handler = limitedManager.getHandler();

        // First federation should succeed
        await handler.handleRequest("peer-1", "federation/establish", {
          role: "child",
          parentAgentId: "agent-1",
          subscribeToStatus: false,
        });

        // Second should be rejected
        const response = await handler.handleRequest("peer-2", "federation/establish", {
          role: "child",
          parentAgentId: "agent-1",
          subscribeToStatus: false,
        });

        expect(response.error).toBeDefined();
        expect(response.error?.code).toBe(4101); // FEDERATION_REJECTED
      });

      it("should call onFederationRequested callback", async () => {
        const onFederationRequested = vi.fn().mockResolvedValue({ accepted: true });

        const callbackManager = createFederationManager({
          callbacks: { onFederationRequested },
        });
        callbackManager.setSendFunctions({
          sendRequest: mockSendRequest,
          sendMessage: mockSendMessage,
        });

        const handler = callbackManager.getHandler();

        await handler.handleRequest("peer-1", "federation/establish", {
          role: "child",
          parentAgentId: "agent-1",
          subscribeToStatus: false,
        });

        expect(onFederationRequested).toHaveBeenCalled();
      });

      it("should reject if callback rejects", async () => {
        const onFederationRequested = vi.fn().mockResolvedValue({
          accepted: false,
          reason: "Not authorized",
        });

        const callbackManager = createFederationManager({
          callbacks: { onFederationRequested },
        });
        callbackManager.setSendFunctions({
          sendRequest: mockSendRequest,
          sendMessage: mockSendMessage,
        });

        const handler = callbackManager.getHandler();

        const response = await handler.handleRequest("peer-1", "federation/establish", {
          role: "child",
          parentAgentId: "agent-1",
          subscribeToStatus: false,
        });

        expect(response.error).toBeDefined();
        expect(response.error?.code).toBe(4101);
      });
    });

    describe("handleRequest - federation/terminate", () => {
      it("should terminate existing federation", async () => {
        const handler = manager.getHandler();

        // Establish first
        const establishResponse = await handler.handleRequest("peer-1", "federation/establish", {
          role: "child",
          parentAgentId: "agent-1",
          subscribeToStatus: false,
        });

        const { federationId } = establishResponse.result as { federationId: string };

        // Terminate
        const response = await handler.handleRequest("peer-1", "federation/terminate", {
          federationId,
        });

        expect(response.result).toEqual({ terminated: true });
        expect(manager.getFederation(federationId)).toBeUndefined();
      });

      it("should reject unknown federation", async () => {
        const handler = manager.getHandler();

        const response = await handler.handleRequest("peer-1", "federation/terminate", {
          federationId: "unknown",
        });

        expect(response.error).toBeDefined();
        expect(response.error?.code).toBe(4103); // FEDERATION_NOT_FOUND
      });

      it("should reject terminate from wrong peer", async () => {
        const handler = manager.getHandler();

        // Establish from peer-1
        const establishResponse = await handler.handleRequest("peer-1", "federation/establish", {
          role: "child",
          parentAgentId: "agent-1",
          subscribeToStatus: false,
        });

        const { federationId } = establishResponse.result as { federationId: string };

        // Try to terminate from peer-2
        const response = await handler.handleRequest("peer-2", "federation/terminate", {
          federationId,
        });

        expect(response.error).toBeDefined();
        expect(response.error?.code).toBe(4103);
      });
    });

    describe("handleRequest - federation/getHierarchy", () => {
      it("should return hierarchy via callback", async () => {
        const onHierarchyQuery = vi.fn().mockResolvedValue({
          agents: [{ id: "agent-1", status: "idle", childCount: 2 }],
          relationships: [],
        });

        const callbackManager = createFederationManager({
          callbacks: { onHierarchyQuery },
        });
        callbackManager.setSendFunctions({
          sendRequest: mockSendRequest,
          sendMessage: mockSendMessage,
        });

        const handler = callbackManager.getHandler();

        // Establish federation (peer is parent, we are child - parents can query children)
        await handler.handleRequest("peer-1", "federation/establish", {
          role: "parent",
          subscribeToStatus: false,
        });

        // Query hierarchy
        const response = await handler.handleRequest("peer-1", "federation/getHierarchy", {
          depth: 2,
        });

        expect(response.result).toBeDefined();
        expect(onHierarchyQuery).toHaveBeenCalled();
      });

      it("should reject if no federation", async () => {
        const handler = manager.getHandler();

        const response = await handler.handleRequest("peer-1", "federation/getHierarchy", {});

        expect(response.error).toBeDefined();
        expect(response.error?.code).toBe(4103);
      });

      it("should reject if peer is child (they cannot query us)", async () => {
        const handler = manager.getHandler();

        // Establish with peer as child (we are parent) - children cannot query parents
        await handler.handleRequest("peer-1", "federation/establish", {
          role: "child",
          parentAgentId: "agent-1",
          subscribeToStatus: false,
        });

        // Query should fail - only parents can query children
        const response = await handler.handleRequest("peer-1", "federation/getHierarchy", {});

        expect(response.error).toBeDefined();
        expect(response.error?.code).toBe(4001);
      });
    });

    describe("handleRequest - federation/mount", () => {
      it("should mount agent via callback", async () => {
        const onMountRequested = vi.fn().mockResolvedValue({
          mountedAs: "remote:agent-2",
          capabilities: ["message", "query"],
        });

        const callbackManager = createFederationManager({
          callbacks: { onMountRequested },
        });
        callbackManager.setSendFunctions({
          sendRequest: mockSendRequest,
          sendMessage: mockSendMessage,
        });

        const handler = callbackManager.getHandler();

        // Establish federation (peer is parent, we are child - parents can mount from children)
        await handler.handleRequest("peer-1", "federation/establish", {
          role: "parent",
          subscribeToStatus: false,
        });

        // Mount
        const response = await handler.handleRequest("peer-1", "federation/mount", {
          targetAgentId: "agent-2",
        });

        expect(response.result).toEqual({
          mountedAs: "remote:agent-2",
          capabilities: ["message", "query"],
        });
      });

      it("should reject if no targetAgentId", async () => {
        const handler = manager.getHandler();

        // Establish federation (peer is parent, we are child)
        await handler.handleRequest("peer-1", "federation/establish", {
          role: "parent",
          subscribeToStatus: false,
        });

        const response = await handler.handleRequest("peer-1", "federation/mount", {});

        expect(response.error).toBeDefined();
        expect(response.error?.code).toBe(4005);
      });

      it("should reject mount if callback denies", async () => {
        const onMountRequested = vi.fn().mockResolvedValue({
          denied: true,
          reason: "Agent is private",
        });

        const callbackManager = createFederationManager({
          callbacks: { onMountRequested },
        });
        callbackManager.setSendFunctions({
          sendRequest: mockSendRequest,
          sendMessage: mockSendMessage,
        });

        const handler = callbackManager.getHandler();

        // Establish federation (peer is parent, we are child)
        await handler.handleRequest("peer-1", "federation/establish", {
          role: "parent",
          subscribeToStatus: false,
        });

        const response = await handler.handleRequest("peer-1", "federation/mount", {
          targetAgentId: "agent-2",
        });

        expect(response.error).toBeDefined();
        expect(response.error?.code).toBe(4104); // MOUNT_DENIED
      });
    });

    describe("handleRequest with capability manager", () => {
      it("should check status subscription capability", async () => {
        const capabilityManager = createCapabilityManager();
        // Grant federation capability without status
        capabilityManager.grant("peer-1", [
          {
            type: "federated-hierarchy",
            canQueryAgents: true,
            canMount: true,
            canSubscribeStatus: false,
          },
        ]);

        const capManager = createFederationManager({ capabilityManager });
        capManager.setSendFunctions({
          sendRequest: mockSendRequest,
          sendMessage: mockSendMessage,
        });

        const handler = capManager.getHandler();

        // Try to establish with status subscription
        const response = await handler.handleRequest("peer-1", "federation/establish", {
          role: "child",
          parentAgentId: "agent-1",
          subscribeToStatus: true,
        });

        expect(response.error).toBeDefined();
        expect(response.error?.code).toBe(4001);
      });

      it("should check query capability", async () => {
        const capabilityManager = createCapabilityManager();
        capabilityManager.grant("peer-1", [
          {
            type: "federated-hierarchy",
            canQueryAgents: false,
            canMount: true,
            canSubscribeStatus: true,
          },
        ]);

        const capManager = createFederationManager({ capabilityManager });
        capManager.setSendFunctions({
          sendRequest: mockSendRequest,
          sendMessage: mockSendMessage,
        });

        const handler = capManager.getHandler();

        // Establish without status
        await handler.handleRequest("peer-1", "federation/establish", {
          role: "child",
          parentAgentId: "agent-1",
          subscribeToStatus: false,
        });

        // Query should fail
        const response = await handler.handleRequest("peer-1", "federation/getHierarchy", {});

        expect(response.error).toBeDefined();
        expect(response.error?.code).toBe(4001);
      });
    });

    describe("handleMessage - federation/status", () => {
      it("should call onStatusUpdate callback", () => {
        const onStatusUpdate = vi.fn();

        const callbackManager = createFederationManager({
          callbacks: { onStatusUpdate },
        });
        callbackManager.setSendFunctions({
          sendRequest: mockSendRequest,
          sendMessage: mockSendMessage,
        });

        const handler = callbackManager.getHandler();

        handler.handleMessage("peer-1", "federation/status", {
          federationId: "fed-123",
          agentId: "agent-1",
          status: "running",
          timestamp: Date.now(),
        });

        expect(onStatusUpdate).toHaveBeenCalledWith(
          expect.objectContaining({
            federationId: "fed-123",
            agentId: "agent-1",
            status: "running",
          })
        );
      });
    });

    describe("establish (outbound)", () => {
      it("should throw if not connected", async () => {
        const freshManager = createFederationManager();

        await expect(
          freshManager.establish("peer-2", {
            role: "parent",
            subscribeToStatus: false,
          })
        ).rejects.toThrow("not connected");
      });

      it("should send establish request", async () => {
        mockSendRequest.mockResolvedValue({
          result: { federationId: "fed-123", accepted: true },
        });

        const result = await manager.establish("peer-2", {
          role: "parent",
          subscribeToStatus: false,
        });

        expect(mockSendRequest).toHaveBeenCalledWith("peer-2", "federation/establish", {
          role: "parent",
          subscribeToStatus: false,
        });
        expect(result.accepted).toBe(true);
        expect(result.federationId).toBe("fed-123");
      });

      it("should store federation on success", async () => {
        mockSendRequest.mockResolvedValue({
          result: { federationId: "fed-123", accepted: true },
        });

        await manager.establish("peer-2", {
          role: "parent",
          subscribeToStatus: false,
        });

        const federation = manager.getFederation("fed-123");
        expect(federation).toBeDefined();
        expect(federation?.peerId).toBe("peer-2");
        expect(federation?.role).toBe("parent");
      });

      it("should not store federation on rejection", async () => {
        mockSendRequest.mockResolvedValue({
          result: { federationId: "", accepted: false, reason: "Declined" },
        });

        await manager.establish("peer-2", {
          role: "parent",
          subscribeToStatus: false,
        });

        expect(manager.listFederations()).toHaveLength(0);
      });

      it("should reject if already federated", async () => {
        mockSendRequest.mockResolvedValue({
          result: { federationId: "fed-123", accepted: true },
        });

        await manager.establish("peer-2", {
          role: "parent",
          subscribeToStatus: false,
        });

        const result = await manager.establish("peer-2", {
          role: "child",
          parentAgentId: "agent-1",
          subscribeToStatus: false,
        });

        expect(result.accepted).toBe(false);
        expect(result.reason).toContain("Already");
      });
    });

    describe("terminate (outbound)", () => {
      it("should send terminate request", async () => {
        mockSendRequest.mockResolvedValueOnce({
          result: { federationId: "fed-123", accepted: true },
        });

        await manager.establish("peer-2", {
          role: "parent",
          subscribeToStatus: false,
        });

        mockSendRequest.mockResolvedValueOnce({
          result: { terminated: true },
        });

        const result = await manager.terminate("fed-123");

        expect(result.terminated).toBe(true);
        expect(manager.getFederation("fed-123")).toBeUndefined();
      });

      it("should return false for unknown federation", async () => {
        const result = await manager.terminate("unknown");
        expect(result.terminated).toBe(false);
      });
    });

    describe("getHierarchy (outbound)", () => {
      it("should send hierarchy request", async () => {
        mockSendRequest.mockResolvedValueOnce({
          result: { federationId: "fed-123", accepted: true },
        });

        await manager.establish("peer-2", {
          role: "parent",
          subscribeToStatus: false,
        });

        mockSendRequest.mockResolvedValueOnce({
          result: {
            agents: [{ id: "agent-1", status: "idle", childCount: 0 }],
            relationships: [],
          },
        });

        const result = await manager.getHierarchy("fed-123", { depth: 2 });

        expect(mockSendRequest).toHaveBeenLastCalledWith(
          "peer-2",
          "federation/getHierarchy",
          { depth: 2 }
        );
        expect(result.agents).toHaveLength(1);
      });

      it("should throw for unknown federation", async () => {
        await expect(manager.getHierarchy("unknown", {})).rejects.toThrow();
      });

      it("should throw if not parent role", async () => {
        mockSendRequest.mockResolvedValueOnce({
          result: { federationId: "fed-123", accepted: true },
        });

        await manager.establish("peer-2", {
          role: "child",
          parentAgentId: "agent-1",
          subscribeToStatus: false,
        });

        await expect(manager.getHierarchy("fed-123", {})).rejects.toThrow();
      });
    });

    describe("mount (outbound)", () => {
      it("should send mount request and track mounted agent", async () => {
        mockSendRequest.mockResolvedValueOnce({
          result: { federationId: "fed-123", accepted: true },
        });

        await manager.establish("peer-2", {
          role: "parent",
          subscribeToStatus: false,
        });

        mockSendRequest.mockResolvedValueOnce({
          result: { mountedAs: "remote:agent-2", capabilities: ["message"] },
        });

        const result = await manager.mount("fed-123", "agent-2");

        expect(result.mountedAs).toBe("remote:agent-2");

        const federation = manager.getFederation("fed-123");
        expect(federation?.mountedAgents.get("remote:agent-2")).toBe("agent-2");
      });
    });

    describe("unmount", () => {
      it("should remove mounted agent", async () => {
        mockSendRequest.mockResolvedValueOnce({
          result: { federationId: "fed-123", accepted: true },
        });

        await manager.establish("peer-2", {
          role: "parent",
          subscribeToStatus: false,
        });

        mockSendRequest.mockResolvedValueOnce({
          result: { mountedAs: "remote:agent-2", capabilities: ["message"] },
        });

        await manager.mount("fed-123", "agent-2");

        manager.unmount("fed-123", "remote:agent-2");

        const federation = manager.getFederation("fed-123");
        expect(federation?.mountedAgents.has("remote:agent-2")).toBe(false);
      });
    });

    describe("listFederations", () => {
      it("should return empty array initially", () => {
        expect(manager.listFederations()).toEqual([]);
      });

      it("should return all federations", async () => {
        const handler = manager.getHandler();

        await handler.handleRequest("peer-1", "federation/establish", {
          role: "child",
          parentAgentId: "agent-1",
          subscribeToStatus: false,
        });

        await handler.handleRequest("peer-2", "federation/establish", {
          role: "parent",
          subscribeToStatus: true,
        });

        const federations = manager.listFederations();
        expect(federations).toHaveLength(2);
      });
    });

    describe("getFederationByPeer", () => {
      it("should return undefined for unknown peer", () => {
        expect(manager.getFederationByPeer("unknown")).toBeUndefined();
      });

      it("should return federation for known peer", async () => {
        const handler = manager.getHandler();

        await handler.handleRequest("peer-1", "federation/establish", {
          role: "child",
          parentAgentId: "agent-1",
          subscribeToStatus: false,
        });

        const federation = manager.getFederationByPeer("peer-1");
        expect(federation).toBeDefined();
        expect(federation?.peerId).toBe("peer-1");
      });
    });

    describe("pushStatusUpdate", () => {
      it("should send status to subscribed federations", async () => {
        const handler = manager.getHandler();

        // Establish as child with subscription
        await handler.handleRequest("peer-1", "federation/establish", {
          role: "parent",
          subscribeToStatus: true,
        });

        manager.pushStatusUpdate("agent-1", "running", "Processing...");

        expect(mockSendMessage).toHaveBeenCalledWith(
          "peer-1",
          "federation/status",
          expect.objectContaining({
            agentId: "agent-1",
            status: "running",
            message: "Processing...",
          })
        );
      });

      it("should not send to non-subscribed federations", async () => {
        const handler = manager.getHandler();

        // Establish as child without subscription
        await handler.handleRequest("peer-1", "federation/establish", {
          role: "parent",
          subscribeToStatus: false,
        });

        manager.pushStatusUpdate("agent-1", "running");

        expect(mockSendMessage).not.toHaveBeenCalled();
      });

      it("should not send to federations where we are parent", async () => {
        const handler = manager.getHandler();

        // Establish as parent (they are child)
        await handler.handleRequest("peer-1", "federation/establish", {
          role: "child",
          parentAgentId: "agent-1",
          subscribeToStatus: true,
        });

        manager.pushStatusUpdate("agent-1", "running");

        expect(mockSendMessage).not.toHaveBeenCalled();
      });
    });

    describe("peer address parsing", () => {
      it("should extract peer ID from simple address", async () => {
        const handler = manager.getHandler();

        await handler.handleRequest("peer-1", "federation/establish", {
          role: "child",
          parentAgentId: "agent-1",
          subscribeToStatus: false,
        });

        const federation = manager.getFederationByPeer("peer-1");
        expect(federation?.peerId).toBe("peer-1");
      });

      it("should extract peer ID from address with path", async () => {
        const handler = manager.getHandler();

        await handler.handleRequest("peer-1/agent-1/sub", "federation/establish", {
          role: "child",
          parentAgentId: "agent-1",
          subscribeToStatus: false,
        });

        const federation = manager.getFederationByPeer("peer-1");
        expect(federation?.peerId).toBe("peer-1");
      });
    });

    describe("unknown methods", () => {
      it("should reject unknown federation methods", async () => {
        const handler = manager.getHandler();

        const response = await handler.handleRequest("peer-1", "federation/unknown", {});

        expect(response.error).toBeDefined();
        expect(response.error?.code).toBe(4005);
      });
    });
  });
});
