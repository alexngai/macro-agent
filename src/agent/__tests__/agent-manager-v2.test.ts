/**
 * Tests for AgentManager V2 — uses AgentStore + InboxAdapter + TasksAdapter
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createAgentManagerV2 } from "../agent-manager-v2.js";
import { AgentStore } from "../agent-store.js";
import type { AgentManager } from "../agent-manager.js";
import type { InboxAdapter, TasksAdapter } from "../../adapters/types.js";
import type { AgentId } from "../../store/types/index.js";

// ─────────────────────────────────────────────────────────────────
// Mocks
// ─────────────────────────────────────────────────────────────────

// Mock acp-factory
vi.mock("acp-factory", () => ({
  AgentFactory: {
    spawn: vi.fn().mockResolvedValue({
      createSession: vi.fn().mockResolvedValue({
        id: "provider-session-1",
        prompt: vi.fn().mockReturnValue({
          [Symbol.asyncIterator]: () => ({
            next: () => Promise.resolve({ done: true, value: undefined }),
          }),
        }),
        forkWithFlush: vi.fn().mockResolvedValue({ id: "forked-session-1" }),
      }),
      loadSession: vi.fn().mockResolvedValue({
        id: "loaded-session-1",
        prompt: vi.fn().mockReturnValue({
          [Symbol.asyncIterator]: () => ({
            next: () => Promise.resolve({ done: true, value: undefined }),
          }),
        }),
      }),
      close: vi.fn().mockResolvedValue(undefined),
      isRunning: vi.fn().mockReturnValue(true),
    }),
  },
}));

function createMockInboxAdapter(): InboxAdapter {
  return {
    registerAgent: vi.fn().mockResolvedValue(undefined),
    deregisterAgent: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue("msg-1"),
    onDelivery: vi.fn(),
    offDelivery: vi.fn(),
    checkInbox: vi.fn().mockResolvedValue([]),
    readThread: vi.fn().mockResolvedValue([]),
    setSignalFilter: vi.fn(),
    setEmissionValidator: vi.fn(),
    socketPath: "/tmp/test-inbox.sock",
    stop: vi.fn().mockResolvedValue(undefined),
  } as unknown as InboxAdapter;
}

function createMockTasksAdapter(): TasksAdapter {
  return {
    createTask: vi.fn().mockResolvedValue("ot-task-1"),
    assignTask: vi.fn().mockResolvedValue(undefined),
    transitionTask: vi.fn().mockResolvedValue(undefined),
    getTask: vi.fn().mockResolvedValue({ id: "t-1", title: "test", status: "open" }),
    queryReady: vi.fn().mockResolvedValue([]),
    listTasks: vi.fn().mockResolvedValue([]),
    addBlocker: vi.fn().mockResolvedValue(undefined),
    removeBlocker: vi.fn().mockResolvedValue(undefined),
    claimTask: vi.fn().mockResolvedValue(null),
    unclaimTask: vi.fn().mockResolvedValue(undefined),
    listClaimable: vi.fn().mockResolvedValue([]),
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
    connected: true,
  } as unknown as TasksAdapter;
}

// ─────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────

describe("AgentManagerV2", () => {
  let agentStore: AgentStore;
  let inboxAdapter: InboxAdapter;
  let tasksAdapter: TasksAdapter;
  let manager: AgentManager;

  beforeEach(() => {
    agentStore = new AgentStore(":memory:");
    inboxAdapter = createMockInboxAdapter();
    tasksAdapter = createMockTasksAdapter();
    manager = createAgentManagerV2(agentStore, inboxAdapter, tasksAdapter, {
      defaultCwd: "/tmp/test",
    });
  });

  afterEach(async () => {
    await manager.close();
    agentStore.close();
  });

  // ── spawn() ────────────────────────────────────────────────

  describe("spawn()", () => {
    it("should spawn an agent and persist to AgentStore", async () => {
      const result = await manager.spawn({
        task: "Write tests",
        role: "worker",
      });

      expect(result.id).toBeDefined();
      expect(result.session).toBeDefined();
      expect(result.agent.role).toBe("worker");
      expect(result.agent.state).toBe("running");

      // Verify persisted in store
      const record = agentStore.getAgent(result.id);
      expect(record).not.toBeNull();
      expect(record!.role).toBe("worker");
      expect(record!.state).toBe("running");
    });

    it("should register agent in inbox", async () => {
      const result = await manager.spawn({
        task: "Write tests",
        role: "worker",
      });

      expect(inboxAdapter.registerAgent).toHaveBeenCalledWith(
        result.id,
        expect.objectContaining({
          role: "worker",
          scope: "default",
        })
      );
    });

    it("should not create task in opentasks on spawn", async () => {
      await manager.spawn({
        task: "Implement feature",
        role: "worker",
      });

      expect(tasksAdapter.createTask).not.toHaveBeenCalled();
    });

    it("should validate parent exists", async () => {
      await expect(
        manager.spawn({
          task: "Child task",
          parent: "nonexistent-parent" as AgentId,
        })
      ).rejects.toThrow("not found");
    });

    it("should compute lineage from parent", async () => {
      const parent = await manager.spawn({
        task: "Parent task",
        role: "coordinator",
      });

      const child = await manager.spawn({
        task: "Child task",
        role: "worker",
        parent: parent.id,
      });

      const childRecord = agentStore.getAgent(child.id)!;
      expect(childRecord.lineage).toContain(parent.id);
    });

    it("should apply spawn interceptor", async () => {
      manager.setSpawnInterceptor((opts) => ({
        ...opts,
        customPrompt: "Injected by interceptor",
      }));

      const result = await manager.spawn({
        task: "Test task",
        role: "worker",
      });

      // Agent should have been spawned (interceptor applied successfully)
      expect(result.id).toBeDefined();
    });

    it("should generate a human-readable name", async () => {
      const result = await manager.spawn({
        task: "Test",
        role: "worker",
      });

      const record = agentStore.getAgent(result.id)!;
      expect(record.name).toBeDefined();
      expect(record.name!.includes("-")).toBe(true); // "adjective-animal" format
    });

    it("should set team scope when team_instance provided", async () => {
      const result = await manager.spawn({
        task: "Team task",
        role: "worker",
        team_instance: "gsd-team",
      });

      const record = agentStore.getAgent(result.id)!;
      expect(record.team).toBe("gsd-team");
      expect(record.scope).toBe("gsd-team");

      expect(inboxAdapter.registerAgent).toHaveBeenCalledWith(
        result.id,
        expect.objectContaining({ scope: "gsd-team" })
      );
    });

    it("should mark agent as failed if spawn process fails", async () => {
      const { AgentFactory } = await import("acp-factory");
      vi.mocked(AgentFactory.spawn).mockRejectedValueOnce(
        new Error("Process failed")
      );

      await expect(
        manager.spawn({ task: "Failing task", role: "worker" })
      ).rejects.toThrow("Process failed");

      // Agent should be in store with failed state
      const agents = agentStore.listAgents({ state: "failed" });
      expect(agents.length).toBeGreaterThanOrEqual(1);
    });

    it("should not spawn during shutdown", async () => {
      await manager.close();
      await expect(
        manager.spawn({ task: "Late task", role: "worker" })
      ).rejects.toThrow("shutdown");
    });
  });

  // ── terminate() ────────────────────────────────────────────

  describe("terminate()", () => {
    it("should terminate an agent and update store", async () => {
      const spawned = await manager.spawn({
        task: "Test",
        role: "worker",
      });

      await manager.terminate(spawned.id, "completed");

      const record = agentStore.getAgent(spawned.id)!;
      expect(record.state).toBe("stopped");
      expect(record.stop_reason).toBe("completed");
      expect(record.stopped_at).toBeDefined();
    });

    it("should deregister from inbox", async () => {
      const spawned = await manager.spawn({
        task: "Test",
        role: "worker",
      });

      await manager.terminate(spawned.id, "completed");

      expect(inboxAdapter.deregisterAgent).toHaveBeenCalledWith(spawned.id);
    });

    it("should not transition task in opentasks on terminate", async () => {
      const spawned = await manager.spawn({
        task: "Test",
        role: "worker",
      });

      await manager.terminate(spawned.id, "completed");

      expect(tasksAdapter.transitionTask).not.toHaveBeenCalled();
    });

    it("should notify parent via inbox", async () => {
      const parent = await manager.spawn({
        task: "Parent",
        role: "coordinator",
      });

      const child = await manager.spawn({
        task: "Child",
        role: "worker",
        parent: parent.id,
      });

      await manager.terminate(child.id, "completed");

      expect(inboxAdapter.send).toHaveBeenCalledWith(
        child.id,
        parent.id,
        expect.objectContaining({
          type: "event",
          event: "agent_stopped",
        }),
        expect.objectContaining({ importance: "high" })
      );
    });

    it("should cascade terminate to children", async () => {
      const parent = await manager.spawn({
        task: "Parent",
        role: "coordinator",
      });

      const child = await manager.spawn({
        task: "Child",
        role: "worker",
        parent: parent.id,
      });

      await manager.terminate(parent.id, "completed");

      // Child should also be stopped
      const childRecord = agentStore.getAgent(child.id)!;
      expect(childRecord.state).toBe("stopped");
    });

    it("should throw for non-existent agent", async () => {
      await expect(
        manager.terminate("nonexistent" as AgentId, "completed")
      ).rejects.toThrow("not found");
    });

    it("should fire lifecycle callback", async () => {
      const events: any[] = [];
      manager.onLifecycleEvent((e) => events.push(e));

      const spawned = await manager.spawn({
        task: "Test",
        role: "worker",
      });

      await manager.terminate(spawned.id, "completed");

      const stopEvent = events.find(
        (e) => e.type === "stopped" && e.agent.id === spawned.id
      );
      expect(stopEvent).toBeDefined();
      expect(stopEvent.reason).toBe("completed");
    });
  });

  // ── Query Methods ──────────────────────────────────────────

  describe("query methods", () => {
    it("get() should return agent", async () => {
      const spawned = await manager.spawn({
        task: "Test",
        role: "worker",
      });

      const agent = manager.get(spawned.id);
      expect(agent).not.toBeNull();
      expect(agent!.id).toBe(spawned.id);
    });

    it("get() should return null for non-existent", () => {
      expect(manager.get("nope" as AgentId)).toBeNull();
    });

    it("list() should return all agents", async () => {
      await manager.spawn({ task: "A", role: "worker" });
      await manager.spawn({ task: "B", role: "worker" });

      const agents = manager.list();
      expect(agents.length).toBeGreaterThanOrEqual(2);
    });

    it("list() should filter by state", async () => {
      const spawned = await manager.spawn({
        task: "Test",
        role: "worker",
      });
      await manager.terminate(spawned.id, "completed");

      const running = manager.list({ state: "running" });
      const stopped = manager.list({ state: "stopped" });

      expect(running.find((a) => a.id === spawned.id)).toBeUndefined();
      expect(stopped.find((a) => a.id === spawned.id)).toBeDefined();
    });

    it("getChildren() should return direct children", async () => {
      const parent = await manager.spawn({
        task: "Parent",
        role: "coordinator",
      });
      const child = await manager.spawn({
        task: "Child",
        role: "worker",
        parent: parent.id,
      });

      const children = manager.getChildren(parent.id);
      expect(children).toHaveLength(1);
      expect(children[0].id).toBe(child.id);
    });

    it("getHierarchy() should build tree", async () => {
      const root = await manager.spawn({
        task: "Root",
        role: "coordinator",
      });
      await manager.spawn({
        task: "Child 1",
        role: "worker",
        parent: root.id,
      });
      await manager.spawn({
        task: "Child 2",
        role: "worker",
        parent: root.id,
      });

      const hierarchy = manager.getHierarchy(root.id);
      expect(hierarchy).not.toBeNull();
      expect(hierarchy!.root.children).toHaveLength(2);
      expect(hierarchy!.totalAgents).toBe(3);
    });
  });

  // ── Session Methods ────────────────────────────────────────

  describe("session methods", () => {
    it("hasActiveSession() should be true after spawn", async () => {
      const spawned = await manager.spawn({
        task: "Test",
        role: "worker",
      });
      expect(manager.hasActiveSession(spawned.id)).toBe(true);
    });

    it("hasActiveSession() should be false after terminate", async () => {
      const spawned = await manager.spawn({
        task: "Test",
        role: "worker",
      });
      await manager.terminate(spawned.id, "completed");
      expect(manager.hasActiveSession(spawned.id)).toBe(false);
    });

    it("getSession() should return session", async () => {
      const spawned = await manager.spawn({
        task: "Test",
        role: "worker",
      });
      const session = manager.getSession(spawned.id);
      expect(session).not.toBeNull();
    });
  });

  // ── Lifecycle Callbacks ────────────────────────────────────

  describe("lifecycle callbacks", () => {
    it("should fire spawned and started events", async () => {
      const events: any[] = [];
      manager.onLifecycleEvent((e) => events.push(e));

      await manager.spawn({ task: "Test", role: "worker" });

      expect(events.find((e) => e.type === "spawned")).toBeDefined();
      expect(events.find((e) => e.type === "started")).toBeDefined();
    });

    it("should support unsubscribe", async () => {
      const events: any[] = [];
      const unsub = manager.onLifecycleEvent((e) => events.push(e));

      await manager.spawn({ task: "First", role: "worker" });
      const countAfterFirst = events.length;

      unsub();
      await manager.spawn({ task: "Second", role: "worker" });

      expect(events.length).toBe(countAfterFirst);
    });
  });

  // ── continueAgent ──────────────────────────────────────────

  describe("continueAgent()", () => {
    it("should spawn a continuation agent", async () => {
      const original = await manager.spawn({
        task: "Original task",
        role: "worker",
      });
      await manager.terminate(original.id, "completed");

      const continued = await manager.continueAgent(original.id);
      expect(continued.id).not.toBe(original.id);
      expect(continued.agent.role).toBe("worker");
    });

    it("should throw for non-existent agent", async () => {
      await expect(
        manager.continueAgent("nonexistent" as AgentId)
      ).rejects.toThrow("not found");
    });
  });

  // ── forkAgent ──────────────────────────────────────────────

  describe("forkAgent()", () => {
    it("should fork an active agent", async () => {
      const original = await manager.spawn({
        task: "Original",
        role: "worker",
      });

      const forked = await manager.forkAgent(original.id);
      expect(forked.id).not.toBe(original.id);

      const forkedRecord = agentStore.getAgent(forked.id)!;
      expect(forkedRecord.metadata?.fork_of).toBe(original.id);
    });

    it("should register forked agent in inbox", async () => {
      const original = await manager.spawn({
        task: "Original",
        role: "worker",
      });

      const forked = await manager.forkAgent(original.id);

      expect(inboxAdapter.registerAgent).toHaveBeenCalledWith(
        forked.id,
        expect.objectContaining({ role: "worker" })
      );
    });
  });

  // ── close() ────────────────────────────────────────────────

  describe("close()", () => {
    it("should close all active sessions", async () => {
      await manager.spawn({ task: "A", role: "worker" });
      await manager.spawn({ task: "B", role: "worker" });

      await manager.close();

      const agents = agentStore.listAgents({ state: "stopped" });
      expect(agents.length).toBeGreaterThanOrEqual(2);
    });
  });
});
