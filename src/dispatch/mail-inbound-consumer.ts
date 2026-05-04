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
import { loadoutToSpawnOptions, type WireLoadout } from "./loadout-translation.js";

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

export interface MailInboundConsumerStats {
  /** Count of envelopes dropped because they lacked a taskId. */
  droppedMalformed: number;
  /** Number of distinct taskIds currently tracked for dedup. */
  seenTaskIds: number;
}

export interface MailInboundConsumer {
  stop(): void;
  /** Snapshot of consumer-level counters for observability. */
  stats(): MailInboundConsumerStats;
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

  // taskId → expiresAt: idempotency guard keyed on the dispatch envelope's
  // task identifier. The local inbox can re-fire `inbox.message` for the
  // same logical delivery — without this guard, a single bridged turn would
  // trigger N concurrent spawn() calls, each producing a long-lived ACP
  // subprocess.
  //
  // Bounded by TTL so the map cannot grow unbounded over a long-running
  // deployment. SEEN_TASK_TTL_MS is generous (1 hour) — re-deliveries within
  // that window are dropped, beyond it the dedup expires and a stale retry
  // could legitimately re-spawn (preferable to permanent memory growth).
  const SEEN_TASK_TTL_MS = 60 * 60 * 1000;
  const seenTaskIds = new Map<string, number>();
  function pruneSeenTaskIds(): void {
    const now = Date.now();
    for (const [id, expiresAt] of seenTaskIds) {
      if (expiresAt <= now) seenTaskIds.delete(id);
    }
  }

  // Counter for envelopes dropped because they are malformed (no taskId).
  // Surfaced via the consumer handle's stats() method so operators can
  // distinguish "no work" from "work is broken".
  let droppedMalformedCount = 0;

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
        loadout?: WireLoadout;
        metadata?: Record<string, unknown>;
      };
      _conversationId?: string;
    } | undefined;

    if (content?.schema !== "x-dispatch/work") return;

    const data = content.data;
    if (!data?.taskId) {
      droppedMalformedCount++;
      log(
        `[mail-inbound] Dropping malformed envelope (no taskId, total=${droppedMalformedCount}) — ` +
          `keys=${Object.keys(data ?? {}).join(',')} from=${event.message?.sender_id ?? '?'}`,
      );
      return;
    }

    const taskId = data.taskId;
    pruneSeenTaskIds();
    const seenExpiresAt = seenTaskIds.get(taskId);
    if (seenExpiresAt !== undefined && seenExpiresAt > Date.now()) {
      // Already spawned a worker for this dispatch within the dedup window
      // — silently ignore the re-delivery. The hub treats dispatch as
      // exactly-once on the worker side, so dropping is correct.
      return;
    }
    seenTaskIds.set(taskId, Date.now() + SEEN_TASK_TTL_MS);

    const conversationId = content._conversationId;
    const prompt = data.prompt ?? data.content ?? "";
    const role = data.role ?? "worker";

    // Loadout-derived structured fields ride in the envelope. We prefer the
    // canonical top-level `data.loadout` slot (Step 3 of the ACP+lifecycle
    // plan) but fall back to the legacy `data.metadata.permissions` shape
    // for one deprecation cycle so older hubs that haven't rolled the new
    // wire shape continue to work.
    //
    // `loadoutToSpawnOptions` is shared with the new `dispatch/spawn-agent`
    // MAP handler so both wire paths produce identical spawn options.
    //
    // `fullAutonomous: true` because mail-inbound workers have no human in
    // the loop to answer `ask` rules — collapse them to `allow` (vs. the
    // safer `deny` default for spawns where a human might still be reached).
    let wireLoadout: WireLoadout | undefined = data.loadout;
    if (!wireLoadout) {
      const legacyPermissions = data.metadata?.permissions as
        | { allow?: string[]; deny?: string[]; ask?: string[] }
        | undefined;
      const legacyMcpProviders = data.metadata?.mcpProviders as
        | WireLoadout["mcpProviders"]
        | undefined;
      if (legacyPermissions || legacyMcpProviders) {
        wireLoadout = {
          ...(legacyPermissions ? { permissions: legacyPermissions } : {}),
          ...(legacyMcpProviders ? { mcpProviders: legacyMcpProviders } : {}),
        };
      }
    }
    const spawnLoadoutOpts = loadoutToSpawnOptions(wireLoadout, {
      fullAutonomous: true,
    });

    log(
      `[mail-inbound] Received x-dispatch/work taskId=${taskId} ` +
        `conv=${conversationId ?? "(none)"} role=${role}` +
        (spawnLoadoutOpts.permissions
          ? ` permissions=${JSON.stringify(spawnLoadoutOpts.permissions)}`
          : ""),
    );

    // Spawn is async — fire and forget. Errors are logged, not thrown.
    agentManager
      .spawn({
        task: prompt,
        task_id: taskId,
        role,
        parent: null,
        // Mail-inbound dispatch workers run sandboxed — strip the host's
        // user-level Claude setting sources so installed plugin MCP servers
        // (claude-code-swarm, oh-my-claudecode, …) don't auto-load and hang
        // session/new on environments where the host services aren't reachable.
        isolatedSettings: true,
        ...spawnLoadoutOpts,
      })
      .then(async (spawned) => {
        log(
          `[mail-inbound] Spawned worker agentId=${spawned.id} for taskId=${taskId}`,
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
        } catch (err) {
          log(
            `[mail-inbound] promptUntilDone failed for agentId=${spawned.id}: ` +
              `${(err as Error).message ?? String(err)}`,
          );
        }
      })
      .catch((err: unknown) => {
        log(
          `[mail-inbound] Spawn failed for taskId=${taskId}: ${
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
        `conv=${conversationId}`,
    );

    const sidecar = getSidecar();
    if (!sidecar?.postMailTurn) {
      log(`[mail-inbound] No sidecar/postMailTurn — reply turn dropped`);
      return;
    }

    sidecar.postMailTurn(conversationId, agentId, summary)
      .then(() => {
        // Clear the stored summary so it can't replay if the same agentId
        // is ever reused for another dispatch (the AgentManager generally
        // mints fresh ids, but this is cheap insurance against a future
        // change).
        try {
          const existingMeta = agentStore.getAgent(agentId)?.metadata ?? {};
          const { _lastSummary: _drop, ...rest } = existingMeta as Record<string, unknown>;
          void _drop;
          agentStore.updateAgent(agentId, { metadata: rest });
        } catch {
          // best-effort — store may be closing during shutdown
        }
      })
      .catch(() => {
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
    stats() {
      pruneSeenTaskIds();
      return {
        droppedMalformed: droppedMalformedCount,
        seenTaskIds: seenTaskIds.size,
      };
    },
  };
}
