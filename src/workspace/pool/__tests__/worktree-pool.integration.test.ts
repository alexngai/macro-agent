/**
 * Worktree Pool Integration Tests
 *
 * Comprehensive integration tests that exercise the full worktree pool
 * functionality with real git operations including:
 * - Actual worktree creation and deletion
 * - All allocation strategies (reject, queue, steal)
 * - Orphan recovery with real orphaned worktrees
 * - Pool integration with WorkspaceManager
 * - Concurrent operations
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import Database from 'better-sqlite3';
import { WorktreePool } from '../worktree-pool.js';
import { createWorkspaceManager, DefaultWorkspaceManager } from '../../workspace-manager.js';
import { createDataplaneAdapter, DataplaneAdapter } from '../../dataplane-adapter.js';
import type { PoolEvent, PoolStats } from '../types.js';
import type { WorkerWorkspace, IntegratorWorkspace, CoordinatorWorkspace } from '../../types.js';

describe('WorktreePool Integration', () => {
  let tempDir: string;
  let repoPath: string;
  let worktreeBaseDir: string;
  let dbPath: string;

  /**
   * Helper to run git commands
   */
  function git(args: string, cwd: string = repoPath): string {
    return execSync(`git ${args}`, { cwd, stdio: 'pipe', encoding: 'utf8' }).trim();
  }

  /**
   * Helper to list all worktrees
   * Uses realpath to handle macOS /var -> /private/var symlink
   */
  function listWorktrees(): string[] {
    return git('worktree list --porcelain')
      .split('\n')
      .filter((line) => line.startsWith('worktree '))
      .map((line) => {
        const wtPath = line.replace('worktree ', '');
        try {
          return fs.realpathSync(wtPath);
        } catch {
          return wtPath;
        }
      });
  }

  /**
   * Helper to normalize path for comparison (handles macOS symlinks)
   */
  function normalizePath(p: string): string {
    try {
      return fs.realpathSync(p);
    } catch {
      return p;
    }
  }

  /**
   * Helper to get current branch in a worktree
   */
  function getCurrentBranch(cwd: string): string {
    try {
      return git('rev-parse --abbrev-ref HEAD', cwd);
    } catch {
      return 'HEAD'; // Detached
    }
  }

  /**
   * Helper to check if worktree has uncommitted changes
   */
  function hasUncommittedChanges(cwd: string): boolean {
    const status = git('status --porcelain', cwd);
    return status.length > 0;
  }

  /**
   * Helper to cleanup all worktrees before removing temp dir
   */
  function cleanupWorktrees(): void {
    if (!repoPath || !fs.existsSync(repoPath)) return;

    try {
      const worktrees = listWorktrees().filter((wt) => wt !== repoPath);
      for (const wt of worktrees) {
        try {
          execSync(`git worktree remove --force "${wt}"`, {
            cwd: repoPath,
            stdio: 'pipe',
          });
        } catch {
          // Ignore errors
        }
      }
    } catch {
      // Ignore errors
    }
  }

  beforeEach(() => {
    // Create temp directory
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-integration-test-'));
    repoPath = path.join(tempDir, 'repo');
    worktreeBaseDir = path.join(tempDir, '.worktrees');
    dbPath = path.join(tempDir, 'test.db');
    fs.mkdirSync(repoPath);

    // Initialize git repo
    git('init');
    git('config user.email "test@test.com"');
    git('config user.name "Test User"');

    // Create initial commit with some files
    fs.writeFileSync(path.join(repoPath, 'README.md'), '# Test Project\n');
    fs.mkdirSync(path.join(repoPath, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repoPath, 'src/index.ts'), 'export const version = "1.0.0";\n');
    git('add .');
    git('commit -m "Initial commit"');
  });

  afterEach(() => {
    cleanupWorktrees();

    // Clean up temp directory
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Real Worktree Operations
  // ═══════════════════════════════════════════════════════════════════════════

  describe('real worktree creation', () => {
    it('should create actual git worktrees on acquire', async () => {
      const pool = new WorktreePool(repoPath, {
        worktreeBaseDir,
        maxSize: 3,
        recoverOrphans: false,
      });

      try {
        const result = await pool.acquire({
          agentId: 'worker-1',
          role: 'worker',
        });

        expect(result.success).toBe(true);
        expect(result.worktree).toBeDefined();

        // Verify the worktree was actually created
        const wtPath = result.worktree!.path;
        expect(fs.existsSync(wtPath)).toBe(true);
        expect(fs.existsSync(path.join(wtPath, '.git'))).toBe(true);

        // Verify git recognizes it as a worktree
        const worktrees = listWorktrees();
        expect(worktrees).toContain(normalizePath(wtPath));

        // Verify the repo files are present
        expect(fs.existsSync(path.join(wtPath, 'README.md'))).toBe(true);
        expect(fs.existsSync(path.join(wtPath, 'src/index.ts'))).toBe(true);
      } finally {
        await pool.close();
      }
    });

    it('should create worktrees with detached HEAD', async () => {
      const pool = new WorktreePool(repoPath, {
        worktreeBaseDir,
        maxSize: 3,
        recoverOrphans: false,
      });

      try {
        const result = await pool.acquire({
          agentId: 'worker-1',
          role: 'worker',
        });

        const branch = getCurrentBranch(result.worktree!.path);
        expect(branch).toBe('HEAD'); // Detached HEAD
      } finally {
        await pool.close();
      }
    });

    it('should allow file operations in worktrees', async () => {
      const pool = new WorktreePool(repoPath, {
        worktreeBaseDir,
        maxSize: 3,
        recoverOrphans: false,
      });

      try {
        const result = await pool.acquire({
          agentId: 'worker-1',
          role: 'worker',
        });

        const wtPath = result.worktree!.path;

        // Write a file
        fs.writeFileSync(path.join(wtPath, 'new-file.ts'), 'export const test = true;');

        // Verify it exists
        expect(fs.existsSync(path.join(wtPath, 'new-file.ts'))).toBe(true);

        // Stage and commit
        git('add .', wtPath);
        git('commit -m "Add test file"', wtPath);

        // Verify commit
        const log = git('log --oneline -1', wtPath);
        expect(log).toContain('Add test file');
      } finally {
        await pool.close();
      }
    });

    it('should create multiple independent worktrees', async () => {
      const pool = new WorktreePool(repoPath, {
        worktreeBaseDir,
        maxSize: 5,
        recoverOrphans: false,
      });

      try {
        const result1 = await pool.acquire({ agentId: 'worker-1', role: 'worker' });
        const result2 = await pool.acquire({ agentId: 'worker-2', role: 'worker' });
        const result3 = await pool.acquire({ agentId: 'worker-3', role: 'worker' });

        // All should succeed
        expect(result1.success).toBe(true);
        expect(result2.success).toBe(true);
        expect(result3.success).toBe(true);

        // All paths should be different
        const paths = [
          result1.worktree!.path,
          result2.worktree!.path,
          result3.worktree!.path,
        ];
        expect(new Set(paths).size).toBe(3);

        // Write different files to each
        fs.writeFileSync(path.join(paths[0], 'worker1.txt'), 'worker 1');
        fs.writeFileSync(path.join(paths[1], 'worker2.txt'), 'worker 2');
        fs.writeFileSync(path.join(paths[2], 'worker3.txt'), 'worker 3');

        // Verify isolation - each only sees its own file
        expect(fs.existsSync(path.join(paths[0], 'worker1.txt'))).toBe(true);
        expect(fs.existsSync(path.join(paths[0], 'worker2.txt'))).toBe(false);
        expect(fs.existsSync(path.join(paths[0], 'worker3.txt'))).toBe(false);

        expect(fs.existsSync(path.join(paths[1], 'worker1.txt'))).toBe(false);
        expect(fs.existsSync(path.join(paths[1], 'worker2.txt'))).toBe(true);
        expect(fs.existsSync(path.join(paths[1], 'worker3.txt'))).toBe(false);
      } finally {
        await pool.close();
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Release and Cleanup
  // ═══════════════════════════════════════════════════════════════════════════

  describe('release and cleanup', () => {
    it('should clean worktree state on release', async () => {
      const pool = new WorktreePool(repoPath, {
        worktreeBaseDir,
        maxSize: 3,
        recoverOrphans: false,
      });

      try {
        const result = await pool.acquire({ agentId: 'worker-1', role: 'worker' });
        const wtPath = result.worktree!.path;

        // Create uncommitted changes
        fs.writeFileSync(path.join(wtPath, 'dirty.txt'), 'dirty content');
        git('add dirty.txt', wtPath);

        // Verify dirty state
        expect(hasUncommittedChanges(wtPath)).toBe(true);

        // Release with clean
        await pool.release('worker-1', { clean: true, force: true });

        // Verify worktree is cleaned
        expect(hasUncommittedChanges(wtPath)).toBe(false);
        expect(fs.existsSync(path.join(wtPath, 'dirty.txt'))).toBe(false);
      } finally {
        await pool.close();
      }
    });

    it('should reuse worktree after release', async () => {
      const pool = new WorktreePool(repoPath, {
        worktreeBaseDir,
        maxSize: 2,
        recoverOrphans: false,
      });

      try {
        // Acquire both slots
        const result1 = await pool.acquire({ agentId: 'worker-1', role: 'worker' });
        await pool.acquire({ agentId: 'worker-2', role: 'worker' });

        const originalPath = result1.worktree!.path;
        const originalSlotId = result1.worktree!.slotId;

        // Release first worker
        await pool.release('worker-1');

        // Acquire with new agent - should get the released slot
        const result3 = await pool.acquire({
          agentId: 'worker-3',
          role: 'worker',
          preferredSlot: originalSlotId,
        });

        // Should reuse the same worktree path
        expect(result3.success).toBe(true);
        expect(result3.worktree!.path).toBe(originalPath);
        expect(result3.worktree!.slotId).toBe(originalSlotId);
      } finally {
        await pool.close();
      }
    });

    it('should persist worktree directory after release (for reuse)', async () => {
      const pool = new WorktreePool(repoPath, {
        worktreeBaseDir,
        maxSize: 3,
        recoverOrphans: false,
      });

      try {
        const result = await pool.acquire({ agentId: 'worker-1', role: 'worker' });
        const wtPath = result.worktree!.path;

        await pool.release('worker-1');

        // Worktree directory should still exist (for reuse)
        expect(fs.existsSync(wtPath)).toBe(true);

        // But it should be available for re-acquisition
        const stats = pool.getStats();
        expect(stats.availableSlots).toBe(3);
      } finally {
        await pool.close();
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Allocation Strategies
  // ═══════════════════════════════════════════════════════════════════════════

  describe('allocation strategies', () => {
    describe('reject strategy', () => {
      it('should reject immediately when pool is full', async () => {
        const pool = new WorktreePool(repoPath, {
          worktreeBaseDir,
          maxSize: 2,
          recoverOrphans: false,
          defaultStrategy: 'reject',
        });

        try {
          await pool.acquire({ agentId: 'worker-1', role: 'worker' });
          await pool.acquire({ agentId: 'worker-2', role: 'worker' });

          const result = await pool.acquire({
            agentId: 'worker-3',
            role: 'worker',
            strategy: 'reject',
          });

          expect(result.success).toBe(false);
          expect(result.error).toContain('Pool exhausted');
        } finally {
          await pool.close();
        }
      });

      it('should emit pool:exhausted event on reject', async () => {
        const pool = new WorktreePool(repoPath, {
          worktreeBaseDir,
          maxSize: 1,
          recoverOrphans: false,
        });

        const events: PoolEvent[] = [];
        pool.onEvent((e) => events.push(e));

        try {
          await pool.acquire({ agentId: 'worker-1', role: 'worker' });
          await pool.acquire({
            agentId: 'worker-2',
            role: 'worker',
            strategy: 'reject',
          });

          const exhaustedEvent = events.find((e) => e.type === 'pool:exhausted');
          expect(exhaustedEvent).toBeDefined();
          expect(exhaustedEvent!.data.strategy).toBe('reject');
        } finally {
          await pool.close();
        }
      });
    });

    describe('queue strategy', () => {
      it('should wait and succeed when slot becomes available', async () => {
        const pool = new WorktreePool(repoPath, {
          worktreeBaseDir,
          maxSize: 1,
          recoverOrphans: false,
        });

        try {
          await pool.acquire({ agentId: 'worker-1', role: 'worker' });

          // Start waiting for a slot
          const queuePromise = pool.acquire({
            agentId: 'worker-2',
            role: 'worker',
            strategy: 'queue',
            timeout: 5000,
          });

          // Release after a short delay
          setTimeout(() => {
            pool.release('worker-1');
          }, 100);

          const result = await queuePromise;
          expect(result.success).toBe(true);
          expect(result.worktree!.allocatedTo).toBe('worker-2');
        } finally {
          await pool.close();
        }
      });

      it('should timeout when no slot becomes available', async () => {
        const pool = new WorktreePool(repoPath, {
          worktreeBaseDir,
          maxSize: 1,
          recoverOrphans: false,
        });

        try {
          await pool.acquire({ agentId: 'worker-1', role: 'worker' });

          const result = await pool.acquire({
            agentId: 'worker-2',
            role: 'worker',
            strategy: 'queue',
            timeout: 100,
          });

          expect(result.success).toBe(false);
          expect(result.queued).toBe(true);
          expect(result.error).toContain('timed out');
        } finally {
          await pool.close();
        }
      });

      it('should process queue in FIFO order', async () => {
        const pool = new WorktreePool(repoPath, {
          worktreeBaseDir,
          maxSize: 1,
          recoverOrphans: false,
        });

        try {
          await pool.acquire({ agentId: 'worker-1', role: 'worker' });

          const queue2 = pool.acquire({
            agentId: 'worker-2',
            role: 'worker',
            strategy: 'queue',
            timeout: 5000,
          });

          const queue3 = pool.acquire({
            agentId: 'worker-3',
            role: 'worker',
            strategy: 'queue',
            timeout: 5000,
          });

          // Release worker-1
          await pool.release('worker-1');

          const result2 = await queue2;
          expect(result2.success).toBe(true);
          expect(result2.worktree!.allocatedTo).toBe('worker-2');

          // Release worker-2 for worker-3
          await pool.release('worker-2');

          const result3 = await queue3;
          expect(result3.success).toBe(true);
          expect(result3.worktree!.allocatedTo).toBe('worker-3');
        } finally {
          await pool.close();
        }
      });
    });

    describe('steal strategy', () => {
      it('should steal from oldest allocation', async () => {
        const pool = new WorktreePool(repoPath, {
          worktreeBaseDir,
          maxSize: 2,
          recoverOrphans: false,
        });

        try {
          // Acquire in order with delay
          await pool.acquire({ agentId: 'worker-1', role: 'worker' });
          await new Promise((r) => setTimeout(r, 50));
          await pool.acquire({ agentId: 'worker-2', role: 'worker' });

          // Steal
          const result = await pool.acquire({
            agentId: 'worker-3',
            role: 'worker',
            strategy: 'steal',
          });

          expect(result.success).toBe(true);

          // worker-1 should have been evicted (oldest)
          expect(pool.getWorktree('worker-1')).toBeNull();
          expect(pool.getWorktree('worker-2')).not.toBeNull();
          expect(pool.getWorktree('worker-3')).not.toBeNull();
        } finally {
          await pool.close();
        }
      });

      it('should clean stolen worktree before reallocation', async () => {
        const pool = new WorktreePool(repoPath, {
          worktreeBaseDir,
          maxSize: 1,
          recoverOrphans: false,
        });

        try {
          const result1 = await pool.acquire({ agentId: 'worker-1', role: 'worker' });
          const wtPath = result1.worktree!.path;

          // Create dirty state
          fs.writeFileSync(path.join(wtPath, 'dirty.txt'), 'dirty');
          git('add dirty.txt', wtPath);

          // Steal
          const result2 = await pool.acquire({
            agentId: 'worker-2',
            role: 'worker',
            strategy: 'steal',
          });

          expect(result2.success).toBe(true);

          // Should be clean
          expect(fs.existsSync(path.join(wtPath, 'dirty.txt'))).toBe(false);
          expect(hasUncommittedChanges(wtPath)).toBe(false);
        } finally {
          await pool.close();
        }
      });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Orphan Recovery
  // ═══════════════════════════════════════════════════════════════════════════

  describe('orphan recovery', () => {
    it('should recover orphaned worktrees on initialization', async () => {
      // Create orphaned worktrees manually
      fs.mkdirSync(worktreeBaseDir, { recursive: true });

      const orphan1Path = path.join(worktreeBaseDir, 'slot-01');
      const orphan2Path = path.join(worktreeBaseDir, 'slot-02');

      git(`worktree add --detach "${orphan1Path}"`);
      git(`worktree add --detach "${orphan2Path}"`);

      // Verify orphans exist
      const worktreesBefore = listWorktrees();
      expect(worktreesBefore).toContain(normalizePath(orphan1Path));
      expect(worktreesBefore).toContain(normalizePath(orphan2Path));

      // Create pool with recovery enabled
      const pool = new WorktreePool(repoPath, {
        worktreeBaseDir,
        maxSize: 3,
        recoverOrphans: true,
      });

      const events: PoolEvent[] = [];
      pool.onEvent((e) => events.push(e));

      try {
        // Trigger initialization by acquiring
        await pool.acquire({ agentId: 'worker-1', role: 'worker' });

        // Should have recovered the orphans
        const recoveryEvent = events.find((e) => e.type === 'pool:recovered');
        expect(recoveryEvent).toBeDefined();
        expect(recoveryEvent!.data.orphansFound).toBeGreaterThan(0);

        // Orphan slots should now be available
        const stats = pool.getStats();
        expect(stats.totalSlots).toBe(3);
        expect(stats.allocatedSlots).toBe(1); // Only worker-1
        expect(stats.availableSlots).toBe(2);
      } finally {
        await pool.close();
      }
    });

    it('should remove unknown orphaned worktrees', async () => {
      // Create an orphaned worktree with unknown slot name
      fs.mkdirSync(worktreeBaseDir, { recursive: true });
      const unknownPath = path.join(worktreeBaseDir, 'unknown-orphan');
      git(`worktree add --detach "${unknownPath}"`);

      const pool = new WorktreePool(repoPath, {
        worktreeBaseDir,
        maxSize: 3,
        recoverOrphans: true,
      });

      try {
        await pool.acquire({ agentId: 'worker-1', role: 'worker' });

        // Unknown orphan should be removed
        const worktreesAfter = listWorktrees();
        expect(worktreesAfter).not.toContain(unknownPath);
      } finally {
        await pool.close();
      }
    });

    it('should recover manually via recoverOrphans()', async () => {
      // Create pool without auto-recovery
      const pool = new WorktreePool(repoPath, {
        worktreeBaseDir,
        maxSize: 3,
        recoverOrphans: false,
      });

      try {
        // Acquire to initialize
        await pool.acquire({ agentId: 'worker-1', role: 'worker' });
        const slot1Path = pool.getWorktree('worker-1')!.path;

        // Release it
        await pool.release('worker-1');

        // Now there's an "orphan" - a slot with existing worktree but no allocation
        const result = await pool.recoverOrphans();

        // Should have found and cleaned the orphan
        expect(result.orphansFound).toBeGreaterThan(0);
        expect(result.orphansCleaned).toBeGreaterThan(0);
      } finally {
        await pool.close();
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // WorkspaceManager Integration
  // ═══════════════════════════════════════════════════════════════════════════

  describe('WorkspaceManager integration', () => {
    let db: Database.Database;
    let adapter: DataplaneAdapter;
    let manager: DefaultWorkspaceManager;

    beforeEach(() => {
      db = new Database(dbPath);
      adapter = createDataplaneAdapter({
        enabled: true,
        repoPath,
        db,
        skipRecovery: true,
      });
    });

    afterEach(async () => {
      if (manager) {
        await manager.closeAsync();
      }
      if (adapter) {
        adapter.close();
      }
      if (db) {
        db.close();
      }
    });

    it('should create WorkspaceManager with pool enabled', () => {
      manager = createWorkspaceManager({
        enabled: true,
        repoPath,
        db,
        skipRecovery: true,
        worktreeBaseDir,
        pool: {
          enabled: true,
          maxSize: 5,
          defaultStrategy: 'reject',
        },
      });

      expect(manager.isPoolEnabled()).toBe(true);
      expect(manager.getPool()).not.toBeNull();
    });

    it('should create worker workspace from pool', async () => {
      manager = createWorkspaceManager({
        enabled: true,
        repoPath,
        db,
        skipRecovery: true,
        worktreeBaseDir,
        pool: {
          enabled: true,
          maxSize: 5,
        },
      });

      const coordinatorId = 'coordinator-1';
      const streamId = manager.createIntegrationStream(coordinatorId, {
        name: 'feature/pool-test',
      });

      const taskId = manager.createTask(streamId, { title: 'Test task' });

      const workspace = await manager.createWorkerWorkspaceFromPool(
        'worker-1',
        taskId,
        streamId
      );

      expect(workspace).toBeDefined();
      expect(workspace.role).toBe('worker');
      expect(workspace.agentId).toBe('worker-1');
      expect(fs.existsSync(workspace.path)).toBe(true);

      // Verify pool stats
      const poolStats = manager.getPool()!.getStats();
      expect(poolStats.allocatedSlots).toBe(1);
      expect(poolStats.byRole.worker).toBe(1);
    });

    it('should create integrator workspace from pool', async () => {
      manager = createWorkspaceManager({
        enabled: true,
        repoPath,
        db,
        skipRecovery: true,
        worktreeBaseDir,
        pool: {
          enabled: true,
          maxSize: 5,
        },
      });

      const coordinatorId = 'coordinator-1';
      const streamId = manager.createIntegrationStream(coordinatorId, {
        name: 'feature/integrator-pool',
      });

      const workspace = await manager.createIntegratorWorkspaceFromPool(
        'integrator-1',
        streamId
      ) as IntegratorWorkspace;

      expect(workspace).toBeDefined();
      expect(workspace.role).toBe('integrator');
      expect(workspace.coordinatorId).toBe(coordinatorId);
      expect(fs.existsSync(workspace.path)).toBe(true);

      const poolStats = manager.getPool()!.getStats();
      expect(poolStats.byRole.integrator).toBe(1);
    });

    it('should create coordinator workspace from pool', async () => {
      manager = createWorkspaceManager({
        enabled: true,
        repoPath,
        db,
        skipRecovery: true,
        worktreeBaseDir,
        pool: {
          enabled: true,
          maxSize: 5,
        },
      });

      const coordinatorId = 'coordinator-1';
      const streamId = manager.createIntegrationStream(coordinatorId, {
        name: 'feature/coordinator-pool',
      });

      const workspace = await manager.createCoordinatorWorkspaceFromPool(
        coordinatorId,
        streamId
      ) as CoordinatorWorkspace;

      expect(workspace).toBeDefined();
      expect(workspace.role).toBe('coordinator');
      expect(fs.existsSync(workspace.path)).toBe(true);

      const poolStats = manager.getPool()!.getStats();
      expect(poolStats.byRole.coordinator).toBe(1);
    });

    it('should release workspace back to pool on deallocateAsync', async () => {
      manager = createWorkspaceManager({
        enabled: true,
        repoPath,
        db,
        skipRecovery: true,
        worktreeBaseDir,
        pool: {
          enabled: true,
          maxSize: 5,
        },
      });

      const coordinatorId = 'coordinator-1';
      const streamId = manager.createIntegrationStream(coordinatorId, {
        name: 'feature/dealloc-pool',
      });

      const taskId = manager.createTask(streamId, { title: 'Test task' });
      await manager.createWorkerWorkspaceFromPool('worker-1', taskId, streamId);

      // Verify allocated
      let poolStats = manager.getPool()!.getStats();
      expect(poolStats.allocatedSlots).toBe(1);

      // Deallocate
      await manager.deallocateWorkspaceAsync('worker-1');

      // Verify released
      poolStats = manager.getPool()!.getStats();
      expect(poolStats.allocatedSlots).toBe(0);
      expect(poolStats.availableSlots).toBe(5);
      expect(manager.getWorkspace('worker-1')).toBeNull();
    });

    it('should handle pool exhaustion with reject strategy', async () => {
      manager = createWorkspaceManager({
        enabled: true,
        repoPath,
        db,
        skipRecovery: true,
        worktreeBaseDir,
        pool: {
          enabled: true,
          maxSize: 2,
          defaultStrategy: 'reject',
        },
      });

      const coordinatorId = 'coordinator-1';
      const streamId = manager.createIntegrationStream(coordinatorId, {
        name: 'feature/exhaustion',
      });

      const task1Id = manager.createTask(streamId, { title: 'Task 1' });
      const task2Id = manager.createTask(streamId, { title: 'Task 2' });
      const task3Id = manager.createTask(streamId, { title: 'Task 3' });

      await manager.createWorkerWorkspaceFromPool('worker-1', task1Id, streamId);
      await manager.createWorkerWorkspaceFromPool('worker-2', task2Id, streamId);

      // Third should fail
      await expect(
        manager.createWorkerWorkspaceFromPool('worker-3', task3Id, streamId)
      ).rejects.toThrow('Pool exhausted');
    });

    it('should fall back to non-pooled allocation when pool disabled', async () => {
      manager = createWorkspaceManager({
        enabled: true,
        repoPath,
        db,
        skipRecovery: true,
        worktreeBaseDir,
        pool: {
          enabled: false, // Pool disabled
        },
      });

      expect(manager.isPoolEnabled()).toBe(false);
      expect(manager.getPool()).toBeNull();

      const coordinatorId = 'coordinator-1';
      const streamId = manager.createIntegrationStream(coordinatorId, {
        name: 'feature/no-pool',
      });

      const taskId = manager.createTask(streamId, { title: 'Task' });

      // Should fall back to regular non-pooled creation
      const workspace = await manager.createWorkerWorkspaceFromPool(
        'worker-1',
        taskId,
        streamId
      );

      expect(workspace).toBeDefined();
      expect(fs.existsSync(workspace.path)).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Full Lifecycle with Pool
  // ═══════════════════════════════════════════════════════════════════════════

  describe('full lifecycle with pool', () => {
    let db: Database.Database;
    let adapter: DataplaneAdapter;
    let manager: DefaultWorkspaceManager;

    beforeEach(() => {
      db = new Database(dbPath);
      adapter = createDataplaneAdapter({
        enabled: true,
        repoPath,
        db,
        skipRecovery: true,
      });
      manager = createWorkspaceManager({
        enabled: true,
        repoPath,
        db,
        skipRecovery: true,
        worktreeBaseDir,
        pool: {
          enabled: true,
          maxSize: 10,
          defaultStrategy: 'reject',
          recoverOrphans: true,
        },
      });
    });

    afterEach(async () => {
      if (manager) {
        await manager.closeAsync();
      }
      if (adapter) {
        adapter.close();
      }
      if (db) {
        db.close();
      }
    });

    it('should complete full workflow: create → work → merge → cleanup', async () => {
      // ═══════════════════════════════════════════════════════════════════════
      // Phase 1: Setup stream and tasks
      // ═══════════════════════════════════════════════════════════════════════
      const coordinatorId = 'coordinator-001';
      const streamId = manager.createIntegrationStream(coordinatorId, {
        name: 'feature/full-lifecycle-pool',
      });

      const task1Id = manager.createTask(streamId, { title: 'Implement feature A' });
      const task2Id = manager.createTask(streamId, { title: 'Implement feature B' });

      // ═══════════════════════════════════════════════════════════════════════
      // Phase 2: Create workers from pool
      // ═══════════════════════════════════════════════════════════════════════
      const worker1Workspace = await manager.createWorkerWorkspaceFromPool(
        'worker-1',
        task1Id,
        streamId
      );

      const worker2Workspace = await manager.createWorkerWorkspaceFromPool(
        'worker-2',
        task2Id,
        streamId
      );

      // Verify pool stats
      let poolStats = manager.getPool()!.getStats();
      expect(poolStats.allocatedSlots).toBe(2);
      expect(poolStats.byRole.worker).toBe(2);

      // ═══════════════════════════════════════════════════════════════════════
      // Phase 3: Workers claim tasks and make changes
      // ═══════════════════════════════════════════════════════════════════════
      const start1 = manager.claimTask(task1Id, 'worker-1', worker1Workspace.path);
      const start2 = manager.claimTask(task2Id, 'worker-2', worker2Workspace.path);

      // Worker 1 makes changes
      fs.writeFileSync(
        path.join(worker1Workspace.path, 'src/featureA.ts'),
        'export const featureA = true;'
      );
      git('add .', worker1Workspace.path);
      git('commit -m "feat: implement feature A"', worker1Workspace.path);

      // Worker 2 makes changes
      fs.writeFileSync(
        path.join(worker2Workspace.path, 'src/featureB.ts'),
        'export const featureB = true;'
      );
      git('add .', worker2Workspace.path);
      git('commit -m "feat: implement feature B"', worker2Workspace.path);

      // ═══════════════════════════════════════════════════════════════════════
      // Phase 4: Release workers back to pool
      // ═══════════════════════════════════════════════════════════════════════
      await manager.deallocateWorkspaceAsync('worker-1');
      await manager.deallocateWorkspaceAsync('worker-2');

      poolStats = manager.getPool()!.getStats();
      expect(poolStats.allocatedSlots).toBe(0);
      expect(poolStats.availableSlots).toBe(10);

      // ═══════════════════════════════════════════════════════════════════════
      // Phase 5: Create integrator from pool to merge
      // ═══════════════════════════════════════════════════════════════════════
      const integratorWorkspace = await manager.createIntegratorWorkspaceFromPool(
        'integrator-1',
        streamId
      );

      poolStats = manager.getPool()!.getStats();
      expect(poolStats.allocatedSlots).toBe(1);
      expect(poolStats.byRole.integrator).toBe(1);

      // Complete tasks (merge worker branches)
      adapter.completeTask({ taskId: task1Id, worktree: integratorWorkspace.path });
      adapter.completeTask({ taskId: task2Id, worktree: integratorWorkspace.path });

      // Verify both features are in the integration branch
      const files = git('ls-tree -r HEAD --name-only', integratorWorkspace.path).split('\n');
      expect(files).toContain('src/featureA.ts');
      expect(files).toContain('src/featureB.ts');

      // ═══════════════════════════════════════════════════════════════════════
      // Phase 6: Cleanup
      // ═══════════════════════════════════════════════════════════════════════
      await manager.deallocateWorkspaceAsync('integrator-1');

      poolStats = manager.getPool()!.getStats();
      expect(poolStats.allocatedSlots).toBe(0);
      expect(poolStats.availableSlots).toBe(10);

      // Clean up worker branches
      const cleanupResult = manager.cleanupWorkerBranches({ olderThanMs: 0 });
      expect(cleanupResult.deleted.length).toBe(2);
    });

    it('should handle concurrent workers efficiently with pool', async () => {
      const coordinatorId = 'coordinator-001';
      const streamId = manager.createIntegrationStream(coordinatorId, {
        name: 'feature/concurrent-pool',
      });

      const workerCount = 5;
      const taskIds: string[] = [];
      for (let i = 0; i < workerCount; i++) {
        taskIds.push(manager.createTask(streamId, { title: `Task ${i}` }));
      }

      // Create all workers concurrently from pool
      const workerPromises = taskIds.map(async (taskId, i) => {
        const workspace = await manager.createWorkerWorkspaceFromPool(
          `worker-${i}`,
          taskId,
          streamId
        );
        return { id: `worker-${i}`, workspace };
      });

      const workers = await Promise.all(workerPromises);

      // Verify all workers have unique paths
      const paths = workers.map((w) => w.workspace.path);
      expect(new Set(paths).size).toBe(workerCount);

      // Verify pool stats
      const poolStats = manager.getPool()!.getStats();
      expect(poolStats.allocatedSlots).toBe(workerCount);
      expect(poolStats.byRole.worker).toBe(workerCount);

      // Release all workers
      for (const worker of workers) {
        await manager.deallocateWorkspaceAsync(worker.id);
      }

      // Verify all released
      const finalStats = manager.getPool()!.getStats();
      expect(finalStats.allocatedSlots).toBe(0);
    });

    it('should emit correct events throughout lifecycle', async () => {
      const events: PoolEvent[] = [];
      manager.getPool()!.onEvent((e) => events.push(e));

      const coordinatorId = 'coordinator-001';
      const streamId = manager.createIntegrationStream(coordinatorId, {
        name: 'feature/events-pool',
      });

      const taskId = manager.createTask(streamId, { title: 'Task' });

      // Acquire
      await manager.createWorkerWorkspaceFromPool('worker-1', taskId, streamId);

      // Release
      await manager.deallocateWorkspaceAsync('worker-1');

      // Check events
      const eventTypes = events.map((e) => e.type);
      expect(eventTypes).toContain('pool:initialized');
      expect(eventTypes).toContain('worktree:acquired');
      expect(eventTypes).toContain('worktree:released');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Edge Cases and Error Handling
  // ═══════════════════════════════════════════════════════════════════════════

  describe('edge cases', () => {
    it('should handle close with pending queue requests', async () => {
      const pool = new WorktreePool(repoPath, {
        worktreeBaseDir,
        maxSize: 1,
        recoverOrphans: false,
      });

      try {
        await pool.acquire({ agentId: 'worker-1', role: 'worker' });

        // Start a queued request
        const queuePromise = pool.acquire({
          agentId: 'worker-2',
          role: 'worker',
          strategy: 'queue',
          timeout: 60000,
        });

        // Wait for the queue request to be added (needs microtask to complete)
        await new Promise((resolve) => setImmediate(resolve));

        // Close the pool
        await pool.close();

        // Queued request should be rejected
        await expect(queuePromise).rejects.toThrow('Pool is closing');
      } catch {
        await pool.close();
      }
    });

    it('should prevent operations after close', async () => {
      const pool = new WorktreePool(repoPath, {
        worktreeBaseDir,
        maxSize: 3,
        recoverOrphans: false,
      });

      await pool.close();

      await expect(
        pool.acquire({ agentId: 'worker-1', role: 'worker' })
      ).rejects.toThrow('Pool is closed');
    });

    it('should handle release of unknown agent gracefully', async () => {
      const pool = new WorktreePool(repoPath, {
        worktreeBaseDir,
        maxSize: 3,
        recoverOrphans: false,
      });

      try {
        // Initialize pool
        await pool.acquire({ agentId: 'worker-1', role: 'worker' });

        // Release unknown agent - should not throw
        await expect(pool.release('unknown-agent')).resolves.toBeUndefined();
      } finally {
        await pool.close();
      }
    });

    it('should handle getWorktree for unknown agent', async () => {
      const pool = new WorktreePool(repoPath, {
        worktreeBaseDir,
        maxSize: 3,
        recoverOrphans: false,
      });

      try {
        await pool.acquire({ agentId: 'worker-1', role: 'worker' });

        const worktree = pool.getWorktree('unknown');
        expect(worktree).toBeNull();
      } finally {
        await pool.close();
      }
    });

    it('should correctly track stats through various operations', async () => {
      const pool = new WorktreePool(repoPath, {
        worktreeBaseDir,
        maxSize: 5,
        recoverOrphans: false,
      });

      try {
        // Initial stats (after first acquire initializes)
        await pool.acquire({ agentId: 'worker-1', role: 'worker' });
        let stats = pool.getStats();
        expect(stats.totalSlots).toBe(5);
        expect(stats.allocatedSlots).toBe(1);
        expect(stats.availableSlots).toBe(4);

        // Add more
        await pool.acquire({ agentId: 'integrator-1', role: 'integrator' });
        await pool.acquire({ agentId: 'coordinator-1', role: 'coordinator' });

        stats = pool.getStats();
        expect(stats.allocatedSlots).toBe(3);
        expect(stats.availableSlots).toBe(2);
        expect(stats.byRole.worker).toBe(1);
        expect(stats.byRole.integrator).toBe(1);
        expect(stats.byRole.coordinator).toBe(1);

        // Release some
        await pool.release('worker-1');
        stats = pool.getStats();
        expect(stats.allocatedSlots).toBe(2);
        expect(stats.availableSlots).toBe(3);
        expect(stats.byRole.worker).toBe(0);

        // Release all
        await pool.release('integrator-1');
        await pool.release('coordinator-1');
        stats = pool.getStats();
        expect(stats.allocatedSlots).toBe(0);
        expect(stats.availableSlots).toBe(5);
      } finally {
        await pool.close();
      }
    });
  });
});
