/**
 * Mail Bridge — connects OpenHive's hub-side mail to macro-agent's local inbox.
 *
 * OpenHive's mail module (src/mail/index.ts) calls forwardTurnToSwarms() when
 * a new mail turn lands in a conversation a swarm participates in. The hub
 * sends a `mail/turn.received` JSON-RPC notification to the connected swarm
 * sidecar via MAP. macro-agent's sidecar (this module) receives the
 * notification, parses the turn content, and forwards it into the local
 * agent-inbox so:
 *
 *   1. swarm-dispatch's MessagePort (boot-v2 wires `createAgentInboxPort`)
 *      sees the inbox delivery event and runs its classifier on the message.
 *   2. The classifier recognizes `x-dispatch/work` schema and routes the
 *      prompt to a worker agent (existing or freshly spawned).
 *
 * Turns that aren't structured `x-dispatch/work` envelopes (e.g.
 * natural-language spec-discussion replies) are delivered into the inbox as
 * plain-text messages instead of being dropped. The classifier won't match
 * them (so no worker spawns), but the delivery still wakes the agent via
 * TriggerSystemV2 (importance → wake action) so it reads the reply on its
 * next turn.
 *
 * Without this bridge, hub-side mail turns never reach macro-agent's
 * dispatcher. The MessagePort is wired to local inbox events only.
 */
import type { InboxAdapter } from "../adapters/types.js";

/**
 * Subset of MAPClient surface this module needs. Mirrors the shape used by
 * trajectory-reporter / coordination-handler — keeps the bridge testable
 * without dragging in the full SDK type.
 */
export interface MailBridgeConnection {
  onNotification(
    method: string,
    handler: (params: unknown) => void | Promise<void>,
  ): void;
  offNotification(
    method: string,
    handler: (params: unknown) => void | Promise<void>,
  ): void;
}

/**
 * Synthetic recipient registered on the local inbox to receive bridged
 * turns. Choosing a stable name lets the macro-agent dispatcher (or any
 * other inbox observer) filter on `to: BRIDGE_RECIPIENT_ID` if it cares
 * about the source — but normally it doesn't, since the dispatcher's
 * MessagePort matches on the `x-dispatch/work` schema in the payload, not
 * on the recipient id.
 */
const BRIDGE_RECIPIENT_ID = "openhive-mail-bridge";

interface MailTurnReceivedParams {
  conversation_id?: string;
  turn_id?: string;
  participant_id?: string;
  content_type?: string;
  content?: unknown;
  thread_id?: string;
  created_at?: string;
  /** Importance hint from the hub. When present, drives wake/interrupt
   *  decisions via TriggerSystemV2's mapImportanceToWakeAction. */
  importance?: string;
}

/**
 * Parse the turn content into a JS object suitable for inbox routing.
 * Returns null when the content is not parseable as JSON or doesn't look
 * like an object payload (e.g., plain text mail turns).
 */
function parseTurnContent(
  content: unknown,
  contentType: string | undefined,
): Record<string, unknown> | null {
  if (typeof content === "object" && content !== null) {
    return content as Record<string, unknown>;
  }
  if (typeof content !== "string") return null;
  // The hub serializes envelope objects via JSON.stringify and tags them
  // application/json. We accept either explicit content type or a leading
  // `{` to handle clients that omit the header.
  if (
    contentType === "application/json" ||
    content.startsWith("{") ||
    content.startsWith("[")
  ) {
    try {
      const parsed = JSON.parse(content);
      return typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
  return null;
}

export interface MailBridgeOptions {
  connection: MailBridgeConnection;
  inboxAdapter: InboxAdapter;
  /**
   * The dispatcher agent ID used by swarm-dispatch's createAgentInboxPort.
   * Messages must be delivered TO this ID so the MessagePort's onIncoming
   * filter (event.agentId === dispatcherAgentId) fires correctly.
   * When omitted the bridge falls back to BRIDGE_RECIPIENT_ID (inert —
   * the MessagePort will never see the message).
   */
  dispatcherAgentId?: string;
  /**
   * Optional logger for diagnostic output. The sidecar currently logs via
   * console; swap if you want structured output.
   */
  log?: (msg: string) => void;
}

/**
 * Wire the mail bridge. Returns a cleanup function that detaches the
 * notification handler.
 *
 * Idempotent registration: register is called exactly once; the handler
 * itself is best-effort (errors are caught and logged so a malformed turn
 * doesn't break subsequent ones).
 */
export async function setupMailBridge(
  opts: MailBridgeOptions,
): Promise<() => void> {
  const { connection, inboxAdapter, dispatcherAgentId, log = () => {} } = opts;

  // Determine the inbox recipient. When a dispatcherAgentId is provided we
  // deliver directly to the dispatcher so createAgentInboxPort.onIncoming
  // (which filters event.agentId === dispatcherAgentId) picks it up.
  const recipientId = dispatcherAgentId ?? BRIDGE_RECIPIENT_ID;

  // Register the recipient on the local inbox so routeMessage accepts the
  // forwarded turn. Idempotent — registerAgent putAgent is an upsert.
  await inboxAdapter.registerAgent(recipientId, {
    name: dispatcherAgentId ? "OpenHive Dispatcher (bridged)" : "OpenHive Mail Bridge",
    role: dispatcherAgentId ? "dispatcher" : "mail-bridge",
    scope: "default",
    metadata: { source: "openhive-mail-forward" },
  });

  // Importance derivation shared by the structured-work and plain-text
  // delivery paths. Defaults to "normal" when the hub doesn't tag the turn.
  const VALID_IMPORTANCE = ["low", "normal", "high", "urgent"];
  const deriveImportance = (
    value: string | undefined,
  ): "low" | "normal" | "high" | "urgent" =>
    typeof value === "string" && VALID_IMPORTANCE.includes(value)
      ? (value as "low" | "normal" | "high" | "urgent")
      : "normal";

  const handler = async (params: unknown): Promise<void> => {
    const turn = (params ?? {}) as MailTurnReceivedParams;
    const wireImportance = deriveImportance(turn.importance);
    const raw = parseTurnContent(turn.content, turn.content_type);

    // Plain-text (non-JSON) turn — e.g. a natural-language spec-discussion
    // reply. Previously dropped; now delivered into the local inbox as a
    // text message so the agent wakes (TriggerSystemV2 maps importance to a
    // wake action) and reads it on its next turn. The dispatcher's
    // MessagePort classifier won't match a text payload, so no worker is
    // spawned — correct for a conversational message. The conversation id
    // rides along (mirrors the structured path) so the agent's reply can be
    // threaded back to the right hub conversation.
    if (!raw) {
      const text = typeof turn.content === "string" ? turn.content : "";
      if (!text.trim()) {
        log(
          `[mail-bridge] Skipping empty/non-text turn (conv=${turn.conversation_id ?? "?"} ` +
            `participant=${turn.participant_id ?? "?"})`,
        );
        return;
      }
      const textContent: Record<string, unknown> = {
        type: "text",
        text,
        ...(turn.conversation_id
          ? { _conversationId: turn.conversation_id }
          : {}),
      };
      try {
        await inboxAdapter.send(
          turn.participant_id ?? "openhive-hub",
          recipientId,
          textContent as never,
          {
            threadTag: turn.thread_id,
            importance: wireImportance,
          },
        );
        log(
          `[mail-bridge] Forwarded text turn ${turn.turn_id ?? "?"} into local inbox`,
        );
      } catch (err) {
        log(
          `[mail-bridge] Forward failed for text turn ${turn.turn_id ?? "?"}: ` +
            `${(err as Error).message}`,
        );
      }
      return;
    }

    // Translate hub envelope shape { type, body } → canonical inbox shape
    // { schema, data } that classifyMessage in boot-v2 expects.
    // Hub sends: { type: "x-dispatch/work", body: { prompt, taskId, role } }
    // Classifier expects: { schema: "x-dispatch/work", data: { prompt, taskId, role } }
    const hubType = (raw as { type?: string }).type;
    const hubBody = (raw as { body?: Record<string, unknown> }).body;
    const content: Record<string, unknown> =
      hubType && hubBody
        ? { schema: hubType, data: hubBody }
        : raw;

    // Attach conversation_id as a top-level field in the payload so
    // the mail-inbound consumer can thread it into the worker spawn.
    // This lets the reply bridge look up which hub conversation to post
    // the worker's output back to.
    //
    // IMPORTANT: include `type: "data"` so agent-inbox's normalizeContent()
    // passes the object through unchanged. Without it, an object lacking
    // a `type` string is re-wrapped as `{ type:"data", data: original }`,
    // burying `schema` one level deeper and breaking the consumer's filter.
    const contentWithConvId: Record<string, unknown> = {
      type: "data",
      ...content,
      ...(turn.conversation_id ? { _conversationId: turn.conversation_id } : {}),
    };

    try {
      await inboxAdapter.send(
        turn.participant_id ?? "openhive-hub",
        recipientId,
        contentWithConvId as never,
        {
          threadTag: turn.thread_id,
          importance: wireImportance,
        },
      );
      log(
        `[mail-bridge] Forwarded turn ${turn.turn_id ?? "?"} into local inbox ` +
          `(schema=${(content as { schema?: string }).schema ?? "n/a"})`,
      );
    } catch (err) {
      log(
        `[mail-bridge] Forward failed for turn ${turn.turn_id ?? "?"}: ` +
          `${(err as Error).message}`,
      );
    }
  };

  connection.onNotification("mail/turn.received", handler);

  return () => {
    try {
      connection.offNotification("mail/turn.received", handler);
    } catch {
      // best effort
    }
  };
}
