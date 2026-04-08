# Task Dispatcher Design

## Overview

A dispatch mode for macro-agent's trigger system that polls opentasks for ready work and spawns agents to execute it. Turns the existing event-driven trigger architecture into an autonomous work processor — the swarmkit equivalent of Symphony's daemon loop, built on primitives that already exist.

## Problem

Swarmkit can coordinate agents and track tasks across systems, but has no "point at a backlog, walk away" mode. Today, agents must be manually spawned or externally triggered. There's no continuous loop that:

1. Watches for ready tasks
2. Claims and dispatches them to agents
3. Manages concurrency, retries, and cleanup

## Architecture

The dispatcher is **not a new system** — it's three components wired into the existing trigger pipeline:

```
┌─────────────────────────────────────────────────────────────────┐
│                      trigger system v2                          │
│                                                                 │
│  ┌──────────┐     ┌──────────────┐     ┌───────────────────┐   │
│  │ CronJob  │────▶│ TriggerEvent │────▶│ TaskDispatch      │   │
│  │ "poll"   │     │ (internal)   │     │ RoutingStrategy   │   │
│  │ every N  │     └──────────────┘     │                   │   │
│  └──────────┘                          │  query ready ─────┼──▶ opentasks
│                          ┌─────────────│  check capacity   │   │
│  ┌──────────┐            │             │  claim + spawn ───┼──▶ agentManager
│  │ Reconcile│────────────┘             │  reconcile state  │   │
│  │ CronJob  │  (separate cadence)      │  track dispatch   │   │
│  │ every M  │                          └───────────────────┘   │
│  └──────────┘                                                   │
│                                                                 │
│  ┌──────────────────┐     ┌─────────────────────────────────┐  │
│  │ DispatchLifecycle │────▶│ onLifecycleEvent() callback    │  │
│  │ Listener          │     │ + inbox signal filter           │  │
│  │                   │     │ + retry on failure              │  │
│  └──────────────────┘     └─────────────────────────────────┘  │
│                                                                 │
│  ┌──────────────────┐                                          │
│  │ DispatchTracker  │  in-memory state: active dispatches,     │
│  │                  │  retry queue, concurrency counts          │
│  │                  │  + reconstruction from opentasks on boot  │
│  └──────────────────┘                                          │
└─────────────────────────────────────────────────────────────────┘
```

---

## Design Decisions

### 1. Parentless Agents

**Decision: Dispatched agents spawn as root agents (`parent: null`).**

AgentManagerV2 already supports parentless agents — they're treated as "head managers" with `isHeadManager: true`. The lifecycle works without a parent:

- `spawn()` accepts `parent: undefined` with no validation error (agent-manager-v2.ts:348)
- Signal emission is skipped when `!context.parentId` (handlers-v2.ts:59)
- Cascade termination works regardless of parent (agent-manager-v2.ts:801-822)

This means dispatched agents are **peers, not children**. They don't report upward via signals — the dispatcher tracks them directly via lifecycle events (see §7 below).

**Why not a synthetic coordinator parent?** A headless coordinator that nobody interacts with adds complexity for no benefit. The dispatcher itself is the coordination layer — it tracks state, manages retries, and handles lifecycle. A parent agent would just be a proxy for logic that already lives in the dispatch strategy.

**Implication:** Dispatched agents can't use the `done()` signal path to notify a parent. Instead, the dispatcher listens to `onLifecycleEvent()` callbacks (type `"stopped"`) and inbox signals via `addSignalFilter()`. See §7.

---

### 2. Hybrid Push/Pull Dispatch

**Decision: Support both modes, configurable per dispatch config. Default to push.**

The dispatcher supports three modes:

```typescript
export type DispatchMode =
  | "push"       // Dispatcher assigns task, spawns dedicated agent
  | "pull"       // Dispatcher maintains a pool of idle workers that self-claim
  | "hybrid";    // Dispatcher pushes high-priority, workers pull the rest
```

#### Push Mode (default)

Dispatcher claims task → spawns agent with task prompt → agent works on assigned task → done.

- **Pros:** Predictable, simple lifecycle, one agent per task
- **Cons:** Cold start per task (agent spawn overhead)
- **Best for:** Heavy tasks, tasks needing specific roles/prompts

#### Pull Mode

Dispatcher maintains N idle worker agents. Workers call `claim_task` / `list_claimable_tasks` to self-select work. Dispatcher respawns workers when they terminate or the pool drops below threshold.

```typescript
export interface PullModeConfig {
  /** Target number of idle workers to maintain */
  poolSize: number;
  /** Role for pool workers */
  workerRole: string;
  /** How long a worker can be idle before termination (ms) */
  idleTimeoutMs?: number;
  /** Whether workers should loop (claim next task after completing one) */
  workerLoop: boolean;
}
```

- **Pros:** Amortizes spawn cost, workers self-select based on capability
- **Cons:** Pool management complexity, workers may compete for same tasks
- **Best for:** Many small tasks, fast throughput

#### Hybrid Mode

High-priority tasks (priority >= threshold) get push-dispatched. Everything else is available for pool workers to pull.

```typescript
export interface HybridConfig {
  push: DispatchConfig;
  pull: PullModeConfig;
  /** Tasks at or above this priority get push-dispatched */
  pushPriorityThreshold: number;
}
```

---

### 3. Workspace Lifecycle Across Retries

**Decision: Configurable per dispatch config. Three strategies:**

```typescript
export type RetryWorkspaceStrategy =
  | "reuse"     // Keep worktree, agent resumes from existing state
  | "fresh"     // Delete worktree, agent starts clean
  | "branch";   // Keep worktree but create a new branch from the pre-failure state
```

```yaml
dispatch:
  retry:
    maxRetries: 3
    workspaceStrategy: reuse     # or "fresh" or "branch"
    preserveOnExhaustion: true   # keep workspace for inspection after final failure
    cleanupDelayMs: 300000       # wait 5 min before cleaning completed workspaces
```

**`reuse` (default):** The agent gets the workspace as-is. Its prompt includes retry context (attempt number, previous error). This matches Symphony's behavior — workspace persists across turns/retries.

**`fresh`:** The worktree is deleted and recreated. Appropriate when failures leave corrupted state (bad merges, broken dependencies).

**`branch`:** Creates a new branch from the current worktree state before retrying. Preserves progress while giving the agent a clean commit history to work from.

**Cleanup:** On final completion, worktree cleanup happens after `cleanupDelayMs` (default: 5 min, configurable to 0 for immediate). On retry exhaustion with `preserveOnExhaustion: true`, the workspace is preserved and a MAP event is emitted so operators can inspect it.

---

### 4. Task-to-Prompt Mapping via Opentasks

**Decision: Extend opentasks with a `context` field and a prompt assembly pipeline.**

The current opentasks `TaskRecord` has `title`, `content`, and `metadata` — not enough for rich agent prompts. Rather than building prompt logic into the dispatcher, extend opentasks to carry structured context that any consumer (dispatcher, agent, dashboard) can use:

```typescript
// Extension to opentasks TaskRecord
export interface TaskContext {
  /** Structured description (markdown) */
  description?: string;
  /** File paths relevant to this task */
  files?: string[];
  /** Related task IDs for cross-reference */
  related?: string[];
  /** Acceptance criteria */
  criteria?: string[];
  /** Labels/categories from the source tracker */
  labels?: string[];
  /** Source tracker URL (e.g., Linear issue URL) */
  sourceUrl?: string;
  /** Free-form key-value context from the tracker */
  extra?: Record<string, unknown>;
}
```

The dispatcher's prompt pipeline then becomes composable:

```typescript
export interface PromptPipeline {
  /** Ordered list of prompt builders — each appends context */
  stages: PromptStage[];
}

export interface PromptStage {
  name: string;
  build(task: TaskRecord, context: PromptContext): Promise<string | null>;
}

// Built-in stages:
// 1. "task-core"     — title, description, criteria, files
// 2. "retry-context" — attempt number, previous error, workspace state
// 3. "playbook"      — query cognitive-core for relevant playbooks (opt-in)
// 4. "role-prompt"   — append role-specific instructions from openteams
// 5. "custom"        — user-provided function
```

This keeps the dispatcher thin (it calls the pipeline) while making prompt assembly extensible. The playbook stage is opt-in — only active if cognitive-core is configured.

---

### 5. Task Eligibility: Heuristic + Configurable + Agent-Driven

**Decision: Three-layer eligibility check before dispatch.**

"Ready" (no blockers in opentasks) is necessary but not sufficient. The dispatcher applies:

#### Layer 1: Static Filters (config-driven)

```yaml
dispatch:
  eligibility:
    tags: [backend, auto]           # Only tasks with these tags
    excludeTags: [manual, blocked]  # Skip tasks with these tags
    trackers: [linear, github]      # Only from these tracker types
    minPriority: 2                  # Skip low-priority tasks
    maxAge: 86400000                # Skip tasks older than 24h (ms)
    requireFields: [description]    # Skip tasks missing required fields
```

#### Layer 2: Heuristic Scoring (built-in)

Tasks that pass static filters get a dispatch score:

```typescript
export interface EligibilityScore {
  taskId: string;
  score: number;       // 0-1, higher = more eligible
  reasons: string[];   // Why this score
}

function scoreTask(task: TaskRecord): EligibilityScore {
  let score = 1.0;
  const reasons: string[] = [];

  // Penalize tasks with no description
  if (!task.content && !task.metadata?.description) {
    score *= 0.3;
    reasons.push("no description — agent may lack context");
  }

  // Penalize tasks with too many prior failures
  const failures = task.metadata?.failureCount as number ?? 0;
  if (failures > 0) {
    score *= Math.pow(0.7, failures);
    reasons.push(`${failures} prior failures`);
  }

  // Boost tasks with acceptance criteria
  if (task.metadata?.criteria) {
    score *= 1.2;
    reasons.push("has acceptance criteria");
  }

  // Boost tasks with file references
  if (task.metadata?.files) {
    score *= 1.1;
    reasons.push("has file references");
  }

  return { taskId: task.id, score: Math.min(score, 1), reasons };
}
```

Tasks below a configurable `minScore` threshold (default: 0.3) are skipped. They stay in opentasks as ready but aren't dispatched until they gain more context.

#### Layer 3: Agent-Driven Triage (opt-in)

For teams that want smarter triage, the dispatcher can spawn a lightweight triage agent that evaluates borderline tasks:

```yaml
dispatch:
  eligibility:
    agentTriage:
      enabled: true
      role: triage              # Role from openteams
      minScoreForTriage: 0.3    # Only triage tasks in this range
      maxScoreForTriage: 0.7
      maxTriagePerCycle: 3      # Don't triage too many per poll
```

The triage agent gets a batch of borderline tasks and returns a verdict per task: `dispatch`, `skip`, or `needs-context` (which creates an opentasks annotation requesting more info from the human).

This is the AI router pattern applied to task eligibility — same trade-off (expensive but intelligent).

---

### 6. Multi-Instance Safety

**Decision: Opentasks daemon is the coordination point. Add atomic claim to opentasks.**

macro-agent is single-process-per-project by design. But multiple instances (different machines, CI environments) may share the same opentasks task pool. The current `claimTask` is not atomic (query → assign is TOCTOU).

#### Required: Atomic Claim in Opentasks

```typescript
// New opentasks operation: atomic claim-if-unclaimed
interface AtomicClaimRequest {
  action: "claim";
  taskId: string;
  claimant: string;      // Unique claimant ID (instance + agent)
  ttlMs?: number;        // Claim expires if not renewed (heartbeat)
}

interface AtomicClaimResponse {
  success: boolean;
  claimedBy?: string;    // Who currently holds the claim (if failed)
}
```

This must be atomic at the opentasks daemon level — a single IPC operation that checks and sets. If two dispatchers race, one gets `success: false` and moves on.

#### Instance Identity

Each dispatcher registers with a unique claimant prefix:

```typescript
const claimantId = `${hostname}:${pid}:${instanceId}`;
// e.g., "dev-laptop:12345:inst_a1b2c3d4"
```

This uses the existing `stable-instance-id.ts` (path-derived hash) plus hostname/pid for uniqueness.

#### Claim TTL + Heartbeat

Claims have a TTL (default: 5 min). The dispatch poll loop doubles as a heartbeat — each cycle renews claims for active dispatches. If an instance crashes, its claims expire and other instances can pick up the work.

```typescript
// In the dispatch strategy's route(), after spawning:
tracker.track(taskId, spawned.id, attempt);

// In every poll cycle, renew claims for active dispatches:
for (const record of tracker.listActive()) {
  await tasksAdapter.renewClaim(record.taskId, claimantId);
}
```

#### What NOT to Add

- No leader election — dispatchers are peers, not primary/secondary
- No distributed lock service — opentasks daemon's atomic claim is sufficient
- No shared state beyond opentasks — each instance has its own DispatchTracker (in-memory), reconstructed from opentasks on boot

---

### 7. Lifecycle Integration via Existing Signals

**Decision: Use `onLifecycleEvent()` callback + inbox signal filter. No new event surface.**

AgentManagerV2 already emits lifecycle events via `onLifecycleEvent()`:

- `{ type: "spawned", agent }` — on spawn (agent-manager-v2.ts:629)
- `{ type: "started", agent }` — on session start (agent-manager-v2.ts:630)
- `{ type: "stopped", agent, reason }` — on terminate (agent-manager-v2.ts:799)

And agents emit inbox signals via done handlers:

- `WORKER_DONE` — worker completed (handlers-v2.ts:49-80)
- `HELP_NEEDED` — worker blocked
- `WORKER_DEFERRED` — worker deferred

The dispatcher hooks into both:

```typescript
// trigger/dispatch/dispatch-lifecycle.ts

export function createDispatchLifecycleListener(
  tracker: DispatchTracker,
  tasksAdapter: TasksAdapter,
  agentManager: AgentManager,
  inboxAdapter: InboxAdapter,
  claimantId: string
): DispatchLifecycleListener {

  // Hook 1: AgentManager lifecycle callback
  // Catches all terminations (normal, crash, external kill)
  const unsubscribe = agentManager.onLifecycleEvent((event) => {
    if (event.type !== "stopped") return;

    const taskId = tracker.findTaskForAgent(event.agent.id);
    if (!taskId) return; // Not a dispatched agent

    const reason = event.reason;
    if (reason === "done" || reason === "completed") {
      tracker.complete(taskId);
      tasksAdapter.transitionTask(taskId, "complete");
      tasksAdapter.releaseClaim(taskId, claimantId);
    } else {
      tracker.fail(taskId, `agent stopped: ${reason}`);
      if (!tracker.isTracked(taskId)) {
        // Retries exhausted
        tasksAdapter.transitionTask(taskId, "fail");
        tasksAdapter.releaseClaim(taskId, claimantId);
      }
      // If still tracked (retry queued), claim is kept — retry will reuse it
    }
  });

  // Hook 2: Inbox signal filter for richer status
  // Captures HELP_NEEDED, WORKER_DEFERRED for status tracking
  inboxAdapter.addSignalFilter("dispatch-lifecycle", (message) => {
    const signal = message.content?.event;
    if (!signal) return true; // Pass through

    const agentId = message.from;
    const taskId = tracker.findTaskForAgent(agentId);
    if (!taskId) return true; // Not dispatched, pass through

    if (signal === "HELP_NEEDED") {
      tracker.updateStatus(taskId, "blocked");
      // Emit MAP event for observability
    }

    return true; // Always pass through — we're observing, not filtering
  });

  return { unsubscribe };
}
```

**Why not new events?** The lifecycle callback handles the critical path (agent stopped → update tracker). Inbox signals provide richer status (blocked, deferred) but are supplementary. No changes needed to AgentManagerV2 or the handler chain.

**Edge case: agent crash without done().** The `"stopped"` lifecycle event fires on all terminations, including crashes. The stop reason distinguishes normal completion from crashes. If an agent crashes, the dispatcher treats it as a failure and queues retry.

---

### 8. Team-Aware Dispatch

**Decision: Task metadata specifies spawn mode. Dispatcher supports single agent, team template, or custom topology.**

```typescript
export type SpawnMode =
  | { type: "agent"; role?: string }                     // Single agent (default)
  | { type: "team"; template: string; config?: object }  // Full team from openteams
  | { type: "custom"; spawn: (task: TaskRecord, context: RoutingContext) => Promise<string[]> };
```

In opentasks, task metadata carries the spawn hint:

```json
{
  "id": "task-123",
  "title": "Security audit for auth module",
  "metadata": {
    "spawn": {
      "type": "team",
      "template": "security-audit"
    }
  }
}
```

The dispatch strategy checks `task.metadata.spawn` and delegates:

```typescript
// In the dispatch strategy
async function spawnForTask(
  task: TaskRecord,
  attempt: number,
  context: RoutingContext,
  config: DispatchConfig
): Promise<string[]> {
  const spawnMode = task.metadata?.spawn as SpawnMode
    ?? { type: "agent", role: config.defaultRole };

  switch (spawnMode.type) {
    case "agent":
      const spawned = await context.agentManager.spawn({
        task: buildPrompt(task, attempt),
        task_id: task.id,
        role: spawnMode.role ?? config.defaultRole,
        parent: null,
      });
      return [spawned.id];

    case "team":
      // Use TeamManagerV2 to start a team instance for this task
      const team = await teamManager.startTeam(spawnMode.template, {
        taskId: task.id,
        config: spawnMode.config,
      });
      return team.agents.map(a => a.id);

    case "custom":
      return spawnMode.spawn(task, context);
  }
}
```

**Lifecycle for teams:** When a team is dispatched, the tracker records all agent IDs. The team's coordinator handles internal lifecycle. The dispatcher watches for the coordinator's `"stopped"` event as the signal that the team is done.

---

### 9. Configurable Concurrency Scoping

**Decision: Concurrency limits are hierarchical and composable.**

```yaml
dispatch:
  concurrency:
    # Global cap across everything
    global: 10

    # Per-project limits (project = opentasks project context)
    perProject:
      backend-api: 5
      frontend: 3

    # Per-tracker limits
    perTracker:
      linear: 8
      github: 4

    # Per-role limits
    perRole:
      worker: 8
      security-auditor: 2

    # Per-tag limits (useful for resource-bound work)
    perTag:
      gpu: 1
      database-migration: 1
```

Enforcement is **most restrictive wins** — a dispatch only happens if ALL applicable limits have available slots:

```typescript
function hasCapacity(task: TaskRecord, tracker: DispatchTracker, config: ConcurrencyConfig): boolean {
  const checks = [
    tracker.activeCount() < config.global,
    tracker.activeByProject(task.project) < (config.perProject?.[task.project] ?? Infinity),
    tracker.activeByTracker(task.tracker) < (config.perTracker?.[task.tracker] ?? Infinity),
    tracker.activeByRole(task.role) < (config.perRole?.[task.role] ?? Infinity),
    ...task.tags.map(tag =>
      tracker.activeByTag(tag) < (config.perTag?.[tag] ?? Infinity)
    ),
  ];
  return checks.every(Boolean);
}
```

The DispatchTracker is extended with indexed counts:

```typescript
export interface DispatchTracker {
  // ... existing methods ...
  activeByProject(project: string): number;
  activeByTracker(tracker: string): number;
  activeByRole(role: string): number;
  activeByTag(tag: string): number;
}
```

---

### 10. External State Reconciliation

**Decision: Separate reconciliation cron job, following Symphony's approach.**

Symphony handles this in its orchestrator tick loop (orchestrator.ex:275-298):

1. Each tick, fetches current state from Linear for all running issues
2. Compares against configured `active_states` / `terminal_states`
3. If issue moved to terminal state externally → stop agent + cleanup workspace
4. If issue reassigned → stop agent (no cleanup)
5. If issue moved to non-active state (e.g., "blocked") → stop agent (no cleanup)

**Our equivalent:** A second cron job (separate from the dispatch poll) that reconciles external tracker state:

```typescript
// Reconciliation strategy — registered alongside dispatch strategy
export function createReconcileStrategy(
  tasksAdapter: TasksAdapter,
  tracker: DispatchTracker,
  agentManager: AgentManager,
  config: ReconcileConfig
): RoutingStrategy {
  return {
    name: "task-reconcile",
    canHandle: (e) => e.source.type === "cron" && e.source.jobName === "task-reconcile",

    async route(_event, context): Promise<RoutingDecision> {
      const active = tracker.listActive();

      for (const record of active) {
        const task = await tasksAdapter.getTask(record.taskId);

        // Task was closed/completed externally
        if (task.status === "closed") {
          await agentManager.terminate(record.agentId, "external_completion");
          tracker.complete(record.taskId);
          continue;
        }

        // Task was reassigned to someone else
        if (task.assignee && task.assignee !== record.claimantId) {
          await agentManager.terminate(record.agentId, "reassigned");
          tracker.complete(record.taskId); // Don't retry — human took over
          continue;
        }

        // Task moved to blocked state
        if (task.status === "blocked") {
          await agentManager.terminate(record.agentId, "blocked_externally");
          // Don't retry immediately — wait for unblock via normal poll
          tracker.complete(record.taskId);
          continue;
        }

        // Task disappeared (deleted from tracker)
        if (!task) {
          await agentManager.terminate(record.agentId, "task_deleted");
          tracker.complete(record.taskId);
          continue;
        }
      }

      return { targetAgents: [], reason: "reconciliation complete" };
    },
  };
}
```

```yaml
dispatch:
  reconcile:
    enabled: true
    intervalMs: 60000   # Check every 60s (slower than dispatch poll)
```

**Why a separate cron job?** Reconciliation is read-heavy (fetches current state from external tracker per active task) and less time-sensitive than dispatch. Running it at a slower cadence (60s vs 15s) reduces API load on Linear/GitHub/Jira.

**Agent-cooperative check:** In addition to dispatcher-side reconciliation, agents should also check task state between turns (like Symphony's `continue_with_issue?()` check). This can be added as a standard instruction in the prompt pipeline: "Before starting a new turn, verify your task is still active via the `task` tool."

---

## Updated Component Design

### Component 1: DispatchTracker

Extended from original design with multi-dimensional concurrency, claim management, and state reconstruction.

```typescript
// trigger/dispatch/dispatch-tracker.ts

export interface DispatchRecord {
  taskId: string;
  agentIds: string[];           // Multiple for team dispatch
  spawnedAt: number;
  attempt: number;
  status: "running" | "completed" | "failed" | "retrying" | "blocked";
  project?: string;
  tracker?: string;
  role?: string;
  tags?: string[];
  claimantId: string;
  workspacePath?: string;
}

export interface DispatchTracker {
  track(record: Omit<DispatchRecord, "spawnedAt" | "status">): void;
  complete(taskId: string): void;
  fail(taskId: string, error?: string): void;
  updateStatus(taskId: string, status: DispatchRecord["status"]): void;
  getRetryReady(): RetryEntry[];
  isTracked(taskId: string): boolean;
  findTaskForAgent(agentId: string): string | undefined;

  // Concurrency queries
  activeCount(): number;
  activeByProject(project: string): number;
  activeByTracker(tracker: string): number;
  activeByRole(role: string): number;
  activeByTag(tag: string): number;
  availableSlots(config: ConcurrencyConfig, task?: TaskRecord): number;

  // Observability
  listActive(): DispatchRecord[];
  listRetries(): RetryEntry[];

  // Reconstruction
  reconstructFromTasks(tasks: TaskRecord[], claimantId: string): void;
}
```

**Reconstruction on boot:** When the dispatcher starts, it queries opentasks for all tasks claimed by this instance's `claimantId` that are still `in_progress`. These become the initial `active` set. This handles process restarts without losing track of running agents.

### Component 2: TaskDispatch Routing Strategy

Updated to support push/pull/hybrid modes, team dispatch, eligibility checking, and atomic claiming.

```typescript
// trigger/strategies/task-dispatch.ts

export interface TaskDispatchStrategyDeps {
  tasksAdapter: TasksAdapter;
  tracker: DispatchTracker;
  agentManager: AgentManager;
  teamManager?: TeamManagerV2;      // Optional, for team dispatch
  promptPipeline: PromptPipeline;
  eligibility: EligibilityChecker;
}

export interface TaskDispatchStrategyConfig {
  mode: DispatchMode;
  concurrency: ConcurrencyConfig;
  retry: RetryConfig;
  claimantId: string;
  push?: { defaultRole: string; tags?: string[] };
  pull?: PullModeConfig;
  hybrid?: HybridConfig;
}
```

### Component 3: Dispatch Lifecycle Listener

Updated to use `onLifecycleEvent()` + inbox signal filter (see §7 above).

### Component 4: Reconciliation Strategy

New component (see §10 above).

---

## Configuration

Full dispatch config:

```yaml
dispatch:
  enabled: true

  mode: push                     # push | pull | hybrid

  poll:
    intervalMs: 15000            # Dispatch poll cadence

  reconcile:
    enabled: true
    intervalMs: 60000            # External state check cadence

  concurrency:
    global: 10
    perProject: { backend: 5 }
    perTracker: { linear: 8 }
    perRole: { worker: 8 }
    perTag: { gpu: 1 }

  retry:
    maxRetries: 3
    baseDelayMs: 10000
    maxDelayMs: 300000
    workspaceStrategy: reuse     # reuse | fresh | branch
    preserveOnExhaustion: true
    cleanupDelayMs: 300000

  eligibility:
    tags: [auto]
    excludeTags: [manual]
    minPriority: 2
    minScore: 0.3
    requireFields: [description]
    agentTriage:
      enabled: false
      role: triage
      minScoreForTriage: 0.3
      maxScoreForTriage: 0.7

  prompt:
    stages: [task-core, retry-context, role-prompt]
    # Add "playbook" to include cognitive-core context

  push:
    defaultRole: worker

  pull:
    poolSize: 3
    workerRole: worker
    idleTimeoutMs: 300000
    workerLoop: true

  hybrid:
    pushPriorityThreshold: 3
```

---

## What This Reuses (Not New)

| Concern | Existing Component | How Dispatch Uses It |
|---|---|---|
| Scheduling | CronService | `every` jobs for poll + reconcile |
| Routing | TriggerRouter + RoutingStrategy | Two strategies (dispatch + reconcile) |
| Agent spawn | AgentManagerV2.spawn() | Parentless root agents |
| Team spawn | TeamManagerV2.startTeam() | Team-aware dispatch |
| Workspace isolation | WorkspaceManager | createWorkspaceForRole() called by spawn |
| Task state | TasksAdapter + opentasks | Atomic claim, transition, release |
| Lifecycle events | onLifecycleEvent() | Agent stopped → update tracker |
| Inbox signals | addSignalFilter() | WORKER_DONE, HELP_NEEDED observation |
| Event delivery | SystemEventQueue + WakeManager | Cron → event → route → dispatch |

## What This Adds

| File | ~Lines | Purpose |
|---|---|---|
| `trigger/dispatch/dispatch-tracker.ts` | 200 | Multi-dimensional concurrency + retry + reconstruction |
| `trigger/strategies/task-dispatch.ts` | 200 | Routing strategy (push/pull/hybrid + eligibility) |
| `trigger/strategies/task-reconcile.ts` | 80 | External state reconciliation |
| `trigger/dispatch/dispatch-lifecycle.ts` | 80 | Lifecycle + signal listener |
| `trigger/dispatch/eligibility.ts` | 120 | Scoring + filtering + triage |
| `trigger/dispatch/prompt-pipeline.ts` | 100 | Composable prompt assembly |
| `trigger/dispatch/types.ts` | 80 | All dispatch-specific types |
| Boot wiring | 40 | Opt-in init |
| **Total** | **~900** | |

## What Needs to Change in Opentasks

| Change | Scope | Purpose |
|---|---|---|
| Atomic `claim` operation | opentasks daemon | Prevent TOCTOU race in multi-instance |
| Claim TTL + heartbeat renewal | opentasks daemon | Auto-release on instance crash |
| `TaskContext` extension | opentasks schema | Richer task metadata for prompts |
| `releaseClaim` operation | opentasks daemon | Explicit claim release on completion |

## Comparison to Symphony

| Feature | Symphony | This Design |
|---|---|---|
| Polling | GenServer tick | CronService `every` job |
| Dispatch | Orchestrator.dispatch | TaskDispatch routing strategy |
| Workspace isolation | Per-issue directory + git clone | WorkspaceManager worktrees |
| Retry | In-orchestrator backoff queue | DispatchTracker retry map |
| Concurrency | max_concurrent_agents | Multi-dimensional (global/project/tracker/role/tag) |
| Agent hierarchy | None (flat) | None (parentless root agents) |
| Reconciliation | In tick loop, checks Linear | Separate reconcile cron, checks opentasks |
| Multi-instance | Disjoint issue sets via Linear assignee | Atomic claims + TTL in opentasks |
| Agent runtime | Codex only | Any AgentFactory (Claude Code, Codex, etc.) |
| Configuration | WORKFLOW.md (single file) | macro-agent config (composable) |
| Observability | Phoenix LiveView dashboard | MAP protocol events |
| Task source | Linear only | Any tracker via opentasks federation |
| Memory/learning | None | cognitive-core + minimem (opt-in) |
| Team dispatch | No | Yes (openteams templates) |
| Push/pull | Push only | Push, pull, or hybrid |
| Task eligibility | None (all active issues) | Configurable filters + scoring + AI triage |
