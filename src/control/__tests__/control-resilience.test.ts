/**
 * Tests for Control Socket crash recovery and health checks.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import { ControlServer } from "../control-server.js";
import { ControlClient } from "../control-client.js";
import type { AgentManager } from "../../agent/agent-manager.js";

// =============================================================================
// Mocks
// =============================================================================

function createMockAgentManager(): AgentManager {
  return {
    spawn: vi.fn().mockResolvedValue({
      id: "agent_child",
      session_id: "session_child",
      agent: {
        id: "agent_child",
        name: "fluffy-penguin",
        task_id: "task_child",
        role: "worker",
        state: "running",
      },
    }),
    terminate: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockReturnValue(null),
    list: vi.fn().mockReturnValue([]),
    getChildren: vi.fn().mockReturnValue([]),
    getHierarchy: vi.fn().mockReturnValue(null),
  } as unknown as AgentManager;
}

// =============================================================================
// Helpers
// =============================================================================

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// =============================================================================
// Tests
// =============================================================================

describe("Control Socket Resilience", () => {
  let server: ControlServer;
  let client: ControlClient;
  let agentManager: AgentManager;
  let testDir: string;
  let socketPath: string;

  beforeEach(() => {
    testDir = path.join(
      os.tmpdir(),
      `control-resilience-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    fs.mkdirSync(testDir, { recursive: true });
    socketPath = path.join(testDir, "control.sock");
    agentManager = createMockAgentManager();
  });

  afterEach(async () => {
    try { client?.disconnect(); } catch { /* ignore */ }
    try { await server?.stop(); } catch { /* ignore */ }
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  // ── Auto-Reconnect ───────────────────────────────────────────

  describe("auto-reconnect", () => {
    it("should auto-reconnect on server restart", async () => {
      server = new ControlServer(agentManager, { socketPath });
      await server.start();

      const reconnected = new Promise<void>((resolve) => {
        client = new ControlClient(socketPath, {
          reconnect: true,
          maxRetries: 10,
          onReconnected: () => resolve(),
        });
      });

      await client.connect();
      expect(client.connected).toBe(true);

      // Stop server — client should detect close
      await server.stop();

      // Wait a bit for close event to propagate
      await delay(50);
      expect(client.connected).toBe(false);
      expect(client.reconnecting).toBe(true);

      // Restart server
      server = new ControlServer(agentManager, { socketPath });
      await server.start();

      // Wait for reconnect
      await reconnected;
      expect(client.connected).toBe(true);
      expect(client.reconnecting).toBe(false);

      // Verify ping works after reconnect
      const result = await client.ping();
      expect(result).toBe(true);
    });

    it("should give up after max retries", async () => {
      server = new ControlServer(agentManager, { socketPath });
      await server.start();

      client = new ControlClient(socketPath, {
        reconnect: true,
        maxRetries: 3, // Low max for fast test
      });
      await client.connect();
      expect(client.connected).toBe(true);

      // Stop server and don't restart
      await server.stop();

      // Wait for close event + all retries (100 + 200 + 400 = 700ms, add buffer)
      await delay(1500);

      expect(client.connected).toBe(false);
      expect(client.reconnecting).toBe(false);
    });

    it("should handle new requests after reconnect", async () => {
      server = new ControlServer(agentManager, { socketPath });
      await server.start();

      const reconnected = new Promise<void>((resolve) => {
        client = new ControlClient(socketPath, {
          reconnect: true,
          maxRetries: 10,
          onReconnected: () => resolve(),
        });
      });

      await client.connect();

      // Stop server
      await server.stop();
      await delay(50);

      // Restart server
      server = new ControlServer(agentManager, { socketPath });
      await server.start();

      // Wait for reconnect
      await reconnected;

      // spawn() should work through the reconnected client
      const result = await client.spawn({ task: "post-reconnect task", role: "worker" });
      expect(result.agent_id).toBe("agent_child");
      expect(agentManager.spawn).toHaveBeenCalledWith(
        expect.objectContaining({ task: "post-reconnect task" })
      );
    });

    it("should not reconnect when reconnect is disabled", async () => {
      server = new ControlServer(agentManager, { socketPath });
      await server.start();

      client = new ControlClient(socketPath, { reconnect: false });
      await client.connect();
      expect(client.connected).toBe(true);

      await server.stop();
      await delay(100);

      expect(client.connected).toBe(false);
      expect(client.reconnecting).toBe(false);
    });
  });

  // ── Health Checks ─────────────────────────────────────────────

  describe("health checks", () => {
    it("should record health check and track lastSeen", async () => {
      server = new ControlServer(agentManager, { socketPath });
      await server.start();

      client = new ControlClient(socketPath, { reconnect: false });
      await client.connect();

      const before = Date.now();
      const result = await client.healthCheck("agent_1", 12345);
      const after = Date.now();

      expect(result).toBe(true);

      const status = server.getHealthStatus("agent_1");
      expect(status).toBeDefined();
      expect(status!.pid).toBe(12345);
      expect(status!.lastSeen).toBeGreaterThanOrEqual(before);
      expect(status!.lastSeen).toBeLessThanOrEqual(after);
      expect(status!.healthy).toBe(true);
    });

    it("should return null for unknown agent health status", async () => {
      server = new ControlServer(agentManager, { socketPath });
      await server.start();

      const status = server.getHealthStatus("nonexistent");
      expect(status).toBeNull();
    });

    it("should detect unhealthy agents with stale heartbeats", async () => {
      server = new ControlServer(agentManager, { socketPath });
      await server.start();

      client = new ControlClient(socketPath, { reconnect: false });
      await client.connect();

      // Send heartbeat
      await client.healthCheck("agent_stale", 99999);

      // Wait for heartbeat to become stale
      await delay(100);

      // With a very short timeout, agent should be unhealthy
      const unhealthy = server.getUnhealthyAgents(50);
      expect(unhealthy).toHaveLength(1);
      expect(unhealthy[0].agentId).toBe("agent_stale");
      expect(unhealthy[0].pid).toBe(99999);
    });

    it("should not report recently heartbeated agents as unhealthy", async () => {
      server = new ControlServer(agentManager, { socketPath });
      await server.start();

      client = new ControlClient(socketPath, { reconnect: false });
      await client.connect();

      await client.healthCheck("agent_fresh", 11111);

      // With a generous timeout, agent should be healthy
      const unhealthy = server.getUnhealthyAgents(60_000);
      expect(unhealthy).toHaveLength(0);
    });
  });
});
