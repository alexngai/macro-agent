/**
 * Mail-Inbound Reuse Consumer
 *
 * Receives hub-driven `x-dispatch/work` envelopes addressed to **non-sidecar**
 * agents — long-lived team workers, coordinators, etc. — and drives them
 * through the dispatch turn using their existing session, then posts the
 * summary back as a mail turn.
 *
 * Mirrors `mail-inbound-consumer.ts` but with three semantic differences:
 *
 *   1. Filters envelopes addressed to ANY non-sidecar agent (the existing
 *      consumer filters for the dispatcher recipient).
 *   2. Does **not** spawn — it drives the existing agent's session via
 *      `agentManager.prompt(agentId, prompt)` and watches for `done()` in
 *      the update stream.
 *   3. Tracks `inflightDispatches` per agentId. A second envelope arriving
 *      while the same agent is already processing a dispatch is rejected
 *      with `recipient_busy` so the orchestrator can retry against another
 *      agent (or fall back to fresh-spawn). Reject is **dispatch-scoped**
 *      — non-dispatch work on the agent (peer messages, user chat) does
 *      NOT trigger the busy reject; that work stacks naturally.
 *
 * Reply path: captures `args.summary` from the done() tool call's rawInput
 * directly off the update stream, so it works for both parented and
 * parentless target agents (the parented branch in `handlers-v2` does NOT
 * stash `_lastSummary` — only parentless agents do — but we don't need
 * that path because we observe done() in-stream).
 *
 * @module dispatch/mail-inbound-reuse-consumer
 */

import type { AgentManager } from "../agent/agent-manager.js";
import type { AgentStore } from "../agent/agent-store.js";
import type { ExtendedSessionUpdate } from "../agent/types.js";
import type {
  InboxEvents,
  InboxMessageEvent,
  MailInboundSidecar,
} from "./mail-inbound-consumer.js";
import type { WireLoadout } from "./loadout-translation.js";

export interface MailInboundReuseConsumerOptions {
  /**
   * The sidecar agent ID. Envelopes addressed to this id are handled by
   * the original `mail-inbound-consumer` (fresh-spawn path); the reuse
   * consumer ignores them so the two consumers' filters don't overlap.
   */
  dispatcherAgentId: string;

  /** Raw inbox event emitter (from inboxAdapter.getInbox().events). */
  inboxEvents: InboxEvents;

  /** Agent lifecycle manager — used to drive the existing session. */
  agentManager: AgentManager;

  /** Agent store — used to confirm the target agent is running. */
  agentStore: AgentStore;

  /**
   * Optional sidecar reference. Populated after step 13 in boot-v2 via
   * the shared systemRef. The consumer accesses it lazily at reply time.
   */
  getSidecar: () => MailInboundSidecar | null | undefined;

  /** Optional logger (default: console.log). */
  log?: (msg: string) => void;
}

export interface MailInboundReuseConsumerStats {
  /** Count of envelopes dropped because they lacked a taskId. */
  droppedMalformed: number;
  /** Number of distinct taskIds currently tracked for dedup. */
  seenTaskIds: number;
  /** Number of rejects emitted because the target agent was already busy with a dispatch. */
  busyRejects: number;
  /** Currently in-flight dispatches keyed by agentId. */
  inflightCount: number;
}

export interface MailInboundReuseConsumer {
  stop(): void;
  stats(): MailInboundReuseConsumerStats;
}

interface InflightDispatch {
  dispatchId: string;
  conversationId: string | null;
  startedAt: number;
}

const SEEN_TASK_TTL_MS = 60 * 60 * 1000;

/**
 * Wire the mail-inbound reuse consumer.
 *
 * Returns a `stop()` handle that detaches the inbox listener.
 */
export function createMailInboundReuseConsumer(
  opts: MailInboundReuseConsumerOptions,
): MailInboundReuseConsumer {
  const {
    dispatcherAgentId,
    inboxEvents,
    agentManager,
    agentStore,
    getSidecar,
    log = (msg: string) => console.log(msg),
  } = opts;

  // agentId → inflight dispatch state. Used both to gate concurrent
  // dispatches against the same agent and to look up the conversation
  // when posting the reply.
  const inflightDispatches = new Map<string, InflightDispatch>();

  // taskId → expiresAt: idempotency guard mirroring mail-inbound-consumer.
  const seenTaskIds = new Map<string, number>();
  function pruneSeenTaskIds(): void {
    const now = Date.now();
    for (const [id, expiresAt] of seenTaskIds) {
      if (expiresAt <= now) seenTaskIds.delete(id);
    }
  }

  let droppedMalformedCount = 0;
  let busyRejectCount = 0;

  log(
    `[mail-inbound-reuse] Consumer ready — listening for x-dispatch/work envelopes ` +
      `addressed to non-sidecar agents (sidecar=${dispatcherAgentId})`,
  );

  const onMessage = (event: InboxMessageEvent): void => {
    // Only handle envelopes addressed to NON-sidecar agents. Sidecar
    // envelopes are owned by mail-inbound-consumer (fresh-spawn).
    if (event.agentId === dispatcherAgentId) return;

    const content = event.message?.content as
      | {
          schema?: string;
          data?: {
            taskId?: string;
            prompt?: string;
            content?: string;
            role?: string;
            tags?: string[];
            loadout?: WireLoadout;
            metadata?: Record<string, unknown>;
          };
          _conversationId?: string;
        }
      | undefined;

    if (content?.schema !== "x-dispatch/work") return;

    const data = content.data;
    if (!data?.taskId) {
      droppedMalformedCount++;
      log(
        `[mail-inbound-reuse] Dropping malformed envelope (no taskId, total=${droppedMalformedCount})`,
      );
      return;
    }

    const taskId = data.taskId;
    pruneSeenTaskIds();
    const seenExpiresAt = seenTaskIds.get(taskId);
    if (seenExpiresAt !== undefined && seenExpiresAt > Date.now()) {
      // Re-delivery within dedup window — silently drop.
      return;
    }
    seenTaskIds.set(taskId, Date.now() + SEEN_TASK_TTL_MS);

    const targetAgentId = event.agentId;
    const conversationId = content._conversationId ?? null;
    const prompt = data.prompt ?? data.content ?? "";

    // Resolve target — must be a known, non-stopped agent.
    const targetRecord = agentStore.getAgent(targetAgentId);
    if (!targetRecord) {
      log(
        `[mail-inbound-reuse] Unknown target agent ${targetAgentId} for taskId=${taskId} — dropping`,
      );
      void postReplyTurn(conversationId, targetAgentId, {
        status: "agent_unavailable",
        reason: `Agent ${targetAgentId} not registered on this swarm`,
      });
      return;
    }
    if (targetRecord.state === "stopped" || targetRecord.state === "failed") {
      log(
        `[mail-inbound-reuse] Target agent ${targetAgentId} state=${targetRecord.state} — dropping taskId=${taskId}`,
      );
      void postReplyTurn(conversationId, targetAgentId, {
        status: "agent_unavailable",
        reason: `Agent ${targetAgentId} state=${targetRecord.state}`,
      });
      return;
    }

    // In-flight check — only reject when this same agent is already
    // processing another tracked dispatch. Non-dispatch work (peer chat,
    // user prompts) does not block; promptUntilDone-style serial stacking
    // handles that.
    const existing = inflightDispatches.get(targetAgentId);
    if (existing) {
      busyRejectCount++;
      log(
        `[mail-inbound-reuse] recipient_busy — agent=${targetAgentId} already processing ` +
          `dispatch=${existing.dispatchId}; rejecting taskId=${taskId}`,
      );
      void postReplyTurn(conversationId, targetAgentId, {
        status: "recipient_busy",
        reason: `Agent ${targetAgentId} is processing dispatch ${existing.dispatchId}`,
      });
      return;
    }

    log(
      `[mail-inbound-reuse] Driving dispatch taskId=${taskId} on existing agent=${targetAgentId} ` +
        `conv=${conversationId ?? "(none)"}`,
    );

    inflightDispatches.set(targetAgentId, {
      dispatchId: taskId,
      conversationId,
      startedAt: Date.now(),
    });

    // Drive the agent's existing session via raw `prompt()` rather than
    // `promptUntilDone` because the latter auto-terminates the agent on
    // done() — fatal for long-lived workers we want to reuse. We watch
    // the update stream ourselves for the done() tool call and capture
    // the summary inline.
    void driveDispatch(targetAgentId, taskId, prompt, conversationId).finally(
      () => {
        inflightDispatches.delete(targetAgentId);
      },
    );
  };

  async function driveDispatch(
    targetAgentId: string,
    taskId: string,
    prompt: string,
    conversationId: string | null,
  ): Promise<void> {
    let summary: string | undefined;
    let status: string | undefined;
    let doneSeen = false;

    try {
      for await (const update of agentManager.prompt(targetAgentId, prompt)) {
        const captured = captureDoneCall(update);
        if (captured) {
          doneSeen = true;
          if (captured.summary) summary = captured.summary;
          if (captured.status) status = captured.status;
        }
      }
    } catch (err) {
      log(
        `[mail-inbound-reuse] prompt() threw for agent=${targetAgentId} taskId=${taskId}: ` +
          `${(err as Error).message ?? String(err)}`,
      );
      void postReplyTurn(conversationId, targetAgentId, {
        status: "failed",
        reason: `Prompt failed: ${(err as Error).message ?? String(err)}`,
      });
      return;
    }

    if (!doneSeen) {
      log(
        `[mail-inbound-reuse] Agent ${targetAgentId} finished prompt without calling done() ` +
          `for taskId=${taskId} — posting "incomplete" reply`,
      );
      void postReplyTurn(conversationId, targetAgentId, {
        status: "incomplete",
        reason: "Agent did not call done() within the prompt cycle",
      });
      return;
    }

    const replyContent = summary ?? `Dispatch ${taskId} ${status ?? "completed"} (no summary)`;
    void postReplyTurn(conversationId, targetAgentId, replyContent);
  }

  /**
   * Detect a `done()` tool-call update and extract `{ status, summary }`
   * from rawInput. Mirrors `promptUntilDone`'s detection logic but also
   * captures `summary` (which the AgentManager's loop discards).
   */
  function captureDoneCall(
    update: ExtendedSessionUpdate,
  ): { status?: string; summary?: string } | null {
    const u = update as unknown as Record<string, unknown>;
    const sessionUpdate = u.sessionUpdate;
    const title = u.title;

    const isDoneToolCall =
      (sessionUpdate === "tool_call" || sessionUpdate === "tool_call_update") &&
      typeof title === "string" &&
      title.endsWith("__done");

    if (!isDoneToolCall) {
      // Older fallback shape.
      if (
        u.type === "result" &&
        u.subtype === "tool_result" &&
        u.toolName === "done"
      ) {
        const result = u.result as { status?: string; summary?: string } | undefined;
        if (result) {
          return { status: result.status, summary: result.summary };
        }
      }
      return null;
    }

    let input: { status?: string; summary?: string } | undefined;
    try {
      const raw = u.rawInput;
      if (typeof raw === "string") {
        input = JSON.parse(raw) as { status?: string; summary?: string };
      } else if (raw && typeof raw === "object") {
        input = raw as { status?: string; summary?: string };
      } else if (u.input && typeof u.input === "object") {
        input = u.input as { status?: string; summary?: string };
      }
    } catch {
      // rawInput not yet parseable (multi-update tool call); ignore.
    }

    if (!input) return null;
    return { status: input.status, summary: input.summary };
  }

  async function postReplyTurn(
    conversationId: string | null,
    fromAgentId: string,
    content: string | { status: string; reason: string },
  ): Promise<void> {
    if (!conversationId) {
      log(
        `[mail-inbound-reuse] No conversationId — reply for ${fromAgentId} dropped: ` +
          `${typeof content === "string" ? content.slice(0, 80) : content.status}`,
      );
      return;
    }
    const sidecar = getSidecar();
    if (!sidecar?.postMailTurn) {
      log(`[mail-inbound-reuse] No sidecar/postMailTurn — reply turn dropped`);
      return;
    }
    const body = typeof content === "string" ? content : JSON.stringify(content);
    try {
      await sidecar.postMailTurn(conversationId, fromAgentId, body);
    } catch (err) {
      log(
        `[mail-inbound-reuse] postMailTurn failed for ${fromAgentId}: ` +
          `${(err as Error).message ?? String(err)}`,
      );
    }
  }

  inboxEvents.on("inbox.message", onMessage);

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
      log(`[mail-inbound-reuse] Consumer stopped`);
    },
    stats() {
      pruneSeenTaskIds();
      return {
        droppedMalformed: droppedMalformedCount,
        seenTaskIds: seenTaskIds.size,
        busyRejects: busyRejectCount,
        inflightCount: inflightDispatches.size,
      };
    },
  };
}
