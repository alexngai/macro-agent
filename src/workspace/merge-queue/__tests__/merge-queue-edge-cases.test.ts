/**
 * MergeQueue Edge Cases and Bug-Finding Tests
 *
 * These tests focus on:
 * - Edge cases that might reveal bugs
 * - Concurrent operations and race conditions
 * - Invalid input handling
 * - State transition edge cases
 * - Resolver flow (or lack thereof)
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

describe('MergeQueue Edge Cases', () => {
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
  // Priority Edge Cases
  // ===========================================================================

  describe('priority edge cases', () => {
    it('should handle priority of 0', () => {
      const mr1 = queue.submit({
        streamId: 'stream-1',
        taskId: 'task-1',
        workerBranch: 'branch-1',
        workerAgentId: 'agent-1',
        priority: 0,
      });

      const mr = queue.get(mr1);
      expect(mr!.priority).toBe(0);
    });

    it('should handle negative priority', () => {
      const mrNegative = queue.submit({
        streamId: 'stream-1',
        taskId: 'task-negative',
        workerBranch: 'branch-negative',
        workerAgentId: 'agent-1',
        priority: -10,
      });

      const mrPositive = queue.submit({
        streamId: 'stream-1',
        taskId: 'task-positive',
        workerBranch: 'branch-positive',
        workerAgentId: 'agent-2',
        priority: 10,
      });

      const mr = queue.get(mrNegative);
      expect(mr!.priority).toBe(-10);

      // Negative priority should be processed first (lower = higher priority)
      const next = queue.getNext('stream-1');
      expect(next!.taskId).toBe('task-negative');
    });

    it('should handle very large priority values', () => {
      const mrId = queue.submit({
        streamId: 'stream-1',
        taskId: 'task-1',
        workerBranch: 'branch-1',
        workerAgentId: 'agent-1',
        priority: Number.MAX_SAFE_INTEGER,
      });

      const mr = queue.get(mrId);
      expect(mr!.priority).toBe(Number.MAX_SAFE_INTEGER);
    });

    it('should handle floating point priority', () => {
      const mrId = queue.submit({
        streamId: 'stream-1',
        taskId: 'task-1',
        workerBranch: 'branch-1',
        workerAgentId: 'agent-1',
        priority: 10.5,
      });

      const mr = queue.get(mrId);
      // SQLite may truncate or store as float
      expect(mr!.priority).toBe(10.5);
    });

    it('should correctly order MRs with same priority by submission time', async () => {
      const mr1 = queue.submit({
        streamId: 'stream-1',
        taskId: 'task-1',
        workerBranch: 'branch-1',
        workerAgentId: 'agent-1',
        priority: 50,
      });

      // Ensure different timestamp
      await new Promise((resolve) => setTimeout(resolve, 5));

      const mr2 = queue.submit({
        streamId: 'stream-1',
        taskId: 'task-2',
        workerBranch: 'branch-2',
        workerAgentId: 'agent-2',
        priority: 50,
      });

      const next = queue.getNext('stream-1');
      expect(next!.id).toBe(mr1); // First submitted should be first
    });
  });

  // ===========================================================================
  // Position Edge Cases
  // ===========================================================================

  describe('position edge cases', () => {
    it('should handle position of 0', () => {
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

      // Set position 0 on second MR
      queue.reposition(mr2, 0);

      const next = queue.getNext('stream-1');
      expect(next!.id).toBe(mr2); // Position 0 should be first
    });

    it('should handle negative position', () => {
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

      // Set negative position
      queue.reposition(mr2, -100);

      const next = queue.getNext('stream-1');
      expect(next!.id).toBe(mr2); // Negative position should be first
    });

    it('should handle very large position values', () => {
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

      queue.reposition(mr1, Number.MAX_SAFE_INTEGER);
      queue.reposition(mr2, 1);

      const next = queue.getNext('stream-1');
      expect(next!.id).toBe(mr2); // Lower position first
    });

    it('should handle multiple MRs with same position', () => {
      const mr1 = queue.submit({
        streamId: 'stream-1',
        taskId: 'task-1',
        workerBranch: 'branch-1',
        workerAgentId: 'agent-1',
        priority: 100,
      });

      const mr2 = queue.submit({
        streamId: 'stream-1',
        taskId: 'task-2',
        workerBranch: 'branch-2',
        workerAgentId: 'agent-2',
        priority: 10, // Higher priority
      });

      // Both at position 1
      queue.reposition(mr1, 1);
      queue.reposition(mr2, 1);

      // Should fall back to priority ordering when positions are equal
      const next = queue.getNext('stream-1');
      expect(next!.taskId).toBe('task-2'); // Higher priority (10 < 100)
    });
  });

  // ===========================================================================
  // State Transition Edge Cases
  // ===========================================================================

  describe('state transition edge cases', () => {
    it('should reject abandoned → abandoned transition', () => {
      const mrId = queue.submit({
        streamId: 'stream-1',
        taskId: 'task-1',
        workerBranch: 'branch-1',
        workerAgentId: 'agent-1',
      });

      queue.markAbandoned(mrId);

      // Should throw MergeRequestStateError on second abandon
      expect(() => queue.markAbandoned(mrId)).toThrow(MergeRequestStateError);
      expect(() => queue.markAbandoned(mrId)).toThrow(/must be 'pending' or 'processing'/);
    });

    it('should reject conflict → abandoned transition', () => {
      const mrId = queue.submit({
        streamId: 'stream-1',
        taskId: 'task-1',
        workerBranch: 'branch-1',
        workerAgentId: 'agent-1',
      });

      queue.markProcessing(mrId);
      queue.markConflict(mrId, ['file.ts']);

      // Conflict is a terminal state requiring resolution via markResolverComplete
      expect(() => queue.markAbandoned(mrId)).toThrow(MergeRequestStateError);
      expect(() => queue.markAbandoned(mrId)).toThrow(/must be 'pending' or 'processing'/);

      // Status should remain conflict
      const mr = queue.get(mrId);
      expect(mr!.status).toBe('conflict');
    });

    it('should not allow processing → processing (double processing)', () => {
      const mrId = queue.submit({
        streamId: 'stream-1',
        taskId: 'task-1',
        workerBranch: 'branch-1',
        workerAgentId: 'agent-1',
      });

      queue.markProcessing(mrId);

      // Already processing - should throw
      expect(() => queue.markProcessing(mrId)).toThrow(MergeRequestStateError);
    });

    it('should not allow merged → conflict', () => {
      const mrId = queue.submit({
        streamId: 'stream-1',
        taskId: 'task-1',
        workerBranch: 'branch-1',
        workerAgentId: 'agent-1',
      });

      queue.markProcessing(mrId);
      queue.markMerged(mrId, 'abc123');

      // Already merged - should throw
      expect(() => queue.markConflict(mrId, ['file.ts'])).toThrow(
        MergeRequestStateError
      );
    });

    it('should not allow conflict → merged', () => {
      const mrId = queue.submit({
        streamId: 'stream-1',
        taskId: 'task-1',
        workerBranch: 'branch-1',
        workerAgentId: 'agent-1',
      });

      queue.markProcessing(mrId);
      queue.markConflict(mrId, ['file.ts']);

      // Already conflicted - should throw when trying to merge
      expect(() => queue.markMerged(mrId, 'abc123')).toThrow(
        MergeRequestStateError
      );
    });
  });

  // ===========================================================================
  // Metadata Edge Cases
  // ===========================================================================

  describe('metadata edge cases', () => {
    it('should handle empty metadata object', () => {
      const mrId = queue.submit({
        streamId: 'stream-1',
        taskId: 'task-1',
        workerBranch: 'branch-1',
        workerAgentId: 'agent-1',
        metadata: {},
      });

      const mr = queue.get(mrId);
      expect(mr!.metadata).toEqual({});
    });

    it('should handle nested metadata objects', () => {
      const metadata = {
        nested: {
          deeply: {
            value: 'test',
          },
        },
        array: [1, 2, 3],
      };

      const mrId = queue.submit({
        streamId: 'stream-1',
        taskId: 'task-1',
        workerBranch: 'branch-1',
        workerAgentId: 'agent-1',
        metadata,
      });

      const mr = queue.get(mrId);
      expect(mr!.metadata).toEqual(metadata);
    });

    it('should handle metadata with special characters', () => {
      const metadata = {
        'key-with-dash': 'value',
        'key.with.dots': 'value',
        'key with spaces': 'value',
        unicode: '日本語',
        emoji: '🚀',
      };

      const mrId = queue.submit({
        streamId: 'stream-1',
        taskId: 'task-1',
        workerBranch: 'branch-1',
        workerAgentId: 'agent-1',
        metadata,
      });

      const mr = queue.get(mrId);
      expect(mr!.metadata).toEqual(metadata);
    });

    it('should handle large metadata objects', () => {
      const largeMetadata: Record<string, string> = {};
      for (let i = 0; i < 1000; i++) {
        largeMetadata[`key_${i}`] = `value_${i}_${'x'.repeat(100)}`;
      }

      const mrId = queue.submit({
        streamId: 'stream-1',
        taskId: 'task-1',
        workerBranch: 'branch-1',
        workerAgentId: 'agent-1',
        metadata: largeMetadata,
      });

      const mr = queue.get(mrId);
      expect(Object.keys(mr!.metadata).length).toBe(1000);
    });
  });

  // ===========================================================================
  // Duplicate and Uniqueness Tests
  // ===========================================================================

  describe('duplicate handling', () => {
    it('should allow duplicate taskId in same stream', () => {
      // This might be a bug - should we allow this?
      queue.submit({
        streamId: 'stream-1',
        taskId: 'task-1',
        workerBranch: 'branch-1',
        workerAgentId: 'agent-1',
      });

      // Second submission with same taskId
      const mr2 = queue.submit({
        streamId: 'stream-1',
        taskId: 'task-1', // Same task ID!
        workerBranch: 'branch-2',
        workerAgentId: 'agent-2',
      });

      // This creates a duplicate - getByTask will only return one
      const byTask = queue.getByTask('task-1');
      expect(byTask).not.toBeNull();

      // But queue depth is 2
      expect(queue.getQueueDepth('stream-1')).toBe(2);
    });

    it('should allow same taskId in different streams', () => {
      queue.submit({
        streamId: 'stream-1',
        taskId: 'task-1',
        workerBranch: 'branch-1',
        workerAgentId: 'agent-1',
      });

      queue.submit({
        streamId: 'stream-2',
        taskId: 'task-1', // Same task ID, different stream
        workerBranch: 'branch-2',
        workerAgentId: 'agent-2',
      });

      expect(queue.getQueueDepth('stream-1')).toBe(1);
      expect(queue.getQueueDepth('stream-2')).toBe(1);
    });
  });

  // ===========================================================================
  // Event System Edge Cases
  // ===========================================================================

  describe('event system edge cases', () => {
    it('should handle event listener that throws error', () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      queue.onEvent(() => {
        throw new Error('Listener error');
      });

      // Should not throw, should log error
      expect(() => {
        queue.submit({
          streamId: 'stream-1',
          taskId: 'task-1',
          workerBranch: 'branch-1',
          workerAgentId: 'agent-1',
        });
      }).not.toThrow();

      expect(errorSpy).toHaveBeenCalled();
      errorSpy.mockRestore();
    });

    it('should continue calling other listeners after one throws', () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const events: MergeQueueEvent[] = [];

      // First listener throws
      queue.onEvent(() => {
        throw new Error('Listener error');
      });

      // Second listener should still receive events
      queue.onEvent((event) => {
        events.push(event);
      });

      queue.submit({
        streamId: 'stream-1',
        taskId: 'task-1',
        workerBranch: 'branch-1',
        workerAgentId: 'agent-1',
      });

      expect(events.length).toBe(1);
      expect(events[0].type).toBe('mr:submitted');
      errorSpy.mockRestore();
    });

    it('should handle unsubscribe during event emission', () => {
      const events: MergeQueueEvent[] = [];
      let unsubscribe: () => void;

      unsubscribe = queue.onEvent((event) => {
        events.push(event);
        unsubscribe(); // Unsubscribe during callback
      });

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

      // Should only receive first event
      expect(events.length).toBe(1);
    });
  });

  // ===========================================================================
  // Conflict Files Edge Cases
  // ===========================================================================

  describe('conflict files edge cases', () => {
    it('should handle empty conflict files array', () => {
      const mrId = queue.submit({
        streamId: 'stream-1',
        taskId: 'task-1',
        workerBranch: 'branch-1',
        workerAgentId: 'agent-1',
      });

      queue.markProcessing(mrId);
      queue.markConflict(mrId, []);

      const mr = queue.get(mrId);
      expect(mr!.conflictFiles).toEqual([]);
    });

    it('should handle conflict files with special characters', () => {
      const mrId = queue.submit({
        streamId: 'stream-1',
        taskId: 'task-1',
        workerBranch: 'branch-1',
        workerAgentId: 'agent-1',
      });

      const files = [
        'path/with spaces/file.ts',
        'path-with-dashes/file.ts',
        'unicode/日本語/file.ts',
        'emoji/🚀/file.ts',
      ];

      queue.markProcessing(mrId);
      queue.markConflict(mrId, files);

      const mr = queue.get(mrId);
      expect(mr!.conflictFiles).toEqual(files);
    });

    it('should handle many conflict files', () => {
      const mrId = queue.submit({
        streamId: 'stream-1',
        taskId: 'task-1',
        workerBranch: 'branch-1',
        workerAgentId: 'agent-1',
      });

      const files = Array.from({ length: 500 }, (_, i) => `path/to/file${i}.ts`);

      queue.markProcessing(mrId);
      queue.markConflict(mrId, files);

      const mr = queue.get(mrId);
      expect(mr!.conflictFiles!.length).toBe(500);
    });
  });

  // ===========================================================================
  // Resolver Task ID Tests (Missing Feature Tests)
  // ===========================================================================

  describe('resolver task ID handling', () => {
    it('should store resolver task ID when conflict is marked', () => {
      const mrId = queue.submit({
        streamId: 'stream-1',
        taskId: 'task-1',
        workerBranch: 'branch-1',
        workerAgentId: 'agent-1',
      });

      queue.markProcessing(mrId);
      queue.markConflict(mrId, ['file.ts'], 'resolver-task-123');

      const mr = queue.get(mrId);
      expect(mr!.resolverTaskId).toBe('resolver-task-123');
    });

    it('should emit resolver task ID in conflict event', () => {
      const events: MergeQueueEvent[] = [];
      queue.onEvent((event) => events.push(event));

      const mrId = queue.submit({
        streamId: 'stream-1',
        taskId: 'task-1',
        workerBranch: 'branch-1',
        workerAgentId: 'agent-1',
      });

      queue.markProcessing(mrId);
      queue.markConflict(mrId, ['file.ts'], 'resolver-task-456');

      const conflictEvent = events.find((e) => e.type === 'mr:conflict');
      expect(conflictEvent).toBeDefined();
      expect(conflictEvent!.data.resolverTaskId).toBe('resolver-task-456');
    });

    it('should handle undefined resolver task ID', () => {
      const mrId = queue.submit({
        streamId: 'stream-1',
        taskId: 'task-1',
        workerBranch: 'branch-1',
        workerAgentId: 'agent-1',
      });

      queue.markProcessing(mrId);
      queue.markConflict(mrId, ['file.ts']); // No resolver task ID

      const mr = queue.get(mrId);
      expect(mr!.resolverTaskId).toBeNull();
    });

    // This is an important test - the current implementation doesn't spawn resolvers
    it('should be possible to query MRs in conflict state awaiting resolution', () => {
      // Create multiple MRs, some with conflicts
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

      // Process and mark some as conflict
      queue.markProcessing(mr1);
      queue.markMerged(mr1, 'commit1');

      queue.markProcessing(mr2);
      queue.markConflict(mr2, ['file.ts'], 'resolver-1');

      queue.markProcessing(mr3);
      queue.markConflict(mr3, ['other.ts']); // No resolver

      // Query conflicts with resolver
      const conflictsWithResolver = queue.getPending('stream-1', {
        status: 'conflict',
      });

      expect(conflictsWithResolver.length).toBe(2);

      // Filter to those with resolvers
      const withResolver = conflictsWithResolver.filter(
        (mr) => mr.resolverTaskId !== null
      );
      expect(withResolver.length).toBe(1);
      expect(withResolver[0].resolverTaskId).toBe('resolver-1');
    });
  });

  // ===========================================================================
  // Stress Tests
  // ===========================================================================

  describe('stress tests', () => {
    it('should handle 100 concurrent submissions', () => {
      for (let i = 0; i < 100; i++) {
        queue.submit({
          streamId: 'stream-1',
          taskId: `task-${i}`,
          workerBranch: `branch-${i}`,
          workerAgentId: `agent-${i}`,
          priority: Math.floor(Math.random() * 100),
        });
      }

      expect(queue.getQueueDepth('stream-1')).toBe(100);

      // Process all
      const processed: string[] = [];
      while (true) {
        const next = queue.getNext('stream-1');
        if (!next) break;

        queue.markProcessing(next.id);
        queue.markMerged(next.id, `commit-${processed.length}`);
        processed.push(next.id);
      }

      expect(processed.length).toBe(100);
      expect(queue.getQueueDepth('stream-1')).toBe(0);
    });

    it('should handle many streams', () => {
      // Create 50 streams with 10 MRs each
      for (let s = 0; s < 50; s++) {
        for (let i = 0; i < 10; i++) {
          queue.submit({
            streamId: `stream-${s}`,
            taskId: `task-${s}-${i}`,
            workerBranch: `branch-${s}-${i}`,
            workerAgentId: `agent-${i}`,
          });
        }
      }

      // Check each stream
      for (let s = 0; s < 50; s++) {
        expect(queue.getQueueDepth(`stream-${s}`)).toBe(10);
      }

      // Process a single stream
      let processed = 0;
      while (true) {
        const next = queue.getNext('stream-25');
        if (!next) break;
        queue.markProcessing(next.id);
        queue.markMerged(next.id, `commit-${processed}`);
        processed++;
      }

      expect(processed).toBe(10);
      expect(queue.getQueueDepth('stream-25')).toBe(0);
      // Other streams untouched
      expect(queue.getQueueDepth('stream-0')).toBe(10);
    });
  });

  // ===========================================================================
  // Branch Name Edge Cases
  // ===========================================================================

  describe('branch name edge cases', () => {
    it('should handle branch names with slashes', () => {
      const mrId = queue.submit({
        streamId: 'stream-1',
        taskId: 'task-1',
        workerBranch: 'feature/user/auth/login',
        workerAgentId: 'agent-1',
      });

      const mr = queue.get(mrId);
      expect(mr!.workerBranch).toBe('feature/user/auth/login');
    });

    it('should handle branch names with special characters', () => {
      const mrId = queue.submit({
        streamId: 'stream-1',
        taskId: 'task-1',
        workerBranch: 'worker/agent-1/task-1@timestamp',
        workerAgentId: 'agent-1',
      });

      const mr = queue.get(mrId);
      expect(mr!.workerBranch).toBe('worker/agent-1/task-1@timestamp');
    });

    it('should handle very long branch names', () => {
      const longBranchName = 'feature/' + 'a'.repeat(200);
      const mrId = queue.submit({
        streamId: 'stream-1',
        taskId: 'task-1',
        workerBranch: longBranchName,
        workerAgentId: 'agent-1',
      });

      const mr = queue.get(mrId);
      expect(mr!.workerBranch).toBe(longBranchName);
    });
  });

  // ===========================================================================
  // Timing and Timestamps
  // ===========================================================================

  describe('timestamps', () => {
    it('should record accurate submittedAt timestamp', () => {
      const before = Date.now();
      const mrId = queue.submit({
        streamId: 'stream-1',
        taskId: 'task-1',
        workerBranch: 'branch-1',
        workerAgentId: 'agent-1',
      });
      const after = Date.now();

      const mr = queue.get(mrId);
      expect(mr!.submittedAt).toBeGreaterThanOrEqual(before);
      expect(mr!.submittedAt).toBeLessThanOrEqual(after);
    });

    it('should record accurate startedAt timestamp', () => {
      const mrId = queue.submit({
        streamId: 'stream-1',
        taskId: 'task-1',
        workerBranch: 'branch-1',
        workerAgentId: 'agent-1',
      });

      const before = Date.now();
      queue.markProcessing(mrId);
      const after = Date.now();

      const mr = queue.get(mrId);
      expect(mr!.startedAt).toBeGreaterThanOrEqual(before);
      expect(mr!.startedAt).toBeLessThanOrEqual(after);
    });

    it('should record accurate completedAt timestamp', () => {
      const mrId = queue.submit({
        streamId: 'stream-1',
        taskId: 'task-1',
        workerBranch: 'branch-1',
        workerAgentId: 'agent-1',
      });

      queue.markProcessing(mrId);

      const before = Date.now();
      queue.markMerged(mrId, 'commit123');
      const after = Date.now();

      const mr = queue.get(mrId);
      expect(mr!.completedAt).toBeGreaterThanOrEqual(before);
      expect(mr!.completedAt).toBeLessThanOrEqual(after);
    });
  });

  // ===========================================================================
  // Query Edge Cases
  // ===========================================================================

  describe('query edge cases', () => {
    it('should return empty array for getPending on empty stream', () => {
      const pending = queue.getPending('nonexistent-stream');
      expect(pending).toEqual([]);
    });

    it('should return 0 for getQueueDepth on empty stream', () => {
      const depth = queue.getQueueDepth('nonexistent-stream');
      expect(depth).toBe(0);
    });

    it('should return null for getNext on empty stream', () => {
      const next = queue.getNext('nonexistent-stream');
      expect(next).toBeNull();
    });

    it('should return null for getByTask with nonexistent task', () => {
      const mr = queue.getByTask('nonexistent-task');
      expect(mr).toBeNull();
    });

    it('should return first matching MR when multiple MRs have same taskId', () => {
      // This is an edge case - taskId should be unique, but what happens if it's not?
      // Submit two MRs with the same taskId
      const mr1 = queue.submit({
        streamId: 'stream-1',
        taskId: 'duplicate-task',
        workerBranch: 'branch-1',
        workerAgentId: 'agent-1',
      });
      const mr2 = queue.submit({
        streamId: 'stream-1',
        taskId: 'duplicate-task', // Same task ID
        workerBranch: 'branch-2',
        workerAgentId: 'agent-2',
      });

      // getByTask should return one of them (implementation detail: likely first)
      const result = queue.getByTask('duplicate-task');
      expect(result).not.toBeNull();
      expect(result!.taskId).toBe('duplicate-task');
      // Note: The returned MR could be either mr1 or mr2 depending on DB query order
      expect([mr1, mr2]).toContain(result!.id);
    });
  });

  // ===========================================================================
  // Position Ordering Edge Cases
  // ===========================================================================

  describe('position ordering edge cases', () => {
    it('should handle position gaps correctly (1, 3, 5)', () => {
      // Create MRs with non-contiguous positions
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

      // Set non-contiguous positions
      queue.reposition(mr1, 1);
      queue.reposition(mr2, 5);
      queue.reposition(mr3, 3);

      // Verify ordering: position 1 < 3 < 5
      const next1 = queue.getNext('stream-1');
      expect(next1!.id).toBe(mr1);
      queue.markProcessing(mr1);
      queue.markMerged(mr1, 'commit1');

      const next2 = queue.getNext('stream-1');
      expect(next2!.id).toBe(mr3); // Position 3 comes before position 5
      queue.markProcessing(mr3);
      queue.markMerged(mr3, 'commit3');

      const next3 = queue.getNext('stream-1');
      expect(next3!.id).toBe(mr2);
    });

    it('should handle mix of positioned and non-positioned MRs', () => {
      // MRs with positions should come before those without
      const mr1 = queue.submit({
        streamId: 'stream-1',
        taskId: 'task-1',
        workerBranch: 'branch-1',
        workerAgentId: 'agent-1',
        priority: 1, // High priority but no position
      });
      const mr2 = queue.submit({
        streamId: 'stream-1',
        taskId: 'task-2',
        workerBranch: 'branch-2',
        workerAgentId: 'agent-2',
        priority: 100, // Low priority but has position
      });
      const mr3 = queue.submit({
        streamId: 'stream-1',
        taskId: 'task-3',
        workerBranch: 'branch-3',
        workerAgentId: 'agent-3',
        priority: 50, // Medium priority, no position
      });

      // Set position only on mr2
      queue.reposition(mr2, 10);

      // MR with position (mr2) should come first, then priority-ordered (mr1, mr3)
      const next1 = queue.getNext('stream-1');
      expect(next1!.id).toBe(mr2); // Positioned first
      queue.markProcessing(mr2);
      queue.markMerged(mr2, 'commit2');

      const next2 = queue.getNext('stream-1');
      expect(next2!.id).toBe(mr1); // Then priority 1
      queue.markProcessing(mr1);
      queue.markMerged(mr1, 'commit1');

      const next3 = queue.getNext('stream-1');
      expect(next3!.id).toBe(mr3); // Then priority 50
    });
  });

  // ===========================================================================
  // Performance / Scale Tests
  // ===========================================================================

  describe('performance at scale', () => {
    it('should handle 1000 MRs in a single stream', () => {
      const count = 1000;
      const mrIds: string[] = [];

      // Submit many MRs
      const submitStart = Date.now();
      for (let i = 0; i < count; i++) {
        const mrId = queue.submit({
          streamId: 'stream-1',
          taskId: `task-${i}`,
          workerBranch: `branch-${i}`,
          workerAgentId: `agent-${i % 10}`,
          priority: Math.floor(Math.random() * 100),
        });
        mrIds.push(mrId);
      }
      const submitTime = Date.now() - submitStart;

      // Verify count
      expect(queue.getQueueDepth('stream-1')).toBe(count);

      // Test getNext performance
      const getNextStart = Date.now();
      for (let i = 0; i < 100; i++) {
        queue.getNext('stream-1');
      }
      const getNextTime = Date.now() - getNextStart;

      // Test getPending performance
      const getPendingStart = Date.now();
      const pending = queue.getPending('stream-1', { limit: 100 });
      const getPendingTime = Date.now() - getPendingStart;

      expect(pending.length).toBe(100);

      // Log performance metrics (informational)
      console.log(`Performance: submit ${count} MRs: ${submitTime}ms, 100 getNext: ${getNextTime}ms, getPending(100): ${getPendingTime}ms`);

      // Sanity check: operations should complete in reasonable time
      expect(submitTime).toBeLessThan(5000); // 5 seconds for 1000 inserts
      expect(getNextTime).toBeLessThan(1000); // 1 second for 100 queries
      expect(getPendingTime).toBeLessThan(500); // 500ms for single query
    });

    it('should maintain consistency during rapid status transitions', () => {
      const mrIds: string[] = [];

      // Submit 100 MRs
      for (let i = 0; i < 100; i++) {
        mrIds.push(
          queue.submit({
            streamId: 'stream-1',
            taskId: `task-${i}`,
            workerBranch: `branch-${i}`,
            workerAgentId: 'agent-1',
          })
        );
      }

      // Rapidly transition all through the state machine
      for (const mrId of mrIds) {
        queue.markProcessing(mrId);
        queue.markMerged(mrId, `commit-${mrId}`);
      }

      // Verify all are merged
      expect(queue.getQueueDepth('stream-1')).toBe(0);
      for (const mrId of mrIds) {
        const mr = queue.get(mrId);
        expect(mr!.status).toBe('merged');
        expect(mr!.mergeCommit).toBe(`commit-${mrId}`);
      }
    });
  });

  // ===========================================================================
  // Stale Processing Detection
  // ===========================================================================

  describe('stale processing detection', () => {
    it('should identify MRs stuck in processing state', () => {
      // This tests a common operational scenario: MRs that never complete

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

      // Mark as processing but never complete
      queue.markProcessing(mr1);
      queue.markProcessing(mr2);

      // Query for processing MRs (using getPending with status filter)
      // Note: getPending name is misleading - it can filter by any status
      const processing = queue.getPending('stream-1', { status: 'processing' });
      expect(processing.length).toBe(2);

      // In real usage, you'd check startedAt to find stale ones
      for (const mr of processing) {
        expect(mr.startedAt).not.toBeNull();
        expect(mr.status).toBe('processing');
        // Could implement: const isStale = Date.now() - mr.startedAt! > TIMEOUT;
      }
    });

    it('should allow abandoning stale processing MRs', () => {
      const mrId = queue.submit({
        streamId: 'stream-1',
        taskId: 'task-1',
        workerBranch: 'branch-1',
        workerAgentId: 'agent-1',
      });

      queue.markProcessing(mrId);

      // Simulate stale detection and recovery
      const mr = queue.get(mrId);
      expect(mr!.status).toBe('processing');

      // Mark as abandoned to recover
      queue.markAbandoned(mrId);

      const updated = queue.get(mrId);
      expect(updated!.status).toBe('abandoned');
      expect(updated!.completedAt).not.toBeNull();

      // Queue is now clear
      expect(queue.getQueueDepth('stream-1')).toBe(0);
    });
  });

  // ===========================================================================
  // markResolverComplete Edge Cases
  // ===========================================================================

  describe('markResolverComplete edge cases', () => {
    it('should allow resolver completion without resolverBranch', () => {
      const mrId = queue.submit({
        streamId: 'stream-1',
        taskId: 'task-1',
        workerBranch: 'branch-1',
        workerAgentId: 'agent-1',
      });
      queue.markProcessing(mrId);
      queue.markConflict(mrId, ['file.ts'], 'resolver-task-1');

      // Complete without resolverBranch
      queue.markResolverComplete(mrId, 'resolved-commit');

      const mr = queue.get(mrId);
      expect(mr!.status).toBe('merged');
      expect(mr!.mergeCommit).toBe('resolved-commit');
    });

    it('should emit mr:resolved event with all data', () => {
      const events: MergeQueueEvent[] = [];
      queue.onEvent((e) => events.push(e));

      const mrId = queue.submit({
        streamId: 'stream-1',
        taskId: 'task-1',
        workerBranch: 'branch-1',
        workerAgentId: 'agent-1',
      });
      queue.markProcessing(mrId);
      queue.markConflict(mrId, ['file.ts', 'file2.ts'], 'resolver-task-1');
      queue.markResolverComplete(mrId, 'resolved-commit', 'resolver/mr-abc@123');

      const resolvedEvent = events.find((e) => e.type === 'mr:resolved');
      expect(resolvedEvent).toBeDefined();
      expect(resolvedEvent!.data).toMatchObject({
        mrId,
        streamId: 'stream-1',
        taskId: 'task-1',
        mergeCommit: 'resolved-commit',
        resolverTaskId: 'resolver-task-1',
        resolverBranch: 'resolver/mr-abc@123',
      });
    });

    it('should handle resolver completion on conflict without resolverTaskId', () => {
      const mrId = queue.submit({
        streamId: 'stream-1',
        taskId: 'task-1',
        workerBranch: 'branch-1',
        workerAgentId: 'agent-1',
      });
      queue.markProcessing(mrId);
      queue.markConflict(mrId, ['file.ts']); // No resolver task ID

      // Still should be able to complete
      queue.markResolverComplete(mrId, 'manual-resolve-commit');

      const mr = queue.get(mrId);
      expect(mr!.status).toBe('merged');
      expect(mr!.resolverTaskId).toBeNull();
    });

    it('should reject resolver completion on non-existent MR', () => {
      expect(() => queue.markResolverComplete('nonexistent', 'commit')).toThrow(
        MergeRequestNotFoundError
      );
    });
  });
});
