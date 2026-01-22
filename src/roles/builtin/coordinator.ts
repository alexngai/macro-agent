/**
 * Coordinator Role Definition
 *
 * Plans work, assigns tasks, tracks progress.
 * IS the batch - orchestrates workers and integrator.
 */

import type { RoleDefinition } from "../types.js";
import {
  FILE_CAPABILITIES,
  TASK_CAPABILITIES,
  AGENT_CAPABILITIES,
  MSG_CAPABILITIES,
} from "../capabilities.js";

/**
 * Coordinator Role
 *
 * Orchestration agent that:
 * - Plans and breaks down work
 * - Creates and assigns tasks to workers
 * - Spawns workers, integrator, and monitor
 * - Tracks progress and handles escalations
 * - Has its own workspace on the integration branch
 */
export const CoordinatorRole: RoleDefinition = {
  name: "coordinator",
  displayName: "Coordinator",
  description: "Plans work, assigns tasks, tracks progress. IS the batch.",

  capabilities: [
    FILE_CAPABILITIES.READ,
    FILE_CAPABILITIES.WRITE, // Read/write on integration branch
    TASK_CAPABILITIES.CREATE,
    TASK_CAPABILITIES.ASSIGN,
    TASK_CAPABILITIES.UPDATE,
    TASK_CAPABILITIES.CLOSE,
    AGENT_CAPABILITIES.SPAWN_WORKER,
    AGENT_CAPABILITIES.SPAWN_INTEGRATOR,
    AGENT_CAPABILITIES.SPAWN_MONITOR,
    AGENT_CAPABILITIES.TERMINATE,
    MSG_CAPABILITIES.SEND,
    MSG_CAPABILITIES.BROADCAST,
    MSG_CAPABILITIES.SUBSCRIBE,
    // Note: lifecycle.done is optional, configured per-coordinator
  ],

  workspace: {
    type: "own",
    // Coordinator's worktree is on the integration branch
    branchPattern: "feature/{name}-{coordinator-id}",
    cleanupOnTerminate: true,
    // Can view child workspaces via filesystem paths
    canViewChildWorkspaces: true,
  },

  lifecycle: {
    type: "persistent",
    cascadeTerminate: true,
  },

  protocol: {
    subscriptions: [
      "WORKER_DONE",
      "MERGE_COMPLETE",
      "LAND_COMPLETE",
      "CONFLICT_DETECTED",
      "STALE_AGENT",
      "INTEGRATOR_DONE",
    ],
    canEmit: ["WORK_ASSIGNED"],
  },
};
