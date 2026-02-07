# Team Templates

Detailed design for the team template system — the modular layer that enables loading different agent team structures on top of macro-agent's role-agnostic core.

## Problem

macro-agent provides powerful primitives: roles with capabilities, workspace isolation, message routing, lifecycle management. But composing these into a working multi-agent team requires knowing which roles to define, how they interact, what prompts they need, and which integration/task patterns to use.

Today, this composition is implicit — you spawn a coordinator, it spawns workers, the integrator processes the merge queue. There's one interaction pattern hardcoded across the system.

Different workflows need different team shapes:
- **Structured development**: Coordinator decomposes tasks, pushes to workers, integrator gates merges (current model)
- **Self-driving**: Planners continuously discover work, workers pull tasks, trunk-based integration, judge evaluates quality
- **Code review**: Author agents write code, reviewer agents evaluate, gatekeeper merges approved changes
- **Migration**: Scanner identifies work, transformer agents apply changes in parallel, validator confirms correctness

Team templates make these compositions **declarative and loadable** without modifying macro-agent core.

## What a Team Template Is

A team template is a directory containing:

```
.macro-agent/teams/<team-name>/
├── team.yaml              # Manifest: topology, strategies, modes
├── roles/                 # Role definitions (extend built-in roles)
│   ├── <role-name>.yaml
│   └── ...
├── prompts/               # System prompt templates and fragments
│   ├── <role-name>.md     # Full prompt template for a role
│   └── ...
├── skills/                # Composable behavior modules
│   ├── <skill-name>.yaml  # Skill definition
│   └── ...
└── hooks/                 # Lifecycle hook scripts (optional)
    ├── on-team-start.sh
    └── on-team-stop.sh
```

A template defines three things:
1. **Who** — the roles and their capabilities/behavior
2. **How they interact** — communication topology, task flow, integration pattern
3. **What they know** — system prompts, skills, and domain context

---

## Manifest: team.yaml

The manifest is the entry point. It declares the team's topology and operational modes.

```yaml
name: self-driving
description: "Autonomous codebase development with continuous planning"
version: 1

# ─────────────────────────────────────────────────────────────
# Roles
# ─────────────────────────────────────────────────────────────
# References role definitions in roles/ directory or built-in roles.
# Each entry is either a string (use as-is) or an object (with config).
roles:
  - planner              # Defined in roles/planner.yaml
  - grinder              # Defined in roles/grinder.yaml
  - judge                # Defined in roles/judge.yaml
  - worker               # Built-in worker (used as-is)

# ─────────────────────────────────────────────────────────────
# Topology
# ─────────────────────────────────────────────────────────────
# Defines the agent spawn graph and communication patterns.
topology:
  # The root agent spawned when the team starts
  root:
    role: planner
    prompt: prompts/planner.md
    config:
      model: sonnet

  # Companion agents spawned alongside root (peers, not children)
  companions:
    - role: judge
      prompt: prompts/judge.md
      config:
        model: haiku

  # Spawn rules: which roles can spawn which other roles.
  # Overrides the default capability-based spawn checks.
  # If omitted, falls back to role capability checks.
  spawn_rules:
    planner: [grinder, planner]      # Planners can spawn grinders and sub-planners
    judge: []                         # Judges cannot spawn agents
    grinder: []                       # Grinders focus on work, don't spawn

  # Communication topology: who subscribes to what.
  # Supplements role-level protocol.subscriptions.
  # "upstream" means parent/ancestors, "downstream" means children.
  communication:
    planner:
      receives_from: [grinder, judge]
      broadcasts_to: [grinder]
    judge:
      receives_from: [grinder, planner]
    grinder:
      receives_from: [planner]

# ─────────────────────────────────────────────────────────────
# Interaction Patterns
# ─────────────────────────────────────────────────────────────
# Declares the operational modes for this team.
# These map to macro-agent primitives but are configured declaratively.

task_assignment:
  mode: pull                         # push | pull
  pull:
    idle_timeout_s: 300              # Worker self-terminates after idle
    claim_retry_delay_ms: 2000       # Backoff between claim attempts
    max_concurrent_per_agent: 1      # Tasks per worker at a time

integration:
  strategy: trunk                    # queue | trunk | optimistic | <custom>
  config:
    max_retries: 3
    conflict_action: abandon         # abandon | resolve

lifecycle:
  # Session continuation settings
  continuations:
    enabled: true
    max_history_messages: 50         # Context window management
    checkpoint_interval: round_trip  # round_trip | time:<seconds>

  # Agent pool scaling
  scaling:
    min_workers: 2
    max_workers: 20
    scale_on: task_queue_depth       # task_queue_depth | manual
    idle_drain: true                 # Drain idle workers when queue empty

# ─────────────────────────────────────────────────────────────
# Observability
# ─────────────────────────────────────────────────────────────
observability:
  metrics_window_s: 3600
  snapshot_interval_s: 300
  emit_events: true                  # Emit metric events for views
```

### Manifest Field Reference

| Section | Field | Type | Description |
|---------|-------|------|-------------|
| `roles` | list | `string[]` | Role names to load from `roles/` or built-ins |
| `topology.root` | object | `{ role, prompt?, config? }` | Initial agent to spawn |
| `topology.companions` | list | `{ role, prompt?, config? }[]` | Peer agents spawned with root |
| `topology.spawn_rules` | map | `Record<role, role[]>` | Allowed spawn relationships |
| `topology.communication` | map | `Record<role, { receives_from?, broadcasts_to? }>` | Message routing overlay |
| `task_assignment.mode` | enum | `push \| pull` | Task flow model |
| `integration.strategy` | string | Strategy name | Integration strategy |
| `integration.config` | object | Strategy-specific config | Passed to strategy.initialize() |
| `lifecycle.continuations` | object | `{ enabled, max_history_messages, checkpoint_interval }` | Session resume config |
| `lifecycle.scaling` | object | `{ min_workers, max_workers, scale_on, idle_drain }` | Agent pool config |
| `observability` | object | Metrics config | Throughput/utilization tracking |

---

## Role Definitions

Roles in a team template extend macro-agent's `RoleDefinition` with team-specific fields.

### Role YAML Schema

```yaml
# roles/planner.yaml
name: planner
extends: coordinator                 # Inherit from built-in coordinator
display_name: "Planner"
description: "Continuously explores codebase and creates tasks"

# Override capabilities from parent
capabilities:
  add:                               # Add to parent's capabilities
    - task.create
    - task.update
    - task.close
  remove:                            # Remove from parent's capabilities
    - agent.spawn.integrator         # Planners don't spawn integrators

# Override workspace enforcement
workspace:
  type: own
  branch_pattern: "planner/{agent-id}"
  cleanup_on_terminate: true

# Override lifecycle enforcement
lifecycle:
  type: daemon                       # Runs continuously
  cascade_terminate: true
  self_cleanup: true

# Override protocol
protocol:
  subscriptions:
    - WORKER_DONE
    - TASK_COMPLETED
    - TASK_FAILED
    - CONVERGENCE_CHECK
  can_emit:
    - WORK_ASSIGNED
    - TASK_CREATED
    - PLANNING_COMPLETE

# Skills this role has (composable behavior modules)
skills:
  - codebase-exploration
  - task-decomposition
  - progress-tracking

# Prompt configuration
prompt:
  template: prompts/planner.md       # Full prompt template
  sections:                          # Additional prompt sections to inject
    - name: planning-guidelines
      content: |
        When exploring the codebase, focus on:
        1. Understanding the current architecture
        2. Identifying gaps relative to the specification
        3. Breaking work into independent, parallelizable tasks
        4. Tracking which areas are actively being worked on
  variables:                         # Variables available in prompt templates
    max_concurrent_tasks: 10
    planning_horizon: "next 5 tasks"
```

### Capability Composition

Roles in a team template can compose capabilities in three ways:

**1. Full replacement** (like current built-in roles):
```yaml
capabilities:
  - file.read
  - file.write
  - task.create
  - lifecycle.done
```

**2. Additive/subtractive** (relative to parent via `extends`):
```yaml
extends: worker
capabilities:
  add:
    - task.claim        # New capability for pull mode
    - git.push          # Workers can push in trunk mode
  remove:
    - agent.spawn.worker  # This worker type can't spawn children
```

**3. From skills** (capabilities contributed by skill modules):
```yaml
skills:
  - code-review         # Contributes: file.read, msg.send
  - conflict-resolution # Contributes: git.merge, file.write
```

The final capability set is: `(parent_capabilities + added + skill_contributed) - removed`

---

## Skills: Composable Behavior Modules

Skills are the key abstraction for reusable agent behaviors. A skill bundles:
- **Capabilities** it requires/contributes
- **Prompt fragments** that teach the agent how to perform the skill
- **Tool guidance** specific to the skill
- **Protocol patterns** the skill uses

### Why Skills?

Roles define *what an agent is*. Skills define *what an agent can do*. The same skill can be composed into different roles across different teams:

| Skill | Used By |
|-------|---------|
| `codebase-exploration` | Planner, Judge, Reviewer |
| `task-decomposition` | Planner, Coordinator |
| `conflict-resolution` | Integrator, Resolver Worker |
| `code-review` | Reviewer, Judge |
| `test-authoring` | Worker, QA Agent |
| `progress-tracking` | Planner, Monitor, Coordinator |

### Skill Definition Schema

```yaml
# skills/codebase-exploration.yaml
name: codebase-exploration
description: "Systematically explore and understand a codebase"

# Capabilities this skill needs to function
requires:
  - file.read
  - exec.command        # For running grep, find, etc.

# Capabilities this skill contributes to the role
contributes: []         # This skill doesn't add capabilities beyond requirements

# Prompt fragment injected into the agent's system prompt
prompt: |
  ## Codebase Exploration

  When exploring the codebase, use a systematic approach:

  1. **Map the structure**: Read the top-level directory, identify key modules
  2. **Understand entry points**: Find main files, CLI handlers, API routes
  3. **Trace dependencies**: Follow imports to understand module relationships
  4. **Read tests**: Tests reveal intended behavior and edge cases
  5. **Check configuration**: Build configs, CI pipelines, environment variables

  Use `glob` and `grep` tools for efficient exploration. Avoid reading
  every file — focus on understanding the architecture and conventions.

  When creating tasks based on exploration:
  - Each task should be independently completable
  - Include enough context for a worker to start without re-exploring
  - Reference specific files and line ranges when possible
  - Tag tasks with the subsystem they belong to

# Tool-specific guidance (appended to tool descriptions in system prompt)
tool_guidance:
  glob: "Use glob patterns like **/*.ts to find files by type"
  grep: "Search for function definitions, imports, and key patterns"
  create_task: "Include file paths and code references in task descriptions"

# Protocol patterns this skill uses
protocol:
  can_emit:
    - EXPLORATION_COMPLETE
    - ARCHITECTURE_INSIGHT
```

### Skill: task-decomposition

```yaml
# skills/task-decomposition.yaml
name: task-decomposition
description: "Break complex objectives into parallelizable worker tasks"

requires:
  - task.create
  - task.update
  - file.read

prompt: |
  ## Task Decomposition

  When breaking work into tasks:

  **Granularity**: Each task should take a single agent 5-30 minutes. Too small
  wastes overhead, too large creates merge conflicts and reduces parallelism.

  **Independence**: Tasks should be completable in isolation. If task B depends
  on task A's output, mark the dependency explicitly.

  **Context**: Include in each task description:
  - What files will be modified
  - What the expected outcome is
  - How to verify the task is complete (test command, expected behavior)
  - Any constraints or conventions to follow

  **Tags**: Tag tasks for filtered claiming:
  - Subsystem: `frontend`, `backend`, `database`, `tests`, `docs`
  - Type: `feature`, `bugfix`, `refactor`, `test`, `config`
  - Priority: `critical`, `high`, `normal`, `low`

  **Dependencies**: Use task blockers when ordering matters:
  - Schema changes before API endpoints
  - API endpoints before frontend integration
  - Feature code before tests (or reverse for TDD)

tool_guidance:
  create_task: |
    Always include tags for subsystem and type. Set blockers for dependencies.
    Example: create_task({ title: "Add user auth endpoint", tags: ["backend", "feature"], blockers: ["task-123"] })
```

### Skill: progress-tracking

```yaml
# skills/progress-tracking.yaml
name: progress-tracking
description: "Monitor task completion and convergence toward objectives"

requires:
  - msg.subscribe
  - msg.send

contributes:
  - task.update         # Can update task metadata/priority

prompt: |
  ## Progress Tracking

  Monitor the state of work across the team:

  1. **Task completion rate**: Are tasks being completed at a steady pace?
  2. **Error rate**: Are tasks failing? What patterns emerge in failures?
  3. **Blocked tasks**: Are any tasks stuck waiting for dependencies?
  4. **Coverage**: Are all areas of the objective being addressed?

  When tracking reveals problems:
  - If error rate is climbing: Create high-priority fixup tasks
  - If a subsystem is blocked: Reprioritize to unblock it
  - If workers are idle: Create more tasks or reduce worker count
  - If convergence stalls: Re-evaluate the plan and adjust priorities

protocol:
  subscriptions:
    - WORKER_DONE
    - TASK_COMPLETED
    - TASK_FAILED
    - METRIC_SNAPSHOT
```

### How Skills Compose into the System Prompt

When a role has `skills: [codebase-exploration, task-decomposition]`, the system prompt generator appends skill prompts as additional sections:

```
[Standard system prompt sections (identity, task, tools, communication, guidelines)]

## Codebase Exploration
[content from codebase-exploration.yaml prompt field]

## Task Decomposition
[content from task-decomposition.yaml prompt field]
```

Tool guidance from skills is merged into the tools section:
```
Available tools:
- glob: Find files by pattern. Use glob patterns like **/*.ts to find files by type
- create_task: Create a new task. Always include tags for subsystem and type...
```

---

## Interaction Patterns

Team templates don't just define roles — they define how those roles interact. These interaction patterns are declared in the manifest and implemented by macro-agent primitives.

### Pattern: Push Task Assignment (Current Default)

```yaml
task_assignment:
  mode: push
```

**How it works**: A coordinator (or planner) creates a task, then spawns a worker with that task bound to it. The worker executes the task and calls `done()`. The coordinator receives the completion signal.

**Implemented by**: `AgentManager.spawn()` with `task` parameter, worker's `lifecycle.taskBound: true`.

**Best for**: Controlled workflows where the coordinator needs to decide exactly what to work on next.

### Pattern: Pull Task Assignment

```yaml
task_assignment:
  mode: pull
  pull:
    idle_timeout_s: 300
    claim_retry_delay_ms: 2000
    max_concurrent_per_agent: 1
```

**How it works**: Planners create tasks in the task backend. Workers run a claim-execute-complete loop: `claim_task() → work → done() → claim_task()`. Workers self-terminate after idle timeout.

**Implemented by**: `TaskBackend.claim()`, `claim_task` MCP tool, modified worker `done()` handler that doesn't terminate on completion.

**Best for**: High-throughput workflows with many independent tasks and elastic worker pools.

**System prompt injection**: When pull mode is active, workers receive additional guidance:

```
## Task Claiming

You operate in PULL mode. After completing a task:
1. Call done() with your results
2. Call claim_task() to get your next task
3. If no tasks available, wait briefly and retry
4. If idle for {idle_timeout_s}s with no tasks, call done() to exit

Do NOT wait for instructions from a coordinator. Claim and execute independently.
```

### Pattern: Queue Integration

```yaml
integration:
  strategy: queue
```

**How it works**: Workers commit to feature branches. On `done()`, a merge request is submitted to the merge queue. An integrator agent processes the queue serially, resolving conflicts by spawning resolver workers.

**Implemented by**: `QueueIntegrationStrategy` wrapping `MergeQueueInterface`.

**System prompt injection for integrator**: Existing behavior, no changes.

### Pattern: Trunk Integration

```yaml
integration:
  strategy: trunk
  config:
    max_retries: 3
    conflict_action: abandon
```

**How it works**: Workers commit and push directly to the integration branch. On conflict, rebase and retry. After max retries, either abandon (task returns to pool) or escalate.

**Implemented by**: `TrunkIntegrationStrategy`.

**System prompt injection for workers**: When trunk mode is active:

```
## Integration

You push directly to the integration branch. After completing your work:
1. Commit all changes
2. The system will push your changes to the integration branch
3. If there's a conflict, the system rebases and retries automatically
4. If retries are exhausted, your task may be re-queued for another worker

You may encounter transient failures from other workers' changes.
This is normal — focus on your task and trust the system to converge.
```

### Pattern: Optimistic Integration

```yaml
integration:
  strategy: optimistic
  config:
    validator: ci
    fixup_task_tag: fixup
    green_branch: green/latest
```

**How it works**: Workers push immediately. A background validator checks CI status. Failures auto-create fixup tasks. A "green" branch is maintained at the last passing commit.

**Implemented by**: `OptimisticIntegrationStrategy`.

### Pattern: Event-Driven Agents

Some roles don't run continuously but activate in response to events:

```yaml
# roles/judge.yaml
lifecycle:
  type: event-driven
  triggers:
    - event: METRIC_SNAPSHOT          # Activate on metric snapshots
      condition: "error_rate > 0.1"   # Only if error rate is high
    - event: TIMER                    # Periodic activation
      interval_s: 600                 # Every 10 minutes
```

**Implemented by**: `LifecycleEnforcement.type: "event-driven"` + `wait_for_activity` MCP tool.

### Pattern: Hierarchical Planning (Recursive Decomposition)

```yaml
topology:
  spawn_rules:
    planner: [grinder, planner]       # Planners can spawn sub-planners
```

**How it works**: A top-level planner explores the full codebase. For large subsystems, it spawns sub-planners focused on specific areas. Sub-planners create tasks for their domain. Workers claim from the shared task pool.

**System prompt injection for planners**: When recursive planning is enabled:

```
## Recursive Planning

For large or complex subsystems, you can spawn a sub-planner:
- spawn_agent({ role: "planner", task: "Plan the authentication subsystem" })
- The sub-planner inherits your team context and creates tasks in the shared pool
- You maintain the high-level view; sub-planners handle domain details
- Monitor sub-planner progress via status updates

Spawn a sub-planner when:
- A subsystem has >10 potential tasks
- Domain expertise is needed for decomposition
- Parallel planning would speed things up
```

---

## Prompt Templates

Full prompt templates live in `prompts/<role-name>.md` and are loaded as the primary system prompt for that role. They can reference variables from the team manifest and role config.

### Template Variables

Templates use `{{variable}}` syntax for interpolation:

```markdown
# {{role_display_name}}

You are a {{role_display_name}} in the **{{team_name}}** team.

## Your Objective

{{task_description}}

## Team Context

- **Integration**: Changes land via {{integration_strategy}} strategy
- **Task Mode**: {{task_mode}} — {{#if pull_mode}}claim tasks independently{{else}}receive tasks from coordinator{{/if}}
- **Team Size**: Up to {{max_workers}} concurrent workers

## Your Skills

{{#each skills}}
{{skill_prompt}}
{{/each}}

## Working Agreements

{{#if constraints}}
{{constraints}}
{{/if}}
```

### Available Template Variables

| Variable | Source | Example |
|----------|--------|---------|
| `team_name` | `team.yaml:name` | `"self-driving"` |
| `role_display_name` | Role definition | `"Planner"` |
| `task_description` | Spawn-time task | `"Build a web browser"` |
| `integration_strategy` | `team.yaml:integration.strategy` | `"trunk"` |
| `task_mode` | `team.yaml:task_assignment.mode` | `"pull"` |
| `pull_mode` | Computed boolean | `true` |
| `max_workers` | `team.yaml:lifecycle.scaling.max_workers` | `20` |
| `skills` | Resolved skill prompts | Array of prompt strings |
| `constraints` | `prompt.variables.constraints` in role | User-defined text |
| `idle_timeout_s` | `team.yaml:task_assignment.pull.idle_timeout_s` | `300` |

### Prompt Assembly Order

The final system prompt for an agent is assembled from multiple sources in this order:

```
1. Base sections (identity, task, lineage)         ← system-prompt.ts
2. Role template (prompts/<role>.md)               ← team template
   OR role systemPrompt field                      ← role definition
   OR generated role section                       ← system-prompt.ts fallback
3. Skills prompt fragments                         ← skill definitions
4. Interaction pattern guidance                    ← derived from team.yaml modes
5. Tool listing with skill-augmented descriptions  ← tools + skill tool_guidance
6. Communication guidelines                        ← system-prompt.ts
7. Role prompt.sections (additional fragments)     ← role definition
```

This means:
- The team template's prompt replaces the default role-specific prompt section
- Skills add behavior-specific sections
- Interaction patterns inject mode-appropriate guidance
- Everything else (identity, tools, communication) is standard

---

## Team Loading and Runtime

### TeamLoader

Responsible for reading and validating the template directory:

```
TeamLoader.load(teamName: string, basePath?: string)
  1. Resolve template directory: .macro-agent/teams/<teamName>/
  2. Parse and validate team.yaml manifest
  3. For each role in manifest.roles:
     a. Load roles/<role>.yaml if present
     b. Resolve extends chain against RoleRegistry
     c. Validate capabilities, enforcement, protocol
  4. For each skill referenced by roles:
     a. Load skills/<skill>.yaml
     b. Validate requires/contributes capabilities
  5. Load prompt templates (prompts/*.md)
  6. Return TeamManifest (parsed, validated, resolved)
```

### TeamRuntime

Responsible for wiring a loaded template into the running system:

```
TeamRuntime.initialize(manifest: TeamManifest, services: MacroAgentServices)
  1. Register roles into RoleRegistry (runtime layer, highest priority)
  2. Compose final capabilities for each role:
     - Start with base (from extends or explicit)
     - Add skill-contributed capabilities
     - Apply add/remove overrides
  3. Compose system prompts:
     - Resolve prompt templates with variables
     - Append skill prompt fragments
     - Append interaction pattern guidance
  4. Select and initialize IntegrationStrategy from registry
  5. Configure TaskBackend mode (push/pull)
  6. Set up scaling config (min/max workers, scale trigger)
  7. Initialize observability (if enabled)
  8. Store active team state
```

### Team Bootstrap

After TeamRuntime initializes, it spawns the initial agents:

```
TeamRuntime.bootstrap()
  1. Spawn root agent per topology.root
     - Role from manifest
     - System prompt from resolved template
     - Team context in environment variables
  2. For each companion in topology.companions:
     - Spawn as peer (not child of root)
     - Same team context
  3. Emit TEAM_STARTED event
  4. If scaling.min_workers > 0:
     - Spawn initial worker pool
```

---

## Example: Self-Driving Team Template

Putting it all together — here's what the reference `self-driving` team looks like:

### team.yaml

```yaml
name: self-driving
description: "Autonomous codebase development with continuous planning and trunk integration"
version: 1

roles:
  - planner
  - grinder
  - judge

topology:
  root:
    role: planner
    prompt: prompts/planner.md
    config:
      model: sonnet
  companions:
    - role: judge
      prompt: prompts/judge.md
      config:
        model: haiku
  spawn_rules:
    planner: [grinder, planner]
    judge: []
    grinder: []
  communication:
    planner:
      receives_from: [grinder, judge]
      broadcasts_to: [grinder]
    judge:
      receives_from: [grinder, planner]
    grinder:
      receives_from: [planner]

task_assignment:
  mode: pull
  pull:
    idle_timeout_s: 300
    claim_retry_delay_ms: 2000
    max_concurrent_per_agent: 1

integration:
  strategy: trunk
  config:
    max_retries: 3
    conflict_action: abandon

lifecycle:
  continuations:
    enabled: true
    max_history_messages: 50
    checkpoint_interval: round_trip
  scaling:
    min_workers: 3
    max_workers: 20
    scale_on: task_queue_depth
    idle_drain: true

observability:
  metrics_window_s: 3600
  snapshot_interval_s: 300
  emit_events: true
```

### roles/planner.yaml

```yaml
name: planner
extends: coordinator
display_name: "Planner"
description: "Continuously explores the codebase, creates and prioritizes tasks"

capabilities:
  add:
    - task.claim        # Can inspect the task pool
  remove:
    - agent.spawn.integrator
    - agent.spawn.monitor

lifecycle:
  type: daemon
  cascade_terminate: true

protocol:
  subscriptions: [WORKER_DONE, TASK_COMPLETED, TASK_FAILED, METRIC_SNAPSHOT]
  can_emit: [WORK_ASSIGNED, TASK_CREATED, PLANNING_COMPLETE, CONVERGENCE_CHECK]

skills:
  - codebase-exploration
  - task-decomposition
  - progress-tracking

prompt:
  template: prompts/planner.md
  variables:
    planning_horizon: "next 10 tasks"
    max_concurrent_tasks: 15
```

### roles/grinder.yaml

```yaml
name: grinder
extends: worker
display_name: "Grinder"
description: "Claims and executes tasks autonomously"

capabilities:
  add:
    - task.claim        # Pull model: can claim tasks
    - git.push          # Trunk model: can push to integration branch

lifecycle:
  type: ephemeral
  task_bound: false      # NOT task-bound — runs claim loop
  max_duration_ms: 3600000  # 1 hour max per session
  self_cleanup: true

protocol:
  subscriptions: [WORK_ASSIGNED]
  can_emit: [WORKER_DONE]

skills:
  - task-execution
```

### roles/judge.yaml

```yaml
name: judge
extends: monitor
display_name: "Judge"
description: "Periodically evaluates codebase health and creates fixup tasks"

capabilities:
  add:
    - exec.build
    - exec.test
    - exec.lint
    - task.create       # Can create fixup tasks
    - task.update       # Can reprioritize tasks
    - git.branch.create # Can snapshot green branch
    - git.push          # Can push green branch

workspace:
  type: own
  branch_pattern: "judge/{agent-id}"
  cleanup_on_terminate: true

lifecycle:
  type: event-driven
  parent_bound: false    # Independent of planner lifecycle

protocol:
  subscriptions: [METRIC_SNAPSHOT, WORKER_DONE, TASK_FAILED]
  can_emit: [HEALTH_CHECK, GREEN_SNAPSHOT, FIXUP_CREATED]

skills:
  - codebase-exploration
  - progress-tracking

prompt:
  template: prompts/judge.md
```

### prompts/planner.md

```markdown
# Planner

You are the Planner for the **{{team_name}}** team. Your job is to continuously
explore the codebase, understand the current state, and create well-defined tasks
for worker agents to execute.

## How You Work

1. **Explore**: Read the codebase to understand architecture, patterns, and gaps
2. **Plan**: Break the objective into independent, parallelizable tasks
3. **Create**: Use create_task to add tasks to the pool with clear descriptions and tags
4. **Monitor**: Watch for completed/failed tasks and adjust the plan accordingly
5. **Repeat**: Planning is continuous — as work completes, create the next batch of tasks

## Current Mode

- Workers claim tasks independently (pull mode)
- Workers push to trunk directly — expect some transient breakage
- The judge monitors quality and creates fixup tasks when needed
- You have up to {{max_workers}} concurrent workers

## Planning Guidelines

- Create tasks in batches of {{planning_horizon}}
- Each task should be completable in 5-30 minutes by a single worker
- Tag tasks with subsystem and type for filtered claiming
- Set dependencies (blockers) when ordering matters
- Prefer many small tasks over few large ones — parallelism is the goal

## When to Spawn Sub-Planners

For large subsystems (>10 potential tasks), spawn a sub-planner focused on that area:
- spawn_agent({ role: "planner", task: "Plan the [subsystem] changes" })
- Sub-planners create tasks in the shared pool
- You maintain the high-level view

## Constraints

- Do NOT instruct on things the model already knows (coding, testing, etc.)
- DO specify things specific to this codebase (conventions, build system, deploy pipeline)
- Constraints are more effective than instructions: "No TODOs, no partial implementations"
- Treat workers like brilliant new hires who know engineering but not this specific codebase
```

### prompts/judge.md

```markdown
# Judge

You are the Judge for the **{{team_name}}** team. You periodically evaluate
the health of the codebase and take corrective action when needed.

## How You Work

1. **Evaluate**: Run the build and test suite to check current status
2. **Diagnose**: If failures exist, identify the root cause and affected area
3. **Fix**: Create high-priority fixup tasks for workers to claim
4. **Snapshot**: When the build is green, snapshot the current state to the green branch

## Evaluation Cycle

Every time you activate:
1. Run: `exec.build` — check compilation
2. Run: `exec.test` — check test suite
3. Run: `exec.lint` — check code quality
4. If all pass: snapshot to green branch, emit GREEN_SNAPSHOT
5. If any fail: create fixup tasks with tag "fixup" and priority "critical"

## Green Branch

Maintain a clean snapshot at `green/latest`:
- Only update when build + tests + lint all pass
- This is the team's release candidate at any given time
- Workers may be on a broken trunk — that's OK, the green branch is the safety net

## Creating Fixup Tasks

When you find failures:
- Create one task per distinct issue (don't bundle)
- Include the exact error output in the task description
- Tag with: ["fixup", "<subsystem>"]
- Set priority: critical
- Reference the failing file and test
```

---

## Example: Structured Team Template

For comparison, here's how the existing coordinator/integrator/worker pattern
would look as a team template:

```yaml
# .macro-agent/teams/structured/team.yaml
name: structured
description: "Traditional structured development with coordinator, integrator, and workers"
version: 1

roles:
  - coordinator        # Built-in
  - integrator         # Built-in
  - worker             # Built-in
  - monitor            # Built-in

topology:
  root:
    role: coordinator
  spawn_rules:
    coordinator: [worker, integrator, monitor]
    integrator: [worker]    # Resolver workers
    worker: []
    monitor: []

task_assignment:
  mode: push

integration:
  strategy: queue

lifecycle:
  continuations:
    enabled: false
  scaling:
    min_workers: 0
    max_workers: 10
    scale_on: manual

observability:
  emit_events: false
```

No custom roles, no skills, no prompt templates — just the built-in roles composed into the current interaction pattern. This demonstrates that team templates are a superset of the existing behavior.

---

## Implementation Considerations

### What macro-agent Core Needs to Support

The team template system is declarative, but it requires these macro-agent primitives:

| Primitive | Status | Required For |
|-----------|--------|-------------|
| `RoleRegistry` with layered config | Exists | Role loading and resolution |
| `IntegrationStrategy` interface | Phase 2 | Pluggable integration |
| `TaskBackend.claim()` | Phase 3 | Pull task assignment |
| Worker done() handler with strategy dispatch | Phase 2 | Integration strategy selection |
| Worker done() handler with pull-mode continuation | Phase 3 | Claim loop lifecycle |
| `EventStore` session history | Phase 4 | Session continuations |
| `AgentManager.resume()` | Phase 4 | Session resumption |
| Metric materialized views | Phase 5 | Observability |
| System prompt template rendering | Phase 1 | Prompt variable interpolation |
| Skill loading and prompt composition | Phase 1 | Skills system |

### What's New in Phase 1 (Team System Itself)

1. **TeamManifest types** — TypeScript types for team.yaml schema
2. **TeamLoader** — Reads and validates team template directory
3. **SkillLoader** — Reads skill YAML files, resolves capabilities and prompts
4. **TeamRuntime** — Wires loaded manifest into running system
5. **Prompt template renderer** — `{{variable}}` interpolation + `{{#each}}` / `{{#if}}` conditionals
6. **System prompt composer** — Assembles final prompt from base + template + skills + interaction guidance
7. **CLI --team flag** — Loads team template on start
8. **Team context propagation** — Environment variables + system prompt context for all spawned agents
9. **spawn_rules enforcement** — Override capability-based spawn checks with team topology rules
10. **Communication topology wiring** — Set up message subscriptions per team manifest

### Configuration Precedence

When a team is loaded, the configuration stack becomes:

```
1. Built-in roles (baseline)
2. User-level overrides (~/.macro-agent/roles.json)
3. Project-level overrides (.macro-agent/roles.json)
4. Team template roles (.macro-agent/teams/<name>/roles/*.yaml)  ← NEW
5. Runtime custom registrations
```

Team template roles have higher priority than project-level overrides but lower than runtime registrations. This allows runtime overrides for debugging/testing.

### Interaction Pattern Injection

When the team manifest declares an interaction pattern (e.g., `task_assignment.mode: pull`), the system prompt generator injects pattern-specific guidance as a distinct section. This guidance is NOT in the skill or prompt template — it's derived from the manifest and injected automatically.

The injected sections are small and focused:
- Pull mode: How to use `claim_task`, idle behavior, self-termination
- Trunk mode: Conflict handling expectations, error tolerance mindset
- Optimistic mode: Validation expectations, fixup awareness
- Continuation mode: Session history context, how resumption works

This separation means prompt templates don't need to be mode-aware — they focus on the role's domain expertise, and the system handles the operational context.
