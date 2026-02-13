/**
 * OpenTasks Task Backend Module
 *
 * Integrates macro-agent's task system with OpenTasks, a graph connector
 * for linking heterogeneous task and issue systems.
 *
 * Tasks are stored as OpenTasks issues with bidirectional ID mapping.
 * Blocking dependencies use OpenTasks 'blocks' edges.
 * The pull model leverages OpenTasks' ready query and claimed_by field.
 *
 * @module task/backend/opentasks
 */

// Backend
export {
  OpenTasksTaskBackend,
  OpenTasksBackendError,
  createOpenTasksTaskBackend,
} from "./backend.js";
export type { OpenTasksBackendConfig } from "./backend.js";

// Client
export {
  IPCOpenTasksClient,
  OpenTasksClientError,
  createOpenTasksClient,
} from "./client.js";
export type {
  OpenTasksClient,
  OpenTasksClientConfig,
  OpenTasksIssue,
  OpenTasksEdge,
  OpenTasksNodeSummary,
  CreateIssueInput,
  UpdateIssueInput,
  IssueChangeType,
  IssueChangeEvent,
  IssueChangeCallback,
  ClientUnsubscribe,
} from "./client.js";

// Mapping
export {
  mapOpenTasksStatus,
  mapTaskStatus,
  isIssueComplete,
  isIssueBlocked,
} from "./mapping.js";
export type { OpenTasksIssueStatus } from "./mapping.js";

// Tool Provider
export {
  OpenTasksTaskToolProvider,
  createOpenTasksToolProvider,
} from "./tools.js";
export type {
  OpenTasksToolMode,
  OpenTasksToolContext,
  GetOpenTasksToolContext,
  OpenTasksToolProviderConfig,
} from "./tools.js";
