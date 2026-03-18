/**
 * InboxAdapter — Wraps agent-inbox for macro-agent's messaging needs.
 *
 * Embeds agent-inbox in-process (hybrid model):
 * - macro-agent gets zero-latency event access via inbox.events
 * - Agent MCP subprocesses connect via IPC socket
 *
 * Owns adapter-side policy enforcement:
 * - Signal filtering (before delivery to handler)
 * - Emission validation (before forwarding to inbox)
 *
 * @module adapters/inbox-adapter
 */

import {
  createAgentInbox,
  type AgentInbox,
  type MessageContent,
  type Message,
  type Importance,
} from "agent-inbox";
import type {
  InboxAdapter as IInboxAdapter,
  InboxDeliveryEvent,
  RegisterAgentOptions,
  SendMessageOptions,
  DeliveryHandler,
  SignalFilterFn,
  EmissionValidatorFn,
} from "./types.js";

// ─────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────

export interface InboxAdapterConfig {
  /** Path to SQLite database for inbox persistence. */
  sqlitePath?: string;
  /** IPC socket path for agent subprocesses. */
  socketPath: string;
  /** Default scope for standalone agents (default: "default"). */
  defaultScope?: string;
}

// ─────────────────────────────────────────────────────────────────
// Implementation
// ─────────────────────────────────────────────────────────────────

export class DefaultInboxAdapter implements IInboxAdapter {
  private inbox: AgentInbox | null = null;
  private handlers: Set<DeliveryHandler> = new Set();
  private signalFilter: SignalFilterFn | null = null;
  private emissionValidator: EmissionValidatorFn | null = null;
  private readonly config: InboxAdapterConfig;
  private readonly defaultScope: string;

  constructor(config: InboxAdapterConfig) {
    this.config = config;
    this.defaultScope = config.defaultScope ?? "default";
  }

  /**
   * Initialize the embedded agent-inbox instance.
   * Must be called before any other methods.
   */
  async initialize(): Promise<void> {
    this.inbox = await createAgentInbox({
      sqlitePath: this.config.sqlitePath,
      config: {
        socketPath: this.config.socketPath,
        scope: this.defaultScope,
      },
    });

    // Subscribe to delivery events from agent-inbox
    this.inbox.events.on(
      "inbox.message",
      (event: InboxDeliveryEvent) => {
        this.handleDeliveryEvent(event);
      }
    );
  }

  get socketPath(): string {
    return this.config.socketPath;
  }

  // ── Agent Lifecycle ──────────────────────────────────────────

  async registerAgent(
    agentId: string,
    opts: RegisterAgentOptions
  ): Promise<void> {
    const inbox = this.requireInbox();
    inbox.storage.putAgent({
      agent_id: agentId,
      display_name: opts.name,
      scope: opts.scope,
      status: "active",
      metadata: {
        role: opts.role,
        ...opts.metadata,
      },
      registered_at: new Date().toISOString(),
      last_active_at: new Date().toISOString(),
    });
  }

  async deregisterAgent(agentId: string): Promise<void> {
    const inbox = this.requireInbox();
    const agent = inbox.storage.getAgent(agentId);
    if (agent) {
      inbox.storage.putAgent({
        ...agent,
        status: "offline",
        last_active_at: new Date().toISOString(),
      });
    }
  }

  // ── Messaging ────────────────────────────────────────────────

  async send(
    from: string,
    to: string | string[],
    content: MessageContent | string,
    opts?: SendMessageOptions
  ): Promise<string> {
    const inbox = this.requireInbox();

    // Normalize content
    const normalizedContent: MessageContent =
      typeof content === "string" ? { type: "text", text: content } : content;

    // Build a partial message for validation
    const validationMsg = {
      content: normalizedContent,
      metadata: {},
    } as Message;

    // Run emission validation (adapter-side)
    if (this.emissionValidator) {
      const rejection = this.emissionValidator(from, validationMsg);
      if (rejection) {
        throw new Error(`Emission rejected for ${from}: ${rejection}`);
      }
    }

    // Route through agent-inbox
    const message = await inbox.router.routeMessage({
      from,
      to,
      payload: normalizedContent,
      threadTag: opts?.threadTag,
      importance: opts?.importance,
      subject: opts?.subject,
      inReplyTo: opts?.inReplyTo,
      scope: opts?.scope,
    });

    return message.id;
  }

  // ── Delivery Subscription ────────────────────────────────────

  onDelivery(handler: DeliveryHandler): void {
    this.handlers.add(handler);
  }

  offDelivery(handler: DeliveryHandler): void {
    this.handlers.delete(handler);
  }

  // ── Queries ──────────────────────────────────────────────────

  async checkInbox(
    agentId: string,
    opts?: { unreadOnly?: boolean; limit?: number }
  ): Promise<Message[]> {
    const inbox = this.requireInbox();
    return inbox.storage.getInbox(agentId, {
      unreadOnly: opts?.unreadOnly,
      limit: opts?.limit,
    });
  }

  async readThread(threadTag: string, scope?: string): Promise<Message[]> {
    const inbox = this.requireInbox();
    return inbox.storage.getThread({
      threadTag,
      scope: scope ?? this.defaultScope,
    });
  }

  // ── Policy Hooks ─────────────────────────────────────────────

  setSignalFilter(filter: SignalFilterFn): void {
    this.signalFilter = filter;
  }

  setEmissionValidator(validator: EmissionValidatorFn): void {
    this.emissionValidator = validator;
  }

  // ── Lifecycle ────────────────────────────────────────────────

  async stop(): Promise<void> {
    if (this.inbox) {
      await this.inbox.stop();
      this.inbox = null;
    }
    this.handlers.clear();
  }

  /** Get the underlying AgentInbox instance (for advanced use). */
  getInbox(): AgentInbox {
    return this.requireInbox();
  }

  // ── Private ──────────────────────────────────────────────────

  private requireInbox(): AgentInbox {
    if (!this.inbox) {
      throw new Error(
        "InboxAdapter not initialized. Call initialize() first."
      );
    }
    return this.inbox;
  }

  private handleDeliveryEvent(event: InboxDeliveryEvent): void {
    // Apply signal filter (adapter-side)
    if (this.signalFilter) {
      const allowed = this.signalFilter(
        event.message.sender_id,
        event.agentId,
        event.message
      );
      if (!allowed) return; // silently drop
    }

    // Dispatch to all registered handlers
    for (const handler of this.handlers) {
      try {
        handler(event);
      } catch {
        // Handler errors should not break delivery to other handlers
      }
    }
  }
}
