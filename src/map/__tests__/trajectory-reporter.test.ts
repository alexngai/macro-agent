/**
 * Tests for Trajectory Reporter — checkpoint reporting & content serving.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
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

// =============================================================================
// Tests — Content Serving via sessionlog
// =============================================================================

describe("TrajectoryReporter — content serving", () => {
  let conn: ReturnType<typeof mockConnection>;
  let tmpDir: string;

  beforeEach(() => {
    conn = mockConnection();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "trajectory-content-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Write a sessionlog-compatible flat state file: <sessionsDir>/<sessionId>.json */
  function writeSessionState(
    sessionsDir: string,
    sessionId: string,
    state: Record<string, unknown>,
    transcript?: string,
  ): string {
    fs.mkdirSync(sessionsDir, { recursive: true });

    const transcriptPath = path.join(sessionsDir, `${sessionId}.jsonl`);
    if (transcript) {
      fs.writeFileSync(transcriptPath, transcript);
    }

    fs.writeFileSync(
      path.join(sessionsDir, `${sessionId}.json`),
      JSON.stringify({
        sessionID: sessionId,
        phase: "active",
        baseCommit: "abc123",
        startedAt: new Date().toISOString(),
        agentType: "claude",
        transcriptPath: transcript ? transcriptPath : undefined,
        ...state,
      }),
    );

    return transcriptPath;
  }

  it("serves transcript from live session matching session ID", async () => {
    const sessionsDir = path.join(tmpDir, "sessions");
    const transcript = [
      JSON.stringify({ type: "user", message: "Fix the bug" }),
      JSON.stringify({ type: "assistant", message: "I'll look into it" }),
    ].join("\n");

    writeSessionState(sessionsDir, "sess-abc", {
      stepCount: 3,
      filesTouched: ["src/main.ts"],
      firstPrompt: "Fix the bug",
    }, transcript);

    createTrajectoryReporter(conn, {
      trajectorySyncLevel: "full",
      sessionDirs: [sessionsDir],
    });

    const handler = conn.onNotification.mock.calls[0][1];
    await handler({ request_id: "req-1", checkpoint_id: "sess-abc-step2" });

    expect(conn.sendNotification).toHaveBeenCalledWith(
      "trajectory/content.response",
      expect.objectContaining({
        request_id: "req-1",
        transcript: expect.stringContaining("Fix the bug"),
        prompts: "Fix the bug",
        metadata: expect.objectContaining({
          sessionID: "sess-abc",
          source: "live",
        }),
      }),
    );
  });

  it("serves transcript matching checkpoint ID in turnCheckpointIDs", async () => {
    const sessionsDir = path.join(tmpDir, "sessions");
    const transcript = JSON.stringify({ type: "user", message: "Deploy it" }) + "\n";

    writeSessionState(sessionsDir, "sess-xyz", {
      turnCheckpointIDs: ["sess-xyz-step1", "sess-xyz-step2"],
      firstPrompt: "Deploy it",
    }, transcript);

    createTrajectoryReporter(conn, {
      trajectorySyncLevel: "full",
      sessionDirs: [sessionsDir],
    });

    const handler = conn.onNotification.mock.calls[0][1];
    await handler({ request_id: "req-2", checkpoint_id: "sess-xyz-step2" });

    expect(conn.sendNotification).toHaveBeenCalledWith(
      "trajectory/content.response",
      expect.objectContaining({
        request_id: "req-2",
        transcript: expect.stringContaining("Deploy it"),
      }),
    );
  });

  it("uses promptAttributions for multi-prompt sessions", async () => {
    const sessionsDir = path.join(tmpDir, "sessions");
    const transcript = JSON.stringify({ type: "user", message: "First" }) + "\n"
      + JSON.stringify({ type: "user", message: "Second" }) + "\n";

    writeSessionState(sessionsDir, "sess-multi", {
      firstPrompt: "First",
      promptAttributions: [
        { prompt: "First", timestamp: "2026-01-01T00:00:00Z", agentLines: 10 },
        { prompt: "Second", timestamp: "2026-01-01T00:01:00Z", agentLines: 5 },
      ],
    }, transcript);

    createTrajectoryReporter(conn, {
      trajectorySyncLevel: "full",
      sessionDirs: [sessionsDir],
    });

    const handler = conn.onNotification.mock.calls[0][1];
    await handler({ request_id: "req-3", checkpoint_id: "sess-multi-step1" });

    expect(conn.sendNotification).toHaveBeenCalledWith(
      "trajectory/content.response",
      expect.objectContaining({
        prompts: "First\n---\nSecond",
      }),
    );
  });

  it("returns empty response when no session found", async () => {
    createTrajectoryReporter(conn, {
      trajectorySyncLevel: "full",
      sessionDirs: [path.join(tmpDir, "nonexistent")],
    });

    const handler = conn.onNotification.mock.calls[0][1];
    await handler({ request_id: "req-4", checkpoint_id: "unknown-session-step1" });

    expect(conn.sendNotification).toHaveBeenCalledWith(
      "trajectory/content.response",
      expect.objectContaining({
        request_id: "req-4",
        transcript: "",
        metadata: expect.objectContaining({ source: "macro-agent" }),
      }),
    );
  });

  it("serves transcripts from ended sessions (content is still valid)", async () => {
    const sessionsDir = path.join(tmpDir, "sessions");
    const transcript = JSON.stringify({ type: "user", message: "Old session" }) + "\n";

    writeSessionState(sessionsDir, "sess-ended", {
      phase: "ended",
    }, transcript);

    createTrajectoryReporter(conn, {
      trajectorySyncLevel: "full",
      sessionDirs: [sessionsDir],
    });

    const handler = conn.onNotification.mock.calls[0][1];
    await handler({ request_id: "req-5", checkpoint_id: "sess-ended-step1" });

    expect(conn.sendNotification).toHaveBeenCalledWith(
      "trajectory/content.response",
      expect.objectContaining({
        request_id: "req-5",
        transcript: expect.stringContaining("Old session"),
      }),
    );
  });

  it("skips sessions with missing transcript path", async () => {
    const sessionsDir = path.join(tmpDir, "sessions");

    // Write state without transcript file
    writeSessionState(sessionsDir, "sess-no-file", {});

    createTrajectoryReporter(conn, {
      trajectorySyncLevel: "full",
      sessionDirs: [sessionsDir],
    });

    const handler = conn.onNotification.mock.calls[0][1];
    await handler({ request_id: "req-6", checkpoint_id: "sess-no-file-step1" });

    const call = conn.sendNotification.mock.calls[0];
    expect(call[1]).toHaveProperty("transcript", "");
  });

  it("sends error response when content handler throws", async () => {
    conn.sendNotification
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce(undefined);

    createTrajectoryReporter(conn, {
      trajectorySyncLevel: "full",
      sessionDirs: [path.join(tmpDir, "nonexistent")],
    });

    const handler = conn.onNotification.mock.calls[0][1];
    await handler({ request_id: "req-7", checkpoint_id: "any" });

    // First call fails, second call sends error response
    expect(conn.sendNotification).toHaveBeenCalledTimes(2);
    expect(conn.sendNotification).toHaveBeenLastCalledWith(
      "trajectory/content.response",
      expect.objectContaining({
        request_id: "req-7",
        error: "Content serving failed",
      }),
    );
  });

  it("searches multiple session directories", async () => {
    const dir1 = path.join(tmpDir, "dir1");
    const dir2 = path.join(tmpDir, "dir2");
    const transcript = JSON.stringify({ type: "user", message: "Found in dir2" }) + "\n";

    // Only dir2 has the session
    fs.mkdirSync(dir1, { recursive: true });
    writeSessionState(dir2, "sess-multi-dir", {}, transcript);

    createTrajectoryReporter(conn, {
      trajectorySyncLevel: "full",
      sessionDirs: [dir1, dir2],
    });

    const handler = conn.onNotification.mock.calls[0][1];
    await handler({ request_id: "req-8", checkpoint_id: "sess-multi-dir-step1" });

    expect(conn.sendNotification).toHaveBeenCalledWith(
      "trajectory/content.response",
      expect.objectContaining({
        transcript: expect.stringContaining("Found in dir2"),
      }),
    );
  });
});
