/**
 * MessageRouter tests
 *
 * Note: send() method tests have been removed as that method is deprecated.
 * See send-to-address.test.ts for comprehensive sendToAddress() coverage.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createEventStore, EventStore } from "../../store/event-store.js";
import { createMessageRouter, MessageRouter } from "../message-router.js";

describe("MessageRouter", () => {
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
  function createAgent(id: string, parent?: string, taskId?: string) {
    eventStore.emit({
      type: "spawn",
      source: { agent_id: parent ?? "system" },
      payload: {
        agent_id: id,
        session_id: `session_${id}`,
        task: `Task for ${id}`,
        task_id: taskId,
        parent: parent ?? null,
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

  describe("getMessages()", () => {
    it("should return messages in chronological order", async () => {
      createAgent("sender");
      createAgent("recipient");

      await router.sendToAddress({
        from: "sender",
        to: { agent: "recipient" },
        content: "First",
      });
      await new Promise((r) => setTimeout(r, 10));
      await router.sendToAddress({
        from: "sender",
        to: { agent: "recipient" },
        content: "Second",
      });
      await new Promise((r) => setTimeout(r, 10));
      await router.sendToAddress({
        from: "sender",
        to: { agent: "recipient" },
        content: "Third",
      });

      const messages = router.getMessages("recipient");
      expect(messages).toHaveLength(3);
      expect(messages[0].content).toBe("First");
      expect(messages[1].content).toBe("Second");
      expect(messages[2].content).toBe("Third");
    });

    it("should respect limit option", async () => {
      createAgent("sender");
      createAgent("recipient");

      for (let i = 0; i < 10; i++) {
        await router.sendToAddress({
          from: "sender",
          to: { agent: "recipient" },
          content: `Message ${i}`,
        });
      }

      const messages = router.getMessages("recipient", { limit: 5 });
      expect(messages).toHaveLength(5);
      expect(messages[0].content).toBe("Message 0");
      expect(messages[4].content).toBe("Message 4");
    });

    it("should return empty array if no messages", () => {
      createAgent("agent_1");
      const messages = router.getMessages("agent_1");
      expect(messages).toHaveLength(0);
    });

    it("should exclude acknowledged messages by default", async () => {
      createAgent("sender");
      createAgent("recipient");

      await router.sendToAddress({
        from: "sender",
        to: { agent: "recipient" },
        content: "Message 1",
      });
      const msg2 = await router.sendToAddress({
        from: "sender",
        to: { agent: "recipient" },
        content: "Message 2",
      });
      await router.sendToAddress({
        from: "sender",
        to: { agent: "recipient" },
        content: "Message 3",
      });

      router.acknowledgeMessage("recipient", msg2.id);

      const messages = router.getMessages("recipient");
      expect(messages).toHaveLength(2);
      expect(messages.map((m) => m.content)).toEqual([
        "Message 1",
        "Message 3",
      ]);
    });

    it("should include acknowledged messages when requested", async () => {
      createAgent("sender");
      createAgent("recipient");

      await router.sendToAddress({
        from: "sender",
        to: { agent: "recipient" },
        content: "Message 1",
      });
      const msg2 = await router.sendToAddress({
        from: "sender",
        to: { agent: "recipient" },
        content: "Message 2",
      });
      await router.sendToAddress({
        from: "sender",
        to: { agent: "recipient" },
        content: "Message 3",
      });

      router.acknowledgeMessage("recipient", msg2.id);

      const messages = router.getMessages("recipient", {
        includeAcknowledged: true,
      });
      expect(messages).toHaveLength(3);
    });
  });

  describe("getFullMessage()", () => {
    it("should return full content of message", async () => {
      createAgent("sender");
      createAgent("recipient");

      const sent = await router.sendToAddress({
        from: "sender",
        to: { agent: "recipient" },
        content: "Full message content here",
      });

      const fullContent = router.getFullMessage(sent.id);
      expect(fullContent).toBe("Full message content here");
    });

    it("should return null for non-existent message", () => {
      const content = router.getFullMessage("nonexistent");
      expect(content).toBeNull();
    });
  });

  describe("acknowledgeMessage()", () => {
    it("should mark message as acknowledged", async () => {
      createAgent("sender");
      createAgent("recipient");

      const sent = await router.sendToAddress({
        from: "sender",
        to: { agent: "recipient" },
        content: "Hello",
      });

      expect(router.getMessages("recipient")).toHaveLength(1);

      router.acknowledgeMessage("recipient", sent.id);

      expect(router.getMessages("recipient")).toHaveLength(0);
    });
  });

  describe("acknowledgeMessages()", () => {
    it("should acknowledge multiple messages", async () => {
      createAgent("sender");
      createAgent("recipient");

      const msg1 = await router.sendToAddress({
        from: "sender",
        to: { agent: "recipient" },
        content: "M1",
      });
      const msg2 = await router.sendToAddress({
        from: "sender",
        to: { agent: "recipient" },
        content: "M2",
      });
      const msg3 = await router.sendToAddress({
        from: "sender",
        to: { agent: "recipient" },
        content: "M3",
      });

      router.acknowledgeMessages("recipient", [msg1.id, msg3.id]);

      const messages = router.getMessages("recipient");
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe("M2");
    });
  });

  describe("subscription management", () => {
    describe("subscribe()", () => {
      it("should add subscription", () => {
        createAgent("agent_1");

        router.subscribe("agent_1", { type: "topic", target: "discoveries" });

        const subs = router.getSubscriptions("agent_1");
        expect(subs).toContainEqual({ type: "topic", target: "discoveries" });
      });
    });

    describe("unsubscribe()", () => {
      it("should remove subscription", () => {
        createAgent("agent_1");

        router.subscribe("agent_1", { type: "topic", target: "updates" });
        expect(router.getSubscriptions("agent_1")).toContainEqual({
          type: "topic",
          target: "updates",
        });

        router.unsubscribe("agent_1", { type: "topic", target: "updates" });
        expect(router.getSubscriptions("agent_1")).not.toContainEqual({
          type: "topic",
          target: "updates",
        });
      });
    });

    describe("getSubscriptions()", () => {
      it("should return all subscriptions for agent", () => {
        createAgent("agent_1");

        router.subscribe("agent_1", { type: "topic", target: "topic_a" });
        router.subscribe("agent_1", { type: "topic", target: "topic_b" });
        router.subscribe("agent_1", { type: "agent", target: "agent_1" });

        const subs = router.getSubscriptions("agent_1");
        expect(subs).toHaveLength(3);
      });
    });

    describe("getSubscribers()", () => {
      it("should return all agents subscribed to channel", () => {
        createAgent("agent_1");
        createAgent("agent_2");
        createAgent("agent_3");

        router.subscribe("agent_1", { type: "topic", target: "errors" });
        router.subscribe("agent_2", { type: "topic", target: "errors" });

        const subscribers = router.getSubscribers({
          type: "topic",
          target: "errors",
        });
        expect(subscribers).toHaveLength(2);
        expect(subscribers).toContain("agent_1");
        expect(subscribers).toContain("agent_2");
      });
    });
  });

  describe("setupDefaultSubscriptions()", () => {
    it("should set up agent and lineage subscriptions", () => {
      createAgent("child_1");

      router.setupDefaultSubscriptions({
        agent_id: "child_1",
      });

      const subs = router.getSubscriptions("child_1");
      expect(subs).toContainEqual({ type: "agent", target: "child_1" });
      expect(subs).toContainEqual({ type: "lineage", target: "child_1" });
    });

    it("should set up task subscription if task_id provided", () => {
      createAgent("worker_1");
      createTask("task_1", "worker_1");

      router.setupDefaultSubscriptions({
        agent_id: "worker_1",
        task_id: "task_1",
      });

      const subs = router.getSubscriptions("worker_1");
      expect(subs).toContainEqual({ type: "task", target: "task_1" });
    });

    it("should subscribe parent to subtree by default", () => {
      createAgent("parent_1");
      createAgent("child_1", "parent_1");

      router.setupDefaultSubscriptions({
        agent_id: "child_1",
        parent_id: "parent_1",
      });

      const parentSubs = router.getSubscriptions("parent_1");
      expect(parentSubs).toContainEqual({ type: "subtree", target: "child_1" });
    });

    it("should not subscribe parent if subscribe_parent is false", () => {
      createAgent("parent_1");
      createAgent("child_1", "parent_1");

      router.setupDefaultSubscriptions({
        agent_id: "child_1",
        parent_id: "parent_1",
        subscribe_parent: false,
      });

      const parentSubs = router.getSubscriptions("parent_1");
      expect(parentSubs).not.toContainEqual({
        type: "subtree",
        target: "child_1",
      });
    });

    it("should subscribe to additional topics", () => {
      createAgent("agent_1");

      router.setupDefaultSubscriptions({
        agent_id: "agent_1",
        additional_topics: ["errors", "discoveries"],
      });

      const subs = router.getSubscriptions("agent_1");
      expect(subs).toContainEqual({ type: "topic", target: "errors" });
      expect(subs).toContainEqual({ type: "topic", target: "discoveries" });
    });
  });

  describe("emitStatus()", () => {
    it("should emit status event", () => {
      createAgent("worker_1");

      router.emitStatus({
        from: { agent_id: "worker_1" },
        status_type: "checkpoint",
        summary: "Progress update",
      });

      const events = eventStore.query({ type: "status" });
      // First event is the "started" status from createAgent, second is the checkpoint
      expect(events).toHaveLength(2);
      expect(events[1].payload).toMatchObject({
        status_type: "checkpoint",
        summary: "Progress update",
      });
    });

    it("should route status to subtree subscribers", () => {
      createAgent("manager_1");
      createAgent("worker_1", "manager_1");

      // Set up default subscriptions
      router.setupDefaultSubscriptions({
        agent_id: "worker_1",
        parent_id: "manager_1",
      });

      // Worker emits status
      router.emitStatus({
        from: { agent_id: "worker_1" },
        status_type: "completed",
        summary: "Task done",
      });

      // Manager should receive the status notification
      const messages = router.getMessages("manager_1");
      expect(messages.length).toBeGreaterThan(0);

      const statusMsg = messages.find((m) =>
        m.content.includes("status_notification")
      );
      expect(statusMsg).toBeDefined();

      const parsed = JSON.parse(statusMsg!.content);
      expect(parsed.status_type).toBe("completed");
      expect(parsed.summary).toBe("Task done");
    });

    it("should route failed status to manager", () => {
      createAgent("manager_1");
      createAgent("worker_1", "manager_1");

      router.setupDefaultSubscriptions({
        agent_id: "worker_1",
        parent_id: "manager_1",
      });

      router.emitStatus({
        from: { agent_id: "worker_1" },
        status_type: "failed",
        summary: "Error occurred",
        details: { error: "Connection timeout" },
      });

      const messages = router.getMessages("manager_1");
      const statusMsg = messages.find((m) =>
        m.content.includes("status_notification")
      );
      expect(statusMsg).toBeDefined();

      const parsed = JSON.parse(statusMsg!.content);
      expect(parsed.status_type).toBe("failed");
      expect(parsed.details.error).toBe("Connection timeout");
    });

    it("should route status to topic co-subscribers", () => {
      // Two peer agents (no parent-child relationship) sharing a topic
      createAgent("worker_a");
      createAgent("worker_b");

      router.subscribe("worker_a", { type: "topic", target: "work_coordination" });
      router.subscribe("worker_b", { type: "topic", target: "work_coordination" });

      // worker_a emits a status
      router.emitStatus({
        from: { agent_id: "worker_a" },
        status_type: "completed",
        summary: "Task A done",
      });

      // worker_b should receive the notification via topic routing
      const messages = router.getMessages("worker_b");
      const statusMsg = messages.find((m) =>
        m.content.includes("status_notification")
      );
      expect(statusMsg).toBeDefined();

      const parsed = JSON.parse(statusMsg!.content);
      expect(parsed.status_type).toBe("completed");
      expect(parsed.summary).toBe("Task A done");
    });

    it("should not send topic status to self", () => {
      createAgent("worker_a");

      router.subscribe("worker_a", { type: "topic", target: "work_coordination" });

      router.emitStatus({
        from: { agent_id: "worker_a" },
        status_type: "checkpoint",
        summary: "Progress",
      });

      // worker_a should NOT receive a notification about its own status
      const messages = router.getMessages("worker_a");
      const statusMsgs = messages.filter((m) =>
        m.content.includes("status_notification")
      );
      expect(statusMsgs).toHaveLength(0);
    });

    it("should not duplicate delivery to agents already notified via subtree", () => {
      // manager_1 is parent of worker_1, AND both share a topic
      createAgent("manager_1");
      createAgent("worker_1", "manager_1");

      // Set up subtree subscription (parent subscribes to child)
      router.setupDefaultSubscriptions({
        agent_id: "worker_1",
        parent_id: "manager_1",
      });

      // Also subscribe both to a shared topic
      router.subscribe("manager_1", { type: "topic", target: "task_updates" });
      router.subscribe("worker_1", { type: "topic", target: "task_updates" });

      router.emitStatus({
        from: { agent_id: "worker_1" },
        status_type: "completed",
        summary: "Done",
      });

      // manager_1 should receive exactly ONE notification (via subtree, not duplicated by topic)
      const messages = router.getMessages("manager_1");
      const statusMsgs = messages.filter((m) =>
        m.content.includes("status_notification")
      );
      expect(statusMsgs).toHaveLength(1);
    });

    it("should route status to multiple topic co-subscribers", () => {
      createAgent("worker_a");
      createAgent("worker_b");
      createAgent("monitor_1");

      // All three share the health topic
      router.subscribe("worker_a", { type: "topic", target: "health" });
      router.subscribe("worker_b", { type: "topic", target: "health" });
      router.subscribe("monitor_1", { type: "topic", target: "health" });

      router.emitStatus({
        from: { agent_id: "worker_a" },
        status_type: "checkpoint",
        summary: "Health OK",
      });

      // Both worker_b and monitor_1 should receive it
      for (const recipientId of ["worker_b", "monitor_1"]) {
        const messages = router.getMessages(recipientId);
        const statusMsg = messages.find((m) =>
          m.content.includes("status_notification")
        );
        expect(statusMsg).toBeDefined();
        const parsed = JSON.parse(statusMsg!.content);
        expect(parsed.summary).toBe("Health OK");
      }

      // worker_a should NOT receive it
      const selfMessages = router.getMessages("worker_a");
      expect(
        selfMessages.filter((m) => m.content.includes("status_notification"))
      ).toHaveLength(0);
    });

    it("should not route to topic subscribers when agent has no topic subscriptions", () => {
      // worker_a has no topic subs, worker_b has a topic sub
      createAgent("worker_a");
      createAgent("worker_b");

      router.subscribe("worker_b", { type: "topic", target: "work_coordination" });

      router.emitStatus({
        from: { agent_id: "worker_a" },
        status_type: "completed",
        summary: "Done",
      });

      // worker_b should NOT receive anything (worker_a isn't on the topic)
      const messages = router.getMessages("worker_b");
      expect(
        messages.filter((m) => m.content.includes("status_notification"))
      ).toHaveLength(0);
    });

    it("should deduplicate across multiple shared topics", () => {
      // Two agents sharing two different topics
      createAgent("worker_a");
      createAgent("worker_b");

      router.subscribe("worker_a", { type: "topic", target: "work_coordination" });
      router.subscribe("worker_a", { type: "topic", target: "task_updates" });
      router.subscribe("worker_b", { type: "topic", target: "work_coordination" });
      router.subscribe("worker_b", { type: "topic", target: "task_updates" });

      router.emitStatus({
        from: { agent_id: "worker_a" },
        status_type: "completed",
        summary: "Done",
      });

      // worker_b should receive exactly ONE notification, not two
      const messages = router.getMessages("worker_b");
      const statusMsgs = messages.filter((m) =>
        m.content.includes("status_notification")
      );
      expect(statusMsgs).toHaveLength(1);
    });
  });

  describe("status wake logic", () => {
    it("should wake sleeping agent on subtree status notification", async () => {
      const wakeEvents: { agentId: string; eventId: string }[] = [];

      const routerWithWake = createMessageRouter(eventStore, {
        sessionChecker: {
          hasActiveSession: () => false,
          getSessionState: () => "idle",
        },
        wakeHandler: (agentId, _decision, eventId) => {
          wakeEvents.push({ agentId, eventId });
        },
      });

      createAgent("manager_1");
      createAgent("worker_1", "manager_1");

      routerWithWake.setupDefaultSubscriptions({
        agent_id: "worker_1",
        parent_id: "manager_1",
      });

      routerWithWake.emitStatus({
        from: { agent_id: "worker_1" },
        status_type: "completed",
        summary: "Task done",
      });

      expect(wakeEvents).toHaveLength(1);
      expect(wakeEvents[0].agentId).toBe("manager_1");
      expect(wakeEvents[0].eventId).toBeDefined();
    });

    it("should wake sleeping agent on topic status notification", async () => {
      const wakeEvents: { agentId: string; eventId: string }[] = [];

      const routerWithWake = createMessageRouter(eventStore, {
        sessionChecker: {
          hasActiveSession: () => false,
          getSessionState: () => "idle",
        },
        wakeHandler: (agentId, _decision, eventId) => {
          wakeEvents.push({ agentId, eventId });
        },
      });

      createAgent("worker_a");
      createAgent("worker_b");

      routerWithWake.subscribe("worker_a", { type: "topic", target: "work_coordination" });
      routerWithWake.subscribe("worker_b", { type: "topic", target: "work_coordination" });

      routerWithWake.emitStatus({
        from: { agent_id: "worker_a" },
        status_type: "completed",
        summary: "Task A done",
      });

      expect(wakeEvents).toHaveLength(1);
      expect(wakeEvents[0].agentId).toBe("worker_b");
    });

    it("should not wake busy (prompting) agent on status notification", async () => {
      const wakeEvents: { agentId: string }[] = [];

      const routerWithWake = createMessageRouter(eventStore, {
        sessionChecker: {
          hasActiveSession: () => true,
          getSessionState: () => "active",
          isPrompting: () => true,
        },
        wakeHandler: (agentId) => {
          wakeEvents.push({ agentId });
        },
      });

      createAgent("worker_a");
      createAgent("worker_b");

      routerWithWake.subscribe("worker_a", { type: "topic", target: "work_coordination" });
      routerWithWake.subscribe("worker_b", { type: "topic", target: "work_coordination" });

      routerWithWake.emitStatus({
        from: { agent_id: "worker_a" },
        status_type: "checkpoint",
        summary: "Progress",
      });

      // Normal priority + busy (prompting) session = queue, no wake
      expect(wakeEvents).toHaveLength(0);
    });

    it("should not fail status delivery if wake handler throws", async () => {
      const routerWithWake = createMessageRouter(eventStore, {
        sessionChecker: {
          hasActiveSession: () => false,
          getSessionState: () => "idle",
        },
        wakeHandler: () => {
          throw new Error("Wake handler crashed");
        },
      });

      createAgent("manager_1");
      createAgent("worker_1", "manager_1");

      routerWithWake.setupDefaultSubscriptions({
        agent_id: "worker_1",
        parent_id: "manager_1",
      });

      // Should not throw despite wake handler error
      expect(() => {
        routerWithWake.emitStatus({
          from: { agent_id: "worker_1" },
          status_type: "completed",
          summary: "Task done",
        });
      }).not.toThrow();

      // Message should still be delivered
      const messages = routerWithWake.getMessages("manager_1");
      const statusMsg = messages.find((m) =>
        m.content.includes("status_notification")
      );
      expect(statusMsg).toBeDefined();
    });
  });

  describe("signal filtering", () => {
    it("should suppress delivery when signal filter rejects", () => {
      createAgent("worker_a");
      createAgent("worker_b");

      router.subscribe("worker_a", { type: "topic", target: "work_coordination" });
      router.subscribe("worker_b", { type: "topic", target: "work_coordination" });

      // Install filter that blocks WORKER_DONE signal
      router.setSignalFilter((_from, _to, signal) => {
        return signal !== "WORKER_DONE";
      });

      router.emitStatus({
        from: { agent_id: "worker_a" },
        status_type: "completed",
        summary: "Task done",
        details: { signal: "WORKER_DONE" },
      });

      const messages = router.getMessages("worker_b");
      expect(
        messages.filter((m) => m.content.includes("status_notification"))
      ).toHaveLength(0);
    });

    it("should allow delivery when signal filter accepts", () => {
      createAgent("worker_a");
      createAgent("worker_b");

      router.subscribe("worker_a", { type: "topic", target: "work_coordination" });
      router.subscribe("worker_b", { type: "topic", target: "work_coordination" });

      // Install filter that allows CONVERGENCE_CHECK
      router.setSignalFilter((_from, _to, signal) => {
        return signal === "CONVERGENCE_CHECK";
      });

      router.emitStatus({
        from: { agent_id: "worker_a" },
        status_type: "checkpoint",
        summary: "Check",
        details: { signal: "CONVERGENCE_CHECK" },
      });

      const messages = router.getMessages("worker_b");
      expect(
        messages.filter((m) => m.content.includes("status_notification"))
      ).toHaveLength(1);
    });

    it("should pass through untagged status events (no details.signal)", () => {
      createAgent("worker_a");
      createAgent("worker_b");

      router.subscribe("worker_a", { type: "topic", target: "work_coordination" });
      router.subscribe("worker_b", { type: "topic", target: "work_coordination" });

      // Install strict filter that blocks everything
      router.setSignalFilter((_from, _to, signal) => {
        if (!signal) return true; // untagged passes through
        return false;
      });

      // Emit without details.signal
      router.emitStatus({
        from: { agent_id: "worker_a" },
        status_type: "completed",
        summary: "Done",
      });

      const messages = router.getMessages("worker_b");
      expect(
        messages.filter((m) => m.content.includes("status_notification"))
      ).toHaveLength(1);
    });

    it("should apply signal filter to subtree subscriptions", () => {
      createAgent("manager_1");
      createAgent("worker_1", "manager_1");

      router.setupDefaultSubscriptions({
        agent_id: "worker_1",
        parent_id: "manager_1",
      });

      // Block FIXUP_CREATED for subtree subscribers
      router.setSignalFilter((_from, _to, signal) => {
        return signal !== "FIXUP_CREATED";
      });

      router.emitStatus({
        from: { agent_id: "worker_1" },
        status_type: "checkpoint",
        summary: "Fixup created",
        details: { signal: "FIXUP_CREATED" },
      });

      const messages = router.getMessages("manager_1");
      expect(
        messages.filter((m) => m.content.includes("status_notification"))
      ).toHaveLength(0);
    });

    it("should use directional from/to in filter callback", () => {
      const filterCalls: { from: string; to: string; signal: string | undefined }[] = [];

      createAgent("worker_a");
      createAgent("worker_b");

      router.subscribe("worker_a", { type: "topic", target: "updates" });
      router.subscribe("worker_b", { type: "topic", target: "updates" });

      router.setSignalFilter((from, to, signal) => {
        filterCalls.push({ from, to, signal });
        return true;
      });

      router.emitStatus({
        from: { agent_id: "worker_a" },
        status_type: "completed",
        summary: "Done",
        details: { signal: "TEST_SIGNAL" },
      });

      expect(filterCalls).toHaveLength(1);
      expect(filterCalls[0]).toEqual({
        from: "worker_a",
        to: "worker_b",
        signal: "TEST_SIGNAL",
      });
    });
  });

  describe("emission validation", () => {
    it("should block emission when validator returns reject", () => {
      createAgent("worker_a");
      createAgent("manager_1");

      router.subscribe("manager_1", { type: "subtree", target: "worker_a" });

      router.setEmissionValidator((_agentId, signal) => {
        if (signal === "FORBIDDEN_SIGNAL") {
          return { action: "reject", message: "Not allowed" };
        }
        return { action: "allow" };
      });

      router.emitStatus({
        from: { agent_id: "worker_a" },
        status_type: "checkpoint",
        summary: "Forbidden",
        details: { signal: "FORBIDDEN_SIGNAL" },
      });

      // No notification should be delivered
      const messages = router.getMessages("manager_1");
      expect(
        messages.filter((m) => m.content.includes("status_notification"))
      ).toHaveLength(0);
    });

    it("should allow emission when validator returns allow", () => {
      createAgent("worker_a");
      createAgent("manager_1");

      router.subscribe("manager_1", { type: "subtree", target: "worker_a" });

      router.setEmissionValidator(() => ({ action: "allow" }));

      router.emitStatus({
        from: { agent_id: "worker_a" },
        status_type: "completed",
        summary: "Done",
        details: { signal: "WORKER_DONE" },
      });

      const messages = router.getMessages("manager_1");
      expect(
        messages.filter((m) => m.content.includes("status_notification"))
      ).toHaveLength(1);
    });

    it("should allow emission and record audit event when validator returns audit", () => {
      createAgent("worker_a");
      createAgent("manager_1");

      router.subscribe("manager_1", { type: "subtree", target: "worker_a" });

      router.setEmissionValidator((_agentId, signal) => {
        if (signal === "UNAUTHORIZED") {
          return { action: "audit", message: "Audit: unauthorized emission" };
        }
        return { action: "allow" };
      });

      router.emitStatus({
        from: { agent_id: "worker_a" },
        status_type: "checkpoint",
        summary: "Check",
        details: { signal: "UNAUTHORIZED" },
      });

      // Status notification should still be delivered
      const messages = router.getMessages("manager_1");
      expect(
        messages.filter((m) => m.content.includes("status_notification"))
      ).toHaveLength(1);

      // Audit event should be recorded in EventStore
      const events = eventStore.query({ type: "status" });
      const auditEvent = events.find(
        (e) => (e.payload as Record<string, unknown>)?.audit != null
      );
      expect(auditEvent).toBeDefined();
      const audit = (auditEvent!.payload as Record<string, unknown>).audit as Record<string, unknown>;
      expect(audit.type).toBe("emission_violation");
      expect(audit.agent_id).toBe("worker_a");
      expect(audit.signal).toBe("UNAUTHORIZED");
    });

    it("should allow emission when validator returns warn", () => {
      createAgent("worker_a");
      createAgent("manager_1");

      router.subscribe("manager_1", { type: "subtree", target: "worker_a" });

      router.setEmissionValidator(() => ({
        action: "warn",
        message: "Warning: unusual emission",
      }));

      router.emitStatus({
        from: { agent_id: "worker_a" },
        status_type: "completed",
        summary: "Done",
        details: { signal: "ODD_SIGNAL" },
      });

      // Warn still allows delivery
      const messages = router.getMessages("manager_1");
      expect(
        messages.filter((m) => m.content.includes("status_notification"))
      ).toHaveLength(1);
    });

    it("should pass through untagged emissions without validation", () => {
      const validatorCalls: { agentId: string; signal: string | undefined }[] = [];

      createAgent("worker_a");
      createAgent("manager_1");

      router.subscribe("manager_1", { type: "subtree", target: "worker_a" });

      router.setEmissionValidator((agentId, signal) => {
        validatorCalls.push({ agentId, signal });
        // Always reject tagged signals for this test
        if (signal) return { action: "reject" };
        return { action: "allow" };
      });

      // Emit without details.signal
      router.emitStatus({
        from: { agent_id: "worker_a" },
        status_type: "completed",
        summary: "Done",
      });

      // Validator is called with undefined signal and allows it
      expect(validatorCalls).toHaveLength(1);
      expect(validatorCalls[0].signal).toBeUndefined();

      const messages = router.getMessages("manager_1");
      expect(
        messages.filter((m) => m.content.includes("status_notification"))
      ).toHaveLength(1);
    });
  });

  // Note: Lineage routing tests removed - feature only implemented in deprecated send()
  // TODO: Port lineage routing to sendToAddress() if needed

  describe("message truncation", () => {
    it("should truncate large messages", async () => {
      createAgent("sender");
      createAgent("recipient");

      const largeContent = "x".repeat(2000); // Exceeds default 1000 char limit

      await router.sendToAddress({
        from: "sender",
        to: { agent: "recipient" },
        content: largeContent,
      });

      const messages = router.getMessages("recipient");
      expect(messages[0].truncated).toBe(true);
      expect(messages[0].content.length).toBeLessThan(largeContent.length);
    });

    it("should not truncate small messages", async () => {
      createAgent("sender");
      createAgent("recipient");

      await router.sendToAddress({
        from: "sender",
        to: { agent: "recipient" },
        content: "Short message",
      });

      const messages = router.getMessages("recipient");
      expect(messages[0].truncated).toBe(false);
      expect(messages[0].content).toBe("Short message");
    });

    it("should retrieve full content via getFullMessage", async () => {
      createAgent("sender");
      createAgent("recipient");

      const largeContent = "x".repeat(2000);

      const sent = await router.sendToAddress({
        from: "sender",
        to: { agent: "recipient" },
        content: largeContent,
      });

      const fullContent = router.getFullMessage(sent.id);
      expect(fullContent).toBe(largeContent);
    });
  });
});
