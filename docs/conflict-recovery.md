# Conflict Recovery Design (Draft)

Parallel design to `docs/workspace-interfaces.md`. Defines how macro-agent handles merge/rebase/cascade conflicts produced by `WorkspaceManager` operations.

**Status**: draft for iteration. Not yet implemented.

**Relationship to other docs:**
- `git-cascade-integration-gaps.md` — narrative, established that conflict recovery is its own concern (§9 Open).
- `workspace-interfaces.md` — defines `ConflictRecord`, `WorkspaceManager.resolveConflict()`. This doc defines how recovery is *driven*.

---

## 1. Problem statement

Conflicts arise from four operations:

- `mergeStream(source → target)` — merge conflict between branches
- `syncWithParent(stream)` — rebase conflict when parent advanced
- `rebaseOntoStream(stream → target)` — same
- `cascadeRebase({ rootStreamId })` — one or more dependent streams fail to rebase

git-cascade records each via `createConflict()`; the stream is marked `conflicted`. Today, macro-agent has no handling — strategies use raw `execSync('git rebase')` which fails hard, and the event is lost.

The redesign needs a **pluggable recovery mechanism** that sits between detection (git-cascade's conflict model) and resolution (which might be git strategies, a spawned resolver agent, a human, or abandonment). The mechanism must work for all four sources.

---

## 2. When conflicts happen — lifecycle

```
Landing / sync / cascade operation
    │
    ├─ Success: MergeResult.success = true
    │            stream.committed event emitted
    │
    └─ Conflict: ConflictRecord created in git-cascade
                 stream marked 'conflicted'
                 stream.conflicted event emitted
                 MergeResult.success = false, conflictId returned
                 │
                 ├─ LandingStrategy / operation caller receives result
                 │
                 └─ workspaceManager.recoverConflict({ conflictId, strategyName? })
                           │
                           └─ Recovery strategy dispatches
                                      │
                                      ├─ Sync resolution → returns ConflictResolution immediately
                                      └─ Async resolution → returns pending; events fire on completion
```

**Key separation**: LandingStrategy decides *how to land*; ConflictRecoveryStrategy decides *what to do when landing fails*. They're parallel concerns, not nested.

---

## 3. Core types

```ts
export interface ConflictContext {
  conflictId: string;
  streamId: StreamId;                  // the conflicted stream
  sourceCommit?: string;
  targetCommit?: string;
  targetStreamId?: StreamId;           // where we were trying to land (if applicable)
  paths: string[];                     // conflicting file paths
  operation: "merge" | "sync" | "rebase" | "cascade";
  landingAgentId?: AgentId;            // who was trying to land (may be terminated)
  recoveryDepth: number;               // for bounded recursion
  strategyConfig?: Record<string, unknown>;
  workspaceManager: WorkspaceManager;
  agentManager: AgentManager;
  inboxAdapter: InboxAdapter;
}

export type ConflictResolution =
  | { kind: "resolved"; resolutionCommit: string }
  | { kind: "deferred"; reason: string }
  | { kind: "abandoned"; streamId: StreamId; reason: string }
  | { kind: "escalated"; escalatedTo: AgentId | "human" }
  | { kind: "retry-after"; backoffMs: number; reason: string }
  | { kind: "failed"; error: string };

export type ConflictResolutionMode = "sync" | "async";

export interface ConflictRecoveryStrategy {
  readonly name: string;
  readonly mode: ConflictResolutionMode;

  canHandle?(ctx: ConflictContext): boolean;
  recover(ctx: ConflictContext): Promise<ConflictResolution>;

  initialize?(): Promise<void>;
  close?(): Promise<void>;
}
```

**Rationale:**
- `recoveryDepth` prevents infinite recursion if a resolver creates new conflicts.
- `mode` is declarative — callers can decide whether to await or fire-and-forget based on it.
- `operation` tells strategies what produced the conflict (merge-specific resolution differs from rebase-specific).
- `landingAgentId` may be null or already terminated; strategies can't rely on it being alive.

---

## 4. Built-in strategies

Five registered by default. Teams pick via YAML `on_conflict:` directive.

### 4.1 `auto-resolve` — sync, git-native strategies

```ts
// strategyConfig: { strategy: "ours" | "theirs" | "union" }
// Runs raw git merge with -X <strategy>; commits the resolution.
// Returns: { kind: "resolved", resolutionCommit } or { kind: "failed", ... }
```

Use cases: low-risk conflicts where one side is authoritative. Example: a reviewer branch that should always defer to coder's changes.

**Constraint**: Only applicable to `operation: "merge"`. Rebase conflicts need different handling.

### 4.2 `defer` — sync, no-op

```ts
// Creates no new state; conflict record persists, stream stays 'conflicted'.
// Returns: { kind: "deferred", reason: "no strategy configured" }
```

Use cases: the team doesn't want automated recovery. Something else (human, external process) will deal with it.

### 4.3 `spawn-resolver` — async, LLM-driven

```ts
// strategyConfig: {
//   role: string;               // e.g., "resolver"
//   max_concurrent?: number;    // default 2
//   timeout_ms?: number;        // default 1800000 (30 min)
//   prompt_template?: string;   // optional prompt override
// }
//
// 1. Emit conflict.recovery.started event
// 2. AgentManager.spawn({ role, options: { conflictId, streamId, paths } })
// 3. Resolver's topology places it on the conflicted stream via
//    workspace: new_stream, stream_lineage: track_existing_branch,
//    track_branch: <conflicted_branch>.
// 4. Resolver has capabilities: [workspace.commit, workspace.resolve, workspace.read]
// 5. Resolver reads conflict markers, edits, commits, calls resolve_conflict MCP tool.
// 6. resolve_conflict → workspaceManager.resolveConflict({ conflictId, resolutionCommit })
//    → emits conflict.resolved event
//    → stream status back to 'active'
// 7. Original operation retried (if requested via config).
//
// Returns: { kind: "resolved", resolutionCommit } on success
//          { kind: "escalated", escalatedTo: "human" } on timeout
```

Use cases: default for teams with LLM budget. Handles most real conflicts via LLM judgment.

**Recursion bound**: if resolver's `resolve_conflict` call produces a new conflict, `recoveryDepth` increments. Default max = 3; beyond that, falls back to `escalate`.

### 4.4 `abandon` — sync, give up

```ts
// Calls workspaceManager.abandonStream(streamId, { reason }).
// If operation was 'merge', source stream is abandoned; target untouched.
// If operation was 'sync' / 'rebase' / 'cascade', conflicted stream is abandoned
//   (cascade: just the failing stream; siblings continue per cascade strategy).
// Returns: { kind: "abandoned", streamId, reason }
```

Use cases: throwaway exploration streams; CI-driven teams where broken work is discarded.

### 4.5 `escalate` — async, human-in-the-loop

```ts
// strategyConfig: { notify: AgentId[] | "team-root" | "external-channel" }
//
// 1. Create inbox message with high importance to configured recipients
// 2. Pause stream via workspaceManager.pauseStream(streamId, "awaiting human")
// 3. Emit conflict.recovery.escalated event
// 4. Wait indefinitely for external resolve_conflict call
// 5. On external resolution: resume stream, emit conflict.resolved
//
// Returns: { kind: "escalated", escalatedTo }
```

Use cases: high-stakes merges; teams with human reviewers; fallback from `spawn-resolver` timeout.

---

## 5. Integration with LandingStrategy

Landing strategies detect conflicts but don't handle them directly. Contract:

```ts
// Inside a LandingStrategy.land(ctx):

const mergeResult = await ctx.workspaceManager.mergeStream({ ... });
if (!mergeResult.success && mergeResult.conflictId) {
  // Do NOT call recoverConflict from inside the strategy.
  // Return the conflict up; the caller (agent's done flow) handles it.
  return {
    success: false,
    conflictId: mergeResult.conflictId,
  };
}
```

**Why not in-strategy recovery?** Three reasons:
1. Strategies can be registered without recovery knowledge. Separation of concerns.
2. Recovery policy is role-level (`on_conflict:` YAML), not strategy-level.
3. Async recovery means strategy would have to block on recovery resolution — fragile.

Instead, the agent's `done()` flow owns recovery dispatch:

```ts
// In AgentManagerV2's done handler (or land MCP tool handler):

const landingResult = await workspaceManager.land({ ... });
if (!landingResult.success && landingResult.conflictId) {
  const roleConfig = topologyPolicy.getRoleConfig(agent.role);
  const recoveryStrategy = roleConfig.on_conflict ?? teamDefault.conflict_recovery.default_strategy;

  const resolution = await workspaceManager.recoverConflict({
    conflictId: landingResult.conflictId,
    strategyName: recoveryStrategy,
    strategyConfig: roleConfig.conflict_recovery_config,
    operation: "merge",
    landingAgentId: agent.id,
  });

  // Handle resolution result — may be async; if so, agent can terminate
  // and let recovery run in background.
}
```

---

## 6. `WorkspaceManager` additions

Extend the interface from `workspace-interfaces.md` §5:

```ts
interface WorkspaceManager {
  // ... existing methods ...

  // Conflict recovery registry
  registerConflictRecoveryStrategy(strategy: ConflictRecoveryStrategy): void;
  unregisterConflictRecoveryStrategy(name: string): void;
  getConflictRecoveryStrategy(name: string): ConflictRecoveryStrategy | null;

  // Recovery dispatch
  recoverConflict(opts: {
    conflictId: string;
    strategyName?: string;              // defaults to team default
    strategyConfig?: Record<string, unknown>;
    operation?: "merge" | "sync" | "rebase" | "cascade";
    landingAgentId?: AgentId;
  }): Promise<ConflictResolution>;

  // Existing method, formalized
  resolveConflict(opts: {
    conflictId: string;
    resolvedBy: Principal;
    resolutionCommit?: string;
  }): void;                              // Called by resolver agents via MCP tool.
                                         // Emits conflict.resolved event.

  // Listing / inspection
  listConflicts(filter?: {
    streamId?: StreamId;
    resolved?: boolean;
  }): ConflictRecord[];

  getConflict(conflictId: string): ConflictRecord | null;
}
```

New events (extend `WorkspaceEvent` union):

```ts
| { kind: "conflict.created"; conflictId: string; streamId: StreamId; operation: string }
| { kind: "conflict.recovery.started"; conflictId: string; strategyName: string }
| { kind: "conflict.recovery.escalated"; conflictId: string; escalatedTo: string }
| { kind: "conflict.recovery.timed-out"; conflictId: string; strategyName: string }
| { kind: "conflict.resolved"; conflictId: string; resolutionCommit?: string; resolvedBy: Principal }
| { kind: "conflict.abandoned"; conflictId: string; reason: string }
```

---

## 7. YAML configuration

```yaml
macro_agent:
  workspace:
    roles:
      worker:
        on_conflict: defer              # strategy name
      coder:
        on_conflict: spawn-resolver
        conflict_recovery_config:
          role: resolver
          timeout_ms: 1200000
      resolver:
        workspace: new_stream
        stream_lineage: track_existing_branch
        # track_branch is set at spawn time from conflict context
        landing: none                   # resolver doesn't land itself
        capabilities:
          - workspace.commit
          - workspace.resolve
          - workspace.read

  # Team-level defaults
  conflict_recovery:
    default_strategy: spawn-resolver    # used when role has no on_conflict
    default_config:
      role: resolver
      max_concurrent: 2
      timeout_ms: 1800000
    escalation_target: team-root        # for escalate strategy
    max_recovery_depth: 3               # recursion bound
```

**Resolution order for strategy selection:**
1. Role-level `on_conflict` (most specific)
2. Team-level `conflict_recovery.default_strategy`
3. Hardcoded fallback: `defer` (safest default)

---

## 8. MCP tool surface

New capability: `workspace.resolve`. Registered tools:

```ts
// ── Capability: workspace.resolve ────────────────────────────────
export const resolveConflictToolInput = z.object({
  conflictId: z.string(),
  resolutionCommit: z.string().optional(),  // inferred from current HEAD if omitted
});
// Handler: workspaceManager.resolveConflict({ conflictId, resolvedBy: agentId, resolutionCommit })
//   → emits conflict.resolved event
//   → returns { resolved: true, conflictId, resolutionCommit }

export const listConflictsToolInput = z.object({
  streamId: z.string().optional(),
  resolvedOnly: z.boolean().default(false),
});
// Handler: workspaceManager.listConflicts({ ... })

export const getConflictToolInput = z.object({
  conflictId: z.string(),
});
// Handler: workspaceManager.getConflict(conflictId)
```

**Capability → tool mapping:**

| Capability | Tools |
|---|---|
| `workspace.resolve` | `resolve_conflict`, `list_conflicts`, `get_conflict` |

Resolver roles need `workspace.resolve` + `workspace.commit` + `workspace.read`.

---

## 9. End-to-end flow: `spawn-resolver`

```
[Coder agent] lands via queue-to-branch strategy
  └─ queue-to-branch.land(ctx):
       workspaceManager.addToMergeQueue({ streamId: coderStream, targetBranch })
       returns { success: true, queuedAt: ... }

[Integrator agent] drains queue
  └─ integrator.processNextMergeRequest():
       next = workspaceManager.getNextToMerge(targetBranch)
       result = workspaceManager.mergeStream({ sourceStreamId: next.streamId, ... })
       → CONFLICT: result.success = false, result.conflictId = "c-abc"
       workspaceManager.markMergeQueueReady(next.id, { status: "conflicted" })

[Integrator's landing flow sees conflict in result]
  └─ done handler:
       roleConfig.on_conflict = "spawn-resolver" (from YAML)
       resolution = await workspaceManager.recoverConflict({
         conflictId: "c-abc",
         strategyName: "spawn-resolver",
         strategyConfig: { role: "resolver", timeout_ms: 1200000 },
         operation: "merge",
         landingAgentId: integratorId,
       })

[SpawnResolverStrategy.recover(ctx)]
  emit conflict.recovery.started
  agentId = await agentManager.spawn({
    role: "resolver",
    parent: ctx.landingAgentId,
    task: `Resolve conflict ${ctx.conflictId} on stream ${ctx.streamId}`,
    options: {
      conflictId: ctx.conflictId,
      streamId: ctx.streamId,
      paths: ctx.paths,
    },
  })
  // Topology places resolver on conflicted stream via track_existing_branch
  // Resolver wakes up, reads conflict markers in worktree, edits files,
  // calls `commit` MCP tool, then `resolve_conflict` MCP tool.

[Resolver agent]
  calls commit({ message: "resolve: merge conflict in auth/middleware.ts" })
    → commitChanges returns { commit: "def456", changeId: "Change-I..." }
  calls resolve_conflict({ conflictId: "c-abc" })
    → workspaceManager.resolveConflict({ conflictId, resolvedBy, resolutionCommit: "def456" })
    → emits conflict.resolved
    → stream status → 'active'

[SpawnResolverStrategy] subscribed to conflict.resolved
  returns { kind: "resolved", resolutionCommit: "def456" }

[Integrator's done handler]
  resolution.kind === "resolved"
  → retry mergeStream(coderStream → targetBranch) — this time it succeeds
  → mark queue entry merged
  → done
```

**Timing**: spawn-resolver is async from the caller's POV but the caller awaits the returned Promise. For truly fire-and-forget, caller doesn't await — just subscribes to `conflict.resolved` event.

---

## 10. Edge cases

**E1: Resolver creates a new conflict.**
Resolver's `commit` succeeds; but when the retry of the original merge runs, it conflicts again (e.g., rebase moved the target). `recoveryDepth` increments; strategy re-enters. Capped at `max_recovery_depth`; beyond that, falls back to `escalate`.

**E2: Multiple conflicts on the same stream.**
git-cascade allows multiple `ConflictRecord` entries per stream. Recovery serializes — `recoverConflict` for conflict B waits if conflict A is in-progress. Implementation: per-stream recovery lock.

**E3: Resolver crashes / times out.**
`spawn-resolver` has a `timeout_ms`. On timeout, strategy returns `{ kind: "escalated", escalatedTo: "human" }` — escalation happens via inbox message. Original agent sees escalation in its resolution result.

**E4: Landing agent already terminated when resolution completes.**
`landingAgentId` is advisory, not required. The retry logic in the agent's done handler is gone; so who retries? Options:
- (a) Recovery strategy doesn't trigger retry; caller subscribes to event and handles
- (b) Recovery strategy itself triggers retry via a "retry" phase

Proposal: **(a)**. The resolver's `resolve_conflict` tool does not retry the original operation. Downstream retry is a separate concern handled by the integrator/queue drainer, which should pick up the now-resolved stream on next iteration. Avoids complex state in strategies.

**E5: Conflict on `cascadeRebase`.**
Cascade produces N potential conflicts across dependents. `CascadeResult.failed[]` lists each with a conflictId. Caller iterates and calls `recoverConflict` per failed stream, typically in parallel. Cascade strategy `defer_conflicts` lets the cascade complete past failures; recovery kicks in per stream.

**E6: Abandoning a stream mid-recovery.**
If a human abandons a conflicted stream while recovery is in-progress, the resolver agent's subsequent `resolve_conflict` call fails with `stream_abandoned`. Resolver handles gracefully (reports failure, terminates). Recovery strategy emits `conflict.recovery.failed` with reason.

---

## 11. Open questions

- **Retry ownership** (E4). Proposed (a): caller subscribes to `conflict.resolved` and retries if it still cares. Downside: lost retries if no one subscribes. Alternative: retry hook on the original LandingStrategy. TBD.
- **Recovery for read-only operations.** `stream_status` tool returning stale data after a conflict — not a recovery concern, but affects UX. Documented as a non-goal.
- **Cross-team conflicts.** If two teams' streams conflict during merge to shared branch, which team's recovery policy applies? Propose: conflict is attached to the stream being merged; the *owning team's* policy runs. For federated scenarios, escalates to human by default.
- **Observability.** Recovery can take minutes; need a structured progress channel. Proposal: resolver agents emit `RECOVERY_PROGRESS` signals on a team channel; subscribers can watch. Optional, enabled via YAML.
- **Cost control for LLM-driven recovery.** Runaway recursion + expensive LLM calls are a risk. Hard cap: `max_recovery_depth` + `max_concurrent` per strategy config. Tokens should be tracked separately.

---

## 12. What's not defined here

- Implementation of resolver role prompt / skills.
- Conflict resolution heuristics (e.g., how an LLM resolver approaches different conflict types) — belongs in resolver role definition, not the strategy infrastructure.
- UI / dashboard for human-escalated conflicts.
- Cross-process conflict coordination (multi-instance macro-agent sharing a repo).
