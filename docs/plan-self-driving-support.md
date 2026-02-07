# Self-Driving Codebases Support

Plan for enabling macro-agent to support Cursor-style autonomous multi-agent workflows through a modular team template layer and a set of new primitives.

## Context

macro-agent currently provides a structured, correctness-oriented multi-agent orchestration system with four built-in roles (Worker, Integrator, Coordinator, Monitor), workspace isolation via git worktrees, a serialized merge queue, and push-based task assignment.

Cursor's ["Towards Self-Driving Codebases"](https://cursor.com/blog/self-driving-codebases) demonstrates a different paradigm: hundreds of agents running autonomously for weeks, committing directly to trunk, tolerating transient errors, and self-converging without centralized integration gates. Their system uses Planners (continuous exploration + task creation), Workers (pull tasks, grind, push), and Judges (periodic quality evaluation).

The goal is to enable macro-agent to support **both** paradigms — the existing structured mode and a self-driving mode — through a modular team template layer and a set of new primitives. macro-agent's core remains role-agnostic; the self-driving patterns are expressed as a loadable team configuration on top.

## Goals

1. **Team Templates**: A modular system for loading pre-configured agent team structures that define roles, spawn patterns, integration strategies, and coordination protocols — without modifying macro-agent core.
2. **Task Pull Model**: Primitives for agents to discover and claim available tasks, enabling decoupled planning/execution and elastic scaling.
3. **Pluggable Integration Strategies**: A strategy interface that the worker done() handler dispatches to, with built-in implementations for merge-queue, trunk-based, and optimistic integration — and the ability to register custom strategies.
4. **Session Continuations**: Persist agent session history so long-running agents can be resumed across process restarts, enabling multi-day autonomous operation.
5. **Autonomous Observability**: Metrics primitives for monitoring throughput, error rates, and convergence during long-running multi-agent runs.

## Non-Goals

- Rewriting the existing role system — team templates compose on top of it
- Building a full dashboard UI — only the data/API layer
- Implementing specific team templates beyond one reference "self-driving" template
- Changing the ACP/process model — session continuations are about history, not in-process agent lifecycle
- Horizontal scaling across machines — single-machine focus for now

---

## Design Decisions

### D1: Team Templates as Configuration, Not Code

Team templates are directories of YAML configuration files that compose roles, define spawn graphs, set integration strategies, and configure coordination protocols. They are loaded by the existing `RoleRegistry` layered config system and a new `TeamLoader`.

**Alternatives considered**:
- **Programmatic API**: Define teams in TypeScript. More flexible but requires code changes for each team shape. Rejected — config is more accessible and shareable.
- **Single monolithic config**: One file per team. Rejected — doesn't compose well with the existing layered role override system.

**Rationale**: The existing `.macro-agent/roles/*.yaml` pattern already supports custom roles with inheritance. Team templates extend this with a `team.yaml` manifest that declares which roles participate, how they're spawned, and what strategies they use. The same role definitions work in both structured and self-driving modes — only the orchestration layer differs.

### D2: Task Pull via `claim_task` with Optimistic Locking

Add a `claim_task` MCP tool and corresponding `TaskBackend.claim()` method. Workers call `claim_task` with optional filters (status, tags, role). The backend atomically transitions the task from `pending`/`ready` to `assigned` using optimistic locking (compare-and-swap on version/status). If the claim fails (another worker got it), the worker retries or picks a different task.

**Alternatives considered**:
- **Central dispatcher**: A coordinator assigns tasks to workers. This is the current push model — works but creates a bottleneck at scale.
- **Message-based bidding**: Workers bid on tasks via messages, coordinator selects winner. Too much round-trip overhead for high-throughput scenarios.

**Rationale**: Pull-based with optimistic locking is the simplest model that scales. No coordinator bottleneck, no bidding overhead. Workers are autonomous — they claim, execute, and report. The task backend is the only coordination point, and SQLite handles contention well for single-machine deployments.

### D3: Integration Strategy as a Pluggable Interface

Integration is handled through an `IntegrationStrategy` interface that the worker `done()` handler dispatches to. The interface has a single responsibility: take a worker's completed work and land it on the integration branch.

```typescript
/**
 * Pluggable integration strategy interface.
 *
 * Implementations control how worker changes are landed onto
 * the integration branch. The worker done() handler dispatches
 * to the active strategy instead of hardcoding merge queue logic.
 */
interface IntegrationStrategy {
  /** Unique identifier for this strategy */
  readonly name: string;

  /**
   * Land a worker's completed changes onto the integration branch.
   *
   * @returns Result indicating success, conflict, or abandonment
   */
  land(request: LandRequest): Promise<LandResult>;

  /**
   * Called when the strategy is initialized for a stream.
   * Opportunity to set up any backing resources (queues, branches, etc).
   */
  initialize?(streamId: string, config: Record<string, unknown>): Promise<void>;

  /**
   * Called when the strategy is torn down.
   */
  close?(): Promise<void>;
}

interface LandRequest {
  /** Stream (integration branch) this targets */
  streamId: string;
  /** Worker's branch containing changes */
  workerBranch: string;
  /** Target integration branch */
  integrationBranch: string;
  /** ID of the worker agent */
  workerAgentId: string;
  /** Task ID this completes */
  taskId: string;
  /** Workspace path for git operations */
  workspacePath: string;
  /** Strategy-specific options from team config */
  options?: Record<string, unknown>;
}

type LandResult =
  | { status: 'landed'; mergeCommit: string }
  | { status: 'conflict'; conflictFiles: string[]; action: 'abandoned' | 'queued_for_resolution' }
  | { status: 'retry_exhausted'; attempts: number }
  | { status: 'failed'; error: string };
```

Three built-in implementations, plus support for custom strategies:

| Strategy | Class | Behavior |
|----------|-------|----------|
| `queue` | `QueueIntegrationStrategy` | Wraps existing `MergeQueueInterface`. Submits merge request to queue; integrator processes serially. Current behavior, no changes. |
| `trunk` | `TrunkIntegrationStrategy` | Direct push to integration branch. On conflict: rebase and retry up to `maxRetries` times. On exhaustion: `conflictAction` determines abandon vs. resolve. |
| `optimistic` | `OptimisticIntegrationStrategy` | Push immediately. Emit `validation:requested` event. Background validator checks CI; creates fixup tasks on failure; snapshots green branch on success. |
| custom | User-provided | Register via `IntegrationStrategyRegistry.register(name, factory)`. Factory receives config from `team.yaml`. |

**Alternatives considered**:
- **Per-agent strategy**: Each worker chooses its integration approach. Rejected — creates unpredictable behavior and merge chaos.
- **Hardcoded strategy selection via switch/case**: Simpler but not extensible. Rejected — users need to implement custom strategies for their specific CI/CD pipelines.
- **Hardcoded trunk-only**: Remove merge queue entirely. Rejected — existing users depend on the queue for correctness.

**Rationale**: A pluggable interface makes integration strategies a first-class extension point. The `queue` strategy wraps existing behavior with zero changes. The worker `done()` handler becomes simpler — it delegates to `strategy.land()` instead of containing merge queue logic directly. Custom strategies can implement organization-specific workflows (e.g., PR-based integration, CI-gated merge, staging branch promotion).

**Integration with worker done() handler**: Today, the worker handler in `src/lifecycle/handlers/worker.ts` directly submits to the merge queue (Step 4, lines ~229-387). This gets replaced with:

```typescript
// Step 4: Land changes via integration strategy
if (args.status === 'completed' && context.workspacePath) {
  const strategy = deps.integrationStrategy; // injected via WorkerHandlerDeps
  const result = await strategy.land({
    streamId: context.streamId,
    workerBranch: sourceBranch,
    integrationBranch: targetBranch,
    workerAgentId: context.agentId,
    taskId: context.taskId,
    workspacePath: context.workspacePath,
  });
  // Handle result...
}
```

### D4: Session Continuations via Persisted Conversation History

Agent session history (the conversation transcript with the LLM) is persisted to the EventStore. When an agent needs to resume (after a crash, timeout, or deliberate pause), a new process is spawned with the prior conversation loaded as context. The agent receives a resume prompt explaining it's continuing a previous session.

This is explicitly NOT about keeping a process alive forever. Long-running operation means: work -> pause -> resume -> work -> pause -> resume, potentially across days.

**Alternatives considered**:
- **Keep processes alive**: Run agent processes indefinitely. Rejected — processes crash, machines restart, and context windows fill up. Resumption is more robust than persistence.
- **Checkpoint-based**: Save structured state (current task, progress, decisions). Rejected — too lossy. The conversation transcript IS the state; structured checkpoints can't capture the nuance of in-flight reasoning.

**Rationale**: Long-running agents are about continuing session history, not keeping processes alive. This aligns with how Claude Code already works — sessions can be resumed. We just need to persist the transcript and provide a clean resume mechanism at the macro-agent level.

### D5: Observability as EventStore Materialized Views

Add new materialized views to the EventStore for autonomous operation metrics:
- **Throughput view**: commits/hour, tasks completed/hour, tasks created/hour (sliding window)
- **Health view**: build pass rate, error rate, agent utilization (active/idle/blocked)
- **Convergence view**: time-to-fix after breakage, conflict frequency

These are computed from existing events (spawn, terminate, task status changes, merge events). No new event types needed — just new projections over existing data.

**Alternatives considered**:
- **External metrics system**: Export to Prometheus/Grafana. Rejected for now — adds infrastructure dependency. Can be added later as an adapter.
- **Per-query computation**: Calculate metrics on demand from raw events. Rejected — too slow for dashboards with thousands of events.

**Rationale**: The EventStore already supports materialized views (agent view, task view, message queue). Adding metric views follows the same pattern. The API server can expose these via new endpoints, and a future dashboard can consume them.

---

## Architecture

### Team Template System

```
┌─────────────────────────────────────────────────────────────┐
│                    Team Template                             │
│  .macro-agent/teams/self-driving/                           │
│  ├── team.yaml          # Manifest: roles, strategy, config │
│  ├── roles/             # Role overrides/extensions         │
│  │   ├── planner.yaml   # extends: coordinator              │
│  │   ├── grinder.yaml   # extends: worker                   │
│  │   └── judge.yaml     # extends: monitor                  │
│  └── prompts/           # Custom prompt templates           │
│      ├── planner.md                                         │
│      └── judge.md                                           │
└───────────────────────────┬─────────────────────────────────┘
                            │ TeamLoader.load()
┌───────────────────────────▼─────────────────────────────────┐
│                    Team Runtime                              │
│  - Registers roles into RoleRegistry                        │
│  - Selects IntegrationStrategy from registry                │
│  - Sets up task backend with pull/push mode                 │
│  - Initializes observability views                          │
│  - Provides team-aware system prompt context                │
└───────────────────────────┬─────────────────────────────────┘
                            │
        ┌───────────────────┼───────────────────┐
        ▼                   ▼                   ▼
  RoleRegistry     IntegrationStrategy     TaskBackend
  (roles added)    Registry (strategy)     (claim enabled)
```

### Team Manifest Schema (team.yaml)

```yaml
name: self-driving
description: "Cursor-style autonomous codebase development"
version: 1

# Roles this team uses (references files in roles/ or built-ins)
roles:
  - planner       # Custom role extending coordinator
  - grinder       # Custom role extending worker
  - judge         # Custom role extending monitor

# How the team bootstraps
bootstrap:
  root:
    role: planner
    config:
      model: sonnet
    prompt: "prompts/planner.md"
  companions:
    - role: judge
      config:
        model: haiku

# Integration strategy for this team
integration:
  strategy: trunk           # queue | trunk | optimistic | <custom-name>
  config:                   # Passed to strategy.initialize()
    maxRetries: 3
    conflictAction: abandon

# Task configuration
tasks:
  mode: pull                 # push | pull
  pull:
    idleTimeout: 300
    claimFilters:
      status: [pending]
    maxConcurrentPerAgent: 1

# Observability
observability:
  metricsWindow: 3600
  snapshotInterval: 300
```

### Integration Strategy Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                  Worker done() Handler                       │
│  (src/lifecycle/handlers/worker.ts)                         │
│                                                             │
│  Step 4: Land changes                                       │
│  strategy.land(request) ──────────────────┐                 │
└───────────────────────────────────────────┤                 │
                                            ▼                 │
┌─────────────────────────────────────────────────────────────┐
│             IntegrationStrategyRegistry                      │
│  .get(name) → IntegrationStrategy                           │
│  .register(name, factory) → void                            │
│                                                             │
│  Built-in:                                                  │
│  ┌──────────────┬──────────────┬────────────────┐           │
│  │    queue     │    trunk     │   optimistic   │           │
│  │              │              │                │           │
│  │ Wraps        │ Direct push  │ Push + async   │           │
│  │ MergeQueue   │ + rebase     │ validation     │           │
│  │ Interface    │ + retry      │ + fixup tasks  │           │
│  └──────────────┴──────────────┴────────────────┘           │
│                                                             │
│  Custom:                                                    │
│  ┌────────────────────────────────┐                         │
│  │  pr-based, staging-promote,   │                         │
│  │  ci-gated, ...                │                         │
│  └────────────────────────────────┘                         │
└─────────────────────────────────────────────────────────────┘
```

### Data Flow: Self-Driving Mode

```
1. Team boots → Planner + Judge spawned
2. Planner explores codebase → creates tasks in TaskBackend
3. Planner spawns N workers (or pool auto-scales)
4. Workers claim tasks (pull model):
   claim_task() → work → commit → strategy.land() → done() → claim_task()
5. On conflict: strategy-specific handling (rebase+retry for trunk, fixup task for optimistic)
6. On failure: task marked failed, re-enters pool for retry
7. Judge runs periodically:
   - Checks build/test status
   - Creates fixup tasks for failures
   - Snapshots "green" state to release branch
8. Planner monitors progress:
   - Creates new tasks as areas are completed
   - Adjusts priorities based on convergence
   - Spawns/terminates workers based on queue depth
```

---

## Affected Code

| Area | Files | Change Type |
|------|-------|-------------|
| Team system | `src/teams/` (new module) | New: types, loader, runtime |
| Integration strategies | `src/workspace/strategies/` (new) | New: interface, registry, 3 implementations |
| Task pull | `src/task/backend/types.ts`, `memory.ts` | Modified: claim(), unclaim(), tags |
| MCP tools | `src/mcp/tools/` (3 new tools) | New: claim_task, unclaim_task, list_claimable_tasks |
| Worker lifecycle | `src/lifecycle/handlers/worker.ts` | Modified: dispatch to strategy instead of direct merge queue |
| Agent manager | `src/agent/agent-manager.ts` | Modified: team context propagation, resume() |
| System prompts | `src/agent/system-prompt.ts` | Modified: team-aware prompt generation |
| EventStore | `src/store/` | Modified: session history, metric views |
| CLI | `src/cli/index.ts` | Modified: --team flag |
| API | `src/api/server.ts` | Modified: metrics + team status endpoints |
| Capabilities | `src/roles/capabilities.ts` | Modified: task.claim capability |

---

## Risks / Trade-offs

| Risk | Impact | Mitigation |
|------|--------|------------|
| Trunk-based integration can break the build | Workers see broken state, waste tokens | Judge creates fixup tasks quickly; optimistic strategy adds async validation |
| Task claim contention under high concurrency | Workers waste cycles on failed claims | Randomized backoff; claim with multiple candidates |
| Session continuations bloat EventStore | Large conversation transcripts stored | Compress transcripts; configurable retention policy |
| Team templates add configuration complexity | Users confused by two config systems | Clear docs; templates are optional; existing roles still work standalone |
| Backward compatibility | Existing coordinator/integrator/worker flows break | `queue` strategy is the default; team templates are additive |
| Custom integration strategies with bugs | Broken landing corrupts integration branch | Strategy receives a sandboxed workspace; failures are recoverable |

## Open Questions

1. **Should team templates be shareable packages?** (e.g., `npm install @macro-agent/team-self-driving`) — Deferred to future work. Start with local directory convention.
2. **Should the Judge role have write access to create a "green" branch?** — Yes, but only `git.branch.create` + `git.push` on a specific release branch, not arbitrary write access.
3. **How much session history should be loaded on resume?** — Start with last N messages (configurable), with option to load full transcript. Context window limits are the practical constraint.
4. **Should workers in pull mode be able to reject a claimed task?** — Yes, via `unclaim_task` which returns it to `pending`.

---

## Implementation Phases

### Phase 1: Team Template System (Foundation)

Everything else builds on this. Delivers the modular team loading layer.

- [ ] 1.1 Define `TeamManifest` TypeScript types in `src/teams/types.ts` — covers team.yaml schema: name, description, version, roles, bootstrap, integration, tasks, observability sections
- [ ] 1.2 Implement `TeamLoader` in `src/teams/team-loader.ts` — reads `.macro-agent/teams/<name>/` directory, parses `team.yaml`, validates schema, reads role YAML files, reads prompt template files
- [ ] 1.3 Implement `TeamRuntime` in `src/teams/team-runtime.ts` — takes a parsed `TeamManifest` and wires it into the system: registers roles into RoleRegistry, selects integration strategy, sets TaskBackend mode, stores active team state
- [ ] 1.4 Add team context to `AgentManager.spawn()` — propagate `MACRO_TEAM_NAME`, `MACRO_INTEGRATION_STRATEGY`, `MACRO_TASK_MODE` environment variables; include team section in system prompt generation
- [ ] 1.5 Add `--team <name>` flag to CLI start command — loads team via TeamLoader, initializes TeamRuntime, then proceeds with existing boot flow
- [ ] 1.6 Implement team bootstrap — after TeamRuntime initializes, spawn root agent and companion agents per manifest `bootstrap` section
- [ ] 1.7 Add `GET /api/team` endpoint — returns active team config or `{ active: false }`
- [ ] 1.8 Write unit tests for TeamLoader (manifest parsing, validation, defaults) and TeamRuntime (role registration, config propagation)
- [ ] 1.9 Write integration test: load a test team template, verify roles registered, agents spawned with correct env vars and prompts
- [ ] 1.10 Create reference team template `.macro-agent/teams/self-driving/` with team.yaml, planner/grinder/judge role definitions, and prompt templates

### Phase 2: Pluggable Integration Strategies (can parallelize with Phase 3)

Depends on: Phase 1 (team template sets `integration.strategy`)

- [ ] 2.1 Define `IntegrationStrategy` interface and `LandRequest`/`LandResult` types in `src/workspace/strategies/types.ts`
- [ ] 2.2 Implement `IntegrationStrategyRegistry` in `src/workspace/strategies/registry.ts` — register/get strategies by name, factory pattern accepting config from team.yaml
- [ ] 2.3 Implement `QueueIntegrationStrategy` in `src/workspace/strategies/queue.ts` — wraps existing `MergeQueueInterface`, same behavior as current worker done() handler Step 4
- [ ] 2.4 Implement `TrunkIntegrationStrategy` in `src/workspace/strategies/trunk.ts` — commit, push to integration branch, rebase-and-retry on conflict, max retries, configurable conflict action (abandon/resolve)
- [ ] 2.5 Implement `OptimisticIntegrationStrategy` in `src/workspace/strategies/optimistic.ts` — push immediately, emit validation request event, background validator logic
- [ ] 2.6 Refactor worker `done()` handler to dispatch to `IntegrationStrategy.land()` instead of directly using merge queue — add `integrationStrategy` to `WorkerHandlerDeps`
- [ ] 2.7 Wire strategy selection into `TeamRuntime` — look up strategy by name from registry, initialize with stream config
- [ ] 2.8 Register built-in strategies in module init — queue, trunk, optimistic available by default
- [ ] 2.9 Ensure `queue` strategy is backward-compatible default — verify all existing merge queue tests pass unchanged
- [ ] 2.10 Write unit tests for each strategy (queue passthrough, trunk push/rebase/retry/exhaust, optimistic push/validate/fixup)
- [ ] 2.11 Write integration test: run workers with each strategy, verify correct landing behavior

### Phase 3: Task Pull Model (can parallelize with Phase 2)

Depends on: Phase 1 (team template sets `tasks.mode: pull`)

- [ ] 3.1 Add `tags` field to task types in `src/task/backend/types.ts` and `src/store/types/tasks.ts`
- [ ] 3.2 Implement `claim(agentId, filters?)` on `TaskBackend` interface — atomic find-and-assign with optimistic locking
- [ ] 3.3 Implement `claim()` in `InMemoryTaskBackend` — scan pending tasks matching filters, CAS on status
- [ ] 3.4 Implement `unclaim(agentId, taskId, reason?)` on `TaskBackend` interface and `InMemoryTaskBackend`
- [ ] 3.5 Add `task.claim` capability to `src/roles/capabilities.ts` capability-tool map
- [ ] 3.6 Implement `claim_task` MCP tool in `src/mcp/tools/claim_task.ts` — schema, handler calling TaskBackend.claim(), response formatting
- [ ] 3.7 Implement `unclaim_task` MCP tool in `src/mcp/tools/unclaim_task.ts`
- [ ] 3.8 Implement `list_claimable_tasks` MCP tool in `src/mcp/tools/list_claimable_tasks.ts`
- [ ] 3.9 Register new tools in `src/mcp/mcp-server.ts` with `task.claim` capability gating
- [ ] 3.10 Modify worker `done()` handler — when task mode is `pull` and status is `completed`, do NOT set `shouldTerminate: true`; allow the worker to continue its claim loop
- [ ] 3.11 Add idle timeout logic — worker tracks last successful claim time; if idle timeout exceeded, self-terminate with `done({ status: "completed", summary: "idle exit" })`
- [ ] 3.12 Write unit tests for claim/unclaim (including contention), MCP tools, and pull-mode done handler
- [ ] 3.13 Write integration test: spawn workers in pull mode, create tasks, verify workers claim and complete them, verify idle timeout termination

### Phase 4: Session Continuations

Depends on: Phase 1 (team template configures `lifecycle.continuation`)

- [ ] 4.1 Define session history event type in `src/store/types/events.ts` — `session_history` event with transcript, message count, token estimate
- [ ] 4.2 Implement session history storage in EventStore — `storeSessionHistory(agentId, transcript)` and `getSessionHistory(agentId, options?)`
- [ ] 4.3 Add session history persistence to agent termination flow in `AgentManager.terminate()` — when `lifecycle.continuation` is enabled for the role, persist the transcript
- [ ] 4.4 Add periodic checkpoint persistence — after each agent tool-call round-trip, persist incremental session state (if continuation enabled)
- [ ] 4.5 Implement `AgentManager.resume(agentId, options?)` — load session history, apply context window limits, generate resume prompt, spawn new agent process with history as initial context
- [ ] 4.6 Add `lifecycle.continuation` to `RoleDefinition` type and capability checks
- [ ] 4.7 Add `continuations` section to team manifest schema and TeamRuntime propagation
- [ ] 4.8 Write unit tests for session storage/retrieval, context window limiting, resume prompt generation
- [ ] 4.9 Write integration test: spawn agent, terminate, resume, verify context continuity

### Phase 5: Autonomous Observability

Depends on: Phase 1 (team template configures `observability`), partially Phases 2+3 (task/commit metrics)

- [ ] 5.1 Define metric event types in `src/store/types/events.ts` — `metric.task_completed`, `metric.commit_pushed`, `metric.conflict_detected`
- [ ] 5.2 Emit metric events from done() handlers, integration strategies, and conflict detection paths
- [ ] 5.3 Implement throughput materialized view in EventStore — sliding window computation over task and commit metric events
- [ ] 5.4 Implement utilization materialized view in EventStore — derived from agent state transitions (spawn, claim, done, terminate)
- [ ] 5.5 Implement error rate materialized view in EventStore — derived from task.failed and conflict events
- [ ] 5.6 Add `GET /api/metrics/throughput`, `GET /api/metrics/utilization`, `GET /api/metrics/errors` endpoints to API server
- [ ] 5.7 Write unit tests for each materialized view (window computation, edge cases)
- [ ] 5.8 Write integration test: run a multi-agent session, query metrics endpoints, verify counts match actual activity

### Phase 6: Reference Templates and Documentation

Depends on: All previous phases

- [ ] 6.1 Finalize the `self-driving` reference team template with tested role definitions and prompts
- [ ] 6.2 Create a `structured` reference template codifying the existing coordinator/integrator/worker pattern as a team template
- [ ] 6.3 Add team template documentation to `docs/teams.md` — schema reference, custom strategy guide, how to create custom templates, examples
- [ ] 6.4 Run end-to-end test with self-driving template: planner creates tasks, workers claim and execute, judge monitors quality, trunk integration, metrics reporting
