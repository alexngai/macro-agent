# macro-agent

A multi-agent orchestration system for spawning and managing hierarchical AI coding agents. Delegates messaging to **agent-inbox** and task management to **opentasks**. Exposes ACP (WebSocket) and REST API servers, supports cross-instance federation, and can serve as a compute backend for cognitive-core/OpenHive.

## Project Overview

macro-agent enables coordinated work across multiple AI agents with:
- **Role-based agents** (Worker, Integrator, Coordinator, Monitor, Analyst + custom team roles)
- **Team templates** for declarative multi-agent topologies (YAML config)
- **Pluggable integration strategies** (queue, trunk, optimistic)
- **Workspace isolation** via git worktrees (powered by git-cascade)
- **Merge queue** for serialized integration
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
│  - Creates tasks in opentasks on spawn                      │
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
└── workspace/               # Workspace isolation
    ├── workspace-manager.ts    # WorkspaceManager implementation
    ├── dataplane-adapter.ts    # Bridges to git-cascade dataplane
    ├── config.ts               # Workspace configuration
    ├── types.ts                # Workspace, WorkspaceManager interface
    ├── pool/                   # Worktree pool management
    │   ├── worktree-pool.ts
    │   ├── types.ts
    │   └── index.ts
    ├── merge-queue/            # SQLite-backed merge queue
    │   ├── merge-queue.ts
    │   ├── schema.ts
    │   ├── types.ts
    │   └── index.ts
    ├── strategies/             # Integration strategies
    │   ├── types.ts            # IntegrationStrategy interface
    │   ├── registry.ts         # Strategy factory registry
    │   ├── queue.ts            # Queue strategy (wraps merge queue)
    │   ├── trunk.ts            # Trunk strategy (direct push + rebase)
    │   ├── optimistic.ts       # Optimistic strategy (push + validation event)
    │   └── index.ts
    └── index.ts                # Public exports
```

## Key Concepts

### Subsystem Architecture

macro-agent delegates two major concerns to external subsystems:

- **agent-inbox**: All messaging (send/receive, threading, conversations, federation). Embedded in-process for zero-latency events, with IPC server for agent MCP subprocesses.
- **opentasks**: All task management (CRUD, dependencies, claiming, state transitions). Connected via IPC to opentasks daemon (auto-started if needed).

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

### Integration Strategies

Pluggable strategies for landing worker changes:
- **Queue** (`queue.ts`): Wraps merge queue with serialized integration
- **Trunk** (`trunk.ts`): Direct push with rebase-retry loop
- **Optimistic** (`optimistic.ts`): Same as trunk + emits validation event

### Workspace Isolation

Each worker gets an isolated git worktree via the WorkspaceManager (backed by git-cascade). Changes are merged at the terminate level — `AgentManagerV2.terminate()` calls `terminateWithChangeConsolidation()` which handles merge requests. Agents never construct merge requests directly.

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

### Done Handler Flow (V2)

1. Agent calls `done()` MCP tool with status + summary
2. MCPServerV2 dispatches to `createDoneHandlerV2()` which builds a handler using `HandlerDepsV2` (InboxAdapter, TasksAdapter, AgentManager)
3. Role-specific handler runs:
   - **Worker**: Commits changes, emits `work:done` signal to parent via InboxAdapter, transitions task via TasksAdapter
   - **Coordinator**: Emits completion signal, cascade-terminates children if needed
   - **Monitor**: Emits health report
4. If `shouldTerminate`, AgentManagerV2 handles termination including workspace cleanup and change consolidation

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

- **Unit tests**: `*.test.ts` — Fast, mocked dependencies (~40 test files)
- **E2E tests**: `*.e2e.test.ts` — Full system tests (11 test files)

Run tests:
```bash
npm test                              # Run all unit tests (watch mode)
npx vitest run                        # Run all unit tests (single run)
npm run test:e2e                      # E2E tests (mocked agent sessions)
npm run test:e2e-full-agents          # E2E tests with real agent spawning (RUN_FULL_AGENT_TESTS=true)
```

E2E test files:
- `agent-lifecycle.e2e.test.ts` — Spawn, prompt, terminate flows
- `cognitive-workspace.e2e.test.ts` — Cognitive-core backend workspace operations
- `done-scenarios.e2e.test.ts` — Done handler scenarios per role
- `workspace-lifecycle.e2e.test.ts` — Worktree allocation and cleanup
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
| `git-cascade` | Git worktree and merge queue operations |
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

- [docs/teams.md](docs/teams.md) - Team template schema reference
- [docs/team-templates.md](docs/team-templates.md) - Team template format and examples
