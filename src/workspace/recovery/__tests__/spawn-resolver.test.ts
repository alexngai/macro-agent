/**
 * SpawnResolverStrategy tests (Phase 7b).
 */

import { describe, it, expect, vi } from 'vitest';
import {
  SpawnResolverStrategy,
  createSpawnResolverStrategy,
} from '../spawn-resolver.js';
import type { ConflictContext } from '../types.js';
import type { WorkspaceManager } from '../../types.js';
import type { AgentManager } from '../../../agent/agent-manager.js';

type EventListener = (event: { type: string; data: Record<string, unknown> }) => void;

function mockManagers(): {
  ws: WorkspaceManager;
  am: AgentManager;
  triggerResolved: (conflictId: string, commit: string) => void;
} {
  const listeners = new Set<EventListener>();

  const ws = {
    onEvent: vi.fn((cb: EventListener) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    }),
  } as unknown as WorkspaceManager;

  const am = {
    spawn: vi.fn().mockResolvedValue({ id: 'resolver-agent-1' }),
  } as unknown as AgentManager;

  const triggerResolved = (conflictId: string, commit: string) => {
    for (const listener of listeners) {
      listener({
        type: 'conflict:resolved',
        data: { conflictId, resolutionCommit: commit },
      });
    }
  };

  return { ws, am, triggerResolved };
}

function mockContext(ws: WorkspaceManager, overrides: Partial<ConflictContext> = {}): ConflictContext {
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

describe('SpawnResolverStrategy', () => {
  it('spawns a resolver with the configured role and awaits resolve', async () => {
    const { ws, am, triggerResolved } = mockManagers();
    const strat = createSpawnResolverStrategy({ agentManager: am });

    const ctx = mockContext(ws, {
      strategyConfig: { role: 'resolver', timeout_ms: 5000 },
    });

    const recoveryPromise = strat.recover(ctx);

    // Allow spawn + onEvent registration to complete
    await new Promise((r) => setTimeout(r, 10));

    expect(am.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        role: 'resolver',
        capabilities: expect.arrayContaining(['workspace.resolve']),
      })
    );

    // Simulate resolver agent calling resolve_conflict
    triggerResolved('c-1', 'abc123');

    const resolution = await recoveryPromise;
    expect(resolution.kind).toBe('resolved');
    if (resolution.kind === 'resolved') {
      expect(resolution.resolutionCommit).toBe('abc123');
    }
  });

  it('escalates on timeout', async () => {
    const { ws, am } = mockManagers();
    const strat = createSpawnResolverStrategy({
      agentManager: am,
      defaultTimeoutMs: 50, // short timeout for test
    });

    const ctx = mockContext(ws);
    const resolution = await strat.recover(ctx);

    expect(resolution.kind).toBe('escalated');
    if (resolution.kind === 'escalated') {
      expect(resolution.escalatedTo).toBe('human');
    }
  });

  it('returns retry-after when max_concurrent exceeded', async () => {
    const { ws, am, triggerResolved } = mockManagers();
    const strat = createSpawnResolverStrategy({
      agentManager: am,
      defaultMaxConcurrent: 1,
      defaultTimeoutMs: 5000,
    });

    // First resolver is still pending
    const first = strat.recover(mockContext(ws));
    await new Promise((r) => setTimeout(r, 10));

    // Second try — exceeds max
    const second = await strat.recover(mockContext(ws));
    expect(second.kind).toBe('retry-after');

    // Resolve the first so it cleans up
    triggerResolved('c-1', 'commit');
    await first;
  });

  it('returns failed when spawn itself fails', async () => {
    const { ws } = mockManagers();
    const am = {
      spawn: vi.fn().mockRejectedValue(new Error('spawn boom')),
    } as unknown as AgentManager;
    const strat = new SpawnResolverStrategy({ agentManager: am });

    const resolution = await strat.recover(mockContext(ws));
    expect(resolution.kind).toBe('failed');
    if (resolution.kind === 'failed') {
      expect(resolution.error).toMatch(/spawn boom/);
    }
  });
});
