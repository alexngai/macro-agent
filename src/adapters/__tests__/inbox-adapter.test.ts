/**
 * Tests for InboxAdapter — wraps agent-inbox for macro-agent messaging.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { DefaultInboxAdapter } from "../inbox-adapter.js";
import type { InboxDeliveryEvent } from "../types.js";
import * as path from "path";
import * as os from "os";
import * as fs from "fs";

describe("InboxAdapter", () => {
  let adapter: DefaultInboxAdapter;
  let testDir: string;
  let socketPath: string;

  beforeEach(async () => {
    testDir = path.join(
      os.tmpdir(),
      `inbox-adapter-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    fs.mkdirSync(testDir, { recursive: true });
    socketPath = path.join(testDir, "test-inbox.sock");

    adapter = new DefaultInboxAdapter({
      socketPath,
      defaultScope: "test",
    });
    await adapter.initialize();
  });

  afterEach(async () => {
    await adapter.stop();
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  // ── Agent Registration ─────────────────────────────────────

  describe("registerAgent / deregisterAgent", () => {
    it("should register an agent", async () => {
      await adapter.registerAgent("agent-1", {
        name: "Worker 1",
        role: "worker",
        scope: "test",
      });

      // Agent should be in inbox storage
      const inbox = adapter.getInbox();
      const agent = inbox.storage.getAgent("agent-1");
      expect(agent).toBeDefined();
      expect(agent?.display_name).toBe("Worker 1");
      expect(agent?.status).toBe("active");
      expect(agent?.scope).toBe("test");
    });

    it("should deregister an agent (set offline)", async () => {
      await adapter.registerAgent("agent-1", {
        role: "worker",
        scope: "test",
      });
      await adapter.deregisterAgent("agent-1");

      const inbox = adapter.getInbox();
      const agent = inbox.storage.getAgent("agent-1");
      expect(agent?.status).toBe("offline");
    });

    it("should handle deregistering non-existent agent gracefully", async () => {
      await expect(
        adapter.deregisterAgent("nonexistent")
      ).resolves.toBeUndefined();
    });
  });

  // ── Messaging ──────────────────────────────────────────────

  describe("send", () => {
    beforeEach(async () => {
      await adapter.registerAgent("alice", {
        role: "coordinator",
        scope: "test",
      });
      await adapter.registerAgent("bob", {
        role: "worker",
        scope: "test",
      });
    });

    it("should send a text message", async () => {
      const msgId = await adapter.send("alice", "bob", "Hello Bob");
      expect(msgId).toBeTruthy();
      expect(typeof msgId).toBe("string");
    });

    it("should send structured content", async () => {
      const msgId = await adapter.send(
        "alice",
        "bob",
        { type: "event", event: "task_assigned", data: { taskId: "t-1" } },
        { threadTag: "work", importance: "high" }
      );
      expect(msgId).toBeTruthy();
    });

    it("should send to multiple recipients", async () => {
      await adapter.registerAgent("charlie", {
        role: "worker",
        scope: "test",
      });

      const msgId = await adapter.send(
        "alice",
        ["bob", "charlie"],
        "Team update"
      );
      expect(msgId).toBeTruthy();
    });

    it("should deliver messages to inbox", async () => {
      await adapter.send("alice", "bob", "Check this");

      const messages = await adapter.checkInbox("bob");
      expect(messages.length).toBeGreaterThanOrEqual(1);
      expect(messages[0].sender_id).toBe("alice");
    });
  });

  // ── Delivery Subscription ──────────────────────────────────

  describe("onDelivery / offDelivery", () => {
    beforeEach(async () => {
      await adapter.registerAgent("alice", {
        role: "coordinator",
        scope: "test",
      });
      await adapter.registerAgent("bob", {
        role: "worker",
        scope: "test",
      });
    });

    it("should fire delivery handler on message send", async () => {
      const events: InboxDeliveryEvent[] = [];
      adapter.onDelivery((event) => events.push(event));

      await adapter.send("alice", "bob", "Hello");

      // Give event loop a tick for async event dispatch
      await new Promise((r) => setTimeout(r, 50));

      expect(events.length).toBeGreaterThanOrEqual(1);
      const bobEvent = events.find((e) => e.agentId === "bob");
      expect(bobEvent).toBeDefined();
      expect(bobEvent!.message.sender_id).toBe("alice");
    });

    it("should stop firing after offDelivery", async () => {
      const events: InboxDeliveryEvent[] = [];
      const handler = (event: InboxDeliveryEvent) => events.push(event);

      adapter.onDelivery(handler);
      await adapter.send("alice", "bob", "First");
      await new Promise((r) => setTimeout(r, 50));

      const countAfterFirst = events.length;

      adapter.offDelivery(handler);
      await adapter.send("alice", "bob", "Second");
      await new Promise((r) => setTimeout(r, 50));

      expect(events.length).toBe(countAfterFirst);
    });
  });

  // ── Signal Filtering ───────────────────────────────────────

  describe("signal filtering", () => {
    beforeEach(async () => {
      await adapter.registerAgent("alice", {
        role: "coordinator",
        scope: "test",
      });
      await adapter.registerAgent("bob", {
        role: "worker",
        scope: "test",
      });
    });

    it("should suppress deliveries when filter returns false", async () => {
      const events: InboxDeliveryEvent[] = [];
      adapter.onDelivery((event) => events.push(event));

      // Block all messages to bob
      adapter.setSignalFilter((_from, to, _msg) => to !== "bob");

      await adapter.send("alice", "bob", "Blocked message");
      await new Promise((r) => setTimeout(r, 50));

      const bobEvents = events.filter((e) => e.agentId === "bob");
      expect(bobEvents).toHaveLength(0);
    });

    it("should allow deliveries when filter returns true", async () => {
      const events: InboxDeliveryEvent[] = [];
      adapter.onDelivery((event) => events.push(event));

      adapter.setSignalFilter(() => true);

      await adapter.send("alice", "bob", "Allowed message");
      await new Promise((r) => setTimeout(r, 50));

      const bobEvents = events.filter((e) => e.agentId === "bob");
      expect(bobEvents.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ── Emission Validation ────────────────────────────────────

  describe("emission validation", () => {
    beforeEach(async () => {
      await adapter.registerAgent("alice", {
        role: "coordinator",
        scope: "test",
      });
      await adapter.registerAgent("bob", {
        role: "worker",
        scope: "test",
      });
    });

    it("should reject sends when validator returns a reason", async () => {
      adapter.setEmissionValidator((from, _msg) => {
        if (from === "bob") return "Workers cannot broadcast";
        return null;
      });

      await expect(
        adapter.send("bob", "alice", "Unauthorized")
      ).rejects.toThrow("Emission rejected for bob: Workers cannot broadcast");
    });

    it("should allow sends when validator returns null", async () => {
      adapter.setEmissionValidator(() => null);

      const msgId = await adapter.send("bob", "alice", "Allowed");
      expect(msgId).toBeTruthy();
    });
  });

  // ── Queries ────────────────────────────────────────────────

  describe("checkInbox / readThread", () => {
    beforeEach(async () => {
      await adapter.registerAgent("alice", {
        role: "coordinator",
        scope: "test",
      });
      await adapter.registerAgent("bob", {
        role: "worker",
        scope: "test",
      });
    });

    it("should return messages in inbox", async () => {
      await adapter.send("alice", "bob", "Message 1");
      await adapter.send("alice", "bob", "Message 2");

      const inbox = await adapter.checkInbox("bob");
      expect(inbox.length).toBeGreaterThanOrEqual(2);
    });

    it("should return empty inbox for agent with no messages", async () => {
      const inbox = await adapter.checkInbox("alice");
      expect(inbox).toHaveLength(0);
    });

    it("should read messages by thread tag", async () => {
      await adapter.send("alice", "bob", "Thread msg 1", {
        threadTag: "task-123",
        scope: "test",
      });
      await adapter.send("bob", "alice", "Thread msg 2", {
        threadTag: "task-123",
        scope: "test",
      });

      const thread = await adapter.readThread("task-123", "test");
      expect(thread.length).toBeGreaterThanOrEqual(2);
    });
  });

  // ── Lifecycle ──────────────────────────────────────────────

  describe("lifecycle", () => {
    it("should throw if used before initialize", async () => {
      const uninitialized = new DefaultInboxAdapter({
        socketPath: "/tmp/nope.sock",
      });

      await expect(
        uninitialized.send("a", "b", "msg")
      ).rejects.toThrow("not initialized");
    });

    it("should expose socket path", () => {
      expect(adapter.socketPath).toBe(socketPath);
    });

    it("should handle double stop gracefully", async () => {
      await adapter.stop();
      await expect(adapter.stop()).resolves.toBeUndefined();
    });
  });
});
