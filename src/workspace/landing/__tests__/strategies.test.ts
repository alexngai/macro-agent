/**
 * Landing strategy tests (Phase 5).
 */

import { describe, it, expect, vi } from 'vitest';
import {
  MergeToParentStrategy,
  QueueToBranchStrategy,
  registerBuiltinLandingStrategies,
} from '../index.js';
import type { WorkspaceManager } from '../../types.js';

describe('landing strategies', () => {
  describe('MergeToParentStrategy', () => {
    it('merges into parent stream when targetStreamId is absent', async () => {
      const strategy = new MergeToParentStrategy();
      const ws = {
        listStreams: vi.fn(() => [
          { id: 'child-1', parentStream: 'parent-1', status: 'active' },
        ]),
        mergeStream: vi.fn(() => ({ success: true, newHead: 'abc123' })),
      } as unknown as WorkspaceManager;

      const result = await strategy.land({
        agentId: 'agent-1',
        streamId: 'child-1',
        sourceWorktree: '/tmp/wt',
        workspaceManager: ws,
      });

      expect(result.success).toBe(true);
      expect(ws.mergeStream).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceStreamId: 'child-1',
          targetStreamId: 'parent-1',
        })
      );
    });

    it('fails when source has no parent and no targetStreamId', async () => {
      const strategy = new MergeToParentStrategy();
      const ws = {
        listStreams: vi.fn(() => [{ id: 'orphan-1', status: 'active' }]),
        mergeStream: vi.fn(),
      } as unknown as WorkspaceManager;

      const result = await strategy.land({
        agentId: 'agent-1',
        streamId: 'orphan-1',
        sourceWorktree: '/tmp/wt',
        workspaceManager: ws,
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/no target stream/);
    });

    it('uses explicit targetStreamId when provided', async () => {
      const strategy = new MergeToParentStrategy();
      const ws = {
        listStreams: vi.fn(() => []),
        mergeStream: vi.fn(() => ({ success: true, newHead: 'def456' })),
      } as unknown as WorkspaceManager;

      const result = await strategy.land({
        agentId: 'agent-1',
        streamId: 'src-1',
        sourceWorktree: '/tmp/wt',
        targetStreamId: 'target-1',
        workspaceManager: ws,
      });

      expect(result.success).toBe(true);
      expect(ws.mergeStream).toHaveBeenCalledWith(
        expect.objectContaining({ targetStreamId: 'target-1' })
      );
    });
  });

  describe('QueueToBranchStrategy', () => {
    it('enqueues to branch target (default main)', async () => {
      const strategy = new QueueToBranchStrategy();
      const addToMergeQueue = vi.fn(() => 'queue-entry-1');
      const ws = {
        adapter: { addToMergeQueue },
        listStreams: vi.fn(() => []),
      } as unknown as WorkspaceManager;

      const result = await strategy.land({
        agentId: 'agent-1',
        streamId: 'stream-1',
        sourceWorktree: '/tmp/wt',
        workspaceManager: ws,
      });

      expect(result.success).toBe(true);
      expect(addToMergeQueue).toHaveBeenCalledWith(
        expect.objectContaining({
          streamId: 'stream-1',
          targetBranch: 'main',
        })
      );
    });

    it('accepts explicit branch: target spec', async () => {
      const strategy = new QueueToBranchStrategy();
      const addToMergeQueue = vi.fn(() => 'q-1');
      const ws = {
        adapter: { addToMergeQueue },
        listStreams: vi.fn(() => []),
      } as unknown as WorkspaceManager;

      await strategy.land({
        agentId: 'agent-1',
        streamId: 'stream-1',
        sourceWorktree: '/tmp/wt',
        strategyConfig: { target: 'branch:release' },
        workspaceManager: ws,
      });

      expect(addToMergeQueue).toHaveBeenCalledWith(
        expect.objectContaining({ targetBranch: 'release' })
      );
    });
  });

  describe('registerBuiltinLandingStrategies', () => {
    it('registers all four built-in strategies', () => {
      const registered: string[] = [];
      const ws = {
        registerLandingStrategy: vi.fn((s) => registered.push(s.name)),
      } as unknown as WorkspaceManager;

      registerBuiltinLandingStrategies(ws);

      expect(registered).toContain('merge-to-parent');
      expect(registered).toContain('queue-to-branch');
      expect(registered).toContain('direct-push');
      expect(registered).toContain('optimistic-push');
    });
  });
});
