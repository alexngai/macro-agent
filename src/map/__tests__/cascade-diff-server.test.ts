/**
 * Tests for the macro-agent side of the cascade diff protocol — shells out
 * to real git on a temp repo, captures the resulting JSON-RPC notifications
 * on a mock connection, and asserts the inline / streaming / error paths.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import { createHash } from 'crypto';
import {
  setupCascadeDiffServer,
  type CascadeDiffServerConnection,
} from '../cascade-diff-server.js';
import {
  createGitCascadeAdapter,
  type GitCascadeAdapter,
} from '../../workspace/git-cascade-adapter.js';

interface SentNotification {
  method: string;
  params: Record<string, unknown>;
}

interface MockConnection extends CascadeDiffServerConnection {
  sent: SentNotification[];
  handlers: Map<string, (params: unknown) => void | Promise<void>>;
  /** Test-only helper — invoke the registered handler from outside. */
  fire(method: string, params: unknown): Promise<void>;
}

function createMockConnection(): MockConnection {
  const sent: SentNotification[] = [];
  const handlers = new Map<string, (params: unknown) => void | Promise<void>>();
  return {
    sent,
    handlers,
    onNotification(method, handler) {
      handlers.set(method, handler);
    },
    offNotification(method) {
      handlers.delete(method);
    },
    async sendNotification(method, params) {
      sent.push({ method, params });
    },
    async fire(method, params) {
      const h = handlers.get(method);
      if (h) await h(params);
    },
  };
}

/**
 * Build a minimal GitCascadeAdapter stub. Only repoPath + listWorktrees
 * are exercised by the diff server. Cast to GitCascadeAdapter for the
 * interface surface.
 */
function mkAdapter(opts: {
  repoPath: string;
  worktrees?: Array<{ path: string; currentStream: string }>;
}): GitCascadeAdapter {
  return {
    get repoPath() {
      return opts.repoPath;
    },
    listWorktrees() {
      return opts.worktrees ?? [];
    },
  } as unknown as GitCascadeAdapter;
}

function shell(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    .toString('utf-8')
    .trim();
}

describe('cascade-diff-server', () => {
  let tempDir: string;
  let repoPath: string;
  let commitA: string;
  let commitB: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-diff-server-'));
    repoPath = path.join(tempDir, 'repo');
    fs.mkdirSync(repoPath);

    shell('git init -q', repoPath);
    shell('git config user.email "test@test.com"', repoPath);
    shell('git config user.name "Test"', repoPath);
    shell('git config commit.gpgsign false', repoPath);

    fs.writeFileSync(path.join(repoPath, 'a.txt'), 'one\n');
    shell('git add .', repoPath);
    shell('git commit -q -m initial', repoPath);
    commitA = shell('git rev-parse HEAD', repoPath);

    fs.writeFileSync(path.join(repoPath, 'a.txt'), 'one\ntwo\n');
    fs.writeFileSync(path.join(repoPath, 'b.txt'), 'new file\n');
    shell('git add .', repoPath);
    shell('git commit -q -m second', repoPath);
    commitB = shell('git rev-parse HEAD', repoPath);
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('returns an inline response for a small single-commit diff', async () => {
    const conn = createMockConnection();
    const adapter = mkAdapter({ repoPath });
    setupCascadeDiffServer(conn, adapter);

    await conn.fire('cascade/diff.request', {
      request_id: 'req-1',
      stream_id: 'doesnt-matter',
      head: commitB,
      format: 'unified',
    });

    expect(conn.sent).toHaveLength(1);
    const note = conn.sent[0];
    expect(note.method).toBe('cascade/diff.response');
    const p = note.params as {
      request_id: string;
      streaming: boolean;
      diff: string;
      files_touched: string[];
      truncated: boolean;
    };
    expect(p.request_id).toBe('req-1');
    expect(p.streaming).toBe(false);
    expect(p.diff).toContain('diff --git a/a.txt');
    expect(p.diff).toContain('diff --git a/b.txt');
    expect(p.files_touched.sort()).toEqual(['a.txt', 'b.txt']);
    expect(p.truncated).toBe(false);
  });

  it('respects files_only and returns name-only output with empty blob', async () => {
    const conn = createMockConnection();
    const adapter = mkAdapter({ repoPath });
    setupCascadeDiffServer(conn, adapter);

    await conn.fire('cascade/diff.request', {
      request_id: 'req-files-only',
      stream_id: 'x',
      head: commitB,
      files_only: true,
      format: 'unified',
    });

    expect(conn.sent).toHaveLength(1);
    const p = conn.sent[0].params as {
      streaming: boolean;
      diff: string;
      files_touched: string[];
    };
    expect(p.streaming).toBe(false);
    expect(p.diff).toBe('');
    expect(p.files_touched.sort()).toEqual(['a.txt', 'b.txt']);
  });

  it('produces a range diff when base is set', async () => {
    const conn = createMockConnection();
    const adapter = mkAdapter({ repoPath });
    setupCascadeDiffServer(conn, adapter);

    await conn.fire('cascade/diff.request', {
      request_id: 'req-range',
      stream_id: 'x',
      base: commitA,
      head: commitB,
      format: 'unified',
    });

    const p = conn.sent[0].params as {
      diff: string;
      files_touched: string[];
    };
    // a.txt went 'one\n' → 'one\ntwo\n' (pure addition, no removed line)
    expect(p.diff).toContain('+two');
    expect(p.diff).toContain('+new file');
    expect(p.files_touched.sort()).toEqual(['a.txt', 'b.txt']);
  });

  it('prefers a live worktree on the stream over the bare repo', async () => {
    // Create a fake "worktree" path that's a sibling git checkout. For
    // this test we reuse repoPath since we just want to verify the
    // resolver picks the worktree when present.
    const conn = createMockConnection();
    const adapter = mkAdapter({
      repoPath: '/should/not/be/used',
      worktrees: [{ path: repoPath, currentStream: 'stream-1' }],
    });
    setupCascadeDiffServer(conn, adapter);

    await conn.fire('cascade/diff.request', {
      request_id: 'req-wt',
      stream_id: 'stream-1',
      head: commitB,
      format: 'unified',
    });

    const note = conn.sent[0];
    expect(note.method).toBe('cascade/diff.response');
    expect((note.params as { error?: unknown }).error).toBeUndefined();
  });

  it('falls back to repo path when no worktree matches the stream', async () => {
    const conn = createMockConnection();
    const adapter = mkAdapter({
      repoPath,
      worktrees: [{ path: '/elsewhere', currentStream: 'other-stream' }],
    });
    setupCascadeDiffServer(conn, adapter);

    await conn.fire('cascade/diff.request', {
      request_id: 'req-fallback',
      stream_id: 'stream-not-in-list',
      head: commitB,
      format: 'unified',
    });

    expect(conn.sent).toHaveLength(1);
    expect((conn.sent[0].params as { error?: unknown }).error).toBeUndefined();
  });

  it('returns not_found error when no worktree and no repo path exists', async () => {
    const conn = createMockConnection();
    const adapter = mkAdapter({
      repoPath: '/definitely/does/not/exist/xyzzy',
      worktrees: [],
    });
    setupCascadeDiffServer(conn, adapter);

    await conn.fire('cascade/diff.request', {
      request_id: 'req-404',
      stream_id: 'whatever',
      head: commitB,
      format: 'unified',
    });

    expect(conn.sent).toHaveLength(1);
    const p = conn.sent[0].params as {
      error?: { code: string; message: string };
    };
    expect(p.error?.code).toBe('not_found');
  });

  it('returns bad_request error when head is missing', async () => {
    const conn = createMockConnection();
    const adapter = mkAdapter({ repoPath });
    setupCascadeDiffServer(conn, adapter);

    await conn.fire('cascade/diff.request', {
      request_id: 'req-bad',
      stream_id: 'x',
      // head missing
    });

    expect(conn.sent).toHaveLength(1);
    const p = conn.sent[0].params as { error?: { code: string } };
    expect(p.error?.code).toBe('bad_request');
  });

  it('returns internal error when git fails (unknown SHA)', async () => {
    const conn = createMockConnection();
    const adapter = mkAdapter({ repoPath });
    setupCascadeDiffServer(conn, adapter);

    await conn.fire('cascade/diff.request', {
      request_id: 'req-bad-sha',
      stream_id: 'x',
      head: '0'.repeat(40),
      format: 'unified',
    });

    expect(conn.sent).toHaveLength(1);
    const p = conn.sent[0].params as { error?: { code: string } };
    expect(p.error?.code).toBe('internal');
  });

  it('streams large diffs as chunks with correct sha256', async () => {
    // Build a >512 KB diff by writing a big file in commit C.
    const big = 'x'.repeat(600 * 1024) + '\n';
    fs.writeFileSync(path.join(repoPath, 'big.txt'), big);
    shell('git add .', repoPath);
    shell('git commit -q -m big', repoPath);
    const commitC = shell('git rev-parse HEAD', repoPath);

    const conn = createMockConnection();
    const adapter = mkAdapter({ repoPath });
    setupCascadeDiffServer(conn, adapter);

    await conn.fire('cascade/diff.request', {
      request_id: 'req-stream',
      stream_id: 'x',
      head: commitC,
      format: 'unified',
    });

    // Expect one response notification + N chunk notifications.
    expect(conn.sent.length).toBeGreaterThan(1);
    const head = conn.sent[0];
    expect(head.method).toBe('cascade/diff.response');
    const headParams = head.params as {
      streaming: boolean;
      chunk_stream_id: string;
      total_size: number;
      files_touched: string[];
    };
    expect(headParams.streaming).toBe(true);
    expect(headParams.total_size).toBeGreaterThan(512 * 1024);
    expect(headParams.files_touched).toContain('big.txt');

    const chunks = conn.sent.slice(1);
    for (const c of chunks) expect(c.method).toBe('cascade/diff.chunk');

    // Reassemble + verify sha against the final chunk's announced hash.
    const parts: Buffer[] = [];
    let finalSha: string | undefined;
    let finalTruncated: boolean | undefined;
    for (const c of chunks) {
      const cp = c.params as {
        chunk_stream_id: string;
        seq: number;
        data: string;
        final?: boolean;
        sha256?: string;
        truncated?: boolean;
      };
      expect(cp.chunk_stream_id).toBe(headParams.chunk_stream_id);
      parts[cp.seq] = Buffer.from(cp.data, 'base64');
      if (cp.final) {
        finalSha = cp.sha256;
        finalTruncated = cp.truncated;
      }
    }
    const reassembled = Buffer.concat(parts);
    expect(reassembled.length).toBe(headParams.total_size);
    expect(createHash('sha256').update(reassembled).digest('hex')).toBe(finalSha);
    expect(finalTruncated).toBe(false);
  }, 30_000);

  it('cleanup() unregisters the handler', async () => {
    const conn = createMockConnection();
    const adapter = mkAdapter({ repoPath });
    const cleanup = setupCascadeDiffServer(conn, adapter);
    expect(conn.handlers.has('cascade/diff.request')).toBe(true);
    cleanup();
    expect(conn.handlers.has('cascade/diff.request')).toBe(false);
  });

  it('ignores malformed requests without a request_id', async () => {
    const conn = createMockConnection();
    const adapter = mkAdapter({ repoPath });
    setupCascadeDiffServer(conn, adapter);

    await conn.fire('cascade/diff.request', { stream_id: 'x', head: commitB });
    expect(conn.sent).toHaveLength(0);
  });

  // ── Real GitCascadeAdapter integration ─────────────────────────────
  //
  // The tests above use a hand-rolled `mkAdapter` that just satisfies the
  // two surface methods (`repoPath`, `listWorktrees`). This integration
  // test wires the actual `createGitCascadeAdapter` from the workspace
  // layer to verify the diff server doesn't depend on stub-only behavior.

  describe('with a real GitCascadeAdapter instance', () => {
    let realAdapter: GitCascadeAdapter | null = null;

    afterEach(() => {
      if (realAdapter) {
        try { realAdapter.close(); } catch { /* nothing-to-close is fine */ }
        realAdapter = null;
      }
    });

    it('serves diff from the real adapter\'s repoPath when no worktree matches', async () => {
      realAdapter = createGitCascadeAdapter({
        enabled: true,
        repoPath,
        dbPath: path.join(tempDir, 'real-adapter.db'),
        skipRecovery: true,
      });

      const conn = createMockConnection();
      setupCascadeDiffServer(conn, realAdapter);

      await conn.fire('cascade/diff.request', {
        request_id: 'req-real-1',
        stream_id: 'no-such-stream', // no worktree → repoPath fallback
        head: commitB,
        format: 'unified',
      });

      expect(conn.sent).toHaveLength(1);
      const p = conn.sent[0].params as {
        streaming: boolean;
        diff: string;
        files_touched: string[];
      };
      expect(p.streaming).toBe(false);
      expect(p.diff).toContain('diff --git a/a.txt');
      expect(p.files_touched.sort()).toEqual(['a.txt', 'b.txt']);
    });

    it('exposes repoPath that matches the configured path', () => {
      realAdapter = createGitCascadeAdapter({
        enabled: true,
        repoPath,
        dbPath: path.join(tempDir, 'real-adapter-2.db'),
        skipRecovery: true,
      });

      // The diff server reads adapter.repoPath as the fallback. Confirm
      // the real adapter exposes the same shape we stub.
      expect(realAdapter.repoPath).toBe(repoPath);
      expect(Array.isArray(realAdapter.listWorktrees())).toBe(true);
    });
  });
});

// Reference vi to keep ESM tree-shake from removing the import; spawn(child_process)
// in the module under test produces no output we need to mock, but vitest's
// hooks rely on the namespace being present.
expect(typeof vi).toBe('object');
