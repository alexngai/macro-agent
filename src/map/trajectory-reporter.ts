/**
 * Trajectory Reporter — builds and reports trajectory checkpoints to the MAP hub.
 *
 * Sends checkpoints via the `trajectory/checkpoint` JSON-RPC extension.
 * Also handles inbound `trajectory/content.request` notifications by serving
 * session transcript data.
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
 * Create a trajectory reporter that sends checkpoints to the MAP hub
 * and serves content on demand.
 */
export function createTrajectoryReporter(
  connection: TrajectoryConnection,
  config: Pick<MAPSidecarConfig, "trajectorySyncLevel">,
): TrajectoryReporter {
  // Cache the resource_id from the first checkpoint response
  // so subsequent calls reuse it (avoids creating duplicate session resources)
  let cachedResourceId: string | undefined;

  // Handler for inbound content requests
  const contentHandler = async (params: unknown): Promise<void> => {
    const req = params as TrajectoryContentRequest;
    if (!req?.request_id) return;

    try {
      // Respond with what we have — macro-agent doesn't store full transcripts
      // like sessionlog does, so we send a minimal response.
      // Future: integrate with ACP session history for richer content.
      await connection.sendNotification("trajectory/content.response", {
        request_id: req.request_id,
        transcript: null,
        metadata: {
          source: "macro-agent",
          note: "Full transcript serving not yet implemented",
        },
      });
    } catch {
      // Best effort
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
