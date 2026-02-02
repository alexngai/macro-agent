/**
 * WorktreePool Tests
 *
 * Tests for the shared worktree pool implementation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import { WorktreePool } from '../worktree-pool.js';
import type { PoolEvent } from '../types.js';

describe('WorktreePool', () => {
  let tempDir: string;
  let repoPath: string;
  let worktreeBaseDir: string;
  let pool: WorktreePool | null = null;

  beforeEach(() => {
    // Create temp directory
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-pool-test-'));
    repoPath = path.join(tempDir, 'repo');
    worktreeBaseDir = path.join(tempDir, '.worktrees');
    fs.mkdirSync(repoPath);

    // Initialize git repo
    execSync('git init', { cwd: repoPath, stdio: 'pipe' });
    execSync('git config user.email "test@test.com"', {
      cwd: repoPath,
      stdio: 'pipe',
    });
    execSync('git config user.name "Test User"', {
      cwd: repoPath,
      stdio: 'pipe',
    });

    // Create initial commit
    fs.writeFileSync(path.join(repoPath, 'README.md'), '# Test Repo');
    execSync('git add .', { cwd: repoPath, stdio: 'pipe' });
    execSync('git commit -m "Initial commit"', { cwd: repoPath, stdio: 'pipe' });
  });

  afterEach(async () => {
    // Close pool if open
    if (pool) {
      await pool.close();
      pool = null;
    }

    // Clean up temp directory
    if (tempDir && fs.existsSync(tempDir)) {
      // Remove any worktrees first
      try {
        const worktrees = execSync('git worktree list --porcelain', {
          cwd: repoPath,
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        const lines = worktrees.split('\n');
        for (const line of lines) {
          if (line.startsWith('worktree ') && !line.includes(repoPath)) {
            const wtPath = line.substring('worktree '.length);
            if (fs.existsSync(wtPath)) {
              execSync(`git worktree remove --force "${wtPath}"`, {
                cwd: repoPath,
                stdio: 'pipe',
              });
            }
          }
        }
      } catch {
        // Ignore errors during cleanup
      }

      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('initialization', () => {
    it('should create a pool with default config', async () => {
      pool = new WorktreePool(repoPath, {
        worktreeBaseDir,
        maxSize: 5,
        recoverOrphans: false,
      });

      const stats = pool.getStats();
      expect(stats.totalSlots).toBe(0); // Not initialized yet (lazy)
    });

    it('should lazily initialize on first acquire', async () => {
      pool = new WorktreePool(repoPath, {
        worktreeBaseDir,
        maxSize: 5,
        recoverOrphans: false,
      });

      // Acquire triggers initialization
      const result = await pool.acquire({
        agentId: 'worker-1',
        role: 'worker',
      });

      expect(result.success).toBe(true);
      const stats = pool.getStats();
      expect(stats.totalSlots).toBe(5);
      expect(stats.allocatedSlots).toBe(1);
    });

    it('should emit pool:initialized event', async () => {
      pool = new WorktreePool(repoPath, {
        worktreeBaseDir,
        maxSize: 3,
        recoverOrphans: false,
      });

      const events: PoolEvent[] = [];
      pool.onEvent((e) => events.push(e));

      await pool.acquire({ agentId: 'worker-1', role: 'worker' });

      expect(events.some((e) => e.type === 'pool:initialized')).toBe(true);
    });
  });

  describe('acquire', () => {
    beforeEach(() => {
      pool = new WorktreePool(repoPath, {
        worktreeBaseDir,
        maxSize: 3,
        recoverOrphans: false,
        defaultStrategy: 'reject',
      });
    });

    it('should acquire a worktree successfully', async () => {
      const result = await pool!.acquire({
        agentId: 'worker-1',
        role: 'worker',
      });

      expect(result.success).toBe(true);
      expect(result.worktree).toBeDefined();
      expect(result.worktree!.state).toBe('allocated');
      expect(result.worktree!.allocatedTo).toBe('worker-1');
      expect(result.worktree!.allocatedRole).toBe('worker');
      expect(fs.existsSync(result.worktree!.path)).toBe(true);
    });

    it('should return the same worktree if agent already has one', async () => {
      const result1 = await pool!.acquire({
        agentId: 'worker-1',
        role: 'worker',
      });
      const result2 = await pool!.acquire({
        agentId: 'worker-1',
        role: 'worker',
      });

      expect(result1.worktree!.slotId).toBe(result2.worktree!.slotId);
    });

    it('should allocate different worktrees to different agents', async () => {
      const result1 = await pool!.acquire({
        agentId: 'worker-1',
        role: 'worker',
      });
      const result2 = await pool!.acquire({
        agentId: 'worker-2',
        role: 'worker',
      });

      expect(result1.worktree!.slotId).not.toBe(result2.worktree!.slotId);
    });

    it('should emit worktree:acquired event', async () => {
      const events: PoolEvent[] = [];
      pool!.onEvent((e) => events.push(e));

      await pool!.acquire({ agentId: 'worker-1', role: 'worker' });

      const acquiredEvent = events.find((e) => e.type === 'worktree:acquired');
      expect(acquiredEvent).toBeDefined();
      expect(acquiredEvent!.data.agentId).toBe('worker-1');
    });

    it('should respect preferredSlot when available', async () => {
      // First acquire to initialize pool
      await pool!.acquire({ agentId: 'worker-1', role: 'worker' });

      // Release it
      await pool!.release('worker-1');

      // Acquire with preferred slot
      const result = await pool!.acquire({
        agentId: 'worker-2',
        role: 'worker',
        preferredSlot: 'slot-01',
      });

      expect(result.success).toBe(true);
      expect(result.worktree!.slotId).toBe('slot-01');
    });
  });

  describe('release', () => {
    beforeEach(() => {
      pool = new WorktreePool(repoPath, {
        worktreeBaseDir,
        maxSize: 3,
        recoverOrphans: false,
      });
    });

    it('should release a worktree back to the pool', async () => {
      await pool!.acquire({ agentId: 'worker-1', role: 'worker' });
      await pool!.release('worker-1');

      const worktree = pool!.getWorktree('worker-1');
      expect(worktree).toBeNull();

      const stats = pool!.getStats();
      expect(stats.availableSlots).toBe(3);
      expect(stats.allocatedSlots).toBe(0);
    });

    it('should emit worktree:released event', async () => {
      await pool!.acquire({ agentId: 'worker-1', role: 'worker' });

      const events: PoolEvent[] = [];
      pool!.onEvent((e) => events.push(e));

      await pool!.release('worker-1');

      expect(events.some((e) => e.type === 'worktree:released')).toBe(true);
    });

    it('should clean the worktree when released', async () => {
      const result = await pool!.acquire({
        agentId: 'worker-1',
        role: 'worker',
      });
      const wtPath = result.worktree!.path;

      // Create a test file
      fs.writeFileSync(path.join(wtPath, 'test.txt'), 'test content');

      await pool!.release('worker-1', { clean: true });

      // File should be cleaned
      expect(fs.existsSync(path.join(wtPath, 'test.txt'))).toBe(false);
    });

    it('should skip cleaning when clean=false', async () => {
      const result = await pool!.acquire({
        agentId: 'worker-1',
        role: 'worker',
      });
      const wtPath = result.worktree!.path;

      // Stage a file
      fs.writeFileSync(path.join(wtPath, 'test.txt'), 'test content');
      execSync('git add test.txt', { cwd: wtPath, stdio: 'pipe' });

      // Release without cleaning - this would normally fail on uncommitted changes
      // but since we skip the check with force, it should work
      await pool!.release('worker-1', { clean: false, force: true });

      const stats = pool!.getStats();
      expect(stats.availableSlots).toBe(3);
    });

    it('should do nothing if agent has no worktree', async () => {
      await expect(pool!.release('unknown-agent')).resolves.toBeUndefined();
    });
  });

  describe('allocation strategies', () => {
    beforeEach(() => {
      pool = new WorktreePool(repoPath, {
        worktreeBaseDir,
        maxSize: 2,
        recoverOrphans: false,
        defaultStrategy: 'reject',
      });
    });

    it('should reject when pool is exhausted with reject strategy', async () => {
      await pool!.acquire({ agentId: 'worker-1', role: 'worker' });
      await pool!.acquire({ agentId: 'worker-2', role: 'worker' });

      const result = await pool!.acquire({
        agentId: 'worker-3',
        role: 'worker',
        strategy: 'reject',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Pool exhausted');
    });

    it('should emit pool:exhausted event when rejected', async () => {
      await pool!.acquire({ agentId: 'worker-1', role: 'worker' });
      await pool!.acquire({ agentId: 'worker-2', role: 'worker' });

      const events: PoolEvent[] = [];
      pool!.onEvent((e) => events.push(e));

      await pool!.acquire({
        agentId: 'worker-3',
        role: 'worker',
        strategy: 'reject',
      });

      expect(events.some((e) => e.type === 'pool:exhausted')).toBe(true);
    });

    it('should steal from oldest when using steal strategy', async () => {
      await pool!.acquire({ agentId: 'worker-1', role: 'worker' });
      // Small delay to ensure different timestamps
      await new Promise((r) => setTimeout(r, 10));
      await pool!.acquire({ agentId: 'worker-2', role: 'worker' });

      const result = await pool!.acquire({
        agentId: 'worker-3',
        role: 'worker',
        strategy: 'steal',
      });

      expect(result.success).toBe(true);
      expect(pool!.getWorktree('worker-1')).toBeNull(); // Should be stolen
      expect(pool!.getWorktree('worker-3')).not.toBeNull();
    });

    it('should queue and timeout with queue strategy', async () => {
      await pool!.acquire({ agentId: 'worker-1', role: 'worker' });
      await pool!.acquire({ agentId: 'worker-2', role: 'worker' });

      const result = await pool!.acquire({
        agentId: 'worker-3',
        role: 'worker',
        strategy: 'queue',
        timeout: 100,
      });

      expect(result.success).toBe(false);
      expect(result.queued).toBe(true);
      expect(result.error).toContain('timed out');
    });

    it('should process queue when worktree is released', async () => {
      await pool!.acquire({ agentId: 'worker-1', role: 'worker' });
      await pool!.acquire({ agentId: 'worker-2', role: 'worker' });

      // Start a queued request
      const queuePromise = pool!.acquire({
        agentId: 'worker-3',
        role: 'worker',
        strategy: 'queue',
        timeout: 5000,
      });

      // Release one
      await pool!.release('worker-1');

      // Queued request should succeed
      const result = await queuePromise;
      expect(result.success).toBe(true);
    });
  });

  describe('getStats', () => {
    beforeEach(() => {
      pool = new WorktreePool(repoPath, {
        worktreeBaseDir,
        maxSize: 5,
        recoverOrphans: false,
      });
    });

    it('should return accurate statistics', async () => {
      await pool!.acquire({ agentId: 'worker-1', role: 'worker' });
      await pool!.acquire({ agentId: 'integrator-1', role: 'integrator' });
      await pool!.acquire({ agentId: 'coordinator-1', role: 'coordinator' });

      const stats = pool!.getStats();

      expect(stats.totalSlots).toBe(5);
      expect(stats.availableSlots).toBe(2);
      expect(stats.allocatedSlots).toBe(3);
      expect(stats.byRole.worker).toBe(1);
      expect(stats.byRole.integrator).toBe(1);
      expect(stats.byRole.coordinator).toBe(1);
    });

    it('should update stats after release', async () => {
      await pool!.acquire({ agentId: 'worker-1', role: 'worker' });
      await pool!.release('worker-1');

      const stats = pool!.getStats();
      expect(stats.allocatedSlots).toBe(0);
      expect(stats.availableSlots).toBe(5);
    });
  });

  describe('getWorktree', () => {
    beforeEach(() => {
      pool = new WorktreePool(repoPath, {
        worktreeBaseDir,
        maxSize: 3,
        recoverOrphans: false,
      });
    });

    it('should return worktree for allocated agent', async () => {
      await pool!.acquire({ agentId: 'worker-1', role: 'worker' });

      const worktree = pool!.getWorktree('worker-1');
      expect(worktree).not.toBeNull();
      expect(worktree!.allocatedTo).toBe('worker-1');
    });

    it('should return null for unknown agent', async () => {
      await pool!.acquire({ agentId: 'worker-1', role: 'worker' });

      const worktree = pool!.getWorktree('unknown');
      expect(worktree).toBeNull();
    });
  });

  describe('themed names', () => {
    it('should use themed names when configured', async () => {
      pool = new WorktreePool(repoPath, {
        worktreeBaseDir,
        maxSize: 3,
        useThemedNames: true,
        recoverOrphans: false,
      });

      const result = await pool.acquire({
        agentId: 'worker-1',
        role: 'worker',
      });

      expect(result.worktree!.slotId).toBe('slot-alpha');
    });

    it('should use custom themed names when provided', async () => {
      pool = new WorktreePool(repoPath, {
        worktreeBaseDir,
        maxSize: 3,
        useThemedNames: true,
        themedNames: ['mercury', 'venus', 'earth'],
        recoverOrphans: false,
      });

      const result = await pool.acquire({
        agentId: 'worker-1',
        role: 'worker',
      });

      expect(result.worktree!.slotId).toBe('slot-mercury');
    });
  });

  describe('orphan recovery', () => {
    it('should recover orphaned worktrees on initialization', async () => {
      // Create a worktree manually (simulating an orphan)
      fs.mkdirSync(worktreeBaseDir, { recursive: true });
      execSync(`git worktree add --detach "${path.join(worktreeBaseDir, 'slot-01')}"`, {
        cwd: repoPath,
        stdio: 'pipe',
      });

      pool = new WorktreePool(repoPath, {
        worktreeBaseDir,
        maxSize: 3,
        recoverOrphans: true,
      });

      // Initialize by acquiring
      await pool.acquire({ agentId: 'worker-1', role: 'worker' });

      const stats = pool.getStats();
      // Should have all 3 slots available (1 is now allocated)
      expect(stats.totalSlots).toBe(3);
    });

    it('should emit pool:recovered event', async () => {
      // Create a worktree manually (simulating an orphan)
      fs.mkdirSync(worktreeBaseDir, { recursive: true });
      execSync(`git worktree add --detach "${path.join(worktreeBaseDir, 'slot-01')}"`, {
        cwd: repoPath,
        stdio: 'pipe',
      });

      pool = new WorktreePool(repoPath, {
        worktreeBaseDir,
        maxSize: 3,
        recoverOrphans: true,
      });

      const events: PoolEvent[] = [];
      pool.onEvent((e) => events.push(e));

      await pool.acquire({ agentId: 'worker-1', role: 'worker' });

      // Should have emitted recovery event
      expect(events.some((e) => e.type === 'pool:recovered')).toBe(true);
    });
  });

  describe('event subscription', () => {
    beforeEach(() => {
      pool = new WorktreePool(repoPath, {
        worktreeBaseDir,
        maxSize: 3,
        recoverOrphans: false,
      });
    });

    it('should allow subscribing to events', async () => {
      const events: PoolEvent[] = [];
      const unsubscribe = pool!.onEvent((e) => events.push(e));

      await pool!.acquire({ agentId: 'worker-1', role: 'worker' });

      expect(events.length).toBeGreaterThan(0);
      expect(typeof unsubscribe).toBe('function');
    });

    it('should allow unsubscribing', async () => {
      const events: PoolEvent[] = [];
      const unsubscribe = pool!.onEvent((e) => events.push(e));

      await pool!.acquire({ agentId: 'worker-1', role: 'worker' });
      const countBefore = events.length;

      unsubscribe();

      await pool!.acquire({ agentId: 'worker-2', role: 'worker' });
      expect(events.length).toBe(countBefore);
    });
  });

  describe('close', () => {
    it('should reject all queued requests on close', async () => {
      pool = new WorktreePool(repoPath, {
        worktreeBaseDir,
        maxSize: 1,
        recoverOrphans: false,
      });

      await pool.acquire({ agentId: 'worker-1', role: 'worker' });

      // Queue a request
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
    });

    it('should prevent further acquisitions after close', async () => {
      pool = new WorktreePool(repoPath, {
        worktreeBaseDir,
        maxSize: 3,
        recoverOrphans: false,
      });

      await pool.close();

      await expect(
        pool.acquire({ agentId: 'worker-1', role: 'worker' })
      ).rejects.toThrow('Pool is closed');
    });
  });
});
