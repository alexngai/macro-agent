# Design: Subsystem Extraction — agent-inbox & opentasks

> **Status:** Implementation Complete (V2 modules live alongside V1)
> **Date:** 2026-03-17
> **Scope:** Restructure macro-agent to delegate messaging to agent-inbox and task management to opentasks, keeping macro-agent focused on agent orchestration.

## Motivation

macro-agent was built before agent-inbox and opentasks existed. It currently owns messaging (`src/router/`, `src/map/`), task management (`src/task/`), and a large event store (`src/store/`) that tracks everything. Now that agent-inbox and opentasks are mature standalone systems with richer capabilities (federation, structured inboxes, graph-based dependencies), macro-agent should delegate these concerns and focus on what only it can do: agent lifecycle, workspace isolation, and team topology.

## Design Principles

1. **Hard dependencies.** agent-inbox and opentasks are required. No fallback modes.
2. **Adapter-side policy enforcement.** Signal filtering and emission validation are orchestration concerns — enforced in macro-agent's adapter layer, not pushed into agent-inbox.
3. **Minimal store.** macro-agent keeps a thin SQLite store for agent lifecycle and session state only. All messages flow through agent-inbox. All tasks flow through opentasks.
4. **One inbox scope per team.** Each team gets its own agent-inbox scope. Standalone agents use the `"default"` scope.
5. **Clean rewrite** of affected layers, not incremental wrapping.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    macro-agent (orchestrator)                 │
│                                                              │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────────┐ │
│  │  Agent   │  │Workspace │  │  Teams   │  │  Trigger   │ │
│  │ Manager  │  │ Manager  │  │ Runtime  │  │  System    │ │
│  └────┬─────┘  └──────────┘  └────┬─────┘  └──────┬─────┘ │
│       │                           │                │        │
│  ┌────▼───────────────────────────▼────────────────▼─────┐ │
│  │                  Adapter Layer                          │ │
│  │  ┌─────────────────┐       ┌──────────────────┐       │ │
│  │  │  InboxAdapter   │       │  TasksAdapter    │       │ │
│  │  │  - register     │       │  - createTask    │       │ │
│  │  │  - send         │       │  - transition    │       │ │
│  │  │  - onDelivery   │       │  - queryReady    │       │ │
│  │  │  - signal filter│       │  - claim/unclaim │       │ │
│  │  │  - emission val │       │                  │       │ │
│  │  └────────┬────────┘       └────────┬─────────┘       │ │
│  └───────────┼─────────────────────────┼─────────────────┘ │
└──────────────┼─────────────────────────┼───────────────────┘
               │                         │
  ┌────────────▼────────────┐  ┌─────────▼──────────┐
  │      agent-inbox        │  │     opentasks       │
  │  (embedded, hybrid)     │  │  (IPC to daemon)    │
  │                         │  │                     │
  │  - MessageRouter        │  │  - Graph store      │
  │  - IpcServer (for MCP)  │  │  - Providers        │
  │  - Traceability         │  │  - Dependencies     │
  │  - PushNotifier         │  │  - Claiming         │
  │  - Federation           │  │  - MCP tools        │
  └─────────────────────────┘  └─────────────────────┘
```

## Module Map (Post-Rewrite)

### Kept (rewired)

| Module | Purpose | Changes |
|--------|---------|---------|
| `src/agent/` | Agent lifecycle (spawn, terminate, resume, continue, fork) | Drop EventStore/MessageRouter deps, use adapters + AgentStore |
| `src/workspace/` | Worktrees, merge queue, integration strategies | Unchanged — pure git operations |
| `src/teams/` | Team topology, role resolution, spawn interception | Rewire: inbox scope per team, adapter-side signal enforcement |
| `src/roles/` | Role registry, capabilities | Unchanged |
| `src/lifecycle/` | Done handlers, cascade termination | Rewire: done → tasksAdapter + agentManager.terminate |
| `src/trigger/` | Wake management, cron, webhooks | Rewire: inbox.message events feed WakeManager |
| `src/mcp/` | MCP server for macro-agent-specific tools | Shrink to `done` + `inject_context` only |
| `src/acp/` | External protocol adapter | Rewire to use adapters |
| `src/cli/` | CLI commands | Rewire to use adapters |
| `src/metrics/` | Observability | Unchanged |

### New

| Module | Purpose |
|--------|---------|
| `src/adapters/inbox-adapter.ts` | Wraps agent-inbox for macro-agent's use |
| `src/adapters/tasks-adapter.ts` | Wraps opentasks client for macro-agent's use |
| `src/adapters/types.ts` | Adapter interfaces |
| `src/agent/agent-store.ts` | Minimal SQLite store (agents + sessions) |

### Deleted

| Module | Lines (approx) | Replaced by |
|--------|----------------|-------------|
| `src/router/` | ~2,000 | agent-inbox |
| `src/map/` | ~1,500 | agent-inbox |
| `src/task/` | ~1,500 | opentasks |
| `src/store/` | ~2,500 | agent-store.ts (~200 lines) |
| `src/steering/` | ~200 | Folded into `mcp/tools/inject_context.ts` |

~7,700 lines removed, ~600 lines added (adapters + store).

## Component Designs

### 1. InboxAdapter

Wraps an embedded `AgentInbox` instance. Owns signal filtering and emission validation as interceptors.

```typescript
interface InboxAdapter {
  // Agent lifecycle — called by AgentManager on spawn/terminate
  registerAgent(agentId: string, opts: {
    name?: string;
    role: string;
    scope: string;
    metadata?: Record<string, unknown>;
  }): Promise<void>;

  deregisterAgent(agentId: string): Promise<void>;

  // Sending — called by team-runtime, done handlers, lifecycle
  // Emission validation runs before forwarding to agent-inbox
  send(from: string, to: string | string[], content: MessageContent, opts?: {
    threadTag?: string;
    importance?: Importance;
    scope?: string;
    subject?: string;
  }): Promise<string>; // returns messageId

  // Delivery subscription — macro-agent reacts to deliveries
  // Signal filtering runs before invoking handler
  onDelivery(handler: (event: InboxDeliveryEvent) => void): void;

  // Queries
  checkInbox(agentId: string, opts?: { unreadOnly?: boolean }): Promise<Message[]>;

  // Policy hooks — set by TeamRuntime
  setSignalFilter(filter: SignalFilterFn): void;
  setEmissionValidator(validator: EmissionValidatorFn): void;

  // Access to underlying inbox (for advanced use)
  readonly inbox: AgentInbox;
}

// Signal filter: returns false to suppress delivery
type SignalFilterFn = (from: string, to: string, message: Message) => boolean;

// Emission validator: returns rejection reason or null to allow
type EmissionValidatorFn = (from: string, message: Message) => string | null;
```

**Embedding strategy (hybrid):** agent-inbox runs in-process inside macro-agent for zero-latency event access. The IPC server also runs, so agent MCP subprocesses connect directly via socket for `send_message`, `check_inbox`, etc.

```typescript
// Boot sequence
const inbox = await createAgentInbox({
  sqlitePath: path.join(baseDir, 'inbox.db'),
  config: {
    scope: 'default',
    socketPath: path.join(baseDir, 'inbox.sock'),
  },
});

const inboxAdapter = new InboxAdapter(inbox);

// macro-agent subscribes to delivery events in-process
inbox.events.on('inbox.message', (event) => {
  inboxAdapter.handleDelivery(event);
});
```

### 2. TasksAdapter

Wraps `OpenTasksClient` via IPC to the opentasks daemon. macro-agent ensures the daemon is running at boot (auto-start if needed), then lets opentasks manage its own lifecycle.

```typescript
interface TasksAdapter {
  // Task lifecycle — called by AgentManager, done handlers
  createTask(opts: {
    title: string;
    assignee?: string;
    parent?: string;
    tags?: string[];
    priority?: number;
  }): Promise<string>; // returns taskId

  assignTask(taskId: string, agentId: string): Promise<void>;
  transitionTask(taskId: string, action: 'start' | 'complete' | 'fail' | 'block'): Promise<void>;

  // Queries — called by team-runtime, coordinators
  getTask(taskId: string): Promise<Task>;
  queryReady(opts?: { tags?: string[]; limit?: number }): Promise<Task[]>;
  listTasks(filter?: { status?: string; assignee?: string }): Promise<Task[]>;

  // Dependencies
  addBlocker(taskId: string, blockerId: string): Promise<void>;
  removeBlocker(taskId: string, blockerId: string): Promise<void>;

  // Pull mode (gated by task.claim capability)
  claimTask(agentId: string, filter?: { tags?: string[] }): Promise<Task | null>;
  unclaimTask(taskId: string): Promise<void>;
  listClaimable(filter?: { tags?: string[] }): Promise<Task[]>;

  // Connection lifecycle
  connect(): Promise<void>;
  disconnect(): void;
}
```

**Daemon lifecycle:** macro-agent uses `OpenTasksClient({ autoConnect: true })`. If the daemon isn't running, opentasks auto-starts it on first request. macro-agent's boot sequence verifies connectivity:

```typescript
const tasksAdapter = new TasksAdapter();
await tasksAdapter.connect(); // auto-starts daemon if needed
```

### 3. AgentStore

Replaces the entire `src/store/` directory. No event sourcing, no materialized views — just two SQLite tables.

```sql
CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'running',  -- running | idle | stopped
  parent_id TEXT,
  team TEXT,
  scope TEXT DEFAULT 'default',
  cwd TEXT,
  capabilities TEXT,  -- JSON array
  workspace_path TEXT,
  workspace_stream_id TEXT,
  task_id TEXT,        -- opentasks task ID
  created_at TEXT NOT NULL,
  stopped_at TEXT,
  stop_reason TEXT,
  metadata TEXT        -- JSON blob for extensible fields
);

CREATE TABLE sessions (
  agent_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  handle_data TEXT,    -- serialized acp-factory handle info
  created_at TEXT NOT NULL,
  FOREIGN KEY (agent_id) REFERENCES agents(id)
);
```

```typescript
interface AgentStore {
  putAgent(agent: AgentRecord): void;
  getAgent(id: string): AgentRecord | null;
  listAgents(filter?: AgentFilter): AgentRecord[];
  updateAgent(id: string, updates: Partial<AgentRecord>): void;
  removeAgent(id: string): void;

  putSession(session: SessionRecord): void;
  getSession(agentId: string): SessionRecord | null;
  removeSession(agentId: string): void;

  // Hierarchy queries (needed for cascade termination, team membership)
  getChildren(parentId: string): AgentRecord[];
  getDescendants(agentId: string): AgentRecord[];
  getAncestors(agentId: string): AgentRecord[];

  close(): void;
}
```

### 4. Agent Lifecycle Flows

#### Spawn

```
AgentManager.spawn(options)
  1. agentStore.putAgent({ id, role, state: 'running', parent, team, scope })
  2. AgentFactory.spawn() → process handle
  3. if worker role:
       workspace = workspaceManager.createWorktree()
       agentStore.updateAgent(id, { workspace_path, workspace_stream_id })
  4. taskId = tasksAdapter.createTask({ title, assignee: id })
     agentStore.updateAgent(id, { task_id: taskId })
  5. inboxAdapter.registerAgent(id, { name, role, scope })
  6. buildMcpServer({ cwd })  // only done + inject_context
  7. agentStore.putSession({ agent_id: id, session_id, handle_data })
  8. handle.createSession(effectiveCwd)
```

#### Terminate

```
AgentManager.terminate(agentId, reason)
  1. cascadeTerminate(children)  // depth-first
  2. if agent has workspace && reason === 'completed':
       branch = getCurrentBranch(workspace.path)
       workspaceManager.submitMergeRequest({ branch, streamId, taskId })
  3. tasksAdapter.transitionTask(taskId, reason === 'completed' ? 'complete' : 'fail')
  4. inboxAdapter.deregisterAgent(agentId)
  5. workspaceManager.cleanup(workspace)
  6. agentStore.updateAgent(agentId, { state: 'stopped', stopped_at, stop_reason })
  7. agentStore.removeSession(agentId)
```

#### Done handler (simplified)

```
done({ status, summary })
  1. tasksAdapter.transitionTask(taskId, mapStatus(status))
  2. inboxAdapter.send(agentId, parentId, {
       type: 'event',
       event: 'task_completed',
       data: { taskId, status, summary }
     }, { importance: 'high' })
  3. return { terminate: true, reason: status }
     // AgentManager.terminate() handles merge request submission
```

The agent never constructs merge requests. The system reads workspace state during termination.

### 5. Team Runtime (Rewired)

#### Bootstrap

```
TeamRuntime.initialize(manifest)
  1. scope = manifest.name  // one inbox scope per team
  2. Register resolved roles in RoleRegistry
  3. Install spawn interceptor on AgentManager
  4. Install signal filter + emission validator on InboxAdapter
  5. Spawn root agent (scope = teamName)
  6. Spawn companion agents (same scope)
```

#### Signal filtering (adapter-side)

```typescript
// TeamRuntime installs this on InboxAdapter
inboxAdapter.setSignalFilter((from, to, message) => {
  const fromAgent = agentStore.getAgent(from);
  const toAgent = agentStore.getAgent(to);

  // Both must be in this team (or allow cross-team)
  if (fromAgent?.team !== teamName && toAgent?.team !== teamName) {
    return true; // not our concern
  }

  // Check if toAgent's role subscribes to this signal type
  const toRole = manifest.roles[toAgent.role];
  const signalType = extractSignalType(message);
  return isAllowedBySubscription(toRole, signalType);
});
```

#### Emission validation (adapter-side)

```typescript
inboxAdapter.setEmissionValidator((from, message) => {
  const agent = agentStore.getAgent(from);
  if (agent?.team !== teamName) return null; // not our concern

  const role = manifest.roles[agent.role];
  const signalType = extractSignalType(message);

  if (!role.allowedEmissions?.includes(signalType)) {
    return `Role ${agent.role} cannot emit ${signalType}`;
  }
  return null; // allowed
});
```

#### Channel mapping

Team YAML channels map to agent-inbox thread tags within the team's scope:

```yaml
# team.yaml
communication:
  channels:
    - name: work_coordination
      signals: [task_assigned, task_completed]
    - name: code_review
      signals: [review_requested, review_completed]
```

Becomes:
- Messages on `work_coordination` → `threadTag: "work_coordination"` in scope `teamName`
- Messages on `code_review` → `threadTag: "code_review"` in scope `teamName`

### 6. Trigger System (Rewired)

The trigger system stays but rewires its inputs:

```
                    ┌─────────────────────┐
                    │   inbox.message      │ (from InboxAdapter.onDelivery)
                    │   events             │
                    └──────────┬──────────┘
                               │
  ┌────────────┐               │          ┌────────────┐
  │   Cron     ├───┐           │     ┌────┤  Webhook   │
  │  Service   │   │           │     │    │  Handler   │
  └────────────┘   ▼           ▼     ▼    └────────────┘
              ┌────────────────────────────┐
              │      TriggerRouter         │
              │  (role, direct, AI strat)  │
              └──────────┬─────────────────┘
                         │
              ┌──────────▼─────────────────┐
              │    SystemEventQueue         │
              │  (per-agent, in-memory)     │
              └──────────┬─────────────────┘
                         │
              ┌──────────▼─────────────────┐
              │      WakeManager            │
              │  heartbeat + coalesce       │
              │  inject → interrupt → prompt│
              └─────────────────────────────┘
```

**Key change:** Inbox delivery events feed into WakeManager's delivery chain. The WakeManager decides *how* to deliver (inject/interrupt/prompt) based on message importance and agent state.

```typescript
inboxAdapter.onDelivery((event) => {
  const action = mapImportanceToWakeAction(event.message.importance, agentState);
  switch (action) {
    case 'interrupt': wakeManager.deliverToAgent(event.agentId, event.message, 'interrupt'); break;
    case 'inject':    wakeManager.deliverToAgent(event.agentId, event.message, 'inject'); break;
    case 'wake':      wakeManager.deliverToAgent(event.agentId, event.message, 'prompt'); break;
    case 'queue':     systemEventQueue.enqueue(event.agentId, event.message); break;
  }
});
```

### 7. MCP Tool Surface Per Agent

Each agent gets tools from three sources, mounted as separate MCP servers:

| Source | Tools | Mount method |
|--------|-------|-------------|
| **agent-inbox** | `send_message`, `check_inbox`, `read_thread`, `list_agents` | IPC socket → agent-inbox's MCP server |
| **opentasks** | `link`, `query`, `annotate`, `task` | IPC socket → opentasks' MCP server |
| **macro-agent** | `done`, `inject_context` | Built into macro-agent's per-agent MCP server |

macro-agent's MCP server shrinks from ~10 tools to 2. Task tools (`create_task`, `assign_task`, `claim_task`, etc.) are removed — opentasks' `task` tool handles all of these with richer semantics (dependencies, providers, ready queries).

### 8. agent-inbox Embedding (Hybrid)

agent-inbox is embedded in-process for macro-agent's direct event access, with IPC server running for agent subprocesses.

```
┌─────────────────────────────────────────┐
│            macro-agent process            │
│                                          │
│  ┌──────────────────────────────────┐   │
│  │  agent-inbox (embedded)           │   │
│  │  - MessageRouter                  │   │
│  │  - Storage (SQLite)               │   │
│  │  - Traceability                   │   │
│  │  - PushNotifier                   │   │
│  │  - IpcServer ◄────────────────────┼───┼── MCP subprocess connects via socket
│  │  - Federation (optional)          │   │
│  └──────────────────┬───────────────┘   │
│                     │                    │
│    inbox.events ────┤                    │
│    (in-process,     │                    │
│     zero-latency)   │                    │
│                     ▼                    │
│  ┌──────────────────────────────────┐   │
│  │  InboxAdapter                     │   │
│  │  - Signal filtering               │   │
│  │  - Emission validation            │   │
│  │  - Delivery → WakeManager         │   │
│  └──────────────────────────────────┘   │
└──────────────────────────────────────────┘
```

**Why hybrid:**
- macro-agent needs zero-latency event subscription (`inbox.message`) for wake decisions
- Agent MCP subprocesses run in separate processes — they connect via IPC socket
- agent-inbox already supports this: `createAgentInbox()` starts IPC server when `socketPath` is set
- Single SQLite database for inbox state, accessible from both paths

## Migration Plan

### Phase 1: Foundation

Create adapter interfaces and AgentStore. These can be built and tested independently.

1. `src/adapters/types.ts` — Interface definitions
2. `src/adapters/inbox-adapter.ts` — Wraps `createAgentInbox()`
3. `src/adapters/tasks-adapter.ts` — Wraps `OpenTasksClient`
4. `src/agent/agent-store.ts` — Minimal SQLite store
5. Unit tests for all four

### Phase 2: Agent Manager Rewrite

Rewrite `AgentManager` to use adapters instead of EventStore/MessageRouter.

1. Replace EventStore dependency → AgentStore
2. Replace MessageRouter dependency → InboxAdapter
3. Replace TaskBackend dependency → TasksAdapter
4. Update spawn flow (see Section 4)
5. Update terminate flow (merge request on terminate)
6. Integration tests

### Phase 3: Team Runtime Rewrite

Rewire team-runtime to use inbox scopes and adapter-side policy.

1. Bootstrap creates inbox scope per team
2. Signal filter + emission validator installed on InboxAdapter
3. Channel config → thread tag conventions
4. Remove MERGE_REQUEST polling loop (handled by terminate flow)
5. Integration tests

### Phase 4: Lifecycle & Done Handlers

Simplify done handlers to delegate to adapters.

1. `done()` → tasksAdapter.transitionTask + inboxAdapter.send + terminate
2. Worker done handler loses branch reading / merge request construction
3. Integrator done handler talks to workspace manager directly
4. Integration tests

### Phase 5: Trigger System Rewire

Reconnect trigger system to inbox delivery events.

1. WakeManager receives from InboxAdapter.onDelivery
2. TriggerRouter queries AgentStore instead of EventStore
3. Remove EventStore dependency from routing strategies
4. Integration tests

### Phase 6: MCP & Tool Surface

Reconfigure per-agent MCP tool mounting.

1. Mount agent-inbox MCP tools via IPC
2. Mount opentasks MCP tools via IPC
3. Shrink macro-agent's MCP server to `done` + `inject_context`
4. Remove all task/message tools from macro-agent
5. E2E tests

### Phase 7: Delete Dead Code

Remove replaced modules.

1. Delete `src/router/`
2. Delete `src/map/`
3. Delete `src/task/`
4. Delete `src/store/`
5. Delete `src/steering/`
6. Update imports, CLAUDE.md, package.json dependencies
7. Full test suite pass

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| agent-inbox IPC latency for MCP subprocesses | Slower tool calls vs current in-process | Benchmark; inbox calls are infrequent relative to agent computation |
| opentasks daemon not running | Boot failure | `autoConnect: true` auto-starts; macro-agent verifies on boot |
| Signal filter/emission validation logic drift | Team policies not enforced | Adapter-side enforcement is tested independently; same YAML config |
| Cross-process SQLite contention (inbox) | Write conflicts | agent-inbox uses WAL mode; writes are low-frequency |
| Large migration surface | Regression risk | Phase-by-phase with integration tests at each phase |

## Dependencies

### New (hard)

- `agent-inbox` — Messaging, threading, federation
- `opentasks` — Task graph, dependencies, providers, claiming

### Removed

- `tinybase` — Was used by EventStore
- Any EventStore-specific dependencies

### Kept

- `acp-factory` — Agent process management
- `better-sqlite3` — Used by AgentStore (and agent-inbox internally)
- `nanoid` — ID generation

## Implementation Status

All V2 modules are implemented and tested. They live alongside V1 code — no V1 code was deleted.

### V2 Files Created

| File | Tests | Purpose |
|------|-------|---------|
| `src/adapters/types.ts` | — | InboxAdapter + TasksAdapter interfaces |
| `src/adapters/inbox-adapter.ts` | 19 tests | Embedded agent-inbox with adapter-side policy |
| `src/adapters/tasks-adapter.ts` | 18 tests | Opentasks client wrapper |
| `src/adapters/index.ts` | — | Public exports |
| `src/agent/agent-store.ts` | 28 tests | Minimal SQLite store (2 tables) |
| `src/agent/agent-manager-v2.ts` | 33 tests | AgentManager using adapters |
| `src/teams/team-runtime-v2.ts` | 17 tests | Team runtime using inbox scopes |
| `src/lifecycle/handlers-v2.ts` | 17 tests | Simplified done handlers |
| `src/mcp/tools/done-v2.ts` | — | Done tool using adapters |
| `src/mcp/mcp-server-v2.ts` | 6 tests | 5-tool MCP server (was 12) |
| `src/trigger/trigger-system-v2.ts` | 10 tests | Inbox→wake integration |
| `src/boot-v2.ts` | 6 tests | Full system wiring |

**Total: 154 new tests, 0 regressions to existing 3596 tests.**

### V1 → V2 Supersession Map

When ready to cut over, delete V1 modules and update imports:

| V1 Module (delete) | V2 Replacement | Notes |
|---------------------|----------------|-------|
| `src/store/` (~2500 lines) | `src/agent/agent-store.ts` (~280 lines) | Event sourcing → simple CRUD |
| `src/router/` (~2000 lines) | `src/adapters/inbox-adapter.ts` | MessageRouter → agent-inbox |
| `src/map/` (~1500 lines) | agent-inbox federation | MAP adapter → agent-inbox handles MAP |
| `src/task/` (~1500 lines) | `src/adapters/tasks-adapter.ts` | TaskBackend → opentasks client |
| `src/steering/` (~200 lines) | InboxAdapter.send() with importance | inject → inbox message |
| `src/mail/` (~800 lines) | agent-inbox traceability | Conversations → agent-inbox auto-tracks |
| `src/agent/agent-manager.ts` (V1 impl) | `src/agent/agent-manager-v2.ts` | Keep interface, swap impl |
| `src/teams/team-runtime.ts` (V1) | `src/teams/team-runtime-v2.ts` | Drop EventStore/MessageRouter deps |
| `src/lifecycle/handlers/` (V1) | `src/lifecycle/handlers-v2.ts` | Drop MessageRouter, simplify worker |
| `src/mcp/mcp-server.ts` (V1) | `src/mcp/mcp-server-v2.ts` | 12 tools → 5 tools |
| `src/mcp/tools/done.ts` (V1) | `src/mcp/tools/done-v2.ts` | Drop EventStore/TaskManager deps |
| `src/trigger/trigger-system.ts` (V1) | `src/trigger/trigger-system-v2.ts` | Drop EventStore/MessageRouter |

### Cutover Checklist

To complete the migration (swap V1 → V2 as primary):

1. Update `src/cli/index.ts` to use `bootV2()` instead of V1 server setup
2. Update `src/api/server.ts` to use V2 services
3. Update `src/acp/macro-agent.ts` to use V2 AgentManager + adapters
4. Rename V2 files to drop `-v2` suffix (or update all imports)
5. Delete V1 modules listed in supersession map above
6. Remove `tinybase` from dependencies
7. Update CLAUDE.md with new architecture
8. Run full test suite — V1 tests that test deleted modules will be removed
