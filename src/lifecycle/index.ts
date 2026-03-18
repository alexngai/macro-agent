/**
 * Lifecycle Module (V2)
 *
 * Agent lifecycle management including done() signaling,
 * cleanup status detection, and cascade termination.
 *
 * @module lifecycle
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

  // Consolidation types (Phase 6)
  ConsolidationResult,
  ConsolidationOptions,
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
  type WorkspaceProvider,
} from "./cascade.js";
