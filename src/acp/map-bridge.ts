/**
 * MAP Protocol Bridge
 *
 * Exposes MAP-compatible JSON-RPC methods on top of InboxAdapter,
 * allowing external MAP clients to interact with the macro-agent
 * messaging system.
 *
 * Since agent-inbox already speaks MAP natively (via MapClient),
 * this bridge translates MAP send/inbox/thread commands to
 * InboxAdapter calls and returns messages in MAP-compatible format.
 *
 * @module acp/map-bridge
 */

import type { InboxAdapter } from "../adapters/types.js";
import type { AgentStore } from "../agent/agent-store.js";

// ─────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────

export interface MAPBridgeConfig {
  /** Default scope for MAP messages. */
  scope?: string;
}

export interface MAPBridgeDeps {
  inboxAdapter: InboxAdapter;
  agentStore: AgentStore;
}

/**
 * MAP-compatible message format returned by the bridge.
 */
export interface MAPMessage {
  id: string;
  from: string;
  to: string | string[];
  payload: unknown;
  timestamp: string;
  meta?: Record<string, unknown>;
}

/**
 * MAP Bridge instance exposing JSON-RPC-style method handlers.
 */
export interface MAPBridge {
  /**
   * Handle a MAP JSON-RPC request.
   * Supports methods: mail/send, mail/inbox, mail/thread, mail/agents
   */
  handleRequest(method: string, params: Record<string, unknown>): Promise<unknown>;

  /** List supported MAP methods. */
  listMethods(): string[];
}

// ─────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────

/**
 * Create a MAP protocol bridge that translates MAP JSON-RPC methods
 * to InboxAdapter calls.
 *
 * Supported methods:
 * - `mail/send` — Send a message via InboxAdapter
 * - `mail/inbox` — Check an agent's inbox
 * - `mail/thread` — Read a message thread
 * - `mail/agents` — List registered agents
 *
 * TODO: Full MAP SDK integration when @multi-agent-protocol/sdk
 * is available as a peer dependency. Currently this is a lightweight
 * compatibility layer for basic MAP interop.
 */
export function createMAPBridge(
  deps: MAPBridgeDeps,
  config: MAPBridgeConfig = {}
): MAPBridge {
  const { inboxAdapter, agentStore } = deps;
  const scope = config.scope ?? "default";

  const methods: Record<string, (params: Record<string, unknown>) => Promise<unknown>> = {
    "mail/send": async (params) => {
      const from = params.from as string;
      const to = params.to as string | string[];
      const payload = params.payload;
      const meta = params.meta as Record<string, unknown> | undefined;

      if (!from || !to) {
        throw new Error("mail/send requires 'from' and 'to' parameters");
      }

      const content = typeof payload === "string"
        ? { type: "text" as const, text: payload }
        : payload as { type: string; text: string };

      const messageId = await inboxAdapter.send(from, to, content, {
        scope: (meta?.scope as string) ?? scope,
        importance: meta?.priority === "high" ? "high" : "normal",
        subject: meta?.subject as string | undefined,
        threadTag: meta?.threadTag as string | undefined,
        inReplyTo: meta?.inReplyTo as string | undefined,
      });

      return { messageId, success: true };
    },

    "mail/inbox": async (params) => {
      const agentId = params.agentId as string;
      if (!agentId) {
        throw new Error("mail/inbox requires 'agentId' parameter");
      }

      const limit = params.limit as number | undefined;
      const unreadOnly = params.unreadOnly as boolean | undefined;

      const messages = await inboxAdapter.checkInbox(agentId, {
        limit,
        unreadOnly,
      });

      return {
        messages: messages.map((msg) => toMAPMessage(msg)),
        count: messages.length,
      };
    },

    "mail/thread": async (params) => {
      const threadTag = params.threadTag as string;
      if (!threadTag) {
        throw new Error("mail/thread requires 'threadTag' parameter");
      }

      const threadScope = (params.scope as string) ?? scope;
      const messages = await inboxAdapter.readThread(threadTag, threadScope);

      return {
        messages: messages.map((msg) => toMAPMessage(msg)),
        count: messages.length,
      };
    },

    "mail/agents": async (_params) => {
      const agents = agentStore.listAgents({ state: "running" });
      return {
        agents: agents.map((a) => ({
          agentId: a.id,
          name: a.name,
          role: a.role,
          scope: a.scope,
          state: a.state,
        })),
        count: agents.length,
      };
    },
  };

  function toMAPMessage(msg: {
    id?: string;
    sender_id?: string;
    recipients?: Array<{ agent_id: string }>;
    content?: unknown;
    created_at?: string | number;
    metadata?: Record<string, unknown>;
  }): MAPMessage {
    const recipients = msg.recipients?.map((r) => r.agent_id) ?? [];
    return {
      id: msg.id ?? "",
      from: msg.sender_id ?? "",
      to: recipients.length === 1 ? recipients[0] : recipients,
      payload: msg.content,
      timestamp: typeof msg.created_at === "number"
        ? new Date(msg.created_at).toISOString()
        : (msg.created_at as string) ?? new Date().toISOString(),
      meta: msg.metadata,
    };
  }

  return {
    async handleRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
      const handler = methods[method];
      if (!handler) {
        throw new Error(`Unknown MAP method: ${method}. Supported: ${Object.keys(methods).join(", ")}`);
      }
      return handler(params);
    },

    listMethods(): string[] {
      return Object.keys(methods);
    },
  };
}
