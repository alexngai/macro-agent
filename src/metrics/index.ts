/**
 * Metrics module — observability for macro-agent.
 *
 * @module metrics
 */

export { collectMetrics } from "./metrics.js";
export type {
  AgentMetrics,
  TaskMetrics,
  SystemMetrics,
  MetricsSnapshot,
} from "./types.js";
