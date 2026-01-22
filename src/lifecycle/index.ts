/**
 * Lifecycle Module
 *
 * Agent lifecycle management including done() signaling,
 * cleanup status detection, and role-specific handlers.
 *
 * @module lifecycle
 * @see s-32xs Self-Cleaning Workers spec
 */

// =============================================================================
// Types
// =============================================================================

export type {
  // Status types
  DoneStatus,
  CleanupStatus,

  // Arguments and results
  DoneArgs,
  DoneResult,

  // Handler types
  LifecycleContext,
  DoneHandler,
  DoneHandlerResult,
  DoneHandlerRegistry,

  // Configuration
  LifecycleConfig,

  // Cascade types
  CascadeOptions,
  CascadeResult,
} from "./types.js";

export { DEFAULT_LIFECYCLE_CONFIG } from "./types.js";

// =============================================================================
// Cleanup Detection
// =============================================================================

export {
  // Detection functions
  detectCleanupStatus,
  hasUncommittedChanges,
  getUncommittedFiles,
  getCurrentBranch,
  getPendingMessageCount,

  // Helper functions
  commitChanges,

  // Types
  type CleanupDependencies,
} from "./cleanup.js";

// =============================================================================
// Handlers
// =============================================================================

export {
  // Registry and dispatch
  createHandlerRegistry,
  getHandler,
  dispatchDone,

  // Individual handlers
  handleWorkerDone,
  handleIntegratorDone,
  handleMonitorDone,
  handleGenericDone,

  // Types
  type AllHandlerDeps,
  type WorkerHandlerDeps,
  type IntegratorHandlerDeps,
  type MonitorHandlerDeps,
  type GenericHandlerDeps,
} from "./handlers/index.js";

// =============================================================================
// Cascade Termination
// =============================================================================

export {
  // Functions
  cascadeTerminateChildren,
  terminateWithChangeConsolidation,
  getAllDescendants,
  needsCascadeTermination,

  // Types
  type CascadeAgent,
  type CascadeAgentManager,
} from "./cascade.js";
