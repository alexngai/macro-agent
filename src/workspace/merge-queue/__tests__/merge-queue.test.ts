/**
 * MergeQueue Tests
 *
 * Tests for the MergeQueue implementation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  MergeQueue,
  createMergeQueue,
  MergeRequestNotFoundError,
  MergeRequestStateError,
} from '../merge-queue.js';
import { mergeQueueTableExists } from '../schema.js';

describe('MergeQueue', () => {
  let db: Database.Database;
  let queue: MergeQueue;

  beforeEach(() => {
    db = new Database(':memory:');
    queue = createMergeQueue({ db });
  });

  afterEach(() => {
    queue.close();
    db.close();
  });

  describe('initialization', () => {
    it('should create merge_requests table on initialization', () => {
      expect(mergeQueueTableExists(db)).toBe(true);
    });

    it('should work with custom table prefix', () => {
      const prefixedQueue = createMergeQueue({
        db,
        tablePrefix: 'test_',
      });
      expect(mergeQueueTableExists(db, 'test_')).toBe(true);
      prefixedQueue.close();
    });

    it('should not recreate table if already exists', () => {
      // Create second queue instance - should not throw
      const secondQueue = createMergeQueue({ db });
      expect(mergeQueueTableExists(db)).toBe(true);
      secondQueue.close();
    });
  });

  describe('submit', () => {
    it('should submit a merge request', () => {
      const mrId = queue.submit({
        streamId: 'stream-1',
        taskId: 'task-1',
        workerBranch: 'worker/agent-1/task-1@123',
        workerAgentId: 'agent-1',
      });

      expect(mrId).toBeDefined();
      expect(typeof mrId).toBe('string');
      expect(mrId.startsWith('mr-')).toBe(true);
    });

    it('should create MR with correct default values', () => {
      const mrId = queue.submit({
        streamId: 'stream-1',
        taskId: 'task-1',
        workerBranch: 'worker/agent-1/task-1@123',
        workerAgentId: 'agent-1',
      });

      const mr = queue.get(mrId);
      expect(mr).not.toBeNull();
      expect(mr!.status).toBe('pending');
      expect(mr!.priority).toBe(100);
      expect(mr!.position).toBeNull();
      expect(mr!.startedAt).toBeNull();
      expect(mr!.completedAt).toBeNull();
    });

    it('should accept custom priority', () => {
      const mrId = queue.submit({
        streamId: 'stream-1',
        taskId: 'task-1',
        workerBranch: 'worker/agent-1/task-1@123',
        workerAgentId: 'agent-1',
        priority: 10,
      });

      const mr = queue.get(mrId);
      expect(mr!.priority).toBe(10);
    });

    it('should emit mr:submitted event', () => {
      const events: Array<{ type: string; data: Record<string, unknown> }> = [];
      queue.onEvent((event) => events.push(event));

      queue.submit({
        streamId: 'stream-1',
        taskId: 'task-1',
        workerBranch: 'worker/agent-1/task-1@123',
        workerAgentId: 'agent-1',
      });

      expect(events.length).toBe(1);
      expect(events[0].type).toBe('mr:submitted');
      expect(events[0].data.streamId).toBe('stream-1');
    });
  });

  describe('getNext', () => {
    it('should return highest priority pending MR', () => {
      queue.submit({
        streamId: 'stream-1',
        taskId: 'task-1',
        workerBranch: 'branch-1',
        workerAgentId: 'agent-1',
        priority: 100,
      });
      queue.submit({
        streamId: 'stream-1',
        taskId: 'task-2',
        workerBranch: 'branch-2',
        workerAgentId: 'agent-2',
        priority: 10, // Higher priority
      });

      const next = queue.getNext('stream-1');
      expect(next).not.toBeNull();
      expect(next!.taskId).toBe('task-2'); // Higher priority first
    });

    it('should return oldest MR when priorities are equal', () => {
      queue.submit({
        streamId: 'stream-1',
        taskId: 'task-1',
        workerBranch: 'branch-1',
        workerAgentId: 'agent-1',
      });

      // Small delay to ensure different timestamps
      queue.submit({
        streamId: 'stream-1',
        taskId: 'task-2',
        workerBranch: 'branch-2',
        workerAgentId: 'agent-2',
      });

      const next = queue.getNext('stream-1');
      expect(next!.taskId).toBe('task-1'); // FIFO
    });

    it('should return null when no pending MRs', () => {
      const next = queue.getNext('stream-1');
      expect(next).toBeNull();
    });

    it('should only return pending MRs', () => {
      const mrId = queue.submit({
        streamId: 'stream-1',
        taskId: 'task-1',
        workerBranch: 'branch-1',
        workerAgentId: 'agent-1',
      });

      queue.markProcessing(mrId);

      const next = queue.getNext('stream-1');
      expect(next).toBeNull();
    });

    it('should respect position over priority', () => {
      const mr1 = queue.submit({
        streamId: 'stream-1',
        taskId: 'task-1',
        workerBranch: 'branch-1',
        workerAgentId: 'agent-1',
        priority: 10, // Higher priority
      });
      const mr2 = queue.submit({
        streamId: 'stream-1',
        taskId: 'task-2',
        workerBranch: 'branch-2',
        workerAgentId: 'agent-2',
        priority: 100, // Lower priority
      });

      // Set position on lower priority MR
      queue.reposition(mr2, 1);

      const next = queue.getNext('stream-1');
      expect(next!.id).toBe(mr2); // Position overrides priority
    });
  });

  describe('status transitions', () => {
    let mrId: string;

    beforeEach(() => {
      mrId = queue.submit({
        streamId: 'stream-1',
        taskId: 'task-1',
        workerBranch: 'branch-1',
        workerAgentId: 'agent-1',
      });
    });

    describe('markProcessing', () => {
      it('should transition pending to processing', () => {
        queue.markProcessing(mrId);

        const mr = queue.get(mrId);
        expect(mr!.status).toBe('processing');
        expect(mr!.startedAt).not.toBeNull();
      });

      it('should throw if not pending', () => {
        queue.markProcessing(mrId);

        expect(() => queue.markProcessing(mrId)).toThrow(MergeRequestStateError);
      });

      it('should emit mr:processing event', () => {
        const events: Array<{ type: string }> = [];
        queue.onEvent((event) => events.push(event));

        queue.markProcessing(mrId);

        expect(events.some((e) => e.type === 'mr:processing')).toBe(true);
      });
    });

    describe('markMerged', () => {
      it('should transition processing to merged', () => {
        queue.markProcessing(mrId);
        queue.markMerged(mrId, 'abc123');

        const mr = queue.get(mrId);
        expect(mr!.status).toBe('merged');
        expect(mr!.mergeCommit).toBe('abc123');
        expect(mr!.completedAt).not.toBeNull();
      });

      it('should throw if not processing', () => {
        expect(() => queue.markMerged(mrId, 'abc123')).toThrow(
          MergeRequestStateError
        );
      });

      it('should emit mr:merged event', () => {
        const events: Array<{ type: string }> = [];
        queue.onEvent((event) => events.push(event));

        queue.markProcessing(mrId);
        queue.markMerged(mrId, 'abc123');

        expect(events.some((e) => e.type === 'mr:merged')).toBe(true);
      });
    });

    describe('markConflict', () => {
      it('should transition processing to conflict', () => {
        queue.markProcessing(mrId);
        queue.markConflict(mrId, ['file1.ts', 'file2.ts']);

        const mr = queue.get(mrId);
        expect(mr!.status).toBe('conflict');
        expect(mr!.conflictFiles).toEqual(['file1.ts', 'file2.ts']);
        expect(mr!.completedAt).not.toBeNull();
      });

      it('should record resolver task ID', () => {
        queue.markProcessing(mrId);
        queue.markConflict(mrId, ['file1.ts'], 'resolver-task-1');

        const mr = queue.get(mrId);
        expect(mr!.resolverTaskId).toBe('resolver-task-1');
      });

      it('should throw if not processing', () => {
        expect(() => queue.markConflict(mrId, ['file1.ts'])).toThrow(
          MergeRequestStateError
        );
      });

      it('should emit mr:conflict event', () => {
        const events: Array<{ type: string }> = [];
        queue.onEvent((event) => events.push(event));

        queue.markProcessing(mrId);
        queue.markConflict(mrId, ['file1.ts']);

        expect(events.some((e) => e.type === 'mr:conflict')).toBe(true);
      });
    });

    describe('markAbandoned', () => {
      it('should transition pending to abandoned', () => {
        queue.markAbandoned(mrId);

        const mr = queue.get(mrId);
        expect(mr!.status).toBe('abandoned');
        expect(mr!.completedAt).not.toBeNull();
      });

      it('should transition processing to abandoned', () => {
        queue.markProcessing(mrId);
        queue.markAbandoned(mrId);

        const mr = queue.get(mrId);
        expect(mr!.status).toBe('abandoned');
      });

      it('should throw if already merged', () => {
        queue.markProcessing(mrId);
        queue.markMerged(mrId, 'abc123');

        expect(() => queue.markAbandoned(mrId)).toThrow(MergeRequestStateError);
      });

      it('should emit mr:abandoned event', () => {
        const events: Array<{ type: string }> = [];
        queue.onEvent((event) => events.push(event));

        queue.markAbandoned(mrId);

        expect(events.some((e) => e.type === 'mr:abandoned')).toBe(true);
      });
    });
  });

  describe('queries', () => {
    beforeEach(() => {
      queue.submit({
        streamId: 'stream-1',
        taskId: 'task-1',
        workerBranch: 'branch-1',
        workerAgentId: 'agent-1',
      });
      queue.submit({
        streamId: 'stream-1',
        taskId: 'task-2',
        workerBranch: 'branch-2',
        workerAgentId: 'agent-2',
      });
      queue.submit({
        streamId: 'stream-2',
        taskId: 'task-3',
        workerBranch: 'branch-3',
        workerAgentId: 'agent-3',
      });
    });

    describe('get', () => {
      it('should return MR by ID', () => {
        const mr = queue.getByTask('task-1');
        const result = queue.get(mr!.id);
        expect(result).not.toBeNull();
        expect(result!.taskId).toBe('task-1');
      });

      it('should return null for unknown ID', () => {
        const result = queue.get('unknown-id');
        expect(result).toBeNull();
      });
    });

    describe('getByTask', () => {
      it('should return MR by task ID', () => {
        const mr = queue.getByTask('task-1');
        expect(mr).not.toBeNull();
        expect(mr!.taskId).toBe('task-1');
      });

      it('should return null for unknown task ID', () => {
        const mr = queue.getByTask('unknown-task');
        expect(mr).toBeNull();
      });
    });

    describe('getPending', () => {
      it('should return pending MRs for stream', () => {
        const pending = queue.getPending('stream-1');
        expect(pending.length).toBe(2);
      });

      it('should filter by status', () => {
        const mr = queue.getByTask('task-1');
        queue.markProcessing(mr!.id);
        queue.markMerged(mr!.id, 'abc123');

        const pending = queue.getPending('stream-1', { status: 'merged' });
        expect(pending.length).toBe(1);
        expect(pending[0].taskId).toBe('task-1');
      });

      it('should respect limit', () => {
        const pending = queue.getPending('stream-1', { limit: 1 });
        expect(pending.length).toBe(1);
      });
    });

    describe('getQueueDepth', () => {
      it('should return count of pending MRs', () => {
        expect(queue.getQueueDepth('stream-1')).toBe(2);
        expect(queue.getQueueDepth('stream-2')).toBe(1);
        expect(queue.getQueueDepth('stream-3')).toBe(0);
      });

      it('should not count non-pending MRs', () => {
        const mr = queue.getByTask('task-1');
        queue.markProcessing(mr!.id);

        expect(queue.getQueueDepth('stream-1')).toBe(1);
      });
    });
  });

  describe('reordering', () => {
    let mr1: string;
    let mr2: string;

    beforeEach(() => {
      mr1 = queue.submit({
        streamId: 'stream-1',
        taskId: 'task-1',
        workerBranch: 'branch-1',
        workerAgentId: 'agent-1',
      });
      mr2 = queue.submit({
        streamId: 'stream-1',
        taskId: 'task-2',
        workerBranch: 'branch-2',
        workerAgentId: 'agent-2',
      });
    });

    describe('reposition', () => {
      it('should set position', () => {
        queue.reposition(mr2, 1);

        const mr = queue.get(mr2);
        expect(mr!.position).toBe(1);
      });

      it('should throw if not pending', () => {
        queue.markProcessing(mr1);

        expect(() => queue.reposition(mr1, 1)).toThrow(MergeRequestStateError);
      });
    });

    describe('bumpPriority', () => {
      it('should change priority', () => {
        queue.bumpPriority(mr1, 5);

        const mr = queue.get(mr1);
        expect(mr!.priority).toBe(5);
      });

      it('should throw if not pending', () => {
        queue.markProcessing(mr1);

        expect(() => queue.bumpPriority(mr1, 5)).toThrow(MergeRequestStateError);
      });
    });
  });

  describe('event subscription', () => {
    it('should allow unsubscribing from events', () => {
      const events: Array<{ type: string }> = [];
      const unsubscribe = queue.onEvent((event) => events.push(event));

      queue.submit({
        streamId: 'stream-1',
        taskId: 'task-1',
        workerBranch: 'branch-1',
        workerAgentId: 'agent-1',
      });

      expect(events.length).toBe(1);

      unsubscribe();

      queue.submit({
        streamId: 'stream-1',
        taskId: 'task-2',
        workerBranch: 'branch-2',
        workerAgentId: 'agent-2',
      });

      expect(events.length).toBe(1); // No new events
    });
  });

  describe('error handling', () => {
    it('should throw MergeRequestNotFoundError for unknown MR', () => {
      expect(() => queue.markProcessing('unknown-id')).toThrow(
        MergeRequestNotFoundError
      );
    });
  });
});
