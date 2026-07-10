/**
 * REST API server for macro-agent.
 *
 * Provides HTTP endpoints for managing agents, tasks, teams, and metrics.
 *
 * @module api/server
 */

import express, { type NextFunction, type Request, type Response } from "express";
import type { Server } from "node:http";
import type { MacroAgentSystemV2 } from "../boot-v2.js";
import type { ApiServer, ApiServerConfig } from "./types.js";
import {
  assertBindAllowed,
  isRequestAuthorized,
  resolveServerToken,
} from "../auth/server-auth.js";
import { collectMetrics } from "../metrics/index.js";

// =============================================================================
// Fallback metrics
// =============================================================================

interface FallbackMetricsSnapshot {
  agents: {
    total: number;
    running: number;
    stopped: number;
    failed: number;
  };
  tasks: {
    total: number;
    open: number;
    in_progress: number;
    closed: number;
  };
  uptime: number;
  collectedAt: string;
}

/**
 * Minimal metrics computed only from the agent store and task adapter. Used as
 * a graceful fallback when the full metrics collector is unavailable (e.g. the
 * control/trigger subsystems aren't wired in a given embedding).
 */
async function collectFallbackMetrics(
  system: MacroAgentSystemV2,
  startTime: number
): Promise<FallbackMetricsSnapshot> {
  const agents = system.agentStore.listAgents();
  const running = agents.filter((a) => a.state === "running").length;
  const stopped = agents.filter((a) => a.state === "stopped").length;
  const failed = agents.filter((a) => a.state === "failed").length;

  let taskMetrics = { total: 0, open: 0, in_progress: 0, closed: 0 };
  try {
    const tasks = await system.tasksAdapter.listTasks();
    taskMetrics = {
      total: tasks.length,
      open: tasks.filter((t) => t.status === "open").length,
      in_progress: tasks.filter((t) => t.status === "in_progress").length,
      closed: tasks.filter((t) => t.status === "closed").length,
    };
  } catch {
    // opentasks may be down
  }

  return {
    agents: { total: agents.length, running, stopped, failed },
    tasks: taskMetrics,
    uptime: (Date.now() - startTime) / 1000,
    collectedAt: new Date().toISOString(),
  };
}

// =============================================================================
// Helpers
// =============================================================================

/** Extract a single string from Express v5 param/query (string | string[]). */
function str(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return undefined;
}

// =============================================================================
// Factory
// =============================================================================

export function createApiServer(
  system: MacroAgentSystemV2,
  config?: ApiServerConfig
): ApiServer {
  const port = config?.port ?? 3000;
  const host = config?.host ?? "127.0.0.1";
  const token = resolveServerToken(config?.token);
  const startTime = Date.now();

  const app = express();
  app.use(express.json());

  // ── Auth ────────────────────────────────────────────────────────
  // When a token is configured, require it on every route except the health
  // check. When it isn't, the bind guard in start() keeps the server
  // loopback-only, so local development needs no token.
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.path === "/api/health") return next();
    if (!isRequestAuthorized(token, req)) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    next();
  });

  // ── Health ──────────────────────────────────────────────────────

  app.get("/api/health", (_req: Request, res: Response) => {
    res.json({
      ok: true,
      uptime: (Date.now() - startTime) / 1000,
      version: "0.1.1",
    });
  });

  // ── Agents ─────────────────────────────────────────────────────

  app.get("/api/agents", (req: Request, res: Response) => {
    try {
      const state = str(req.query.state);
      const role = str(req.query.role);
      const team = str(req.query.team);
      const limit = parseInt(str(req.query.limit) ?? "50", 10) || 50;
      const offset = parseInt(str(req.query.offset) ?? "0", 10) || 0;

      const filter: Record<string, unknown> = {};
      if (state) filter.state = state;
      if (role) filter.role = role;
      if (team) filter.team = team;

      const agents = system.agentManager.list(
        Object.keys(filter).length > 0 ? (filter as any) : undefined
      );

      const total = agents.length;
      const paged = agents.slice(offset, offset + limit);

      res.json({ agents: paged, total });
    } catch (err: any) {
      res.status(500).json({ error: err.message ?? "Internal server error" });
    }
  });

  app.get("/api/agents/:id", (req: Request, res: Response) => {
    try {
      const id = str(req.params.id);
      const agent = system.agentManager.get(id!);
      if (!agent) {
        res.status(404).json({ error: "Agent not found" });
        return;
      }
      res.json(agent);
    } catch (err: any) {
      res.status(500).json({ error: err.message ?? "Internal server error" });
    }
  });

  app.get("/api/agents/:id/hierarchy", (req: Request, res: Response) => {
    try {
      const id = str(req.params.id)!;
      const depthStr = str(req.query.depth);
      const options = depthStr ? { depth: parseInt(depthStr, 10) } : undefined;

      const hierarchy = system.agentManager.getHierarchy(id, options);
      if (!hierarchy) {
        res.status(404).json({ error: "Agent not found" });
        return;
      }
      res.json(hierarchy);
    } catch (err: any) {
      res.status(500).json({ error: err.message ?? "Internal server error" });
    }
  });

  app.get("/api/agents/:id/inbox", async (req: Request, res: Response) => {
    try {
      const id = str(req.params.id)!;
      const agent = system.agentManager.get(id);
      if (!agent) {
        res.status(404).json({ error: "Agent not found" });
        return;
      }

      const limit = parseInt(str(req.query.limit) ?? "20", 10) || 20;
      const unreadOnly = str(req.query.unreadOnly) === "true";

      const messages = await system.inboxAdapter.checkInbox(id, {
        limit,
        unreadOnly,
      });

      res.json({ messages });
    } catch (err: any) {
      res.status(500).json({ error: err.message ?? "Internal server error" });
    }
  });

  app.post("/api/agents", async (req: Request, res: Response) => {
    try {
      const { task, role, parent, cwd } = req.body;

      if (!task) {
        res.status(400).json({ error: "Missing required field: task" });
        return;
      }

      const spawned = await system.agentManager.spawn({
        task,
        role,
        parent,
        cwd,
      });

      res.status(201).json(spawned);
    } catch (err: any) {
      res.status(500).json({ error: err.message ?? "Internal server error" });
    }
  });

  app.delete("/api/agents/:id", async (req: Request, res: Response) => {
    try {
      const id = str(req.params.id)!;
      const agent = system.agentManager.get(id);
      if (!agent) {
        res.status(404).json({ error: "Agent not found" });
        return;
      }

      const reason = str(req.query.reason) ?? "cancelled";
      await system.agentManager.terminate(id, reason as any);

      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message ?? "Internal server error" });
    }
  });

  // ── Tasks ──────────────────────────────────────────────────────

  app.get("/api/tasks", async (req: Request, res: Response) => {
    try {
      const status = str(req.query.status);
      const assignee = str(req.query.assignee);
      const limitStr = str(req.query.limit);

      const filter: Record<string, unknown> = {};
      if (status) filter.status = status;
      if (assignee) filter.assignee = assignee;
      if (limitStr) filter.limit = parseInt(limitStr, 10);

      const tasks = await system.tasksAdapter.listTasks(
        Object.keys(filter).length > 0 ? (filter as any) : undefined
      );

      res.json({ tasks });
    } catch (err: any) {
      res.status(500).json({ error: err.message ?? "Internal server error" });
    }
  });

  app.get("/api/tasks/ready", async (req: Request, res: Response) => {
    try {
      const limitStr = str(req.query.limit);
      const tagsStr = str(req.query.tags);

      const opts: { limit?: number; tags?: string[] } = {};
      if (limitStr) opts.limit = parseInt(limitStr, 10);
      if (tagsStr) opts.tags = tagsStr.split(",");

      const tasks = await system.tasksAdapter.queryReady(opts);

      res.json({ tasks });
    } catch (err: any) {
      res.status(500).json({ error: err.message ?? "Internal server error" });
    }
  });

  // ── Metrics ────────────────────────────────────────────────────

  app.get("/api/metrics", async (_req: Request, res: Response) => {
    try {
      // Prefer the full collector; fall back to store-only metrics if the
      // control/trigger subsystems aren't available in this embedding.
      let snapshot: unknown;
      try {
        snapshot = await collectMetrics(system, startTime);
      } catch {
        snapshot = await collectFallbackMetrics(system, startTime);
      }
      res.json(snapshot);
    } catch (err: any) {
      res.status(500).json({ error: err.message ?? "Internal server error" });
    }
  });

  app.get("/api/metrics/agents", (_req: Request, res: Response) => {
    try {
      const agents = system.agentStore.listAgents();
      const running = agents.filter((a) => a.state === "running").length;
      const stopped = agents.filter((a) => a.state === "stopped").length;
      const failed = agents.filter((a) => a.state === "failed").length;

      res.json({
        total: agents.length,
        running,
        stopped,
        failed,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message ?? "Internal server error" });
    }
  });

  app.get("/api/metrics/tasks", async (_req: Request, res: Response) => {
    try {
      const tasks = await system.tasksAdapter.listTasks();
      res.json({
        total: tasks.length,
        open: tasks.filter((t) => t.status === "open").length,
        in_progress: tasks.filter((t) => t.status === "in_progress").length,
        closed: tasks.filter((t) => t.status === "closed").length,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message ?? "Internal server error" });
    }
  });

  // ── Teams ──────────────────────────────────────────────────────

  app.get("/api/teams", (_req: Request, res: Response) => {
    try {
      const agents = system.agentStore.listAgents();
      const teamMap = new Map<
        string,
        { name: string; agentCount: number; roles: Set<string> }
      >();

      for (const agent of agents) {
        const teamName = agent.team ?? "default";
        let entry = teamMap.get(teamName);
        if (!entry) {
          entry = { name: teamName, agentCount: 0, roles: new Set() };
          teamMap.set(teamName, entry);
        }
        entry.agentCount++;
        entry.roles.add(agent.role);
      }

      const teams = Array.from(teamMap.values()).map((t) => ({
        name: t.name,
        agentCount: t.agentCount,
        roles: Array.from(t.roles),
      }));

      res.json({ teams });
    } catch (err: any) {
      res.status(500).json({ error: err.message ?? "Internal server error" });
    }
  });

  // ── Server Lifecycle ───────────────────────────────────────────

  let server: Server | null = null;

  return {
    app,

    async start(): Promise<void> {
      assertBindAllowed("api", host, token);
      return new Promise((resolve) => {
        server = app.listen(port, host, () => {
          console.log(
            `[api] Listening on ${host}:${port}` +
              (token ? " (auth required)" : " (loopback, no auth)"),
          );
          resolve();
        });
      });
    },

    async stop(): Promise<void> {
      if (server) {
        return new Promise((resolve) => {
          server!.close(() => {
            server = null;
            resolve();
          });
        });
      }
    },
  };
}
