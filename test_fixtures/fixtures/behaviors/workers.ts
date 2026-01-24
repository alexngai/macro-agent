/**
 * Worker Behavior Fixtures
 *
 * Predefined behaviors for worker agents.
 *
 * @see s-1zcx Multi-Agent Orchestration Testing Strategy
 * @see i-7f2l Phase 4: Fixtures Library
 */

import type { SimulatedBehavior, BehaviorStep } from "../../harness/simulator/types.js";

/**
 * Successful worker - completes work and terminates
 */
export const SUCCESSFUL_WORKER: SimulatedBehavior = {
  onStart: [
    { type: "log", message: "Starting work" },
    { type: "write_file", path: "output.txt", content: "Work completed successfully" },
    { type: "commit", message: "Complete work" },
    { type: "done", status: "completed", summary: "Work finished successfully" },
  ],
};

/**
 * Failing worker - starts work but fails before completion
 */
export const FAILING_WORKER: SimulatedBehavior = {
  onStart: [
    { type: "log", message: "Starting work" },
    { type: "write_file", path: "partial.txt", content: "Partial work" },
  ],
  failAfter: 2,
  failWith: "Simulated worker failure",
};

/**
 * Stuck worker - starts but never completes (for timeout testing)
 */
export const STUCK_WORKER: SimulatedBehavior = {
  onStart: [
    { type: "log", message: "Starting work" },
    { type: "wait_for_event", event: "NEVER_COMING_EVENT" },
    { type: "log", message: "This will never execute" },
    { type: "done", status: "completed" },
  ],
};

/**
 * Worker that implements a function
 */
export const IMPLEMENT_FUNCTION_WORKER: SimulatedBehavior = {
  onStart: [
    { type: "log", message: "Reading existing code" },
    { type: "read_file", path: "src/index.ts", into: "existingCode" },
    { type: "log", message: "Writing new function" },
    {
      type: "write_file",
      path: "src/feature.ts",
      content: `/**
 * New feature implementation
 */
export function newFeature(input: string): string {
  return input.toUpperCase();
}
`,
    },
    { type: "log", message: "Committing changes" },
    { type: "commit", message: "Implement new feature function" },
    { type: "done", status: "completed", summary: "Feature implemented" },
  ],
};

/**
 * Worker that waits for assignment before working
 */
export const WAITING_WORKER: SimulatedBehavior = {
  onStart: [
    { type: "log", message: "Waiting for work assignment" },
    { type: "wait_for_event", event: "WORK_ASSIGNED" },
    { type: "log", message: "Work assigned, starting" },
    { type: "write_file", path: "result.txt", content: "Work done" },
    { type: "commit", message: "Complete assigned work" },
    { type: "done", status: "completed" },
  ],
};

/**
 * Worker that emits progress signals
 */
export const SIGNALING_WORKER: SimulatedBehavior = {
  onStart: [
    { type: "log", message: "Starting work" },
    { type: "emit_signal", signal: "progress", payload: { percent: 0 } },
    { type: "write_file", path: "step1.txt", content: "Step 1" },
    { type: "emit_signal", signal: "progress", payload: { percent: 33 } },
    { type: "write_file", path: "step2.txt", content: "Step 2" },
    { type: "emit_signal", signal: "progress", payload: { percent: 66 } },
    { type: "write_file", path: "step3.txt", content: "Step 3" },
    { type: "emit_signal", signal: "progress", payload: { percent: 100 } },
    { type: "commit", message: "Complete all steps" },
    { type: "done", status: "completed" },
  ],
};

/**
 * Create a worker that writes specific content to a file (for conflict testing)
 */
export function createConflictingWorker(
  filePath: string,
  content: string,
  commitMessage: string = "Update file"
): SimulatedBehavior {
  return {
    onStart: [
      { type: "log", message: `Writing to ${filePath}` },
      { type: "write_file", path: filePath, content },
      { type: "commit", message: commitMessage },
      { type: "done", status: "completed" },
    ],
  };
}

/**
 * Create a worker with custom steps
 */
export function createWorker(
  steps: BehaviorStep[],
  options: Partial<SimulatedBehavior> = {}
): SimulatedBehavior {
  return {
    onStart: steps,
    ...options,
  };
}

/**
 * Worker that performs multiple commits
 */
export const MULTI_COMMIT_WORKER: SimulatedBehavior = {
  onStart: [
    { type: "log", message: "Starting multi-commit work" },
    { type: "write_file", path: "file1.txt", content: "First file" },
    { type: "commit", message: "Add first file" },
    { type: "write_file", path: "file2.txt", content: "Second file" },
    { type: "commit", message: "Add second file" },
    { type: "write_file", path: "file3.txt", content: "Third file" },
    { type: "commit", message: "Add third file" },
    { type: "done", status: "completed", summary: "3 commits created" },
  ],
};

/**
 * Worker that completes work but reports as blocked
 */
export const BLOCKED_WORKER: SimulatedBehavior = {
  onStart: [
    { type: "log", message: "Starting work" },
    { type: "write_file", path: "partial.txt", content: "Partial progress" },
    { type: "commit", message: "Partial work" },
    {
      type: "done",
      status: "blocked",
      summary: "Blocked on external dependency",
      details: { reason: "Waiting for API access" },
    },
  ],
};

/**
 * Worker that defers its work
 */
export const DEFERRED_WORKER: SimulatedBehavior = {
  onStart: [
    { type: "log", message: "Analyzing work" },
    {
      type: "done",
      status: "deferred",
      summary: "Work deferred for later",
      details: { reason: "Insufficient context" },
    },
  ],
};
