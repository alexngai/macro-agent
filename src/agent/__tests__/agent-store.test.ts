/**
 * Tests for AgentStore — minimal SQLite store for agent lifecycle.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { AgentStore } from "../agent-store.js";
import type { AgentRecord, SessionRecord } from "../agent-store.js";

describe("AgentStore", () => {
  let store: AgentStore;

  beforeEach(() => {
    store = new AgentStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  function makeAgent(overrides: Partial<AgentRecord> = {}): AgentRecord {
    return {
      id: `agent-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      role: "worker",
      state: "running",
      parent_id: null,
      lineage: [],
      scope: "default",
      task: "test task",
      cwd: "/tmp/test",
      capabilities: ["file.read", "file.write"],
      created_at: Date.now(),
      ...overrides,
    };
  }

  // ── Agent CRUD ─────────────────────────────────────────────

  describe("putAgent / getAgent", () => {
    it("should store and retrieve an agent", () => {
      const agent = makeAgent({ id: "agent-1", name: "Alice" });
      store.putAgent(agent);

      const retrieved = store.getAgent("agent-1");
      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe("agent-1");
      expect(retrieved!.name).toBe("Alice");
      expect(retrieved!.role).toBe("worker");
      expect(retrieved!.state).toBe("running");
      expect(retrieved!.capabilities).toEqual(["file.read", "file.write"]);
    });

    it("should return null for non-existent agent", () => {
      expect(store.getAgent("nonexistent")).toBeNull();
    });

    it("should upsert on duplicate ID", () => {
      store.putAgent(makeAgent({ id: "agent-1", name: "Alice" }));
      store.putAgent(makeAgent({ id: "agent-1", name: "Bob" }));

      const agent = store.getAgent("agent-1");
      expect(agent!.name).toBe("Bob");
    });

    it("should handle all optional fields", () => {
      const agent = makeAgent({
        id: "agent-full",
        name: "Full Agent",
        stop_reason: "completed",
        team: "team-alpha",
        task_id: "task-1",
        workspace_path: "/tmp/worktree",
        workspace_stream_id: "stream-1",
        config: { model: "claude-3" },
        metadata: { custom: "value" },
        started_at: Date.now(),
        stopped_at: Date.now(),
        last_activity_at: Date.now(),
      });
      store.putAgent(agent);

      const retrieved = store.getAgent("agent-full")!;
      expect(retrieved.team).toBe("team-alpha");
      expect(retrieved.workspace_path).toBe("/tmp/worktree");
      expect(retrieved.config).toEqual({ model: "claude-3" });
      expect(retrieved.metadata).toEqual({ custom: "value" });
      expect(retrieved.stop_reason).toBe("completed");
    });

    it("should preserve lineage as array", () => {
      const agent = makeAgent({
        id: "agent-child",
        lineage: ["agent-root", "agent-parent"],
      });
      store.putAgent(agent);

      const retrieved = store.getAgent("agent-child")!;
      expect(retrieved.lineage).toEqual(["agent-root", "agent-parent"]);
    });
  });

  // ── updateAgent ────────────────────────────────────────────

  describe("updateAgent", () => {
    it("should update specific fields", () => {
      store.putAgent(makeAgent({ id: "agent-1", state: "running" }));
      store.updateAgent("agent-1", {
        state: "stopped",
        stop_reason: "completed",
        stopped_at: Date.now(),
      });

      const agent = store.getAgent("agent-1")!;
      expect(agent.state).toBe("stopped");
      expect(agent.stop_reason).toBe("completed");
      expect(agent.stopped_at).toBeDefined();
    });

    it("should update JSON fields correctly", () => {
      store.putAgent(makeAgent({ id: "agent-1" }));
      store.updateAgent("agent-1", {
        metadata: { updated: true },
        capabilities: ["exec.command"],
      });

      const agent = store.getAgent("agent-1")!;
      expect(agent.metadata).toEqual({ updated: true });
      expect(agent.capabilities).toEqual(["exec.command"]);
    });

    it("should not modify other fields", () => {
      store.putAgent(
        makeAgent({ id: "agent-1", name: "Alice", role: "worker" })
      );
      store.updateAgent("agent-1", { state: "stopped" });

      const agent = store.getAgent("agent-1")!;
      expect(agent.name).toBe("Alice");
      expect(agent.role).toBe("worker");
    });

    it("should handle empty updates gracefully", () => {
      store.putAgent(makeAgent({ id: "agent-1" }));
      store.updateAgent("agent-1", {});
      expect(store.getAgent("agent-1")).not.toBeNull();
    });
  });

  // ── removeAgent ────────────────────────────────────────────

  describe("removeAgent", () => {
    it("should delete an agent", () => {
      store.putAgent(makeAgent({ id: "agent-1" }));
      store.removeAgent("agent-1");
      expect(store.getAgent("agent-1")).toBeNull();
    });

    it("should cascade delete sessions", () => {
      store.putAgent(makeAgent({ id: "agent-1" }));
      store.putSession({
        agent_id: "agent-1",
        session_id: "session-1",
        created_at: Date.now(),
      });
      store.removeAgent("agent-1");
      expect(store.getSession("agent-1")).toBeNull();
    });
  });

  // ── listAgents ─────────────────────────────────────────────

  describe("listAgents", () => {
    beforeEach(() => {
      store.putAgent(
        makeAgent({
          id: "w1",
          role: "worker",
          state: "running",
          team: "alpha",
          parent_id: "coord-1",
        })
      );
      store.putAgent(
        makeAgent({
          id: "w2",
          role: "worker",
          state: "stopped",
          team: "alpha",
          parent_id: "coord-1",
        })
      );
      store.putAgent(
        makeAgent({
          id: "c1",
          role: "coordinator",
          state: "running",
          team: "beta",
          parent_id: null,
        })
      );
    });

    it("should return all agents with no filter", () => {
      expect(store.listAgents()).toHaveLength(3);
    });

    it("should filter by state", () => {
      const running = store.listAgents({ state: "running" });
      expect(running).toHaveLength(2);
    });

    it("should filter by role", () => {
      const workers = store.listAgents({ role: "worker" });
      expect(workers).toHaveLength(2);
    });

    it("should filter by team", () => {
      const alpha = store.listAgents({ team: "alpha" });
      expect(alpha).toHaveLength(2);
    });

    it("should filter by parent_id null (root agents)", () => {
      const roots = store.listAgents({ parent_id: null });
      expect(roots).toHaveLength(1);
      expect(roots[0].id).toBe("c1");
    });

    it("should filter by parent_id value", () => {
      const children = store.listAgents({ parent_id: "coord-1" });
      expect(children).toHaveLength(2);
    });

    it("should combine filters", () => {
      const result = store.listAgents({
        role: "worker",
        state: "running",
      });
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("w1");
    });
  });

  // ── Hierarchy ──────────────────────────────────────────────

  describe("hierarchy queries", () => {
    beforeEach(() => {
      store.putAgent(makeAgent({ id: "root", parent_id: null }));
      store.putAgent(makeAgent({ id: "child-1", parent_id: "root" }));
      store.putAgent(makeAgent({ id: "child-2", parent_id: "root" }));
      store.putAgent(
        makeAgent({ id: "grandchild-1", parent_id: "child-1" })
      );
    });

    it("getChildren should return direct children", () => {
      const children = store.getChildren("root");
      expect(children).toHaveLength(2);
      expect(children.map((c) => c.id).sort()).toEqual([
        "child-1",
        "child-2",
      ]);
    });

    it("getChildren should return empty for leaf nodes", () => {
      expect(store.getChildren("grandchild-1")).toHaveLength(0);
    });

    it("getDescendants should return all descendants BFS", () => {
      const desc = store.getDescendants("root");
      expect(desc).toHaveLength(3);
      expect(desc.map((d) => d.id)).toContain("grandchild-1");
    });

    it("getAncestors should return parent chain", () => {
      const ancestors = store.getAncestors("grandchild-1");
      expect(ancestors).toHaveLength(2);
      expect(ancestors[0].id).toBe("child-1");
      expect(ancestors[1].id).toBe("root");
    });

    it("getAncestors should return empty for root", () => {
      expect(store.getAncestors("root")).toHaveLength(0);
    });
  });

  // ── Change Subscriptions ────────────────────────────────────

  describe("onChange", () => {
    it("should fire on putAgent", () => {
      const events: { type: string; agentId: string }[] = [];
      store.onChange((e) => events.push(e));

      store.putAgent(makeAgent({ id: "agent-1" }));

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ type: "put", agentId: "agent-1" });
    });

    it("should fire on updateAgent", () => {
      store.putAgent(makeAgent({ id: "agent-1" }));

      const events: { type: string; agentId: string }[] = [];
      store.onChange((e) => events.push(e));

      store.updateAgent("agent-1", { state: "stopped" });

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ type: "update", agentId: "agent-1" });
    });

    it("should fire on removeAgent", () => {
      store.putAgent(makeAgent({ id: "agent-1" }));

      const events: { type: string; agentId: string }[] = [];
      store.onChange((e) => events.push(e));

      store.removeAgent("agent-1");

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ type: "remove", agentId: "agent-1" });
    });

    it("should support unsubscribe", () => {
      const events: { type: string; agentId: string }[] = [];
      const unsub = store.onChange((e) => events.push(e));

      store.putAgent(makeAgent({ id: "agent-1" }));
      expect(events).toHaveLength(1);

      unsub();

      store.putAgent(makeAgent({ id: "agent-2" }));
      expect(events).toHaveLength(1); // No new events after unsub
    });

    it("should not break other listeners when one throws", () => {
      const events: { type: string; agentId: string }[] = [];

      store.onChange(() => {
        throw new Error("listener error");
      });
      store.onChange((e) => events.push(e));

      store.putAgent(makeAgent({ id: "agent-1" }));

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ type: "put", agentId: "agent-1" });
    });
  });

  // ── Sessions ───────────────────────────────────────────────

  describe("sessions", () => {
    beforeEach(() => {
      store.putAgent(makeAgent({ id: "agent-1" }));
    });

    it("should store and retrieve a session", () => {
      const session: SessionRecord = {
        agent_id: "agent-1",
        session_id: "session-abc",
        provider_session_id: "uuid-123",
        created_at: Date.now(),
      };
      store.putSession(session);

      const retrieved = store.getSession("agent-1");
      expect(retrieved).not.toBeNull();
      expect(retrieved!.session_id).toBe("session-abc");
      expect(retrieved!.provider_session_id).toBe("uuid-123");
    });

    it("should return null for non-existent session", () => {
      expect(store.getSession("agent-1")).toBeNull();
    });

    it("should upsert sessions", () => {
      store.putSession({
        agent_id: "agent-1",
        session_id: "session-1",
        created_at: Date.now(),
      });
      store.putSession({
        agent_id: "agent-1",
        session_id: "session-2",
        created_at: Date.now(),
      });

      const session = store.getSession("agent-1")!;
      expect(session.session_id).toBe("session-2");
    });

    it("removeSession should delete a session", () => {
      store.putSession({
        agent_id: "agent-1",
        session_id: "session-1",
        created_at: Date.now(),
      });
      store.removeSession("agent-1");
      expect(store.getSession("agent-1")).toBeNull();
    });

    it("should handle optional provider_session_id", () => {
      store.putSession({
        agent_id: "agent-1",
        session_id: "session-1",
        created_at: Date.now(),
      });

      const session = store.getSession("agent-1")!;
      expect(session.provider_session_id).toBeUndefined();
    });
  });
});
