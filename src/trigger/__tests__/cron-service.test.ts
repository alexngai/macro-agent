/**
 * Cron Service Tests
 *
 * Tests for the cron job scheduling service.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createCronService } from "../sources/cron/cron-service.js";
import type { CronJobCreate, CronEvent } from "../sources/cron/types.js";

describe("CronService", () => {
  let mockDeps: ReturnType<typeof createMockDeps>;
  let cronService: ReturnType<typeof createCronService>;
  let capturedEvents: CronEvent[];

  beforeEach(() => {
    vi.useFakeTimers();
    mockDeps = createMockDeps();
    capturedEvents = [];

    cronService = createCronService(mockDeps, {
      onEvent: (event) => capturedEvents.push(event),
    });
  });

  afterEach(async () => {
    await cronService.stop();
    vi.useRealTimers();
  });

  describe("lifecycle", () => {
    it("should start and stop", async () => {
      expect(cronService.isRunning()).toBe(false);

      await cronService.start();
      expect(cronService.isRunning()).toBe(true);

      await cronService.stop();
      expect(cronService.isRunning()).toBe(false);
    });

    it("should be idempotent for start/stop", async () => {
      await cronService.start();
      await cronService.start();
      expect(cronService.isRunning()).toBe(true);

      await cronService.stop();
      await cronService.stop();
      expect(cronService.isRunning()).toBe(false);
    });
  });

  describe("job management", () => {
    it("should add a job", async () => {
      const jobCreate: CronJobCreate = {
        name: "Test Job",
        enabled: true,
        schedule: { kind: "every", everyMs: 60000 },
        sessionTarget: "main",
        wakeMode: "now",
        payload: { kind: "systemEvent", text: "Test event" },
      };

      const job = await cronService.add(jobCreate);

      expect(job.id).toBeDefined();
      expect(job.name).toBe("Test Job");
      expect(job.enabled).toBe(true);
      expect(job.state.nextRunAtMs).toBeDefined();
    });

    it("should list jobs", async () => {
      await cronService.add({
        name: "Job 1",
        enabled: true,
        schedule: { kind: "every", everyMs: 60000 },
        sessionTarget: "main",
        wakeMode: "now",
        payload: { kind: "systemEvent", text: "Event 1" },
      });

      await cronService.add({
        name: "Job 2",
        enabled: false,
        schedule: { kind: "every", everyMs: 60000 },
        sessionTarget: "main",
        wakeMode: "now",
        payload: { kind: "systemEvent", text: "Event 2" },
      });

      const enabledJobs = await cronService.list();
      expect(enabledJobs).toHaveLength(1);
      expect(enabledJobs[0].name).toBe("Job 1");

      const allJobs = await cronService.list({ includeDisabled: true });
      expect(allJobs).toHaveLength(2);
    });

    it("should get a job by ID", async () => {
      const job = await cronService.add({
        name: "Test Job",
        enabled: true,
        schedule: { kind: "every", everyMs: 60000 },
        sessionTarget: "main",
        wakeMode: "now",
        payload: { kind: "systemEvent", text: "Test" },
      });

      const fetched = await cronService.get(job.id);
      expect(fetched).toEqual(job);
    });

    it("should return null for non-existent job", async () => {
      const fetched = await cronService.get("nonexistent");
      expect(fetched).toBeNull();
    });

    it("should update a job", async () => {
      const job = await cronService.add({
        name: "Test Job",
        enabled: true,
        schedule: { kind: "every", everyMs: 60000 },
        sessionTarget: "main",
        wakeMode: "now",
        payload: { kind: "systemEvent", text: "Test" },
      });

      const updated = await cronService.update(job.id, {
        name: "Updated Job",
        schedule: { kind: "every", everyMs: 120000 },
      });

      expect(updated.name).toBe("Updated Job");
      expect(updated.schedule).toEqual({ kind: "every", everyMs: 120000 });
    });

    it("should throw when updating non-existent job", async () => {
      await expect(
        cronService.update("nonexistent", { name: "New Name" })
      ).rejects.toThrow("Job not found");
    });

    it("should remove a job", async () => {
      const job = await cronService.add({
        name: "Test Job",
        enabled: true,
        schedule: { kind: "every", everyMs: 60000 },
        sessionTarget: "main",
        wakeMode: "now",
        payload: { kind: "systemEvent", text: "Test" },
      });

      await cronService.remove(job.id);

      const fetched = await cronService.get(job.id);
      expect(fetched).toBeNull();
      expect(capturedEvents).toContainEqual({
        action: "removed",
        jobId: job.id,
      });
    });

    it("should throw when removing non-existent job", async () => {
      await expect(cronService.remove("nonexistent")).rejects.toThrow(
        "Job not found"
      );
    });

    it("should enable/disable a job", async () => {
      const job = await cronService.add({
        name: "Test Job",
        enabled: true,
        schedule: { kind: "every", everyMs: 60000 },
        sessionTarget: "main",
        wakeMode: "now",
        payload: { kind: "systemEvent", text: "Test" },
      });

      const disabled = await cronService.disable(job.id);
      expect(disabled.enabled).toBe(false);
      expect(disabled.state.nextRunAtMs).toBeUndefined();

      const enabled = await cronService.enable(job.id);
      expect(enabled.enabled).toBe(true);
      expect(enabled.state.nextRunAtMs).toBeDefined();
    });
  });

  describe("schedule validation", () => {
    it("should reject invalid at schedule", async () => {
      await expect(
        cronService.add({
          name: "Invalid",
          enabled: true,
          schedule: { kind: "at", atMs: -1 },
          sessionTarget: "main",
          wakeMode: "now",
          payload: { kind: "systemEvent", text: "Test" },
        })
      ).rejects.toThrow("Invalid schedule");
    });

    it("should reject invalid every schedule", async () => {
      await expect(
        cronService.add({
          name: "Invalid",
          enabled: true,
          schedule: { kind: "every", everyMs: 0 },
          sessionTarget: "main",
          wakeMode: "now",
          payload: { kind: "systemEvent", text: "Test" },
        })
      ).rejects.toThrow("Invalid schedule");
    });

    it("should reject interval below 1 second", async () => {
      await expect(
        cronService.add({
          name: "Invalid",
          enabled: true,
          schedule: { kind: "every", everyMs: 500 },
          sessionTarget: "main",
          wakeMode: "now",
          payload: { kind: "systemEvent", text: "Test" },
        })
      ).rejects.toThrow("Invalid schedule");
    });

    it("should reject invalid cron expression", async () => {
      await expect(
        cronService.add({
          name: "Invalid",
          enabled: true,
          schedule: { kind: "cron", expr: "invalid" },
          sessionTarget: "main",
          wakeMode: "now",
          payload: { kind: "systemEvent", text: "Test" },
        })
      ).rejects.toThrow("Invalid schedule");
    });

    it("should accept valid cron expression", async () => {
      const job = await cronService.add({
        name: "Valid Cron",
        enabled: true,
        schedule: { kind: "cron", expr: "0 * * * *" },
        sessionTarget: "main",
        wakeMode: "now",
        payload: { kind: "systemEvent", text: "Test" },
      });

      expect(job.schedule).toEqual({ kind: "cron", expr: "0 * * * *" });
    });
  });

  describe("job execution", () => {
    it("should execute job when due", async () => {
      mockDeps.triggerRouter.route = vi.fn().mockResolvedValue({
        success: true,
        deliveredTo: ["agent_1"],
      });

      await cronService.start();

      const job = await cronService.add({
        name: "Test Job",
        enabled: true,
        schedule: { kind: "every", everyMs: 1000 },
        sessionTarget: "main",
        wakeMode: "now",
        payload: { kind: "systemEvent", text: "Execute me" },
      });

      // Advance time past first interval
      await vi.advanceTimersByTimeAsync(1100);

      expect(mockDeps.triggerRouter.route).toHaveBeenCalled();
      expect(capturedEvents).toContainEqual(
        expect.objectContaining({
          action: "started",
          jobId: job.id,
        })
      );
      expect(capturedEvents).toContainEqual(
        expect.objectContaining({
          action: "finished",
          jobId: job.id,
          status: "ok",
        })
      );
    });

    it("should request wake for immediate mode jobs", async () => {
      mockDeps.triggerRouter.route = vi.fn().mockResolvedValue({
        success: true,
        deliveredTo: ["agent_1"],
      });

      await cronService.start();

      await cronService.add({
        name: "Immediate Job",
        enabled: true,
        schedule: { kind: "every", everyMs: 1000 },
        sessionTarget: "main",
        wakeMode: "now",
        payload: { kind: "systemEvent", text: "Wake now" },
      });

      await vi.advanceTimersByTimeAsync(1100);

      expect(mockDeps.wakeManager.requestWakeNow).toHaveBeenCalled();
    });

    it("should not request wake for next-prompt mode jobs", async () => {
      mockDeps.triggerRouter.route = vi.fn().mockResolvedValue({
        success: true,
        deliveredTo: ["agent_1"],
      });

      await cronService.start();

      await cronService.add({
        name: "Queue Job",
        enabled: true,
        schedule: { kind: "every", everyMs: 1000 },
        sessionTarget: "main",
        wakeMode: "next-prompt",
        payload: { kind: "systemEvent", text: "Queue me" },
      });

      await vi.advanceTimersByTimeAsync(1100);

      expect(mockDeps.wakeManager.requestWakeNow).not.toHaveBeenCalled();
    });

    it("should handle routing errors", async () => {
      mockDeps.triggerRouter.route = vi.fn().mockResolvedValue({
        success: false,
        error: "Routing failed",
        deliveredTo: [],
      });

      await cronService.start();

      const job = await cronService.add({
        name: "Error Job",
        enabled: true,
        schedule: { kind: "every", everyMs: 1000 },
        sessionTarget: "main",
        wakeMode: "now",
        payload: { kind: "systemEvent", text: "Error" },
      });

      await vi.advanceTimersByTimeAsync(1100);

      const updatedJob = await cronService.get(job.id);
      expect(updatedJob?.state.lastStatus).toBe("error");
      expect(updatedJob?.state.lastError).toContain("failed");
    });

    it("should disable one-shot jobs after execution", async () => {
      mockDeps.triggerRouter.route = vi.fn().mockResolvedValue({
        success: true,
        deliveredTo: ["agent_1"],
      });

      await cronService.start();

      const futureTime = Date.now() + 1000;
      const job = await cronService.add({
        name: "One-shot Job",
        enabled: true,
        schedule: { kind: "at", atMs: futureTime },
        sessionTarget: "main",
        wakeMode: "now",
        payload: { kind: "systemEvent", text: "Once" },
      });

      await vi.advanceTimersByTimeAsync(1100);

      const updatedJob = await cronService.get(job.id);
      expect(updatedJob?.enabled).toBe(false);
      expect(capturedEvents).toContainEqual({
        action: "disabled",
        jobId: job.id,
      });
    });

    it("should delete one-shot jobs if configured", async () => {
      mockDeps.triggerRouter.route = vi.fn().mockResolvedValue({
        success: true,
        deliveredTo: ["agent_1"],
      });

      await cronService.start();

      const futureTime = Date.now() + 1000;
      const job = await cronService.add({
        name: "Delete After Run",
        enabled: true,
        deleteAfterRun: true,
        schedule: { kind: "at", atMs: futureTime },
        sessionTarget: "main",
        wakeMode: "now",
        payload: { kind: "systemEvent", text: "Delete me" },
      });

      await vi.advanceTimersByTimeAsync(1100);

      const deletedJob = await cronService.get(job.id);
      expect(deletedJob).toBeNull();
      expect(capturedEvents).toContainEqual({
        action: "removed",
        jobId: job.id,
      });
    });

    it("should run job manually", async () => {
      mockDeps.triggerRouter.route = vi.fn().mockResolvedValue({
        success: true,
        deliveredTo: ["agent_1"],
      });

      const job = await cronService.add({
        name: "Manual Job",
        enabled: true,
        schedule: { kind: "every", everyMs: 60000 },
        sessionTarget: "main",
        wakeMode: "now",
        payload: { kind: "systemEvent", text: "Manual trigger" },
      });

      await cronService.run(job.id);

      expect(mockDeps.triggerRouter.route).toHaveBeenCalled();
    });

    it("should throw when running disabled job without force", async () => {
      const job = await cronService.add({
        name: "Disabled Job",
        enabled: false,
        schedule: { kind: "every", everyMs: 60000 },
        sessionTarget: "main",
        wakeMode: "now",
        payload: { kind: "systemEvent", text: "Disabled" },
      });

      await expect(cronService.run(job.id)).rejects.toThrow("Job is disabled");
    });

    it("should run disabled job with force option", async () => {
      mockDeps.triggerRouter.route = vi.fn().mockResolvedValue({
        success: true,
        deliveredTo: ["agent_1"],
      });

      const job = await cronService.add({
        name: "Disabled Job",
        enabled: false,
        schedule: { kind: "every", everyMs: 60000 },
        sessionTarget: "main",
        wakeMode: "now",
        payload: { kind: "systemEvent", text: "Force run" },
      });

      await cronService.run(job.id, { force: true });

      expect(mockDeps.triggerRouter.route).toHaveBeenCalled();
    });
  });

  describe("job scheduling", () => {
    it("should compute next run time on add", async () => {
      const job = await cronService.add({
        name: "Scheduled Job",
        enabled: true,
        schedule: { kind: "every", everyMs: 60000 },
        sessionTarget: "main",
        wakeMode: "now",
        payload: { kind: "systemEvent", text: "Scheduled" },
      });

      expect(job.state.nextRunAtMs).toBeDefined();
      expect(job.state.nextRunAtMs).toBeGreaterThan(Date.now());
    });

    it("should update next run time after execution", async () => {
      mockDeps.triggerRouter.route = vi.fn().mockResolvedValue({
        success: true,
        deliveredTo: ["agent_1"],
      });

      await cronService.start();

      const job = await cronService.add({
        name: "Recurring Job",
        enabled: true,
        schedule: { kind: "every", everyMs: 1000 },
        sessionTarget: "main",
        wakeMode: "now",
        payload: { kind: "systemEvent", text: "Recurring" },
      });

      const firstNextRun = job.state.nextRunAtMs;

      await vi.advanceTimersByTimeAsync(1100);

      const updatedJob = await cronService.get(job.id);
      expect(updatedJob?.state.nextRunAtMs).toBeGreaterThan(firstNextRun!);
    });

    it("should emit scheduled event", async () => {
      const job = await cronService.add({
        name: "New Job",
        enabled: true,
        schedule: { kind: "every", everyMs: 60000 },
        sessionTarget: "main",
        wakeMode: "now",
        payload: { kind: "systemEvent", text: "New" },
      });

      expect(capturedEvents).toContainEqual({
        action: "scheduled",
        jobId: job.id,
        nextRunAtMs: job.state.nextRunAtMs,
      });
    });
  });
});

// =============================================================================
// Test Helpers
// =============================================================================

function createMockDeps() {
  return {
    triggerRouter: {
      route: vi.fn().mockResolvedValue({
        success: true,
        deliveredTo: [],
      }),
    } as any,
    wakeManager: {
      requestWakeNow: vi.fn(),
    } as any,
  };
}
