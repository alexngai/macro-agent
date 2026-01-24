/**
 * Monitor Behavior Fixtures
 *
 * Predefined behaviors for monitor agents.
 *
 * @see s-1zcx Multi-Agent Orchestration Testing Strategy
 * @see i-7f2l Phase 4: Fixtures Library
 */

import type { SimulatedBehavior } from "../../harness/simulator/types.js";

/**
 * Health check monitor - periodic checks for stuck agents
 */
export const HEALTH_CHECK_MONITOR: SimulatedBehavior = {
  onStart: [
    { type: "log", message: "Starting health check monitor" },
    { type: "emit_signal", signal: "monitor_started", payload: { type: "health" } },
  ],
  onEvent: {
    CHECK_HEALTH: [
      { type: "log", message: "Running health check" },
      {
        type: "conditional",
        if: (ctx) => ctx.stuckAgents.length > 0,
        then: [
          { type: "log", message: "Stuck agents detected" },
          {
            type: "emit_signal",
            signal: "stuck_agents_detected",
            payload: {},
          },
        ],
        else: [
          { type: "log", message: "All agents healthy" },
        ],
      },
    ],
  },
  conditions: [
    {
      condition: (ctx) => ctx.variables.get("shutdown") === true,
      behavior: [
        { type: "log", message: "Health monitor shutting down" },
        { type: "done", status: "completed" },
      ],
      once: true,
    },
  ],
};

/**
 * GUPP violation monitor
 */
export const GUPP_MONITOR: SimulatedBehavior = {
  onStart: [
    { type: "log", message: "Starting GUPP monitor" },
    { type: "emit_signal", signal: "monitor_started", payload: { type: "gupp" } },
  ],
  onEvent: {
    COMMIT_DETECTED: [
      { type: "log", message: "Checking commit for GUPP violations" },
      {
        type: "conditional",
        if: (ctx) => {
          const commit = ctx.variables.get("lastCommit") as { files?: string[] } | undefined;
          // Simple GUPP check - multiple files in one commit
          return (commit?.files?.length ?? 0) > 5;
        },
        then: [
          { type: "log", message: "GUPP violation: too many files in commit" },
          { type: "emit_signal", signal: "gupp_violation", payload: { type: "commit_size" } },
        ],
        else: [
          { type: "log", message: "Commit passes GUPP check" },
        ],
      },
    ],
    BRANCH_CREATED: [
      { type: "log", message: "Checking branch naming" },
    ],
  },
  conditions: [
    {
      condition: (ctx) => ctx.variables.get("shutdown") === true,
      behavior: [
        { type: "log", message: "GUPP monitor shutting down" },
        { type: "done", status: "completed" },
      ],
      once: true,
    },
  ],
};

/**
 * Progress monitor - tracks task completion
 */
export const PROGRESS_MONITOR: SimulatedBehavior = {
  onStart: [
    { type: "log", message: "Starting progress monitor" },
    { type: "emit_signal", signal: "monitor_started", payload: { type: "progress" } },
  ],
  onEvent: {
    TASK_COMPLETED: [
      { type: "log", message: "Task completed, updating progress" },
      { type: "emit_signal", signal: "progress_updated", payload: {} },
    ],
    TASK_FAILED: [
      { type: "log", message: "Task failed, reporting" },
      { type: "emit_signal", signal: "failure_reported", payload: {} },
    ],
  },
  conditions: [
    {
      condition: (ctx) => ctx.variables.get("allTasksComplete") === true,
      behavior: [
        { type: "log", message: "All tasks complete" },
        { type: "emit_signal", signal: "all_complete", payload: {} },
        { type: "done", status: "completed" },
      ],
      once: true,
    },
  ],
};

/**
 * Timeout monitor - watches for stuck operations
 */
export const TIMEOUT_MONITOR: SimulatedBehavior = {
  onStart: [
    { type: "log", message: "Starting timeout monitor" },
  ],
  onEvent: {
    OPERATION_STARTED: [
      { type: "log", message: "Recording operation start time" },
    ],
    CHECK_TIMEOUTS: [
      { type: "log", message: "Checking for timeouts" },
      {
        type: "conditional",
        if: (ctx) => {
          const startTime = ctx.variables.get("operationStartTime") as number | undefined;
          if (!startTime) return false;
          return Date.now() - startTime > 60000; // 60 second timeout
        },
        then: [
          { type: "log", message: "Operation timeout detected" },
          { type: "emit_signal", signal: "timeout_detected", payload: {} },
        ],
      },
    ],
  },
};

/**
 * Resource monitor - watches resource usage
 */
export const RESOURCE_MONITOR: SimulatedBehavior = {
  onStart: [
    { type: "log", message: "Starting resource monitor" },
  ],
  onEvent: {
    CHECK_RESOURCES: [
      { type: "log", message: "Checking resource usage" },
      { type: "emit_signal", signal: "resource_report", payload: { cpu: "ok", memory: "ok" } },
    ],
  },
  conditions: [
    {
      condition: (ctx) => ctx.variables.get("shutdown") === true,
      behavior: [
        { type: "done", status: "completed" },
      ],
      once: true,
    },
  ],
};

/**
 * Simple monitor that completes immediately
 */
export const SIMPLE_MONITOR: SimulatedBehavior = {
  onStart: [
    { type: "log", message: "Simple monitor check" },
    { type: "done", status: "completed" },
  ],
};

/**
 * Monitor that waits for shutdown signal
 */
export const PERSISTENT_MONITOR: SimulatedBehavior = {
  onStart: [
    { type: "log", message: "Persistent monitor started" },
    { type: "wait_for_event", event: "SHUTDOWN" },
    { type: "log", message: "Shutdown received" },
    { type: "done", status: "completed" },
  ],
};
