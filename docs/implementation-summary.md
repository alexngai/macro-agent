# Self-Driving Codebases: Implementation Summary

Implementation of modular team templates, pluggable integration strategies, task pull model, session continuations, and observability for macro-agent. Completed across 6 phases.

## Design Decisions

Seven resolved design decisions (RD1–RD7) guide the implementation:

| Decision | Summary |
|----------|---------|
| **RD1** | Replace hardcoded `done()` role check with `roleRegistry.hasCapability()` lookup |
| **RD2** | Share team config via EventStore status event (cross-process MCP subprocess access) |
| **RD3** | `spawn_rules` translate to capability additions (e.g., `planner: [grinder]` → `agent.spawn.grinder`) |
| **RD4** | Team `customPrompt` replaces base role `systemPrompt` entirely |
| **RD5** | Optimistic strategy is thin — validation is the judge agent's job |
| **RD6** | Team selection via `.macro-agent/config.json` with CLI `--team` override |
| **RD7** | Use `js-yaml` for YAML parsing |

## Phase 0–1: Team Template System

**New modules**: `src/teams/`, `.macro-agent/teams/self-driving/`

### Data Model (`src/teams/types.ts`)

The `TeamManifest` is the central type — a fully-resolved team after loading:

```
TeamManifest
├── TeamTopology
│   ├── root: TopologyNode        # Initial agent (always spawned)
│   ├── companions: TopologyNode[] # Peers outside the hierarchy
│   └── spawn_rules: Record<role, role[]>
├── TeamCommunication
│   ├── channels: Record<name, { signals[] }>
│   ├── subscriptions: Record<role, { channel, signals? }[]>
│   ├── emissions: Record<role, signal[]>
│   ├── routing: { status, peers[] }
│   └── enforcement: "permissive" | "strict" | "audit"
├── MacroAgentExtensions
│   ├── task_assignment: { mode: "push"|"pull", pull?: {...} }
│   ├── integration: { strategy: "queue"|"trunk"|"optimistic", config }
│   ├── lifecycle: { continuations, scaling }
│   └── observability: { metrics_window_s, snapshot_interval_s }
└── _resolved (computed at load time)
    ├── _resolvedRoles: Map<name, ResolvedTeamRole>
    ├── _loadedPrompts: Map<path, content>
    └── _mcpServers: Map<role, McpServerEntry[]>
```

### Team Loader (`src/teams/team-loader.ts`)

Seven-step loading pipeline:

1. Parse `team.yaml` with `js-yaml`
2. Validate required fields
3. Resolve each role: load `roles/<name>.yaml`, find base via `extends`, compute capabilities (add/remove)
4. Translate `spawn_rules` → capability additions
5. Load prompt markdown files
6. Load optional MCP server configs (`tools/mcp-servers.json`)
7. Validate communication topology references

Errors are typed with `TeamLoadError` and codes: `MANIFEST_NOT_FOUND`, `INVALID_MANIFEST`, `ROLE_NOT_FOUND`, `PROMPT_NOT_FOUND`, `INVALID_COMMUNICATION`.

### Team Runtime (`src/teams/team-runtime.ts`)

Three lifecycle phases:

**`initialize()`**:
1. Registers team roles into `RoleRegistry` (custom layer, highest priority)
2. Emits `team_config` discovery event to EventStore for cross-process MCP subprocess access (RD2)
3. Installs a **spawn interceptor** on `AgentManager`

**`bootstrap()`**:
1. Spawns root agent per `topology.root`
2. Spawns companions per `topology.companions` (parent: null, outside hierarchy)
3. Sets up peer subscriptions via `MessageRouter`
4. Starts continuation monitoring for daemon agents

**`teardown()`**:
- Removes spawn interceptor
- Stops lifecycle event listener

### Spawn Interceptor

The interceptor is the key integration mechanism. It intercepts every `AgentManager.spawn()` call and injects:

- **Topics**: from `communication.subscriptions[roleName]`
- **MCP servers**: from `_mcpServers[roleName]`
- **Environment variables**: `MACRO_TEAM_NAME`, `MACRO_TASK_MODE`, `MACRO_INTEGRATION_STRATEGY`
- **Custom prompt**: from loaded prompts (only if caller didn't provide one)
- **Interaction patterns**: auto-generated text for pull mode instructions, integration strategy notes

This means all downstream agents automatically receive team context without callers needing to know about the team.

### Modified Core Files

| File | Change |
|------|--------|
| `src/agent/agent-manager.ts` | Added `setSpawnInterceptor()`, `customPrompt` in spawn options, interceptor hook point before capability checks |
| `src/agent/types.ts` | Added `customPrompt`, `interactionPatterns` to `SpawnAgentOptions` |
| `src/mcp/mcp-server.ts` | Added `integrationStrategy`, `taskBackend` to `MCPServices` |
| `src/api/server.ts` | Added `GET /api/team` endpoint |

---

## Phase 2: Pluggable Integration Strategies

**New module**: `src/workspace/strategies/`

### Architecture

Before Phase 2, workers could only land changes through the merge queue. Phase 2 makes the integration path pluggable via a strategy pattern:

```
Worker done()
    │
    ├─ integrationStrategy exists?
    │      ├─ Yes → strategy.land(request)
    │      └─ No → merge queue fallback (existing path)
    │
    └─ Resolver worker?
           └─ Yes → RESOLVER_DONE + inline merge (unchanged)
```

### IntegrationStrategy Interface (`src/workspace/strategies/types.ts`)

```typescript
interface IntegrationStrategy {
  readonly name: string;
  land(request: LandRequest): Promise<LandResult>;
  initialize?(): Promise<void>;
  close?(): Promise<void>;
}
```

`LandRequest` carries `sourceBranch`, `targetBranch`, `workspacePath`, `agentId`, `taskId`, `streamId`. `LandResult` returns `status: "landed" | "conflict" | "failed"` with optional `commitHash`, `conflictFiles`, `error`.

### Built-in Strategies

| Strategy | Behavior | Use Case |
|----------|----------|----------|
| **Queue** (`queue.ts`) | Wraps existing `MergeQueueInterface`. Calls `mergeQueue.submit()` | Sequential integration with review gates |
| **Trunk** (`trunk.ts`) | Direct push with rebase-and-retry loop. `maxRetries` (default: 3). Uses `execSync` for git ops | Fast CI/CD-enforced workflows |
| **Optimistic** (`optimistic.ts`) | Same as trunk, but emits `validation:requested` event after push via EventStore | Fast with async validation by judge |

### Strategy Registry (`src/workspace/strategies/registry.ts`)

Factory registry with `register(name, factory)`, `get(name, config)`, `has()`, `list()`. `defaultStrategyRegistry` singleton pre-registers all three strategies.

Late binding via setters: `QueueIntegrationStrategy.setMergeQueue()`, `OptimisticIntegrationStrategy.setEventStore()`.

### Worker Handler Changes (`src/lifecycle/handlers/worker.ts`)

- Added `integrationStrategy?` and `taskMode?` to `WorkerHandlerDeps`
- Strategy dispatch in Step 4 before merge queue fallback
- **Pull mode**: `shouldTerminate = false` when `taskMode === "pull"` and `status === "completed"`, keeping the worker alive to claim more tasks

### Dependency Wiring

```
MCPServices.integrationStrategy
  → DoneToolDeps.integrationStrategy
    → AllHandlerDeps.integrationStrategy
      → WorkerHandlerDeps.integrationStrategy
        → strategy.land() in handleWorkerDone()
```

---

## Phase 3: Task Pull Model

**New files**: `src/mcp/tools/claim_task.ts`, `unclaim_task.ts`, `list_claimable_tasks.ts`

### Architecture

Before Phase 3, tasks were always explicitly assigned (push model). Phase 3 adds autonomous task claiming where agents pull work from a shared pool.

### Task Backend Extensions (`src/task/backend/types.ts`)

Three optional methods added to `TaskBackend`:

```typescript
claim?(agentId: AgentId, filter?: ClaimFilter): Promise<ExtendedTask | null>;
unclaim?(taskId: TaskId): Promise<void>;
listClaimable?(filter?: ClaimFilter): Promise<ExtendedTask[]>;
```

Optional to avoid breaking existing backends. `ClaimFilter` supports `tags`, `rootTasksOnly`, and `created_by`.

### InMemory Implementation (`src/task/backend/memory.ts`)

**`claim()`**:
1. Call `listClaimable()` to get candidates (pending, unblocked, unassigned)
2. Take first candidate (FIFO by creation time)
3. Re-check EventStore for contention (status still pending, not yet assigned)
4. Atomically emit "assigned" event
5. Return assigned task (or null on contention)

**`listClaimable()`**: Filters tasks by pending status, no assigned agent, matching tags/filters, and not blocked (all blockers must be completed).

### MCP Tools

| Tool | Purpose | Capability Gate |
|------|---------|-----------------|
| `claim_task` | Atomically claim next available task | `task.claim` |
| `unclaim_task` | Return claimed task to pending pool | `task.claim` |
| `list_claimable_tasks` | Preview available tasks without claiming | `task.claim` |

### Capability System Changes

- Added `TASK_CAPABILITIES.CLAIM = "task.claim"` to `src/roles/capabilities.ts`
- Added to `ALL_CAPABILITIES` set
- Added `CAPABILITY_TOOL_MAP[task.claim] = ["claim_task", "unclaim_task", "list_claimable_tasks"]`
- Added `"task.claim"` to `TaskCapability` union type in `src/roles/types.ts`

### Tags (`src/store/types/tasks.ts`)

Added `tags?: string[]` to `Task`, `CreateTaskOptions`, and `TaskFilter` for tag-based filtering.

---

## Phase 4: Session Continuations

### continueAgent() (`src/agent/agent-manager.ts`)

Spawns a new agent with the prior agent's context:

1. Load original agent from EventStore
2. Query status events (up to `maxMessages`, default 50)
3. Format event summaries as "Prior Session Context" markdown
4. Spawn new agent with same role/parent + resume context as `customPrompt`
5. Emit continuation event (`continuation_of: agentId`)

```typescript
interface ContinueAgentOptions {
  maxMessages?: number;      // History depth (default: 50)
  task?: string;             // Override task description
  additionalContext?: string; // Extra context to prepend
}
```

### Continuation Monitoring (`src/teams/team-runtime.ts`)

`monitorContinuations()` watches for agent lifecycle events:
- Subscribes to `agentManager.onLifecycleEvent()`
- Monitors root and companion agent IDs
- On unexpected stop (not "completed" or "cancelled"):
  - Waits 1 second
  - Calls `agentManager.continueAgent(agentId)`
  - Updates internal tracking to point to new agent

Only active when `lifecycle.continuations.enabled === true` in team manifest. Unsubscribes on teardown.

---

## Phase 5: Autonomous Observability

**New module**: `src/metrics/`

### Metrics Functions (`src/metrics/metrics.ts`)

Three pure functions that query EventStore:

| Function | Queries | Returns |
|----------|---------|---------|
| `getThroughputMetrics(store, windowMs)` | Task events (created/completed/failed) | `tasksCompleted`, `tasksFailed`, `tasksCreated`, `completedPerMinute`, `avgCompletionTimeMs` |
| `getUtilizationMetrics(store, windowMs)` | Agent list + spawn/terminate events | `activeAgents`, `totalSpawned`, `totalStopped`, `agentsByRole`, `agentsByState` |
| `getErrorMetrics(store, windowMs, limit)` | Failed status events + failed task events | `totalErrors`, `errorsByType`, `recentErrors` |

### REST API Endpoints (`src/api/server.ts`)

| Endpoint | Query Params | Description |
|----------|-------------|-------------|
| `GET /api/metrics/throughput` | `window_ms` (default: 5min) | Task completion rates |
| `GET /api/metrics/utilization` | — | Agent counts by role and state |
| `GET /api/metrics/errors` | `window_ms` (default: 30min), `limit` (default: 20) | Error counts and recent failures |

Computed inline from EventStore queries. The metrics module provides reusable functions for other consumers (monitor agents, dashboards).

---

## Phase 6: Reference Templates, Docs, and Tests

### Templates

| Template | Roles | Task Mode | Integration | Continuations |
|----------|-------|-----------|-------------|---------------|
| **self-driving** | planner, grinder, judge | Pull | Trunk | Enabled |
| **structured** | lead, developer, reviewer | Push | Queue | Disabled |

### Documentation

`docs/teams.md` covers: YAML schema reference, role definition format, push vs pull task models, integration strategy guide, both reference templates, and a minimal custom team example.

### Test Suite

37 unit tests in `src/teams/__tests__/team-system.test.ts` across 5 suites:
- Template loading (8 tests)
- TeamRuntime lifecycle (14 tests)
- Integration strategies (4 tests)
- Task pull model (4 tests)
- Metrics module (5 tests)

Additional cross-subsystem integration tests in `src/teams/__tests__/cross-subsystem.integration.test.ts` verifying:
- Strategy → worker handler dispatch
- Task backend claim/unclaim/listClaimable cycle
- Team config → spawn interceptor → worker done pipeline
- Metrics from realistic event streams
- Pull mode lifecycle (shouldTerminate behavior)

---

## File Inventory

### New Files (30)

```
src/teams/types.ts
src/teams/team-loader.ts
src/teams/team-runtime.ts
src/teams/index.ts
src/teams/__tests__/team-system.test.ts
src/teams/__tests__/cross-subsystem.integration.test.ts

src/workspace/strategies/types.ts
src/workspace/strategies/registry.ts
src/workspace/strategies/queue.ts
src/workspace/strategies/trunk.ts
src/workspace/strategies/optimistic.ts
src/workspace/strategies/index.ts

src/mcp/tools/claim_task.ts
src/mcp/tools/unclaim_task.ts
src/mcp/tools/list_claimable_tasks.ts

src/metrics/metrics.ts
src/metrics/index.ts

.macro-agent/teams/self-driving/team.yaml
.macro-agent/teams/self-driving/roles/planner.yaml
.macro-agent/teams/self-driving/roles/grinder.yaml
.macro-agent/teams/self-driving/roles/judge.yaml
.macro-agent/teams/self-driving/prompts/planner.md
.macro-agent/teams/self-driving/prompts/grinder.md
.macro-agent/teams/self-driving/prompts/judge.md

.macro-agent/teams/structured/team.yaml
.macro-agent/teams/structured/roles/lead.yaml
.macro-agent/teams/structured/roles/developer.yaml
.macro-agent/teams/structured/roles/reviewer.yaml
.macro-agent/teams/structured/prompts/lead.md
.macro-agent/teams/structured/prompts/developer.md
.macro-agent/teams/structured/prompts/reviewer.md

docs/teams.md
docs/implementation-summary.md
```

### Modified Files (12)

```
src/agent/agent-manager.ts      # setSpawnInterceptor(), continueAgent(), customPrompt
src/agent/types.ts               # ContinueAgentOptions, customPrompt, interactionPatterns
src/lifecycle/handlers/worker.ts # Strategy dispatch, pull mode shouldTerminate
src/lifecycle/handlers/index.ts  # integrationStrategy, taskMode in AllHandlerDeps
src/mcp/tools/done.ts           # integrationStrategy, taskMode in DoneToolDeps
src/mcp/mcp-server.ts           # integrationStrategy, taskBackend in MCPServices; claim tool registration
src/store/types/tasks.ts        # tags field on Task
src/task/backend/types.ts       # ClaimFilter, claim/unclaim/listClaimable optional methods
src/task/backend/memory.ts      # claim(), unclaim(), listClaimable() implementations
src/roles/types.ts              # "task.claim" in TaskCapability union
src/roles/capabilities.ts       # TASK_CAPABILITIES.CLAIM, ALL_CAPABILITIES, CAPABILITY_TOOL_MAP
src/api/server.ts               # /api/team, /api/metrics/* endpoints
```

---

## Backward Compatibility

All changes are additive. When no team is loaded:
- Spawn interceptor is not set → `spawn()` is unmodified
- `integrationStrategy` is undefined → worker handler falls back to merge queue
- `taskMode` is undefined → workers terminate after completion (push behavior)
- `claim_task`/`unclaim_task`/`list_claimable_tasks` tools are not registered (no `task.claim` capability)
- `continueAgent()` exists but is never called
- Metrics endpoints return zero-value results
- `/api/team` returns `{ active: false }`
