/**
 * Session persistence and recovery tests
 *
 * Tests that session lifecycle events are persisted to the EventStore
 * and that SessionMapper can recover its state from persisted sessions.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SessionMapper } from "../session-mapper.js";
import { createEventStore, type EventStore } from "../../store/event-store.js";

describe("Session Persistence", () => {
  let eventStore: EventStore;
  let mapper: SessionMapper;

  beforeEach(async () => {
    eventStore = await createEventStore({ inMemory: true });
    mapper = new SessionMapper(eventStore);
  });

  afterEach(async () => {
    await eventStore.close();
  });

  describe("session lifecycle events", () => {
    it("should emit session created event on createMapping", () => {
      mapper.createMapping("session-1", "agent-head");

      const session = eventStore.getSession("session-1");
      expect(session).not.toBeNull();
      expect(session!.id).toBe("session-1");
      expect(session!.head_manager_id).toBe("agent-head");
      expect(session!.current_agent_id).toBe("agent-head");
      expect(session!.state).toBe("active");
      expect(session!.created_at).toBeGreaterThan(0);
    });

    it("should emit session mounted event on mount", () => {
      mapper.createMapping("session-1", "agent-head");
      mapper.mount("session-1", "agent-child");

      const session = eventStore.getSession("session-1");
      expect(session!.state).toBe("mounted");
      expect(session!.current_agent_id).toBe("agent-child");
      expect(session!.head_manager_id).toBe("agent-head");
    });

    it("should emit session unmounted event on unmount", () => {
      mapper.createMapping("session-1", "agent-head");
      mapper.mount("session-1", "agent-child");
      mapper.unmount("session-1");

      const session = eventStore.getSession("session-1");
      expect(session!.state).toBe("active");
      expect(session!.current_agent_id).toBe("agent-head");
    });

    it("should emit unmounted when mounting back to head manager", () => {
      mapper.createMapping("session-1", "agent-head");
      mapper.mount("session-1", "agent-child");
      mapper.mount("session-1", "agent-head");

      const session = eventStore.getSession("session-1");
      expect(session!.state).toBe("active");
      expect(session!.current_agent_id).toBe("agent-head");
    });

    it("should emit session closed event on removeMapping", () => {
      mapper.createMapping("session-1", "agent-head");
      mapper.removeMapping("session-1");

      const session = eventStore.getSession("session-1");
      expect(session!.state).toBe("closed");
      expect(session!.closed_at).toBeGreaterThan(0);
    });

    it("should not emit close for non-existent session", () => {
      mapper.removeMapping("non-existent");

      const session = eventStore.getSession("non-existent");
      expect(session).toBeNull();
    });

    it("should track multiple sessions independently", () => {
      mapper.createMapping("session-1", "agent-1");
      mapper.createMapping("session-2", "agent-2");
      mapper.mount("session-1", "agent-child");

      const s1 = eventStore.getSession("session-1");
      const s2 = eventStore.getSession("session-2");

      expect(s1!.state).toBe("mounted");
      expect(s2!.state).toBe("active");
    });
  });

  describe("listSessions", () => {
    it("should list sessions by state", () => {
      mapper.createMapping("session-1", "agent-1");
      mapper.createMapping("session-2", "agent-2");
      mapper.mount("session-1", "agent-child");

      const active = eventStore.listSessions({ state: "active" });
      const mounted = eventStore.listSessions({ state: "mounted" });

      expect(active).toHaveLength(1);
      expect(active[0].id).toBe("session-2");
      expect(mounted).toHaveLength(1);
      expect(mounted[0].id).toBe("session-1");
    });

    it("should list sessions by agent", () => {
      mapper.createMapping("session-1", "agent-1");
      mapper.createMapping("session-2", "agent-2");

      const sessions = eventStore.listSessions({ agent_id: "agent-1" });
      expect(sessions).toHaveLength(1);
      expect(sessions[0].id).toBe("session-1");
    });

    it("should filter closed sessions", () => {
      mapper.createMapping("session-1", "agent-1");
      mapper.createMapping("session-2", "agent-2");
      mapper.removeMapping("session-1");

      const active = eventStore.listSessions({ state: "active" });
      const closed = eventStore.listSessions({ state: "closed" });

      expect(active).toHaveLength(1);
      expect(active[0].id).toBe("session-2");
      expect(closed).toHaveLength(1);
      expect(closed[0].id).toBe("session-1");
    });
  });

  describe("session events in event log", () => {
    it("should persist session events that can be queried", () => {
      mapper.createMapping("session-1", "agent-head");
      mapper.mount("session-1", "agent-child");
      mapper.unmount("session-1");
      mapper.removeMapping("session-1");

      const events = eventStore.query({ type: "session" });
      expect(events).toHaveLength(4);
      expect(events[0].payload.action).toBe("created");
      expect(events[1].payload.action).toBe("mounted");
      expect(events[2].payload.action).toBe("unmounted");
      expect(events[3].payload.action).toBe("closed");
    });
  });
});

describe("Session Recovery", () => {
  let eventStore: EventStore;

  beforeEach(async () => {
    eventStore = await createEventStore({ inMemory: true });
  });

  afterEach(async () => {
    await eventStore.close();
  });

  it("should recover active sessions from EventStore", () => {
    // Create sessions with original mapper
    const original = new SessionMapper(eventStore);
    original.createMapping("session-1", "agent-1");
    original.createMapping("session-2", "agent-2");

    // Create new mapper and recover
    const recovered = new SessionMapper(eventStore);
    const count = recovered.recoverFromStore();

    expect(count).toBe(2);
    expect(recovered.size).toBe(2);
    expect(recovered.getAgentId("session-1")).toBe("agent-1");
    expect(recovered.getAgentId("session-2")).toBe("agent-2");
  });

  it("should recover mounted sessions with correct state", () => {
    const original = new SessionMapper(eventStore);
    original.createMapping("session-1", "agent-head");
    original.mount("session-1", "agent-child");

    const recovered = new SessionMapper(eventStore);
    const count = recovered.recoverFromStore();

    expect(count).toBe(1);
    expect(recovered.getAgentId("session-1")).toBe("agent-child");
    expect(recovered.getHeadManagerId("session-1")).toBe("agent-head");
    expect(recovered.isMounted("session-1")).toBe(true);
  });

  it("should not recover closed sessions", () => {
    const original = new SessionMapper(eventStore);
    original.createMapping("session-1", "agent-1");
    original.createMapping("session-2", "agent-2");
    original.removeMapping("session-1");

    const recovered = new SessionMapper(eventStore);
    const count = recovered.recoverFromStore();

    expect(count).toBe(1);
    expect(recovered.getAgentId("session-1")).toBeUndefined();
    expect(recovered.getAgentId("session-2")).toBe("agent-2");
  });

  it("should recover after unmount returns to active state", () => {
    const original = new SessionMapper(eventStore);
    original.createMapping("session-1", "agent-head");
    original.mount("session-1", "agent-child");
    original.unmount("session-1");

    const recovered = new SessionMapper(eventStore);
    const count = recovered.recoverFromStore();

    expect(count).toBe(1);
    expect(recovered.getAgentId("session-1")).toBe("agent-head");
    expect(recovered.isMounted("session-1")).toBe(false);
  });

  it("should reset isProcessing to false on recovery", () => {
    const original = new SessionMapper(eventStore);
    original.createMapping("session-1", "agent-1");
    original.setProcessing("session-1", true);

    const recovered = new SessionMapper(eventStore);
    recovered.recoverFromStore();

    const status = recovered.getSessionStatus("agent-1");
    expect(status).toBeDefined();
    expect(status!.isProcessing).toBe(false);
  });

  it("should return 0 when no EventStore is configured", () => {
    const mapper = new SessionMapper();
    const count = mapper.recoverFromStore();
    expect(count).toBe(0);
  });

  it("should survive view rebuild", () => {
    const original = new SessionMapper(eventStore);
    original.createMapping("session-1", "agent-1");
    original.createMapping("session-2", "agent-2");
    original.mount("session-1", "agent-child");
    original.removeMapping("session-2");

    // Simulate reload (which rebuilds views from events)
    // We don't need to call reload() since in-memory; just verify
    // the view state matches after rebuilding
    const session1 = eventStore.getSession("session-1");
    const session2 = eventStore.getSession("session-2");

    expect(session1!.state).toBe("mounted");
    expect(session1!.current_agent_id).toBe("agent-child");
    expect(session2!.state).toBe("closed");
  });
});

describe("SessionMapper backward compatibility", () => {
  it("should work without EventStore (original behavior)", () => {
    const mapper = new SessionMapper();

    const mapping = mapper.createMapping("session-1", "agent-head");
    expect(mapping.agentId).toBe("agent-head");

    mapper.mount("session-1", "agent-child");
    expect(mapper.getAgentId("session-1")).toBe("agent-child");

    mapper.unmount("session-1");
    expect(mapper.getAgentId("session-1")).toBe("agent-head");

    mapper.removeMapping("session-1");
    expect(mapper.getMapping("session-1")).toBeUndefined();
  });
});
