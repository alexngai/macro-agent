/**
 * Combined Server
 *
 * Single HTTP server that hosts:
 * - WebSocket ACP protocol on /acp
 * - WebSocket MAP protocol on /map
 * - REST API + WebSocket subscriptions on /api/*
 */

import http from "http";
import express, { Express } from "express";
import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "http";
import type { Duplex } from "stream";
import type { EventStore } from "../store/event-store.js";
import type { AgentManager } from "../agent/agent-manager.js";
import type { TaskManager } from "../task/task-manager.js";
import type { MessageRouter } from "../router/message-router.js";
import type { PeerManager } from "../peer/peer-manager.js";
import type { CapabilityManager } from "../peer/capability-manager.js";
import { getAncestors, type RelevanceAgentSource } from "../activity/index.js";
import type { ActivityWatcher } from "../activity/watcher.js";
import { setupACPWebSocket } from "../acp/websocket-server.js";
import { createAPIApp, setupAPIWebSocket } from "../api/server.js";
import {
  createMAPAdapter,
  createMAPWebSocketHandler,
  registerWorkspaceFileExtensions,
  registerUpdateMetadataExtension,
  registerMCPBridgeExtensions,
  type MAPAdapter,
  type MAPAdapterServices,
  type MAPWebSocketHandler,
} from "../map/adapter/index.js";
import type { Agent, AgentId } from "../store/types/index.js";
import type { Address, SendOptions } from "../map/types.js";
import { createMailService, type MailService } from "../mail/mail-service.js";
import {
  createConversationMap,
  type ConversationMap,
} from "../mail/conversation-map.js";
import { createTurnRecorder } from "../mail/turn-recorder.js";
import {
  AgentTokenManager,
  generateToken as generateTokenFn,
  secureCompare,
} from "../auth/token.js";
import { TaskBackend, TaskToolProvider } from "../task/backend/types.js";

// ─────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────

export interface CombinedServerServices {
  eventStore: EventStore;
  agentManager: AgentManager;
  taskManager: TaskManager;
  messageRouter: MessageRouter;
  peerManager?: PeerManager;
  capabilityManager?: CapabilityManager;
  /** Optional activity watcher for event-driven waking */
  activityWatcher?: ActivityWatcher;
  /** Optional task backend for task tool bridge extensions */
  taskBackend?: TaskBackend;
  /** Optional task tool provider for dynamic task tools in thin-client mode */
  taskToolProvider?: TaskToolProvider;
  /** Mutable context holder for task tool provider agent_id injection */
  taskToolContext?: { agent_id: string };
  /** Per-agent token manager for MCP bridge authentication */
  agentTokenManager?: AgentTokenManager;
  /** Get connected opentasks project paths (for health endpoint) */
  getConnectedProjects?: () => string[];
}

export interface CombinedServerConfig {
  /** Port to listen on (default: 3001) */
  port?: number;

  /** Host to bind to (default: "localhost") */
  host?: string;

  /** Default working directory for ACP sessions */
  defaultCwd?: string;

  /** Enable CORS for REST API (default: true) */
  cors?: boolean;

  /** URL path for MAP connections (default: "/map") */
  mapPath?: string;

  /** Disable MAP protocol (default: false - MAP is enabled) */
  disableMap?: boolean;

  /** Server token for authentication. Auto-generated if not provided (unless noAuth is true). */
  serverToken?: string;

  /** Disable authentication entirely (for local development/testing) */
  noAuth?: boolean;
}

export interface CombinedServer {
  /** Start the server */
  start(): Promise<void>;

  /** Stop the server gracefully */
  stop(): Promise<void>;

  /** Get the server URL */
  getUrl(): string;

  /** Get number of ACP connections */
  getACPConnectionCount(): number;

  /** Get number of MAP connections */
  getMAPConnectionCount(): number;

  /** HTTP server */
  readonly httpServer: http.Server;

  /** Express app */
  readonly app: Express;

  /** MAP adapter (for testing) */
  readonly mapAdapter?: MAPAdapter;

  /** Mail service (for conversation tracking) */
  readonly mailService?: MailService;

  /** Conversation map (for agent-to-conversation tracking) */
  readonly conversationMap?: ConversationMap;

  /** Server token used for authentication (exposed for tests). Undefined when auth is disabled. */
  readonly serverToken?: string;
}

// ─────────────────────────────────────────────────────────────────
// MAP Services Wiring
// ─────────────────────────────────────────────────────────────────

/**
 * Get all descendants of an agent recursively.
 */
function getDescendantsRecursive(
  agentId: AgentId,
  agentManager: AgentManager,
): AgentId[] {
  const descendants: AgentId[] = [];
  const children = agentManager.getChildren(agentId);
  for (const child of children) {
    descendants.push(child.id);
    descendants.push(...getDescendantsRecursive(child.id, agentManager));
  }
  return descendants;
}

/**
 * Create MAPAdapterServices from CombinedServerServices.
 * Wires the internal services to the MAP adapter interface.
 */
function createMAPServices(
  services: CombinedServerServices,
): MAPAdapterServices {
  // Create agent source for getAncestors (needs lineage lookup)
  // RelevanceAgentSource expects getAgent to return null (not undefined) when not found
  const agentSource: RelevanceAgentSource = {
    getAgent: (id) => services.agentManager.get(id),
    listAgents: () => services.agentManager.list(),
  };

  // Map Agent → MAPAdapterServices AgentState (handle null→undefined, created_at→createdAt)
  const mapAgent = (agent: Agent | null) =>
    agent
      ? {
          id: agent.id,
          name: agent.name,
          role: agent.role,
          state: agent.state,
          parent: agent.parent ?? undefined,
          createdAt: agent.created_at,
          metadata: agent.metadata,
        }
      : undefined;

  return {
    getAgent: (id) => mapAgent(services.agentManager.get(id)),
    listAgents: (filter) =>
      services.agentManager.list(filter).map((a) => mapAgent(a)!),
    sendMessage: async (
      from: AgentId,
      to: Address,
      content: string,
      options?: SendOptions,
    ) => {
      const result = await services.messageRouter.sendToAddress({
        from,
        to,
        content,
        options: options ? { priority: options.priority } : undefined,
      });
      return { delivered: result.delivered };
    },
    getAncestors: (agentId) => getAncestors(agentId, agentSource),
    getDescendants: (agentId) =>
      getDescendantsRecursive(agentId, services.agentManager),
    // Full services for ACP-over-MAP support
    agentManager: services.agentManager,
    eventStore: services.eventStore,
    taskManager: services.taskManager,
  };
}

// ─────────────────────────────────────────────────────────────────
// Server Implementation
// ─────────────────────────────────────────────────────────────────

export function createCombinedServer(
  services: CombinedServerServices,
  config: CombinedServerConfig = {},
): CombinedServer {
  const {
    port = 3001,
    host = "localhost",
    defaultCwd = process.cwd(),
    cors = true,
    mapPath = "/map",
    disableMap = false,
    serverToken: configToken,
    noAuth = false,
  } = config;

  // Resolve server token: disabled > config > env > none (no auth by default)
  const resolvedServerToken = noAuth
    ? undefined
    : (configToken ?? process.env.MACRO_SERVER_SECRET ?? undefined);

  // Set up mail service and conversation map (always created, independent of MAP)
  const mailService = createMailService({ eventStore: services.eventStore });
  const conversationMap = createConversationMap();

  // Wire mail services into AgentManager for conversation lifecycle
  if (services.agentManager.setMailServices) {
    services.agentManager.setMailServices(mailService, conversationMap);
  }

  // Wire turn recorder into MessageRouter for automatic turn tracking
  if (services.messageRouter.setTurnRecorder) {
    const turnRecorder = createTurnRecorder({
      mailService,
      conversationMap,
      eventStore: services.eventStore,
    });
    services.messageRouter.setTurnRecorder(turnRecorder);
  }

  // Create Express app with API routes (include mail services)
  const app = createAPIApp(
    { ...services, mailService, conversationMap },
    { cors, serverToken: resolvedServerToken },
  );

  // Create HTTP server with Express
  const httpServer = http.createServer(app);

  // Create WebSocket servers in noServer mode
  const acpWss = new WebSocketServer({ noServer: true });
  const apiWss = new WebSocketServer({ noServer: true });

  // Set up ACP WebSocket handling
  const acpHandler = setupACPWebSocket(acpWss, services, { defaultCwd });

  // Set up API WebSocket handling (pass app to share state)
  const apiHandler = setupAPIWebSocket(apiWss, services, app);

  // Set up MAP protocol handling (unless disabled)
  let mapAdapter: MAPAdapter | undefined;
  let mapHandler: MAPWebSocketHandler | undefined;

  if (!disableMap) {
    const mapServices = {
      ...createMAPServices(services),
      defaultCwd,
      mailService,
    };
    mapAdapter = createMAPAdapter(
      { name: "macro-agent", version: "1.0.0" },
      mapServices,
    );

    // Register workspace file extensions for TUI file attachment.
    // Uses defaultCwd (project root) as the workspace path for all agents,
    // since the head manager doesn't have an isolated worktree.
    registerWorkspaceFileExtensions(mapAdapter, {
      getWorkspace: () => ({ path: defaultCwd }) as any,
      agentExists: () => true,
    });

    // Register generic metadata update extension
    registerUpdateMetadataExtension(mapAdapter, {
      getAgent: (id) => services.agentManager.get(id),
      updateAgentMetadata: (id, updates) =>
        services.eventStore.updateAgentMetadata(id, updates),
    });

    // Register MCP bridge extensions for thin-client MCP subprocesses
    registerMCPBridgeExtensions(mapAdapter, {
      eventStore: services.eventStore,
      agentManager: services.agentManager,
      taskManager: services.taskManager,
      messageRouter: services.messageRouter,
      peerManager: services.peerManager,
      activityWatcher: services.activityWatcher,
      taskBackend: services.taskBackend,
      taskToolProvider: services.taskToolProvider,
      taskToolContext: services.taskToolContext,
      agentTokenManager: services.agentTokenManager,
    });

    mapHandler = createMAPWebSocketHandler(mapAdapter);
  }

  // Handle upgrade requests - route by path
  httpServer.on(
    "upgrade",
    (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      const parsedUrl = new URL(
        request.url ?? "/",
        `http://${request.headers.host}`,
      );
      const pathname = parsedUrl.pathname;

      // Validate server token on WebSocket upgrade (skip when auth disabled)
      if (resolvedServerToken) {
        const urlToken = parsedUrl.searchParams.get("token");
        if (!urlToken || !secureCompare(urlToken, resolvedServerToken)) {
          socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
          socket.destroy();
          return;
        }
      }

      if (pathname === "/acp") {
        acpWss.handleUpgrade(request, socket, head, (ws) => {
          acpWss.emit("connection", ws, request);
        });
      } else if (pathname === "/api/ws") {
        apiWss.handleUpgrade(request, socket, head, (ws) => {
          apiWss.emit("connection", ws, request);
        });
      } else if (pathname === mapPath && mapHandler) {
        // MAP protocol connection
        acpWss.handleUpgrade(request, socket, head, (ws) => {
          mapHandler.handleConnection(ws, request);
        });
      } else {
        // Unknown WebSocket path
        socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
        socket.destroy();
      }
    },
  );

  // Add health endpoint
  app.get("/health", (_req, res) => {
    const connectedProjects = services.getConnectedProjects?.() ?? [];
    res.json({
      status: "ok",
      acp_connections: acpHandler.getConnectionCount(),
      map_connections: mapHandler?.getConnectionCount() ?? 0,
      opentasks: {
        connected_projects: connectedProjects,
        project_count: connectedProjects.length,
      },
      timestamp: Date.now(),
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Server Lifecycle
  // ─────────────────────────────────────────────────────────────────

  async function start(): Promise<void> {
    // Start MAP adapter if enabled
    if (mapAdapter && !mapAdapter.isRunning()) {
      await mapAdapter.start();
    }

    return new Promise((resolve, reject) => {
      httpServer.on("error", reject);
      httpServer.listen(port, host, () => {
        httpServer.removeListener("error", reject);
        const tokenParam = resolvedServerToken ? `?token=${resolvedServerToken}` : "";
        console.error(`[combined] Server listening on http://${host}:${port}`);
        console.error(`[combined]   ACP WebSocket: ws://${host}:${port}/acp${tokenParam}`);
        if (mapHandler) {
          console.error(
            `[combined]   MAP WebSocket: ws://${host}:${port}${mapPath}${tokenParam}`,
          );
        }
        console.error(
          `[combined]   API WebSocket: ws://${host}:${port}/api/ws${tokenParam}`,
        );
        console.error(`[combined]   REST API: http://${host}:${port}/api/*`);
        if (resolvedServerToken) {
          console.error(`[combined]   Server token: ${resolvedServerToken.substring(0, 8)}...`);
        } else {
          console.error(`[combined]   Auth: disabled`);
        }
        resolve();
      });
    });
  }

  async function stop(): Promise<void> {
    console.error(`[combined] Shutting down...`);

    // Close ACP connections
    acpHandler.closeAll();

    // Close MAP connections
    mapHandler?.closeAll();

    // Stop MAP adapter
    if (mapAdapter?.isRunning()) {
      await mapAdapter.stop();
    }

    // Close API WebSocket connections
    apiHandler.closeAll();

    // Close WebSocket servers
    await Promise.all([
      new Promise<void>((resolve) => acpWss.close(() => resolve())),
      new Promise<void>((resolve) => apiWss.close(() => resolve())),
    ]);

    // Close HTTP server
    await new Promise<void>((resolve, reject) => {
      httpServer.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    console.error(`[combined] Server stopped`);
  }

  function getUrl(): string {
    const addr = httpServer.address();
    if (addr && typeof addr === "object") {
      return `http://${host}:${addr.port}`;
    }
    return `http://${host}:${port}`;
  }

  function getACPConnectionCount(): number {
    return acpHandler.getConnectionCount();
  }

  function getMAPConnectionCount(): number {
    return mapHandler?.getConnectionCount() ?? 0;
  }

  return {
    start,
    stop,
    getUrl,
    getACPConnectionCount,
    getMAPConnectionCount,
    httpServer,
    app,
    mapAdapter,
    mailService,
    conversationMap,
    serverToken: resolvedServerToken,
  };
}
