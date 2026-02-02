/**
 * Tests for MAP adapter types
 */

import { describe, it, expect } from "vitest";
import {
  createParticipantId,
  createSessionId,
  createSubscriptionId,
  type ParticipantId,
  type SessionId,
  type SubscriptionId,
  type ParticipantType,
  type ParticipantCapabilities,
  type ConnectedParticipant,
  type AuthCredentials,
  type AuthResult,
  type MAPEventType,
  type SubscriptionFilter,
  type Subscription,
  type EventNotification,
  type ConnectionEventType,
  type ConnectionEvent,
} from "../adapter/types.js";

describe("Branded ID creation functions", () => {
  describe("createParticipantId", () => {
    it("creates a ParticipantId from string", () => {
      const id = createParticipantId("participant-123");
      expect(id).toBe("participant-123");
      // Type should be ParticipantId (branded string)
      const _typeCheck: ParticipantId = id;
    });

    it("handles empty string", () => {
      const id = createParticipantId("");
      expect(id).toBe("");
    });

    it("handles special characters", () => {
      const id = createParticipantId("p-123_abc.xyz");
      expect(id).toBe("p-123_abc.xyz");
    });
  });

  describe("createSessionId", () => {
    it("creates a SessionId from string", () => {
      const id = createSessionId("session-456");
      expect(id).toBe("session-456");
      const _typeCheck: SessionId = id;
    });

    it("handles UUID format", () => {
      const id = createSessionId("550e8400-e29b-41d4-a716-446655440000");
      expect(id).toBe("550e8400-e29b-41d4-a716-446655440000");
    });
  });

  describe("createSubscriptionId", () => {
    it("creates a SubscriptionId from string", () => {
      const id = createSubscriptionId("sub-789");
      expect(id).toBe("sub-789");
      const _typeCheck: SubscriptionId = id;
    });
  });
});

describe("Type definitions", () => {
  describe("ParticipantType", () => {
    it("accepts valid participant types", () => {
      const types: ParticipantType[] = ["client", "agent", "gateway"];
      expect(types).toHaveLength(3);
    });
  });

  describe("ParticipantCapabilities", () => {
    it("accepts full capabilities object", () => {
      const caps: ParticipantCapabilities = {
        canQuery: true,
        canSubscribe: true,
        canMessage: true,
        canSpawn: false,
        canStop: false,
        canManageScopes: false,
        canUpdatePermissions: false,
      };
      expect(caps.canQuery).toBe(true);
      expect(caps.canSpawn).toBe(false);
    });

    it("accepts partial capabilities object", () => {
      const caps: ParticipantCapabilities = {
        canQuery: true,
      };
      expect(caps.canQuery).toBe(true);
      expect(caps.canMessage).toBeUndefined();
    });

    it("accepts empty capabilities object", () => {
      const caps: ParticipantCapabilities = {};
      expect(Object.keys(caps)).toHaveLength(0);
    });
  });

  describe("ConnectedParticipant", () => {
    it("accepts valid participant object", () => {
      const participant: ConnectedParticipant = {
        id: createParticipantId("p-1"),
        type: "client",
        name: "Test Client",
        capabilities: { canQuery: true },
        sessionId: createSessionId("s-1"),
        connectedAt: Date.now(),
        metadata: { version: "1.0" },
      };
      expect(participant.type).toBe("client");
      expect(participant.capabilities.canQuery).toBe(true);
    });

    it("accepts minimal participant object", () => {
      const participant: ConnectedParticipant = {
        id: createParticipantId("p-2"),
        type: "agent",
        capabilities: {},
        sessionId: createSessionId("s-2"),
        connectedAt: 0,
      };
      expect(participant.name).toBeUndefined();
      expect(participant.metadata).toBeUndefined();
    });
  });

  describe("AuthCredentials", () => {
    it("accepts token auth", () => {
      const creds: AuthCredentials = {
        method: "token",
        token: "abc123",
      };
      expect(creds.method).toBe("token");
    });

    it("accepts method-only auth", () => {
      const creds: AuthCredentials = {
        method: "none",
      };
      expect(creds.token).toBeUndefined();
    });

    it("accepts auth with params", () => {
      const creds: AuthCredentials = {
        method: "oauth",
        token: "bearer-token",
        params: { scope: "read write" },
      };
      expect(creds.params?.scope).toBe("read write");
    });
  });

  describe("AuthResult", () => {
    it("accepts success result", () => {
      const result: AuthResult = {
        allowed: true,
        capabilities: { canQuery: true, canSubscribe: true },
        participantId: createParticipantId("p-new"),
      };
      expect(result.allowed).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it("accepts failure result", () => {
      const result: AuthResult = {
        allowed: false,
        error: "Invalid token",
      };
      expect(result.allowed).toBe(false);
      expect(result.capabilities).toBeUndefined();
    });
  });

  describe("MAPEventType", () => {
    it("includes all expected event types", () => {
      const eventTypes: MAPEventType[] = [
        "agent.registered",
        "agent.unregistered",
        "agent.state.changed",
        "scope.created",
        "scope.deleted",
        "scope.member.joined",
        "scope.member.left",
        "message.sent",
        "message.delivered",
        "permissions.updated",
        "task.created",
        "task.assigned",
        "task.completed",
        "task.failed",
      ];
      expect(eventTypes).toHaveLength(14);
    });
  });

  describe("SubscriptionFilter", () => {
    it("accepts full filter", () => {
      const filter: SubscriptionFilter = {
        eventTypes: ["agent.registered", "agent.unregistered"],
        agents: ["agent-1", "agent-2"],
        scopes: ["scope-1"],
        subtree: "root-agent",
        lineage: "child-agent",
      };
      expect(filter.eventTypes).toHaveLength(2);
      expect(filter.agents).toHaveLength(2);
    });

    it("accepts empty filter", () => {
      const filter: SubscriptionFilter = {};
      expect(Object.keys(filter)).toHaveLength(0);
    });

    it("accepts hierarchy filters only", () => {
      const filter: SubscriptionFilter = {
        subtree: "parent-agent",
      };
      expect(filter.subtree).toBe("parent-agent");
      expect(filter.eventTypes).toBeUndefined();
    });
  });

  describe("Subscription", () => {
    it("accepts active subscription", () => {
      const sub: Subscription = {
        id: createSubscriptionId("sub-1"),
        participantId: createParticipantId("p-1"),
        filter: { eventTypes: ["message.sent"] },
        createdAt: Date.now(),
        paused: false,
        lastEventId: "evt-123",
        lastSequence: 42,
      };
      expect(sub.paused).toBe(false);
      expect(sub.lastSequence).toBe(42);
    });

    it("accepts paused subscription", () => {
      const sub: Subscription = {
        id: createSubscriptionId("sub-2"),
        participantId: createParticipantId("p-1"),
        filter: {},
        createdAt: 0,
        paused: true,
      };
      expect(sub.paused).toBe(true);
      expect(sub.lastEventId).toBeUndefined();
    });
  });

  describe("EventNotification", () => {
    it("accepts full event", () => {
      const event: EventNotification = {
        eventId: "evt-001",
        type: "agent.registered",
        timestamp: Date.now(),
        data: { agentName: "worker-1" },
        causedBy: ["evt-000"],
        agentId: "agent-1",
        scopeId: "scope-1",
        sequence: 1,
      };
      expect(event.type).toBe("agent.registered");
      expect(event.causedBy).toHaveLength(1);
    });

    it("accepts minimal event", () => {
      const event: EventNotification = {
        eventId: "evt-002",
        type: "message.sent",
        timestamp: 0,
        data: null,
      };
      expect(event.causedBy).toBeUndefined();
      expect(event.agentId).toBeUndefined();
    });
  });

  describe("ConnectionEvent", () => {
    it("accepts connected event", () => {
      const event: ConnectionEvent = {
        type: "connected",
        participantId: createParticipantId("p-1"),
        timestamp: Date.now(),
      };
      expect(event.type).toBe("connected");
    });

    it("accepts disconnected event with reason", () => {
      const event: ConnectionEvent = {
        type: "disconnected",
        participantId: createParticipantId("p-1"),
        timestamp: Date.now(),
        reason: "Client requested disconnect",
      };
      expect(event.reason).toBe("Client requested disconnect");
    });

    it("accepts error event", () => {
      const event: ConnectionEvent = {
        type: "error",
        participantId: createParticipantId("p-1"),
        timestamp: Date.now(),
        error: new Error("Connection lost"),
      };
      expect(event.error?.message).toBe("Connection lost");
    });

    it("accepts all connection event types", () => {
      const types: ConnectionEventType[] = [
        "connected",
        "disconnected",
        "reconnecting",
        "reconnected",
        "error",
      ];
      expect(types).toHaveLength(5);
    });
  });
});
