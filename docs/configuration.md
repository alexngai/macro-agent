# Configuration Reference

Complete reference for configuring macro-agent.

## Environment Variables

### Task Backend

| Variable | Description | Values | Default |
|----------|-------------|--------|---------|
| `MACRO_TASK_BACKEND` | Task backend type | `memory`, `sudocode` | `memory` |
| `MACRO_TASK_TOOL_MODE` | MCP tool exposure mode | `abstract`, `native`, `both`, `auto` | `auto` |

### Sudocode Integration

| Variable | Description | Values | Default |
|----------|-------------|--------|---------|
| `SUDOCODE_PROJECT_PATH` | Path to sudocode project root | Directory path | `cwd` |
| `SUDOCODE_TOOL_MODE` | Sudocode-specific tool mode | `native`, `mapped`, `both` | `mapped` |

### Agent Subprocess

These are set automatically when spawning agent subprocesses:

| Variable | Description |
|----------|-------------|
| `MACRO_AGENT_ID` | Agent's unique identifier |
| `MACRO_PARENT_ID` | Parent agent's ID (if any) |
| `MACRO_TASK_ID` | Assigned task ID (if any) |
| `MACRO_AGENT_CWD` | Working directory for this agent |
| `MACRO_INSTANCE_ID` | Global instance identifier |
| `MACRO_AGENT_SERVER_ONLY` | Set to `1` for server-only mode |

### Testing

| Variable | Description | Values | Default |
|----------|-------------|--------|---------|
| `RUN_E2E_TESTS` | Enable E2E tests | `true`, `1` | (disabled) |
| `DEBUG_E2E` | Enable E2E test debugging | `true`, `1` | (disabled) |
| `ANTHROPIC_API_KEY` | API key for integration tests | API key | (required for e2e) |

## Programmatic Configuration

### Task Backend Configuration

```typescript
import { createTaskBackend, loadTaskConfigFromEnv } from 'macro-agent';

// Load from environment
const config = loadTaskConfigFromEnv();

// Or configure manually
const config = {
  backend: {
    type: 'memory',
  },
  toolMode: 'abstract',
};

const { backend, toolProvider, toolMode } = await createTaskBackend(config, eventStore);
```

### InMemory Backend Config

```typescript
interface InMemoryBackendConfig {
  type: 'memory';
}
```

### Sudocode Backend Config

```typescript
interface SudocodeBackendConfig {
  type: 'sudocode';

  /** Path to sudocode project root (contains .sudocode/) */
  projectPath: string;

  /** ID strategy (default: 'dual') */
  idStrategy?: 'dual';

  /** Sync mode for event subscriptions */
  syncMode?: 'realtime' | 'batch';

  /** Execution tracking configuration */
  executionTracking?: ExecutionTrackingConfig;

  /** Auto-link tasks to specs when created from spec context */
  autoLinkSpecs?: boolean;

  /** Tool mode for this backend */
  toolMode?: 'native' | 'mapped' | 'both';
}
```

### Execution Tracking Options

```typescript
type ExecutionTrackingConfig =
  | { mode: 'none' }        // No execution records
  | { mode: 'bound-only' }  // Only tasks with external binding (default)
  | { mode: 'all' }         // All agent runs
  | { mode: 'filter'; filter: ExecutionFilter };
```

## Workspace Configuration

### Dataplane Config

```typescript
interface DataplaneConfig {
  /** Whether dataplane is enabled */
  enabled: boolean;

  /** Path to the git repository */
  repoPath?: string;

  /** Table prefix for dataplane tables */
  tablePrefix?: string;  // Default: 'dataplane_'

  /** Path to SQLite database file */
  dbPath?: string;

  /** Existing database connection to share */
  db?: Database.Database;

  /** Enable verbose logging */
  verbose?: boolean;  // Default: false

  /** Skip recovery process on startup */
  skipRecovery?: boolean;  // Default: false
}
```

### Workspace Directory Config

```typescript
interface WorkspaceDirectoryConfig {
  /** Base directory for worktrees */
  worktreeDir?: string;  // Default: <repoPath>/.worktrees

  /** Maximum number of concurrent worktrees */
  maxWorktrees?: number;  // Default: 50

  /** Use themed names for worktree directories */
  useThemedNames?: boolean;  // Default: false

  /** Custom themed names for worktree directories */
  themedNames?: string[];
}
```

## Agent Manager Configuration

```typescript
interface AgentManagerConfig {
  /** Default permission mode for spawned agents */
  defaultPermissionMode?: PermissionMode;

  /** Maximum agents allowed in hierarchy */
  maxAgents?: number;

  /** Timeout for agent spawn operations (ms) */
  spawnTimeout?: number;
}

type PermissionMode =
  | 'auto-approve'  // All tool calls approved automatically
  | 'auto-deny'     // All tool calls denied
  | 'callback'      // External system decides
  | 'interactive';  // User prompted for each call
```

## API Server Configuration

### CLI Options

```bash
multiagent start [options]
  -p, --port <port>           Port (default: 3000)
  -h, --host <host>           Host (default: localhost)
  --cwd <path>                Working directory

multiagent-acp [options]
  --cwd <path>                Working directory
  --ws                        Enable WebSocket ACP
  --ws-port <port>            WebSocket port (default: 3001)
  --ws-host <host>            WebSocket host (default: localhost)
  --api                       Enable HTTP API server
  --port <port>               HTTP API port (auto-discovers)
  --host <host>               HTTP API host (default: localhost)
```

### Programmatic API Server

```typescript
import { createAPIServer, createAPIApp } from 'macro-agent';

// Full server with WebSocket
const { app, server, wss } = createAPIServer({
  eventStore,
  agentManager,
  taskManager,
  messageRouter,
});

server.listen(3000);

// Express app only (for custom server setup)
const app = createAPIApp({
  eventStore,
  agentManager,
  taskManager,
  messageRouter,
});
```

## Event Store Configuration

```typescript
import { createEventStore } from 'macro-agent';

// In-memory store (for testing)
const eventStore = await createEventStore({ inMemory: true });

// SQLite store (for production)
const eventStore = await createEventStore({
  dbPath: './data/events.db',
});

// Shared database connection
const eventStore = await createEventStore({
  db: existingDatabase,
});
```

## Message Router Configuration

```typescript
import { createMessageRouter } from 'macro-agent';

const messageRouter = createMessageRouter(eventStore, {
  /** Default message priority */
  defaultPriority: 'normal',

  /** Enable activity waking for monitors */
  enableActivityWaking: true,
});
```

### Priority Levels

| Priority | Description |
|----------|-------------|
| `urgent` | Immediate delivery, interrupts current work |
| `high` | High priority, processed before normal |
| `normal` | Standard priority (default) |
| `low` | Background messages |

## Tool Mode Reference

### TaskToolMode

| Mode | Description |
|------|-------------|
| `abstract` | Generic task tools (`create_task`, `complete_task`, etc.) |
| `native` | Backend-specific tools (sudocode: `upsert_issue`, `link`, etc.) |
| `both` | Both abstract and native tools available |
| `auto` | Automatic selection based on backend |

### Sudocode Tool Mode

| Mode | Description |
|------|-------------|
| `mapped` | Map to abstract task tools (default) |
| `native` | Expose sudocode's native tools |
| `both` | Expose both tool sets |

## Example Configurations

### Development (In-Memory)

```bash
# No environment variables needed - uses defaults
npx multiagent start
```

### Production with Sudocode

```bash
export MACRO_TASK_BACKEND=sudocode
export SUDOCODE_PROJECT_PATH=/path/to/project
export MACRO_TASK_TOOL_MODE=abstract

npx multiagent start --port 3000
```

### Multi-Client ACP Server

```bash
# WebSocket + HTTP API
npx multiagent-acp --ws --ws-port 3001 --api --port 3000

# All transports: stdio + WebSocket + HTTP API
npx multiagent-acp --ws --ws-port 3001 --api --port 3000
```

### Programmatic Full Setup

```typescript
import {
  createEventStore,
  createAgentManager,
  createMessageRouter,
  createTaskBackend,
  loadTaskConfigFromEnv,
  createAPIServer,
} from 'macro-agent';

// Initialize stores
const eventStore = await createEventStore({ dbPath: './data/events.db' });

// Initialize services
const messageRouter = createMessageRouter(eventStore);
const taskConfig = loadTaskConfigFromEnv();
const { backend: taskBackend, toolMode } = await createTaskBackend(taskConfig, eventStore);

// Initialize agent manager
const agentManager = createAgentManager(eventStore, messageRouter, {
  defaultPermissionMode: 'auto-approve',
});

// Start API server
const { server } = createAPIServer({
  eventStore,
  agentManager,
  taskManager: taskBackend,
  messageRouter,
});

server.listen(3000, () => {
  console.log('macro-agent running on port 3000');
});
```
