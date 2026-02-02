/**
 * Cron Schedule Utilities
 *
 * Functions for computing next run times for various schedule types.
 *
 * @module trigger/sources/cron/scheduler
 */

import type { CronSchedule, CronJob } from "./types.js";

// =============================================================================
// Cron Expression Parsing
// =============================================================================

/**
 * Field ranges for cron expressions
 */
const CRON_FIELDS = {
  minute: { min: 0, max: 59 },
  hour: { min: 0, max: 23 },
  dayOfMonth: { min: 1, max: 31 },
  month: { min: 1, max: 12 },
  dayOfWeek: { min: 0, max: 6 }, // 0 = Sunday
};

/**
 * Parse a cron field into a set of valid values
 */
function parseCronField(
  field: string,
  min: number,
  max: number
): Set<number> {
  const values = new Set<number>();

  // Handle wildcards
  if (field === "*") {
    for (let i = min; i <= max; i++) {
      values.add(i);
    }
    return values;
  }

  // Split by comma for multiple values
  const parts = field.split(",");

  for (const part of parts) {
    // Handle step values (*/5 or 1-10/2)
    const stepMatch = part.match(/^(.+)\/(\d+)$/);
    if (stepMatch) {
      const [, range, stepStr] = stepMatch;
      const step = parseInt(stepStr, 10);
      let start = min;
      let end = max;

      if (range !== "*") {
        const rangeMatch = range.match(/^(\d+)-(\d+)$/);
        if (rangeMatch) {
          start = parseInt(rangeMatch[1], 10);
          end = parseInt(rangeMatch[2], 10);
        } else {
          start = parseInt(range, 10);
        }
      }

      for (let i = start; i <= end; i += step) {
        if (i >= min && i <= max) {
          values.add(i);
        }
      }
      continue;
    }

    // Handle ranges (1-5)
    const rangeMatch = part.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const start = parseInt(rangeMatch[1], 10);
      const end = parseInt(rangeMatch[2], 10);
      for (let i = start; i <= end; i++) {
        if (i >= min && i <= max) {
          values.add(i);
        }
      }
      continue;
    }

    // Single value
    const value = parseInt(part, 10);
    if (!isNaN(value) && value >= min && value <= max) {
      values.add(value);
    }
  }

  return values;
}

/**
 * Parse a cron expression into field sets
 */
function parseCronExpression(expr: string): {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
} | null {
  const parts = expr.trim().split(/\s+/);

  // Support both 5-field and 6-field (with seconds) formats
  // We ignore seconds if present
  const fields = parts.length === 6 ? parts.slice(1) : parts;

  if (fields.length !== 5) {
    return null;
  }

  try {
    return {
      minutes: parseCronField(fields[0], CRON_FIELDS.minute.min, CRON_FIELDS.minute.max),
      hours: parseCronField(fields[1], CRON_FIELDS.hour.min, CRON_FIELDS.hour.max),
      daysOfMonth: parseCronField(fields[2], CRON_FIELDS.dayOfMonth.min, CRON_FIELDS.dayOfMonth.max),
      months: parseCronField(fields[3], CRON_FIELDS.month.min, CRON_FIELDS.month.max),
      daysOfWeek: parseCronField(fields[4], CRON_FIELDS.dayOfWeek.min, CRON_FIELDS.dayOfWeek.max),
    };
  } catch {
    return null;
  }
}

/**
 * Get next matching time for a cron expression
 */
function getNextCronTime(
  expr: string,
  afterMs: number,
  timezone?: string
): number | null {
  const parsed = parseCronExpression(expr);
  if (!parsed) {
    return null;
  }

  // Start from the next minute
  const startDate = new Date(afterMs);
  startDate.setSeconds(0, 0);
  startDate.setMinutes(startDate.getMinutes() + 1);

  // Search up to 2 years ahead
  const maxIterations = 365 * 24 * 60 * 2;
  let iterations = 0;

  while (iterations < maxIterations) {
    iterations++;

    const minute = startDate.getMinutes();
    const hour = startDate.getHours();
    const dayOfMonth = startDate.getDate();
    const month = startDate.getMonth() + 1; // 1-indexed
    const dayOfWeek = startDate.getDay();

    // Check if all fields match
    const monthMatch = parsed.months.has(month);
    const dayOfWeekMatch = parsed.daysOfWeek.has(dayOfWeek);
    const dayOfMonthMatch = parsed.daysOfMonth.has(dayOfMonth);
    const hourMatch = parsed.hours.has(hour);
    const minuteMatch = parsed.minutes.has(minute);

    // Day matching: if both dayOfMonth and dayOfWeek are specified (not *),
    // they are OR'd together. Otherwise, they are AND'd.
    const dayMatch =
      parsed.daysOfMonth.size === 31 || parsed.daysOfWeek.size === 7
        ? dayOfMonthMatch && dayOfWeekMatch
        : dayOfMonthMatch || dayOfWeekMatch;

    if (monthMatch && dayMatch && hourMatch && minuteMatch) {
      return startDate.getTime();
    }

    // Advance to next minute
    startDate.setMinutes(startDate.getMinutes() + 1);
  }

  return null;
}

// =============================================================================
// Schedule Computation
// =============================================================================

/**
 * Compute next run time for a schedule
 */
export function computeNextRunTime(
  schedule: CronSchedule,
  afterMs: number = Date.now()
): number | null {
  switch (schedule.kind) {
    case "at": {
      // One-shot: only return if it's in the future
      return schedule.atMs > afterMs ? schedule.atMs : null;
    }

    case "every": {
      // Recurring interval
      const { everyMs, anchorMs } = schedule;

      if (anchorMs !== undefined) {
        // Align to anchor
        const elapsed = afterMs - anchorMs;
        const periods = Math.ceil(elapsed / everyMs);
        return anchorMs + periods * everyMs;
      }

      // No anchor - next interval from now
      return afterMs + everyMs;
    }

    case "cron": {
      // Cron expression
      return getNextCronTime(schedule.expr, afterMs, schedule.tz);
    }
  }
}

/**
 * Compute next run time for a job
 */
export function computeJobNextRunTime(
  job: CronJob,
  afterMs: number = Date.now()
): number | null {
  if (!job.enabled) {
    return null;
  }

  return computeNextRunTime(job.schedule, afterMs);
}

/**
 * Find the next job to run across all jobs
 */
export function findNextJob(
  jobs: CronJob[],
  nowMs: number = Date.now()
): { job: CronJob; runAtMs: number } | null {
  let nextJob: CronJob | null = null;
  let nextRunAt: number | null = null;

  for (const job of jobs) {
    if (!job.enabled) continue;
    if (job.state.runningAtMs) continue; // Already running

    const nextRun = job.state.nextRunAtMs ?? computeJobNextRunTime(job, nowMs);
    if (nextRun === null) continue;

    if (nextRunAt === null || nextRun < nextRunAt) {
      nextRunAt = nextRun;
      nextJob = job;
    }
  }

  return nextJob && nextRunAt ? { job: nextJob, runAtMs: nextRunAt } : null;
}

/**
 * Find all jobs that are due to run
 */
export function findDueJobs(
  jobs: CronJob[],
  nowMs: number = Date.now()
): CronJob[] {
  return jobs.filter((job) => {
    if (!job.enabled) return false;
    if (job.state.runningAtMs) return false; // Already running

    const nextRun = job.state.nextRunAtMs;
    return typeof nextRun === "number" && nowMs >= nextRun;
  });
}

// =============================================================================
// Schedule Validation
// =============================================================================

/**
 * Validate a schedule specification
 */
export function validateSchedule(
  schedule: CronSchedule
): { valid: boolean; error?: string } {
  switch (schedule.kind) {
    case "at": {
      if (typeof schedule.atMs !== "number" || schedule.atMs < 0) {
        return { valid: false, error: "Invalid timestamp" };
      }
      return { valid: true };
    }

    case "every": {
      if (typeof schedule.everyMs !== "number" || schedule.everyMs <= 0) {
        return { valid: false, error: "Interval must be positive" };
      }
      if (schedule.everyMs < 1000) {
        return { valid: false, error: "Interval must be at least 1 second" };
      }
      return { valid: true };
    }

    case "cron": {
      const parsed = parseCronExpression(schedule.expr);
      if (!parsed) {
        return { valid: false, error: "Invalid cron expression" };
      }
      return { valid: true };
    }
  }
}

/**
 * Format a schedule for display
 */
export function formatSchedule(schedule: CronSchedule): string {
  switch (schedule.kind) {
    case "at": {
      return `at ${new Date(schedule.atMs).toISOString()}`;
    }

    case "every": {
      const seconds = Math.floor(schedule.everyMs / 1000);
      if (seconds < 60) return `every ${seconds}s`;
      const minutes = Math.floor(seconds / 60);
      if (minutes < 60) return `every ${minutes}m`;
      const hours = Math.floor(minutes / 60);
      if (hours < 24) return `every ${hours}h`;
      const days = Math.floor(hours / 24);
      return `every ${days}d`;
    }

    case "cron": {
      const tz = schedule.tz ? ` (${schedule.tz})` : "";
      return `cron: ${schedule.expr}${tz}`;
    }
  }
}
