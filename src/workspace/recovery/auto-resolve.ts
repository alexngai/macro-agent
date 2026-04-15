/**
 * `auto-resolve` conflict recovery strategy.
 *
 * Replays the failed merge in the agent's worktree with a git strategy
 * option (`-X ours` / `-X theirs` / `-s union` via `-X`), commits the
 * resolution, and returns the resulting commit hash.
 *
 * Strategy config:
 * - `strategy`: 'ours' | 'theirs' | 'union' (default: 'ours')
 * - `commit_message`: string (default: `resolve: ${conflictId} via <strategy>`)
 *
 * Scope limits:
 * - Only handles `operation: 'merge'`. Rebase conflicts need different tooling.
 * - Requires `ctx.worktree` to be set. If absent, returns `failed`.
 * - Requires `ctx.sourceCommit` to identify what to replay. If absent,
 *   tries `HEAD^2` (the merge commit's incoming side).
 *
 * @module workspace/recovery/auto-resolve
 */

import { execSync } from 'child_process';
import type {
  ConflictContext,
  ConflictRecoveryStrategy,
  ConflictResolution,
} from './types.js';

export class AutoResolveStrategy implements ConflictRecoveryStrategy {
  readonly name = 'auto-resolve';
  readonly mode = 'sync' as const;

  canHandle(ctx: ConflictContext): boolean {
    return ctx.operation === 'merge' && !!ctx.worktree;
  }

  async recover(ctx: ConflictContext): Promise<ConflictResolution> {
    if (ctx.operation !== 'merge') {
      return {
        kind: 'failed',
        error: `auto-resolve only handles merge conflicts, not ${ctx.operation}`,
      };
    }

    if (!ctx.worktree) {
      return {
        kind: 'failed',
        error: 'auto-resolve requires ctx.worktree',
      };
    }

    const strategy = (ctx.strategyConfig?.strategy as string | undefined) ?? 'ours';
    if (strategy !== 'ours' && strategy !== 'theirs' && strategy !== 'union') {
      return {
        kind: 'failed',
        error: `auto-resolve: unsupported strategy "${strategy}" (use ours | theirs | union)`,
      };
    }

    const sourceRef = ctx.sourceCommit ?? 'MERGE_HEAD';
    const commitMessage =
      (ctx.strategyConfig?.commit_message as string | undefined) ??
      `resolve: ${ctx.conflictId} via ${strategy}`;

    try {
      // Abort any in-progress merge state first (safety — merge may have
      // left the index in a partial state)
      try {
        execSync('git merge --abort', {
          cwd: ctx.worktree,
          stdio: 'pipe',
        });
      } catch {
        // No merge in progress — that's fine
      }

      // Replay the merge with the chosen strategy
      execSync(
        `git merge -X ${strategy} --no-edit -m ${quote(commitMessage)} ${quote(sourceRef)}`,
        {
          cwd: ctx.worktree,
          stdio: 'pipe',
        }
      );

      // Capture the new HEAD as the resolution commit
      const resolutionCommit = execSync('git rev-parse HEAD', {
        cwd: ctx.worktree,
        encoding: 'utf-8',
      }).trim();

      // Notify the WorkspaceManager so downstream consumers see the resolution
      try {
        ctx.workspaceManager.resolveConflict({
          conflictId: ctx.conflictId,
          resolvedBy: ctx.landingAgentId ?? 'system:auto-resolve',
          resolutionCommit,
          method: 'auto-resolve',
          summary: `merged with -X ${strategy}`,
        });
      } catch {
        // Non-fatal — resolution is recorded via return value regardless
      }

      return { kind: 'resolved', resolutionCommit };
    } catch (err) {
      return {
        kind: 'failed',
        error: `auto-resolve (strategy=${strategy}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }
  }
}

/** Minimal shell-safe single-quoting for commit messages / refs. */
function quote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
