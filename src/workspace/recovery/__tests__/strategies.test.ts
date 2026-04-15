/**
 * Conflict recovery strategy tests (Phase 7).
 */

import { describe, it, expect, vi } from 'vitest';
import {
  DeferStrategy,
  AbandonStrategy,
  EscalateStrategy,
  AutoResolveStrategy,
  buildBuiltinRecoveryRegistry,
} from '../index.js';
import type { ConflictContext } from '../types.js';
import type { WorkspaceManager } from '../../types.js';

function mockContext(overrides: Partial<ConflictContext> = {}): ConflictContext {
  const ws = {
    abandonStream: vi.fn(),
    pauseStream: vi.fn(),
  } as unknown as WorkspaceManager;
  return {
    conflictId: 'c-1',
    streamId: 'stream-1',
    paths: ['a.ts'],
    operation: 'merge',
    recoveryDepth: 0,
    workspaceManager: ws,
    ...overrides,
  };
}

describe('conflict recovery strategies', () => {
  describe('DeferStrategy', () => {
    it('returns { kind: deferred }', async () => {
      const strat = new DeferStrategy();
      const res = await strat.recover(mockContext());
      expect(res.kind).toBe('deferred');
    });
  });

  describe('AbandonStrategy', () => {
    it('abandons the stream and returns { kind: abandoned }', async () => {
      const strat = new AbandonStrategy();
      const ctx = mockContext();
      const res = await strat.recover(ctx);
      expect(res.kind).toBe('abandoned');
      expect(ctx.workspaceManager.abandonStream).toHaveBeenCalledWith(
        'stream-1',
        expect.objectContaining({ reason: expect.stringContaining('c-1') })
      );
    });

    it('returns { kind: failed } on abandon error', async () => {
      const strat = new AbandonStrategy();
      const ctx = mockContext();
      (ctx.workspaceManager.abandonStream as any) = vi.fn(() => {
        throw new Error('boom');
      });
      const res = await strat.recover(ctx);
      expect(res.kind).toBe('failed');
      if (res.kind === 'failed') {
        expect(res.error).toContain('boom');
      }
    });
  });

  describe('EscalateStrategy', () => {
    it('pauses the stream and returns { kind: escalated }', async () => {
      const strat = new EscalateStrategy();
      const ctx = mockContext();
      const res = await strat.recover(ctx);
      expect(res.kind).toBe('escalated');
      expect(ctx.workspaceManager.pauseStream).toHaveBeenCalledWith(
        'stream-1',
        expect.any(String)
      );
    });

    it('uses notify config when provided', async () => {
      const strat = new EscalateStrategy();
      const ctx = mockContext({
        strategyConfig: { notify: 'team:alpha' },
      });
      const res = await strat.recover(ctx);
      expect(res.kind).toBe('escalated');
      if (res.kind === 'escalated') {
        expect(res.escalatedTo).toBe('team:alpha');
      }
    });
  });

  describe('AutoResolveStrategy', () => {
    it('canHandle only applies to merge conflicts', () => {
      const strat = new AutoResolveStrategy();
      expect(strat.canHandle!(mockContext({ operation: 'merge' }))).toBe(true);
      expect(strat.canHandle!(mockContext({ operation: 'rebase' }))).toBe(false);
    });

    it('returns failed for non-merge operations', async () => {
      const strat = new AutoResolveStrategy();
      const res = await strat.recover(mockContext({ operation: 'rebase' }));
      expect(res.kind).toBe('failed');
    });

    it('returns failed (scaffold) for merge operations pending worktree hook', async () => {
      const strat = new AutoResolveStrategy();
      const res = await strat.recover(mockContext({ operation: 'merge' }));
      expect(res.kind).toBe('failed');
      if (res.kind === 'failed') {
        expect(res.error).toMatch(/worktree/);
      }
    });
  });

  describe('buildBuiltinRecoveryRegistry', () => {
    it('includes 4 built-in strategies', () => {
      const registry = buildBuiltinRecoveryRegistry();
      expect(registry.has('defer')).toBe(true);
      expect(registry.has('abandon')).toBe(true);
      expect(registry.has('escalate')).toBe(true);
      expect(registry.has('auto-resolve')).toBe(true);
      expect(registry.has('spawn-resolver')).toBe(false); // Phase 7b
    });
  });
});
