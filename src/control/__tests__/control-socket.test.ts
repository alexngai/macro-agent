/**
 * Tests for Control Socket (server + client)
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
    get: vi.fn().mockImplementation((id: string) => {
      if (id === "agent_1") {
        return {
          id: "agent_1",
          name: "test-agent",
          role: "coordinator",
          state: "running",
          parent: null,
          task: "test task",
          cwd: "/tmp",
          created_at: Date.now(),
        };
      }
      return null;
    }),
    list: vi.fn().mockReturnValue([
      { id: "agent_1", state: "running", role: "coordinator" },
      { id: "agent_2", state: "stopped", role: "worker" },
    ]),
    getChildren: vi.fn().mockReturnValue([
      { id: "agent_2", state: "running", role: "worker", parent: "agent_1" },
    ]),
    getHierarchy: vi.fn().mockReturnValue({
      root: {
        agent: { id: "agent_1", state: "running" },
        children: [
          { agent: { id: "agent_2", state: "running" }, children: [] },
        ],
      },
      depth: 1,
      totalAgents: 2,
    }),
  } as unknown as AgentManager;
}

// =============================================================================
// Tests
// =============================================================================

describe("Control Socket", () => {
  let server: ControlServer;
  let client: ControlClient;
  let agentManager: AgentManager;
  let testDir: string;
  let socketPath: string;

  beforeEach(async () => {
    testDir = path.join(
      os.tmpdir(),
      `control-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    fs.mkdirSync(testDir, { recursive: true });
    socketPath = path.join(testDir, "control.sock");

    agentManager = createMockAgentManager();
    server = new ControlServer(agentManager, { socketPath });
    await server.start();

    client = new ControlClient(socketPath);
    await client.connect();
  });

  afterEach(async () => {
    client.disconnect();
    await server.stop();
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  // ── Connectivity ───────────────────────────────────────────

  describe("connectivity", () => {
    it("should connect and ping", async () => {
      const result = await client.ping();
      expect(result).toBe(true);
    });

    it("should handle multiple sequential requests", async () => {
      const r1 = await client.ping();
      const r2 = await client.ping();
      const r3 = await client.ping();
      expect(r1).toBe(true);
      expect(r2).toBe(true);
      expect(r3).toBe(true);
    });
  });

  // ── Spawn ──────────────────────────────────────────────────

  describe("spawn", () => {
    it("should spawn an agent via control socket", async () => {
      const result = await client.spawn({
        task: "Test task",
        role: "worker",
        parent: "agent_1",
      });

      expect(result.agent_id).toBe("agent_child");
      expect(result.name).toBe("fluffy-penguin");
      expect(result.role).toBe("worker");

      expect(agentManager.spawn).toHaveBeenCalledWith(
        expect.objectContaining({
          task: "Test task",
          role: "worker",
          parent: "agent_1",
        })
      );
    });

    it("should propagate spawn errors", async () => {
      vi.mocked(agentManager.spawn).mockRejectedValueOnce(
        new Error("Capability denied")
      );

      await expect(
        client.spawn({ task: "Bad spawn", role: "coordinator" })
      ).rejects.toThrow("Capability denied");
    });
  });

  // ── Terminate ──────────────────────────────────────────────

  describe("terminate", () => {
    it("should terminate an agent via control socket", async () => {
      await client.terminate("agent_2", "completed");

      expect(agentManager.terminate).toHaveBeenCalledWith(
        "agent_2",
        "completed"
      );
    });

    it("should propagate terminate errors", async () => {
      vi.mocked(agentManager.terminate).mockRejectedValueOnce(
        new Error("Agent not found")
      );

      await expect(
        client.terminate("nonexistent", "cancelled")
      ).rejects.toThrow("Agent not found");
    });
  });

  // ── Queries ────────────────────────────────────────────────

  describe("queries", () => {
    it("should get agent by ID", async () => {
      const agent = await client.getAgent("agent_1");
      expect(agent).toBeDefined();
      expect((agent as any).id).toBe("agent_1");
      expect((agent as any).role).toBe("coordinator");
    });

    it("should return error for non-existent agent", async () => {
      await expect(client.getAgent("nonexistent")).rejects.toThrow(
        "Agent not found"
      );
    });

    it("should list agents", async () => {
      const agents = await client.listAgents();
      expect(agents).toHaveLength(2);
    });

    it("should get children", async () => {
      const children = await client.getChildren("agent_1");
      expect(children).toHaveLength(1);
      expect((children[0] as any).id).toBe("agent_2");
    });

    it("should get hierarchy", async () => {
      const hierarchy = await client.getHierarchy("agent_1");
      expect(hierarchy).toBeDefined();
      expect((hierarchy as any).totalAgents).toBe(2);
    });
  });

  // ── Error Handling ─────────────────────────────────────────

  describe("error handling", () => {
    it("should detect disconnected client after server stop", async () => {
      // Disconnect client first to avoid blocking server.close()
      client.disconnect();
      await server.stop();

      expect(client.connected).toBe(false);

      // Reconnecting should fail
      const newClient = new ControlClient(socketPath);
      let connectFailed = false;
      try {
        await newClient.connect();
      } catch {
        connectFailed = true;
      }
      expect(connectFailed).toBe(true);
    });

    it("should handle disconnected client", async () => {
      client.disconnect();
      expect(client.connected).toBe(false);

      await expect(
        client.spawn({ task: "test" })
      ).rejects.toThrow("not connected");
    });
  });
});
