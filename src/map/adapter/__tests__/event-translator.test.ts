/**
 * Tests for Event Translator
 */

import { describe, it, expect, vi } from "vitest";
import {
  translateEvent,
  translateEvents,
  createEventStreamAdapter,
  type TranslationContext,
} from "../event-translator.js";
import type { Event, EventType } from "../../../store/types/events.js";
import type { AgentId, EventId, Timestamp } from "../../../store/types/primitives.js";

/**
 * Create a test event with minimal required fields.
 */
function createTestEvent(
  type: EventType,
  overrides: Partial<Event> = {}
): Event {
  return {
    id: "evt-1" as EventId,
    version: 1,
    timestamp: Date.now() as Timestamp,
    type,
    source: { agent_id: "agent-1" as AgentId },
    payload: {},
    ...overrides,
  };
}

describe("translateEvent", () => {
  const mockContext: TranslationContext = {
    generateEventId: vi.fn().mockReturnValue("mock-event-id"),
  };

  describe("spawn event", () => {
    it("translates to agent.registered", () => {
      const event = createTestEvent("spawn", {
        payload: {
          name: "Worker",
          role: "worker",
          parent_id: "parent-1",
          metadata: { key: "value" },
        },
      });

      const result = translateEvent(event, mockContext);

      expect(result.translated).toBe(true);
      if (result.translated) {
        expect(result.events).toHaveLength(1);
        expect(result.events[0].type).toBe("agent.registered");
        expect(result.events[0].data).toEqual({
          agentId: "agent-1",
          name: "Worker",
          role: "worker",
          parent: "parent-1",
          metadata: { key: "value" },
        });
        expect(result.events[0].agentId).toBe("agent-1");
      }
    });

    it("fails if agent_id missing", () => {
      const event = createTestEvent("spawn", {
        source: {},
      });

      const result = translateEvent(event, mockContext);

      expect(result.translated).toBe(false);
      if (!result.translated) {
        expect(result.reason).toContain("missing agent_id");
      }
    });
  });

  describe("stop event", () => {
    it("translates to agent.unregistered", () => {
      const event = createTestEvent("stop", {
        payload: {
          reason: "completed",
          exit_code: 0,
        },
      });

      const result = translateEvent(event, mockContext);

      expect(result.translated).toBe(true);
      if (result.translated) {
        expect(result.events).toHaveLength(1);
        expect(result.events[0].type).toBe("agent.unregistered");
        expect(result.events[0].data).toEqual({
          agentId: "agent-1",
          reason: "completed",
          exitCode: 0,
        });
      }
    });
  });

  describe("status event", () => {
    it("translates to agent.state.changed", () => {
      const event = createTestEvent("status", {
        payload: {
          status: "blocked",
          previous_state: "running",
          message: "Waiting for input",
          metadata: { blockReason: "user" },
        },
      });

      const result = translateEvent(event, mockContext);

      expect(result.translated).toBe(true);
      if (result.translated) {
        expect(result.events).toHaveLength(1);
        expect(result.events[0].type).toBe("agent.state.changed");
        expect(result.events[0].data).toMatchObject({
          agentId: "agent-1",
          state: "blocked",
          previousState: "running",
          message: "Waiting for input",
        });
      }
    });

    it("maps status types to state names", () => {
      const statusTests = [
        { status: "started", expectedState: "running" },
        { status: "checkpoint", expectedState: "running" },
        { status: "blocked", expectedState: "blocked" },
        { status: "completed", expectedState: "completed" },
        { status: "failed", expectedState: "failed" },
      ];

      for (const { status, expectedState } of statusTests) {
        const event = createTestEvent("status", {
          payload: { status },
        });

        const result = translateEvent(event, mockContext);

        expect(result.translated).toBe(true);
        if (result.translated) {
          expect(result.events[0].data.state).toBe(expectedState);
        }
      }
    });
  });

  describe("message event", () => {
    it("produces both message.sent and message.delivered events", () => {
      const event = createTestEvent("message", {
        id: "msg-1" as EventId,
        target: {
          agent_id: "recipient-1" as AgentId,
          delivered: ["recipient-1"] as AgentId[],
        },
        payload: {
          content: "Hello",
          priority: "normal",
        },
        metadata: {
          correlation_id: "corr-1",
        },
      });

      const result = translateEvent(event, mockContext);

      expect(result.translated).toBe(true);
      if (result.translated) {
        expect(result.events).toHaveLength(2);

        // First event: message.sent
        expect(result.events[0].type).toBe("message.sent");
        expect(result.events[0].data).toMatchObject({
          messageId: "msg-1",
          from: "agent-1",
          content: "Hello",
          priority: "normal",
          correlationId: "corr-1",
        });

        // Second event: message.delivered
        expect(result.events[1].type).toBe("message.delivered");
        expect(result.events[1].data).toMatchObject({
          messageId: "msg-1",
          from: "agent-1",
          to: ["recipient-1"],
          deliveredCount: 1,
        });
        expect(result.events[1].causedBy).toContain(result.events[0].eventId);
      }
    });

    it("only produces message.sent if no recipients", () => {
      const event = createTestEvent("message", {
        target: {
          delivered: [],
        },
        payload: {
          content: "Hello",
        },
      });

      const result = translateEvent(event, mockContext);

      expect(result.translated).toBe(true);
      if (result.translated) {
        expect(result.events).toHaveLength(1);
        expect(result.events[0].type).toBe("message.sent");
      }
    });
  });

  describe("task event", () => {
    it("translates task.created action", () => {
      const event = createTestEvent("task", {
        payload: {
          action: "created",
          task_id: "task-1",
          title: "Test Task",
          description: "A test task",
        },
      });

      const result = translateEvent(event, mockContext);

      expect(result.translated).toBe(true);
      if (result.translated) {
        expect(result.events[0].type).toBe("task.created");
        expect(result.events[0].data).toMatchObject({
          taskId: "task-1",
          title: "Test Task",
        });
      }
    });

    it("translates task.assigned action", () => {
      const event = createTestEvent("task", {
        payload: {
          action: "assigned",
          task_id: "task-1",
          assignee: "agent-2",
        },
      });

      const result = translateEvent(event, mockContext);

      expect(result.translated).toBe(true);
      if (result.translated) {
        expect(result.events[0].type).toBe("task.assigned");
        expect(result.events[0].data.assignee).toBe("agent-2");
      }
    });

    it("translates task.completed action", () => {
      const event = createTestEvent("task", {
        payload: {
          action: "completed",
          task_id: "task-1",
          result: { success: true },
        },
      });

      const result = translateEvent(event, mockContext);

      expect(result.translated).toBe(true);
      if (result.translated) {
        expect(result.events[0].type).toBe("task.completed");
      }
    });

    it("translates task.failed action", () => {
      const event = createTestEvent("task", {
        payload: {
          action: "failed",
          task_id: "task-1",
          error: "Something went wrong",
        },
      });

      const result = translateEvent(event, mockContext);

      expect(result.translated).toBe(true);
      if (result.translated) {
        expect(result.events[0].type).toBe("task.failed");
        expect(result.events[0].data.error).toBe("Something went wrong");
      }
    });

    it("fails for unknown task action", () => {
      const event = createTestEvent("task", {
        payload: {
          action: "unknown",
        },
      });

      const result = translateEvent(event, mockContext);

      expect(result.translated).toBe(false);
    });
  });

  describe("non-exposed events", () => {
    it("does not translate subscription events", () => {
      const event = createTestEvent("subscription");
      const result = translateEvent(event, mockContext);

      expect(result.translated).toBe(false);
      if (!result.translated) {
        expect(result.reason).toContain("not exposed");
      }
    });

    it("does not translate peer_message events", () => {
      const event = createTestEvent("peer_message");
      const result = translateEvent(event, mockContext);

      expect(result.translated).toBe(false);
    });

    it("does not translate peer_request events", () => {
      const event = createTestEvent("peer_request");
      const result = translateEvent(event, mockContext);

      expect(result.translated).toBe(false);
    });
  });

  describe("event ID generation", () => {
    it("uses provided generateEventId function", () => {
      const mockGenerateId = vi.fn().mockReturnValue("custom-id");
      const event = createTestEvent("spawn");

      const result = translateEvent(event, { generateEventId: mockGenerateId });

      expect(result.translated).toBe(true);
      if (result.translated) {
        expect(result.events[0].eventId).toBe("custom-id");
        expect(mockGenerateId).toHaveBeenCalled();
      }
    });

    it("generates ULID by default", () => {
      const event = createTestEvent("spawn");

      const result = translateEvent(event);

      expect(result.translated).toBe(true);
      if (result.translated) {
        // ULID is 26 characters
        expect(result.events[0].eventId).toHaveLength(26);
      }
    });
  });
});

describe("translateEvents", () => {
  it("translates multiple events", () => {
    const events = [
      createTestEvent("spawn", { payload: { name: "Agent 1" } }),
      createTestEvent("spawn", {
        source: { agent_id: "agent-2" as AgentId },
        payload: { name: "Agent 2" },
      }),
    ];

    const results = translateEvents(events);

    expect(results).toHaveLength(2);
    expect(results[0].type).toBe("agent.registered");
    expect(results[1].type).toBe("agent.registered");
  });

  it("filters out non-translatable events", () => {
    const events = [
      createTestEvent("spawn"),
      createTestEvent("subscription"), // Not exposed
      createTestEvent("stop"),
    ];

    const results = translateEvents(events);

    expect(results).toHaveLength(2);
    expect(results.map((e) => e.type)).toEqual([
      "agent.registered",
      "agent.unregistered",
    ]);
  });

  it("flattens multi-event translations", () => {
    const events = [
      createTestEvent("message", {
        target: { delivered: ["r1"] as AgentId[] },
        payload: { content: "Hi" },
      }),
    ];

    const results = translateEvents(events);

    // message produces both sent and delivered
    expect(results).toHaveLength(2);
    expect(results.map((e) => e.type)).toEqual([
      "message.sent",
      "message.delivered",
    ]);
  });

  it("returns empty array for empty input", () => {
    expect(translateEvents([])).toEqual([]);
  });
});

describe("createEventStreamAdapter", () => {
  it("subscribes to events and translates them", () => {
    const handlers: ((event: Event) => void)[] = [];
    const subscribe = vi.fn((callback) => {
      handlers.push(callback);
      return () => {
        const idx = handlers.indexOf(callback);
        if (idx >= 0) handlers.splice(idx, 1);
      };
    });

    const adapter = createEventStreamAdapter({ subscribe });
    const receivedEvents: any[] = [];

    adapter.onEvent((event) => receivedEvents.push(event));

    // Verify subscription was called
    expect(subscribe).toHaveBeenCalled();

    // Simulate internal event
    const internalEvent = createTestEvent("spawn", {
      payload: { name: "Test Agent" },
    });
    handlers[0](internalEvent);

    // Should have received translated event
    expect(receivedEvents).toHaveLength(1);
    expect(receivedEvents[0].type).toBe("agent.registered");
  });

  it("handles multiple handlers", () => {
    const handlers: ((event: Event) => void)[] = [];
    const subscribe = vi.fn((callback) => {
      handlers.push(callback);
      return () => {};
    });

    const adapter = createEventStreamAdapter({ subscribe });
    const handler1Events: any[] = [];
    const handler2Events: any[] = [];

    adapter.onEvent((event) => handler1Events.push(event));
    adapter.onEvent((event) => handler2Events.push(event));

    // Simulate event
    handlers[0](createTestEvent("spawn"));

    expect(handler1Events).toHaveLength(1);
    expect(handler2Events).toHaveLength(1);
  });

  it("returns unsubscribe function for handlers", () => {
    const handlers: ((event: Event) => void)[] = [];
    const subscribe = vi.fn((callback) => {
      handlers.push(callback);
      return () => {};
    });

    const adapter = createEventStreamAdapter({ subscribe });
    const receivedEvents: any[] = [];

    const unsubscribe = adapter.onEvent((event) => receivedEvents.push(event));

    // First event
    handlers[0](createTestEvent("spawn"));
    expect(receivedEvents).toHaveLength(1);

    // Unsubscribe
    unsubscribe();

    // Second event - handler should not receive it
    handlers[0](createTestEvent("spawn"));
    expect(receivedEvents).toHaveLength(1);
  });

  it("stop() cleans up subscription", () => {
    const unsubscribeFn = vi.fn();
    const subscribe = vi.fn(() => unsubscribeFn);

    const adapter = createEventStreamAdapter({ subscribe });
    adapter.onEvent(() => {});

    adapter.stop();

    expect(unsubscribeFn).toHaveBeenCalled();
  });

  it("handles handler errors gracefully", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const handlers: ((event: Event) => void)[] = [];
    const subscribe = vi.fn((callback) => {
      handlers.push(callback);
      return () => {};
    });

    const adapter = createEventStreamAdapter({ subscribe });
    const goodHandlerEvents: any[] = [];

    // Bad handler that throws
    adapter.onEvent(() => {
      throw new Error("Handler error");
    });

    // Good handler
    adapter.onEvent((event) => goodHandlerEvents.push(event));

    // Should not throw
    expect(() => handlers[0](createTestEvent("spawn"))).not.toThrow();

    // Good handler should still receive event
    expect(goodHandlerEvents).toHaveLength(1);

    consoleSpy.mockRestore();
  });

  it("filters non-translatable events", () => {
    const handlers: ((event: Event) => void)[] = [];
    const subscribe = vi.fn((callback) => {
      handlers.push(callback);
      return () => {};
    });

    const adapter = createEventStreamAdapter({ subscribe });
    const receivedEvents: any[] = [];

    adapter.onEvent((event) => receivedEvents.push(event));

    // Send non-translatable event
    handlers[0](createTestEvent("subscription"));

    expect(receivedEvents).toHaveLength(0);
  });
});
