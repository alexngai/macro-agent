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
