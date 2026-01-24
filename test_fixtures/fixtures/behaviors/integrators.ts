/**
 * Integrator Behavior Fixtures
 *
 * Predefined behaviors for integrator agents.
 *
 * @see s-1zcx Multi-Agent Orchestration Testing Strategy
 * @see i-7f2l Phase 4: Fixtures Library
 */

import type { SimulatedBehavior } from "../../harness/simulator/types.js";

/**
 * Basic integrator - processes queue and merges
 */
export const BASIC_INTEGRATOR: SimulatedBehavior = {
  onStart: [
    { type: "log", message: "Starting integration process" },
    { type: "log", message: "Checking merge queue" },
    { type: "wait_for_event", event: "MERGE_REQUEST_READY" },
    { type: "log", message: "Processing merge request" },
    { type: "emit_signal", signal: "merge_started", payload: {} },
    { type: "log", message: "Merge completed" },
    { type: "emit_signal", signal: "merge_completed", payload: { success: true } },
    { type: "done", status: "completed", summary: "Integration complete" },
  ],
};

/**
 * Integrator that handles conflicts
 */
export const CONFLICT_RESOLVER: SimulatedBehavior = {
  onStart: [
    { type: "log", message: "Starting conflict resolution" },
    { type: "wait_for_event", event: "CONFLICT_DETECTED" },
    { type: "log", message: "Conflict detected, analyzing" },
    { type: "log", message: "Attempting automatic resolution" },
    {
      type: "conditional",
      if: (ctx) => ctx.variables.get("canAutoResolve") === true,
      then: [
        { type: "log", message: "Auto-resolving conflict" },
        { type: "emit_signal", signal: "conflict_resolved", payload: { auto: true } },
      ],
      else: [
        { type: "log", message: "Manual resolution required" },
        { type: "emit_signal", signal: "manual_resolution_needed", payload: {} },
      ],
    },
    { type: "done", status: "completed" },
  ],
};

/**
 * Integrator that waits for all merge requests
 */
export const BATCH_INTEGRATOR: SimulatedBehavior = {
  onStart: [
    { type: "log", message: "Starting batch integration" },
    { type: "emit_signal", signal: "collecting_requests", payload: {} },
    { type: "wait_for_event", event: "BATCH_READY" },
    { type: "log", message: "Processing batch" },
    { type: "log", message: "Merging request 1" },
    { type: "log", message: "Merging request 2" },
    { type: "log", message: "Merging request 3" },
    { type: "emit_signal", signal: "batch_merged", payload: { count: 3 } },
    { type: "done", status: "completed", summary: "Batch of 3 merged" },
  ],
};

/**
 * Integrator that validates before merging
 */
export const VALIDATING_INTEGRATOR: SimulatedBehavior = {
  onStart: [
    { type: "log", message: "Starting validated integration" },
    { type: "wait_for_event", event: "MERGE_REQUEST" },
    { type: "log", message: "Running validation checks" },
    { type: "emit_signal", signal: "running_tests", payload: {} },
    {
      type: "conditional",
      if: (ctx) => ctx.variables.get("testsPass") !== false,
      then: [
        { type: "log", message: "Tests passed, proceeding with merge" },
        { type: "emit_signal", signal: "merge_approved", payload: {} },
      ],
      else: [
        { type: "log", message: "Tests failed, rejecting merge" },
        { type: "emit_signal", signal: "merge_rejected", payload: { reason: "tests_failed" } },
      ],
    },
    { type: "done", status: "completed" },
  ],
};

/**
 * Integrator that processes queue continuously
 */
export const CONTINUOUS_INTEGRATOR: SimulatedBehavior = {
  onStart: [
    { type: "log", message: "Starting continuous integration" },
    { type: "emit_signal", signal: "integrator_ready", payload: {} },
  ],
  onEvent: {
    NEW_MERGE_REQUEST: [
      { type: "log", message: "New merge request received" },
      { type: "emit_signal", signal: "processing", payload: {} },
      { type: "emit_signal", signal: "merged", payload: {} },
    ],
  },
  conditions: [
    {
      condition: (ctx) => ctx.variables.get("shutdown") === true,
      behavior: [
        { type: "log", message: "Shutdown requested" },
        { type: "done", status: "completed", summary: "Shutdown complete" },
      ],
      once: true,
    },
  ],
};

/**
 * Simple integrator that just completes
 */
export const SIMPLE_INTEGRATOR: SimulatedBehavior = {
  onStart: [
    { type: "log", message: "Simple integrator running" },
    { type: "done", status: "completed" },
  ],
};

/**
 * Integrator that fails on conflict
 */
export const FAILING_INTEGRATOR: SimulatedBehavior = {
  onStart: [
    { type: "log", message: "Starting integration" },
    { type: "wait_for_event", event: "MERGE_REQUEST" },
    { type: "log", message: "Attempting merge" },
  ],
  failAfter: 3,
  failWith: "Merge conflict could not be resolved",
};
