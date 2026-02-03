/**
 * Cron Service Implementation
 *
 * Manages scheduled trigger jobs with support for one-shot,
 * recurring, and cron expression schedules.
 *
 * @module trigger/sources/cron/cron-service
 */

import type { TriggerRouter } from "../../router/types.js";
import type { TriggerWakeManager } from "../../wake/types.js";
import type {
  CronService,
  CronServiceConfig,
  CronJob,
  CronJobCreate,
  CronJobPatch,
  CronJobFilter,
  CronEvent,
} from "./types.js";
import {
  computeJobNextRunTime,
  findDueJobs,
  findNextJob,
  validateSchedule,
} from "./scheduler.js";
import { createTriggerEvent, type TriggerPayload } from "../../types.js";

// =============================================================================
// Configuration
// =============================================================================

const MAX_TIMER_DELAY_MS = 2 ** 31 - 1; // ~24.8 days

// =============================================================================
// Cron Service Dependencies
// =============================================================================

/**
 * Dependencies for the cron service
 */
export interface CronServiceDeps {
  /** Trigger router for delivering job payloads */
  triggerRouter: TriggerRouter;
  /** Wake manager for immediate wakes */
  wakeManager: TriggerWakeManager;
}

// =============================================================================
// In-Memory Store
// =============================================================================

/**
 * Simple in-memory job store
 * For production, this could be backed by SQLite
 */
class JobStore {
  private jobs: Map<string, CronJob> = new Map();

  async list(filter?: CronJobFilter): Promise<CronJob[]> {
    let jobs = Array.from(this.jobs.values());

    // Filter out disabled jobs by default unless includeDisabled is true
    if (!filter?.includeDisabled) {
      jobs = jobs.filter((j) => j.enabled);
    }

    if (filter) {
      if (filter.namePattern) {
        const pattern = new RegExp(filter.namePattern, "i");
        jobs = jobs.filter((j) => pattern.test(j.name));
      }
      if (filter.sessionTarget) {
        jobs = jobs.filter((j) => j.sessionTarget === filter.sessionTarget);
      }
    }

    return jobs;
  }

  async get(id: string): Promise<CronJob | null> {
    return this.jobs.get(id) ?? null;
  }

  async save(job: CronJob): Promise<void> {
    this.jobs.set(job.id, job);
  }

  async delete(id: string): Promise<void> {
    this.jobs.delete(id);
  }

  async clear(): Promise<void> {
    this.jobs.clear();
  }
}

// =============================================================================
// Cron Service Implementation
// =============================================================================

/**
 * Create a cron service
 */
export function createCronService(
  deps: CronServiceDeps,
  config: CronServiceConfig = {}
): CronService {
  const { enabled = true, onEvent } = config;

  // State
  const store = new JobStore();
  let running = false;
  let timer: NodeJS.Timeout | null = null;
  let executingJobs = new Set<string>();

  /**
   * Emit a cron event
   */
  function emit(event: CronEvent): void {
    try {
      onEvent?.(event);
    } catch {
      // Ignore event handler errors
    }
  }

  /**
   * Generate a unique job ID
   */
  function generateId(): string {
    return `cron_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  }

  /**
   * Arm the timer for the next job
   */
  async function armTimer(): Promise<void> {
    // Clear existing timer
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }

    if (!running || !enabled) return;

    const jobs = await store.list({ includeDisabled: false });
    const next = findNextJob(jobs, Date.now());

    if (!next) return;

    const delay = Math.max(0, next.runAtMs - Date.now());
    const clampedDelay = Math.min(delay, MAX_TIMER_DELAY_MS);

    timer = setTimeout(async () => {
      timer = null;
      if (!running) return;

      await runDueJobs();
      await armTimer();
    }, clampedDelay);

    timer.unref?.();
  }

  /**
   * Run all due jobs
   */
  async function runDueJobs(): Promise<void> {
    const jobs = await store.list({ includeDisabled: false });
    const dueJobs = findDueJobs(jobs, Date.now());

    for (const job of dueJobs) {
      await executeJob(job);
    }
  }

  /**
   * Execute a single job
   */
  async function executeJob(job: CronJob): Promise<void> {
    // Prevent concurrent execution
    if (executingJobs.has(job.id)) return;
    executingJobs.add(job.id);

    const startedAt = Date.now();

    // Update job state
    job.state.runningAtMs = startedAt;
    job.state.lastError = undefined;
    job.updatedAtMs = startedAt;
    await store.save(job);

    emit({ action: "started", jobId: job.id, runAtMs: startedAt });

    try {
      // Build trigger payload
      const payload: TriggerPayload =
        job.payload.kind === "systemEvent"
          ? { kind: "text", content: job.payload.text }
          : { kind: "text", content: job.payload.message };

      // Create trigger event
      const trigger = createTriggerEvent({
        source: { type: "cron", jobId: job.id, jobName: job.name },
        payload,
        wakeMode: job.wakeMode,
        routing: job.routing ?? (job.targetAgentId
          ? { target: { type: "agent", agentId: job.targetAgentId } }
          : { target: { type: "head" } }),
      });

      // Route the trigger
      const result = await deps.triggerRouter.route(trigger);

      // Update job state
      const finishedAt = Date.now();
      const durationMs = finishedAt - startedAt;

      job.state.runningAtMs = undefined;
      job.state.lastRunAtMs = startedAt;
      job.state.lastDurationMs = durationMs;
      job.state.runCount = (job.state.runCount ?? 0) + 1;

      if (result.success) {
        job.state.lastStatus = "ok";
        job.state.lastError = undefined;

        // Handle one-shot jobs
        if (job.schedule.kind === "at") {
          if (job.deleteAfterRun) {
            await store.delete(job.id);
            emit({ action: "removed", jobId: job.id });
          } else {
            job.enabled = false;
            job.state.nextRunAtMs = undefined;
            await store.save(job);
            emit({ action: "disabled", jobId: job.id });
          }
        } else {
          // Compute next run time
          job.state.nextRunAtMs = computeJobNextRunTime(job, finishedAt) ?? undefined;
          await store.save(job);
        }

        emit({
          action: "finished",
          jobId: job.id,
          status: "ok",
          durationMs,
          nextRunAtMs: job.state.nextRunAtMs,
        });
      } else {
        job.state.lastStatus = "error";
        job.state.lastError = result.error ?? "Trigger routing failed";
        job.state.nextRunAtMs = computeJobNextRunTime(job, finishedAt) ?? undefined;
        await store.save(job);

        emit({
          action: "finished",
          jobId: job.id,
          status: "error",
          error: job.state.lastError,
          durationMs,
          nextRunAtMs: job.state.nextRunAtMs,
        });
      }

      // Request wake if immediate mode
      if (job.wakeMode === "now") {
        deps.wakeManager.requestWakeNow({
          reason: `cron:${job.id}`,
          source: "cron",
        });
      }
    } catch (error) {
      const finishedAt = Date.now();
      const durationMs = finishedAt - startedAt;

      job.state.runningAtMs = undefined;
      job.state.lastRunAtMs = startedAt;
      job.state.lastDurationMs = durationMs;
      job.state.lastStatus = "error";
      job.state.lastError = error instanceof Error ? error.message : String(error);
      job.state.nextRunAtMs = computeJobNextRunTime(job, finishedAt) ?? undefined;
      await store.save(job);

      emit({
        action: "finished",
        jobId: job.id,
        status: "error",
        error: job.state.lastError,
        durationMs,
        nextRunAtMs: job.state.nextRunAtMs,
      });
    } finally {
      executingJobs.delete(job.id);
    }
  }

  // =============================================================================
  // Public Interface
  // =============================================================================

  return {
    async start(): Promise<void> {
      if (running) return;
      running = true;

      // Compute initial next run times
      const jobs = await store.list({ includeDisabled: false });
      const now = Date.now();

      for (const job of jobs) {
        if (!job.state.nextRunAtMs) {
          job.state.nextRunAtMs = computeJobNextRunTime(job, now) ?? undefined;
          await store.save(job);
        }
      }

      // Run any due jobs immediately
      await runDueJobs();

      // Arm timer for next job
      await armTimer();
    },

    async stop(): Promise<void> {
      if (!running) return;
      running = false;

      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },

    isRunning(): boolean {
      return running;
    },

    async list(filter?: CronJobFilter): Promise<CronJob[]> {
      return store.list(filter);
    },

    async get(id: string): Promise<CronJob | null> {
      return store.get(id);
    },

    async add(input: CronJobCreate): Promise<CronJob> {
      // Validate schedule
      const validation = validateSchedule(input.schedule);
      if (!validation.valid) {
        throw new Error(`Invalid schedule: ${validation.error}`);
      }

      const now = Date.now();

      const job: CronJob = {
        id: generateId(),
        name: input.name,
        description: input.description,
        enabled: input.enabled,
        deleteAfterRun: input.deleteAfterRun,
        createdAtMs: now,
        updatedAtMs: now,
        schedule: input.schedule,
        sessionTarget: input.sessionTarget,
        wakeMode: input.wakeMode,
        payload: input.payload,
        routing: input.routing,
        targetAgentId: input.targetAgentId,
        metadata: input.metadata,
        state: {
          ...input.state,
          nextRunAtMs: input.state?.nextRunAtMs ?? computeJobNextRunTime(
            { ...input, enabled: input.enabled } as CronJob,
            now
          ) ?? undefined,
        },
      };

      await store.save(job);

      if (job.state.nextRunAtMs) {
        emit({ action: "scheduled", jobId: job.id, nextRunAtMs: job.state.nextRunAtMs });
      }

      // Re-arm timer
      if (running) {
        await armTimer();
      }

      return job;
    },

    async update(id: string, patch: CronJobPatch): Promise<CronJob> {
      const job = await store.get(id);
      if (!job) {
        throw new Error(`Job not found: ${id}`);
      }

      // Validate schedule if updated
      if (patch.schedule) {
        const validation = validateSchedule(patch.schedule);
        if (!validation.valid) {
          throw new Error(`Invalid schedule: ${validation.error}`);
        }
      }

      const now = Date.now();

      // Apply patch
      if (patch.name !== undefined) job.name = patch.name;
      if (patch.description !== undefined) job.description = patch.description;
      if (patch.enabled !== undefined) job.enabled = patch.enabled;
      if (patch.deleteAfterRun !== undefined) job.deleteAfterRun = patch.deleteAfterRun;
      if (patch.schedule !== undefined) job.schedule = patch.schedule;
      if (patch.sessionTarget !== undefined) job.sessionTarget = patch.sessionTarget;
      if (patch.wakeMode !== undefined) job.wakeMode = patch.wakeMode;
      if (patch.payload !== undefined) job.payload = patch.payload;
      if (patch.routing !== undefined) job.routing = patch.routing;
      if (patch.targetAgentId !== undefined) job.targetAgentId = patch.targetAgentId;
      if (patch.metadata !== undefined) job.metadata = patch.metadata;

      // Apply state patch
      if (patch.state) {
        job.state = { ...job.state, ...patch.state };
      }

      job.updatedAtMs = now;

      // Recompute next run time if schedule or enabled changed
      if (patch.schedule !== undefined || patch.enabled !== undefined) {
        job.state.nextRunAtMs = job.enabled
          ? computeJobNextRunTime(job, now) ?? undefined
          : undefined;
      }

      await store.save(job);

      // Re-arm timer
      if (running) {
        await armTimer();
      }

      return job;
    },

    async remove(id: string): Promise<void> {
      const job = await store.get(id);
      if (!job) {
        throw new Error(`Job not found: ${id}`);
      }

      await store.delete(id);
      emit({ action: "removed", jobId: id });

      // Re-arm timer
      if (running) {
        await armTimer();
      }
    },

    async enable(id: string): Promise<CronJob> {
      return this.update(id, { enabled: true });
    },

    async disable(id: string): Promise<CronJob> {
      const job = await this.update(id, { enabled: false });
      emit({ action: "disabled", jobId: id });
      return job;
    },

    async run(id: string, opts?: { force?: boolean }): Promise<void> {
      const job = await store.get(id);
      if (!job) {
        throw new Error(`Job not found: ${id}`);
      }

      if (!opts?.force && !job.enabled) {
        throw new Error(`Job is disabled: ${id}`);
      }

      await executeJob(job);
    },

    /** Alias for run() - triggers job immediately */
    async triggerNow(id: string): Promise<void> {
      return this.run(id, { force: true });
    },

    getNextRunTime(): number | null {
      // This is sync but uses cached state
      // For async, we'd need to query the store
      return null; // TODO: implement with store query
    },
  };
}
