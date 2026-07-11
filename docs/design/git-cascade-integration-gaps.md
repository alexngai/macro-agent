# git-cascade Integration: Surface Analysis & Redesign

Working doc for rethinking how macro-agent integrates with git-cascade (and, next, cc-swarm). Iterative — sections are discussion-ready, not committed.

---

## 1. Framing

The previous draft of this doc catalogued bugs in the "coordinator / integrator / worker" flow and called them integration gaps. That framing was wrong. The real issue is the **shape of the abstraction**, not holes within it.

- **git-cascade** (the library) is a general stream-stacking system. It has no notion of roles, no assumption of a coordinator, no requirement that work accumulates a specific way. A single agent, a stack, a swarm of peers — all are valid.
- **macro-agent's `WorkspaceManager`** projects that general model onto exactly one topology: one team → one stream → one coordinator → one integrator → N workers. Any agent outside that triad gets no workspace; any workflow that isn't "workers merge into a shared integration branch" is unreachable.

This doc (a) catalogues git-cascade's capability surface, (b) shows how narrow macro-agent's exposure of it is, and (c) sketches a stream-first redesign of `WorkspaceManager`.

cc-swarm integration is out of scope for this doc but will follow once the workspace abstraction is settled.

---

## 2. git-cascade capability surface

From `node_modules/git-cascade/dist/tracker.d.ts` and the README. The library's primary API is `MultiAgentRepoTracker` plus namespace modules. Core concepts:

### 2.1 Streams as first-class units of work

| API | Purpose |
|---|---|
| `createStream({ name, agentId, enableStackedReview? })` | Create a stream owned by some agent. `agentId` is identity, not role. |
| `getStream` / `listStreams({ agentId?, status? })` | Enumerate streams. Status: `active`, `merged`, `abandoned`, `conflicted`. |
| `updateStream` / `abandonStream({ cascade? })` | Lifecycle transitions with cascading abandonment. |
| `pauseStream` / `resumeStream` | Temporary halt without abandoning. |
| `trackExistingBranch({ branch, agentId })` | Treat an existing branch as a stream without creating `stream/<id>`. |
| `getStreamHierarchy(rootStreamId?)` | Tree of parent/child streams with active tasks. |

### 2.2 Stacking primitives

| API | Purpose |
|---|---|
| `forkStream({ parentStreamId, name, agentId })` | Fork a **child stream** off a parent. The building block for stacked diffs. |
| `syncWithParent(streamId, agentId, worktree, onConflict)` | Rebase child onto parent as parent advances. Conflict strategies: `abort`, `ours`, `theirs`, `agent` (callback). |
| `rebaseOntoStream(opts)` / `rebaseOntoStreamAsync(opts)` | Generalized rebase with async conflict handlers. |
| `mergeStream({ sourceStream, targetStream, agentId, worktree })` | Stream-to-stream merge preserving change tracking. |
| `cascade.cascadeRebase({ rootStream, strategy: 'skip_conflicting' \| ... })` | **Auto-propagate a rebase through all dependent streams.** The library's namesake feature. |
| `addDependency` / `getDependencies` / `getDependents` | Stream dependency graph. |
| `findCommonAncestor(streamA, streamB)` | Stream-level ancestor queries. |

### 2.3 Stable change identity

| API | Purpose |
|---|---|
| `commitChanges({ streamId, agentId, worktree, message })` | Commit with an auto-generated `Change-Id` trailer. Returns `{ commit, changeId }`. |
| `getChangeByCommit` / `getChangeByHistoricalCommit` | Look up a change by any of its commits (past or current). |
| `recordSquash(absorbed[], target, resultCommit)` | Record squash so identity tracking survives. |
| `recordSplit(originalId, stream, newCommits[])` | Record split similarly. |
| `markChangesMerged` / `markChangeDropped` | Change lifecycle. |

Change-Ids are the mechanism by which git-cascade tracks a logical change across rebases, squashes, and splits. Macro-agent currently bypasses this entirely by using plain `git commit`.

### 2.4 Merge queue (built into git-cascade)

| API | Purpose |
|---|---|
| `addToMergeQueue({ streamId, targetBranch, ... })` | Submit a stream for merging. |
| `getMergeQueue({ targetBranch?, status? })` | Inspect queue. |
| `getNextToMerge(targetBranch?)` | Deterministic dequeue. |
| `processMergeQueue(opts)` | Drain loop. |
| `markMergeQueueReady` / `cancelMergeQueueEntry` / `removeFromMergeQueue` / `getMergeQueuePosition` | Full queue management. |

**Macro-agent built its own MergeQueue** (`src/workspace/merge-queue/`) in parallel, storing rows in the same SQLite database under the `macro_` table prefix, ignoring git-cascade's `mergeQueue` module. This is pure duplication.

### 2.5 Worker task lifecycle (one specific workflow git-cascade ships)

| API | Purpose |
|---|---|
| `createTask({ streamId, title, priority? })` | Create a task under a stream. |
| `startTask({ taskId, agentId, worktree })` | Assign agent, cut worker branch. |
| `completeTask(opts)` | Merge worker branch into stream (with `--no-ff`). |
| `abandonTask` / `releaseTask` | Task lifecycle recovery. |
| `listTasks(streamId, opts)` | Query. |
| `cleanupWorkerBranches({ olderThan, deleteOrphaned })` | Branch GC. |

Note: **this is one workflow the library provides**, not the library's core model. `workerTasks` is an optional module for the specific "N workers merging into a shared stream" pattern. A single-agent stacking workflow wouldn't use it at all.

### 2.6 Review & diff stacks

| API | Purpose |
|---|---|
| `createReviewBlock` / `getReviewBlock` / `getStack` / `setReviewStatus` | PR-like review units. |
| `addCommitsToBlock` / `removeCommitsFromBlock` / `splitReviewBlock` / `mergeReviewBlocks` | Review block manipulation. |
| `rebuildStack` / `autoPopulateStack` / `listStacks` | Stack management. |
| `createCheckpointsFromStream(streamId, opts)` | Make checkpoints from commits in range. |
| `createStackFromStream(opts)` → `DiffStackWithCheckpoints` | Group checkpoints into a reviewable diff stack. |
| `cherryPickStackToTarget(stackId, worktree)` | Cherry-pick an approved stack onto a target. |

### 2.7 Conflict handling

| API | Purpose |
|---|---|
| `createConflict` / `getConflict` / `getConflictForStream` | Conflict records as first-class objects. |
| Conflict strategies: `abort` / `ours` / `theirs` / `agent` | Configurable on any rebase/sync. |

Conflicts are recorded and deferred rather than blocking. Macro-agent does raw `git rebase`/`git merge` in its strategies and fails hard on conflicts.

### 2.8 Operation log, rollback, reconciliation, health

| API | Purpose |
|---|---|
| `recordOperation` / `getOperation` / `getOperations` / `getOperationChain` | Audit log of all state changes. |
| `rollbackToOperation` / `rollbackN` / `rollbackToForkPoint` | Undo via op log. |
| `checkStreamSync` / `checkAllStreamsSync` / `reconcile` / `ensureStreamInSync` | Detect and heal git↔db drift. |
| `healthCheck()` | Stream counts, agents, stale locks, incomplete ops, orphaned conflicts. |
| `gc.*` | Auto-archive on merge/abandon, retention, branch deletion. |

The reconcile/health/gc tooling already solves what was listed as "Gap 7: no reconciliation between pool and git-cascade state" in the previous draft — macro-agent just doesn't call it.

---

## 3. What macro-agent currently exposes

| Capability | Status | Where |
|---|---|---|
| `createStream` | Used (once per team, owner = coordinator) | `workspace-manager.ts:136` |
| `createWorktree` | Used | `workspace-manager.ts` |
| `workerTasks.startTask` / `completeTask` | Used (via `claimTask`) | `dataplane-adapter.ts`, `agent-manager-v2.ts:469` |
| `deallocateWorktree` | Used | `workspace-manager.ts:391` |
| `workerTasks.detectTaskConflicts` | Surfaced in adapter, **no callers** | `dataplane-adapter.ts:379` |
| `diffStacks.createCheckpointsFromStream` | Surfaced in adapter, **no callers** | `dataplane-adapter.ts:431` |
| `workerTasks.cleanupWorkerBranches` | Surfaced in adapter, **no callers** | `dataplane-adapter.ts:486` |
| `forkStream` | **Never used.** No way to stack child streams. | — |
| `syncWithParent` / `rebaseOntoStream` | **Never used.** | — |
| `mergeStream` | **Never used.** Macro-agent uses raw `git merge`/`execSync` in strategies. | — |
| `cascade.cascadeRebase` | **Never used.** The library's namesake feature. | — |
| `commitChanges` (Change-Id tracking) | **Never used.** Workers use plain `git commit`. | — |
| Built-in `mergeQueue.*` | **Never used.** Macro-agent duplicates it with its own `MergeQueue`. | `src/workspace/merge-queue/` |
| Review blocks / stacks / checkpoints | **Never used.** | — |
| Conflict records | **Never used.** Strategies swallow conflicts via raw git. | — |
| `recordOperation` / rollback APIs | **Never used.** | — |
| `checkStreamSync` / `reconcile` / `healthCheck` | **Never used.** | — |
| `gc.*` / auto-archive | **Never configured.** | — |
| `trackExistingBranch` | **Never used.** Every stream creates a new `stream/<id>` branch. | — |
| `pauseStream` / `resumeStream` | **Never used.** | — |
| `addDependency` / `getDependents` | **Never used.** | — |
| `getStreamHierarchy` | **Never used.** | — |

Roughly **20% of git-cascade's surface is touched**, and the 80% that's ignored includes every primitive that would make topologies other than the triad workable.

---

## 4. The current topology as a case study

The triad is one valid workflow. It's worth describing precisely so it can be one of several supported topologies, not the only one.

### 4.1 Actors and bootstrapping

- **One coordinator** per team, owning one stream. Coordinator's `agentId` is stored as `stream.agentId`.
- **Zero or one integrator** per team (team YAML must declare a role with `workspace.integrate` capability).
- **N workers** siblings of the coordinator.
- Stream is created eagerly at team bootstrap in `team-runtime-v2.ts:850-853` with `name = manifest.name` and `forkFrom = "main"`.

### 4.2 Normal completion flow

1. Worker spawn → `createWorkerWorkspace` creates a detached worktree, `claimTask` calls `startTask` which cuts `worker/<agentId>/<taskId>@<ts>`.
2. Worker runs, commits with plain `git commit` (no Change-Id).
3. On `done(status: "completed")`, AgentManagerV2 submits to the **macro_** merge queue (not git-cascade's).
4. `mr:submitted` event fires; TeamRuntime prompts any `workspace.integrate`-capable agent with freeform "process the merge queue."
5. Integrator LLM is expected to dequeue, merge, push. Strategy `.land()` is never called; `trunk` / `optimistic` are dead code.

### 4.3 What this topology bakes in

| Assumption | Where | Consequence |
|---|---|---|
| Stream owner = coordinator | `stream.agentId = coordinatorId` | No stream without a coordinator. |
| One stream per team | `team-runtime-v2.ts:850`, `teamStreamId` | No parallel features per team. |
| Coordinator writes to stream branch | `CoordinatorWorkspace.branch = getStreamBranchName(streamId)` | Race with integrator's merges. |
| Integrator branch naming off coordinator ID | `integrator/${stream.agentId}@${ts}` | Nonsense if stream has no coordinator. |
| Role-name dispatch | `agent-manager-v2.ts:281-306` | Any role outside `{coordinator, integrator, worker}` gets no workspace. |
| `forkFrom: "main"` default | `team-runtime-v2.ts:852` | Assumes single trunk, always off `main`. |
| Workers can only land via merge queue | `agent-manager-v2.ts:687-695` | No other completion paths. |

---

## 5. Topologies that don't fit today

| Topology | Why it fails |
|---|---|
| **Single agent stacking** — one agent owns stream A, forks B off A, forks C off B, squash-merges | No `forkStream` wrapper. Stream owner coupling means the one agent has to play "coordinator" to get a stream at all. No Change-Id tracking. No `cascadeRebase` to propagate parent updates. |
| **Peer swarm** — N equal agents, no coordinator, each working on its own stream | No stream owner assigned at team start. Agents have role-name fallback returning `undefined`. No workspace isolation. |
| **Stacked diffs across team** — feature A (stream 1) depends on feature B (stream 2) which depends on main | No `forkStream`. `StreamConfig.forkFrom` is a branch name string, not a stream reference. No dependency graph. |
| **Nested coordinators** — parent coord spawns child coord for a sub-feature | Child coord creating a new stream via `workspace.stream` creates a stream forked from `"main"`, not from parent's stream. |
| **Multi-stream per team** — team runs feature A and feature B in parallel | One team = one stream, hardcoded at bootstrap. |
| **Non-worker leaf roles** — reviewer, judge, researcher, analyst | Role-name fallback returns `undefined`. Share parent cwd; no isolation even if they write files. |
| **Workers without integrator** | MRs submit and pile up with no drainer. |
| **Change identity across rebases** — "what was this change's ID before it got rebased?" | Never tracked; `commitChanges` not used. |
| **Auto-cascade on parent update** — merge main → rebase all child streams | `cascadeRebase` never called; no listener on parent-stream updates. |
| **Deferred conflict resolution** | Conflicts aren't recorded via git-cascade's conflict model; strategies fail hard on raw `git rebase`. |

---

## 6. Layers of control

Three distinct paths drive git-cascade behavior. The redesign must serve all three without letting any one become the single source of truth.

### 6.1 Team YAML — declarative static shape (primary path)

Loaded once at team start. Describes what the team *always* does:

- Which roles get workspaces, and what kind (new stream, shared stream, shared worktree, none)
- Stream lineage per role (`from_team_root`, `fork_from_parent`, `fork_from_team_root`, `independent`, `track_existing_branch`)
- Default landing strategy per role
- Change-ID tracking on/off (defaults on)
- Default conflict strategy per role
- `cascade_on_parent_update` flag per stream
- Capability grants — which runtime MCP tools each role can call

Lives inside `macro_agent.workspace` at team level and inside per-role YAML via the `macro_agent` passthrough field on `RoleDefinition`. **No openteams schema changes required** — `TeamManifest.macro_agent` and `RoleDefinition.macro_agent` are both `Record<string, unknown>` by design, explicitly opaque to openteams. Macro-agent validates its own schema inside those envelopes.

### 6.2 MCP tools — runtime dynamic decisions

Currently not exposed as tools; should be. Agents make decisions at runtime within the envelope granted by YAML capabilities:

| Tool | Capability gate | Purpose |
|---|---|---|
| `fork_stream({ name, parent? })` | `workspace.fork` | Create a child stream at runtime (experiment, sub-feature) |
| `land({ strategy?, target? })` | `workspace.land` | Finalize current stream using role default or override |
| `sync_with_parent({ onConflict? })` | `workspace.sync` | Rebase current stream onto advanced parent |
| `merge_stream({ target })` | `workspace.merge` | Merge this stream into a specific target |
| `request_cascade({ root })` | `workspace.cascade` | Trigger `cascadeRebase` from a root stream |
| `stream_status({ streamId? })` | `workspace.read` | Inspect stream state, dependencies, conflicts |
| `commit({ message })` | `workspace.commit` | Commit via `commitChanges` (replaces raw `git commit` for streamed agents) |

Capabilities gate *what's callable*; the agent's judgment governs *when* and *how*. Tool registration gating already exists in `mcp-server-v2.ts` via `isToolAllowedForRole()`.

### 6.3 Programmatic API — library consumers

`cognitive-core` (`references/cognitive-core/src/atlas.ts:321`) constructs a `WorkspaceManager` directly and never loads a team YAML. Other library consumers will follow (e.g., future cc-swarm orchestration).

The `WorkspaceManager` interface must therefore stand on its own as a plain API — not degenerate into a "YAML interpreter." YAML is *compiled into* API calls; the API is the source of truth.

### 6.4 Division of responsibility

| Decision | Source |
|---|---|
| "This role gets a new stream at spawn" | YAML |
| "This role's default landing is `queue_to_parent`" | YAML |
| "This role can fork sub-streams at runtime" | YAML capability grant |
| "I (agent) want to fork a sub-stream right now" | MCP tool call |
| "Pick strategy X for this specific land" | MCP tool args |
| "cognitive-core spawns an analyst and allocates a worktree" | Programmatic API |
| "Reconcile state on boot / run gc" | Programmatic API (called by `boot-v2`) |
| "If conflict density > N, spawn extra integrators" | `TopologyPolicy` plugin (not YAML) |

### 6.5 Design constraints across layers

- **YAML must not encode runtime logic.** Conditional behavior belongs in a `TopologyPolicy` plugin, not config.
- **MCP tools must not bypass YAML capability grants.** A role without `workspace.fork` cannot call `fork_stream`, period. Enforced at tool registration time, not runtime check.
- **Programmatic callers are not bound by YAML.** They provide their own policies when constructing `WorkspaceManager` — YAML compilation is just one entry point.
- **All three layers emit the same events.** Whether a decision comes from YAML-compiled topology call, MCP tool invocation, or direct API use, observers see the same event stream. No divergent observation paths.
- **Capability grants are compositional, not role-name-specific.** `workspace.fork` granted to `planner` means the same thing as granted to `researcher`. Role names are human-readable labels; capabilities are the actual contract.

---

## 7. Redesign sketch: stream-first `WorkspaceManager`

The core move: **drop role-shaped APIs; expose streams and worktrees as primitives; make topologies a policy layer on top.** The interface below is what all three control layers (§6) compile into.

### 7.1 Core abstractions

- **`Stream`** — a named line of work with an owner, a base, and optional parent stream. What git-cascade already has.
- **`Worktree`** — a filesystem checkout associated with an agent and optionally a stream. Role-neutral.
- **`LandingStrategy`** — decides how changes from a worktree land somewhere (merge into parent stream, submit to merge queue, cherry-pick as stack, etc.). Strategy is per-stream or per-agent, not per-team.
- **`TopologyPolicy`** — maps team shape → stream graph + spawn-time workspace decisions. Teams configure this; it's not baked into the manager.

### 7.2 Proposed `WorkspaceManager` interface

```ts
interface WorkspaceManager {
  // ── Streams (direct pass-through of git-cascade's model) ─────────
  createStream(opts: {
    name: string;
    ownerAgentId: AgentId;
    parentStreamId?: StreamId;      // Enables stacking natively
    forkFrom?: string | StreamId;   // Branch name OR stream reference
    metadata?: Record<string, unknown>;
  }): StreamId;

  forkStream(opts: {
    parentStreamId: StreamId;
    name: string;
    ownerAgentId: AgentId;
  }): StreamId;

  mergeStream(opts: {
    sourceStreamId: StreamId;
    targetStreamId: StreamId;
    agentId: AgentId;
    worktree: string;
  }): MergeResult;

  syncWithParent(
    streamId: StreamId,
    agentId: AgentId,
    worktree: string,
    onConflict?: ConflictStrategy
  ): RebaseResult;

  cascadeRebase(opts: { rootStreamId: StreamId; strategy: CascadeStrategy }): void;

  abandonStream(streamId: StreamId, opts?: { cascade?: boolean }): void;
  pauseStream(streamId: StreamId, reason?: string): void;
  resumeStream(streamId: StreamId): void;

  getStream(streamId: StreamId): Stream | null;
  getStreamHierarchy(rootStreamId?: StreamId): StreamNode | StreamNode[];
  listStreams(filter?: StreamFilter): Stream[];

  // ── Worktrees (role-neutral) ─────────────────────────────────────
  allocateWorktree(opts: {
    agentId: AgentId;
    streamId?: StreamId;          // Optional — worktree can be detached
    baseDir?: string;
    reuseFromPool?: boolean;
  }): Worktree;

  deallocateWorktree(agentId: AgentId): void;
  getWorktreeForAgent(agentId: AgentId): Worktree | null;
  listWorktrees(): Worktree[];

  // ── Changes (use git-cascade's Change-Id tracking) ───────────────
  commitChanges(opts: {
    agentId: AgentId;
    streamId: StreamId;
    worktree: string;
    message: string;
  }): { commit: string; changeId: ChangeId };

  getChangeByCommit(commit: string): Change | null;
  getChangesForStream(streamId: StreamId, filter?: ChangeFilter): Change[];

  // ── Landing (strategy-driven) ────────────────────────────────────
  registerLandingStrategy(name: string, strategy: LandingStrategy): void;

  land(opts: {
    agentId: AgentId;
    streamId: StreamId;
    strategyName?: string;        // Defaults to stream's configured strategy
    targetStreamId?: StreamId;    // For stream-to-stream landings
  }): LandingResult;

  // ── Merge queue (use git-cascade's built-in) ─────────────────────
  addToMergeQueue(opts: AddToQueueOptions): QueueEntryId;
  getNextToMerge(targetBranch?: string): MergeQueueEntry | null;
  processMergeQueue(opts: ProcessQueueOptions): ProcessQueueResult;

  // ── Reconciliation & health ──────────────────────────────────────
  reconcile(opts?: ReconcileOptions): ReconcileResult;
  healthCheck(): HealthCheckResult;

  // ── Lifecycle ────────────────────────────────────────────────────
  onEvent(cb: WorkspaceEventCallback): () => void;
  close(): void;
}
```

### 7.3 `LandingStrategy` interface

```ts
interface LandingStrategy {
  readonly name: string;
  canLand(ctx: LandingContext): boolean;
  land(ctx: LandingContext): Promise<LandingResult>;
  initialize?(): Promise<void>;
  close?(): Promise<void>;
}

// Built-in strategies:
// - "merge-to-parent"   — mergeStream(source → parent), optional cascade rebase
// - "queue-to-branch"   — addToMergeQueue(targetBranch), deterministic drain
// - "stack-cherry-pick" — createStackFromStream + cherryPickStackToTarget
// - "direct-push"       — rebase + push (current trunk strategy)
// - "optimistic"        — direct-push + emit validation:requested
// - "no-land"           — worktree-only, landing is out of band
```

Strategies no longer live at the team level. A stream can carry its own `landingStrategy` in metadata, set at stream creation.

### 7.4 `TopologyPolicy` layer (replaces role-name dispatch)

Topology is declarative, not hardcoded in AgentManagerV2:

```ts
interface TopologyPolicy {
  readonly name: string;  // "triad" | "peer-swarm" | "solo-stack" | custom
  onTeamStart(ctx: TeamContext): Promise<TeamStreamPlan>;
  onAgentSpawn(ctx: SpawnContext): Promise<WorkspaceDecision>;
  onAgentComplete(ctx: CompleteContext): Promise<void>;
}

type WorkspaceDecision =
  | { kind: "none" }                                       // No workspace
  | { kind: "share-parent-worktree" }                      // Inherit cwd
  | { kind: "new-worktree"; streamId: StreamId }           // Attach to existing stream
  | { kind: "new-stream"; parent?: StreamId; name: string } // Fork new stream
  | { kind: "track-branch"; branch: string };              // trackExistingBranch
```

AgentManagerV2 loses `createWorkspaceForRole`. It calls `topology.onAgentSpawn(...)` and gets a decision back. The decision is enacted via `workspaceManager.allocateWorktree` / `createStream` / `forkStream`.

Built-in topologies:
- **`triad`** — current behavior, for backward compat.
- **`peer-swarm`** — every spawned agent gets its own stream forked off team's root stream.
- **`solo-stack`** — one agent owns a chain of forked streams, `forkStream` on demand.
- **`shared-worktree`** — all agents share one worktree, landing is out-of-band.
- **`no-workspace`** — no isolation at all (default for teams that don't want it).

### 7.5 What this buys us

Every row in the §5 failure table becomes expressible:

| Topology | How it works |
|---|---|
| Single agent stacking | `solo-stack` topology; `forkStream` on demand; `cascadeRebase` on parent update |
| Peer swarm | `peer-swarm` topology; each agent → own stream; `mergeStream` when done |
| Stacked diffs across team | Use `parentStreamId` + `addDependency`; `cascadeRebase` propagates |
| Nested coordinators | Child coord's `onAgentSpawn` returns `new-stream` with parent = current stream |
| Multi-stream per team | Triad topology extended to create N streams |
| Non-worker leaf roles | `WorkspaceDecision.share-parent-worktree` or `none` |
| Change identity | `commitChanges` (mandatory path), replaces raw `git commit` |
| Deferred conflicts | Landing strategies route through `rebaseOntoStream` with conflict records |

### 7.6 git-cascade behavior notes (verified from source)

Before committing to the interface above, key behaviors were verified against git-cascade source at `references/git-cascade/src/`. Corrections to earlier assumptions:

- **`mergeStream` leaves the worktree on the target branch** (`streams.ts:638-717`). Checks out target, performs merge, does NOT restore source branch. On conflict, calls `mergeAbort()` but stays on target. → Implication: `LandingStrategy` doesn't need to restore state; the worktree is deallocated right after landing anyway.
- **`reconcile()` only handles stream↔git divergence** (`reconcile.ts:237-284`). Detects missing branches and diverged HEAD. Does **NOT** clean orphan worktrees or in-progress multi-step ops. → macro-agent ships its own `reconcile()` wrapper on top that handles worktree pool state, orphan worktrees, and agent↔worktree mapping drift.
- **No public worktree branch-switch API**. `updateWorktreeStream()` (`worktrees.ts:113-162`) is private to the tracker. → Pool reuse across streams requires raw `git checkout` in macro-agent (bypassing cascade's op log). Accepted; tracked as follow-up to petition git-cascade.
- **`cascadeRebase` uses a callback-based worktree provider** (`cascade.ts:84`); doesn't require all dependent streams to be pre-allocated. → `WorkspaceManager.cascadeRebase` takes `worktreeProvider: (streamId) => string | null`; macro-agent resolves lazily.
- **Cascade conflict strategies** (`models/dependency.ts:65-68`): `stop_on_conflict` / `skip_conflicting` / `defer_conflicts`. Maps directly to YAML.
- **`commitChanges` stages ALL files** (`tracker.ts:715`); trailer format `Change-Id: c-xxxxxxxx` (`git/commands.ts:764`); throws on no-op. → No file filtering; agents manage staging manually if scoped commits are needed.
- **Events** use configurable prefix (default `x-cascade/`): `stream.opened` / `stream.committed` / `stream.merged` / `stream.conflicted` / `stream.abandoned`. Synchronous callback, exceptions discarded by emitter. → macro-agent subscribes once in `WorkspaceManager` and re-emits structured `WorkspaceEvent`.

---

### 7.7 Worked example: peer swarm

The forcing function for the interface above. Three `peer` agents each own a stream forked off a team-level root stream, merge back independently.

**YAML:**

```yaml
name: peer-swarm
roles: [orchestrator, peer]

topology:
  root: { role: orchestrator, prompt: prompts/orchestrator.md }
  spawn_rules:
    orchestrator: [peer]
    peer: []

macro_agent:
  workspace:
    default_stream: { fork_from: main, change_id_tracking: true }
    on_team_complete: keep
    roles:
      orchestrator: { workspace: none, allocation: inherit_parent_cwd, landing: none }
      peer:
        workspace: new_stream
        stream_lineage: fork_from_team_root
        allocation: new_worktree
        landing: merge_to_parent_stream
        on_conflict: defer
    capabilities:
      peer: [workspace.commit, workspace.land, workspace.read]
```

**Phase-by-phase:**

| Phase | Action | API calls |
|---|---|---|
| 1. Boot | Load YAML, construct `WorkspaceManager`, call `reconcile()`, create team stream | `createStream({ name: "peer-swarm", ownerId: "team:peer-swarm", forkFrom: "main" })` |
| 2. Spawn orchestrator | Topology decides `{ kind: "share-parent-cwd" }` | — (no workspace calls) |
| 3. Spawn peer | Topology decides `{ kind: "new-stream", streamSpec, worktree }` | `forkStream(teamStream)` + `allocateWorktree({ agentId, streamId, pooled: true })` |
| 4. Peer commits | MCP `commit` tool | `commitChanges({ agentId, streamId, worktree, message })` → Change-Id assigned |
| 5. Peer done | MCP `land()` tool → `merge-to-parent` strategy | `mergeStream(peer → team_root)`; if `cascade_on_parent_update`, `cascadeRebase` |
| 6. Peer terminate | AgentManager cleanup | `deallocateWorktree(agentId)` |
| 7. Team done | Orchestrator calls `done()` | `on_team_complete: keep` → team stream stays for human PR |

**Interface pieces exercised:** `createStream`, `forkStream`, `mergeStream`, `commitChanges`, `allocateWorktree`, `deallocateWorktree`, `land` + `LandingStrategy`, `WorkspaceEvent` stream, `TopologyPolicy.onAgentSpawn/onAgentComplete`.

**Surfaced design decisions:**
- **Pseudo-principal `team:<name>`** owns team streams. Tagged string type.
- **`onAgentSpawn` returns a `WorkspaceDecision`** (declarative), not a `Workspace` (imperative). AgentManager executes it.
- **`commit` MCP tool is the mandatory path** for Change-Id tracking; bypassing via raw `Bash: git commit` is documented as unsupported, not enforced.
- **`LandingStrategy.land(ctx)` receives structured context** (agentId, streamId, sourceWorktree, targetStreamId, strategyConfig, workspaceManager). Strategy decides internals (merge + cascade, queue, cherry-pick, etc.).
- **Landing happens in `done()` / `land()` MCP tool**, NOT in `terminate()`. Terminate is pure cleanup.

---

### 7.8 Generalizing: other workflows

The peer swarm interface was tested against the other 5 workflows from §5. Summary:

**Solo stack (sequential)** — One agent forks chains of streams, lands each back up.

```yaml
roles:
  author:
    workspace: new_stream
    stream_lineage: fork_from_team_root
    landing: merge_to_parent_stream
    cascade_on_parent_update: true
    capabilities: [workspace.commit, workspace.land, workspace.fork, workspace.sync, workspace.read]
```

Interface addition needed: **agent's active stream is mutable**. `fork_stream` MCP tool implicitly moves agent to the new child; `checkout_stream` returns to parent after landing. Simultaneous multi-stream attachment (Graphite-style) is explicitly out of scope.

**Triad (current topology)** — coordinator + integrator + N workers, ported to new interface.

```yaml
roles:
  coordinator: { workspace: attach_to_team_root, landing: none, capabilities: [workspace.read] }
  worker:
    workspace: new_stream
    stream_lineage: fork_from_parent
    landing: queue_to_branch
    landing_config: { target_stream: team_root }
    capabilities: [workspace.commit, workspace.land, workspace.read]
  integrator:
    workspace: attach_to_team_root
    landing: none
    capabilities: [workspace.merge, workspace.read, merge_queue.drain]
```

Changes from today: macro-agent's duplicate merge queue is deleted; git-cascade's built-in queue is used. Integrator gets structured MCP tools (`next_merge_request`, `merge_stream`, `mark_merge_complete`) instead of freeform "process the merge queue" prompt. Integrator wake trigger is `x-cascade/stream.committed` event on team root, not a custom `mr:submitted`.

**Pipeline (planner → coder → reviewer → integrator)** — sequential handoffs with cross-role worktree sharing.

```yaml
roles:
  planner: { workspace: none, landing: none }
  coder:
    workspace: new_stream
    stream_lineage: fork_from_team_root
    landing: queue_to_branch
    landing_config: { target_role: integrator }
  reviewer:
    workspace: share_with_agent
    share_with: coder
    landing: none
    capabilities: [workspace.read]
  integrator: { workspace: attach_to_team_root, capabilities: [workspace.merge, merge_queue.drain] }
```

Interface addition needed: **`share_with_agent` workspace decision**. Reviewer co-locates on coder's worktree path (ref-counted deallocation — last-out wins). `workspace.commit` capability withheld; raw `git commit` via Bash is not enforced-against.

**Research / read-only** — agents read the repo, never commit.

```yaml
roles:
  researcher: { workspace: none, allocation: inherit_parent_cwd, landing: none, capabilities: [] }
```

Interface holds trivially. No MCP workspace tools registered; git-cascade dormant for this role.

**Long-lived feature + subtasks** — parent stream lives for days, children fork and merge back, parent rebases onto `main` periodically.

```yaml
roles:
  feature_owner:
    workspace: new_stream
    stream_lineage: fork_from_team_root
    landing: merge_to_parent_stream
    cascade_on_parent_update: true
    on_parent_advanced: sync_with_parent
    capabilities: [workspace.commit, workspace.land, workspace.sync, workspace.fork, workspace.read]
  subtask:
    workspace: new_stream
    stream_lineage: fork_from_parent
    landing: merge_to_parent_stream
    capabilities: [workspace.commit, workspace.land, workspace.read]
```

Interface addition needed: **`on_parent_advanced` directive + event subscription**. TopologyPolicy subscribes to `x-cascade/stream.committed` on parent stream; schedules `syncWithParent` call on the feature stream via WakeManager (fires as a system event into the agent). Coalesced (max once per N seconds).

**Verdict — interface generalizes with three additions:**

1. **`share_with_agent: <role>`** workspace decision (pipeline reviewer).
2. **Mutable agent-active-stream** — `fork_stream` / `checkout_stream` MCP tools for solo stack.
3. **`on_parent_advanced: sync_with_parent`** auto-sync directive driven by event subscription (long-lived feature).

Plus one carve-out: **Graphite-style simultaneous stacks** (multiple active streams per agent) deferred as future extension.

---

## 8. Migration plan (sketch)

1. **Surface more git-cascade** — extend `DataplaneAdapter` to cover `forkStream`, `mergeStream`, `syncWithParent`, `cascadeRebase`, `commitChanges`, built-in merge queue, reconcile, health. No consumer changes yet. **Safe, additive.**

2. **Add new `WorkspaceManager` methods alongside existing ones** — `allocateWorktree`, `createStream` (new signature), `land`, `commitChanges`. Old methods stay; implementations delegate. **Safe, additive.**

3. **Introduce `TopologyPolicy`** — extract triad logic out of `agent-manager-v2.ts:281-306` into `TriadPolicy`. AgentManagerV2 gets a `topology?: TopologyPolicy` field, defaults to Triad for backward compat. **Invisible to existing callers.**

4. **Migrate landing** — `IntegrationStrategy` → `LandingStrategy` (rename + generalize). AgentManagerV2 on worker completion calls `workspaceManager.land(...)` instead of `mergeQueue.submit(...)` directly. Queue strategy uses git-cascade's built-in queue. **Kills the duplicate merge queue.**

5. **Drop role-name dispatch** — remove the `switch(role)` in AgentManagerV2 once all topologies are expressed as policies. Role capabilities still gate spawn, but workspace allocation is policy-driven. **Breaking for custom role names relying on the fallback — needs migration note.**

6. **Deprecate old WorkspaceManager methods** — `createWorkerWorkspace` / `createIntegratorWorkspace` / `createCoordinatorWorkspace` move to `TriadPolicy` internals; public interface becomes stream-first.

Each step is individually reviewable and runnable. We don't need to break anything in one big drop.

---

## 9. Open questions

### Resolved

- ✅ **Pseudo-principals** — team-owned streams owned by `team:<name>` tagged string; never terminates. Regular agents own stream via their `AgentId`.
- ✅ **`mergeStream` worktree semantics** — verified from source: leaves worktree on target. Clean up after landing.
- ✅ **Cascade triggering** — `LandingStrategy.land()` decides whether to `cascadeRebase` after merge. `mergeStream` stays narrow. YAML `cascade_on_parent_update` configures the *strategy*, not the primitive. Agent's `done()` → opentasks task completion → `land()` → strategy → cascade is the full chain.
- ✅ **Landing strategy = per-stream, not per-team** — strategies register globally; YAML role config picks which strategy each stream uses. Agent can override via MCP tool args.
- ✅ **Team stream on completion** — YAML `on_team_complete: keep | merge_to_main | abandon`. Default `keep`.
- ✅ **Recovery** — macro-agent ships a `reconcile()` wrapper on top of git-cascade's (which only handles stream↔git sync). Wrapper handles worktree pool, orphan worktrees, agent↔worktree drift. Called on boot; runtime drift tolerated until next boot.
- ✅ **Pool behavior** — config-driven: `pool.reuse_across_streams: bool`. If `true`, raw `git checkout` on reuse (bypasses cascade op log, accepted). If `false`, fresh worktree per stream.
- ✅ **Commit path** — `commit` MCP tool is the mandatory path for Change-Id tracking. Agents with workspace access get the tool; raw `Bash: git commit` isn't enforced-against but is documented as unsupported.

### Open

- **Conflict recovery strategy** — deferred to a dedicated design doc. Options: auto-resolve (git strategies), spawn resolver agent, human-in-the-loop. Stream marked `conflicted` + conflict record + recovery strategy kicks off asynchronously.
- **Simultaneous multi-stream per agent (Graphite-style)** — explicitly out of scope for v1. The solo-stack workflow uses sequential streams. Flagging so the interface doesn't preclude a future extension.
- **Reviewer-outlives-coder lifecycle** — ref-counted shared worktree deallocation. Needs a small lifecycle hook; not complex.
- **Sync-with-main triggering** — event-driven via `x-cascade/stream.committed` on parent + WakeManager coalescing (max once per N seconds). Needs WakeManager integration.
- **Worktree branch-switch** — macro-agent does raw `git checkout` for pool reuse across streams. Follow-up: petition git-cascade to expose `updateWorktreeStream` publicly.
- **Integrator structured tools** — `next_merge_request`, `merge_stream`, `mark_merge_complete`. New MCP tool surface for `merge_queue.drain` capability.
- ~~**Backward compatibility with cognitive-core**~~ — ✅ resolved. Pressure test showed cognitive-core imports `WorkspaceManager` from a separate `agent-workspace` package, not macro-agent's. No git-cascade usage. No overlap. The `src/cognitive/` bridge in macro-agent also makes no `WorkspaceManager` calls. **No shim required; redesign has no external consumer constraints.** Sole production consumers are `src/agent/agent-manager-v2.ts` (~6 call sites) and `src/teams/team-runtime-v2.ts` (~3 call sites).
- **cc-swarm consumption** — deferred to separate follow-up doc. Likely consumes `WorkspaceManager` directly as a library, skipping team YAML layer.

---

## 10. Follow-ups

- cc-swarm integration doc — how the redesigned WorkspaceManager composes with cc-swarm's orchestration primitives.
- Concrete API shape for `TopologyPolicy` (this doc's sketch needs fleshing out with a working peer-swarm example).
- Review with cognitive-core owners on backward compat.

---

## Appendix A — Original gap list (within the triad topology)

These were the items in the previous draft. They remain valid *within the current triad model*, but most dissolve once the stream-first interface is in place. Annotated with how they map to the redesign:

| # | Original gap | Disposition under redesign |
|---|---|---|
| 1 | `IntegrationStrategy.land()` never called | Dissolved — `LandingStrategy.land()` is on the critical path in `workspaceManager.land()` |
| 2 | Merge queue has no deterministic drainer | Dissolved — use git-cascade's built-in `processMergeQueue` |
| 3 | `getNextTask()` orphaned | Deleted — workspace-side tasks collapse into opentasks or into git-cascade's `workerTasks` directly |
| 4 | No integrator auto-spawn | Becomes a topology policy concern, not a lifecycle hack |
| 5 | Conflict detection & checkpoints unused | Exposed via new interface; topologies can opt in |
| 6 | Cascade termination bypasses integration | Cascade calls `workspaceManager.land()` same as normal completion |
| 7 | No reconciliation between pool and git-cascade | Dissolved — call `reconcile()` on boot |
| 8 | No pre-submit validation on MR branches | Lives in the specific landing strategy |
| 9 | No default strategy outside team runtime | Dissolved — strategies are per-stream, not per-team |

## Appendix B — Duplicated vs ignored, at a glance

**Duplicated** (macro-agent built its own alongside git-cascade's):
- Merge queue (`src/workspace/merge-queue/` vs git-cascade's `mergeQueue.*`)
- Worktree pool (`src/workspace/pool/` vs git-cascade's `listWorktrees` / `deallocateWorktree` + reconcile)
- Branch creation via `execSync` (vs `forkStream` / `commitChanges`)

**Ignored** (exposed by git-cascade, never called):
- `forkStream`, `mergeStream`, `syncWithParent`, `cascadeRebase`
- `commitChanges` / Change-IDs
- Review blocks, diff stacks, checkpoints
- Conflict records
- `recordOperation`, rollback APIs
- `reconcile`, `healthCheck`, gc
- `trackExistingBranch`, `pauseStream`, `resumeStream`
- `addDependency`, `getDependents`, `getStreamHierarchy`
