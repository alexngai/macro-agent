/**
 * Shared worktree ref-counting tests (Gap 3 fix).
 *
 * Verifies the fixed deallocateWorkspace behavior for shared worktrees:
 *  - Sharer deallocation decrements ref-count without tearing down the worktree.
 *  - Owner deallocation with active sharers defers teardown (ownerDeparted flag).
 *  - Teardown fires when the last sharer leaves after owner departed.
 *  - Normal (non-shared) teardown is unchanged.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import { createGitCascadeAdapter, type GitCascadeAdapter } from '../git-cascade-adapter.js';
import {
  DefaultWorkspaceManager,
  createWorkspaceManagerWithAdapter,
} from '../workspace-manager.js';

describe('shared worktree ref-counting', () => {
  let tempDir: string;
  let repoPath: string;
  let adapter: GitCascadeAdapter;
  let manager: DefaultWorkspaceManager;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'refcount-'));
    repoPath = path.join(tempDir, 'repo');
    fs.mkdirSync(repoPath);

    execSync('git init -b main', { cwd: repoPath, stdio: 'pipe' });
    execSync('git config user.email "t@t.com"', { cwd: repoPath, stdio: 'pipe' });
    execSync('git config user.name "T"', { cwd: repoPath, stdio: 'pipe' });
    fs.writeFileSync(path.join(repoPath, 'README.md'), '# Test');
    execSync('git add .', { cwd: repoPath, stdio: 'pipe' });
    execSync('git commit -m "init"', { cwd: repoPath, stdio: 'pipe' });

    adapter = createGitCascadeAdapter({
      enabled: true,
      repoPath,
      dbPath: path.join(tempDir, 'db.sqlite'),
      skipRecovery: true,
    });
    manager = createWorkspaceManagerWithAdapter(adapter, {
      worktreeBaseDir: path.join(tempDir, 'worktrees'),
    }) as DefaultWorkspaceManager;
  });

  afterEach(() => {
    manager.close();
    adapter.close();
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('sharer deallocation decrements refs without touching the worktree', () => {
    const streamId = manager.createStreamV3({ name: 's1', ownerId: 'owner-A' });
    const owner = manager.allocateWorktree({ agentId: 'owner-A', streamId });
    manager.allocateWorktree({ agentId: 'sharer-B', sharedWithAgent: 'owner-A' });
    manager.allocateWorktree({ agentId: 'sharer-C', sharedWithAgent: 'owner-A' });

    // Owner's worktree exists on disk
    expect(fs.existsSync(owner.path)).toBe(true);

    // Deallocate one sharer
    manager.deallocateWorkspace('sharer-B');
    expect(fs.existsSync(owner.path)).toBe(true);

    // Owner's adapter record untouched
    expect(adapter.getWorktree('owner-A')).not.toBeNull();
  });

  it('owner deallocation with active sharers defers teardown', () => {
    const streamId = manager.createStreamV3({ name: 's1', ownerId: 'owner-A' });
    const owner = manager.allocateWorktree({ agentId: 'owner-A', streamId });
    manager.allocateWorktree({ agentId: 'sharer-B', sharedWithAgent: 'owner-A' });

    const events: Array<{ type: string }> = [];
    manager.onEvent((e) => events.push(e));

    manager.deallocateWorkspace('owner-A');

    // Path still exists — teardown deferred
    expect(fs.existsSync(owner.path)).toBe(true);
    // git-cascade still thinks owner-A has a worktree (deferred state)
    expect(adapter.getWorktree('owner-A')).not.toBeNull();

    // Released event fired with kind=owner-departed
    const released = events.find((e) => e.type === 'worktree:released');
    expect(released).toBeDefined();
    expect((released as { data?: { kind?: string } }).data?.kind).toBe('owner-departed');
  });

  it('last sharer leaving after owner departed finalizes teardown', () => {
    const streamId = manager.createStreamV3({ name: 's1', ownerId: 'owner-A' });
    const owner = manager.allocateWorktree({ agentId: 'owner-A', streamId });
    manager.allocateWorktree({ agentId: 'sharer-B', sharedWithAgent: 'owner-A' });

    manager.deallocateWorkspace('owner-A');
    // Still deferred
    expect(fs.existsSync(owner.path)).toBe(true);

    manager.deallocateWorkspace('sharer-B');
    // Now actually torn down
    expect(fs.existsSync(owner.path)).toBe(false);
    expect(adapter.getWorktree('owner-A')).toBeNull();
  });

  it('rejects allocation after owner departed with no sharers', () => {
    const streamId = manager.createStreamV3({ name: 's1', ownerId: 'owner-A' });
    manager.allocateWorktree({ agentId: 'owner-A', streamId });
    manager.allocateWorktree({ agentId: 'sharer-B', sharedWithAgent: 'owner-A' });

    manager.deallocateWorkspace('owner-A'); // owner departs (sharer-B still alive)
    manager.deallocateWorkspace('sharer-B'); // last sharer leaves — torn down

    // Now try to share again — owner is gone
    expect(() =>
      manager.allocateWorktree({ agentId: 'late-C', sharedWithAgent: 'owner-A' })
    ).toThrow();
  });

  it('non-shared worktree teardown is unchanged', () => {
    const streamId = manager.createStreamV3({ name: 's1', ownerId: 'lone-A' });
    const wt = manager.allocateWorktree({ agentId: 'lone-A', streamId });
    expect(fs.existsSync(wt.path)).toBe(true);

    manager.deallocateWorkspace('lone-A');
    expect(fs.existsSync(wt.path)).toBe(false);
    expect(adapter.getWorktree('lone-A')).toBeNull();
  });

  it('multiple sharers coexist; dealloc order does not matter', () => {
    const streamId = manager.createStreamV3({ name: 's1', ownerId: 'owner-A' });
    const owner = manager.allocateWorktree({ agentId: 'owner-A', streamId });
    manager.allocateWorktree({ agentId: 'sharer-B', sharedWithAgent: 'owner-A' });
    manager.allocateWorktree({ agentId: 'sharer-C', sharedWithAgent: 'owner-A' });
    manager.allocateWorktree({ agentId: 'sharer-D', sharedWithAgent: 'owner-A' });

    // Dealloc in a scrambled order: owner first, then sharers
    manager.deallocateWorkspace('owner-A');
    expect(fs.existsSync(owner.path)).toBe(true);

    manager.deallocateWorkspace('sharer-C');
    expect(fs.existsSync(owner.path)).toBe(true);

    manager.deallocateWorkspace('sharer-D');
    expect(fs.existsSync(owner.path)).toBe(true);

    manager.deallocateWorkspace('sharer-B'); // last sharer
    expect(fs.existsSync(owner.path)).toBe(false);
  });
});
