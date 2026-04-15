/**
 * `spawn-resolver` conflict recovery strategy.
 *
 * Async strategy that spawns a dedicated resolver agent on the conflicted
 * stream. The resolver reads conflict markers, resolves, commits, and calls
 * the `resolve_conflict` MCP tool — unblocking the original landing.
 *
 * Strategy config:
 * - `role`: string (default 'resolver') — role to spawn
 * - `max_concurrent`: number (default 2) — cap on simultaneous resolvers per stream
 * - `timeout_ms`: number (default 1,800,000 = 30 min) — fallback to escalate
 *
 * Unlike the other built-in strategies, this one requires an `AgentManager`
 * reference at construction time. Callers inject it via the factory. That's
 * why it's not in `buildBuiltinRecoveryRegistry()` — consumers register it
 * explicitly after constructing AgentManager.
 *
 * @module workspace/recovery/spawn-resolver
 * @see docs/conflict-recovery.md §4.3
 */

import type { AgentManager } from '../../agent/agent-manager.js';
import type { SpawnAgentOptions } from '../../agent/types.js';
import type {
  ConflictContext,
  ConflictRecoveryStrategy,
  ConflictResolution,
} from './types.js';

export interface SpawnResolverStrategyOptions {
  agentManager: AgentManager;
  /** Default role to spawn if not overridden in strategyConfig. */
  defaultRole?: string;
  /** Default timeout in ms. */
  defaultTimeoutMs?: number;
  /** Default concurrency cap per stream. */
  defaultMaxConcurrent?: number;
}

export class SpawnResolverStrategy implements ConflictRecoveryStrategy {
  readonly name = 'spawn-resolver';
  readonly mode = 'async' as const;

  // Tracks in-progress resolvers per stream to enforce max_concurrent.
  private readonly activeByStream = new Map<string, Set<string>>();

  constructor(private readonly opts: SpawnResolverStrategyOptions) {}

  async recover(ctx: ConflictContext): Promise<ConflictResolution> {
    const role =
      (ctx.strategyConfig?.role as string | undefined) ??
      this.opts.defaultRole ??
      'resolver';
    const timeoutMs =
      (ctx.strategyConfig?.timeout_ms as number | undefined) ??
      this.opts.defaultTimeoutMs ??
      30 * 60 * 1000;
    const maxConcurrent =
      (ctx.strategyConfig?.max_concurrent as number | undefined) ??
      this.opts.defaultMaxConcurrent ??
      2;

    // Concurrency cap
    const active = this.activeByStream.get(ctx.streamId) ?? new Set();
    if (active.size >= maxConcurrent) {
      return {
        kind: 'retry-after',
        backoffMs: 30_000,
        reason: `max concurrent resolvers (${maxConcurrent}) on stream ${ctx.streamId}`,
      };
    }

    // Spawn the resolver
    let resolverAgentId: string;
    try {
      const spawnOpts: SpawnAgentOptions = {
        role,
        task: `Resolve conflict ${ctx.conflictId} on stream ${ctx.streamId}`,
        parent: ctx.landingAgentId,
        capabilities: ['workspace.commit', 'workspace.resolve', 'workspace.read'],
      };
      const spawned = await this.opts.agentManager.spawn(spawnOpts);
      resolverAgentId = spawned.id;
    } catch (err) {
      return {
        kind: 'failed',
        error: `spawn-resolver: failed to spawn resolver — ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }

    active.add(resolverAgentId);
    this.activeByStream.set(ctx.streamId, active);

    // Wait for conflict.resolved event OR timeout. The resolver agent calls
    // `resolve_conflict` MCP tool, which invokes workspaceManager.resolveConflict,
    // which emits 'conflict:resolved' event.
    try {
      const resolution = await this.awaitResolution(ctx, timeoutMs);
      return resolution;
    } finally {
      active.delete(resolverAgentId);
      if (active.size === 0) this.activeByStream.delete(ctx.streamId);
    }
  }

  private awaitResolution(
    ctx: ConflictContext,
    timeoutMs: number
  ): Promise<ConflictResolution> {
    return new Promise((resolve) => {
      const unsubscribe = ctx.workspaceManager.onEvent((event) => {
        if (
          event.type === 'conflict:resolved' &&
          event.data.conflictId === ctx.conflictId
        ) {
          clearTimeout(timer);
          unsubscribe();
          resolve({
            kind: 'resolved',
            resolutionCommit: (event.data.resolutionCommit as string) ?? 'unknown',
          });
        }
      });

      const timer = setTimeout(() => {
        unsubscribe();
        resolve({
          kind: 'escalated',
          escalatedTo: 'human',
        });
      }, timeoutMs);
    });
  }
}

/**
 * Factory for SpawnResolverStrategy — requires AgentManager.
 */
export function createSpawnResolverStrategy(
  opts: SpawnResolverStrategyOptions
): SpawnResolverStrategy {
  return new SpawnResolverStrategy(opts);
}
