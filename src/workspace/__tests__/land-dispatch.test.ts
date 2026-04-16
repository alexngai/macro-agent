/**
 * WorkspaceManager.land() dispatcher tests (A2 follow-up).
 *
 * Closes the gap where `registerLandingStrategy` existed but no caller
 * invoked `.land(ctx)` at `done()` time. Verifies the dispatcher:
 *   - resolves strategy by name (internal or YAML form)
 *   - respects `strategyName: 'none'` (short-circuits to success)
 *   - errors out on unknown names
 *   - fills in `ctx.workspaceManager` before invoking the strategy
 *   - rejects when `canLand` returns false
 *
 * Unit-only — doesn't spin up git. The end-to-end path (strategy fires
 * tracker events → hub projects) is covered by OpenHive's
 * live-emission-e2e.test.ts.
 */

import { describe, it, expect, vi } from 'vitest';
import type { GitCascadeAdapter } from '../git-cascade-adapter.js';
import { DefaultWorkspaceManager, resolveLandingStrategyName } from '../workspace-manager.js';
import type { LandingStrategy, LandingContext } from '../types-v3.js';

// A no-op adapter stub that satisfies the DefaultWorkspaceManager constructor
// without touching git. Every method the dispatcher path might hit throws so
// accidental delegation is loud.
function stubAdapter(): GitCascadeAdapter {
  const throwing = (name: string) => () => {
    throw new Error(`stub adapter: ${name} should not be called in this test`);
  };
  return {
    close: vi.fn(),
    reconcile: throwing('reconcile'),
    listWorktrees: vi.fn(() => []),
    getWorktree: vi.fn(() => null),
  } as unknown as GitCascadeAdapter;
}

function makeTestStrategy(
  name: string,
  impl: (ctx: LandingContext) => ReturnType<LandingStrategy['land']>,
  canLand?: (ctx: LandingContext) => boolean,
): LandingStrategy {
  return { name, land: impl, canLand };
}

describe('WorkspaceManager.land() dispatcher', () => {
  it('dispatches to an internal-named strategy', async () => {
    const wm = new DefaultWorkspaceManager(stubAdapter());
    const land = vi.fn(async () => ({ success: true, newHead: 'abc' } as never));
    wm.registerLandingStrategy(makeTestStrategy('merge-to-parent', land));

    const result = await wm.land({
      agentId: 'a1',
      streamId: 's1',
      sourceWorktree: '/tmp/wt',
      strategyName: 'merge-to-parent',
      workspaceManager: wm,
    });

    expect(result.success).toBe(true);
    expect(land).toHaveBeenCalledOnce();
  });

  it('accepts YAML-style strategy names and maps them', async () => {
    const wm = new DefaultWorkspaceManager(stubAdapter());
    const land = vi.fn(async () => ({ success: true } as never));
    wm.registerLandingStrategy(makeTestStrategy('queue-to-branch', land));

    await wm.land({
      agentId: 'a1',
      streamId: 's1',
      sourceWorktree: '/tmp/wt',
      strategyName: 'queue_to_branch', // YAML form
      workspaceManager: wm,
    });

    expect(land).toHaveBeenCalledOnce();
  });

  it('defaults to merge-to-parent when strategyName is unset', async () => {
    const wm = new DefaultWorkspaceManager(stubAdapter());
    const land = vi.fn(async () => ({ success: true } as never));
    wm.registerLandingStrategy(makeTestStrategy('merge-to-parent', land));

    await wm.land({
      agentId: 'a1',
      streamId: 's1',
      sourceWorktree: '/tmp/wt',
      workspaceManager: wm,
    });

    expect(land).toHaveBeenCalledOnce();
  });

  it('short-circuits on strategyName: "none" without invoking any strategy', async () => {
    const wm = new DefaultWorkspaceManager(stubAdapter());
    const land = vi.fn(async () => ({ success: false } as never));
    wm.registerLandingStrategy(makeTestStrategy('merge-to-parent', land));

    const result = await wm.land({
      agentId: 'a1',
      streamId: 's1',
      sourceWorktree: '/tmp/wt',
      strategyName: 'none',
      workspaceManager: wm,
    });

    expect(result.success).toBe(true);
    expect(land).not.toHaveBeenCalled();
  });

  it('throws on an unknown strategy name', async () => {
    const wm = new DefaultWorkspaceManager(stubAdapter());
    await expect(
      wm.land({
        agentId: 'a1',
        streamId: 's1',
        sourceWorktree: '/tmp/wt',
        strategyName: 'nonexistent-strategy',
        workspaceManager: wm,
      }),
    ).rejects.toThrow(/No landing strategy registered/);
  });

  it('fills ctx.workspaceManager with the dispatcher instance', async () => {
    const wm = new DefaultWorkspaceManager(stubAdapter());
    let seenManager: unknown = null;
    wm.registerLandingStrategy(
      makeTestStrategy('merge-to-parent', async (ctx) => {
        seenManager = ctx.workspaceManager;
        return { success: true } as never;
      }),
    );

    await wm.land({
      agentId: 'a1',
      streamId: 's1',
      sourceWorktree: '/tmp/wt',
      // Deliberately pass a non-matching value to prove the dispatcher overrides.
      workspaceManager: { bogus: true },
    });

    expect(seenManager).toBe(wm);
  });

  it('rejects when strategy.canLand(ctx) returns false', async () => {
    const wm = new DefaultWorkspaceManager(stubAdapter());
    wm.registerLandingStrategy(
      makeTestStrategy(
        'merge-to-parent',
        async () => ({ success: true } as never),
        () => false,
      ),
    );

    await expect(
      wm.land({
        agentId: 'a1',
        streamId: 's1',
        sourceWorktree: '/tmp/wt',
        workspaceManager: wm,
      }),
    ).rejects.toThrow(/rejected context/);
  });

  it('propagates strategy return values including conflicts', async () => {
    const wm = new DefaultWorkspaceManager(stubAdapter());
    wm.registerLandingStrategy(
      makeTestStrategy(
        'merge-to-parent',
        async () => ({
          success: false,
          conflicts: ['foo.ts'],
        } as never),
      ),
    );

    const result = await wm.land({
      agentId: 'a1',
      streamId: 's1',
      sourceWorktree: '/tmp/wt',
      workspaceManager: wm,
    });

    expect(result.success).toBe(false);
    expect((result as { conflicts?: string[] }).conflicts).toEqual(['foo.ts']);
  });
});

describe('resolveLandingStrategyName()', () => {
  it('maps every YAML name to its internal counterpart', () => {
    expect(resolveLandingStrategyName('merge_to_parent_stream')).toBe('merge-to-parent');
    expect(resolveLandingStrategyName('queue_to_branch')).toBe('queue-to-branch');
    expect(resolveLandingStrategyName('direct_push')).toBe('direct-push');
    expect(resolveLandingStrategyName('optimistic_push')).toBe('optimistic-push');
    expect(resolveLandingStrategyName('cherry_pick_stack')).toBe('cherry-pick-stack');
  });

  it('passes internal names through unchanged', () => {
    expect(resolveLandingStrategyName('merge-to-parent')).toBe('merge-to-parent');
    expect(resolveLandingStrategyName('queue-to-branch')).toBe('queue-to-branch');
  });

  it('passes unknown names through (lets the dispatcher throw with a useful message)', () => {
    expect(resolveLandingStrategyName('my-custom-strategy')).toBe('my-custom-strategy');
  });

  it('defaults to merge-to-parent on undefined', () => {
    expect(resolveLandingStrategyName(undefined)).toBe('merge-to-parent');
  });

  it('preserves "none" so the dispatcher can short-circuit', () => {
    expect(resolveLandingStrategyName('none')).toBe('none');
  });
});
