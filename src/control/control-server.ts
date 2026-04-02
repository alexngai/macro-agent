/**
 * Control Socket Server
 *
 * NDJSON over UNIX socket. Exposes AgentManager lifecycle operations
 * to MCP subprocesses. Runs in the main macro-agent process.
 *
 * Protocol: One JSON object per line. Request → Response.
 * Same pattern as agent-inbox's IPC server.
 *
 * @module control/control-server
 */

import * as net from "node:net";
import * as fs from "node:fs";
import type { AgentManager } from "../agent/agent-manager.js";
import type { ControlCommand, ControlResponse } from "./types.js";

// =============================================================================
// Server
// =============================================================================

export interface ControlServerConfig {
  socketPath: string;
}

export interface AgentHealthStatus {
  healthy: boolean;
  lastSeen: number;
  pid: number;
}

export class ControlServer {
  private server: net.Server | null = null;
  private readonly socketPath: string;
  private readonly agentManager: AgentManager;
  private readonly heartbeats: Map<string, { pid: number; lastSeen: number }> = new Map();
  private readonly connections: Set<net.Socket> = new Set();

  constructor(agentManager: AgentManager, config: ControlServerConfig) {
    this.agentManager = agentManager;
    this.socketPath = config.socketPath;
  }

  async start(): Promise<void> {
    // Clean up stale socket file
    if (fs.existsSync(this.socketPath)) {
      fs.unlinkSync(this.socketPath);
    }

    this.server = net.createServer((socket) => {
      this.handleConnection(socket);
    });

    return new Promise((resolve, reject) => {
      this.server!.on("error", reject);
      this.server!.listen(this.socketPath, () => {
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (this.server) {
      // Destroy all active client connections so they receive close events
      for (const socket of this.connections) {
        socket.destroy();
      }
      this.connections.clear();

      return new Promise((resolve) => {
        this.server!.close(() => {
          if (fs.existsSync(this.socketPath)) {
            try {
              fs.unlinkSync(this.socketPath);
            } catch {
              // Best effort
            }
          }
          this.server = null;
          resolve();
        });
      });
    }
  }

  // ── Connection Handler ───────────────────────────────────────

  private handleConnection(socket: net.Socket): void {
    this.connections.add(socket);
    let buffer = "";

    socket.on("close", () => {
      this.connections.delete(socket);
    });

    socket.on("data", (data) => {
      buffer += data.toString();

      // Process complete lines
      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);

        if (!line) continue;

        this.handleLine(line).then(
          (response) => {
            try {
              socket.write(JSON.stringify(response) + "\n");
            } catch {
              // Socket may have closed
            }
          },
          (err) => {
            try {
              socket.write(
                JSON.stringify({ ok: false, error: String(err) }) + "\n"
              );
            } catch {
              // Socket may have closed
            }
          }
        );
      }
    });

    socket.on("error", () => {
      // Client disconnected — ignore
    });
  }

  // ── Command Dispatch ─────────────────────────────────────────

  private async handleLine(line: string): Promise<ControlResponse & { _seq?: number }> {
    let cmd: ControlCommand & { _seq?: number };
    try {
      cmd = JSON.parse(line);
    } catch {
      return { ok: false, error: "Invalid JSON" };
    }

    if (!cmd || typeof cmd !== "object" || !("action" in cmd)) {
      return { ok: false, error: "Missing 'action' field" };
    }

    // Preserve sequence ID for response matching
    const seq = cmd._seq;

    let response: ControlResponse;
    try {
      switch (cmd.action) {
        case "ping":
          response = { ok: true, result: { pid: process.pid } };
          break;
        case "spawn":
          response = await this.handleSpawn(cmd);
          break;
        case "terminate":
          response = await this.handleTerminate(cmd);
          break;
        case "get_agent":
          response = this.handleGetAgent(cmd);
          break;
        case "list_agents":
          response = this.handleListAgents(cmd);
          break;
        case "get_children":
          response = this.handleGetChildren(cmd);
          break;
        case "get_hierarchy":
          response = this.handleGetHierarchy(cmd);
          break;
        case "health_check":
          response = this.handleHealthCheck(cmd);
          break;
        default:
          response = {
            ok: false,
            error: `Unknown action: ${(cmd as any).action}`,
          };
      }
    } catch (err) {
      response = {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        code: (err as any)?.code,
      };
    }

    // Attach sequence ID for client response matching
    return seq !== undefined ? { ...response, _seq: seq } : response;
  }

  // ── Handlers ─────────────────────────────────────────────────

  private async handleSpawn(
    cmd: Extract<ControlCommand, { action: "spawn" }>
  ): Promise<ControlResponse> {
    const spawned = await this.agentManager.spawn({
      task: cmd.task,
      parent: cmd.parent ?? undefined,
      role: cmd.role,
      cwd: cmd.cwd,
      team_instance: cmd.team_instance,
      customPrompt: cmd.customPrompt,
    });

    return {
      ok: true,
      result: {
        agent_id: spawned.id,
        name: spawned.agent.name,
        session_id: spawned.session_id,
        task_id: spawned.agent.task_id,
        role: spawned.agent.role,
        state: spawned.agent.state,
      },
    };
  }

  private async handleTerminate(
    cmd: Extract<ControlCommand, { action: "terminate" }>
  ): Promise<ControlResponse> {
    await this.agentManager.terminate(cmd.agentId, cmd.reason);
    return { ok: true };
  }

  private handleGetAgent(
    cmd: Extract<ControlCommand, { action: "get_agent" }>
  ): ControlResponse {
    const agent = this.agentManager.get(cmd.agentId);
    if (!agent) {
      return { ok: false, error: `Agent not found: ${cmd.agentId}`, code: "AGENT_NOT_FOUND" };
    }
    return { ok: true, result: agent };
  }

  private handleListAgents(
    cmd: Extract<ControlCommand, { action: "list_agents" }>
  ): ControlResponse {
    const agents = this.agentManager.list(cmd.filter as any);
    return { ok: true, result: agents };
  }

  private handleGetChildren(
    cmd: Extract<ControlCommand, { action: "get_children" }>
  ): ControlResponse {
    const children = this.agentManager.getChildren(cmd.agentId);
    return { ok: true, result: children };
  }

  private handleGetHierarchy(
    cmd: Extract<ControlCommand, { action: "get_hierarchy" }>
  ): ControlResponse {
    const hierarchy = this.agentManager.getHierarchy(cmd.agentId, {
      depth: cmd.depth,
    });
    return { ok: true, result: hierarchy };
  }

  // ── Health Check ────────────────────────────────────────────

  private handleHealthCheck(
    cmd: Extract<ControlCommand, { action: "health_check" }>
  ): ControlResponse {
    this.heartbeats.set(cmd.agentId, {
      pid: cmd.mcpPid,
      lastSeen: Date.now(),
    });
    return { ok: true };
  }

  getHealthStatus(agentId: string): AgentHealthStatus | null {
    const entry = this.heartbeats.get(agentId);
    if (!entry) return null;
    return {
      healthy: true,
      lastSeen: entry.lastSeen,
      pid: entry.pid,
    };
  }

  getUnhealthyAgents(timeoutMs: number): Array<{ agentId: string; lastSeen: number; pid: number }> {
    const now = Date.now();
    const unhealthy: Array<{ agentId: string; lastSeen: number; pid: number }> = [];
    for (const [agentId, entry] of this.heartbeats) {
      if (now - entry.lastSeen > timeoutMs) {
        unhealthy.push({
          agentId,
          lastSeen: entry.lastSeen,
          pid: entry.pid,
        });
      }
    }
    return unhealthy;
  }
}
