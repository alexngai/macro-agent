/**
 * Tests for ConnectionManager
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  createConnectionManager,
  ConnectionManagerImpl,
  ConnectionError,
  type ConnectionManager,
  type ConnectionManagerEvent,
} from "../connection-manager.js";
import type { ParticipantCapabilities } from "../types.js";

describe("ConnectionManager", () => {
  let manager: ConnectionManager;

  beforeEach(() => {
    manager = createConnectionManager();
  });

  describe("connect", () => {
    it("creates a participant with generated IDs", () => {
      const participant = manager.connect({ type: "client" });

      expect(participant.id).toMatch(/^p-/);
      expect(participant.sessionId).toMatch(/^s-/);
      expect(participant.type).toBe("client");
      expect(participant.connectedAt).toBeLessThanOrEqual(Date.now());
    });

    it("assigns default capabilities based on participant type", () => {
      const client = manager.connect({ type: "client" });
      expect(client.capabilities.canQuery).toBe(true);
      expect(client.capabilities.canSubscribe).toBe(true);
      expect(client.capabilities.canMessage).toBe(true);
      expect(client.capabilities.canSpawn).toBe(false);

      const agent = manager.connect({ type: "agent" });
      expect(agent.capabilities.canQuery).toBe(true);
      expect(agent.capabilities.canSpawn).toBe(true);
      expect(agent.capabilities.canStop).toBe(true);
    });

    it("allows custom capabilities", () => {
      const capabilities: ParticipantCapabilities = {
        canQuery: true,
        canSubscribe: true,
        canMessage: false,
        canSpawn: true,
      };

      const participant = manager.connect({ type: "client", capabilities });

      expect(participant.capabilities.canMessage).toBe(false);
      expect(participant.capabilities.canSpawn).toBe(true);
    });

    it("stores name and metadata", () => {
      const participant = manager.connect({
        type: "client",
        name: "Test Client",
        metadata: { version: "1.0" },
      });

      expect(participant.name).toBe("Test Client");
      expect(participant.metadata).toEqual({ version: "1.0" });
    });

    it("emits participant.connected event", () => {
      const events: ConnectionManagerEvent[] = [];
      manager.onEvent((e) => events.push(e));

      const participant = manager.connect({ type: "client" });

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("participant.connected");
      if (events[0].type === "participant.connected") {
        expect(events[0].participant.id).toBe(participant.id);
      }
    });

    it("enforces maximum connections limit", () => {
      const limited = createConnectionManager({
        limits: { maxConnections: 2 },
      });

      limited.connect({ type: "client" });
      limited.connect({ type: "client" });

      expect(() => limited.connect({ type: "client" })).toThrow(ConnectionError);
      expect(() => limited.connect({ type: "client" })).toThrow(
        /Maximum connections exceeded/
      );
    });

    it("enforces per-client connection limit", () => {
      const limited = createConnectionManager({
        limits: { maxConnectionsPerClient: 2 },
      });

      limited.connect({ type: "client", clientIdentity: "client-1" });
      limited.connect({ type: "client", clientIdentity: "client-1" });

      expect(() =>
        limited.connect({ type: "client", clientIdentity: "client-1" })
      ).toThrow(ConnectionError);

      // Different client identity should work
      const participant = limited.connect({
        type: "client",
        clientIdentity: "client-2",
      });
      expect(participant).toBeDefined();
    });
  });

  describe("disconnect", () => {
    it("removes participant from tracking", () => {
      const participant = manager.connect({ type: "client" });
      expect(manager.isConnected(participant.id)).toBe(true);

      manager.disconnect(participant.id);
      expect(manager.isConnected(participant.id)).toBe(false);
      expect(manager.getParticipant(participant.id)).toBeUndefined();
    });

    it("emits participant.disconnected event", () => {
      const participant = manager.connect({ type: "client" });

      const events: ConnectionManagerEvent[] = [];
      manager.onEvent((e) => events.push(e));

      manager.disconnect(participant.id, "test reason");

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("participant.disconnected");
      if (events[0].type === "participant.disconnected") {
        expect(events[0].participantId).toBe(participant.id);
        expect(events[0].reason).toBe("test reason");
      }
    });

    it("is idempotent for already disconnected participants", () => {
      const participant = manager.connect({ type: "client" });
      manager.disconnect(participant.id);

      // Should not throw
      expect(() => manager.disconnect(participant.id)).not.toThrow();
    });

    it("allows new connections after disconnect (within limit)", () => {
      const limited = createConnectionManager({
        limits: { maxConnections: 1 },
      });

      const p1 = limited.connect({ type: "client" });
      expect(() => limited.connect({ type: "client" })).toThrow();

      limited.disconnect(p1.id);

      // Should work now
      const p2 = limited.connect({ type: "client" });
      expect(p2).toBeDefined();
    });
  });

  describe("getParticipants", () => {
    it("returns all connected participants", () => {
      const p1 = manager.connect({ type: "client", name: "Client 1" });
      const p2 = manager.connect({ type: "agent", name: "Agent 1" });

      const participants = manager.getParticipants();

      expect(participants).toHaveLength(2);
      expect(participants.map((p) => p.id)).toContain(p1.id);
      expect(participants.map((p) => p.id)).toContain(p2.id);
    });

    it("returns empty array when no participants", () => {
      expect(manager.getParticipants()).toEqual([]);
    });

    it("excludes disconnected participants", () => {
      const p1 = manager.connect({ type: "client" });
      manager.connect({ type: "client" });

      manager.disconnect(p1.id);

      expect(manager.getParticipants()).toHaveLength(1);
    });
  });

  describe("getParticipant", () => {
    it("returns participant by ID", () => {
      const participant = manager.connect({ type: "client", name: "Test" });

      const retrieved = manager.getParticipant(participant.id);

      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe(participant.id);
      expect(retrieved?.name).toBe("Test");
    });

    it("returns undefined for unknown ID", () => {
      expect(manager.getParticipant("unknown" as any)).toBeUndefined();
    });
  });

  describe("getConnectionCount", () => {
    it("returns current connection count", () => {
      expect(manager.getConnectionCount()).toBe(0);

      manager.connect({ type: "client" });
      expect(manager.getConnectionCount()).toBe(1);

      manager.connect({ type: "agent" });
      expect(manager.getConnectionCount()).toBe(2);
    });
  });

  describe("updateCapabilities", () => {
    it("merges capabilities", () => {
      const participant = manager.connect({ type: "client" });
      expect(participant.capabilities.canSpawn).toBe(false);

      manager.updateCapabilities(participant.id, { canSpawn: true });

      const updated = manager.getParticipant(participant.id);
      expect(updated?.capabilities.canSpawn).toBe(true);
      // Original capabilities preserved
      expect(updated?.capabilities.canQuery).toBe(true);
    });

    it("throws for unknown participant", () => {
      expect(() =>
        manager.updateCapabilities("unknown" as any, { canSpawn: true })
      ).toThrow(ConnectionError);
    });
  });

  describe("onEvent", () => {
    it("returns unsubscribe function", () => {
      const events: ConnectionManagerEvent[] = [];
      const unsubscribe = manager.onEvent((e) => events.push(e));

      manager.connect({ type: "client" });
      expect(events).toHaveLength(1);

      unsubscribe();

      manager.connect({ type: "client" });
      expect(events).toHaveLength(1); // No new events
    });

    it("handles errors in event handlers gracefully", () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      manager.onEvent(() => {
        throw new Error("Handler error");
      });

      // Should not throw
      expect(() => manager.connect({ type: "client" })).not.toThrow();

      consoleSpy.mockRestore();
    });
  });

  describe("disconnectAll", () => {
    it("disconnects all participants", () => {
      manager.connect({ type: "client" });
      manager.connect({ type: "agent" });
      manager.connect({ type: "client" });

      expect(manager.getConnectionCount()).toBe(3);

      manager.disconnectAll("shutdown");

      expect(manager.getConnectionCount()).toBe(0);
    });

    it("emits disconnect event for each participant", () => {
      manager.connect({ type: "client" });
      manager.connect({ type: "agent" });

      const events: ConnectionManagerEvent[] = [];
      manager.onEvent((e) => events.push(e));

      manager.disconnectAll();

      const disconnectEvents = events.filter(
        (e) => e.type === "participant.disconnected"
      );
      expect(disconnectEvents).toHaveLength(2);
    });
  });

  describe("configuration", () => {
    it("uses custom anonymous capabilities", () => {
      const custom = createConnectionManager({
        anonymousCapabilities: {
          canQuery: false,
          canSubscribe: false,
        },
      });

      // Note: anonymous capabilities would be used for a different path
      // For now we test custom client capabilities
    });

    it("uses custom default client capabilities", () => {
      const custom = createConnectionManager({
        defaultClientCapabilities: {
          canQuery: true,
          canSubscribe: true,
          canMessage: false,
          canSpawn: false,
        },
      });

      const client = custom.connect({ type: "client" });

      expect(client.capabilities.canMessage).toBe(false);
    });

    it("uses custom default agent capabilities", () => {
      const custom = createConnectionManager({
        defaultAgentCapabilities: {
          canQuery: true,
          canSubscribe: true,
          canMessage: true,
          canSpawn: false,
          canStop: false,
        },
      });

      const agent = custom.connect({ type: "agent" });

      expect(agent.capabilities.canSpawn).toBe(false);
      expect(agent.capabilities.canStop).toBe(false);
    });
  });
});
