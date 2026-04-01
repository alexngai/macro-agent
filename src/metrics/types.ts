/**
 * Metrics type definitions.
 *
 * @module metrics/types
 */

// ─────────────────────────────────────────────────────────────────
// Agent Metrics
// ─────────────────────────────────────────────────────────────────

export interface AgentMetrics {
  /** Total number of agents. */
  total: number;
  /** Count of agents by state (e.g., running, stopped). */
  byState: Record<string, number>;
  /** Count of agents by role (e.g., worker, coordinator). */
  byRole: Record<string, number>;
  /** Count of agents by team. */
  byTeam: Record<string, number>;
  /** Number of agents with stale MCP heartbeats. */
  unhealthy: number;
}

// ─────────────────────────────────────────────────────────────────
// Task Metrics
// ─────────────────────────────────────────────────────────────────

export interface TaskMetrics {
  /** Count of tasks by status (open, in_progress, blocked, closed). */
  byStatus: Record<string, number>;
  /** Number of tasks ready to be worked on (no active blockers). */
  ready: number;
  /** Number of blocked tasks. */
  blocked: number;
}

// ─────────────────────────────────────────────────────────────────
// System Metrics
// ─────────────────────────────────────────────────────────────────

export interface SystemMetrics {
  /** Uptime in milliseconds since boot. */
  uptime: number;
  /** Number of agents with queued trigger events. */
  triggerQueueDepth: number;
  /** Number of registered cron jobs. */
  cronJobCount: number;
}

// ─────────────────────────────────────────────────────────────────
// Snapshot
// ─────────────────────────────────────────────────────────────────

export interface MetricsSnapshot {
  /** ISO timestamp of when this snapshot was collected. */
  timestamp: string;
  /** Agent metrics. */
  agents: AgentMetrics;
  /** Task metrics, or null if opentasks is unavailable. */
  tasks: TaskMetrics | null;
  /** System-level metrics. */
  system: SystemMetrics;
}
