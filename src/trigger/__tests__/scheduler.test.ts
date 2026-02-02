/**
 * Cron Scheduler Tests
 *
 * Tests for schedule computation and cron expression parsing.
 */

import { describe, it, expect } from "vitest";
import {
  computeNextRunTime,
  computeJobNextRunTime,
  findNextJob,
  findDueJobs,
  validateSchedule,
  formatSchedule,
} from "../sources/cron/scheduler.js";
import type { CronJob, CronSchedule } from "../sources/cron/types.js";

describe("Scheduler", () => {
  describe("computeNextRunTime", () => {
    describe("at schedule (one-shot)", () => {
      it("should return the scheduled time if in the future", () => {
        const futureTime = Date.now() + 60000;
        const schedule: CronSchedule = { kind: "at", atMs: futureTime };

        const result = computeNextRunTime(schedule, Date.now());

        expect(result).toBe(futureTime);
      });

      it("should return null if scheduled time is in the past", () => {
        const pastTime = Date.now() - 60000;
        const schedule: CronSchedule = { kind: "at", atMs: pastTime };

        const result = computeNextRunTime(schedule, Date.now());

        expect(result).toBeNull();
      });
    });

    describe("every schedule (recurring)", () => {
      it("should return next interval from now without anchor", () => {
        const now = Date.now();
        const interval = 60000; // 1 minute
        const schedule: CronSchedule = { kind: "every", everyMs: interval };

        const result = computeNextRunTime(schedule, now);

        expect(result).toBe(now + interval);
      });

      it("should align to anchor time", () => {
        const anchor = 1000000000000; // Fixed anchor
        const interval = 60000;
        const schedule: CronSchedule = {
          kind: "every",
          everyMs: interval,
          anchorMs: anchor,
        };

        // 30 seconds after a period boundary
        const afterTime = anchor + interval * 5 + 30000;
        const result = computeNextRunTime(schedule, afterTime);

        // Should align to next period boundary
        expect(result).toBe(anchor + interval * 6);
      });
    });

    describe("cron schedule", () => {
      it("should parse simple cron expressions", () => {
        // Every minute
        const schedule: CronSchedule = { kind: "cron", expr: "* * * * *" };
        const now = Date.now();

        const result = computeNextRunTime(schedule, now);

        expect(result).not.toBeNull();
        expect(result).toBeGreaterThan(now);
        // Should be within 60 seconds
        expect(result! - now).toBeLessThanOrEqual(60000);
      });

      it("should handle specific minute", () => {
        const schedule: CronSchedule = { kind: "cron", expr: "30 * * * *" };
        const now = Date.now();

        const result = computeNextRunTime(schedule, now);

        expect(result).not.toBeNull();
        const resultDate = new Date(result!);
        expect(resultDate.getMinutes()).toBe(30);
      });

      it("should handle specific hour and minute", () => {
        const schedule: CronSchedule = { kind: "cron", expr: "0 12 * * *" };
        const now = Date.now();

        const result = computeNextRunTime(schedule, now);

        expect(result).not.toBeNull();
        const resultDate = new Date(result!);
        expect(resultDate.getMinutes()).toBe(0);
        expect(resultDate.getHours()).toBe(12);
      });

      it("should handle ranges", () => {
        const schedule: CronSchedule = { kind: "cron", expr: "0-5 * * * *" };
        const now = Date.now();

        const result = computeNextRunTime(schedule, now);

        expect(result).not.toBeNull();
        const resultDate = new Date(result!);
        expect(resultDate.getMinutes()).toBeGreaterThanOrEqual(0);
        expect(resultDate.getMinutes()).toBeLessThanOrEqual(5);
      });

      it("should handle step values", () => {
        const schedule: CronSchedule = { kind: "cron", expr: "*/15 * * * *" };
        const now = Date.now();

        const result = computeNextRunTime(schedule, now);

        expect(result).not.toBeNull();
        const resultDate = new Date(result!);
        expect(resultDate.getMinutes() % 15).toBe(0);
      });

      it("should handle comma-separated values", () => {
        const schedule: CronSchedule = { kind: "cron", expr: "0,15,30,45 * * * *" };
        const now = Date.now();

        const result = computeNextRunTime(schedule, now);

        expect(result).not.toBeNull();
        const resultDate = new Date(result!);
        expect([0, 15, 30, 45]).toContain(resultDate.getMinutes());
      });

      it("should return null for invalid cron expression", () => {
        const schedule: CronSchedule = { kind: "cron", expr: "invalid" };

        const result = computeNextRunTime(schedule, Date.now());

        expect(result).toBeNull();
      });
    });
  });

  describe("computeJobNextRunTime", () => {
    it("should return null for disabled job", () => {
      const job = createMockJob({ enabled: false });

      const result = computeJobNextRunTime(job);

      expect(result).toBeNull();
    });

    it("should compute next run for enabled job", () => {
      const job = createMockJob({
        enabled: true,
        schedule: { kind: "every", everyMs: 60000 },
      });

      const result = computeJobNextRunTime(job);

      expect(result).not.toBeNull();
    });
  });

  describe("findNextJob", () => {
    it("should find the job with earliest next run time", () => {
      const now = Date.now();
      const jobs: CronJob[] = [
        createMockJob({
          id: "job1",
          enabled: true,
          state: { nextRunAtMs: now + 60000 },
        }),
        createMockJob({
          id: "job2",
          enabled: true,
          state: { nextRunAtMs: now + 30000 },
        }),
        createMockJob({
          id: "job3",
          enabled: true,
          state: { nextRunAtMs: now + 90000 },
        }),
      ];

      const result = findNextJob(jobs, now);

      expect(result).not.toBeNull();
      expect(result!.job.id).toBe("job2");
      expect(result!.runAtMs).toBe(now + 30000);
    });

    it("should skip disabled jobs", () => {
      const now = Date.now();
      const jobs: CronJob[] = [
        createMockJob({
          id: "job1",
          enabled: false,
          state: { nextRunAtMs: now + 10000 },
        }),
        createMockJob({
          id: "job2",
          enabled: true,
          state: { nextRunAtMs: now + 60000 },
        }),
      ];

      const result = findNextJob(jobs, now);

      expect(result!.job.id).toBe("job2");
    });

    it("should skip currently running jobs", () => {
      const now = Date.now();
      const jobs: CronJob[] = [
        createMockJob({
          id: "job1",
          enabled: true,
          state: { nextRunAtMs: now + 10000, runningAtMs: now - 5000 },
        }),
        createMockJob({
          id: "job2",
          enabled: true,
          state: { nextRunAtMs: now + 60000 },
        }),
      ];

      const result = findNextJob(jobs, now);

      expect(result!.job.id).toBe("job2");
    });

    it("should return null if no jobs", () => {
      const result = findNextJob([], Date.now());

      expect(result).toBeNull();
    });
  });

  describe("findDueJobs", () => {
    it("should find all jobs that are due", () => {
      const now = Date.now();
      const jobs: CronJob[] = [
        createMockJob({
          id: "job1",
          enabled: true,
          state: { nextRunAtMs: now - 1000 }, // Due
        }),
        createMockJob({
          id: "job2",
          enabled: true,
          state: { nextRunAtMs: now - 5000 }, // Due
        }),
        createMockJob({
          id: "job3",
          enabled: true,
          state: { nextRunAtMs: now + 60000 }, // Not due
        }),
      ];

      const result = findDueJobs(jobs, now);

      expect(result).toHaveLength(2);
      expect(result.map((j) => j.id)).toContain("job1");
      expect(result.map((j) => j.id)).toContain("job2");
    });

    it("should not include disabled jobs", () => {
      const now = Date.now();
      const jobs: CronJob[] = [
        createMockJob({
          id: "job1",
          enabled: false,
          state: { nextRunAtMs: now - 1000 },
        }),
      ];

      const result = findDueJobs(jobs, now);

      expect(result).toHaveLength(0);
    });
  });

  describe("validateSchedule", () => {
    it("should validate at schedule", () => {
      expect(validateSchedule({ kind: "at", atMs: Date.now() + 1000 })).toEqual({
        valid: true,
      });
      expect(validateSchedule({ kind: "at", atMs: -1 })).toEqual({
        valid: false,
        error: "Invalid timestamp",
      });
    });

    it("should validate every schedule", () => {
      expect(validateSchedule({ kind: "every", everyMs: 60000 })).toEqual({
        valid: true,
      });
      expect(validateSchedule({ kind: "every", everyMs: 0 })).toEqual({
        valid: false,
        error: "Interval must be positive",
      });
      expect(validateSchedule({ kind: "every", everyMs: 500 })).toEqual({
        valid: false,
        error: "Interval must be at least 1 second",
      });
    });

    it("should validate cron schedule", () => {
      expect(validateSchedule({ kind: "cron", expr: "* * * * *" })).toEqual({
        valid: true,
      });
      expect(validateSchedule({ kind: "cron", expr: "invalid" })).toEqual({
        valid: false,
        error: "Invalid cron expression",
      });
    });
  });

  describe("formatSchedule", () => {
    it("should format at schedule", () => {
      const timestamp = 1700000000000;
      const result = formatSchedule({ kind: "at", atMs: timestamp });

      expect(result).toContain("at");
      expect(result).toContain("2023");
    });

    it("should format every schedule", () => {
      expect(formatSchedule({ kind: "every", everyMs: 30000 })).toBe("every 30s");
      expect(formatSchedule({ kind: "every", everyMs: 120000 })).toBe("every 2m");
      expect(formatSchedule({ kind: "every", everyMs: 7200000 })).toBe("every 2h");
      expect(formatSchedule({ kind: "every", everyMs: 172800000 })).toBe("every 2d");
    });

    it("should format cron schedule", () => {
      expect(formatSchedule({ kind: "cron", expr: "0 * * * *" })).toBe(
        "cron: 0 * * * *"
      );
      expect(formatSchedule({ kind: "cron", expr: "0 * * * *", tz: "UTC" })).toBe(
        "cron: 0 * * * * (UTC)"
      );
    });
  });
});

// =============================================================================
// Test Helpers
// =============================================================================

function createMockJob(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: "job_test",
    name: "Test Job",
    enabled: true,
    createdAtMs: Date.now(),
    updatedAtMs: Date.now(),
    schedule: { kind: "every", everyMs: 60000 },
    sessionTarget: "main",
    wakeMode: "now",
    payload: { kind: "systemEvent", text: "Test" },
    state: {},
    ...overrides,
  };
}
