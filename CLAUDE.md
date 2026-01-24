# macro-agent

A multi-agent orchestration system for spawning and managing hierarchical Claude Code agents.

## Project Overview

macro-agent enables coordinated work across multiple AI agents with:
- **Role-based agents** (Worker, Integrator, Coordinator, Monitor)
- **Workspace isolation** via git worktrees
- **Merge queue** for serialized integration
- **Task backend** abstraction (memory or sudocode)
- **In-flight steering** via context injection

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      External Clients                       │
│           (CLI, WebSocket ACP, REST API)                    │
└───────────────────────────┬─────────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────────┐
│                     Agent Manager                            │
│  - Spawns agents via acp-factory                            │
│  - Manages lifecycle (spawn, prompt, stop)                  │
│  - Exposes sessions for context injection                   │
└───────────────────────────┬─────────────────────────────────┘
                            │
        ┌───────────────────┼───────────────────┐
        │                   │                   │
        ▼                   ▼                   ▼
┌──────────────┐   ┌──────────────┐   ┌──────────────┐
│    Roles     │   │   Workspace  │   │    Tasks     │
│  Worker      │   │  Bare Repo   │   │  Backend     │
│  Integrator  │   │  Worktrees   │   │  (memory/    │
│  Coordinator │   │  Pool        │   │   sudocode)  │
│  Monitor     │   │              │   │              │
└──────────────┘   └──────────────┘   └──────────────┘
        │                   │                   │
        └───────────────────┼───────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────────┐
│                     Message Router                           │
│  - Direct agent-to-agent messaging                          │
│  - Broadcast channels (fan-out)                             │
│  - Role channels (send-time resolution)                     │
│  - Priority ordering                                        │
└───────────────────────────┬─────────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────────┐
│                      Event Store                             │
│  - Append-only event log (SQLite)                           │
│  - Materialized views for queries                           │
│  - Agents, tasks, messages, events                          │
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
│   ├── agent-manager.ts    # Spawn, prompt, stop agents
│   ├── wake.ts             # Wake sleeping agents
│   └── system-prompt.ts    # Agent system prompts
│
├── api/                 # REST API
│   ├── server.ts           # Express routes
│   └── types.ts            # Request/response types
│
├── cli/                 # Command-line interface
│   └── index.ts            # CLI commands (start, chat, status)
│
├── lifecycle/           # Agent lifecycle management
│   ├── handlers/           # Role-specific done() handlers
│   │   ├── worker.ts       # Worker completion (commit, merge request)
│   │   ├── integrator.ts   # Integrator completion (merge queue)
│   │   └── monitor.ts      # Monitor completion (health reporting)
│   ├── cascade.ts          # Cascade termination
│   └── cleanup.ts          # Workspace cleanup helpers
│
├── mcp/                 # Model Context Protocol
│   ├── mcp-server.ts       # Per-agent MCP server
│   └── tools/              # MCP tool implementations
│       ├── done.ts         # Generalized done() tool
│       └── inject_context.ts # Context injection tool
│
├── roles/               # Role system
│   ├── types.ts            # RoleDefinition, Capability types
│   ├── capabilities.ts     # Capability constants
│   ├── registry.ts         # Role registry with resolution
│   └── builtin/            # Built-in role definitions
│       ├── worker.ts
│       ├── integrator.ts
│       ├── coordinator.ts
│       └── monitor.ts
│
├── router/              # Message routing
│   ├── message-router.ts   # Core router with priority
│   ├── broadcast.ts        # Broadcast channel (fan-out)
│   ├── role-resolver.ts    # Role → Agent resolution
│   ├── wake.ts             # Activity waking
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
│       ├── types.ts        # TaskBackend interface
│       ├── memory.ts       # InMemoryTaskBackend
│       ├── tool-provider.ts # Task MCP tools
│       └── sudocode/       # Sudocode integration
│
└── workspace/           # Workspace isolation
    ├── workspace-manager.ts # Worktree management
    ├── config.ts           # Workspace configuration
    └── merge-queue/        # Merge queue
        ├── merge-queue.ts  # SQLite-backed queue
        ├── types.ts        # Queue types
        └── schema.ts       # Database schema
```

## Key Concepts

### Roles

Agents are assigned roles that determine their capabilities:

| Role | Purpose | Key Capabilities |
|------|---------|------------------|
| **Worker** | Execute tasks in isolated workspace | File I/O, git operations, task completion |
| **Integrator** | Manage merge queue and resolve conflicts | Merge operations, branch management |
| **Coordinator** | Orchestrate workers and manage tasks | Spawn agents, assign tasks, broadcast |
| **Monitor** | Health monitoring and alerts | Read-only access, activity watching |

### Workspace Isolation

Each worker gets an isolated git worktree:
- Workers operate on feature branches
- Changes merge through the queue
- Conflicts detected and resolved by integrator

### Task Backend

Two backends available:
- **memory**: In-memory tasks with EventStore persistence
- **sudocode**: External issue tracking with dependency management

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

### Adding a New Role

1. Create `src/roles/builtin/your_role.ts`
2. Define `RoleDefinition` with capabilities
3. Add enforcement implementations
4. Register in `src/roles/builtin/index.ts`

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

## References

- [README.md](README.md) - User-facing documentation
- [docs/sudocode-integration.md](docs/sudocode-integration.md) - Sudocode backend details
- [docs/architecture.md](docs/architecture.md) - Full architecture documentation
- [docs/configuration.md](docs/configuration.md) - Configuration reference
