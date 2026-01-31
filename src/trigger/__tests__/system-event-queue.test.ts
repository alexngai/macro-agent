/**
 * System Event Queue Tests
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createSystemEventQueue } from "../queue/system-event-queue.js";
import type { AgentId } from "../../store/types/index.js";

describe("SystemEventQueue", () => {
  let queue: ReturnType<typeof createSystemEventQueue>;
  const agentId = "agent_123" as AgentId;

  beforeEach(() => {
    queue = createSystemEventQueue({ maxEventsPerAgent: 10 });
  });

  describe("enqueue", () => {
    it("should enqueue events for an agent", () => {
      queue.enqueue("Event 1", { agentId });
      queue.enqueue("Event 2", { agentId });

      expect(queue.hasEvents(agentId)).toBe(true);
      expect(queue.getEventCount(agentId)).toBe(2);
    });

    it("should skip empty text", () => {
      queue.enqueue("", { agentId });
      queue.enqueue("   ", { agentId });

      expect(queue.hasEvents(agentId)).toBe(false);
    });

    it("should deduplicate consecutive identical events", () => {
      queue.enqueue("Same event", { agentId });
      queue.enqueue("Same event", { agentId });
      queue.enqueue("Same event", { agentId });

      expect(queue.getEventCount(agentId)).toBe(1);
    });

    it("should not deduplicate non-consecutive identical events", () => {
      queue.enqueue("Event A", { agentId });
      queue.enqueue("Event B", { agentId });
      queue.enqueue("Event A", { agentId });

      expect(queue.getEventCount(agentId)).toBe(3);
    });

    it("should enforce max events limit", () => {
      for (let i = 0; i < 15; i++) {
        queue.enqueue(`Event ${i}`, { agentId });
      }

      expect(queue.getEventCount(agentId)).toBe(10);
    });
  });

  describe("drain", () => {
    it("should drain all events and clear queue", () => {
      queue.enqueue("Event 1", { agentId });
      queue.enqueue("Event 2", { agentId });

      const events = queue.drain(agentId);

      expect(events).toHaveLength(2);
      expect(events[0].text).toBe("Event 1");
      expect(events[1].text).toBe("Event 2");
      expect(queue.hasEvents(agentId)).toBe(false);
    });

    it("should return empty array for agent with no events", () => {
      const events = queue.drain("nonexistent" as AgentId);
      expect(events).toHaveLength(0);
    });

    it("should sort by priority when requested", () => {
      queue.enqueue("Low priority", { agentId, priority: "low" });
      queue.enqueue("High priority", { agentId, priority: "high" });
      queue.enqueue("Normal priority", { agentId, priority: "normal" });

      const events = queue.drain(agentId, { sortByPriority: true });

      expect(events[0].text).toBe("High priority");
      expect(events[1].text).toBe("Normal priority");
      expect(events[2].text).toBe("Low priority");
    });
  });

  describe("drainText", () => {
    it("should return just text content", () => {
      queue.enqueue("Event 1", { agentId });
      queue.enqueue("Event 2", { agentId });

      const texts = queue.drainText(agentId);

      expect(texts).toEqual(["Event 1", "Event 2"]);
    });
  });

  describe("peek", () => {
    it("should return events without removing them", () => {
      queue.enqueue("Event 1", { agentId });

      const peeked = queue.peek(agentId);
      expect(peeked).toEqual(["Event 1"]);

      // Should still have events
      expect(queue.hasEvents(agentId)).toBe(true);
    });
  });

  describe("isContextChanged", () => {
    it("should detect context changes", () => {
      queue.enqueue("Event", { agentId, contextKey: "context-1" });

      expect(queue.isContextChanged(agentId, "context-1")).toBe(false);
      expect(queue.isContextChanged(agentId, "context-2")).toBe(true);
    });
  });

  describe("getAgentsWithEvents", () => {
    it("should return all agents with pending events", () => {
      const agent1 = "agent_1" as AgentId;
      const agent2 = "agent_2" as AgentId;

      queue.enqueue("Event 1", { agentId: agent1 });
      queue.enqueue("Event 2", { agentId: agent2 });

      const agents = queue.getAgentsWithEvents();

      expect(agents).toHaveLength(2);
      expect(agents).toContain(agent1);
      expect(agents).toContain(agent2);
    });
  });

  describe("reset", () => {
    it("should clear all queues", () => {
      queue.enqueue("Event 1", { agentId });

      queue.reset();

      expect(queue.hasEvents(agentId)).toBe(false);
      expect(queue.getAgentsWithEvents()).toHaveLength(0);
    });
  });
});
