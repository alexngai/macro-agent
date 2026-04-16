/**
 * Consolidation-through-tracker tests (A3 follow-up).
 *
 * Verifies `terminateWithChangeConsolidation` prefers
 * `workspaceManager.mergeStream()` when both workspaces carry stream ids —
 * so the merge fires `x-cascade/stream.merged` and propagates to the hub —
 * and cleanly falls back to raw `git merge` when streams aren't available.
 *
 * Unit-only: stubs workspaces + agent manager. No git invocations.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { terminateWithChangeConsolidation } from '../cascade.js';
import type {
  CascadeAgentManager,
  WorkspaceProvider,
} from '../cascade.js';
import type { Workspace, WorkspaceManager } from '../../workspace/types.js';
import * as cleanupModule from '../cleanup.js';

function mkWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    agentId: 'agent',
    path: '/tmp/wt',
    branch: 'stream/s',
    streamId: 's',
    role: 'worker' as any,
    createdAt: Date.now(),
    ...overrides,
  };
}

function mkAgentManager(): CascadeAgentManager {
  return {
    getChildren: vi.fn(() => []),
    terminate: vi.fn(async () => {}),
  };
}

describe('terminateWithChangeConsolidation', () => {
  let attemptMergeSpy: ReturnType<typeof vi.spyOn>;
  let getCurrentBranchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Default: branch matches so the "parent on expected branch" warning doesn't fire.
    getCurrentBranchSpy = vi
      .spyOn(cleanupModule, 'getCurrentBranch')
      .mockReturnValue('stream/parent');
    attemptMergeSpy = vi.spyOn(cleanupModule, 'attemptMerge');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('routes through workspaceManager.mergeStream when both workspaces have stream ids', async () => {
    const mergeStream = vi.fn(() => ({ success: true, newHead: 'abc123' }));
    const ws = { mergeStream } as unknown as WorkspaceManager;
    const provider: WorkspaceProvider = {
      getWorkspace: (id) =>
        id === 'child'
          ? mkWorkspace({ agentId: 'child', streamId: 'child-s', branch: 'stream/child' })
          : mkWorkspace({ agentId: 'parent', streamId: 'parent-s', branch: 'stream/parent', path: '/tmp/parent' }),
    };
    const am = mkAgentManager();

    const result = await terminateWithChangeConsolidation(
      'child' as any,
      'parent' as any,
      am,
      provider,
      undefined,
      ws,
    );

    expect(result).toEqual({ success: true, merged: true, mergeCommit: 'abc123' });
    expect(mergeStream).toHaveBeenCalledWith({
      sourceStreamId: 'child-s',
      targetStreamId: 'parent-s',
      agentId: 'parent',
      worktree: '/tmp/parent',
      metadata: undefined,
    });
    // Raw-git path must NOT be touched when the tracker handled it.
    expect(attemptMergeSpy).not.toHaveBeenCalled();
    expect(am.terminate).toHaveBeenCalledWith('child', 'changes_consolidated');
  });

  it('threads a provided taskRef into the mergeStream metadata', async () => {
    const mergeStream = vi.fn(() => ({ success: true, newHead: 'def456' }));
    const ws = { mergeStream } as unknown as WorkspaceManager;
    const provider: WorkspaceProvider = {
      getWorkspace: (id) =>
        mkWorkspace({
          agentId: id,
          streamId: `${id}-s`,
          branch: `stream/${id}`,
        }),
    };

    const taskRef = { resource_id: 'res-a1', node_id: 'task-a1' };
    await terminateWithChangeConsolidation(
      'child' as any,
      'parent' as any,
      mkAgentManager(),
      provider,
      undefined,
      ws,
      taskRef,
    );

    expect(mergeStream).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { task_ref: taskRef } }),
    );
  });

  it('surfaces tracker conflicts without falling back to raw git', async () => {
    const mergeStream = vi.fn(() => ({
      success: false,
      conflicts: ['shared.ts'],
    }));
    const ws = { mergeStream } as unknown as WorkspaceManager;
    const provider: WorkspaceProvider = {
      getWorkspace: (id) =>
        mkWorkspace({
          agentId: id,
          streamId: `${id}-s`,
          branch: `stream/${id}`,
        }),
    };
    const am = mkAgentManager();

    const result = await terminateWithChangeConsolidation(
      'child' as any,
      'parent' as any,
      am,
      provider,
      undefined,
      ws,
    );

    expect(result.success).toBe(false);
    expect(result.conflicts).toEqual(['shared.ts']);
    expect(attemptMergeSpy).not.toHaveBeenCalled();
    expect(am.terminate).toHaveBeenCalledWith('child', 'merge_conflict');
  });

  it('falls back to raw git when workspaceManager is not provided', async () => {
    attemptMergeSpy.mockReturnValue({
      success: true,
      mergeCommit: 'rawabc',
    });
    const provider: WorkspaceProvider = {
      getWorkspace: (id) =>
        mkWorkspace({
          agentId: id,
          streamId: `${id}-s`,
          branch: `stream/${id}`,
        }),
    };
    const am = mkAgentManager();

    const result = await terminateWithChangeConsolidation(
      'child' as any,
      'parent' as any,
      am,
      provider,
      undefined,
      // No workspaceManager argument.
    );

    expect(result).toEqual({ success: true, merged: true, mergeCommit: 'rawabc' });
    expect(attemptMergeSpy).toHaveBeenCalledOnce();
  });

  it('falls back to raw git when the child workspace lacks a stream id', async () => {
    attemptMergeSpy.mockReturnValue({ success: true, mergeCommit: 'legacyabc' });
    const mergeStream = vi.fn();
    const ws = { mergeStream } as unknown as WorkspaceManager;
    const provider: WorkspaceProvider = {
      getWorkspace: (id) =>
        id === 'child'
          ? mkWorkspace({ agentId: 'child', streamId: '', branch: 'feat/legacy' })
          : mkWorkspace({ agentId: 'parent', streamId: 'parent-s', branch: 'stream/parent' }),
    };

    const result = await terminateWithChangeConsolidation(
      'child' as any,
      'parent' as any,
      mkAgentManager(),
      provider,
      undefined,
      ws,
    );

    expect(result.success).toBe(true);
    expect(mergeStream).not.toHaveBeenCalled();
    expect(attemptMergeSpy).toHaveBeenCalledOnce();
  });

  it('falls back to raw git when tracker.mergeStream throws', async () => {
    const mergeStream = vi.fn(() => {
      throw new Error('stream not found');
    });
    attemptMergeSpy.mockReturnValue({ success: true, mergeCommit: 'fallbackabc' });
    const ws = { mergeStream } as unknown as WorkspaceManager;
    const provider: WorkspaceProvider = {
      getWorkspace: (id) =>
        mkWorkspace({
          agentId: id,
          streamId: `${id}-s`,
          branch: `stream/${id}`,
        }),
    };

    const result = await terminateWithChangeConsolidation(
      'child' as any,
      'parent' as any,
      mkAgentManager(),
      provider,
      undefined,
      ws,
    );

    expect(result.success).toBe(true);
    expect(mergeStream).toHaveBeenCalledOnce();
    expect(attemptMergeSpy).toHaveBeenCalledOnce();
  });

  it('preserves legacy "no workspace provider" behavior', async () => {
    const am = mkAgentManager();
    const result = await terminateWithChangeConsolidation(
      'child' as any,
      'parent' as any,
      am,
    );
    expect(result).toEqual({ success: true, merged: false });
    expect(am.terminate).toHaveBeenCalledWith('child', 'parent_stopped');
  });
});
