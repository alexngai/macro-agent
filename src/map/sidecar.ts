/**
 * MAP Sidecar — connects macro-agent to an OpenHive MAP hub.
 *
 * This is the main orchestrator module. It establishes a MAP connection,
 * creates sub-modules (lifecycle bridge, trajectory reporter, task bridge,
 * coordination handler), and wires them to macro-agent's event sources.
 *
 * Usage:
 *   const sidecar = createMAPSidecar(deps, config);
 *   await sidecar.start();  // Connect + wire events
 *   await sidecar.stop();   // Disconnect + cleanup
 *
 * @module map/sidecar
 */

import type {
  MAPSidecar,
  MAPSidecarConfig,
  MAPSidecarDeps,
  TrajectoryCheckpointPayload,
  TrajectoryCheckpointResult,
  TrajectoryReporter,
  TaskBridge,
} from "./types.js";
import type { AgentLifecycleCallback } from "../agent/types.js";

/**
 * Create a MAP sidecar that connects macro-agent to an OpenHive MAP hub.
 *
 * The sidecar is lazy: if connection fails, it logs a warning and
 * operates in disconnected mode. All bridge operations silently no-op
 * when disconnected. macro-agent continues working normally.
 */
export function createMAPSidecar(
  deps: MAPSidecarDeps,
  config: MAPSidecarConfig,
): MAPSidecar {
  const { agentManager, agentStore, inboxAdapter, tasksAdapter } = deps;
  const scope = config.scope ?? "swarm:macro-agent";
  const agentName = config.agentName ?? "macro-agent-sidecar";

  // Connection state
  let connection: any = null; // AgentConnection from MAP SDK (dynamic import)
  let isConnected = false;

  // Sub-module state
  let lifecycleCallback: AgentLifecycleCallback | null = null;
  let lifecycleUnsubscribe: (() => void) | null = null;
  let lifecycleCleanup: (() => Promise<void>) | null = null;
  let trajectoryReporter: TrajectoryReporter | null = null;
  let taskBridge: TaskBridge | null = null;
  let coordinationCleanup: (() => void) | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Build the MAP connection URL with auth token.
   */
  function buildUrl(): string {
    const parsed = new URL(config.server);
    // Ensure the path includes /ws/map for OpenHive
    if (!parsed.pathname.includes("/ws/map") && !parsed.pathname.includes("/map")) {
      parsed.pathname = parsed.pathname.replace(/\/?$/, "/ws/map");
    }
    if (config.token) {
      parsed.searchParams.set("token", config.token);
    }
    // Include swarm_id for stable identity across reconnections.
    // When set, the hub reuses the pre-registered swarm record instead
    // of auto-generating a new one on each connection.
    if (config.swarmId) {
      parsed.searchParams.set("swarm_id", config.swarmId);
    }
    return parsed.toString();
  }

  /**
   * Clean up sub-modules (notification handlers, lifecycle listeners, etc.)
   * Called before re-wiring on reconnect and during stop().
   */
  async function cleanupSubModules(): Promise<void> {
    if (coordinationCleanup) {
      coordinationCleanup();
      coordinationCleanup = null;
    }
    if (trajectoryReporter) {
      trajectoryReporter.stop();
      trajectoryReporter = null;
    }
    if (lifecycleCleanup) {
      await lifecycleCleanup();
      lifecycleCleanup = null;
    }
    if (lifecycleUnsubscribe) {
      lifecycleUnsubscribe();
      lifecycleUnsubscribe = null;
    }
    lifecycleCallback = null;
    taskBridge = null;
  }

  /**
   * Attempt to connect to the MAP hub.
   */
  async function connect(): Promise<boolean> {
    try {
      const { AgentConnection } = await import(
        "@multi-agent-protocol/sdk"
      );

      const url = buildUrl();
      const connectOpts: Record<string, unknown> = {
        name: agentName,
        role: "sidecar",
        scopes: [scope],
        capabilities: {
          messaging: { canSend: true, canReceive: true },
          mail: { canCreate: true, canJoin: true, canViewHistory: true },
          trajectory: { canReport: true, canServeContent: false },
          tasks: {
            canCreate: true,
            canAssign: true,
            canUpdate: true,
            canList: true,
          },
        },
        metadata: {
          systemId: config.systemId ?? "macro-agent",
          type: "macro-agent-sidecar",
        },
        reconnection: {
          enabled: config.reconnection?.enabled ?? true,
          maxRetries: config.reconnection?.maxRetries ?? 10,
          baseDelayMs: config.reconnection?.baseDelayMs ?? 1000,
          maxDelayMs: config.reconnection?.maxDelayMs ?? 30000,
        },
      };

      // Try mesh transport first if enabled (encrypted P2P via agentic-mesh)
      if (config.mesh?.enabled) {
        try {
          connection = await (AgentConnection as any).connectMesh({
            ...connectOpts,
            peer: { peerId: config.mesh.peerId ?? `${agentName}-mesh` },
            server: config.server,
          });
          isConnected = true;
          console.log(`[map-sidecar] Connected via MeshPeer to ${config.server}`);
        } catch (meshErr) {
          console.warn(
            `[map-sidecar] MeshPeer failed, falling back to WebSocket: ${(meshErr as Error).message}`,
          );
        }
      }

      // WebSocket connection (direct or fallback from mesh)
      if (!isConnected) {
      // Try open mode first (single call connect+register).
      // If server requires auth, fall back to verified mode.
      if (config.credential && (AgentConnection as any).createConnection) {
        // Verified mode: connectOnly → check authRequired → authenticate → register
        connection = await (AgentConnection as any).createConnection(url, connectOpts);
        const result = await connection.connectOnly();
        if (result.authRequired) {
          const method = result.authRequired.methods?.[0] ?? "x-agent-iam";
          await connection.authenticate({
            method,
            token: config.credential,
          });
        }
        await connection.register();
      } else {
        // Open mode: single call connect+register
        connection = await (AgentConnection as any).connect(url, connectOpts);
      }
      isConnected = true;
      } // end if (!isConnected)

      // Monitor connection state
      connection.onStateChange(
        (newState: string, _oldState: string) => {
          isConnected = newState === "connected";
          if (!isConnected) {
            console.warn(
              `[map-sidecar] Connection state: ${newState}`,
            );
          }
        },
      );

      // Start slow reconnect loop when SDK retries are exhausted
      connection.closed
        .then(() => {
          isConnected = false;
          scheduleReconnect();
        })
        .catch(() => {
          isConnected = false;
          scheduleReconnect();
        });

      console.log(
        `[map-sidecar] Connected to MAP hub at ${config.server}`,
      );
      return true;
    } catch (err) {
      console.warn(
        `[map-sidecar] Failed to connect to MAP hub: ${(err as Error).message}`,
      );
      isConnected = false;
      return false;
    }
  }

  /**
   * Schedule a slow reconnection attempt after SDK retries are exhausted.
   */
  function scheduleReconnect(): void {
    if (reconnectTimer) return;
    const interval = config.reconnectIntervalMs ?? 60_000;

    reconnectTimer = setTimeout(async () => {
      reconnectTimer = null;
      if (isConnected) return;

      console.log("[map-sidecar] Attempting reconnection...");
      // Clean up old sub-modules before re-wiring
      await cleanupSubModules();
      const ok = await connect();
      if (ok) {
        await wireSubModules();
      } else {
        scheduleReconnect();
      }
    }, interval);
    reconnectTimer.unref?.(); // Don't prevent process exit
  }

  /**
   * Wire sub-modules to event sources and the MAP connection.
   */
  async function wireSubModules(): Promise<void> {
    if (!connection) return;

    // 1. Task Bridge (created first so lifecycle bridge can reference it)
    const { createTaskBridge } = await import("./task-bridge.js");
    taskBridge = createTaskBridge(connection, scope);

    // 2. Lifecycle Bridge
    const { createLifecycleBridge } = await import("./lifecycle-bridge.js");
    const bridge = createLifecycleBridge(
      connection,
      agentStore,
      scope,
      taskBridge,
    );
    lifecycleCallback = bridge.callback;
    lifecycleCleanup = bridge.cleanup;
    lifecycleUnsubscribe = agentManager.onLifecycleEvent(lifecycleCallback);

    // 3. Trajectory Reporter
    const { createTrajectoryReporter } = await import("./trajectory-reporter.js");
    trajectoryReporter = createTrajectoryReporter(connection, config);

    // 4. Coordination Handler
    const { setupCoordinationHandlers } = await import("./coordination-handler.js");
    coordinationCleanup = setupCoordinationHandlers({
      connection,
      agentManager,
      inboxAdapter,
      tasksAdapter,
      trajectoryReporter,
    });
  }

  return {
    async start(): Promise<void> {
      const ok = await connect();
      if (ok) {
        await wireSubModules();
      } else {
        // Schedule retry — sidecar will wire sub-modules when connected
        scheduleReconnect();
      }
    },

    async stop(): Promise<void> {
      // Clear reconnect timer
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }

      // Clean up all sub-modules
      await cleanupSubModules();

      // Disconnect from hub
      if (connection) {
        try {
          await connection.disconnect("sidecar_shutdown");
        } catch {
          // Already disconnected
        }
        connection = null;
      }

      isConnected = false;
    },

    get connected(): boolean {
      return isConnected;
    },

    async reportCheckpoint(
      checkpoint: TrajectoryCheckpointPayload,
    ): Promise<TrajectoryCheckpointResult | null> {
      if (!trajectoryReporter) return null;
      return trajectoryReporter.reportCheckpoint(checkpoint);
    },
  };
}
