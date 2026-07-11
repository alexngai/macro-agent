# macro-agent

Multi-agent orchestration system for spawning and managing hierarchical AI coding agents. Interact with multiple agents as if they were one.

macro-agent owns **orchestration**: agent lifecycle, workspace isolation, team topology, role system, trigger/wake, control socket. It delegates **messaging** to `agent-inbox` and **task management** to `opentasks`. It exposes ACP (WebSocket) and REST API servers, supports cross-instance federation, can serve as a compute backend for `cognitive-core`/OpenHive, and bridges to an OpenHive hub via the MAP protocol (`src/map/`).

## Build, test, run

```bash
npm install                # install deps
npm run build               # tsc -> dist/
npm run dev                 # tsc --watch
npm test                    # vitest (watch mode)
npx vitest run               # unit tests, single run
npm run test:e2e             # e2e tests (config: vitest.e2e.config.ts)
npm run test:e2e-full-agents  # e2e with real agent spawning (RUN_FULL_AGENT_TESTS=true)
npm start                   # node dist/cli/index.js
```

Binaries (via `bin` in package.json): `multiagent` (ACP stdio entry), `multiagent-cli` (CLI), `multiagent-mcp` (per-agent MCP subprocess entry).

Unit tests are colocated in `__tests__/` next to source (`*.test.ts`); e2e tests live under `src/__tests__/` (`*.e2e.test.ts`) and are gated by `RUN_E2E_TESTS`/`RUN_FULL_AGENT_TESTS` env vars.

## Architecture

`src/boot-v2.ts` is the single system wiring entry point. It constructs, in order: `AgentStore` (SQLite), `InboxAdapter` (embeds `agent-inbox`), `TasksAdapter` (IPC to `opentasks` daemon), `RoleRegistry`, `AgentManagerV2`, `TriggerSystemV2`, `ControlServer`, and optionally federation, the REST API server, and the ACP WebSocket server.

Request flow for a running team:

1. **Boot** — `bootV2()` wires the components above.
2. **Team start** — `TeamManagerV2.startTeam()` loads `team.yaml`, builds a `YamlDrivenTopology`, creates the team's root integration stream, bootstraps root + companion agents.
3. **Spawn** — `AgentManagerV2.spawn(role)` asks the active `TopologyPolicy` for a `WorkspaceDecision`, allocates a worktree if needed, launches a Claude Code subprocess with MCP tools.
4. **Work** — the agent edits files in its isolated worktree, commits via the `commit` MCP tool (Change-Id tracked), messages via `agent-inbox`, optionally spawns sub-agents.
5. **Land** — agent calls `done()`; the role's `LandingStrategy` finalizes the work (merge, queue, direct push, etc).
6. **Recover** — if landing conflicts, a `ConflictRecoveryStrategy` dispatches (defer/abandon/escalate/auto-resolve/spawn-resolver).
7. **Terminate** — `TopologyPolicy.onAgentComplete` deallocates the worktree; cascade termination consolidates changes for child agents.

Two coordination layers run in parallel with the agent manager: the **control socket** (NDJSON-over-UNIX-socket RPC between each MCP subprocess and the main process — commands: `spawn`, `terminate`, `get_agent`, `list_agents`, `get_children`, `get_hierarchy`, `ping`, `health_check`) and the **trigger system** (routes external events and inbox-delivery events to agents via pluggable routing strategies, plus cron/webhook sources and a `WakeManager` for inject/interrupt/prompt delivery).

### Source layout

| Directory | Role |
|---|---|
| `acp/` | ACP protocol bridge (`session/new`, `session/prompt`, extension methods) + WebSocket transport |
| `adapters/` | Integration boundary: `InboxAdapter`, `InboxClientAdapter` (MCP subprocess IPC client), `TasksAdapter`, `federation.ts` |
| `agent/` | `AgentManagerV2`, `AgentStore` (SQLite), spawn/prompt/terminate lifecycle, system prompt generation |
| `agent-detection/` | Discovers installed CLI coding agents (Claude Code, Codex, etc.) on `PATH` |
| `api/` | REST API server (agents, tasks, teams, metrics) |
| `auth/` | Per-agent auth tokens |
| `cli/` | `multiagent-cli` commands, ACP stdio mode, MCP subprocess entry |
| `cognitive/` | Implements cognitive-core's `AgentBackend` interface (compute backend for OpenHive) |
| `control/` | Control socket server/client (see above) |
| `dispatch/` | Hub-driven work intake: consumes `x-dispatch/work` envelopes from a connected OpenHive hub, spawns or reuses workers, posts reply turns back |
| `integrations/` | Optional peer-dependency integrations (`sessionlog`, `skill-tree`) |
| `lifecycle/` | Role-specific `done()` handlers, cascade termination, workspace cleanup |
| `map/` | MAP protocol bridge to an OpenHive hub — sidecar connection, agent registration, mail bridge, trajectory reporting |
| `mcp/` | Per-agent MCP server factory and tool implementations |
| `metrics/` | Point-in-time agent/task/system metrics snapshot |
| `roles/` | Role definitions (`worker`, `integrator`, `coordinator`, `monitor`, `generic`) + capability-based tool filtering |
| `teams/` | Team YAML loading, `TeamRuntimeV2` (per-team), `TeamManagerV2` (multi-team orchestrator) |
| `trigger/` | `TriggerRouterV2`, `WakeManager`, `SystemEventQueue`, cron/webhook sources, AI-router strategy |
| `workspace/` | Workspace isolation — V3 stream-first (topology/landing/recovery) + legacy role-shaped path |

Full interface contracts and design rationale live in `docs/` (see References below) rather than duplicated here.

## Key concepts

**Adapters.** Three adapters form the integration boundary: `InboxAdapter` (main process, embeds `agent-inbox`, owns composite signal filters + emission validators), `InboxClientAdapter` (MCP subprocess, IPC client to the main process's inbox), `TasksAdapter` (both, IPC client to the `opentasks` daemon). `AgentManagerV2` does **not** create or transition `opentasks` nodes on spawn/terminate — that was removed to avoid polluting the task graph with per-session noise. Opentasks is used only for explicit task operations (claim/unclaim/list, team coordination).

**AgentStore.** Minimal SQLite store (`~/.macro-agent/agents.db`, two tables: `agents`, `sessions`). Simple CRUD, no event sourcing. Read-only access from MCP subprocesses via SQLite WAL mode.

**Teams.** Declarative YAML topologies under `.multiagent/teams/<name>/team.yaml` (+ `roles/*.yaml` extending built-in roles, `prompts/*.md`). `TeamLoader` parses and validates; `TeamRuntimeV2` runs one team (scoped `agent-inbox` by team name, installs a named signal filter + emission validator); `TeamManagerV2` orchestrates multiple teams (composite spawn interceptor, agent-to-team mapping, auto-registers children into their parent's team).

**Roles.** Built-ins: Worker (execute in isolated workspace), Integrator (integration + conflict resolution), Coordinator (spawn/assign/broadcast), Monitor (read-only health watch), Generic (minimal base). Teams define custom roles via `extends` in `roles/<name>.yaml`. Tool registration is capability-gated: `isToolAllowedForRole()` checks before each MCP tool is registered.

**Workspace layer (V3).** Two paths coexist. The **V3 path** (YAML-driven, recommended for teams): the `macro_agent.workspace` block in `team.yaml` declares per-role workspace decisions; `TopologyPolicy` (`workspace/topology/`) compiles YAML into a `WorkspaceDecision` per spawn (`none` / `share-parent-cwd` / `share-with-agent` / `attach-to-stream` / `new-stream`); `LandingStrategy` (`workspace/landing/`) finalizes work at `done()` time; `ConflictRecoveryStrategy` (`workspace/recovery/`) handles conflicts. Auto-wired by `TeamManagerV2.startTeam()` when workspace config is present. The **legacy path** (programmatic/capability-based): direct `agentManager.spawn({ capabilities: [...] })` routes through `capabilityBasedDispatch` to role-shaped `WorkspaceManager` methods — retained for callers that don't load team YAML (tools, libraries, tests). `AgentManagerV2.createWorkspaceForRole()` prefers the V3 path when a `topologyPolicy` is set, else falls back to capability-based dispatch.

Built-in landing strategies: `merge-to-parent`, `queue-to-branch`, `direct-push`, `optimistic-push`. Built-in conflict recovery strategies: `defer`, `abandon`, `escalate`, `auto-resolve` (real git `-X` merge), `spawn-resolver` (spawns an LLM resolver agent — requires `AgentManager` injection, not in the default registry).

Each streamed agent gets an isolated git worktree via `WorkspaceManager`, backed by `git-cascade`'s `MultiAgentRepoTracker`. Commits made through `commitChanges()` get a stable `Change-Id: c-xxxxxxxx` trailer that survives rebases; legacy callers using raw `git commit` bypass this tracking. Merge queueing is `git-cascade`'s built-in queue (via the adapter and the `queue-to-branch` `LandingStrategy`); integration is handled per-role by `workspace/landing/` at `done()` time.

**MCP tool surface.** Each agent gets tools from three sources: macro-agent's built-in MCP server (`done`, `spawn_agent`, `stop_agent`, `get_hierarchy`, `inject_context`, plus `claim_task`/`unclaim_task`/`list_claimable_tasks` gated by the `task.claim` capability, and `commit`/`land`/`resolve_conflict` gated by workspace capabilities), `agent-inbox` (`send_message`, `check_inbox`, `read_thread`, `list_agents` — separate IPC-backed MCP server), and `opentasks` (`task`, `link`, `annotate`, `query` — separate IPC-backed MCP server). Registration is role-gated via `isToolAllowedForRole()`.

**Trigger system.** Routes external events and inbox-delivery events to agents. Routing strategies (pluggable via `RoutingStrategy`): `direct` (specific agent ID), `role` (all agents with a role), `head` (all running root agents — default fallback), `custom` (user-registered), and an AI-router strategy that spawns a temporary Claude session to make routing decisions (expensive; falls back to `head` on failure/timeout). `InboxAdapter.onDelivery` maps message importance to a wake action (`urgent`→interrupt, `high`→inject, `normal`/`low`→queue), enqueued in `SystemEventQueue` and handled by `WakeManager`.

**Task dispatch (autonomous mode).** Opt-in via `config.dispatch.enabled`; powered by the `swarm-dispatch` package. The orchestrator polls `opentasks` for ready work, checks an `AgentRoster` (idle agents) and routes via `MessagePort` (agent-inbox) before falling back to spawning a new agent via `AgentRuntime`. Tracks lifecycle with a continuation/retry split (continuation = normal exit + task still active, short delay, turn-counted; retry = abnormal exit, exponential backoff), detects stalls, and periodically reconciles external state. macro-agent supplies five adapter ports (TaskSource, AgentRuntime, MessagePort, AgentRoster, dispatch-mode selection); the orchestrator, state machine, and retry/reconcile logic live in `swarm-dispatch` itself. See the package README for the full API.

**Hub-driven dispatch (`src/dispatch/`).** Separate from the above: this handles inbound `x-dispatch/work` envelopes pushed by a connected OpenHive hub (via `src/map/`). `mail-inbound-consumer.ts` spawns a fresh parentless worker per envelope; `mail-inbound-reuse-consumer.ts` forwards into an existing long-lived agent's prompt loop instead of spawning. Unknown roles from the hub fall back to `worker` (validated against the local `RoleRegistry` before spawn — see `src/dispatch/CLAUDE.md` for the full failure mode this guards against).

**MAP / OpenHive bridge (`src/map/`).** Connects a sidecar to an OpenHive MAP hub, declaring connection-level capabilities (messaging, mail, trajectory reporting, task management) and per-agent capabilities on registration (coordinators get `protocols: ['acp']` to enable ACP streaming chat in OpenHive; workers do not). Registration uses `map/agents/register` rather than `map/agents/spawn` because `spawn` drops the `capabilities` field.

**Federation.** `adapters/federation.ts` lets multiple macro-agent instances federate their embedded `agent-inbox`es. Addressing is `agentId@systemId`. Trust is enforced via a configurable `allowedSystems` whitelist. Setup via `config.federation` in boot.

## Conventions

- One module per file; export via `index.ts`.
- Tests colocated in `__tests__/` next to source; `types.ts` holds interface definitions separately from implementation.
- Naming: camelCase (functions/vars), PascalCase (types/classes), kebab-case (file names), SCREAMING_SNAKE (constants).
- Typed errors with codes (`AgentManagerError`, `MCPToolError`, `AgentDetectionError`); prefer graceful degradation over hard failures (e.g. `opentasks` daemon unavailable is non-fatal); log warnings for recoverable issues.

## Common tasks

- **New MCP tool**: define a Zod schema in `src/mcp/mcp-server-v2.ts` (or a dedicated file), register inside `createMCPServerV2()` gated by `shouldRegister(toolName)`; use `agentManager` for lifecycle access, `inboxAdapter.send()` for messaging.
- **New built-in role**: add `src/roles/builtin/your_role.ts` with a `RoleDefinition`, register in `src/roles/builtin/index.ts`, update `isToolAllowedForRole()` in `src/roles/registry.ts` if needed.
- **New team role (YAML)**: add `.multiagent/teams/<team>/roles/<role>.yaml` with `extends`, `capabilities_add`/`capabilities_remove`, and a matching `prompts/<role>.md`; reference it from `team.yaml`.
- **New routing strategy**: implement `RoutingStrategy` from `src/trigger/trigger-system-v2.ts`, register via `triggerSystem.router.registerStrategy(strategy)`.
- **New landing strategy (V3)**: implement `LandingStrategy` from `src/workspace/types-v3.ts`, register via `workspaceManager.registerLandingStrategy(new YourStrategy())`, reference from YAML `landing:`.
- **New conflict recovery strategy (V3)**: implement `ConflictRecoveryStrategy` from `src/workspace/recovery/types.ts`, register into the team's recovery registry, select via YAML `on_conflict_recovery:`.
- **New topology policy (V3)**: implement `TopologyPolicy` from `src/workspace/topology/types.ts`, inject via `agentManager.setTopologyPolicy(policy)` or let `TeamManagerV2.startTeam` auto-wire `YamlDrivenTopology` from YAML.
- **New control command**: add to the `ControlCommand` union in `src/control/types.ts`, handle in `ControlServer.handleCommand()`, add a typed method on `ControlClient`.

## Environment variables

Set by boot / system config: `MACRO_BASE_DIR` (default `~/.macro-agent`), `MACRO_WORKSPACE_POOL_SIZE` (default `10`), `MACRO_TEAMS` (comma-separated auto-start teams), `MACRO_AGENT_HOME` (alt base dir for CLI clear).

Injected into MCP subprocesses by `AgentManagerV2`: `MACRO_AGENT_ID`, `MACRO_PARENT_ID`, `MACRO_TASK_ID`, `MACRO_AGENT_CWD`, `MACRO_PERMISSION_MODE`, `MACRO_SESSION_ID`, `MACRO_STREAM_ID`, `MACRO_AGENT_LINEAGE` (JSON array of ancestor IDs), `MACRO_CONTROL_SOCKET_PATH`, `INBOX_SOCKET_PATH`.

Injected by team runtime: `MACRO_TEAM_NAME`, `MACRO_TASK_MODE` (`push`/`pull`), `MACRO_INTEGRATION_STRATEGY`.

Key `BootV2Config` options: `api.enabled`/`api.port`, `acp.enabled`/`acp.port`, `federation.systemId`/`federation.peers`/`federation.trust.allowedSystems`, `dispatch.enabled`/`dispatch.pollIntervalMs`/`dispatch.maxConcurrent`/`dispatch.dispatchMode` (`route-only`/`spawn-only`/`prefer-route`/`prefer-spawn`).

## Dependencies

Runtime: `agent-inbox` (messaging, embedded), `opentasks` (task graph, IPC daemon), `acp-factory` (agent process management), `swarm-dispatch` (autonomous dispatch orchestrator), `openteams` (team template resolution), `git-cascade` (git worktrees, streams, Change-Id tracking), `better-sqlite3`, `@modelcontextprotocol/sdk`, `@multi-agent-protocol/sdk`, `@agentclientprotocol/claude-agent-acp`, `zod`, `commander`, `express`, `ws`, `js-yaml`.

Optional peer dependencies (declared but not required): `agentic-mesh`, `minimem`, `sessionlog`, `skill-tree`.

## References

- `docs/teams.md`, `docs/team-templates.md` — team template schema and examples
- `docs/workspace-redesign-plan.md`, `docs/workspace-interfaces.md` — V3 workspace interface contracts
- `docs/git-cascade-integration-gaps.md` — design narrative, workflow traces
- `docs/conflict-recovery.md` — conflict recovery strategy design
- `README.md` — end-to-end tutorial (first run, team YAML grammar, CLI reference, programmatic API examples)
