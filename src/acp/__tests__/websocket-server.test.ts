/**
 * Tests for WebSocket ACP server.
 *
 * Integration-style tests that start the server, connect via WebSocket,
 * and verify JSON-RPC round-trips.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { WebSocket } from "ws";
import { createWebSocketACPServer } from "../websocket-server.js";
import type { WebSocketACPServer } from "../websocket-server.js";
import type { MacroAgentSystemV2 } from "../../boot-v2.js";

// ─────────────────────────────────────────────────────────────────
// Mock System
// ─────────────────────────────────────────────────────────────────

function createMockSystem(): MacroAgentSystemV2 {
  return {
    agentManager: {
      getOrCreateHeadManager: vi.fn().mockResolvedValue({
        id: "head-1",
        session_id: "acp-session-1",
        agent: { id: "head-1", role: "coordinator", state: "running" },
        session: {},
      }),
      spawn: vi.fn().mockResolvedValue({
        id: "worker-1",
        session_id: "worker-session-1",
        agent: { id: "worker-1", role: "worker", state: "running" },
        session: {},
      }),
      get: vi.fn().mockReturnValue({ id: "agent-1", role: "worker", state: "running" }),
      prompt: vi.fn().mockReturnValue(
        (async function* () {
          yield { sessionUpdate: "agent_message_chunk", text: "Hello", messageId: "msg-1" };
        })(),
      ),
      terminate: vi.fn().mockResolvedValue(undefined),
      getHierarchy: vi.fn().mockReturnValue(null),
      forkAgent: vi.fn().mockResolvedValue({ id: "fork-1", session_id: "fork-1" }),
      resume: vi.fn().mockResolvedValue({ id: "r-1", session_id: "r-1", agent: { state: "running" } }),
      respondToPermission: vi.fn().mockReturnValue(true),
      cancelPermission: vi.fn().mockReturnValue(true),
      setPermissionMode: vi.fn().mockReturnValue(true),
    } as any,
    agentStore: {} as any,
    inboxAdapter: {
      checkInbox: vi.fn().mockResolvedValue([]),
      readThread: vi.fn().mockResolvedValue([]),
    } as any,
    tasksAdapter: {
      getTask: vi.fn().mockResolvedValue({ id: "task-1", title: "Test" }),
    } as any,
    triggerSystem: {} as any,
    controlServer: {} as any,
    roleRegistry: {} as any,
    controlSocketPath: "/tmp/test.sock",
    shutdown: vi.fn(),
  };
}

// ─────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────

function sendJsonRpc(ws: WebSocket, id: number, method: string, params?: unknown): void {
  ws.send(JSON.stringify({
    jsonrpc: "2.0",
    id,
    method,
    params: params ?? {},
  }));
}

function waitForMessage(ws: WebSocket, timeoutMs = 5000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timeout waiting for message")), timeoutMs);
    ws.once("message", (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()));
    });
  });
}

function connectWs(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

// ─────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────

describe("WebSocket ACP Server", () => {
  let server: WebSocketACPServer;
  let system: MacroAgentSystemV2;

  // Use a random high port to avoid conflicts
  const port = 19000 + Math.floor(Math.random() * 1000);

  beforeEach(async () => {
    system = createMockSystem();
    server = createWebSocketACPServer(system, {
      port,
      host: "127.0.0.1",
      path: "/acp",
    });
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  it("should start and report URL", () => {
    const url = server.getUrl();
    expect(url).toContain("ws://127.0.0.1");
    expect(url).toContain("/acp");
  });

  it("should serve health endpoint", async () => {
    const httpUrl = `http://127.0.0.1:${port}/health`;
    const res = await fetch(httpUrl);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(typeof body.connections).toBe("number");
  });

  it("should accept WebSocket connections and track count", async () => {
    expect(server.getConnectionCount()).toBe(0);

    const ws = await connectWs(server.getUrl());
    // Give the server a tick to register the connection
    await new Promise((r) => setTimeout(r, 50));

    expect(server.getConnectionCount()).toBe(1);

    ws.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(server.getConnectionCount()).toBe(0);
  });

  it("should handle initialize → newSession JSON-RPC flow", async () => {
    const ws = await connectWs(server.getUrl());

    // 1. Initialize
    sendJsonRpc(ws, 1, "initialize", { protocolVersion: 1 });
    const initResp = await waitForMessage(ws);
    expect(initResp.jsonrpc).toBe("2.0");
    expect(initResp.id).toBe(1);
    expect(initResp.result.protocolVersion).toBe(1);
    expect(initResp.result.agentInfo.name).toBe("macro-agent");

    // 2. New session
    sendJsonRpc(ws, 2, "session/new", { cwd: "/tmp/test", mcpServers: [] });
    const sessionResp = await waitForMessage(ws);
    expect(sessionResp.id).toBe(2);
    expect(sessionResp.result.sessionId).toBe("acp-session-1");

    ws.close();
  });

  it("should handle multiple concurrent connections", async () => {
    const ws1 = await connectWs(server.getUrl());
    const ws2 = await connectWs(server.getUrl());
    await new Promise((r) => setTimeout(r, 50));

    expect(server.getConnectionCount()).toBe(2);

    ws1.close();
    ws2.close();
  });

  it("should close all connections on stop", async () => {
    const ws = await connectWs(server.getUrl());
    await new Promise((r) => setTimeout(r, 50));
    expect(server.getConnectionCount()).toBe(1);

    const closedPromise = new Promise<void>((resolve) => {
      ws.on("close", () => resolve());
    });

    await server.stop();
    await closedPromise;

    expect(server.getConnectionCount()).toBe(0);
  });
});
