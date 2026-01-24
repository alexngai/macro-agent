/**
 * Workspace E2E Tests
 *
 * Comprehensive end-to-end tests for the workspace isolation flow including:
 * - Full lifecycle: coordinator → tasks → workers → merge queue → integration
 * - Parallel workers with merge queue ordering
 * - Conflict detection and handling
 * - Cleanup of worktrees and worker branches
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import { createWorkspaceManager, DefaultWorkspaceManager } from '../workspace-manager.js';
import { createDataplaneAdapter, DataplaneAdapter } from '../dataplane-adapter.js';
import { createMergeQueue, MergeQueue } from '../merge-queue/index.js';
import Database from 'better-sqlite3';
import type { WorkerWorkspace, IntegratorWorkspace, CoordinatorWorkspace } from '../types.js';

describe('Workspace E2E', () => {
  let tempDir: string;
  let repoPath: string;
  let dbPath: string;
  let db: Database.Database;
  let adapter: DataplaneAdapter;
  let manager: DefaultWorkspaceManager;
  let mergeQueue: MergeQueue;

  /**
   * Helper to run git commands in the repo
   */
  function git(args: string, cwd: string = repoPath): string {
    return execSync(`git ${args}`, { cwd, stdio: 'pipe', encoding: 'utf8' }).trim();
  }

  /**
   * Helper to write a file and commit it
   */
  function writeAndCommit(
    filePath: string,
    content: string,
    message: string,
    cwd: string = repoPath
  ): string {
    const fullPath = path.join(cwd, filePath);
    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(fullPath, content);
    git('add .', cwd);
    git(`commit -m "${message}"`, cwd);
    return git('rev-parse HEAD', cwd);
  }

  /**
   * Helper to get list of branches
   */
  function listBranches(): string[] {
    return git('branch --list')
      .split('\n')
      .map((b) => b.trim().replace(/^\* /, ''))
      .filter(Boolean);
  }

  /**
   * Helper to get list of worktrees
   */
  function listWorktrees(): string[] {
    return git('worktree list --porcelain')
      .split('\n')
      .filter((line) => line.startsWith('worktree '))
      .map((line) => line.replace('worktree ', ''));
  }

  beforeEach(() => {
    // Create temp directory
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-e2e-test-'));
    repoPath = path.join(tempDir, 'repo');
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

    // Create shared database
    db = new Database(dbPath);

    // Create adapter
    adapter = createDataplaneAdapter({
      enabled: true,
      repoPath,
      db,
      skipRecovery: true,
    });

    // Create workspace manager
    manager = new DefaultWorkspaceManager(adapter, {
      worktreeBaseDir: path.join(tempDir, '.worktrees'),
    });

    // Create merge queue
    mergeQueue = createMergeQueue({ db });
  });

  afterEach(() => {
    // Close resources first
    try {
      mergeQueue?.close();
    } catch { /* ignore */ }
    try {
      manager?.close();
    } catch { /* ignore */ }
    try {
      adapter?.close();
    } catch { /* ignore */ }
    try {
      db?.close();
    } catch { /* ignore */ }

    // Remove all worktrees before deleting temp directory
    // This prevents dangling worktree references
    if (repoPath && fs.existsSync(repoPath)) {
      try {
        const worktreeList = execSync('git worktree list --porcelain', {
          cwd: repoPath,
          encoding: 'utf8',
          stdio: 'pipe',
        });
        const worktrees = worktreeList
          .split('\n')
          .filter((line) => line.startsWith('worktree '))
          .map((line) => line.replace('worktree ', ''))
          .filter((wt) => wt !== repoPath); // Don't remove main repo

        for (const wt of worktrees) {
          try {
            execSync(`git worktree remove --force "${wt}"`, {
              cwd: repoPath,
              stdio: 'pipe',
            });
          } catch { /* ignore */ }
        }
      } catch { /* ignore */ }
    }

    // Clean up temp directory
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('full lifecycle', () => {
    it('should complete the full coordinator → worker → merge → cleanup flow', () => {
      // ═══════════════════════════════════════════════════════════════════════
      // Phase 1: Coordinator creates integration stream and tasks
      // ═══════════════════════════════════════════════════════════════════════
      const coordinatorId = 'coordinator-001';
      const streamId = manager.createIntegrationStream(coordinatorId, {
        name: 'feature/user-auth',
      });

      expect(streamId).toBeDefined();
      expect(manager.getStream(streamId)).not.toBeNull();

      // Create tasks for workers
      const task1Id = manager.createTask(streamId, {
        title: 'Implement login API',
        priority: 10,
      });
      const task2Id = manager.createTask(streamId, {
        title: 'Implement logout API',
        priority: 20,
      });

      expect(task1Id).toBeDefined();
      expect(task2Id).toBeDefined();

      // ═══════════════════════════════════════════════════════════════════════
      // Phase 2: Workers create workspaces and claim tasks
      // ═══════════════════════════════════════════════════════════════════════
      // Use sufficiently different IDs so the 8-char truncation creates unique paths
      const worker1Id = 'worker-alpha-001';
      const worker2Id = 'worker-beta-002';

      // Worker 1 creates workspace and claims higher priority task
      const worker1Workspace = manager.createWorkerWorkspace(
        worker1Id,
        task1Id,
        streamId
      ) as WorkerWorkspace;

      expect(worker1Workspace.role).toBe('worker');
      expect(worker1Workspace.taskId).toBe(task1Id);
      expect(fs.existsSync(worker1Workspace.path)).toBe(true);

      // Worker 1 claims the task (creates worker branch)
      const startResult1 = manager.claimTask(task1Id, worker1Id, worker1Workspace.path);
      expect(startResult1.branchName).toMatch(/^worker\/worker-alpha-001\//);

      // Worker 2 creates workspace and claims next task
      const worker2Workspace = manager.createWorkerWorkspace(
        worker2Id,
        task2Id,
        streamId
      ) as WorkerWorkspace;

      const startResult2 = manager.claimTask(task2Id, worker2Id, worker2Workspace.path);
      expect(startResult2.branchName).toMatch(/^worker\/worker-beta-002\//);

      // Verify worker branches exist in the repo
      const branches = git('branch --list worker/*').split('\n').filter(Boolean);
      expect(branches.length).toBe(2);

      // ═══════════════════════════════════════════════════════════════════════
      // Phase 3: Workers make changes and commit
      // ═══════════════════════════════════════════════════════════════════════

      // Worker 1 implements login
      writeAndCommit(
        'src/auth/login.ts',
        'export function login(user: string, pass: string) { return true; }',
        'feat: implement login API',
        worker1Workspace.path
      );

      // Worker 2 implements logout
      writeAndCommit(
        'src/auth/logout.ts',
        'export function logout() { return true; }',
        'feat: implement logout API',
        worker2Workspace.path
      );

      // ═══════════════════════════════════════════════════════════════════════
      // Phase 4: Workers submit to merge queue
      // ═══════════════════════════════════════════════════════════════════════

      // Get updated task info
      const task1 = adapter.getTask(task1Id)!;
      const task2 = adapter.getTask(task2Id)!;

      // Submit both to merge queue
      const mr1Id = mergeQueue.submit({
        streamId,
        taskId: task1Id,
        workerBranch: task1.branchName!,
        workerAgentId: worker1Id,
        priority: 10,
      });

      const mr2Id = mergeQueue.submit({
        streamId,
        taskId: task2Id,
        workerBranch: task2.branchName!,
        workerAgentId: worker2Id,
        priority: 20,
      });

      expect(mr1Id).toBeDefined();
      expect(mr2Id).toBeDefined();
      expect(mergeQueue.getQueueDepth(streamId)).toBe(2);

      // ═══════════════════════════════════════════════════════════════════════
      // Phase 5: Integrator processes merge queue
      // ═══════════════════════════════════════════════════════════════════════

      // Note: Workers must release their worktrees first since integrator
      // needs to work on the stream branch
      manager.deallocateWorkspace(worker1Id);
      manager.deallocateWorkspace(worker2Id);

      const integratorId = 'integrator-001';
      const integratorWorkspace = manager.createIntegratorWorkspace(
        integratorId,
        streamId
      ) as IntegratorWorkspace;

      expect(integratorWorkspace.role).toBe('integrator');

      // Process first MR (higher priority - task1)
      const nextMr1 = mergeQueue.getNext(streamId);
      expect(nextMr1).not.toBeNull();
      expect(nextMr1!.taskId).toBe(task1Id); // Higher priority first

      mergeQueue.markProcessing(nextMr1!.id);

      // Complete the task (merges worker branch to stream)
      const completeResult1 = adapter.completeTask({
        taskId: task1Id,
        worktree: integratorWorkspace.path,
      });

      expect(completeResult1.mergeCommit).toBeDefined();
      mergeQueue.markMerged(nextMr1!.id, completeResult1.mergeCommit);

      // Process second MR
      const nextMr2 = mergeQueue.getNext(streamId);
      expect(nextMr2).not.toBeNull();
      expect(nextMr2!.taskId).toBe(task2Id);

      mergeQueue.markProcessing(nextMr2!.id);

      const completeResult2 = adapter.completeTask({
        taskId: task2Id,
        worktree: integratorWorkspace.path,
      });

      expect(completeResult2.mergeCommit).toBeDefined();
      mergeQueue.markMerged(nextMr2!.id, completeResult2.mergeCommit);

      // Verify queue is empty
      expect(mergeQueue.getQueueDepth(streamId)).toBe(0);
      expect(mergeQueue.getNext(streamId)).toBeNull();

      // Verify both changes are in the integration branch
      const files = git('ls-tree -r HEAD --name-only', integratorWorkspace.path).split('\n');
      expect(files).toContain('src/auth/login.ts');
      expect(files).toContain('src/auth/logout.ts');

      // ═══════════════════════════════════════════════════════════════════════
      // Phase 6: Cleanup workspaces and branches
      // ═══════════════════════════════════════════════════════════════════════

      // Deallocate integrator workspace
      manager.deallocateWorkspace(integratorId);

      // Verify workspaces are removed
      expect(manager.getWorkspace(worker1Id)).toBeNull();
      expect(manager.getWorkspace(worker2Id)).toBeNull();
      expect(manager.getWorkspace(integratorId)).toBeNull();

      // Clean up worker branches (branches for completed tasks)
      const cleanupResult = manager.cleanupWorkerBranches({ olderThanMs: 0 });

      // Worker branches should be cleaned up
      const branchesAfterCleanup = git('branch --list worker/*').split('\n').filter(Boolean);
      expect(branchesAfterCleanup.length).toBe(0);
      expect(cleanupResult.deleted.length).toBe(2);
    });
  });

  describe('parallel workers with merge queue', () => {
    it('should correctly order merges by priority', () => {
      const coordinatorId = 'coordinator-001';
      const streamId = manager.createIntegrationStream(coordinatorId, {
        name: 'feature/parallel',
      });

      // Create 3 tasks with different priorities
      const taskIds = [
        manager.createTask(streamId, { title: 'Task A', priority: 30 }),
        manager.createTask(streamId, { title: 'Task B', priority: 10 }), // Highest priority
        manager.createTask(streamId, { title: 'Task C', priority: 20 }),
      ];

      // Create workers for each task
      const workers = taskIds.map((taskId, i) => {
        const workerId = `worker-${i + 1}`;
        const workspace = manager.createWorkerWorkspace(
          workerId,
          taskId,
          streamId
        ) as WorkerWorkspace;
        const startResult = manager.claimTask(taskId, workerId, workspace.path);

        // Make a simple change
        writeAndCommit(
          `src/task-${i + 1}.ts`,
          `export const task${i + 1} = true;`,
          `feat: task ${i + 1}`,
          workspace.path
        );

        return { workerId, taskId, workspace, branchName: startResult.branchName };
      });

      // Submit all to merge queue
      workers.forEach((w, i) => {
        mergeQueue.submit({
          streamId,
          taskId: w.taskId,
          workerBranch: w.branchName,
          workerAgentId: w.workerId,
          priority: [30, 10, 20][i], // A=30, B=10, C=20
        });
      });

      // Verify queue depth
      expect(mergeQueue.getQueueDepth(streamId)).toBe(3);

      // Get items in priority order
      const order: string[] = [];
      let mr = mergeQueue.getNext(streamId);

      while (mr) {
        order.push(mr.taskId);
        mergeQueue.markProcessing(mr.id);
        mergeQueue.markAbandoned(mr.id); // Just mark abandoned to clear queue
        mr = mergeQueue.getNext(streamId);
      }

      // Should be B (10), C (20), A (30)
      expect(order[0]).toBe(taskIds[1]); // Task B - priority 10
      expect(order[1]).toBe(taskIds[2]); // Task C - priority 20
      expect(order[2]).toBe(taskIds[0]); // Task A - priority 30

      // Cleanup
      workers.forEach((w) => manager.deallocateWorkspace(w.workerId));
    });

    it('should handle FIFO when priorities are equal', () => {
      const coordinatorId = 'coordinator-001';
      const streamId = manager.createIntegrationStream(coordinatorId, {
        name: 'feature/fifo',
      });

      // Create tasks with same priority, submitted in order
      const taskIds: string[] = [];
      for (let i = 0; i < 3; i++) {
        taskIds.push(manager.createTask(streamId, { title: `Task ${i}`, priority: 100 }));
      }

      // Submit in order
      taskIds.forEach((taskId, i) => {
        mergeQueue.submit({
          streamId,
          taskId,
          workerBranch: `worker/test/${taskId}`,
          workerAgentId: `worker-${i}`,
          priority: 100,
        });
      });

      // Should come out in FIFO order
      const order: string[] = [];
      let mr = mergeQueue.getNext(streamId);

      while (mr) {
        order.push(mr.taskId);
        mergeQueue.markProcessing(mr.id);
        mergeQueue.markAbandoned(mr.id);
        mr = mergeQueue.getNext(streamId);
      }

      expect(order).toEqual(taskIds);
    });
  });

  describe('conflict detection', () => {
    it('should detect conflicts when workers modify same file', () => {
      const coordinatorId = 'coordinator-001';
      const streamId = manager.createIntegrationStream(coordinatorId, {
        name: 'feature/conflicts',
      });

      // Create two tasks
      const task1Id = manager.createTask(streamId, { title: 'Modify shared file - version A' });
      const task2Id = manager.createTask(streamId, { title: 'Modify shared file - version B' });

      // Worker 1 modifies the file
      const worker1Workspace = manager.createWorkerWorkspace(
        'worker-1',
        task1Id,
        streamId
      ) as WorkerWorkspace;
      manager.claimTask(task1Id, 'worker-1', worker1Workspace.path);
      writeAndCommit(
        'src/index.ts',
        'export const version = "2.0.0"; // Updated by worker 1',
        'feat: update version to 2.0.0',
        worker1Workspace.path
      );

      // Worker 2 modifies the same file differently
      const worker2Workspace = manager.createWorkerWorkspace(
        'worker-2',
        task2Id,
        streamId
      ) as WorkerWorkspace;
      manager.claimTask(task2Id, 'worker-2', worker2Workspace.path);
      writeAndCommit(
        'src/index.ts',
        'export const version = "3.0.0"; // Updated by worker 2',
        'feat: update version to 3.0.0',
        worker2Workspace.path
      );

      // Create integrator workspace
      const integratorWorkspace = manager.createIntegratorWorkspace(
        'integrator-1',
        streamId
      ) as IntegratorWorkspace;

      // First merge succeeds
      const completeResult1 = adapter.completeTask({
        taskId: task1Id,
        worktree: integratorWorkspace.path,
      });
      expect(completeResult1.mergeCommit).toBeDefined();

      // Second merge should detect conflicts
      const conflicts = adapter.detectTaskConflicts(
        task2Id,
        integratorWorkspace.path
      );

      expect(conflicts.length).toBeGreaterThan(0);
      expect(conflicts).toContain('src/index.ts');

      // Cleanup
      manager.deallocateWorkspace('worker-1');
      manager.deallocateWorkspace('worker-2');
      manager.deallocateWorkspace('integrator-1');
    });

    it('should mark MR as conflict when merge fails', () => {
      const coordinatorId = 'coordinator-001';
      const streamId = manager.createIntegrationStream(coordinatorId, {
        name: 'feature/mr-conflict',
      });

      const task1Id = manager.createTask(streamId, { title: 'Task 1' });
      const task2Id = manager.createTask(streamId, { title: 'Task 2' });

      // Setup workers with conflicting changes
      const worker1Workspace = manager.createWorkerWorkspace(
        'worker-1',
        task1Id,
        streamId
      ) as WorkerWorkspace;
      const start1 = manager.claimTask(task1Id, 'worker-1', worker1Workspace.path);
      writeAndCommit('shared.ts', 'const x = 1;', 'change 1', worker1Workspace.path);

      const worker2Workspace = manager.createWorkerWorkspace(
        'worker-2',
        task2Id,
        streamId
      ) as WorkerWorkspace;
      const start2 = manager.claimTask(task2Id, 'worker-2', worker2Workspace.path);
      writeAndCommit('shared.ts', 'const x = 2;', 'change 2', worker2Workspace.path);

      // Submit both to merge queue
      const mr1Id = mergeQueue.submit({
        streamId,
        taskId: task1Id,
        workerBranch: start1.branchName,
        workerAgentId: 'worker-1',
      });
      const mr2Id = mergeQueue.submit({
        streamId,
        taskId: task2Id,
        workerBranch: start2.branchName,
        workerAgentId: 'worker-2',
      });

      // Create integrator
      const integratorWorkspace = manager.createIntegratorWorkspace(
        'integrator-1',
        streamId
      ) as IntegratorWorkspace;

      // Process first MR - should succeed
      mergeQueue.markProcessing(mr1Id);
      const result1 = adapter.completeTask({
        taskId: task1Id,
        worktree: integratorWorkspace.path,
      });
      mergeQueue.markMerged(mr1Id, result1.mergeCommit);

      // Process second MR - should conflict
      mergeQueue.markProcessing(mr2Id);

      // Detect conflicts before attempting merge
      const conflicts = adapter.detectTaskConflicts(task2Id, integratorWorkspace.path);

      if (conflicts.length > 0) {
        mergeQueue.markConflict(mr2Id, conflicts, 'resolver-task-123');
      }

      // Verify MR states
      expect(mergeQueue.get(mr1Id)!.status).toBe('merged');
      expect(mergeQueue.get(mr2Id)!.status).toBe('conflict');
      expect(mergeQueue.get(mr2Id)!.conflictFiles).toContain('shared.ts');

      // Cleanup
      manager.deallocateWorkspace('worker-1');
      manager.deallocateWorkspace('worker-2');
      manager.deallocateWorkspace('integrator-1');
    });
  });

  describe('cleanup', () => {
    it('should properly deallocate worktrees', () => {
      const coordinatorId = 'coordinator-001';
      const streamId = manager.createIntegrationStream(coordinatorId, {
        name: 'feature/cleanup-test',
      });

      const taskId = manager.createTask(streamId, { title: 'Test cleanup' });

      // Create worker workspace
      const workerWorkspace = manager.createWorkerWorkspace(
        'worker-1',
        taskId,
        streamId
      ) as WorkerWorkspace;

      // Verify worktree exists
      const worktreesBefore = listWorktrees();
      expect(worktreesBefore.length).toBeGreaterThan(1); // Main repo + at least one worktree

      // Deallocate
      manager.deallocateWorkspace('worker-1');

      // Verify worktree is removed
      expect(manager.getWorkspace('worker-1')).toBeNull();
    });

    it('should clean up completed task branches', () => {
      const coordinatorId = 'coordinator-001';
      const streamId = manager.createIntegrationStream(coordinatorId, {
        name: 'feature/branch-cleanup',
      });

      const taskId = manager.createTask(streamId, { title: 'Branch cleanup test' });

      // Worker claims task and makes changes
      const workerWorkspace = manager.createWorkerWorkspace(
        'worker-1',
        taskId,
        streamId
      ) as WorkerWorkspace;
      const startResult = manager.claimTask(taskId, 'worker-1', workerWorkspace.path);
      writeAndCommit('test.ts', 'export const test = true;', 'test commit', workerWorkspace.path);

      // Verify worker branch exists
      const branchesBefore = git('branch --list worker/*').split('\n').filter(Boolean);
      expect(branchesBefore.length).toBeGreaterThan(0);

      // Deallocate worker first so integrator can use the stream branch
      manager.deallocateWorkspace('worker-1');

      // Create integrator and complete task
      const integratorWorkspace = manager.createIntegratorWorkspace(
        'integrator-1',
        streamId
      ) as IntegratorWorkspace;

      adapter.completeTask({
        taskId,
        worktree: integratorWorkspace.path,
      });

      // Cleanup branches (with 0ms threshold to clean immediately)
      const cleanupResult = manager.cleanupWorkerBranches({ olderThanMs: 0 });

      // Verify branch is cleaned up
      const branchesAfter = git('branch --list worker/*').split('\n').filter(Boolean);
      expect(branchesAfter.length).toBe(0);
      expect(cleanupResult.deleted).toContain(startResult.branchName);

      // Cleanup workspaces
      manager.deallocateWorkspace('integrator-1');
    });

    it('should emit cleanup events', () => {
      const events: Array<{ type: string; data: Record<string, unknown> }> = [];
      manager.onEvent((event) => events.push(event));

      const coordinatorId = 'coordinator-001';
      const streamId = manager.createIntegrationStream(coordinatorId, {
        name: 'feature/events-test',
      });

      const taskId = manager.createTask(streamId, { title: 'Events test' });

      const workerWorkspace = manager.createWorkerWorkspace(
        'worker-1',
        taskId,
        streamId
      ) as WorkerWorkspace;

      // Should have workspace:created event
      expect(events.some((e) => e.type === 'workspace:created')).toBe(true);

      manager.claimTask(taskId, 'worker-1', workerWorkspace.path);
      writeAndCommit('test.ts', 'test', 'test', workerWorkspace.path);

      // Deallocate worker first so integrator can use the stream branch
      manager.deallocateWorkspace('worker-1');

      // Should have workspace:deallocated event
      expect(events.some((e) => e.type === 'workspace:deallocated')).toBe(true);

      // Complete task
      const integratorWorkspace = manager.createIntegratorWorkspace(
        'integrator-1',
        streamId
      ) as IntegratorWorkspace;
      adapter.completeTask({ taskId, worktree: integratorWorkspace.path });

      // Cleanup
      const cleanupResult = manager.cleanupWorkerBranches({ olderThanMs: 0 });

      // Should have branches:cleaned event if any branches were deleted
      if (cleanupResult.deleted.length > 0) {
        expect(events.some((e) => e.type === 'branches:cleaned')).toBe(true);
      }

      // Deallocate integrator
      manager.deallocateWorkspace('integrator-1');
    });
  });

  describe('edge cases', () => {
    it('should handle empty merge queue gracefully', () => {
      const coordinatorId = 'coordinator-001';
      const streamId = manager.createIntegrationStream(coordinatorId, {
        name: 'feature/empty-queue',
      });

      expect(mergeQueue.getNext(streamId)).toBeNull();
      expect(mergeQueue.getQueueDepth(streamId)).toBe(0);
    });

    it('should handle abandoned merge requests', () => {
      const coordinatorId = 'coordinator-001';
      const streamId = manager.createIntegrationStream(coordinatorId, {
        name: 'feature/abandoned',
      });

      const mrId = mergeQueue.submit({
        streamId,
        taskId: 'task-1',
        workerBranch: 'worker/test/branch',
        workerAgentId: 'worker-1',
      });

      // Mark as processing then abandoned
      mergeQueue.markProcessing(mrId);
      mergeQueue.markAbandoned(mrId);

      expect(mergeQueue.get(mrId)!.status).toBe('abandoned');
      expect(mergeQueue.getQueueDepth(streamId)).toBe(0);
    });

    it('should handle reordering pending merge requests', () => {
      const coordinatorId = 'coordinator-001';
      const streamId = manager.createIntegrationStream(coordinatorId, {
        name: 'feature/reorder',
      });

      const mr1Id = mergeQueue.submit({
        streamId,
        taskId: 'task-1',
        workerBranch: 'branch-1',
        workerAgentId: 'worker-1',
        priority: 100,
      });

      const mr2Id = mergeQueue.submit({
        streamId,
        taskId: 'task-2',
        workerBranch: 'branch-2',
        workerAgentId: 'worker-2',
        priority: 100,
      });

      // Initially task-1 should be first (FIFO)
      expect(mergeQueue.getNext(streamId)!.taskId).toBe('task-1');

      // Reposition task-2 to position 1 (front of queue)
      mergeQueue.reposition(mr2Id, 1);

      // Now task-2 should be first
      expect(mergeQueue.getNext(streamId)!.taskId).toBe('task-2');
    });

    it('should recover stale tasks', () => {
      const coordinatorId = 'coordinator-001';
      const streamId = manager.createIntegrationStream(coordinatorId, {
        name: 'feature/recovery',
      });

      const taskId = manager.createTask(streamId, { title: 'Stale task' });

      // Worker claims task
      const workerWorkspace = manager.createWorkerWorkspace(
        'worker-1',
        taskId,
        streamId
      ) as WorkerWorkspace;
      manager.claimTask(taskId, 'worker-1', workerWorkspace.path);

      // Task should be in_progress
      let task = adapter.getTask(taskId);
      expect(task!.status).toBe('in_progress');

      // Recover tasks with -1ms threshold (cutoff is 1ms in future, so all tasks are stale)
      const recoveryResult = adapter.recoverStaleTasks(-1);

      // Task should be released back to open
      task = adapter.getTask(taskId);
      expect(task!.status).toBe('open');
      expect(recoveryResult.released).toContain(taskId);

      // Cleanup
      manager.deallocateWorkspace('worker-1');
    });
  });
});
