# Change: Add Self-Driving Codebases Support

## Why

Cursor's "Towards Self-Driving Codebases" research demonstrates that hundreds of AI agents can work autonomously on a single codebase for weeks — achieving ~1,000 commits/hour — using a planner/worker/judge hierarchy, trunk-based development, pull-based task assignment, and tolerance for transient errors.

macro-agent currently supports a structured, correctness-oriented model (coordinator → integrator → workers, merge queue, push-based tasks). This works well for controlled workflows but creates bottlenecks at scale: the integrator is a single gate, task assignment requires a coordinator in the loop, and workers are ephemeral with no session continuity.

To support both paradigms, macro-agent needs a modular team template layer that lets users load different agent team structures — including a self-driving mode — without modifying the core system.

## What Changes

- **Team Template System** (new capability): A `TeamLoader` and `TeamRuntime` that reads team configuration from `.macro-agent/teams/<name>/`, registers custom roles, configures integration strategy and task mode, and bootstraps the team's agent hierarchy. Teams are the composition layer on top of macro-agent's role-agnostic core.

- **Task Pull Model** (new capability + task-manager modification): `claim_task`, `unclaim_task`, and `list_claimable_tasks` MCP tools backed by atomic `TaskBackend.claim()` with optimistic locking. Workers in pull mode run a claim-execute-complete loop and self-terminate after idle timeout.

- **Integration Strategies** (new capability): Configurable `queue` (existing), `trunk` (direct push with rebase-and-retry), or `optimistic` (push-then-validate with auto-fixup) integration at the team level. Workers' `done()` handler dispatches to the active strategy.

- **Session Continuations** (new capability + agent-manager/event-store modifications): Persist agent session transcripts to EventStore. `AgentManager.resume()` spawns a new process with prior conversation history loaded as context. This enables multi-day operation through work/pause/resume cycles — session history continuity, not process persistence.

- **Autonomous Observability** (new capability + event-store/cli-api modifications): Materialized views for throughput, utilization, and error rate metrics over sliding windows. REST API endpoints for querying metrics. Metric events emitted from existing lifecycle hooks.

## Impact

- Affected specs: `team-templates` (new), `task-pull` (new), `integration-strategies` (new), `session-continuations` (new), `autonomous-observability` (new), `task-manager` (modified), `mcp-tools` (modified), `agent-manager` (modified), `event-store` (modified), `cli-api` (modified)
- Affected code: `src/teams/` (new), `src/task/backend/`, `src/mcp/tools/`, `src/agent/agent-manager.ts`, `src/agent/system-prompt.ts`, `src/workspace/`, `src/store/`, `src/api/server.ts`, `src/cli/index.ts`, `src/lifecycle/handlers/worker.ts`, `src/roles/capabilities.ts`
- **No breaking changes**: All new functionality is additive. Existing behavior preserved when no team is loaded (default strategy `queue`, default task mode `push`). The `--team` flag is opt-in.
