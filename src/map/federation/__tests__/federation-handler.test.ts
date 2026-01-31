/**
 * Tests for FederationHandler
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createFederationHandler,
  federatedAddressToPeerAddress,
  getSystemFromAddress,
  createCapabilityExchangeHandler,
  unwrapFederatedMessage,
} from "../federation-handler.js";
import type { PeerManager } from "../../../peer/peer-manager.js";
import type { MAPFederationConfig, FederationCapabilities, FederationEvent } from "../types.js";

// =============================================================================
// Mock PeerManager
// =============================================================================

function createMockPeerManager(): PeerManager {
  return {
    registerTransport: vi.fn(),
    hasTransport: vi.fn(() => true),
    sendMessage: vi.fn(() => Promise.resolve()),
    sendRequest: vi.fn(() =>
      Promise.resolve({
        result: {
          systemId: "peer-system",
          messaging: { canSend: true, canReceive: true },
          lifecycle: { canSpawn: false, canStop: false },
          query: { canListAgents: true, canGetAgent: true, canQueryHierarchy: true },
          extensions: ["_macro/task/*"],
        } satisfies FederationCapabilities,
      })
    ),
    respondToRequest: vi.fn(),
    getPeerMessages: vi.fn(() => []),
    acknowledgePeerMessages: vi.fn(),
    parseAddress: vi.fn((addr) => ({ peerId: addr })),
    deliverMessage: vi.fn(() => "msg-1"),
    deliverRequest: vi.fn(() => Promise.resolve({ result: {} })),
  } as unknown as PeerManager;
}

function createConfig(overrides?: Partial<MAPFederationConfig>): MAPFederationConfig {
  return {
    enabled: true,
    systemId: "local-system",
    systemInfo: { name: "Test System", version: "1.0.0" },
    ...overrides,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe("createFederationHandler", () => {
  let peerManager: PeerManager;
  let config: MAPFederationConfig;

  beforeEach(() => {
    peerManager = createMockPeerManager();
    config = createConfig();
  });

  describe("connect", () => {
    it("connects to a peer and returns capabilities", async () => {
      const handler = createFederationHandler(peerManager, config);

      const capabilities = await handler.connect({
        systemId: "peer-system",
        endpoint: "ws://peer:8080",
      });

      expect(capabilities.systemId).toBe("peer-system");
      expect(capabilities.messaging.canSend).toBe(true);
      expect(peerManager.sendRequest).toHaveBeenCalledWith(
        "local-system",
        "peer-system",
        expect.objectContaining({
          method: "_federation/capabilities",
        })
      );
    });

    it("throws when federation is disabled", async () => {
      const handler = createFederationHandler(peerManager, {
        ...config,
        enabled: false,
      });

      await expect(
        handler.connect({ systemId: "peer", endpoint: "ws://peer:8080" })
      ).rejects.toThrow("Federation is not enabled");
    });

    it("throws when already connected", async () => {
      const handler = createFederationHandler(peerManager, config);

      await handler.connect({ systemId: "peer-system", endpoint: "ws://peer:8080" });

      await expect(
        handler.connect({ systemId: "peer-system", endpoint: "ws://peer:8080" })
      ).rejects.toThrow("Already connected to peer-system");
    });

    it("emits connecting and connected events", async () => {
      const handler = createFederationHandler(peerManager, config);
      const events: FederationEvent[] = [];
      handler.on((event) => events.push(event));

      await handler.connect({ systemId: "peer-system", endpoint: "ws://peer:8080" });

      expect(events).toHaveLength(2);
      expect(events[0].type).toBe("peer:connecting");
      expect(events[1].type).toBe("peer:connected");
    });

    it("emits error event on connection failure", async () => {
      vi.mocked(peerManager.sendRequest).mockRejectedValueOnce(
        new Error("Connection refused")
      );

      const handler = createFederationHandler(peerManager, config);
      const events: FederationEvent[] = [];
      handler.on((event) => events.push(event));

      await expect(
        handler.connect({ systemId: "peer-system", endpoint: "ws://peer:8080" })
      ).rejects.toThrow();

      expect(events.some((e) => e.type === "peer:error")).toBe(true);
    });
  });

  describe("disconnect", () => {
    it("disconnects from a peer", async () => {
      const handler = createFederationHandler(peerManager, config);
      await handler.connect({ systemId: "peer-system", endpoint: "ws://peer:8080" });

      await handler.disconnect("peer-system");

      expect(handler.getPeer("peer-system")).toBeUndefined();
    });

    it("throws when not connected", async () => {
      const handler = createFederationHandler(peerManager, config);

      await expect(handler.disconnect("unknown")).rejects.toThrow(
        "Not connected to unknown"
      );
    });

    it("emits disconnected event", async () => {
      const handler = createFederationHandler(peerManager, config);
      const events: FederationEvent[] = [];
      handler.on((event) => events.push(event));

      await handler.connect({ systemId: "peer-system", endpoint: "ws://peer:8080" });
      await handler.disconnect("peer-system");

      expect(events.some((e) => e.type === "peer:disconnected")).toBe(true);
    });
  });

  describe("getPeer", () => {
    it("returns connected peer", async () => {
      const handler = createFederationHandler(peerManager, config);
      await handler.connect({ systemId: "peer-system", endpoint: "ws://peer:8080" });

      const peer = handler.getPeer("peer-system");

      expect(peer).toBeDefined();
      expect(peer?.systemId).toBe("peer-system");
      expect(peer?.status).toBe("connected");
    });

    it("returns undefined for unknown peer", () => {
      const handler = createFederationHandler(peerManager, config);
      expect(handler.getPeer("unknown")).toBeUndefined();
    });
  });

  describe("listPeers", () => {
    it("returns empty array initially", () => {
      const handler = createFederationHandler(peerManager, config);
      expect(handler.listPeers()).toEqual([]);
    });

    it("returns all connected peers", async () => {
      const handler = createFederationHandler(peerManager, config);
      await handler.connect({ systemId: "peer-1", endpoint: "ws://peer1:8080" });

      vi.mocked(peerManager.sendRequest).mockResolvedValueOnce({
        result: {
          systemId: "peer-2",
          messaging: { canSend: true, canReceive: true },
          lifecycle: { canSpawn: false, canStop: false },
          query: { canListAgents: true, canGetAgent: true, canQueryHierarchy: true },
          extensions: [],
        },
      });

      await handler.connect({ systemId: "peer-2", endpoint: "ws://peer2:8080" });

      const peers = handler.listPeers();
      expect(peers).toHaveLength(2);
      expect(peers.map((p) => p.systemId)).toContain("peer-1");
      expect(peers.map((p) => p.systemId)).toContain("peer-2");
    });
  });

  describe("getCapabilities", () => {
    it("returns peer capabilities", async () => {
      const handler = createFederationHandler(peerManager, config);
      await handler.connect({ systemId: "peer-system", endpoint: "ws://peer:8080" });

      const caps = handler.getCapabilities("peer-system");

      expect(caps?.systemId).toBe("peer-system");
      expect(caps?.messaging.canSend).toBe(true);
    });

    it("returns undefined for unknown peer", () => {
      const handler = createFederationHandler(peerManager, config);
      expect(handler.getCapabilities("unknown")).toBeUndefined();
    });
  });

  describe("isConnected", () => {
    it("returns true for connected peer", async () => {
      const handler = createFederationHandler(peerManager, config);
      await handler.connect({ systemId: "peer-system", endpoint: "ws://peer:8080" });

      expect(handler.isConnected("peer-system")).toBe(true);
    });

    it("returns false for unknown peer", () => {
      const handler = createFederationHandler(peerManager, config);
      expect(handler.isConnected("unknown")).toBe(false);
    });
  });

  describe("sendMessage", () => {
    it("sends message to connected peer", async () => {
      const handler = createFederationHandler(peerManager, config);
      await handler.connect({ systemId: "peer-system", endpoint: "ws://peer:8080" });

      await handler.sendMessage("peer-system", { type: "test" });

      expect(peerManager.sendMessage).toHaveBeenCalledWith(
        "local-system",
        "peer-system",
        expect.objectContaining({
          type: "_federation/message",
          payload: expect.objectContaining({
            message: { type: "test" },
            federation: expect.objectContaining({
              sourceSystem: "local-system",
              targetSystem: "peer-system",
            }),
          }),
        })
      );
    });

    it("throws when federation is disabled", async () => {
      const handler = createFederationHandler(peerManager, {
        ...config,
        enabled: false,
      });

      await expect(
        handler.sendMessage("peer-system", { type: "test" })
      ).rejects.toThrow("Federation is not enabled");
    });

    it("throws when not connected", async () => {
      const handler = createFederationHandler(peerManager, config);

      await expect(
        handler.sendMessage("unknown", { type: "test" })
      ).rejects.toThrow("Not connected to unknown");
    });
  });

  describe("sendRequest", () => {
    it("sends request to connected peer", async () => {
      const handler = createFederationHandler(peerManager, config);
      await handler.connect({ systemId: "peer-system", endpoint: "ws://peer:8080" });

      vi.mocked(peerManager.sendRequest).mockResolvedValueOnce({
        result: { data: "response" },
      });

      const result = await handler.sendRequest("peer-system", "testMethod", {
        param: 1,
      });

      expect(result).toEqual({ data: "response" });
    });

    it("throws when peer returns error", async () => {
      const handler = createFederationHandler(peerManager, config);
      await handler.connect({ systemId: "peer-system", endpoint: "ws://peer:8080" });

      vi.mocked(peerManager.sendRequest).mockResolvedValueOnce({
        error: { code: -1, message: "Method not allowed" },
      });

      await expect(
        handler.sendRequest("peer-system", "restrictedMethod")
      ).rejects.toThrow("Method not allowed");
    });
  });

  describe("on", () => {
    it("returns unsubscribe function", async () => {
      const handler = createFederationHandler(peerManager, config);
      const events: FederationEvent[] = [];
      const unsubscribe = handler.on((event) => events.push(event));

      await handler.connect({ systemId: "peer-system", endpoint: "ws://peer:8080" });
      expect(events.length).toBeGreaterThan(0);

      const eventCount = events.length;
      unsubscribe();

      await handler.disconnect("peer-system");
      // No new events after unsubscribe
      expect(events.length).toBe(eventCount);
    });
  });

  describe("getConfig", () => {
    it("returns the configuration", () => {
      const handler = createFederationHandler(peerManager, config);
      expect(handler.getConfig()).toEqual(config);
    });
  });

  describe("getLocalCapabilities", () => {
    it("returns local capabilities", () => {
      const handler = createFederationHandler(peerManager, config);
      const caps = handler.getLocalCapabilities();

      expect(caps.systemId).toBe("local-system");
      expect(caps.systemInfo?.name).toBe("Test System");
      expect(caps.messaging.canSend).toBe(true);
      expect(caps.extensions).toContain("_macro/task/*");
    });
  });
});

describe("federatedAddressToPeerAddress", () => {
  it("converts federated agent address", () => {
    const addr = federatedAddressToPeerAddress({
      system: "example.com/macro-agent/prod",
      agent: "worker-1",
    });
    expect(addr).toBe("example.com/macro-agent/prod/worker-1");
  });

  it("converts federated scope address to system root", () => {
    const addr = federatedAddressToPeerAddress({
      system: "example.com/macro-agent/prod",
      scope: "scope-1",
    });
    expect(addr).toBe("example.com/macro-agent/prod");
  });
});

describe("getSystemFromAddress", () => {
  it("extracts system from federated agent address", () => {
    const system = getSystemFromAddress({
      system: "example.com/macro-agent/prod",
      agent: "worker-1",
    });
    expect(system).toBe("example.com/macro-agent/prod");
  });

  it("extracts system from federated scope address", () => {
    const system = getSystemFromAddress({
      system: "example.com/macro-agent/prod",
      scope: "scope-1",
    });
    expect(system).toBe("example.com/macro-agent/prod");
  });
});

describe("createCapabilityExchangeHandler", () => {
  it("returns capabilities for exchange method", () => {
    const caps: FederationCapabilities = {
      systemId: "test-system",
      messaging: { canSend: true, canReceive: true },
      lifecycle: { canSpawn: false, canStop: false },
      query: { canListAgents: true, canGetAgent: true, canQueryHierarchy: true },
      extensions: [],
    };

    const handler = createCapabilityExchangeHandler(caps);
    const response = handler({ method: "_federation/capabilities" });

    expect(response.result).toEqual(caps);
    expect(response.error).toBeUndefined();
  });

  it("returns error for unknown method", () => {
    const caps: FederationCapabilities = {
      systemId: "test-system",
      messaging: { canSend: true, canReceive: true },
      lifecycle: { canSpawn: false, canStop: false },
      query: { canListAgents: true, canGetAgent: true, canQueryHierarchy: true },
      extensions: [],
    };

    const handler = createCapabilityExchangeHandler(caps);
    const response = handler({ method: "unknown/method" });

    expect(response.error).toBeDefined();
    expect(response.error?.code).toBe(-32601);
  });
});

describe("unwrapFederatedMessage", () => {
  it("unwraps federated message", () => {
    const message = {
      type: "_federation/message",
      payload: {
        message: { data: "test" },
        federation: {
          sourceSystem: "a",
          targetSystem: "b",
          timestamp: Date.now(),
        },
      },
    };

    const unwrapped = unwrapFederatedMessage(message);
    expect(unwrapped).toEqual({ data: "test" });
  });

  it("returns null for non-federated message", () => {
    const message = {
      type: "regular/message",
      payload: { data: "test" },
    };

    expect(unwrapFederatedMessage(message)).toBeNull();
  });

  it("returns null for invalid envelope", () => {
    const message = {
      type: "_federation/message",
      payload: { invalid: "structure" },
    };

    expect(unwrapFederatedMessage(message)).toBeNull();
  });
});
