/**
 * `abandon` conflict recovery strategy.
 *
 * Abandons the conflicted stream. Throwaway-exploration teams; CI-driven
 * flows where broken work is discarded rather than resolved.
 *
 * @module workspace/recovery/abandon
 */

import type {
  ConflictContext,
  ConflictRecoveryStrategy,
  ConflictResolution,
} from './types.js';

export class AbandonStrategy implements ConflictRecoveryStrategy {
  readonly name = 'abandon';
  readonly mode = 'sync' as const;

  async recover(ctx: ConflictContext): Promise<ConflictResolution> {
    try {
      ctx.workspaceManager.abandonStream(ctx.streamId, {
        reason: `abandon strategy: conflict ${ctx.conflictId}`,
      });
      return {
        kind: 'abandoned',
        streamId: ctx.streamId,
        reason: `conflict ${ctx.conflictId}`,
      };
    } catch (err) {
      return {
        kind: 'failed',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
