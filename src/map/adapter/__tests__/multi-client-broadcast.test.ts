/**
 * Multi-Client Event Broadcast E2E Test
 *
 * Spins up a REAL CombinedServer with in-memory EventStore, connects
 * two WebSocket clients, and verifies that events emitted by one client's
 * ACP activity are broadcast to the other client's subscription.
 *
 * This tests the full pipeline:
 *   Client B sends map/send (ACP envelope)
 *     → handleSend → handleACPOverMAP
 *       → emitEvent(message_sent)
 *       → processRequest → emitNotification → emitEvent(message_delivered)
 *       → emitEvent(message_delivered) [final response]
 *     → subscription match → sendToSession → WebSocket.send()
 *       → Client A receives map/event notification
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { WebSocket } from "ws";
import { createEventStore, type EventStore } from "../../../store/event-store.js";
import {
  createAgentManager,
  type AgentManager,
} from "../../../agent/agent-manager.js";
import { createTaskManager, type TaskManager } from "../../../task/task-manager.js";
import {
  createMessageRouter,
  type MessageRouter,
} from "../../../router/message-router.js";
import {
  createCombinedServer,
  type CombinedServer,
  type CombinedServerServices,
} from "../../../server/combined-server.js";

// =============================================================================
// Helpers
// =============================================================================

function getRandomPort(): number {
  return 10000 + Math.floor(Math.random() * 50000);
}

interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/**
 * WebSocket MAP client that handles both RPC responses AND notifications.
 */
class MAPTestClient {
  private ws!: WebSocket;
  private waiters: Map<
    number,
    { resolve: (r: JsonRpcMessage) => void; reject: (e: Error) => void }
  > = new Map();
  private nextId = 1;
  private url: string;

  /** All received notifications (no `id` field) */
  readonly notifications: JsonRpcMessage[] = [];

  /** Resolvers waiting for a notification matching some predicate */
  private notificationWaiters: Array<{
    check: (msg: JsonRpcMessage) => boolean;
    resolve: (msg: JsonRpcMessage) => void;
    reject: (e: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  }> = [];

  constructor(url: string) {
    this.url = url;
  }

  async connect(): Promise<void> {
    this.ws = new WebSocket(this.url);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Connection timeout")),
        5000,
      );
      this.ws.on("open", () => {
        clearTimeout(timeout);
        resolve();
      });
      this.ws.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
      this.ws.on("message", (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString()) as JsonRpcMessage;

          if (msg.id != null) {
            // RPC response
            const waiter = this.waiters.get(msg.id);
            if (waiter) {
              this.waiters.delete(msg.id);
              waiter.resolve(msg);
            }
          } else if (msg.method) {
            // Notification (no id)
            this.notifications.push(msg);

            // Check pending notification waiters
            for (let i = this.notificationWaiters.length - 1; i >= 0; i--) {
              const w = this.notificationWaiters[i];
              if (w.check(msg)) {
                clearTimeout(w.timeout);
                this.notificationWaiters.splice(i, 1);
                w.resolve(msg);
              }
            }
          }
        } catch {
          // ignore parse errors
        }
      });
    });
  }

  async request(method: string, params?: unknown): Promise<JsonRpcMessage> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.waiters.delete(id);
        reject(new Error(`Request timeout: ${method}`));
      }, 30000);
      this.waiters.set(id, {
        resolve: (r) => {
          clearTimeout(timeout);
          resolve(r);
        },
        reject: (e) => {
          clearTimeout(timeout);
          reject(e);
        },
      });
      this.ws.send(JSON.stringify({ jsonrpc: "2.0", method, params, id }));
    });
  }

  /**
   * Wait for a notification matching the predicate.
   * Checks already-received notifications first.
   */
  waitForNotification(
    check: (msg: JsonRpcMessage) => boolean,
    timeoutMs = 15000,
  ): Promise<JsonRpcMessage> {
    const existing = this.notifications.find(check);
    if (existing) return Promise.resolve(existing);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const idx = this.notificationWaiters.findIndex(
          (w) => w.resolve === resolve,
        );
        if (idx >= 0) this.notificationWaiters.splice(idx, 1);
        reject(
          new Error(
            `Timeout waiting for notification. Received ${this.notifications.length} notifications:\n` +
              this.notifications
                .map((n) => {
                  const p = n.params as Record<string, unknown> | undefined;
                  const evt = p?.event as Record<string, unknown> | undefined;
                  return `  ${n.method} → type=${evt?.type}`;
                })
                .join("\n"),
          ),
        );
      }, timeoutMs);
      this.notificationWaiters.push({ check, resolve, reject, timeout });
    });
  }

  close(): void {
    // Clean up pending waiters
    for (const w of this.notificationWaiters) {
      clearTimeout(w.timeout);
    }
    this.notificationWaiters.length = 0;

    try {
      this.ws?.close();
    } catch {
      // ignore
    }
  }
}

// =============================================================================
// Tests
// =============================================================================

describe("Multi-client event broadcast E2E", () => {
  let eventStore: EventStore;
  let agentManager: AgentManager;
  let taskManager: TaskManager;
  let messageRouter: MessageRouter;
  let server: CombinedServer;
  let port: number;
  const clients: MAPTestClient[] = [];

  beforeEach(async () => {
    port = getRandomPort();
    eventStore = await createEventStore({ inMemory: true });
    messageRouter = createMessageRouter(eventStore);
    taskManager = createTaskManager(eventStore);
    agentManager = createAgentManager(eventStore, messageRouter, {
      defaultPermissionMode: "auto-approve",
      defaultCwd: process.cwd(),
    });

    const services: CombinedServerServices = {
      eventStore,
      agentManager,
      taskManager,
      messageRouter,
    };

    server = createCombinedServer(services, { port, host: "localhost" });
    await server.start();
  });

  afterEach(async () => {
    for (const c of clients) {
      c.close();
    }
    clients.length = 0;
    await server.stop().catch(() => {});
    await agentManager.close();
    await eventStore.close();
  });

  function createClient(): MAPTestClient {
    const client = new MAPTestClient(`ws://localhost:${port}/map`);
    clients.push(client);
    return client;
  }

  // Helper to check if a notification is a map/event with a specific type
  function isEventOfType(type: string) {
    return (msg: JsonRpcMessage) => {
      if (msg.method !== "map/event") return false;
      const params = msg.params as Record<string, unknown> | undefined;
      const event = params?.event as Record<string, unknown> | undefined;
      return event?.type === type;
    };
  }

  /** Send ACP initialize + session/new via map/send, return the response. */
  async function initializeAndCreateSession(
    client: MAPTestClient,
    streamId: string,
  ): Promise<JsonRpcMessage> {
    // ACP requires initialize before session/new
    await client.request("map/send", {
      to: { agent: "default" },
      payload: {
        acp: {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            clientInfo: { name: "test-client", version: "0.1.0" },
          },
        },
        acpContext: { streamId, direction: "client-to-agent" },
      },
    });

    return client.request("map/send", {
      to: { agent: "default" },
      payload: {
        acp: {
          jsonrpc: "2.0",
          id: 2,
          method: "session/new",
          params: {},
        },
        acpContext: { streamId, direction: "client-to-agent" },
      },
    });
  }

  it("Client A receives agent_registered when Client B creates a session", async () => {
    // Connect Client A and subscribe
    const clientA = createClient();
    await clientA.connect();
    const subRes = await clientA.request("map/subscribe", {
      filter: {
        eventTypes: [
          "agent_registered",
          "message_sent",
          "message_delivered",
          "agent_state_changed",
        ],
      },
    });
    expect(subRes.error).toBeUndefined();
    expect(subRes.result).toHaveProperty("subscriptionId");

    // Connect Client B
    const clientB = createClient();
    await clientB.connect();

    // Client B initializes ACP stream and creates a session
    const streamId = `stream-${Date.now()}`;
    const sessionNewRes = await initializeAndCreateSession(clientB, streamId);
    console.log("session/new response:", JSON.stringify(sessionNewRes, null, 2));

    // Client A should receive agent_registered notification
    const agentEvent = await clientA.waitForNotification(
      isEventOfType("agent_registered"),
      10000,
    );

    expect(agentEvent.method).toBe("map/event");
    const params = agentEvent.params as Record<string, unknown>;
    const event = params.event as Record<string, unknown>;
    expect(event.type).toBe("agent_registered");

    const data = event.data as Record<string, unknown>;
    expect(data.agentId).toBeDefined();
    console.log("Agent registered event data:", JSON.stringify(data, null, 2));
  });

  it("Client A receives message_sent when Client B sends ACP request", async () => {
    // Connect and subscribe Client A
    const clientA = createClient();
    await clientA.connect();
    await clientA.request("map/subscribe", {
      filter: {
        eventTypes: [
          "agent_registered",
          "message_sent",
          "message_delivered",
        ],
      },
    });

    // Connect Client B and create a session first
    const clientB = createClient();
    await clientB.connect();

    const streamId = `stream-${Date.now()}`;

    // Initialize ACP stream
    await clientB.request("map/send", {
      to: { agent: "default" },
      payload: {
        acp: {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            clientInfo: { name: "test-client-b", version: "0.1.0" },
          },
        },
        acpContext: {
          streamId,
          direction: "client-to-agent",
        },
      },
    });

    // Create new session (this also triggers agent_registered)
    const sessionNewRes = await clientB.request("map/send", {
      to: { agent: "default" },
      payload: {
        acp: {
          jsonrpc: "2.0",
          id: 2,
          method: "session/new",
          params: {},
        },
        acpContext: {
          streamId,
          direction: "client-to-agent",
        },
      },
    });

    console.log("session/new response:", JSON.stringify(sessionNewRes, null, 2));

    // Wait for agent_registered first (confirms agent was created)
    const agentEvent = await clientA.waitForNotification(
      isEventOfType("agent_registered"),
      10000,
    );
    const agentData = (
      (agentEvent.params as Record<string, unknown>).event as Record<
        string,
        unknown
      >
    ).data as Record<string, unknown>;
    const agentId = agentData.agentId as string;
    console.log("Created agent:", agentId);

    // Client A should have received message_sent events for the ACP requests
    // (initialize and session/new both emit message_sent)
    const messageSentEvents = clientA.notifications.filter(
      isEventOfType("message_sent"),
    );
    console.log(
      `Client A received ${messageSentEvents.length} message_sent events`,
    );
    expect(messageSentEvents.length).toBeGreaterThanOrEqual(1);

    // Verify the message_sent event has the ACP envelope in the data
    const sentParams = messageSentEvents[0].params as Record<string, unknown>;
    const sentEvent = sentParams.event as Record<string, unknown>;
    const sentData = sentEvent.data as Record<string, unknown>;
    expect(sentData.from).toBeDefined();
    expect(sentData.to).toBeDefined();
    expect(sentData.message).toBeDefined();

    const message = sentData.message as Record<string, unknown>;
    expect(message.payload).toBeDefined();

    // The payload should be a valid ACP envelope
    const payload = message.payload as Record<string, unknown>;
    expect(payload.acp).toBeDefined();
    expect(payload.acpContext).toBeDefined();

    console.log("message_sent event data:", JSON.stringify(sentData, null, 2));
  });

  it("Client A receives message_delivered for ACP streaming updates", async () => {
    // Connect and subscribe Client A
    const clientA = createClient();
    await clientA.connect();
    await clientA.request("map/subscribe", {
      filter: {
        eventTypes: [
          "agent_registered",
          "message_sent",
          "message_delivered",
        ],
      },
    });

    // Connect Client B
    const clientB = createClient();
    await clientB.connect();

    const streamId = `stream-${Date.now()}`;

    // Initialize
    await clientB.request("map/send", {
      to: { agent: "default" },
      payload: {
        acp: {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            clientInfo: { name: "test-client-b", version: "0.1.0" },
          },
        },
        acpContext: {
          streamId,
          direction: "client-to-agent",
        },
      },
    });

    // Create session
    const sessionRes = await clientB.request("map/send", {
      to: { agent: "default" },
      payload: {
        acp: {
          jsonrpc: "2.0",
          id: 2,
          method: "session/new",
          params: {},
        },
        acpContext: {
          streamId,
          direction: "client-to-agent",
        },
      },
    });

    console.log("session/new response:", JSON.stringify(sessionRes, null, 2));

    // Wait for agent_registered first
    const agentEvent = await clientA.waitForNotification(
      isEventOfType("agent_registered"),
      10000,
    );
    const agentData = (
      (agentEvent.params as Record<string, unknown>).event as Record<
        string,
        unknown
      >
    ).data as Record<string, unknown>;
    const agentId = agentData.agentId as string;

    // Extract session ID from the session/new response
    const sessionResult =
      sessionRes.result as Record<string, unknown> | undefined;
    let sessionId: string | undefined;
    if (sessionResult?.delivered) {
      // The response comes from sendMessage — extract sessionId from
      // message_delivered events that should be in Client A's notifications
    }

    // Check message_delivered events — session/new should emit session info
    // Wait a moment for streaming updates
    await new Promise((r) => setTimeout(r, 1000));

    const deliveredEvents = clientA.notifications.filter(
      isEventOfType("message_delivered"),
    );
    console.log(
      `Client A received ${deliveredEvents.length} message_delivered events`,
    );

    // There should be at least one message_delivered event
    // (session info notification emitted during session/new processing)
    expect(deliveredEvents.length).toBeGreaterThanOrEqual(1);

    // Verify the delivered event has the proper structure
    for (const evt of deliveredEvents) {
      const p = evt.params as Record<string, unknown>;
      const e = p.event as Record<string, unknown>;
      const d = e.data as Record<string, unknown>;
      expect(d.from).toBeDefined();
      expect(d.to).toBeDefined();
      expect(d.message).toBeDefined();

      const msg = d.message as Record<string, unknown>;
      expect(msg.payload).toBeDefined();

      const payload = msg.payload as Record<string, unknown>;
      expect(payload.acp).toBeDefined();
      expect(payload.acpContext).toBeDefined();

      console.log(
        `  message_delivered: method=${(payload.acp as Record<string, unknown>).method ?? "(response)"}`,
      );
    }
  });

  it("Client A does NOT receive events for non-subscribed types", async () => {
    // Client A subscribes only to agent_registered
    const clientA = createClient();
    await clientA.connect();
    await clientA.request("map/subscribe", {
      filter: { eventTypes: ["agent_registered"] },
    });

    // Client B sends ACP messages
    const clientB = createClient();
    await clientB.connect();

    const streamId = `stream-${Date.now()}`;
    await clientB.request("map/send", {
      to: { agent: "default" },
      payload: {
        acp: {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            clientInfo: { name: "test-client-b", version: "0.1.0" },
          },
        },
        acpContext: {
          streamId,
          direction: "client-to-agent",
        },
      },
    });

    await clientB.request("map/send", {
      to: { agent: "default" },
      payload: {
        acp: {
          jsonrpc: "2.0",
          id: 2,
          method: "session/new",
          params: {},
        },
        acpContext: {
          streamId,
          direction: "client-to-agent",
        },
      },
    });

    // Wait for agent_registered (should arrive)
    await clientA.waitForNotification(
      isEventOfType("agent_registered"),
      10000,
    );

    // Give time for any other events to arrive
    await new Promise((r) => setTimeout(r, 2000));

    // Should NOT have received message_sent or message_delivered
    const messageSent = clientA.notifications.filter(
      isEventOfType("message_sent"),
    );
    const messageDelivered = clientA.notifications.filter(
      isEventOfType("message_delivered"),
    );

    expect(messageSent).toHaveLength(0);
    expect(messageDelivered).toHaveLength(0);
  });

  it("Both clients receive events when both are subscribed", async () => {
    const clientA = createClient();
    await clientA.connect();
    await clientA.request("map/subscribe", {
      filter: { eventTypes: ["agent_registered", "message_sent"] },
    });

    const clientB = createClient();
    await clientB.connect();
    await clientB.request("map/subscribe", {
      filter: { eventTypes: ["agent_registered", "message_sent"] },
    });

    const streamId = `stream-${Date.now()}`;

    // Client B initializes and creates session — both should see the events
    await initializeAndCreateSession(clientB, streamId);

    // Both should receive agent_registered
    const eventA = await clientA.waitForNotification(
      isEventOfType("agent_registered"),
      10000,
    );
    const eventB = await clientB.waitForNotification(
      isEventOfType("agent_registered"),
      10000,
    );

    expect(eventA.method).toBe("map/event");
    expect(eventB.method).toBe("map/event");

    console.log(
      `Client A notifications: ${clientA.notifications.length}`,
      clientA.notifications.map((n) => {
        const p = n.params as Record<string, unknown>;
        const e = p?.event as Record<string, unknown>;
        return e?.type;
      }),
    );
    console.log(
      `Client B notifications: ${clientB.notifications.length}`,
      clientB.notifications.map((n) => {
        const p = n.params as Record<string, unknown>;
        const e = p?.event as Record<string, unknown>;
        return e?.type;
      }),
    );
  });

  it("map/replay returns historical events", async () => {
    // Client B creates an agent (generates events)
    const clientB = createClient();
    await clientB.connect();

    const streamId = `stream-${Date.now()}`;
    await initializeAndCreateSession(clientB, streamId);

    // Wait for the request to be processed
    await new Promise((r) => setTimeout(r, 2000));

    // NOW Client A connects and replays history
    const clientA = createClient();
    await clientA.connect();

    const replayRes = await clientA.request("map/replay", {
      filter: {
        eventTypes: [
          "agent_registered",
          "message_sent",
          "message_delivered",
        ],
      },
      limit: 100,
    });

    expect(replayRes.error).toBeUndefined();
    const result = replayRes.result as {
      events: Array<{ event: { type: string } }>;
      hasMore: boolean;
    };
    expect(result.events).toBeDefined();
    expect(result.events.length).toBeGreaterThan(0);

    const eventTypes = result.events.map((e) => e.event.type);
    console.log("Replayed event types:", eventTypes);

    // Should include agent_registered from the session/new
    expect(eventTypes).toContain("agent_registered");
    // Should include message_sent (for the session/new ACP request)
    expect(eventTypes).toContain("message_sent");
  });
});
