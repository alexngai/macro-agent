# Implementation Tasks

Tasks are ordered by dependency. Each phase delivers independently testable functionality. Phases 1-3 are foundational; Phases 4-5 build on them. Phases 2 and 3 can be parallelized after Phase 1 is complete.

---

## Phase 1: Team Template System (Foundation)

This phase delivers the modular team loading layer. Everything else builds on it.

- [ ] 1.1 Define `TeamManifest` TypeScript types in `src/teams/types.ts` — covers team.yaml schema: name, description, version, roles, bootstrap, integration, tasks, observability sections
- [ ] 1.2 Implement `TeamLoader` in `src/teams/team-loader.ts` — reads `.macro-agent/teams/<name>/` directory, parses `team.yaml`, validates schema, reads role YAML files, reads prompt template files
- [ ] 1.3 Implement `TeamRuntime` in `src/teams/team-runtime.ts` — takes a parsed `TeamManifest` and wires it into the system: registers roles into RoleRegistry, configures WorkspaceManager integration strategy, sets TaskBackend mode, stores active team state
- [ ] 1.4 Add team context to `AgentManager.spawn()` — propagate `MACRO_TEAM_NAME`, `MACRO_INTEGRATION_STRATEGY`, `MACRO_TASK_MODE` environment variables; include team section in system prompt generation (`src/agent/system-prompt.ts`)
- [ ] 1.5 Add `--team <name>` flag to CLI start command (`src/cli/index.ts`) — loads team via TeamLoader, initializes TeamRuntime, then proceeds with existing boot flow
- [ ] 1.6 Implement team bootstrap — after TeamRuntime initializes, spawn root agent and companion agents per manifest `bootstrap` section
- [ ] 1.7 Add `GET /api/team` endpoint (`src/api/server.ts`) — returns active team config or `{ active: false }`
- [ ] 1.8 Write unit tests for TeamLoader (manifest parsing, validation, defaults) and TeamRuntime (role registration, config propagation)
- [ ] 1.9 Write integration test: load a test team template, verify roles registered, agents spawned with correct env vars and prompts
- [ ] 1.10 Create reference team template `.macro-agent/teams/self-driving/` with team.yaml, planner/grinder/judge role definitions, and prompt templates

---

## Phase 2: Task Pull Model (can parallelize with Phase 3)

Depends on: Phase 1 (team template sets `tasks.mode: pull`)

- [ ] 2.1 Add `tags` field to task types in `src/task/backend/types.ts` and `src/store/types/tasks.ts`
- [ ] 2.2 Implement `claim(agentId, filters?)` on `TaskBackend` interface — atomic find-and-assign with optimistic locking
- [ ] 2.3 Implement `claim()` in `InMemoryTaskBackend` — scan pending tasks matching filters, CAS on status
- [ ] 2.4 Implement `unclaim(agentId, taskId, reason?)` on `TaskBackend` interface and `InMemoryTaskBackend`
- [ ] 2.5 Add `task.claim` capability to `src/roles/capabilities.ts` capability-tool map
- [ ] 2.6 Implement `claim_task` MCP tool in `src/mcp/tools/claim_task.ts` — schema, handler calling TaskBackend.claim(), response formatting
- [ ] 2.7 Implement `unclaim_task` MCP tool in `src/mcp/tools/unclaim_task.ts`
- [ ] 2.8 Implement `list_claimable_tasks` MCP tool in `src/mcp/tools/list_claimable_tasks.ts`
- [ ] 2.9 Register new tools in `src/mcp/mcp-server.ts` with `task.claim` capability gating
- [ ] 2.10 Modify worker `done()` handler (`src/lifecycle/handlers/worker.ts`) — when task mode is `pull` and status is `completed`, do NOT set `shouldTerminate: true`; instead, allow the worker to continue its claim loop
- [ ] 2.11 Add idle timeout logic — worker tracks last successful claim time; if idle timeout exceeded, self-terminate with `done({ status: "completed", summary: "idle exit" })`
- [ ] 2.12 Write unit tests for claim/unclaim (including contention), MCP tools, and pull-mode done handler
- [ ] 2.13 Write integration test: spawn workers in pull mode, create tasks, verify workers claim and complete them, verify idle timeout termination

---

## Phase 3: Integration Strategies (can parallelize with Phase 2)

Depends on: Phase 1 (team template sets `integration.strategy`)

- [ ] 3.1 Define `IntegrationStrategy` type and configuration in `src/workspace/types.ts` — `queue | trunk | optimistic` with strategy-specific options
- [ ] 3.2 Add strategy configuration to `WorkspaceManager` — accept strategy from TeamRuntime, store as active strategy for the stream
- [ ] 3.3 Implement trunk strategy in `src/workspace/strategies/trunk.ts` — commit, push to integration branch, rebase-and-retry on conflict, max retries, configurable conflict action (abandon/resolve)
- [ ] 3.4 Modify worker `done()` handler — dispatch to strategy-specific integration: `queue` uses existing merge request flow, `trunk` uses new direct-push flow
- [ ] 3.5 Implement optimistic strategy in `src/workspace/strategies/optimistic.ts` — push immediately, emit validation request event
- [ ] 3.6 Implement background validator for optimistic strategy — listens for validation request events, runs build/test, creates fixup tasks on failure, snapshots green branch on success
- [ ] 3.7 Ensure `queue` strategy is unchanged default — verify existing merge queue tests still pass with no config changes
- [ ] 3.8 Write unit tests for trunk strategy (successful push, rebase retry, max retries exceeded, abandon vs resolve)
- [ ] 3.9 Write unit tests for optimistic strategy (push, validation pass, validation fail with fixup task creation, green branch snapshot)
- [ ] 3.10 Write integration test: run workers with each strategy, verify correct behavior

---

## Phase 4: Session Continuations

Depends on: Phase 1 (team template configures `lifecycle.continuation`)

- [ ] 4.1 Define session history event type in `src/store/types/events.ts` — `session_history` event with transcript, message count, token estimate
- [ ] 4.2 Implement session history storage in EventStore — `storeSessionHistory(agentId, transcript)` and `getSessionHistory(agentId, options?)`
- [ ] 4.3 Add session history persistence to agent termination flow in `AgentManager.terminate()` — when `lifecycle.continuation` is enabled for the role, persist the transcript
- [ ] 4.4 Add periodic checkpoint persistence — after each agent tool-call round-trip, persist incremental session state (if continuation enabled)
- [ ] 4.5 Implement `AgentManager.resume(agentId, options?)` — load session history, apply context window limits, generate resume prompt, spawn new agent process with history as initial context
- [ ] 4.6 Add `lifecycle.continuation` to `RoleDefinition` type and capability checks
- [ ] 4.7 Add `continuations` section to team manifest schema and TeamRuntime propagation
- [ ] 4.8 Write unit tests for session storage/retrieval, context window limiting, resume prompt generation
- [ ] 4.9 Write integration test: spawn agent, terminate, resume, verify context continuity

---

## Phase 5: Autonomous Observability

Depends on: Phase 1 (team template configures `observability`), partially Phase 2 (task metrics), partially Phase 3 (commit/conflict metrics)

- [ ] 5.1 Define metric event types in `src/store/types/events.ts` — `metric.task_completed`, `metric.commit_pushed`, `metric.conflict_detected`
- [ ] 5.2 Emit metric events from done() handlers, workspace strategies, and conflict detection paths
- [ ] 5.3 Implement throughput materialized view in EventStore — sliding window computation over task and commit metric events
- [ ] 5.4 Implement utilization materialized view in EventStore — derived from agent state transitions (spawn, claim, done, terminate)
- [ ] 5.5 Implement error rate materialized view in EventStore — derived from task.failed and conflict events
- [ ] 5.6 Add `GET /api/metrics/throughput`, `GET /api/metrics/utilization`, `GET /api/metrics/errors` endpoints to API server
- [ ] 5.7 Write unit tests for each materialized view (window computation, edge cases)
- [ ] 5.8 Write integration test: run a multi-agent session, query metrics endpoints, verify counts match actual activity

---

## Phase 6: Reference Template and Documentation

Depends on: All previous phases

- [ ] 6.1 Finalize the `self-driving` reference team template with tested role definitions and prompts
- [ ] 6.2 Create a second reference template (e.g., `structured` or `default`) that codifies the existing coordinator/integrator/worker pattern as a team template for comparison
- [ ] 6.3 Add team template documentation to `docs/teams.md` — schema reference, how to create custom templates, examples
- [ ] 6.4 Run end-to-end test with self-driving template: planner creates tasks, workers claim and execute, judge monitors quality, trunk integration, metrics reporting
