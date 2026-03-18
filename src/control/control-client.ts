/**
 * Control Socket Client
 *
 * Connects to the main process control socket from MCP subprocesses.
 * Provides typed methods for lifecycle operations (spawn, terminate, etc.)
 * Supports auto-reconnect with exponential backoff on socket close.
 *
 * @module control/control-client
 */

import * as net from "node:net";
import type { ControlCommand, ControlResponse } from "./types.js";

// =============================================================================
// Types
// =============================================================================

export interface ControlClientOptions {
  timeout?: number;
  reconnect?: boolean;
  maxRetries?: number;
  onReconnected?: () => void;
}

// =============================================================================
// Client
// =============================================================================

export class ControlClient {
  private socket: net.Socket | null = null;
  private buffer = "";
  private pending: Map<
    number,
    { resolve: (r: ControlResponse) => void; reject: (e: Error) => void }
  > = new Map();
  private seq = 0;
  private _connected = false;
  private _reconnecting = false;
  private _permanentlyDisconnected = false;
  private readonly socketPath: string;
  private readonly timeout: number;
  private readonly reconnectEnabled: boolean;
  private readonly maxRetries: number;
  private readonly onReconnected?: () => void;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(socketPath: string, options?: ControlClientOptions | number) {
    this.socketPath = socketPath;
    if (typeof options === "number") {
      // Legacy signature: constructor(socketPath, timeout)
      this.timeout = options;
      this.reconnectEnabled = false;
      this.maxRetries = 10;
    } else {
      this.timeout = options?.timeout ?? 30_000;
      this.reconnectEnabled = options?.reconnect ?? true;
      this.maxRetries = options?.maxRetries ?? 10;
      this.onReconnected = options?.onReconnected;
    }
  }

  get connected(): boolean {
    return this._connected;
  }

  get reconnecting(): boolean {
    return this._reconnecting;
  }

  async connect(): Promise<void> {
    if (this._connected) return;

    this._permanentlyDisconnected = false;
    return this.connectInternal();
  }

  private connectInternal(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Control socket connection timeout: ${this.socketPath}`));
      }, 5000);

      this.socket = net.createConnection(this.socketPath, () => {
        clearTimeout(timer);
        this._connected = true;
        this._reconnecting = false;
        resolve();
      });

      this.socket.on("error", (err) => {
        clearTimeout(timer);
        if (!this._connected) {
          // Connection failed during initial connect
          reject(err);
        }
        // If already connected, error will be followed by close
      });

      this.socket.on("data", (data) => {
        this.buffer += data.toString();
        this.processBuffer();
      });

      this.socket.on("close", () => {
        const wasConnected = this._connected;
        this._connected = false;
        this.socket = null;
        this.buffer = "";

        if (wasConnected && this.reconnectEnabled && !this._permanentlyDisconnected) {
          // Reject pending requests — they won't get responses
          for (const [, p] of this.pending) {
            p.reject(new Error("Control socket closed"));
          }
          this.pending.clear();

          // Start reconnect loop
          this.startReconnect();
        } else if (!this._reconnecting) {
          // No reconnect — reject all pending
          for (const [, p] of this.pending) {
            p.reject(new Error("Control socket closed"));
          }
          this.pending.clear();
        }
      });
    });
  }

  private startReconnect(): void {
    if (this._reconnecting || this._permanentlyDisconnected) return;
    this._reconnecting = true;
    this.attemptReconnect(0, 100);
  }

  private attemptReconnect(attempt: number, delay: number): void {
    if (this._permanentlyDisconnected || this._connected) {
      this._reconnecting = false;
      return;
    }

    if (attempt >= this.maxRetries) {
      this._reconnecting = false;
      this._permanentlyDisconnected = true;
      // Reject any pending that accumulated
      for (const [, p] of this.pending) {
        p.reject(new Error("Control socket reconnect failed after max retries"));
      }
      this.pending.clear();
      return;
    }

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;

      if (this._permanentlyDisconnected || this._connected) {
        this._reconnecting = false;
        return;
      }

      try {
        await this.connectInternal();
        // Success
        this._reconnecting = false;
        this.onReconnected?.();
      } catch {
        // Failed — retry with exponential backoff (cap at 5s)
        const nextDelay = Math.min(delay * 2, 5000);
        this.attemptReconnect(attempt + 1, nextDelay);
      }
    }, delay);
  }

  disconnect(): void {
    this._permanentlyDisconnected = true;
    this._reconnecting = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
      this._connected = false;
    }
    // Reject any pending
    for (const [, p] of this.pending) {
      p.reject(new Error("Control socket disconnected"));
    }
    this.pending.clear();
  }

  // ── Typed Methods ────────────────────────────────────────────

  async spawn(options: {
    task: string;
    parent?: string | null;
    role?: string;
    cwd?: string;
    team_instance?: string;
    customPrompt?: string;
  }): Promise<{
    agent_id: string;
    name?: string;
    session_id: string;
    task_id?: string;
    role?: string;
  }> {
    const resp = await this.send({ action: "spawn", ...options });
    return resp.result as any;
  }

  async terminate(agentId: string, reason: string): Promise<void> {
    await this.send({ action: "terminate", agentId, reason } as any);
  }

  async getAgent(agentId: string): Promise<unknown> {
    const resp = await this.send({ action: "get_agent", agentId });
    return resp.result;
  }

  async listAgents(filter?: Record<string, unknown>): Promise<unknown[]> {
    const resp = await this.send({ action: "list_agents", filter } as any);
    return (resp.result as unknown[]) ?? [];
  }

  async getChildren(agentId: string): Promise<unknown[]> {
    const resp = await this.send({ action: "get_children", agentId });
    return (resp.result as unknown[]) ?? [];
  }

  async getHierarchy(
    agentId: string,
    depth?: number
  ): Promise<unknown> {
    const resp = await this.send({
      action: "get_hierarchy",
      agentId,
      depth,
    });
    return resp.result;
  }

  async ping(): Promise<boolean> {
    try {
      const resp = await this.send({ action: "ping" });
      return resp.ok;
    } catch {
      return false;
    }
  }

  async healthCheck(agentId: string, mcpPid: number): Promise<boolean> {
    try {
      const resp = await this.send({ action: "health_check", agentId, mcpPid });
      return resp.ok;
    } catch {
      return false;
    }
  }

  // ── Internal ─────────────────────────────────────────────────

  private async send(cmd: ControlCommand): Promise<ControlResponse & { ok: true }> {
    if (!this.socket || !this._connected) {
      throw new Error("Control socket not connected");
    }

    const resp = await this.sendRaw(cmd);
    if (!resp.ok) {
      const err = new Error((resp as any).error ?? "Control socket error");
      (err as any).code = (resp as any).code;
      throw err;
    }
    return resp as ControlResponse & { ok: true };
  }

  private sendRaw(cmd: ControlCommand): Promise<ControlResponse> {
    return new Promise((resolve, reject) => {
      const id = this.seq++;

      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Control socket timeout (${this.timeout}ms)`));
      }, this.timeout);

      this.pending.set(id, {
        resolve: (resp) => {
          clearTimeout(timer);
          resolve(resp);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });

      try {
        // Tag the command with a sequence ID for response matching
        this.socket!.write(JSON.stringify({ ...cmd, _seq: id }) + "\n");
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private processBuffer(): void {
    let newlineIdx: number;
    while ((newlineIdx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newlineIdx).trim();
      this.buffer = this.buffer.slice(newlineIdx + 1);

      if (!line) continue;

      try {
        const resp = JSON.parse(line) as ControlResponse & { _seq?: number };
        const seq = resp._seq;

        if (seq !== undefined && this.pending.has(seq)) {
          this.pending.get(seq)!.resolve(resp);
          this.pending.delete(seq);
        } else {
          // No matching request — resolve oldest pending
          const oldest = this.pending.entries().next();
          if (!oldest.done) {
            oldest.value[1].resolve(resp);
            this.pending.delete(oldest.value[0]);
          }
        }
      } catch {
        // Invalid JSON — ignore
      }
    }
  }
}
