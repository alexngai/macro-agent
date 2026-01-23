/**
 * HealthCheckService - Per-coordinator health check timer service
 *
 * Runs periodic health checks for worker agents under each coordinator:
 * - Detects stalled agents (no activity + not processing)
 * - Tracks consecutive failures before escalating
 * - Emits STALE_AGENT signals for coordinator remediation
 * - Cleans up zombie sessions periodically
 *
 * @module monitor/health-check-service
 * @see s-5yhx Phase B: Monitor Active Behaviors
 */

import type { EventStore } from "../store/event-store.js";
import type { SessionMapper } from "../acp/session-mapper.js";
import type { MessageRouter } from "../router/message-router.js";
import type { AgentId, Timestamp } from "../store/types/index.js";
import { StallDetector, type StalledAgent } from "./stall-detector.js";

// =============================================================================
// Types
// =============================================================================

/**
 * Configuration for health check service
 */
export interface HealthCheckConfig {
  /**
   * Interval between health checks (ms)
   * Default: 300000 (5 minutes)
   */
  intervalMs: number;

  /**
   * How long without activity before an agent is considered stalled (ms)
   * Default: 600000 (10 minutes)
   */
  stalledThresholdMs: number;

  /**
   * How long with no progress before GUPP violation (ms)
   * Default: 1800000 (30 minutes)
   */
  guppThresholdMs: number;

  /**
   * How many consecutive failures before escalating
   * Default: 3
   */
  consecutiveFailuresBeforeEscalate: number;
}

/**
 * Default configuration values
 */
export const DEFAULT_HEALTH_CHECK_CONFIG: HealthCheckConfig = {
  intervalMs: 5 * 60 * 1000, // 5 minutes
  stalledThresholdMs: 10 * 60 * 1000, // 10 minutes
  guppThresholdMs: 30 * 60 * 1000, // 30 minutes
  consecutiveFailuresBeforeEscalate: 3,
};

/**
 * Health state for a single worker
 */
export interface WorkerHealthState {
  agentId: AgentId;
  lastActivityAt: Timestamp;
  consecutiveFailures: number;
  lastCheckAt: Timestamp;
  status: "healthy" | "warning" | "stalled";
}

/**
 * Health state for a coordinator and its workers
 */
export interface CoordinatorHealthState {
  coordinatorId: AgentId;
  workers: Map<AgentId, WorkerHealthState>;
  lastCheckAt: Timestamp;
  nextCheckAt: Timestamp;
  isRunning: boolean;
}

/**
 * Result of a health check
 */
export interface HealthCheckResult {
  coordinatorId: AgentId;
  checkedAt: Timestamp;
  stalledAgents: StalledAgent[];
  escalatedAgents: AgentId[];
  zombiesCleanedUp: number;
}

// =============================================================================
// HealthCheckService Class
// =============================================================================

/**
 * Service that runs periodic health checks for coordinator workers
 */
export class HealthCheckService {
  private readonly eventStore: EventStore;
  private readonly sessionMapper: SessionMapper;
  private readonly messageRouter: MessageRouter;
  private readonly config: HealthCheckConfig;
  private readonly stallDetector: StallDetector;

  /** Timer handles per coordinator */
  private timers: Map<AgentId, ReturnType<typeof setInterval>> = new Map();

  /** Health state per coordinator */
  private healthStates: Map<AgentId, CoordinatorHealthState> = new Map();

  /** Last zombie cleanup time */
  private lastZombieCleanup: Timestamp = 0;

  constructor(
    eventStore: EventStore,
    sessionMapper: SessionMapper,
    messageRouter: MessageRouter,
    config: Partial<HealthCheckConfig> = {}
  ) {
    this.eventStore = eventStore;
    this.sessionMapper = sessionMapper;
    this.messageRouter = messageRouter;
    this.config = { ...DEFAULT_HEALTH_CHECK_CONFIG, ...config };
    this.stallDetector = new StallDetector(eventStore, sessionMapper, {
      stalledThresholdMs: this.config.stalledThresholdMs,
    });
  }

  /**
   * Start health check monitoring for a coordinator
   *
   * @param coordinatorId - The coordinator to monitor
   * @param config - Optional config overrides for this coordinator
   */
  startForCoordinator(
    coordinatorId: AgentId,
    config?: Partial<HealthCheckConfig>
  ): void {
    // Stop existing timer if any
    this.stopForCoordinator(coordinatorId);

    const effectiveConfig = { ...this.config, ...config };

    // Initialize health state
    const now = Date.now();
    this.healthStates.set(coordinatorId, {
      coordinatorId,
      workers: new Map(),
      lastCheckAt: now,
      nextCheckAt: now + effectiveConfig.intervalMs,
      isRunning: true,
    });

    // Start periodic health check timer
    const timer = setInterval(() => {
      this.runHealthCheck(coordinatorId).catch((error) => {
        console.error(
          `[HealthCheckService] Error running health check for ${coordinatorId}:`,
          error
        );
      });
    }, effectiveConfig.intervalMs);

    this.timers.set(coordinatorId, timer);

    // Run initial check immediately
    this.runHealthCheck(coordinatorId).catch((error) => {
      console.error(
        `[HealthCheckService] Error running initial health check for ${coordinatorId}:`,
        error
      );
    });
  }

  /**
   * Stop health check monitoring for a coordinator
   *
   * @param coordinatorId - The coordinator to stop monitoring
   */
  stopForCoordinator(coordinatorId: AgentId): void {
    const timer = this.timers.get(coordinatorId);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(coordinatorId);
    }

    const state = this.healthStates.get(coordinatorId);
    if (state) {
      state.isRunning = false;
    }
  }

  /**
   * Stop all health check timers
   */
  stopAll(): void {
    for (const [coordinatorId, timer] of this.timers) {
      clearInterval(timer);
      const state = this.healthStates.get(coordinatorId);
      if (state) {
        state.isRunning = false;
      }
    }
    this.timers.clear();
  }

  /**
   * Manually trigger a health check for a coordinator
   *
   * @param coordinatorId - The coordinator to check
   * @returns Health check result
   */
  async checkNow(coordinatorId: AgentId): Promise<HealthCheckResult> {
    return this.runHealthCheck(coordinatorId);
  }

  /**
   * Get the current health state for a coordinator
   *
   * @param coordinatorId - The coordinator to get state for
   * @returns Health state or undefined if not monitoring
   */
  getHealthState(coordinatorId: AgentId): CoordinatorHealthState | undefined {
    return this.healthStates.get(coordinatorId);
  }

  /**
   * Get all monitored coordinators
   *
   * @returns Array of coordinator IDs being monitored
   */
  getMonitoredCoordinators(): AgentId[] {
    return Array.from(this.timers.keys());
  }

  /**
   * Get the current configuration
   */
  getConfig(): HealthCheckConfig {
    return { ...this.config };
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  /**
   * Run a health check for a coordinator
   */
  private async runHealthCheck(coordinatorId: AgentId): Promise<HealthCheckResult> {
    const now = Date.now();
    const escalatedAgents: AgentId[] = [];

    // Get or create health state
    let state = this.healthStates.get(coordinatorId);
    if (!state) {
      state = {
        coordinatorId,
        workers: new Map(),
        lastCheckAt: now,
        nextCheckAt: now + this.config.intervalMs,
        isRunning: true,
      };
      this.healthStates.set(coordinatorId, state);
    }

    // Detect stalled agents
    const stalledAgents = this.stallDetector.detectStalled(coordinatorId);

    // Update worker health states and check for escalation
    for (const stalled of stalledAgents) {
      const workerState = state.workers.get(stalled.agentId) ?? {
        agentId: stalled.agentId,
        lastActivityAt: stalled.lastActivityAt,
        consecutiveFailures: 0,
        lastCheckAt: now,
        status: "healthy" as const,
      };

      // Increment failure counter
      workerState.consecutiveFailures++;
      workerState.lastCheckAt = now;
      workerState.lastActivityAt = stalled.lastActivityAt;

      // Determine status
      if (workerState.consecutiveFailures >= this.config.consecutiveFailuresBeforeEscalate) {
        workerState.status = "stalled";
        escalatedAgents.push(stalled.agentId);

        // Emit STALE_AGENT signal
        this.emitStaleAgentSignal(stalled);
      } else {
        workerState.status = "warning";
      }

      state.workers.set(stalled.agentId, workerState);
    }

    // Clear failure counters for healthy workers
    const stalledIds = new Set(stalledAgents.map((s) => s.agentId));
    for (const [workerId, workerState] of state.workers) {
      if (!stalledIds.has(workerId)) {
        workerState.consecutiveFailures = 0;
        workerState.status = "healthy";
        workerState.lastCheckAt = now;
      }
    }

    // Periodically clean up zombies (every 5 checks)
    let zombiesCleanedUp = 0;
    if (now - this.lastZombieCleanup > this.config.intervalMs * 5) {
      const zombies = this.stallDetector.cleanupZombies();
      zombiesCleanedUp = zombies.length;
      this.lastZombieCleanup = now;
    }

    // Update state
    state.lastCheckAt = now;
    state.nextCheckAt = now + this.config.intervalMs;

    return {
      coordinatorId,
      checkedAt: now,
      stalledAgents,
      escalatedAgents,
      zombiesCleanedUp,
    };
  }

  /**
   * Emit a STALE_AGENT signal via MessageRouter
   */
  private emitStaleAgentSignal(stalled: StalledAgent): void {
    try {
      this.messageRouter.emitStatus({
        from: { agent_id: stalled.coordinatorId },
        status_type: "checkpoint",
        summary: `Worker ${stalled.agentId} is stalled`,
        details: {
          signal: "STALE_AGENT",
          workerId: stalled.agentId,
          taskId: stalled.assignedTaskId,
          lastActivity: stalled.lastActivityAt,
          durationMs: stalled.stalledDurationMs,
        },
      });
    } catch (error) {
      console.error(
        `[HealthCheckService] Error emitting STALE_AGENT signal:`,
        error
      );
    }
  }
}
