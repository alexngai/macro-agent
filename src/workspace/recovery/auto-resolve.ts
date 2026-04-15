/**
 * `auto-resolve` conflict recovery strategy.
 *
 * Uses git's native merge strategies (`-X ours` / `-X theirs` / `union`) to
 * resolve merge conflicts automatically. Limited to `operation: 'merge'`;
 * rebase conflicts need different handling.
 *
 * Strategy config:
 * - `strategy`: 'ours' | 'theirs' | 'union' (default: 'ours')
 *
 * @module workspace/recovery/auto-resolve
 */

import type {
  ConflictContext,
  ConflictRecoveryStrategy,
  ConflictResolution,
} from './types.js';

export class AutoResolveStrategy implements ConflictRecoveryStrategy {
  readonly name = 'auto-resolve';
  readonly mode = 'sync' as const;

  canHandle(ctx: ConflictContext): boolean {
    return ctx.operation === 'merge';
  }

  async recover(ctx: ConflictContext): Promise<ConflictResolution> {
    if (ctx.operation !== 'merge') {
      return {
        kind: 'failed',
        error: `auto-resolve only handles merge conflicts, not ${ctx.operation}`,
      };
    }

    const strategy =
      (ctx.strategyConfig?.strategy as string | undefined) ?? 'ours';

    // auto-resolve would need worktree access + raw git commands to replay
    // the merge with the chosen strategy. Full implementation requires the
    // worktree path which is not on ConflictContext (only streamId).
    //
    // For the v3 scaffold: return failure with a clear message. A full
    // implementation lands when ConflictContext is extended with worktree
    // info, tracked as follow-up.

    return {
      kind: 'failed',
      error: `auto-resolve (strategy=${strategy}): requires worktree access; deferred to follow-up`,
    };
  }
}
