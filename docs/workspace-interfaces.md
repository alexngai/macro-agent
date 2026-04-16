# Workspace Interfaces (Draft)

Concrete TypeScript sketches for the redesigned workspace layer described in `docs/git-cascade-integration-gaps.md`. This file is the interface contract; the narrative doc is the rationale.

**Status**: draft for iteration. Not yet implemented. Not yet ported to call sites.

Three things are defined here:

1. **`WorkspaceManager`** — stream-first API that sits above git-cascade. Used by programmatic consumers (cognitive-core), TopologyPolicy compilers, and MCP tool handlers.
2. **`TopologyPolicy`** — compiles team YAML (`macro_agent.workspace`) into spawn-time workspace decisions and lifecycle hooks. The compiler is the only thing that reads YAML; everything downstream sees resolved policy objects.
3. **`LandingStrategy`** — pluggable landing algorithm. Strategies register globally; YAML role config picks which strategy each stream uses.

Plus supporting surfaces:

- **YAML Zod schema** for `macro_agent.workspace` validation.
- **MCP tool schemas** for agent-facing workspace tools.
- **Built-in registrations** (5 landing strategies, 5 topology policies).

---

## 1. Core primitives

```ts
// Identity types
export type AgentId = string;
export type StreamId = string;
export type ChangeId = string;
export type QueueEntryId = string;

// Pseudo-principals for entities that aren't real agents (team roots, system owners).
// Tagged via prefix; never terminates.
export type PseudoAgentId =
  | `team:${string}`
  | `system:${string}`;

export type Principal = AgentId | PseudoAgentId;

export const isPseudo = (p: Principal): p is PseudoAgentId =>
  p.startsWith("team:") || p.startsWith("system:");
```

---

## 2. Stream & worktree types

```ts
export type StreamStatus = "active" | "merged" | "abandoned" | "conflicted" | "paused";

export interface Stream {
  id: StreamId;
  name: string;
  ownerId: Principal;
  parentStreamId?: StreamId;
  baseCommit: string;
  branch: string;
  status: StreamStatus;
  metadata: Record<string, unknown>;
  createdAt: number;
}

export interface StreamNode {
  stream: Stream;
  children: StreamNode[];
  activeTaskCount: number;
}

export interface Change {
  id: ChangeId;
  streamId: StreamId;
  currentCommit: string;
  historicalCommits: string[];
  status: "active" | "merged" | "dropped";
  createdAt: number;
}

export interface StreamSpec {
  name: string;
  ownerId: Principal;
  parent?: StreamId;           // fork from this stream (takes precedence)
  forkFrom?: string;           // otherwise fork from this branch
  metadata?: Record<string, unknown>;
}

export interface Worktree {
  agentId: Principal;
  path: string;
  streamId?: StreamId;         // worktrees may be detached
  branch: string;
  pooled: boolean;
  sharedWithAgents: AgentId[];  // ref-counted shares
  createdAt: number;
}

export interface AllocateWorktreeOpts {
  agentId: Principal;
  streamId?: StreamId;
  baseDir?: string;
  pooled?: boolean;
  sharedWithAgent?: AgentId;   // if set, co-locates on that agent's worktree; ref-counted
}
```

---

## 3. Results & conflict types

```ts
export type ConflictStrategy = "abort" | "ours" | "theirs" | "defer" | "agent";
export type CascadeStrategy = "stop_on_conflict" | "skip_conflicting" | "defer_conflicts";

export interface MergeResult {
  success: boolean;
  mergeCommit?: string;
  changeIds?: ChangeId[];
  conflictId?: string;
}

export interface RebaseResult {
  success: boolean;
  rebasedCommits?: string[];
  conflictId?: string;
}

export interface CascadeResult {
  rootStreamId: StreamId;
  succeeded: StreamId[];
  failed: Array<{ streamId: StreamId; conflictId?: string; error?: string }>;
}

export interface ConflictRecord {
  id: string;
  streamId: StreamId;
  sourceCommit?: string;
  targetCommit?: string;
  paths: string[];
  createdAt: number;
  resolvedAt?: number;
}

export interface ReconcileResult {
  streamsChecked: number;
  streamsFixed: number;
  worktreesOrphaned: number;
  worktreesCleaned: number;
  poolEntriesPurged: number;
  errors: Array<{ context: string; message: string }>;
}
```

---

## 4. Events

All three control layers (YAML-compiled, MCP tools, programmatic) emit the same stream.

```ts
export type WorkspaceEvent =
  | { kind: "stream.created"; streamId: StreamId; ownerId: Principal; parentStreamId?: StreamId }
  | { kind: "stream.committed"; streamId: StreamId; commit: string; changeId: ChangeId; agentId: Principal }
  | { kind: "stream.merged"; sourceStreamId: StreamId; targetStreamId: StreamId; mergeCommit: string }
  | { kind: "stream.conflicted"; streamId: StreamId; conflictId: string }
  | { kind: "stream.abandoned"; streamId: StreamId; reason?: string }
  | { kind: "stream.paused"; streamId: StreamId; reason?: string }
  | { kind: "stream.resumed"; streamId: StreamId }
  | { kind: "worktree.allocated"; agentId: Principal; path: string; streamId?: StreamId }
  | { kind: "worktree.deallocated"; agentId: Principal; path: string }
  | { kind: "worktree.shared"; ownerAgentId: AgentId; sharingAgentId: AgentId; path: string }
  | { kind: "landing.started"; agentId: AgentId; streamId: StreamId; strategyName: string }
  | { kind: "landing.completed"; agentId: AgentId; streamId: StreamId; result: MergeResult | RebaseResult }
  | { kind: "cascade.started"; rootStreamId: StreamId }
  | { kind: "cascade.completed"; result: CascadeResult };

export type WorkspaceEventCallback = (e: WorkspaceEvent) => void;
```

---

## 5. `WorkspaceManager` interface

```ts
export interface WorkspaceManager {
  // ── Stream management ──────────────────────────────────────────
  createStream(spec: StreamSpec): StreamId;

  forkStream(opts: {
    parentStreamId: StreamId;
    name: string;
    ownerId: Principal;
    metadata?: Record<string, unknown>;
  }): StreamId;

  mergeStream(opts: {
    sourceStreamId: StreamId;
    targetStreamId: StreamId;
    agentId: Principal;
    worktree: string;
  }): MergeResult;

  syncWithParent(opts: {
    streamId: StreamId;
    agentId: Principal;
    worktree: string;
    onConflict?: ConflictStrategy;
  }): RebaseResult;

  rebaseOntoStream(opts: {
    streamId: StreamId;
    targetStreamId: StreamId;
    agentId: Principal;
    worktree: string;
    onConflict?: ConflictStrategy;
  }): RebaseResult;

  cascadeRebase(opts: {
    rootStreamId: StreamId;
    strategy: CascadeStrategy;
    worktreeProvider: (streamId: StreamId) => string | null;
  }): CascadeResult;

  abandonStream(streamId: StreamId, opts?: { cascade?: boolean; reason?: string }): void;
  pauseStream(streamId: StreamId, reason?: string): void;
  resumeStream(streamId: StreamId): void;

  getStream(streamId: StreamId): Stream | null;
  listStreams(filter?: { ownerId?: Principal; status?: StreamStatus; parentStreamId?: StreamId }): Stream[];
  getStreamHierarchy(rootStreamId?: StreamId): StreamNode | StreamNode[];
  getDependents(streamId: StreamId): StreamId[];

  // ── Changes (Change-Id tracking) ───────────────────────────────
  commitChanges(opts: {
    agentId: Principal;
    streamId: StreamId;
    worktree: string;
    message: string;
  }): { commit: string; changeId: ChangeId };

  markChangesMerged(changeIds: ChangeId[]): void;
  getChange(changeId: ChangeId): Change | null;
  getChangeByCommit(commit: string): Change | null;

  // ── Worktree management ────────────────────────────────────────
  allocateWorktree(opts: AllocateWorktreeOpts): Worktree;
  deallocateWorktree(agentId: Principal): void;
  getWorktreeForAgent(agentId: Principal): Worktree | null;
  listWorktrees(): Worktree[];

  // ── Conflicts ──────────────────────────────────────────────────
  getConflictForStream(streamId: StreamId): ConflictRecord | null;
  resolveConflict(opts: { conflictId: string; resolvedBy: Principal; resolutionCommit?: string }): void;

  // ── Landing ────────────────────────────────────────────────────
  registerLandingStrategy(strategy: LandingStrategy): void;
  unregisterLandingStrategy(name: string): void;
  getLandingStrategy(name: string): LandingStrategy | null;

  land(opts: {
    agentId: AgentId;
    streamId: StreamId;
    strategyName?: string;
    targetStreamId?: StreamId;
    strategyConfig?: Record<string, unknown>;
  }): Promise<MergeResult>;

  // ── Merge queue (delegates to git-cascade's built-in) ──────────
  addToMergeQueue(opts: {
    streamId: StreamId;
    targetBranch: string;
    priority?: number;
  }): QueueEntryId;

  getNextToMerge(targetBranch?: string): MergeQueueEntry | null;
  markMergeQueueReady(entryId: QueueEntryId): void;
  cancelMergeQueueEntry(entryId: QueueEntryId): void;
  getMergeQueuePosition(streamId: StreamId, targetBranch?: string): number | null;

  // ── Reconciliation & health ────────────────────────────────────
  reconcile(): ReconcileResult;
  healthCheck(): HealthCheckResult;

  // ── Events ─────────────────────────────────────────────────────
  onEvent(cb: WorkspaceEventCallback): () => void;

  // ── Lifecycle ──────────────────────────────────────────────────
  close(): void;
}

export interface MergeQueueEntry {
  id: QueueEntryId;
  streamId: StreamId;
  targetBranch: string;
  status: "pending" | "ready" | "in_progress" | "merged" | "cancelled" | "failed";
  priority: number;
  submittedAt: number;
}

export interface HealthCheckResult {
  streamsActive: number;
  streamsArchived: number;
  agentsActive: number;
  staleLocks: number;
  incompleteOperations: number;
  orphanedConflicts: number;
  orphanedWorktrees: number;
}
```

---

## 6. `LandingStrategy` interface

```ts
export interface LandingContext {
  agentId: AgentId;
  streamId: StreamId;
  sourceWorktree: string;
  targetStreamId?: StreamId;
  strategyConfig?: Record<string, unknown>;   // from YAML `landing_config`
  workspaceManager: WorkspaceManager;
}

export interface LandingStrategy {
  readonly name: string;

  // Optional: strategy decides if it applies given the context
  canLand?(ctx: LandingContext): boolean;

  // Execute the landing
  land(ctx: LandingContext): Promise<MergeResult>;

  // Optional lifecycle hooks
  initialize?(): Promise<void>;
  close?(): Promise<void>;
}
```

### 6.1 Built-in strategies

```ts
// merge-to-parent: merge sourceStream → targetStream (or parent of source).
//   On success: optionally cascadeRebase if strategyConfig.cascade === true.
// Used by: peer swarm, long-lived feature, solo stack.

// queue-to-branch: add to merge queue; return immediately. Actual merge is drained
//   by an integrator-capable agent calling processMergeQueue / merge_stream.
//   strategyConfig: { target: "stream:<id>" | "branch:<name>" | "role:<role>" }.
// Used by: triad (workers), pipeline (coders).

// cherry-pick-stack: createStackFromStream + cherryPickStackToTarget. Preserves
//   commit identity via Change-Ids. strategyConfig: { target_branch: string }.
// Used by: stacked-diff review workflows.

// direct-push: rebase onto target + push. Raw execSync (current trunk strategy).
//   strategyConfig: { target_branch: string; max_retries?: number }.
// Used by: trunk-based flows without a merge queue.

// optimistic-push: direct-push + emit `validation:requested` event.
//   Validation delegated to a judge role.
// Used by: self-driving team today.
```

Strategy registration happens once at boot; all 5 are registered by default. Teams pick via YAML `landing: <strategy_name>`.

---

## 7. `TopologyPolicy` interface

```ts
export interface TopologyPolicy {
  readonly name: string;

  onTeamStart(ctx: TeamStartContext): Promise<TeamStartPlan>;
  onAgentSpawn(ctx: SpawnContext): Promise<WorkspaceDecision>;
  onAgentComplete(ctx: AgentCompleteContext): Promise<void>;
  onTeamStop(ctx: TeamStopContext): Promise<void>;

  // Optional: subscribed if the topology cares about parent stream updates
  onParentStreamAdvanced?(ctx: ParentAdvancedContext): Promise<void>;
}

export interface TeamStartContext {
  teamName: string;
  teamId: string;                          // instance id
  manifest: TeamManifest;                  // openteams-resolved
  workspaceConfig: TeamWorkspaceConfig;    // macro-agent's Zod-validated section
  workspaceManager: WorkspaceManager;
  inboxAdapter: InboxAdapter;
}

export interface TeamStartPlan {
  teamStreamId?: StreamId;                 // the team's root stream if created
  additionalStreams?: StreamId[];
}

export interface SpawnContext {
  agentId: AgentId;
  role: string;
  roleConfig: RoleWorkspaceConfig;         // parsed YAML for this role
  parent?: AgentId;
  parentStreamId?: StreamId;
  teamStreamId?: StreamId;
  workspaceManager: WorkspaceManager;
  options: SpawnAgentOptions;
}

export type WorkspaceDecision =
  | { kind: "none" }
  | { kind: "share-parent-cwd" }
  | { kind: "share-with-agent"; agentId: AgentId; worktreeRole?: "read" | "write" }
  | { kind: "attach-to-stream"; streamId: StreamId; worktree: WorktreeOpts }
  | { kind: "new-stream"; streamSpec: StreamSpec; worktree: WorktreeOpts };

export interface WorktreeOpts {
  baseDir?: string;
  pooled?: boolean;
}

export interface AgentCompleteContext {
  agentId: AgentId;
  role: string;
  reason: "completed" | "failed" | "cascade" | "interrupted";
  streamId?: StreamId;
  workspaceManager: WorkspaceManager;
  landingResult?: MergeResult;
}

export interface TeamStopContext {
  teamName: string;
  teamStreamId?: StreamId;
  onTeamComplete: "keep" | "merge_to_main" | "abandon";
  workspaceManager: WorkspaceManager;
}

export interface ParentAdvancedContext {
  parentStreamId: StreamId;
  childStreamIds: StreamId[];
  workspaceManager: WorkspaceManager;
  triggerSystem: TriggerSystemV2;
}
```

### 7.1 Built-in topology policies

```ts
// YamlDrivenTopology: the default. Compiles TeamWorkspaceConfig into
//   per-spawn decisions by looking up role config. Covers peer-swarm,
//   triad, pipeline, research, long-lived, solo-stack via YAML alone.

// CognitiveCoreTopology: minimal policy for cognitive-core's analyst
//   workflow; spawns analysts with no stream, allocates detached worktrees.
//   Skips YAML; configured programmatically.

// NoWorkspaceTopology: returns { kind: "none" } for everything. Used when
//   no workspace is needed but the team still needs structured spawning.
```

`YamlDrivenTopology` is the primary; the others are escape hatches for library consumers.

---

## 8. YAML Zod schema (`macro_agent.workspace`)

```ts
import { z } from "zod";

export const StreamLineageSchema = z.enum([
  "from_team_root",       // attach to existing team root (no new stream)
  "fork_from_team_root",  // fork new stream off team root
  "fork_from_parent",     // fork new stream off spawner's stream
  "independent",          // fork new stream off main branch
  "track_existing_branch",// track an existing branch (no new stream/<id>)
]);

export const LandingStrategyNameSchema = z.enum([
  "merge_to_parent_stream",
  "queue_to_branch",
  "cherry_pick_stack",
  "direct_push",
  "optimistic_push",
  "none",
]);

export const ConflictStrategySchema = z.enum(["abort", "ours", "theirs", "defer", "agent"]);

export const WorkspaceKindSchema = z.enum([
  "new_stream",
  "attach_to_team_root",
  "share_with_agent",
  "share_parent_cwd",
  "none",
]);

export const AllocationSchema = z.enum([
  "new_worktree",
  "inherit_parent_cwd",
  "pooled_worktree",
]);

export const OnParentAdvancedSchema = z.enum([
  "sync_with_parent",
  "none",
]);

export const OnTeamCompleteSchema = z.enum([
  "keep",
  "merge_to_main",
  "abandon",
]);

export const RoleWorkspaceConfigSchema = z.object({
  workspace: WorkspaceKindSchema,
  stream_lineage: StreamLineageSchema.optional(),
  allocation: AllocationSchema.optional(),
  landing: LandingStrategyNameSchema.optional(),
  landing_config: z.record(z.unknown()).optional(),
  on_conflict: ConflictStrategySchema.optional(),
  cascade_on_parent_update: z.boolean().optional(),
  on_parent_advanced: OnParentAdvancedSchema.optional(),
  share_with: z.string().optional(),     // role name — for workspace: share_with_agent
  track_branch: z.string().optional(),   // branch name — for stream_lineage: track_existing_branch
}).superRefine((val, ctx) => {
  if (val.workspace === "share_with_agent" && !val.share_with) {
    ctx.addIssue({ code: "custom", message: "share_with is required when workspace=share_with_agent" });
  }
  if (val.stream_lineage === "track_existing_branch" && !val.track_branch) {
    ctx.addIssue({ code: "custom", message: "track_branch is required when stream_lineage=track_existing_branch" });
  }
});

export const PoolConfigSchema = z.object({
  enabled: z.boolean().default(true),
  max_size: z.number().default(10),
  reuse_across_streams: z.boolean().default(false),
}).optional();

export const DefaultStreamSchema = z.object({
  fork_from: z.string().default("main"),
  name_template: z.string().default("{team}"),
  change_id_tracking: z.boolean().default(true),
}).optional();

export const TeamWorkspaceConfigSchema = z.object({
  default_stream: DefaultStreamSchema,
  on_team_complete: OnTeamCompleteSchema.default("keep"),
  pool: PoolConfigSchema,
  roles: z.record(z.string(), RoleWorkspaceConfigSchema),
  capabilities: z.record(z.string(), z.array(z.string())).optional(),
});

export type TeamWorkspaceConfig = z.infer<typeof TeamWorkspaceConfigSchema>;
export type RoleWorkspaceConfig = z.infer<typeof RoleWorkspaceConfigSchema>;
```

Loaded from `TeamManifest.macro_agent.workspace`. Validated once at team start; errors rejected loudly.

---

## 9. MCP tool schemas

Registered per-role based on capabilities in team YAML. Tool filtering already exists in `mcp-server-v2.ts` via `isToolAllowedForRole()`.

```ts
import { z } from "zod";

// ── Capability: workspace.commit ──────────────────────────────────
export const commitToolInput = z.object({
  message: z.string().min(1),
});
// Handler: commitChanges({ agentId, streamId: ctx.streamId, worktree: ctx.cwd, message })
//   → returns { commit, changeId }

// ── Capability: workspace.land ────────────────────────────────────
export const landToolInput = z.object({
  strategy: z.string().optional(),               // override role default
  targetStreamId: z.string().optional(),
  strategyConfig: z.record(z.unknown()).optional(),
});
// Handler: workspaceManager.land({ agentId, streamId: ctx.streamId, ... })

// ── Capability: workspace.fork ────────────────────────────────────
export const forkStreamToolInput = z.object({
  name: z.string().min(1),
  parent: z.string().optional(),                 // defaults to current stream
});
// Handler: forkStream + allocateWorktree + implicitly moves agent's active stream

// ── Capability: workspace.sync ────────────────────────────────────
export const syncWithParentToolInput = z.object({
  onConflict: ConflictStrategySchema.optional(),
});
// Handler: syncWithParent({ streamId: ctx.streamId, ... })

// ── Capability: workspace.merge ───────────────────────────────────
export const mergeStreamToolInput = z.object({
  sourceStreamId: z.string(),
  targetStreamId: z.string().optional(),
});
// Handler: mergeStream(...). For integrator roles draining queue.

// ── Capability: merge_queue.drain ─────────────────────────────────
export const nextMergeRequestToolInput = z.object({
  targetBranch: z.string().optional(),
});
// Handler: getNextToMerge(targetBranch) + mark in_progress

export const markMergeCompleteToolInput = z.object({
  entryId: z.string(),
  mergeCommit: z.string().optional(),
  success: z.boolean(),
  error: z.string().optional(),
});
// Handler: updates queue entry state

// ── Capability: workspace.cascade ─────────────────────────────────
export const requestCascadeToolInput = z.object({
  rootStreamId: z.string(),
  strategy: z.enum(["stop_on_conflict", "skip_conflicting", "defer_conflicts"]).optional(),
});
// Handler: cascadeRebase({ rootStreamId, strategy, worktreeProvider })

// ── Capability: workspace.read (always available if role has any workspace cap) ─
export const streamStatusToolInput = z.object({
  streamId: z.string().optional(),               // defaults to agent's current stream
  includeHierarchy: z.boolean().default(false),
});
// Handler: getStream + listStreams(filter) + optionally getStreamHierarchy

export const checkoutStreamToolInput = z.object({
  streamId: z.string(),
});
// Handler: switches agent's active stream (for returning to parent after fork+land).
// Capability gate: workspace.fork OR workspace.sync.
```

### 9.1 Capability → tool mapping

| Capability | Tools registered |
|---|---|
| `workspace.commit` | `commit` |
| `workspace.land` | `land` |
| `workspace.fork` | `fork_stream`, `checkout_stream` |
| `workspace.sync` | `sync_with_parent` |
| `workspace.merge` | `merge_stream` |
| `workspace.cascade` | `request_cascade` |
| `workspace.read` | `stream_status` |
| `merge_queue.drain` | `next_merge_request`, `mark_merge_complete` |

---

## 10. Boot integration

```ts
// boot-v2.ts — new path
export async function bootV2(config: BootV2Config): Promise<MacroAgentSystemV2> {
  // ... existing setup (agentStore, inbox, tasks, etc.) ...

  // Load team config if provided
  let teamManifest: TeamManifest | null = null;
  let workspaceConfig: TeamWorkspaceConfig | null = null;
  if (config.team) {
    teamManifest = await loadTeamManifest(config.team);
    const rawWorkspace = teamManifest.macro_agent?.workspace;
    if (rawWorkspace) {
      workspaceConfig = TeamWorkspaceConfigSchema.parse(rawWorkspace);
    }
  }

  // Construct WorkspaceManager if any role needs one
  let workspaceManager: WorkspaceManager | undefined;
  if (workspaceConfig || config.workspaceManager) {
    workspaceManager = config.workspaceManager ?? createDefaultWorkspaceManager({
      repoPath: config.cwd,
      pool: workspaceConfig?.pool,
    });

    // Register built-in landing strategies
    registerBuiltinLandingStrategies(workspaceManager);

    // Reconcile on boot
    const reconcileResult = workspaceManager.reconcile();
    logReconcile(reconcileResult);
  }

  // Construct agent manager
  const agentManager = createAgentManagerV2({
    // ... existing args ...
    workspaceManager,
  });

  // Construct topology policy
  let topologyPolicy: TopologyPolicy | undefined;
  if (workspaceConfig && workspaceManager) {
    topologyPolicy = new YamlDrivenTopology(workspaceConfig);
    agentManager.setTopologyPolicy(topologyPolicy);
  }

  // Start team if requested
  if (config.team && teamManifest) {
    const teamManager = new TeamManagerV2({
      agentManager,
      inboxAdapter,
      tasksAdapter,
      workspaceManager,
      topologyPolicy,
    });
    await teamManager.startTeam(teamManifest);
  }

  // ... rest of boot ...
}
```

Callers like `cognitive-core` continue to pass their own `workspaceManager` and skip team YAML entirely — they drive the API directly.

---

## 11. Open gaps in this draft

- **`checkout_stream` semantics** — moves agent's *context* (streamId in spawn env), but does it relocate cwd or re-allocate worktree? Needs concrete decision when we implement solo-stack.
- **`attach-to-stream` worktree** — when workspace kind is `attach_to_team_root`, does the agent get a fresh worktree on team_root's branch, or share with whoever already has one? Default: fresh worktree on the team_root branch.
- **Conflict recovery hook** — no interface method on `WorkspaceManager` yet for "escalate conflict to recovery strategy." Probably a pluggable `ConflictRecoveryStrategy` parallel to `LandingStrategy`. Deferred.
- **cascadeRebase triggering from events** — `YamlDrivenTopology` subscribes to `stream.committed` on parent streams when any child has `on_parent_advanced: sync_with_parent`. Needs WakeManager integration for coalescing. Deferred to migration step.
- **Backward compat shim for cognitive-core** — the existing `DefaultWorkspaceManager` needs to implement both old and new interfaces during migration. TBD once we start migration.

---

## 12. What's not defined here

- **Implementation** of `DefaultWorkspaceManager` — this doc is the interface only.
- **Migration order** — see `git-cascade-integration-gaps.md` §8.
- **Conflict recovery strategy interface** — parallel design, out of scope.
- **cc-swarm integration** — separate follow-up doc.
