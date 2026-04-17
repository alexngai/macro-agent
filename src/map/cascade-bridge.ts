/**
 * Cascade Bridge — forwards GitCascadeAdapter events to the MAP hub as
 * `x-cascade/*` notifications.
 *
 * macro-agent's GitCascadeAdapter maintains a structured `GitCascadeEvent`
 * stream (translated from git-cascade's native `x-cascade/*` emissions + local
 * adapter events). This bridge subscribes to that stream and translates
 * **back** to `x-cascade/*` MAP method calls so the OpenHive hub receives the
 * canonical event schema.
 *
 * The round-trip (git-cascade → adapter translation → bridge re-translation)
 * is deliberate: it preserves the adapter's internal abstraction (other
 * macro-agent code consumes `GitCascadeEvent`, not raw MAP params) while
 * guaranteeing the hub sees the same schema git-cascade defines. The bridge
 * is the only place that knows about both shapes.
 *
 * Standalone-safe: when `connection.isConnected` is false, events are
 * dropped. macro-agent continues to work without an OpenHive hub.
 *
 * @module map/cascade-bridge
 */

import { CASCADE_METHODS } from 'git-cascade/events';

// Fallback method names for events not yet present in the installed
// git-cascade version (`STREAM_PAUSED`, `STREAM_RESUMED`,
// `STREAM_ROLLED_BACK` were added after 0.0.7). When the dep is upgraded,
// collapse these back into `CASCADE_METHODS.*` for a single source of truth.
const X_CASCADE_STREAM_PAUSED = 'x-cascade/stream.paused' as const;
const X_CASCADE_STREAM_RESUMED = 'x-cascade/stream.resumed' as const;
const X_CASCADE_STREAM_ROLLED_BACK = 'x-cascade/stream.rolled_back' as const;
import type { LifecycleBridgeConnection } from './lifecycle-bridge.js';
import type {
  GitCascadeAdapter,
  GitCascadeEvent,
} from '../workspace/git-cascade-adapter.js';

export interface CascadeBridgeDisposable {
  /** Unsubscribe from the adapter event stream. Safe to call multiple times. */
  dispose: () => void;
}

export interface CascadeBridgeOptions {
  /** Enable debug logging when events fail to forward. Defaults to false. */
  verbose?: boolean;
}

/**
 * Create a cascade bridge.
 *
 * Subscribes to `adapter.onEvent()` and forwards a fixed subset of events
 * (the ones that have a canonical `x-cascade/*` method name) as MAP
 * notifications via `connection.callExtension()`. Events with no MAP
 * counterpart (`stream:forked`, `worktree:*`, `task:*`, `mergeQueue:*`, etc.)
 * are silently ignored.
 *
 * @returns A disposable that unsubscribes from the adapter stream.
 */
export function createCascadeBridge(
  connection: LifecycleBridgeConnection,
  adapter: GitCascadeAdapter,
  options: CascadeBridgeOptions = {}
): CascadeBridgeDisposable {
  const verbose = options.verbose ?? false;

  const unsubscribe = adapter.onEvent((event: GitCascadeEvent) => {
    if (!connection.isConnected) return;

    const mapped = translate(event);
    if (!mapped) return;

    // Fire-and-forget: never block the adapter's event loop on a MAP RPC.
    // Errors are swallowed to preserve standalone-safety; they indicate the
    // hub is unreachable or the method isn't registered, neither of which
    // should break local cascade operations.
    void connection
      .callExtension(mapped.method, mapped.params)
      .catch((err) => {
        if (verbose) {
          // eslint-disable-next-line no-console
          console.warn(
            `[cascade-bridge] failed to forward ${event.type} as ${mapped.method}:`,
            err instanceof Error ? err.message : err
          );
        }
      });
  });

  return { dispose: unsubscribe };
}

// ─────────────────────────────────────────────────────────────────────────────
// GitCascadeEvent → x-cascade/* translation
// ─────────────────────────────────────────────────────────────────────────────

interface TranslatedCall {
  method: string;
  params: Record<string, unknown>;
}

/**
 * Translate a `GitCascadeEvent` into a MAP method call.
 *
 * Covers the 7 event types that have canonical MAP method names. Returns
 * `null` for events that are macro-agent-internal (worktree/task/mergeQueue
 * lifecycle, local-only forks, etc.).
 *
 * Field names flip from camelCase (macro-agent internal) back to snake_case
 * (MAP wire format). The bridge is intentionally conservative — it only
 * emits fields present on the event, letting the hub back-fill/ignore as
 * needed.
 */
function translate(event: GitCascadeEvent): TranslatedCall | null {
  const d = event.data;

  switch (event.type) {
    case 'stream:created':
      return {
        method: CASCADE_METHODS.STREAM_OPENED,
        params: {
          stream_id: d.streamId,
          name: d.name,
          agent_id: d.agentId,
          base_commit: d.baseCommit,
          parent_stream: d.parentStream,
          branch_name: d.branchName,
          metadata: d.metadata,
        },
      };

    case 'stream:committed':
      return {
        method: CASCADE_METHODS.STREAM_COMMITTED,
        params: {
          stream_id: d.streamId,
          commit_hash: d.commit,
          change_id: d.changeId,
          agent_id: d.agentId,
          message_summary: d.messageSummary,
          files_touched: d.filesTouched,
          parent_commit: d.parentCommit,
          metadata: d.metadata,
        },
      };

    case 'stream:merged':
      return {
        method: CASCADE_METHODS.STREAM_MERGED,
        params: {
          source_stream_id: d.sourceStreamId,
          target_stream_id: d.targetStreamId,
          merge_commit: d.mergeCommit,
          agent_id: d.agentId,
          strategy: d.strategy,
          source_commit: d.sourceCommit,
          metadata: d.metadata,
        },
      };

    case 'stream:conflicted':
      return {
        method: CASCADE_METHODS.STREAM_CONFLICTED,
        params: {
          stream_id: d.streamId,
          conflict_id: d.conflictId,
          conflicted_files: d.conflictedFiles,
          agent_id: d.agentId,
          conflicting_commit: d.conflictingCommit,
          target_commit: d.targetCommit,
          source: d.source,
          metadata: d.metadata,
        },
      };

    case 'conflict:resolved':
      // The adapter emits this from two sources: workspace-manager's local
      // resolveConflict path (carries resolvedBy + resolutionCommit) AND the
      // forwarded git-cascade stream.conflict_resolved (carries the explicit
      // resolution_method). Bridge only forwards events with conflict_id +
      // stream_id present (the cascade-driven shape).
      if (!d.streamId || !d.conflictId) return null;
      return {
        method: CASCADE_METHODS.STREAM_CONFLICT_RESOLVED,
        params: {
          stream_id: d.streamId,
          conflict_id: d.conflictId,
          resolution_method:
            (d.resolutionMethod as string | undefined) ??
            (d.resolvedBy ? 'agent' : 'manual'),
          resolved_by: d.resolvedBy,
          resolution_summary: d.resolutionSummary,
          metadata: d.metadata,
        },
      };

    case 'stream:abandoned':
      return {
        method: CASCADE_METHODS.STREAM_ABANDONED,
        params: {
          stream_id: d.streamId,
          reason: d.reason,
          cascade: d.cascade,
          metadata: d.metadata,
        },
      };

    case 'stream:pushed':
      // Trunk-style push to a remote (direct-push / optimistic-push). Hub
      // sees this as the "merged" equivalent for non-stream targets.
      if (!d.streamId || !d.pushedCommit || !d.remoteRef) return null;
      return {
        method: CASCADE_METHODS.STREAM_PUSHED,
        params: {
          stream_id: d.streamId,
          agent_id: d.agentId,
          pushed_commit: d.pushedCommit,
          remote: d.remote ?? 'origin',
          remote_ref: d.remoteRef,
          strategy: d.strategy,
          metadata: d.metadata,
        },
      };

    case 'cascade:rebased':
      return {
        method: CASCADE_METHODS.CASCADE_REBASED,
        params: {
          stream_id: d.streamId,
          agent_id: d.agentId,
          triggered_by_stream_id: d.triggeredByStreamId,
          triggered_by_agent_id: d.triggeredByAgentId,
          new_base_commit: d.newBaseCommit,
          new_head: d.newHead,
          new_commits: d.newCommits,
          metadata: d.metadata,
        },
      };

    case 'cascade:completed':
      return {
        method: CASCADE_METHODS.CASCADE_COMPLETED,
        params: {
          root_stream_id: d.rootStreamId,
          agent_id: d.agentId,
          strategy: d.strategy,
          updated_streams: d.updatedStreams,
          failed_streams: d.failedStreams,
          skipped_streams: d.skippedStreams,
          deferred_streams: d.deferredStreams,
          metadata: d.metadata,
        },
      };

    case 'mergeQueue:added':
      if (!d.entryId || !d.streamId) return null;
      return {
        method: CASCADE_METHODS.QUEUE_ADDED,
        params: {
          entry_id: d.entryId,
          stream_id: d.streamId,
          target_branch: (d.targetBranch as string | undefined) ?? 'main',
          metadata: d.metadata,
        },
      };

    case 'mergeQueue:ready':
      if (!d.entryId || !d.streamId) return null;
      return {
        method: CASCADE_METHODS.QUEUE_READY,
        params: {
          entry_id: d.entryId,
          stream_id: d.streamId,
          target_branch: (d.targetBranch as string | undefined) ?? 'main',
        },
      };

    case 'mergeQueue:cancelled':
      if (!d.entryId || !d.streamId) return null;
      return {
        method: CASCADE_METHODS.QUEUE_CANCELLED,
        params: {
          entry_id: d.entryId,
          stream_id: d.streamId,
          target_branch: (d.targetBranch as string | undefined) ?? 'main',
          reason: d.reason,
        },
      };

    case 'mergeQueue:removed':
      if (!d.entryId || !d.streamId) return null;
      return {
        method: CASCADE_METHODS.QUEUE_REMOVED,
        params: {
          entry_id: d.entryId,
          stream_id: d.streamId,
          target_branch: (d.targetBranch as string | undefined) ?? 'main',
          outcome: d.outcome,
        },
      };

    case 'stream:paused':
      if (!d.streamId) return null;
      return {
        method: X_CASCADE_STREAM_PAUSED,
        params: {
          stream_id: d.streamId,
          reason: d.reason,
        },
      };

    case 'stream:resumed':
      if (!d.streamId) return null;
      return {
        method: X_CASCADE_STREAM_RESUMED,
        params: {
          stream_id: d.streamId,
        },
      };

    case 'stream:rolled_back':
      if (!d.streamId) return null;
      return {
        method: X_CASCADE_STREAM_ROLLED_BACK,
        params: {
          stream_id: d.streamId,
          strategy: d.strategy,
          target: d.target,
          new_head: d.newHead,
        },
      };

    // Local-only events with no MAP counterpart.
    // 'stream:updated', 'stream:forked', 'worktree:*', 'task:*',
    // 'change:*', 'conflict:*' (legacy local-only variant — cascade-bridge
    // handles the cascade-driven 'conflict:resolved' separately above)
    default:
      return null;
  }
}
