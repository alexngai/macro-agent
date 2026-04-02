/**
 * Sessionlog Integration
 *
 * Reads sessionlog state files to enrich trajectory checkpoints with
 * turn-level metadata (turn IDs, token usage, step counts, etc.).
 *
 * Works with sessionlog's file format regardless of agent type —
 * sessionlog has adapters for Claude Code, Codex, and generic agents.
 *
 * @module integrations/sessionlog
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { TrajectoryCheckpointPayload } from "../map/types.js";

/** Sessionlog session state (subset of fields we need) */
export interface SessionState {
  sessionId: string;
  phase: "active" | "ended";
  turnId?: string;
  stepCount?: number;
  lastCheckpointId?: string;
  tokenUsage?: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_tokens?: number;
    cache_read_tokens?: number;
    api_call_count?: number;
  };
  filesTouched?: string[];
  startedAt?: string;
  endedAt?: string;
}

/**
 * Find the active sessionlog session in the given working directory.
 *
 * Sessionlog stores state in `.git/sessionlog-sessions/<sessionId>/state.json`
 * or in `.swarm/sessionlog/sessions/` depending on configuration.
 */
export function findActiveSession(cwd: string): SessionState | null {
  const searchPaths = [
    join(cwd, ".git", "sessionlog-sessions"),
    join(cwd, ".swarm", "sessionlog", "sessions"),
  ];

  for (const sessionsDir of searchPaths) {
    if (!existsSync(sessionsDir)) continue;

    try {
      const entries = readdirSync(sessionsDir, { withFileTypes: true });
      const sessionDirs = entries
        .filter((e) => e.isDirectory())
        .sort((a, b) => b.name.localeCompare(a.name)); // Most recent first

      for (const dir of sessionDirs) {
        const statePath = join(sessionsDir, dir.name, "state.json");
        if (!existsSync(statePath)) continue;

        try {
          const raw = readFileSync(statePath, "utf-8");
          const state = JSON.parse(raw);

          // Only return active (non-ended) sessions
          if (state.phase === "ended") continue;

          return {
            sessionId: state.sessionId ?? dir.name,
            phase: state.phase ?? "active",
            turnId: state.turnId ?? state.currentTurnId,
            stepCount: state.stepCount ?? state.totalSteps,
            lastCheckpointId: state.lastCheckpointId,
            tokenUsage: state.tokenUsage
              ? {
                  input_tokens: state.tokenUsage.inputTokens ?? state.tokenUsage.input_tokens ?? 0,
                  output_tokens: state.tokenUsage.outputTokens ?? state.tokenUsage.output_tokens ?? 0,
                  cache_creation_tokens: state.tokenUsage.cacheCreationTokens ?? state.tokenUsage.cache_creation_tokens,
                  cache_read_tokens: state.tokenUsage.cacheReadTokens ?? state.tokenUsage.cache_read_tokens,
                  api_call_count: state.tokenUsage.apiCallCount ?? state.tokenUsage.api_call_count,
                }
              : undefined,
            filesTouched: state.filesTouched ?? state.files_touched,
            startedAt: state.startedAt ?? state.started_at,
            endedAt: state.endedAt ?? state.ended_at,
          };
        } catch {
          // Corrupted state file — skip
          continue;
        }
      }
    } catch {
      // Can't read sessions directory
      continue;
    }
  }

  return null;
}

/** Metadata to annotate a sessionlog session with swarm context */
export interface SessionAnnotation {
  teamName?: string;
  template?: string;
  scope?: string;
  swarmId?: string;
  [key: string]: unknown;
}

/**
 * Annotate a sessionlog session with swarm metadata.
 * Writes/merges metadata into the session's state.json file.
 *
 * Searches the same paths as `findActiveSession()`.
 */
export function annotateSession(
  cwd: string,
  metadata: SessionAnnotation,
): boolean {
  const searchPaths = [
    join(cwd, ".git", "sessionlog-sessions"),
    join(cwd, ".swarm", "sessionlog", "sessions"),
  ];

  for (const sessionsDir of searchPaths) {
    if (!existsSync(sessionsDir)) continue;

    try {
      const entries = readdirSync(sessionsDir, { withFileTypes: true });
      const sessionDirs = entries
        .filter((e) => e.isDirectory())
        .sort((a, b) => b.name.localeCompare(a.name));

      for (const dir of sessionDirs) {
        const statePath = join(sessionsDir, dir.name, "state.json");
        if (!existsSync(statePath)) continue;

        try {
          const raw = readFileSync(statePath, "utf-8");
          const state = JSON.parse(raw);

          // Only annotate active sessions
          if (state.phase === "ended") continue;

          // Merge metadata into existing state
          const annotated = {
            ...state,
            swarm: {
              ...(state.swarm ?? {}),
              ...metadata,
            },
          };
          writeFileSync(statePath, JSON.stringify(annotated, null, 2));
          return true;
        } catch {
          continue;
        }
      }
    } catch {
      continue;
    }
  }

  return false;
}

/**
 * Enrich a trajectory checkpoint with sessionlog state data.
 * Sessionlog data takes precedence over the base checkpoint when available.
 */
export function enrichCheckpoint(
  state: SessionState,
  base: TrajectoryCheckpointPayload,
): TrajectoryCheckpointPayload {
  return {
    ...base,
    // Use sessionlog token usage if available (more accurate than ACP stream tracking)
    ...(state.tokenUsage ? { token_usage: state.tokenUsage } : {}),
    // Merge files from sessionlog with existing
    files_touched: [
      ...new Set([
        ...base.files_touched,
        ...(state.filesTouched ?? []),
      ]),
    ],
    metadata: {
      ...base.metadata,
      turnId: state.turnId ?? base.metadata?.turnId,
      stepCount: state.stepCount ?? base.metadata?.stepCount,
      lastCheckpointID: state.lastCheckpointId ?? base.metadata?.lastCheckpointID,
      startedAt: state.startedAt ?? base.metadata?.startedAt,
    },
  };
}
