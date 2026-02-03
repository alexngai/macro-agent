/**
 * Cron Service Types
 *
 * Types for the cron scheduler that manages time-based triggers.
 *
 * @module trigger/sources/cron/types
 */

import type { AgentId } from "../../../store/types/index.js";
import type { TriggerWakeMode, TriggerRoutingHint } from "../../types.js";

// =============================================================================
// Schedule Types
// =============================================================================

/**
 * One-shot schedule - runs once at a specific time
 */
export interface AtSchedule {
  kind: "at";
  /** Unix timestamp in milliseconds */
  atMs: number;
}

/**
 * Recurring interval schedule
 */
export interface EverySchedule {
  kind: "every";
  /** Interval in milliseconds */
  everyMs: number;
  /** Optional anchor time for alignment */
  anchorMs?: number;
}

/**
 * Cron expression schedule
 */
export interface CronExprSchedule {
  kind: "cron";
  /** Cron expression (5 or 6 fields) */
  expr: string;
  /** Timezone (IANA format, e.g., "America/New_York") */
  tz?: string;
}

/**
 * Union of all schedule types
 */
export type CronSchedule = AtSchedule | EverySchedule | CronExprSchedule;

// =============================================================================
// Job Payload Types
// =============================================================================

/**
 * System event payload - injects text into agent's context
 */
export interface SystemEventPayload {
  kind: "systemEvent";
  /** Text to inject as system event */
  text: string;
}

/**
 * Agent prompt payload - sends a full prompt to agent
 */
export interface AgentPromptPayload {
  kind: "agentPrompt";
  /** Message to send to agent */
  message: string;
  /** Optional timeout in seconds */
  timeoutSeconds?: number;
  /** Optional model override */
  model?: string;
}

/**
 * Union of job payload types
 */
export type CronJobPayload = SystemEventPayload | AgentPromptPayload;

// =============================================================================
// Job State Types
// =============================================================================

/**
 * Job execution state
 */
export interface CronJobState {
  /** Next scheduled run time */
  nextRunAtMs?: number;
  /** Currently running since (undefined if not running) */
  runningAtMs?: number;
  /** Last run time */
  lastRunAtMs?: number;
  /** Last run status */
  lastStatus?: "ok" | "error" | "skipped";
  /** Last error message if failed */
  lastError?: string;
  /** Last run duration in ms */
  lastDurationMs?: number;
  /** Run count */
  runCount?: number;
}

// =============================================================================
// Cron Job Definition
// =============================================================================

/**
 * Session target for job execution
 */
export type CronSessionTarget = "main" | "isolated";

/**
 * Full cron job definition
 */
export interface CronJob {
  /** Unique job ID */
  id: string;
  /** Human-readable name */
  name: string;
  /** Optional description */
  description?: string;
  /** Whether job is enabled */
  enabled: boolean;
  /** Delete job after successful run (for one-shot jobs) */
  deleteAfterRun?: boolean;
  /** Creation timestamp */
  createdAtMs: number;
  /** Last update timestamp */
  updatedAtMs: number;
  /** Schedule specification */
  schedule: CronSchedule;
  /** Session target */
  sessionTarget: CronSessionTarget;
  /** Wake mode for trigger delivery */
  wakeMode: TriggerWakeMode;
  /** Job payload */
  payload: CronJobPayload;
  /** Optional routing hints */
  routing?: TriggerRoutingHint;
  /** Optional target agent ID (overrides routing) */
  targetAgentId?: AgentId;
  /** Job state */
  state: CronJobState;
  /** Optional metadata */
  metadata?: Record<string, unknown>;
}

// =============================================================================
// Job Operations
// =============================================================================

/**
 * Input for creating a cron job
 */
export type CronJobCreate = Omit<
  CronJob,
  "id" | "createdAtMs" | "updatedAtMs" | "state"
> & {
  /** Optional initial state */
  state?: Partial<CronJobState>;
};

/**
 * Input for updating a cron job
 */
export type CronJobPatch = Partial<
  Omit<CronJob, "id" | "createdAtMs" | "state">
> & {
  /** Partial state update */
  state?: Partial<CronJobState>;
};

/**
 * Filter options for listing jobs
 */
export interface CronJobFilter {
  /** Include disabled jobs */
  includeDisabled?: boolean;
  /** Filter by name pattern */
  namePattern?: string;
  /** Filter by session target */
  sessionTarget?: CronSessionTarget;
}

// =============================================================================
// Cron Events
// =============================================================================

/**
 * Event emitted when a job starts
 */
export interface CronJobStartedEvent {
  action: "started";
  jobId: string;
  runAtMs: number;
}

/**
 * Event emitted when a job finishes
 */
export interface CronJobFinishedEvent {
  action: "finished";
  jobId: string;
  status: "ok" | "error" | "skipped";
  error?: string;
  durationMs: number;
  nextRunAtMs?: number;
}

/**
 * Event emitted when a job is scheduled
 */
export interface CronJobScheduledEvent {
  action: "scheduled";
  jobId: string;
  nextRunAtMs: number;
}

/**
 * Event emitted when a job is disabled
 */
export interface CronJobDisabledEvent {
  action: "disabled";
  jobId: string;
}

/**
 * Event emitted when a job is removed
 */
export interface CronJobRemovedEvent {
  action: "removed";
  jobId: string;
}

/**
 * Union of all cron events
 */
export type CronEvent =
  | CronJobStartedEvent
  | CronJobFinishedEvent
  | CronJobScheduledEvent
  | CronJobDisabledEvent
  | CronJobRemovedEvent;

// =============================================================================
// Cron Service Interface
// =============================================================================

/**
 * Cron service configuration
 */
export interface CronServiceConfig {
  /** Enable cron service */
  enabled?: boolean;
  /** Storage path for jobs (":memory:" or file path) */
  storePath?: string;
  /** Event callback */
  onEvent?: (event: CronEvent) => void;
}

/**
 * Cron service interface
 */
export interface CronService {
  /**
   * Start the cron service
   */
  start(): Promise<void>;

  /**
   * Stop the cron service
   */
  stop(): Promise<void>;

  /**
   * Check if service is running
   */
  isRunning(): boolean;

  /**
   * List all jobs
   */
  list(filter?: CronJobFilter): Promise<CronJob[]>;

  /**
   * Get a job by ID
   */
  get(id: string): Promise<CronJob | null>;

  /**
   * Add a new job
   */
  add(input: CronJobCreate): Promise<CronJob>;

  /**
   * Update an existing job
   */
  update(id: string, patch: CronJobPatch): Promise<CronJob>;

  /**
   * Remove a job
   */
  remove(id: string): Promise<void>;

  /**
   * Enable a job
   */
  enable(id: string): Promise<CronJob>;

  /**
   * Disable a job
   */
  disable(id: string): Promise<CronJob>;

  /**
   * Manually run a job
   */
  run(id: string, opts?: { force?: boolean }): Promise<void>;

  /**
   * Trigger a job immediately (alias for run with force: true)
   */
  triggerNow(id: string): Promise<void>;

  /**
   * Get next scheduled run time across all jobs
   */
  getNextRunTime(): number | null;
}
