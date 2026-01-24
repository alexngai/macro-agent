/**
 * Tests for RetryPolicy framework
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  DEFAULT_RETRY_POLICY,
  createDefaultRetryPolicy,
  createStandardRetryPolicy,
  shouldRetry,
  calculateBackoff,
  getRemainingRetries,
  createInitialRetryState,
  updateRetryState,
  isWaitingForRetry,
  getTimeUntilRetry,
} from "../retry-policy.js";
import type { Task } from "../../store/types/index.js";

// =============================================================================
// Mock Factories
// =============================================================================

function createMockTask(overrides: Partial<Task> = {}): Task {
  return {
    id: `task_${Math.random().toString(36).slice(2, 8)}`,
    description: "Test task",
    status: "pending",
    created_at: Date.now() - 60000,
    created_by: "agent_test",
    ...overrides,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe("RetryPolicy", () => {
  describe("DEFAULT_RETRY_POLICY", () => {
    it("should have sensible defaults", () => {
      expect(DEFAULT_RETRY_POLICY.maxRetries).toBe(0);
      expect(DEFAULT_RETRY_POLICY.retryOn).toEqual([]);
      expect(DEFAULT_RETRY_POLICY.backoffMs).toBe(1000);
      expect(DEFAULT_RETRY_POLICY.backoffMultiplier).toBe(2);
      expect(DEFAULT_RETRY_POLICY.maxBackoffMs).toBe(60000);
    });
  });

  describe("createDefaultRetryPolicy", () => {
    it("should return a copy of default policy", () => {
      const policy = createDefaultRetryPolicy();

      expect(policy).toEqual(DEFAULT_RETRY_POLICY);
      expect(policy).not.toBe(DEFAULT_RETRY_POLICY);
    });
  });

  describe("createStandardRetryPolicy", () => {
    it("should create policy with default maxRetries of 3", () => {
      const policy = createStandardRetryPolicy();

      expect(policy.maxRetries).toBe(3);
      expect(policy.retryOn).toEqual(["failed", "stalled"]);
      expect(policy.backoffMs).toBe(1000);
      expect(policy.backoffMultiplier).toBe(2);
      expect(policy.maxBackoffMs).toBe(60000);
    });

    it("should accept custom maxRetries", () => {
      const policy = createStandardRetryPolicy(5);

      expect(policy.maxRetries).toBe(5);
    });
  });

  describe("shouldRetry", () => {
    it("should return false when no retry policy", () => {
      const task = createMockTask();

      expect(shouldRetry(task, "failed")).toBe(false);
      expect(shouldRetry(task, "stalled")).toBe(false);
    });

    it("should return false when reason not in retryOn", () => {
      const task = createMockTask({
        retryPolicy: {
          maxRetries: 3,
          retryOn: ["failed"],
          backoffMs: 1000,
          backoffMultiplier: 2,
          maxBackoffMs: 60000,
        },
      });

      expect(shouldRetry(task, "stalled")).toBe(false);
    });

    it("should return true when reason matches and retries remaining", () => {
      const task = createMockTask({
        retryPolicy: createStandardRetryPolicy(),
      });

      expect(shouldRetry(task, "failed")).toBe(true);
      expect(shouldRetry(task, "stalled")).toBe(true);
    });

    it("should return false when max retries exceeded", () => {
      const task = createMockTask({
        retryPolicy: {
          maxRetries: 2,
          retryOn: ["failed"],
          backoffMs: 1000,
          backoffMultiplier: 2,
          maxBackoffMs: 60000,
        },
        retryState: {
          attemptCount: 2,
          lastAttemptAt: Date.now(),
        },
      });

      expect(shouldRetry(task, "failed")).toBe(false);
    });

    it("should return true when attempts less than max", () => {
      const task = createMockTask({
        retryPolicy: {
          maxRetries: 3,
          retryOn: ["failed"],
          backoffMs: 1000,
          backoffMultiplier: 2,
          maxBackoffMs: 60000,
        },
        retryState: {
          attemptCount: 2,
          lastAttemptAt: Date.now(),
        },
      });

      expect(shouldRetry(task, "failed")).toBe(true);
    });
  });

  describe("calculateBackoff", () => {
    const policy = {
      maxRetries: 5,
      retryOn: ["failed"] as ("failed" | "stalled")[],
      backoffMs: 1000,
      backoffMultiplier: 2,
      maxBackoffMs: 60000,
    };

    it("should return initial backoff for first attempt", () => {
      // Due to jitter, we check the value is close to expected
      const backoff = calculateBackoff(0, policy);

      // 1000 ± 10%
      expect(backoff).toBeGreaterThanOrEqual(900);
      expect(backoff).toBeLessThanOrEqual(1100);
    });

    it("should apply exponential backoff", () => {
      const backoff1 = calculateBackoff(1, policy);
      const backoff2 = calculateBackoff(2, policy);
      const backoff3 = calculateBackoff(3, policy);

      // With jitter, these should be approximately:
      // 2000 ± 10%, 4000 ± 10%, 8000 ± 10%
      expect(backoff1).toBeGreaterThanOrEqual(1800);
      expect(backoff1).toBeLessThanOrEqual(2200);

      expect(backoff2).toBeGreaterThanOrEqual(3600);
      expect(backoff2).toBeLessThanOrEqual(4400);

      expect(backoff3).toBeGreaterThanOrEqual(7200);
      expect(backoff3).toBeLessThanOrEqual(8800);
    });

    it("should cap at maxBackoffMs", () => {
      // With multiplier of 2 and base 1000:
      // attempt 10 would be 1000 * 2^10 = 1024000ms
      // But max is 60000, so should be capped (with jitter)
      const backoff = calculateBackoff(10, policy);

      expect(backoff).toBeLessThanOrEqual(60000);
      expect(backoff).toBeGreaterThanOrEqual(54000); // 60000 - 10%
    });

    it("should never return negative values", () => {
      // Test many times due to random jitter
      for (let i = 0; i < 100; i++) {
        const backoff = calculateBackoff(0, policy);
        expect(backoff).toBeGreaterThanOrEqual(0);
      }
    });
  });

  describe("getRemainingRetries", () => {
    it("should return 0 when no retry policy", () => {
      const task = createMockTask();

      expect(getRemainingRetries(task)).toBe(0);
    });

    it("should return full count when no attempts made", () => {
      const task = createMockTask({
        retryPolicy: createStandardRetryPolicy(5),
      });

      expect(getRemainingRetries(task)).toBe(5);
    });

    it("should return remaining count after attempts", () => {
      const task = createMockTask({
        retryPolicy: createStandardRetryPolicy(5),
        retryState: {
          attemptCount: 2,
          lastAttemptAt: Date.now(),
        },
      });

      expect(getRemainingRetries(task)).toBe(3);
    });

    it("should return 0 when all retries exhausted", () => {
      const task = createMockTask({
        retryPolicy: createStandardRetryPolicy(3),
        retryState: {
          attemptCount: 3,
          lastAttemptAt: Date.now(),
        },
      });

      expect(getRemainingRetries(task)).toBe(0);
    });

    it("should not return negative values", () => {
      const task = createMockTask({
        retryPolicy: createStandardRetryPolicy(3),
        retryState: {
          attemptCount: 10, // More than max
          lastAttemptAt: Date.now(),
        },
      });

      expect(getRemainingRetries(task)).toBe(0);
    });
  });

  describe("createInitialRetryState", () => {
    it("should create state with zero attempts", () => {
      const state = createInitialRetryState();

      expect(state.attemptCount).toBe(0);
      expect(state.lastAttemptAt).toBeCloseTo(Date.now(), -2);
      expect(state.lastError).toBeUndefined();
      expect(state.nextRetryAt).toBeUndefined();
    });
  });

  describe("updateRetryState", () => {
    it("should increment attempt count from undefined", () => {
      const state = updateRetryState(undefined);

      expect(state.attemptCount).toBe(1);
    });

    it("should increment attempt count from existing", () => {
      const current = {
        attemptCount: 2,
        lastAttemptAt: Date.now() - 10000,
      };

      const state = updateRetryState(current);

      expect(state.attemptCount).toBe(3);
    });

    it("should record error message", () => {
      const state = updateRetryState(undefined, "Connection refused");

      expect(state.lastError).toBe("Connection refused");
    });

    it("should record next retry time", () => {
      const nextRetry = Date.now() + 5000;
      const state = updateRetryState(undefined, undefined, nextRetry);

      expect(state.nextRetryAt).toBe(nextRetry);
    });

    it("should update lastAttemptAt to now", () => {
      const state = updateRetryState(undefined);

      expect(state.lastAttemptAt).toBeCloseTo(Date.now(), -2);
    });
  });

  describe("isWaitingForRetry", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("should return false when no retry state", () => {
      const task = createMockTask();

      expect(isWaitingForRetry(task)).toBe(false);
    });

    it("should return false when no nextRetryAt", () => {
      const task = createMockTask({
        retryState: {
          attemptCount: 1,
          lastAttemptAt: Date.now(),
        },
      });

      expect(isWaitingForRetry(task)).toBe(false);
    });

    it("should return true when nextRetryAt is in the future", () => {
      vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));

      const task = createMockTask({
        retryState: {
          attemptCount: 1,
          lastAttemptAt: Date.now(),
          nextRetryAt: Date.now() + 5000,
        },
      });

      expect(isWaitingForRetry(task)).toBe(true);
    });

    it("should return false when nextRetryAt has passed", () => {
      vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));

      const task = createMockTask({
        retryState: {
          attemptCount: 1,
          lastAttemptAt: Date.now() - 10000,
          nextRetryAt: Date.now() - 5000,
        },
      });

      expect(isWaitingForRetry(task)).toBe(false);
    });
  });

  describe("getTimeUntilRetry", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("should return 0 when no retry state", () => {
      const task = createMockTask();

      expect(getTimeUntilRetry(task)).toBe(0);
    });

    it("should return 0 when no nextRetryAt", () => {
      const task = createMockTask({
        retryState: {
          attemptCount: 1,
          lastAttemptAt: Date.now(),
        },
      });

      expect(getTimeUntilRetry(task)).toBe(0);
    });

    it("should return remaining time", () => {
      vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));

      const task = createMockTask({
        retryState: {
          attemptCount: 1,
          lastAttemptAt: Date.now(),
          nextRetryAt: Date.now() + 5000,
        },
      });

      expect(getTimeUntilRetry(task)).toBe(5000);
    });

    it("should return 0 when nextRetryAt has passed", () => {
      vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));

      const task = createMockTask({
        retryState: {
          attemptCount: 1,
          lastAttemptAt: Date.now() - 10000,
          nextRetryAt: Date.now() - 5000,
        },
      });

      expect(getTimeUntilRetry(task)).toBe(0);
    });
  });
});
