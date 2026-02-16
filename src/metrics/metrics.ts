/**
 * Metrics Module
 *
 * Computes throughput, utilization, and error metrics from EventStore data.
 * No new events needed — aggregates existing spawn, terminate, task, and
 * status events.
 *
 * @module metrics/metrics
 */

import type { EventStore } from "../store/event-store.js";
import type { Agent } from "../store/types/index.js";

// =============================================================================
// Types
// =============================================================================

export interface ThroughputMetrics {
  /** Tasks completed in the time window */
  tasksCompleted: number;

  /** Tasks failed in the time window */
  tasksFailed: number;

  /** Total tasks created in the time window */
  tasksCreated: number;

  /** Average completion time in ms (completed tasks only) */
  avgCompletionTimeMs: number | null;

  /** Tasks per minute (completed) */
  completedPerMinute: number;

  /** Time window start */
  windowStart: number;

  /** Time window end */
  windowEnd: number;
}

export interface UtilizationMetrics {
  /** Currently running agents */
  activeAgents: number;

  /** Total agents spawned in the time window */
  totalSpawned: number;

  /** Total agents stopped in the time window */
  totalStopped: number;

  /** Agents by role */
  agentsByRole: Record<string, number>;

  /** Agents by state */
  agentsByState: Record<string, number>;
}

export interface ErrorMetrics {
  /** Total errors in the time window */
  totalErrors: number;

  /** Errors by type */
  errorsByType: Record<string, number>;

  /** Recent errors (last N) */
  recentErrors: ErrorEntry[];
}

export interface ErrorEntry {
  /** Timestamp */
  timestamp: number;

  /** Agent ID */
  agentId: string;

  /** Error type/category */
  type: string;

  /** Error summary */
  summary: string;
}

// =============================================================================
// Implementation
// =============================================================================

/**
 * Compute throughput metrics for a time window.
 *
 * @param eventStore - EventStore to query
 * @param windowMs - Time window in milliseconds (default: 5 minutes)
 */
export function getThroughputMetrics(
  eventStore: EventStore,
  windowMs: number = 5 * 60 * 1000
): ThroughputMetrics {
  const now = Date.now();
  const windowStart = now - windowMs;

  const taskEvents = eventStore.query({
    type: "task",
    after: windowStart,
  });

  let tasksCompleted = 0;
  let tasksFailed = 0;
  let tasksCreated = 0;
  let totalCompletionTimeMs = 0;
  let completedWithTime = 0;

  for (const event of taskEvents) {
    const action = event.payload?.action as string | undefined;

    if (action === "created") {
      tasksCreated++;
    } else if (action === "completed") {
      tasksCompleted++;

      // Try to compute completion time
      const taskId = event.payload?.task_id as string | undefined;
      if (taskId) {
        const task = eventStore.getTask(taskId);
        if (task?.created_at && task?.completed_at) {
          totalCompletionTimeMs += task.completed_at - task.created_at;
          completedWithTime++;
        }
      }
    } else if (action === "failed") {
      tasksFailed++;
    }
  }

  const windowMinutes = windowMs / 60000;
  const completedPerMinute =
    windowMinutes > 0 ? tasksCompleted / windowMinutes : 0;

  return {
    tasksCompleted,
    tasksFailed,
    tasksCreated,
    avgCompletionTimeMs:
      completedWithTime > 0
        ? Math.round(totalCompletionTimeMs / completedWithTime)
        : null,
    completedPerMinute: Math.round(completedPerMinute * 100) / 100,
    windowStart,
    windowEnd: now,
  };
}

/**
 * Compute utilization metrics (current snapshot + window).
 *
 * @param eventStore - EventStore to query
 * @param windowMs - Time window for spawn/stop counts (default: 5 minutes)
 */
export function getUtilizationMetrics(
  eventStore: EventStore,
  windowMs: number = 5 * 60 * 1000
): UtilizationMetrics {
  const now = Date.now();
  const windowStart = now - windowMs;

  // Current agents
  const allAgents = eventStore.listAgents();
  const activeAgents = allAgents.filter(
    (a: Agent) => a.state === "running" || a.state === "spawning"
  );

  // Agents by role
  const agentsByRole: Record<string, number> = {};
  for (const agent of activeAgents) {
    const role = agent.role ?? "unknown";
    agentsByRole[role] = (agentsByRole[role] ?? 0) + 1;
  }

  // Agents by state
  const agentsByState: Record<string, number> = {};
  for (const agent of allAgents) {
    agentsByState[agent.state] = (agentsByState[agent.state] ?? 0) + 1;
  }

  // Count spawn and terminate events in window
  const spawnEvents = eventStore.query({
    type: "spawn",
    after: windowStart,
  });
  const terminateEvents = eventStore.query({
    type: "stop",
    after: windowStart,
  });

  return {
    activeAgents: activeAgents.length,
    totalSpawned: spawnEvents.length,
    totalStopped: terminateEvents.length,
    agentsByRole,
    agentsByState,
  };
}

/**
 * Compute error metrics for a time window.
 *
 * @param eventStore - EventStore to query
 * @param windowMs - Time window in milliseconds (default: 30 minutes)
 * @param maxRecent - Maximum recent errors to return (default: 20)
 */
export function getErrorMetrics(
  eventStore: EventStore,
  windowMs: number = 30 * 60 * 1000,
  maxRecent: number = 20
): ErrorMetrics {
  const now = Date.now();
  const windowStart = now - windowMs;

  // Query status events that indicate errors
  const statusEvents = eventStore.query({
    type: "status",
    after: windowStart,
  });

  const errors: ErrorEntry[] = [];
  const errorsByType: Record<string, number> = {};

  for (const event of statusEvents) {
    const statusType = event.payload?.status_type as string | undefined;
    if (statusType !== "failed") continue;

    const agentId =
      (event.source as { agent_id?: string })?.agent_id ?? "unknown";
    const summary =
      (event.payload?.summary as string) ?? "Unknown error";
    const errorType =
      (event.payload?.details as Record<string, unknown>)?.signal as string ??
      "agent_failed";

    errors.push({
      timestamp: event.timestamp,
      agentId,
      type: errorType,
      summary,
    });

    errorsByType[errorType] = (errorsByType[errorType] ?? 0) + 1;
  }

  // Also count task failures
  const taskEvents = eventStore.query({
    type: "task",
    after: windowStart,
  });

  for (const event of taskEvents) {
    if (event.payload?.action !== "failed") continue;

    const agentId =
      (event.source as { agent_id?: string })?.agent_id ?? "unknown";
    const taskId = (event.payload?.task_id as string) ?? "unknown";

    errors.push({
      timestamp: event.timestamp,
      agentId,
      type: "task_failed",
      summary: `Task ${taskId} failed`,
    });

    errorsByType["task_failed"] = (errorsByType["task_failed"] ?? 0) + 1;
  }

  // Sort by timestamp descending and limit
  errors.sort((a, b) => b.timestamp - a.timestamp);
  const recentErrors = errors.slice(0, maxRecent);

  return {
    totalErrors: errors.length,
    errorsByType,
    recentErrors,
  };
}
