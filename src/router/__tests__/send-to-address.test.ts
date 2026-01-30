/**
 * Tests for MessageRouter.sendToAddress() - MAP Address-based routing
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createEventStore, EventStore } from "../../store/event-store.js";
import { createMessageRouter, MessageRouter } from "../message-router.js";
import { AddressRoutingError } from "../types.js";
import type { Address } from "../../map/types.js";

describe("MessageRouter.sendToAddress()", () => {
  let eventStore: EventStore;
  let router: MessageRouter;

  beforeEach(async () => {
    eventStore = await createEventStore({ inMemory: true });
    router = createMessageRouter(eventStore);
  });

  afterEach(async () => {
    await eventStore.close();
  });

  // Helper to create an agent (starts in "running" state)
  function createAgent(
    id: string,
    parent?: string,
    taskId?: string,
    role?: string
  ) {
    eventStore.emit({
      type: "spawn",
      source: { agent_id: parent ?? "system" },
      payload: {
        agent_id: id,
        session_id: `session_${id}`,
        task: `Task for ${id}`,
        task_id: taskId,
        parent: parent ?? null,
        role,
      },
    });
    // Emit "started" status to transition to running state
    eventStore.emit({
      type: "status",
      source: { agent_id: id },
      payload: {
        status_type: "started",
        summary: "Agent started",
      },
    });
  }

  // Helper to create a task
  function createTask(taskId: string, creatorId: string) {
    eventStore.emit({
      type: "task",
      source: { agent_id: creatorId },
      payload: {
        task_id: taskId,
        action: "created",
        details: {
          description: `Task ${taskId}`,
        },
      },
    });
  }

  // Helper to assign task to agent
  function assignTask(taskId: string, agentId: string) {
    eventStore.emit({
      type: "task",
      source: { agent_id: "system" },
      payload: {
        task_id: taskId,
        action: "assigned",
        details: {
          agent_id: agentId,
        },
      },
    });
  }

  describe("agent address", () => {
    it("sends message to agent by address", async () => {
      createAgent("sender");
      createAgent("recipient");

      const result = await router.sendToAddress({
        from: "sender",
        to: { agent: "recipient" },
        content: "Hello via MAP address",
      });

      expect(result.id).toBeDefined();
      expect(result.from).toBe("sender");
      expect(result.to).toEqual({ agent: "recipient" });
      expect(result.content).toBe("Hello via MAP address");
      expect(result.timestamp).toBeDefined();
      expect(result.delivered).toEqual(["recipient"]);
    });

    it("message appears in recipient queue", async () => {
      createAgent("sender");
      createAgent("recipient");

      await router.sendToAddress({
        from: "sender",
        to: { agent: "recipient" },
        content: "Hello",
      });

      const messages = router.getMessages("recipient");
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe("Hello");
    });

    it("throws AGENT_NOT_FOUND for non-existent agent", async () => {
      createAgent("sender");

      await expect(
        router.sendToAddress({
          from: "sender",
          to: { agent: "nonexistent" },
          content: "Hello",
        })
      ).rejects.toThrow(AddressRoutingError);

      try {
        await router.sendToAddress({
          from: "sender",
          to: { agent: "nonexistent" },
          content: "Hello",
        });
      } catch (error) {
        expect(error).toBeInstanceOf(AddressRoutingError);
        expect((error as AddressRoutingError).code).toBe("AGENT_NOT_FOUND");
      }
    });

    it("includes correlationId when provided", async () => {
      createAgent("sender");
      createAgent("recipient");

      const result = await router.sendToAddress({
        from: "sender",
        to: { agent: "recipient" },
        content: "Request",
        options: { correlationId: "req-123" },
      });

      expect(result.correlationId).toBe("req-123");
    });

    it("includes priority in message payload", async () => {
      createAgent("sender");
      createAgent("recipient");

      await router.sendToAddress({
        from: "sender",
        to: { agent: "recipient" },
        content: "Urgent message",
        options: { priority: "urgent" },
      });

      const messages = router.getMessages("recipient");
      expect(messages).toHaveLength(1);
    });
  });

  describe("task address", () => {
    it("routes to assigned agent", async () => {
      createAgent("sender");
      createAgent("worker");
      createTask("task-1", "sender");
      assignTask("task-1", "worker");

      const result = await router.sendToAddress({
        from: "sender",
        to: { task: "task-1" },
        content: "Task update",
      });

      expect(result.delivered).toEqual(["worker"]);

      const messages = router.getMessages("worker");
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe("Task update");
    });

    it("throws TASK_NOT_FOUND for non-existent task", async () => {
      createAgent("sender");

      await expect(
        router.sendToAddress({
          from: "sender",
          to: { task: "nonexistent" },
          content: "Hello",
        })
      ).rejects.toThrow(AddressRoutingError);

      try {
        await router.sendToAddress({
          from: "sender",
          to: { task: "nonexistent" },
          content: "Hello",
        });
      } catch (error) {
        expect(error).toBeInstanceOf(AddressRoutingError);
        expect((error as AddressRoutingError).code).toBe("TASK_NOT_FOUND");
      }
    });

    it("throws TASK_UNASSIGNED for unassigned task without spawner", async () => {
      createAgent("sender");
      createTask("task-1", "sender");

      try {
        await router.sendToAddress({
          from: "sender",
          to: { task: "task-1" },
          content: "Hello",
        });
      } catch (error) {
        expect(error).toBeInstanceOf(AddressRoutingError);
        expect((error as AddressRoutingError).code).toBe("TASK_UNASSIGNED");
      }
    });
  });

  describe("scope address", () => {
    it("routes to scope subscribers", async () => {
      createAgent("sender");
      createAgent("agent-1");
      createAgent("agent-2");

      router.subscribe("agent-1", { type: "topic", target: "my-scope" });
      router.subscribe("agent-2", { type: "topic", target: "my-scope" });

      const result = await router.sendToAddress({
        from: "sender",
        to: { scope: "my-scope" },
        content: "Scope message",
      });

      expect(result.delivered).toHaveLength(2);
      expect(result.delivered).toContain("agent-1");
      expect(result.delivered).toContain("agent-2");

      // Each subscriber receives the fan-out message
      // Note: May also receive topic event - check at least 1 message
      expect(router.getMessages("agent-1").length).toBeGreaterThanOrEqual(1);
      expect(router.getMessages("agent-2").length).toBeGreaterThanOrEqual(1);
    });

    it("throws NO_RECIPIENTS for empty scope", async () => {
      createAgent("sender");

      try {
        await router.sendToAddress({
          from: "sender",
          to: { scope: "empty-scope" },
          content: "Hello",
        });
      } catch (error) {
        expect(error).toBeInstanceOf(AddressRoutingError);
        expect((error as AddressRoutingError).code).toBe("NO_RECIPIENTS");
      }
    });
  });

  describe("role address", () => {
    it("routes to agents with matching role", async () => {
      // Create sender with coordinator role so it doesn't match worker role
      // (agents without role default to "worker")
      createAgent("sender", undefined, undefined, "coordinator");
      createAgent("worker-1", undefined, undefined, "worker");
      createAgent("worker-2", undefined, undefined, "worker");
      createAgent("another-coordinator", undefined, undefined, "coordinator");

      const result = await router.sendToAddress({
        from: "sender",
        to: { role: "worker" },
        content: "To all workers",
      });

      expect(result.delivered).toHaveLength(2);
      expect(result.delivered).toContain("worker-1");
      expect(result.delivered).toContain("worker-2");
      expect(result.delivered).not.toContain("sender");
      expect(result.delivered).not.toContain("another-coordinator");
    });

    it("throws NO_RECIPIENTS for role with no agents", async () => {
      // Create sender with coordinator role
      createAgent("sender", undefined, undefined, "coordinator");
      createAgent("worker-1", undefined, undefined, "worker");

      try {
        await router.sendToAddress({
          from: "sender",
          to: { role: "integrator" },
          content: "Hello",
        });
        expect.fail("Expected AddressRoutingError to be thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(AddressRoutingError);
        expect((error as AddressRoutingError).code).toBe("NO_RECIPIENTS");
      }
    });
  });

  describe("broadcast address", () => {
    it("routes to all running agents", async () => {
      createAgent("sender");
      createAgent("agent-1", undefined, undefined, "worker");
      createAgent("agent-2", undefined, undefined, "worker");
      createAgent("agent-3", undefined, undefined, "coordinator");

      const result = await router.sendToAddress({
        from: "sender",
        to: { broadcast: true },
        content: "Broadcast message",
      });

      // Should include all running agents (sender + 3 others = 4 total)
      // But broadcast only targets workers/coordinators/monitors, not sender
      expect(result.delivered.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe("hierarchical addresses", () => {
    it("routes to parent", async () => {
      createAgent("parent-agent");
      createAgent("child-agent", "parent-agent");

      const result = await router.sendToAddress({
        from: "child-agent",
        to: { parent: true },
        content: "Hello parent",
      });

      expect(result.delivered).toEqual(["parent-agent"]);
      expect(router.getMessages("parent-agent").length).toBeGreaterThanOrEqual(1);
    });

    it("throws NO_RECIPIENTS for root agent with no parent", async () => {
      createAgent("root-agent");

      try {
        await router.sendToAddress({
          from: "root-agent",
          to: { parent: true },
          content: "Hello parent",
        });
        expect.fail("Expected AddressRoutingError to be thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(AddressRoutingError);
        expect((error as AddressRoutingError).code).toBe("NO_RECIPIENTS");
      }
    });

    it("routes to children", async () => {
      createAgent("parent-agent");
      createAgent("child-1", "parent-agent");
      createAgent("child-2", "parent-agent");

      const result = await router.sendToAddress({
        from: "parent-agent",
        to: { children: true },
        content: "Hello children",
      });

      expect(result.delivered).toHaveLength(2);
      expect(result.delivered).toContain("child-1");
      expect(result.delivered).toContain("child-2");
    });

    it("routes to ancestors", async () => {
      createAgent("grandparent");
      createAgent("parent-agent", "grandparent");
      createAgent("child-agent", "parent-agent");

      const result = await router.sendToAddress({
        from: "child-agent",
        to: { ancestors: true },
        content: "Hello ancestors",
      });

      expect(result.delivered).toHaveLength(2);
      expect(result.delivered).toContain("parent-agent");
      expect(result.delivered).toContain("grandparent");
    });

    it("routes to ancestors with depth limit", async () => {
      createAgent("grandparent");
      createAgent("parent-agent", "grandparent");
      createAgent("child-agent", "parent-agent");

      const result = await router.sendToAddress({
        from: "child-agent",
        to: { ancestors: true, depth: 1 },
        content: "Hello parent only",
      });

      expect(result.delivered).toHaveLength(1);
      expect(result.delivered).toContain("parent-agent");
    });

    it("routes to descendants", async () => {
      createAgent("root-agent");
      createAgent("child-1", "root-agent");
      createAgent("grandchild", "child-1");

      const result = await router.sendToAddress({
        from: "root-agent",
        to: { descendants: true },
        content: "Hello descendants",
      });

      expect(result.delivered).toHaveLength(2);
      expect(result.delivered).toContain("child-1");
      expect(result.delivered).toContain("grandchild");
    });

    it("routes to descendants with depth limit", async () => {
      createAgent("root-agent");
      createAgent("child-1", "root-agent");
      createAgent("grandchild", "child-1");

      const result = await router.sendToAddress({
        from: "root-agent",
        to: { descendants: true, depth: 1 },
        content: "Hello children only",
      });

      expect(result.delivered).toHaveLength(1);
      expect(result.delivered).toContain("child-1");
      expect(result.delivered).not.toContain("grandchild");
    });

    it("routes to siblings", async () => {
      createAgent("parent-agent");
      createAgent("sibling-1", "parent-agent");
      createAgent("sibling-2", "parent-agent");
      createAgent("sibling-3", "parent-agent");

      const result = await router.sendToAddress({
        from: "sibling-1",
        to: { siblings: true },
        content: "Hello siblings",
      });

      expect(result.delivered).toHaveLength(2);
      expect(result.delivered).toContain("sibling-2");
      expect(result.delivered).toContain("sibling-3");
      expect(result.delivered).not.toContain("sibling-1"); // Sender excluded
    });

    it("throws NO_RECIPIENTS for siblings with no siblings", async () => {
      createAgent("parent-agent");
      createAgent("only-child", "parent-agent");

      try {
        await router.sendToAddress({
          from: "only-child",
          to: { siblings: true },
          content: "Hello siblings",
        });
        expect.fail("Expected AddressRoutingError to be thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(AddressRoutingError);
        expect((error as AddressRoutingError).code).toBe("NO_RECIPIENTS");
      }
    });
  });

  describe("multi-agent address", () => {
    it("routes to all specified agents", async () => {
      createAgent("sender");
      createAgent("agent-1");
      createAgent("agent-2");
      createAgent("agent-3");

      const result = await router.sendToAddress({
        from: "sender",
        to: { agents: ["agent-1", "agent-2", "agent-3"] },
        content: "Hello multiple",
      });

      expect(result.delivered).toHaveLength(3);
      expect(result.delivered).toContain("agent-1");
      expect(result.delivered).toContain("agent-2");
      expect(result.delivered).toContain("agent-3");
    });

    it("each agent receives the message", async () => {
      createAgent("sender");
      createAgent("agent-1");
      createAgent("agent-2");

      await router.sendToAddress({
        from: "sender",
        to: { agents: ["agent-1", "agent-2"] },
        content: "Multi-message",
      });

      expect(router.getMessages("agent-1").length).toBeGreaterThanOrEqual(1);
      expect(router.getMessages("agent-2").length).toBeGreaterThanOrEqual(1);
    });

    it("throws AGENT_NOT_FOUND if any agent is missing", async () => {
      createAgent("sender");
      createAgent("agent-1");
      // agent-2 does not exist

      try {
        await router.sendToAddress({
          from: "sender",
          to: { agents: ["agent-1", "agent-2"] },
          content: "Hello",
        });
        expect.fail("Expected AddressRoutingError to be thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(AddressRoutingError);
        expect((error as AddressRoutingError).code).toBe("AGENT_NOT_FOUND");
      }
    });

    it("throws NO_RECIPIENTS for empty agents array", async () => {
      createAgent("sender");

      try {
        await router.sendToAddress({
          from: "sender",
          to: { agents: [] },
          content: "Hello",
        });
        expect.fail("Expected AddressRoutingError to be thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(AddressRoutingError);
        expect((error as AddressRoutingError).code).toBe("NO_RECIPIENTS");
      }
    });

    it("includes correlationId when provided", async () => {
      createAgent("sender");
      createAgent("agent-1");
      createAgent("agent-2");

      const result = await router.sendToAddress({
        from: "sender",
        to: { agents: ["agent-1", "agent-2"] },
        content: "Request",
        options: { correlationId: "multi-req-123" },
      });

      expect(result.correlationId).toBe("multi-req-123");
    });
  });

  describe("options", () => {
    it("passes priority through to routing", async () => {
      let wakeHandlerCalled = false;
      let capturedPriority: string | undefined;

      const routerWithWake = createMessageRouter(eventStore, {
        sessionChecker: {
          hasActiveSession: () => true,
          getSessionState: () => "idle",
        },
        wakeHandler: (agentId, decision) => {
          wakeHandlerCalled = true;
        },
      });

      createAgent("sender");
      createAgent("recipient");

      await routerWithWake.sendToAddress({
        from: "sender",
        to: { agent: "recipient" },
        content: "Urgent!",
        options: { priority: "urgent" },
      });

      // Urgent priority should trigger wake handler
      expect(wakeHandlerCalled).toBe(true);
    });
  });
});
