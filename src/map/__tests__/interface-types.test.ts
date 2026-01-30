/**
 * Tests for MAP adapter interface types
 *
 * These tests verify that the interface types are properly defined
 * and can be used correctly at compile time and runtime.
 */

import { describe, it, expect } from "vitest";
import type {
  Stream,
  ExtensionContext,
  ExtensionHandler,
  AgentExposure,
  ScopeExposure,
  EventExposure,
  SystemExposure,
  AdapterLimits,
  MAPAdapterConfig,
  MessagePayload,
  SendResult,
  AgentFilter,
  AgentInfo,
  ScopeInfo,
  AdapterEvent,
  MAPAdapter,
} from "../adapter/interface.js";
import { createParticipantId, createSessionId } from "../adapter/types.js";

describe("Interface type definitions", () => {
  describe("ExtensionContext", () => {
    it("accepts valid context", () => {
      const context: ExtensionContext = {
        participantId: createParticipantId("p-1"),
        capabilities: { canQuery: true, canMessage: true },
        sessionId: "session-123",
      };
      expect(context.participantId).toBe("p-1");
      expect(context.capabilities.canQuery).toBe(true);
    });
  });

  describe("ExtensionHandler", () => {
    it("can be defined as async function", async () => {
      const handler: ExtensionHandler = async (context, params) => {
        return { result: "ok", contextId: context.participantId };
      };

      const result = await handler(
        {
          participantId: createParticipantId("p-1"),
          capabilities: {},
          sessionId: "s-1",
        },
        { input: "test" }
      );

      expect(result).toEqual({ result: "ok", contextId: "p-1" });
    });
  });

  describe("AgentExposure", () => {
    it("accepts full exposure config", () => {
      const exposure: AgentExposure = {
        publicByDefault: true,
        publicAgents: ["worker-*", "coordinator-*"],
        hiddenAgents: ["_internal-*", "monitor-*"],
      };
      expect(exposure.publicByDefault).toBe(true);
      expect(exposure.publicAgents).toHaveLength(2);
      expect(exposure.hiddenAgents).toHaveLength(2);
    });

    it("accepts partial exposure config", () => {
      const exposure: AgentExposure = {
        publicByDefault: false,
      };
      expect(exposure.publicByDefault).toBe(false);
      expect(exposure.publicAgents).toBeUndefined();
    });
  });

  describe("ScopeExposure", () => {
    it("accepts scope exposure config", () => {
      const exposure: ScopeExposure = {
        publicByDefault: true,
        publicScopes: ["public-*"],
        hiddenScopes: ["private-*"],
      };
      expect(exposure.publicByDefault).toBe(true);
    });
  });

  describe("EventExposure", () => {
    it("accepts event exposure config", () => {
      const exposure: EventExposure = {
        exposedTypes: ["agent.registered", "agent.unregistered"],
        hiddenTypes: ["message.sent"],
      };
      expect(exposure.exposedTypes).toHaveLength(2);
      expect(exposure.hiddenTypes).toHaveLength(1);
    });
  });

  describe("SystemExposure", () => {
    it("accepts full system exposure", () => {
      const exposure: SystemExposure = {
        agents: { publicByDefault: true },
        scopes: { publicByDefault: true },
        events: { hiddenTypes: ["message.sent"] },
      };
      expect(exposure.agents?.publicByDefault).toBe(true);
      expect(exposure.events?.hiddenTypes).toContain("message.sent");
    });

    it("accepts empty exposure", () => {
      const exposure: SystemExposure = {};
      expect(Object.keys(exposure)).toHaveLength(0);
    });
  });

  describe("AdapterLimits", () => {
    it("accepts all limits", () => {
      const limits: AdapterLimits = {
        maxConnections: 100,
        maxConnectionsPerClient: 5,
        maxSubscriptionsPerConnection: 10,
        maxMessageSize: 1024 * 1024,
        requestTimeoutMs: 30000,
      };
      expect(limits.maxConnections).toBe(100);
      expect(limits.maxMessageSize).toBe(1024 * 1024);
    });

    it("accepts partial limits", () => {
      const limits: AdapterLimits = {
        maxConnections: 50,
      };
      expect(limits.maxConnections).toBe(50);
      expect(limits.maxSubscriptionsPerConnection).toBeUndefined();
    });
  });

  describe("MAPAdapterConfig", () => {
    it("accepts full config", () => {
      const config: MAPAdapterConfig = {
        name: "macro-agent",
        version: "1.0.0",
        anonymousCapabilities: { canQuery: true },
        defaultClientCapabilities: { canQuery: true, canSubscribe: true },
        defaultAgentCapabilities: { canMessage: true },
        authenticate: async (type, creds) => ({
          allowed: creds.token === "valid",
          capabilities: { canQuery: true },
        }),
        exposure: {
          agents: { publicByDefault: true },
        },
        limits: {
          maxConnections: 100,
        },
      };
      expect(config.name).toBe("macro-agent");
      expect(config.limits?.maxConnections).toBe(100);
    });

    it("accepts minimal config", () => {
      const config: MAPAdapterConfig = {};
      expect(config.name).toBeUndefined();
    });
  });

  describe("MessagePayload", () => {
    it("accepts full payload", () => {
      const payload: MessagePayload = {
        type: "task.assignment",
        content: { taskId: "t-1", description: "Do something" },
        metadata: { priority: "high" },
      };
      expect(payload.type).toBe("task.assignment");
    });

    it("accepts content-only payload", () => {
      const payload: MessagePayload = {
        content: "Hello, agent!",
      };
      expect(payload.content).toBe("Hello, agent!");
      expect(payload.type).toBeUndefined();
    });
  });

  describe("SendResult", () => {
    it("accepts successful send", () => {
      const result: SendResult = {
        messageId: "msg-123",
        delivered: ["agent-1", "agent-2"],
      };
      expect(result.delivered).toHaveLength(2);
      expect(result.failed).toBeUndefined();
    });

    it("accepts partial delivery", () => {
      const result: SendResult = {
        messageId: "msg-456",
        delivered: ["agent-1"],
        failed: [{ agentId: "agent-2", reason: "Agent not found" }],
      };
      expect(result.delivered).toHaveLength(1);
      expect(result.failed).toHaveLength(1);
      expect(result.failed?.[0].reason).toBe("Agent not found");
    });
  });

  describe("AgentFilter", () => {
    it("accepts full filter", () => {
      const filter: AgentFilter = {
        states: ["active", "idle"],
        roles: ["worker", "integrator"],
        scopes: ["scope-1"],
        parent: "coordinator-1",
      };
      expect(filter.states).toHaveLength(2);
      expect(filter.roles).toHaveLength(2);
    });

    it("accepts empty filter", () => {
      const filter: AgentFilter = {};
      expect(Object.keys(filter)).toHaveLength(0);
    });
  });

  describe("AgentInfo", () => {
    it("accepts full agent info", () => {
      const info: AgentInfo = {
        id: "agent-1",
        name: "Worker 1",
        role: "worker",
        state: "active",
        parent: "coordinator-1",
        scopes: ["scope-1", "scope-2"],
        metadata: { version: "1.0" },
        createdAt: Date.now(),
      };
      expect(info.id).toBe("agent-1");
      expect(info.scopes).toHaveLength(2);
    });

    it("accepts minimal agent info", () => {
      const info: AgentInfo = {
        id: "agent-2",
        state: "created",
        scopes: [],
        createdAt: 0,
      };
      expect(info.name).toBeUndefined();
      expect(info.role).toBeUndefined();
    });
  });

  describe("ScopeInfo", () => {
    it("accepts full scope info", () => {
      const info: ScopeInfo = {
        id: "scope-1",
        name: "Workers Scope",
        members: ["agent-1", "agent-2"],
        createdAt: Date.now(),
        metadata: { purpose: "coordination" },
      };
      expect(info.members).toHaveLength(2);
    });

    it("accepts minimal scope info", () => {
      const info: ScopeInfo = {
        id: "scope-2",
        members: [],
        createdAt: 0,
      };
      expect(info.name).toBeUndefined();
    });
  });

  describe("AdapterEvent", () => {
    it("accepts participant connected event", () => {
      const event: AdapterEvent = {
        type: "participant.connected",
        participant: {
          id: createParticipantId("p-1"),
          type: "client",
          capabilities: {},
          sessionId: createSessionId("s-1"),
          connectedAt: Date.now(),
        },
      };
      expect(event.type).toBe("participant.connected");
    });

    it("accepts participant disconnected event", () => {
      const event: AdapterEvent = {
        type: "participant.disconnected",
        participantId: createParticipantId("p-1"),
        reason: "Client closed connection",
      };
      expect(event.type).toBe("participant.disconnected");
      expect(event.reason).toBe("Client closed connection");
    });

    it("accepts subscription events", () => {
      const created: AdapterEvent = {
        type: "subscription.created",
        subscriptionId: "sub-1" as any,
      };
      const removed: AdapterEvent = {
        type: "subscription.removed",
        subscriptionId: "sub-1" as any,
      };
      expect(created.type).toBe("subscription.created");
      expect(removed.type).toBe("subscription.removed");
    });

    it("accepts error event", () => {
      const event: AdapterEvent = {
        type: "error",
        error: new Error("Something went wrong"),
        context: "message routing",
      };
      expect(event.type).toBe("error");
      expect(event.error.message).toBe("Something went wrong");
      expect(event.context).toBe("message routing");
    });
  });
});

describe("Stream interface", () => {
  it("can create a mock stream", () => {
    // Verify the Stream interface is usable
    const mockStream: Stream = {
      readable: new ReadableStream(),
      writable: new WritableStream(),
    };
    expect(mockStream.readable).toBeInstanceOf(ReadableStream);
    expect(mockStream.writable).toBeInstanceOf(WritableStream);
  });
});
