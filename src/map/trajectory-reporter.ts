/**
 * Trajectory Reporter — builds and reports trajectory checkpoints to the MAP hub.
 *
 * Sends checkpoints via the `trajectory/checkpoint` JSON-RPC extension.
 * Handles inbound `trajectory/content.request` notifications by serving
 * session transcripts via sessionlog's SessionStore and CheckpointStore.
 * Supports all agent types (Claude Code, Codex, Gemini, etc.) through
 * sessionlog's adapter system.
 *
 * @module map/trajectory-reporter
 */

import type {
  TrajectoryCheckpointPayload,
  TrajectoryCheckpointResult,
  TrajectoryContentRequest,
  TrajectoryReporter,
  MAPSidecarConfig,
} from "./types.js";

/** Minimal interface for the MAP connection methods we need */
export interface TrajectoryConnection {
  callExtension<TParams = unknown, TResult = unknown>(
    method: string,
    params?: TParams,
  ): Promise<TResult>;
  sendNotification(method: string, params: unknown): Promise<void>;
  onNotification(
    method: string,
    handler: (params: unknown) => void | Promise<void>,
  ): void;
  offNotification(
    method: string,
    handler: (params: unknown) => void | Promise<void>,
  ): void;
  get isConnected(): boolean;
}

/**
 * Resolve transcript content for a checkpoint ID using sessionlog.
 *
 * Two-source strategy (matching cc-swarm):
 * 1. Live session — use sessionlog's SessionStore to find a session
 *    matching the checkpoint ID, then read its transcript from disk.
 * 2. Committed checkpoint — use sessionlog's CheckpointStore to read
 *    content from the git history.
 *
 * Returns null if no content is found or sessionlog is unavailable.
 */
async function resolveContent(
  checkpointId: string,
  sessionDirs: string[],
): Promise<{
  transcript: string;
  metadata: Record<string, unknown>;
  prompts: string;
  context: string;
} | null> {
  let sessionlog: typeof import("sessionlog") | null = null;
  try {
    sessionlog = await import("sessionlog");
  } catch {
    return null; // sessionlog not available
  }

  const { readFileSync, existsSync } = await import("node:fs");

  // Derive the session ID from checkpoint ID (e.g., "sess-abc-step3" → "sess-abc")
  const sessionId = checkpointId.replace(/-step\d+$/, "");

  // ── 1. Live session lookup via SessionStore ────────────────────────────
  for (const sessionsDir of sessionDirs) {
    if (!existsSync(sessionsDir)) continue;

    try {
      const store = sessionlog.createSessionStore(undefined, sessionsDir);
      // Try loading by derived session ID first, then by raw checkpoint ID
      let state = await store.load(sessionId);
      if (!state) state = await store.load(checkpointId);

      // If not found by ID, scan all sessions for checkpoint match
      if (!state) {
        const allSessions = await store.list();
        state = allSessions.find((s) =>
          s.lastCheckpointID === checkpointId ||
          (s.turnCheckpointIDs || []).includes(checkpointId),
        ) ?? null;
      }

      if (!state?.transcriptPath || !existsSync(state.transcriptPath)) continue;

      const transcript = readFileSync(state.transcriptPath, "utf-8");

      // Use sessionlog's prompt extraction if the agent has a TranscriptAnalyzer,
      // otherwise fall back to the prompts stored in state
      let prompts = "";
      if (state.firstPrompt) {
        // Collect from promptAttributions if available, otherwise use firstPrompt
        const attrs = state.promptAttributions;
        if (attrs && attrs.length > 0) {
          prompts = attrs.map((a) => a.prompt).join("\n---\n");
        } else {
          prompts = state.firstPrompt;
        }
      }

      return {
        transcript,
        prompts,
        metadata: {
          sessionID: state.sessionID,
          phase: state.phase,
          agentType: state.agentType,
          stepCount: state.stepCount || 0,
          filesTouched: state.filesTouched || [],
          tokenUsage: state.tokenUsage || {},
          startedAt: state.startedAt,
          endedAt: state.endedAt,
          source: "live",
        },
        context: `Session ${state.sessionID} (${state.phase})`,
      };
    } catch {
      continue;
    }
  }

  // ── 2. Committed checkpoint via CheckpointStore ────────────────────────
  try {
    if (sessionlog.createCheckpointStore) {
      const store = sessionlog.createCheckpointStore();
      const content = await store.readSessionContent(checkpointId, 0);
      if (content) {
        return {
          transcript: content.transcript,
          prompts: content.prompts,
          metadata: { ...content.metadata, source: "committed" },
          context: content.context,
        };
      }
    }
  } catch {
    // Checkpoint not found or store unavailable
  }

  return null;
}

/**
 * Create a trajectory reporter that sends checkpoints to the MAP hub
 * and serves session transcript content on demand via sessionlog.
 */
export function createTrajectoryReporter(
  connection: TrajectoryConnection,
  config: Pick<MAPSidecarConfig, "trajectorySyncLevel"> & {
    /** Additional session directories to search for transcripts */
    sessionDirs?: string[];
  },
): TrajectoryReporter {
  // Cache the resource_id from the first checkpoint response
  // so subsequent calls reuse it (avoids creating duplicate session resources)
  let cachedResourceId: string | undefined;

  // Build session directory search list
  const defaultDirs: string[] = [];
  try {
    const cwd = process.cwd();
    defaultDirs.push(
      `${cwd}/.git/sessionlog-sessions`,
      `${cwd}/.swarm/sessionlog/sessions`,
    );
  } catch {
    // Can't resolve paths — will use config dirs only
  }
  const sessionDirs = [...(config.sessionDirs ?? []), ...defaultDirs];

  // Handler for inbound content requests
  const contentHandler = async (params: unknown): Promise<void> => {
    const req = params as TrajectoryContentRequest;
    if (!req?.request_id) return;

    try {
      const content = await resolveContent(
        req.checkpoint_id,
        sessionDirs,
      );

      if (content) {
        await connection.sendNotification("trajectory/content.response", {
          request_id: req.request_id,
          transcript: content.transcript,
          metadata: content.metadata,
          prompts: content.prompts,
          context: content.context,
        });
      } else {
        await connection.sendNotification("trajectory/content.response", {
          request_id: req.request_id,
          transcript: "",
          metadata: { source: "macro-agent" },
          prompts: "",
          context: "",
        });
      }
    } catch {
      try {
        await connection.sendNotification("trajectory/content.response", {
          request_id: req.request_id,
          error: "Content serving failed",
        });
      } catch {
        // Double failure — give up silently
      }
    }
  };

  // Register content request handler
  connection.onNotification("trajectory/content.request", contentHandler);

  return {
    async reportCheckpoint(
      checkpoint: TrajectoryCheckpointPayload,
    ): Promise<TrajectoryCheckpointResult | null> {
      if (!connection.isConnected) return null;
      if (config.trajectorySyncLevel === "off") return null;

      try {
        const result = await connection.callExtension<
          { checkpoint: TrajectoryCheckpointPayload; resource_id?: string },
          TrajectoryCheckpointResult
        >("trajectory/checkpoint", {
          checkpoint,
          resource_id: cachedResourceId,
        });

        // Cache the resource_id for subsequent calls
        if (result?.resource_id) {
          cachedResourceId = result.resource_id;
        }

        return result;
      } catch (err) {
        // Fallback: try broadcasting as a message instead
        try {
          await connection.sendNotification("trajectory.checkpoint", {
            checkpoint,
          });
        } catch {
          // Silent — hub may not support either method
        }
        return null;
      }
    },

    stop(): void {
      connection.offNotification(
        "trajectory/content.request",
        contentHandler,
      );
    },
  };
}
