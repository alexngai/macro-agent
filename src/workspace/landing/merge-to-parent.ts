/**
 * `merge-to-parent` landing strategy.
 *
 * Merges the source stream into its parent stream via `mergeStream`. On
 * success, optionally triggers a cascade rebase for dependents if
 * `strategyConfig.cascade === true` (cascade currently skipped — see
 * docs/workspace-redesign-plan.md "Known upstream gaps").
 *
 * @module workspace/landing/merge-to-parent
 */

import type {
  LandingStrategy,
  LandingContext,
  MergeResult,
} from '../types-v3.js';
import type { WorkspaceManager } from '../types.js';

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

    // Cascade rebase step deferred — requires git-cascade upstream to expose
    // the `cascade` namespace (see docs/workspace-redesign-plan.md Known
    // upstream gaps). Will be wired in when published.
    if (result.success && ctx.strategyConfig?.cascade === true) {
      // Placeholder — no-op for now. Emit a log so this gap is visible if hit.
      // Implementation lands in Phase 5b when git-cascade ships the export.
    }

    return result;
  }
}
