/**
 * Worker Role Definition
 *
 * Executes discrete tasks, writes code, runs tests.
 * Ephemeral, task-bound with 30-minute stale timeout.
 */

import type { RoleDefinition } from "../types.js";
import {
  FILE_CAPABILITIES,
  GIT_CAPABILITIES,
  EXEC_CAPABILITIES,
  LIFECYCLE_CAPABILITIES,
  AGENT_CAPABILITIES,
  MSG_CAPABILITIES,
  WORKSPACE_CAPABILITIES,
} from "../capabilities.js";

/** 30 minutes in milliseconds (stale timeout) */
const STALE_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Worker Role
 *
 * Core execution agent that:
 * - Executes discrete tasks
 * - Writes code and makes file changes
 * - Runs tests, builds, and lints
 * - Can spawn child workers
 * - Self-terminates on task completion
 */
export const WorkerRole: RoleDefinition = {
  name: "worker",
  displayName: "Worker",
  description: "Executes discrete tasks, writes code, runs tests",

  capabilities: [
    FILE_CAPABILITIES.READ,
    FILE_CAPABILITIES.WRITE,
    FILE_CAPABILITIES.DELETE,
    GIT_CAPABILITIES.COMMIT,
    EXEC_CAPABILITIES.COMMAND,
    EXEC_CAPABILITIES.BUILD,
    EXEC_CAPABILITIES.TEST,
    EXEC_CAPABILITIES.LINT,
    LIFECYCLE_CAPABILITIES.DONE,
    AGENT_CAPABILITIES.SPAWN_WORKER,
    MSG_CAPABILITIES.SEND,
    WORKSPACE_CAPABILITIES.WORKTREE,
  ],

  workspace: {
    type: "own",
    branchPattern: "worker/{prefix?}/{agent-id}/{task-id}@{timestamp}",
    cleanupOnTerminate: true,
  },

  lifecycle: {
    type: "ephemeral",
    taskBound: true,
    maxDurationMs: STALE_TIMEOUT_MS,
    cascadeTerminate: true,
    selfCleanup: true,
  },

  protocol: {
    subscriptions: ["WORK_ASSIGNED", "HEALTH_CHECK"],
    canEmit: ["WORKER_DONE", "MERGE_REQUEST"],
  },

  systemPrompt: `You are a worker agent. After completing your assigned task:
1. Verify all requirements are met
2. Commit any changes (if working with files)
3. Call done() with status "completed" and a summary of what you did

IMPORTANT: You MUST call done() when finished. Example:
done({ status: "completed", summary: "Created src/greeting.ts with hello function and committed changes" })`,
};

/**
 * Resolver Worker Role
 *
 * Specialized worker spawned by Integrator to resolve merge conflicts.
 * Inherits from Worker with conflict resolution guidance.
 */
export const ResolverWorkerRole: RoleDefinition = {
  name: "worker.resolver",
  displayName: "Resolver Worker",
  description: "Resolves merge conflicts with fresh baseline",
  extends: "worker",

  // Inherits capabilities from worker
  capabilities: [
    FILE_CAPABILITIES.READ,
    FILE_CAPABILITIES.WRITE,
    FILE_CAPABILITIES.DELETE,
    GIT_CAPABILITIES.COMMIT,
    EXEC_CAPABILITIES.COMMAND,
    EXEC_CAPABILITIES.BUILD,
    EXEC_CAPABILITIES.TEST,
    EXEC_CAPABILITIES.LINT,
    LIFECYCLE_CAPABILITIES.DONE,
    AGENT_CAPABILITIES.SPAWN_WORKER,
    MSG_CAPABILITIES.SEND,
    WORKSPACE_CAPABILITIES.WORKTREE,
  ],

  // Inherits workspace from worker
  workspace: {
    type: "own",
    branchPattern: "worker/resolver/{agent-id}/{task-id}@{timestamp}",
    cleanupOnTerminate: true,
  },

  // Inherits lifecycle from worker
  lifecycle: {
    type: "ephemeral",
    taskBound: true,
    maxDurationMs: STALE_TIMEOUT_MS,
    cascadeTerminate: true,
    selfCleanup: true,
  },

  protocol: {
    subscriptions: ["WORK_ASSIGNED", "HEALTH_CHECK"],
    canEmit: ["WORKER_DONE", "RESOLVER_DONE"],
  },

  systemPrompt: `You are a resolver worker. Your job is to:
1. Apply the changes from the original work to the updated baseline
2. Resolve any conflicts that arise
3. Ensure tests pass after resolution
4. Call done() when complete`,
};
