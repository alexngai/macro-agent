/**
 * MAP Sidecar — connects macro-agent to an OpenHive MAP hub.
 *
 * @module map
 */

export { createMAPSidecar } from "./sidecar.js";

export type {
  MAPSidecar,
  MAPSidecarConfig,
  MAPSidecarDeps,
  TrajectoryCheckpointPayload,
  TrajectoryCheckpointResult,
} from "./types.js";
