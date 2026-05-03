/**
 * Mail-Inbound Consumer
 *
 * Receives hub-driven `x-dispatch/work` envelopes from the local agent-inbox
 * and spawns a worker agent to handle them — without requiring the optional
 * outbound swarm-dispatch orchestrator (`config.dispatch.enabled`).
 *
 * This makes mail-inbound dispatch a **default capability** of macro-agent: as
 * long as the MAP sidecar is connected and the inbox is running, any hub that
 * delivers work via `mail/turn.received` will be served.
 *
 * ## Data flow
 *
 *   hub sends `mail/turn.received`
 *     → mail-bridge translates {type,body} → {schema,data} + _conversationId
 *     → inboxAdapter delivers to local inbox (recipient = dispatcherAgentId)
 *     → inbox.events fires "inbox.message"
 *     → consumer classifies: schema === 'x-dispatch/work'?
 *       yes → spawn worker via agentManager.spawn()
 *            → record agentId → conversationId in side map
 *     → worker calls done(summary="…SENTINEL…")
 *     → handlers-v2 stores _lastSummary in agentStore metadata (parentId null branch)
 *     → agentManager.onLifecycleEvent fires "stopped"
 *     → consumer reads _lastSummary + conversationId
 *     → mapSidecar.postMailTurn(conversationId, agentId, summary)  [fire-and-forget]
 *
 * @module dispatch/mail-inbound-consumer
 */

import type { AgentManager } from "../agent/agent-manager.js";
import type { AgentStore } from "../agent/agent-store.js";

// ─────────────────────────────────────────────────────────────────
// Dependency interfaces (narrow — keeps the module testable without
// dragging in the full InboxAdapter / MAPSidecar concrete types)
// ─────────────────────────────────────────────────────────────────

export interface InboxEvents {
  on(event: "inbox.message", listener: (event: InboxMessageEvent) => void): void;
  off?(event: "inbox.message", listener: (event: InboxMessageEvent) => void): void;
  removeListener?(event: "inbox.message", listener: (event: InboxMessageEvent) => void): void;
}

export interface InboxMessageEvent {
  /** The inbox recipient agent ID. */
  agentId: string;
  message: {
    id?: string;
    content?: unknown;
    sender_id?: string;
    thread_tag?: string;
  };
}

export interface MailInboundSidecar {
  postMailTurn?(
    conversationId: string,
    participantId: string,
    content: string,
  ): Promise<void>;
}

export interface MailInboundConsumerOptions {
  /**
   * The inbox agent ID that mail-bridge delivers envelopes to.
   * Typically `dispatcher:<claimantId>` when the outbound orchestrator
   * is also running, or a dedicated ID when it is not.
   */
  dispatcherAgentId: string;

  /** Raw inbox event emitter (from inboxAdapter.getInbox().events). */
  inboxEvents: InboxEvents;

  /** Agent lifecycle manager — used to spawn workers. */
  agentManager: AgentManager;

  /** Agent store — used to read _lastSummary after the agent stops. */
  agentStore: AgentStore;

  /**
   * Optional sidecar reference. Populated after step 13 in boot-v2 via
   * the shared systemRef — the consumer accesses it lazily at reply time
   * so it works even though the sidecar is created after the consumer.
   */
  getSidecar: () => MailInboundSidecar | null | undefined;

  /** Optional logger (default: console.log). */
  log?: (msg: string) => void;
}

export interface MailInboundConsumer {
  stop(): void;
}

// ─────────────────────────────────────────────────────────────────
// Implementation
// ─────────────────────────────────────────────────────────────────

/**
 * Wire the mail-inbound consumer.
 *
 * Returns a `stop()` handle that detaches all listeners.
 * Safe to call multiple times (idempotent cleanup).
 */
export function createMailInboundConsumer(
  opts: MailInboundConsumerOptions,
): MailInboundConsumer {
  const {
    dispatcherAgentId,
    inboxEvents,
    agentManager,
    agentStore,
    getSidecar,
    log = (msg: string) => console.log(msg),
  } = opts;

  // ── Side-channel maps ────────────────────────────────────────
  // agentId → conversationId: populated when a worker is spawned for a
  // mail-inbound envelope; read when the agent's stopped event fires.
  const agentConversationMap = new Map<string, string>();

  // taskId → 1: idempotency guard keyed on the dispatch envelope's task
  // identifier (which is stable across redeliveries). The local inbox can
  // re-fire `inbox.message` for the same logical delivery — without
  // this, a single bridged turn would trigger N concurrent spawn()
  // calls, each producing a long-lived ACP subprocess. We dedupe on
  // taskId because (a) message.id may not survive routing transforms
  // and (b) the dispatch contract guarantees each taskId is processed
  // exactly once on the agent side.
  const seenTaskIds = new Set<string>();

  log(
    `[mail-inbound] Consumer ready — listening for x-dispatch/work envelopes ` +
      `(recipient=${dispatcherAgentId})`,
  );

  // ── Inbox message listener ───────────────────────────────────
  const onMessage = (event: InboxMessageEvent): void => {
    // Only handle messages delivered to our dispatcher recipient.
    if (event.agentId !== dispatcherAgentId) return;

    const content = event.message?.content as {
      schema?: string;
      data?: {
        taskId?: string;
        prompt?: string;
        content?: string;
        title?: string;
        role?: string;
        tags?: string[];
        metadata?: Record<string, unknown>;
      };
      _conversationId?: string;
    } | undefined;

    if (content?.schema !== "x-dispatch/work") return;

    const data = content.data;
    if (!data?.taskId) {
      log(`[mail-inbound] Dropping envelope with missing taskId`);
      return;
    }

    const taskId = data.taskId;
    if (seenTaskIds.has(taskId)) {
      // Already spawned a worker for this dispatch — silently ignore the
      // re-delivery. The hub treats dispatch as exactly-once on the
      // worker side, so dropping is correct.
      return;
    }
    seenTaskIds.add(taskId);

    const conversationId = content._conversationId;
    const prompt = data.prompt ?? data.content ?? "";
    const role = data.role ?? "worker";

    log(
      `[mail-inbound] Received x-dispatch/work taskId=${taskId} ` +
        `conv=${conversationId ?? "(none)"} role=${role}`,
    );

    // Spawn is async — fire and forget. Errors are logged, not thrown.
    log(`[mail-inbound] Calling agentManager.spawn for taskId=${taskId}...`);
    const spawnStart = Date.now();
    agentManager
      .spawn({
        task: prompt,
        task_id: taskId,
        role,
        parent: null,
      })
      .then(async (spawned) => {
        const elapsed = Date.now() - spawnStart;
        log(
          `[mail-inbound] Spawned worker agentId=${spawned.id} for taskId=${taskId} (${elapsed}ms)`,
        );
        if (conversationId) {
          agentConversationMap.set(spawned.id, conversationId);
        }

        // Spawn only creates an idle ACP session — the task lives in the
        // system prompt as instructions. To get the model to actually do
        // the work, send the prompt as a user message via promptUntilDone.
        // This drives the worker to completion (done() called) so the
        // lifecycle stopped listener below fires and posts the reply
        // back to the hub. Fire-and-forget; errors are logged.
        try {
          await agentManager.promptUntilDone(spawned.id, prompt, {
            maxFollowUps: 0,
          });
          log(
            `[mail-inbound] promptUntilDone completed for agentId=${spawned.id}`,
          );
        } catch (err) {
          log(
            `[mail-inbound] promptUntilDone failed for agentId=${spawned.id}: ` +
              `${(err as Error).message ?? String(err)}`,
          );
        }
      })
      .catch((err: unknown) => {
        const elapsed = Date.now() - spawnStart;
        log(
          `[mail-inbound] Spawn failed for taskId=${taskId} after ${elapsed}ms: ${
            (err as Error).message ?? String(err)
          }`,
        );
      });
  };

  inboxEvents.on("inbox.message", onMessage);

  // ── Lifecycle stopped listener ───────────────────────────────
  const unsubscribeLifecycle = agentManager.onLifecycleEvent((event) => {
    if (event.type !== "stopped") return;

    const agentId = event.agent.id;
    const conversationId = agentConversationMap.get(agentId);
    if (!conversationId) return; // not a mail-inbound worker we spawned

    agentConversationMap.delete(agentId);

    // Read the summary stored by handlers-v2 for parentless workers.
    const record = agentStore.getAgent(agentId);
    const summary = record?.metadata?._lastSummary as string | undefined;
    if (!summary) {
      log(
        `[mail-inbound] Worker agentId=${agentId} stopped but _lastSummary is empty — ` +
          `no reply turn posted`,
      );
      return;
    }

    log(
      `[mail-inbound] Worker agentId=${agentId} stopped — posting reply to ` +
        `conv=${conversationId} (summary first 120 chars: ${JSON.stringify(summary.slice(0, 120))})`,
    );

    const sidecar = getSidecar();
    if (!sidecar?.postMailTurn) {
      log(`[mail-inbound] No sidecar/postMailTurn — reply turn dropped`);
      return;
    }

    sidecar.postMailTurn(conversationId, agentId, summary).catch(() => {
      // best-effort — hub may be temporarily unreachable
    });
  });

  // ── Cleanup ──────────────────────────────────────────────────
  let stopped = false;
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      try {
        if (inboxEvents.off) {
          inboxEvents.off("inbox.message", onMessage);
        } else if (inboxEvents.removeListener) {
          inboxEvents.removeListener("inbox.message", onMessage);
        }
      } catch {
        // best effort
      }
      unsubscribeLifecycle();
      log(`[mail-inbound] Consumer stopped`);
    },
  };
}
