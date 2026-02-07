## Context

macro-agent currently provides a structured, correctness-oriented multi-agent orchestration system with four built-in roles (Worker, Integrator, Coordinator, Monitor), workspace isolation via git worktrees, a serialized merge queue, and push-based task assignment.

Cursor's ["Towards Self-Driving Codebases"](https://cursor.com/blog/self-driving-codebases) demonstrates a different paradigm: hundreds of agents running autonomously for weeks, committing directly to trunk, tolerating transient errors, and self-converging without centralized integration gates. Their system uses Planners (continuous exploration + task creation), Workers (pull tasks, grind, push), and Judges (periodic quality evaluation).

The goal of this change is to enable macro-agent to support **both** paradigms — the existing structured mode and a self-driving mode — through a modular team template layer and a set of new primitives. macro-agent's core remains role-agnostic; the self-driving patterns are expressed as a loadable team configuration on top.

### Stakeholders

- macro-agent users who want structured, correctness-oriented workflows (existing)
- Users who want high-throughput autonomous operation (new)
- Users who want custom team structures for specific domains (new)

## Goals / Non-Goals

### Goals

1. **Team Templates**: A modular system for loading pre-configured agent team structures that define roles, spawn patterns, integration strategies, and coordination protocols — without modifying macro-agent core.
2. **Task Pull Model**: Primitives for agents to discover and claim available tasks, enabling decoupled planning/execution and elastic scaling.
3. **Configurable Integration Strategies**: Allow teams to choose between merge-queue (current), trunk-based (direct push), or optimistic (push-then-validate) integration.
4. **Session Continuations**: Persist agent session history so long-running agents can be resumed across process restarts, enabling multi-day autonomous operation.
5. **Autonomous Observability**: Metrics primitives for monitoring throughput, error rates, and convergence during long-running multi-agent runs.

### Non-Goals

- Rewriting the existing role system — team templates compose on top of it
- Building a full dashboard UI — only the data/API layer
- Implementing specific team templates beyond one reference "self-driving" template
- Changing the ACP/process model — session continuations are about history, not in-process agent lifecycle
- Horizontal scaling across machines — single-machine focus for now

## Decisions

### D1: Team Templates as Configuration, Not Code

**Decision**: Team templates are directories of YAML configuration files that compose roles, define spawn graphs, set integration strategies, and configure coordination protocols. They are loaded by the existing `RoleRegistry` layered config system and a new `TeamLoader`.

**Alternatives considered**:
- **Programmatic API**: Define teams in TypeScript. More flexible but requires code changes for each team shape. Rejected — config is more accessible and shareable.
- **Single monolithic config**: One file per team. Rejected — doesn't compose well with the existing layered role override system.

**Rationale**: The existing `.macro-agent/roles/*.yaml` pattern already supports custom roles with inheritance. Team templates extend this with a `team.yaml` manifest that declares which roles participate, how they're spawned, and what strategies they use. This means the same role definitions work in both structured and self-driving modes — only the orchestration layer differs.

### D2: Task Pull via `claim_task` with Optimistic Locking

**Decision**: Add a `claim_task` MCP tool and corresponding `TaskBackend.claim()` method. Workers call `claim_task` with optional filters (status, tags, role). The backend atomically transitions the task from `pending`/`ready` to `assigned` using optimistic locking (compare-and-swap on version/status). If the claim fails (another worker got it), the worker retries or picks a different task.

**Alternatives considered**:
- **Central dispatcher**: A coordinator assigns tasks to workers. This is the current push model — works but creates a bottleneck at scale.
- **Message-based bidding**: Workers bid on tasks via messages, coordinator selects winner. Too much round-trip overhead for high-throughput scenarios.

**Rationale**: Pull-based with optimistic locking is the simplest model that scales. No coordinator bottleneck, no bidding overhead. Workers are autonomous — they claim, execute, and report. The task backend is the only coordination point, and SQLite handles contention well for single-machine deployments.

### D3: Integration Strategy as a Team-Level Configuration

**Decision**: Integration strategy is declared in the team template and enforced by the workspace manager. Three strategies:

| Strategy | Behavior | Trade-off |
|----------|----------|-----------|
| `queue` | Current merge queue. Workers commit to branches, integrator merges serially. | Safe, slow at scale |
| `trunk` | Workers commit and push directly to integration branch. Rebase on conflict, retry up to N times. | Fast, tolerates transient breakage |
| `optimistic` | Workers push to trunk immediately. A background validator checks CI; failures auto-create fixup tasks. | Fastest, requires error tolerance |

**Alternatives considered**:
- **Per-agent strategy**: Each worker chooses its integration approach. Rejected — this creates unpredictable behavior and merge chaos.
- **Hardcoded trunk-only**: Remove merge queue entirely. Rejected — existing users depend on the queue for correctness.

**Rationale**: Team-level configuration is the right granularity. All workers in a team use the same strategy, which makes the system's behavior predictable. The `queue` strategy preserves full backward compatibility. The `trunk` and `optimistic` strategies unlock the self-driving mode.

### D4: Session Continuations via Persisted Conversation History

**Decision**: Agent session history (the conversation transcript with the LLM) is persisted to the EventStore. When an agent needs to resume (after a crash, timeout, or deliberate pause), a new process is spawned with the prior conversation loaded as context. The agent receives a resume prompt explaining it's continuing a previous session.

This is explicitly NOT about keeping a process alive forever. Long-running operation means: work → pause → resume → work → pause → resume, potentially across days.

**Alternatives considered**:
- **Keep processes alive**: Run agent processes indefinitely. Rejected — processes crash, machines restart, and context windows fill up. Resumption is more robust than persistence.
- **Checkpoint-based**: Save structured state (current task, progress, decisions). Rejected — too lossy. The conversation transcript IS the state; structured checkpoints can't capture the nuance of in-flight reasoning.

**Rationale**: The user specifically noted that long-running agents are about continuing session history, not keeping processes alive. This aligns with how Claude Code already works — sessions can be resumed. We just need to persist the transcript and provide a clean resume mechanism at the macro-agent level.

### D5: Observability as EventStore Materialized Views

**Decision**: Add new materialized views to the EventStore for autonomous operation metrics:
- **Throughput view**: commits/hour, tasks completed/hour, tasks created/hour (sliding window)
- **Health view**: build pass rate, error rate, agent utilization (active/idle/blocked)
- **Convergence view**: time-to-fix after breakage, conflict frequency

These are computed from existing events (spawn, terminate, task status changes, merge events). No new event types needed — just new projections over existing data.

**Alternatives considered**:
- **External metrics system**: Export to Prometheus/Grafana. Rejected for now — adds infrastructure dependency. Can be added later as an adapter.
- **Per-query computation**: Calculate metrics on demand from raw events. Rejected — too slow for dashboards with thousands of events.

**Rationale**: The EventStore already supports materialized views (agent view, task view, message queue). Adding metric views follows the same pattern. The API server can expose these via new endpoints, and a future dashboard can consume them.

## Architecture: Team Template System

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
│  - Configures WorkspaceManager integration strategy         │
│  - Sets up task backend with pull/push mode                 │
│  - Initializes observability views                          │
│  - Provides team-aware system prompt context                │
└───────────────────────────┬─────────────────────────────────┘
                            │
        ┌───────────────────┼───────────────────┐
        ▼                   ▼                   ▼
  RoleRegistry      WorkspaceManager      TaskBackend
  (roles added)     (strategy set)        (claim enabled)
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
  # The initial agent spawned when the team starts
  root:
    role: planner
    config:
      model: sonnet
    prompt: "prompts/planner.md"
  # Agents spawned automatically alongside root
  companions:
    - role: judge
      config:
        model: haiku

# Integration strategy for this team
integration:
  strategy: trunk           # queue | trunk | optimistic
  trunk:
    maxRetries: 3            # Rebase retry count
    conflictAction: abandon  # abandon | resolve
  # Only for 'optimistic':
  # optimistic:
  #   validator: ci          # What validates pushes
  #   fixupTaskTag: fixup    # Tag for auto-created fixup tasks

# Task configuration
tasks:
  mode: pull                 # push | pull
  pull:
    idleTimeout: 300         # Seconds before idle worker self-terminates
    claimFilters:            # Default filters for task claims
      status: [pending]
    maxConcurrentPerAgent: 1

# Observability
observability:
  metricsWindow: 3600       # Sliding window in seconds
  snapshotInterval: 300     # How often to snapshot metrics
```

## Data Flow: Self-Driving Mode

```
1. Team boots → Planner + Judge spawned
2. Planner explores codebase → creates tasks in TaskBackend
3. Planner spawns N workers (or pool auto-scales)
4. Workers claim tasks (pull model):
   claim_task() → work → commit → push to trunk → done() → claim_task()
5. On conflict: rebase + retry (trunk strategy)
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

## Risks / Trade-offs

| Risk | Impact | Mitigation |
|------|--------|------------|
| Trunk-based integration can break the build | Workers see broken state, waste tokens | Judge creates fixup tasks quickly; `optimistic` strategy adds async validation |
| Task claim contention under high concurrency | Workers waste cycles on failed claims | Randomized backoff; claim with multiple candidates (claim any of N) |
| Session continuations bloat EventStore | Large conversation transcripts stored | Compress transcripts; configurable retention policy; prune old sessions |
| Team templates add configuration complexity | Users confused by two config systems | Clear docs; templates are optional; existing `.macro-agent/roles/` still works standalone |
| Backward compatibility with existing teams | Existing coordinator/integrator/worker flows break | `queue` strategy is the default; team templates are additive, not replacing |

## Migration Plan

No migration needed. This is purely additive:
- Existing systems continue to work unchanged (default strategy remains `queue`, default task mode remains `push`)
- Team templates are opt-in via `macro-agent start --team self-driving` or config
- New MCP tools (`claim_task`, etc.) are only exposed when team config enables them
- Session continuations are available to all agents regardless of team

## Relationship to Existing Specs

| Existing Spec | Relationship |
|---|---|
| `agent-manager` | MODIFIED: spawn accepts team context; resume support for session continuations |
| `task-manager` | MODIFIED: new `claim()` method; `ready` status for claimable tasks |
| `mcp-tools` | MODIFIED: new `claim_task` tool; new `resume_session` tool |
| `event-store` | MODIFIED: new views for metrics; session transcript storage |
| `message-router` | Unchanged — existing routing sufficient |
| `cli-api` | MODIFIED: new endpoints for metrics; `--team` flag on start command |

## Open Questions

1. **Should team templates be shareable packages?** (e.g., `npm install @macro-agent/team-self-driving`) — Deferred to future work. Start with local directory convention.
2. **Should the Judge role have write access to create a "green" branch?** — Yes, but only `git.branch.create` + `git.push` on a specific release branch, not arbitrary write access.
3. **How much session history should be loaded on resume?** — Start with last N messages (configurable), with option to load full transcript. Context window limits are the practical constraint.
4. **Should workers in pull mode be able to reject a claimed task?** — Yes, via `unclaim_task` which returns it to `pending`. This handles cases where the worker realizes the task is blocked or out of scope.
