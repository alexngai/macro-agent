/**
 * Sudocode Task Backend Module
 *
 * Provides integration with sudocode for task management.
 *
 * @module task/backend/sudocode
 * @see s-8472 Pluggable Task Backend Integration with Sudocode
 */

// =============================================================================
// Client Types and Factory
// =============================================================================

export type {
  // Configuration types
  SudocodeClientMode,
  SudocodeClientConfig,
  AutoDetectOptions,
  ServerClientConfig,
  StandaloneClientConfig,

  // Filter and input types
  ListIssuesOptions,
  ListSpecsOptions,
  UpdateIssueInput,
  FeedbackInput,

  // Event types
  IssueChangeType,
  IssueChangeEvent,
  IssueChangeCallback,
  Unsubscribe,

  // Client interface
  SudocodeClient,
} from "./client.js";

export {
  DEFAULT_CLIENT_CONFIG,
  checkServerHealth,
  createSudocodeClient,
} from "./client.js";

// Re-export sudocode types for convenience
export type {
  Issue,
  IssueStatus,
  Spec,
  Relationship,
  RelationshipType,
  EntityType,
  IssueFeedback,
  FeedbackType,
  FeedbackAnchor,
} from "./client.js";

// =============================================================================
// Backend Implementation
// =============================================================================

export type { SudocodeTaskBackendConfig } from "./backend.js";

export {
  SudocodeTaskBackend,
  SudocodeTaskBackendError,
  createSudocodeTaskBackend,
} from "./backend.js";

// =============================================================================
// Mapping Utilities
// =============================================================================

export {
  mapSudocodeStatus,
  mapTaskStatus,
  mapIssuePriority,
  isIssueComplete,
  isIssueBlocked,
} from "./mapping.js";
