/**
 * AutoResolveStrategy integration tests.
 *
 * Creates a real merge conflict in a temp git repo and verifies the strategy
 * replays the merge with `ours`/`theirs` and commits the resolution.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import { AutoResolveStrategy } from '../auto-resolve.js';
import type { WorkspaceManager } from '../../types.js';
import type { ConflictContext } from '../types.js';

function mockWorkspaceManager(): WorkspaceManager {
  return {
    resolveConflict: vi.fn(),
  } as unknown as WorkspaceManager;
}

function sh(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' }).trim();
}

describe('AutoResolveStrategy (real git)', () => {
  let tempDir: string;
  let repoPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-resolve-'));
    repoPath = path.join(tempDir, 'repo');
    fs.mkdirSync(repoPath);

    sh('git init -b main', repoPath);
    sh('git config user.email "t@t.com"', repoPath);
    sh('git config user.name "T"', repoPath);

    // Base commit
    fs.writeFileSync(path.join(repoPath, 'f.txt'), 'base\n');
    sh('git add .', repoPath);
    sh('git commit -m "base"', repoPath);

    // Branch A (main) with change
    fs.writeFileSync(path.join(repoPath, 'f.txt'), 'main-change\n');
    sh('git add .', repoPath);
    sh('git commit -m "main change"', repoPath);

    // Branch B with conflicting change
    sh('git checkout -b feature HEAD~1', repoPath);
    fs.writeFileSync(path.join(repoPath, 'f.txt'), 'feature-change\n');
    sh('git add .', repoPath);
    sh('git commit -m "feature change"', repoPath);

    // Checkout main + attempt merge (conflicts)
    sh('git checkout main', repoPath);
    try {
      sh('git merge feature --no-edit', repoPath);
    } catch {
      // Expected — creates the conflict state
    }
    // Abort so AutoResolve starts from a clean state; it will re-trigger
    // the merge via `git merge -X <strategy>`.
    sh('git merge --abort', repoPath);
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('resolves with -X ours — keeps main-change', async () => {
    const strat = new AutoResolveStrategy();
    const ws = mockWorkspaceManager();

    const ctx: ConflictContext = {
      conflictId: 'c-test',
      streamId: 's-1',
      paths: ['f.txt'],
      operation: 'merge',
      worktree: repoPath,
      sourceCommit: 'feature',
      recoveryDepth: 0,
      strategyConfig: { strategy: 'ours' },
      workspaceManager: ws,
    };

    const result = await strat.recover(ctx);

    expect(result.kind).toBe('resolved');
    if (result.kind === 'resolved') {
      expect(result.resolutionCommit).toMatch(/^[0-9a-f]+$/);
    }

    // Verify file has the 'ours' version
    expect(fs.readFileSync(path.join(repoPath, 'f.txt'), 'utf-8')).toBe('main-change\n');

    // WorkspaceManager.resolveConflict was notified
    expect(ws.resolveConflict).toHaveBeenCalledWith(
      expect.objectContaining({ conflictId: 'c-test' })
    );
  });

  it('resolves with -X theirs — keeps feature-change', async () => {
    const strat = new AutoResolveStrategy();
    const ws = mockWorkspaceManager();

    const ctx: ConflictContext = {
      conflictId: 'c-test',
      streamId: 's-1',
      paths: ['f.txt'],
      operation: 'merge',
      worktree: repoPath,
      sourceCommit: 'feature',
      recoveryDepth: 0,
      strategyConfig: { strategy: 'theirs' },
      workspaceManager: ws,
    };

    const result = await strat.recover(ctx);

    expect(result.kind).toBe('resolved');
    expect(fs.readFileSync(path.join(repoPath, 'f.txt'), 'utf-8')).toBe('feature-change\n');
  });
});
