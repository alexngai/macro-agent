# Implementation Details: Self-Driving Support

Detailed implementation plan for each phase, with resolved ambiguities, concrete interface designs, and precise code integration points.

Companion to [plan-self-driving-support.md](plan-self-driving-support.md) (high-level plan) and [team-templates.md](team-templates.md) (team template design).

---

## Ambiguities and Design Decisions

These are questions that arose when mapping the design documents to the actual codebase. Each is resolved here with rationale.

### A1: Where does TeamRuntime sit in the dependency graph?

**Problem**: TeamRuntime needs access to RoleRegistry, AgentManager, MessageRouter, TaskBackend, and IntegrationStrategy. But these services are created independently in the CLI (`src/cli/index.ts`) and passed around via dependency injection. TeamRuntime isn't a service — it's a configuration layer that modifies how existing services behave.

**Resolution**: TeamRuntime is initialized *after* core services are created but *before* any agents are spawned. It receives service references and configures them:

```typescript
// In CLI start/chat commands (or equivalent bootstrap path):
const eventStore = await createEventStore({ inMemory: false });
const messageRouter = createMessageRouter(eventStore);
const agentManager = createAgentManager(eventStore, messageRouter);
const taskBackend = createInMemoryTaskBackend(eventStore);

// NEW: Load and apply team configuration
let teamRuntime: TeamRuntime | null = null;
if (teamName) {
  const manifest = await TeamLoader.load(teamName);
  teamRuntime = new TeamRuntime(manifest, {
    roleRegistry: agentManager.getRoleRegistry(),  // exposed getter
    messageRouter,
    taskBackend,
    eventStore,
  });
  await teamRuntime.initialize();
}
```

TeamRuntime does three things at `initialize()`:
1. Registers team roles into the RoleRegistry (team layer, highest priority)
2. Sets up an IntegrationStrategy from the registry
3. Stores team state (manifest, active strategy, task mode) for later use during spawns

TeamRuntime does **not** wrap or replace AgentManager. Instead, it hooks into the spawn flow via a **spawn interceptor** pattern (see A2).

### A2: How does TeamRuntime intercept agent spawns?

**Problem**: When an agent is spawned within a team, the TeamRuntime needs to:
- Add topic subscriptions from the communication topology
- Set up peer routes
- Inject the role's static prompt
- Add MCP servers from the team config
- Set team environment variables

Currently, `AgentManager.spawn()` handles all of this. We need team context without a deep refactor.

**Resolution**: Add a `spawnInterceptor` hook to AgentManager. The interceptor receives the `SpawnAgentOptions` and returns modified options before the spawn proceeds.

```typescript
// In agent-manager.ts
type SpawnInterceptor = (options: SpawnAgentOptions) => SpawnAgentOptions | Promise<SpawnAgentOptions>;

interface AgentManagerConfig {
  // ... existing fields
  spawnInterceptor?: SpawnInterceptor;
}
```

TeamRuntime registers itself as the interceptor:

```typescript
// In TeamRuntime.initialize()
agentManager.setSpawnInterceptor((options) => {
  const roleManifest = this.manifest.roles.find(r => r.name === options.role);
  if (!roleManifest) return options; // Unknown role, pass through

  return {
    ...options,
    // Inject team topic subscriptions
    topics: [
      ...(options.topics ?? []),
      ...this.getTopicsForRole(options.role),
    ],
    // Add team MCP servers
    config: {
      ...options.config,
      mcpServers: [
        ...(options.config?.mcpServers ?? []),
        ...this.getMCPServersForRole(options.role),
      ],
      env: {
        ...options.config?.env,
        MACRO_TEAM_NAME: this.manifest.name,
        MACRO_INTEGRATION_STRATEGY: this.manifest.macro_agent.integration.strategy,
        MACRO_TASK_MODE: this.manifest.macro_agent.task_assignment.mode,
      },
    },
    // Team's custom prompt replaces the default
    customPrompt: roleManifest.prompt
      ? this.loadedPrompts.get(roleManifest.prompt)
      : options.customPrompt,
  };
});
```

The interceptor pattern is minimal — one new optional field on AgentManagerConfig, one check in spawn(). No existing code changes beyond the hook point.

**Where the hook goes in spawn()**: After options destructuring (line ~346), before capability checks (line ~379):

```typescript
async function spawn(rawOptions: SpawnAgentOptions): Promise<SpawnedAgent> {
  // Apply spawn interceptor if present
  const options = spawnInterceptor
    ? await spawnInterceptor(rawOptions)
    : rawOptions;

  const { task, task_id, parent, ... } = options;
  // ... rest of spawn continues unchanged
}
```

### A3: How do companion agents work without a parent-child relationship?

**Problem**: The self-driving team has a judge companion — a peer of the planner, not its child. But `AgentManager.spawn()` assumes every agent has a parent (except the head manager). Companions need to be discoverable via role addressing (`{ role: "judge" }`) without being in anyone's subtree.

**Resolution**: Companions are spawned by the TeamRuntime bootstrap, not by any agent. They use `parent: null` (no parent, like a head manager) but are tagged with the team name for scoping.

```typescript
// In TeamRuntime.bootstrap()
async bootstrap(): Promise<void> {
  // 1. Spawn root agent
  const root = await this.agentManager.spawn({
    task: `Team root: ${this.manifest.name}`,
    parent: null,  // head-like agent
    role: this.manifest.topology.root.role,
    config: this.manifest.topology.root.config,
  });
  this.rootAgentId = root.id;

  // 2. Spawn companions
  for (const companion of this.manifest.topology.companions ?? []) {
    const agent = await this.agentManager.spawn({
      task: `Companion: ${companion.role}`,
      parent: null,  // peer, not child
      role: companion.role,
      config: companion.config,
    });
    this.companionAgentIds.push(agent.id);
  }

  // 3. Set up peer subscriptions between root and companions
  //    (neither is in the other's subtree, so explicit subscriptions needed)
  for (const peerId of this.companionAgentIds) {
    this.setupPeerSubscriptions(this.rootAgentId, peerId);
  }
}
```

**Peer discovery**: Companions are discoverable via `{ role: "judge" }` MAP addressing because `setupDefaultSubscriptions` already subscribes agents to their role channel when `role` is provided (line 1078-1081 in message-router.ts). No changes needed for role-based discovery.

**Subtree visibility**: Since the judge is not in the planner's subtree, it won't automatically receive worker status updates. The TeamRuntime's spawn interceptor adds explicit topic subscriptions (from the communication topology) to solve this — the judge subscribes to `work_coordination` and `health` topics.

### A4: How does IntegrationStrategy inject into the done() handler?

**Problem**: The worker done() handler (in `src/lifecycle/handlers/worker.ts`) currently receives `WorkerHandlerDeps` which includes `mergeQueue?`. We need to replace (or augment) this with `integrationStrategy`. But `WorkerHandlerDeps` is used in `AllHandlerDeps` (in `handlers/index.ts`), which is constructed in `createDoneHandler` (in `mcp/tools/done.ts`) from `DoneToolDeps`.

The dependency chain is:
```
DoneToolDeps → AllHandlerDeps → WorkerHandlerDeps → mergeQueue?
```

**Resolution**: Add `integrationStrategy?` to `AllHandlerDeps` (and thus `WorkerHandlerDeps`). The worker handler checks for it first, falls back to mergeQueue:

```typescript
// In handlers/index.ts
export interface AllHandlerDeps {
  messageRouter: MessageRouter;
  agentManager: AgentManager;
  mergeQueue?: MergeQueueInterface;          // existing
  getWorkspacePath?: (agentId: string) => string | undefined;
  integrationStrategy?: IntegrationStrategy; // NEW
  taskMode?: 'push' | 'pull';               // NEW
}
```

```typescript
// In handlers/worker.ts, Step 4 (merge/integration)
if (args.status === 'completed' && context.workspacePath) {
  if (deps.integrationStrategy) {
    // NEW: use pluggable strategy
    const result = await deps.integrationStrategy.land({
      streamId: context.streamId ?? 'default',
      workerBranch: sourceBranch,
      integrationBranch: context.integrationBranch ?? 'main',
      workerAgentId: context.agentId,
      taskId: context.taskId ?? '',
      workspacePath: context.workspacePath,
    });
    // Handle result...
  } else if (deps.mergeQueue) {
    // EXISTING: fall back to merge queue (backward compatible)
    // ... current merge queue logic unchanged ...
  }
}
```

The `DoneToolDeps` gets a new optional field:

```typescript
export interface DoneToolDeps {
  // ... existing fields
  integrationStrategy?: IntegrationStrategy;
  taskMode?: 'push' | 'pull';
}
```

And in `createDoneHandler`, it passes through to `AllHandlerDeps`:

```typescript
const handlerDeps: AllHandlerDeps = {
  messageRouter,
  agentManager,
  mergeQueue: workspaceManager?.getMergeQueue?.(),
  getWorkspacePath: ...,
  integrationStrategy: deps.integrationStrategy,  // NEW
  taskMode: deps.taskMode,                         // NEW
};
```

**Where does the strategy come from at MCP server creation time?** The `MCPServices` type gets extended with optional team context:

```typescript
// In mcp-server.ts
interface MCPServices {
  // ... existing fields
  integrationStrategy?: IntegrationStrategy;
  taskMode?: 'push' | 'pull';
}
```

TeamRuntime sets these on the MCPServices when it's active. When no team is loaded, these are undefined and the existing mergeQueue path is used.

### A5: How does the pull-mode done() handler keep agents alive?

**Problem**: Currently, `handleWorkerDone` returns `{ shouldTerminate: true }` for completed/failed status. In pull mode, a completed worker should NOT terminate — it should continue its claim loop.

**Resolution**: The worker handler checks `deps.taskMode`:

```typescript
// In handlers/worker.ts, final return
if (deps.taskMode === 'pull' && args.status === 'completed') {
  return {
    shouldTerminate: false,  // Worker continues to claim next task
    warnings: handlerWarnings,
  };
}

return {
  shouldTerminate: args.status === 'completed' || args.status === 'failed',
  warnings: handlerWarnings,
};
```

The worker agent's prompt (from the team template) instructs it to call `claim_task()` after `done()`. The `done()` tool returning `shouldTerminate: false` means the MCP server stays alive and the agent can continue.

**Idle timeout**: The agent is responsible for tracking idle time. If `claim_task()` returns empty repeatedly beyond the configured `idle_timeout_s`, the agent calls `done({ status: "completed", summary: "idle exit" })`. This is conveyed in the injected interaction pattern section of the system prompt (see team-templates.md "Interaction Pattern Injection").

### A6: How does `claim_task` work with optimistic locking in InMemoryTaskBackend?

**Problem**: `InMemoryTaskBackend` wraps the EventStore. Tasks are materialized views from events. There's no explicit version field for CAS operations. Under concurrency (multiple MCP server processes calling claim), we need atomicity.

**Resolution**: The EventStore's SQLite backend serializes writes. Since all task state comes from events, a claim operation is:

1. Read task state (from materialized view)
2. Check status is `pending` or `ready` (claimable)
3. Emit an `assign` event
4. The materialized view updates the task to `assigned`

Since the EventStore is SQLite-backed and writes are serialized, two concurrent claims for the same task will be ordered — the second one will see the task is already assigned and fail.

```typescript
// In memory.ts
async claim(agentId: string, filters?: ClaimFilters): Promise<ExtendedTask | null> {
  // 1. Find claimable tasks matching filters
  const candidates = this.eventStore.listTasks({
    status: 'pending',
    ...filters,
  }).filter(t => !t.assigned_agent);

  if (candidates.length === 0) return null;

  // 2. Pick one (first match, or random for load distribution)
  const target = candidates[0];

  // 3. Try to assign — this emits an event through SQLite
  //    If another process claimed it first, the task status won't be 'pending'
  //    and assign() will throw (status transition validation)
  try {
    await this.assign(target.id, agentId);
    await this.start(target.id);
    return this.get(target.id);
  } catch {
    // Another agent claimed it — return null to retry
    return null;
  }
}
```

This is not true CAS, but it works because:
- SQLite serializes writes across processes
- `assign()` validates status transitions (only `pending` → `assigned` is valid)
- The window between read and write is small (same process, synchronous event emit)
- Under contention, the failure mode is "try again" not "corrupt state"

For the InMemory backend this is sufficient. If a higher-concurrency backend is needed later, it can implement true CAS.

### A7: How does the system prompt change for team-loaded roles?

**Problem**: Currently, `generateSystemPrompt()` in `system-prompt.ts` generates a fixed structure. Team templates provide static prompt files and interaction pattern injections. How do these compose?

**Resolution**: Extend `SystemPromptContext` with optional team fields:

```typescript
interface SystemPromptContext {
  // ... existing fields
  teamPrompt?: string;              // Static prompt from team template prompts/<role>.md
  interactionPatterns?: string[];    // Auto-injected sections (pull mode, trunk integration, etc.)
}
```

The prompt assembly order in `generateSystemPrompt()` becomes:

```
1. Identity section           ← always (agent ID, task, lineage)
2. Role section               ← existing role guidance OR team prompt (mutually exclusive)
3. Interaction patterns       ← NEW: auto-injected operational sections
4. MCP tools listing          ← always (capability-filtered)
5. Communication guidelines   ← always
6. Guidelines section         ← always (execution, error handling)
```

In `AgentManager.spawn()`, the team prompt replaces the default role section:

```typescript
// Current code (line ~421-424):
const resolvedRole = roleRegistry.resolveRole(role ?? "worker");
if (resolvedRole.systemPrompt) {
  systemPrompt += `\n\n# Role-Specific Instructions\n\n${resolvedRole.systemPrompt}`;
}

// With team support:
const resolvedRole = roleRegistry.resolveRole(role ?? "worker");
if (teamPrompt) {
  // Team prompt replaces role.systemPrompt
  systemPrompt += `\n\n# Role Instructions\n\n${teamPrompt}`;
} else if (resolvedRole.systemPrompt) {
  systemPrompt += `\n\n# Role-Specific Instructions\n\n${resolvedRole.systemPrompt}`;
}

// Append interaction pattern sections
for (const pattern of interactionPatterns ?? []) {
  systemPrompt += `\n\n${pattern}`;
}
```

The spawn interceptor (A2) provides `teamPrompt` and `interactionPatterns` via the spawn options. This requires adding these fields to `SpawnAgentOptions` and `SystemPromptContext`.

### A8: What happens to existing behavior when no team is loaded?

**Problem**: We need to ensure that without `--team`, everything works exactly as before.

**Resolution**: All new code paths are guarded by optional checks:

- No `spawnInterceptor`? Options pass through unchanged.
- No `integrationStrategy`? Worker handler falls back to `mergeQueue` (existing path).
- No `taskMode`? Done handler returns `shouldTerminate: true` (existing behavior).
- No `teamPrompt`? System prompt uses `resolvedRole.systemPrompt` (existing behavior).
- No team roles registered? RoleRegistry resolves to built-in roles (existing behavior).

The `queue` integration strategy wraps the existing merge queue with no behavioral change.

### A9: How do signal channels map to topics at runtime?

**Problem**: The team manifest defines named channels (`task_updates`, `work_coordination`, `health`) with signal lists. The router has `topic` channels. How do we bridge these?

**Resolution**: Each named channel becomes a topic. When the TeamRuntime's spawn interceptor adds topics for a role, it uses the channel names:

```yaml
# In team.yaml
communication:
  channels:
    task_updates:
      signals: [TASK_CREATED, TASK_COMPLETED, TASK_FAILED]
  subscriptions:
    planner:
      - channel: task_updates
```

Maps to:

```typescript
// In TeamRuntime.getTopicsForRole("planner")
return ["task_updates"];  // topic name = channel name
```

When an agent emits a signal (e.g., `TASK_CREATED`), it publishes to the channel's topic:

```typescript
// In a future emit_signal MCP tool (or via emit_status with signal details)
messageRouter.sendToAddress({
  from: agentId,
  to: { scope: "task_updates" },  // ScopeAddress → routes to topic subscribers
  content: JSON.stringify({ signal: "TASK_CREATED", taskId, ... }),
});
```

**Signal filtering**: For subscriptions with specific signals (e.g., `judge subscribes to task_updates but only TASK_FAILED`), filtering happens at message receive time. The agent receives all messages on the `task_updates` topic, but the MCP tool (or a thin filtering wrapper) only surfaces messages matching the subscribed signals. This avoids adding filtering complexity to the router.

Implementation options for filtering:
1. **Filter in `check_messages`**: When the MCP tool retrieves messages, apply the signal filter from the team manifest. This is simplest.
2. **Separate topics per signal**: `task_updates.TASK_CREATED`, `task_updates.TASK_FAILED`. More topics but no filtering needed. Verbose.
3. **Router-level filter**: Add filter predicates to subscriptions. Most powerful but changes the router.

**Recommendation**: Option 1 (filter in check_messages) for Phase 1. It's the least invasive. The team manifest's signal filters are stored in TeamRuntime and applied when the agent reads messages. Can upgrade to option 3 later if performance requires it.

### A10: Enforcement of emissions — where does it happen?

**Problem**: The team manifest declares what signals a role can emit. The current router has no emission restrictions.

**Resolution**: Enforcement happens at the MCP tool level, not the router level. When an agent calls `emit_status` (or a future `emit_signal` tool), the tool handler checks the team manifest's `emissions` declaration for the agent's role.

```typescript
// In the emit_status tool handler (or a wrapper)
if (teamRuntime && enforcement === 'strict') {
  const allowed = teamRuntime.getAllowedEmissions(context.role);
  if (allowed && !allowed.includes(signal)) {
    return { error: `Role ${context.role} cannot emit signal ${signal}` };
  }
}
```

For `permissive` mode, the check logs a warning but allows the emission. For `audit` mode, it records the emission in the EventStore for later analysis.

This keeps the router clean (it doesn't need to know about team-level enforcement) and is easy to implement as a thin layer in the MCP tool.

---

## Phase 1: Team Template System — Implementation Details

### 1.1 TeamManifest Types (`src/teams/types.ts`)

```typescript
// ─────────────────────────────────────────────────────────────
// Core manifest types (generic, portable)
// ─────────────────────────────────────────────────────────────

export interface TeamManifest {
  /** Team name (directory name) */
  name: string;
  /** Human-readable description */
  description: string;
  /** Schema version */
  version: number;

  /** Role names used by this team */
  roles: string[];

  /** Agent spawn topology */
  topology: TeamTopology;

  /** Communication topology */
  communication: TeamCommunication;

  /** macro-agent specific extensions */
  macro_agent: MacroAgentExtensions;

  /** Resolved role definitions (populated by TeamLoader) */
  _resolvedRoles: Map<string, ResolvedTeamRole>;
  /** Loaded prompt contents (populated by TeamLoader) */
  _loadedPrompts: Map<string, string>;
  /** Loaded MCP server configs (populated by TeamLoader) */
  _mcpServers: Map<string, McpServerConfig[]>;
}

// ─────────────────────────────────────────────────────────────
// Topology
// ─────────────────────────────────────────────────────────────

export interface TeamTopology {
  /** The initial agent spawned when the team starts */
  root: TopologyNode;
  /** Agents spawned alongside root (peers, not children) */
  companions?: TopologyNode[];
  /** Which roles can spawn which other roles */
  spawn_rules?: Record<string, string[]>;
}

export interface TopologyNode {
  role: string;
  prompt?: string;         // path to prompt file relative to team dir
  config?: {
    model?: string;
    [key: string]: unknown;
  };
}

// ─────────────────────────────────────────────────────────────
// Communication
// ─────────────────────────────────────────────────────────────

export interface TeamCommunication {
  /** Named signal channels */
  channels?: Record<string, ChannelDefinition>;
  /** Per-role subscription declarations */
  subscriptions?: Record<string, ChannelSubscription[]>;
  /** Per-role emission declarations */
  emissions?: Record<string, string[]>;
  /** Routing configuration */
  routing?: CommunicationRouting;
  /** Enforcement level */
  enforcement?: 'strict' | 'permissive' | 'audit';
}

export interface ChannelDefinition {
  description?: string;
  signals: string[];
}

export interface ChannelSubscription {
  channel: string;
  /** If omitted, subscribes to all signals in the channel */
  signals?: string[];
}

export interface CommunicationRouting {
  /** Status flow direction */
  status?: 'upstream';
  /** Explicit peer connections */
  peers?: PeerConnection[];
}

export interface PeerConnection {
  from: string;   // role name
  to: string;     // role name
  via: 'direct' | 'topic' | 'scope';
  signals?: string[];
}

// ─────────────────────────────────────────────────────────────
// macro-agent extensions
// ─────────────────────────────────────────────────────────────

export interface MacroAgentExtensions {
  task_assignment?: {
    mode: 'push' | 'pull';
    pull?: {
      idle_timeout_s?: number;
      claim_retry_delay_ms?: number;
      max_concurrent_per_agent?: number;
    };
  };

  integration?: {
    strategy: string;   // 'queue' | 'trunk' | 'optimistic' | custom name
    config?: Record<string, unknown>;
  };

  lifecycle?: {
    continuations?: {
      enabled: boolean;
      max_history_messages?: number;
      checkpoint_interval?: 'round_trip' | 'none';
    };
    scaling?: {
      min_workers?: number;
      max_workers?: number;
      scale_on?: 'task_queue_depth' | 'manual';
      idle_drain?: boolean;
    };
  };

  observability?: {
    metrics_window_s?: number;
    snapshot_interval_s?: number;
  };
}

// ─────────────────────────────────────────────────────────────
// Role definition within a team template
// ─────────────────────────────────────────────────────────────

export interface TeamRoleDefinition {
  name: string;
  extends?: string;
  display_name?: string;
  description?: string;

  /** Full replacement capability list */
  capabilities?: string[];

  /** Additive/subtractive capabilities (relative to extends) */
  capabilities_add?: string[];
  capabilities_remove?: string[];

  /** Path to prompt file (relative to team dir) */
  prompt?: string;

  /** macro-agent specific role config */
  macro_agent?: {
    workspace?: {
      type?: string;
      branch_pattern?: string;
      cleanup_on_terminate?: boolean;
    };
    lifecycle?: {
      type?: 'ephemeral' | 'persistent' | 'daemon' | 'event-driven';
      cascade_terminate?: boolean;
      self_cleanup?: boolean;
      task_bound?: boolean;
      parent_bound?: boolean;
      max_duration_ms?: number;
    };
  };
}

/** Role definition with inheritance resolved and capabilities computed */
export interface ResolvedTeamRole {
  name: string;
  baseRole: string;          // The built-in role this extends
  capabilities: string[];    // Final computed capability set
  prompt?: string;           // Loaded prompt content
  roleDefinition: import('../roles/types.js').RoleDefinition;  // For RoleRegistry
}
```

### 1.2 TeamLoader (`src/teams/team-loader.ts`)

```
TeamLoader.load(teamName: string, basePath?: string): Promise<TeamManifest>

Steps:
1. Resolve directory: basePath ?? cwd / .multiagent/teams/<teamName>/
2. Read and parse team.yaml (use yaml library, already in deps or add)
3. Validate manifest against TeamManifest schema (Zod validation)
4. For each role name in manifest.roles:
   a. Check roles/<name>.yaml exists → parse TeamRoleDefinition
   b. If not found, check if it's a built-in role name → use as-is
   c. Resolve extends chain:
      - Load parent role from RoleRegistry
      - Compute final capabilities:
        - If TeamRoleDefinition.capabilities is set → full replacement
        - If .capabilities_add/.capabilities_remove → parent.capabilities + add - remove
   d. Build ResolvedTeamRole with final RoleDefinition
5. For each prompt reference in topology and roles:
   a. Read prompts/<name>.md → store in _loadedPrompts map
6. If tools/mcp-servers.json exists:
   a. Parse → store per-role MCP server configs in _mcpServers map
7. Validate communication topology:
   a. All subscription channel refs exist in channels
   b. All emission signals exist in some channel
   c. All peer connection roles exist in manifest.roles
8. Return fully resolved TeamManifest
```

**Dependencies**: `js-yaml` for YAML parsing (add to package.json), `zod` for validation (already used).

**Error handling**: TeamLoader throws typed errors (`TeamLoadError`) with specific codes: `MANIFEST_NOT_FOUND`, `INVALID_MANIFEST`, `ROLE_NOT_FOUND`, `PROMPT_NOT_FOUND`, `INVALID_COMMUNICATION`.

### 1.3 TeamRuntime (`src/teams/team-runtime.ts`)

```typescript
export class TeamRuntime {
  private manifest: TeamManifest;
  private services: TeamServices;
  private integrationStrategy?: IntegrationStrategy;
  private rootAgentId?: string;
  private companionAgentIds: string[] = [];

  constructor(manifest: TeamManifest, services: TeamServices);

  /** Wire team config into running services */
  async initialize(): Promise<void>;

  /** Spawn root + companion agents */
  async bootstrap(): Promise<{ rootId: string; companionIds: string[] }>;

  /** Tear down team (terminate agents, clean up) */
  async teardown(): Promise<void>;

  /** Get integration strategy (for DoneToolDeps) */
  getIntegrationStrategy(): IntegrationStrategy | undefined;

  /** Get task mode (for DoneToolDeps) */
  getTaskMode(): 'push' | 'pull';

  /** Get topics a role should subscribe to (for spawn interceptor) */
  getTopicsForRole(role: string): string[];

  /** Get MCP servers for a role (for spawn interceptor) */
  getMCPServersForRole(role: string): McpServerConfig[];

  /** Get the loaded prompt for a role (for spawn interceptor) */
  getPromptForRole(role: string): string | undefined;

  /** Get interaction pattern injection sections (for spawn interceptor) */
  getInteractionPatterns(): string[];

  /** Check if a signal emission is allowed for a role */
  isEmissionAllowed(role: string, signal: string): boolean;

  /** Get active manifest (for API) */
  getManifest(): TeamManifest;
}

interface TeamServices {
  roleRegistry: DefaultRoleRegistry;
  messageRouter: MessageRouter;
  taskBackend: TaskBackend;
  eventStore: EventStore;
  agentManager: AgentManager;
}
```

### 1.4 SpawnInterceptor in AgentManager

Changes to `src/agent/agent-manager.ts`:

1. Add `spawnInterceptor?: SpawnInterceptor` to `AgentManagerConfig`
2. Add `setSpawnInterceptor(fn)` method to AgentManager
3. In `spawn()`, call interceptor before proceeding (see A2 above)
4. Add `customPrompt?: string` to `SpawnAgentOptions` for team prompt injection
5. Expose `getRoleRegistry()` getter for TeamRuntime access

### 1.5 CLI Integration

Changes to `src/cli/index.ts`:

```typescript
program
  .command("start")
  .option("--team <name>", "Load team template")
  .action(async (options) => {
    const eventStore = await createEventStore({ inMemory: false });
    const messageRouter = createMessageRouter(eventStore);
    const agentManager = createAgentManager(eventStore, messageRouter);

    // Load team if specified
    let teamRuntime: TeamRuntime | null = null;
    if (options.team) {
      const manifest = await TeamLoader.load(options.team);
      teamRuntime = new TeamRuntime(manifest, {
        roleRegistry: agentManager.getRoleRegistry(),
        messageRouter,
        taskBackend: createInMemoryTaskBackend(eventStore),
        eventStore,
        agentManager,
      });
      await teamRuntime.initialize();
    }

    // Create API server (pass teamRuntime for API endpoints)
    const server = createAPIServer(
      { eventStore, agentManager, taskManager, messageRouter, teamRuntime },
      { port: parseInt(options.port), host: options.host }
    );

    await server.start();

    // Bootstrap team agents if team loaded
    if (teamRuntime) {
      const { rootId, companionIds } = await teamRuntime.bootstrap();
      console.log(`Team '${options.team}' started: root=${rootId}, companions=${companionIds.join(', ')}`);
    }
  });
```

### 1.6 Testing Strategy

**Unit tests** (`src/teams/__tests__/`):
- `team-loader.test.ts`: Parse valid manifest, handle missing files, validate schema, resolve role inheritance, compute capabilities
- `team-runtime.test.ts`: Role registration, spawn interceptor behavior, topic computation, prompt resolution, integration strategy selection

**Integration test** (`src/teams/__tests__/team-integration.test.ts`):
- Load a fixture team template from `src/teams/__tests__/fixtures/test-team/`
- Initialize TeamRuntime with real services
- Spawn an agent and verify: correct topics subscribed, correct MCP servers, correct prompt, correct env vars

---

## Phase 2: Pluggable Integration Strategies — Implementation Details

### New Module: `src/workspace/strategies/`

```
src/workspace/strategies/
├── types.ts            # IntegrationStrategy, LandRequest, LandResult
├── registry.ts         # IntegrationStrategyRegistry
├── queue.ts            # QueueIntegrationStrategy (wraps merge queue)
├── trunk.ts            # TrunkIntegrationStrategy (push + rebase)
├── optimistic.ts       # OptimisticIntegrationStrategy (push + async validate)
└── index.ts            # Re-exports
```

### IntegrationStrategy interface (`types.ts`)

As defined in plan-self-driving-support.md. No changes needed.

### QueueIntegrationStrategy (`queue.ts`)

This wraps the existing merge queue behavior from `handleWorkerDone` Step 4 (worker.ts lines ~229-387). It extracts that logic into the strategy:

```typescript
export class QueueIntegrationStrategy implements IntegrationStrategy {
  readonly name = 'queue';
  private mergeQueue?: MergeQueueInterface;

  async initialize(streamId: string, config: Record<string, unknown>): Promise<void> {
    // mergeQueue is injected via constructor or config
  }

  async land(request: LandRequest): Promise<LandResult> {
    if (!this.mergeQueue) {
      return { status: 'failed', error: 'No merge queue configured' };
    }
    // Extract logic from current worker.ts:
    // 1. Detect source/target branch from workspace
    // 2. Submit merge request to queue
    // 3. Return result
    const entry = await this.mergeQueue.submit({
      streamId: request.streamId,
      sourceBranch: request.workerBranch,
      targetBranch: request.integrationBranch,
      agentId: request.workerAgentId,
      taskId: request.taskId,
    });
    return { status: 'landed', mergeCommit: entry.id };
  }
}
```

### TrunkIntegrationStrategy (`trunk.ts`)

```typescript
export class TrunkIntegrationStrategy implements IntegrationStrategy {
  readonly name = 'trunk';

  async land(request: LandRequest): Promise<LandResult> {
    const { maxRetries = 3, conflictAction = 'abandon' } = request.options ?? {};

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // 1. Fetch latest integration branch
        await git.fetch(request.workspacePath, 'origin', request.integrationBranch);

        // 2. Rebase worker branch onto integration branch
        await git.rebase(request.workspacePath, `origin/${request.integrationBranch}`);

        // 3. Push to integration branch
        await git.push(request.workspacePath, 'origin', request.integrationBranch);

        // 4. Get merge commit SHA
        const sha = await git.getHead(request.workspacePath);
        return { status: 'landed', mergeCommit: sha };
      } catch (error) {
        if (isConflictError(error)) {
          await git.rebaseAbort(request.workspacePath);
          if (attempt === maxRetries) {
            const conflictFiles = await git.getConflictFiles(request.workspacePath);
            return {
              status: 'conflict',
              conflictFiles,
              action: conflictAction === 'abandon' ? 'abandoned' : 'queued_for_resolution',
            };
          }
          // Retry with fresh state
          continue;
        }
        return { status: 'failed', error: String(error) };
      }
    }
    return { status: 'retry_exhausted', attempts: maxRetries };
  }
}
```

**Git operations**: These will use the same git helpers used elsewhere in the codebase (check if `src/workspace/` has git utility functions, otherwise add a thin wrapper around child_process exec of git commands).

### IntegrationStrategyRegistry (`registry.ts`)

```typescript
type StrategyFactory = (config: Record<string, unknown>) => IntegrationStrategy;

export class IntegrationStrategyRegistry {
  private factories = new Map<string, StrategyFactory>();

  register(name: string, factory: StrategyFactory): void;
  get(name: string, config?: Record<string, unknown>): IntegrationStrategy;
  has(name: string): boolean;
  list(): string[];
}

// Register built-ins at module load
export const defaultRegistry = new IntegrationStrategyRegistry();
defaultRegistry.register('queue', (config) => new QueueIntegrationStrategy(config));
defaultRegistry.register('trunk', (config) => new TrunkIntegrationStrategy(config));
defaultRegistry.register('optimistic', (config) => new OptimisticIntegrationStrategy(config));
```

### Worker handler refactor

The key change in `src/lifecycle/handlers/worker.ts` is replacing the direct merge queue calls in Step 4 with a strategy dispatch. The existing merge queue logic moves into `QueueIntegrationStrategy`. The handler becomes:

```
Step 1: Commit uncommitted changes (unchanged)
Step 2: Create checkpoints (unchanged)
Step 3: Handle blocked/deferred (unchanged)
Step 4: Emit WORKER_DONE signal (unchanged)
Step 5: Land changes via strategy (NEW)
  - if integrationStrategy: call strategy.land()
  - else if mergeQueue: existing merge queue logic (backward compat)
  - else: skip integration
Step 6: Signal descendants (unchanged)
Step 7: Return shouldTerminate based on taskMode (MODIFIED for pull mode)
```

**Backward compatibility**: When no team is loaded and no integrationStrategy is set, the handler falls back to the existing mergeQueue path. Zero behavior change for existing users.

---

## Phase 3: Task Pull Model — Implementation Details

### TaskBackend interface additions (`src/task/backend/types.ts`)

```typescript
export interface TaskBackend {
  // ... existing methods

  // NEW: Pull model
  claim(agentId: string, filters?: ClaimFilters): Promise<ExtendedTask | null>;
  unclaim(taskId: TaskId, reason?: string): Promise<void>;
  listClaimable(filters?: ClaimFilters): Promise<ExtendedTask[]>;
}

export interface ClaimFilters {
  /** Only tasks with these tags */
  tags?: string[];
  /** Only tasks with these statuses (default: ['pending']) */
  status?: string[];
  /** Exclude tasks that were previously claimed by this agent and failed */
  excludePreviousFails?: boolean;
}
```

### Tags on tasks (`src/store/types/tasks.ts`)

Add `tags?: string[]` to the task type. Tags are set at creation time and used for filtered claiming.

### New MCP tools

**`src/mcp/tools/claim_task.ts`**:
```
claim_task(filters?: { tags?: string[], status?: string[] })
  → { task: ExtendedTask } | { empty: true, message: "No claimable tasks" }
```

**`src/mcp/tools/unclaim_task.ts`**:
```
unclaim_task(task_id: string, reason?: string)
  → { success: true }
```

**`src/mcp/tools/list_claimable_tasks.ts`**:
```
list_claimable_tasks(filters?: { tags?: string[] }, limit?: number)
  → { tasks: ExtendedTask[] }
```

### Capability gating

Add `task.claim` to `CAPABILITY_TOOL_MAP` in `src/roles/capabilities.ts`:

```typescript
'task.claim': ['claim_task', 'unclaim_task', 'list_claimable_tasks'],
```

### MCP registration

In `src/mcp/mcp-server.ts`, register the three new tools alongside existing task tools. They follow the same pattern as `create_task` — gated by capability, receive `taskBackend` from MCPServices.

---

## Phase 4: Session Continuations — Implementation Details

### Session history storage

Add a new event type: `conversation` events already exist in the EventStore. Session continuations build on the existing conversation/turn infrastructure:

- When an agent's `done()` is called with continuation enabled, the agent's conversation transcript is already stored as turns in the EventStore's conversation view.
- `AgentManager.resume(agentId)` loads the conversation turns, formats them as a resume context, and spawns a new agent with that context prepended.

```typescript
// In agent-manager.ts
async function resume(agentId: string, options?: ResumeOptions): Promise<SpawnedAgent> {
  const agent = eventStore.getAgent(agentId);
  if (!agent) throw new Error(`Agent not found: ${agentId}`);

  // Load conversation history
  const turns = eventStore.listTurns({ agent_id: agentId });
  const maxMessages = options?.maxMessages ?? 50;
  const recentTurns = turns.slice(-maxMessages);

  // Build resume context
  const resumeContext = formatResumeContext(recentTurns, agent);

  // Spawn new agent with same role, task, and resume context
  return spawn({
    task: agent.task,
    task_id: agent.task_id,
    parent: agent.parent,
    role: agent.role,
    customPrompt: resumeContext, // Prepended to system prompt
  });
}
```

This is the simplest approach — no new event types, no new storage. We build on the existing conversation tracking. The main implementation work is:
1. Ensuring conversation turns are captured during agent operation (already happening via MailService)
2. Building `formatResumeContext()` to create a useful summary
3. Adding `resume()` to AgentManager
4. Adding periodic checkpointing if turns aren't already captured at each round-trip

---

## File Change Summary

### New files
| File | Description |
|------|-------------|
| `src/teams/types.ts` | TeamManifest, TeamTopology, TeamCommunication, MacroAgentExtensions types |
| `src/teams/team-loader.ts` | TeamLoader — reads and validates team template directories |
| `src/teams/team-runtime.ts` | TeamRuntime — wires team config into running services |
| `src/teams/index.ts` | Re-exports |
| `src/workspace/strategies/types.ts` | IntegrationStrategy, LandRequest, LandResult |
| `src/workspace/strategies/registry.ts` | IntegrationStrategyRegistry |
| `src/workspace/strategies/queue.ts` | QueueIntegrationStrategy |
| `src/workspace/strategies/trunk.ts` | TrunkIntegrationStrategy |
| `src/workspace/strategies/optimistic.ts` | OptimisticIntegrationStrategy |
| `src/workspace/strategies/index.ts` | Re-exports |
| `src/mcp/tools/claim_task.ts` | claim_task MCP tool |
| `src/mcp/tools/unclaim_task.ts` | unclaim_task MCP tool |
| `src/mcp/tools/list_claimable_tasks.ts` | list_claimable_tasks MCP tool |
| `.multiagent/teams/self-driving/` | Reference team template (team.yaml, roles/, prompts/) |
| `.multiagent/teams/structured/` | Backward-compat structured team template |

### Modified files
| File | Change |
|------|--------|
| `src/agent/agent-manager.ts` | Add spawnInterceptor hook, customPrompt support, getRoleRegistry(), resume() |
| `src/agent/system-prompt.ts` | Add teamPrompt and interactionPatterns to SystemPromptContext |
| `src/lifecycle/handlers/index.ts` | Add integrationStrategy and taskMode to AllHandlerDeps |
| `src/lifecycle/handlers/worker.ts` | Add strategy dispatch (A4), pull mode shouldTerminate (A5) |
| `src/mcp/tools/done.ts` | Pass integrationStrategy/taskMode through DoneToolDeps |
| `src/mcp/mcp-server.ts` | Register claim_task/unclaim_task/list_claimable_tasks, add MCPServices fields |
| `src/task/backend/types.ts` | Add claim(), unclaim(), listClaimable(), ClaimFilters, tags |
| `src/task/backend/memory.ts` | Implement claim/unclaim/listClaimable |
| `src/store/types/tasks.ts` | Add tags field to task type |
| `src/roles/capabilities.ts` | Add task.claim capability mapping |
| `src/cli/index.ts` | Add --team flag, TeamLoader/TeamRuntime initialization, bootstrap |
| `src/api/server.ts` | Add GET /api/team endpoint |

---

## Implementation Order and Dependencies

```
Phase 1 (Foundation)
  1.1 Types → 1.2 Loader → 1.3 Runtime → 1.4 Spawn interceptor
  1.5 CLI integration → 1.6 Bootstrap → 1.7 API → 1.8-1.9 Tests → 1.10 Reference template

Phase 2 (Integration Strategies) ── can start after 1.3
  2.1 Types → 2.2 Registry → 2.3 Queue → 2.4 Trunk → 2.5 Optimistic
  2.6 Worker handler refactor → 2.7 Wire into TeamRuntime → 2.8-2.11 Tests

Phase 3 (Task Pull) ── can start after 1.3
  3.1 Tags → 3.2-3.4 Backend methods → 3.5 Capabilities → 3.6-3.8 MCP tools
  3.9 Registration → 3.10 Pull mode done → 3.11 Idle timeout → 3.12-3.13 Tests

Phase 4 (Session Continuations) ── can start after 1.3
  4.1-4.2 Storage → 4.3-4.4 Persistence hooks → 4.5 Resume
  4.6-4.7 Config → 4.8-4.9 Tests

Phase 5 (Observability) ── depends on 2 + 3
  5.1-5.2 Metric events → 5.3-5.5 Views → 5.6 API → 5.7-5.8 Tests

Phase 6 (Templates + Docs) ── depends on all
  6.1-6.4 Reference templates, docs, E2E test
```

Phases 2, 3, and 4 can be developed in parallel once Phase 1.3 (TeamRuntime) is done, since they each hook into different parts of the system. Phase 5 requires 2 and 3 for the metric events to be meaningful.

---

## Resolved Open Questions

These questions were resolved during spec review. See `docs/spec-self-driving-support.md` for the binding decisions (RD1-RD7).

1. **YAML library**: `js-yaml` (RD7).

2. **Git operations for trunk strategy**: Need a thin wrapper around child_process git commands. Check if `src/workspace/` has existing helpers to reuse.

3. **Optimistic strategy validation**: The strategy is thin — push + emit event. Validation is the judge agent's responsibility via its role prompt (RD5).

4. **MCP subprocess team context**: Store `team_config` event in EventStore. MCP subprocess reads it to reconstruct strategy and taskMode (RD2). No HTTP API between processes.

5. **Team selection**: Via `.multiagent/config.json` (new file), CLI `--team` overrides (RD6).

6. **spawn_rules vs capabilities**: spawn_rules are syntactic sugar — TeamLoader translates them into capability additions (RD3).

7. **Team prompt vs base role prompt**: Team prompt replaces base systemPrompt entirely (RD4).

8. **done() hardcoded roles**: Must be fixed as prerequisite (RD1). Replace with RoleRegistry lookup.

### Deferred

- **Team template hot-reloading**: Not needed for Phase 1. The `RoleRegistry` already supports file watching, so this could be added later.
- **Multiple simultaneous teams**: Single team focus for now. Architecture supports it but CLI only accepts one `--team` flag.
