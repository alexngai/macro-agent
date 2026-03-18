# macro-agent

A multi-agent orchestration system for spawning and managing hierarchical Claude Code agents. Delegates messaging to **agent-inbox** and task management to **opentasks**.

## Project Overview

macro-agent enables coordinated work across multiple AI agents with:
- **Role-based agents** (Worker, Integrator, Coordinator, Monitor + custom team roles)
- **Team templates** for declarative multi-agent topologies (YAML config)
- **Pluggable integration strategies** (queue, trunk, optimistic)
- **Workspace isolation** via git worktrees
- **Merge queue** for serialized integration
- **Messaging** via agent-inbox (structured inbox/outbox, threading, federation)
- **Task management** via opentasks (graph-based dependencies, providers, claiming)
- **Signal filtering and emission enforcement** for communication topology (adapter-side)
- **Session continuations** for long-running daemon agents
- **Trigger system** for wake management, cron, and webhooks

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      External Clients                       │
│                       (CLI)                                 │
└───────────────────────────┬─────────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────────┐
│                   boot-v2.ts (System Wiring)                │
│  Initializes all components and wires adapters              │
└───────────────────────────┬─────────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────────┐
│                 Team Runtime (optional)                      │
│  - Loads team YAML config (topology, communication)         │
│  - Bootstraps root + companion agents                       │
│  - Installs spawn interceptor                               │
│  - Adapter-side signal filtering + emission validation      │
│  - One inbox scope per team                                 │
└───────────────────────────┬─────────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────────┐
│                     Agent Manager                           │
│  - Spawns agents via acp-factory                            │
│  - Manages lifecycle (spawn, prompt, stop, continue, fork)  │
│  - Registers agents in agent-inbox on spawn                 │
│  - Creates tasks in opentasks on spawn                      │
│  - Submits merge requests on worker terminate               │
│  - Cascade termination with workspace cleanup               │
└───────────────────────────┬─────────────────────────────────┘
                            │
        ┌───────────────────┼───────────────────┐
        │                   │                   │
        ▼                   ▼                   ▼
┌──────────────┐   ┌──────────────┐   ┌──────────────┐
│    Roles     │   │   Workspace  │   │   Adapters   │
│  Built-in +  │   │  Worktrees   │   │              │
│  Team-defined│   │  Strategies  │   │ InboxAdapter │
│  (via YAML)  │   │  (queue/     │   │ TasksAdapter │
│              │   │   trunk/opt) │   │              │
└──────────────┘   └──────────────┘   └──────┬───────┘
                                             │
                        ┌────────────────────┼────────────────────┐
                        │                                        │
               ┌────────▼─────────┐                   ┌──────────▼─────────┐
               │   agent-inbox    │                   │     opentasks      │
               │  (embedded)      │                   │  (IPC to daemon)   │
               │                  │                   │                    │
               │  - Messaging     │                   │  - Task graph      │
               │  - Threading     │                   │  - Dependencies    │
               │  - IPC server    │                   │  - Providers       │
               │  - Federation    │                   │  - Claiming        │
               └──────────────────┘                   └────────────────────┘
```

## Source Directory Structure

```
src/
├── adapters/            # Subsystem integration layer
│   ├── types.ts            # InboxAdapter + TasksAdapter interfaces
│   ├── inbox-adapter.ts    # Wraps agent-inbox (embedded, hybrid IPC)
│   ├── tasks-adapter.ts    # Wraps opentasks client (IPC to daemon)
│   └── index.ts            # Public exports
│
├── agent/               # Agent lifecycle
│   ├── agent-manager.ts    # AgentManager interface + SpawnInterceptor type
│   ├── agent-manager-v2.ts # Implementation using adapters + AgentStore
│   ├── agent-store.ts      # Minimal SQLite store (agents + sessions)
│   ├── system-prompt.ts    # Agent system prompts
│   └── types.ts            # SpawnAgentOptions, AgentFilter, etc.
│
├── boot-v2.ts           # System wiring entry point
│
├── cli/                 # Command-line interface
│   ├── index.ts            # CLI commands (uses bootV2)
│   └── acp.ts              # ACP CLI mode (uses bootV2)
│
├── config/              # Project configuration
│   └── project-config.ts   # .multiagent/config.json loader
│
├── lifecycle/           # Agent lifecycle management
│   ├── handlers-v2.ts      # Role-specific done() handlers (using adapters)
│   ├── cascade.ts          # Cascade termination
│   ├── cleanup.ts          # Workspace cleanup helpers
│   └── types.ts            # Lifecycle type definitions
│
├── mcp/                 # Model Context Protocol
│   ├── mcp-server-v2.ts    # Per-agent MCP server (5 tools)
│   ├── tools/
│   │   └── done-v2.ts      # done() tool using adapters
│   └── types.ts            # ToolContext, error types
│
├── roles/               # Role system
│   ├── types.ts            # RoleDefinition, Capability types
│   ├── capabilities.ts     # Capability constants
│   ├── registry.ts         # Role registry with resolution
│   └── builtin/            # Built-in role definitions
│
├── store/               # Type definitions only (no implementation)
│   └── types/              # AgentId, TaskId, Agent, etc.
│       ├── agents.ts
│       ├── tasks.ts
│       ├── events.ts
│       └── primitives.ts
│
├── teams/               # Team template system
│   ├── types.ts            # TeamManifest, TeamTopology, TeamCommunication
│   ├── team-loader.ts      # YAML loading, role resolution, validation
│   ├── team-runtime-v2.ts  # Initialize, bootstrap, signal filtering (adapter-side)
│   └── index.ts            # Public exports
│
├── trigger/             # Trigger system
│   ├── trigger-system-v2.ts # Factory: inbox delivery → wake manager
│   ├── types.ts            # TriggerEvent, TriggerSource types
│   ├── wake/               # Wake manager (heartbeat, coalesce, inject→interrupt→prompt)
│   ├── queue/              # Per-agent system event queue
│   └── sources/            # Cron scheduler, webhook handler
│
└── workspace/           # Workspace isolation
    ├── workspace-manager.ts # Worktree management
    ├── config.ts           # Workspace configuration
    ├── merge-queue/        # SQLite-backed merge queue
    └── strategies/         # Integration strategies (queue, trunk, optimistic)
```

## Key Concepts

### Subsystem Architecture

macro-agent delegates two major concerns to external subsystems:

- **agent-inbox**: All messaging (send/receive, threading, conversations, federation). Embedded in-process for zero-latency events, with IPC server for agent MCP subprocesses.
- **opentasks**: All task management (CRUD, dependencies, claiming, state transitions). Connected via IPC to opentasks daemon.

macro-agent owns: agent lifecycle, workspace isolation, team topology, role system, trigger/wake.

### Adapter Layer

Two adapters form the integration boundary:

- **InboxAdapter** (`adapters/inbox-adapter.ts`): Wraps agent-inbox. Owns adapter-side signal filtering and emission validation (set by TeamRuntime). Provides `send()`, `onDelivery()`, `registerAgent()`.
- **TasksAdapter** (`adapters/tasks-adapter.ts`): Wraps opentasks client. Provides `createTask()`, `transitionTask()`, `queryReady()`, `claimTask()`.

### AgentStore

Minimal SQLite store with two tables: `agents` and `sessions`. Replaces the heavy EventStore + TinyBase materialized views. Simple CRUD, no event sourcing.

### Teams

Teams are declarative YAML configurations that define multi-agent topologies.

- **TeamLoader** (`team-loader.ts`): Parses `team.yaml`, resolves role inheritance, validates topology
- **TeamRuntime** (`team-runtime-v2.ts`): Per-instance runtime — registers roles, bootstraps root + companions, adapter-side signal filtering, emission validation, continuation monitoring
- **Scope**: Each team gets its own agent-inbox scope (scope = team name)
- **Signal filtering**: Installed on InboxAdapter (not MessageRouter) — enforced before delivery
- **Emission validation**: Installed on InboxAdapter — enforced before send

### Roles

Agents are assigned roles that determine their capabilities:

| Role | Purpose | Key Capabilities |
|------|---------|------------------|
| **Worker** | Execute tasks in isolated workspace | File I/O, git operations, task completion |
| **Integrator** | Manage merge queue and resolve conflicts | Merge operations, branch management |
| **Coordinator** | Orchestrate workers and manage tasks | Spawn agents, assign tasks, broadcast |
| **Monitor** | Health monitoring and alerts | Read-only access, activity watching |

Teams can define custom roles (e.g., planner, grinder, judge) that extend built-in roles via `extends` in `roles/<name>.yaml`.

### Integration Strategies

Pluggable strategies for landing worker changes:
- **Queue** (`queue.ts`): Wraps merge queue with serialized integration
- **Trunk** (`trunk.ts`): Direct push with rebase-retry loop
- **Optimistic** (`optimistic.ts`): Same as trunk + emits validation event

### Workspace Isolation

Each worker gets an isolated git worktree. Merge requests are submitted system-level by `AgentManager.terminate()` when a worker with completed work terminates — agents never construct merge requests directly.

### MCP Tool Surface

Each agent gets tools from three sources:

| Source | Tools | Mount method |
|--------|-------|-------------|
| **agent-inbox** | `send_message`, `check_inbox`, `read_thread`, `list_agents` | IPC socket |
| **opentasks** | `link`, `query`, `annotate`, `task` | IPC socket |
| **macro-agent** | `done`, `spawn_agent`, `stop_agent`, `get_hierarchy`, `inject_context` | Built-in MCP server |

### Trigger System

Routes external events (cron, webhooks) and inbox delivery events to agents:
- **WakeManager**: Heartbeat + coalesce + inject→interrupt→prompt fallback chain
- **Inbox integration**: `InboxAdapter.onDelivery` → importance mapping → WakeManager
- **CronService**: Time-based agent activation
- **WebhookHandler**: HTTP endpoint triggers

### Communication Topology

Teams configure communication via:
- **Channels**: Named topics with defined signals
- **Subscriptions**: Per-role channel subscriptions with optional signal filters
- **Peer routing**: Directional connections with per-peer signal filters
- **Emissions**: Per-role allowed signal lists
- **Enforcement**: `strict` (reject), `permissive` (warn), `audit` (log)

All filtering is adapter-side — agent-inbox is a dumb pipe, macro-agent enforces policy.

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

- **Unit tests**: `*.test.ts` - Fast, mocked dependencies
- **Integration tests**: `*-integration.test.ts` - Real dependencies
- **E2E tests**: `*.e2e.test.ts` - Full system tests

Run tests:
```bash
npm test                    # All unit tests
npm run test:e2e            # E2E tests (requires RUN_E2E_TESTS=true)
```

### Error Handling

- Use typed errors with codes
- Graceful degradation over hard failures
- Log warnings for recoverable issues

## Common Tasks

### Adding a New MCP Tool (macro-agent specific)

1. Create `src/mcp/tools/your_tool.ts`
2. Define schema with Zod
3. Export tool info and handler
4. Register in `src/mcp/mcp-server-v2.ts`

### Adding a New Built-in Role

1. Create `src/roles/builtin/your_role.ts`
2. Define `RoleDefinition` with capabilities
3. Register in `src/roles/builtin/index.ts`

### Adding a Team Role (via YAML)

1. Create `.multiagent/teams/<team>/roles/<role>.yaml` with `extends` base role
2. Add `capabilities_add`/`capabilities_remove` as needed
3. Create `.multiagent/teams/<team>/prompts/<role>.md` for custom prompt
4. Reference the role in `team.yaml` topology and communication sections

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `MACRO_WORKSPACE_POOL_SIZE` | Max concurrent workspaces | `10` |
| `MACRO_MERGE_QUEUE_DB` | Merge queue SQLite path | `:memory:` |
| `MACRO_TEAMS` | Comma-separated team templates to auto-start | — |
| `MACRO_TEAM_NAME` | Team name (injected by team runtime) | — |
| `MACRO_TASK_MODE` | Task mode: `push` or `pull` (injected by team runtime) | — |
| `MACRO_INTEGRATION_STRATEGY` | Integration strategy name | — |
| `INBOX_SOCKET_PATH` | agent-inbox IPC socket path | `~/.macro-agent/inbox.sock` |

## Dependencies

### Core (hard)

- `agent-inbox` — Messaging, threading, federation (embedded in-process)
- `opentasks` — Task graph, dependencies, providers (IPC to daemon)
- `acp-factory` — Agent process management (Claude Code sessions)
- `openteams` — Team template loading and resolution
- `better-sqlite3` — AgentStore persistence
- `git-cascade` — Git worktree and merge queue operations

## References

- [docs/design-subsystem-extraction.md](docs/design-subsystem-extraction.md) - Subsystem extraction design document
- [docs/teams.md](docs/teams.md) - Team template schema reference
- [docs/team-templates.md](docs/team-templates.md) - Team template format and examples
