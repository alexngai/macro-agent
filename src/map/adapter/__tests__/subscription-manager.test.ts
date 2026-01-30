/**
 * Tests for SubscriptionManager
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  createSubscriptionManager,
  SubscriptionError,
  type SubscriptionManager,
  type SubscriptionManagerEvent,
} from "../subscription-manager.js";
import type {
  ParticipantId,
  SubscriptionFilter,
  EventNotification,
  MAPEventType,
} from "../types.js";
import { createParticipantId } from "../types.js";
import type { AgentId } from "../../../store/types/index.js";

describe("SubscriptionManager", () => {
  let manager: SubscriptionManager;
  let participant1: ParticipantId;
  let participant2: ParticipantId;

  beforeEach(() => {
    manager = createSubscriptionManager();
    participant1 = createParticipantId("p-test-1");
    participant2 = createParticipantId("p-test-2");
  });

  describe("subscribe", () => {
    it("creates a subscription with generated ID", () => {
      const subscriptionId = manager.subscribe(participant1);

      expect(subscriptionId).toMatch(/^sub-/);

      const subscription = manager.getSubscription(subscriptionId);
      expect(subscription).toBeDefined();
      expect(subscription?.participantId).toBe(participant1);
    });

    it("stores subscription filter", () => {
      const filter: SubscriptionFilter = {
        eventTypes: ["agent.registered", "agent.unregistered"],
        agents: ["agent-1" as AgentId],
      };

      const subscriptionId = manager.subscribe(participant1, filter);
      const subscription = manager.getSubscription(subscriptionId);

      expect(subscription?.filter).toEqual(filter);
    });

    it("creates subscription with empty filter if not provided", () => {
      const subscriptionId = manager.subscribe(participant1);
      const subscription = manager.getSubscription(subscriptionId);

      expect(subscription?.filter).toEqual({});
    });

    it("sets initial state to not paused", () => {
      const subscriptionId = manager.subscribe(participant1);
      const subscription = manager.getSubscription(subscriptionId);

      expect(subscription?.paused).toBe(false);
    });

    it("emits subscription.created event", () => {
      const events: SubscriptionManagerEvent[] = [];
      manager.onEvent((e) => events.push(e));

      const subscriptionId = manager.subscribe(participant1);

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("subscription.created");
      if (events[0].type === "subscription.created") {
        expect(events[0].subscription.id).toBe(subscriptionId);
      }
    });

    it("enforces subscription limit per participant", () => {
      const limited = createSubscriptionManager({
        limits: { maxSubscriptionsPerConnection: 2 },
      });

      limited.subscribe(participant1);
      limited.subscribe(participant1);

      expect(() => limited.subscribe(participant1)).toThrow(SubscriptionError);
      expect(() => limited.subscribe(participant1)).toThrow(
        /Maximum subscriptions per connection exceeded/
      );
    });

    it("allows subscriptions for different participants", () => {
      const limited = createSubscriptionManager({
        limits: { maxSubscriptionsPerConnection: 1 },
      });

      limited.subscribe(participant1);
      const sub2 = limited.subscribe(participant2);

      expect(sub2).toBeDefined();
    });
  });

  describe("unsubscribe", () => {
    it("removes subscription", () => {
      const subscriptionId = manager.subscribe(participant1);
      expect(manager.getSubscription(subscriptionId)).toBeDefined();

      manager.unsubscribe(subscriptionId);

      expect(manager.getSubscription(subscriptionId)).toBeUndefined();
    });

    it("emits subscription.removed event", () => {
      const subscriptionId = manager.subscribe(participant1);

      const events: SubscriptionManagerEvent[] = [];
      manager.onEvent((e) => events.push(e));

      manager.unsubscribe(subscriptionId);

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("subscription.removed");
      if (events[0].type === "subscription.removed") {
        expect(events[0].subscriptionId).toBe(subscriptionId);
      }
    });

    it("is idempotent", () => {
      const subscriptionId = manager.subscribe(participant1);
      manager.unsubscribe(subscriptionId);

      // Should not throw
      expect(() => manager.unsubscribe(subscriptionId)).not.toThrow();
    });

    it("allows new subscriptions after unsubscribe (within limit)", () => {
      const limited = createSubscriptionManager({
        limits: { maxSubscriptionsPerConnection: 1 },
      });

      const sub1 = limited.subscribe(participant1);
      expect(() => limited.subscribe(participant1)).toThrow();

      limited.unsubscribe(sub1);

      const sub2 = limited.subscribe(participant1);
      expect(sub2).toBeDefined();
    });
  });

  describe("getSubscriptions", () => {
    it("returns all subscriptions for participant", () => {
      const sub1 = manager.subscribe(participant1);
      const sub2 = manager.subscribe(participant1);
      manager.subscribe(participant2);

      const subs = manager.getSubscriptions(participant1);

      expect(subs).toHaveLength(2);
      expect(subs.map((s) => s.id)).toContain(sub1);
      expect(subs.map((s) => s.id)).toContain(sub2);
    });

    it("returns empty array for unknown participant", () => {
      expect(manager.getSubscriptions(participant1)).toEqual([]);
    });
  });

  describe("getSubscriptionIds", () => {
    it("returns subscription IDs for participant", () => {
      const sub1 = manager.subscribe(participant1);
      const sub2 = manager.subscribe(participant1);

      const ids = manager.getSubscriptionIds(participant1);

      expect(ids).toHaveLength(2);
      expect(ids).toContain(sub1);
      expect(ids).toContain(sub2);
    });
  });

  describe("pause and resume", () => {
    it("pauses subscription", () => {
      const subscriptionId = manager.subscribe(participant1);
      expect(manager.isPaused(subscriptionId)).toBe(false);

      manager.pause(subscriptionId);

      expect(manager.isPaused(subscriptionId)).toBe(true);
    });

    it("resumes subscription", () => {
      const subscriptionId = manager.subscribe(participant1);
      manager.pause(subscriptionId);

      manager.resume(subscriptionId);

      expect(manager.isPaused(subscriptionId)).toBe(false);
    });

    it("emits pause event", () => {
      const subscriptionId = manager.subscribe(participant1);

      const events: SubscriptionManagerEvent[] = [];
      manager.onEvent((e) => events.push(e));

      manager.pause(subscriptionId);

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("subscription.paused");
    });

    it("emits resume event", () => {
      const subscriptionId = manager.subscribe(participant1);
      manager.pause(subscriptionId);

      const events: SubscriptionManagerEvent[] = [];
      manager.onEvent((e) => events.push(e));

      manager.resume(subscriptionId);

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("subscription.resumed");
    });

    it("throws for unknown subscription on pause", () => {
      expect(() => manager.pause("unknown" as any)).toThrow(SubscriptionError);
    });

    it("throws for unknown subscription on resume", () => {
      expect(() => manager.resume("unknown" as any)).toThrow(SubscriptionError);
    });

    it("does not emit event if already paused", () => {
      const subscriptionId = manager.subscribe(participant1);
      manager.pause(subscriptionId);

      const events: SubscriptionManagerEvent[] = [];
      manager.onEvent((e) => events.push(e));

      manager.pause(subscriptionId);

      expect(events).toHaveLength(0);
    });

    it("does not emit event if already resumed", () => {
      const subscriptionId = manager.subscribe(participant1);

      const events: SubscriptionManagerEvent[] = [];
      manager.onEvent((e) => events.push(e));

      manager.resume(subscriptionId);

      expect(events).toHaveLength(0);
    });
  });

  describe("match", () => {
    const createEvent = (
      type: MAPEventType,
      agentId?: AgentId,
      scopeId?: string
    ): EventNotification => ({
      eventId: "evt-1",
      type,
      timestamp: Date.now(),
      data: {},
      agentId,
      scopeId: scopeId as any,
    });

    it("matches subscription with empty filter", () => {
      manager.subscribe(participant1, {});

      const event = createEvent("agent.registered", "agent-1" as AgentId);
      const result = manager.match(event);

      expect(result.subscriptions).toHaveLength(1);
      expect(result.participantIds).toContain(participant1);
    });

    it("filters by event type", () => {
      manager.subscribe(participant1, {
        eventTypes: ["agent.registered"],
      });
      manager.subscribe(participant2, {
        eventTypes: ["agent.unregistered"],
      });

      const event = createEvent("agent.registered", "agent-1" as AgentId);
      const result = manager.match(event);

      expect(result.participantIds).toContain(participant1);
      expect(result.participantIds).not.toContain(participant2);
    });

    it("filters by agent ID", () => {
      manager.subscribe(participant1, {
        agents: ["agent-1" as AgentId],
      });
      manager.subscribe(participant2, {
        agents: ["agent-2" as AgentId],
      });

      const event = createEvent("agent.registered", "agent-1" as AgentId);
      const result = manager.match(event);

      expect(result.participantIds).toContain(participant1);
      expect(result.participantIds).not.toContain(participant2);
    });

    it("filters by scope ID", () => {
      manager.subscribe(participant1, {
        scopes: ["scope-1" as any],
      });

      const eventWithScope = createEvent(
        "scope.member.joined",
        undefined,
        "scope-1"
      );
      const eventWithoutScope = createEvent(
        "scope.member.joined",
        undefined,
        "scope-2"
      );

      expect(manager.match(eventWithScope).participantIds).toContain(participant1);
      expect(manager.match(eventWithoutScope).participantIds).not.toContain(
        participant1
      );
    });

    it("combines filters with AND logic", () => {
      manager.subscribe(participant1, {
        eventTypes: ["agent.registered"],
        agents: ["agent-1" as AgentId],
      });

      // Matches both
      const event1 = createEvent("agent.registered", "agent-1" as AgentId);
      expect(manager.match(event1).participantIds).toContain(participant1);

      // Wrong event type
      const event2 = createEvent("agent.unregistered", "agent-1" as AgentId);
      expect(manager.match(event2).participantIds).not.toContain(participant1);

      // Wrong agent
      const event3 = createEvent("agent.registered", "agent-2" as AgentId);
      expect(manager.match(event3).participantIds).not.toContain(participant1);
    });

    it("skips paused subscriptions", () => {
      const subscriptionId = manager.subscribe(participant1, {});
      manager.pause(subscriptionId);

      const event = createEvent("agent.registered", "agent-1" as AgentId);
      const result = manager.match(event);

      expect(result.subscriptions).toHaveLength(0);
      expect(result.participantIds).toHaveLength(0);
    });

    it("deduplicates participant IDs when multiple subscriptions match", () => {
      manager.subscribe(participant1, { eventTypes: ["agent.registered"] });
      manager.subscribe(participant1, { agents: ["agent-1" as AgentId] });

      const event = createEvent("agent.registered", "agent-1" as AgentId);
      const result = manager.match(event);

      expect(result.subscriptions).toHaveLength(2);
      expect(result.participantIds).toHaveLength(1); // Deduplicated
    });

    describe("subtree filter", () => {
      it("matches events from descendants", () => {
        const managerWithHierarchy = createSubscriptionManager({
          getDescendants: (agentId) => {
            if (agentId === ("root" as AgentId)) {
              return ["child-1", "child-2", "grandchild-1"] as AgentId[];
            }
            return [];
          },
        });

        managerWithHierarchy.subscribe(participant1, {
          subtree: "root" as AgentId,
        });

        // Root itself
        const eventRoot = createEvent("agent.state.changed", "root" as AgentId);
        expect(
          managerWithHierarchy.match(eventRoot).participantIds
        ).toContain(participant1);

        // Descendant
        const eventChild = createEvent(
          "agent.state.changed",
          "child-1" as AgentId
        );
        expect(
          managerWithHierarchy.match(eventChild).participantIds
        ).toContain(participant1);

        // Non-descendant
        const eventOther = createEvent(
          "agent.state.changed",
          "other" as AgentId
        );
        expect(
          managerWithHierarchy.match(eventOther).participantIds
        ).not.toContain(participant1);
      });
    });

    describe("lineage filter", () => {
      it("matches events from ancestors", () => {
        const managerWithHierarchy = createSubscriptionManager({
          getAncestors: (agentId) => {
            if (agentId === ("child" as AgentId)) {
              return ["parent", "root"] as AgentId[];
            }
            return [];
          },
        });

        managerWithHierarchy.subscribe(participant1, {
          lineage: "child" as AgentId,
        });

        // Child itself
        const eventChild = createEvent(
          "agent.state.changed",
          "child" as AgentId
        );
        expect(
          managerWithHierarchy.match(eventChild).participantIds
        ).toContain(participant1);

        // Ancestor
        const eventParent = createEvent(
          "agent.state.changed",
          "parent" as AgentId
        );
        expect(
          managerWithHierarchy.match(eventParent).participantIds
        ).toContain(participant1);

        // Non-ancestor
        const eventOther = createEvent(
          "agent.state.changed",
          "other" as AgentId
        );
        expect(
          managerWithHierarchy.match(eventOther).participantIds
        ).not.toContain(participant1);
      });
    });
  });

  describe("removeAllForParticipant", () => {
    it("removes all subscriptions for participant", () => {
      manager.subscribe(participant1);
      manager.subscribe(participant1);
      const sub3 = manager.subscribe(participant2);

      manager.removeAllForParticipant(participant1);

      expect(manager.getSubscriptions(participant1)).toHaveLength(0);
      expect(manager.getSubscription(sub3)).toBeDefined();
    });

    it("emits remove event for each subscription", () => {
      manager.subscribe(participant1);
      manager.subscribe(participant1);

      const events: SubscriptionManagerEvent[] = [];
      manager.onEvent((e) => events.push(e));

      manager.removeAllForParticipant(participant1);

      const removeEvents = events.filter((e) => e.type === "subscription.removed");
      expect(removeEvents).toHaveLength(2);
    });

    it("is idempotent for unknown participant", () => {
      expect(() =>
        manager.removeAllForParticipant(participant1)
      ).not.toThrow();
    });
  });

  describe("getSubscriptionCount", () => {
    it("returns total subscription count", () => {
      expect(manager.getSubscriptionCount()).toBe(0);

      manager.subscribe(participant1);
      expect(manager.getSubscriptionCount()).toBe(1);

      manager.subscribe(participant2);
      expect(manager.getSubscriptionCount()).toBe(2);
    });
  });

  describe("onEvent", () => {
    it("returns unsubscribe function", () => {
      const events: SubscriptionManagerEvent[] = [];
      const unsubscribe = manager.onEvent((e) => events.push(e));

      manager.subscribe(participant1);
      expect(events).toHaveLength(1);

      unsubscribe();

      manager.subscribe(participant1);
      expect(events).toHaveLength(1);
    });

    it("handles errors in event handlers gracefully", () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      manager.onEvent(() => {
        throw new Error("Handler error");
      });

      expect(() => manager.subscribe(participant1)).not.toThrow();

      consoleSpy.mockRestore();
    });
  });
});
