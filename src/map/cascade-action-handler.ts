/**
 * Cascade Action Handler — receives hub→runtime commands.
 *
 * Listens for `x-cascade/request.*` notifications from the OpenHive hub
 * and dispatches to the GitCascadeAdapter. This is the inbound counterpart
 * to the CascadeBridge (which handles outbound events).
 *
 * Actions are fire-and-forget from the hub's perspective: the hub sends
 * the notification and the UI updates reactively when the resulting
 * `x-cascade/stream.*` event flows back through the bridge.
 *
 * @module map/cascade-action-handler
 */

import type { GitCascadeAdapter } from '../workspace/git-cascade-adapter.js';

export interface CascadeActionConnection {
  onNotification(
    method: string,
    handler: (params: unknown) => void | Promise<void>,
  ): void;
  offNotification(
    method: string,
    handler: (params: unknown) => void | Promise<void>,
  ): void;
}

const REQUEST_METHODS = {
  MERGE: 'x-cascade/request.merge',
  ABANDON: 'x-cascade/request.abandon',
  PAUSE: 'x-cascade/request.pause',
  RESUME: 'x-cascade/request.resume',
  RESOLVE: 'x-cascade/request.resolve',
  PUSH: 'x-cascade/request.push',
  COMMIT: 'x-cascade/request.commit',
} as const;

/**
 * Register cascade action handlers on the MAP connection.
 * Returns a cleanup function that removes all handlers.
 */
export function setupCascadeActionHandlers(
  connection: CascadeActionConnection,
  adapter: GitCascadeAdapter,
): () => void {
  const handlers: Array<{
    method: string;
    handler: (params: unknown) => void | Promise<void>;
  }> = [];

  const register = (
    method: string,
    handler: (params: unknown) => void | Promise<void>,
  ): void => {
    connection.onNotification(method, handler);
    handlers.push({ method, handler });
  };

  /** Find the first worktree checked out on a given stream. */
  function findWorktreeForStream(streamId: string): string | null {
    const wts = adapter.listWorktrees();
    const match = wts.find((wt) => wt.currentStream === streamId);
    return match?.path ?? null;
  }

  // ── Merge ─────────────────────────────────────────────────────────
  register(REQUEST_METHODS.MERGE, (params: unknown) => {
    const p = params as { stream_id?: string; target_stream_id?: string };
    if (!p?.stream_id) return;

    const stream = adapter.getStream(p.stream_id);
    const targetStreamId = p.target_stream_id ?? stream?.parentStream;
    if (!targetStreamId) return;

    const worktreePath = findWorktreeForStream(p.stream_id);
    if (!worktreePath) return;

    try {
      adapter.mergeStream({
        sourceStream: p.stream_id,
        targetStream: targetStreamId,
        agentId: 'hub-request',
        worktree: worktreePath,
      });
    } catch {
      // Non-fatal — the resulting event (or conflict) will surface via the bridge
    }
  });

  // ── Abandon ───────────────────────────────────────────────────────
  register(REQUEST_METHODS.ABANDON, (params: unknown) => {
    const p = params as { stream_id?: string; reason?: string };
    if (!p?.stream_id) return;
    try {
      adapter.abandonStream(p.stream_id, { reason: p.reason ?? 'hub-request' });
    } catch { /* non-fatal */ }
  });

  // ── Pause ─────────────────────────────────────────────────────────
  register(REQUEST_METHODS.PAUSE, (params: unknown) => {
    const p = params as { stream_id?: string; reason?: string };
    if (!p?.stream_id) return;
    try {
      adapter.pauseStream(p.stream_id, p.reason);
    } catch { /* non-fatal */ }
  });

  // ── Resume ────────────────────────────────────────────────────────
  register(REQUEST_METHODS.RESUME, (params: unknown) => {
    const p = params as { stream_id?: string };
    if (!p?.stream_id) return;
    try {
      adapter.resumeStream(p.stream_id);
    } catch { /* non-fatal */ }
  });

  // ── Resolve conflict ──────────────────────────────────────────────
  register(REQUEST_METHODS.RESOLVE, (params: unknown) => {
    const p = params as {
      stream_id?: string;
      conflict_id?: string;
      strategy?: string;
    };
    if (!p?.stream_id || !p?.conflict_id) return;
    try {
      adapter.resolveConflict({
        conflictId: p.conflict_id,
        resolution: {
          method: (p.strategy as 'ours' | 'theirs') ?? 'ours',
          resolvedBy: 'hub-request',
        },
      });
    } catch { /* non-fatal */ }
  });

  // ── Push ───────────────────────────────────────────────────────────
  register(REQUEST_METHODS.PUSH, (params: unknown) => {
    const p = params as {
      stream_id?: string;
      remote?: string;
      target_ref?: string;
    };
    if (!p?.stream_id) return;

    const worktreePath = findWorktreeForStream(p.stream_id);
    if (!worktreePath) return;

    const remote = p.remote ?? 'origin';
    const streamBranch = `stream/${p.stream_id}`;
    const targetRef = p.target_ref ?? streamBranch;

    try {
      const { execSync } = require('child_process');
      execSync(`git push ${remote} ${streamBranch}:refs/heads/${targetRef}`, {
        cwd: worktreePath,
        stdio: 'pipe',
        encoding: 'utf-8',
      });
      // Emit pushed event so the hub records it
      adapter.notifyStreamPushed?.({
        streamId: p.stream_id,
        agentId: 'hub-request',
        pushedCommit: execSync('git rev-parse HEAD', {
          cwd: worktreePath,
          encoding: 'utf-8',
        }).trim(),
        remote,
        remoteRef: targetRef,
        strategy: 'hub-push',
      });
    } catch { /* non-fatal — push failure is reported via absence of pushed event */ }
  });

  // ── Commit ────────────────────────────────────────────────────────
  register(REQUEST_METHODS.COMMIT, (params: unknown) => {
    const p = params as {
      stream_id?: string;
      message?: string;
      metadata?: Record<string, unknown>;
    };
    if (!p?.stream_id) return;

    const worktreePath = findWorktreeForStream(p.stream_id);
    if (!worktreePath) return;

    const message = p.message ?? 'checkpoint (hub-requested)';
    try {
      adapter.commitChanges({
        streamId: p.stream_id,
        agentId: 'hub-request',
        worktree: worktreePath,
        message,
        metadata: p.metadata,
      });
    } catch { /* non-fatal — nothing to commit, or stream conflicted */ }
  });

  // ── Cleanup ───────────────────────────────────────────────────────
  return () => {
    for (const { method, handler } of handlers) {
      connection.offNotification(method, handler);
    }
    handlers.length = 0;
  };
}
