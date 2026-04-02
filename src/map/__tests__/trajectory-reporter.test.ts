/**
 * Tests for Trajectory Reporter — checkpoint building & reporting.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  createTrajectoryReporter,
  type TrajectoryConnection,
} from "../trajectory-reporter.js";
import type { TrajectoryCheckpointPayload } from "../types.js";

function mockConnection(): TrajectoryConnection & {
  callExtension: ReturnType<typeof vi.fn>;
  sendNotification: ReturnType<typeof vi.fn>;
  onNotification: ReturnType<typeof vi.fn>;
  offNotification: ReturnType<typeof vi.fn>;
} {
  return {
    callExtension: vi.fn().mockResolvedValue({
      ok: true,
      resource_id: "res-123",
      created: true,
      checkpoint_id: "cp-1",
    }),
    sendNotification: vi.fn().mockResolvedValue(undefined),
    onNotification: vi.fn(),
    offNotification: vi.fn(),
    get isConnected() {
      return true;
    },
  };
}

function sampleCheckpoint(): TrajectoryCheckpointPayload {
  return {
    id: "session-1-step1",
    session_id: "session-1",
    agent: "macro-agent-sidecar",
    branch: "main",
    files_touched: ["src/index.ts"],
    checkpoints_count: 1,
    token_usage: { input_tokens: 100, output_tokens: 200 },
    metadata: { project: "test-project", phase: "active" },
  };
}

describe("TrajectoryReporter", () => {
  let conn: ReturnType<typeof mockConnection>;

  beforeEach(() => {
    conn = mockConnection();
  });

  it("sends checkpoint via callExtension", async () => {
    const reporter = createTrajectoryReporter(conn, {
      trajectorySyncLevel: "metrics",
    });

    const result = await reporter.reportCheckpoint(sampleCheckpoint());

    expect(conn.callExtension).toHaveBeenCalledWith(
      "trajectory/checkpoint",
      expect.objectContaining({
        checkpoint: expect.objectContaining({
          id: "session-1-step1",
          agent: "macro-agent-sidecar",
        }),
      }),
    );
    expect(result?.ok).toBe(true);
    expect(result?.resource_id).toBe("res-123");
  });

  it("caches resource_id from first response", async () => {
    const reporter = createTrajectoryReporter(conn, {
      trajectorySyncLevel: "metrics",
    });

    // First call
    await reporter.reportCheckpoint(sampleCheckpoint());

    // Second call should include cached resource_id
    await reporter.reportCheckpoint({
      ...sampleCheckpoint(),
      id: "session-1-step2",
    });

    const secondCall = conn.callExtension.mock.calls[1];
    expect(secondCall[1]).toHaveProperty("resource_id", "res-123");
  });

  it("returns null when sync level is off", async () => {
    const reporter = createTrajectoryReporter(conn, {
      trajectorySyncLevel: "off",
    });

    const result = await reporter.reportCheckpoint(sampleCheckpoint());

    expect(result).toBeNull();
    expect(conn.callExtension).not.toHaveBeenCalled();
  });

  it("returns null when disconnected", async () => {
    const disconnected = {
      ...conn,
      get isConnected() {
        return false;
      },
    };
    const reporter = createTrajectoryReporter(disconnected, {
      trajectorySyncLevel: "metrics",
    });

    const result = await reporter.reportCheckpoint(sampleCheckpoint());

    expect(result).toBeNull();
  });

  it("falls back to sendNotification on extension failure", async () => {
    conn.callExtension.mockRejectedValue(new Error("unsupported extension"));

    const reporter = createTrajectoryReporter(conn, {
      trajectorySyncLevel: "metrics",
    });

    const result = await reporter.reportCheckpoint(sampleCheckpoint());

    expect(result).toBeNull();
    expect(conn.sendNotification).toHaveBeenCalledWith(
      "trajectory.checkpoint",
      expect.objectContaining({
        checkpoint: expect.objectContaining({ id: "session-1-step1" }),
      }),
    );
  });

  it("registers content request handler on creation", () => {
    createTrajectoryReporter(conn, { trajectorySyncLevel: "metrics" });

    expect(conn.onNotification).toHaveBeenCalledWith(
      "trajectory/content.request",
      expect.any(Function),
    );
  });

  it("unregisters content request handler on stop", () => {
    const reporter = createTrajectoryReporter(conn, {
      trajectorySyncLevel: "metrics",
    });

    reporter.stop();

    expect(conn.offNotification).toHaveBeenCalledWith(
      "trajectory/content.request",
      expect.any(Function),
    );
  });

  it("responds to content request with sendNotification", async () => {
    createTrajectoryReporter(conn, { trajectorySyncLevel: "metrics" });

    // Get the registered handler
    const handler = conn.onNotification.mock.calls[0][1];

    // Simulate inbound content request
    await handler({ request_id: "req-1", checkpoint_id: "cp-1" });

    expect(conn.sendNotification).toHaveBeenCalledWith(
      "trajectory/content.response",
      expect.objectContaining({ request_id: "req-1" }),
    );
  });
});
