/**
 * StallDetector - Detects stalled agents and cleans up zombies
 *
 * A stalled agent is one that:
 * - Has no recent activity (lastActivityAt is stale)
 * - Is not actively processing a prompt (isProcessing is false)
 *
 * A zombie agent is one that:
 * - Has state 'stopped' in EventStore
 * - But still has a session mapping in SessionMapper
 *
 * @module monitor/stall-detector
 * @see s-5yhx Phase B: Monitor Active Behaviors
 */

import type { EventStore } from "../store/event-store.js";
import type { SessionMapper } from "../acp/session-mapper.js";
import type { AgentId, TaskId, Timestamp } from "../store/types/index.js";

// =============================================================================
// Types
// =============================================================================

/**
 * Information about a stalled agent
 */
export interface StalledAgent {
  /** The stalled agent's ID */
  agentId: AgentId;

  /** The coordinator this worker belongs to */
  coordinatorId: AgentId;

  /** Last time the agent had activity */
  lastActivityAt: Timestamp;

  /** How long the agent has been stalled (ms) */
  stalledDurationMs: number;

  /** Task the agent was assigned to (if any) */
  assignedTaskId?: TaskId;

  /** Session processing status */
  sessionStatus: "processing" | "idle" | "unknown";
}

/**
 * Information about a zombie agent
 */
export interface ZombieAgent {
  /** The zombie agent's ID */
  agentId: AgentId;

  /** When the agent stopped */
  stoppedAt: Timestamp;

  /** The orphaned ACP session ID */
  acpSessionId: string;

  /** Why the agent stopped */
  reason: "done_called" | "parent_terminated" | "unknown";
}

/**
 * Configuration for stall detection
 */
export interface StallDetectorConfig {
  /**
   * How long without activity before an agent is considered stalled (ms)
   * Default: 600000 (10 minutes)
   */
  stalledThresholdMs: number;
}

/**
 * Default configuration values
 */
export const DEFAULT_STALL_DETECTOR_CONFIG: StallDetectorConfig = {
  stalledThresholdMs: 10 * 60 * 1000, // 10 minutes
};

// =============================================================================
// StallDetector Class
// =============================================================================

/**
 * Detects stalled agents and cleans up zombie sessions
 */
export class StallDetector {
  private readonly eventStore: EventStore;
  private readonly sessionMapper: SessionMapper;
  private readonly config: StallDetectorConfig;

  constructor(
    eventStore: EventStore,
    sessionMapper: SessionMapper,
    config: Partial<StallDetectorConfig> = {}
  ) {
    this.eventStore = eventStore;
    this.sessionMapper = sessionMapper;
    this.config = { ...DEFAULT_STALL_DETECTOR_CONFIG, ...config };
  }

  /**
   * Detect stalled workers under a coordinator
   *
   * A worker is considered stalled if:
   * 1. It's in 'running' state
   * 2. Its lastActivityAt is older than stalledThresholdMs
   * 3. Its session is NOT currently processing a prompt
   *
   * @param coordinatorId - The coordinator whose workers to check
   * @returns Array of stalled agents
   */
  detectStalled(coordinatorId: AgentId): StalledAgent[] {
    const now = Date.now();
    const workers = this.eventStore.listAgents({
      parent: coordinatorId,
      state: "running",
    });

    const stalled: StalledAgent[] = [];

    for (const worker of workers) {
      // Use lastActivityAt if available, otherwise fall back to created_at
      const lastActivity = worker.last_activity_at ?? worker.created_at;
      const stalledMs = now - lastActivity;

      // Check if the agent has been inactive long enough
      if (stalledMs > this.config.stalledThresholdMs) {
        // Get session status to see if it's actually processing
        const sessionStatus = this.sessionMapper.getSessionStatus(worker.id);

        // Only mark as stalled if NOT processing
        // If processing, the agent is actively working even if lastActivityAt is stale
        if (!sessionStatus?.isProcessing) {
          stalled.push({
            agentId: worker.id,
            coordinatorId,
            lastActivityAt: lastActivity,
            stalledDurationMs: stalledMs,
            assignedTaskId: worker.task_id,
            sessionStatus: sessionStatus ? "idle" : "unknown",
          });
        }
      }
    }

    return stalled;
  }

  /**
   * Detect all stalled agents across all coordinators
   *
   * @returns Array of all stalled agents
   */
  detectAllStalled(): StalledAgent[] {
    const allStalled: StalledAgent[] = [];

    // Find all coordinators (agents with role 'coordinator')
    const coordinators = this.eventStore.listAgents({ state: "running" });
    const coordinatorIds = coordinators
      .filter((a) => a.role === "coordinator")
      .map((a) => a.id);

    for (const coordinatorId of coordinatorIds) {
      const stalled = this.detectStalled(coordinatorId);
      allStalled.push(...stalled);
    }

    return allStalled;
  }

  /**
   * Detect and clean up zombie agents
   *
   * A zombie is an agent that:
   * - Is in 'stopped' state in EventStore
   * - Still has a session mapping in SessionMapper
   *
   * This can happen if an agent terminates but the session cleanup fails.
   *
   * @returns Array of cleaned up zombie agents
   */
  cleanupZombies(): ZombieAgent[] {
    const zombies: ZombieAgent[] = [];

    // Get all stopped agents
    const stoppedAgents = this.eventStore.listAgents({ state: "stopped" });

    for (const agent of stoppedAgents) {
      // Check if there are any sessions still mapped to this agent
      const sessions = this.sessionMapper.getSessionsForAgent(agent.id);

      if (sessions.length > 0) {
        // Determine stop reason
        let reason: ZombieAgent["reason"] = "unknown";
        if (agent.stop_reason === "completed") {
          reason = "done_called";
        } else if (
          agent.stop_reason === "stopped" ||
          agent.stop_reason === "cancelled"
        ) {
          reason = "parent_terminated";
        }

        // Record the zombie
        zombies.push({
          agentId: agent.id,
          stoppedAt: agent.stopped_at ?? Date.now(),
          acpSessionId: sessions[0],
          reason,
        });

        // Clean up all orphaned session mappings for this agent
        for (const sessionId of sessions) {
          this.sessionMapper.removeMapping(sessionId);
        }
      }
    }

    return zombies;
  }

  /**
   * Get the current configuration
   */
  getConfig(): StallDetectorConfig {
    return { ...this.config };
  }

  /**
   * Update the configuration
   */
  updateConfig(config: Partial<StallDetectorConfig>): void {
    Object.assign(this.config, config);
  }
}
