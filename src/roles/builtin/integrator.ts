/**
 * Integrator Role Definition
 *
 * Handles merging worker branches into integration branch.
 * Persistent, spawns resolver workers on conflict.
 */

import type { RoleDefinition } from "../types.js";
import {
  FILE_CAPABILITIES,
  GIT_CAPABILITIES,
  AGENT_CAPABILITIES,
  LIFECYCLE_CAPABILITIES,
  MSG_CAPABILITIES,
} from "../capabilities.js";

/**
 * Integrator Role
 *
 * Merge manager agent that:
 * - Processes merge queue from workers
 * - Merges worker branches into integration branch
 * - Spawns resolver workers on conflicts
 * - Notifies coordinator of merge results
 */
export const IntegratorRole: RoleDefinition = {
  name: "integrator",
  displayName: "Integrator",
  description:
    "Handles merging worker branches into integration branch, conflict resolution",

  capabilities: [
    FILE_CAPABILITIES.READ,
    FILE_CAPABILITIES.WRITE,
    GIT_CAPABILITIES.COMMIT,
    GIT_CAPABILITIES.MERGE,
    GIT_CAPABILITIES.PUSH,
    AGENT_CAPABILITIES.SPAWN_WORKER, // Spawn resolver workers on conflict
    LIFECYCLE_CAPABILITIES.DONE,
    MSG_CAPABILITIES.SEND,
    MSG_CAPABILITIES.SUBSCRIBE,
  ],

  workspace: {
    type: "own",
    // Integrator's worktree is on a merge branch, merges INTO integration branch
    branchPattern: "integrator/{coordinator-id}@{timestamp}",
    cleanupOnTerminate: true,
  },

  lifecycle: {
    type: "persistent",
    cascadeTerminate: true,
  },

  protocol: {
    subscriptions: ["MERGE_REQUEST", "WORKER_DONE"],
    canEmit: ["MERGE_COMPLETE", "LAND_COMPLETE", "CONFLICT_DETECTED"],
  },
};
