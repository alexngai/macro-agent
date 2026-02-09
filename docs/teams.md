# Team Templates

Team templates define reusable multi-agent configurations that can be loaded and bootstrapped by the TeamRuntime. Templates live in `.macro-agent/teams/<name>/` directories.

## Directory Structure

```
.macro-agent/teams/<name>/
├── team.yaml              # Main manifest (required)
├── roles/
│   ├── <role>.yaml        # Custom role definitions
│   └── ...
└── prompts/
    ├── <role>.md          # System prompts for each role
    └── ...
```

## Schema Reference

### team.yaml

```yaml
name: string              # Team identifier (matches directory name)
description: string       # Human-readable description
version: 1                # Schema version (currently 1)

roles:                    # List of role names used by this team
  - <role_name>

topology:                 # Agent spawn structure
  root:                   # Initial agent (always spawned first)
    role: string          # Role name from roles list
    prompt: string        # Relative path to prompt file
    config:
      model: string       # Model to use (sonnet, haiku, opus)

  companions:             # Peer agents (spawned alongside root, not as children)
    - role: string
      prompt: string
      config:
        model: string

  spawn_rules:            # Which roles can spawn which other roles
    <role>: [<role>, ...]

communication:            # Signal routing configuration
  channels:               # Named signal groups
    <channel_name>:
      description: string
      signals: [string, ...]

  subscriptions:          # Which signals each role receives
    <role>:
      - channel: string
        signals: [string, ...]  # Optional; omit for all signals

  emissions:              # Which signals each role can emit
    <role>: [string, ...]

  routing:
    status: upstream      # Status events flow to parent
    peers:                # Direct peer-to-peer routes
      - from: string
        to: string
        via: direct
        signals: [string, ...]

  enforcement: permissive | strict | audit

macro_agent:              # Runtime behavior configuration
  task_assignment:
    mode: push | pull
    pull:                 # Only for pull mode
      idle_timeout_s: number
      claim_retry_delay_ms: number
      max_concurrent_per_agent: number

  integration:
    strategy: queue | trunk | optimistic
    config:               # Strategy-specific options
      max_retries: number       # trunk/optimistic: retry count
      conflict_action: string   # trunk: abandon|rebase
      require_review: boolean   # queue: gate on review

  lifecycle:
    continuations:
      enabled: boolean
      max_history_messages: number
      checkpoint_interval: round_trip | none
    scaling:
      min_workers: number
      max_workers: number
      scale_on: task_queue_depth | manual
      idle_drain: boolean

  observability:
    metrics_window_s: number
    snapshot_interval_s: number
```

### Role Definitions (roles/*.yaml)

```yaml
name: string              # Role identifier
extends: string           # Base role: worker, coordinator, monitor, integrator
display_name: string      # Human-readable name
description: string

# Capability modification (pick one approach)
capabilities: [string]          # Full replacement of base capabilities
capabilities_add: [string]      # Add to base capabilities
capabilities_remove: [string]   # Remove from base capabilities

prompt: string            # Relative path to prompt file

macro_agent:
  workspace:
    type: own | shared | none
    branch_pattern: string        # Pattern with {agent-id} placeholder
    cleanup_on_terminate: boolean
  lifecycle:
    type: ephemeral | persistent | daemon | event-driven
    cascade_terminate: boolean
    self_cleanup: boolean
    task_bound: boolean
    parent_bound: boolean
    max_duration_ms: number
```

## Task Assignment Modes

### Push Mode

The coordinator creates tasks and explicitly assigns them to spawned agents. This is the traditional hierarchical model.

- Coordinator spawns workers and assigns tasks via `assign_task`
- Workers execute their assigned task and call `done()`
- Workers terminate after task completion

### Pull Mode

Agents autonomously claim tasks from a shared pool. Best for large, parallelizable workloads.

- A planner role creates and prioritizes tasks
- Worker agents call `claim_task` to pick up work
- After completing a task, workers claim the next available one
- Workers that find no tasks wait with configurable idle timeout

## Integration Strategies

### Queue (default)

Changes flow through a merge queue managed by an integrator agent. Provides the highest safety with review gates.

### Trunk

Workers push directly to the main branch with automatic rebase-and-retry. Fast but requires good test coverage.

Configuration:
- `max_retries`: Number of rebase attempts (default: 3)
- `conflict_action`: What to do on persistent conflict (`abandon` or `rebase`)

### Optimistic

Like trunk, but emits a validation event after push for async verification. Useful when builds are slow.

## Reference Templates

### self-driving

Autonomous development with continuous planning. Uses pull-mode task assignment and trunk integration.

| Role | Base | Purpose |
|------|------|---------|
| planner | coordinator | Explores codebase, creates and prioritizes tasks |
| grinder | worker | Claims and executes tasks autonomously |
| judge | monitor | Monitors codebase health, creates fixup tasks |

### structured

Hierarchical development with explicit assignment. Uses push-mode task assignment and merge queue.

| Role | Base | Purpose |
|------|------|---------|
| lead | coordinator | Decomposes work and assigns tasks to developers |
| developer | worker | Executes assigned tasks in isolated workspaces |
| reviewer | monitor | Reviews merge requests before they land |

## Creating a Custom Team

1. Create directory: `.macro-agent/teams/my-team/`
2. Write `team.yaml` with your manifest
3. Define custom roles in `roles/`
4. Write system prompts in `prompts/`
5. Load with: `TeamLoader.load("my-team")`

### Example: Minimal Custom Team

```yaml
name: my-team
description: "Simple worker team"
version: 1
roles: [lead, dev]

topology:
  root:
    role: lead
    prompt: prompts/lead.md
  spawn_rules:
    lead: [dev]
    dev: []

communication:
  channels:
    work:
      signals: [TASK_ASSIGNED, TASK_COMPLETED]
  subscriptions:
    lead:
      - channel: work
    dev:
      - channel: work
        signals: [TASK_ASSIGNED]
  emissions:
    lead: [TASK_ASSIGNED]
    dev: [TASK_COMPLETED]
  enforcement: permissive

macro_agent:
  task_assignment:
    mode: push
  integration:
    strategy: queue
```
