# macro-agent

A multi-agent orchestration system for spawning and managing hierarchical Claude Code agents.

## Project Overview

macro-agent enables coordinated work across multiple AI agents with:
- **Role-based agents** (Worker, Integrator, Coordinator, Monitor + custom team roles)
- **Team templates** for declarative multi-agent topologies (YAML config)
- **Pluggable integration strategies** (queue, trunk, optimistic)
- **Workspace isolation** via git worktrees
- **Merge queue** for serialized integration
- **Task backend** abstraction (memory or sudocode) with push and pull modes
- **In-flight steering** via context injection
- **Signal filtering and emission enforcement** for communication topology
- **Session continuations** for long-running daemon agents
- **Observability** via throughput, utilization, and error metrics

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      External Clients                       │
│           (CLI, WebSocket ACP, REST API)                    │
└───────────────────────────┬─────────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────────┐
│                     Team Runtime (optional)                   │
│  - Loads team YAML config (topology, communication)         │
│  - Bootstraps root + companion agents                       │
│  - Installs spawn interceptor, signal filters, validators   │
│  - Manages integration strategy and session continuations   │
└───────────────────────────┬─────────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────────┐
│                     Agent Manager                            │
│  - Spawns agents via acp-factory                            │
│  - Manages lifecycle (spawn, prompt, stop, continue)        │
│  - Spawn interception for team role/topic injection         │
└───────────────────────────┬─────────────────────────────────┘
                            │
        ┌───────────────────┼───────────────────┐
        │                   │                   │
        ▼                   ▼                   ▼
┌──────────────┐   ┌──────────────┐   ┌──────────────┐
│    Roles     │   │   Workspace  │   │    Tasks     │
│  Built-in +  │   │  Bare Repo   │   │  Backend     │
│  Team-defined│   │  Worktrees   │   │  (memory/    │
│  (via YAML)  │   │  Strategies  │   │   sudocode)  │
│              │   │  (queue/     │   │  Push/Pull   │
│              │   │   trunk/opt) │   │   modes      │
└──────────────┘   └──────────────┘   └──────────────┘
        │                   │                   │
        └───────────────────┼───────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────────┐
│                     Message Router                           │
│  - MAP addressing (agent, role, scope, parent/child)        │
│  - sendToAddress() for all message routing                  │
│  - Topic-based status routing with signal filtering         │
│  - Emission validation (strict/permissive/audit)            │
│  - Activity waking for sleeping agents                      │
└───────────────────────────┬─────────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────────┐
│                      Event Store                             │
│  - Append-only event log (SQLite)                           │
│  - Materialized views for queries                           │
│  - Agents, tasks, messages, events, team config             │
└─────────────────────────────────────────────────────────────┘
```

## Source Directory Structure

```
src/
├── acp/                 # Agent Communication Protocol
│   ├── macro-agent.ts      # ACP agent implementation (mount, fork)
│   ├── websocket-server.ts # Multi-client WebSocket ACP
│   └── session-mapper.ts   # Session → Agent ID mapping
│
├── agent/               # Agent lifecycle
│   ├── agent-manager.ts    # Spawn, prompt, stop, continue agents
│   ├── wake.ts             # Wake sleeping agents
│   └── system-prompt.ts    # Agent system prompts
│
├── api/                 # REST API
│   ├── server.ts           # Express routes (agents, tasks, team, metrics)
│   └── types.ts            # Request/response types
│
├── cli/                 # Command-line interface
│   └── index.ts            # CLI commands (start, chat, status, --team)
│
├── config/              # Project configuration
│   └── project-config.ts   # .macro-agent/config.json loader
│
├── lifecycle/           # Agent lifecycle management
│   ├── handlers/           # Role-specific done() handlers
│   │   ├── worker.ts       # Worker completion (strategy dispatch)
│   │   ├── integrator.ts   # Integrator completion (merge queue)
│   │   └── monitor.ts      # Monitor completion (health reporting)
│   ├── cascade.ts          # Cascade termination
│   └── cleanup.ts          # Workspace cleanup helpers
│
├── mcp/                 # Model Context Protocol
│   ├── mcp-server.ts       # Per-agent MCP server (role-based tool filtering)
│   └── tools/              # MCP tool implementations
│       ├── done.ts         # Generalized done() tool
│       ├── inject_context.ts # Context injection tool
│       ├── claim_task.ts   # Claim task from pool (pull mode)
│       ├── unclaim_task.ts # Release claimed task (pull mode)
│       └── list_claimable_tasks.ts # List available tasks (pull mode)
│
├── metrics/             # Observability
│   └── metrics.ts          # Throughput, utilization, error metrics
│
├── roles/               # Role system
│   ├── types.ts            # RoleDefinition, Capability types
│   ├── capabilities.ts     # Capability constants (incl. task.claim)
│   ├── registry.ts         # Role registry with resolution
│   └── builtin/            # Built-in role definitions
│       ├── worker.ts
│       ├── integrator.ts
│       ├── coordinator.ts
│       └── monitor.ts
│
├── router/              # Message routing
│   ├── message-router.ts   # Core router with signal filtering + emission validation
│   ├── broadcast.ts        # Broadcast channel (fan-out)
│   ├── role-resolver.ts    # Role → Agent resolution
│   ├── wake.ts             # Activity waking (status + message)
│   └── types.ts            # Message, Channel types
│
├── steering/            # In-flight steering
│   ├── inject.ts           # Context injection with fallback
│   └── types.ts            # Injection types
│
├── store/               # Event sourcing
│   ├── event-store.ts      # Core event store
│   ├── instance.ts         # Global instance management
│   ├── backends/           # Storage backends
│   │   ├── sqlite-backend.ts
│   │   └── memory-backend.ts
│   └── types/              # Type definitions
│       ├── agents.ts
│       ├── tasks.ts
│       ├── events.ts
│       └── primitives.ts
│
├── task/                # Task management
│   ├── task-manager.ts     # Legacy task manager
│   └── backend/            # Pluggable task backends
│       ├── types.ts        # TaskBackend interface (+ claim/unclaim/listClaimable)
│       ├── memory.ts       # InMemoryTaskBackend (push + pull)
│       ├── tool-provider.ts # Task MCP tools
│       └── sudocode/       # Sudocode integration
│
├── teams/               # Team template system
│   ├── types.ts            # TeamManifest, TeamTopology, TeamCommunication
│   ├── team-loader.ts      # YAML loading, role resolution, validation
│   ├── team-runtime.ts     # Initialize, bootstrap, peer routing, signal filtering
│   └── index.ts            # Public exports
│
└── workspace/           # Workspace isolation
    ├── workspace-manager.ts # Worktree management
    ├── config.ts           # Workspace configuration
    ├── merge-queue/        # Merge queue
    │   ├── merge-queue.ts  # SQLite-backed queue
    │   ├── types.ts        # Queue types
    │   └── schema.ts       # Database schema
    └── strategies/         # Integration strategies
        ├── types.ts        # IntegrationStrategy interface
        ├── registry.ts     # Strategy factory registry
        ├── queue.ts        # Queue strategy (wraps merge queue)
        ├── trunk.ts        # Trunk strategy (direct push + rebase)
        └── optimistic.ts   # Optimistic strategy (push + validation event)
```

## Key Concepts

### Teams

Teams are declarative YAML configurations that define multi-agent topologies:
- **TeamLoader** (`team-loader.ts`): Parses `team.yaml`, resolves role inheritance, validates topology
- **TeamRuntime** (`team-runtime.ts`): Wires team config into running services (roles, spawn interceptor, peer routing, signal filtering, emission validation, continuation monitoring)
- Teams compose on top of existing primitives — no team loaded = identical behavior to pre-team codebase
- Team config is shared across processes via EventStore `team_config` event

### Roles

Agents are assigned roles that determine their capabilities:

| Role | Purpose | Key Capabilities |
|------|---------|------------------|
| **Worker** | Execute tasks in isolated workspace | File I/O, git operations, task completion |
| **Integrator** | Manage merge queue and resolve conflicts | Merge operations, branch management |
| **Coordinator** | Orchestrate workers and manage tasks | Spawn agents, assign tasks, broadcast |
| **Monitor** | Health monitoring and alerts | Read-only access, activity watching |

Teams can define custom roles (e.g., planner, grinder, judge) that extend built-in roles via `extends` in `roles/<name>.yaml`. Custom roles can add/remove capabilities and provide custom prompts.

### Integration Strategies

Pluggable strategies for landing worker changes:
- **Queue** (`queue.ts`): Wraps merge queue with serialized integration
- **Trunk** (`trunk.ts`): Direct push with rebase-retry loop, configurable `conflictAction`
- **Optimistic** (`optimistic.ts`): Same as trunk + emits `validation:requested` event

Strategy is set per-team in `team.yaml` under `macro_agent.integration.strategy`.

### Workspace Isolation

Each worker gets an isolated git worktree:
- Workers operate on feature branches
- Changes merge through the queue or strategy
- Conflicts detected and resolved by integrator

### Task Backend

Two backends available:
- **memory**: In-memory tasks with EventStore persistence (supports push + pull modes)
- **sudocode**: External issue tracking with dependency management (push mode only)

Pull mode adds `claim_task`, `unclaim_task`, `list_claimable_tasks` MCP tools (gated by `task.claim` capability).

### Communication Topology

Teams configure non-hierarchical communication via:
- **Channels**: Named topics (e.g., `work_coordination`, `task_updates`) with defined signals
- **Subscriptions**: Per-role channel subscriptions with optional signal filters
- **Peer routing**: Directional connections between roles (`via: direct|topic|scope`) with per-peer signal filters
- **Emissions**: Per-role allowed signal lists, enforced by emission validator
- **Enforcement**: `strict` (reject violations), `permissive` (warn), `audit` (record to EventStore)

### Context Injection

Inject context into running agents:
- `inject()`: Direct session injection (if supported)
- `interruptWith()`: Fallback interrupt method
- High-priority message: Final fallback

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

#### ID Field Naming Convention

Different layers use different naming for ID fields by design:

| Layer | Convention | Example | Rationale |
|-------|------------|---------|-----------|
| **Internal** (store, router, activity) | `agent_id`, `task_id` | `source.agent_id` | Database/event conventions, explicit |
| **MAP Protocol** (map/types) | `agent`, `task` | `address.agent` | Protocol spec, cleaner syntax |

The `store/types/events.ts` module bridges these conventions when converting between internal events and MAP addresses.

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

### Adding a New MCP Tool

1. Create `src/mcp/tools/your_tool.ts`
2. Define schema with Zod
3. Export tool info and handler
4. Register in `src/mcp/mcp-server.ts`

### Adding a New Built-in Role

1. Create `src/roles/builtin/your_role.ts`
2. Define `RoleDefinition` with capabilities
3. Add enforcement implementations
4. Register in `src/roles/builtin/index.ts`

### Adding a Team Role (via YAML)

1. Create `.macro-agent/teams/<team>/roles/<role>.yaml` with `extends` base role
2. Add `capabilities_add`/`capabilities_remove` as needed
3. Create `.macro-agent/teams/<team>/prompts/<role>.md` for custom prompt
4. Reference the role in `team.yaml` topology and communication sections

### Modifying Task Backend

1. Update interface in `src/task/backend/types.ts`
2. Implement in both `memory.ts` and `sudocode/`
3. Update tool provider if adding new operations

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `MACRO_TASK_BACKEND` | Task backend: `memory` or `sudocode` | `memory` |
| `SUDOCODE_PROJECT_PATH` | Path to sudocode project | `cwd` |
| `MACRO_WORKSPACE_POOL_SIZE` | Max concurrent workspaces | `10` |
| `MACRO_MERGE_QUEUE_DB` | Merge queue SQLite path | `:memory:` |
| `MACRO_TEAM_NAME` | Team name (injected into agent env by team runtime) | — |
| `MACRO_TASK_MODE` | Task mode: `push` or `pull` (injected by team runtime) | — |
| `MACRO_INTEGRATION_STRATEGY` | Integration strategy name (injected by team runtime) | — |
| `MACRO_INSTANCE_ID` | EventStore instance ID (for MCP subprocess access) | — |
| `MACRO_BASE_DIR` | EventStore base directory (for MCP subprocess access) | — |

## References

- [README.md](README.md) - User-facing documentation
- [docs/architecture.md](docs/architecture.md) - Full architecture documentation
- [docs/configuration.md](docs/configuration.md) - Configuration reference
- [docs/teams.md](docs/teams.md) - Team template schema reference
- [docs/team-templates.md](docs/team-templates.md) - Team template format and examples
- [docs/sudocode-integration.md](docs/sudocode-integration.md) - Sudocode backend details
