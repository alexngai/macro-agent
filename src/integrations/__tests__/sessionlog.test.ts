/**
 * Unit Tests for Sessionlog Integration
 *
 * Tests `findActiveSession()` and `enrichCheckpoint()` from the sessionlog
 * module which reads sessionlog state files and enriches trajectory checkpoints.
 *
 * Run:
 *   npx vitest run src/integrations/__tests__/sessionlog.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  findActiveSession,
  enrichCheckpoint,
  type SessionState,
} from "../sessionlog.js";
import type { TrajectoryCheckpointPayload } from "../../map/types.js";

// ─────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────

let tmpDir: string;

function createSessionState(
  sessionId: string,
  state: Record<string, unknown>,
  location: "git" | "swarm" = "git",
): void {
  const baseDir =
    location === "git"
      ? path.join(tmpDir, ".git", "sessionlog-sessions")
      : path.join(tmpDir, ".swarm", "sessionlog", "sessions");

  const sessionDir = path.join(baseDir, sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(
    path.join(sessionDir, "state.json"),
    JSON.stringify(state),
  );
}

function makeBaseCheckpoint(
  overrides: Partial<TrajectoryCheckpointPayload> = {},
): TrajectoryCheckpointPayload {
  return {
    id: "cp-1",
    session_id: "s-1",
    agent: "test-agent",
    branch: "main",
    files_touched: ["src/index.ts"],
    checkpoints_count: 1,
    token_usage: {
      input_tokens: 100,
      output_tokens: 50,
    },
    metadata: {
      project: "test-project",
      phase: "active",
    },
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────
// Setup / Teardown
// ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sessionlog-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────
// findActiveSession
// ─────────────────────────────────────────────────────────────────

describe("findActiveSession", () => {
  it("returns null when no sessionlog directory exists", () => {
    const result = findActiveSession(tmpDir);
    expect(result).toBeNull();
  });

  it("returns null when sessions directory is empty", () => {
    fs.mkdirSync(path.join(tmpDir, ".git", "sessionlog-sessions"), {
      recursive: true,
    });

    const result = findActiveSession(tmpDir);
    expect(result).toBeNull();
  });

  it("returns null when all sessions are ended", () => {
    createSessionState("session-001", {
      sessionId: "session-001",
      phase: "ended",
      endedAt: "2026-01-01T12:00:00Z",
    });

    createSessionState("session-002", {
      sessionId: "session-002",
      phase: "ended",
      endedAt: "2026-01-01T13:00:00Z",
    });

    const result = findActiveSession(tmpDir);
    expect(result).toBeNull();
  });

  it("returns active session state with correct fields", () => {
    createSessionState("session-abc", {
      sessionId: "session-abc",
      phase: "active",
      turnId: "turn-5",
      stepCount: 12,
      lastCheckpointId: "cp-3",
      tokenUsage: {
        inputTokens: 1500,
        outputTokens: 800,
        cacheCreationTokens: 200,
        cacheReadTokens: 100,
        apiCallCount: 5,
      },
      filesTouched: ["src/main.ts", "README.md"],
      startedAt: "2026-03-15T10:00:00Z",
    });

    const result = findActiveSession(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe("session-abc");
    expect(result!.phase).toBe("active");
    expect(result!.turnId).toBe("turn-5");
    expect(result!.stepCount).toBe(12);
    expect(result!.lastCheckpointId).toBe("cp-3");
    expect(result!.tokenUsage).toEqual({
      input_tokens: 1500,
      output_tokens: 800,
      cache_creation_tokens: 200,
      cache_read_tokens: 100,
      api_call_count: 5,
    });
    expect(result!.filesTouched).toEqual(["src/main.ts", "README.md"]);
    expect(result!.startedAt).toBe("2026-03-15T10:00:00Z");
  });

  it("handles snake_case token usage fields", () => {
    createSessionState("session-snake", {
      sessionId: "session-snake",
      phase: "active",
      tokenUsage: {
        input_tokens: 500,
        output_tokens: 300,
        cache_creation_tokens: 50,
        cache_read_tokens: 25,
        api_call_count: 3,
      },
    });

    const result = findActiveSession(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.tokenUsage).toEqual({
      input_tokens: 500,
      output_tokens: 300,
      cache_creation_tokens: 50,
      cache_read_tokens: 25,
      api_call_count: 3,
    });
  });

  it("uses directory name as sessionId when state has no sessionId", () => {
    createSessionState("fallback-id-123", {
      phase: "active",
    });

    const result = findActiveSession(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe("fallback-id-123");
  });

  it("handles alternative field names (currentTurnId, totalSteps, files_touched, started_at)", () => {
    createSessionState("session-alt", {
      sessionId: "session-alt",
      phase: "active",
      currentTurnId: "alt-turn-2",
      totalSteps: 7,
      files_touched: ["alt.ts"],
      started_at: "2026-02-01T08:00:00Z",
    });

    const result = findActiveSession(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.turnId).toBe("alt-turn-2");
    expect(result!.stepCount).toBe(7);
    expect(result!.filesTouched).toEqual(["alt.ts"]);
    expect(result!.startedAt).toBe("2026-02-01T08:00:00Z");
  });

  it("handles missing/corrupted state files gracefully", () => {
    // Create a session directory without a state.json
    const sessionDir = path.join(
      tmpDir,
      ".git",
      "sessionlog-sessions",
      "session-nofile",
    );
    fs.mkdirSync(sessionDir, { recursive: true });

    // Create a session with invalid JSON
    const corruptDir = path.join(
      tmpDir,
      ".git",
      "sessionlog-sessions",
      "session-corrupt",
    );
    fs.mkdirSync(corruptDir, { recursive: true });
    fs.writeFileSync(path.join(corruptDir, "state.json"), "not valid json{{{");

    // Also create a valid active session
    createSessionState("session-valid", {
      sessionId: "session-valid",
      phase: "active",
    });

    const result = findActiveSession(tmpDir);
    // Should skip corrupt/missing and return the valid one
    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe("session-valid");
  });

  it("skips non-directory entries in sessions folder", () => {
    const sessionsDir = path.join(tmpDir, ".git", "sessionlog-sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    // Create a file (not a directory) in the sessions folder
    fs.writeFileSync(path.join(sessionsDir, "stray-file.json"), "{}");

    createSessionState("session-real", {
      sessionId: "session-real",
      phase: "active",
    });

    const result = findActiveSession(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe("session-real");
  });

  it("searches .swarm/sessionlog/sessions/ as fallback", () => {
    createSessionState(
      "session-swarm",
      {
        sessionId: "session-swarm",
        phase: "active",
        turnId: "swarm-turn-1",
      },
      "swarm",
    );

    const result = findActiveSession(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe("session-swarm");
    expect(result!.turnId).toBe("swarm-turn-1");
  });

  it("prefers .git path over .swarm path (checks .git first)", () => {
    createSessionState(
      "session-git",
      {
        sessionId: "session-git",
        phase: "active",
      },
      "git",
    );

    createSessionState(
      "session-swarm",
      {
        sessionId: "session-swarm",
        phase: "active",
      },
      "swarm",
    );

    const result = findActiveSession(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe("session-git");
  });

  it("returns most recent session (sorted descending by name)", () => {
    createSessionState("aaa-old", {
      sessionId: "aaa-old",
      phase: "active",
    });
    createSessionState("zzz-new", {
      sessionId: "zzz-new",
      phase: "active",
    });

    const result = findActiveSession(tmpDir);
    expect(result).not.toBeNull();
    // Descending sort: "zzz" comes first
    expect(result!.sessionId).toBe("zzz-new");
  });

  it("returns null when tokenUsage is missing", () => {
    createSessionState("session-no-tokens", {
      sessionId: "session-no-tokens",
      phase: "active",
    });

    const result = findActiveSession(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.tokenUsage).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────
// enrichCheckpoint
// ─────────────────────────────────────────────────────────────────

describe("enrichCheckpoint", () => {
  it("merges sessionlog data into base checkpoint", () => {
    const state: SessionState = {
      sessionId: "s-1",
      phase: "active",
      turnId: "turn-10",
      stepCount: 25,
      lastCheckpointId: "cp-5",
      startedAt: "2026-03-20T09:00:00Z",
    };
    const base = makeBaseCheckpoint();

    const enriched = enrichCheckpoint(state, base);

    expect(enriched.metadata?.turnId).toBe("turn-10");
    expect(enriched.metadata?.stepCount).toBe(25);
    expect(enriched.metadata?.lastCheckpointID).toBe("cp-5");
    expect(enriched.metadata?.startedAt).toBe("2026-03-20T09:00:00Z");
    // Base metadata preserved
    expect(enriched.metadata?.project).toBe("test-project");
    expect(enriched.metadata?.phase).toBe("active");
  });

  it("token usage from sessionlog overrides base checkpoint", () => {
    const state: SessionState = {
      sessionId: "s-1",
      phase: "active",
      tokenUsage: {
        input_tokens: 5000,
        output_tokens: 3000,
        cache_creation_tokens: 500,
        cache_read_tokens: 250,
        api_call_count: 15,
      },
    };
    const base = makeBaseCheckpoint({
      token_usage: { input_tokens: 100, output_tokens: 50 },
    });

    const enriched = enrichCheckpoint(state, base);

    expect(enriched.token_usage).toEqual({
      input_tokens: 5000,
      output_tokens: 3000,
      cache_creation_tokens: 500,
      cache_read_tokens: 250,
      api_call_count: 15,
    });
  });

  it("preserves base token usage when sessionlog has none", () => {
    const state: SessionState = {
      sessionId: "s-1",
      phase: "active",
    };
    const base = makeBaseCheckpoint({
      token_usage: { input_tokens: 100, output_tokens: 50 },
    });

    const enriched = enrichCheckpoint(state, base);

    expect(enriched.token_usage).toEqual({
      input_tokens: 100,
      output_tokens: 50,
    });
  });

  it("files from sessionlog merge with existing files (deduplicated)", () => {
    const state: SessionState = {
      sessionId: "s-1",
      phase: "active",
      filesTouched: ["src/index.ts", "src/new-file.ts", "package.json"],
    };
    const base = makeBaseCheckpoint({
      files_touched: ["src/index.ts", "README.md"],
    });

    const enriched = enrichCheckpoint(state, base);

    // Merged + deduplicated
    expect(enriched.files_touched).toHaveLength(4);
    expect(enriched.files_touched).toContain("src/index.ts");
    expect(enriched.files_touched).toContain("README.md");
    expect(enriched.files_touched).toContain("src/new-file.ts");
    expect(enriched.files_touched).toContain("package.json");
  });

  it("handles empty filesTouched from sessionlog", () => {
    const state: SessionState = {
      sessionId: "s-1",
      phase: "active",
      filesTouched: [],
    };
    const base = makeBaseCheckpoint({
      files_touched: ["src/index.ts"],
    });

    const enriched = enrichCheckpoint(state, base);
    expect(enriched.files_touched).toEqual(["src/index.ts"]);
  });

  it("handles undefined filesTouched from sessionlog", () => {
    const state: SessionState = {
      sessionId: "s-1",
      phase: "active",
    };
    const base = makeBaseCheckpoint({
      files_touched: ["src/index.ts"],
    });

    const enriched = enrichCheckpoint(state, base);
    expect(enriched.files_touched).toEqual(["src/index.ts"]);
  });

  it("preserves base fields not overridden by sessionlog", () => {
    const state: SessionState = {
      sessionId: "s-1",
      phase: "active",
      turnId: "turn-1",
    };
    const base = makeBaseCheckpoint({
      id: "original-cp",
      session_id: "original-session",
      agent: "original-agent",
      branch: "feature-branch",
      checkpoints_count: 5,
    });

    const enriched = enrichCheckpoint(state, base);

    expect(enriched.id).toBe("original-cp");
    expect(enriched.session_id).toBe("original-session");
    expect(enriched.agent).toBe("original-agent");
    expect(enriched.branch).toBe("feature-branch");
    expect(enriched.checkpoints_count).toBe(5);
  });

  it("sessionlog turnId overrides base metadata turnId", () => {
    const state: SessionState = {
      sessionId: "s-1",
      phase: "active",
      turnId: "new-turn",
    };
    const base = makeBaseCheckpoint({
      metadata: { turnId: "old-turn", project: "keep-this" },
    });

    const enriched = enrichCheckpoint(state, base);
    expect(enriched.metadata?.turnId).toBe("new-turn");
    expect(enriched.metadata?.project).toBe("keep-this");
  });

  it("falls back to base metadata values when sessionlog fields are undefined", () => {
    const state: SessionState = {
      sessionId: "s-1",
      phase: "active",
      // No turnId, stepCount, etc.
    };
    const base = makeBaseCheckpoint({
      metadata: {
        turnId: "base-turn",
        stepCount: 10,
        lastCheckpointID: "base-cp",
        startedAt: "2026-01-01T00:00:00Z",
      },
    });

    const enriched = enrichCheckpoint(state, base);
    expect(enriched.metadata?.turnId).toBe("base-turn");
    expect(enriched.metadata?.stepCount).toBe(10);
    expect(enriched.metadata?.lastCheckpointID).toBe("base-cp");
    expect(enriched.metadata?.startedAt).toBe("2026-01-01T00:00:00Z");
  });
});
