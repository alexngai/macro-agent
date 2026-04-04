/**
 * Trajectory Content Serving E2E Test
 *
 * Verifies end-to-end that the trajectory reporter can serve session
 * transcripts via sessionlog when the hub sends trajectory/content.request.
 *
 * Tests the full content resolution pipeline:
 *   1. Live session lookup from sessionlog state files
 *   2. Prompt extraction from various JSONL transcript formats
 *   3. Multi-directory search (simulating multiple agent workspaces)
 *   4. Checkpoint ID matching strategies (session ID, lastCheckpointID, turnCheckpointIDs)
 *   5. Graceful degradation when sessions aren't found
 *   6. Reporter lifecycle (register/unregister content handler)
 *
 * All tests use tmp dirs to avoid interfering with active sessionlog files.
 *
 * Run:
 *   npx vitest run src/__tests__/e2e/trajectory-content.e2e.test.ts
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync } from "node:child_process";
import {
  createTrajectoryReporter,
  type TrajectoryConnection,
} from "../../map/trajectory-reporter.js";
import type { TrajectoryReporter } from "../../map/types.js";

// =============================================================================
// Test fixtures — simulate sessionlog directory layouts
// =============================================================================

/** Root tmp dir for all tests */
let rootTmpDir: string;

/** Workspace dirs simulating different agent cwds */
let workspace1Dir: string;
let workspace2Dir: string;
let emptyWorkspaceDir: string;

/** Session directories within workspaces */
let sessionsDir1: string;
let sessionsDir2: string;

/** Sample JSONL transcripts in various agent formats */
const CLAUDE_CODE_TRANSCRIPT = [
  JSON.stringify({
    type: "user",
    message: { role: "user", content: "Fix the authentication bug in login.ts" },
  }),
  JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "I'll investigate the auth issue." },
      ],
    },
  }),
  JSON.stringify({
    type: "tool_use",
    tool_name: "Read",
    input: { file_path: "/src/login.ts" },
  }),
  JSON.stringify({
    type: "tool_result",
    tool_use_id: "tu_1",
    content: "export function login() { ... }",
  }),
  JSON.stringify({
    type: "user",
    message: { role: "user", content: "Now add rate limiting" },
  }),
  JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: "Adding rate limiter." },
  }),
].join("\n") + "\n";

const MULTI_BLOCK_TRANSCRIPT = [
  JSON.stringify({
    type: "user",
    message: {
      content: [
        { type: "text", text: "First instruction" },
        { type: "image", source: { type: "base64", data: "..." } },
        { type: "text", text: "Second instruction" },
      ],
    },
  }),
  JSON.stringify({ type: "assistant", message: "Working on it" }),
].join("\n") + "\n";

const SIMPLE_STRING_TRANSCRIPT = [
  JSON.stringify({ type: "user", message: "Simple prompt" }),
  JSON.stringify({ type: "assistant", message: "Simple response" }),
].join("\n") + "\n";

// =============================================================================
// Setup / Teardown
// =============================================================================

/** Write a sessionlog-compatible flat state file: <sessionsDir>/<sessionId>.json */
function writeSession(
  sessionsDir: string,
  sessionId: string,
  state: Record<string, unknown>,
  transcript: string,
): void {
  fs.mkdirSync(sessionsDir, { recursive: true });
  const transcriptPath = path.join(sessionsDir, `${sessionId}.jsonl`);
  fs.writeFileSync(transcriptPath, transcript);
  fs.writeFileSync(
    path.join(sessionsDir, `${sessionId}.json`),
    JSON.stringify({
      sessionID: sessionId,
      phase: "active",
      baseCommit: "abc123",
      startedAt: "2026-04-04T00:00:00Z",
      agentType: "claude",
      transcriptPath,
      ...state,
    }),
  );
}

beforeAll(() => {
  rootTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "trajectory-content-e2e-"));

  // Workspace 1: two sessions (one active with Claude Code transcript, one ended)
  workspace1Dir = path.join(rootTmpDir, "workspace1");
  sessionsDir1 = path.join(workspace1Dir, ".git", "sessionlog-sessions");

  writeSession(sessionsDir1, "sess-auth-fix", {
    stepCount: 5,
    lastCheckpointID: "sess-auth-fix-step5",
    turnCheckpointIDs: [
      "sess-auth-fix-step1",
      "sess-auth-fix-step3",
      "sess-auth-fix-step5",
    ],
    filesTouched: ["src/login.ts", "src/rate-limiter.ts"],
    tokenUsage: {
      input_tokens: 1500,
      output_tokens: 800,
      cache_read_tokens: 200,
    },
    firstPrompt: "Fix the authentication bug in login.ts",
    promptAttributions: [
      { prompt: "Fix the authentication bug in login.ts", timestamp: "2026-04-04T00:00:00Z", agentLines: 20 },
      { prompt: "Now add rate limiting", timestamp: "2026-04-04T00:01:00Z", agentLines: 15 },
    ],
  }, CLAUDE_CODE_TRANSCRIPT);

  writeSession(sessionsDir1, "sess-old-work", {
    phase: "ended",
    stepCount: 2,
    endedAt: "2026-04-03T11:00:00Z",
    firstPrompt: "Simple prompt",
  }, SIMPLE_STRING_TRANSCRIPT);

  // Workspace 2: one session with multi-block content
  workspace2Dir = path.join(rootTmpDir, "workspace2");
  sessionsDir2 = path.join(workspace2Dir, ".swarm", "sessionlog", "sessions");

  writeSession(sessionsDir2, "sess-multiblock", {
    firstPrompt: "First instruction\nSecond instruction",
  }, MULTI_BLOCK_TRANSCRIPT);

  // Empty workspace: no sessions
  emptyWorkspaceDir = path.join(rootTmpDir, "empty");
  fs.mkdirSync(emptyWorkspaceDir, { recursive: true });
});

afterAll(() => {
  fs.rmSync(rootTmpDir, { recursive: true, force: true });
});

// =============================================================================
// Helpers
// =============================================================================

interface MockConnection extends TrajectoryConnection {
  callExtension: ReturnType<typeof vi.fn>;
  sendNotification: ReturnType<typeof vi.fn>;
  onNotification: ReturnType<typeof vi.fn>;
  offNotification: ReturnType<typeof vi.fn>;
  contentHandler: ((params: unknown) => Promise<void>) | null;
}

function createMockConnection(): MockConnection {
  const conn: MockConnection = {
    callExtension: vi.fn().mockResolvedValue({ ok: true }),
    sendNotification: vi.fn().mockResolvedValue(undefined),
    onNotification: vi.fn(),
    offNotification: vi.fn(),
    get isConnected() { return true; },
    contentHandler: null,
  };

  // Capture the content handler when registered
  conn.onNotification.mockImplementation((method: string, handler: any) => {
    if (method === "trajectory/content.request") {
      conn.contentHandler = handler;
    }
  });

  return conn;
}

/** Simulate a content request and return the response params */
async function requestContent(
  conn: MockConnection,
  checkpointId: string,
): Promise<Record<string, unknown>> {
  expect(conn.contentHandler).not.toBeNull();

  const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  await conn.contentHandler!({
    request_id: requestId,
    checkpoint_id: checkpointId,
  });

  // Find the response for this request
  const responseCalls = conn.sendNotification.mock.calls.filter(
    (c: any[]) => c[0] === "trajectory/content.response" && c[1]?.request_id === requestId,
  );
  expect(responseCalls.length).toBe(1);
  return responseCalls[0][1] as Record<string, unknown>;
}

// =============================================================================
// E2E Tests
// =============================================================================

describe("Trajectory Content E2E — live session serving", () => {
  let conn: MockConnection;
  let reporter: TrajectoryReporter;

  beforeAll(() => {
    conn = createMockConnection();
    reporter = createTrajectoryReporter(conn, {
      trajectorySyncLevel: "full",
      sessionDirs: [sessionsDir1, sessionsDir2],
    });
  });

  afterAll(() => {
    reporter.stop();
  });

  it("serves transcript for active session by derived session ID", async () => {
    const response = await requestContent(conn, "sess-auth-fix-step2");

    expect(response.transcript).toContain("Fix the authentication bug");
    expect(response.transcript).toContain("rate limiting");
    expect(response.metadata).toEqual(
      expect.objectContaining({
        sessionID: "sess-auth-fix",
        phase: "active",
        source: "live",
        stepCount: 5,
        filesTouched: ["src/login.ts", "src/rate-limiter.ts"],
      }),
    );
    expect(response.context).toContain("sess-auth-fix");
  });

  it("matches by lastCheckpointID", async () => {
    const response = await requestContent(conn, "sess-auth-fix-step5");

    expect(response.transcript).toContain("Fix the authentication bug");
    expect((response.metadata as any).sessionID).toBe("sess-auth-fix");
  });

  it("matches by turnCheckpointIDs entry", async () => {
    const response = await requestContent(conn, "sess-auth-fix-step3");

    expect(response.transcript).toContain("Fix the authentication bug");
  });

  it("extracts prompts from promptAttributions", async () => {
    const response = await requestContent(conn, "sess-auth-fix-step1");

    const prompts = response.prompts as string;
    expect(prompts).toContain("Fix the authentication bug in login.ts");
    expect(prompts).toContain("Now add rate limiting");
    // Two prompts separated by ---
    expect(prompts.split("---").length).toBe(2);
  });

  it("serves ended session transcripts", async () => {
    const response = await requestContent(conn, "sess-old-work-step1");

    expect(response.transcript).toContain("Simple prompt");
    expect((response.metadata as any).sessionID).toBe("sess-old-work");
    expect((response.metadata as any).phase).toBe("ended");
  });

  it("serves from second session directory (workspace2)", async () => {
    const response = await requestContent(conn, "sess-multiblock-step1");

    expect(response.transcript).toContain("First instruction");
    expect((response.metadata as any).sessionID).toBe("sess-multiblock");
  });

  it("uses firstPrompt when no promptAttributions", async () => {
    const response = await requestContent(conn, "sess-multiblock-step1");

    const prompts = response.prompts as string;
    expect(prompts).toContain("First instruction");
    expect(prompts).toContain("Second instruction");
  });
});

describe("Trajectory Content E2E — no content found", () => {
  let conn: MockConnection;
  let reporter: TrajectoryReporter;

  beforeAll(() => {
    conn = createMockConnection();
    reporter = createTrajectoryReporter(conn, {
      trajectorySyncLevel: "full",
      sessionDirs: [path.join(emptyWorkspaceDir, "nonexistent")],
    });
  });

  afterAll(() => {
    reporter.stop();
  });

  it("returns empty response for unknown session", async () => {
    const response = await requestContent(conn, "sess-nonexistent-step1");

    expect(response.transcript).toBe("");
    expect(response.prompts).toBe("");
    expect((response.metadata as any).source).toBe("macro-agent");
  });

  it("returns empty response for checkpoint with no matching session", async () => {
    const response = await requestContent(conn, "completely-unknown-id");

    expect(response.transcript).toBe("");
  });
});

describe("Trajectory Content E2E — reporter lifecycle", () => {
  it("registers content handler on creation", () => {
    const conn = createMockConnection();
    const reporter = createTrajectoryReporter(conn, {
      trajectorySyncLevel: "full",
      sessionDirs: [],
    });

    expect(conn.contentHandler).not.toBeNull();
    reporter.stop();
  });

  it("unregisters content handler on stop", () => {
    const conn = createMockConnection();
    const reporter = createTrajectoryReporter(conn, {
      trajectorySyncLevel: "full",
      sessionDirs: [],
    });

    reporter.stop();

    expect(conn.offNotification).toHaveBeenCalledWith(
      "trajectory/content.request",
      expect.any(Function),
    );
  });

  it("checkpoint reporting still works alongside content serving", async () => {
    const conn = createMockConnection();
    const reporter = createTrajectoryReporter(conn, {
      trajectorySyncLevel: "metrics",
      sessionDirs: [sessionsDir1],
    });

    const result = await reporter.reportCheckpoint({
      id: "sess-auth-fix-step6",
      session_id: "sess-auth-fix",
      agent: "macro-agent-sidecar",
      branch: "main",
      files_touched: ["src/login.ts"],
      checkpoints_count: 6,
    });

    expect(result).toEqual(expect.objectContaining({ ok: true }));
    expect(conn.callExtension).toHaveBeenCalledWith(
      "trajectory/checkpoint",
      expect.objectContaining({
        checkpoint: expect.objectContaining({ id: "sess-auth-fix-step6" }),
      }),
    );

    reporter.stop();
  });
});

describe("Trajectory Content E2E — edge cases", () => {
  it("handles malformed state.json gracefully", async () => {
    const badDir = path.join(rootTmpDir, "bad-state");
    fs.mkdirSync(badDir, { recursive: true });
    fs.writeFileSync(path.join(badDir, "sess-bad.json"), "not valid json{{{");

    const conn = createMockConnection();
    const reporter = createTrajectoryReporter(conn, {
      trajectorySyncLevel: "full",
      sessionDirs: [badDir],
    });

    const response = await requestContent(conn, "sess-bad-step1");
    expect(response.transcript).toBe("");

    reporter.stop();
  });

  it("handles state.json with missing transcriptPath", async () => {
    const noTranscriptDir = path.join(rootTmpDir, "no-transcript");
    fs.mkdirSync(noTranscriptDir, { recursive: true });
    fs.writeFileSync(
      path.join(noTranscriptDir, "sess-no-file.json"),
      JSON.stringify({
        sessionID: "sess-no-file",
        phase: "active",
        baseCommit: "abc",
        startedAt: new Date().toISOString(),
        agentType: "claude",
      }),
    );

    const conn = createMockConnection();
    const reporter = createTrajectoryReporter(conn, {
      trajectorySyncLevel: "full",
      sessionDirs: [noTranscriptDir],
    });

    const response = await requestContent(conn, "sess-no-file-step1");
    expect(response.transcript).toBe("");

    reporter.stop();
  });

  it("handles transcript with malformed JSONL lines", async () => {
    const malformedDir = path.join(rootTmpDir, "malformed-transcript");
    fs.mkdirSync(malformedDir, { recursive: true });

    const transcriptPath = path.join(malformedDir, "sess-malformed.jsonl");
    fs.writeFileSync(transcriptPath, [
      JSON.stringify({ type: "user", message: "Valid prompt" }),
      "this is not json",
      "{ broken json",
      JSON.stringify({ type: "user", message: "Another valid prompt" }),
    ].join("\n") + "\n");

    fs.writeFileSync(
      path.join(malformedDir, "sess-malformed.json"),
      JSON.stringify({
        sessionID: "sess-malformed",
        phase: "active",
        baseCommit: "abc",
        startedAt: new Date().toISOString(),
        agentType: "claude",
        transcriptPath,
        firstPrompt: "Valid prompt",
      }),
    );

    const conn = createMockConnection();
    const reporter = createTrajectoryReporter(conn, {
      trajectorySyncLevel: "full",
      sessionDirs: [malformedDir],
    });

    const response = await requestContent(conn, "sess-malformed-step1");

    // Transcript is served raw (including malformed lines)
    expect(response.transcript).toContain("Valid prompt");
    expect(response.transcript).toContain("this is not json");
    // Prompts come from state.firstPrompt, not transcript parsing
    expect(response.prompts).toBe("Valid prompt");

    reporter.stop();
  });

  it("handles empty transcript file", async () => {
    const emptyDir = path.join(rootTmpDir, "empty-transcript");
    fs.mkdirSync(emptyDir, { recursive: true });

    const transcriptPath = path.join(emptyDir, "sess-empty.jsonl");
    fs.writeFileSync(transcriptPath, "");

    fs.writeFileSync(
      path.join(emptyDir, "sess-empty.json"),
      JSON.stringify({
        sessionID: "sess-empty",
        phase: "active",
        baseCommit: "abc",
        startedAt: new Date().toISOString(),
        agentType: "claude",
        transcriptPath,
      }),
    );

    const conn = createMockConnection();
    const reporter = createTrajectoryReporter(conn, {
      trajectorySyncLevel: "full",
      sessionDirs: [emptyDir],
    });

    const response = await requestContent(conn, "sess-empty-step1");

    expect(response.transcript).toBe("");
    expect(response.prompts).toBe("");
    // Should still have metadata since the session was found
    expect((response.metadata as any).sessionID).toBe("sess-empty");

    reporter.stop();
  });
});

// =============================================================================
// E2E Tests — Committed checkpoint store (real git repo)
// =============================================================================

describe("Trajectory Content E2E — committed checkpoints via sessionlog", () => {
  let checkpointRepoDir: string;
  let committedCheckpointId: string;
  let checkpointStore: any;

  const COMMITTED_TRANSCRIPT = [
    JSON.stringify({ type: "user", message: "Refactor the database layer" }),
    JSON.stringify({ type: "assistant", message: "I'll restructure the DAL." }),
    JSON.stringify({ type: "tool_use", tool_name: "Edit", input: { file_path: "src/db/dal.ts" } }),
    JSON.stringify({ type: "user", message: "Also add connection pooling" }),
  ].join("\n") + "\n";

  beforeAll(async () => {
    // Create a real git repo for the checkpoint store
    checkpointRepoDir = path.join(rootTmpDir, "checkpoint-repo");
    fs.mkdirSync(checkpointRepoDir, { recursive: true });

    // Initialize git repo with an initial commit
    execSync("git init", { cwd: checkpointRepoDir, stdio: "pipe" });
    execSync("git config user.email 'test@test.com'", { cwd: checkpointRepoDir, stdio: "pipe" });
    execSync("git config user.name 'Test'", { cwd: checkpointRepoDir, stdio: "pipe" });
    execSync("git commit --allow-empty -m 'init'", { cwd: checkpointRepoDir, stdio: "pipe" });

    // Use sessionlog's CheckpointStore to write a committed checkpoint
    try {
      const sessionlog = await import("sessionlog");
      checkpointStore = sessionlog.createCheckpointStore(
        undefined,
        checkpointRepoDir,
        "sessionlog/checkpoints/v1",
      );

      committedCheckpointId = await checkpointStore.generateID();

      await checkpointStore.writeCommitted({
        checkpointID: committedCheckpointId,
        sessionID: "sess-committed-db",
        strategy: "manual-commit",
        branch: "main",
        transcript: Buffer.from(COMMITTED_TRANSCRIPT),
        prompts: ["Refactor the database layer", "Also add connection pooling"],
        context: Buffer.from("Database refactoring session"),
        filesTouched: ["src/db/dal.ts", "src/db/pool.ts"],
        checkpointsCount: 1,
        authorName: "Test Agent",
        authorEmail: "agent@test.com",
        agent: "Claude Code",
        turnID: "turn-committed-1",
        checkpointTranscriptStart: 0,
      });
    } catch (err) {
      // If sessionlog is not available or write fails, skip these tests
      console.warn("[e2e] Skipping committed checkpoint tests:", (err as Error).message);
      checkpointStore = null;
    }
  });

  it("serves transcript from committed checkpoint store", async () => {
    if (!checkpointStore) return; // skip if sessionlog unavailable

    const conn = createMockConnection();
    const reporter = createTrajectoryReporter(conn, {
      trajectorySyncLevel: "full",
      // No live session dirs — force fallback to checkpoint store
      sessionDirs: [],
    });

    // Mock the sessionlog import to use our test repo
    // The resolveContent function imports sessionlog dynamically, so we need
    // to ensure it can find our checkpoint repo. We do this by temporarily
    // changing cwd (createCheckpointStore defaults to cwd).
    const origCwd = process.cwd();
    try {
      process.chdir(checkpointRepoDir);

      const response = await requestContent(conn, committedCheckpointId);

      expect(response.transcript).toContain("Refactor the database layer");
      expect(response.transcript).toContain("connection pooling");
      expect((response.metadata as any).source).toBe("committed");
    } finally {
      process.chdir(origCwd);
    }

    reporter.stop();
  });

  it("committed checkpoint contains correct prompts", async () => {
    if (!checkpointStore) return;

    const conn = createMockConnection();
    const reporter = createTrajectoryReporter(conn, {
      trajectorySyncLevel: "full",
      sessionDirs: [],
    });

    const origCwd = process.cwd();
    try {
      process.chdir(checkpointRepoDir);

      const response = await requestContent(conn, committedCheckpointId);

      const prompts = response.prompts as string;
      expect(prompts).toContain("Refactor the database layer");
      expect(prompts).toContain("connection pooling");
    } finally {
      process.chdir(origCwd);
    }

    reporter.stop();
  });

  it("committed checkpoint includes context", async () => {
    if (!checkpointStore) return;

    const conn = createMockConnection();
    const reporter = createTrajectoryReporter(conn, {
      trajectorySyncLevel: "full",
      sessionDirs: [],
    });

    const origCwd = process.cwd();
    try {
      process.chdir(checkpointRepoDir);

      const response = await requestContent(conn, committedCheckpointId);

      expect(response.context).toContain("Database refactoring session");
    } finally {
      process.chdir(origCwd);
    }

    reporter.stop();
  });

  it("prefers live session over committed checkpoint when both exist", async () => {
    if (!checkpointStore) return;

    // Set up a live session dir that matches the committed checkpoint ID
    const liveDir = path.join(rootTmpDir, "live-override");
    fs.mkdirSync(liveDir, { recursive: true });

    const liveTranscript = JSON.stringify({
      type: "user",
      message: "LIVE SESSION DATA",
    }) + "\n";
    const liveTranscriptPath = path.join(liveDir, "sess-committed-db.jsonl");
    fs.writeFileSync(liveTranscriptPath, liveTranscript);
    fs.writeFileSync(
      path.join(liveDir, "sess-committed-db.json"),
      JSON.stringify({
        sessionID: "sess-committed-db",
        phase: "active",
        baseCommit: "abc",
        startedAt: new Date().toISOString(),
        agentType: "claude",
        transcriptPath: liveTranscriptPath,
        lastCheckpointID: committedCheckpointId,
      }),
    );

    const conn = createMockConnection();
    const reporter = createTrajectoryReporter(conn, {
      trajectorySyncLevel: "full",
      sessionDirs: [liveDir],
    });

    const response = await requestContent(conn, committedCheckpointId);

    // Live session should win over committed
    expect(response.transcript).toContain("LIVE SESSION DATA");
    expect((response.metadata as any).source).toBe("live");

    reporter.stop();
  });
});
