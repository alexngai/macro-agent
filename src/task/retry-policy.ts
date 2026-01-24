/**
 * RetryPolicy - Framework for coordinator-orchestrated task retries
 *
 * Provides retry policy configuration, state tracking, and helper functions
 * for implementing exponential backoff retry logic.
 *
 * @module task/retry-policy
 * @see s-5yhx Phase B: Monitor Active Behaviors
 */

import type {
  Task,
  Timestamp,
  RetryPolicy,
  RetryState,
} from "../store/types/index.js";

// Re-export types for convenience
export type { RetryPolicy, RetryState } from "../store/types/index.js";

/**
 * Reason for triggering a retry check
 */
export type RetryReason = "failed" | "stalled";

// =============================================================================
// Default Configuration
// =============================================================================

/**
 * Default retry policy values
 */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 0,
  retryOn: [],
  backoffMs: 1000,
  backoffMultiplier: 2,
  maxBackoffMs: 60000,
};

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Create a default retry policy (no retries)
 *
 * @returns A retry policy with all defaults
 */
export function createDefaultRetryPolicy(): RetryPolicy {
  return { ...DEFAULT_RETRY_POLICY };
}

/**
 * Create a standard retry policy for resilient tasks
 *
 * @param maxRetries - Maximum retry attempts (default: 3)
 * @returns A retry policy configured for both failed and stalled conditions
 */
export function createStandardRetryPolicy(maxRetries = 3): RetryPolicy {
  return {
    maxRetries,
    retryOn: ["failed", "stalled"],
    backoffMs: 1000,
    backoffMultiplier: 2,
    maxBackoffMs: 60000,
  };
}

/**
 * Determine if a task should be retried based on the reason
 *
 * @param task - The task to check
 * @param reason - Why retry is being considered ('failed' or 'stalled')
 * @returns true if the task should be retried
 */
export function shouldRetry(task: Task, reason: RetryReason): boolean {
  const policy = task.retryPolicy;

  // No policy means no retry
  if (!policy) {
    return false;
  }

  // Check if this reason triggers retry
  if (!policy.retryOn.includes(reason)) {
    return false;
  }

  // Check if we've exceeded max retries
  const attemptCount = task.retryState?.attemptCount ?? 0;
  if (attemptCount >= policy.maxRetries) {
    return false;
  }

  return true;
}

/**
 * Calculate the backoff delay for the next retry attempt
 *
 * Uses exponential backoff with jitter:
 * delay = min(backoffMs * (backoffMultiplier ^ attemptCount), maxBackoffMs)
 * with ±10% jitter
 *
 * @param attemptCount - Number of attempts already made
 * @param policy - The retry policy configuration
 * @returns Delay in milliseconds before next retry
 */
export function calculateBackoff(
  attemptCount: number,
  policy: RetryPolicy
): number {
  // Calculate base delay with exponential backoff
  const baseDelay =
    policy.backoffMs * Math.pow(policy.backoffMultiplier, attemptCount);

  // Cap at maximum
  const cappedDelay = Math.min(baseDelay, policy.maxBackoffMs);

  // Add ±10% jitter to prevent thundering herd
  const jitter = cappedDelay * 0.1 * (Math.random() * 2 - 1);
  const finalDelay = Math.round(cappedDelay + jitter);

  // Ensure we never go below 0 or above max
  return Math.max(0, Math.min(finalDelay, policy.maxBackoffMs));
}

/**
 * Get the number of remaining retry attempts for a task
 *
 * @param task - The task to check
 * @returns Number of remaining retries, or 0 if no policy
 */
export function getRemainingRetries(task: Task): number {
  if (!task.retryPolicy) {
    return 0;
  }

  const attemptCount = task.retryState?.attemptCount ?? 0;
  return Math.max(0, task.retryPolicy.maxRetries - attemptCount);
}

/**
 * Create initial retry state for a task
 *
 * @returns Fresh retry state with zero attempts
 */
export function createInitialRetryState(): RetryState {
  return {
    attemptCount: 0,
    lastAttemptAt: Date.now(),
  };
}

/**
 * Update retry state after a failed attempt
 *
 * @param currentState - Current retry state (or undefined for first attempt)
 * @param error - Optional error message from the failure
 * @param nextRetryAt - Optional timestamp for next scheduled retry
 * @returns Updated retry state
 */
export function updateRetryState(
  currentState: RetryState | undefined,
  error?: string,
  nextRetryAt?: Timestamp
): RetryState {
  return {
    attemptCount: (currentState?.attemptCount ?? 0) + 1,
    lastAttemptAt: Date.now(),
    lastError: error,
    nextRetryAt,
  };
}

/**
 * Check if a task is currently in a retry waiting period
 *
 * @param task - The task to check
 * @returns true if waiting for retry, false otherwise
 */
export function isWaitingForRetry(task: Task): boolean {
  if (!task.retryState?.nextRetryAt) {
    return false;
  }

  return Date.now() < task.retryState.nextRetryAt;
}

/**
 * Get time until next retry is allowed (in ms)
 *
 * @param task - The task to check
 * @returns Milliseconds until next retry, or 0 if can retry now
 */
export function getTimeUntilRetry(task: Task): number {
  if (!task.retryState?.nextRetryAt) {
    return 0;
  }

  const remaining = task.retryState.nextRetryAt - Date.now();
  return Math.max(0, remaining);
}
