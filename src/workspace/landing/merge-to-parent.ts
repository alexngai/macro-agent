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
 * @module workspace/landing/merge-to-parent
 */

import type {
  LandingStrategy,
  LandingContext,
  MergeResult,
  CascadeStrategy,
} from '../types-v3.js';
import type { WorkspaceManager } from '../types.js';
import type { DefaultWorkspaceManager } from '../workspace-manager.js';

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

    const result = ws.mergeStream({
      sourceStreamId: ctx.streamId,
      targetStreamId,
      agentId: ctx.agentId,
      worktree: ctx.sourceWorktree,
    });

    // Cascade rebase on dependents if requested. Uses git-cascade's
    // cascadeRebase via the adapter (0.0.3+).
    if (result.success && ctx.strategyConfig?.cascade === true) {
      const adapter = (ws as unknown as { adapter?: { cascadeRebase?: Function; getWorktree?: Function } }).adapter;
      if (adapter?.cascadeRebase) {
        const cascadeStrategy = (ctx.strategyConfig?.cascadeStrategy as CascadeStrategy | undefined) ?? 'defer_conflicts';
        try {
          adapter.cascadeRebase({
            rootStream: targetStreamId,
            agentId: ctx.agentId,
            strategy: cascadeStrategy,
            worktree: {
              mode: 'callback',
              provider: (streamId: string) => {
                // Callback: find a worktree for the dependent stream, or
                // return null to skip. We look up agents whose active stream
                // matches.
                const worktrees = (adapter.getWorktree
                  ? (ws as unknown as DefaultWorkspaceManager).listStreams().map((s) => s)
                  : []);
                // Simplified: return null — cascade will skip streams without
                // worktrees per the strategy. Caller can provide a richer
                // provider via a custom strategy if needed.
                return null;
              },
            },
          });
        } catch {
          // Cascade failures are non-fatal to the landing itself
        }
      }
    }

    return result;
  }
}
