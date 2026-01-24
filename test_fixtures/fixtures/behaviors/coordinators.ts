/**
 * Coordinator Behavior Fixtures
 *
 * Predefined behaviors for coordinator agents.
 *
 * @see s-1zcx Multi-Agent Orchestration Testing Strategy
 * @see i-7f2l Phase 4: Fixtures Library
 */

import type { SimulatedBehavior, BehaviorStep } from "../../harness/simulator/types.js";
import { SUCCESSFUL_WORKER } from "./workers.js";

/**
 * Basic planning coordinator - spawns workers and waits
 */
export const PLANNING_COORDINATOR: SimulatedBehavior = {
  onStart: [
    { type: "log", message: "Planning work distribution" },
    {
      type: "call_tool",
      tool: "create_task",
      params: { description: "Task 1: Implement feature A" },
      storeResult: "task1",
    },
    {
      type: "call_tool",
      tool: "create_task",
      params: { description: "Task 2: Implement feature B" },
      storeResult: "task2",
    },
    { type: "log", message: "Spawning workers" },
    {
      type: "spawn_child",
      role: "worker",
      behavior: SUCCESSFUL_WORKER,
    },
    { type: "log", message: "Waiting for workers" },
    { type: "wait_for_event", event: "WORKERS_COMPLETE" },
    { type: "done", status: "completed", summary: "Coordination complete" },
  ],
};

/**
 * Coordinator that spawns multiple workers
 */
export function createMultiWorkerCoordinator(
  workerCount: number,
  workerBehavior: SimulatedBehavior = SUCCESSFUL_WORKER
): SimulatedBehavior {
  const steps: BehaviorStep[] = [
    { type: "log", message: `Spawning ${workerCount} workers` },
  ];

  for (let i = 0; i < workerCount; i++) {
    steps.push({
      type: "spawn_child",
      role: "worker",
      behavior: workerBehavior,
    });
  }

  steps.push(
    { type: "log", message: "All workers spawned" },
    { type: "done", status: "completed", summary: `Spawned ${workerCount} workers` }
  );

  return { onStart: steps };
}

/**
 * Coordinator that waits for all children to complete
 */
export const WAITING_COORDINATOR: SimulatedBehavior = {
  onStart: [
    { type: "log", message: "Starting coordination" },
    {
      type: "spawn_child",
      role: "worker",
      behavior: {
        onStart: [
          { type: "log", message: "Worker 1 working" },
          { type: "emit_signal", signal: "worker_done", payload: { id: 1 } },
          { type: "done", status: "completed" },
        ],
      },
    },
    {
      type: "spawn_child",
      role: "worker",
      behavior: {
        onStart: [
          { type: "log", message: "Worker 2 working" },
          { type: "emit_signal", signal: "worker_done", payload: { id: 2 } },
          { type: "done", status: "completed" },
        ],
      },
    },
    { type: "wait_for_event", event: "ALL_WORKERS_DONE" },
    { type: "done", status: "completed" },
  ],
};

/**
 * Coordinator with conditional spawning
 */
export const CONDITIONAL_COORDINATOR: SimulatedBehavior = {
  onStart: [
    { type: "log", message: "Checking conditions" },
    {
      type: "conditional",
      if: (ctx) => ctx.variables.get("needsWorker") === true,
      then: [
        { type: "log", message: "Spawning worker" },
        { type: "spawn_child", role: "worker", behavior: SUCCESSFUL_WORKER },
      ],
      else: [
        { type: "log", message: "No worker needed" },
      ],
    },
    { type: "done", status: "completed" },
  ],
};

/**
 * Coordinator that handles worker events
 */
export const EVENT_HANDLING_COORDINATOR: SimulatedBehavior = {
  onStart: [
    { type: "log", message: "Starting event-driven coordination" },
    {
      type: "spawn_child",
      role: "worker",
      behavior: {
        onStart: [
          { type: "log", message: "Worker starting" },
          { type: "emit_signal", signal: "status", payload: { status: "started" } },
          { type: "write_file", path: "output.txt", content: "done" },
          { type: "emit_signal", signal: "status", payload: { status: "completed" } },
          { type: "done", status: "completed" },
        ],
      },
    },
  ],
  onEvent: {
    worker_status: [
      { type: "log", message: "Received worker status update" },
    ],
    worker_error: [
      { type: "log", message: "Worker reported error - handling" },
    ],
  },
};

/**
 * Coordinator that creates tasks and assigns workers
 */
export const TASK_CREATING_COORDINATOR: SimulatedBehavior = {
  onStart: [
    { type: "log", message: "Creating tasks" },
    {
      type: "call_tool",
      tool: "create_task",
      params: { description: "Implement authentication" },
      storeResult: "authTask",
    },
    {
      type: "call_tool",
      tool: "create_task",
      params: { description: "Implement database layer" },
      storeResult: "dbTask",
    },
    {
      type: "call_tool",
      tool: "create_task",
      params: { description: "Implement API endpoints" },
      storeResult: "apiTask",
    },
    { type: "log", message: "Tasks created, spawning workers" },
    {
      type: "spawn_child",
      role: "worker",
      behavior: SUCCESSFUL_WORKER,
    },
    { type: "done", status: "completed", summary: "Tasks created and distributed" },
  ],
};

/**
 * Simple coordinator that just completes
 */
export const SIMPLE_COORDINATOR: SimulatedBehavior = {
  onStart: [
    { type: "log", message: "Simple coordinator running" },
    { type: "done", status: "completed" },
  ],
};
