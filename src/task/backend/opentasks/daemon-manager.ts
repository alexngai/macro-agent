/**
 * OpenTasks Daemon Manager
 *
 * Manages the lifecycle of the central opentasks daemon as part of the
 * task backend lifecycle. The daemon is auto-started by createTaskBackend()
 * and stopped via TaskBackendResult.shutdown().
 *
 * Architecture:
 * - Central daemon lives at ~/.multiagent/opentasks/
 * - If a daemon is already running, we connect to it (ownsDaemon=false)
 * - If not, we start one and own its lifecycle (ownsDaemon=true)
 * - On shutdown, we only stop the daemon if we started it
 *
 * @module task/backend/opentasks/daemon-manager
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { checkExistingDaemon, createDaemonWithStore } from "opentasks";
import { IPCOpenTasksClient } from "./client.js";
import type { OpenTasksClient } from "./client.js";

// =============================================================================
// Types
// =============================================================================

/**
 * Configuration for the DaemonManager.
 */
export interface DaemonManagerConfig {
  /** Central daemon location (default: ~/.multiagent/opentasks) */
  centralPath?: string;

  /** Whether to auto-connect project .opentasks/ on connectProject() */
  connectOnSpawn?: boolean;
}

/**
 * Result from ensureDaemon() — the running daemon's connection info.
 */
export interface DaemonManagerResult {
  /** Connected OpenTasks client */
  client: OpenTasksClient;

  /** Daemon socket path */
  socketPath: string;

  /** Whether we started the daemon (vs connecting to existing) */
  ownsDaemon: boolean;
}

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_CENTRAL_PATH = path.join(
  process.env.MACRO_AGENT_HOME || path.join(os.homedir(), ".multiagent"),
  "opentasks",
);

/** Grace period (ms) between client disconnect and daemon.stop() to let children finish disconnecting */
const DAEMON_DRAIN_MS = 500;

// =============================================================================
// DaemonManager Implementation
// =============================================================================

/**
 * Manages the central opentasks daemon lifecycle.
 *
 * Internal to the opentasks backend module — not exposed as a standalone service.
 */
export class DaemonManager {
  private readonly centralPath: string;
  private readonly connectOnSpawn: boolean;
  private daemon: any = null;
  private client: OpenTasksClient | null = null;
  private ownsDaemon = false;
  private connectedProjects = new Set<string>();

  constructor(config?: DaemonManagerConfig) {
    this.centralPath = config?.centralPath ?? DEFAULT_CENTRAL_PATH;
    this.connectOnSpawn = config?.connectOnSpawn ?? true;
  }

  /**
   * Ensure the central daemon is running and return a connected client.
   *
   * 1. Check if a daemon is already running at the central path
   * 2. If running, connect to it (ownsDaemon=false)
   * 3. If not running, start one (ownsDaemon=true)
   * 4. Return connected client + socket path
   */
  async ensureDaemon(): Promise<DaemonManagerResult> {
    // Ensure the central directory exists
    fs.mkdirSync(this.centralPath, { recursive: true });

    // Check if a daemon is already running at this location
    const existing = await checkExistingDaemon(this.centralPath);

    if (existing.running && existing.socketPath) {
      // Connect to the existing daemon
      console.error(`[opentasks] Connecting to existing daemon at ${existing.socketPath} (pid: ${existing.pid})`);

      const client = new IPCOpenTasksClient({
        socketPath: existing.socketPath,
      });
      await client.connect();

      this.client = client;
      this.ownsDaemon = false;

      return {
        client,
        socketPath: existing.socketPath,
        ownsDaemon: false,
      };
    }

    // No daemon running — start one
    console.error(`[opentasks] Starting daemon at ${this.centralPath}`);

    const daemon = await createDaemonWithStore({
      locationPath: this.centralPath,
      version: "0.0.3",
    });
    await daemon.start();

    this.daemon = daemon;
    this.ownsDaemon = true;

    const socketPath = daemon.socketPath as string;
    console.error(`[opentasks] Daemon started (socket: ${socketPath})`);

    // Connect client to the daemon
    const client = new IPCOpenTasksClient({ socketPath });
    await client.connect();

    this.client = client;

    return {
      client,
      socketPath,
      ownsDaemon: true,
    };
  }

  /**
   * Connect a project's .opentasks/ directory to the central daemon.
   *
   * This is a fire-and-forget operation — connection failures are logged
   * but do not affect the caller.
   *
   * @param projectPath - Path to the project root (will look for .opentasks/ subdirectory)
   */
  async connectProject(projectPath: string): Promise<void> {
    if (!this.connectOnSpawn) return;
    if (!this.client) return;

    const opentasksDir = path.join(projectPath, ".opentasks");

    // Check if project has .opentasks/
    if (!fs.existsSync(opentasksDir)) return;

    // Check if already connected
    if (this.connectedProjects.has(opentasksDir)) return;

    try {
      // Read the project's config.json to get its location hash
      const configPath = path.join(opentasksDir, "config.json");
      const configContent = fs.readFileSync(configPath, "utf-8");
      const config = JSON.parse(configContent);
      const hash = config?.location?.hash;

      if (!hash) {
        console.error(`[opentasks] No location hash in ${configPath}, skipping`);
        return;
      }

      // Register the location with the daemon via IPC
      const client = this.client as any;
      if (typeof client.call === "function") {
        await client.call("location.register", {
          hash,
          opentasksPath: opentasksDir,
        });
      }

      this.connectedProjects.add(opentasksDir);
      console.error(`[opentasks] Connected to project: ${opentasksDir}`);
    } catch (error) {
      // Non-fatal — log and continue
      console.error(`[opentasks] Failed to connect project ${opentasksDir}: ${error}`);
    }
  }

  /**
   * Check if a project is already connected to the central daemon.
   */
  isProjectConnected(projectPath: string): boolean {
    const opentasksDir = path.join(projectPath, ".opentasks");
    return this.connectedProjects.has(opentasksDir);
  }

  /**
   * Get list of connected project .opentasks/ paths.
   */
  getConnectedProjects(): string[] {
    return Array.from(this.connectedProjects);
  }

  /**
   * Shut down the daemon manager.
   *
   * - Disconnects the client
   * - Stops the daemon if we started it (ownsDaemon=true)
   * - Leaves the daemon running if someone else started it
   */
  async shutdown(): Promise<void> {
    // Disconnect client
    if (this.client) {
      try {
        this.client.disconnect();
      } catch {
        // Ignore disconnect errors
      }
      this.client = null;
    }

    // Stop daemon only if we own it
    if (this.ownsDaemon && this.daemon) {
      try {
        // Grace period to let child agents finish disconnecting from the daemon
        await new Promise<void>(resolve => setTimeout(resolve, DAEMON_DRAIN_MS));
        console.error("[opentasks] Stopping daemon");
        await this.daemon.stop();
      } catch (error) {
        console.error(`[opentasks] Error stopping daemon: ${error}`);
      }
      this.daemon = null;
      this.ownsDaemon = false;
    }

    this.connectedProjects.clear();
  }
}

/**
 * Create a DaemonManager instance.
 */
export function createDaemonManager(
  config?: DaemonManagerConfig
): DaemonManager {
  return new DaemonManager(config);
}
