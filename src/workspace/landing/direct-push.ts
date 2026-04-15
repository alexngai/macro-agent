/**
 * `direct-push` landing strategy.
 *
 * Rebases the source stream's worker branch onto a target branch and pushes.
 * Preserves existing trunk-based behavior from the legacy `trunk` integration
 * strategy. Uses raw git (via execSync) since git-cascade doesn't expose a
 * rebase-and-push primitive.
 *
 * Strategy config:
 * - `target_branch`: string (default 'main')
 * - `max_retries`: number (default 3)
 *
 * @module workspace/landing/direct-push
 */

import { execSync } from 'child_process';
import type {
  LandingStrategy,
  LandingContext,
  MergeResult,
} from '../types-v3.js';

export class DirectPushStrategy implements LandingStrategy {
  readonly name = 'direct-push';

  async land(ctx: LandingContext): Promise<MergeResult> {
    const targetBranch = (ctx.strategyConfig?.target_branch as string | undefined) ?? 'main';
    const maxRetries = (ctx.strategyConfig?.max_retries as number | undefined) ?? 3;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        execSync(`git fetch origin ${targetBranch}`, {
          cwd: ctx.sourceWorktree,
          stdio: 'pipe',
        });
        execSync(`git rebase origin/${targetBranch}`, {
          cwd: ctx.sourceWorktree,
          stdio: 'pipe',
        });
        execSync(`git push origin HEAD:${targetBranch}`, {
          cwd: ctx.sourceWorktree,
          stdio: 'pipe',
        });
        return { success: true };
      } catch (err) {
        if (attempt >= maxRetries) {
          return {
            success: false,
            error: `direct-push: failed after ${maxRetries} attempts — ${
              err instanceof Error ? err.message : String(err)
            }`,
          };
        }
        // Transient failure — retry once after brief backoff
        // (brief; no sleep needed in tests — strategies are synchronous enough)
      }
    }

    return { success: false, error: 'direct-push: exhausted retries' };
  }
}
