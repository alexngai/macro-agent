/**
 * MAP Sidecar — connects macro-agent to an OpenHive MAP hub.
 *
 * @module map
 */

export { createMAPSidecar } from "./sidecar.js";
export { createMAPServerInstance } from "./server.js";

export type {
  MAPSidecar,
  MAPSidecarConfig,
  MAPSidecarDeps,
  MAPServerInstance,
  MapServerConfig,
  TrajectoryCheckpointPayload,
  TrajectoryCheckpointResult,
} from "./types.js";
