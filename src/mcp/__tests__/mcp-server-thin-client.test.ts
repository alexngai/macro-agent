/**
 * Unit tests for createMCPServerThinClient
 *
 * Verifies tool registration, forwarding to mapCallFn, context injection,
 * error handling, and result formatting.
 *
 * Uses MCP SDK's InMemoryTransport + Client for in-process tool invocation.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  createMCPServerThinClient,
  type MapCallFn,
} from "../mcp-server.js";
import type { ToolContext } from "../types.js";
import { MapCallError } from "../map-client.js";

// =============================================================================
// Test Helpers
// =============================================================================

function createTestContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    agent_id: "agent_caller",
    session_id: "sess_caller",
    task_id: "task_caller",
    lineage: ["agent_root"],
    cwd: "/test/cwd",
    ...overrides,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe("createMCPServerThinClient", () => {
  let mockMapCallFn: MapCallFn;
  let client: Client;
  let context: ToolContext;

  beforeEach(async () => {
    context = createTestContext();
    mockMapCallFn = vi.fn(async () => ({ success: true }));

    // Create thin client MCP server
    const mcpInstance = createMCPServerThinClient(context, mockMapCallFn);

    // Connect via in-memory transport
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test-client", version: "1.0.0" });

    await Promise.all([
      client.connect(clientTransport),
      mcpInstance.server.connect(serverTransport),
    ]);
  });

  afterEach(async () => {
    await client.close();
  });

  // ─────────────────────────────────────────────────────────────────
  // Server creation
  // ─────────────────────────────────────────────────────────────────

  describe("server creation", () => {
    it("creates MCPServerInstance with server, start, close", () => {
      const instance = createMCPServerThinClient(context, mockMapCallFn);
      expect(instance.server).toBeDefined();
      expect(instance.start).toBeTypeOf("function");
      expect(instance.close).toBeTypeOf("function");
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Tool registration
  // ─────────────────────────────────────────────────────────────────

  describe("tool registration", () => {
    it("registers all 17 tools", async () => {
      const tools = await client.listTools();
      const toolNames = tools.tools.map((t) => t.name);

      expect(toolNames).toContain("spawn_agent");
      expect(toolNames).toContain("emit_status");
      expect(toolNames).toContain("send_message");
      expect(toolNames).toContain("check_messages");
      expect(toolNames).toContain("query_index");
      expect(toolNames).toContain("get_hierarchy");
      expect(toolNames).toContain("get_agent_summary");
      expect(toolNames).toContain("stop_agent");
      expect(toolNames).toContain("done");
      expect(toolNames).toContain("inject_context");
      expect(toolNames).toContain("wait_for_activity");
      expect(toolNames).toContain("claim_task");
      expect(toolNames).toContain("unclaim_task");
      expect(toolNames).toContain("list_claimable_tasks");
      expect(toolNames).toContain("send_peer_message");
      expect(toolNames).toContain("send_peer_request");
      expect(toolNames).toContain("respond_to_peer_request");
      expect(toolNames).toHaveLength(17);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Tool forwarding
  // ─────────────────────────────────────────────────────────────────

  describe("tool forwarding", () => {
    it("spawn_agent forwards to _macro/mcp/spawn_agent with context", async () => {
      (mockMapCallFn as ReturnType<typeof vi.fn>).mockResolvedValue({
        agent_id: "a1",
        task_id: "t1",
        session_id: "s1",
      });

      await client.callTool({ name: "spawn_agent", arguments: { task: "child task" } });

      expect(mockMapCallFn).toHaveBeenCalledWith(
        "_macro/mcp/spawn_agent",
        expect.objectContaining({
          task: "child task",
          context: expect.objectContaining({
            agent_id: "agent_caller",
            session_id: "sess_caller",
          }),
        }),
        undefined
      );
    });

    it("emit_status forwards to _macro/mcp/emit_status", async () => {
      await client.callTool({
        name: "emit_status",
        arguments: { status_type: "checkpoint", summary: "50% done" },
      });

      expect(mockMapCallFn).toHaveBeenCalledWith(
        "_macro/mcp/emit_status",
        expect.objectContaining({
          status_type: "checkpoint",
          summary: "50% done",
          context: expect.objectContaining({ agent_id: "agent_caller" }),
        }),
        undefined
      );
    });

    it("wait_for_activity forwards with extended 65s timeout", async () => {
      await client.callTool({
        name: "wait_for_activity",
        arguments: {},
      });

      expect(mockMapCallFn).toHaveBeenCalledWith(
        "_macro/mcp/wait_for_activity",
        expect.objectContaining({
          context: expect.objectContaining({ agent_id: "agent_caller" }),
        }),
        { timeoutMs: 65000 }
      );
    });

    it("check_messages forwards to _macro/mcp/check_messages", async () => {
      (mockMapCallFn as ReturnType<typeof vi.fn>).mockResolvedValue({
        messages: [],
        total_pending: 0,
      });

      await client.callTool({ name: "check_messages", arguments: {} });

      expect(mockMapCallFn).toHaveBeenCalledWith(
        "_macro/mcp/check_messages",
        expect.objectContaining({
          context: expect.objectContaining({ agent_id: "agent_caller" }),
        }),
        undefined
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // withContext helper
  // ─────────────────────────────────────────────────────────────────

  describe("withContext helper", () => {
    it("injects full ToolContext into params.context", async () => {
      await client.callTool({ name: "query_index", arguments: { type: "agents" } });

      const call = (mockMapCallFn as ReturnType<typeof vi.fn>).mock.calls[0];
      const params = call[1] as Record<string, unknown>;

      expect(params.context).toEqual({
        agent_id: "agent_caller",
        session_id: "sess_caller",
        task_id: "task_caller",
        lineage: ["agent_root"],
        cwd: "/test/cwd",
      });
    });

    it("preserves all arg properties alongside context", async () => {
      await client.callTool({
        name: "query_index",
        arguments: { type: "agents", limit: 5, search: "test" },
      });

      const call = (mockMapCallFn as ReturnType<typeof vi.fn>).mock.calls[0];
      const params = call[1] as Record<string, unknown>;

      expect(params.type).toBe("agents");
      expect(params.limit).toBe(5);
      expect(params.search).toBe("test");
      expect(params.context).toBeDefined();
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Error handling
  // ─────────────────────────────────────────────────────────────────

  describe("error handling", () => {
    it("wraps mapCallFn errors in MCPToolError with ROUTING_FAILED", async () => {
      (mockMapCallFn as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("network error")
      );

      const result = await client.callTool({ name: "spawn_agent", arguments: { task: "test" } });

      expect(result.isError).toBe(true);
      expect(result.content).toHaveLength(1);
      expect((result.content[0] as any).text).toContain("spawn_agent failed: network error");
    });

    it("wraps MapCallError instances", async () => {
      (mockMapCallFn as ReturnType<typeof vi.fn>).mockRejectedValue(
        new MapCallError(-32000, "MAP call timed out")
      );

      const result = await client.callTool({
        name: "emit_status",
        arguments: { status_type: "checkpoint", summary: "test" },
      });

      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain("emit_status failed: MAP call timed out");
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Result formatting
  // ─────────────────────────────────────────────────────────────────

  describe("result formatting", () => {
    it("wraps successful result in MCP content format", async () => {
      const expectedResult = { agent_id: "a1", task_id: "t1" };
      (mockMapCallFn as ReturnType<typeof vi.fn>).mockResolvedValue(expectedResult);

      const result = await client.callTool({
        name: "spawn_agent",
        arguments: { task: "test" },
      });

      expect(result.content).toHaveLength(1);
      expect(result.content[0]).toEqual({
        type: "text",
        text: JSON.stringify(expectedResult),
      });
    });
  });
});
