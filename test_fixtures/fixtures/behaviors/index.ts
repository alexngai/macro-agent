/**
 * Behavior Fixtures exports
 *
 * @see s-1zcx Multi-Agent Orchestration Testing Strategy
 * @see i-7f2l Phase 4: Fixtures Library
 */

// Workers
export {
  SUCCESSFUL_WORKER,
  FAILING_WORKER,
  STUCK_WORKER,
  IMPLEMENT_FUNCTION_WORKER,
  WAITING_WORKER,
  SIGNALING_WORKER,
  MULTI_COMMIT_WORKER,
  BLOCKED_WORKER,
  DEFERRED_WORKER,
  HELP_EMITTING_WORKER,
  EXPLICIT_FAILING_WORKER,
  createConflictingWorker,
  createWorker,
  createUniqueFileWorker,
  // Resolver workers
  RESOLVER_WORKER,
  FAILING_RESOLVER_WORKER,
  NESTED_CONFLICT_RESOLVER,
  createResolverWorker,
} from "./workers.js";

// Coordinators
export {
  PLANNING_COORDINATOR,
  WAITING_COORDINATOR,
  CONDITIONAL_COORDINATOR,
  EVENT_HANDLING_COORDINATOR,
  TASK_CREATING_COORDINATOR,
  SIMPLE_COORDINATOR,
  createMultiWorkerCoordinator,
} from "./coordinators.js";

// Integrators
export {
  BASIC_INTEGRATOR,
  CONFLICT_RESOLVER,
  BATCH_INTEGRATOR,
  VALIDATING_INTEGRATOR,
  CONTINUOUS_INTEGRATOR,
  SIMPLE_INTEGRATOR,
  FAILING_INTEGRATOR,
} from "./integrators.js";

// Monitors
export {
  HEALTH_CHECK_MONITOR,
  GUPP_MONITOR,
  PROGRESS_MONITOR,
  TIMEOUT_MONITOR,
  RESOURCE_MONITOR,
  SIMPLE_MONITOR,
  PERSISTENT_MONITOR,
} from "./monitors.js";
