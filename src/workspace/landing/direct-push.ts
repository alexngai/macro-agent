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

import { execFileSync } from 'child_process';
import type {
  LandingStrategy,
  LandingContext,
  MergeResult,
} from '../types-v3.js';
import type { WorkspaceManager } from '../types.js';
import type { GitCascadeAdapter } from '../git-cascade-adapter.js';
import { assertSafeGitRef, GitInputError } from '../../util/git-safety.js';

export class DirectPushStrategy implements LandingStrategy {
  readonly name = 'direct-push';

  async land(ctx: LandingContext): Promise<MergeResult> {
    // `target_branch`/`remote` come from team YAML `landing_config`, which may
    // be attacker-influenced (e.g. a shared team template). Validate them as
    // plain refs and invoke git via execFileSync array args (no shell) so
    // they can never be a command-injection sink.
    let targetBranch: string;
    let remote: string;
    try {
      targetBranch = assertSafeGitRef(
        (ctx.strategyConfig?.target_branch as string | undefined) ?? 'main',
        'target_branch',
      );
      remote = assertSafeGitRef(
        (ctx.strategyConfig?.remote as string | undefined) ?? 'origin',
        'remote',
      );
    } catch (err) {
      if (err instanceof GitInputError) {
        return { success: false, error: err.message };
      }
      throw err;
    }
    const maxRetries = (ctx.strategyConfig?.max_retries as number | undefined) ?? 3;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        execFileSync('git', ['fetch', remote, targetBranch], {
          cwd: ctx.sourceWorktree,
          stdio: 'pipe',
        });
        execFileSync('git', ['rebase', `${remote}/${targetBranch}`], {
          cwd: ctx.sourceWorktree,
          stdio: 'pipe',
        });
        execFileSync('git', ['push', remote, `HEAD:${targetBranch}`], {
          cwd: ctx.sourceWorktree,
          stdio: 'pipe',
        });

        // Capture pushed commit + emit stream:pushed for hub observability
        // (OpenHive cascade-bridge translates this to x-cascade/stream.pushed
        // since trunk pushes don't fire stream.merged).
        try {
          const pushedCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
            cwd: ctx.sourceWorktree,
            encoding: 'utf-8',
          }).trim();
          const adapter = (
            ctx.workspaceManager as WorkspaceManager & {
              getGitCascadeAdapter?: () => GitCascadeAdapter;
            }
          ).getGitCascadeAdapter?.();
          adapter?.notifyStreamPushed({
            streamId: ctx.streamId,
            agentId: ctx.agentId,
            pushedCommit,
            remote,
            remoteRef: targetBranch,
            strategy: this.name,
            metadata: ctx.taskRef ? { task_ref: ctx.taskRef } : undefined,
          });
        } catch {
          // Best-effort observability — don't fail the push if notify fails.
        }

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
