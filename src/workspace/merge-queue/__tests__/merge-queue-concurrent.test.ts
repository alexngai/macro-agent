/**
 * MergeQueue Concurrent Operations Tests
 *
 * Tests for race conditions and concurrent access patterns.
 * While SQLite serializes writes, these tests verify behavior
 * when multiple operations interleave.
 *
 * @see s-1zcx Testing Strategy spec
 * @see s-bcqm Change Management spec
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import {
  MergeQueue,
  createMergeQueue,
  MergeRequestNotFoundError,
  MergeRequestStateError,
} from '../merge-queue.js';
import type { MergeRequest, MergeQueueEvent } from '../types.js';

describe('MergeQueue Concurrent Operations', () => {
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

  // ===========================================================================
  // Simulated Concurrent getNext + markProcessing
  // ===========================================================================

  describe('concurrent getNext and markProcessing', () => {
    it('should handle interleaved getNext calls from different "integrators"', () => {
      // This simulates two integrators calling getNext() at the same time
      // Both would get the same MR, but only one should be able to process it

      const mrId = queue.submit({
        streamId: 'stream-1',
        taskId: 'task-1',
        workerBranch: 'branch-1',
        workerAgentId: 'agent-1',
      });

      // Integrator A gets next
      const mrA = queue.getNext('stream-1');
      expect(mrA).not.toBeNull();
      expect(mrA!.id).toBe(mrId);

      // Integrator B also gets next (before A calls markProcessing)
      const mrB = queue.getNext('stream-1');
      expect(mrB).not.toBeNull();
      expect(mrB!.id).toBe(mrId); // Same MR - potential race condition

      // Integrator A marks as processing first
      queue.markProcessing(mrA!.id);

      // Integrator B tries to mark as processing - should fail
      expect(() => queue.markProcessing(mrB!.id)).toThrow(MergeRequestStateError);
    });

    it('should return null for getNext after MR is marked processing', () => {
      const mrId = queue.submit({
        streamId: 'stream-1',
        taskId: 'task-1',
        workerBranch: 'branch-1',
        workerAgentId: 'agent-1',
      });

      // First integrator gets and processes
      const mr = queue.getNext('stream-1');
      queue.markProcessing(mr!.id);

      // Second integrator should get null
      const mrNext = queue.getNext('stream-1');
      expect(mrNext).toBeNull();
    });

    it('should handle rapid submit-then-getNext sequences', () => {
      // Simulate rapid submissions while processing is happening
      const results: { submitted: string; processed: string[] }[] = [];

      for (let i = 0; i < 10; i++) {
        const mrId = queue.submit({
          streamId: 'stream-1',
          taskId: `task-${i}`,
          workerBranch: `branch-${i}`,
          workerAgentId: `agent-${i}`,
        });

        const processed: string[] = [];

        // Try to process immediately after submit
        const next = queue.getNext('stream-1');
        if (next) {
          queue.markProcessing(next.id);
          queue.markMerged(next.id, `commit-${i}`);
          processed.push(next.id);
        }

        results.push({ submitted: mrId, processed });
      }

      // All should have been processed
      expect(queue.getQueueDepth('stream-1')).toBe(0);
    });
  });

  // ===========================================================================
  // Concurrent Submissions
  // ===========================================================================

  describe('concurrent submissions', () => {
    it('should handle multiple submissions to same stream in rapid succession', () => {
      const mrIds: string[] = [];

      // Simulate 50 workers submitting simultaneously
      for (let i = 0; i < 50; i++) {
        mrIds.push(
          queue.submit({
            streamId: 'stream-1',
            taskId: `task-${i}`,
            workerBranch: `branch-${i}`,
            workerAgentId: `agent-${i}`,
          })
        );
      }

      // All should be in queue
      expect(queue.getQueueDepth('stream-1')).toBe(50);

      // All IDs should be unique
      const uniqueIds = new Set(mrIds);
      expect(uniqueIds.size).toBe(50);
    });

    it('should maintain FIFO order under rapid submissions', async () => {
      const submissionOrder: string[] = [];

      // Submit with slight delays to ensure different timestamps
      for (let i = 0; i < 10; i++) {
        const mrId = queue.submit({
          streamId: 'stream-1',
          taskId: `task-${i}`,
          workerBranch: `branch-${i}`,
          workerAgentId: `agent-${i}`,
        });
        submissionOrder.push(mrId);
        await new Promise((resolve) => setTimeout(resolve, 2));
      }

      // Process and verify order
      const processOrder: string[] = [];
      while (true) {
        const next = queue.getNext('stream-1');
        if (!next) break;
        processOrder.push(next.id);
        queue.markProcessing(next.id);
        queue.markMerged(next.id, `commit-${processOrder.length}`);
      }

      expect(processOrder).toEqual(submissionOrder);
    });
  });

  // ===========================================================================
  // Concurrent Priority Changes
  // ===========================================================================

  describe('concurrent priority changes', () => {
    it('should handle priority change while queue is being processed', () => {
      // Submit 3 MRs with same priority
      const mr1 = queue.submit({
        streamId: 'stream-1',
        taskId: 'task-1',
        workerBranch: 'branch-1',
        workerAgentId: 'agent-1',
        priority: 50,
      });
      const mr2 = queue.submit({
        streamId: 'stream-1',
        taskId: 'task-2',
        workerBranch: 'branch-2',
        workerAgentId: 'agent-2',
        priority: 50,
      });
      const mr3 = queue.submit({
        streamId: 'stream-1',
        taskId: 'task-3',
        workerBranch: 'branch-3',
        workerAgentId: 'agent-3',
        priority: 50,
      });

      // Start processing first MR
      const first = queue.getNext('stream-1');
      expect(first!.id).toBe(mr1);
      queue.markProcessing(first!.id);

      // While processing, bump priority of mr3
      queue.bumpPriority(mr3, 10); // Now higher priority

      // Complete first
      queue.markMerged(first!.id, 'commit-1');

      // Next should be mr3 (higher priority), not mr2
      const second = queue.getNext('stream-1');
      expect(second!.id).toBe(mr3);
    });

    it('should not allow priority change on processing MR', () => {
      const mrId = queue.submit({
        streamId: 'stream-1',
        taskId: 'task-1',
        workerBranch: 'branch-1',
        workerAgentId: 'agent-1',
      });

      queue.markProcessing(mrId);

      expect(() => queue.bumpPriority(mrId, 10)).toThrow(MergeRequestStateError);
    });

    it('should handle concurrent reposition operations', () => {
      const mr1 = queue.submit({
        streamId: 'stream-1',
        taskId: 'task-1',
        workerBranch: 'branch-1',
        workerAgentId: 'agent-1',
      });
      const mr2 = queue.submit({
        streamId: 'stream-1',
        taskId: 'task-2',
        workerBranch: 'branch-2',
        workerAgentId: 'agent-2',
      });
      const mr3 = queue.submit({
        streamId: 'stream-1',
        taskId: 'task-3',
        workerBranch: 'branch-3',
        workerAgentId: 'agent-3',
      });

      // Multiple repositions in sequence
      queue.reposition(mr3, 1);
      queue.reposition(mr1, 2);
      queue.reposition(mr2, 3);

      // Process and verify order
      const order: string[] = [];
      while (true) {
        const next = queue.getNext('stream-1');
        if (!next) break;
        order.push(next.id);
        queue.markProcessing(next.id);
        queue.markMerged(next.id, `commit-${order.length}`);
      }

      expect(order).toEqual([mr3, mr1, mr2]);
    });
  });

  // ===========================================================================
  // Event Emission Under Load
  // ===========================================================================

  describe('event emission under load', () => {
    it('should emit all events even under rapid operations', () => {
      const events: MergeQueueEvent[] = [];
      queue.onEvent((event) => events.push(event));

      // Rapid submission and processing
      for (let i = 0; i < 20; i++) {
        const mrId = queue.submit({
          streamId: 'stream-1',
          taskId: `task-${i}`,
          workerBranch: `branch-${i}`,
          workerAgentId: `agent-${i}`,
        });
        queue.markProcessing(mrId);
        queue.markMerged(mrId, `commit-${i}`);
      }

      // Should have 20 submitted + 20 processing + 20 merged = 60 events
      expect(events.filter((e) => e.type === 'mr:submitted').length).toBe(20);
      expect(events.filter((e) => e.type === 'mr:processing').length).toBe(20);
      expect(events.filter((e) => e.type === 'mr:merged').length).toBe(20);
    });

    it('should handle multiple listeners under load', () => {
      const events1: MergeQueueEvent[] = [];
      const events2: MergeQueueEvent[] = [];
      const events3: MergeQueueEvent[] = [];

      queue.onEvent((e) => events1.push(e));
      queue.onEvent((e) => events2.push(e));
      queue.onEvent((e) => events3.push(e));

      for (let i = 0; i < 10; i++) {
        queue.submit({
          streamId: 'stream-1',
          taskId: `task-${i}`,
          workerBranch: `branch-${i}`,
          workerAgentId: `agent-${i}`,
        });
      }

      // All listeners should receive all events
      expect(events1.length).toBe(10);
      expect(events2.length).toBe(10);
      expect(events3.length).toBe(10);
    });
  });

  // ===========================================================================
  // Multi-Stream Concurrent Operations
  // ===========================================================================

  describe('multi-stream concurrent operations', () => {
    it('should isolate operations across streams under concurrent load', () => {
      // Submit to multiple streams concurrently
      for (let s = 0; s < 5; s++) {
        for (let i = 0; i < 10; i++) {
          queue.submit({
            streamId: `stream-${s}`,
            taskId: `task-${s}-${i}`,
            workerBranch: `branch-${s}-${i}`,
            workerAgentId: `agent-${i}`,
          });
        }
      }

      // Process streams "concurrently" (interleaved)
      const processed: Record<string, number> = {};
      let totalProcessed = 0;

      while (totalProcessed < 50) {
        let anyProcessed = false;

        for (let s = 0; s < 5; s++) {
          const streamId = `stream-${s}`;
          const next = queue.getNext(streamId);
          if (next) {
            queue.markProcessing(next.id);
            queue.markMerged(next.id, `commit-${s}-${totalProcessed}`);
            processed[streamId] = (processed[streamId] || 0) + 1;
            totalProcessed++;
            anyProcessed = true;
          }
        }

        if (!anyProcessed) break;
      }

      // Each stream should have processed 10
      for (let s = 0; s < 5; s++) {
        expect(processed[`stream-${s}`]).toBe(10);
        expect(queue.getQueueDepth(`stream-${s}`)).toBe(0);
      }
    });

    it('should handle mixed success and failure across streams', () => {
      // Submit to two streams
      for (let i = 0; i < 5; i++) {
        queue.submit({
          streamId: 'stream-success',
          taskId: `task-success-${i}`,
          workerBranch: `branch-success-${i}`,
          workerAgentId: `agent-${i}`,
        });
        queue.submit({
          streamId: 'stream-conflict',
          taskId: `task-conflict-${i}`,
          workerBranch: `branch-conflict-${i}`,
          workerAgentId: `agent-${i}`,
        });
      }

      // Process stream-success with merges
      while (true) {
        const next = queue.getNext('stream-success');
        if (!next) break;
        queue.markProcessing(next.id);
        queue.markMerged(next.id, 'commit');
      }

      // Process stream-conflict with conflicts
      while (true) {
        const next = queue.getNext('stream-conflict');
        if (!next) break;
        queue.markProcessing(next.id);
        queue.markConflict(next.id, ['file.ts']);
      }

      // Verify stream states
      expect(queue.getQueueDepth('stream-success')).toBe(0);
      expect(queue.getQueueDepth('stream-conflict')).toBe(0);

      // Check statuses
      const successMrs = queue.getPending('stream-success', { status: 'merged' });
      const conflictMrs = queue.getPending('stream-conflict', { status: 'conflict' });
      expect(successMrs.length).toBe(5);
      expect(conflictMrs.length).toBe(5);
    });
  });

  // ===========================================================================
  // Database Consistency
  // ===========================================================================

  describe('database consistency', () => {
    it('should maintain data integrity after many operations', () => {
      // Perform many mixed operations
      const created: string[] = [];
      const merged: string[] = [];
      const conflicted: string[] = [];
      const abandoned: string[] = [];

      for (let i = 0; i < 100; i++) {
        const mrId = queue.submit({
          streamId: 'stream-1',
          taskId: `task-${i}`,
          workerBranch: `branch-${i}`,
          workerAgentId: `agent-${i}`,
        });
        created.push(mrId);

        // Randomly decide outcome
        const outcome = i % 3;
        queue.markProcessing(mrId);

        if (outcome === 0) {
          queue.markMerged(mrId, `commit-${i}`);
          merged.push(mrId);
        } else if (outcome === 1) {
          queue.markConflict(mrId, ['file.ts']);
          conflicted.push(mrId);
        } else {
          queue.markAbandoned(mrId);
          abandoned.push(mrId);
        }
      }

      // Verify counts
      expect(merged.length + conflicted.length + abandoned.length).toBe(100);

      // Verify each MR is in expected state
      for (const mrId of merged) {
        expect(queue.get(mrId)!.status).toBe('merged');
      }
      for (const mrId of conflicted) {
        expect(queue.get(mrId)!.status).toBe('conflict');
      }
      for (const mrId of abandoned) {
        expect(queue.get(mrId)!.status).toBe('abandoned');
      }

      // Queue should be empty (no pending)
      expect(queue.getQueueDepth('stream-1')).toBe(0);
    });

    it('should correctly track queue depth during rapid changes', () => {
      const depths: number[] = [];

      // Submit and track depth
      for (let i = 0; i < 10; i++) {
        queue.submit({
          streamId: 'stream-1',
          taskId: `task-${i}`,
          workerBranch: `branch-${i}`,
          workerAgentId: `agent-${i}`,
        });
        depths.push(queue.getQueueDepth('stream-1'));
      }

      // Depth should have increased linearly
      expect(depths).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

      // Process and track depth
      const processingDepths: number[] = [];
      while (true) {
        const next = queue.getNext('stream-1');
        if (!next) break;
        queue.markProcessing(next.id);
        processingDepths.push(queue.getQueueDepth('stream-1'));
        queue.markMerged(next.id, 'commit');
      }

      // Depth should have decreased linearly
      expect(processingDepths).toEqual([9, 8, 7, 6, 5, 4, 3, 2, 1, 0]);
    });
  });

  // ===========================================================================
  // Abort and Recovery Scenarios
  // ===========================================================================

  describe('abort and recovery scenarios', () => {
    it('should allow processing new MR after previous was abandoned mid-processing', () => {
      const mr1 = queue.submit({
        streamId: 'stream-1',
        taskId: 'task-1',
        workerBranch: 'branch-1',
        workerAgentId: 'agent-1',
      });

      const mr2 = queue.submit({
        streamId: 'stream-1',
        taskId: 'task-2',
        workerBranch: 'branch-2',
        workerAgentId: 'agent-2',
      });

      // Start processing first
      queue.markProcessing(mr1);

      // Abandon it (simulating integrator crash/restart)
      queue.markAbandoned(mr1);

      // Should be able to process second
      const next = queue.getNext('stream-1');
      expect(next!.id).toBe(mr2);

      queue.markProcessing(next!.id);
      queue.markMerged(next!.id, 'commit');

      expect(queue.getQueueDepth('stream-1')).toBe(0);
    });

    it('should handle recovery after processing-state MR exists', () => {
      // Simulate crash: MR left in processing state
      const mr1 = queue.submit({
        streamId: 'stream-1',
        taskId: 'task-1',
        workerBranch: 'branch-1',
        workerAgentId: 'agent-1',
      });

      queue.markProcessing(mr1);
      // Crash happens here - mr1 left in processing

      // On recovery, getNext should still return null for this stream
      // because mr1 is still processing
      const next = queue.getNext('stream-1');
      expect(next).toBeNull();

      // Recovery: abandon the stuck MR
      queue.markAbandoned(mr1);

      // Now new submissions can be processed
      const mr2 = queue.submit({
        streamId: 'stream-1',
        taskId: 'task-2',
        workerBranch: 'branch-2',
        workerAgentId: 'agent-2',
      });

      const nextAfterRecovery = queue.getNext('stream-1');
      expect(nextAfterRecovery!.id).toBe(mr2);
    });
  });

  // ===========================================================================
  // Two Queue Instances (Simulating Multiple Integrators)
  // ===========================================================================

  describe('multiple queue instances on same database', () => {
    it('should see each others changes immediately', () => {
      // Create second queue instance on same DB
      const queue2 = createMergeQueue({ db, initSchema: false });

      const mrId = queue.submit({
        streamId: 'stream-1',
        taskId: 'task-1',
        workerBranch: 'branch-1',
        workerAgentId: 'agent-1',
      });

      // queue2 should see the MR immediately
      const mr = queue2.get(mrId);
      expect(mr).not.toBeNull();
      expect(mr!.status).toBe('pending');

      // queue2 processes it
      queue2.markProcessing(mrId);
      queue2.markMerged(mrId, 'commit');

      // queue should see the update
      const mrUpdated = queue.get(mrId);
      expect(mrUpdated!.status).toBe('merged');

      queue2.close();
    });

    it('should handle race between two queue instances', () => {
      const queue2 = createMergeQueue({ db, initSchema: false });

      const mrId = queue.submit({
        streamId: 'stream-1',
        taskId: 'task-1',
        workerBranch: 'branch-1',
        workerAgentId: 'agent-1',
      });

      // Both instances get the same MR
      const mr1 = queue.getNext('stream-1');
      const mr2 = queue2.getNext('stream-1');

      expect(mr1!.id).toBe(mrId);
      expect(mr2!.id).toBe(mrId);

      // First one wins
      queue.markProcessing(mr1!.id);

      // Second one should fail
      expect(() => queue2.markProcessing(mr2!.id)).toThrow(MergeRequestStateError);

      queue2.close();
    });
  });
});
