/**
 * Cascade Diff Server — services `cascade/diff.request` notifications.
 *
 * The OpenHive hub fetches unified diffs from this runtime on demand. Flow:
 *
 *   1. Hub sends `cascade/diff.request` with `request_id`, `stream_id`,
 *      `head`, optional `base` / `file_paths` / `files_only`.
 *   2. This handler resolves a worktree path from the stream id (falling
 *      back to the bare repo when no live worktree is checked out on the
 *      stream), shells out to `git show` or `git diff`, and produces a
 *      unified diff blob (or a name-only list when `files_only: true`).
 *   3. Response is emitted as a `cascade/diff.response` notification —
 *      inline when ≤ 512 KB, streamed via N `cascade/diff.chunk`
 *      notifications when larger.
 *
 * The 50 MB raw cap (`MAX_DIFF_BYTES`) defends against runaway monorepo
 * diffs. Errors fold into the same `cascade/diff.response` method via the
 * `error` shape (mirrors trajectory/content.response).
 *
 * @module map/cascade-diff-server
 */

import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { existsSync } from 'fs';
import type { GitCascadeAdapter } from '../workspace/git-cascade-adapter.js';

const REQUEST_METHOD = 'cascade/diff.request';
const RESPONSE_METHOD = 'cascade/diff.response';
const CHUNK_METHOD = 'cascade/diff.chunk';

const INLINE_THRESHOLD_BYTES = 512 * 1024;
const CHUNK_SIZE_BYTES = 1024 * 1024;
const MAX_DIFF_BYTES = 50 * 1024 * 1024;
const GIT_TIMEOUT_MS = 30_000;

export interface CascadeDiffServerConnection {
  onNotification(
    method: string,
    handler: (params: unknown) => void | Promise<void>,
  ): void;
  offNotification(
    method: string,
    handler: (params: unknown) => void | Promise<void>,
  ): void;
  /** Send a JSON-RPC notification back to the hub. */
  sendNotification(method: string, params: Record<string, unknown>): void | Promise<void>;
}

export interface CascadeDiffRequestParams {
  request_id: string;
  stream_id: string;
  head: string;
  base?: string;
  file_paths?: string[];
  files_only?: boolean;
  format?: 'unified';
}

type DiffErrorCode =
  | 'not_found'
  | 'bad_request'
  | 'integrity_failed'
  | 'internal';

interface ProduceResult {
  blob: Buffer;
  filesTouched: string[];
  truncated: boolean;
}

/**
 * Register the cascade/diff.request handler on the connection.
 * Returns a cleanup function that removes the registration.
 */
export function setupCascadeDiffServer(
  connection: CascadeDiffServerConnection,
  adapter: GitCascadeAdapter,
): () => void {
  const handler = async (params: unknown): Promise<void> => {
    const req = params as CascadeDiffRequestParams | null;
    if (!req?.request_id || typeof req.request_id !== 'string') return;
    if (!req.stream_id || !req.head) {
      await sendError(
        connection,
        req.request_id,
        'bad_request',
        'missing stream_id or head',
      );
      return;
    }

    const workdir = resolveWorkdir(adapter, req.stream_id);
    if (!workdir) {
      await sendError(
        connection,
        req.request_id,
        'not_found',
        `no worktree or repo path for stream ${req.stream_id}`,
      );
      return;
    }

    let produced: ProduceResult;
    try {
      produced = await runGit({
        workdir,
        head: req.head,
        base: req.base,
        filePaths: req.file_paths,
        filesOnly: req.files_only === true,
      });
    } catch (err) {
      await sendError(
        connection,
        req.request_id,
        'internal',
        `git failed: ${(err as Error).message}`,
      );
      return;
    }

    if (produced.blob.length <= INLINE_THRESHOLD_BYTES) {
      await connection.sendNotification(RESPONSE_METHOD, {
        request_id: req.request_id,
        streaming: false,
        diff: produced.blob.toString('utf-8'),
        files_touched: produced.filesTouched,
        truncated: produced.truncated,
      });
      return;
    }

    await streamLargeBlob(
      connection,
      req.request_id,
      produced.blob,
      produced.filesTouched,
      produced.truncated,
    );
  };

  connection.onNotification(REQUEST_METHOD, handler);
  return () => {
    try {
      connection.offNotification(REQUEST_METHOD, handler);
    } catch {
      /* non-fatal */
    }
  };
}

// ============================================================================
// Worktree resolution
// ============================================================================

function resolveWorkdir(
  adapter: GitCascadeAdapter,
  streamId: string,
): string | null {
  // Prefer a live worktree currently checked out on this stream.
  try {
    const match = adapter
      .listWorktrees()
      .find((wt) => wt.currentStream === streamId);
    if (match?.path && existsSync(match.path)) return match.path;
  } catch {
    /* fall through to repo-path fallback */
  }

  // Fallback: bare repo path. `git show <sha>` works repo-wide.
  try {
    const repoPath = adapter.repoPath;
    if (repoPath && existsSync(repoPath)) return repoPath;
  } catch {
    /* fall through */
  }
  return null;
}

// ============================================================================
// Git shell-out
// ============================================================================

interface RunGitArgs {
  workdir: string;
  head: string;
  base?: string;
  filePaths?: string[];
  filesOnly: boolean;
}

async function runGit(args: RunGitArgs): Promise<ProduceResult> {
  const gitArgs = buildGitArgs(args);
  const buf = await spawnCapped(args.workdir, gitArgs);

  if (args.filesOnly) {
    const files = parseNameOnly(buf.data);
    return { blob: Buffer.from(''), filesTouched: files, truncated: buf.truncated };
  }

  // Extract files_touched from the diff blob headers. Cheap regex; the
  // sidecar can avoid a second git invocation.
  const files = extractFilesFromDiffHeaders(buf.data);
  return { blob: buf.data, filesTouched: files, truncated: buf.truncated };
}

function buildGitArgs(args: RunGitArgs): string[] {
  // --no-textconv: don't apply textconv filters (force raw bytes).
  // -U3: 3 lines of context (default unified-diff window).
  // --binary suppressed: default "Binary files differ" markers are fine.
  if (args.filesOnly) {
    if (args.base) {
      return ['diff', '--name-only', `${args.base}..${args.head}`, '--', ...(args.filePaths ?? [])];
    }
    return [
      'show',
      '--no-textconv',
      '--format=',
      '--name-only',
      args.head,
      '--',
      ...(args.filePaths ?? []),
    ];
  }
  if (args.base) {
    return [
      'diff',
      '--no-textconv',
      '-U3',
      `${args.base}..${args.head}`,
      '--',
      ...(args.filePaths ?? []),
    ];
  }
  return [
    'show',
    '--no-textconv',
    '-U3',
    '--format=',
    args.head,
    '--',
    ...(args.filePaths ?? []),
  ];
}

interface CappedSpawnResult {
  data: Buffer;
  truncated: boolean;
}

/**
 * Spawn git, capture stdout up to `MAX_DIFF_BYTES`. Beyond that, drain
 * the rest into /dev/null and mark `truncated: true`. Always returns
 * (no rejection on overflow); rejects only on spawn / non-zero exit.
 */
function spawnCapped(cwd: string, args: string[]): Promise<CappedSpawnResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const parts: Buffer[] = [];
    let total = 0;
    let truncated = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    let stderrBuf = '';

    proc.stdout.on('data', (chunk: Buffer) => {
      if (truncated) return;
      if (total + chunk.length > MAX_DIFF_BYTES) {
        const remaining = MAX_DIFF_BYTES - total;
        if (remaining > 0) parts.push(chunk.subarray(0, remaining));
        total = MAX_DIFF_BYTES;
        truncated = true;
        return;
      }
      parts.push(chunk);
      total += chunk.length;
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      // Cap stderr so a flood doesn't OOM us.
      if (stderrBuf.length < 8192) {
        stderrBuf += chunk.toString('utf-8');
      }
    });

    killTimer = setTimeout(() => {
      truncated = true;
      try { proc.kill('SIGKILL'); } catch { /* nothing to kill */ }
    }, GIT_TIMEOUT_MS);

    proc.on('error', (err) => {
      if (killTimer) clearTimeout(killTimer);
      reject(err);
    });

    proc.on('close', (code) => {
      if (killTimer) clearTimeout(killTimer);
      if (code !== 0 && !truncated) {
        reject(
          new Error(
            `git ${args.join(' ')} exited ${code}: ${stderrBuf.trim().slice(0, 200)}`,
          ),
        );
        return;
      }
      resolve({ data: Buffer.concat(parts), truncated });
    });
  });
}

// ============================================================================
// Output parsing
// ============================================================================

function parseNameOnly(buf: Buffer): string[] {
  return buf
    .toString('utf-8')
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Pull file paths out of `diff --git a/X b/Y` headers. Cheap heuristic;
 * collisions with file names containing spaces are accepted as a known
 * limitation (git escapes those with `"` anyway).
 */
function extractFilesFromDiffHeaders(buf: Buffer): string[] {
  const seen = new Set<string>();
  const text = buf.toString('utf-8');
  const regex = /^diff --git a\/(.+?) b\/(.+?)$/gm;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(text)) !== null) {
    // Use the b/ side — that's the post-image path.
    seen.add(m[2]);
  }
  return Array.from(seen);
}

// ============================================================================
// Streaming
// ============================================================================

async function streamLargeBlob(
  connection: CascadeDiffServerConnection,
  requestId: string,
  blob: Buffer,
  filesTouched: string[],
  truncated: boolean,
): Promise<void> {
  const chunkStreamId = `cdiff-${requestId}-${Date.now()}`;

  await connection.sendNotification(RESPONSE_METHOD, {
    request_id: requestId,
    streaming: true,
    chunk_stream_id: chunkStreamId,
    total_size: blob.length,
    files_touched: filesTouched,
  });

  const sha = createHash('sha256').update(blob).digest('hex');
  const totalChunks = Math.ceil(blob.length / CHUNK_SIZE_BYTES);

  for (let i = 0; i < totalChunks; i++) {
    const start = i * CHUNK_SIZE_BYTES;
    const end = Math.min(start + CHUNK_SIZE_BYTES, blob.length);
    const slice = blob.subarray(start, end);
    const isFinal = i === totalChunks - 1;
    await connection.sendNotification(CHUNK_METHOD, {
      chunk_stream_id: chunkStreamId,
      seq: i,
      data: slice.toString('base64'),
      ...(isFinal ? { final: true, sha256: sha, truncated } : {}),
    });
  }
}

async function sendError(
  connection: CascadeDiffServerConnection,
  requestId: string,
  code: DiffErrorCode,
  message: string,
): Promise<void> {
  await connection.sendNotification(RESPONSE_METHOD, {
    request_id: requestId,
    error: { code, message },
  });
}
