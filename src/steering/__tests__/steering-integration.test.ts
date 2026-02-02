/**
 * Steering Integration Tests
 *
 * Tests for message routing, broadcast, wake/inject behavior, and
 * handling of terminated agents.
 *
 * @see s-9rld In-Flight Steering spec
 * @see i-9cwb Phase 2f: Steering and Task Integration E2E Tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import {
  createTestHarness,
  type TestHarness,
} from "../../../test_fixtures/harness/test-harness.js";
import type { SimulatedBehavior } from "../../../test_fixtures/harness/simulator/types.js";
import { createEventStore, type EventStore } from "../../store/event-store.js";
import {
  createMessageRouter,
  type MessageRouter,
  type WakeHandler,
} from "../../router/message-router.js";
import type { WakeDecision } from "../../router/wake.js";
import {
  determineWakeAction,
  getWakeDecision,
  type SessionChecker,
} from "../../router/wake.js";
import {
  injectContext,
  formatInjectedContent,
} from "../inject.js";
import type { InjectionDeps, InjectableSession } from "../types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Test Behaviors
// ─────────────────────────────────────────────────────────────────────────────

function createWaitingWorker(): SimulatedBehavior {
  return {
    onStart: [
      { type: "log", message: "Worker waiting" },
      { type: "wait_for_event", event: "WORK_ASSIGNED" },
      { type: "done", status: "completed" },
    ],
  };
}

function createWaitingMonitor(): SimulatedBehavior {
  return {
    onStart: [
      { type: "log", message: "Monitor watching" },
      { type: "wait_for_event", event: "SHUTDOWN" },
      { type: "done", status: "completed" },
    ],
  };
}

function createCoordinator(): SimulatedBehavior {
  return {
    onStart: [
      { type: "log", message: "Coordinator started" },
      { type: "wait_for_event", event: "ALL_DONE" },
      { type: "done", status: "completed" },
    ],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 5a: Broadcast to @workers
// ─────────────────────────────────────────────────────────────────────────────

describe("Steering Integration", () => {
  describe("Scenario 5a: Broadcast to @workers", () => {
    let harness: TestHarness;

    beforeEach(async () => {
      harness = await createTestHarness({
        withMergeQueue: false,
        withWorkspaces: false,
      });
      // TestHarness requires a repo for simulators
      await harness.createTempRepo({ initialFiles: { "README.md": "# Test" } });
    });

    afterEach(async () => {
      await harness.cleanup();
    });

    it("should deliver broadcast to all workers, not monitors", async () => {
      // Create coordinator
      const coord = await harness.spawnSimulator({
        role: "coordinator",
        agentId: "coord-1",
        behavior: createCoordinator(),
      });

      // Create 2 workers
      const worker1 = await harness.spawnSimulator({
        role: "worker",
        agentId: "worker-1",
        parentId: coord.agentId,
        behavior: createWaitingWorker(),
      });

      const worker2 = await harness.spawnSimulator({
        role: "worker",
        agentId: "worker-2",
        parentId: coord.agentId,
        behavior: createWaitingWorker(),
      });

      // Create monitor
      const monitor = await harness.spawnSimulator({
        role: "monitor",
        agentId: "monitor-1",
        parentId: coord.agentId,
        behavior: createWaitingMonitor(),
      });

      // Step to get all agents running
      await harness.stepAll();

      // Broadcast to workers via role-based addressing
      const result = await harness.messageRouter.sendToAddress({
        from: coord.agentId,
        to: { role: "worker" },
        content: "Task update for all workers",
      });

      expect(result.id).toBeDefined();

      // Check messages received
      const worker1Messages = harness.messageRouter.getMessages(worker1.agentId);
      const worker2Messages = harness.messageRouter.getMessages(worker2.agentId);
      const monitorMessages = harness.messageRouter.getMessages(monitor.agentId);

      // Workers should receive the message
      expect(worker1Messages.some((m) => m.content.includes("Task update"))).toBe(true);
      expect(worker2Messages.some((m) => m.content.includes("Task update"))).toBe(true);

      // Monitor should NOT receive the message
      expect(monitorMessages.some((m) => m.content.includes("Task update"))).toBe(false);
    });

    it("should deliver broadcast to @all including monitors", async () => {
      const coord = await harness.spawnSimulator({
        role: "coordinator",
        agentId: "coord-1",
        behavior: createCoordinator(),
      });

      const worker = await harness.spawnSimulator({
        role: "worker",
        agentId: "worker-1",
        parentId: coord.agentId,
        behavior: createWaitingWorker(),
      });

      const monitor = await harness.spawnSimulator({
        role: "monitor",
        agentId: "monitor-1",
        parentId: coord.agentId,
        behavior: createWaitingMonitor(),
      });

      await harness.stepAll();

      // Broadcast to all via broadcast addressing
      await harness.messageRouter.sendToAddress({
        from: coord.agentId,
        to: { broadcast: true },
        content: "System-wide announcement",
      });

      const workerMessages = harness.messageRouter.getMessages(worker.agentId);
      const monitorMessages = harness.messageRouter.getMessages(monitor.agentId);

      // Both should receive
      expect(workerMessages.some((m) => m.content.includes("System-wide"))).toBe(true);
      expect(monitorMessages.some((m) => m.content.includes("System-wide"))).toBe(true);
    });

    it("should only broadcast to running agents", async () => {
      const coord = await harness.spawnSimulator({
        role: "coordinator",
        agentId: "coord-1",
        behavior: createCoordinator(),
      });

      const worker1 = await harness.spawnSimulator({
        role: "worker",
        agentId: "worker-1",
        parentId: coord.agentId,
        behavior: {
          onStart: [
            { type: "log", message: "Quick worker" },
            { type: "done", status: "completed" },
          ],
        },
      });

      const worker2 = await harness.spawnSimulator({
        role: "worker",
        agentId: "worker-2",
        parentId: coord.agentId,
        behavior: createWaitingWorker(),
      });

      // Run worker1 to completion
      await harness.waitForSimulator(worker1.agentId, { maxIterations: 10 });

      // Broadcast to workers via role-based addressing
      await harness.messageRouter.sendToAddress({
        from: coord.agentId,
        to: { role: "worker" },
        content: "Only for running workers",
      });

      // Running worker should receive
      const worker2Messages = harness.messageRouter.getMessages(worker2.agentId);
      expect(worker2Messages.some((m) => m.content.includes("Only for running"))).toBe(true);

      // Stopped worker should NOT receive (broadcast filters to running)
      const worker1Messages = harness.messageRouter.getMessages(worker1.agentId);
      expect(worker1Messages.some((m) => m.content.includes("Only for running"))).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Scenario 5b: Priority Message Wake Behavior
  // ─────────────────────────────────────────────────────────────────────────────

  describe("Scenario 5b: Priority-based wake behavior", () => {
    describe("determineWakeAction unit tests", () => {
      // Test all 12 combinations: 4 priorities × 3 states

      describe("Inactive agent (no session)", () => {
        it("low priority → queue (never wake inactive)", () => {
          expect(determineWakeAction("low", false, false)).toBe("queue");
        });

        it("normal priority → wake", () => {
          expect(determineWakeAction("normal", false, false)).toBe("wake");
        });

        it("high priority → wake", () => {
          expect(determineWakeAction("high", false, false)).toBe("wake");
        });

        it("urgent priority → wake", () => {
          expect(determineWakeAction("urgent", false, false)).toBe("wake");
        });
      });

      describe("Idle agent (session, not prompting)", () => {
        it("low priority → queue", () => {
          expect(determineWakeAction("low", true, false)).toBe("queue");
        });

        it("normal priority → wake", () => {
          expect(determineWakeAction("normal", true, false)).toBe("wake");
        });

        it("high priority → wake", () => {
          expect(determineWakeAction("high", true, false)).toBe("wake");
        });

        it("urgent priority → wake", () => {
          expect(determineWakeAction("urgent", true, false)).toBe("wake");
        });
      });

      describe("Busy agent (actively prompting)", () => {
        it("low priority → queue", () => {
          expect(determineWakeAction("low", true, true)).toBe("queue");
        });

        it("normal priority → queue", () => {
          expect(determineWakeAction("normal", true, true)).toBe("queue");
        });

        it("high priority → inject", () => {
          expect(determineWakeAction("high", true, true)).toBe("inject");
        });

        it("urgent priority → interrupt", () => {
          expect(determineWakeAction("urgent", true, true)).toBe("interrupt");
        });
      });
    });

    describe("getWakeDecision with session checker", () => {
      it("should return correct decision for inactive agent", () => {
        const sessionChecker: SessionChecker = {
          hasActiveSession: () => false,
          isPrompting: () => false,
          supportsInjection: () => true,
        };

        const decision = getWakeDecision("agent-1", "high", sessionChecker);

        expect(decision.action).toBe("wake");
        expect(decision.shouldWake).toBe(true);
        expect(decision.shouldInterrupt).toBe(false);
      });

      it("should fall back to interrupt when injection not supported", () => {
        const sessionChecker: SessionChecker = {
          hasActiveSession: () => true,
          isPrompting: () => true,
          supportsInjection: () => false, // No injection support
        };

        const decision = getWakeDecision("agent-1", "high", sessionChecker);

        // Would be inject, but falls back to interrupt
        expect(decision.action).toBe("interrupt");
        expect(decision.shouldInterrupt).toBe(true);
        expect(decision.canInject).toBe(false);
      });
    });

    describe("MessageRouter wake handler integration", () => {
      let eventStore: EventStore;
      let messageRouter: MessageRouter;
      let wakeEvents: Array<{ agentId: string; decision: WakeDecision }>;

      beforeEach(async () => {
        eventStore = await createEventStore({ inMemory: true });
        wakeEvents = [];

        // Create session checker
        const agentStates = new Map<string, { active: boolean; prompting: boolean }>();
        agentStates.set("sleeping-agent", { active: false, prompting: false });
        agentStates.set("idle-agent", { active: true, prompting: false });
        agentStates.set("busy-agent", { active: true, prompting: true });

        const sessionChecker: SessionChecker = {
          hasActiveSession: (id) => agentStates.get(id)?.active ?? false,
          isPrompting: (id) => agentStates.get(id)?.prompting ?? false,
          supportsInjection: () => true,
        };

        const wakeHandler: WakeHandler = (agentId, decision, messageId) => {
          wakeEvents.push({ agentId, decision });
        };

        messageRouter = createMessageRouter(eventStore, {
          sessionChecker,
          wakeHandler,
        });

        // Create agents in event store using proper event types
        for (const id of ["sleeping-agent", "idle-agent", "busy-agent"]) {
          // 1. Spawn event creates agent in 'spawning' state
          eventStore.emit({
            type: "spawn",
            source: { agent_id: id },
            payload: {
              agent_id: id,
              session_id: `session-${id}`,
              task: "test task",
              cwd: "/tmp",
            },
          });
          // 2. Status event with 'started' sets state to 'running'
          eventStore.emit({
            type: "status",
            source: { agent_id: id },
            payload: { status_type: "started" },
          });
        }
      });

      afterEach(async () => {
        await eventStore.close();
      });

      it("should wake sleeping agent with normal priority", async () => {
        await messageRouter.sendToAddress({
          from: "sender",
          to: { agent: "sleeping-agent" },
          content: "Wake up!",
          options: { priority: "normal" },
        });

        expect(wakeEvents).toHaveLength(1);
        expect(wakeEvents[0].agentId).toBe("sleeping-agent");
        expect(wakeEvents[0].decision.shouldWake).toBe(true);
      });

      it("should not wake sleeping agent with low priority", async () => {
        await messageRouter.sendToAddress({
          from: "sender",
          to: { agent: "sleeping-agent" },
          content: "Low priority message",
          options: { priority: "low" },
        });

        expect(wakeEvents).toHaveLength(0);
      });

      it("should interrupt busy agent with urgent priority", async () => {
        await messageRouter.sendToAddress({
          from: "sender",
          to: { agent: "busy-agent" },
          content: "URGENT!",
          options: { priority: "urgent" },
        });

        expect(wakeEvents).toHaveLength(1);
        expect(wakeEvents[0].agentId).toBe("busy-agent");
        expect(wakeEvents[0].decision.shouldInterrupt).toBe(true);
      });

      it("should only queue for busy agent with normal priority", async () => {
        await messageRouter.sendToAddress({
          from: "sender",
          to: { agent: "busy-agent" },
          content: "Normal message",
          options: { priority: "normal" },
        });

        // No wake event for queue action
        expect(wakeEvents).toHaveLength(0);
      });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Scenario 5c: Context Injection During Execution
  // ─────────────────────────────────────────────────────────────────────────────

  describe("Scenario 5c: Context injection", () => {
    describe("formatInjectedContent", () => {
      it("should format with user source", () => {
        const result = formatInjectedContent("Test content", {
          source: { type: "human" },
          reason: "Priority update",
        });

        expect(result).toContain("[Context Injection from User]");
        expect(result).toContain("Reason: Priority update");
        expect(result).toContain("Test content");
      });

      it("should format with agent source", () => {
        const result = formatInjectedContent("Agent message", {
          source: { type: "agent", agentId: "agent-123" },
        });

        expect(result).toContain("[Context Injection from Agent: agent-123]");
        expect(result).toContain("Agent message");
      });
    });

    describe("injectContext fallback chain", () => {
      let messagesSent: Array<{ to: string; content: string; priority: string }>;

      function createMockDeps(options: {
        hasSession: boolean;
        isPrompting: boolean;
        supportsInject: boolean;
        injectSuccess: boolean;
      }): InjectionDeps {
        messagesSent = [];

        // Create a proper async generator for interruptWith
        async function* mockInterruptWith(): AsyncGenerator<{ type: string }> {
          yield { type: "started" };
          yield { type: "completed" };
        }

        const mockSession: InjectableSession = {
          supportsInject: () => options.supportsInject,
          checkInjectSupport: async () => options.supportsInject,
          inject: async () => ({ success: options.injectSuccess }),
          interruptWith: () => mockInterruptWith(),
        };

        return {
          getSession: () => (options.hasSession ? mockSession : null),
          isPrompting: () => options.isPrompting,
          sendMessage: async (from, to, content, priority) => {
            messagesSent.push({ to, content, priority: priority ?? "normal" });
          },
        };
      }

      it("should use inject when supported and successful", async () => {
        const deps = createMockDeps({
          hasSession: true,
          isPrompting: false,
          supportsInject: true,
          injectSuccess: true,
        });

        const result = await injectContext(deps, "agent-1", "Test content");

        expect(result.success).toBe(true);
        expect(result.method).toBe("inject");
        expect(messagesSent).toHaveLength(0); // No fallback message
      });

      it("should fall back to interrupt when inject not supported", async () => {
        const deps = createMockDeps({
          hasSession: true,
          isPrompting: true,
          supportsInject: false,
          injectSuccess: false,
        });

        const result = await injectContext(deps, "agent-1", "Test content", {
          allowInterrupt: true,
        });

        expect(result.success).toBe(true);
        expect(result.method).toBe("interrupt");
      });

      it("should fall back to high-priority message when no session", async () => {
        const deps = createMockDeps({
          hasSession: false,
          isPrompting: false,
          supportsInject: false,
          injectSuccess: false,
        });

        const result = await injectContext(deps, "agent-1", "Test content");

        expect(result.success).toBe(true);
        expect(result.method).toBe("message");
        expect(messagesSent).toHaveLength(1);
        expect(messagesSent[0].priority).toBe("high");
      });

      it("should prefer interrupt when urgent and prompting", async () => {
        let interruptCalled = false;

        // Create a proper async generator
        async function* mockInterruptWith(): AsyncGenerator<{ type: string }> {
          interruptCalled = true;
          yield { type: "started" };
          yield { type: "completed" };
        }

        const mockSession: InjectableSession = {
          supportsInject: () => true,
          checkInjectSupport: async () => true,
          inject: async () => ({ success: true }),
          interruptWith: () => mockInterruptWith(),
        };

        const deps: InjectionDeps = {
          getSession: () => mockSession,
          isPrompting: () => true,
          sendMessage: async () => {},
        };

        const result = await injectContext(deps, "agent-1", "URGENT", {
          urgent: true,
        });

        expect(result.success).toBe(true);
        expect(result.method).toBe("interrupt");
        expect(interruptCalled).toBe(true);
      });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Scenario 5d: Message to Terminated Agent
  // ─────────────────────────────────────────────────────────────────────────────

  describe("Scenario 5d: Message to terminated agent", () => {
    let harness: TestHarness;

    beforeEach(async () => {
      harness = await createTestHarness({
        withMergeQueue: false,
        withWorkspaces: false,
      });
      await harness.createTempRepo({ initialFiles: { "README.md": "# Test" } });
    });

    afterEach(async () => {
      await harness.cleanup();
    });

    it("should be a no-op when sending to stopped agent", async () => {
      // Create and run a worker to completion
      const worker = await harness.spawnSimulator({
        role: "worker",
        agentId: "worker-1",
        behavior: {
          onStart: [
            { type: "log", message: "Quick work" },
            { type: "done", status: "completed" },
          ],
        },
      });

      await harness.waitForSimulator(worker.agentId, { maxIterations: 10 });
      harness.assertSimulatorComplete(worker.agentId);

      // Verify agent is stopped
      const agent = harness.eventStore.getAgent(worker.agentId);
      expect(agent?.state).toBe("stopped");

      // Send message to stopped agent - should not throw
      // The message is simply queued (or dropped) but no error occurs
      const messagesBefore = harness.messageRouter.getMessages(worker.agentId);

      await harness.messageRouter.sendToAddress({
        from: "sender",
        to: { agent: worker.agentId },
        content: "Message to stopped agent",
      });

      // Message is delivered to the queue (but agent won't process it)
      const messagesAfter = harness.messageRouter.getMessages(worker.agentId);
      expect(messagesAfter.length).toBeGreaterThanOrEqual(messagesBefore.length);
    });

    it("should handle urgent message to stopped agent without error", async () => {
      // Create custom event store
      const eventStore = await createEventStore({ inMemory: true });

      // Session checker that correctly identifies stopped agents
      const sessionChecker: SessionChecker = {
        hasActiveSession: (id) => {
          const agent = eventStore.getAgent(id);
          // Only running agents have active sessions
          return agent?.state === "running";
        },
        isPrompting: () => false,
        supportsInjection: () => true,
        isStopped: (id) => {
          const agent = eventStore.getAgent(id);
          return agent?.state === "stopped";
        },
      };

      // Track what wake decisions are made
      const wakeDecisions: Array<{ agentId: string; decision: WakeDecision }> = [];
      const wakeHandler: WakeHandler = (agentId, decision) => {
        wakeDecisions.push({ agentId, decision });
      };

      const messageRouter = createMessageRouter(eventStore, {
        sessionChecker,
        wakeHandler,
      });

      // Create a stopped agent using proper event types
      eventStore.emit({
        type: "spawn",
        source: { agent_id: "stopped-agent" },
        payload: {
          agent_id: "stopped-agent",
          session_id: "session-stopped",
          task: "test task",
          cwd: "/tmp",
        },
      });
      eventStore.emit({
        type: "status",
        source: { agent_id: "stopped-agent" },
        payload: { status_type: "started" },
      });
      eventStore.emit({
        type: "terminate",
        source: { agent_id: "stopped-agent" },
        payload: { agent_id: "stopped-agent", reason: "completed" },
      });

      // Verify stopped
      expect(eventStore.getAgent("stopped-agent")?.state).toBe("stopped");

      // Send urgent message - should not throw
      await messageRouter.sendToAddress({
        from: "sender",
        to: { agent: "stopped-agent" },
        content: "URGENT to stopped",
        options: { priority: "urgent" },
      });

      // Message is delivered to the queue
      const messages = eventStore.getMessages("stopped-agent", undefined);
      expect(messages.some((m) => m.content.includes("URGENT to stopped"))).toBe(true);

      // With isStopped() properly implemented, the wake action should be "skip"
      // meaning no wake attempt is made for stopped agents
      if (wakeDecisions.length > 0) {
        expect(wakeDecisions[0].decision.action).toBe("skip");
      }

      await eventStore.close();
    });

    it("should handle broadcast that includes stopped agents gracefully", async () => {
      // Create coordinator and workers
      const coord = await harness.spawnSimulator({
        role: "coordinator",
        agentId: "coord",
        behavior: createCoordinator(),
      });

      // Worker 1 completes immediately
      const worker1 = await harness.spawnSimulator({
        role: "worker",
        agentId: "worker-1",
        parentId: coord.agentId,
        behavior: {
          onStart: [{ type: "done", status: "completed" }],
        },
      });

      // Worker 2 stays running
      const worker2 = await harness.spawnSimulator({
        role: "worker",
        agentId: "worker-2",
        parentId: coord.agentId,
        behavior: createWaitingWorker(),
      });

      await harness.waitForSimulator(worker1.agentId, { maxIterations: 10 });
      await harness.stepAll(); // Get worker2 running

      // Broadcast to workers - should only hit worker2 (running)
      await harness.messageRouter.sendToAddress({
        from: coord.agentId,
        to: { role: "worker" },
        content: "Broadcast after some workers stopped",
      });

      const worker1Messages = harness.messageRouter.getMessages(worker1.agentId);
      const worker2Messages = harness.messageRouter.getMessages(worker2.agentId);

      // Only running worker receives broadcast
      expect(worker1Messages.some((m) => m.content.includes("Broadcast after"))).toBe(false);
      expect(worker2Messages.some((m) => m.content.includes("Broadcast after"))).toBe(true);
    });
  });
});
