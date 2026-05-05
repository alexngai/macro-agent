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
  const { agentManager, agentStore, inboxAdapter, tasksAdapter, getLocalMapId, gitCascadeAdapter, dispatcherAgentId } = deps;
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
  let mailBridgeCleanup: (() => void) | null = null;
  let dispatchSpawnHandlerCleanup: (() => void) | null = null;
  let dispatchMessageHandlerCleanup: (() => void) | null = null;
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
    if (mailBridgeCleanup) {
      try { mailBridgeCleanup(); } catch { /* non-critical */ }
      mailBridgeCleanup = null;
    }
    if (cascadeBridgeCleanup) {
      try { cascadeBridgeCleanup(); } catch { /* non-critical */ }
      cascadeBridgeCleanup = null;
    }
    if (dispatchMessageHandlerCleanup) {
      try { dispatchMessageHandlerCleanup(); } catch { /* non-critical */ }
      dispatchMessageHandlerCleanup = null;
    }
    if (dispatchSpawnHandlerCleanup) {
      try { dispatchSpawnHandlerCleanup(); } catch { /* non-critical */ }
      dispatchSpawnHandlerCleanup = null;
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
    const awaitAcpRegistration = bridge.awaitRegistration;
    const findLocalAgentByMapId = bridge.findLocalAgentByMapId;
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

    // 4b. Mail Bridge — forwards `mail/turn.received` notifications from the
    // hub into the local agent-inbox so swarm-dispatch's MessagePort can
    // pick them up via its `inbox.events` subscription. Without this,
    // hub-side mail never reaches the dispatcher.
    const { setupMailBridge } = await import("./mail-bridge.js");
    mailBridgeCleanup = await setupMailBridge({
      connection,
      inboxAdapter,
      dispatcherAgentId,
      log: (msg) => console.log(msg),
    });

    // 4c. x-dispatch/spawn-agent handler — notification-pair pattern.
    //
    // The MAP SDK's AgentConnection doesn't expose setRequestHandler, so
    // the hub→swarm spawn-agent "request" is sent as a notification
    // with a correlation_id. We process and reply with a `.response`
    // notification carrying the same correlation_id (or an error).
    //
    // Dual-listen: subscribe to BOTH the canonical
    // `x-dispatch/spawn-agent.request` (Tier 2+, owned by swarm-dispatch)
    // AND the legacy `dispatch/spawn-agent.request` for one release
    // window. Reply on the matching channel — the hub's response
    // dispatcher accepts both.
    const { handleDispatchSpawnAgent } = await import(
      "../dispatch/spawn-agent-handler.js"
    );
    const {
      handleSpawnAgentRequest,
      X_DISPATCH_METHODS: SPAWN_METHODS,
      LEGACY_DISPATCH_SPAWN_AGENT_REQUEST,
      LEGACY_DISPATCH_SPAWN_AGENT_RESPONSE,
    } = await import("swarm-dispatch/client");

    const makeSpawnHandler = (
      responseMethod: string,
    ): ((params: unknown) => Promise<void>) =>
      async (params) => {
        await handleSpawnAgentRequest({
          params,
          runtime: {
            async spawn(req) {
              return handleDispatchSpawnAgent(
                req as unknown as Parameters<typeof handleDispatchSpawnAgent>[0],
                {
                  agentManager,
                  // Wait barrier: lifecycle-bridge resolves once
                  // `map/agents/register` completes, so the orchestrator's
                  // subsequent `findAcpAgentInfo` lookup doesn't race.
                  waitForAcpRegistration: awaitAcpRegistration,
                  log: (msg) => console.log(msg),
                },
              );
            },
          },
          sendResponse: async (responseParams) => {
            await connection.sendNotification(responseMethod, responseParams);
          },
          log: (msg) => console.log(msg),
        });
      };

    const canonicalSpawnHandler = makeSpawnHandler(
      SPAWN_METHODS.SPAWN_AGENT_RESPONSE,
    );
    const legacySpawnHandler = makeSpawnHandler(
      LEGACY_DISPATCH_SPAWN_AGENT_RESPONSE,
    );

    connection.onNotification(
      SPAWN_METHODS.SPAWN_AGENT_REQUEST,
      canonicalSpawnHandler,
    );
    connection.onNotification(
      LEGACY_DISPATCH_SPAWN_AGENT_REQUEST,
      legacySpawnHandler,
    );
    dispatchSpawnHandlerCleanup = () => {
      try {
        if (typeof connection.offNotification === "function") {
          connection.offNotification(
            SPAWN_METHODS.SPAWN_AGENT_REQUEST,
            canonicalSpawnHandler,
          );
          connection.offNotification(
            LEGACY_DISPATCH_SPAWN_AGENT_REQUEST,
            legacySpawnHandler,
          );
        }
      } catch {
        /* connection already torn down */
      }
    };

    // 4d. map/dispatch/message handler — receives hub-routed envelopes
    // addressed to a specific agent on this swarm via MAP scope. The hub
    // takes this path (not mail/turn) when the target agent declares
    // `messaging.canReceive: true` per-agent but not `mail.canJoin`,
    // which is the default for long-lived workers/coordinators registered
    // by the lifecycle bridge. Without this handler, mail+reuse dispatches
    // are silently dropped on the swarm side.
    //
    // Translate the hub-assigned MAP ULID (`to_agent_id`) → local agent
    // id and forward the envelope into the local inbox so the new
    // `mail-inbound-reuse-consumer` picks it up.
    const dispatchMessageHandler = async (params: unknown): Promise<void> => {
      const p = params as
        | (Record<string, unknown> & {
            to_agent_id?: string;
            envelope?: unknown;
            from_agent_id?: string;
          })
        | undefined;
      const toAgentId = p?.to_agent_id;
      const envelope = p?.envelope;
      if (!toAgentId || !envelope) {
        console.warn(
          "[sidecar] map/dispatch/message missing to_agent_id or envelope; ignoring",
        );
        return;
      }
      const localAgentId = findLocalAgentByMapId(toAgentId);
      if (!localAgentId) {
        console.warn(
          `[sidecar] map/dispatch/message recipient ${toAgentId} not registered locally; dropping`,
        );
        return;
      }
      // Translate envelope { type, body } → { schema, data } shape that the
      // mail-inbound-reuse-consumer expects (mirrors mail-bridge's
      // translation for `mail/turn.received`).
      const env = envelope as { type?: string; body?: Record<string, unknown> };
      const content: Record<string, unknown> =
        env.type && env.body
          ? { schema: env.type, data: env.body }
          : (envelope as Record<string, unknown>);
      const contentWithMarker: Record<string, unknown> = {
        type: "data",
        ...content,
      };
      try {
        await inboxAdapter.send(
          (p?.from_agent_id as string | undefined) ?? "openhive-hub",
          localAgentId,
          contentWithMarker as never,
          { importance: "normal" },
        );
      } catch (err) {
        console.warn(
          `[sidecar] map/dispatch/message inbox.send failed for ${localAgentId}: ` +
            `${(err as Error).message}`,
        );
      }
    };
    // Dual-listen: subscribe to BOTH the canonical `x-dispatch/message`
    // (the new method name owned by swarm-dispatch's protocol-constants
    // module) AND the legacy `map/dispatch/message` alias for one
    // release window. Older hub builds send under the legacy name; new
    // builds send under the canonical name. Once the dual-listen window
    // closes, drop the legacy registration.
    const {
      X_DISPATCH_METHODS,
      LEGACY_MAP_DISPATCH_MESSAGE_METHOD,
    } = await import("swarm-dispatch/client");
    connection.onNotification(
      X_DISPATCH_METHODS.MESSAGE,
      dispatchMessageHandler,
    );
    connection.onNotification(
      LEGACY_MAP_DISPATCH_MESSAGE_METHOD,
      dispatchMessageHandler,
    );
    dispatchMessageHandlerCleanup = () => {
      try {
        if (typeof connection.offNotification === "function") {
          connection.offNotification(
            X_DISPATCH_METHODS.MESSAGE,
            dispatchMessageHandler,
          );
          connection.offNotification(
            LEGACY_MAP_DISPATCH_MESSAGE_METHOD,
            dispatchMessageHandler,
          );
        }
      } catch {
        /* connection already torn down */
      }
    };

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

    async postMailTurn(
      conversationId: string,
      participantId: string,
      content: string,
    ): Promise<void> {
      if (!connection || !isConnected) {
        console.warn(
          `[map-sidecar] postMailTurn skipped (connection=${!!connection} ` +
            `isConnected=${isConnected}) conv=${conversationId}`,
        );
        return;
      }
      try {
        await connection.sendNotification("mail/turn", {
          conversationId,
          participantId,
          contentType: "text/plain",
          content,
        });
      } catch (err) {
        // Best effort — hub may be temporarily unavailable. Log at warn
        // so silent failures are visible during postmortem.
        console.warn(
          `[map-sidecar] postMailTurn failed for conv=${conversationId}: ` +
            `${(err as Error).message ?? String(err)}`,
        );
      }
    },
  };
}
