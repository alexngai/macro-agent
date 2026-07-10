# macro-agent

A multi-agent orchestration system for spawning and managing hierarchical AI coding agents. Interact with multiple agents as if they were one.

macro-agent handles **orchestration** (agent lifecycle, team topology, workspace isolation, trigger/wake) and delegates **messaging** to [agent-inbox](https://github.com/alexngai/agent-inbox) and **task management** to [opentasks](https://github.com/alexngai/opentasks). It exposes ACP (WebSocket) and REST API servers, supports cross-instance federation, and can serve as a compute backend for [cognitive-core](https://github.com/alexngai/cognitive-core)/OpenHive.

---

## Table of contents

- [Install](#install)
- [Your first run (5 minutes)](#your-first-run-5-minutes)
- [How it works](#how-it-works)
- [Team configuration](#team-configuration)
  - [Minimum viable team](#minimum-viable-team)
  - [Workspace topology](#workspace-topology)
  - [Landing strategies](#landing-strategies)
  - [Conflict recovery](#conflict-recovery)
  - [Six team shapes](#six-team-shapes)
- [CLI reference](#cli-reference)
- [Programmatic API](#programmatic-api)
- [MCP tools agents get](#mcp-tools-agents-get)
- [Architecture](#architecture)
- [Design & internals](#design--internals)
  - [Why V3 was needed](#why-v3-was-needed)
  - [Workspace interfaces](#workspace-interfaces)
  - [Conflict recovery mechanics](#conflict-recovery-mechanics)
  - [Implementation status](#implementation-status)
- [Advanced integrations](#advanced-integrations)
- [Dependencies](#dependencies)
- [Testing](#testing)
- [License](#license)

---

## Install

```bash
npm install macro-agent
```

The workspace layer is powered by [git-cascade](https://github.com/alexngai/git-cascade), installed automatically as a dependency.

---

## Your first run (5 minutes)

The fastest way to use macro-agent is to run a team template with one command:

```bash
# From a git repository with a .multiagent/teams/<name>/team.yaml
npx multiagent-cli run self-driving --task "implement a /status endpoint"
```

That command does this:

1. Boots the full macro-agent system (inbox, tasks, agent manager, workspace layer).
2. Loads `.multiagent/teams/self-driving/team.yaml` and its `macro_agent.workspace` block.
3. Constructs a `YamlDrivenTopology` and wires it into the agent manager.
4. Creates a `team:self-driving` integration stream (forked from `main`).
5. Spawns the team's root agent (planner) + companions (judge) from the team YAML topology.
6. Sends your task to the root agent and streams the response.
7. On `Ctrl-C`: cleanly shuts down agents, closes worktrees, leaves the team stream intact for review.

Expected output (abridged):

```
Booting macro-agent and starting team: self-driving
System booted.
Team started: self-driving (instance self-driving-1)
Prompting root agent (agent_ab...) with task...
[agent output streams here]
Press Ctrl+C to shut down.
```

---

## How it works

The flow for a running team, end to end:

```
1. BOOT         bootV2 → AgentStore · Inbox · Tasks · AgentManager · Triggers
2. TEAM START   TeamManager.startTeam → load YAML → YamlDrivenTopology
                → onTeamStart creates team:<name> integration stream
                → bootstrap root + companions
3. SPAWN        agentManager.spawn(role)
                → topology.onAgentSpawn → WorkspaceDecision
                → executeWorkspaceDecision: create/fork stream, allocate worktree
                → Claude Code subprocess launched with MCP tools
4. WORK         Agent writes files in its isolated worktree
                → commits via `commit` MCP tool (Change-Id tracked)
                → sends messages via agent-inbox
                → spawns sub-agents via `spawn_agent` (capability-gated)
5. LAND         Agent calls `done()`
                → LandingStrategy invoked (merge-to-parent / queue-to-branch / etc.)
                → cascade rebase optional (for stacked streams)
6. RECOVER      If landing conflicts: ConflictRecoveryStrategy dispatches
                → defer / abandon / escalate / auto-resolve / spawn-resolver
7. SYNC         When a parent stream advances, roles with
                `on_parent_advanced: sync_with_parent` auto-rebase
                (coalesced 2s debounce)
8. TERMINATE    topology.onAgentComplete → deallocate worktree (ref-counted)
9. TEAM STOP    topology.onTeamStop → keep / merge-to-main / abandon the team stream
```

Key separation:
- **YAML** is the source of truth for team shape (who exists, which streams, what landing/recovery).
- **MCP tools** are how agents make runtime decisions within capabilities granted by YAML.
- **Programmatic API** on `WorkspaceManager` is for library consumers that bypass team YAML.

---

## Team configuration

Teams live in `.multiagent/teams/<name>/`:

```
.multiagent/teams/self-driving/
├── team.yaml          # Manifest: topology, communication, macro_agent block
├── roles/
│   ├── planner.yaml   # Custom role (extends coordinator)
│   ├── grinder.yaml   # Custom role (extends worker)
│   └── judge.yaml     # Custom role (extends monitor)
└── prompts/
    ├── planner.md
    ├── grinder.md
    └── judge.md
```

### Minimum viable team

```yaml
# team.yaml
name: my-team
version: 1
roles: [worker]

topology:
  root:
    role: worker
    prompt: prompts/worker.md

communication:
  enforcement: permissive

macro_agent:
  workspace:
    roles:
      worker:
        workspace: none   # no git isolation; inherit parent cwd
```

Run it:

```bash
npx multiagent-cli run my-team --task "hello"
```

### Workspace topology

The `macro_agent.workspace` block drives stream allocation per role. Grammar summary:

```yaml
macro_agent:
  workspace:
    default_stream:
      fork_from: main                # branch to fork team_root from
      name_template: "{team}"        # {team} is substituted at runtime
      change_id_tracking: true

    on_team_complete: keep           # or: merge_to_main, abandon

    roles:
      <role_name>:
        # What kind of workspace this role gets
        workspace: none | share_parent_cwd | attach_to_team_root |
                   share_with_agent | new_stream

        # When workspace: new_stream, how is the stream placed in the graph?
        stream_lineage: from_team_root | fork_from_team_root |
                        fork_from_parent | independent | track_existing_branch

        # How to finalize work (see Landing strategies below)
        landing: merge_to_parent_stream | queue_to_branch |
                 direct_push | optimistic_push | none
        landing_config: { }          # strategy-specific options

        # What to do on a landing conflict
        on_conflict: abort | ours | theirs | defer | agent
        on_conflict_recovery: defer | abandon | escalate |
                              auto-resolve | spawn-resolver

        # Auto-rebase onto parent when parent advances
        on_parent_advanced: sync_with_parent | none
        cascade_on_parent_update: true | false

        # Cross-role references
        share_with: <role_name>      # for workspace: share_with_agent
        track_branch: <branch_name>  # for stream_lineage: track_existing_branch

        # MCP tool access for the agent
        capabilities: [workspace.commit, workspace.land, ...]
```

### Landing strategies

When an agent calls `done()`, its role's `landing:` strategy finalizes the work.

| Strategy | What it does | Typical use |
|---|---|---|
| `merge_to_parent_stream` | `mergeStream(source → parent)`; optional cascade rebase for dependents | Stacked workflows, peer swarm |
| `queue_to_branch` | Adds to git-cascade's merge queue; integrator drains it later | Triad / many-writer flows |
| `direct_push` | `git rebase + git push` with retries | Trunk-based teams (self-driving's grinders) |
| `optimistic_push` | `direct_push` + emits validation event | Self-driving with judge reviewing after push |
| `none` | No landing (for read-only roles) | Researchers, judges, orchestrators |

Enable cascade rebase for stacked streams:

```yaml
roles:
  feature_owner:
    landing: merge_to_parent_stream
    landing_config:
      cascade: true                     # propagate rebase to dependents
      cascadeStrategy: defer_conflicts  # or: stop_on_conflict, skip_conflicting
```

### Conflict recovery

When landing returns a conflict, macro-agent dispatches a `ConflictRecoveryStrategy` based on the role's `on_conflict_recovery` (or team default).

| Strategy | Mode | Behavior |
|---|---|---|
| `defer` | sync | Leave conflict record in place; human/external resolves |
| `abandon` | sync | Abandon the conflicted stream — throwaway work |
| `escalate` | async | Pause stream, notify human, await external resolve_conflict |
| `auto-resolve` | sync | Replay merge with `-X ours/theirs/union`; commit; unblock |
| `spawn-resolver` | async | Spawn an LLM resolver agent; times out → escalates |

Example:

```yaml
macro_agent:
  workspace:
    conflict_recovery:
      default_strategy: spawn-resolver
      default_config:
        role: resolver
        timeout_ms: 1800000    # 30 min
      max_recovery_depth: 3

    roles:
      coder:
        landing: queue_to_branch
        on_conflict_recovery: spawn-resolver  # can override team default
      hotfix:
        on_conflict_recovery: auto-resolve
        conflict_recovery_config:
          strategy: ours
```

For `spawn-resolver`, define the resolver role:

```yaml
roles:
  resolver:
    workspace: new_stream
    stream_lineage: track_existing_branch     # attach to the conflicted branch
    landing: none                             # resolver doesn't land itself
    capabilities:
      - workspace.commit
      - workspace.resolve                     # unlocks resolve_conflict MCP tool
      - workspace.read
```

### Six team shapes

The workspace layer is designed to express 6 common multi-agent patterns. See [docs/git-cascade-integration-gaps.md](docs/git-cascade-integration-gaps.md) §5 for traces.

**1. Solo stack** — one agent, chain of forked streams:
```yaml
roles:
  author:
    workspace: new_stream
    stream_lineage: fork_from_team_root
    landing: merge_to_parent_stream
    cascade_on_parent_update: true
```

**2. Triad** — coordinator + integrator + N workers:
```yaml
roles:
  coordinator: { workspace: attach_to_team_root }
  worker:
    workspace: new_stream
    stream_lineage: fork_from_parent
    landing: queue_to_branch
    landing_config: { target: "stream:team_root" }
  integrator:
    workspace: attach_to_team_root
    capabilities: [workspace.merge, merge_queue.drain]
```

**3. Peer swarm** — N equal agents:
```yaml
roles:
  orchestrator: { workspace: none }
  peer:
    workspace: new_stream
    stream_lineage: fork_from_team_root
    landing: merge_to_parent_stream
```

**4. Pipeline** — planner → coder → reviewer → integrator:
```yaml
roles:
  planner: { workspace: none }
  coder:
    workspace: new_stream
    stream_lineage: fork_from_team_root
    landing: queue_to_branch
  reviewer:
    workspace: share_with_agent
    share_with: coder
    landing: none
  integrator:
    workspace: attach_to_team_root
    capabilities: [workspace.merge, merge_queue.drain]
```

**5. Research / read-only** — agents don't commit:
```yaml
roles:
  researcher:
    workspace: none
    capabilities: []
```

**6. Long-lived feature + subtasks** — parent rebases onto main as it advances:
```yaml
roles:
  feature_owner:
    workspace: new_stream
    stream_lineage: fork_from_team_root
    landing: merge_to_parent_stream
    cascade_on_parent_update: true
    on_parent_advanced: sync_with_parent
  subtask:
    workspace: new_stream
    stream_lineage: fork_from_parent
    landing: merge_to_parent_stream
```

---

## CLI reference

```bash
# Run a team with optional initial task
npx multiagent-cli run <teamName> [--task "..."] [--cwd <path>] [--base-path <path>]

# Interactive chat with a head manager (no team)
npx multiagent-cli chat [--cwd <path>]

# System status (agent count, active sessions)
npx multiagent-cli status

# Agent hierarchy tree
npx multiagent-cli hierarchy [rootId]

# List agents (optional filter)
npx multiagent-cli agents [agentId]

# Stop a specific agent or all
npx multiagent-cli stop <agentId>
npx multiagent-cli stop --all

# Wipe local state (agents.db, inbox.db, worktrees)
npx multiagent-cli clear

# ACP stdio server (for embedding via acp-factory)
npx multiagent --acp
```

`run` exits cleanly on `SIGINT` (Ctrl-C). Exit code `0` on normal shutdown, non-zero if team startup fails.

---

## Programmatic API

For library consumers (tools, tests, cognitive-core):

```typescript
import { bootV2 } from 'macro-agent';

const system = await bootV2({
  cwd: process.cwd(),
  // Optional: enable extras
  api:        { enabled: true, port: 3000 },
  acp:        { enabled: true, port: 8080 },
  federation: { systemId: 'dev-laptop' },
});

// Option A: start a team with auto-wired V3 topology
const teamManager = new TeamManagerV2({
  agentManager: system.agentManager,
  inboxAdapter: system.inboxAdapter,
  tasksAdapter: system.tasksAdapter,
  workspaceManager: system.workspaceManager,
});
teamManager.install();
await teamManager.startTeam('self-driving');

// Option B: drive agents directly (no team YAML)
const head = await system.agentManager.getOrCreateHeadManager({ cwd: process.cwd() });
for await (const update of system.agentManager.prompt(head.id, 'Do the thing')) {
  // stream updates
}

await system.shutdown();
```

Workspace API for direct control:

```typescript
import { DefaultWorkspaceManager, createGitCascadeAdapter } from 'macro-agent';

const adapter = createGitCascadeAdapter({ enabled: true, repoPath, dbPath });
const ws = createWorkspaceManagerWithAdapter(adapter);

// Stream-first primitives
const stream = ws.createStreamV3({ name: 'feature-x', ownerId: 'team:app', forkFrom: 'main' });
const child = ws.forkStream({ parentStreamId: stream, name: 'sub', ownerId: 'agent-1' });
const wt = ws.allocateWorktree({ agentId: 'agent-1', streamId: child });

// Change-Id tracked commit
const { commit, changeId } = ws.commitChanges({
  agentId: 'agent-1', streamId: child, worktree: wt.path, message: 'feat: x',
});

// Land via strategy
const result = await ws.land({ agentId: 'agent-1', streamId: child, strategyName: 'merge-to-parent' });
```

---

## MCP tools agents get

Registered per role based on capabilities declared in team YAML:

| Source | Tools | Capability required |
|---|---|---|
| macro-agent | `done`, `spawn_agent`, `stop_agent`, `get_hierarchy`, `inject_context` | always available |
| macro-agent | `claim_task`, `unclaim_task`, `list_claimable_tasks` | `task.claim` |
| macro-agent | `commit` | `workspace.commit` |
| macro-agent | `land` | `workspace.land` |
| macro-agent | `resolve_conflict`, `list_conflicts`, `get_conflict` | `workspace.resolve` |
| macro-agent | `next_merge_request`, `mark_merge_complete` | `merge_queue.drain` |
| agent-inbox | `send_message`, `check_inbox`, `read_thread`, `list_agents` | always available |
| opentasks | `task`, `link`, `annotate`, `query` | always available |

Role YAML grants capabilities:

```yaml
# roles/grinder.yaml
name: grinder
extends: worker
capabilities_add:
  - workspace.commit
  - workspace.land
  - task.claim
```

---

## Architecture

```
              CLI / ACP stdio / WebSocket / REST API
                              │
                         ┌────▼────┐
                         │ bootV2  │  Wires all components
                         └────┬────┘
                              │
       ┌──────────┬───────────┼───────────┬──────────┐
       │          │           │           │          │
 ┌─────▼─────┐ ┌─▼───────┐ ┌▼────────┐ ┌▼───────┐ ┌▼──────────┐
 │  Agent    │ │ Trigger  │ │ Control │ │  ACP   │ │ REST API  │
 │  Manager  │ │ System   │ │ Socket  │ │ Server │ │ Server    │
 │           │ │          │ │ (RPC)   │ │ (WS)   │ │ (HTTP)    │
 │  spawn    │ │ router   │ └────┬────┘ └────────┘ └───────────┘
 │  prompt   │ │ wake     │      │
 │  terminate│ │ cron     │  MCP subprocesses (per agent)
 └─────┬─────┘ │ webhook  │
       │       │ ai-router│
 ┌─────┼───────┘──────────┐
 │     │                  │
┌▼────┐┌▼──────────────┐ ┌───▼────────┐
│Roles││ Workspace (V3) │ │  Adapters  │
│    ││ TopologyPolicy │ │            │
│    ││ LandingStrategy│ │ InboxAdapter  ──► agent-inbox (embedded)
│    ││ ConflictRecov. │ │ TasksAdapter  ──► opentasks  (IPC daemon)
│    ││ GitCascadeAdpt │ │ Federation    ──► remote instances
└────┘└────────────────┘ └────────────┘
```

Three subsystems:
- **macro-agent** — orchestration, lifecycle, teams, workspace, triggers, ACP/REST, federation, cognitive backend
- **agent-inbox** — messaging (embedded in-process, IPC server for subprocesses, federation)
- **opentasks** — task management (separate daemon, IPC client)

For full design rationale and interface contracts:
- [docs/workspace-interfaces.md](docs/workspace-interfaces.md) — V3 TypeScript contracts
- [docs/git-cascade-integration-gaps.md](docs/git-cascade-integration-gaps.md) — design narrative + 6 workflow traces
- [docs/conflict-recovery.md](docs/conflict-recovery.md) — recovery strategy design
- [docs/workspace-redesign-plan.md](docs/workspace-redesign-plan.md) — implementation plan + status

The four subsections below summarize those docs so this README is useful standalone.

---

## Design & internals

### Why V3 was needed

The original workspace layer was **role-shaped**: every agent had to be a `coordinator`, `worker`, or `integrator`, and the dispatch path in `AgentManagerV2` hardcoded a `switch(role)` that decided what kind of workspace to allocate. The API surface — `createWorkerWorkspace`, `createIntegratorWorkspace`, `createCoordinatorWorkspace`, `createIntegrationStream`, `getMergeQueue` — reflected this bias.

**Problems in the old model:**

| Symptom | Cause |
|---|---|
| One stream per team, owned by a coordinator | Hardcoded in `TeamRuntimeV2` at bootstrap |
| Cascade rebase (git-cascade's namesake) never called | Adapter never surfaced it |
| Change-IDs never tracked | Agents used raw `git commit`, bypassing `commitChanges` |
| Merge queue duplicated | `src/workspace/merge-queue/` replicated git-cascade's built-in with incompatible semantics |
| Only 20% of git-cascade's API used | Role-shaped wrapper hid most of the library |
| Peer-swarm / solo-stack / pipeline shapes unexpressible | No role name mapped to them |

**What V3 changed:**

1. **Stream-first primitives.** `createStreamV3`, `forkStream`, `allocateWorktree`, `commitChanges`, `land` — all role-neutral. Any `Principal` (real `AgentId` or pseudo like `team:<name>`) can own a stream.
2. **YAML-driven topology.** Team YAML's `macro_agent.workspace` block declares per-role workspace decisions. `YamlDrivenTopology` compiles this into per-spawn `WorkspaceDecision` objects.
3. **Pluggable landing strategies.** `merge-to-parent`, `queue-to-branch`, `direct-push`, `optimistic-push` replace the dead `IntegrationStrategy` abstraction.
4. **Pluggable conflict recovery.** `defer` / `abandon` / `escalate` / `auto-resolve` (real git `-X` merge) / `spawn-resolver` (LLM agent).
5. **git-cascade 0.0.3 alignment.** `cascade` namespace export + `emit` callback wired, unlocking `cascadeRebase` and event-driven auto-sync.
6. **Legacy path retained.** Programmatic callers that bypass team YAML still use capability-based dispatch (`workspace.worktree` / `workspace.stream` / `workspace.integrate`).

Three control layers coexist:

| Layer | Used by | What it controls |
|---|---|---|
| YAML (`macro_agent.workspace`) | Team authors | Static shape: who gets a stream, lineage, landing, recovery |
| MCP tools (`commit`, `land`, `fork_stream`, `resolve_conflict`, ...) | Agents at runtime | Runtime judgment within YAML-granted capabilities |
| Programmatic API on `WorkspaceManager` | Tools, tests, cognitive-core | Full control without team YAML |

### Workspace interfaces

Three interfaces form the V3 workspace layer. Types live in `src/workspace/types-v3.ts`.

**`WorkspaceManager`** — the full API surface, grouped by concern:

```typescript
interface WorkspaceManager {
  // Streams
  createStreamV3(spec: StreamSpec): StreamId;
  forkStream(opts: { parentStreamId, name, ownerId, metadata? }): StreamId;
  mergeStream(opts: { sourceStreamId, targetStreamId, agentId, worktree }): MergeResult;
  syncWithParent(opts: { streamId, agentId, worktree, onConflict? }): RebaseResult;
  abandonStream(streamId, opts?): void;
  pauseStream(streamId, reason?): void;
  resumeStream(streamId): void;
  listStreams(filter?): Stream[];
  getStream(streamId): Stream | null;

  // Changes (Change-Id tracking via git-cascade)
  commitChanges(opts): { commit: string; changeId: ChangeId };
  markChangesMerged(changeIds: ChangeId[]): void;
  getChange(changeId): Change | null;
  getChangeByCommit(commit): Change | null;

  // Worktrees
  allocateWorktree(opts: AllocateWorktreeOpts): Worktree;
  deallocateWorkspace(agentId): void;
  getWorktreeForAgent(agentId): Worktree | null;

  // Landing + recovery
  registerLandingStrategy(strategy: LandingStrategy): void;
  land(opts): Promise<MergeResult>;
  resolveConflict(opts: { conflictId, resolvedBy, resolutionCommit? }): void;

  // Events + lifecycle
  onEvent(callback: WorkspaceEventCallback): () => void;
  reconcileV3(): MacroReconcileResult;
  close(): void;
}
```

**Core types:**

```typescript
// A principal — either a real agent or a pseudo-principal for team/system ownership
type Principal = AgentId | `team:${string}` | `system:${string}`;

interface StreamSpec {
  name: string;
  ownerId: Principal;
  parent?: StreamId;        // if set, forks from this parent stream
  forkFrom?: string;        // otherwise forks from this branch (default: "main")
  metadata?: Record<string, unknown>;
}

interface AllocateWorktreeOpts {
  agentId: Principal;
  streamId?: StreamId;
  sharedWithAgent?: AgentId;  // ref-counted co-location
  branch?: string;
  baseDir?: string;
}
```

**`TopologyPolicy`** — compiles team YAML into per-spawn decisions:

```typescript
interface TopologyPolicy {
  readonly name: string;
  onTeamStart(ctx): Promise<TeamStartPlan>;         // create team-root stream
  onAgentSpawn(ctx): Promise<WorkspaceDecision>;    // per-spawn workspace choice
  onAgentComplete(ctx): Promise<void>;              // deallocate worktree
  onTeamStop(ctx): Promise<void>;                   // apply on_team_complete
}

type WorkspaceDecision =
  | { kind: 'none' }
  | { kind: 'share-parent-cwd' }
  | { kind: 'share-with-agent'; agentId: AgentId }
  | { kind: 'attach-to-stream'; streamId: StreamId; allocateWorktree: boolean }
  | { kind: 'new-stream'; streamSpec: StreamSpec; allocateWorktree: boolean };
```

Three built-in policies:
- **`YamlDrivenTopology`** — the default; compiles `macro_agent.workspace` YAML
- **`NoWorkspaceTopology`** — null policy returning `share-parent-cwd` for every spawn
- **Custom** — implement the interface for bespoke topologies

**`LandingStrategy`** — finalizes work at `done()` time:

```typescript
interface LandingStrategy {
  readonly name: string;
  canLand?(ctx: LandingContext): boolean;
  land(ctx: LandingContext): Promise<MergeResult>;
  initialize?(): Promise<void>;
  close?(): Promise<void>;
}

interface LandingContext {
  agentId: AgentId;
  streamId: StreamId;
  sourceWorktree: string;
  targetStreamId?: StreamId;
  strategyConfig?: Record<string, unknown>;   // from YAML landing_config
  workspaceManager: WorkspaceManager;
}
```

Registered via `workspaceManager.registerLandingStrategy()` at boot. YAML `landing:` selects per role; MCP `land()` tool arguments can override per call.

**Events** — all operations emit through a single channel:

```typescript
type WorkspaceEventType =
  | 'stream:created' | 'stream:forked' | 'stream:committed'
  | 'stream:merged' | 'stream:conflicted' | 'stream:abandoned'
  | 'stream:paused' | 'stream:resumed'
  | 'worktree:allocated' | 'worktree:shared' | 'worktree:released'
  | 'change:merged' | 'change:dropped'
  | 'conflict:created' | 'conflict:resolved'
  | 'landing:started' | 'landing:completed'
  | 'cascade:completed'
  | 'mergeQueue:added' | 'mergeQueue:ready' | 'mergeQueue:cancelled' | 'mergeQueue:removed';
```

Subscribers include `YamlDrivenTopology` (for `on_parent_advanced` auto-sync) and the conflict recovery dispatcher (awaiting `conflict:resolved`).

### Conflict recovery mechanics

Conflicts originate from four operations:

| Operation | How conflict surfaces |
|---|---|
| `mergeStream(source → target)` | Result has `success: false`, `conflictId` present |
| `syncWithParent(stream)` | Rebase fails with `ConflictStrategy != 'ours'/'theirs'` |
| `rebaseOntoStream(target)` | Same as syncWithParent |
| `cascadeRebase({ root })` | `CascadeResult.failed[]` populated |

**Dispatch flow:**

```
Agent calls done()
  ↓
Role's LandingStrategy invoked
  ↓
LandingStrategy returns { success: false, conflictId }
  ↓
done() handler looks up role's on_conflict_recovery (or team default)
  ↓
workspaceManager dispatches to the matching ConflictRecoveryStrategy
  ↓
Strategy runs sync (returns immediately) or async (awaits conflict:resolved event)
  ↓
Resolution: resolved | deferred | abandoned | escalated | retry-after | failed
```

Landing strategies **never** dispatch recovery themselves. They return the conflict up; the agent's `done()` flow owns recovery selection. This keeps strategies free of role-level policy (which lives in YAML).

**`ConflictRecoveryStrategy` interface:**

```typescript
interface ConflictRecoveryStrategy {
  readonly name: string;
  readonly mode: 'sync' | 'async';
  canHandle?(ctx: ConflictContext): boolean;
  recover(ctx: ConflictContext): Promise<ConflictResolution>;
}

interface ConflictContext {
  conflictId: string;
  streamId: StreamId;
  paths: string[];
  operation: 'merge' | 'sync' | 'rebase' | 'cascade';
  landingAgentId?: AgentId;
  worktree?: string;            // required for auto-resolve
  recoveryDepth: number;        // for bounded recursion
  strategyConfig?: Record<string, unknown>;  // from YAML conflict_recovery_config
  workspaceManager: WorkspaceManager;
}

type ConflictResolution =
  | { kind: 'resolved'; resolutionCommit: string }
  | { kind: 'deferred'; reason: string }
  | { kind: 'abandoned'; streamId: StreamId; reason: string }
  | { kind: 'escalated'; escalatedTo: Principal | 'human' }
  | { kind: 'retry-after'; backoffMs: number; reason: string }
  | { kind: 'failed'; error: string };
```

**Built-in strategy details:**

- **`defer`** — no-op. Returns `deferred`. Leaves the conflict record; a human or external process resolves later.
- **`abandon`** — calls `workspaceManager.abandonStream(streamId, { reason })`. Returns `abandoned`. For throwaway workflows.
- **`escalate`** — async. `pauseStream(streamId)` + emit escalation event. Returns `escalated` immediately; waits for an external `resolve_conflict` MCP call to unblock. Suitable when humans must review.
- **`auto-resolve`** — sync. Only handles `operation: 'merge'`. Replays the failed merge in `ctx.worktree` with `git merge -X ours|theirs|union`, commits the resolution, calls `workspaceManager.resolveConflict`. Returns `resolved` with the new commit hash.
- **`spawn-resolver`** — async. Spawns a resolver agent via `AgentManager.spawn({ role, ... })` with `workspace.resolve` capability. The resolver reads conflict markers, resolves, commits via the `commit` MCP tool, then calls `resolve_conflict` which emits `conflict:resolved`. The awaiting strategy promise resolves with the resolution commit. On timeout → `escalated`. Configurable concurrency cap (`max_concurrent` per stream) prevents resolver spawn storms.

**Safety controls:**

| Control | Location | Default |
|---|---|---|
| `max_recovery_depth` | `macro_agent.workspace.conflict_recovery.max_recovery_depth` | 3 |
| Per-stream recovery lock | Module-level in `spawn-resolver` | Auto |
| `max_concurrent` resolvers per stream | Strategy config | 2 |
| `timeout_ms` for async strategies | Strategy config | 30 min |

Recursion: if a resolver agent's resolution itself produces a new conflict, `recoveryDepth` increments. When it exceeds `max_recovery_depth`, the strategy falls back to `escalate`.

### Implementation status

The V3 redesign shipped as 10 phases plus 6 follow-up fixes. All are in `main`.

**Completed:**

| # | Phase | What shipped |
|---|---|---|
| 0 | GitCascadeAdapter expansion | 40+ git-cascade primitives surfaced (streams, forks, merges, cascade, changes, events) |
| 1 | WorkspaceManager V3 surface | Stream-first methods alongside legacy role-shaped ones |
| 2 | YAML Zod schema | `macro_agent.workspace` validated at team load |
| 3 | TopologyPolicy + YamlDrivenTopology | Declarative topology compiler |
| 4 | AgentManagerV2 delegates to TopologyPolicy | V3 dispatch path with legacy capability fallback |
| 5 | LandingStrategy integration | 4 built-in strategies registered |
| 6 | MergeQueue marked `@deprecated` | Duplicate kept for legacy callers; scheduled for removal |
| 7 | ConflictRecoveryStrategy | 5 built-in strategies (including real-git `auto-resolve` + `spawn-resolver`) |
| 8 | Role-name fallback removed | `switch(role)` deleted; capability-based path retained |
| 9 | Legacy methods retained (not hard-removed) | Reframed: they serve programmatic callers |
| 10 | `macro-agent run <team>` CLI | Single-command team launch |

**Follow-up fixes (post-plan):**

| # | Fix | Verified by |
|---|---|---|
| a | git-cascade 0.0.3 event wiring + cascade namespace | Adapter forwards `x-cascade/*` events into `WorkspaceEvent` stream |
| b | `macro-agent run` CLI e2e (subprocess spawn, SIGINT exit) | 2 e2e tests |
| c | self-driving team migrated to V3 YAML | 4 e2e tests; caught duplicate-stream bug in TeamRuntime |
| d | `spawn-resolver` real-spawn e2e | 4 unit + 2 e2e tests |
| e | Shared worktree ref-counting (Gap 3) | Fixed 2 latent bugs: sharer dealloc leaked refs; owner dealloc tore down path while sharers alive. 6 unit tests cover lifecycle |
| f | Cascade worktree provider (Gap 1) | Replaced null-returning stub with real provider: reuses live worktrees, allocates ephemeral `system:cascade-<id>` worktrees, cleans up in `finally`. Per-root-stream lock prevents parallel cascades racing. 4 e2e tests |
| g | `on_parent_advanced: sync_with_parent` auto-sync (Gap 2) | Full implementation: event subscription, 2-second coalescing debounce, role-scoped dispatch. 3 e2e tests |

**Test counts after all fixes:**

- 998 unit tests (59 files)
- 183 e2e tests (25 files) — all previously skipped `RUN_FULL_AGENT_TESTS` tests pass with real Claude Code
- Zero regressions, clean typecheck

**Known open items / follow-ups:**

| Item | Severity | Notes |
|---|---|---|
| Hard removal of legacy capability dispatch | Low | Retained as programmatic API; not a gap, a supported path |
| `on_team_complete: merge_to_main` implementation | Low | Currently leaves stream active. Requires landing strategy on team stream; deferred |
| Cross-team conflict policy | Low | When conflicts span teams, owner team's policy applies; federation-specific edge cases |
| Recovery observability dashboard | Low | `conflict:*` events fire; no built-in UI yet |

**Coverage gaps intentionally accepted:**

- Cascade with >3 levels under `stop_on_conflict` — tested at 3 levels only
- Shared worktree edge case: sharer outlives owner for >1 hour (no TTL) — accepted; `reconcileV3` cleans stale entries on boot

---

## Advanced integrations

### ACP Protocol Server

Bridges the [Agent Client Protocol](https://github.com/agentclientprotocol/agent-client-protocol) to macro-agent so external clients can connect:

```typescript
const system = await bootV2({ acp: { enabled: true, port: 8080 } });
// session/new → head manager creation
// session/prompt → streaming responses
// Extension methods: _macro/spawnAgent, _macro/getHierarchy, _macro/forkAgent, etc.
```

### REST API

```typescript
const system = await bootV2({ api: { enabled: true, port: 3000 } });
// HTTP endpoints for agents, tasks, teams, metrics — used for dashboards
```

### Federation

Connect multiple macro-agent instances for cross-instance messaging:

```typescript
const system = await bootV2({
  federation: {
    systemId: 'dev-laptop',
    peers: [{ systemId: 'ci-server', url: 'ws://ci:8080' }],
    trust: { allowedSystems: ['ci-server'] },
  },
});
// Agents address with agentId@systemId (e.g., coordinator@ci-server)
```

### Cognitive-core backend

Serve as compute backend for [cognitive-core](https://github.com/alexngai/cognitive-core) / OpenHive:

```typescript
import { MacroAgentBackend } from 'macro-agent';
const backend = new MacroAgentBackend(system.agentManager, {
  tasksAdapter: system.tasksAdapter,
  inboxAdapter: system.inboxAdapter,
});
```

The swarm is pure compute — atlas, trajectory extraction, and team coordination are handled by OpenHive.

---

## Dependencies

| Package | Purpose |
|---|---|
| [agent-inbox](https://github.com/alexngai/agent-inbox) | Messaging, threading, federation |
| [opentasks](https://github.com/alexngai/opentasks) | Task graph, dependencies, claiming |
| [acp-factory](https://github.com/alexngai/acp-factory) | Agent process management |
| [openteams](https://github.com/alexngai/openteams) | Team template resolution |
| [git-cascade](https://github.com/alexngai/git-cascade) | Git worktrees, stream/fork/merge, Change-Id tracking, cascade rebase |
| express | REST API server |
| ws | ACP WebSocket transport |

---

## Testing

```bash
# Unit tests (59 files, ~1000 tests)
npm test                              # watch
npx vitest run                        # single run

# E2E tests (24 files, ~180 tests — mocked agent sessions)
RUN_E2E_TESTS=true npm run test:e2e

# Full e2e with real Claude Code agents
RUN_FULL_AGENT_TESTS=true RUN_E2E_TESTS=true npm run test:e2e
```

---

## Development

```bash
npm install          # Install dependencies
npm run build        # Build (TypeScript → dist/)
npm run dev          # Watch mode build
```

---

## License

MIT
