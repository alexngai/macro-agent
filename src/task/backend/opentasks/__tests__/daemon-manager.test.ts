/**
 * Tests for DaemonManager
 *
 * Covers:
 * - connectProject() IPC location.register flow
 * - connectProject() edge cases (missing dir, missing config, no hash, already connected)
 * - getConnectedProjects() tracking
 * - shutdown() cleanup
 *
 * Uses mocked filesystem and IPC client — no real daemon needed.
 *
 * @module task/backend/opentasks/__tests__/daemon-manager.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { DaemonManager } from "../daemon-manager.js";
import { IPCOpenTasksClient } from "../client.js";

// Mock opentasks to avoid real daemon operations
vi.mock("opentasks", () => ({
  checkExistingDaemon: vi.fn(),
  createDaemonWithStore: vi.fn(),
}));

// Mock fs for connectProject tests
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof fs>("node:fs");
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

// =============================================================================
// Tests
// =============================================================================

describe("DaemonManager", () => {
  let manager: DaemonManager;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    if (manager) {
      await manager.shutdown();
    }
  });

  // ─────────────────────────────────────────────────────────────────
  // connectProject()
  // ─────────────────────────────────────────────────────────────────

  describe("connectProject()", () => {
    let mockClient: IPCOpenTasksClient;

    beforeEach(() => {
      manager = new DaemonManager({ connectOnSpawn: true });

      // Create a mock IPCOpenTasksClient with a call method
      mockClient = {
        call: vi.fn().mockResolvedValue({ success: true }),
        isConnected: vi.fn().mockReturnValue(true),
        connect: vi.fn().mockResolvedValue(undefined),
        disconnect: vi.fn(),
      } as unknown as IPCOpenTasksClient;

      // Inject the mock client via private field access
      (manager as any).client = mockClient;
    });

    it("should register project location with daemon via IPC", async () => {
      const projectPath = "/projects/my-app";
      const opentasksDir = path.join(projectPath, ".opentasks");

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          location: { hash: "abc123", uuid: "uuid-1", name: "my-app" },
        })
      );

      await manager.connectProject(projectPath);

      expect(mockClient.call).toHaveBeenCalledWith("location.register", {
        hash: "abc123",
        opentasksPath: opentasksDir,
      });
      expect(manager.getConnectedProjects()).toContain(opentasksDir);
    });

    it("should skip if connectOnSpawn is false", async () => {
      manager = new DaemonManager({ connectOnSpawn: false });
      (manager as any).client = mockClient;

      await manager.connectProject("/projects/my-app");

      expect(mockClient.call).not.toHaveBeenCalled();
      expect(manager.getConnectedProjects()).toHaveLength(0);
    });

    it("should skip if client is not set", async () => {
      (manager as any).client = null;

      await manager.connectProject("/projects/my-app");

      expect(manager.getConnectedProjects()).toHaveLength(0);
    });

    it("should skip if .opentasks/ directory does not exist", async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      await manager.connectProject("/projects/my-app");

      expect(mockClient.call).not.toHaveBeenCalled();
      expect(manager.getConnectedProjects()).toHaveLength(0);
    });

    it("should skip if config.json has no location hash", async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ location: { uuid: "uuid-1" } }) // no hash
      );

      await manager.connectProject("/projects/my-app");

      expect(mockClient.call).not.toHaveBeenCalled();
      expect(manager.getConnectedProjects()).toHaveLength(0);
    });

    it("should skip if project is already connected", async () => {
      const projectPath = "/projects/my-app";
      const opentasksDir = path.join(projectPath, ".opentasks");

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          location: { hash: "abc123", uuid: "uuid-1", name: "my-app" },
        })
      );

      // Connect once
      await manager.connectProject(projectPath);
      expect(mockClient.call).toHaveBeenCalledTimes(1);

      // Try to connect again — should be idempotent
      await manager.connectProject(projectPath);
      expect(mockClient.call).toHaveBeenCalledTimes(1);
    });

    it("should handle IPC errors gracefully (non-fatal)", async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          location: { hash: "abc123", uuid: "uuid-1", name: "my-app" },
        })
      );
      (mockClient as any).call.mockRejectedValue(new Error("IPC failed"));

      // Should not throw
      await manager.connectProject("/projects/my-app");

      // Should not be tracked as connected since the IPC call failed
      expect(manager.getConnectedProjects()).toHaveLength(0);
    });

    it("should handle malformed config.json gracefully", async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue("not valid json");

      // Should not throw
      await manager.connectProject("/projects/my-app");

      expect(mockClient.call).not.toHaveBeenCalled();
      expect(manager.getConnectedProjects()).toHaveLength(0);
    });

    it("should not call IPC if client is not an IPCOpenTasksClient", async () => {
      // Replace with a plain mock that isn't an instance of IPCOpenTasksClient
      const plainClient = {
        isConnected: vi.fn().mockReturnValue(true),
        connect: vi.fn().mockResolvedValue(undefined),
        disconnect: vi.fn(),
      } as any;
      (manager as any).client = plainClient;

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          location: { hash: "abc123", uuid: "uuid-1", name: "my-app" },
        })
      );

      await manager.connectProject("/projects/my-app");

      // Should still track as connected (IPC call is skipped, not failed)
      expect(manager.getConnectedProjects()).toContain(
        path.join("/projects/my-app", ".opentasks")
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // isProjectConnected()
  // ─────────────────────────────────────────────────────────────────

  describe("isProjectConnected()", () => {
    it("should return false for unconnected project", () => {
      manager = new DaemonManager();
      expect(manager.isProjectConnected("/projects/my-app")).toBe(false);
    });

    it("should return true after connecting", async () => {
      manager = new DaemonManager({ connectOnSpawn: true });
      const mockClient = {
        call: vi.fn().mockResolvedValue({ success: true }),
        isConnected: vi.fn().mockReturnValue(true),
        connect: vi.fn(),
        disconnect: vi.fn(),
      } as unknown as IPCOpenTasksClient;
      (manager as any).client = mockClient;

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          location: { hash: "abc123", uuid: "uuid-1", name: "my-app" },
        })
      );

      await manager.connectProject("/projects/my-app");
      expect(manager.isProjectConnected("/projects/my-app")).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // shutdown()
  // ─────────────────────────────────────────────────────────────────

  describe("shutdown()", () => {
    it("should clear connected projects on shutdown", async () => {
      manager = new DaemonManager({ connectOnSpawn: true });
      const mockClient = {
        call: vi.fn().mockResolvedValue({ success: true }),
        isConnected: vi.fn().mockReturnValue(true),
        connect: vi.fn(),
        disconnect: vi.fn(),
      } as unknown as IPCOpenTasksClient;
      (manager as any).client = mockClient;

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          location: { hash: "abc123", uuid: "uuid-1", name: "my-app" },
        })
      );

      await manager.connectProject("/projects/my-app");
      expect(manager.getConnectedProjects()).toHaveLength(1);

      await manager.shutdown();
      expect(manager.getConnectedProjects()).toHaveLength(0);
    });

    it("should disconnect client on shutdown", async () => {
      manager = new DaemonManager();
      const mockClient = {
        disconnect: vi.fn(),
        isConnected: vi.fn().mockReturnValue(true),
      } as any;
      (manager as any).client = mockClient;

      await manager.shutdown();

      expect(mockClient.disconnect).toHaveBeenCalled();
    });

    it("should stop daemon only if ownsDaemon is true", async () => {
      manager = new DaemonManager();
      const mockDaemon = { stop: vi.fn().mockResolvedValue(undefined) };
      const mockClient = { disconnect: vi.fn() } as any;

      (manager as any).client = mockClient;
      (manager as any).daemon = mockDaemon;
      (manager as any).ownsDaemon = true;

      await manager.shutdown();

      expect(mockDaemon.stop).toHaveBeenCalled();
    });

    it("should NOT stop daemon if ownsDaemon is false", async () => {
      manager = new DaemonManager();
      const mockDaemon = { stop: vi.fn().mockResolvedValue(undefined) };
      const mockClient = { disconnect: vi.fn() } as any;

      (manager as any).client = mockClient;
      (manager as any).daemon = mockDaemon;
      (manager as any).ownsDaemon = false;

      await manager.shutdown();

      expect(mockDaemon.stop).not.toHaveBeenCalled();
    });

    it("should delay daemon.stop() by drain grace period when ownsDaemon", async () => {
      manager = new DaemonManager();
      const stopTimes: number[] = [];
      const mockDaemon = {
        stop: vi.fn().mockImplementation(async () => {
          stopTimes.push(Date.now());
        }),
      };
      const mockClient = { disconnect: vi.fn() } as any;

      (manager as any).client = mockClient;
      (manager as any).daemon = mockDaemon;
      (manager as any).ownsDaemon = true;

      const startTime = Date.now();
      await manager.shutdown();

      expect(mockDaemon.stop).toHaveBeenCalled();
      // Drain delay should be at least ~450ms (500ms target with timing tolerance)
      const elapsed = stopTimes[0] - startTime;
      expect(elapsed).toBeGreaterThanOrEqual(450);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // ensureDaemon()
  // ─────────────────────────────────────────────────────────────────

  describe("ensureDaemon()", () => {
    it("should return socketPath when connecting to existing daemon", async () => {
      const { checkExistingDaemon } = await import("opentasks");

      vi.mocked(checkExistingDaemon).mockResolvedValue({
        running: true,
        socketPath: "/tmp/existing.sock",
        pid: 1234,
      });

      // Mock IPCOpenTasksClient constructor and connect
      const connectSpy = vi.fn().mockResolvedValue(undefined);
      vi.spyOn(
        await import("../client.js"),
        "IPCOpenTasksClient"
      ).mockImplementation(
        () =>
          ({
            connect: connectSpy,
            disconnect: vi.fn(),
            isConnected: vi.fn().mockReturnValue(true),
          }) as any
      );

      manager = new DaemonManager({ centralPath: "/tmp/central" });
      const result = await manager.ensureDaemon();

      expect(result.socketPath).toBe("/tmp/existing.sock");
      expect(result.ownsDaemon).toBe(false);
      expect(connectSpy).toHaveBeenCalled();
    });

    it("should return socketPath when starting new daemon", async () => {
      const { checkExistingDaemon, createDaemonWithStore } =
        await import("opentasks");

      vi.mocked(checkExistingDaemon).mockResolvedValue({
        running: false,
      });

      const mockDaemon = {
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
        socketPath: "/tmp/new-daemon.sock",
      };
      vi.mocked(createDaemonWithStore).mockResolvedValue(mockDaemon as any);

      const connectSpy = vi.fn().mockResolvedValue(undefined);
      vi.spyOn(
        await import("../client.js"),
        "IPCOpenTasksClient"
      ).mockImplementation(
        () =>
          ({
            connect: connectSpy,
            disconnect: vi.fn(),
            isConnected: vi.fn().mockReturnValue(true),
          }) as any
      );

      manager = new DaemonManager({ centralPath: "/tmp/central" });
      const result = await manager.ensureDaemon();

      expect(result.socketPath).toBe("/tmp/new-daemon.sock");
      expect(result.ownsDaemon).toBe(true);
      expect(mockDaemon.start).toHaveBeenCalled();
    });
  });
});
