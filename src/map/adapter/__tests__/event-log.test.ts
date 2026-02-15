/**
 * Tests for EventLog — in-memory ring buffer for MAP event replay.
 */

import { describe, it, expect } from "vitest";
import {
  EventLog,
  underscoreToDot,
  dotToUnderscore,
  type LoggedEvent,
} from "../event-log.js";

// =============================================================================
// Helpers
// =============================================================================

function makeEvent(
  overrides: Partial<LoggedEvent> & { eventId: string },
): LoggedEvent {
  return {
    timestamp: Date.now(),
    type: "agent.registered",
    data: {},
    ...overrides,
  };
}

function makeEvents(count: number, prefix = "evt"): LoggedEvent[] {
  return Array.from({ length: count }, (_, i) =>
    makeEvent({
      eventId: `${prefix}-${String(i).padStart(4, "0")}`,
      timestamp: 1000 + i,
      type: i % 2 === 0 ? "agent.registered" : "message.sent",
      data: { index: i },
      agentId: `agent-${i % 3}`,
    }),
  );
}

// =============================================================================
// Format Normalization
// =============================================================================

describe("underscoreToDot", () => {
  it("converts underscore format to dot format", () => {
    expect(underscoreToDot("agent_registered")).toBe("agent.registered");
    expect(underscoreToDot("message_sent")).toBe("message.sent");
    expect(underscoreToDot("agent_state_changed")).toBe("agent.state.changed");
  });

  it("passes through dot format unchanged", () => {
    expect(underscoreToDot("agent.registered")).toBe("agent.registered");
  });

  it("handles strings with no separators", () => {
    expect(underscoreToDot("test")).toBe("test");
  });
});

describe("dotToUnderscore", () => {
  it("converts dot format to underscore format", () => {
    expect(dotToUnderscore("agent.registered")).toBe("agent_registered");
    expect(dotToUnderscore("message.sent")).toBe("message_sent");
    expect(dotToUnderscore("agent.state.changed")).toBe("agent_state_changed");
  });

  it("passes through underscore format unchanged", () => {
    expect(dotToUnderscore("agent_registered")).toBe("agent_registered");
  });
});

// =============================================================================
// EventLog — Basic Operations
// =============================================================================

describe("EventLog", () => {
  describe("append and query", () => {
    it("appends events and queries all in chronological order", () => {
      const log = new EventLog();
      const events = makeEvents(5);
      for (const e of events) log.append(e);

      const result = log.query({ limit: 100 });

      expect(result.events).toHaveLength(5);
      expect(result.events.map((e) => e.eventId)).toEqual(
        events.map((e) => e.eventId),
      );
      expect(result.hasMore).toBe(false);
    });

    it("returns empty result for empty buffer", () => {
      const log = new EventLog();
      const result = log.query();

      expect(result.events).toEqual([]);
      expect(result.hasMore).toBe(false);
    });

    it("reports correct size", () => {
      const log = new EventLog();
      expect(log.size).toBe(0);

      log.append(makeEvent({ eventId: "e1" }));
      expect(log.size).toBe(1);

      log.append(makeEvent({ eventId: "e2" }));
      expect(log.size).toBe(2);
    });
  });

  // ===========================================================================
  // Ring Buffer Eviction
  // ===========================================================================

  describe("ring buffer eviction", () => {
    it("evicts oldest events when exceeding maxSize", () => {
      const log = new EventLog({ maxSize: 5 });
      const events = makeEvents(8);
      for (const e of events) log.append(e);

      expect(log.size).toBe(5);

      const result = log.query({ limit: 100 });
      // Should have events 3-7 (oldest 0-2 evicted)
      expect(result.events).toHaveLength(5);
      expect(result.events[0].eventId).toBe("evt-0003");
      expect(result.events[4].eventId).toBe("evt-0007");
    });
  });

  // ===========================================================================
  // Keyset Pagination (afterEventId)
  // ===========================================================================

  describe("afterEventId pagination", () => {
    it("returns events after specified eventId", () => {
      const log = new EventLog();
      const events = makeEvents(10);
      for (const e of events) log.append(e);

      const result = log.query({ afterEventId: "evt-0004", limit: 100 });

      expect(result.events).toHaveLength(5);
      expect(result.events[0].eventId).toBe("evt-0005");
      expect(result.events[4].eventId).toBe("evt-0009");
    });

    it("returns empty when afterEventId is the last event", () => {
      const log = new EventLog();
      const events = makeEvents(5);
      for (const e of events) log.append(e);

      const result = log.query({ afterEventId: "evt-0004" });
      expect(result.events).toEqual([]);
      expect(result.hasMore).toBe(false);
    });

    it("starts from beginning when afterEventId is not found (evicted)", () => {
      const log = new EventLog({ maxSize: 5 });
      const events = makeEvents(10);
      for (const e of events) log.append(e);

      // evt-0002 has been evicted (buffer has evt-0005 through evt-0009)
      const result = log.query({ afterEventId: "evt-0002", limit: 100 });

      // Should start from beginning of buffer
      expect(result.events).toHaveLength(5);
      expect(result.events[0].eventId).toBe("evt-0005");
    });

    it("supports multi-page pagination", () => {
      const log = new EventLog();
      const events = makeEvents(10);
      for (const e of events) log.append(e);

      // Page 1
      const page1 = log.query({ limit: 3 });
      expect(page1.events).toHaveLength(3);
      expect(page1.hasMore).toBe(true);
      expect(page1.events[0].eventId).toBe("evt-0000");

      // Page 2
      const page2 = log.query({
        afterEventId: page1.events[2].eventId,
        limit: 3,
      });
      expect(page2.events).toHaveLength(3);
      expect(page2.hasMore).toBe(true);
      expect(page2.events[0].eventId).toBe("evt-0003");

      // Page 3
      const page3 = log.query({
        afterEventId: page2.events[2].eventId,
        limit: 3,
      });
      expect(page3.events).toHaveLength(3);
      expect(page3.hasMore).toBe(true);
      expect(page3.events[0].eventId).toBe("evt-0006");

      // Page 4 (last)
      const page4 = log.query({
        afterEventId: page3.events[2].eventId,
        limit: 3,
      });
      expect(page4.events).toHaveLength(1);
      expect(page4.hasMore).toBe(false);
      expect(page4.events[0].eventId).toBe("evt-0009");
    });
  });

  // ===========================================================================
  // Timestamp Filters
  // ===========================================================================

  describe("timestamp filtering", () => {
    it("filters events from fromTimestamp", () => {
      const log = new EventLog();
      const events = makeEvents(5);
      for (const e of events) log.append(e);

      const result = log.query({ fromTimestamp: 1003, limit: 100 });

      expect(result.events).toHaveLength(2);
      expect(result.events[0].eventId).toBe("evt-0003");
      expect(result.events[1].eventId).toBe("evt-0004");
    });

    it("filters events up to toTimestamp", () => {
      const log = new EventLog();
      const events = makeEvents(5);
      for (const e of events) log.append(e);

      const result = log.query({ toTimestamp: 1002, limit: 100 });

      expect(result.events).toHaveLength(3);
      expect(result.events[2].eventId).toBe("evt-0002");
    });

    it("combines fromTimestamp and toTimestamp", () => {
      const log = new EventLog();
      const events = makeEvents(10);
      for (const e of events) log.append(e);

      const result = log.query({
        fromTimestamp: 1003,
        toTimestamp: 1006,
        limit: 100,
      });

      expect(result.events).toHaveLength(4);
      expect(result.events[0].eventId).toBe("evt-0003");
      expect(result.events[3].eventId).toBe("evt-0006");
    });

    it("returns empty when fromTimestamp is beyond all events", () => {
      const log = new EventLog();
      const events = makeEvents(5);
      for (const e of events) log.append(e);

      const result = log.query({ fromTimestamp: 9999 });
      expect(result.events).toEqual([]);
    });
  });

  // ===========================================================================
  // Limit and hasMore
  // ===========================================================================

  describe("limit and hasMore", () => {
    it("respects limit parameter", () => {
      const log = new EventLog();
      const events = makeEvents(10);
      for (const e of events) log.append(e);

      const result = log.query({ limit: 3 });

      expect(result.events).toHaveLength(3);
      expect(result.hasMore).toBe(true);
    });

    it("defaults to 100 when limit not specified", () => {
      const log = new EventLog();
      const events = makeEvents(150);
      for (const e of events) log.append(e);

      const result = log.query();

      expect(result.events).toHaveLength(100);
      expect(result.hasMore).toBe(true);
    });

    it("caps limit at 1000", () => {
      const log = new EventLog();
      const events = makeEvents(1500);
      for (const e of events) log.append(e);

      const result = log.query({ limit: 5000 });

      expect(result.events).toHaveLength(1000);
      expect(result.hasMore).toBe(true);
    });

    it("hasMore is false when all events fit within limit", () => {
      const log = new EventLog();
      const events = makeEvents(3);
      for (const e of events) log.append(e);

      const result = log.query({ limit: 10 });

      expect(result.events).toHaveLength(3);
      expect(result.hasMore).toBe(false);
    });
  });

  // ===========================================================================
  // Event Type Filters
  // ===========================================================================

  describe("event type filter", () => {
    it("filters by underscore format event types", () => {
      const log = new EventLog();
      // Even indices: agent.registered, odd indices: message.sent
      const events = makeEvents(6);
      for (const e of events) log.append(e);

      const result = log.query({
        filter: { eventTypes: ["agent_registered"] },
        limit: 100,
      });

      expect(result.events).toHaveLength(3);
      expect(result.events.every((e) => e.type === "agent.registered")).toBe(
        true,
      );
    });

    it("filters by dot format event types", () => {
      const log = new EventLog();
      const events = makeEvents(6);
      for (const e of events) log.append(e);

      const result = log.query({
        filter: { eventTypes: ["agent.registered"] },
        limit: 100,
      });

      expect(result.events).toHaveLength(3);
    });

    it("handles mixed stored formats (dot and underscore)", () => {
      const log = new EventLog();
      // Event stored in dot format
      log.append(
        makeEvent({ eventId: "e1", type: "message.delivered", timestamp: 1 }),
      );
      // Event stored in underscore format (as ACP-over-MAP does)
      log.append(
        makeEvent({ eventId: "e2", type: "message_delivered", timestamp: 2 }),
      );
      // Different type
      log.append(
        makeEvent({ eventId: "e3", type: "agent.registered", timestamp: 3 }),
      );

      // Filter using underscore format — should match both message.delivered entries
      const result = log.query({
        filter: { eventTypes: ["message_delivered"] },
        limit: 100,
      });

      expect(result.events).toHaveLength(2);
      expect(result.events.map((e) => e.eventId)).toEqual(["e1", "e2"]);
    });

    it("supports multiple event types (OR)", () => {
      const log = new EventLog();
      const events = makeEvents(6);
      for (const e of events) log.append(e);

      const result = log.query({
        filter: { eventTypes: ["agent_registered", "message_sent"] },
        limit: 100,
      });

      // All 6 events match (alternating between the two types)
      expect(result.events).toHaveLength(6);
    });

    it("empty eventTypes array matches all events", () => {
      const log = new EventLog();
      const events = makeEvents(5);
      for (const e of events) log.append(e);

      const result = log.query({
        filter: { eventTypes: [] },
        limit: 100,
      });

      // Empty eventTypes should not filter (matches all)
      expect(result.events).toHaveLength(5);
    });
  });

  // ===========================================================================
  // Agent Filter
  // ===========================================================================

  describe("agent filter", () => {
    it("filters by agent ID", () => {
      const log = new EventLog();
      // makeEvents assigns agentId: agent-${i % 3}
      const events = makeEvents(9);
      for (const e of events) log.append(e);

      const result = log.query({
        filter: { agents: ["agent-0"] },
        limit: 100,
      });

      expect(result.events).toHaveLength(3);
      expect(result.events.every((e) => e.agentId === "agent-0")).toBe(true);
    });

    it("excludes events without agentId", () => {
      const log = new EventLog();
      log.append(makeEvent({ eventId: "e1", agentId: "agent-1" }));
      log.append(makeEvent({ eventId: "e2" })); // no agentId
      log.append(makeEvent({ eventId: "e3", agentId: "agent-1" }));

      const result = log.query({
        filter: { agents: ["agent-1"] },
        limit: 100,
      });

      expect(result.events).toHaveLength(2);
      expect(result.events.map((e) => e.eventId)).toEqual(["e1", "e3"]);
    });

    it("supports multiple agent IDs (OR)", () => {
      const log = new EventLog();
      const events = makeEvents(9);
      for (const e of events) log.append(e);

      const result = log.query({
        filter: { agents: ["agent-0", "agent-1"] },
        limit: 100,
      });

      expect(result.events).toHaveLength(6);
    });
  });

  // ===========================================================================
  // Scope Filter
  // ===========================================================================

  describe("scope filter", () => {
    it("filters by scope ID", () => {
      const log = new EventLog();
      log.append(makeEvent({ eventId: "e1", scopeId: "scope-a" }));
      log.append(makeEvent({ eventId: "e2", scopeId: "scope-b" }));
      log.append(makeEvent({ eventId: "e3", scopeId: "scope-a" }));
      log.append(makeEvent({ eventId: "e4" })); // no scopeId

      const result = log.query({
        filter: { scopes: ["scope-a"] },
        limit: 100,
      });

      expect(result.events).toHaveLength(2);
      expect(result.events.map((e) => e.eventId)).toEqual(["e1", "e3"]);
    });
  });

  // ===========================================================================
  // Combined Filters
  // ===========================================================================

  describe("combined filters (AND)", () => {
    it("combines eventType and agent filters", () => {
      const log = new EventLog();
      // makeEvents: even=agent.registered, odd=message.sent, agentId=agent-{i%3}
      const events = makeEvents(9);
      for (const e of events) log.append(e);

      const result = log.query({
        filter: {
          eventTypes: ["agent_registered"],
          agents: ["agent-0"],
        },
        limit: 100,
      });

      // agent.registered at indices 0,2,4,6,8
      // agent-0 at indices 0,3,6
      // Both: indices 0,6
      expect(result.events).toHaveLength(2);
      expect(result.events[0].eventId).toBe("evt-0000");
      expect(result.events[1].eventId).toBe("evt-0006");
    });
  });

  // ===========================================================================
  // Empty / No Filter
  // ===========================================================================

  describe("empty filter matches all", () => {
    it("returns all events with empty filter object", () => {
      const log = new EventLog();
      const events = makeEvents(5);
      for (const e of events) log.append(e);

      const result = log.query({ filter: {}, limit: 100 });
      expect(result.events).toHaveLength(5);
    });

    it("returns all events with no filter", () => {
      const log = new EventLog();
      const events = makeEvents(5);
      for (const e of events) log.append(e);

      const result = log.query({ limit: 100 });
      expect(result.events).toHaveLength(5);
    });
  });
});
