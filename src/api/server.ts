/**
 * API Server
 *
 * Express server with REST API and WebSocket support for the multi-agent system.
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
} from "./types.js";

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

export interface APIServer {
  /** Express app for testing */
  app: Express;

  /** HTTP server */
  server: http.Server;

  /** WebSocket server */
  wss: WebSocketServer;

  /** Start the server */
  start(): Promise<void>;

  /** Stop the server */
  stop(): Promise<void>;

  /** Get current status */
  getStatus(): SystemStatus;
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
}

// ─────────────────────────────────────────────────────────────────
// WebSocket Client Tracking
// ─────────────────────────────────────────────────────────────────

interface WSClient {
  ws: WebSocket;
  subscriptions: Set<string>;
}

// ─────────────────────────────────────────────────────────────────
// Create API Server
// ─────────────────────────────────────────────────────────────────

export function createAPIServer(
  services: APIServices,
  config: APIServerConfig = {}
): APIServer {
  const { port = 3000, host = "localhost", cors = true } = config;
  const { eventStore, agentManager, taskManager } = services;

  // Server state
  const state: ServerState = {
    initialized: false,
    conversationHistory: [],
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

      // Send to head manager and collect response
      let responseContent = "";
      for await (const update of agentManager.prompt(state.headManagerId, body.message)) {
        if ("sessionUpdate" in update && update.sessionUpdate === "agent_message_chunk") {
          const chunk = update as { content: { type: string; text?: string } };
          if (chunk.content.type === "text" && chunk.content.text) {
            responseContent += chunk.content.text;
          }
        }
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
    const agent = agentManager.get(req.params.id);
    if (!agent) {
      return sendError(res, 404, "AGENT_NOT_FOUND", `Agent not found: ${req.params.id}`);
    }
    res.json(agentToDetail(agent));
  });

  // GET /api/agents/:id/hierarchy - Get agent hierarchy
  app.get("/api/agents/:id/hierarchy", (req: Request, res: Response) => {
    const agent = agentManager.get(req.params.id);
    if (!agent) {
      return sendError(res, 404, "AGENT_NOT_FOUND", `Agent not found: ${req.params.id}`);
    }

    const hierarchy = agentManager.getHierarchy(req.params.id);
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
    const task = taskManager.get(req.params.id);
    if (!task) {
      return sendError(res, 404, "TASK_NOT_FOUND", `Task not found: ${req.params.id}`);
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

  async function stop(): Promise<void> {
    // Close all WebSocket connections
    for (const client of wsClients) {
      client.ws.close();
    }
    wsClients.clear();

    // Close HTTP server
    return new Promise((resolve, reject) => {
      server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  return {
    app,
    server,
    wss,
    start,
    stop,
    getStatus,
  };
}
