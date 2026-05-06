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
import {
  REPO_PROTOCOL_VERSION,
  RepoClient,
  RepoManager,
  type RepoClientTransport,
  type WorkspaceCapability,
} from "agent-workspace/kinds/repo";

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
  const { agentManager, agentStore, inboxAdapter, tasksAdapter, getLocalMapId, gitCascadeAdapter } = deps;
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
  let cascadeBridgeCleanup: (() => void) | null = null;
  let workspaceManager: RepoManager | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  // Resolve the workspace capability from env vars. Setting OPENHIVE_WORKSPACE_DECLARE=off
  // disables both explicit declare AND trajectory-handler bootstrap on the hub side.
  const workspaceCapability: WorkspaceCapability = {
    protocolVersion: REPO_PROTOCOL_VERSION,
    declare: {
      enabled: process.env.OPENHIVE_WORKSPACE_DECLARE !== "off",
      defaultVisibility:
        (process.env.OPENHIVE_WORKSPACE_VISIBILITY as
          | "private"
          | "hub_local"
          | "federated") ?? "hub_local",
    },
    list: { enabled: true },
  };

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
    if (cascadeBridgeCleanup) {
      try { cascadeBridgeCleanup(); } catch { /* non-critical */ }
      cascadeBridgeCleanup = null;
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
    workspaceManager = null;
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
          workspace: workspaceCapability,
        },
        metadata: {
          systemId: config.systemId ?? "macro-agent",
          type: "macro-agent-sidecar",
          // Signals that this swarm can spawn ACP-capable coordinators on demand,
          // even before any coordinator has registered. The hub's /sessions/create-acp
          // endpoint handles the spawn via _macro/spawnAgent when no ACP agent exists.
          canHostAcp: true,
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

      // Publish sidecar metadata to the hub. The MAP SDK's connect()/register()
      // does not propagate the `metadata` field from connect options — it only
      // forwards name/role/capabilities/scopes. Call updateMetadata explicitly
      // so the hub sees canHostAcp (and any other metadata the UI relies on).
      try {
        const metadata = (connectOpts.metadata as Record<string, unknown>) ?? {};
        if (typeof connection.updateMetadata === "function") {
          await connection.updateMetadata(metadata);
        }
      } catch {
        // Non-fatal — metadata is advisory
      }

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
      getLocalMapId,
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

    // 5. Cascade Bridge + Action Handler (optional — only when a GitCascadeAdapter is available)
    if (gitCascadeAdapter) {
      const { createCascadeBridge } = await import("./cascade-bridge.js");
      const cascadeBridge = createCascadeBridge(connection, gitCascadeAdapter);

      // 5b. Inbound action handler — receives x-cascade/request.* from hub
      const { setupCascadeActionHandlers } = await import("./cascade-action-handler.js");
      const actionCleanup = setupCascadeActionHandlers(connection, gitCascadeAdapter);

      cascadeBridgeCleanup = () => {
        cascadeBridge.dispose();
        actionCleanup();
      };
    }

    // 6. Workspace (kinds/repo) — declare attached repos to the hub.
    //    Discovers repos from WORKSPACE_* env vars (set by openhive's swarm-spawn
    //    flow when spawning with a `repo_id`) plus OPENHIVE_WORKSPACE_REPOS for
    //    multi-repo declarations. Skipped entirely when capability.declare is off.
    if (workspaceCapability.declare.enabled) {
      try {
        // OpenHive's MAP server registers x-workspace/repo.* as request handlers
        // (additionalHandlers), not notification handlers — so route notify
        // through callExtension and ignore the (void) response.
        const transport: RepoClientTransport = {
          notify: async (method, params) => {
            await connection.callExtension(method, params);
          },
          request: (method, params) => connection.callExtension(method, params),
        };
        const manager = new RepoManager();
        const single =
          process.env.WORKSPACE_REPO_URL && process.env.WORKSPACE_LOCAL_PATH
            ? [{
                remoteUrl: process.env.WORKSPACE_REPO_URL,
                localPath: process.env.WORKSPACE_LOCAL_PATH,
              }]
            : [];
        const multi = process.env.OPENHIVE_WORKSPACE_REPOS
          ? (JSON.parse(process.env.OPENHIVE_WORKSPACE_REPOS) as Array<{
              remoteUrl: string;
              localPath: string;
            }>)
          : [];
        for (const cfg of [...single, ...multi]) {
          await manager.attach(cfg);
        }
        if (manager.list().length > 0) {
          const client = new RepoClient(transport);
          await client.declare(RepoClient.snapshot(manager));
          workspaceManager = manager;
          console.log(
            `[map-sidecar] Declared ${manager.list().length} workspace(s) to hub`,
          );
        }
      } catch (err) {
        // Non-fatal — sidecar continues without workspace declarations
        console.warn(
          `[map-sidecar] Workspace declare failed: ${(err as Error).message}`,
        );
      }
    }
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

    async emitEvent(event: Record<string, unknown>): Promise<void> {
      if (!connection || !isConnected) return;
      try {
        await connection.send({ scope }, { ...event, _origin: "macro-agent" });
      } catch {
        // Best effort — MAP hub may be temporarily unavailable
      }
    },
  };
}
