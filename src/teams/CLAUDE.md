# Teams & Workspace Isolation - AI Agent Instructions

This document provides instructions for AI coding agents working on the team system and workspace isolation.

## Module Overview

The teams module manages declarative multi-agent topologies defined in YAML. It wires team config into running services (roles, spawn interceptor, signal filtering, emission validation) and coordinates workspace isolation through git worktrees.

Workspace isolation ensures each worker agent operates in its own git worktree with a dedicated branch. Changes flow through a merge queue for serialized integration.

## Key Files and Their Purpose

| File | Purpose | When to Modify |
|------|---------|----------------|
| `team-runtime.ts` | Wires team config into services, polls MERGE_REQUEST signals | Changing bootstrap, signal filtering, or merge coordination |
| `team-loader.ts` | Parses team YAML, resolves role inheritance | Adding YAML fields or role resolution logic |
| `team-manager.ts` | Manages multiple team instances | Multi-team orchestration |
| `types.ts` | TeamManifest, topology, communication types | Adding team config fields |
| `../agent/agent-manager.ts` | Spawn flow with workspace creation | Changing agent lifecycle or workspace binding |
| `../workspace/workspace-manager.ts` | Worktree creation and task management | Changing workspace creation or branch handling |
| `../workspace/dataplane-adapter.ts` | Wraps git-cascade tracker | Changing git operations or task tracking |
| `../lifecycle/handlers/worker.ts` | Done handler — branch detection and MERGE_REQUEST | Changing worker completion or merge flow |
| `../store/event-store.ts` | Event log, materialized views, out-of-band fields | Adding new metadata fields |

## Spawn Flow and Workspace Binding

The spawn flow in `agent-manager.ts` is the most critical path for workspace isolation. The ordering is:

```
emit spawn event (cwd = repo root)          ← line 673
persist + verify agent in EventStore         ← line 698
AgentFactory.spawn() → process handle        ← line 712
┌─ Workspace Creation ─────────────────────  ← line 719
│  createWorkspaceForRole() → worktree       ← line 726
│  createTask() → dataplane task             ← line 751
│  claimTask() → creates worker branch       ← line 753
│  registerChildWorkspace() (if applicable)  ← line 760
└──────────────────────────────────────────
effectiveCwd = workspace.path ?? cwd         ← line 779
updateAgentMetadata({ cwd: effectiveCwd })   ← line 783
persist (so MCP subprocess sees updated cwd) ← line 784
buildMacroAgentMcp({ cwd: effectiveCwd })    ← line 787
handle.createSession(effectiveCwd)           ← line 824
```

**Why this order matters**: Workspace creation happens AFTER `AgentFactory.spawn()` (so a failed spawn doesn't leave orphaned worktrees) but BEFORE `buildMacroAgentMcp()` and `createSession()` (so the agent process, MCP subprocess, and done handler all use the worktree path).

### Dataplane Task Creation

Worktrees are created in **detached HEAD** state. A real worker branch (e.g., `worker/<agentId>/<taskId>`) is only created when a dataplane task is started via `claimTask()`. The spawn flow handles this automatically:

```typescript
// 1. Create task in git-cascade dataplane (returns generated ID)
const dpTaskId = workspaceManager.createTask(workspace.streamId, { title });
// 2. Claim/start task (creates branch, checks it out in worktree)
workspaceManager.claimTask(dpTaskId, agentId, workspace.path);
```

Without this, `getCurrentBranch()` in the done handler would return `"HEAD"` instead of the actual worker branch name, causing MERGE_REQUEST signals to have an invalid `sourceBranch`.

## EventStore Out-of-Band Fields

`updateAgentMetadata()` writes fields directly to TinyBase (not through events). These fields must be listed in `OUT_OF_BAND_FIELDS` inside `rebuildViews()` (`event-store.ts` ~line 1341) or they will be lost when auto-load (every 1 second) triggers a view rebuild:

```typescript
const OUT_OF_BAND_FIELDS = ['plan', 'name', 'metadata', 'cwd', 'team_instance'] as const;
```

**If you add a new field to `AgentMetadataUpdate`**, you must also add it to `OUT_OF_BAND_FIELDS`. Otherwise the field reverts to its event-derived value on every auto-load cycle.

The preservation works by:
1. Saving current out-of-band values before clearing views
2. Replaying all events to rebuild views (resets fields to event-derived values)
3. Restoring saved out-of-band values on top

## Done Handler → Merge Queue Flow

When a worker calls `done()` (`lifecycle/handlers/worker.ts`):

```
done({ status: "completed" })
  → getCurrentBranch(context.workspacePath)      ← reads actual git branch
  → emit MERGE_REQUEST signal (via EventStore)   ← includes sourceBranch, taskId
  → mergeQueue.submit(streamId, { ... })         ← submit to local merge queue
  → schedule agent termination
```

The MCP subprocess emits MERGE_REQUEST to **shared SQLite** (EventStore). The main process polls for these signals.

## MERGE_REQUEST Polling

`team-runtime.ts` runs a 2-second polling loop (`startMergeRequestPolling()`, ~line 663):

1. `eventStore.reload()` — reads SQLite to see events from MCP subprocesses
2. Filter status events for `signal === "MERGE_REQUEST"`
3. Verify source agent is a team member (or child of one)
4. Extract `sourceBranch`, `taskId`, `workerId` from event payload
5. Submit to the real merge queue via `workspaceManager.getMergeQueue()`

**Why polling?** Workers run in separate MCP subprocesses with their own EventStore instances writing to shared SQLite. The main process must reload to see their events. Direct in-memory notification isn't possible across processes.

## Common Gotchas

### Spawn Interceptor Injects Workspace Fields

`team-runtime.ts` `_createSpawnInterceptor()` (~line 743) automatically injects:
- `streamId` — team's integration stream (for workers with `workspace.worktree` capability)
- `dataplaneTaskId` — `worker-${Date.now()}` identifier
- `capabilities` — from resolved role definition

These are injected into spawn options before `agent-manager.ts` processes them.

### Merge Queue Table Prefix

`DefaultWorkspaceManager` uses `tablePrefix: 'macro_'` for its dataplane adapter. Tests must use `wsManager.getMergeQueue()` (which shares this prefix) rather than creating a standalone `createMergeQueue()` instance. Mismatched prefixes cause the polling code to write to one table while assertions read from another.

### Agent CWD vs Session CWD

The `cwd` field exists in three places:
1. **EventStore agent row** (`agent.cwd`) — for resume/display. Updated via `updateAgentMetadata()`.
2. **Session creation** (`handle.createSession(effectiveCwd)`) — agent process working directory.
3. **MCP env** (`MACRO_AGENT_CWD`) — subprocess working directory, set in `buildMacroAgentMcp()`.

All three must agree. The spawn flow sets (2) and (3) from `effectiveCwd` and updates (1) via `updateAgentMetadata`. If (1) drifts (e.g., out-of-band field not preserved), resume would use the wrong directory.

### getCurrentBranch Returns "HEAD" for Detached Worktrees

If `claimTask()` fails or is skipped, the worktree remains in detached HEAD state. `getCurrentBranch()` returns `"HEAD"`, which becomes the `sourceBranch` in MERGE_REQUEST — an invalid branch name that breaks the integrator.

## Architecture Constraints

### DO

- Keep workspace creation before session creation in the spawn flow
- Create and claim a dataplane task for every worker workspace
- Add new `AgentMetadataUpdate` fields to `OUT_OF_BAND_FIELDS`
- Use `workspaceManager.getMergeQueue()` (not standalone) for consistent table prefixes
- Handle workspace creation failures gracefully (don't fail the spawn)
- Use `eventStore.reload()` before reading cross-process events

### DON'T

- Don't emit the spawn event with workspace-dependent data (workspace doesn't exist yet at emit time)
- Don't assume `getCurrentBranch()` returns a real branch — it can return `"HEAD"` if claim failed
- Don't create a standalone merge queue in tests — use `wsManager.getMergeQueue()`
- Don't skip `persist()` after `updateAgentMetadata()` — the MCP subprocess needs to see updated values in SQLite
- Don't remove fields from `OUT_OF_BAND_FIELDS` without migrating them to event-sourced storage

## Testing

### Test Layers

Tests in `__tests__/e2e/workspace-isolation.e2e.test.ts` are organized in three layers:

| Layer | Gate | What It Tests |
|-------|------|---------------|
| **1: Infrastructure** | `RUN_E2E_TESTS` | Worktree creation, stream management, merge queue operations |
| **2: Service** | `RUN_E2E_TESTS` | AgentManager + WorkspaceManager integration, spawn interceptor, done handler, full lifecycle |
| **3: Full Agent** | `RUN_FULL_AGENT_TESTS` | Real Claude Code agent calls done(), MERGE_REQUEST polling, merge queue submission |

```bash
# Layer 1+2 only (fast, no real agents)
RUN_E2E_TESTS=true npx vitest run --config vitest.e2e.config.ts src/teams/__tests__/e2e/workspace-isolation.e2e.test.ts

# All layers including full agent (slow, requires API)
RUN_E2E_TESTS=true RUN_FULL_AGENT_TESTS=true npx vitest run --config vitest.e2e.config.ts src/teams/__tests__/e2e/workspace-isolation.e2e.test.ts
```

### Key Assertions in Full Agent Tests

- **Bootstrap test**: `agentRecord.cwd === developer.workspace.path` (not repo root)
- **Done test**: `mr.workerBranch` matches `/^worker\//` (not `"HEAD"` or `"main"`)
- **Done test**: `mergeQueue.getQueueDepth(streamId) > 0` (MERGE_REQUEST reached queue)

## Related Documentation

- `../CLAUDE.md` — Root project instructions
- `../workspace/types.ts` — Workspace, WorkerWorkspace, StreamConfig types
- `../store/types/agents.ts` — Agent, AgentMetadataUpdate types
- `docs/teams.md` — Team template schema reference
