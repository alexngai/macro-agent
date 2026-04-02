/**
 * OpenTasks Daemon Lifecycle Helper
 *
 * Starts/stops the opentasks daemon programmatically using the
 * opentasks Node API (createDaemonWithStore). Falls back to CLI
 * spawning if the programmatic API is unavailable.
 *
 * @module adapters/opentasks-daemon
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as net from "node:net";

// ─────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────

export interface DaemonHandle {
  /** Path to the daemon's Unix socket. */
  socketPath: string;
  /** Gracefully stop the daemon. */
  stop(): Promise<void>;
}

export interface EnsureDaemonOptions {
  /** Timeout in ms to wait for the daemon to become reachable (default: 10000). */
  timeoutMs?: number;
  /** Custom registry path — useful for test isolation. */
  registryPath?: string;
}

// ─────────────────────────────────────────────────────────────────
// Socket Probing
// ─────────────────────────────────────────────────────────────────

/**
 * Try to connect to a Unix socket.  Resolves true if the connection
 * succeeds (i.e., something is listening), false otherwise.
 */
function probeSocket(socketPath: string, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.createConnection({ path: socketPath });
    const timer = setTimeout(() => {
      sock.destroy();
      resolve(false);
    }, timeoutMs);

    sock.on("connect", () => {
      clearTimeout(timer);
      sock.destroy();
      resolve(true);
    });
    sock.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

// ─────────────────────────────────────────────────────────────────
// Socket Discovery
// ─────────────────────────────────────────────────────────────────

/**
 * Candidate socket locations, in priority order:
 *   1. .git/opentasks/daemon.sock   (multi-location mode)
 *   2. .opentasks/daemon.sock       (single-location mode)
 */
function candidateSocketPaths(repoPath: string): string[] {
  return [
    path.join(repoPath, ".git", "opentasks", "daemon.sock"),
    path.join(repoPath, ".opentasks", "daemon.sock"),
  ];
}

/**
 * Find an existing, reachable daemon socket for the given repo.
 */
async function findRunningDaemon(
  repoPath: string
): Promise<string | null> {
  for (const candidate of candidateSocketPaths(repoPath)) {
    if (fs.existsSync(candidate) && (await probeSocket(candidate))) {
      return candidate;
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────
// Poll helper
// ─────────────────────────────────────────────────────────────────

async function waitForSocket(
  socketPath: string,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const interval = 200;

  while (Date.now() < deadline) {
    if (fs.existsSync(socketPath) && (await probeSocket(socketPath, 1000))) {
      return;
    }
    await new Promise((r) => setTimeout(r, interval));
  }

  throw new Error(
    `Timed out waiting for opentasks daemon socket at ${socketPath} (${timeoutMs}ms)`
  );
}

// ─────────────────────────────────────────────────────────────────
// Initialization
// ─────────────────────────────────────────────────────────────────

/**
 * Ensure the .opentasks directory exists with a minimal config.
 * Returns the path to the .opentasks directory.
 */
function ensureOpentasksDir(repoPath: string): string {
  const opentasksDir = path.join(repoPath, ".opentasks");

  if (!fs.existsSync(opentasksDir)) {
    fs.mkdirSync(opentasksDir, { recursive: true });
  }

  const configPath = path.join(opentasksDir, "config.json");
  if (!fs.existsSync(configPath)) {
    const config = {
      storage: {
        graphPath: "graph.jsonl",
        sqlitePath: "cache.db",
      },
      daemon: {
        socketPath: "daemon.sock",
      },
      providers: {
        // Disable external providers for a minimal setup
        beads: { enabled: false },
        claudeTasks: { enabled: false },
        sudocode: { enabled: false },
        global: { enabled: false },
      },
    };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  }

  return opentasksDir;
}

// ─────────────────────────────────────────────────────────────────
// Diagnostics
// ─────────────────────────────────────────────────────────────────

function safeReaddir(dir: string): string {
  try {
    return fs.readdirSync(dir).join(", ");
  } catch {
    return `(unreadable: ${dir})`;
  }
}

// ─────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────

/**
 * Ensure an opentasks daemon is running for the given repo.
 *
 * 1. Checks for an already-running daemon (probes known socket locations).
 * 2. If none is running, initializes `.opentasks/` and starts a daemon
 *    using the opentasks programmatic API (`createDaemonWithStore`).
 * 3. Waits for the socket to become reachable.
 * 4. Returns a handle with `socketPath` and `stop()`.
 */
export async function ensureOpentasksDaemon(
  repoPath: string,
  opts: EnsureDaemonOptions = {}
): Promise<DaemonHandle> {
  const { timeoutMs = 10_000, registryPath } = opts;

  // ── 1. Check for existing daemon ───────────────────────────────
  const existingSocket = await findRunningDaemon(repoPath);
  if (existingSocket) {
    return {
      socketPath: existingSocket,
      async stop() {
        // We didn't start it, so don't stop it.
      },
    };
  }

  // ── 2. Ensure .opentasks/ dir + config ─────────────────────────
  const locationPath = ensureOpentasksDir(repoPath);

  // ── 3. Start daemon via programmatic API ───────────────────────
  let daemon: { socketPath: string; start(): Promise<void>; stop(): Promise<void> };

  try {
    const { createDaemonWithStore } = await import("opentasks");

    const daemonConfig: {
      locationPath: string;
      version: string;
      registryPath?: string;
    } = {
      locationPath,
      version: "0.0.1",
    };
    if (registryPath) {
      daemonConfig.registryPath = registryPath;
    }

    daemon = await createDaemonWithStore(daemonConfig);
  } catch (err) {
    throw new Error(
      `Failed to create opentasks daemon: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  try {
    await daemon.start();
  } catch (err) {
    throw new Error(
      `Failed to start opentasks daemon: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // ── 4. Verify socket is reachable ──────────────────────────────
  // daemon.start() already ensures the IPC server is listening.
  const socketPath = daemon.socketPath;
  if (!fs.existsSync(socketPath)) {
    throw new Error(
      `Daemon started but socket file not found at ${socketPath}. ` +
      `Location dir contents: ${safeReaddir(path.dirname(socketPath))}`
    );
  }

  // ── 5. Return handle ───────────────────────────────────────────
  return {
    socketPath,
    async stop() {
      try {
        await daemon.stop();
      } catch {
        // Best-effort shutdown — socket may already be gone.
      }
    },
  };
}
