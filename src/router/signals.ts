/**
 * Protocol Signal Types
 *
 * Standardized signal vocabulary for agent communication.
 *
 * @module router/signals
 * @see s-9rld In-Flight Steering spec section 3.5
 */

// =============================================================================
// Signal Types
// =============================================================================

/**
 * All protocol signal types
 */
export type SignalType =
  | "WORKER_DONE"
  | "TASK_DONE"
  | "WORK_ASSIGNED"
  | "MERGE_REQUEST"
  | "MERGE_COMPLETE"
  | "LAND_COMPLETE"
  | "CONFLICT_DETECTED"
  | "HELP"
  | "HELP_CLAIMED"
  | "HANDOFF"
  | "STATUS"
  | "HEALTH_CHECK"
  | "HEALTH_CHECK_TIMER"
  | "GUPP_VIOLATION"
  | "PRIORITY_CHANGE"
  | "FORCE_TERMINATE_REQUEST"
  | "WORKER_SPAWNED"
  | "INTEGRATOR_DONE"
  | "AGENT_TIMEOUT"
  | "ASSIGNMENT_EXPIRED";

// =============================================================================
// Signal Payloads
// =============================================================================

import type { AgentId, TaskId, Timestamp } from "../store/types/index.js";

/**
 * WORKER_DONE - Worker agent finished its part
 */
export interface WorkerDonePayload {
  workerId: AgentId;
  taskId?: TaskId;
  status: "completed" | "failed" | "blocked" | "deferred";
  message?: string;
}

/**
 * TASK_DONE - Entire task completed (may span multiple workers)
 */
export interface TaskDonePayload {
  taskId: TaskId;
  exitStatus: "completed" | "failed";
  artifacts?: ArtifactRef[];
  summary?: string;
}

/**
 * WORK_ASSIGNED - Task assigned to worker
 */
export interface WorkAssignedPayload {
  taskId: TaskId;
  workerId: AgentId;
  assignedBy?: AgentId;
}

/**
 * MERGE_REQUEST - Worker submits to merge queue
 */
export interface MergeRequestPayload {
  sourceBranch: string;
  targetBranch: string;
  taskId?: TaskId;
  workerId: AgentId;
}

/**
 * MERGE_COMPLETE - Integrator merged successfully
 */
export interface MergeCompletePayload {
  taskId?: TaskId;
  branch: string;
  integratorId: AgentId;
}

/**
 * LAND_COMPLETE - Changes landed to integration branch
 */
export interface LandCompletePayload {
  taskId?: TaskId;
  branch: string;
  commitHash?: string;
}

/**
 * CONFLICT_DETECTED - Merge conflict found
 */
export interface ConflictDetectedPayload {
  sourceBranch: string;
  targetBranch: string;
  taskId?: TaskId;
  conflictingFiles: string[];
}

/**
 * HELP - Agent needs escalation
 */
export interface HelpPayload {
  requestId: string;
  topic: string;
  problem: string;
  tried?: string[];
  severity: "low" | "normal" | "high" | "urgent";
  agentId: AgentId;
}

/**
 * HELP_CLAIMED - Supervisor claiming help request
 */
export interface HelpClaimedPayload {
  requestId: string;
  claimedBy: AgentId;
}

/**
 * HANDOFF - Context transfer between agents
 */
export interface HandoffPayload {
  context: Record<string, unknown>;
  hookedWork?: string[];
  reason: string;
  fromAgent: AgentId;
  toAgent?: AgentId;
}

/**
 * STATUS - State report from agent
 */
export interface StatusPayload {
  status: "working" | "idle" | "blocked" | "waiting";
  progress?: number; // 0-100
  blockers?: string[];
  currentTask?: TaskId;
}

/**
 * HEALTH_CHECK - Liveness probe from monitor
 */
export interface HealthCheckPayload {
  respondBy: Timestamp;
  checkId: string;
}

/**
 * HEALTH_CHECK_TIMER - Periodic check trigger from system
 */
export interface HealthCheckTimerPayload {
  timestamp: Timestamp;
  coordinatorId?: AgentId;
}

/**
 * GUPP_VIOLATION - Worker timeout detected
 */
export interface GuppViolationPayload {
  workerId: AgentId;
  taskId?: TaskId;
  lastActivity: Timestamp;
  durationMs: number;
}

/**
 * PRIORITY_CHANGE - Task priority update
 */
export interface PriorityChangePayload {
  taskId: TaskId;
  oldPriority: number;
  newPriority: number;
}

/**
 * FORCE_TERMINATE_REQUEST - Request to forcefully terminate an agent
 */
export interface ForceTerminateRequestPayload {
  agentId: AgentId;
  reason: string;
  requestedBy: AgentId;
}

/**
 * WORKER_SPAWNED - New worker agent created
 */
export interface WorkerSpawnedPayload {
  workerId: AgentId;
  parentId?: AgentId;
  taskId?: TaskId;
  role: string;
}

/**
 * INTEGRATOR_DONE - Integrator finished
 */
export interface IntegratorDonePayload {
  integratorId: AgentId;
  status: "completed" | "failed";
  baseBranch: string;
}

/**
 * AGENT_TIMEOUT - External timeout signal
 */
export interface AgentTimeoutPayload {
  agentId: AgentId;
  timeoutType: "gupp" | "health_check" | "lease";
  durationMs: number;
}

/**
 * ASSIGNMENT_EXPIRED - Task assignment lease expired
 */
export interface AssignmentExpiredPayload {
  taskId: TaskId;
  previousAssignee: AgentId;
  leaseMs: number;
}

// =============================================================================
// Artifact Reference (imported from tasks but defined here for signal payloads)
// =============================================================================

/**
 * Artifact reference for signal payloads
 */
export interface ArtifactRef {
  type: "file" | "commit" | "url";
  ref: string;
  description?: string;
}

// =============================================================================
// Signal Payload Map
// =============================================================================

/**
 * Map of signal types to their payload types
 */
export interface SignalPayloadMap {
  WORKER_DONE: WorkerDonePayload;
  TASK_DONE: TaskDonePayload;
  WORK_ASSIGNED: WorkAssignedPayload;
  MERGE_REQUEST: MergeRequestPayload;
  MERGE_COMPLETE: MergeCompletePayload;
  LAND_COMPLETE: LandCompletePayload;
  CONFLICT_DETECTED: ConflictDetectedPayload;
  HELP: HelpPayload;
  HELP_CLAIMED: HelpClaimedPayload;
  HANDOFF: HandoffPayload;
  STATUS: StatusPayload;
  HEALTH_CHECK: HealthCheckPayload;
  HEALTH_CHECK_TIMER: HealthCheckTimerPayload;
  GUPP_VIOLATION: GuppViolationPayload;
  PRIORITY_CHANGE: PriorityChangePayload;
  FORCE_TERMINATE_REQUEST: ForceTerminateRequestPayload;
  WORKER_SPAWNED: WorkerSpawnedPayload;
  INTEGRATOR_DONE: IntegratorDonePayload;
  AGENT_TIMEOUT: AgentTimeoutPayload;
  ASSIGNMENT_EXPIRED: AssignmentExpiredPayload;
}

/**
 * Get the payload type for a signal
 */
export type SignalPayload<T extends SignalType> = SignalPayloadMap[T];

// =============================================================================
// Signal Constants
// =============================================================================

/**
 * All signal type constants for easy reference
 */
export const SIGNALS = {
  // Worker lifecycle
  WORKER_DONE: "WORKER_DONE" as const,
  WORKER_SPAWNED: "WORKER_SPAWNED" as const,

  // Task lifecycle
  TASK_DONE: "TASK_DONE" as const,
  WORK_ASSIGNED: "WORK_ASSIGNED" as const,
  ASSIGNMENT_EXPIRED: "ASSIGNMENT_EXPIRED" as const,
  PRIORITY_CHANGE: "PRIORITY_CHANGE" as const,

  // Merge queue
  MERGE_REQUEST: "MERGE_REQUEST" as const,
  MERGE_COMPLETE: "MERGE_COMPLETE" as const,
  LAND_COMPLETE: "LAND_COMPLETE" as const,
  CONFLICT_DETECTED: "CONFLICT_DETECTED" as const,

  // Integrator
  INTEGRATOR_DONE: "INTEGRATOR_DONE" as const,

  // Help and handoff
  HELP: "HELP" as const,
  HELP_CLAIMED: "HELP_CLAIMED" as const,
  HANDOFF: "HANDOFF" as const,
  STATUS: "STATUS" as const,

  // Health monitoring
  HEALTH_CHECK: "HEALTH_CHECK" as const,
  HEALTH_CHECK_TIMER: "HEALTH_CHECK_TIMER" as const,
  GUPP_VIOLATION: "GUPP_VIOLATION" as const,
  AGENT_TIMEOUT: "AGENT_TIMEOUT" as const,
  FORCE_TERMINATE_REQUEST: "FORCE_TERMINATE_REQUEST" as const,
} as const;

/**
 * Set of all valid signal types for validation
 */
export const ALL_SIGNALS: Set<SignalType> = new Set(
  Object.values(SIGNALS) as SignalType[]
);

/**
 * Check if a string is a valid signal type
 */
export function isValidSignal(signal: string): signal is SignalType {
  return ALL_SIGNALS.has(signal as SignalType);
}
