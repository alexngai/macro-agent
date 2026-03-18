/**
 * InboxClientAdapter — Client-only inbox adapter for MCP subprocesses.
 *
 * Connects to the main process's agent-inbox via IPC socket (NDJSON).
 * Does NOT embed agent-inbox or start an IPC server.
 * Used by cli/mcp.ts where the main process already owns the inbox.
 *
 * @module adapters/inbox-client-adapter
 */

import * as net from "node:net";
import type {
  InboxAdapter,
  InboxDeliveryEvent,
  RegisterAgentOptions,
  SendMessageOptions,
  DeliveryHandler,
  SignalFilterFn,
  EmissionValidatorFn,
} from "./types.js";
import type { Message, MessageContent } from "agent-inbox";

export class InboxClientAdapter implements InboxAdapter {
  private socket: net.Socket | null = null;
  private buffer = "";
  private pending: Map<number, (resp: any) => void> = new Map();
  private seq = 0;
  private _socketPath: string;

  constructor(socketPath: string) {
    this._socketPath = socketPath;
  }

  get socketPath(): string {
    return this._socketPath;
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Inbox IPC connect timeout")), 5000);

      this.socket = net.createConnection(this._socketPath, () => {
        clearTimeout(timer);
        resolve();
      });

      this.socket.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });

      this.socket.on("data", (data) => {
        this.buffer += data.toString();
        let idx: number;
        while ((idx = this.buffer.indexOf("\n")) !== -1) {
          const line = this.buffer.slice(0, idx).trim();
          this.buffer = this.buffer.slice(idx + 1);
          if (!line) continue;
          try {
            const resp = JSON.parse(line);
            // Resolve oldest pending request
            const oldest = this.pending.entries().next();
            if (!oldest.done) {
              oldest.value[1](resp);
              this.pending.delete(oldest.value[0]);
            }
          } catch { /* ignore */ }
        }
      });
    });
  }

  private async ipcCall(cmd: Record<string, unknown>): Promise<any> {
    if (!this.socket) throw new Error("Inbox IPC not connected");

    return new Promise((resolve, reject) => {
      const id = this.seq++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Inbox IPC call timeout"));
      }, 10000);

      this.pending.set(id, (resp: any) => {
        clearTimeout(timer);
        if (resp.ok === false) {
          reject(new Error(resp.error ?? "IPC error"));
        } else {
          resolve(resp);
        }
      });

      this.socket!.write(JSON.stringify(cmd) + "\n");
    });
  }

  // ── InboxAdapter interface ───────────────────────────────────

  async registerAgent(agentId: string, opts: RegisterAgentOptions): Promise<void> {
    // Registration is handled by the main process AgentManager
    // Subprocess doesn't need to register
  }

  async deregisterAgent(agentId: string): Promise<void> {
    // Handled by main process
  }

  async send(
    from: string,
    to: string | string[],
    content: MessageContent | string,
    opts?: SendMessageOptions
  ): Promise<string> {
    const normalizedContent = typeof content === "string" ? content : content;

    const resp = await this.ipcCall({
      action: "send",
      from,
      to,
      payload: normalizedContent,
      threadTag: opts?.threadTag,
      importance: opts?.importance,
      scope: opts?.scope,
      subject: opts?.subject,
      inReplyTo: opts?.inReplyTo,
    });

    return resp.messageId ?? "";
  }

  onDelivery(_handler: DeliveryHandler): void {
    // Subprocess doesn't receive delivery events
  }

  offDelivery(_handler: DeliveryHandler): void {}

  async checkInbox(
    agentId: string,
    opts?: { unreadOnly?: boolean; limit?: number }
  ): Promise<Message[]> {
    const resp = await this.ipcCall({
      action: "check_inbox",
      agentId,
      unreadOnly: opts?.unreadOnly,
      limit: opts?.limit,
    });
    return resp.messages ?? [];
  }

  async readThread(threadTag: string, scope?: string): Promise<Message[]> {
    const resp = await this.ipcCall({
      action: "read_thread",
      threadTag,
      scope,
    });
    return resp.messages ?? [];
  }

  setSignalFilter(_filter: SignalFilterFn): void {}
  setEmissionValidator(_validator: EmissionValidatorFn): void {}

  // Multi-team hooks — no-ops for subprocess
  addSignalFilter(_id: string, _filter: SignalFilterFn): void {}
  removeSignalFilter(_id: string): void {}
  addEmissionValidator(_id: string, _validator: EmissionValidatorFn): void {}
  removeEmissionValidator(_id: string): void {}

  async stop(): Promise<void> {
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
  }
}
