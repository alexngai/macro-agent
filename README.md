# macro-agent

A multi-agent orchestration system for spawning and managing hierarchical Claude Code agents. Interact with multiple agents as if they were one.

## Features

- **Hierarchical Agent Management** - Head manager spawns and coordinates child agents
- **Event-Sourced State** - All state changes persisted via append-only event log
- **Real-time Communication** - WebSocket subscriptions for live updates
- **MCP Tool Integration** - Agents communicate via Model Context Protocol tools
- **Task Lifecycle** - Create, assign, and track tasks across agents
- **Message Routing** - Parent-child and topic-based message delivery

## Installation

```bash
npm install macro-agent
```

## Quick Start

### CLI Usage

```bash
# Start the server
npx multiagent start

# Start interactive chat
npx multiagent chat

# Check system status
npx multiagent status

# View agent hierarchy
npx multiagent hierarchy

# List all agents
npx multiagent agents

# List all tasks
npx multiagent tasks
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

## API Reference

### REST Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/status` | GET | System status |
| `/api/init` | POST | Initialize head manager |
| `/api/agents` | GET | List all agents |
| `/api/agents/:id` | GET | Get agent details |
| `/api/agents/:id/hierarchy` | GET | Get agent hierarchy |
| `/api/tasks` | GET | List all tasks |
| `/api/tasks/:id` | GET | Get task details |
| `/api/events` | GET | List events |
| `/api/conversation/message` | POST | Send message |
| `/api/conversation/history` | GET | Get history |

### WebSocket Channels

- `agents` - Agent lifecycle events
- `tasks` - Task status changes
- `conversation` - Chat messages
- `events` - All system events

### MCP Tools (Available to Agents)

| Tool | Description |
|------|-------------|
| `spawn_agent` | Spawn a child agent |
| `emit_status` | Report status to parent |
| `send_message` | Send message to another agent |
| `check_messages` | Check message inbox |
| `get_hierarchy` | View agent tree |
| `get_agent_summary` | Get agent details |
| `stop_agent` | Terminate an agent |
| `create_task` | Create a new task |
| `get_task` | Get task details |

## ACP Mode (Agent Communication Protocol)

macro-agent can run as an ACP-compliant agent, enabling external systems to spawn and control it programmatically.

### Stdio ACP (Single Client)

```bash
# Run as stdio ACP server (for spawning via acp-factory)
npx multiagent-acp --cwd /path/to/project
```

### WebSocket ACP (Multi-Client)

For scenarios where multiple clients need to connect to the same agent hierarchy simultaneously:

```bash
# WebSocket ACP server
npx multiagent-acp --ws --ws-port 3001

# WebSocket + HTTP API together
npx multiagent-acp --ws --ws-port 3001 --api --port 3000

# All transports: stdio + WebSocket + HTTP API
npx multiagent-acp --ws --ws-port 3001 --api --port 3000
```

### ACP Options

| Option | Description |
|--------|-------------|
| `--cwd <path>` | Working directory for agents |
| `--ws` | Enable WebSocket ACP server |
| `--ws-port <port>` | WebSocket port (default: 3001) |
| `--ws-host <host>` | WebSocket host (default: localhost) |
| `--api` | Enable HTTP API server |
| `--port <port>` | HTTP API port (auto-discovers if not specified) |
| `--host <host>` | HTTP API host (default: localhost) |

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

### Programmatic ACP Registration

```typescript
import { registerMacroAgent } from 'macro-agent';
import { AgentFactory } from 'acp-factory';

// Register macro-agent with acp-factory
registerMacroAgent();

// Spawn via ACP
const handle = await AgentFactory.spawn('macro-agent', {
  permissionMode: 'auto-approve',
});

// Or connect to WebSocket ACP
const ws = new WebSocket('ws://localhost:3001/acp');
// Send JSON-RPC 2.0 messages for ACP methods
```

## CLI Commands

```
multiagent start [options]    Start the server
  -p, --port <port>           Port (default: 3000)
  -h, --host <host>           Host (default: localhost)
  --cwd <path>                Working directory

multiagent chat               Interactive chat mode

multiagent status             Show system status

multiagent agents [id]        List agents or show details

multiagent tasks [id]         List tasks or show details

multiagent hierarchy [root]   Show agent hierarchy tree

multiagent stop [agentId]     Stop agent(s)

multiagent clear              Reset the system

multiagent-acp [options]      Run as ACP server
  --cwd <path>                Working directory
  --ws                        Enable WebSocket ACP
  --ws-port <port>            WebSocket port (default: 3001)
  --ws-host <host>            WebSocket host (default: localhost)
  --api                       Enable HTTP API server
  --port <port>               HTTP API port (auto-discovers)
  --host <host>               HTTP API host (default: localhost)
```

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Run tests
npm test

# Run integration tests (requires ANTHROPIC_API_KEY)
ANTHROPIC_API_KEY=xxx npm test -- src/__tests__/integration.test.ts
```

## License

MIT
