/**
 * Unit tests for mapCall() — the thin MAP client utility.
 *
 * Spins up a real local WebSocket server per test to validate the
 * handshake → RPC → close lifecycle.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { WebSocketServer, WebSocket as WsWebSocket } from "ws";
import { mapCall, MapCallError } from "../map-client.js";

// =============================================================================
// Test Helpers
// =============================================================================

function getRandomPort(): number {
  return 10000 + Math.floor(Math.random() * 50000);
}

interface TestServer {
  port: number;
  wss: WebSocketServer;
  connections: WsWebSocket[];
  close: () => Promise<void>;
}

/**
 * Create a test WebSocket server that simulates the MAP protocol.
 * @param handler - Called for each incoming JSON-RPC message with (ws, parsed message).
 */
function createTestServer(
  handler: (ws: WsWebSocket, msg: { jsonrpc: string; id: number; method: string; params?: unknown }) => void
): TestServer {
  const port = getRandomPort();
  const connections: WsWebSocket[] = [];

  const wss = new WebSocketServer({ port, path: "/map" });
  wss.on("connection", (ws) => {
    connections.push(ws);
    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        handler(ws, msg);
      } catch {
        // Ignore parse errors
      }
    });
  });

  return {
    port,
    wss,
    connections,
    close: () =>
      new Promise<void>((resolve) => {
        for (const conn of connections) {
          if (conn.readyState === WsWebSocket.OPEN) conn.close();
        }
        wss.close(() => resolve());
      }),
  };
}

/**
 * Create a test server that handles the MAP handshake and responds to a single RPC.
 */
function createHandshakeAndRpcServer(rpcResult: unknown): TestServer {
  return createTestServer((ws, msg) => {
    if (msg.method === "map/connect") {
      // Respond to handshake
      ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: msg.id,
          result: { participantId: "p-test", capabilities: {} },
        })
      );
    } else {
      // Respond to RPC
      ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: msg.id,
          result: rpcResult,
        })
      );
    }
  });
}

// =============================================================================
// Tests
// =============================================================================

describe("mapCall", () => {
  let server: TestServer;

  afterEach(async () => {
    if (server) {
      await server.close();
    }
  });

  // ─────────────────────────────────────────────────────────────────
  // Success path
  // ─────────────────────────────────────────────────────────────────

  describe("success path", () => {
    it("completes handshake and returns RPC result", async () => {
      const expectedResult = { agent_id: "a1", task_id: "t1" };
      server = createHandshakeAndRpcServer(expectedResult);

      const result = await mapCall<typeof expectedResult>(
        `http://localhost:${server.port}`,
        "_macro/mcp/spawn_agent",
        { task: "test" }
      );

      expect(result).toEqual(expectedResult);
    });

    it("converts http:// URL to ws:// with /map path", async () => {
      let receivedConnection = false;
      server = createTestServer((ws, msg) => {
        receivedConnection = true;
        if (msg.method === "map/connect") {
          ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }));
        } else {
          ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: "ok" }));
        }
      });

      await mapCall(`http://localhost:${server.port}`, "test");
      expect(receivedConnection).toBe(true);
    });

    it("passes params through to RPC request", async () => {
      let capturedParams: unknown;
      server = createTestServer((ws, msg) => {
        if (msg.method === "map/connect") {
          ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }));
        } else {
          capturedParams = msg.params;
          ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: "ok" }));
        }
      });

      const params = { task: "test", context: { agent_id: "a1" } };
      await mapCall(`http://localhost:${server.port}`, "_macro/mcp/spawn_agent", params);

      expect(capturedParams).toEqual(params);
    });

    it("handles undefined params", async () => {
      let capturedParams: unknown = "NOT_SET";
      server = createTestServer((ws, msg) => {
        if (msg.method === "map/connect") {
          ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }));
        } else {
          capturedParams = msg.params;
          ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: "ok" }));
        }
      });

      await mapCall(`http://localhost:${server.port}`, "test");
      expect(capturedParams).toBeUndefined();
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Timeout
  // ─────────────────────────────────────────────────────────────────

  describe("timeout", () => {
    it("times out if server never responds to handshake", async () => {
      // Server accepts connection but never responds
      server = createTestServer(() => {
        // intentionally empty — no response
      });

      await expect(
        mapCall(`http://localhost:${server.port}`, "test", undefined, { timeoutMs: 100 })
      ).rejects.toThrow(MapCallError);

      try {
        await mapCall(`http://localhost:${server.port}`, "test", undefined, { timeoutMs: 100 });
      } catch (err) {
        expect(err).toBeInstanceOf(MapCallError);
        expect((err as MapCallError).code).toBe(-32000);
        expect((err as MapCallError).message).toContain("timed out");
      }
    });

    it("times out if server never responds to RPC after handshake", async () => {
      server = createTestServer((ws, msg) => {
        if (msg.method === "map/connect") {
          ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }));
        }
        // Don't respond to the RPC
      });

      await expect(
        mapCall(`http://localhost:${server.port}`, "test", undefined, { timeoutMs: 100 })
      ).rejects.toThrow("timed out");
    });

    it("uses custom timeout from options", async () => {
      server = createTestServer(() => {});

      const start = Date.now();
      await expect(
        mapCall(`http://localhost:${server.port}`, "test", undefined, { timeoutMs: 50 })
      ).rejects.toThrow(MapCallError);
      const elapsed = Date.now() - start;

      // Should have timed out quickly (within ~200ms allowing for jitter)
      expect(elapsed).toBeLessThan(500);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Handshake failure
  // ─────────────────────────────────────────────────────────────────

  describe("handshake failure", () => {
    it("rejects with MapCallError if handshake returns error response", async () => {
      server = createTestServer((ws, msg) => {
        if (msg.method === "map/connect") {
          ws.send(
            JSON.stringify({
              jsonrpc: "2.0",
              id: msg.id,
              error: { code: -32600, message: "Invalid request" },
            })
          );
        }
      });

      try {
        await mapCall(`http://localhost:${server.port}`, "test");
        expect.fail("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(MapCallError);
        expect((err as MapCallError).code).toBe(-32600);
        expect((err as MapCallError).message).toContain("MAP handshake failed");
        expect((err as MapCallError).message).toContain("Invalid request");
      }
    });

    it("includes error data from handshake failure", async () => {
      server = createTestServer((ws, msg) => {
        if (msg.method === "map/connect") {
          ws.send(
            JSON.stringify({
              jsonrpc: "2.0",
              id: msg.id,
              error: { code: -32600, message: "Bad", data: { reason: "auth_required" } },
            })
          );
        }
      });

      try {
        await mapCall(`http://localhost:${server.port}`, "test");
        expect.fail("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(MapCallError);
        expect((err as MapCallError).data).toEqual({ reason: "auth_required" });
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // RPC error response
  // ─────────────────────────────────────────────────────────────────

  describe("RPC error response", () => {
    it("rejects with MapCallError on RPC error", async () => {
      server = createTestServer((ws, msg) => {
        if (msg.method === "map/connect") {
          ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }));
        } else {
          ws.send(
            JSON.stringify({
              jsonrpc: "2.0",
              id: msg.id,
              error: { code: -32601, message: "Method not found" },
            })
          );
        }
      });

      try {
        await mapCall(`http://localhost:${server.port}`, "_macro/mcp/nonexistent");
        expect.fail("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(MapCallError);
        expect((err as MapCallError).code).toBe(-32601);
        expect((err as MapCallError).message).toBe("Method not found");
      }
    });

    it("includes error data from RPC failure", async () => {
      server = createTestServer((ws, msg) => {
        if (msg.method === "map/connect") {
          ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }));
        } else {
          ws.send(
            JSON.stringify({
              jsonrpc: "2.0",
              id: msg.id,
              error: { code: -32602, message: "Bad params", data: { field: "agent_id" } },
            })
          );
        }
      });

      try {
        await mapCall(`http://localhost:${server.port}`, "test");
        expect.fail("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(MapCallError);
        expect((err as MapCallError).data).toEqual({ field: "agent_id" });
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Connection failures
  // ─────────────────────────────────────────────────────────────────

  describe("connection failures", () => {
    it("rejects when connection is refused", async () => {
      // Use a port with no server
      const unusedPort = getRandomPort();

      await expect(
        mapCall(`http://localhost:${unusedPort}`, "test", undefined, { timeoutMs: 2000 })
      ).rejects.toThrow(MapCallError);
    });

    it("rejects when server closes socket before responding", async () => {
      server = createTestServer((ws, msg) => {
        if (msg.method === "map/connect") {
          ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }));
        } else {
          // Close instead of responding
          ws.close();
        }
      });

      try {
        await mapCall(`http://localhost:${server.port}`, "test");
        expect.fail("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(MapCallError);
        expect((err as MapCallError).message).toContain("closed unexpectedly");
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // MapCallError class
  // ─────────────────────────────────────────────────────────────────

  describe("MapCallError", () => {
    it("extends Error", () => {
      const err = new MapCallError(-32000, "test error");
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(MapCallError);
    });

    it("has correct properties", () => {
      const err = new MapCallError(-32601, "Method not found", { detail: "extra" });
      expect(err.name).toBe("MapCallError");
      expect(err.code).toBe(-32601);
      expect(err.message).toBe("Method not found");
      expect(err.data).toEqual({ detail: "extra" });
    });

    it("has undefined data when not provided", () => {
      const err = new MapCallError(-32000, "test");
      expect(err.data).toBeUndefined();
    });
  });
});
