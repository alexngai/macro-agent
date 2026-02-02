/**
 * Cron Service
 *
 * Time-based trigger scheduling with support for one-shot,
 * recurring, and cron expression schedules.
 *
 * @module trigger/sources/cron
 */

export {
  createCronService,
  type CronServiceDeps,
} from "./cron-service.js";

export {
  computeNextRunTime,
  computeJobNextRunTime,
  findNextJob,
  findDueJobs,
  validateSchedule,
  formatSchedule,
} from "./scheduler.js";

export type {
  CronService,
  CronServiceConfig,
  CronJob,
  CronJobCreate,
  CronJobPatch,
  CronJobFilter,
  CronSchedule,
  AtSchedule,
  EverySchedule,
  CronExprSchedule,
  CronJobPayload,
  SystemEventPayload,
  AgentPromptPayload,
  CronJobState,
  CronSessionTarget,
  CronEvent,
} from "./types.js";
