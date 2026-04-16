/**
 * MAP Server — accepts inbound MAP connections for ACP-over-MAP interaction.
 *
 * Provides a MAP-compliant server that the TUI (and other MAP clients) can
 * connect to. Supports:
 * - Agent discovery (listAgents, subscribe)
 * - ACP-over-MAP (prompt agents, handle permissions)
 * - Extension methods (_macro/spawnAgent, _macro/getHierarchy, etc.)
 * - MAP event subscriptions (agent lifecycle, task events)
 *
 * Uses MAPServer from @multi-agent-protocol/sdk/server for protocol handling.
 * Agent lifecycle is synced from AgentManager to MAPServer's agent registry.
 *
 * @module map/server
 */

import * as http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import type { AgentManager } from "../agent/agent-manager.js";
import type { AgentStore } from "../agent/agent-store.js";
import type { InboxAdapter, TasksAdapter } from "../adapters/types.js";
import type { MapServerConfig, MAPServerInstance } from "./types.js";
import type { MacroAgentSystemV2 } from "../boot-v2.js";
import type { ACPBridge } from "./acp-bridge.js";

// =============================================================================
// Dependencies (same shape as MacroAgentSystemV2, partial)
// =============================================================================

export interface MapServerDeps {
  agentManager: AgentManager;
  agentStore: AgentStore;
  inboxAdapter: InboxAdapter;
  tasksAdapter: TasksAdapter;
  /** Full system reference needed for ACP-over-MAP bridge */
  system?: MacroAgentSystemV2;
}

// =============================================================================
// Implementation
// =============================================================================

/**
 * Create a MAP server that accepts inbound connections.
 *
 * The server uses MAPServer from the MAP SDK for protocol handling,
 * with macro-agent extension methods registered as additionalHandlers.
 * Agent lifecycle events from AgentManager are synced to the MAPServer's
 * agent registry so clients see agents via listAgents() and subscribe().
 */
export function createMAPServerInstance(
  deps: MapServerDeps,
  config: MapServerConfig = {},
): MAPServerInstance {
  const port = config.port ?? 3002;
  const host = config.host ?? "127.0.0.1";
  const wsPath = config.path ?? "/map";
  const serverName = config.name ?? "macro-agent";

  let mapServer: any = null;
  let httpServer: http.Server | null = null;
  let wss: WebSocketServer | null = null;
  let acpBridge: ACPBridge | null = null;
  let lifecycleUnsubscribe: (() => void) | null = null;
  let connectionCount = 0;
  let actualUrl = "";

  // Bidirectional mapping: MAPServer assigns its own ULIDs for agents.
  // We track the mapping so we can route ACP messages to the right local agent.
  const mapIdToLocalId = new Map<string, string>(); // MAP ULID → macro-agent agent ID
  const localIdToMapId = new Map<string, string>(); // macro-agent agent ID → MAP ULID

  // Track WebSocket connections by their MAP participant/agent ID for direct delivery
  const clientWebSockets = new Map<string, WebSocket>(); // participant/agent ID → WebSocket
  // Track subscription IDs by client agent ID for ACP response delivery
  const clientSubscriptions = new Map<string, string[]>(); // agent ID → subscription IDs
  /**
   * Per-subscription monotonic event counter. The MAP SDK's Subscription
   * checks `sequenceNumber !== lastSequenceNumber + 1` and warns on gaps —
   * using `Date.now()` (millisecond timestamp) breaks that assumption since
   * each event becomes a "gap". Track a per-subscription counter starting
   * at 1 and increment per event.
   */
  const subscriptionSequence = new Map<string, number>(); // subscription ID → next sequence number
  // Track original ws.send for each WebSocket (before interception)
  const originalSends = new Map<WebSocket, Function>();

  /**
   * Build additionalHandlers for macro-agent extension methods.
   * These are registered on the MAPServer so MAP clients can call them.
   */
  function buildAdditionalHandlers(): Record<
    string,
    (params: any, ctx: any) => Promise<any>
  > {
    const { agentManager, agentStore, tasksAdapter } = deps;
    const handlers: Record<string, (params: any, ctx: any) => Promise<any>> = {};

    // ── Agent extensions ──────────────────────────────────────────
    handlers["_macro/spawnAgent"] = async (params, ctx) => {
      const spawned = await agentManager.spawn({
        task: params.task ?? "Spawned via MAP",
        parent: params.parent ?? null,
        cwd: params.cwd,
        role: params.role ?? "worker",
      });

      // Ensure agent is registered in MAPServer's registry.
      // The lifecycle bridge may have already done this, but we also
      // register here with the session context for subscription routing.
      if (mapServer && !localIdToMapId.has(spawned.id)) {
        try {
          const registered = mapServer.agents.register({
            name: (spawned as any).name ?? spawned.id,
            role: params.role ?? "worker",
            state: "idle",
            sessionId: ctx?.session?.id,
            metadata: { peerAgentId: spawned.id, task: params.task },
          });
          if (registered?.id) {
            mapIdToLocalId.set(registered.id, spawned.id);
            localIdToMapId.set(spawned.id, registered.id);
          }
        } catch {
          // Best effort
        }
      }

      // Return the MAP ULID (from MAPServer registry) so clients can reference it
      const mapId = localIdToMapId.get(spawned.id) ?? spawned.id;
      return { agent: { id: mapId, name: (spawned as any).name, localId: spawned.id } };
    };

    handlers["_macro/getHierarchy"] = async (params) => {
      const hierarchy = agentManager.getHierarchy(
        params.agentId,
        params.depth ? { depth: params.depth } : undefined,
      );
      return { hierarchy };
    };

    handlers["_macro/forkAgent"] = async (params) => {
      const spawned = await agentManager.forkAgent(params.sourceAgentId, {
        name: params.name,
        prompt: params.prompt,
        cwd: params.cwd,
      });
      return { agent: { id: spawned.id } };
    };

    handlers["_macro/resume"] = async (params) => {
      const spawned = await agentManager.resume(params.agentId);
      return { agent: { id: spawned.id } };
    };

    /**
     * Terminate a running agent. Accepts either the agent's local ID or the
     * MAP-assigned ULID (we resolve back to local via mapIdToLocalId).
     * Reason defaults to "stopped"; use "cancelled" for user-initiated stops.
     */
    handlers["_macro/terminateAgent"] = async (params) => {
      const agentIdParam = params.agentId as string | undefined;
      const reason = (params.reason as string) ?? "cancelled";
      if (!agentIdParam) {
        return { success: false, error: "agentId is required" };
      }
      // Resolve either a MAP ULID or a local agent ID to our internal ID.
      const localId = mapIdToLocalId.get(agentIdParam) ?? agentIdParam;
      try {
        await agentManager.terminate(localId as any, reason as any);
        return { success: true };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    };

    /**
     * Inspect ACP stream → peer agent bindings on this MAP server.
     * Each stream carries the peer agent id (macro-agent's internal store id)
     * it was opened against, set by the bridge from MAP routing. Useful for
     * routing tests and debugging multi-coordinator scenarios.
     */
    handlers["_macro/getAcpStreamBindings"] = async () => {
      if (!acpBridge) return { bindings: [] };
      return { bindings: acpBridge.getStreamBindings() };
    };

    // ── Task extensions ───────────────────────────────────────────
    handlers["_macro/task/list"] = async () => {
      if (!tasksAdapter.connected) return { tasks: [] };
      try {
        const tasks = await tasksAdapter.listTasks();
        return { tasks };
      } catch {
        return { tasks: [] };
      }
    };

    handlers["_macro/getTask"] = async (params) => {
      if (!tasksAdapter.connected) return { task: null };
      try {
        const task = await tasksAdapter.getTask(params.taskId);
        return { task };
      } catch {
        return { task: null };
      }
    };

    // ── Query extensions ──────────────────────────────────────────
    handlers["_macro/getHistory"] = async (params) => {
      try {
        const messages = await deps.inboxAdapter.checkInbox(params.agentId, {
          limit: params.limit ?? 50,
        });
        return { messages };
      } catch {
        return { messages: [] };
      }
    };

    // ── Trajectory ─────────────────────────────────────────────────
    // Receives trajectory checkpoints from cc-swarm agents connected
    // to this MAP server. Forwards upstream to OpenHive via the sidecar.
    handlers["trajectory/checkpoint"] = async (params: any) => {
      const checkpoint = params?.checkpoint;
      if (!checkpoint) return { ok: false, error: "missing checkpoint" };

      // Forward to the sidecar for upstream delivery to OpenHive
      const sidecar = (deps.system as any)?.mapSidecar;
      if (sidecar?.connected) {
        try {
          const result = await sidecar.reportCheckpoint(checkpoint);
          return result ?? { ok: true };
        } catch {
          return { ok: true, note: "forwarding failed, received locally" };
        }
      }

      return { ok: true, note: "received locally, no upstream sidecar" };
    };

    // ── Ping ──────────────────────────────────────────────────────
    handlers["ping"] = async () => ({ pong: true });

    return handlers;
  }

  return {
    async start(): Promise<void> {
      // 1. Import MAPServer from SDK (dynamic to keep it optional)
      // @ts-expect-error — server subpath export may lack .d.ts
      const { MAPServer } = await import("@multi-agent-protocol/sdk/server");
      const { websocketStream } = await import("@multi-agent-protocol/sdk");

      // 2. Create MAPServer with extension handlers
      const additionalHandlers = buildAdditionalHandlers();
      mapServer = new MAPServer({
        name: serverName,
        version: "1.0.0",
        additionalHandlers,
      });

      // 2b. Patch SubscriptionManager to handle undefined filters.
      // The SDK's matchesFilter() crashes with "Cannot read properties of
      // undefined (reading '$or')" when a subscription has no filter (e.g.,
      // client.subscribe() with no args). We patch the method to treat
      // undefined/null filter as "match all" (return true).
      if (mapServer.subscriptions?.matchesFilter) {
        const origMatchesFilter = mapServer.subscriptions.matchesFilter.bind(
          mapServer.subscriptions,
        );
        mapServer.subscriptions.matchesFilter = (event: any, filter: any) => {
          if (!filter) return true; // undefined/null filter matches everything
          return origMatchesFilter(event, filter);
        };
      }

      // 3. Set up ACP-over-MAP bridge for local agent interaction
      // When MAP clients send ACP envelopes to local agents (via createACPStream),
      // we intercept via the eventBus's message_sent event. The bridge creates
      // in-memory stream pairs and wires them to createMacroAgent() for processing.
      if (deps.system) {
        const { createACPBridge } = await import("./acp-bridge.js");
        acpBridge = createACPBridge(
          deps.system,
          mapServer,
          (localId) => localIdToMapId.get(localId),
          (clientId, rawEvent) => {
            const ws = clientWebSockets.get(clientId);
            if (!ws || ws.readyState !== WebSocket.OPEN) {
                return;
            }

            const send = originalSends.get(ws) ?? ws.send.bind(ws);
            const subIds = clientSubscriptions.get(clientId) ?? [];

            // Send as subscription event notification (what ACPStreamConnection expects).
            // The _pushEvent method expects: { subscriptionId, sequenceNumber, eventId, timestamp, event }
            //
            // sequenceNumber must be a per-subscription monotonic counter that
            // increments by exactly 1 — the SDK warns on any gap. Don't use
            // Date.now() here (breaks the contract on every event).
            for (const subId of subIds) {
              const event = rawEvent.params?.event ?? rawEvent;
              const eventId = event.id ?? `acp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
              const nextSeq = (subscriptionSequence.get(subId) ?? 0) + 1;
              subscriptionSequence.set(subId, nextSeq);
              const notification = JSON.stringify({
                jsonrpc: "2.0",
                method: "map/event",
                params: {
                  subscriptionId: subId,
                  sequenceNumber: nextSeq,
                  eventId,
                  timestamp: Date.now(),
                  event,
                },
              });
              send(notification);
            }
          },
        );

        // Intercept messages via eventBus.
        // Messages to local agents get "queued" (not "delivered") because
        // local agents don't have MAP connections. We intercept both sent
        // and queued events to catch ACP envelopes destined for local agents.
        // Handle message events asynchronously to avoid blocking the map/send
        // response. The eventBus fires synchronously during sendToAgent(),
        // and if we process ACP messages synchronously, the response to
        // map/send might be delayed (or the ACP response notification might
        // arrive before the map/send ACK, causing protocol issues).
        const handleMessageEvent = (event: any) => {
          if (!acpBridge) return;
          const data = event?.data;
          const message = data?.message;
          if (!message) return;

          // Check if this is an ACP envelope — these should always be handled
          // by the bridge, even if the target agent can't be resolved to a
          // specific local agent (the bridge creates a head manager on demand).
          const payload = message?.payload;
          const isAcp = payload && typeof payload === 'object' &&
            'acp' in payload && 'acpContext' in payload;

          const toField = message.to;
          const mapTargetId = data?.agentId ??
            (typeof toField === "string" ? toField : toField?.agent ?? toField?.id);
          if (!mapTargetId) return;

          const localAgentId = mapIdToLocalId.get(mapTargetId) ?? mapTargetId;

          // For ACP envelopes, always forward to bridge (it creates sessions on demand).
          // For non-ACP messages, require a local agent to exist.
          if (!isAcp) {
            const localAgent = deps.agentManager.get(localAgentId);
            if (!localAgent) return;
          }

          // Defer ACP processing to next tick so map/send response goes out first
          setImmediate(() => {
            acpBridge!.handleDelivery(localAgentId, message);
          });
        };

        mapServer.eventBus.on("message.sent", handleMessageEvent);
        mapServer.eventBus.on("message.queued", handleMessageEvent);
      }

      // 4. Create HTTP server with /health endpoint
      httpServer = http.createServer((req, res) => {
        if (req.url === "/health") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              status: "ok",
              connections: connectionCount,
              agents: deps.agentManager.list().length,
            }),
          );
        } else {
          res.writeHead(404);
          res.end("Not Found");
        }
      });

      // 5. Attach WebSocket server
      wss = new WebSocketServer({ server: httpServer, path: wsPath });

      wss.on("connection", (ws: WebSocket) => {
        connectionCount++;

        // Intercept outgoing messages to track subscription IDs and agent IDs.
        // This lets us route ACP responses directly via the WebSocket.
        const originalSend = ws.send.bind(ws);
        originalSends.set(ws, originalSend);
        const subscriptionIds: string[] = [];
        let clientAgentId: string | null = null;

        ws.send = function (data: any, ...args: any[]) {
          // Parse outgoing messages to learn about subscriptions and agent IDs
          try {
            const msg = typeof data === "string" ? JSON.parse(data) : null;
            if (msg?.result?.subscriptionId) {
              subscriptionIds.push(msg.result.subscriptionId);
            }
            // Track client by ALL IDs we see in responses
            if (msg?.result?.agent?.id) {
              clientAgentId = msg.result.agent.id as string;
              clientWebSockets.set(clientAgentId!, ws);
              clientSubscriptions.set(clientAgentId!, subscriptionIds);
            }
            // Also track by session/participant IDs
            if (msg?.result?.connection?.participantId) {
              const partId = msg.result.connection.participantId as string;
              clientWebSockets.set(partId, ws);
              clientSubscriptions.set(partId, subscriptionIds);
            }
            if (msg?.result?.sessionId) {
              const sessId = msg.result.sessionId as string;
              clientWebSockets.set(sessId, ws);
              clientSubscriptions.set(sessId, subscriptionIds);
            }
          } catch {
            // Ignore parse errors
          }
          return originalSend(data, ...args);
        } as any;

        // Observe incoming messages so we drop subscription IDs from our
        // routing array when the client unsubscribes. Without this, closed
        // ACP streams keep receiving events ("MAP: Event for unknown
        // subscription" warnings on the client). We don't intercept the
        // SDK's processing — this listener runs alongside it.
        ws.on("message", (data: any) => {
          try {
            const text = typeof data === "string"
              ? data
              : Buffer.isBuffer(data)
                ? data.toString("utf-8")
                : String(data);
            const msg = JSON.parse(text);
            if (msg?.method === "map/unsubscribe") {
              const subId = msg?.params?.subscriptionId;
              if (typeof subId === "string") {
                const idx = subscriptionIds.indexOf(subId);
                if (idx >= 0) subscriptionIds.splice(idx, 1);
                subscriptionSequence.delete(subId);
              }
            }
          } catch {
            // Non-JSON or parse failure — ignore
          }
        });

        const stream = websocketStream(ws as unknown as globalThis.WebSocket);
        const router = mapServer.accept(stream, {
          role: "client",
          transportType: "websocket",
        });
        router.start();

        ws.on("close", () => {
          connectionCount--;
          // Clear sequence counters for any subscriptions belonging to this
          // connection. Use a copy of subscriptionIds since we don't mutate it.
          for (const subId of subscriptionIds) {
            subscriptionSequence.delete(subId);
          }
          if (clientAgentId) {
            clientWebSockets.delete(clientAgentId);
            clientSubscriptions.delete(clientAgentId);
          }
        });
      });

      // 6. Sync agent lifecycle → MAPServer agent registry
      lifecycleUnsubscribe = deps.agentManager.onLifecycleEvent((event) => {
        if (!mapServer) return;

        try {
          if (event.type === "spawned" || event.type === "started") {
            const agent = event.agent;
            // Register agent ONCE. spawn() fires "spawned" immediately followed
            // by "started", so without this guard the listener re-registers
            // on the second event — generating a fresh MAP ULID and overwriting
            // localIdToMapId. Consumers racing against that overwrite (like the
            // sidecar's lifecycle bridge, which snapshots peerMapId into hub
            // metadata) end up disagreeing with _macro/spawnAgent's return
            // value on which ULID refers to this agent.
            if (localIdToMapId.has(agent.id)) return;
            try {
              const registered = mapServer.agents.register({
                name: agent.name ?? agent.id,
                role: agent.role ?? "worker",
                state: "idle",
                metadata: {
                  peerAgentId: agent.id, // macro-agent's internal store id
                  parent: (agent as any).parent ?? null,
                  task: (agent as any).task ?? null,
                  cwd: (agent as any).cwd ?? null,
                },
              });
              // Track the ID mapping
              if (registered?.id) {
                mapIdToLocalId.set(registered.id, agent.id);
                localIdToMapId.set(agent.id, registered.id);
              }
            } catch {
              // Registration may fail if subscription system has no active sessions.
              // The agent still exists in macro-agent's AgentStore — MAP registry
              // is a secondary projection.
            }
          } else if (event.type === "stopped") {
            const mapId = localIdToMapId.get(event.agent.id);
            if (mapId) {
              try {
                mapServer.agents.unregister(mapId);
              } catch {
                // Agent may not be registered
              }
              mapIdToLocalId.delete(mapId);
              localIdToMapId.delete(event.agent.id);
            }
          }
        } catch {
          // Non-fatal — registry sync is best-effort
        }
      });

      // 7. Register existing agents (that were spawned before server started)
      for (const agent of deps.agentManager.list()) {
        try {
          const registered = mapServer.agents.register({
            name: agent.name ?? agent.id,
            role: agent.role ?? "worker",
            state: agent.state === "running" ? "busy" : "idle",
            metadata: {
              peerAgentId: agent.id,
              parent: agent.parent ?? null,
              task: agent.task ?? null,
            },
          });
          if (registered?.id) {
            mapIdToLocalId.set(registered.id, agent.id);
            localIdToMapId.set(agent.id, registered.id);
          }
        } catch {
          // Ignore registration failures for existing agents
        }
      }

      // 8. Start listening
      await new Promise<void>((resolve) => {
        httpServer!.listen(port, host, () => {
          const addr = httpServer!.address() as { port: number };
          const actualPort = addr.port;
          actualUrl = `ws://${host}:${actualPort}`;
          console.log(
            `[map-server] MAP server listening at ${actualUrl}${wsPath}`,
          );
          resolve();
        });
      });
    },

    async stop(): Promise<void> {
      if (lifecycleUnsubscribe) {
        lifecycleUnsubscribe();
        lifecycleUnsubscribe = null;
      }

      if (acpBridge) {
        acpBridge.close();
        acpBridge = null;
      }

      if (mapServer) {
        try {
          mapServer.close({ force: true });
        } catch {
          // Ignore close errors
        }
        mapServer = null;
      }

      if (wss) {
        // Force-close all WebSocket connections to unblock pending operations
        for (const ws of wss.clients) {
          try {
            ws.terminate();
          } catch {
            // ignore
          }
        }
        wss.close();
        wss = null;
      }

      if (httpServer) {
        await Promise.race([
          new Promise<void>((resolve) => {
            httpServer!.close(() => resolve());
          }),
          new Promise<void>((resolve) => setTimeout(resolve, 3000)),
        ]);
        httpServer = null;
      }

      connectionCount = 0;
    },

    getUrl(): string {
      return actualUrl ? `${actualUrl}${wsPath}` : `ws://${host}:${port}${wsPath}`;
    },

    getConnectionCount(): number {
      return connectionCount;
    },

    getLocalMapId(localAgentId: string): string | undefined {
      return localIdToMapId.get(localAgentId);
    },
  };
}
