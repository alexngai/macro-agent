# Architecture Overview

This document describes the architecture of macro-agent, a multi-agent orchestration system for managing hierarchical Claude Code agents.

## System Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              External Interfaces                             │
│                                                                              │
│   ┌──────────────┐    ┌──────────────┐    ┌──────────────────────────────┐  │
│   │     CLI      │    │   REST API   │    │      WebSocket ACP           │  │
│   │  multiagent  │    │  /api/*      │    │  ws://host:3001/acp          │  │
│   │  start|chat  │    │              │    │  (multi-client, mount/fork)  │  │
│   └──────┬───────┘    └──────┬───────┘    └──────────────┬───────────────┘  │
│          │                   │                           │                   │
│          └───────────────────┼───────────────────────────┘                   │
│                              │                                               │
└──────────────────────────────┼───────────────────────────────────────────────┘
                               │
┌──────────────────────────────▼───────────────────────────────────────────────┐
│                            Agent Manager                                      │
│                                                                               │
│  ┌─────────────────────────────────────────────────────────────────────────┐ │
│  │  spawn(task, role, config)  │  prompt(id, message)  │  stop(id)         │ │
│  │  getOrCreateHeadManager()   │  getSession(id)       │  isPrompting(id)  │ │
│  └─────────────────────────────────────────────────────────────────────────┘ │
│                                                                               │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐           │
│  │   Head Manager   │──│   Child Agent    │──│   Child Agent    │           │
│  │   (Coordinator)  │  │   (Worker)       │  │   (Integrator)   │           │
│  └──────────────────┘  └──────────────────┘  └──────────────────┘           │
│           │                     │                     │                      │
│           └─────────────────────┼─────────────────────┘                      │
│                                 │ acp-factory subprocess                     │
└─────────────────────────────────┼────────────────────────────────────────────┘
                                  │
        ┌─────────────────────────┼─────────────────────────┐
        │                         │                         │
        ▼                         ▼                         ▼
┌───────────────┐        ┌───────────────┐        ┌───────────────┐
│  Role System  │        │   Workspace   │        │ Task Backend  │
│               │        │   Manager     │        │               │
│  Worker       │        │               │        │  memory       │
│  Integrator   │        │  Bare Repo    │        │  sudocode     │
│  Coordinator  │        │  Worktrees    │        │               │
│  Monitor      │        │  Pool         │        │               │
└───────────────┘        └───────────────┘        └───────────────┘
        │                         │                         │
        └─────────────────────────┼─────────────────────────┘
                                  │
┌─────────────────────────────────▼────────────────────────────────────────────┐
│                           Message Router                                      │
│                                                                               │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐              │
│  │  MAP Addresses  │  │   Structural    │  │  Hierarchical   │              │
│  │  { agent }      │  │  { scope/role } │  │ { parent/child }│              │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘              │
│                                                                               │
│  Priority Ordering: urgent > high > normal > low                              │
│  Activity Waking: wake sleeping agents on relevant events                     │
└─────────────────────────────────┬────────────────────────────────────────────┘
                                  │
┌─────────────────────────────────▼────────────────────────────────────────────┐
│                             Event Store                                       │
│                                                                               │
│  ┌───────────────────────────────────────────────────────────────────────┐   │
│  │                        Append-Only Event Log                          │   │
│  │  AgentEvent | TaskEvent | MessageEvent | SystemEvent                  │   │
│  └───────────────────────────────────────────────────────────────────────┘   │
│                                    │                                          │
│  ┌────────────────┐  ┌────────────────┐  ┌────────────────┐                 │
│  │ Agents Table   │  │  Tasks Table   │  │ Messages Table │                 │
│  │ (materialized) │  │ (materialized) │  │ (materialized) │                 │
│  └────────────────┘  └────────────────┘  └────────────────┘                 │
│                                                                               │
│  Backend: SQLite (default) or Memory                                          │
└──────────────────────────────────────────────────────────────────────────────┘
```

## Component Details

### Agent Manager

The Agent Manager is the central orchestrator for agent lifecycle:

- **Spawning**: Creates agent subprocesses via `acp-factory`
- **Prompting**: Sends messages and streams responses
- **Session Access**: Exposes sessions for context injection
- **Hierarchy**: Maintains parent-child relationships

```typescript
// Spawn a new agent
const agent = await agentManager.spawn({
  task: 'Implement feature X',
  role: 'worker',
  parent: headManagerId,
});

// Send a prompt
for await (const update of agentManager.prompt(agent.id, 'Start working')) {
  // Handle streaming response
}

// Context injection
const session = agentManager.getSession(agent.id);
await session.inject('Priority change: pause current work');
```

### Role System

Agents are assigned roles that determine their capabilities and behavior:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              Role Registry                                   │
│                                                                              │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐        │
│  │   Worker    │  │ Integrator  │  │ Coordinator │  │   Monitor   │        │
│  ├─────────────┤  ├─────────────┤  ├─────────────┤  ├─────────────┤        │
│  │ file_read   │  │ merge_ops   │  │ spawn_agent │  │ read_only   │        │
│  │ file_write  │  │ branch_mgmt │  │ assign_task │  │ activity    │        │
│  │ git_ops     │  │ conflict    │  │ broadcast   │  │ health      │        │
│  │ task_done   │  │ queue_mgmt  │  │ prioritize  │  │ alerts      │        │
│  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────┘        │
│                                                                              │
│  Resolution: role → capabilities → enforcement                               │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Role Capabilities:**

| Role | Capabilities |
|------|-------------|
| **Worker** | `file_read`, `file_write`, `git_commit`, `task_complete`, `send_message` |
| **Integrator** | `merge`, `branch_create`, `branch_delete`, `conflict_resolve`, `queue_manage` |
| **Coordinator** | `spawn_agent`, `assign_task`, `broadcast`, `priority_change`, `task_create` |
| **Monitor** | `read_only`, `activity_watch`, `health_check`, `alert_send` |

### Workspace Isolation

Workers operate in isolated git worktrees to prevent conflicts:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Workspace Manager                                  │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │                          Bare Repository                                 ││
│  │                     (shared across all agents)                           ││
│  └─────────────────────────────────────────────────────────────────────────┘│
│                                    │                                         │
│         ┌──────────────────────────┼──────────────────────────┐             │
│         │                          │                          │             │
│         ▼                          ▼                          ▼             │
│  ┌─────────────┐           ┌─────────────┐           ┌─────────────┐       │
│  │  Worktree 1 │           │  Worktree 2 │           │  Worktree 3 │       │
│  │  Worker A   │           │  Worker B   │           │  Worker C   │       │
│  │  feature/a  │           │  feature/b  │           │  feature/c  │       │
│  └──────┬──────┘           └──────┬──────┘           └──────┬──────┘       │
│         │                          │                          │             │
│         └──────────────────────────┼──────────────────────────┘             │
│                                    │                                         │
│                                    ▼                                         │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │                           Merge Queue                                    ││
│  │  ┌────────┐  ┌────────┐  ┌────────┐                                     ││
│  │  │ MR #1  │→ │ MR #2  │→ │ MR #3  │→  [Integration Branch]              ││
│  │  │ from A │  │ from B │  │ from C │                                     ││
│  │  └────────┘  └────────┘  └────────┘                                     ││
│  └─────────────────────────────────────────────────────────────────────────┘│
│                                    │                                         │
│                                    ▼                                         │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │                          Integrator                                      ││
│  │  - Processes queue in order                                              ││
│  │  - Detects and resolves conflicts                                        ││
│  │  - Merges to integration branch                                          ││
│  └─────────────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────────────┘
```

**Workspace Lifecycle:**

1. **Allocation**: Worker requests workspace from pool
2. **Creation**: Worktree created with feature branch
3. **Work**: Worker makes changes, commits
4. **Completion**: Worker calls `done()`, submits to merge queue
5. **Cleanup**: Worktree removed after merge

### Task Backend

Pluggable task management with two backends:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            TaskBackend Interface                             │
│                                                                              │
│  create() | get() | update() | assign() | start() | complete() | fail()     │
│  list() | listReady() | getBlockers() | getBlocking() | onTaskChange()      │
└─────────────────────────────────────────────────────────────────────────────┘
                    │                                     │
                    ▼                                     ▼
┌─────────────────────────────────┐    ┌─────────────────────────────────────┐
│      InMemoryTaskBackend        │    │       SudocodeTaskBackend           │
│                                 │    │                                     │
│  - Tasks stored in EventStore   │    │  - Tasks bound to sudocode issues   │
│  - Blockers via task events     │    │  - Blockers from issue links        │
│  - Fast, no external deps       │    │  - Bidirectional status sync        │
│                                 │    │  - External dependency management   │
└─────────────────────────────────┘    └─────────────────────────────────────┘
```

**Task Lifecycle:**

```
pending → assigned → in_progress → completed
                  ↘             ↗
                    → failed ←
```

**Ready Query:**

`listReady()` returns tasks that:
- Have status `pending` or `assigned`
- Have no incomplete blockers
- Match optional filter criteria

### Message Router

Inter-agent communication using MAP (Multi-Agent Protocol) addressing:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            Message Router                                    │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │                          Message Queue                                   ││
│  │                                                                          ││
│  │  Priority: urgent > high > normal > low                                  ││
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐                    ││
│  │  │ urgent:1 │ │ high:3   │ │ normal:5 │ │ low:2    │                    ││
│  │  └──────────┘ └──────────┘ └──────────┘ └──────────┘                    ││
│  └─────────────────────────────────────────────────────────────────────────┘│
│                                                                              │
│  MAP Address Types:                                                          │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐        │
│  │   Direct    │  │  Structural │  │Hierarchical │  │  Federated  │        │
│  │ { agent }   │  │ { scope }   │  │ { parent }  │  │ { system,   │        │
│  │ { agents }  │  │ { role }    │  │ { children }│  │   agent }   │        │
│  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────┘        │
│                                                                              │
│  Activity Waking:                                                            │
│  - Monitor agents wake on system events                                      │
│  - Sleeping agents wake on direct messages                                   │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Primary API:** `sendToAddress()`

```typescript
// Direct agent addressing
await router.sendToAddress({
  from: "coordinator",
  to: { agent: "worker-1" },
  content: "Start task",
});

// Role-based addressing
await router.sendToAddress({
  from: "coordinator",
  to: { role: "worker" },
  content: "Status check",
});

// Hierarchical addressing
await router.sendToAddress({
  from: "worker-1",
  to: { parent: true },
  content: "Task complete",
});

// Scope/topic addressing
await router.sendToAddress({
  from: "monitor",
  to: { scope: "alerts" },
  content: "System warning",
});
```

### Context Injection

Inject context into running agents without waiting for message checks:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          Context Injection Flow                              │
│                                                                              │
│  Source (Coordinator/API)                                                    │
│          │                                                                   │
│          ▼                                                                   │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │ 1. Try session.inject(content)                                          ││
│  │    - Direct injection into agent context                                 ││
│  │    - Appears in next turn                                                ││
│  └─────────────────────────────────────────────────────────────────────────┘│
│          │ If not supported                                                  │
│          ▼                                                                   │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │ 2. Try session.interruptWith(content)                                   ││
│  │    - Interrupt current generation                                        ││
│  │    - Inject as user message                                              ││
│  └─────────────────────────────────────────────────────────────────────────┘│
│          │ If not available                                                  │
│          ▼                                                                   │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │ 3. Send high-priority message                                           ││
│  │    - Via message router                                                  ││
│  │    - Agent sees on next check_messages                                   ││
│  └─────────────────────────────────────────────────────────────────────────┘│
│                                                                              │
│  Use Cases:                                                                  │
│  - Priority changes ("Pause X, work on Y")                                   │
│  - Urgent information ("Build failing, check types")                         │
│  - Health checks ("Report status")                                           │
│  - Context updates ("Worker 2 finished API")                                 │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Event Store

All state changes flow through the event store:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              Event Store                                     │
│                                                                              │
│  Event Types:                                                                │
│  ┌───────────────┐ ┌───────────────┐ ┌───────────────┐ ┌───────────────┐   │
│  │  AgentEvent   │ │  TaskEvent    │ │ MessageEvent  │ │ SystemEvent   │   │
│  │  - spawned    │ │  - created    │ │  - sent       │ │  - initialized│   │
│  │  - started    │ │  - assigned   │ │  - delivered  │ │  - shutdown   │   │
│  │  - stopped    │ │  - completed  │ │  - read       │ │  - error      │   │
│  │  - status     │ │  - failed     │ │               │ │               │   │
│  └───────────────┘ └───────────────┘ └───────────────┘ └───────────────┘   │
│                                                                              │
│  Storage Backend:                                                            │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │                     SQLite (default) or Memory                          ││
│  │  - Events table (append-only log)                                        ││
│  │  - Agents table (materialized view)                                      ││
│  │  - Tasks table (materialized view)                                       ││
│  │  - Messages table (materialized view)                                    ││
│  └─────────────────────────────────────────────────────────────────────────┘│
│                                                                              │
│  Subscriptions:                                                              │
│  - onAgentChange(callback)                                                   │
│  - onTaskChange(callback)                                                    │
│  - onEvent(type, callback)                                                   │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Data Flow

### Worker Task Execution

```
1. Coordinator creates task
   └─► TaskEvent { action: 'created' }

2. Coordinator spawns worker
   └─► AgentEvent { action: 'spawned', role: 'worker' }

3. Task assigned to worker
   └─► TaskEvent { action: 'assigned', agent_id: worker }

4. Worker starts task
   └─► TaskEvent { action: 'status_change', status: 'in_progress' }

5. Worker makes changes
   └─► (local git operations in worktree)

6. Worker calls done()
   └─► Commits changes
   └─► Submits to merge queue
   └─► TaskEvent { action: 'completed' }
   └─► AgentEvent { action: 'stopped' }

7. Integrator processes queue
   └─► Merges to integration branch
   └─► Cleans up worktree
```

### Multi-Client ACP Session

```
1. Client connects to WebSocket ACP
   └─► MacroAgent created for connection

2. Client creates session
   └─► newSession() → session_id

3. Client mounts to agent
   └─► _macro/mountAgent → agent_id

4. Client sends prompt
   └─► prompt() → streaming response

5. Client switches agent
   └─► _macro/mountAgent → different agent_id

6. Multiple clients can mount same agent
   └─► Shared agent hierarchy, independent sessions
```

## Security Considerations

### Workspace Isolation

- Each worker operates in separate worktree
- Changes cannot affect other workers until merged
- Integration branch protected by merge queue

### Permission Modes

| Mode | Behavior |
|------|----------|
| `auto-approve` | All tool calls approved automatically |
| `auto-deny` | All tool calls denied |
| `callback` | External system decides |
| `interactive` | User prompted for each call |

### Role Enforcement

- Capabilities checked before tool execution
- Workers cannot spawn other agents
- Monitors have read-only access
- Integrators cannot execute arbitrary code

## Performance Characteristics

### Event Store

- Write: O(1) append to log
- Read: O(log n) via SQLite indexes
- Materialized views updated on write

### Message Queue

- Priority ordering maintained on insert
- Delivery: O(1) per recipient
- Broadcast: O(n) where n = agent count

### Workspace Pool

- Pool size configurable (default: 10)
- Worktree creation: ~100ms
- Cleanup: ~50ms

## Extension Points

### Custom Roles

Implement `RoleDefinition` interface:

```typescript
const customRole: RoleDefinition = {
  name: 'custom',
  description: 'Custom role',
  capabilities: ['cap1', 'cap2'],
  enforcement: {
    workspace: { ... },
    tool: { ... },
    lifecycle: { ... },
  },
};

roleRegistry.register(customRole);
```

### Custom Task Backend

Implement `TaskBackend` interface:

```typescript
class CustomTaskBackend implements TaskBackend {
  async create(options) { ... }
  async get(id) { ... }
  async list(filter) { ... }
  // ... other methods
}
```

### Custom MCP Tools

Add tools to agent's MCP server:

```typescript
const tool = {
  name: 'custom_tool',
  description: '...',
  inputSchema: zodSchema,
  handler: async (args) => { ... },
};

mcpServer.registerTool(tool);
```
