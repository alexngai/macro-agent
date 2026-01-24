/**
 * API Server
 *
 * Express server with REST API and WebSocket support for the multi-agent system.
 *
 * Can be used in two modes:
 * 1. Standalone: createAPIServer() creates its own HTTP server
 * 2. Shared: createAPIApp() + setupAPIWebSocket() for external HTTP server
 */

import express, { Express, Request, Response, NextFunction } from "express";
import { WebSocketServer, WebSocket } from "ws";
import http from "http";
import type { EventStore } from "../store/event-store.js";
import type { AgentManager } from "../agent/agent-manager.js";
import type { TaskManager } from "../task/task-manager.js";
import type { MessageRouter } from "../router/message-router.js";
import type { Agent, Task, Event } from "../store/types/index.js";
import type {
  SystemStatus,
  InitRequest,
  InitResponse,
  ConversationMessageRequest,
  ConversationHistoryResponse,
  AgentSummary,
  AgentDetail,
  AgentListResponse,
  HierarchyResponse,
  HierarchyNode,
  TaskSummary,
  TaskDetail,
  TaskListResponse,
  EventSummary,
  EventListResponse,
  AgentQueryParams,
  TaskQueryParams,
  EventQueryParams,
  APIError,
  WSMessage,
  WSSubscribeMessage,
  WSAgentUpdate,
  WSTaskUpdate,
  InjectContextRequest,
  InjectContextResponse,
} from "./types.js";
import {
  injectContext,
  type InjectionDeps,
} from "../steering/index.js";
import type { AgentId } from "../store/types/index.js";

// ─────────────────────────────────────────────────────────────────
// Server Configuration
// ─────────────────────────────────────────────────────────────────

export interface APIServerConfig {
  /** Port to listen on */
  port?: number;

  /** Host to bind to */
  host?: string;

  /** Enable CORS */
  cors?: boolean;

  /** Grace period in milliseconds for in-flight work during shutdown (default: 5000) */
  shutdownGracePeriodMs?: number;
}

export interface APIServices {
  eventStore: EventStore;
  agentManager: AgentManager;
  taskManager: TaskManager;
  messageRouter: MessageRouter;
}

// ─────────────────────────────────────────────────────────────────
// API Server Instance
// ─────────────────────────────────────────────────────────────────

export interface StopOptions {
  /** Force immediate shutdown, skipping grace period */
  force?: boolean;
}

export interface APIServer {
  /** Express app for testing */
  app: Express;

  /** HTTP server */
  server: http.Server;

  /** WebSocket server */
  wss: WebSocketServer;

  /** Start the server */
  start(): Promise<void>;

  /**
   * Stop the server gracefully.
   * 1. Stop accepting new connections
   * 2. Wait grace period for in-flight prompts
   * 3. Close WebSocket connections with 1001 "going away"
   * 4. Terminate running agents
   * 5. Persist and close event store
   */
  stop(options?: StopOptions): Promise<void>;

  /** Get current status */
  getStatus(): SystemStatus;

  /** Register signal handlers for graceful shutdown */
  registerSignalHandlers(): void;
}

// ─────────────────────────────────────────────────────────────────
// Server State
// ─────────────────────────────────────────────────────────────────

interface ServerState {
  initialized: boolean;
  headManagerId?: string;
  startedAt?: number;
  conversationHistory: Array<{
    role: "user" | "assistant";
    content: string;
    agent_id?: string;
    timestamp: number;
  }>;
  /** Tracks in-flight prompt promises for graceful shutdown */
  inFlightPrompts: Map<string, Promise<void>>;
  /** Whether shutdown is in progress */
  isShuttingDown: boolean;
}

// ─────────────────────────────────────────────────────────────────
// WebSocket Client Tracking
// ─────────────────────────────────────────────────────────────────

interface WSClient {
  ws: WebSocket;
  subscriptions: Set<string>;
}

/**
 * API WebSocket handler interface (shared server mode)
 */
export interface APIWebSocketHandler {
  /** Get the number of active connections */
  getConnectionCount(): number;

  /** Close all connections gracefully */
  closeAll(): void;
}

/**
 * Shared state for API app and WebSocket handler
 */
export interface APISharedState {
  initialized: boolean;
  headManagerId?: string;
  startedAt?: number;
  conversationHistory: Array<{
    role: "user" | "assistant";
    content: string;
    agent_id?: string;
    timestamp: number;
  }>;
  inFlightPrompts: Map<string, Promise<void>>;
  isShuttingDown: boolean;
  wsClients: Set<WSClient>;
  broadcast: (channel: string, message: WSMessage) => void;
}

/**
 * Create shared state for API app and WebSocket handler
 */
export function createAPISharedState(): APISharedState {
  const wsClients = new Set<WSClient>();

  const broadcast = (channel: string, message: WSMessage): void => {
    const data = JSON.stringify(message);
    for (const client of wsClients) {
      if (client.subscriptions.has(channel) && client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(data);
      }
    }
  };

  return {
    initialized: false,
    conversationHistory: [],
    inFlightPrompts: new Map(),
    isShuttingDown: false,
    wsClients,
    broadcast,
  };
}

// ─────────────────────────────────────────────────────────────────
// Create API Server
// ─────────────────────────────────────────────────────────────────

export function createAPIServer(
  services: APIServices,
  config: APIServerConfig = {}
): APIServer {
  const { port = 3000, host = "localhost", cors = true, shutdownGracePeriodMs = 5000 } = config;
  const { eventStore, agentManager, taskManager } = services;

  // Server state
  const state: ServerState = {
    initialized: false,
    conversationHistory: [],
    inFlightPrompts: new Map(),
    isShuttingDown: false,
  };

  // WebSocket clients
  const wsClients = new Set<WSClient>();

  // Create Express app
  const app = express();

  // Middleware
  app.use(express.json());

  if (cors) {
    app.use((_req: Request, res: Response, next: NextFunction) => {
      res.header("Access-Control-Allow-Origin", "*");
      res.header("Access-Control-Allow-Headers", "Content-Type");
      res.header("Access-Control-Allow-Methods", "GET, POST, DELETE");
      next();
    });
  }

  // ─────────────────────────────────────────────────────────────────
  // Helper Functions
  // ─────────────────────────────────────────────────────────────────

  function agentToSummary(agent: Agent): AgentSummary {
    return {
      id: agent.id,
      session_id: agent.session_id,
      task: agent.task ?? "No task",
      state: agent.state,
      parent: agent.parent,
      children_count: agentManager.getChildren(agent.id).length,
      created_at: agent.created_at,
    };
  }

  function agentToDetail(agent: Agent): AgentDetail {
    return {
      ...agentToSummary(agent),
      lineage: agent.lineage,
      task_id: agent.task_id,
      config: agent.config as Record<string, unknown>,
      started_at: agent.started_at,
      stopped_at: agent.stopped_at,
      stop_reason: agent.stop_reason,
    };
  }

  function taskToSummary(task: Task): TaskSummary {
    return {
      id: task.id,
      description: task.description,
      status: task.status,
      assigned_agent: task.assigned_agent,
      created_at: task.created_at,
    };
  }

  function taskToDetail(task: Task): TaskDetail {
    return {
      ...taskToSummary(task),
      parent_task: task.parent_task,
      subtasks: task.subtasks ?? [],
      created_by: task.created_by,
      inputs: task.inputs,
      outputs: task.outputs,
      artifacts: task.artifacts,
      started_at: task.started_at,
      completed_at: task.completed_at,
    };
  }

  function eventToSummary(event: Event): EventSummary {
    let summary = "";
    switch (event.type) {
      case "spawn":
        summary = `Agent ${event.payload.agent_id} spawned`;
        break;
      case "terminate":
        summary = `Agent terminated: ${event.payload.reason}`;
        break;
      case "status":
        summary = `${event.payload.status_type}: ${event.payload.summary}`;
        break;
      case "message":
        summary = `Message: ${String(event.payload.content).substring(0, 50)}...`;
        break;
      case "task":
        summary = `Task ${event.payload.action}: ${event.payload.task_id}`;
        break;
      default:
        summary = `${event.type} event`;
    }

    return {
      id: event.id,
      type: event.type,
      timestamp: event.timestamp,
      source_agent_id: event.source.agent_id,
      target_agent_id: event.target?.agent_id,
      summary,
    };
  }

  function buildHierarchyNode(agent: Agent): HierarchyNode {
    const children = agentManager.getChildren(agent.id);
    return {
      agent_id: agent.id,
      task: agent.task ?? "No task",
      state: agent.state,
      children: children.map(buildHierarchyNode),
    };
  }

  function sendError(res: Response, status: number, code: string, message: string): void {
    const error: APIError = { error: message, code };
    res.status(status).json(error);
  }

  function broadcastToChannel(channel: string, message: WSMessage): void {
    const data = JSON.stringify(message);
    for (const client of wsClients) {
      if (client.subscriptions.has(channel) && client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(data);
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // API Routes
  // ─────────────────────────────────────────────────────────────────

  // POST /api/init - Initialize the system
  app.post("/api/init", async (req: Request, res: Response) => {
    try {
      if (state.initialized) {
        return sendError(res, 400, "ALREADY_INITIALIZED", "System already initialized");
      }

      const body = req.body as InitRequest;
      const cwd = body.cwd ?? process.cwd();

      const headManager = await agentManager.getOrCreateHeadManager({
        cwd,
        systemPrompt: body.system_prompt,
        permissionMode: body.permission_mode,
      });

      state.initialized = true;
      state.headManagerId = headManager.id;
      state.startedAt = Date.now();

      const response: InitResponse = {
        success: true,
        head_manager_id: headManager.id,
        session_id: headManager.session_id,
      };

      res.json(response);
    } catch (error) {
      sendError(res, 500, "INIT_FAILED", `Failed to initialize: ${error}`);
    }
  });

  // GET /api/status - Get system status
  app.get("/api/status", (_req: Request, res: Response) => {
    const status = getStatus();
    res.json(status);
  });

  // POST /api/conversation/message - Send message to head manager
  app.post("/api/conversation/message", async (req: Request, res: Response) => {
    // Reject new messages during shutdown
    if (state.isShuttingDown) {
      return sendError(res, 503, "SHUTTING_DOWN", "Server is shutting down");
    }

    const promptId = `prompt_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    try {
      if (!state.initialized || !state.headManagerId) {
        return sendError(res, 400, "NOT_INITIALIZED", "System not initialized");
      }

      const body = req.body as ConversationMessageRequest;
      if (!body.message) {
        return sendError(res, 400, "MISSING_MESSAGE", "Message is required");
      }

      // Add user message to history
      state.conversationHistory.push({
        role: "user",
        content: body.message,
        timestamp: Date.now(),
      });

      // Broadcast to conversation channel
      broadcastToChannel("conversation", {
        type: "message",
        data: {
          role: "user",
          content: body.message,
          timestamp: Date.now(),
        },
      });

      // Track this prompt as in-flight
      let resolvePrompt: () => void;
      const promptPromise = new Promise<void>((resolve) => {
        resolvePrompt = resolve;
      });
      state.inFlightPrompts.set(promptId, promptPromise);

      // Send to head manager and collect response
      let responseContent = "";
      try {
        for await (const update of agentManager.prompt(state.headManagerId, body.message)) {
          if ("sessionUpdate" in update && update.sessionUpdate === "agent_message_chunk") {
            const chunk = update as { content: { type: string; text?: string } };
            if (chunk.content.type === "text" && chunk.content.text) {
              responseContent += chunk.content.text;
            }
          }
        }
      } finally {
        // Mark prompt as complete
        resolvePrompt!();
        state.inFlightPrompts.delete(promptId);
      }

      // Add assistant response to history
      state.conversationHistory.push({
        role: "assistant",
        content: responseContent,
        agent_id: state.headManagerId,
        timestamp: Date.now(),
      });

      // Broadcast response
      broadcastToChannel("conversation", {
        type: "message",
        data: {
          role: "assistant",
          content: responseContent,
          agent_id: state.headManagerId,
          timestamp: Date.now(),
        },
      });

      res.json({
        content: responseContent,
        agent_id: state.headManagerId,
        message_id: `msg_${Date.now()}`,
      });
    } catch (error) {
      // Ensure we clean up the in-flight prompt on error
      state.inFlightPrompts.delete(promptId);
      sendError(res, 500, "MESSAGE_FAILED", `Failed to process message: ${error}`);
    }
  });

  // GET /api/conversation/history - Get conversation history
  app.get("/api/conversation/history", (req: Request, res: Response) => {
    const limit = parseInt(req.query.limit as string) || 50;
    const offset = parseInt(req.query.offset as string) || 0;

    const history = state.conversationHistory.slice(offset, offset + limit);

    const response: ConversationHistoryResponse = {
      history,
      total: state.conversationHistory.length,
    };

    res.json(response);
  });

  // GET /api/agents - List agents
  app.get("/api/agents", (req: Request, res: Response) => {
    const params = req.query as unknown as AgentQueryParams;
    let agents = agentManager.list();

    // Apply filters
    if (params.state) {
      agents = agents.filter((a) => a.state === params.state);
    }
    if (params.parent !== undefined) {
      const parentValue = params.parent === "null" ? null : params.parent;
      agents = agents.filter((a) => a.parent === parentValue);
    }

    const total = agents.length;

    // Apply pagination
    const offset = params.offset ?? 0;
    const limit = params.limit ?? 50;
    agents = agents.slice(offset, offset + limit);

    const response: AgentListResponse = {
      agents: agents.map(agentToSummary),
      total,
    };

    res.json(response);
  });

  // GET /api/agents/:id - Get agent details
  app.get("/api/agents/:id", (req: Request, res: Response) => {
    const id = req.params.id as string;
    const agent = agentManager.get(id);
    if (!agent) {
      return sendError(res, 404, "AGENT_NOT_FOUND", `Agent not found: ${id}`);
    }
    res.json(agentToDetail(agent));
  });

  // GET /api/agents/:id/hierarchy - Get agent hierarchy
  app.get("/api/agents/:id/hierarchy", (req: Request, res: Response) => {
    const id = req.params.id as string;
    const agent = agentManager.get(id);
    if (!agent) {
      return sendError(res, 404, "AGENT_NOT_FOUND", `Agent not found: ${id}`);
    }

    const hierarchy = agentManager.getHierarchy(id);
    if (!hierarchy) {
      return sendError(res, 500, "HIERARCHY_ERROR", "Failed to build hierarchy");
    }

    const response: HierarchyResponse = {
      tree: buildHierarchyNode(agent),
      depth: hierarchy.depth,
      total_agents: hierarchy.totalAgents,
    };

    res.json(response);
  });

  // GET /api/tasks - List tasks
  app.get("/api/tasks", (req: Request, res: Response) => {
    const params = req.query as unknown as TaskQueryParams;
    let tasks = taskManager.list();

    // Apply filters
    if (params.status) {
      tasks = tasks.filter((t) => t.status === params.status);
    }
    if (params.assigned_agent) {
      tasks = tasks.filter((t) => t.assigned_agent === params.assigned_agent);
    }

    const total = tasks.length;

    // Apply pagination
    const offset = params.offset ?? 0;
    const limit = params.limit ?? 50;
    tasks = tasks.slice(offset, offset + limit);

    const response: TaskListResponse = {
      tasks: tasks.map(taskToSummary),
      total,
    };

    res.json(response);
  });

  // GET /api/tasks/:id - Get task details
  app.get("/api/tasks/:id", (req: Request, res: Response) => {
    const id = req.params.id as string;
    const task = taskManager.get(id);
    if (!task) {
      return sendError(res, 404, "TASK_NOT_FOUND", `Task not found: ${id}`);
    }
    res.json(taskToDetail(task));
  });

  // GET /api/events - List events with filters
  app.get("/api/events", (req: Request, res: Response) => {
    const params = req.query as unknown as EventQueryParams;

    const events = eventStore.query({
      type: params.type as any,
      source_agent_id: params.source_agent_id,
      target_agent_id: params.target_agent_id,
      after: params.after,
      before: params.before,
      limit: (params.limit ?? 50) + 1, // Get one extra to check has_more
    });

    const limit = params.limit ?? 50;
    const hasMore = events.length > limit;
    const resultEvents = hasMore ? events.slice(0, limit) : events;

    const response: EventListResponse = {
      events: resultEvents.map(eventToSummary),
      total: resultEvents.length,
      has_more: hasMore,
    };

    res.json(response);
  });

  // POST /api/agents/:id/inject - Inject context into agent session
  app.post("/api/agents/:id/inject", async (req: Request, res: Response) => {
    const id = req.params.id as AgentId;
    const body = req.body as InjectContextRequest;

    // Validate content
    if (!body.content) {
      return sendError(res, 400, "MISSING_CONTENT", "Content is required");
    }

    // Check agent exists
    const agent = agentManager.get(id);
    if (!agent) {
      return sendError(res, 404, "AGENT_NOT_FOUND", `Agent not found: ${id}`);
    }

    // Create injection deps
    const injectionDeps: InjectionDeps = {
      getSession(agentId: AgentId) {
        const session = agentManager.getSession(agentId);
        if (!session) return null;
        return {
          inject: async (content: string) => session.inject(content),
          supportsInject: () => session.supportsInject(),
          checkInjectSupport: async () => session.supportsInject(),
          interruptWith: (content: string) => session.interruptWith(content),
        };
      },
      isPrompting(agentId: AgentId) {
        return agentManager.isPrompting(agentId);
      },
      async sendMessage(
        _fromAgentId: AgentId | undefined,
        toAgentId: AgentId,
        content: string,
        priority: "high"
      ) {
        await services.messageRouter.send({
          from: { agent_id: "__human__" as AgentId },
          to: { agent_id: toAgentId },
          content,
          priority,
        });
      },
    };

    try {
      const result = await injectContext(injectionDeps, id, body.content, {
        urgent: body.urgent,
        allowInterrupt: true,
        source: { type: "human" },
        reason: body.reason,
      });

      const response: InjectContextResponse = {
        success: result.success,
        method: result.method,
        error: result.error,
        note: result.note,
      };

      if (result.success) {
        res.json(response);
      } else {
        res.status(500).json(response);
      }
    } catch (error) {
      sendError(res, 500, "INJECTION_FAILED", `Failed to inject context: ${error}`);
    }
  });

  // ─────────────────────────────────────────────────────────────────
  // HTTP Server
  // ─────────────────────────────────────────────────────────────────

  const server = http.createServer(app);

  // ─────────────────────────────────────────────────────────────────
  // WebSocket Server
  // ─────────────────────────────────────────────────────────────────

  const wss = new WebSocketServer({ server });

  wss.on("connection", (ws: WebSocket) => {
    const client: WSClient = {
      ws,
      subscriptions: new Set(),
    };
    wsClients.add(client);

    ws.on("message", (data: Buffer) => {
      try {
        const message = JSON.parse(data.toString()) as { type: string; channel?: string };

        if (message.type === "subscribe" && message.channel) {
          client.subscriptions.add(message.channel);
          ws.send(JSON.stringify({ type: "subscribed", channel: message.channel }));
        } else if (message.type === "unsubscribe" && message.channel) {
          client.subscriptions.delete(message.channel);
          ws.send(JSON.stringify({ type: "unsubscribed", channel: message.channel }));
        }
      } catch {
        ws.send(JSON.stringify({ type: "error", error: "Invalid message format" }));
      }
    });

    ws.on("close", () => {
      wsClients.delete(client);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Event Store Listeners for Real-time Updates
  // ─────────────────────────────────────────────────────────────────

  // Listen for agent changes
  eventStore.onAgentChange((agentId, agent) => {
    if (!agent) return;

    const update: WSAgentUpdate = {
      type: "agent_update",
      action: agent.state === "stopped" ? "stopped" : "started",
      agent: agentToSummary(agent),
    };

    broadcastToChannel("agents", update);
  });

  // Listen for task changes
  eventStore.onTaskChange((taskId, task) => {
    if (!task) return;

    const update: WSTaskUpdate = {
      type: "task_update",
      action: task.status === "completed" ? "completed" : "status_change",
      task: taskToSummary(task),
    };

    broadcastToChannel("tasks", update);
  });

  // ─────────────────────────────────────────────────────────────────
  // Server Lifecycle
  // ─────────────────────────────────────────────────────────────────

  function getStatus(): SystemStatus {
    const agents = agentManager.list();
    const tasks = taskManager.list();

    return {
      initialized: state.initialized,
      head_manager_id: state.headManagerId,
      agents: {
        total: agents.length,
        running: agents.filter((a) => a.state === "running").length,
        stopped: agents.filter((a) => a.state === "stopped").length,
      },
      tasks: {
        total: tasks.length,
        pending: tasks.filter((t) => t.status === "pending").length,
        in_progress: tasks.filter((t) => t.status === "in_progress").length,
        completed: tasks.filter((t) => t.status === "completed").length,
        failed: tasks.filter((t) => t.status === "failed").length,
      },
      uptime: state.startedAt ? Date.now() - state.startedAt : 0,
      started_at: state.startedAt,
    };
  }

  async function start(): Promise<void> {
    return new Promise((resolve) => {
      server.listen(port, host, () => {
        resolve();
      });
    });
  }

  /**
   * Helper function to create a delay promise
   */
  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Get all in-flight prompt promises
   */
  function getInFlightPrompts(): Promise<void>[] {
    return Array.from(state.inFlightPrompts.values());
  }

  async function stop(options?: StopOptions): Promise<void> {
    // Prevent concurrent shutdown calls
    if (state.isShuttingDown) {
      return;
    }
    state.isShuttingDown = true;

    const gracePeriod = options?.force ? 0 : shutdownGracePeriodMs;

    // 1. Stop accepting new connections
    server.close();

    // 2. Wait grace period for in-flight work
    if (gracePeriod > 0) {
      const inFlight = getInFlightPrompts();
      if (inFlight.length > 0) {
        await Promise.race([
          Promise.all(inFlight),
          sleep(gracePeriod),
        ]);
      }
    }

    // 3. Close WebSocket connections with 1001 "going away"
    for (const client of wsClients) {
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.close(1001, "Server shutting down");
      }
    }
    wsClients.clear();

    // 4. Terminate running agents
    await agentManager.close();

    // 5-6. Persist and close event store
    await eventStore.persist();
    await eventStore.close();
  }

  /**
   * Register signal handlers for graceful shutdown.
   * Should be called after server.start() in production.
   */
  function registerSignalHandlers(): void {
    let shutdownInProgress = false;

    const handleSignal = async (signal: string) => {
      if (shutdownInProgress) {
        // Force exit on second signal
        process.exit(1);
      }
      shutdownInProgress = true;

      console.log(`\nReceived ${signal}, shutting down gracefully...`);

      try {
        await stop();
        console.log("Server shutdown complete.");
        process.exit(0);
      } catch (error) {
        console.error("Error during shutdown:", error);
        process.exit(1);
      }
    };

    process.on("SIGINT", () => handleSignal("SIGINT"));
    process.on("SIGTERM", () => handleSignal("SIGTERM"));
  }

  return {
    app,
    server,
    wss,
    start,
    stop,
    getStatus,
    registerSignalHandlers,
  };
}

// ─────────────────────────────────────────────────────────────────
// Shared Server Mode (createAPIApp + setupAPIWebSocket)
// ─────────────────────────────────────────────────────────────────

/**
 * Create Express app with API routes for use with an external HTTP server.
 *
 * Use this when you want to share an HTTP server with other services.
 *
 * @param services - Shared services (EventStore, AgentManager, etc.)
 * @param config - Configuration options
 * @returns Express app
 */
export function createAPIApp(
  services: Pick<APIServices, "eventStore" | "agentManager" | "taskManager" | "messageRouter">,
  config: { cors?: boolean } = {}
): Express {
  const { cors = true } = config;
  const { agentManager, taskManager, messageRouter } = services;

  // Create shared state
  const state = createAPISharedState();

  // Create Express app
  const app = express();

  // Store state on app for access by setupAPIWebSocket
  (app as any).__apiState = state;
  (app as any).__apiServices = services;

  // Middleware
  app.use(express.json());

  if (cors) {
    app.use((_req: Request, res: Response, next: NextFunction) => {
      res.header("Access-Control-Allow-Origin", "*");
      res.header("Access-Control-Allow-Headers", "Content-Type");
      res.header("Access-Control-Allow-Methods", "GET, POST, DELETE");
      next();
    });
  }

  // ─────────────────────────────────────────────────────────────────
  // Helper Functions
  // ─────────────────────────────────────────────────────────────────

  function agentToSummary(agent: Agent): AgentSummary {
    return {
      id: agent.id,
      session_id: agent.session_id,
      task: agent.task ?? "No task",
      state: agent.state,
      parent: agent.parent,
      children_count: agentManager.getChildren(agent.id).length,
      created_at: agent.created_at,
    };
  }

  function agentToDetail(agent: Agent): AgentDetail {
    return {
      ...agentToSummary(agent),
      lineage: agent.lineage,
      task_id: agent.task_id,
      config: agent.config as Record<string, unknown>,
      started_at: agent.started_at,
      stopped_at: agent.stopped_at,
      stop_reason: agent.stop_reason,
    };
  }

  function taskToSummary(task: Task): TaskSummary {
    return {
      id: task.id,
      description: task.description,
      status: task.status,
      assigned_agent: task.assigned_agent,
      created_at: task.created_at,
    };
  }

  function taskToDetail(task: Task): TaskDetail {
    return {
      ...taskToSummary(task),
      parent_task: task.parent_task,
      subtasks: task.subtasks ?? [],
      created_by: task.created_by,
      inputs: task.inputs,
      outputs: task.outputs,
      artifacts: task.artifacts,
      started_at: task.started_at,
      completed_at: task.completed_at,
    };
  }

  function eventToSummary(event: Event): EventSummary {
    let summary = "";
    switch (event.type) {
      case "spawn":
        summary = `Agent ${event.payload.agent_id} spawned`;
        break;
      case "terminate":
        summary = `Agent terminated: ${event.payload.reason}`;
        break;
      case "status":
        summary = `${event.payload.status_type}: ${event.payload.summary}`;
        break;
      case "message":
        summary = `Message: ${String(event.payload.content).substring(0, 50)}...`;
        break;
      case "task":
        summary = `Task ${event.payload.action}: ${event.payload.task_id}`;
        break;
      default:
        summary = `${event.type} event`;
    }

    return {
      id: event.id,
      type: event.type,
      timestamp: event.timestamp,
      source_agent_id: event.source.agent_id,
      target_agent_id: event.target?.agent_id,
      summary,
    };
  }

  function buildHierarchyNode(agent: Agent): HierarchyNode {
    const children = agentManager.getChildren(agent.id);
    return {
      agent_id: agent.id,
      task: agent.task ?? "No task",
      state: agent.state,
      children: children.map(buildHierarchyNode),
    };
  }

  function sendError(res: Response, status: number, code: string, message: string): void {
    const error: APIError = { error: message, code };
    res.status(status).json(error);
  }

  // ─────────────────────────────────────────────────────────────────
  // API Routes
  // ─────────────────────────────────────────────────────────────────

  // POST /api/init - Initialize the system
  app.post("/api/init", async (req: Request, res: Response) => {
    try {
      if (state.initialized) {
        return sendError(res, 400, "ALREADY_INITIALIZED", "System already initialized");
      }

      const body = req.body as InitRequest;
      const cwd = body.cwd ?? process.cwd();

      const headManager = await agentManager.getOrCreateHeadManager({
        cwd,
        systemPrompt: body.system_prompt,
        permissionMode: body.permission_mode,
      });

      state.initialized = true;
      state.headManagerId = headManager.id;
      state.startedAt = Date.now();

      const response: InitResponse = {
        success: true,
        head_manager_id: headManager.id,
        session_id: headManager.session_id,
      };

      res.json(response);
    } catch (error) {
      sendError(res, 500, "INIT_FAILED", `Failed to initialize: ${error}`);
    }
  });

  // GET /api/status - Get system status
  app.get("/api/status", (_req: Request, res: Response) => {
    const agents = agentManager.list();
    const tasks = taskManager.list();

    const status: SystemStatus = {
      initialized: state.initialized,
      head_manager_id: state.headManagerId,
      agents: {
        total: agents.length,
        running: agents.filter((a) => a.state === "running").length,
        stopped: agents.filter((a) => a.state === "stopped").length,
      },
      tasks: {
        total: tasks.length,
        pending: tasks.filter((t) => t.status === "pending").length,
        in_progress: tasks.filter((t) => t.status === "in_progress").length,
        completed: tasks.filter((t) => t.status === "completed").length,
        failed: tasks.filter((t) => t.status === "failed").length,
      },
      uptime: state.startedAt ? Date.now() - state.startedAt : 0,
      started_at: state.startedAt,
    };

    res.json(status);
  });

  // POST /api/conversation/message - Send message to head manager
  app.post("/api/conversation/message", async (req: Request, res: Response) => {
    // Reject new messages during shutdown
    if (state.isShuttingDown) {
      return sendError(res, 503, "SHUTTING_DOWN", "Server is shutting down");
    }

    const promptId = `prompt_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    try {
      if (!state.initialized || !state.headManagerId) {
        return sendError(res, 400, "NOT_INITIALIZED", "System not initialized");
      }

      const body = req.body as ConversationMessageRequest;
      if (!body.message) {
        return sendError(res, 400, "MISSING_MESSAGE", "Message is required");
      }

      // Add user message to history
      state.conversationHistory.push({
        role: "user",
        content: body.message,
        timestamp: Date.now(),
      });

      // Broadcast to conversation channel
      state.broadcast("conversation", {
        type: "message",
        data: {
          role: "user",
          content: body.message,
          timestamp: Date.now(),
        },
      });

      // Track this prompt as in-flight
      let resolvePrompt: () => void;
      const promptPromise = new Promise<void>((resolve) => {
        resolvePrompt = resolve;
      });
      state.inFlightPrompts.set(promptId, promptPromise);

      // Send to head manager and collect response
      let responseContent = "";
      try {
        for await (const update of agentManager.prompt(state.headManagerId, body.message)) {
          if ("sessionUpdate" in update && update.sessionUpdate === "agent_message_chunk") {
            const chunk = update as { content: { type: string; text?: string } };
            if (chunk.content.type === "text" && chunk.content.text) {
              responseContent += chunk.content.text;
            }
          }
        }
      } finally {
        // Mark prompt as complete
        resolvePrompt!();
        state.inFlightPrompts.delete(promptId);
      }

      // Add assistant response to history
      state.conversationHistory.push({
        role: "assistant",
        content: responseContent,
        agent_id: state.headManagerId,
        timestamp: Date.now(),
      });

      // Broadcast response
      state.broadcast("conversation", {
        type: "message",
        data: {
          role: "assistant",
          content: responseContent,
          agent_id: state.headManagerId,
          timestamp: Date.now(),
        },
      });

      res.json({
        content: responseContent,
        agent_id: state.headManagerId,
        message_id: `msg_${Date.now()}`,
      });
    } catch (error) {
      // Ensure we clean up the in-flight prompt on error
      state.inFlightPrompts.delete(promptId);
      sendError(res, 500, "MESSAGE_FAILED", `Failed to process message: ${error}`);
    }
  });

  // GET /api/conversation/history - Get conversation history
  app.get("/api/conversation/history", (req: Request, res: Response) => {
    const limit = parseInt(req.query.limit as string) || 50;
    const offset = parseInt(req.query.offset as string) || 0;

    const history = state.conversationHistory.slice(offset, offset + limit);

    const response: ConversationHistoryResponse = {
      history,
      total: state.conversationHistory.length,
    };

    res.json(response);
  });

  // GET /api/agents - List agents
  app.get("/api/agents", (req: Request, res: Response) => {
    const params = req.query as unknown as AgentQueryParams;
    let agents = agentManager.list();

    // Apply filters
    if (params.state) {
      agents = agents.filter((a) => a.state === params.state);
    }
    if (params.parent !== undefined) {
      const parentValue = params.parent === "null" ? null : params.parent;
      agents = agents.filter((a) => a.parent === parentValue);
    }

    const total = agents.length;

    // Apply pagination
    const offset = params.offset ?? 0;
    const limit = params.limit ?? 50;
    agents = agents.slice(offset, offset + limit);

    const response: AgentListResponse = {
      agents: agents.map(agentToSummary),
      total,
    };

    res.json(response);
  });

  // GET /api/agents/:id - Get agent details
  app.get("/api/agents/:id", (req: Request, res: Response) => {
    const id = req.params.id as string;
    const agent = agentManager.get(id);
    if (!agent) {
      return sendError(res, 404, "AGENT_NOT_FOUND", `Agent not found: ${id}`);
    }
    res.json(agentToDetail(agent));
  });

  // GET /api/agents/:id/hierarchy - Get agent hierarchy
  app.get("/api/agents/:id/hierarchy", (req: Request, res: Response) => {
    const id = req.params.id as string;
    const agent = agentManager.get(id);
    if (!agent) {
      return sendError(res, 404, "AGENT_NOT_FOUND", `Agent not found: ${id}`);
    }

    const hierarchy = agentManager.getHierarchy(id);
    if (!hierarchy) {
      return sendError(res, 500, "HIERARCHY_ERROR", "Failed to build hierarchy");
    }

    const response: HierarchyResponse = {
      tree: buildHierarchyNode(agent),
      depth: hierarchy.depth,
      total_agents: hierarchy.totalAgents,
    };

    res.json(response);
  });

  // GET /api/tasks - List tasks
  app.get("/api/tasks", (req: Request, res: Response) => {
    const params = req.query as unknown as TaskQueryParams;
    let tasks = taskManager.list();

    // Apply filters
    if (params.status) {
      tasks = tasks.filter((t) => t.status === params.status);
    }
    if (params.assigned_agent) {
      tasks = tasks.filter((t) => t.assigned_agent === params.assigned_agent);
    }

    const total = tasks.length;

    // Apply pagination
    const offset = params.offset ?? 0;
    const limit = params.limit ?? 50;
    tasks = tasks.slice(offset, offset + limit);

    const response: TaskListResponse = {
      tasks: tasks.map(taskToSummary),
      total,
    };

    res.json(response);
  });

  // GET /api/tasks/:id - Get task details
  app.get("/api/tasks/:id", (req: Request, res: Response) => {
    const id = req.params.id as string;
    const task = taskManager.get(id);
    if (!task) {
      return sendError(res, 404, "TASK_NOT_FOUND", `Task not found: ${id}`);
    }
    res.json(taskToDetail(task));
  });

  // GET /api/events - List events with filters
  app.get("/api/events", (req: Request, res: Response) => {
    const params = req.query as unknown as EventQueryParams;
    const { eventStore } = services;

    const events = eventStore.query({
      type: params.type as any,
      source_agent_id: params.source_agent_id,
      target_agent_id: params.target_agent_id,
      after: params.after,
      before: params.before,
      limit: (params.limit ?? 50) + 1, // Get one extra to check has_more
    });

    const limit = params.limit ?? 50;
    const hasMore = events.length > limit;
    const resultEvents = hasMore ? events.slice(0, limit) : events;

    const response: EventListResponse = {
      events: resultEvents.map(eventToSummary),
      total: resultEvents.length,
      has_more: hasMore,
    };

    res.json(response);
  });

  // POST /api/agents/:id/inject - Inject context into agent session
  app.post("/api/agents/:id/inject", async (req: Request, res: Response) => {
    const id = req.params.id as AgentId;
    const body = req.body as InjectContextRequest;

    // Validate content
    if (!body.content) {
      return sendError(res, 400, "MISSING_CONTENT", "Content is required");
    }

    // Check agent exists
    const agent = agentManager.get(id);
    if (!agent) {
      return sendError(res, 404, "AGENT_NOT_FOUND", `Agent not found: ${id}`);
    }

    // Create injection deps
    const injectionDeps: InjectionDeps = {
      getSession(agentId: AgentId) {
        const session = agentManager.getSession(agentId);
        if (!session) return null;
        return {
          inject: async (content: string) => session.inject(content),
          supportsInject: () => session.supportsInject(),
          checkInjectSupport: async () => session.supportsInject(),
          interruptWith: (content: string) => session.interruptWith(content),
        };
      },
      isPrompting(agentId: AgentId) {
        return agentManager.isPrompting(agentId);
      },
      async sendMessage(
        _fromAgentId: AgentId | undefined,
        toAgentId: AgentId,
        content: string,
        priority: "high"
      ) {
        await messageRouter.send({
          from: { agent_id: "__human__" as AgentId },
          to: { agent_id: toAgentId },
          content,
          priority,
        });
      },
    };

    try {
      const result = await injectContext(injectionDeps, id, body.content, {
        urgent: body.urgent,
        allowInterrupt: true,
        source: { type: "human" },
        reason: body.reason,
      });

      const response: InjectContextResponse = {
        success: result.success,
        method: result.method,
        error: result.error,
        note: result.note,
      };

      if (result.success) {
        res.json(response);
      } else {
        res.status(500).json(response);
      }
    } catch (error) {
      sendError(res, 500, "INJECTION_FAILED", `Failed to inject context: ${error}`);
    }
  });

  return app;
}

/**
 * Set up API WebSocket handling on an existing WebSocketServer.
 *
 * Use this when you want to share an HTTP server with other services.
 * The WebSocketServer should be created with `noServer: true`.
 *
 * @param wss - WebSocketServer instance (noServer mode)
 * @param services - Shared services (EventStore, AgentManager, etc.)
 * @returns Handler for managing connections
 */
export function setupAPIWebSocket(
  wss: WebSocketServer,
  services: Pick<APIServices, "eventStore" | "agentManager" | "taskManager">,
  app?: Express
): APIWebSocketHandler {
  const { eventStore, agentManager } = services;

  // Get shared state from app if provided, otherwise create new
  const state: APISharedState = app && (app as any).__apiState
    ? (app as any).__apiState
    : createAPISharedState();

  const { wsClients, broadcast } = state;

  // Helper functions for event listeners
  function agentToSummary(agent: Agent): AgentSummary {
    return {
      id: agent.id,
      session_id: agent.session_id,
      task: agent.task ?? "No task",
      state: agent.state,
      parent: agent.parent,
      children_count: agentManager.getChildren(agent.id).length,
      created_at: agent.created_at,
    };
  }

  function taskToSummary(task: Task): TaskSummary {
    return {
      id: task.id,
      description: task.description,
      status: task.status,
      assigned_agent: task.assigned_agent,
      created_at: task.created_at,
    };
  }

  // Handle WebSocket connections
  wss.on("connection", (ws: WebSocket) => {
    const client: WSClient = {
      ws,
      subscriptions: new Set(),
    };
    wsClients.add(client);

    ws.on("message", (data: Buffer) => {
      try {
        const message = JSON.parse(data.toString()) as { type: string; channel?: string };

        if (message.type === "subscribe" && message.channel) {
          client.subscriptions.add(message.channel);
          ws.send(JSON.stringify({ type: "subscribed", channel: message.channel }));
        } else if (message.type === "unsubscribe" && message.channel) {
          client.subscriptions.delete(message.channel);
          ws.send(JSON.stringify({ type: "unsubscribed", channel: message.channel }));
        }
      } catch {
        ws.send(JSON.stringify({ type: "error", error: "Invalid message format" }));
      }
    });

    ws.on("close", () => {
      wsClients.delete(client);
    });
  });

  // Listen for agent changes
  eventStore.onAgentChange((agentId, agent) => {
    if (!agent) return;

    const update: WSAgentUpdate = {
      type: "agent_update",
      action: agent.state === "stopped" ? "stopped" : "started",
      agent: agentToSummary(agent),
    };

    broadcast("agents", update);
  });

  // Listen for task changes
  eventStore.onTaskChange((taskId, task) => {
    if (!task) return;

    const update: WSTaskUpdate = {
      type: "task_update",
      action: task.status === "completed" ? "completed" : "status_change",
      task: taskToSummary(task),
    };

    broadcast("tasks", update);
  });

  return {
    getConnectionCount(): number {
      return wsClients.size;
    },

    closeAll(): void {
      console.error(`[api-ws] Closing ${wsClients.size} connections...`);
      for (const client of wsClients) {
        if (client.ws.readyState === WebSocket.OPEN) {
          client.ws.close(1001, "Server shutting down");
        }
      }
      wsClients.clear();
    },
  };
}
