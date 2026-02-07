# Spec: Self-Driving Codebases Support

Implementation specification for adding modular team templates, pluggable integration strategies, task pull model, and session continuations to macro-agent.

## Overview

Enable macro-agent to support multiple agent team configurations — from the existing structured coordinator/integrator/worker pattern to Cursor-style autonomous self-driving teams with planners, workers, and judges — through a declarative team template layer on top of the existing role-agnostic core.

### Companion Documents

| Document | Purpose |
|----------|---------|
| [plan-self-driving-support.md](plan-self-driving-support.md) | High-level plan, design decisions D1-D5, phase overview |
| [team-templates.md](team-templates.md) | Team template format, communication topology, examples |
| [implementation-details.md](implementation-details.md) | Resolved ambiguities A1-A10, concrete code integration points |

---

## Resolved Design Decisions

The following decisions were discussed and agreed upon. They are binding for implementation.

### RD1: Fix hardcoded `done()` capability check (Prerequisite)

`src/mcp/tools/done.ts:98-103` hardcodes which roles can call `done()`. This blocks team-defined roles from completing.

**Decision**: Replace the hardcoded role set with a proper `roleRegistry.hasCapability(role, 'lifecycle.done')` lookup. The `RoleRegistry` must be accessible from the MCP subprocess (it already is via the `roleRegistry` field on `MCPServices`).

**Scope**: Prerequisite work before Phase 1. Small, isolated change.

### RD2: Team config shared via EventStore

The MCP server runs as a subprocess communicating via stdio. It shares state with the main process through a SQLite-backed EventStore (same `instanceId`).

**Decision**: Store team configuration in the EventStore as a `team_config` event when the team initializes. The MCP subprocess reads this event to reconstruct team context (integration strategy name, task mode, communication enforcement level). The subprocess instantiates the integration strategy from the default registry using the stored config.

**Rationale**: The EventStore is already the cross-process shared state channel. This avoids adding an HTTP API between main process and MCP subprocess. The MCP subprocess already calls `eventStore.reload()` to get fresh data.

**Implementation**:
```
Main process (TeamRuntime.initialize()):
  1. Store team_config event with { strategy, strategyConfig, taskMode, enforcement, teamName }
  2. Event persists to SQLite

MCP subprocess (mcp.ts):
  1. Read team_config event from EventStore (after agent lookup)
  2. If present: instantiate strategy from registry, set taskMode
  3. Pass to MCPServices → DoneToolDeps → handler deps
  4. If absent: existing behavior (mergeQueue fallback)
```

### RD3: spawn_rules generate capabilities

Team manifest `spawn_rules` are syntactic sugar over the capability system.

**Decision**: `TeamLoader` translates spawn rules into capability additions on the role definition. `planner: [grinder, planner]` becomes `capabilities_add: ['agent.spawn.grinder', 'agent.spawn.planner']`. The existing `AgentManager.spawn()` capability check runs unchanged.

**Why not override**: A single enforcement mechanism is easier to reason about. Spawn rules make the manifest readable; capabilities are the enforcement layer.

### RD4: Team prompt replaces base role systemPrompt

When a team provides `prompts/planner.md`, it is the sole role-level prompt for that agent.

**Decision**: `customPrompt` in `SpawnAgentOptions` replaces `resolvedRole.systemPrompt` in prompt assembly. The base coordinator's `systemPrompt` is not appended. The team author owns the full role prompt — they can include coordinator-like instructions if needed.

**Rationale**: The base role's `systemPrompt` will eventually be factored into a dedicated team topology. Keeping it out of team-loaded agents avoids conflicting instructions.

### RD5: Optimistic strategy is thin — validation is the judge's job

The `OptimisticIntegrationStrategy.land()` pushes changes and emits a `validation:requested` event. It does not run build/test/lint.

**Decision**: Validation (build, test, fixup task creation, green branch snapshotting) is the responsibility of the judge agent, driven by its role prompt and the team's communication topology. The strategy is intentionally simple.

### RD6: Team selection via macro-agent config, not just CLI flag

Rather than requiring `--team` on every invocation, the active team is stored in macro-agent project-level configuration.

**Decision**: Add a `team` field to `.macro-agent/config.json` (new file, alongside existing `.macro-agent/roles.json`). The CLI `--team` flag overrides the config. When neither is set, no team is loaded (existing behavior).

```json
// .macro-agent/config.json
{
  "team": "self-driving"
}
```

**Loading priority**: CLI `--team` flag > `.macro-agent/config.json` > no team (default)

### RD7: YAML library

**Decision**: Use `js-yaml` (MIT license, most widely used, stable). Add as a runtime dependency.

---

## Requirements

### Phase 0: Prerequisites

#### P0.1: Fix done() capability check

| | |
|---|---|
| **What** | Replace hardcoded role set in `hasLifecycleDoneCapability()` with `roleRegistry.hasCapability()` lookup |
| **Where** | `src/mcp/tools/done.ts` |
| **Input** | Agent ID, EventStore, RoleRegistry |
| **Output** | `{ hasCapability: boolean, role: string }` using actual capability resolution |
| **Constraint** | RoleRegistry must be passed through to the done tool. Currently `MCPServices` has an optional `roleRegistry` field — make it required or ensure it's always provided |
| **Success** | Team-defined roles (planner, grinder, judge) that extend built-in roles and inherit `lifecycle.done` can call `done()` |
| **Test** | Unit test: register a custom role extending "worker" via RoleRegistry, verify `hasLifecycleDoneCapability` returns true |

#### P0.2: Add macro-agent config loader

| | |
|---|---|
| **What** | Read `.macro-agent/config.json` for project-level settings (starting with `team` field) |
| **Where** | New: `src/config/project-config.ts` |
| **Schema** | `{ team?: string, [key: string]: unknown }` |
| **Loading** | On CLI start/chat, read config file. CLI flags override. Missing file = empty config |
| **Success** | `loadProjectConfig(projectPath?)` returns parsed config or defaults |
| **Test** | Unit test: read valid config, missing file, invalid JSON |

### Phase 1: Team Template System

#### P1.1: TeamManifest types

| | |
|---|---|
| **What** | TypeScript types for the full team manifest schema |
| **Where** | New: `src/teams/types.ts` |
| **Types** | `TeamManifest`, `TeamTopology`, `TopologyNode`, `TeamCommunication`, `ChannelDefinition`, `ChannelSubscription`, `CommunicationRouting`, `PeerConnection`, `MacroAgentExtensions`, `TeamRoleDefinition`, `ResolvedTeamRole` |
| **Constraint** | Generic fields (name, roles, topology, communication) separated from `macro_agent` namespace per interoperability design in team-templates.md |
| **Success** | Types compile, accurately represent team.yaml schema |
| **Test** | Type-level only (compile check) |

#### P1.2: TeamLoader

| | |
|---|---|
| **What** | Reads `.macro-agent/teams/<name>/` directory, parses and validates team.yaml, resolves role inheritance, loads prompts, loads MCP server configs |
| **Where** | New: `src/teams/team-loader.ts` |
| **Interface** | `TeamLoader.load(teamName: string, basePath?: string): Promise<TeamManifest>` |
| **Dependencies** | `js-yaml` (new), `zod` (existing), `RoleRegistry` (for resolving `extends` chains) |
| **Steps** | 1. Resolve directory path 2. Parse team.yaml 3. Validate with Zod 4. For each role: load YAML, resolve extends, compute capabilities (add/remove), translate spawn_rules to capabilities (RD3) 5. Load prompt files 6. Load tools/mcp-servers.json 7. Validate communication topology (all refs exist) |
| **Errors** | Typed `TeamLoadError` with codes: `MANIFEST_NOT_FOUND`, `INVALID_MANIFEST`, `ROLE_NOT_FOUND`, `PROMPT_NOT_FOUND`, `INVALID_COMMUNICATION` |
| **Success** | Given a valid team directory, returns fully resolved `TeamManifest` with computed capabilities, loaded prompts, and MCP server configs |
| **Test** | Unit tests with fixture directories: valid team, missing manifest, invalid schema, broken extends chain, missing prompt, invalid communication refs |

#### P1.3: TeamRuntime

| | |
|---|---|
| **What** | Wires a loaded TeamManifest into running services |
| **Where** | New: `src/teams/team-runtime.ts` |
| **Interface** | `TeamRuntime` class with `initialize()`, `bootstrap()`, `teardown()`, getters for strategy/taskMode/topics/prompts |
| **initialize()** | 1. Register team roles into RoleRegistry (highest priority layer) 2. Instantiate IntegrationStrategy from registry 3. Store team_config event in EventStore (RD2) 4. Register spawn interceptor on AgentManager |
| **bootstrap()** | 1. Spawn root agent per `topology.root` 2. Spawn companions per `topology.companions` (parent: null) 3. Set up peer subscriptions between root and companions 4. Return `{ rootId, companionIds }` |
| **Spawn interceptor** | Modifies `SpawnAgentOptions` to inject: team topics from communication topology, team MCP servers, team prompt (customPrompt), team env vars, role channel subscription |
| **Dependencies** | RoleRegistry, AgentManager, MessageRouter, EventStore |
| **Success** | After `initialize()`: team roles resolvable, strategy available, config in EventStore. After `bootstrap()`: root + companion agents running with correct subscriptions/prompts |
| **Test** | Unit test with mocked services: verify role registration, strategy selection, event emission, spawn interceptor output. Integration test: full load → initialize → bootstrap cycle |

#### P1.4: Spawn interceptor hook on AgentManager

| | |
|---|---|
| **What** | Add optional `spawnInterceptor` to AgentManager that transforms `SpawnAgentOptions` before spawn proceeds |
| **Where** | Modified: `src/agent/agent-manager.ts` |
| **Interface** | `setSpawnInterceptor(fn: SpawnInterceptor)` method. `SpawnInterceptor = (options: SpawnAgentOptions) => SpawnAgentOptions \| Promise<SpawnAgentOptions>` |
| **Hook point** | After options destructuring, before capability checks. Interceptor can modify topics, config, customPrompt, env vars |
| **New field** | Add `customPrompt?: string` to `SpawnAgentOptions` |
| **Prompt assembly** | When `customPrompt` is set, use it instead of `resolvedRole.systemPrompt` (RD4) |
| **Constraint** | When no interceptor is set, spawn behavior is identical to current (backward compatible) |
| **Success** | Interceptor can inject topics, MCP servers, prompt, env vars into spawn options |
| **Test** | Unit test: spawn with interceptor, verify modified options are applied. Spawn without interceptor, verify identical behavior |

#### P1.5: System prompt team support

| | |
|---|---|
| **What** | Support `customPrompt` and interaction pattern injection in system prompt generation |
| **Where** | Modified: `src/agent/agent-manager.ts` (prompt assembly section), optionally `src/agent/system-prompt.ts` |
| **Change** | When `customPrompt` is provided in spawn options: append it as `# Role Instructions` section, skip `resolvedRole.systemPrompt`. Append interaction pattern sections after role prompt. |
| **Interaction patterns** | Auto-generated text sections based on team config: pull mode instructions, trunk integration notes, continuation guidelines. Generated by TeamRuntime, passed via spawn interceptor |
| **Success** | Agent spawned with team prompt has correct system prompt: base sections + team prompt + interaction patterns + tools + guidelines |
| **Test** | Unit test: generate prompt with customPrompt set, verify structure. Generate without, verify existing behavior |

#### P1.6: CLI and config integration

| | |
|---|---|
| **What** | Add `--team <name>` CLI flag, read `.macro-agent/config.json`, initialize TeamRuntime in start/chat flows |
| **Where** | Modified: `src/cli/index.ts` |
| **Flow** | 1. Read project config (P0.2) 2. Determine team name (CLI flag > config > none) 3. If team: load via TeamLoader, create TeamRuntime, initialize, then bootstrap after server starts |
| **Constraint** | Chat command also supports team loading (interactive mode with team agents) |
| **Success** | `multiagent-cli start --team self-driving` loads team, bootstraps agents. `multiagent-cli start` with `.macro-agent/config.json` containing `"team": "self-driving"` does the same |
| **Test** | Integration test: CLI start with team flag, verify agents spawned with correct roles |

#### P1.7: MCP subprocess team context

| | |
|---|---|
| **What** | MCP subprocess reads team config from EventStore and reconstructs team context |
| **Where** | Modified: `src/cli/mcp.ts`, `src/mcp/mcp-server.ts` |
| **Flow** | 1. After EventStore connection (mcp.ts:61), query for `team_config` event 2. If found: instantiate strategy from `IntegrationStrategyRegistry`, set taskMode 3. Pass strategy and taskMode through `MCPServices` → `DoneToolDeps` |
| **New MCPServices fields** | `integrationStrategy?: IntegrationStrategy`, `taskMode?: 'push' \| 'pull'` |
| **Constraint** | When no team_config event exists, all new fields are undefined (backward compatible) |
| **Success** | Worker agent in a team calls `done()` → handler dispatches to correct integration strategy |
| **Test** | Integration test: emit team_config event, start MCP subprocess, verify strategy is available in done handler |

#### P1.8: API endpoint

| | |
|---|---|
| **What** | `GET /api/team` returns active team info |
| **Where** | Modified: `src/api/server.ts` |
| **Response** | `{ active: true, name, roles, topology, strategy, taskMode }` or `{ active: false }` |
| **Success** | Endpoint returns team config when team is loaded, returns inactive otherwise |
| **Test** | Unit test with mocked APIServices |

#### P1.9: Reference self-driving template

| | |
|---|---|
| **What** | Complete team template for the self-driving pattern |
| **Where** | New: `.macro-agent/teams/self-driving/` with team.yaml, roles/*.yaml, prompts/*.md |
| **Roles** | planner (extends coordinator), grinder (extends worker), judge (extends monitor) |
| **Topology** | Root: planner. Companions: judge. spawn_rules: planner→[grinder,planner], others→[] |
| **Communication** | Channels: task_updates, work_coordination, health. Peer routes: judge↔planner |
| **Integration** | trunk strategy |
| **Task mode** | pull |
| **Success** | `TeamLoader.load('self-driving')` succeeds and returns a valid manifest |
| **Test** | Validated by TeamLoader unit tests |

### Phase 2: Pluggable Integration Strategies

#### P2.1: IntegrationStrategy interface and registry

| | |
|---|---|
| **What** | Strategy interface, LandRequest/LandResult types, and a registry with factory pattern |
| **Where** | New: `src/workspace/strategies/types.ts`, `src/workspace/strategies/registry.ts` |
| **Interface** | `IntegrationStrategy { name, land(request), initialize?(), close?() }` |
| **Registry** | `IntegrationStrategyRegistry { register(name, factory), get(name, config), has(name), list() }` |
| **Default instance** | `defaultStrategyRegistry` with queue, trunk, optimistic registered |
| **Success** | `registry.get('trunk', { maxRetries: 3 })` returns a TrunkIntegrationStrategy instance |
| **Test** | Unit test: register, get, factory invocation, unknown name throws |

#### P2.2: QueueIntegrationStrategy

| | |
|---|---|
| **What** | Wraps existing MergeQueueInterface — same behavior as current worker done() handler |
| **Where** | New: `src/workspace/strategies/queue.ts` |
| **Behavior** | Receives MergeQueueInterface at construction. `land()` submits merge request to queue |
| **Constraint** | Must produce identical behavior to current worker.ts Step 4 merge queue path |
| **Success** | Existing merge queue tests pass when routed through QueueIntegrationStrategy |
| **Test** | Unit test with mocked MergeQueueInterface |

#### P2.3: TrunkIntegrationStrategy

| | |
|---|---|
| **What** | Direct push to integration branch with rebase-and-retry on conflict |
| **Where** | New: `src/workspace/strategies/trunk.ts` |
| **Config** | `maxRetries` (default: 3), `conflictAction` ('abandon' \| 'queued_for_resolution') |
| **Behavior** | fetch → rebase → push. On conflict: abort rebase, retry. On exhaustion: return conflict result |
| **Git operations** | Thin wrapper around child_process git commands (or reuse workspace git helpers if they exist) |
| **Success** | Pushes cleanly when no conflict. Retries on conflict. Returns appropriate LandResult |
| **Test** | Unit test with git repo fixture: clean push, conflict + retry, exhaustion |

#### P2.4: OptimisticIntegrationStrategy

| | |
|---|---|
| **What** | Push immediately, emit validation event. No blocking validation (RD5) |
| **Where** | New: `src/workspace/strategies/optimistic.ts` |
| **Behavior** | Push to integration branch. Emit `validation:requested` event via EventStore. Return landed |
| **Constraint** | Does not run build/test. Validation is the judge's responsibility |
| **Success** | Push succeeds, event emitted. On push conflict: rebase + retry (same as trunk) |
| **Test** | Unit test: verify push and event emission |

#### P2.5: Worker handler refactor

| | |
|---|---|
| **What** | Add strategy dispatch to worker done() handler |
| **Where** | Modified: `src/lifecycle/handlers/worker.ts`, `src/lifecycle/handlers/index.ts` |
| **New deps** | `integrationStrategy?: IntegrationStrategy`, `taskMode?: 'push' \| 'pull'` on `AllHandlerDeps` and `WorkerHandlerDeps` |
| **Logic** | If `integrationStrategy`: call `strategy.land()`, handle result. Else if `mergeQueue`: existing path. Pull mode: return `shouldTerminate: false` on completed status |
| **Constraint** | When neither strategy nor mergeQueue is set, skip integration (log warning). Existing tests pass unchanged |
| **Success** | Workers with trunk strategy push directly. Workers with queue strategy use merge queue. Pull-mode workers stay alive after completion |
| **Test** | Unit test: strategy dispatch, pull mode shouldTerminate, fallback to mergeQueue |

#### P2.6: Done tool dependency wiring

| | |
|---|---|
| **What** | Pass integration strategy and task mode through DoneToolDeps → AllHandlerDeps |
| **Where** | Modified: `src/mcp/tools/done.ts`, `src/mcp/mcp-server.ts` |
| **New fields** | `integrationStrategy?` and `taskMode?` on `DoneToolDeps` and `MCPServices` |
| **Success** | Strategy flows from MCPServices → DoneToolDeps → AllHandlerDeps → worker handler |
| **Test** | Integration test: full done() call with strategy set, verify land() called |

### Phase 3: Task Pull Model

#### P3.1: Task tags

| | |
|---|---|
| **What** | Add `tags?: string[]` to task types |
| **Where** | Modified: `src/store/types/tasks.ts`, `src/task/backend/types.ts` |
| **Constraint** | Tags set at creation time via `CreateTaskOptions`. Queryable via filters |
| **Success** | Tasks can be created with tags, filtered by tags in list operations |
| **Test** | Unit test: create task with tags, filter by tags |

#### P3.2: TaskBackend claim/unclaim

| | |
|---|---|
| **What** | Add `claim()`, `unclaim()`, `listClaimable()` to TaskBackend interface and InMemoryTaskBackend |
| **Where** | Modified: `src/task/backend/types.ts`, `src/task/backend/memory.ts` |
| **claim()** | Find first matching pending task, atomically assign to agent. Return null if none available or contention |
| **unclaim()** | Return claimed task to pending status |
| **listClaimable()** | Return pending tasks matching optional filters (tags, status) |
| **Atomicity** | SQLite write serialization ensures no double-claims (see implementation-details.md A6) |
| **Success** | Agent claims task, task transitions to assigned. Two agents claiming same task: one succeeds, one gets null |
| **Test** | Unit test: claim, unclaim, contention (two claims on same task), filtered claims |

#### P3.3: MCP tools (claim_task, unclaim_task, list_claimable_tasks)

| | |
|---|---|
| **What** | Three new MCP tools for the pull model |
| **Where** | New: `src/mcp/tools/claim_task.ts`, `unclaim_task.ts`, `list_claimable_tasks.ts` |
| **Capability** | Gated by `task.claim` capability |
| **Registration** | Added to `src/mcp/mcp-server.ts` tool registration, with `task.claim` in capability map (`src/roles/capabilities.ts`) |
| **Success** | Agent with `task.claim` capability can call `claim_task()` → gets a task → works → `done()` → `claim_task()` again |
| **Test** | Unit test per tool. Integration test: claim loop cycle |

### Phase 4: Session Continuations

#### P4.1: Resume mechanism

| | |
|---|---|
| **What** | `AgentManager.resume(agentId, options?)` loads conversation history and spawns continuation agent |
| **Where** | Modified: `src/agent/agent-manager.ts` |
| **Flow** | 1. Load agent record from EventStore 2. Load conversation turns (existing turn infrastructure) 3. Format as resume context (summarized transcript) 4. Spawn new agent with same role/task + resume context as customPrompt prefix |
| **Config** | `maxMessages` controls how many turns to include (default: 50) |
| **Success** | Resumed agent has access to prior conversation context |
| **Test** | Integration test: spawn agent, record turns, terminate, resume, verify context |

#### P4.2: Continuation lifecycle config

| | |
|---|---|
| **What** | Wire `macro_agent.lifecycle.continuations` from team manifest into agent lifecycle |
| **Where** | Modified: `src/teams/team-runtime.ts` (config propagation) |
| **Behavior** | When continuations enabled and agent terminates: eligible for resume. TeamRuntime can auto-resume daemon agents that exit unexpectedly |
| **Success** | Planner agent in self-driving team auto-resumes after unexpected termination |
| **Test** | Integration test: daemon agent terminates, TeamRuntime detects and resumes |

### Phase 5: Autonomous Observability

#### P5.1: Metric events and views

| | |
|---|---|
| **What** | Emit metric events from done handlers and strategies. Materialized views for throughput, utilization, errors |
| **Where** | Modified: `src/store/event-store.ts` (new views), `src/lifecycle/handlers/` (emit events), `src/workspace/strategies/` (emit events) |
| **API** | `GET /api/metrics/throughput`, `/utilization`, `/errors` |
| **Success** | After a multi-agent run, API returns meaningful throughput and error metrics |
| **Test** | Unit test: view computation. Integration test: run agents, query metrics |

### Phase 6: Reference Templates and Documentation

#### P6.1: Finalized templates and E2E test

| | |
|---|---|
| **What** | Finalize self-driving and structured reference templates. Add docs. Run E2E test |
| **Where** | `.macro-agent/teams/self-driving/`, `.macro-agent/teams/structured/`, `docs/teams.md` |
| **E2E test** | Full cycle: load self-driving team → planner creates tasks → grinders claim and complete → judge monitors → trunk integration |
| **Success** | E2E test passes. Documentation covers schema reference, custom strategy guide, examples |

---

## Success Criteria

### Phase-level criteria

| Phase | Criterion |
|-------|-----------|
| **P0** | `done()` works with any role that has `lifecycle.done` capability. `.macro-agent/config.json` is read on startup |
| **P1** | `multiagent-cli start --team self-driving` loads a team, registers roles, spawns root + companions, agents have correct prompts and topics. MCP subprocess picks up team config from EventStore. Existing behavior without `--team` is unchanged |
| **P2** | Worker `done()` dispatches to configured integration strategy. `queue` strategy produces identical behavior to current merge queue. `trunk` strategy pushes directly. Existing merge queue tests pass |
| **P3** | Agents with `task.claim` capability can `claim_task()` → `done()` → `claim_task()` in a loop. Idle timeout triggers graceful exit |
| **P4** | `AgentManager.resume()` loads conversation history and spawns continuation. Daemon agents auto-resume on unexpected exit |
| **P5** | Metrics API returns throughput/utilization/error data after multi-agent run |
| **P6** | E2E test passes. Docs complete |

### Cross-cutting criteria

| Criterion | Description |
|-----------|-------------|
| **Backward compatibility** | All existing tests pass without modification. No team loaded = identical behavior to current codebase |
| **No core rewrites** | Team system composes on top of existing primitives (RoleRegistry, MessageRouter, EventStore, AgentManager). Core modules receive surgical additions (interceptor hook, new deps fields), not rewrites |
| **Type safety** | All new types have Zod validation schemas. Team manifest validated at load time. Invalid config fails fast with clear error messages |
| **Test coverage** | Each phase has unit tests for new modules and integration tests for the wiring. Phase 6 has an E2E test for the full self-driving flow |

---

## Implementation Order

```
P0 (Prerequisites) ────────────────────────────────────►
  P0.1: Fix done() capability     ~1 file, small
  P0.2: Project config loader     ~1 new file, small

P1 (Team Template System) ─────────────────────────────►
  P1.1: Types                     ~1 new file
  P1.2: TeamLoader                ~1 new file + js-yaml dep
  P1.3: TeamRuntime               ~1 new file
  P1.4: Spawn interceptor         ~1 modified file
  P1.5: System prompt support     ~1 modified file
  P1.6: CLI + config              ~1 modified file
  P1.7: MCP subprocess context    ~2 modified files
  P1.8: API endpoint              ~1 modified file
  P1.9: Reference template        ~7 new files (yaml/md)

          ┌──── P2 (Integration) ────────────────────►
          │       P2.1-P2.6 (parallel with P3/P4)
          │
P1.3 ────┼──── P3 (Task Pull) ──────────────────────►
done      │       P3.1-P3.3 (parallel with P2/P4)
          │
          └──── P4 (Session Continuations) ──────────►
                  P4.1-P4.2 (parallel with P2/P3)

P2+P3 ──────── P5 (Observability) ──────────────────►
done              P5.1

All ────────── P6 (Templates + Docs + E2E) ─────────►
done              P6.1
```

**Total new files**: ~18
**Total modified files**: ~12
**New dependency**: `js-yaml`

---

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Spawn interceptor introduces subtle bugs in existing spawns | Agents fail to start or have wrong config | Interceptor is no-op when not set. Guarded by `if (spawnInterceptor)` check. Comprehensive test for both paths |
| Team config event in EventStore is stale after hot-reload | MCP subprocess uses old config | For Phase 1, no hot-reload. Config is set once at initialize(). Future: re-emit event on config change |
| SQLite contention on claim() under high worker count | Workers waste cycles retrying claims | Randomize candidate selection. Short retry delay with jitter. Metrics track contention rate for observability |
| trunk strategy corrupts integration branch on crash mid-push | Integration branch in inconsistent state | All git operations are atomic (push either succeeds or fails cleanly). Rebase is aborted on error before retry |
| YAML parsing adds a new dependency | Supply chain risk, bundle size | `js-yaml` is MIT, 1.4M weekly downloads, well-audited. Pin version. No native bindings |
| Companion agents (parent: null) confuse hierarchy queries | `getHierarchy()` shows disconnected nodes | Accept this: companions are intentionally outside the spawn tree. API/CLI can group them under "team companions" label |
