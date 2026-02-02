/**
 * Trigger Wake System Types
 *
 * Types for the wake manager that handles polling agents
 * with pending events and delivering them.
 *
 * @module trigger/wake/types
 */

import type { AgentId } from "../../store/types/index.js";

// =============================================================================
// Wake Manager Types
// =============================================================================

/**
 * Wake request for immediate agent activation
 */
export interface WakeRequest {
  /** Reason for the wake request */
  reason: string;
  /** Source component requesting wake */
  source?: string;
  /** Optional specific agent to wake */
  agentId?: AgentId;
  /** Coalesce delay in ms (default: 250) */
  coalesceMs?: number;
}

/**
 * Result of a wake operation
 */
export interface WakeResult {
  status: "ran" | "skipped" | "failed";
  /** Duration if ran */
  durationMs?: number;
  /** Reason if skipped or failed */
  reason?: string;
  /** Agents that were woken */
  wokenAgents?: AgentId[];
}

/**
 * Wake handler function type
 */
export type WakeHandler = (opts: { reason?: string }) => Promise<WakeResult>;

/**
 * Wake manager configuration
 */
export interface WakeManagerConfig {
  /** Enable periodic heartbeat polling */
  enableHeartbeat?: boolean;
  /** Heartbeat interval in ms (default: 30000) */
  heartbeatIntervalMs?: number;
  /** Coalesce window for wake requests (default: 250) */
  defaultCoalesceMs?: number;
  /** Maximum retry delay for failed wakes (default: 5000) */
  maxRetryDelayMs?: number;
  /** Log wake operations */
  enableLogging?: boolean;
}

/**
 * Wake manager interface
 */
export interface TriggerWakeManager {
  /**
   * Request an immediate wake cycle
   * @param request - Wake request details
   */
  requestWakeNow(request?: WakeRequest): void;

  /**
   * Check if a wake is pending
   * @returns True if wake is scheduled
   */
  hasPendingWake(): boolean;

  /**
   * Run a single wake cycle immediately
   * @param opts - Optional reason for the cycle
   * @returns Wake result
   */
  runWakeCycle(opts?: { reason?: string }): Promise<WakeResult>;

  /**
   * Start the wake manager (enables heartbeat if configured)
   */
  start(): void;

  /**
   * Stop the wake manager
   */
  stop(): void;

  /**
   * Check if manager is running
   */
  isRunning(): boolean;

  /**
   * Get pending wake reason if any
   */
  getPendingReason(): string | null;
}

// =============================================================================
// Drain Result Types
// =============================================================================

/**
 * Result of draining events for a single agent
 */
export interface AgentDrainResult {
  agentId: AgentId;
  eventCount: number;
  deliveryMethod: "inject" | "interrupt" | "prompt" | "queued";
  success: boolean;
  error?: string;
}

/**
 * Result of a full wake cycle
 */
export interface WakeCycleResult {
  /** Agents processed */
  agentsProcessed: AgentId[];
  /** Successful deliveries */
  successfulDeliveries: AgentDrainResult[];
  /** Failed deliveries */
  failedDeliveries: AgentDrainResult[];
  /** Total duration */
  durationMs: number;
}
