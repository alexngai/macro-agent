# Workspace Redesign: Implementation Plan

Turns the design in `git-cascade-integration-gaps.md`, `workspace-interfaces.md`, and `conflict-recovery.md` into ordered, independently-reviewable work.

**Status**: active. Phase 0 starting now.

---

## Goal

Replace macro-agent's role-shaped workspace layer with a stream-first abstraction over git-cascade, configurable via team YAML, usable for all 6 workflows in the design doc (§5), with clean hooks for conflict recovery.

## Non-goals (v1)

- Graphite-style simultaneous multi-stream per agent (deferred — see interfaces §7.8 carve-out)
- cc-swarm integration (separate follow-up)
- Human-escalation UI for conflict recovery
- Cross-process conflict coordination
- Petitioning git-cascade to expose `updateWorktreeStream` publicly (accept raw `git checkout` workaround)

## Success criteria

- All 6 workflows from `git-cascade-integration-gaps.md` §5 expressible via YAML only
- Zero references to `src/workspace/merge-queue/` (duplicate removed)
- Every commit from a streamed agent carries a Change-Id
- `cascadeRebase` called on parent-stream updates when YAML requests it
- Conflict recovery dispatch works end-to-end with `spawn-resolver` strategy
- Existing `self-driving` team continues to work (regression-free)
- AgentManagerV2 has no role-name `switch(role)` dispatch for workspace allocation
- Total consumer-site diff under ~400 lines across `agent-manager-v2.ts` + `team-runtime-v2.ts`

---

## Phase summary

| # | Phase | Risk | Blocks |
|---|---|---|---|
| 0 | Additive DataplaneAdapter expansion | Very low | 1, 7 |
| 1 | New WorkspaceManager surface (alongside old) | Low | 3, 5, 7 |
| 2 | YAML Zod schema + team config parsing | Very low | 3 |
| 3 | TopologyPolicy + YamlDrivenTopology | Medium | 4 |
| 4 | AgentManagerV2 uses TopologyPolicy | Medium | 5, 8 |
| 5 | LandingStrategy integration | Medium | 6 |
| 6 | Delete macro-agent's duplicate MergeQueue | Low (once 5 lands) | — |
| 7 | ConflictRecoveryStrategy infrastructure | Low | — |
| 8 | Remove role-name fallback from AgentManagerV2 | Low (once 4 lands) | 9 |
| 9 | Deprecate & remove old WorkspaceManager methods | Low | — |
| 10 | Boot ergonomics: `macro-agent run <team>` CLI | Low | — |

Each phase is 1 PR unless noted.

---

## Phase 0 — Additive DataplaneAdapter expansion

**Scope**: expose the git-cascade primitives macro-agent doesn't currently surface. No new consumers yet; no behavior change.

**Subtasks**:
- Add to `src/workspace/dataplane-adapter.ts`:
  - `forkStream(opts)` → `tracker.forkStream`
  - `mergeStream(opts)` → `tracker.mergeStream`
  - `syncWithParent(opts)` → `tracker.syncWithParent`
  - `rebaseOntoStream(opts)` + async variant
  - `cascadeRebase(opts)` → imports `cascade` module
  - `commitChanges(opts)` → `tracker.commitChanges`
  - `abandonStream` / `pauseStream` / `resumeStream`
  - `listStreams` / `getStreamHierarchy` / `getDependents`
  - `addToMergeQueue` / `getNextToMerge` / `processMergeQueue` / `markMergeQueueReady` / etc.
  - `getChange` / `getChangeByCommit` / `markChangesMerged`
  - `getConflictForStream` / `listConflicts` (if exposed)
  - Event subscription via tracker's `emit` hook
- Unit test each new method against a temp-repo fixture.
- No changes to public WorkspaceManager interface yet.

**Acceptance**: all new methods have unit tests passing; `src/workspace/dataplane-adapter.ts` surface matches what §5 of `workspace-interfaces.md` needs. No existing tests broken.

---

## Phase 1 — New WorkspaceManager surface (alongside old)

**Scope**: introduce new methods on `DefaultWorkspaceManager` matching the redesigned interface in `workspace-interfaces.md` §5. Old methods untouched.

**Subtasks**:
- Create `src/workspace/types-v3.ts` with new types: `Principal`, `PseudoAgentId`, `StreamSpec`, `Worktree` (v3 shape), `AllocateWorktreeOpts`, `WorkspaceEvent` union, `MergeResult`, `RebaseResult`, `CascadeResult`, `ReconcileResult`.
- Extend `src/workspace/types.ts` `WorkspaceManager` interface with new methods (marked `// v3` for clarity):
  - `createStream`, `forkStream`, `mergeStream`, `syncWithParent`, `rebaseOntoStream`, `cascadeRebase`
  - `commitChanges`, `markChangesMerged`
  - `allocateWorktree` (new signature), `getWorktreeForAgent`, `listWorktrees`
  - `land`, `registerLandingStrategy`, `unregisterLandingStrategy`
  - `reconcile`, `healthCheck`, `onEvent`
- Implement on `DefaultWorkspaceManager` by delegating to DataplaneAdapter.
- Write own `reconcile()` wrapper: calls git-cascade's + walks worktree pool + cleans orphans.
- Add structured event re-emission: subscribe to git-cascade's `x-cascade/*` events; emit unified `WorkspaceEvent`.
- No consumers use new methods yet.

**Acceptance**: new interface is importable and usable; unit tests for each new method; existing `agent-manager-v2.ts` and `team-runtime-v2.ts` compile unchanged.

---

## Phase 2 — YAML Zod schema + team config parsing

**Scope**: `macro_agent.workspace` section validated via Zod at team load time.

**Subtasks**:
- Create `src/workspace/yaml-schema.ts` with `TeamWorkspaceConfigSchema` + `RoleWorkspaceConfigSchema` per `workspace-interfaces.md` §8.
- Plumb parsing into `src/teams/team-loader.ts`: when `macro_agent.workspace` is present, validate and attach to resolved team.
- Add cross-field validations in `superRefine` (`workspace: share_with_agent` requires `share_with`; `stream_lineage: track_existing_branch` requires `track_branch`).
- Update `self-driving/team.yaml` and any other existing configs to the new schema (or leave as-is if they omit `macro_agent.workspace`; parser accepts missing).
- Schema failures surface as team load errors with useful messages.

**Acceptance**: valid YAML parses; invalid YAML fails with clear error; test coverage for each schema branch.

---

## Phase 3 — TopologyPolicy + YamlDrivenTopology

**Scope**: introduce the `TopologyPolicy` interface and the default YAML-driven implementation.

**Subtasks**:
- Create `src/workspace/topology/types.ts` with `TopologyPolicy` interface + context types per `workspace-interfaces.md` §7.
- Create `src/workspace/topology/yaml-driven.ts` implementing `YamlDrivenTopology`:
  - `onTeamStart` → creates team root stream if any role's `stream_lineage` requires it
  - `onAgentSpawn` → maps role YAML config to `WorkspaceDecision`
  - `onAgentComplete` → deallocate, optionally cascade
  - `onParentStreamAdvanced` → schedule `syncWithParent` via WakeManager (for `on_parent_advanced: sync_with_parent` roles)
- Create `src/workspace/topology/cognitive-core.ts` — minimal policy for programmatic consumers
- Create `src/workspace/topology/no-workspace.ts` — null policy
- Unit test: `YamlDrivenTopology` on `self-driving` config reproduces current spawn decisions; on `peer-swarm` (new example) produces correct forkStream decisions.

**Acceptance**: policies produce same decisions as current code for self-driving; new YAML-only teams work.

---

## Phase 4 — AgentManagerV2 uses TopologyPolicy

**Scope**: rewire AgentManagerV2 to delegate workspace allocation to a TopologyPolicy instance. Keep fallback to old `switch(role)` dispatch if no policy set.

**Subtasks**:
- Add `setTopologyPolicy(policy: TopologyPolicy)` to AgentManagerV2.
- In `spawn()`, when `topologyPolicy` is set: call `onAgentSpawn` and execute the `WorkspaceDecision` via new `WorkspaceManager` methods.
- When unset: preserve existing `createWorkspaceForRole` behavior.
- Wire through boot-v2: when team config has `macro_agent.workspace`, instantiate `YamlDrivenTopology` and call `setTopologyPolicy`.
- Update TeamManagerV2 / TeamRuntimeV2 to use `TopologyPolicy.onTeamStart` for stream creation instead of direct `createIntegrationStream`.

**Acceptance**: self-driving team works unchanged; a new peer-swarm test team with `macro_agent.workspace` config spawns agents with correct streams.

---

## Phase 5 — LandingStrategy integration

**Scope**: replace the dead `IntegrationStrategy` abstraction with the new `LandingStrategy`. Workers land via `workspaceManager.land()` instead of direct queue submit.

**Subtasks**:
- Create `src/workspace/landing/types.ts` with `LandingStrategy` + `LandingContext` per `workspace-interfaces.md` §6.
- Create `src/workspace/landing/` strategies:
  - `merge-to-parent.ts` — calls `mergeStream` + optional `cascadeRebase`
  - `queue-to-branch.ts` — calls `addToMergeQueue`; drains are integrator-driven
  - `cherry-pick-stack.ts` — `createStackFromStream` + `cherryPickStackToTarget`
  - `direct-push.ts` — raw rebase+push (current trunk behavior, retained for compat)
  - `optimistic-push.ts` — direct-push + validation event
- Register all 5 at boot.
- Add MCP tool: `land` (gated by `workspace.land` capability).
- Wire `AgentManagerV2.terminate` (worker completion path): replace hardcoded `mergeQueue.submit` with `workspaceManager.land({ agentId, streamId, strategyName: roleConfig.landing })`.
- Add MCP tools for integrator: `next_merge_request`, `merge_stream`, `mark_merge_complete` (gated by `merge_queue.drain` + `workspace.merge`).
- Delete dead `src/workspace/strategies/` code (the `IntegrationStrategy` files).

**Acceptance**: worker completion routes through strategy; `self-driving` still works via `queue-to-branch` strategy; dead strategies directory gone.

---

## Phase 6 — Delete macro-agent's duplicate MergeQueue

**Scope**: remove `src/workspace/merge-queue/` — fully replaced by git-cascade's built-in.

**Subtasks**:
- Verify all merge queue access goes through `DataplaneAdapter.addToMergeQueue` / `getNextToMerge` / etc. (surfaces git-cascade's module).
- Delete `src/workspace/merge-queue/*`.
- Update `DefaultWorkspaceManager.getMergeQueue()`: either return a thin shim wrapping git-cascade's queue APIs, or remove the method entirely (preferred — callers use `workspaceManager.addToMergeQueue` / etc. directly).
- Remove `macro_` table prefix handling if present.

**Acceptance**: no references to the old MergeQueue class; `self-driving` still works; merge queue persistence now uses git-cascade's schema.

---

## Phase 7 — ConflictRecoveryStrategy infrastructure

**Scope**: implement `ConflictRecoveryStrategy` per `conflict-recovery.md`. Register the 5 built-ins. Wire dispatch into `done()` flow.

**Subtasks**:
- Create `src/workspace/recovery/types.ts` with `ConflictRecoveryStrategy`, `ConflictContext`, `ConflictResolution`.
- Implement built-ins:
  - `src/workspace/recovery/auto-resolve.ts`
  - `src/workspace/recovery/defer.ts`
  - `src/workspace/recovery/spawn-resolver.ts`
  - `src/workspace/recovery/abandon.ts`
  - `src/workspace/recovery/escalate.ts`
- Add `registerConflictRecoveryStrategy` / `recoverConflict` to WorkspaceManager.
- Wire into AgentManagerV2's `done()` flow: on `LandingResult.success = false && conflictId`, look up role config `on_conflict` (or team default), call `recoverConflict`.
- Add MCP tools: `resolve_conflict`, `list_conflicts`, `get_conflict` (gated by `workspace.resolve` capability).
- Per-stream recovery lock to serialize concurrent recoveries.
- `max_recovery_depth` enforcement with fallback to `escalate`.

**Acceptance**: `defer` works end-to-end (conflict creates record, stream marked conflicted, no crash); `spawn-resolver` spawns a resolver agent successfully in a test; `auto-resolve` with `ours` strategy works for synthetic merge conflicts.

---

## Phase 8 — Remove role-name fallback from AgentManagerV2

**Scope**: clean up the transitional `switch(role)` path left in Phase 4.

**Subtasks**:
- Remove `createWorkspaceForRole` role-name `switch` from `agent-manager-v2.ts:281-306`.
- Require `topologyPolicy` be set before any spawn with workspace-needing roles (throw on missing).
- Default to `NoWorkspaceTopology` when no YAML config — spawns all agents with `share-parent-cwd`.
- Update any tests that relied on role-name dispatch to provide an explicit policy.

**Acceptance**: grep for `case "coordinator"` / `case "worker"` / `case "integrator"` in `agent-manager-v2.ts` returns nothing; tests green.

---

## Phase 9 — Deprecate & remove old WorkspaceManager methods

**Scope**: clean up the old `createWorkerWorkspace` / `createIntegratorWorkspace` / `createCoordinatorWorkspace` / `getMergeQueue` / old-signature `deallocateWorkspace`.

**Subtasks**:
- Migrate any remaining callers to new methods.
- Remove the old methods from interface + implementation.
- Update tests.
- Old merge-queue-based `IntegrationStrategy` interface removed (was dead code, per Phase 5).

**Acceptance**: `WorkspaceManager` interface matches `workspace-interfaces.md` §5 exactly; no legacy methods.

---

## Phase 10 — Boot ergonomics: `macro-agent run <team>` CLI

**Scope**: first-class CLI for running a team with one command.

**Subtasks**:
- Add `src/cli/run.ts` — loads team YAML, constructs system, starts team, prompts root agent.
- Wire into `src/cli/index.ts` as `run <team>` command.
- `bootV2` accepts `config.team: string | TeamManifest` — auto-wires WorkspaceManager + TopologyPolicy + TeamManager.
- Add `config.task?: string` — if set, prompts root agent with this task after start.
- Streaming output (re-use existing ACP prompt streaming).

**Acceptance**: `macro-agent run self-driving --task "x"` starts the team, prompts root, streams output; Ctrl-C cleans up.

---

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| `self-driving` team regresses during migration | Run its e2e test after each phase; gate each PR on it |
| Raw `git checkout` for pool reuse bypasses git-cascade op log | Accepted; tracked as follow-up to petition git-cascade for public `updateWorktreeStream` |
| Git-cascade semantics differ from assumptions | Phase 0 unit tests verify each primitive against temp-repo fixture before wiring upward |
| Conflict recovery infinite loops | `max_recovery_depth` cap; `max_concurrent` per strategy; per-stream lock |
| Event storm from `x-cascade/*` subscription | Coalescing in WakeManager integration (Phase 3 `onParentStreamAdvanced`) |
| Reviewer-outlives-coder shared worktree deallocation | Ref-count implemented in Phase 1 `allocateWorktree` with `sharedWithAgent` opt |

---

## Known upstream gaps (git-cascade 0.0.1)

The published `git-cascade@0.0.1` dependency (pinned in `package.json`) lacks features present in the source at `references/git-cascade/`:

- **No `emit` callback** on `TrackerOptions` — event subscription to `x-cascade/*` not possible via the published API. Phase 0 falls back to local wrapper-level emits; Phase 5 (LandingStrategy) and Phase 3 (`on_parent_advanced`) will need this for event-driven sync.
- **`cascade.cascadeRebase` not namespace-exported** from `git-cascade` root. The cascade module exists as `dist/cascade.js` but isn't reachable (no subpath exports, no `export * as cascade` in index). Blocks Phase 5's `merge-to-parent` strategy's cascade step and Phase 3's auto-cascade.

**Resolution options:**
- (a) Publish a new `git-cascade` version that exposes these. Preferred.
- (b) Pin `git-cascade` to a local file path (`file:./references/git-cascade/`) temporarily until (a).
- (c) Workaround: for `cascadeRebase`, walk dependents manually via `getDependents()` + `syncWithParent()` in a loop. Less efficient, no atomic transactions.

Tracking as a P0 dependency issue; needs to land before Phase 5.

---

## Open items to resolve during implementation

From `workspace-interfaces.md` §11:
- [ ] **`checkout_stream` semantics** — decide in Phase 5 when we implement `fork_stream` MCP tool: relocate cwd vs re-allocate worktree. Likely: fresh worktree per stream, update `MACRO_STREAM_ID` in agent env on checkout.
- [ ] **`attach-to-stream` worktree** — decide in Phase 3. Proposal: always fresh worktree on target branch.
- [ ] **Conflict recovery retry ownership** — decide in Phase 7. Proposal: caller subscribes to `conflict.resolved` event; recovery strategy does not auto-retry.
- [ ] **Cascade event triggering** — decide in Phase 3. Proposal: `YamlDrivenTopology.onTeamStart` subscribes to `x-cascade/stream.committed` per relevant stream; WakeManager coalesces.

From `conflict-recovery.md` §11:
- [ ] **Cross-team conflicts** — decide in Phase 7. Proposal: owning team's policy; default escalate for federation.
- [ ] **Recovery observability** — decide in Phase 7. Proposal: optional `RECOVERY_PROGRESS` signal on team channel.

---

## Tracking

Per-phase progress tracked via TaskCreate/TaskUpdate. Each phase is one or more tasks; each task has acceptance criteria.

Milestone tags:
- `v3.0.0-alpha1` — Phases 0-2 complete (infrastructure additive, no behavior change)
- `v3.0.0-alpha2` — Phases 3-6 complete (TopologyPolicy + LandingStrategy in place, duplicate queue gone)
- `v3.0.0-alpha3` — Phase 7 complete (conflict recovery working)
- `v3.0.0-beta1` — Phases 8-9 complete (legacy removed)
- `v3.0.0` — Phase 10 complete (CLI ergonomics)
