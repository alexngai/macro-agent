/**
 * Integration tests for multi-client event broadcast.
 *
 * Verifies that when events are emitted via emitEvent(), they are correctly
 * delivered to subscribed participants through their WebSocket streams.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  createMAPAdapter,
  MAPAdapterImpl,
  type MAPAdapterServices,
} from "../map-adapter.js";
import type { MAPAdapter, MAPAdapterConfig, Stream } from "../interface.js";
import type { ParticipantId, EventNotification } from "../types.js";
import type { AgentId } from "../../../store/types/index.js";
import type { MAPEventType } from "../subscription-manager.js";
import { ulid } from "ulid";

// =============================================================================
// Helpers
// =============================================================================

/**
 * Create a mock stream pair that captures messages written by the server.
 * - `serverStream`: pass to adapter.acceptConnection()
 * - `clientMessages`: array of messages the adapter has written to the client
 * - `sendToServer`: simulate client sending a message to the server
 */
function createMockStreamPair(): {
  serverStream: Stream;
  clientMessages: unknown[];
  sendToServer: (msg: unknown) => void;
} {
  const clientMessages: unknown[] = [];

  let clientResolve: ((msg: unknown) => void) | null = null;
  let serverResolve: ((msg: unknown) => void) | null = null;

  // Server reads from this (client → server)
  const serverReadable = new ReadableStream<unknown>({
    start(controller) {
      serverResolve = (msg) => {
        controller.enqueue(msg);
      };
    },
  });

  // Server writes to this (server → client)
  const serverWritable = new WritableStream<unknown>({
    write(chunk) {
      clientMessages.push(chunk);
    },
  });

  return {
    serverStream: { readable: serverReadable, writable: serverWritable },
    clientMessages,
    sendToServer: (msg) => serverResolve?.(msg),
  };
}

/**
 * Wait for async writes to flush (emitEvent fires sendToSession without await).
 */
async function flushAsync(ms = 50): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

// =============================================================================
// Tests
// =============================================================================

describe("Multi-client event broadcast", () => {
  let adapter: MAPAdapter;
  let config: MAPAdapterConfig;
  let services: MAPAdapterServices;

  beforeEach(() => {
    config = {
      name: "test-broadcast",
      version: "1.0.0",
      limits: {
        maxConnections: 10,
        maxSubscriptionsPerConnection: 5,
      },
    };

    services = {
      getAgent: vi.fn(),
      listAgents: vi.fn().mockReturnValue([]),
      sendMessage: vi.fn().mockResolvedValue({ delivered: [] }),
      getAncestors: vi.fn().mockReturnValue([]),
      getDescendants: vi.fn().mockReturnValue([]),
    };

    adapter = createMAPAdapter(config, services);
  });

  afterEach(async () => {
    if (adapter.isRunning()) {
      await adapter.stop();
    }
  });

  it("broadcasts event to subscribed participant", async () => {
    await adapter.start();

    // Connect Client A with subscription
    const pairA = createMockStreamPair();
    const clientA = await adapter.acceptConnection(pairA.serverStream);
    await adapter.createSubscription(clientA.id, {
      eventTypes: [
        "message_sent" as MAPEventType,
        "message_delivered" as MAPEventType,
        "agent_registered" as MAPEventType,
      ],
    });

    // Connect Client B (no subscription)
    const pairB = createMockStreamPair();
    await adapter.acceptConnection(pairB.serverStream);

    // Emit a message_delivered event (simulates ACP response broadcast)
    adapter.emitEvent({
      eventId: ulid(),
      type: "message_delivered" as MAPEventType,
      timestamp: Date.now(),
      agentId: "agent-1" as AgentId,
      data: {
        from: "agent-1",
        to: "p-client-b",
        message: {
          id: `acp-notif-${Date.now()}`,
          from: "agent-1",
          payload: { type: "session/update", data: { text: "hello" } },
        },
      },
    } as EventNotification);

    await flushAsync();

    // Client A should have received the notification
    expect(pairA.clientMessages.length).toBeGreaterThan(0);

    const notification = pairA.clientMessages[0] as {
      jsonrpc: string;
      method: string;
      params: {
        subscriptionId: string;
        sequenceNumber: number;
        event: { type: string; data: unknown };
      };
    };
    expect(notification.method).toBe("map/event");
    expect(notification.params.event.type).toBe("message_delivered");
    expect(notification.params.subscriptionId).toMatch(/^sub-/);

    // Client B should NOT have received the notification (no subscription)
    expect(pairB.clientMessages).toHaveLength(0);
  });

  it("broadcasts agent_registered event to subscribed participant", async () => {
    await adapter.start();

    const pairA = createMockStreamPair();
    const clientA = await adapter.acceptConnection(pairA.serverStream);
    await adapter.createSubscription(clientA.id, {
      eventTypes: ["agent_registered" as MAPEventType],
    });

    // Emit agent_registered (simulates onAgentRegistered callback)
    adapter.emitEvent({
      eventId: ulid(),
      type: "agent_registered" as MAPEventType,
      timestamp: Date.now(),
      agentId: "agent-new" as AgentId,
      data: {
        agentId: "agent-new",
        name: "New Agent",
        role: "assistant",
      },
    } as EventNotification);

    await flushAsync();

    expect(pairA.clientMessages.length).toBeGreaterThan(0);
    const notification = pairA.clientMessages[0] as {
      method: string;
      params: { event: { type: string; data: { agentId: string } } };
    };
    expect(notification.method).toBe("map/event");
    expect(notification.params.event.type).toBe("agent_registered");
    expect(notification.params.event.data.agentId).toBe("agent-new");
  });

  it("broadcasts message_sent event to subscribed participant", async () => {
    await adapter.start();

    const pairA = createMockStreamPair();
    const clientA = await adapter.acceptConnection(pairA.serverStream);
    await adapter.createSubscription(clientA.id, {
      eventTypes: ["message_sent" as MAPEventType],
    });

    // Emit message_sent (simulates client→agent ACP request broadcast)
    adapter.emitEvent({
      eventId: ulid(),
      type: "message_sent" as MAPEventType,
      timestamp: Date.now(),
      agentId: "agent-1" as AgentId,
      data: {
        from: "p-client-b",
        to: "agent-1",
        message: {
          id: `acp-req-${Date.now()}`,
          from: "p-client-b",
          to: "agent-1",
          payload: {
            type: "session/prompt",
            data: { text: "hello agent" },
          },
        },
      },
    } as EventNotification);

    await flushAsync();

    expect(pairA.clientMessages.length).toBeGreaterThan(0);
    const notification = pairA.clientMessages[0] as {
      method: string;
      params: { event: { type: string; data: { from: string; to: string } } };
    };
    expect(notification.method).toBe("map/event");
    expect(notification.params.event.type).toBe("message_sent");
    expect(notification.params.event.data.from).toBe("p-client-b");
    expect(notification.params.event.data.to).toBe("agent-1");
  });

  it("both clients receive events when both are subscribed", async () => {
    await adapter.start();

    const pairA = createMockStreamPair();
    const clientA = await adapter.acceptConnection(pairA.serverStream);
    await adapter.createSubscription(clientA.id, {
      eventTypes: ["message_delivered" as MAPEventType],
    });

    const pairB = createMockStreamPair();
    const clientB = await adapter.acceptConnection(pairB.serverStream);
    await adapter.createSubscription(clientB.id, {
      eventTypes: ["message_delivered" as MAPEventType],
    });

    adapter.emitEvent({
      eventId: ulid(),
      type: "message_delivered" as MAPEventType,
      timestamp: Date.now(),
      agentId: "agent-1" as AgentId,
      data: { from: "agent-1", to: "some-client", message: {} },
    } as EventNotification);

    await flushAsync();

    // Both should receive
    expect(pairA.clientMessages.length).toBeGreaterThan(0);
    expect(pairB.clientMessages.length).toBeGreaterThan(0);

    const notifA = pairA.clientMessages[0] as { method: string };
    const notifB = pairB.clientMessages[0] as { method: string };
    expect(notifA.method).toBe("map/event");
    expect(notifB.method).toBe("map/event");
  });

  it("does NOT broadcast to participant with non-matching filter", async () => {
    await adapter.start();

    const pairA = createMockStreamPair();
    const clientA = await adapter.acceptConnection(pairA.serverStream);
    // Subscribe only to agent_registered
    await adapter.createSubscription(clientA.id, {
      eventTypes: ["agent_registered" as MAPEventType],
    });

    // Emit message_delivered — should NOT match
    adapter.emitEvent({
      eventId: ulid(),
      type: "message_delivered" as MAPEventType,
      timestamp: Date.now(),
      agentId: "agent-1" as AgentId,
      data: { from: "agent-1", to: "some-client", message: {} },
    } as EventNotification);

    await flushAsync();

    expect(pairA.clientMessages).toHaveLength(0);
  });

  it("dot format event types match underscore subscriptions via normalization", async () => {
    await adapter.start();

    const pairA = createMockStreamPair();
    const clientA = await adapter.acceptConnection(pairA.serverStream);
    // Subscribe with underscore format (what SDK sends)
    await adapter.createSubscription(clientA.id, {
      eventTypes: ["agent_registered" as MAPEventType],
    });

    // Emit with DOT format — SHOULD match after normalization
    adapter.emitEvent({
      eventId: ulid(),
      type: "agent.registered" as MAPEventType,
      timestamp: Date.now(),
      agentId: "agent-1" as AgentId,
      data: { agentId: "agent-1" },
    } as EventNotification);

    await flushAsync();

    // Should receive — normalization converts dots to underscores for matching
    expect(pairA.clientMessages.length).toBeGreaterThan(0);
    const notification = pairA.clientMessages[0] as { method: string };
    expect(notification.method).toBe("map/event");
  });

  it("underscore format event types DO match underscore subscriptions", async () => {
    await adapter.start();

    const pairA = createMockStreamPair();
    const clientA = await adapter.acceptConnection(pairA.serverStream);
    await adapter.createSubscription(clientA.id, {
      eventTypes: ["agent_registered" as MAPEventType],
    });

    // Emit with UNDERSCORE format — SHOULD match
    adapter.emitEvent({
      eventId: ulid(),
      type: "agent_registered" as MAPEventType,
      timestamp: Date.now(),
      agentId: "agent-1" as AgentId,
      data: { agentId: "agent-1" },
    } as EventNotification);

    await flushAsync();

    expect(pairA.clientMessages.length).toBeGreaterThan(0);
    const notification = pairA.clientMessages[0] as { method: string };
    expect(notification.method).toBe("map/event");
  });

  it("sequence numbers increment per subscription", async () => {
    await adapter.start();

    const pairA = createMockStreamPair();
    const clientA = await adapter.acceptConnection(pairA.serverStream);
    await adapter.createSubscription(clientA.id, {
      eventTypes: ["message_delivered" as MAPEventType],
    });

    // Emit three events
    for (let i = 0; i < 3; i++) {
      adapter.emitEvent({
        eventId: ulid(),
        type: "message_delivered" as MAPEventType,
        timestamp: Date.now(),
        agentId: "agent-1" as AgentId,
        data: { index: i },
      } as EventNotification);
    }

    await flushAsync();

    expect(pairA.clientMessages).toHaveLength(3);

    const seqNums = pairA.clientMessages.map(
      (m) => (m as { params: { sequenceNumber: number } }).params.sequenceNumber,
    );
    expect(seqNums).toEqual([0, 1, 2]);
  });

  it("paused subscription does not receive events", async () => {
    await adapter.start();

    const pairA = createMockStreamPair();
    const clientA = await adapter.acceptConnection(pairA.serverStream);
    const subId = await adapter.createSubscription(clientA.id, {
      eventTypes: ["message_delivered" as MAPEventType],
    });

    // Pause the subscription
    await adapter.pauseSubscription(subId);

    adapter.emitEvent({
      eventId: ulid(),
      type: "message_delivered" as MAPEventType,
      timestamp: Date.now(),
      agentId: "agent-1" as AgentId,
      data: {},
    } as EventNotification);

    await flushAsync();

    expect(pairA.clientMessages).toHaveLength(0);

    // Resume and emit again
    await adapter.resumeSubscription(subId);

    adapter.emitEvent({
      eventId: ulid(),
      type: "message_delivered" as MAPEventType,
      timestamp: Date.now(),
      agentId: "agent-1" as AgentId,
      data: {},
    } as EventNotification);

    await flushAsync();

    expect(pairA.clientMessages).toHaveLength(1);
  });
});
