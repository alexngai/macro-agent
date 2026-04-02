# macro-agent

A multi-agent orchestration system for spawning and managing hierarchical AI coding agents. Interact with multiple agents as if they were one.

macro-agent handles **orchestration** (agent lifecycle, team topology, workspace isolation, trigger/wake) and delegates **messaging** to [agent-inbox](https://github.com/alexngai/agent-inbox) and **task management** to [opentasks](https://github.com/alexngai/opentasks). It exposes ACP (WebSocket) and REST API servers, supports cross-instance federation, and can serve as a compute backend for [cognitive-core](https://github.com/alexngai/cognitive-core)/OpenHive.

## Features

- **Hierarchical Agent Management** — Head manager spawns and coordinates child agents via acp-factory
- **Role-Based Agents** — Worker, Integrator, Coordinator, Monitor, Analyst roles with distinct capabilities
- **Team Templates** — Declarative YAML configs for multi-agent topologies with composite signal filtering
- **Workspace Isolation** — Each worker gets an isolated git worktree via git-cascade
- **Merge Queue** — Serialized integration of worker changes with conflict resolution
- **Control Socket** — NDJSON-over-UNIX-socket RPC for MCP subprocess lifecycle operations
- **Trigger System** — Pluggable routing strategies (direct, role, head, AI router) for wake, cron, and webhook-based agent activation
- **MCP Tools** — 5 core orchestration tools + 3 pull-mode claim tools per agent
- **Task Modes** — Push (coordinator assigns) or pull (agents claim from pool)
- **Agent Detection** — Auto-discovers installed CLI coding agents (Claude Code, Codex, etc.)
- **ACP Protocol Server** — WebSocket transport bridging ACP protocol to macro-agent services
- **REST API** — HTTP endpoints for agents, tasks, teams, and metrics
- **Federation** — Cross-instance communication via federated agent-inbox (addressable as `agentId@systemId`)
- **Cognitive-Core Backend** — Serves as compute backend for OpenHive (analyst agent spawning, batch execution)
- **Metrics** — Point-in-time snapshots of agent, task, and system health

## Installation

```bash
npm install macro-agent
```

## Quick Start

### Programmatic Usage

```typescript
import { bootV2 } from 'macro-agent';

// Boot the system — initializes AgentStore, InboxAdapter, TasksAdapter,
// AgentManager, TriggerSystem, and ControlServer
const system = await bootV2({ cwd: process.cwd() });

// Create a head manager agent
const headManager = await system.agentManager.getOrCreateHeadManager({
  cwd: process.cwd(),
});

// Send a prompt and stream the response
for await (const update of system.agentManager.prompt(headManager.id, 'Build feature X')) {
  // Handle streaming response
}

// Shut down cleanly
await system.shutdown();
```

### CLI

```bash
# Start the system and enter interactive chat
npx multiagent-cli chat

# Check system status
npx multiagent-cli status

# View agent hierarchy
npx multiagent-cli hierarchy

# List all agents
npx multiagent-cli agents

# Stop an agent or all agents
npx multiagent-cli stop <agentId>
npx multiagent-cli stop --all

# Clear all data (agents.db, inbox.db)
npx multiagent-cli clear

# Start as ACP server (for embedding via acp-factory)
npx multiagent --acp
```

## Architecture

```
              CLI / ACP stdio / WebSocket / REST API
                              │
                         ┌────▼────┐
                         │ bootV2  │  Wires all components
                         └────┬────┘
                              │
       ┌──────────┬───────────┼───────────┬──────────┐
       │          │           │           │          │
 ┌─────▼─────┐ ┌─▼───────┐ ┌▼────────┐ ┌▼───────┐ ┌▼──────────┐
 │  Agent    │ │ Trigger  │ │ Control │ │  ACP   │ │ REST API  │
 │  Manager  │ │ System   │ │ Socket  │ │ Server │ │ Server    │
 │           │ │          │ │ (RPC)   │ │ (WS)   │ │ (HTTP)    │
 │  spawn    │ │ router   │ └────┬────┘ └────────┘ └───────────┘
 │  prompt   │ │ wake     │      │
 │  terminate│ │ cron     │  MCP subprocesses
 └─────┬─────┘ │ webhook  │  (per agent)
       │       │ ai-router│
 ┌─────┼───────┘──────────┐
 │     │                  │
┌▼────┐┌▼──────────┐ ┌───▼────────┐
│Roles││ Workspace  │ │  Adapters  │
│    ││ Worktrees  │ │            │
│    ││ Strategies │ │ InboxAdapter ──► agent-inbox (embedded)
│    ││ MergeQueue │ │ TasksAdapter ──► opentasks  (IPC daemon)
└────┘└────────────┘ │ Federation ──► remote instances
                     └────────────┘
```

**Three subsystems:**
- **macro-agent** — Orchestration, lifecycle, teams, workspace, triggers, ACP/REST servers, federation, cognitive backend, metrics
- **agent-inbox** — Messaging (embedded in-process, IPC server for subprocesses, federation)
- **opentasks** — Task management (separate daemon, IPC client)

## Team Templates

Teams define multi-agent topologies as YAML configuration:

```bash
# Start with a team template
npx multiagent --team self-driving
```

Teams are stored in `.multiagent/teams/<name>/`:

```
.multiagent/teams/self-driving/
├── team.yaml          # Team manifest (topology, communication, strategy)
├── roles/
│   ├── planner.yaml   # Custom role (extends coordinator)
│   └── grinder.yaml   # Custom role (extends worker)
└── prompts/
    ├── planner.md     # Role-specific system prompt
    └── grinder.md
```

Key team features:
- **Topology**: Root + companion agents spawned at bootstrap, with spawn rules for dynamic workers
- **Communication**: Topic-based channels with per-role signal filtering and peer-to-peer routing
- **Multi-team**: Multiple teams run concurrently with composite signal filters and emission validators
- **Integration strategies**: `queue` (merge queue), `trunk` (direct push), `optimistic` (push + validation)
- **Task modes**: `push` (coordinator assigns) or `pull` (agents claim from pool)

See [docs/teams.md](docs/teams.md) for the full schema reference.

## MCP Tools

Each agent gets tools from three sources:

| Source | Tools |
|--------|-------|
| **macro-agent** | `done`, `spawn_agent`, `stop_agent`, `get_hierarchy`, `inject_context` |
| **macro-agent** (pull mode) | `claim_task`, `unclaim_task`, `list_claimable_tasks` |
| **agent-inbox** (IPC) | `send_message`, `check_inbox`, `read_thread`, `list_agents` |
| **opentasks** (IPC) | `task`, `link`, `annotate`, `query` |

## Role System

| Role | Purpose | Key Capabilities |
|------|---------|------------------|
| **Worker** | Execute tasks in isolated workspace | File I/O, git operations, task completion |
| **Integrator** | Manage merge queue and resolve conflicts | Merge operations, branch management |
| **Coordinator** | Orchestrate workers and manage tasks | Spawn agents, assign tasks, broadcast |
| **Monitor** | Health monitoring and alerts | Read-only access, activity watching |

Custom roles extend built-in roles via YAML with `capabilities_add`/`capabilities_remove`.

## ACP Protocol Server

The ACP server bridges the [Agent Client Protocol](https://github.com/anthropics/acp) to macro-agent:

```typescript
const system = await bootV2({
  acp: { enabled: true, port: 8080 },
});
```

- Maps `session/new` → head manager creation, `session/prompt` → streaming responses
- Extension methods: `_macro/spawnAgent`, `_macro/getHierarchy`, `_macro/mountAgent`, `_macro/forkAgent`, etc.
- WebSocket transport for real-time communication

## REST API

```typescript
const system = await bootV2({
  api: { enabled: true, port: 3000 },
});
```

HTTP endpoints for agents, tasks, teams, and metrics. Used for dashboards and external tooling.

## Federation

Connect multiple macro-agent instances for cross-instance agent communication:

```typescript
const system = await bootV2({
  federation: {
    systemId: 'dev-laptop',
    peers: [{ systemId: 'ci-server', url: 'ws://ci:8080' }],
    trust: { allowedSystems: ['ci-server'] },
  },
});
```

Agents address across instances with `agentId@systemId` (e.g., `coordinator@ci-server`).

## Cognitive-Core Backend

macro-agent can serve as a compute backend for [cognitive-core](https://github.com/alexngai/cognitive-core) / OpenHive:

```typescript
import { MacroAgentBackend } from 'macro-agent/cognitive';

const backend = new MacroAgentBackend(system.agentManager, {
  tasksAdapter: system.tasksAdapter,
  inboxAdapter: system.inboxAdapter,
});
```

Spawns analyst agents, manages sessions with timeouts, and reports completion. The swarm is pure compute — atlas, trajectory extraction, and team coordination are handled by OpenHive.

## Dependencies

| Package | Purpose |
|---------|---------|
| [agent-inbox](https://github.com/alexngai/agent-inbox) | Messaging, threading, federation |
| [opentasks](https://github.com/alexngai/opentasks) | Task graph, dependencies, claiming |
| [acp-factory](https://github.com/alexngai/acp-factory) | Agent process management |
| [openteams](https://github.com/alexngai/openteams) | Team template resolution |
| [git-cascade](https://github.com/alexngai/git-cascade) | Git worktree and merge operations |
| [express](https://expressjs.com/) | REST API server |
| [ws](https://github.com/websockets/ws) | ACP WebSocket transport |

## Testing

```bash
# Unit tests (watch mode)
npm test

# Unit tests (single run)
npx vitest run

# E2E tests (mocked agent sessions)
npm run test:e2e

# E2E tests with real agent spawning
RUN_FULL_AGENT_TESTS=true npm run test:e2e-full-agents
```

## Development

```bash
npm install          # Install dependencies
npm run build        # Build (TypeScript → dist/)
npm run dev          # Watch mode build
```

## License

MIT
