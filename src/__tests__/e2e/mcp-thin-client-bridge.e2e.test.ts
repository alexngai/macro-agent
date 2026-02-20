/**
 * E2E Integration tests for MCP Thin-Client Bridge
 *
 * Starts a real combined server with real services, then uses mapCall()
 * over WebSocket to verify the complete round-trip through MCP bridge
 * extension handlers.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createEventStore, type EventStore } from "../../store/event-store.js";
import { createAgentManager, type AgentManager } from "../../agent/agent-manager.js";
import { createTaskManager, type TaskManager } from "../../task/task-manager.js";
import { createMessageRouter, type MessageRouter } from "../../router/message-router.js";
import {
  createCombinedServer,
  type CombinedServer,
} from "../../server/combined-server.js";
import { mapCall, MapCallError } from "../../mcp/map-client.js";

// =============================================================================
// Test Helpers
// =============================================================================

function getRandomPort(): number {
  return 10000 + Math.floor(Math.random() * 50000);
}

/**
 * Valid agent context for bridge calls.
 * Must match an agent that exists in EventStore.
 */
function agentContext(agentId: string, taskId?: string) {
  return {
    agent_id: agentId,
    session_id: "sess_test",
    task_id: taskId ?? "task_test",
    lineage: [],
    cwd: "/test/cwd",
  };
}

// =============================================================================
// Tests
// =============================================================================

describe("MCP Thin-Client Bridge E2E", () => {
  let eventStore: EventStore;
  let agentManager: AgentManager;
  let taskManager: TaskManager;
  let messageRouter: MessageRouter;
  let server: CombinedServer;
  let port: number;
  let serverUrl: string;

  beforeEach(async () => {
    port = getRandomPort();
    serverUrl = `http://localhost:${port}`;

    // Create real services with in-memory EventStore
    eventStore = await createEventStore({ inMemory: true });
    messageRouter = createMessageRouter(eventStore);
    agentManager = createAgentManager(eventStore, messageRouter, {
      defaultPermissionMode: "auto-approve",
      defaultCwd: "/test/cwd",
    });
    taskManager = createTaskManager(eventStore);

    // Create and start combined server (includes MCP bridge registration)
    server = createCombinedServer(
      { eventStore, agentManager, taskManager, messageRouter },
      { port, host: "localhost" }
    );

    await server.start();
  });

  afterEach(async () => {
    await server.stop();
    await agentManager.close();
    await eventStore.close();
  });

  // ─────────────────────────────────────────────────────────────────
  // emit_status round-trip
  // ─────────────────────────────────────────────────────────────────

  describe("emit_status round-trip", () => {
    it("emits a status event via bridge and verifies it in EventStore", async () => {
      // Seed an agent in the EventStore
      eventStore.emit({
        type: "spawn",
        source: { agent_id: "system" },
        payload: {
          agent_id: "agent_e2e",
          session_id: "sess_e2e",
          task: "E2E test task",
          task_id: "task_e2e",
          parent: null,
          config: {},
          cwd: "/test/cwd",
        },
      });

      const result = await mapCall<{ event_id: string; task_updated: boolean }>(
        serverUrl,
        "_macro/mcp/emit_status",
        {
          context: agentContext("agent_e2e", "task_e2e"),
          status_type: "checkpoint",
          summary: "50% complete",
        }
      );

      expect(result.event_id).toBeDefined();
      expect(result.task_updated).toBe(false);

      // Verify the event was actually stored
      const events = eventStore.query({
        type: "status",
        source_agent_id: "agent_e2e",
      });
      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events[0].payload.summary).toBe("50% complete");
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // query_index round-trip
  // ─────────────────────────────────────────────────────────────────

  describe("query_index round-trip", () => {
    it("queries agents via bridge after seeding data", async () => {
      // Seed agents
      eventStore.emit({
        type: "spawn",
        source: { agent_id: "system" },
        payload: {
          agent_id: "agent_1",
          session_id: "sess_1",
          task: "First task",
          task_id: "task_1",
          parent: null,
          config: {},
          cwd: "/test",
        },
      });
      eventStore.emit({
        type: "spawn",
        source: { agent_id: "system" },
        payload: {
          agent_id: "agent_2",
          session_id: "sess_2",
          task: "Second task",
          task_id: "task_2",
          parent: null,
          config: {},
          cwd: "/test",
        },
      });

      const result = await mapCall<{
        entries: Array<{ type: string; id: string; summary: string }>;
        total: number;
        has_more: boolean;
      }>(serverUrl, "_macro/mcp/query_index", {
        context: agentContext("agent_1"),
        type: "agents",
      });

      expect(result.entries.length).toBeGreaterThanOrEqual(2);
      expect(result.entries.some((e) => e.id === "agent_1")).toBe(true);
      expect(result.entries.some((e) => e.id === "agent_2")).toBe(true);
    });

    it("queries tasks via bridge", async () => {
      // Create a task
      taskManager.create({
        description: "E2E test task",
        created_by: "agent_test",
      });

      const result = await mapCall<{
        entries: Array<{ type: string; id: string; summary: string }>;
        total: number;
      }>(serverUrl, "_macro/mcp/query_index", {
        context: agentContext("agent_test"),
        type: "tasks",
      });

      expect(result.entries.length).toBeGreaterThanOrEqual(1);
      expect(result.entries[0].type).toBe("task");
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // send_message + check_messages round-trip
  // ─────────────────────────────────────────────────────────────────

  describe("send_message + check_messages round-trip", () => {
    it("sends and receives a message via bridge", async () => {
      // Seed two agents
      eventStore.emit({
        type: "spawn",
        source: { agent_id: "system" },
        payload: {
          agent_id: "agent_sender",
          session_id: "sess_sender",
          task: "Sender task",
          task_id: "task_sender",
          parent: null,
          config: {},
          cwd: "/test",
        },
      });
      eventStore.emit({
        type: "spawn",
        source: { agent_id: "system" },
        payload: {
          agent_id: "agent_receiver",
          session_id: "sess_receiver",
          task: "Receiver task",
          task_id: "task_receiver",
          parent: null,
          config: {},
          cwd: "/test",
        },
      });

      // Subscribe receiver to their own address
      eventStore.addSubscription("agent_receiver", "agent:agent_receiver");

      // Send message via bridge
      const sendResult = await mapCall<{ message_id: string; delivered_to: number }>(
        serverUrl,
        "_macro/mcp/send_message",
        {
          context: agentContext("agent_sender"),
          to: { agent_id: "agent_receiver" },
          content: "Hello from E2E test",
        }
      );

      expect(sendResult.message_id).toBeDefined();
      expect(sendResult.delivered_to).toBeGreaterThanOrEqual(1);

      // Check messages via bridge
      const checkResult = await mapCall<{
        messages: Array<{ id: string; content: string; from: string }>;
        total_pending: number;
      }>(serverUrl, "_macro/mcp/check_messages", {
        context: agentContext("agent_receiver"),
      });

      expect(checkResult.messages.length).toBeGreaterThanOrEqual(1);
      expect(checkResult.messages.some((m) => m.content === "Hello from E2E test")).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Context validation over the wire
  // ─────────────────────────────────────────────────────────────────

  describe("context validation over the wire", () => {
    it("rejects calls without context", async () => {
      try {
        await mapCall(serverUrl, "_macro/mcp/query_index", { type: "agents" });
        expect.fail("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(MapCallError);
        expect((err as MapCallError).message).toContain("agent_id is required");
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Error propagation
  // ─────────────────────────────────────────────────────────────────

  describe("error propagation", () => {
    it("returns error for non-existent agent in get_agent_summary", async () => {
      try {
        await mapCall(serverUrl, "_macro/mcp/get_agent_summary", {
          context: agentContext("agent_test"),
          agent_id: "nonexistent_agent",
        });
        expect.fail("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(MapCallError);
        expect((err as MapCallError).message).toContain("not found");
      }
    });

    it("returns error for non-existent extension method", async () => {
      try {
        await mapCall(serverUrl, "_macro/mcp/nonexistent_method", {
          context: agentContext("agent_test"),
        });
        expect.fail("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(MapCallError);
      }
    });
  });
});
