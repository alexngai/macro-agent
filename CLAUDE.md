# macro-agent

A multi-agent orchestration system for spawning and managing hierarchical AI coding agents. Delegates messaging to **agent-inbox** and task management to **opentasks**. Exposes ACP (WebSocket) and REST API servers, supports cross-instance federation, and can serve as a compute backend for cognitive-core/OpenHive.

## Project Overview

macro-agent enables coordinated work across multiple AI agents with:
- **Role-based agents** (Worker, Integrator, Coordinator, Monitor, Analyst + custom team roles)
- **Team templates** for declarative multi-agent topologies (YAML config)
- **Stream-first workspace layer (V3)** — YAML-driven `TopologyPolicy` compiles role config into per-spawn workspace decisions; falls back to capability-based dispatch for programmatic callers
- **Pluggable `LandingStrategy`** — `merge-to-parent`, `queue-to-branch`, `direct-push`, `optimistic-push` built-ins; registered on WorkspaceManager, selected per-role via YAML
- **Pluggable `ConflictRecoveryStrategy`** — `defer`, `abandon`, `escalate`, `auto-resolve` (real git `-X` merge), `spawn-resolver` (LLM resolver agent)
- **Workspace isolation** via git worktrees + Change-Id tracking (powered by git-cascade 0.0.3+)
- **Messaging** via agent-inbox (structured inbox/outbox, threading, federation)
- **Task management** via opentasks (graph-based dependencies, providers, claiming)
- **Control socket** for MCP subprocess lifecycle RPC (NDJSON over UNIX socket)
- **Composite signal filtering and emission enforcement** for multi-team communication topology
- **Trigger system** with pluggable routing strategies (including AI router), wake management, cron, and webhooks
- **Agent detection** for discovering installed CLI coding agents (Claude Code, Codex, etc.)
- **Health check heartbeats** from MCP subprocesses to the control server
- **ACP protocol server** with WebSocket transport for external client integration
- **REST API server** for HTTP-based agent, task, team, and metrics management
- **Federation** for cross-instance communication between macro-agent instances
- **Cognitive-core backend** for serving as compute backend for OpenHive
- **Metrics collection** for point-in-time system observability

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      External Clients                       │
│             (CLI, ACP stdio, WebSocket, REST API)           │
└───────────────────────────┬─────────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────────┐
│                   boot-v2.ts (System Wiring)                │
│  1. AgentStore (SQLite)       6. TriggerSystemV2            │
│  2. InboxAdapter (embedded)   7. ControlServer              │
│  3. TasksAdapter (IPC)        8. Federation (optional)      │
│  4. RoleRegistry              9. REST API server (optional)  │
│  5. AgentManagerV2           10. ACP WebSocket (optional)    │
└───────────────────────────┬─────────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────────┐
│              TeamManagerV2 (optional, multi-team)            │
│  - Holds multiple TeamRuntimeV2 instances                   │
│  - Composite spawn interceptor (delegates per agent-team)   │
│  - Composite signal filters via addSignalFilter(id, fn)     │
│  - Composite emission validators via addEmissionValidator()  │
│  - Agent-to-team mapping (auto-registers children)          │
│  - Each TeamRuntimeV2:                                      │
│    - Loads team YAML, bootstraps root + companions          │
│    - Scoped inbox (scope = team name)                       │
│    - Per-team signal filter + emission validator             │
└───────────────────────────┬─────────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────────┐
│                  AgentManagerV2                              │
│  - Spawns agents via acp-factory (AgentFactory)             │
│  - Manages lifecycle (spawn, prompt, stop, continue, fork)  │
│  - Registers agents in agent-inbox on spawn                 │
│  - Workspace allocation via WorkspaceManager                │
│  - Cascade termination with change consolidation            │
│  - Spawn interceptor hook (set by TeamManager)              │
│  - Lifecycle listeners for child-auto-join-team             │
└──────────┬────────────────────────────────────┬─────────────┘
           │                                    │
┌──────────▼──────────┐              ┌──────────▼──────────────┐
│  Control Socket     │              │  MCP Server (per agent)  │
│  (UNIX socket)      │              │  runs as subprocess      │
│                     │              │                          │
│  Main process:      │◄─────────── │  cli/mcp.ts connects to: │
│  ControlServer      │  NDJSON RPC │  - ControlClient (spawn,  │
│  - spawn            │             │    terminate, hierarchy)  │
│  - terminate        │             │  - InboxClientAdapter     │
│  - get_agent        │             │    (send, check messages) │
│  - list_agents      │             │  - AgentStore (read-only) │
│  - get_children     │             │  - TasksAdapter (IPC)     │
│  - get_hierarchy    │             │                          │
│  - ping             │             │  Registers 5-8 tools:     │
│  - health_check     │             │  done, spawn_agent,       │
│                     │             │  stop_agent, get_hierarchy│
│  MCP subprocess:    │             │  inject_context,          │
│  ControlClient      │             │  claim_task, unclaim_task,│
│  - auto-reconnect   │             │  list_claimable_tasks     │
│  - heartbeat ping   │             │                          │
└─────────────────────┘              └──────────────────────────┘
           │
┌──────────┼──────────────────────────────────────┐
│          │                                      │
│  ┌───────▼───────┐  ┌──────────────┐  ┌────────▼───────────┐
│  │ TriggerSystem │  │  Workspace   │  │    Adapters        │
│  │               │  │  Worktrees   │  │                    │
│  │ Router with   │  │  Strategies  │  │  InboxAdapter      │
│  │  pluggable    │  │  (queue/     │  │  (embedded inbox   │
│  │  strategies   │  │   trunk/opt) │  │   + IPC server)    │
│  │ - direct      │  │  MergeQueue  │  │                    │
│  │ - role        │  │  git-cascade │  │  TasksAdapter      │
│  │ - head        │  │              │  │  (opentasks IPC)   │
│  │ - custom      │  │              │  │                    │
│  │               │  │              │  │  InboxClientAdapter │
│  │ WakeManager   │  │              │  │  (MCP subprocess   │
│  │ CronService   │  │              │  │   IPC client)      │
│  │ WebhookHandler│  │              │  │                    │
│  └───────────────┘  └──────────────┘  └────────┬───────────┘
│                                                │
│                    ┌───────────────────┬────────┘
│                    │                   │
│           ┌────────▼─────────┐  ┌──────▼───────────────┐
│           │   agent-inbox    │  │     opentasks        │
│           │  (embedded)      │  │  (IPC to daemon)     │
│           │                  │  │                      │
│           │  - Messaging     │  │  - Task graph        │
│           │  - Threading     │  │  - Dependencies      │
│           │  - IPC server    │  │  - Providers         │
│           │  - Federation    │  │  - Claiming          │
│           └──────────────────┘  └──────────────────────┘
└─────────────────────────────────────────────────────────┘
```

## Source Directory Structure

```
src/
├── acp/                     # ACP protocol server
│   ├── macro-agent.ts          # ACP-to-macro-agent bridge (session/new, session/prompt, extensions)
│   ├── websocket-server.ts     # WebSocket server for ACP clients
│   ├── session-mapper.ts       # Maps ACP sessions to agent states
│   ├── map-bridge.ts           # Bridges between MAP and macro-agent protocols
│   ├── types.ts                # Protocol type definitions (MacroAgentInitConfig, ACPError)
│   └── index.ts                # Public exports
│
├── adapters/                # Subsystem integration layer
│   ├── types.ts                # InboxAdapter + TasksAdapter interfaces
│   ├── inbox-adapter.ts        # Wraps agent-inbox (embedded, hybrid IPC)
│   ├── inbox-client-adapter.ts # IPC-only client for MCP subprocesses
│   ├── tasks-adapter.ts        # Wraps opentasks client (IPC to daemon)
│   ├── opentasks-daemon.ts     # Daemon lifecycle helper (start/stop/probe)
│   ├── federation.ts           # Cross-instance communication via federated inboxes
│   └── index.ts                # Public exports
│
├── agent/                   # Agent lifecycle
│   ├── agent-manager.ts        # AgentManager interface + SpawnInterceptor type
│   ├── agent-manager-v2.ts     # Implementation using adapters + AgentStore
│   ├── agent-store.ts          # Minimal SQLite store (agents + sessions tables)
│   ├── system-prompt.ts        # Agent system prompt generation
│   ├── types.ts                # SpawnAgentOptions, AgentFilter, MCPServerConfig, etc.
│   ├── prompts/                # Prompt fragments
│   │   ├── coordinator-signals.ts
│   │   └── index.ts
│   └── index.ts                # Public exports
│
├── agent-detection/         # CLI agent auto-detection
│   ├── types.ts                # CLIAgentDefinition, DetectedAgent, SpawnCommand
│   ├── detector.ts             # Scans PATH for known CLI agents
│   ├── registry.ts             # Registry of known agent definitions
│   ├── command-builder.ts      # Builds headless invocation commands
│   └── index.ts                # Public exports
│
├── api/                     # REST API server
│   ├── server.ts               # HTTP endpoints for agents, tasks, teams, metrics
│   ├── types.ts                # ApiServer, ApiServerConfig interfaces
│   └── index.ts                # Public exports
│
├── auth/                    # Authentication
│   ├── token.ts                # AgentTokenManager for per-agent auth tokens
│   └── index.ts                # Public exports
│
├── boot-v2.ts               # System wiring entry point (single boot function)
│
├── cli/                     # Command-line interfaces
│   ├── index.ts                # multiagent-cli commands (start, chat, status, etc.)
│   ├── acp.ts                  # multiagent ACP stdio mode
│   ├── mcp.ts                  # multiagent-mcp subprocess entry point
│   ├── parse-args.ts           # Argument parsing helpers
│   └── stable-instance-id.ts   # Stable instance ID generation
│
├── cognitive/               # cognitive-core backend integration
│   ├── macro-agent-backend.ts  # Implements cognitive-core AgentBackend interface
│   ├── session-converter.ts    # Converts sessions between cognitive-core and macro-agent formats
│   ├── workspace-handler.ts    # Workspace operations for cognitive backend
│   ├── analyst-role.ts         # Analyst role definition for cognitive system
│   ├── types.ts                # CognitiveAgentSession, CognitiveBatchConfig, etc.
│   └── index.ts                # Public exports
│
├── config/                  # Project configuration
│   ├── project-config.ts       # .multiagent/config.json loader
│   └── index.ts                # Public exports
│
├── control/                 # Control socket (MCP subprocess ↔ main process)
│   ├── control-server.ts       # NDJSON server, dispatches to AgentManager
│   ├── control-client.ts       # NDJSON client with auto-reconnect
│   ├── types.ts                # ControlCommand, ControlResponse types
│   └── index.ts                # Public exports
│
├── index.ts                 # Public library exports
│
├── lifecycle/               # Agent lifecycle management
│   ├── handlers-v2.ts          # Role-specific done() handlers (using adapters)
│   ├── cascade.ts              # Cascade termination with change consolidation
│   ├── cleanup.ts              # Workspace cleanup helpers (commitChanges)
│   ├── types.ts                # DoneArgs, DoneResult, LifecycleContext, CascadeOptions
│   └── index.ts                # Public exports
│
├── mcp/                     # Model Context Protocol (per-agent tools)
│   ├── mcp-server-v2.ts        # Factory: registers 5 core + 3 claim tools
│   ├── tools/
│   │   └── done-v2.ts          # done() tool using adapters
│   ├── types.ts                # ToolContext, HierarchyNode, MCPToolError
│   └── index.ts                # Public exports
│
├── metrics/                 # Metrics collection and reporting
│   ├── metrics.ts              # collectMetrics() — point-in-time agent/task/system snapshot
│   ├── types.ts                # AgentMetrics, TaskMetrics, SystemMetrics, MetricsSnapshot
│   └── index.ts                # Public exports
│
├── roles/                   # Role system
│   ├── types.ts                # RoleDefinition, RoleRegistry, Capability types
│   ├── capabilities.ts         # Capability constants (AGENT_CAPABILITIES, WORKSPACE_CAPABILITIES)
│   ├── registry.ts             # DefaultRoleRegistry with resolution + tool filtering
│   ├── config-loader.ts        # Load role definitions from YAML files
│   ├── builtin/                # Built-in role definitions
│   │   ├── worker.ts
│   │   ├── integrator.ts
│   │   ├── coordinator.ts
│   │   ├── monitor.ts
│   │   ├── generic.ts
│   │   └── index.ts
│   └── index.ts                # Public exports
│
├── store/                   # Shared type definitions (no runtime implementation)
│   ├── types/
│   │   ├── agents.ts           # Agent, AgentState, StopReason
│   │   ├── tasks.ts            # Task, TaskStatus
│   │   ├── events.ts           # Event, EventType, EventSource
│   │   ├── messages.ts         # QueuedMessage, Subscription types
│   │   ├── primitives.ts       # AgentId, TaskId, EventId, SessionId, Timestamp
│   │   └── index.ts            # Re-exports all types
│   └── index.ts                # Public exports
│
├── teams/                   # Team template system
│   ├── types.ts                # TeamManifest, TeamTopology, TeamCommunication
│   ├── team-loader.ts          # YAML loading, role resolution, validation
│   ├── team-runtime-v2.ts      # Per-team runtime (scoped inbox, signal filtering)
│   ├── team-manager-v2.ts      # Multi-team orchestrator (composite filters)
│   ├── seed-defaults.ts        # Seed default team templates
│   └── index.ts                # Public exports
│
├── trigger/                 # Trigger system
│   ├── trigger-system-v2.ts    # Factory + TriggerRouterV2 with routing strategies
│   ├── types.ts                # TriggerEvent, TriggerSource, RoutingHint types
│   ├── queue/                  # Per-agent system event queue
│   │   ├── system-event-queue.ts
│   │   ├── types.ts
│   │   └── index.ts
│   ├── wake/                   # Wake manager
│   │   ├── wake-manager.ts     # Heartbeat + coalesce + inject→interrupt→prompt
│   │   ├── types.ts
│   │   └── index.ts
│   ├── strategies/             # Pluggable routing strategies
│   │   └── ai-router.ts       # AI-powered routing via temporary Claude session
│   ├── sources/                # Trigger event sources
│   │   ├── cron/
│   │   │   ├── cron-service.ts
│   │   │   ├── scheduler.ts
│   │   │   ├── types.ts
│   │   │   └── index.ts
│   │   ├── webhook/
│   │   │   ├── webhook-handler.ts
│   │   │   ├── types.ts
│   │   │   └── index.ts
│   │   └── index.ts
│   └── index.ts                # Public exports
│
└── workspace/               # Workspace isolation — V3 stream-first + legacy role-shaped
    ├── workspace-manager.ts    # WorkspaceManager implementation (legacy + V3 surfaces)
    ├── git-cascade-adapter.ts  # Wraps git-cascade tracker (40+ primitives surfaced)
    ├── config.ts               # GitCascadeConfig + pool config
    ├── types.ts                # WorkspaceManager interface (legacy + V3), events
    ├── types-v3.ts             # V3 types: Principal, StreamSpec, LandingStrategy, etc.
    ├── yaml-schema.ts          # Zod schema for `macro_agent.workspace`
    ├── topology/               # TopologyPolicy — compiles YAML → spawn decisions
    │   ├── types.ts            # TopologyPolicy, WorkspaceDecision, contexts
    │   ├── yaml-driven.ts      # YamlDrivenTopology (primary)
    │   ├── no-workspace.ts     # NoWorkspaceTopology (null policy)
    │   └── index.ts
    ├── landing/                # LandingStrategy — pluggable merge/push algorithms
    │   ├── merge-to-parent.ts  # mergeStream into parent + optional cascadeRebase
    │   ├── queue-to-branch.ts  # git-cascade built-in merge queue
    │   ├── direct-push.ts      # rebase + push
    │   ├── optimistic-push.ts  # direct-push + validation event
    │   └── index.ts            # registerBuiltinLandingStrategies()
    ├── recovery/               # ConflictRecoveryStrategy
    │   ├── types.ts            # ConflictContext, ConflictResolution
    │   ├── defer.ts            # Leave conflict record; no-op
    │   ├── abandon.ts          # Abandon the conflicted stream
    │   ├── escalate.ts         # Pause + notify human
    │   ├── auto-resolve.ts     # Replay merge with -X ours|theirs|union
    │   ├── spawn-resolver.ts   # Spawn a resolver agent (requires AgentManager)
    │   └── index.ts            # buildBuiltinRecoveryRegistry()
    ├── pool/                   # Worktree pool management
    │   ├── worktree-pool.ts
    │   ├── types.ts
    │   └── index.ts
    ├── merge-queue/            # @deprecated — legacy SQLite-backed queue,
    │   ├── merge-queue.ts      #   duplicates git-cascade's built-in. Use
    │   ├── schema.ts           #   GitCascadeAdapter.addToMergeQueue for
    │   ├── types.ts            #   new code (via QueueToBranchStrategy).
    │   └── index.ts
    ├── strategies/             # @deprecated — old IntegrationStrategy.
    │   ├── types.ts            #   Superseded by workspace/landing/.
    │   ├── queue.ts            #   Scheduled for removal once all teams
    │   ├── trunk.ts            #   migrate to macro_agent.workspace YAML.
    │   ├── optimistic.ts
    │   └── index.ts
    └── index.ts                # Public exports
```

## Key Concepts

### Subsystem Architecture

macro-agent delegates two major concerns to external subsystems:

- **agent-inbox**: All messaging (send/receive, threading, conversations, federation). Embedded in-process for zero-latency events, with IPC server for agent MCP subprocesses.
- **opentasks**: Task management for pull-mode workflows (claiming, dependencies, state transitions). Connected via IPC to opentasks daemon (auto-started if needed). Note: AgentManagerV2 does **not** create opentasks nodes on spawn or transition them on terminate — that was removed to avoid polluting the task graph with per-session noise. Opentasks is used only for explicit task operations (pull-mode claim/unclaim/list, team task coordination).

macro-agent owns: agent lifecycle, workspace isolation, team topology, role system, trigger/wake, control socket.

### Adapter Layer

Three adapters form the integration boundary:

| Adapter | Module | Used By | Purpose |
|---------|--------|---------|---------|
| **InboxAdapter** | `adapters/inbox-adapter.ts` | Main process | Embeds agent-inbox, owns composite signal filters + emission validators |
| **InboxClientAdapter** | `adapters/inbox-client-adapter.ts` | MCP subprocesses | IPC client to main process's agent-inbox |
| **TasksAdapter** | `adapters/tasks-adapter.ts` | Both | IPC client to opentasks daemon |

InboxAdapter key details:
- `send()`: Runs emission validators (all must pass) before forwarding to agent-inbox
- `onDelivery()`: Runs signal filters (AND logic — all must return true) before invoking handlers
- Multi-team support: `addSignalFilter(id, fn)` / `addEmissionValidator(id, fn)` for named composite hooks
- Single-team compat: `setSignalFilter(fn)` installs under the "default" key

### Control Socket

NDJSON-over-UNIX-socket RPC between MCP subprocesses and the main process. Separates the **control plane** (lifecycle operations) from the **data plane** (messaging via agent-inbox IPC).

| Component | Module | Process |
|-----------|--------|---------|
| **ControlServer** | `control/control-server.ts` | Main process |
| **ControlClient** | `control/control-client.ts` | MCP subprocess |

Commands: `spawn`, `terminate`, `get_agent`, `list_agents`, `get_children`, `get_hierarchy`, `ping`, `health_check`

Health check heartbeats:
- MCP subprocesses send periodic `health_check` commands with `agentId` and `mcpPid`
- ControlServer tracks `lastSeen` timestamps per agent
- Enables detection of stale/crashed MCP subprocesses

ControlClient features:
- Auto-reconnect with exponential backoff on socket close
- Configurable timeout (default 30s)
- Sequence-numbered request/response correlation

### AgentStore

Minimal SQLite store (`~/.macro-agent/agents.db`) with two tables: `agents` and `sessions`. Replaces the heavy EventStore + TinyBase materialized views. Simple CRUD, no event sourcing. Accessed read-only by MCP subprocesses via SQLite WAL mode.

### Teams

Teams are declarative YAML configurations that define multi-agent topologies.

- **TeamLoader** (`team-loader.ts`): Parses `team.yaml`, resolves role inheritance, validates topology
- **TeamRuntimeV2** (`team-runtime-v2.ts`): Per-team runtime — registers roles, bootstraps root + companions, installs scoped signal filter + emission validator on InboxAdapter via named keys
- **TeamManagerV2** (`team-manager-v2.ts`): Multi-team orchestrator — holds all TeamRuntimeV2 instances, installs a composite spawn interceptor on AgentManager, maintains agent-to-team mapping, auto-registers children in parent's team via lifecycle listener
- **Scope**: Each team gets its own agent-inbox scope (scope = team name)
- **Composite filters**: Multiple teams install named signal filters and emission validators on the same InboxAdapter. The adapter evaluates all filters with AND logic (all must pass) and all validators (first rejection wins).

### Roles

Agents are assigned roles that determine their capabilities:

| Role | Purpose | Key Capabilities |
|------|---------|------------------|
| **Worker** | Execute tasks in isolated workspace | File I/O, git operations, task completion |
| **Integrator** | Manage merge queue and resolve conflicts | Merge operations, branch management |
| **Coordinator** | Orchestrate workers and manage tasks | Spawn agents, assign tasks, broadcast |
| **Monitor** | Health monitoring and alerts | Read-only access, activity watching |
| **Generic** | Base role for custom extensions | Minimal capabilities |

Teams can define custom roles (e.g., planner, grinder, judge) that extend built-in roles via `extends` in `roles/<name>.yaml`. Tool filtering is role-based — `isToolAllowedForRole()` checks the role's capabilities before registering each MCP tool.

### Workspace Layer (V3 Stream-First)

The workspace layer went through a v3 redesign. Two paths coexist:

**V3 path (YAML-driven, recommended for teams):**
- `macro_agent.workspace` block in `team.yaml` declares per-role workspace decisions
- `TopologyPolicy` (`workspace/topology/`) compiles YAML → `WorkspaceDecision` per spawn
- `LandingStrategy` (`workspace/landing/`) finalizes work at `done()` time
- `ConflictRecoveryStrategy` (`workspace/recovery/`) dispatches on conflicts
- Auto-wired by `TeamManagerV2.startTeam()` when workspace config is present

**Legacy path (programmatic / capability-based):**
- Direct `agentManager.spawn({ capabilities: ['workspace.worktree'|'workspace.stream'|'workspace.integrate'], streamId, streamConfig })`
- `capabilityBasedDispatch` in `AgentManagerV2` routes to role-shaped `WorkspaceManager` methods (`createWorkerWorkspace`, etc.)
- Retained for programmatic callers (tools, libraries, tests that don't load team YAML)

**Dispatch priority in `AgentManagerV2.createWorkspaceForRole()`:**
1. If `topologyPolicy` is set → V3 path via `executeWorkspaceDecision`
2. Else → `capabilityBasedDispatch` using role-shaped methods

### TopologyPolicy (V3)

`TopologyPolicy` (`workspace/topology/types.ts`) is the contract for compiling
team YAML into per-spawn workspace decisions. Three built-ins:

| Policy | Module | Purpose |
|---|---|---|
| **YamlDrivenTopology** | `topology/yaml-driven.ts` | Primary; reads `macro_agent.workspace` |
| **NoWorkspaceTopology** | `topology/no-workspace.ts` | Null policy; returns `share-parent-cwd` for all |

Hook methods:
- `onTeamStart(ctx)` → creates team-root stream if any role needs it
- `onAgentSpawn(ctx)` → returns `WorkspaceDecision` (`none` / `share-parent-cwd` / `share-with-agent` / `attach-to-stream` / `new-stream`)
- `onAgentComplete(ctx)` → deallocates the agent's worktree
- `onTeamStop(ctx)` → applies `on_team_complete` action (`keep` / `merge_to_main` / `abandon`)

The YAML schema (`workspace/yaml-schema.ts`) supports:
- `workspace`: `none` / `attach_to_team_root` / `share_with_agent` / `share_parent_cwd` / `new_stream`
- `stream_lineage`: `from_team_root` / `fork_from_team_root` / `fork_from_parent` / `independent` / `track_existing_branch`
- `allocation`, `landing`, `landing_config`, `on_conflict`, `on_conflict_recovery`, `conflict_recovery_config`, `cascade_on_parent_update`, `on_parent_advanced`, `share_with`, `track_branch`, `capabilities`

### LandingStrategies (V3)

`LandingStrategy` (`workspace/types-v3.ts`) is how a streamed agent finalizes
its work. Registered on `WorkspaceManager` via `registerLandingStrategy(s)`
and selected per-role via YAML `landing:`. Four built-ins registered by
`registerBuiltinLandingStrategies()`:

| Strategy | Module | Semantics |
|---|---|---|
| **merge-to-parent** | `landing/merge-to-parent.ts` | `mergeStream(source → parent)`, optional `cascadeRebase` via `strategyConfig.cascade: true` |
| **queue-to-branch** | `landing/queue-to-branch.ts` | `GitCascadeAdapter.addToMergeQueue(streamId, targetBranch)` — drained by integrator-capable agents |
| **direct-push** | `landing/direct-push.ts` | Rebase + `git push` with retries (trunk flow) |
| **optimistic-push** | `landing/optimistic-push.ts` | `direct-push` + emits validation event |

`LandingContext` carries: `agentId`, `streamId`, `sourceWorktree`,
`targetStreamId`, `strategyConfig` (from YAML `landing_config`), and a back-
reference to `WorkspaceManager`.

### Conflict Recovery (V3)

When a landing returns a conflict, the agent's `done()` flow dispatches to a
`ConflictRecoveryStrategy` (`workspace/recovery/types.ts`) selected via YAML
`on_conflict_recovery:` or team default. Five built-ins:

| Strategy | Mode | Behavior |
|---|---|---|
| **defer** | sync | No-op — leaves conflict record for later manual recovery |
| **abandon** | sync | `abandonStream(streamId)` — throwaway work |
| **escalate** | async | `pauseStream` + emit escalation — awaits external `resolve_conflict` MCP call |
| **auto-resolve** | sync | Replays merge with `-X ours|theirs|union` in the agent's worktree, commits, notifies `workspaceManager.resolveConflict` |
| **spawn-resolver** | async | Spawns a resolver agent on the conflicted stream; awaits `conflict:resolved` event or timeout |

`spawn-resolver` requires `AgentManager` injection (not in default registry;
register via `createSpawnResolverStrategy({ agentManager })`). Max concurrent
resolvers per stream is configurable; timeout falls back to `escalated`.

`ConflictContext` carries: `conflictId`, `streamId`, `paths`, `operation`
(`merge` | `sync` | `rebase` | `cascade`), `worktree?` (required for
`auto-resolve`), `landingAgentId?`, `recoveryDepth`, `strategyConfig`.

### Workspace Isolation (shared across paths)

Each streamed agent gets an isolated git worktree via `WorkspaceManager`,
backed by git-cascade's `MultiAgentRepoTracker`. V3 agents use
`allocateWorktree({ agentId, streamId })`; legacy agents use role-specific
`createWorkerWorkspace` / `createIntegratorWorkspace` / `createCoordinatorWorkspace`.
Both produce the same underlying git worktree structure.

Change-Id tracking via `commitChanges({ agentId, streamId, worktree, message })`
(v3) — each commit gets a stable `Change-Id: c-xxxxxxxx` trailer that survives
rebases. Legacy callers that use raw `git commit` bypass this tracking.

### MCP Tool Surface

Each agent gets tools from three sources:

| Source | Tools | Mount method |
|--------|-------|-------------|
| **macro-agent** (MCPServerV2) | `done`, `spawn_agent`, `stop_agent`, `get_hierarchy`, `inject_context` | Built-in MCP server (stdio) |
| **macro-agent** (MCPServerV2, pull mode) | `claim_task`, `unclaim_task`, `list_claimable_tasks` | Built-in MCP server (gated by `task.claim` capability) |
| **agent-inbox** | `send_message`, `check_inbox`, `read_thread`, `list_agents` | IPC socket (separate MCP server) |
| **opentasks** | `task`, `link`, `annotate`, `query` | IPC socket (separate MCP server) |

Tool registration in MCPServerV2 is role-gated: `shouldRegister(toolName)` checks `isToolAllowedForRole()` before calling `server.registerTool()`.

### Trigger System

Routes external events and inbox delivery events to agents via pluggable routing strategies.

**Components:**
- **TriggerRouterV2**: Pluggable strategy-based router
- **WakeManager**: Heartbeat + coalesce + inject/interrupt/prompt fallback chain
- **SystemEventQueue**: Per-agent event queue with priority and deduplication
- **CronService**: Time-based agent activation via cron schedules
- **WebhookHandler**: HTTP endpoint triggers

**Routing Strategies** (pluggable via `RoutingStrategy` interface):

| Strategy | Description | Selection |
|----------|-------------|-----------|
| **direct** | Route to a specific agent by ID | `routing.target.type === "agent"` |
| **role** | Route to all agents with a given role | `routing.target.type === "role"` |
| **head** | Route to all running root agents (default) | Fallback when no strategy matches |
| **custom** | User-defined strategies via `registerStrategy()` | By name or `canHandle()` |

Strategy resolution order: explicit `strategyName` > first `canHandle()` match > default strategy.

**Inbox-to-Wake integration:**
- `InboxAdapter.onDelivery` fires on every message delivery
- Importance is mapped to wake action: `urgent` → interrupt/wake, `high` → inject/wake, `normal` → queue/wake, `low` → queue
- Events are enqueued in SystemEventQueue, then WakeManager handles delivery

### Agent Detection

The `agent-detection/` module discovers installed CLI coding agents on the system (e.g., Claude Code, Codex, Goose). It:
- Scans PATH for known binaries
- Extracts version information
- Builds headless invocation commands with proper flags
- Supports custom agent definitions via `additionalAgents` config

### ACP Protocol Server

The `acp/` module bridges the Agent Client Protocol (ACP) to macro-agent's V2 services:
- **MacroAgent** (`macro-agent.ts`): Implements the ACP Agent interface — maps `session/new` → `agentManager.getOrCreateHeadManager()`, `session/prompt` → streaming `agentManager.prompt()`, and extension methods for spawn/mount/fork/hierarchy/tasks
- **WebSocketACPServer** (`websocket-server.ts`): Optional WebSocket transport for ACP clients (enabled via `config.acp.enabled` in boot)
- **SessionMapper** (`session-mapper.ts`): Maps ACP sessions to macro-agent agent states
- **MAPBridge** (`map-bridge.ts`): Bridges MAP protocol to macro-agent for external observability

### MAP Capabilities

Capabilities are declared at two levels:

**Connection-level** (sidecar, `src/map/sidecar.ts`): Declared when the sidecar connects to the OpenHive MAP hub. These describe the swarm's general capabilities:

- `messaging: { canSend: true, canReceive: true }` — can exchange MAP scope messages
- `mail: { canCreate: true, canJoin: true, canViewHistory: true }` — supports agent-inbox conversations (enables Mail chat mode in OpenHive)
- `trajectory: { canReport: true, canServeContent: false }` — reports checkpoints (does not serve content on demand)
- `tasks: { canCreate, canAssign, canUpdate, canList }` — task management

**Per-agent** (lifecycle bridge, `src/map/lifecycle-bridge.ts`): Declared when agents register on the hub via `map/agents/register`. ACP is per-agent because you connect to a specific agent, not to the swarm:

- **Coordinators** (head managers): `protocols: ['acp']`, `acp: { version: '2024-10-07' }`, `messaging: { canReceive: true }` — enables ACP streaming chat in OpenHive
- **Workers**: `messaging: { canReceive: true }` — no ACP

The hub aggregates per-agent capabilities into the swarm record (union semantics). OpenHive resolves the ACP target by finding the first registered agent with `protocols: ['acp']` on the live connection.

The lifecycle bridge uses `map/agents/register` (not `map/agents/spawn`) to register agents on the hub, because `spawn` drops the `capabilities` field. The bridge tracks MAP-assigned ULIDs (`mapId`) for correct unregistration.

Message delivery is **push-based**: `InboxAdapter.onDelivery()` fires immediately on message receipt, the trigger system maps importance → wake action, and `WakeManager` injects into the active session via inject/interrupt/prompt fallback chain.

### REST API Server

The `api/` module provides HTTP endpoints for external integration:
- Agent CRUD and listing
- Task operations
- Team management
- Metrics endpoint (powered by `metrics/` module)
- Enabled via `config.api.enabled` in boot, configurable host/port

### Cognitive-Core Backend

The `cognitive/` module implements cognitive-core's `AgentBackend` interface, enabling macro-agent to serve as a compute backend for OpenHive:
- **MacroAgentBackend** (`macro-agent-backend.ts`): Spawns analyst agents, tracks sessions, manages timeouts, reports completion via callbacks and InboxAdapter
- **AnalystRole** (`analyst-role.ts`): Custom role definition for cognitive analysis tasks
- **SessionConverter** (`session-converter.ts`): Converts between cognitive-core and macro-agent session formats
- **WorkspaceHandler** (`workspace-handler.ts`): Workspace operations for cognitive backend tasks
- Design principle: the swarm is pure compute — receive task, execute agent, return result. Atlas, trajectory extraction, and team coordination are handled by OpenHive.

### Federation

The `adapters/federation.ts` module enables cross-instance communication:
- Multiple macro-agent instances federate their embedded agent-inbox instances
- Federated addressing: `agentId@systemId` (e.g., `coordinator@dev-laptop`)
- Cross-instance spawn via convention-based inbox messages (`remote_spawn_request` events)
- Trust policy: configurable `allowedSystems` whitelist
- Setup via `config.federation` in boot, cleanup on shutdown

### Metrics

The `metrics/` module provides point-in-time system observability:
- `collectMetrics()` gathers agent, task, and system metrics into a `MetricsSnapshot`
- Agent metrics: total/running/stopped/failed counts, unhealthy agent detection
- Task metrics: total/open/in-progress/closed counts
- System metrics: uptime, health check status
- Used by the REST API server's `/metrics` endpoint

### AI Router Strategy

The `trigger/strategies/ai-router.ts` provides an AI-powered routing strategy:
- Spawns a temporary Claude session to make routing decisions for trigger events
- Falls back to "head" strategy if spawning fails or times out
- Selected when `routing.target.type === "ai-router"`
- Expensive — intended for events that genuinely need intelligent routing

### Communication Topology

Teams configure communication via:
- **Channels**: Named topics with defined signals
- **Subscriptions**: Per-role channel subscriptions with optional signal filters
- **Peer routing**: Directional connections with per-peer signal filters
- **Emissions**: Per-role allowed signal lists
- **Enforcement**: `strict` (reject), `permissive` (warn), `audit` (log)

All filtering is adapter-side — agent-inbox is a dumb pipe, macro-agent enforces policy via composite filters on the InboxAdapter.

### Done Handler Flow

1. Agent calls `done()` MCP tool with status + summary
2. MCPServerV2 dispatches to `createDoneHandlerV2()` which builds a handler using `HandlerDepsV2` (InboxAdapter, TasksAdapter, AgentManager)
3. Role-specific handler runs:
   - **Worker / V3 streamed agent**: Commits changes via `commitChanges` (Change-Id tracked), invokes `LandingStrategy.land()` per YAML config, emits `work:done` signal
   - **Coordinator**: Emits completion signal, cascade-terminates children if needed
   - **Monitor**: Emits health report
4. If landing returns a conflict, the recovery dispatcher selects a `ConflictRecoveryStrategy` per role's `on_conflict_recovery` YAML (or team default); strategy runs sync or async
5. If `shouldTerminate`, AgentManagerV2 handles termination: `TopologyPolicy.onAgentComplete` deallocates the worktree; cascade termination consolidates changes for child agents

## Conventions

### File Organization

- **One module per file** - Export from index.ts
- **Tests colocated** - `__tests__/` directory alongside source
- **Types separate** - `types.ts` for interface definitions

### Naming

- **camelCase** for functions and variables
- **PascalCase** for types and classes
- **kebab-case** for file names
- **SCREAMING_SNAKE** for constants

### Testing

- **Unit tests**: `*.test.ts` — Fast tests, mixed real-git and mocked dependencies (~58 test files, ~990 tests)
- **E2E tests**: `*.e2e.test.ts` — Full system tests gated by `RUN_E2E_TESTS=true`

Run tests:
```bash
npm test                              # Run all unit tests (watch mode)
npx vitest run                        # Run all unit tests (single run)
npm run test:e2e                      # E2E tests (mocked agent sessions)
npm run test:e2e-full-agents          # E2E tests with real agent spawning (RUN_FULL_AGENT_TESTS=true)
```

E2E test files (selected):
- `agent-lifecycle.e2e.test.ts` — Spawn, prompt, terminate flows
- `workspace-lifecycle.e2e.test.ts` — Legacy capability-based workspace path (programmatic API)
- `workspace-v3.e2e.test.ts` — V3 YAML-driven path: peer swarm, merge-to-parent landing, conflict recovery, legacy regression guard
- `cognitive-workspace.e2e.test.ts` — Cognitive-core backend workspace operations
- `done-scenarios.e2e.test.ts` — Done handler scenarios per role
- `trigger-wake.e2e.test.ts` — Trigger delivery and wake flows
- `resume-continue.e2e.test.ts` — Session continuation
- `pull-mode.e2e.test.ts` — Task claiming workflows
- `opentasks-integration.e2e.test.ts` — TasksAdapter integration
- `live-agent.e2e.test.ts` — Full agent with real Claude Code (requires `RUN_FULL_AGENT_TESTS`)
- `conflict-resolution-git.e2e.test.ts` — Git merge conflict handling
- `real-git-operations.e2e.test.ts` — Real git worktree operations

### Error Handling

- Use typed errors with codes (`AgentManagerError`, `MCPToolError`, `AgentDetectionError`)
- Graceful degradation over hard failures (e.g., opentasks daemon not available is non-fatal)
- Log warnings for recoverable issues

## Common Tasks

### Adding a New MCP Tool (macro-agent specific)

1. Define Zod schema in `src/mcp/mcp-server-v2.ts` (or separate file for complex tools)
2. Add `server.registerTool()` call inside `createMCPServerV2()`, gated by `shouldRegister(toolName)`
3. If the tool needs lifecycle access, use `agentManager` (via ControlClient in subprocess, or directly in main process)
4. If the tool needs messaging, use `inboxAdapter.send()`

### Adding a New Built-in Role

1. Create `src/roles/builtin/your_role.ts`
2. Define `RoleDefinition` with capabilities
3. Register in `src/roles/builtin/index.ts`
4. Update `isToolAllowedForRole()` in `src/roles/registry.ts` if needed

### Adding a Team Role (via YAML)

1. Create `.multiagent/teams/<team>/roles/<role>.yaml` with `extends` base role
2. Add `capabilities_add`/`capabilities_remove` as needed
3. Create `.multiagent/teams/<team>/prompts/<role>.md` for custom prompt
4. Reference the role in `team.yaml` topology and communication sections

### Adding a Routing Strategy

1. Implement the `RoutingStrategy` interface from `src/trigger/trigger-system-v2.ts`
2. Define `name`, `route()`, and optionally `canHandle()`, `initialize()`, `cleanup()`
3. Register with `triggerSystem.router.registerStrategy(strategy)`
4. Optionally set as default: `triggerSystem.router.setDefaultStrategy(name)`

### Adding a Landing Strategy (V3)

1. Implement the `LandingStrategy` interface from `src/workspace/types-v3.ts`
2. Define `name`, `land(ctx)`, optionally `canLand(ctx)`, `initialize()`, `close()`
3. Register via `workspaceManager.registerLandingStrategy(new YourStrategy())` (typically at boot after built-ins)
4. Reference from team YAML: `roles.<role>.landing: your_strategy_name`; pass config via `landing_config`

### Adding a Conflict Recovery Strategy (V3)

1. Implement the `ConflictRecoveryStrategy` interface from `src/workspace/recovery/types.ts`
2. Define `name`, `mode` (`sync` | `async`), `recover(ctx)`, optionally `canHandle(ctx)`
3. If the strategy needs `AgentManager` (like `spawn-resolver`), expose a factory that accepts it
4. Register into the team's recovery registry; selected per-role via `on_conflict_recovery:` or team default

### Adding a Topology Policy (V3)

1. Implement the `TopologyPolicy` interface from `src/workspace/topology/types.ts`
2. Define `onTeamStart`, `onAgentSpawn`, `onAgentComplete`, `onTeamStop`
3. Return `WorkspaceDecision` values from `onAgentSpawn` (`none` / `share-parent-cwd` / `share-with-agent` / `attach-to-stream` / `new-stream`)
4. Inject via `agentManager.setTopologyPolicy(policy)` — or have `TeamManagerV2.startTeam` auto-wire from YAML via `YamlDrivenTopology`

### Adding a Control Command

1. Add the command type to `ControlCommand` union in `src/control/types.ts`
2. Handle the command in `ControlServer.handleCommand()` in `src/control/control-server.ts`
3. Add typed method on `ControlClient` in `src/control/control-client.ts`

## Environment Variables

### Set by boot-v2 / system config

| Variable | Description | Default |
|----------|-------------|---------|
| `MACRO_BASE_DIR` | Base directory for data storage | `~/.macro-agent` |
| `MACRO_WORKSPACE_POOL_SIZE` | Max concurrent workspaces | `10` |
| `MACRO_MERGE_QUEUE_DB` | Merge queue SQLite path | `:memory:` |
| `MACRO_TEAMS` | Comma-separated team templates to auto-start | -- |
| `MACRO_AGENT_HOME` | Alternative base directory (used by CLI clear) | `~/.macro-agent` |

### Boot config options (BootV2Config)

| Option | Description | Default |
|--------|-------------|---------|
| `api.enabled` | Start REST API server | `false` |
| `api.port` | REST API port | -- |
| `acp.enabled` | Start ACP WebSocket server | `false` |
| `acp.port` | ACP WebSocket port | -- |
| `federation.systemId` | Unique instance ID for federation | -- |
| `federation.peers` | Peer instances to federate with | `[]` |
| `federation.trust.allowedSystems` | Trusted system ID whitelist | -- |

### Injected into MCP subprocesses (by AgentManagerV2)

| Variable | Description |
|----------|-------------|
| `MACRO_AGENT_ID` | ID of the calling agent |
| `MACRO_PARENT_ID` | Parent agent ID |
| `MACRO_TASK_ID` | Task ID |
| `MACRO_AGENT_CWD` | Working directory |
| `MACRO_PERMISSION_MODE` | Permission mode |
| `MACRO_SESSION_ID` | Session ID |
| `MACRO_STREAM_ID` | Workspace stream ID |
| `MACRO_AGENT_LINEAGE` | JSON array of ancestor agent IDs |
| `MACRO_CONTROL_SOCKET_PATH` | Control socket for lifecycle RPC |
| `INBOX_SOCKET_PATH` | agent-inbox IPC socket path |

### Injected by team runtime

| Variable | Description |
|----------|-------------|
| `MACRO_TEAM_NAME` | Team name |
| `MACRO_TASK_MODE` | Task mode: `push` or `pull` |
| `MACRO_INTEGRATION_STRATEGY` | Integration strategy name |

## Dependencies

### Runtime

| Package | Purpose |
|---------|---------|
| `agent-inbox` | Messaging, threading, federation (embedded in-process) |
| `opentasks` | Task graph, dependencies, providers (IPC to daemon) |
| `acp-factory` | Agent process management (Claude Code sessions) |
| `openteams` | Team template loading and resolution |
| `git-cascade` | Git worktree, stream/fork/merge/rebase, Change-Id tracking, cascade namespace, event emitter (0.0.3+) |
| `better-sqlite3` | AgentStore + InboxAdapter persistence |
| `@modelcontextprotocol/sdk` | MCP server implementation |
| `@multi-agent-protocol/sdk` | MAP protocol types |
| `@sudocode-ai/claude-code-acp` | Claude Code ACP adapter |
| `zod` | Schema validation for MCP tools |
| `commander` | CLI argument parsing |
| `chalk` | CLI output formatting |
| `js-yaml` | Team YAML config parsing |
| `nanoid` | ID generation |
| `unique-names-generator` | Human-readable agent names |
| `express` | REST API server |
| `ws` | ACP WebSocket transport |

### Dev

| Package | Purpose |
|---------|---------|
| `vitest` | Test runner |
| `typescript` | Type checking and compilation |
| `@sudocode-ai/cli` | Sudocode CLI integration |

## References

### Team configuration
- [docs/teams.md](docs/teams.md) - Team template schema reference
- [docs/team-templates.md](docs/team-templates.md) - Team template format and examples

### Workspace redesign (V3)
- [docs/workspace-redesign-plan.md](docs/workspace-redesign-plan.md) - Implementation plan + status
- [docs/workspace-interfaces.md](docs/workspace-interfaces.md) - V3 interface contracts (TypeScript)
- [docs/git-cascade-integration-gaps.md](docs/git-cascade-integration-gaps.md) - Design narrative, workflow traces, migration plan
- [docs/conflict-recovery.md](docs/conflict-recovery.md) - Conflict recovery strategy design
