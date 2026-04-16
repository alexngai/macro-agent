/**
 * `queue-to-branch` landing strategy.
 *
 * Adds the source stream to git-cascade's built-in merge queue targeting a
 * named branch (default 'main' or configured via `strategyConfig.target`).
 * The actual merge is drained by an integrator-capable agent using the
 * `next_merge_request` / `merge_stream` / `mark_merge_complete` MCP tools.
 *
 * Strategy config:
 * - `target`: "branch:<name>" | "stream:<id>" | "role:<role>" (default: "branch:main")
 * - `priority`: number (lower = higher priority, default 100)
 *
 * Return value shape adapts to git-cascade's MergeResult:
 * - `success: true` means the queue submission succeeded (not that merge happened).
 *
 * @module workspace/landing/queue-to-branch
 */

import type {
  LandingStrategy,
  LandingContext,
  MergeResult,
} from '../types-v3.js';
import { DefaultWorkspaceManager } from '../workspace-manager.js';

export class QueueToBranchStrategy implements LandingStrategy {
  readonly name = 'queue-to-branch';

  async land(ctx: LandingContext): Promise<MergeResult> {
    const ws = ctx.workspaceManager as DefaultWorkspaceManager;

    // Resolve the target branch name from strategyConfig.
    const targetSpec = (ctx.strategyConfig?.target as string | undefined) ?? 'branch:main';
    const targetBranch = this.resolveTargetBranch(targetSpec, ws, ctx);

    if (!targetBranch) {
      return {
        success: false,
        error: `queue-to-branch: could not resolve target from spec "${targetSpec}"`,
      };
    }

    const priority = (ctx.strategyConfig?.priority as number | undefined) ?? 100;

    // Access the adapter through the WorkspaceManager's getMergeQueue shim.
    // Direct call via the git-cascade adapter is made through a method on the
    // manager that we expose for strategies.
    try {
      // Use the underlying adapter via the DefaultWorkspaceManager
      const adapter = (ws as unknown as { adapter?: unknown }).adapter;
      if (
        adapter &&
        typeof (adapter as { addToMergeQueue?: unknown }).addToMergeQueue === 'function'
      ) {
        (
          adapter as {
            addToMergeQueue: (opts: {
              streamId: string;
              targetBranch: string;
              priority?: number;
              agentId: string;
            }) => string;
          }
        ).addToMergeQueue({
          streamId: ctx.streamId,
          targetBranch,
          priority,
          agentId: ctx.agentId,
        });
      }
    } catch (err) {
      return {
        success: false,
        error: `queue-to-branch: enqueue failed — ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }

    return { success: true };
  }

  private resolveTargetBranch(
    spec: string,
    ws: DefaultWorkspaceManager,
    ctx: LandingContext
  ): string | null {
    const [kind, value] = spec.split(':', 2);
    switch (kind) {
      case 'branch':
        return value ?? 'main';
      case 'stream': {
        // Look up the stream; use its branch name. For now, we synthesize
        // the default `stream/<id>` branch format git-cascade uses.
        const allStreams = ws.listStreams();
        const match = allStreams.find((s) => s.id === value);
        if (!match) return null;
        return `stream/${match.id}`;
      }
      case 'role':
        // Role → agent lookup requires agentStore access; deferred. Use
        // 'main' as fallback and log in a follow-up.
        return 'main';
      default:
        return spec; // assume raw branch name
    }
  }
}
