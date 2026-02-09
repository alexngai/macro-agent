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

---

## File Structure

A team template is a directory. The structure is designed to be interoperable with other multi-agent systems — the core topology and role structure uses a generic schema, while macro-agent specific configuration lives in clearly namespaced extension fields.

```
.macro-agent/teams/<team-name>/
├── team.yaml              # Manifest: topology, communication, modes
├── roles/                 # Role definitions
│   ├── <role-name>.yaml
│   └── ...
├── prompts/               # Static role prompt files
│   ├── <role-name>.md
│   └── ...
└── tools/                 # Additional MCP servers / tool configs
    ├── mcp-servers.json   # Additional MCP servers to mount per role
    └── ...
```

### Interoperability

The manifest schema separates **generic multi-agent concepts** from **macro-agent specifics**:

```yaml
# Generic multi-agent fields (portable across systems)
name: self-driving
description: "Autonomous codebase development"
version: 1
roles: [...]
topology: { ... }
communication: { ... }

# macro-agent specific extensions (namespaced)
macro_agent:
  integration:
    strategy: trunk
    config: { ... }
  task_assignment:
    mode: pull
    pull: { ... }
  lifecycle: { ... }
  observability: { ... }
```

The `topology`, `roles`, and `communication` sections are generic enough to describe any multi-agent team. The `macro_agent` section contains implementation-specific configuration that another system would ignore (or define its own equivalent).

Similarly, role definitions separate generic fields from extensions:

```yaml
# Generic
name: planner
extends: coordinator
description: "..."
capabilities: [...]

# macro-agent specific
macro_agent:
  workspace: { ... }
  lifecycle: { ... }
  protocol: { ... }
```

This means the same team template directory could be consumed by different orchestrators — each reading the generic topology and applying their own runtime semantics.

---

## Manifest: team.yaml

```yaml
name: self-driving
description: "Autonomous codebase development with continuous planning"
version: 1

# ─────────────────────────────────────────────────────────────
# Roles
# ─────────────────────────────────────────────────────────────
# References role files in roles/ directory or built-in roles.
roles:
  - planner
  - grinder
  - judge

# ─────────────────────────────────────────────────────────────
# Topology
# ─────────────────────────────────────────────────────────────
# Defines the agent spawn graph.
topology:
  # The initial agent spawned when the team starts
  root:
    role: planner
    prompt: prompts/planner.md    # Static prompt file
    config:
      model: sonnet

  # Agents spawned alongside root (peers, not children)
  companions:
    - role: judge
      prompt: prompts/judge.md
      config:
        model: haiku

  # Which roles can spawn which other roles.
  # Overrides the default capability-based spawn checks.
  spawn_rules:
    planner: [grinder, planner]
    judge: []
    grinder: []

# ─────────────────────────────────────────────────────────────
# Communication
# ─────────────────────────────────────────────────────────────
# Detailed below in the Communication Topology section.
communication:
  channels:
    task_updates:
      description: "Task lifecycle events"
      signals: [TASK_CREATED, TASK_COMPLETED, TASK_FAILED]
    work_coordination:
      description: "Work assignment and completion"
      signals: [WORK_ASSIGNED, WORKER_DONE, MERGE_REQUEST]
    health:
      description: "System health monitoring"
      signals: [HEALTH_CHECK, METRIC_SNAPSHOT, GREEN_SNAPSHOT]

  subscriptions:
    planner:
      - channel: task_updates
      - channel: work_coordination
        signals: [WORKER_DONE]
      - channel: health
        signals: [METRIC_SNAPSHOT]
    judge:
      - channel: task_updates
        signals: [TASK_FAILED]
      - channel: work_coordination
        signals: [WORKER_DONE]
      - channel: health
    grinder:
      - channel: work_coordination
        signals: [WORK_ASSIGNED]

  emissions:
    planner: [TASK_CREATED, WORK_ASSIGNED, PLANNING_COMPLETE]
    judge: [HEALTH_CHECK, GREEN_SNAPSHOT, FIXUP_CREATED]
    grinder: [WORKER_DONE]

  # How roles communicate with each other (see Communication Topology section)
  routing:
    # Status flows upward by default (subtree subscriptions)
    status: upstream

    # Explicit peer connections (non-hierarchical)
    peers:
      - from: judge
        to: planner
        via: direct            # Direct agent-to-agent messaging
        signals: [FIXUP_CREATED, GREEN_SNAPSHOT]
      - from: planner
        to: judge
        via: direct
        signals: [CONVERGENCE_CHECK]

# ─────────────────────────────────────────────────────────────
# macro-agent specific extensions
# ─────────────────────────────────────────────────────────────
macro_agent:
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
```

---

## Communication Topology

This is the most architecturally significant part of the team template. The communication section declares *how agents talk to each other* — which is what distinguishes one team shape from another.

### The Problem Communication Topology Solves

macro-agent's MessageRouter is powerful but low-level. It supports seven channel types (`agent`, `task`, `lineage`, `subtree`, `topic`, `broadcast`, `role`) and MAP addresses (direct, scope, role, hierarchical, federated). An agent can technically send a message to anyone via any mechanism.

But a well-functioning team needs **structured communication** — not a free-for-all. The planner shouldn't be interrupted by every grinder's debug output. The judge shouldn't broadcast to workers directly. Workers shouldn't message each other about unrelated tasks.

The communication topology declares the **intended** communication patterns. The TeamRuntime translates these into the right subscriptions, address restrictions, and routing rules.

### Three Layers of Communication

macro-agent communication already operates at three layers. The team template configures each:

#### Layer 1: Status Flow (Automatic, Hierarchical)

Status events (`started`, `checkpoint`, `completed`, `failed`, `blocked`) flow automatically from children to parents via subtree subscriptions. This is already implemented — `setupDefaultSubscriptions` subscribes parents to children's subtree.

```yaml
communication:
  routing:
    status: upstream     # Default: status flows up the spawn tree
```

In most teams, this is sufficient — a planner spawns grinders, and automatically receives their status updates. No additional configuration needed.

**But** the self-driving team has a non-hierarchical topology: the judge is a companion (peer of the planner), not a child. It still needs to see worker status. This is where explicit subscriptions come in.

#### Layer 2: Signal Channels (Topic-Based Pub/Sub)

Signals are named events that agents publish and subscribe to. They map directly to macro-agent's `topic` channel type and the existing `protocol.subscriptions` / `protocol.canEmit` in role definitions.

The team manifest groups signals into **named channels** for clarity:

```yaml
communication:
  channels:
    task_updates:
      signals: [TASK_CREATED, TASK_COMPLETED, TASK_FAILED]
    work_coordination:
      signals: [WORK_ASSIGNED, WORKER_DONE, MERGE_REQUEST]
    health:
      signals: [HEALTH_CHECK, METRIC_SNAPSHOT, GREEN_SNAPSHOT]
```

Each role subscribes to channels (or specific signals within a channel):

```yaml
  subscriptions:
    planner:
      - channel: task_updates                    # All signals in channel
      - channel: work_coordination
        signals: [WORKER_DONE]                   # Specific signal only
      - channel: health
        signals: [METRIC_SNAPSHOT]
    judge:
      - channel: task_updates
        signals: [TASK_FAILED]                   # Only failures
      - channel: health                          # All health signals
    grinder:
      - channel: work_coordination
        signals: [WORK_ASSIGNED]
```

And declares what it can emit:

```yaml
  emissions:
    planner: [TASK_CREATED, WORK_ASSIGNED]
    judge: [HEALTH_CHECK, GREEN_SNAPSHOT, FIXUP_CREATED]
    grinder: [WORKER_DONE]
```

**How this maps to macro-agent primitives**:

When the TeamRuntime initializes, for each agent spawned with role `planner`:

```typescript
// For each channel subscription:
//   channel: task_updates → subscribe to topic "task_updates"
messageRouter.subscribe(agentId, { type: "topic", target: "task_updates" });

// For signal-filtered subscriptions, the filtering happens at read time:
//   The agent receives all messages on the channel topic,
//   but the signal filter is applied when getMessages() is called
//   (or encoded in the subscription metadata for routing-level filtering)
```

When an agent emits a signal (e.g., `WORKER_DONE`), the emission is routed:

```typescript
// emitStatus with signal details → routes to topic subscribers
messageRouter.emitStatus({
  from: { agent_id: grinderId },
  status_type: "completed",
  summary: "Task done",
  details: { signal: "WORKER_DONE", taskId, ... }
});
// This reaches all agents subscribed to the topic containing WORKER_DONE
```

**The channel abstraction is purely organizational** — it groups related signals under a name for readability. Under the hood, each channel maps to a topic subscription. The signals within a channel can be used for filtering.

#### Layer 3: Direct Messaging (Peer-to-Peer)

Some communication doesn't fit the pub/sub model. The judge needs to tell the planner about a specific fixup. The planner needs to ask the judge to run an evaluation. These are directed, point-to-point messages.

```yaml
communication:
  routing:
    peers:
      - from: judge
        to: planner
        via: direct
        signals: [FIXUP_CREATED, GREEN_SNAPSHOT]
      - from: planner
        to: judge
        via: direct
        signals: [CONVERGENCE_CHECK]
```

**How this maps to macro-agent primitives**:

Peer connections use MAP's `role` addressing. When the judge sends `FIXUP_CREATED`:

```typescript
// The judge sends to the planner role (resolved to specific agent IDs)
messageRouter.sendToAddress({
  from: judgeAgentId,
  to: { role: "planner" },  // RoleAddress — resolved to planner agent(s)
  content: JSON.stringify({ signal: "FIXUP_CREATED", taskId, ... }),
  options: { priority: "high" }
});
```

The `via: direct` means use MAP agent/role addressing (not topic pub/sub). The `via` field can be:
- `direct` — MAP `{ role: "target_role" }` or `{ agent: id }` addressing
- `topic` — publish to a shared topic (same as channel subscriptions)
- `scope` — MAP `{ scope: "scope_name" }` addressing (explicit scope membership)

**Why this matters for the self-driving team**: The judge and planner are peers (not parent-child). Without explicit peer routing, the judge has no way to reach the planner. The peer connection declares this path and the TeamRuntime sets up the necessary subscriptions/address resolution.

### Communication Topology Enforcement

The team template doesn't just *suggest* communication patterns — it can *enforce* them. The `emissions` field restricts what signals a role can emit (maps to `protocol.canEmit` in the role definition). If a grinder tries to emit `HEALTH_CHECK`, it's blocked.

```yaml
  emissions:
    grinder: [WORKER_DONE]    # Grinders can ONLY emit WORKER_DONE
```

Similarly, the `subscriptions` field restricts what a role receives. The combination of emission restrictions + subscription filters means agents can only communicate through declared paths.

**Enforcement levels** (configured per team):

```yaml
communication:
  enforcement: strict    # strict | permissive | audit
```

- `strict` — Agents can only emit declared signals, only receive subscribed channels. Violations are blocked.
- `permissive` — All communication allowed, but undeclared patterns are logged as warnings.
- `audit` — All communication allowed, undeclared patterns recorded for analysis.

Default is `permissive` — teams work without declaring every signal, but you get visibility into undeclared communication for iterative refinement.

### Addressing Summary

How team template communication concepts map to macro-agent's existing addressing:

| Team Concept | MAP Address Type | Channel Type | Notes |
|---|---|---|---|
| Status flow (upstream) | Automatic via subtree | `subtree` | Already implemented by `setupDefaultSubscriptions` |
| Channel subscription | `{ scope: "channel_name" }` | `topic` | Agent subscribes to topic matching channel name |
| Signal emission | `emitStatus()` with signal details | `topic` routing | Details carry signal name for filtering |
| Peer direct message | `{ role: "target_role" }` | `role` | Resolved to agent IDs at send time |
| Broadcast to role | `{ role: "grinder" }` | `role` | Fan-out to all agents with that role |
| Hierarchical (parent) | `{ parent: true }` | `lineage` | Resolved relative to sender |
| Hierarchical (children) | `{ children: true }` | `subtree` | Resolved relative to sender |
| Broadcast to all | `{ broadcast: true }` | `broadcast` | All active agents |

### Example: Communication Flow in Self-Driving Team

```
Planner                    Judge                     Grinder (x N)
   │                         │                           │
   │ ── TASK_CREATED ──────▷ │ (via task_updates topic)  │
   │                         │                           │
   │ ── WORK_ASSIGNED ─────────────────────────────────▷ │ (via work_coordination topic)
   │                         │                           │
   │                         │                     ◁── WORKER_DONE ── │
   │                   ◁── WORKER_DONE ──────────────────│ (both subscribed)
   │                         │                           │
   │                         │── FIXUP_CREATED ──▷│      │ (peer direct)
   │ ◁── FIXUP_CREATED ─────│                           │
   │                         │                           │
   │ ── CONVERGENCE_CHECK ──▷│                           │ (peer direct)
   │                         │                           │
   │                         │── GREEN_SNAPSHOT ──▷ (health topic)
   │ ◁── GREEN_SNAPSHOT ─────│ (planner subscribes to health.METRIC_SNAPSHOT)
```

Key observations:
- Grinders emit WORKER_DONE to the `work_coordination` topic — both planner and judge receive it
- Judge sends FIXUP_CREATED directly to planner via role addressing (peer connection)
- Planner sends CONVERGENCE_CHECK directly to judge (peer connection)
- Status flows upstream automatically (grinder → planner via subtree subscription)
- Judge receives TASK_FAILED from `task_updates` topic but ignores TASK_CREATED

---

## Role Definitions

Roles in a team template extend macro-agent's `RoleDefinition`. The generic fields are portable; macro-agent specifics live under `macro_agent:`.

```yaml
# roles/planner.yaml
name: planner
extends: coordinator
display_name: "Planner"
description: "Continuously explores codebase and creates tasks"

# Capability composition (generic)
capabilities:
  add:
    - task.create
    - task.update
    - task.close
    - task.claim
  remove:
    - agent.spawn.integrator
    - agent.spawn.monitor

# Prompt (static file, no template rendering)
prompt: prompts/planner.md

# macro-agent specific enforcement
macro_agent:
  workspace:
    type: own
    branch_pattern: "planner/{agent-id}"
    cleanup_on_terminate: true
  lifecycle:
    type: daemon
    cascade_terminate: true
    self_cleanup: true
```

### Capability Composition

Roles can compose capabilities in two ways:

**1. Full replacement**:
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
    - task.claim
    - git.push
  remove:
    - agent.spawn.worker
```

The final capability set is: `(parent_capabilities + added) - removed`

---

## Prompts

Prompts are **static markdown files** in `prompts/`. No template rendering — they are included as-is in the system prompt.

The system prompt assembler combines prompts from multiple sources:

```
1. Base sections (identity, agent ID, task, lineage)    ← system-prompt.ts (always)
2. Role prompt (prompts/<role>.md)                       ← team template (if provided)
   OR role.systemPrompt field                            ← role definition fallback
   OR generated role guidance                            ← system-prompt.ts default
3. Interaction pattern guidance                          ← derived from macro_agent config
4. Tool listing                                          ← filtered by capabilities
5. Communication guidelines                              ← system-prompt.ts (always)
```

The role prompt file is the only part the team template author writes. It's static and self-contained — it describes what the role does, how it should think, what conventions to follow. The system injects the dynamic context (agent ID, task, available tools, interaction mode) around it.

### Interaction Pattern Injection

When `macro_agent.task_assignment.mode: pull` is set, the assembler injects a small operational section after the role prompt:

```
## Task Claiming

You operate in PULL mode. After completing a task:
1. Call done() with your results
2. Call claim_task() to get your next task
3. If no tasks available, wait briefly and retry
4. After extended idle, call done() to exit gracefully

Claim and execute independently — do not wait for instructions.
```

Similarly for trunk integration, session continuations, etc. These injected sections are small and operational. They don't overlap with the role prompt (which is about domain expertise and strategy).

---

## Tools and MCP Servers

For tools beyond macro-agent's built-in MCP tools, the team template can declare additional MCP servers to mount per role. This uses Claude Code's native MCP server configuration format.

```json
// tools/mcp-servers.json
{
  "planner": {
    "servers": [
      {
        "name": "project-knowledge",
        "command": "npx",
        "args": ["@org/project-knowledge-mcp"],
        "env": {
          "PROJECT_ROOT": "${MACRO_AGENT_CWD}"
        }
      }
    ]
  },
  "judge": {
    "servers": [
      {
        "name": "ci-status",
        "command": "npx",
        "args": ["@org/ci-status-mcp"],
        "env": {
          "CI_TOKEN": "${CI_TOKEN}"
        }
      }
    ]
  }
}
```

This is already supported by `AgentSpawnConfig.config.mcpServers` — the TeamRuntime just passes these through when spawning agents of that role.

Future iterations may support Claude Code's native skill/slash-command system for defining reusable tool+prompt bundles per role. For now, additional capabilities are expressed as MCP servers.

---

## Team Loading and Runtime

### TeamLoader

Reads and validates the template directory:

```
TeamLoader.load(teamName, basePath?)
  1. Resolve: .macro-agent/teams/<teamName>/
  2. Parse team.yaml, validate schema
  3. For each role in manifest:
     a. Load roles/<role>.yaml if present
     b. Resolve extends chain against RoleRegistry
     c. Compute final capabilities (parent + add - remove)
     d. Validate enforcement sections
  4. Load prompt files from prompts/
  5. Load tools/mcp-servers.json if present
  6. Return TeamManifest (fully resolved)
```

### TeamRuntime

Wires the loaded template into the running system:

```
TeamRuntime.initialize(manifest, services)
  1. Register roles into RoleRegistry (team layer)
  2. Set up communication topology:
     a. Register named channels as topics
     b. Configure per-role subscription templates
        (applied when agents of that role are spawned)
     c. Set up peer routing rules
     d. Configure enforcement level
  3. Compose system prompts:
     a. Load static prompt files
     b. Prepare interaction pattern injection sections
  4. Select IntegrationStrategy from registry
  5. Configure TaskBackend mode (push/pull)
  6. Store active team state for context propagation
```

### Agent Spawn with Team Context

When an agent is spawned within a team, the TeamRuntime intercepts the spawn and applies team configuration:

```
TeamRuntime.onAgentSpawn(role, spawnOptions)
  1. Look up role in team manifest
  2. Apply communication topology:
     a. Add topic subscriptions from manifest channels
     b. Register peer routes (if this role has peer connections)
     c. Subscribe to role channel (for role-addressed messages)
  3. Assemble system prompt:
     a. Base sections (identity, task)
     b. Role prompt file (static)
     c. Interaction pattern sections (auto-injected)
     d. Tool listing (capability-filtered)
     e. Communication guidelines
  4. Add MCP servers from tools/mcp-servers.json (if any for this role)
  5. Set team environment variables:
     MACRO_TEAM_NAME, MACRO_INTEGRATION_STRATEGY, MACRO_TASK_MODE
  6. Return enriched spawn options
```

### Team Bootstrap

After initialization, spawns the starting agents:

```
TeamRuntime.bootstrap()
  1. Spawn root agent per topology.root
  2. Spawn each companion per topology.companions
  3. Emit TEAM_STARTED event
  4. If scaling.min_workers > 0:
     Spawn initial worker pool
```

---

## Example: Self-Driving Team

### roles/planner.yaml

```yaml
name: planner
extends: coordinator
display_name: "Planner"
description: "Continuously explores the codebase, creates and prioritizes tasks"

capabilities:
  add: [task.claim]
  remove: [agent.spawn.integrator, agent.spawn.monitor]

prompt: prompts/planner.md

macro_agent:
  lifecycle:
    type: daemon
    cascade_terminate: true
```

### roles/grinder.yaml

```yaml
name: grinder
extends: worker
display_name: "Grinder"
description: "Claims and executes tasks autonomously"

capabilities:
  add: [task.claim, git.push]

prompt: prompts/grinder.md

macro_agent:
  lifecycle:
    type: ephemeral
    task_bound: false
    max_duration_ms: 3600000
    self_cleanup: true
```

### roles/judge.yaml

```yaml
name: judge
extends: monitor
display_name: "Judge"
description: "Periodically evaluates codebase health and creates fixup tasks"

capabilities:
  add: [exec.build, exec.test, exec.lint, task.create, task.update, git.branch.create, git.push]

prompt: prompts/judge.md

macro_agent:
  workspace:
    type: own
    branch_pattern: "judge/{agent-id}"
    cleanup_on_terminate: true
  lifecycle:
    type: event-driven
    parent_bound: false
```

### prompts/planner.md

```markdown
# Planner

You are the Planner. Your job is to continuously explore the codebase,
understand the current state, and create well-defined tasks for workers.

## How You Work

1. **Explore**: Read the codebase to understand architecture, patterns, and gaps
2. **Plan**: Break the objective into independent, parallelizable tasks
3. **Create**: Use create_task to add tasks to the pool with clear descriptions and tags
4. **Monitor**: Watch for completed/failed tasks and adjust the plan
5. **Repeat**: Planning is continuous — as work completes, create the next batch

## Planning Guidelines

- Each task should be completable in 5-30 minutes by a single worker
- Tag tasks with subsystem and type for filtered claiming
- Set dependencies (blockers) when ordering matters
- Prefer many small tasks over few large ones — parallelism is the goal
- Include enough context for a worker to start without re-exploring

## Constraints

- Do NOT instruct on things the model already knows (coding, testing, etc.)
- DO specify things specific to this codebase (conventions, build system, deploy pipeline)
- Constraints are more effective than instructions: "No TODOs, no partial implementations"

## Sub-Planners

For large subsystems (>10 tasks), spawn a sub-planner:
- spawn_agent({ role: "planner", task: "Plan the [subsystem] changes" })
- Sub-planners create tasks in the shared pool
- You maintain the high-level view
```

### prompts/judge.md

```markdown
# Judge

You periodically evaluate the health of the codebase and take corrective action.

## Evaluation Cycle

Every time you activate:
1. Run the build — check compilation
2. Run the test suite — check correctness
3. Run the linter — check code quality
4. If all pass: snapshot to green branch, emit GREEN_SNAPSHOT
5. If any fail: create fixup tasks with tag "fixup" and priority "critical"

## Green Branch

Maintain a clean snapshot at `green/latest`:
- Only update when build + tests + lint all pass
- This is the team's release candidate at any point in time
- Workers may be on a broken trunk — that's expected

## Creating Fixup Tasks

When you find failures:
- Create one task per distinct issue (don't bundle)
- Include the exact error output in the task description
- Tag with: ["fixup", "<subsystem>"]
- Set priority: critical
- Reference the failing file and test
```

---

## Example: Structured Team (Backward Compatibility)

The existing coordinator/integrator/worker pattern expressed as a team template:

```yaml
name: structured
description: "Traditional structured development"
version: 1

roles:
  - coordinator
  - integrator
  - worker
  - monitor

topology:
  root:
    role: coordinator
  spawn_rules:
    coordinator: [worker, integrator, monitor]
    integrator: [worker]
    worker: []
    monitor: []

communication:
  channels:
    work:
      signals: [WORK_ASSIGNED, WORKER_DONE, MERGE_REQUEST, MERGE_COMPLETE]
    health:
      signals: [HEALTH_CHECK, STALE_AGENT]
  subscriptions:
    coordinator:
      - channel: work
      - channel: health
    integrator:
      - channel: work
        signals: [MERGE_REQUEST, WORKER_DONE]
    worker:
      - channel: work
        signals: [WORK_ASSIGNED]
    monitor:
      - channel: health

macro_agent:
  task_assignment:
    mode: push
  integration:
    strategy: queue
  lifecycle:
    continuations:
      enabled: false
    scaling:
      scale_on: manual
```

No custom roles, no custom prompts — just built-in roles wired together. This demonstrates that team templates are a superset of the existing behavior.

---

## Open Questions

1. **Channel-level vs signal-level subscription granularity** — Is subscribing to a channel with signal filters the right granularity? Or should every signal be an independent topic? Channel grouping is cleaner for authoring but requires filtering at receive time. Signal-per-topic is cleaner at the routing layer but verbose in the manifest.

2. **Enforcement of emissions** — Should emission enforcement be at the routing layer (block the emit) or the audit layer (log but allow)? Strict enforcement could break agents that need to emit undeclared signals during error handling. Starting with `permissive` default and letting teams opt into `strict` seems right.

3. **Peer discovery for companions** — Companions are spawned as peers (no parent-child relationship). How do they discover each other? Options: (a) both subscribe to a shared team scope, (b) the bootstrap process shares agent IDs via environment variables, (c) role-based addressing (`{ role: "judge" }`) resolves to companion agents. Option (c) is cleanest — it's already supported by the router.

4. **Cross-team communication** — If multiple teams run simultaneously (e.g., a "frontend" team and a "backend" team), can they communicate? This maps to MAP's federated addressing but needs team-scoped routing rules. Deferred — single-team focus for now.

5. **Skill system evolution** — The current design uses static prompts + MCP servers for tool configuration. A future iteration could adopt Claude Code's native skill system (slash commands, tool bundles) for more structured reusable behaviors. The prompt file slot in role definitions is designed to be replaceable by a richer skill reference.
