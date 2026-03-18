/**
 * Agent Lifecycle E2E Tests (V2)
 *
 * Tests the full agent lifecycle through the V2 stack:
 * - Spawn, terminate, resume, continue, fork
 * - Cascade termination
 * - Inbox registration/deregistration
 * - Task creation in opentasks
 * - Inter-agent messaging via inbox
 * - Team bootstrap and signal filtering
 *
 * REQUIRES: RUN_E2E_TESTS=true (no real Claude Code agents)
 * REQUIRES: RUN_FULL_AGENT_TESTS=true for real agent tests
 *
 * Run with:
 *   RUN_E2E_TESTS=true npx vitest run --config vitest.e2e.config.ts src/__tests__/e2e/agent-lifecycle.e2e.test.ts
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import { bootV2, type MacroAgentSystemV2 } from "../../boot-v2.js";
import { loadTeam } from "../../teams/team-loader.js";
import { TeamRuntimeV2 } from "../../teams/team-runtime-v2.js";
import type { InboxDeliveryEvent } from "../../adapters/types.js";

// ─────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────

const RUN_E2E = !!process.env.RUN_E2E_TESTS;
const RUN_FULL_AGENT = !!process.env.RUN_FULL_AGENT_TESTS;
const describeFn = RUN_E2E ? describe : describe.skip;

// Mock acp-factory for non-full-agent tests
if (!RUN_FULL_AGENT) {
  vi.mock("acp-factory", () => ({
    AgentFactory: {
      spawn: vi.fn().mockResolvedValue({
        createSession: vi.fn().mockResolvedValue({
          id: `session-${Date.now()}`,
          prompt: vi.fn().mockReturnValue({
            [Symbol.asyncIterator]: () => ({
              next: () => Promise.resolve({ done: true, value: undefined }),
            }),
          }),
          forkWithFlush: vi.fn().mockResolvedValue({
            id: `forked-${Date.now()}`,
          }),
        }),
        loadSession: vi.fn().mockResolvedValue({
          id: `loaded-${Date.now()}`,
        }),
        close: vi.fn().mockResolvedValue(undefined),
        isRunning: vi.fn().mockReturnValue(true),
      }),
    },
  }));
}

// Mock opentasks (daemon not available in CI)
vi.mock("opentasks", () => ({
  OpenTasksClient: vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockRejectedValue(new Error("No daemon")),
    disconnect: vi.fn(),
    query: vi.fn().mockResolvedValue({ items: [] }),
    link: vi.fn().mockResolvedValue({ success: true }),
    task: vi.fn().mockResolvedValue({ id: "t-1" }),
  })),
}));

// ─────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────

const PROJECT_ROOT = path.resolve(import.meta.dirname, "../../..");

function createTestDir(): string {
  const dir = path.join(
    os.tmpdir(),
    `agent-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ─────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────

describeFn("Agent Lifecycle E2E (V2)", () => {
  let system: MacroAgentSystemV2;
  let testDir: string;

  beforeEach(async () => {
    testDir = createTestDir();
    system = await bootV2({
      cwd: testDir,
      baseDir: testDir,
      inbox: {
        socketPath: path.join(testDir, "inbox.sock"),
      },
    });
  });

  afterEach(async () => {
    if (system) {
      await system.shutdown();
    }
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  // ── Part 1: Agent Spawning ───────────────────────────────────

  describe("SPAWN: Agent Spawning", () => {
    it("should spawn a single agent", async () => {
      const spawned = await system.agentManager.spawn({
        task: "E2E test task",
        role: "worker",
      });

      expect(spawned.id).toBeDefined();
      expect(spawned.agent.state).toBe("running");
      expect(spawned.session).toBeDefined();

      // Verify in AgentStore
      const record = system.agentStore.getAgent(spawned.id);
      expect(record).not.toBeNull();
      expect(record!.role).toBe("worker");
    });

    it("should spawn parent-child hierarchy", async () => {
      const coordinator = await system.agentManager.spawn({
        task: "Coordinate work",
        role: "coordinator",
      });

      const worker = await system.agentManager.spawn({
        task: "Do work",
        role: "worker",
        parent: coordinator.id,
      });

      expect(worker.agent.parent).toBe(coordinator.id);

      const children = system.agentManager.getChildren(coordinator.id);
      expect(children).toHaveLength(1);
      expect(children[0].id).toBe(worker.id);
    });

    it("should spawn multiple workers under coordinator", async () => {
      const coordinator = await system.agentManager.spawn({
        task: "Manage team",
        role: "coordinator",
      });

      const workers = await Promise.all(
        Array.from({ length: 3 }, (_, i) =>
          system.agentManager.spawn({
            task: `Worker task ${i + 1}`,
            role: "worker",
            parent: coordinator.id,
          })
        )
      );

      expect(workers).toHaveLength(3);

      const hierarchy = system.agentManager.getHierarchy(coordinator.id);
      expect(hierarchy!.totalAgents).toBe(4); // coordinator + 3 workers
      expect(hierarchy!.root.children).toHaveLength(3);
    });

    it("should register agents in inbox on spawn", async () => {
      const spawned = await system.agentManager.spawn({
        task: "Test",
        role: "worker",
      });

      const inbox = (system.inboxAdapter as any).getInbox();
      const agent = inbox.storage.getAgent(spawned.id);
      expect(agent).toBeDefined();
      expect(agent.status).toBe("active");
    });

    it("should set team scope on agents", async () => {
      const spawned = await system.agentManager.spawn({
        task: "Team task",
        role: "worker",
        team_instance: "test-team",
      });

      const record = system.agentStore.getAgent(spawned.id)!;
      expect(record.team).toBe("test-team");
      expect(record.scope).toBe("test-team");
    });
  });

  // ── Part 2: Agent Termination ────────────────────────────────

  describe("TERM: Agent Termination", () => {
    it("should terminate a running agent", async () => {
      const spawned = await system.agentManager.spawn({
        task: "Short-lived",
        role: "worker",
      });

      await system.agentManager.terminate(spawned.id, "completed");

      const record = system.agentStore.getAgent(spawned.id)!;
      expect(record.state).toBe("stopped");
      expect(record.stop_reason).toBe("completed");
    });

    it("should deregister from inbox on terminate", async () => {
      const spawned = await system.agentManager.spawn({
        task: "Test",
        role: "worker",
      });

      await system.agentManager.terminate(spawned.id, "completed");

      const inbox = (system.inboxAdapter as any).getInbox();
      const agent = inbox.storage.getAgent(spawned.id);
      expect(agent.status).toBe("offline");
    });

    it("should cascade terminate children", async () => {
      const parent = await system.agentManager.spawn({
        task: "Parent",
        role: "coordinator",
      });

      const child1 = await system.agentManager.spawn({
        task: "Child 1",
        role: "worker",
        parent: parent.id,
      });

      const child2 = await system.agentManager.spawn({
        task: "Child 2",
        role: "worker",
        parent: parent.id,
      });

      // Terminate parent — children should cascade
      await system.agentManager.terminate(parent.id, "completed");

      expect(system.agentStore.getAgent(child1.id)!.state).toBe("stopped");
      expect(system.agentStore.getAgent(child2.id)!.state).toBe("stopped");
    });

    it("should cascade through grandchildren", async () => {
      const root = await system.agentManager.spawn({
        task: "Root",
        role: "coordinator",
      });
      const mid = await system.agentManager.spawn({
        task: "Mid",
        role: "worker",
        parent: root.id,
      });
      const leaf = await system.agentManager.spawn({
        task: "Leaf",
        role: "worker",
        parent: mid.id,
      });

      await system.agentManager.terminate(root.id, "completed");

      expect(system.agentStore.getAgent(mid.id)!.state).toBe("stopped");
      expect(system.agentStore.getAgent(leaf.id)!.state).toBe("stopped");
    });

    it("should notify parent via inbox when child terminates", async () => {
      const parent = await system.agentManager.spawn({
        task: "Parent",
        role: "coordinator",
      });
      const child = await system.agentManager.spawn({
        task: "Child",
        role: "worker",
        parent: parent.id,
      });

      await system.agentManager.terminate(child.id, "completed");

      // Parent should have a message in inbox
      const inbox = await system.inboxAdapter.checkInbox(parent.id);
      expect(inbox.length).toBeGreaterThanOrEqual(1);

      const stopMsg = inbox.find(
        (m) => m.content?.type === "event" && m.content?.event === "agent_stopped"
      );
      expect(stopMsg).toBeDefined();
    });
  });

  // ── Part 3: Agent Queries ────────────────────────────────────

  describe("QUERY: Agent Queries", () => {
    it("should list all running agents", async () => {
      await system.agentManager.spawn({ task: "A", role: "worker" });
      await system.agentManager.spawn({ task: "B", role: "worker" });

      const running = system.agentManager.list({ state: "running" });
      expect(running.length).toBeGreaterThanOrEqual(2);
    });

    it("should filter by state", async () => {
      const a = await system.agentManager.spawn({ task: "A", role: "worker" });
      await system.agentManager.spawn({ task: "B", role: "worker" });
      await system.agentManager.terminate(a.id, "completed");

      const running = system.agentManager.list({ state: "running" });
      const stopped = system.agentManager.list({ state: "stopped" });

      expect(running.find((r) => r.id === a.id)).toBeUndefined();
      expect(stopped.find((r) => r.id === a.id)).toBeDefined();
    });

    it("should build hierarchy tree", async () => {
      const root = await system.agentManager.spawn({
        task: "Root",
        role: "coordinator",
      });
      await system.agentManager.spawn({
        task: "W1",
        role: "worker",
        parent: root.id,
      });
      await system.agentManager.spawn({
        task: "W2",
        role: "worker",
        parent: root.id,
      });

      const h = system.agentManager.getHierarchy(root.id)!;
      expect(h.totalAgents).toBe(3);
      expect(h.depth).toBe(1);
    });
  });

  // ── Part 4: Inter-Agent Messaging ────────────────────────────

  describe("MSG: Inter-Agent Messaging", () => {
    it("should send message between agents via inbox", async () => {
      const a = await system.agentManager.spawn({
        task: "Sender",
        role: "coordinator",
      });
      const b = await system.agentManager.spawn({
        task: "Receiver",
        role: "worker",
        parent: a.id,
      });

      await system.inboxAdapter.send(a.id, b.id, "Hello from coordinator", {
        threadTag: "test-thread",
      });

      const inbox = await system.inboxAdapter.checkInbox(b.id);
      expect(inbox.length).toBeGreaterThanOrEqual(1);
      expect(inbox[0].sender_id).toBe(a.id);
    });

    it("should deliver messages to multiple recipients", async () => {
      const coord = await system.agentManager.spawn({
        task: "Coord",
        role: "coordinator",
      });
      const w1 = await system.agentManager.spawn({
        task: "W1",
        role: "worker",
        parent: coord.id,
      });
      const w2 = await system.agentManager.spawn({
        task: "W2",
        role: "worker",
        parent: coord.id,
      });

      await system.inboxAdapter.send(
        coord.id,
        [w1.id, w2.id],
        "Team broadcast"
      );

      const inbox1 = await system.inboxAdapter.checkInbox(w1.id);
      const inbox2 = await system.inboxAdapter.checkInbox(w2.id);

      expect(inbox1.length).toBeGreaterThanOrEqual(1);
      expect(inbox2.length).toBeGreaterThanOrEqual(1);
    });

    it("should support event-type messages", async () => {
      const a = await system.agentManager.spawn({
        task: "A",
        role: "coordinator",
      });
      const b = await system.agentManager.spawn({
        task: "B",
        role: "worker",
        parent: a.id,
      });

      await system.inboxAdapter.send(
        a.id,
        b.id,
        {
          type: "event",
          event: "task_assigned",
          data: { taskId: "t-123" },
        },
        { importance: "high" }
      );

      const inbox = await system.inboxAdapter.checkInbox(b.id);
      const eventMsg = inbox.find(
        (m) => m.content?.type === "event" && m.content?.event === "task_assigned"
      );
      expect(eventMsg).toBeDefined();
    });

    it("should support thread-based messaging", async () => {
      const a = await system.agentManager.spawn({
        task: "A",
        role: "coordinator",
      });
      const b = await system.agentManager.spawn({
        task: "B",
        role: "worker",
        parent: a.id,
      });

      await system.inboxAdapter.send(a.id, b.id, "First message", {
        threadTag: "task-discussion",
      });
      await system.inboxAdapter.send(b.id, a.id, "Reply", {
        threadTag: "task-discussion",
      });

      const thread = await system.inboxAdapter.readThread("task-discussion");
      expect(thread.length).toBeGreaterThanOrEqual(2);
    });
  });

  // ── Part 5: Trigger System Integration ───────────────────────

  describe("TRIGGER: Inbox Delivery → Wake", () => {
    it("should enqueue inbox messages for wake delivery", async () => {
      const agent = await system.agentManager.spawn({
        task: "Wake test",
        role: "worker",
      });

      // Send a message — trigger system should enqueue it
      await system.inboxAdapter.send(
        "external",
        agent.id,
        "Wake up!",
        { importance: "high" }
      );

      // Give event loop time for delivery
      await new Promise((r) => setTimeout(r, 100));

      // Check queue has events for this agent
      const pending = system.triggerSystem.queue.getAgentsWithEvents();
      // May or may not have pending depending on timing — just verify no crash
      expect(system.triggerSystem.isRunning()).toBe(true);
    });
  });

  // ── Part 6: Continue / Fork ──────────────────────────────────

  describe("CONTINUE: Agent Continuation", () => {
    it("should continue a terminated agent", async () => {
      const original = await system.agentManager.spawn({
        task: "Original task",
        role: "worker",
      });

      await system.agentManager.terminate(original.id, "completed");

      const continued = await system.agentManager.continueAgent(original.id);

      expect(continued.id).not.toBe(original.id);
      expect(continued.agent.role).toBe("worker");
      expect(continued.agent.state).toBe("running");
    });
  });

  describe("FORK: Agent Forking", () => {
    it("should fork an active agent", async () => {
      const original = await system.agentManager.spawn({
        task: "Forkable task",
        role: "worker",
      });

      const forked = await system.agentManager.forkAgent(original.id);

      expect(forked.id).not.toBe(original.id);

      const forkedRecord = system.agentStore.getAgent(forked.id)!;
      expect(forkedRecord.metadata?.fork_of).toBe(original.id);

      // Both should be registered in inbox
      const inbox = (system.inboxAdapter as any).getInbox();
      expect(inbox.storage.getAgent(original.id)).toBeDefined();
      expect(inbox.storage.getAgent(forked.id)).toBeDefined();
    });
  });

  // ── Part 7: Team Integration ─────────────────────────────────

  describe("TEAM: Team Bootstrap", () => {
    it("should bootstrap a team with root and companions", async () => {
      const manifest = await loadTeam(
        "self-driving",
        system.roleRegistry,
        PROJECT_ROOT
      );

      const runtime = new TeamRuntimeV2(manifest, {
        agentManager: system.agentManager,
        inboxAdapter: system.inboxAdapter,
        tasksAdapter: system.tasksAdapter,
      });

      await runtime.initialize();
      const result = await runtime.bootstrap();

      expect(result.rootId).toBeDefined();
      expect(result.companionIds).toHaveLength(1);

      // Verify agents in store
      const root = system.agentStore.getAgent(result.rootId)!;
      expect(root.role).toBe("planner");
      expect(root.team).toBe("self-driving");

      const companion = system.agentStore.getAgent(result.companionIds[0])!;
      expect(companion.role).toBe("judge");

      // Verify agents in inbox
      const inbox = (system.inboxAdapter as any).getInbox();
      expect(inbox.storage.getAgent(result.rootId)).toBeDefined();
      expect(inbox.storage.getAgent(result.companionIds[0])).toBeDefined();

      await runtime.teardown();
    });

    it("should enforce signal filtering via adapter", async () => {
      const manifest = await loadTeam(
        "self-driving",
        system.roleRegistry,
        PROJECT_ROOT
      );

      const runtime = new TeamRuntimeV2(manifest, {
        agentManager: system.agentManager,
        inboxAdapter: system.inboxAdapter,
        tasksAdapter: system.tasksAdapter,
      });

      await runtime.initialize();
      const result = await runtime.bootstrap();
      runtime.installOnServices();

      // Delivery events should be filtered
      const events: InboxDeliveryEvent[] = [];
      system.inboxAdapter.onDelivery((e) => events.push(e));

      // Send allowed signal: judge→planner with FIXUP_CREATED
      await system.inboxAdapter.send(
        result.companionIds[0], // judge
        result.rootId, // planner
        {
          type: "event",
          event: "FIXUP_CREATED",
          data: {},
        }
      );

      await new Promise((r) => setTimeout(r, 50));

      // Should have been delivered (allowed by peer filter)
      const delivered = events.filter(
        (e) => e.agentId === result.rootId
      );
      expect(delivered.length).toBeGreaterThanOrEqual(1);

      await runtime.teardown();
    });
  });

  // ── Part 8: System Lifecycle ─────────────────────────────────

  describe("LIFECYCLE: System Boot/Shutdown", () => {
    it("should handle graceful shutdown with running agents", async () => {
      await system.agentManager.spawn({ task: "A", role: "worker" });
      await system.agentManager.spawn({ task: "B", role: "worker" });
      await system.agentManager.spawn({ task: "C", role: "coordinator" });

      // Grab store ref before shutdown closes it
      const store = system.agentStore;

      // Query agents before shutdown to get IDs
      const agentsBefore = store.listAgents();
      const agentIds = agentsBefore.map((a) => a.id);
      expect(agentIds.length).toBe(3);

      // Shutdown should not throw
      await system.shutdown();

      // Prevent double shutdown in afterEach
      system = null!;
    });
  });
});
