/**
 * Unit tests for createCascadeBridge.
 *
 * Exercises the GitCascadeEvent → x-cascade/* MAP call translation directly
 * via a mock adapter + mock connection, avoiding real git operations. E2E
 * coverage lives elsewhere (workspace-v3 tests + OpenHive hub round-trips).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createCascadeBridge } from '../cascade-bridge.js';
import type {
  GitCascadeEvent,
  GitCascadeEventCallback,
  GitCascadeAdapter,
} from '../../workspace/git-cascade-adapter.js';
import type { LifecycleBridgeConnection } from '../lifecycle-bridge.js';

interface MockConnection extends LifecycleBridgeConnection {
  calls: Array<{ method: string; params: unknown }>;
  connected: boolean;
}

function createMockConnection(connected = true): MockConnection {
  const calls: Array<{ method: string; params: unknown }> = [];
  return {
    calls,
    connected,
    get isConnected() {
      return this.connected;
    },
    async callExtension(method: string, params?: unknown): Promise<unknown> {
      this.calls.push({ method, params });
      return { ok: true };
    },
  };
}

interface MockAdapter {
  emit: (event: GitCascadeEvent) => void;
  onEvent(callback: GitCascadeEventCallback): () => void;
}

function createMockAdapter(): MockAdapter {
  const listeners = new Set<GitCascadeEventCallback>();
  return {
    emit(event: GitCascadeEvent) {
      for (const listener of listeners) {
        listener(event);
      }
    },
    onEvent(callback: GitCascadeEventCallback): () => void {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
  };
}

function mkEvent<T extends GitCascadeEvent['type']>(
  type: T,
  data: Record<string, unknown>
): GitCascadeEvent {
  return { type, timestamp: Date.now(), data } as GitCascadeEvent;
}

describe('createCascadeBridge', () => {
  let connection: MockConnection;
  let adapter: MockAdapter;

  beforeEach(() => {
    connection = createMockConnection();
    adapter = createMockAdapter();
  });

  async function flushMicrotasks() {
    // The bridge's callExtension is fire-and-forget (void + .catch). Yield
    // to the microtask queue so the promise settles before assertions.
    await new Promise((resolve) => setImmediate(resolve));
  }

  it('forwards stream:created as x-cascade/stream.opened with snake_case params', async () => {
    createCascadeBridge(connection, adapter as unknown as GitCascadeAdapter);
    adapter.emit(
      mkEvent('stream:created', {
        streamId: 's1',
        name: 'feat',
        agentId: 'a1',
        baseCommit: 'base',
        branchName: 'stream/s1',
        metadata: { task_ref: { resource_id: 'r', node_id: 'n' } },
      })
    );
    await flushMicrotasks();

    expect(connection.calls).toHaveLength(1);
    expect(connection.calls[0].method).toBe('x-cascade/stream.opened');
    expect(connection.calls[0].params).toMatchObject({
      stream_id: 's1',
      name: 'feat',
      agent_id: 'a1',
      base_commit: 'base',
      branch_name: 'stream/s1',
      metadata: { task_ref: { resource_id: 'r', node_id: 'n' } },
    });
  });

  it('forwards stream:committed with commit_hash and files_touched', async () => {
    createCascadeBridge(connection, adapter as unknown as GitCascadeAdapter);
    adapter.emit(
      mkEvent('stream:committed', {
        streamId: 's1',
        commit: 'abc',
        changeId: 'c-123',
        agentId: 'a',
        messageSummary: 'feat: x',
        filesTouched: ['a.ts', 'b.ts'],
        parentCommit: 'base',
      })
    );
    await flushMicrotasks();

    expect(connection.calls[0].method).toBe('x-cascade/stream.committed');
    expect(connection.calls[0].params).toMatchObject({
      stream_id: 's1',
      commit_hash: 'abc',
      change_id: 'c-123',
      files_touched: ['a.ts', 'b.ts'],
      parent_commit: 'base',
    });
  });

  it('forwards cascade:rebased with new_commits array', async () => {
    createCascadeBridge(connection, adapter as unknown as GitCascadeAdapter);
    adapter.emit(
      mkEvent('cascade:rebased', {
        streamId: 'dep',
        agentId: 'a',
        triggeredByStreamId: 'root',
        triggeredByAgentId: 'a',
        newBaseCommit: 'nb',
        newHead: 'nh',
        newCommits: [
          {
            commit_hash: 'r1',
            change_id: 'chg',
            parent_commit: 'nb',
            message_summary: 'rebased',
            files_touched: ['x.ts'],
          },
        ],
      })
    );
    await flushMicrotasks();

    expect(connection.calls[0].method).toBe('x-cascade/cascade.rebased');
    expect(connection.calls[0].params).toMatchObject({
      stream_id: 'dep',
      triggered_by_stream_id: 'root',
      new_base_commit: 'nb',
      new_head: 'nh',
    });
    expect((connection.calls[0].params as { new_commits: unknown[] }).new_commits).toHaveLength(1);
  });

  it('forwards cascade:completed with summary fields', async () => {
    createCascadeBridge(connection, adapter as unknown as GitCascadeAdapter);
    adapter.emit(
      mkEvent('cascade:completed', {
        rootStreamId: 'root',
        agentId: 'a',
        strategy: 'stop_on_conflict',
        updatedStreams: ['d1'],
        failedStreams: [],
        skippedStreams: [],
      })
    );
    await flushMicrotasks();

    expect(connection.calls[0].method).toBe('x-cascade/cascade.completed');
    expect(connection.calls[0].params).toMatchObject({
      root_stream_id: 'root',
      strategy: 'stop_on_conflict',
      updated_streams: ['d1'],
    });
  });

  it('drops events while disconnected (standalone mode)', async () => {
    connection.connected = false;
    createCascadeBridge(connection, adapter as unknown as GitCascadeAdapter);
    adapter.emit(mkEvent('stream:created', { streamId: 's', name: 'n', agentId: 'a' }));
    await flushMicrotasks();
    expect(connection.calls).toHaveLength(0);
  });

  it('ignores events that have no MAP counterpart (e.g. worktree:created, mergeQueue:added)', async () => {
    createCascadeBridge(connection, adapter as unknown as GitCascadeAdapter);
    adapter.emit(mkEvent('worktree:created', { agentId: 'a' }));
    adapter.emit(mkEvent('mergeQueue:added', { streamId: 's' }));
    adapter.emit(mkEvent('task:started', { taskId: 't' }));
    await flushMicrotasks();
    expect(connection.calls).toHaveLength(0);
  });

  it('dispose() unsubscribes — no more forwarding after call', async () => {
    const disposable = createCascadeBridge(connection, adapter as unknown as GitCascadeAdapter);
    adapter.emit(mkEvent('stream:created', { streamId: 's1', name: 'x', agentId: 'a' }));
    await flushMicrotasks();
    expect(connection.calls).toHaveLength(1);

    disposable.dispose();

    adapter.emit(mkEvent('stream:created', { streamId: 's2', name: 'y', agentId: 'a' }));
    await flushMicrotasks();
    expect(connection.calls).toHaveLength(1);
  });

  it('swallows callExtension errors (does not throw or block the event loop)', async () => {
    const errConnection = createMockConnection();
    errConnection.callExtension = vi.fn().mockRejectedValue(new Error('hub broke'));
    createCascadeBridge(errConnection, adapter as unknown as GitCascadeAdapter);

    expect(() =>
      adapter.emit(
        mkEvent('stream:abandoned', { streamId: 's', reason: 'testing' })
      )
    ).not.toThrow();
    await flushMicrotasks();
    expect(errConnection.callExtension).toHaveBeenCalledTimes(1);
  });
});
