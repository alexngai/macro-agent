/**
 * `merge-to-parent` landing strategy.
 *
 * Merges the source stream into its parent stream via `mergeStream`. On
 * success, optionally triggers a cascade rebase for dependents if
 * `strategyConfig.cascade === true` (requires git-cascade 0.0.3+).
 *
 * Strategy config:
 * - `cascade`: boolean (default false) — run cascadeRebase after merge
 * - `cascadeStrategy`: 'stop_on_conflict' | 'skip_conflicting' | 'defer_conflicts'
 *   (default 'defer_conflicts')
 *
 * Cascade worktree provider:
 *   For each dependent stream needing a worktree, the strategy:
 *   1. Reuses a live agent's worktree if one is already allocated on that stream.
 *   2. Otherwise allocates an ephemeral system-owned worktree (under
 *      `system:cascade-<streamId>`), tracks it, and tears it down after
 *      cascadeRebase returns — regardless of per-stream success/failure.
 *
 * Per-root-stream lock prevents two parallel cascades on the same root from
 * racing on ephemeral worktree allocation.
 *
 * @module workspace/landing/merge-to-parent
 */

import type {
  LandingStrategy,
  LandingContext,
  MergeResult,
  CascadeStrategy,
  Principal,
} from '../types-v3.js';
import type { WorkspaceManager } from '../types.js';
import type { DefaultWorkspaceManager } from '../workspace-manager.js';

/**
 * Per-root-stream locks for cascadeRebase. Shared across all instances of
 * this strategy (module-scoped) so two separately-registered strategies
 * can't race either.
 */
const rootStreamLocks = new Map<string, Promise<unknown>>();

export class MergeToParentStrategy implements LandingStrategy {
  readonly name = 'merge-to-parent';

  async land(ctx: LandingContext): Promise<MergeResult> {
    const ws = ctx.workspaceManager as WorkspaceManager;

    // Resolve target stream. Explicit targetStreamId wins; otherwise use
    // the source stream's parent.
    let targetStreamId: string | undefined = ctx.targetStreamId;
    if (!targetStreamId) {
      const allStreams = ws.listStreams();
      const source = allStreams.find((s) => s.id === ctx.streamId);
      targetStreamId = source?.parentStream ?? undefined;
    }

    if (!targetStreamId) {
      return {
        success: false,
        error: `merge-to-parent: no target stream (source ${ctx.streamId} has no parent)`,
      };
    }

    // Resolve the worktree to perform the merge in.
    //
    // git's constraint: the target branch cannot already be checked out in
    // another worktree. Three cases:
    //   1. A live agent is already on the target stream → use that worktree
    //      (the merge happens there; the agent's files update).
    //   2. No live agent on target → use the source's worktree (target
    //      branch isn't checked out anywhere else, so mergeStream can
    //      check it out safely).
    //   3. Neither — fallback: allocate an ephemeral worktree on the target.
    const mergeWorktree = this.resolveMergeWorktree(ws, targetStreamId, ctx.sourceWorktree);
    const ephemeralForMerge = mergeWorktree.ephemeralId;

    try {
      const result = ws.mergeStream({
        sourceStreamId: ctx.streamId,
        targetStreamId,
        agentId: ctx.agentId,
        worktree: mergeWorktree.path,
      });

      // Cascade rebase on dependents if requested.
      if (result.success && ctx.strategyConfig?.cascade === true) {
        await this.runCascade(ws, ctx, targetStreamId);
      }

      return result;
    } finally {
      if (ephemeralForMerge) {
        try {
          (ws as DefaultWorkspaceManager).deallocateWorkspace(ephemeralForMerge);
        } catch {
          // Best-effort cleanup
        }
      }
    }
  }

  /**
   * Pick a worktree to perform the merge in.
   *
   * Priority:
   *   1. A live agent already on the target stream
   *   2. The source worktree (target branch not checked out elsewhere)
   *   3. Ephemeral system worktree on the target stream
   */
  private resolveMergeWorktree(
    ws: WorkspaceManager,
    targetStreamId: string,
    sourceWorktree: string
  ): { path: string; ephemeralId?: string } {
    const adapter = (ws as unknown as {
      adapter?: {
        listWorktrees?: () => Array<{ agentId: string; path: string; currentStream?: string | null }>;
      };
    }).adapter;

    if (adapter?.listWorktrees) {
      const live = adapter.listWorktrees().find((wt) => wt.currentStream === targetStreamId);
      if (live) return { path: live.path };
    }

    // Default: use the source worktree. mergeStream will check out the
    // target branch there. If that conflicts (branch checked out elsewhere
    // that we didn't detect), the adapter throws and the strategy's caller
    // handles it.
    return { path: sourceWorktree };
  }

  private async runCascade(
    ws: WorkspaceManager,
    ctx: LandingContext,
    rootStreamId: string
  ): Promise<void> {
    // Serialize cascades on the same root to prevent ephemeral-worktree
    // races.
    const prior = rootStreamLocks.get(rootStreamId);
    const gate = prior ?? Promise.resolve();

    const run = gate.then(async () => {
      await this.doCascade(ws, ctx, rootStreamId);
    });

    // Store under the lock; clean up when done regardless of outcome.
    rootStreamLocks.set(rootStreamId, run);
    try {
      await run;
    } finally {
      if (rootStreamLocks.get(rootStreamId) === run) {
        rootStreamLocks.delete(rootStreamId);
      }
    }
  }

  private async doCascade(
    ws: WorkspaceManager,
    ctx: LandingContext,
    rootStreamId: string
  ): Promise<void> {
    const dwm = ws as DefaultWorkspaceManager;
    const adapter = (dwm as unknown as {
      adapter?: {
        cascadeRebase?: (opts: unknown) => unknown;
        getWorktree?: (agentId: string) => { path: string; currentStream?: string } | null;
        listWorktrees?: () => Array<{ agentId: string; path: string; currentStream?: string | null }>;
      };
    }).adapter;
    if (!adapter?.cascadeRebase) return; // no-op if cascade unavailable

    const cascadeStrategy =
      (ctx.strategyConfig?.cascadeStrategy as CascadeStrategy | undefined) ??
      'defer_conflicts';

    // Track ephemeral worktrees we allocate so we can tear them down.
    const ephemeralIds: Principal[] = [];

    const provider = (streamId: string): string | null => {
      // 1. Look for a live agent already on this stream.
      if (adapter.listWorktrees) {
        const wts = adapter.listWorktrees();
        const live = wts.find((wt) => wt.currentStream === streamId);
        if (live) return live.path;
      }

      // 2. Allocate an ephemeral system-owned worktree.
      try {
        const ephemeralId = `system:cascade-${streamId}` as Principal;
        const worktree = ws.allocateWorktree({
          agentId: ephemeralId,
          streamId,
        });
        ephemeralIds.push(ephemeralId);
        return worktree.path;
      } catch {
        // Allocation failure — signal skip to cascadeRebase
        return null;
      }
    };

    try {
      adapter.cascadeRebase({
        rootStream: rootStreamId,
        agentId: ctx.agentId,
        strategy: cascadeStrategy,
        worktree: {
          mode: 'callback',
          provider,
        },
      });
    } catch {
      // Cascade internal failure — non-fatal to the landing
    } finally {
      // Tear down all ephemeral worktrees we allocated, regardless of
      // per-stream success/failure.
      for (const id of ephemeralIds) {
        try {
          dwm.deallocateWorkspace(id as string);
        } catch {
          // Best-effort cleanup
        }
      }
    }
  }
}
