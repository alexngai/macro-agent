/**
 * Monitor module - Health monitoring for multi-agent orchestration
 *
 * Provides:
 * - Stall detection for inactive agents
 * - Zombie cleanup for orphaned sessions
 * - Health check service for periodic monitoring
 *
 * @module monitor
 * @see s-5yhx Phase B: Monitor Active Behaviors
 */

export {
  StallDetector,
  type StalledAgent,
  type ZombieAgent,
  type StallDetectorConfig,
  DEFAULT_STALL_DETECTOR_CONFIG,
} from "./stall-detector.js";

export {
  HealthCheckService,
  type HealthCheckConfig,
  type HealthCheckResult,
  type CoordinatorHealthState,
  type WorkerHealthState,
  DEFAULT_HEALTH_CHECK_CONFIG,
} from "./health-check-service.js";
