# macro-agent

A multi-agent orchestration system for spawning and managing hierarchical Claude Code agents. Interact with multiple agents as if they were one.

## Features

- **Hierarchical Agent Management** - Head manager spawns and coordinates child agents
- **Role-Based Agents** - Worker, Integrator, Coordinator, and Monitor roles with distinct capabilities
- **Team Templates** - Declarative YAML-based team configurations for multi-agent topologies
- **Pluggable Integration Strategies** - Queue, trunk, or optimistic merge strategies
- **Workspace Isolation** - Each worker gets isolated git worktrees to prevent conflicts
- **Merge Queue** - Serialized integration of worker changes with conflict resolution
- **Event-Sourced State** - All state changes persisted via append-only event log
- **Real-time Communication** - WebSocket subscriptions for live updates
- **MCP Tool Integration** - Agents communicate via Model Context Protocol tools
- **Task Lifecycle** - Create, assign, and track tasks with push or pull models
- **Message Routing** - Direct, broadcast, role-based, and topic-based message delivery with priority
- **Signal Filtering** - Per-role and per-peer signal filtering for status notifications
- **Context Injection** - Push context into running agents without waiting for message checks
- **Session Continuations** - Auto-resume long-running agents across process restarts
- **Observability** - Throughput, utilization, and error metrics via REST API
- **Sudocode Integration** - Optional issue tracking with dependency management

## Sudocode Integration

macro-agent can integrate with [sudocode](https://github.com/sudocode-ai/sudocode) for external issue tracking:

```bash
# Enable sudocode backend
export MACRO_TASK_BACKEND=sudocode
export SUDOCODE_PROJECT_PATH=/path/to/project

# Start macro-agent server (full mode with ACP + MAP + REST)
npx multiagent
```

With sudocode enabled:
- Tasks are bound to sudocode issues via `external_id`
- Blocking relationships come from sudocode's issue links
- `listReady()` returns only tasks with no incomplete blockers
- Task status can sync with issue status

See [docs/sudocode-integration.md](docs/sudocode-integration.md) for full documentation.

## Team Templates

Teams define multi-agent topologies as YAML configuration. A team template specifies which roles to spawn, how they communicate, and what integration strategy to use.

```bash
# Start with a team template
npx multiagent --team self-driving

# Or set in project config (.macro-agent/config.json)
echo '{ "team": "self-driving" }' > .macro-agent/config.json
npx multiagent
```

Teams are stored in `.macro-agent/teams/<name>/`:

```
.macro-agent/teams/self-driving/
├── team.yaml          # Team manifest (topology, communication, strategy)
├── roles/
│   ├── planner.yaml   # Custom role (extends coordinator)
│   ├── grinder.yaml   # Custom role (extends worker)
│   └── judge.yaml     # Custom role (extends monitor)
└── prompts/
    ├── planner.md     # Role-specific system prompt
    ├── grinder.md
    └── judge.md
```

Key team features:
- **Topology**: Root + companion agents spawned at bootstrap, with spawn rules for dynamic workers
- **Communication**: Topic-based channels with per-role signal filtering, peer-to-peer routing
- **Integration strategies**: `queue` (merge queue), `trunk` (direct push with rebase), `optimistic` (push + validation)
- **Task modes**: `push` (coordinator assigns) or `pull` (agents claim from pool)
- **Enforcement**: `strict` (reject violations), `permissive` (warn), or `audit` (record)
- **Session continuations**: Auto-resume daemon agents on unexpected stops

See [docs/teams.md](docs/teams.md) for the full schema reference and [docs/team-templates.md](docs/team-templates.md) for examples.

## Installation

```bash
npm install macro-agent
```

## Quick Start

### Server Mode (Default)

```bash
# Start full server with ACP + MAP + REST API
npx multiagent

# Start with a team template
npx multiagent --team self-driving

# Custom port and host
npx multiagent --port 8080 --host 0.0.0.0
```

### CLI Tools

```bash
# Start interactive chat
npx multiagent-cli chat

# Check system status
npx multiagent-cli status

# View agent hierarchy
npx multiagent-cli hierarchy

# List all agents
npx multiagent-cli agents

# List all tasks
npx multiagent-cli tasks
```

### Programmatic Usage

```typescript
import {
  createEventStore,
  createAgentManager,
  createTaskManager,
  createMessageRouter,
  createAPIServer,
} from 'macro-agent';

// Initialize the system
const eventStore = await createEventStore({ inMemory: true });
const messageRouter = createMessageRouter(eventStore);
const taskManager = createTaskManager(eventStore);
const agentManager = createAgentManager(eventStore, messageRouter, {
  defaultPermissionMode: 'auto-approve',
});

// Create a head manager
const headManager = await agentManager.getOrCreateHeadManager({
  cwd: process.cwd(),
});

// Send a message
for await (const update of agentManager.prompt(headManager.id, 'Hello!')) {
  // Handle streaming response
}

// Start the API server
const { app, server, wss } = createAPIServer({
  eventStore,
  agentManager,
  taskManager,
  messageRouter,
});

server.listen(3000);
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        User                                  │
│                          │                                   │
│                          ▼                                   │
│  ┌──────────┐     ┌─────────────┐     ┌──────────────────┐  │
│  │   CLI    │────▶│  API Server │────▶│   WebSocket      │  │
│  └──────────┘     └─────────────┘     └──────────────────┘  │
│                          │                                   │
│                          ▼                                   │
│  ┌───────────────────────────────────────────────────────┐  │
│  │                   Agent Manager                        │  │
│  │  ┌─────────────┐  ┌─────────────┐  ┌──────────────┐   │  │
│  │  │Head Manager │──│ Child Agent │──│ Child Agent  │   │  │
│  │  └─────────────┘  └─────────────┘  └──────────────┘   │  │
│  └───────────────────────────────────────────────────────┘  │
│                          │                                   │
│         ┌────────────────┼────────────────┐                 │
│         ▼                ▼                ▼                 │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐         │
│  │Task Manager │  │Msg Router   │  │ MCP Server  │         │
│  └─────────────┘  └─────────────┘  └─────────────┘         │
│                          │                                   │
│                          ▼                                   │
│  ┌───────────────────────────────────────────────────────┐  │
│  │                   Event Store                          │  │
│  │    (Append-only log + Materialized Views)             │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

## Role System

Agents are assigned roles that determine their capabilities:

| Role | Purpose | Key Capabilities |
|------|---------|------------------|
| **Worker** | Execute tasks in isolated workspace | File I/O, git operations, task completion |
| **Integrator** | Manage merge queue and resolve conflicts | Merge operations, branch management |
| **Coordinator** | Orchestrate workers and manage tasks | Spawn agents, assign tasks, broadcast |
| **Monitor** | Health monitoring and alerts | Read-only access, activity watching |

```typescript
// Spawn a worker agent
const worker = await agentManager.spawn({
  task: 'Implement feature X',
  role: 'worker',
  parent: headManagerId,
});
```

## Workspace Isolation

Each worker operates in an isolated git worktree:

```
Main Repository
├── .worktrees/
│   ├── worker-01/  → feature/task-123 (Worker A)
│   ├── worker-02/  → feature/task-456 (Worker B)
│   └── worker-03/  → feature/task-789 (Worker C)
└── integration     → Merge queue target
```

- Workers cannot affect each other's work
- Changes merge through the queue in order
- Conflicts detected and resolved by Integrator

## Context Injection

Push context into running agents without waiting for message checks:

```typescript
// Via API
await fetch('/api/agents/{agentId}/inject', {
  method: 'POST',
  body: JSON.stringify({
    content: 'Priority change: pause current work',
    urgent: true,
  }),
});

// Via MCP tool (agent-to-agent)
await injectContext(deps, targetAgentId, 'Build is failing', {
  urgent: true,
  reason: 'CI failure detected',
});
```

Fallback chain: `inject()` → `interruptWith()` → high-priority message

## API Reference

### REST Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/status` | GET | System status |
| `/api/init` | POST | Initialize head manager |
| `/api/agents` | GET | List all agents |
| `/api/agents/:id` | GET | Get agent details |
| `/api/agents/:id/hierarchy` | GET | Get agent hierarchy |
| `/api/agents/:id/inject` | POST | Inject context into agent |
| `/api/tasks` | GET | List all tasks |
| `/api/tasks/:id` | GET | Get task details |
| `/api/events` | GET | List events |
| `/api/conversation/message` | POST | Send message |
| `/api/conversation/history` | GET | Get history |
| `/api/team` | GET | Active team info |
| `/api/metrics/throughput` | GET | Task completion rates |
| `/api/metrics/utilization` | GET | Agent counts by role/state |
| `/api/metrics/errors` | GET | Error tracking |

### WebSocket Channels

- `agents` - Agent lifecycle events
- `tasks` - Task status changes
- `conversation` - Chat messages
- `events` - All system events

### MCP Tools (Available to Agents)

| Tool | Description |
|------|-------------|
| `spawn_agent` | Spawn a child agent |
| `emit_status` | Report status (with signal filtering and emission validation) |
| `send_message` | Send message to another agent |
| `check_messages` | Check message inbox |
| `get_hierarchy` | View agent tree |
| `get_agent_summary` | Get agent details |
| `stop_agent` | Terminate an agent |
| `create_task` | Create a new task |
| `get_task` | Get task details |
| `list_ready_tasks` | List tasks with no blockers |
| `claim_task` | Claim next available task (pull mode) |
| `unclaim_task` | Return claimed task to pool (pull mode) |
| `list_claimable_tasks` | List claimable tasks (pull mode) |
| `done` | Signal task completion (role-specific) |
| `inject_context` | Inject context into another agent |
| `wait_for_activity` | Wait for system events (Monitor) |

## Server Mode (ACP + MAP)

macro-agent runs as an ACP-compliant agent server with MAP (Multi-Agent Protocol) support, enabling external systems to spawn and control agents programmatically.

### Full Server Mode (Default)

```bash
# Start combined server with all protocols
npx multiagent

# Custom configuration
npx multiagent --port 8080 --host 0.0.0.0 --cwd /path/to/project
```

### Stdio ACP (Embedded Use)

```bash
# Run as stdio ACP server (for spawning via acp-factory)
npx multiagent --acp
npx multiagent --acp --cwd /path/to/project
```

### Server Options

| Option | Description |
|--------|-------------|
| `--port <port>` | Server port (default: 3001) |
| `--host <host>` | Server host (default: localhost) |
| `--cwd <path>` | Working directory for agents |
| `--team <name>` | Load team template from `.macro-agent/teams/<name>/` |
| `--acp` | Stdio ACP-only mode (for embedded use with acp-factory) |

### Multi-Client Architecture

When using WebSocket ACP, each client gets its own ACP session but all sessions share the same agent hierarchy:

```
┌─────────────────────────────────────────────────────────────┐
│                   External Clients                          │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐                  │
│  │ Client A │  │ Client B │  │ Client C │                  │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘                  │
│       │             │             │                         │
│       └─────────────┼─────────────┘                         │
│                     │ WebSocket ACP (JSON-RPC 2.0)          │
│                     ▼                                       │
│  ┌───────────────────────────────────────────────────────┐  │
│  │              WebSocket ACP Server                     │  │
│  │    (Each connection = independent ACP session)        │  │
│  └───────────────────────────────────────────────────────┘  │
│                     │                                       │
│                     ▼                                       │
│  ┌───────────────────────────────────────────────────────┐  │
│  │           Shared Agent Manager                        │  │
│  │  ┌─────────────┐  ┌─────────────┐  ┌──────────────┐   │  │
│  │  │Head Manager │──│ Child Agent │──│ Child Agent  │   │  │
│  │  └─────────────┘  └─────────────┘  └──────────────┘   │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

Each client can:
- Create independent sessions via `newSession()`
- Mount to different agents in the hierarchy
- Send prompts to their mounted agents
- See agents spawned by other clients

### Programmatic Usage

```typescript
import { registerMacroAgent } from 'macro-agent';
import { AgentFactory } from 'acp-factory';

// Register macro-agent with acp-factory (uses --acp flag for stdio mode)
registerMacroAgent();

// Spawn via ACP (stdio mode)
const handle = await AgentFactory.spawn('macro-agent', {
  permissionMode: 'auto-approve',
});

// Or connect to server mode (default when running `multiagent`)
const acpWs = new WebSocket('ws://localhost:3001/acp');   // ACP protocol
const mapWs = new WebSocket('ws://localhost:3001/map');   // MAP protocol
```

## CLI Commands

### multiagent (Server)

```
multiagent [options]          Start the agent server (full mode by default)
  --port <port>               Port (default: 3001)
  --host <host>               Host (default: localhost)
  --cwd <path>                Working directory
  --team <name>               Load team template
  --acp                       Stdio ACP-only mode (for acp-factory)
```

Server endpoints (default mode):
- `ws://host:port/acp` - ACP protocol (WebSocket)
- `ws://host:port/map` - MAP protocol (WebSocket)
- `ws://host:port/api/ws` - Real-time subscriptions
- `http://host:port/api/*` - REST API
- `http://host:port/health` - Health check

### multiagent-cli (Management Tools)

```
multiagent-cli start [options]  Start REST-only server (legacy)
  -p, --port <port>             Port (default: 3000)
  -h, --host <host>             Host (default: localhost)
  --cwd <path>                  Working directory

multiagent-cli chat             Interactive chat mode

multiagent-cli status           Show system status

multiagent-cli agents [id]      List agents or show details

multiagent-cli tasks [id]       List tasks or show details

multiagent-cli hierarchy [root] Show agent hierarchy tree

multiagent-cli stop [agentId]   Stop agent(s)

multiagent-cli clear            Reset the system
```

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Run tests
npm test

# Run E2E tests (requires ANTHROPIC_API_KEY)
RUN_E2E_TESTS=true ANTHROPIC_API_KEY=xxx npm run test:e2e
```

## Documentation

- [Architecture Overview](docs/architecture.md) - Full system architecture
- [Configuration Reference](docs/configuration.md) - Environment variables and config options
- [Team Templates](docs/team-templates.md) - Team template format and examples
- [Team Schema Reference](docs/teams.md) - Full YAML schema reference
- [Sudocode Integration](docs/sudocode-integration.md) - External issue tracking
- [Troubleshooting Guide](docs/troubleshooting.md) - Common issues and solutions

## License

MIT
