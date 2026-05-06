# macro-agent/src/dispatch — hub-driven work intake

This directory contains the consumer-side handlers that receive
hub-orchestrated `x-dispatch/work` envelopes from a connected OpenHive
hub (or any hub speaking the same wire shape). Two consumers, one
mail-bridge:

- **`mail-inbound-consumer.ts`** — addressed to the sidecar (`recipient =
  dispatcher:<claimantId>`). Spawns a **fresh, parentless** worker per
  envelope. Used when the hub picks the sidecar as the mail target —
  typically because no specialized worker is registered yet, or because
  the hub's `mail_lifecycle: 'fresh'` hint forced sidecar routing.
- **`mail-inbound-reuse-consumer.ts`** — addressed to a **non-sidecar**
  agent that already exists on the swarm. Forwards the envelope into
  the long-lived agent's prompt iterator instead of spawning. Used for
  `mail_lifecycle: 'reuse'` dispatches against multi-role swarms.
- **`mail-bridge.ts`** — receives `mail/turn.received` MAP notifications
  from the hub and forwards each turn into the sidecar's local
  agent-inbox so the consumers above can dispatch on `inbox.message`.

## Wire envelope shape (hub contract)

Every envelope follows:

```json
{
  "type": "x-dispatch/work",
  "body": {
    "taskId": "disp_xxx",
    "prompt": "<rendered prompt>",
    "role": "worker | executor | reviewer | ...",
    "loadout": { "permissions": {...}, "mcpProviders": [...], ... },
    "metadata": { "permissions": ..., "mcpProviders": ... },  // legacy
    "_conversationId": "conv_xxx"  // mail-reuse path only
  }
}
```

- `body.role` may be **any** string the hub side surfaces (e.g., from a
  team template's `team_role_ref.role`). It is NOT guaranteed to match
  any built-in or locally-configured macro-agent role. The consumer
  must defend against unknown role strings — see "Role validation" below.
- `body.loadout` is the canonical structured slot. `body.metadata` carries
  the legacy permissions/MCP fields for one deprecation cycle so older
  consumers continue to work.

## Role validation (regression hardening)

When the hub surfaces a team-defined role like `'executor'`, the wire
envelope arrives at `mail-inbound-consumer.ts` with `body.role:
'executor'`. macro-agent's role registry has no `'executor'` entry, so
`roleRegistry.resolveRole('executor')` falls back to `GenericRole` —
which has:

- `lifecycle.type: 'persistent'` (no auto-cleanup, no task-bound timeout)
- `WILDCARD_CAPABILITY` (so it has the `done` capability technically),
  but no system-prompt instruction telling the agent to call `done()`

When such an agent finishes a single prompt cycle (`promptUntilDone(...,
{maxFollowUps: 0})`), it stops without invoking `done({summary: ...})`.
The lifecycle handler's `_lastSummary` write is gated on `args.summary`,
so nothing gets persisted. The consumer reads back `_lastSummary` to
post the reply turn — empty → "no reply turn posted" → the hub never
sees an answer and the dispatch silently dies.

The fix: validate the requested role against the registry **before**
passing it to `agentManager.spawn`. Unknown roles fall back to
`'worker'` (ephemeral lifecycle + `LIFECYCLE_CAPABILITIES.DONE` +
explicit "you MUST call done()" system prompt):

```typescript
const requestedRole = data.role;
const roleRegistry = agentManager.getRoleRegistry?.();
const knownRole =
  requestedRole && roleRegistry?.getRole(requestedRole) !== undefined;
const role = knownRole ? requestedRole! : "worker";
if (requestedRole && !knownRole) {
  log(`[mail-inbound] Unknown role '${requestedRole}' for taskId=${taskId} — falling back to 'worker'`);
}
```

`roleRegistry.getRole(name)` is exact-match across custom / project /
user / built-in maps and returns `undefined` for unknown names —
distinct from `resolveRole(name)` which always returns *something* via
`GenericRole`. We use the former here intentionally so the fallback
path is observable (we log a warning) rather than silent.

**Apply the same pattern to any future consumer that spawns workers
from a wire envelope.** The receiving side owns the role taxonomy;
hubs cannot be expected to use names that match the receiver's
registry.

## Reply path (worker → hub)

After the consumer spawns a worker:

1. `agentManager.promptUntilDone(spawnedId, prompt, {maxFollowUps: 0})`
   drives the worker through one prompt cycle.
2. Worker calls `done({status, summary})` — the lifecycle handler
   writes `_lastSummary` to agent metadata (`handlers-v2.ts:233`,
   gated on `inDispatch || !parentId`).
3. AgentManager fires the lifecycle `stopped` event.
4. The consumer's `stopped` listener reads `_lastSummary` from
   `agentStore.getAgent(agentId)` and posts a reply turn into the
   dispatch conversation via `mail/turn`.
5. The hub's `mail.turn.added` event fires; the orchestrator's
   reply-demuxer routes it back to swarm-dispatch as the dispatch
   completion.

If `_lastSummary` is empty when the worker stops, the consumer logs
"Worker stopped but _lastSummary is empty — no reply turn posted" and
bails. This is the canary for role-validation failures, lifecycle
misconfigurations, or agents that exit without calling `done()`.

## Idempotency + dedup

Both consumers track `seenTaskIds` with a 1-hour TTL to drop duplicate
deliveries (the hub's mail-push bridge can re-fire `mail.turn.added`
on reconnect; the local inbox can re-emit `inbox.message` for the same
logical turn). Within the TTL window, a re-delivered taskId is
silently ignored. After the TTL expires, a stale retry could
legitimately re-spawn — preferable to permanent memory growth.

## Tests

- `__tests__/mail-inbound-consumer.test.ts` — unit-level spawn/reply flow with mocked AgentManager
- `__tests__/mail-inbound-consumer.integration.test.ts` — full lifecycle through real `AgentManagerV2`
- `__tests__/mail-inbound-reuse-consumer.test.ts` — reuse-path classification + filtering
- Live e2e (in OpenHive): `src/__tests__/swarm/live-{loadout,mail-reuse}-dispatch*.test.ts` — gated by `LIVE_AGENT_E2E=true`
