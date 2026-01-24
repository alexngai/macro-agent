# Test Fixtures

Testing infrastructure for multi-agent orchestration scenarios.

> See spec [s-1zcx](../.sudocode/specs/s-1zcx.md) Multi-Agent Orchestration Testing Strategy

## Overview

This directory provides a complete testing framework for:
- **Simulated agents** that execute behavior scripts without real LLM calls
- **Temporary repositories** for isolated git operations
- **Event-driven stepping** for deterministic test execution
- **Built-in assertions** for common test scenarios

## Directory Structure

```
test_fixtures/
├── fixtures/           # Reusable test data and configurations
│   ├── behaviors/      # Agent behavior scripts
│   │   ├── workers.ts      # Worker behaviors (successful, failing, stuck, etc.)
│   │   ├── coordinators.ts # Coordinator behaviors
│   │   ├── integrators.ts  # Integrator behaviors
│   │   └── monitors.ts     # Monitor behaviors
│   ├── projects/       # Project templates
│   │   └── typescript-project.ts
│   ├── repos/          # Repository utilities
│   │   └── temp-repo-factory.ts
│   └── sudocode/       # Sudocode fixtures
│       ├── specs.ts
│       └── issues.ts
│
├── harness/            # Test harness implementation
│   ├── test-harness.ts # Main TestHarness class
│   ├── simulator/      # Agent simulation
│   │   ├── agent-simulator.ts   # Simulated agent
│   │   ├── behavior-executor.ts # Step execution
│   │   └── types.ts             # Type definitions
│   ├── timing/         # Execution control
│   │   └── event-stepper.ts     # Deterministic stepping
│   ├── assertions/     # Test assertions
│   │   └── harness-assertions.ts
│   └── __tests__/      # Self-tests for harness
│
└── README.md           # This file
```

## Quick Start

### Basic Test Setup

```typescript
import { describe, it, expect, afterEach } from "vitest";
import { createTestHarness, SUCCESSFUL_WORKER } from "../test_fixtures";

describe("my test", () => {
  let harness: TestHarness;

  afterEach(async () => {
    await harness?.cleanup();
  });

  it("should run a worker", async () => {
    harness = await createTestHarness();
    await harness.createTempRepo();

    const worker = await harness.spawnSimulator({
      role: "worker",
      behavior: SUCCESSFUL_WORKER,
    });

    await harness.waitForSimulator(worker.agentId);

    harness.assertSimulatorComplete(worker.agentId);
    harness.assertAgentTerminated(worker.agentId);
  });
});
```

## TestHarness

The `TestHarness` is the main orchestrator for multi-agent tests. It manages:
- Services (EventStore, MessageRouter, TaskManager)
- Repositories (temporary git repos, worktrees)
- Simulators (spawning, stepping, waiting)
- Assertions (agent state, task status, git state)

### Creating a Harness

```typescript
// Basic harness
const harness = await createTestHarness();

// With merge queue support
const harness = await createTestHarness({ withMergeQueue: true });

// With workspace/worktree support
const harness = await createTestHarness({ withWorkspaces: true });
```

### Harness Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `inMemory` | `boolean` | `true` | Use in-memory EventStore |
| `withMergeQueue` | `boolean` | `false` | Enable merge queue support |
| `withWorkspaces` | `boolean` | `false` | Enable worktree management |

## Agent Simulator

Simulates agent behavior without LLM calls. Executes a behavior script step-by-step.

### SimulatedBehavior

```typescript
interface SimulatedBehavior {
  /** Steps to execute when agent starts */
  onStart: BehaviorStep[];

  /** Event handlers (keyed by event name) */
  onEvent?: Record<string, BehaviorStep[]>;

  /** Conditional behaviors evaluated continuously */
  conditions?: ConditionalBehavior[];

  /** Fail after N steps (for testing error handling) */
  failAfter?: number;
  failWith?: Error | string;

  /** Delay between steps */
  stepDelayMs?: number;

  /** Maximum execution time */
  timeoutMs?: number;
}
```

### Behavior Steps

| Step Type | Description | Example |
|-----------|-------------|---------|
| `log` | Log a message | `{ type: "log", message: "Starting" }` |
| `write_file` | Write content to file | `{ type: "write_file", path: "foo.txt", content: "bar" }` |
| `read_file` | Read file into variable | `{ type: "read_file", path: "foo.txt", into: "content" }` |
| `commit` | Git commit | `{ type: "commit", message: "Add feature" }` |
| `done` | Complete with status | `{ type: "done", status: "completed", summary: "Done" }` |
| `emit_signal` | Emit a signal | `{ type: "emit_signal", signal: "progress", payload: { pct: 50 } }` |
| `wait_for_event` | Wait for event | `{ type: "wait_for_event", event: "ASSIGNED" }` |
| `wait_for_condition` | Wait for condition | `{ type: "wait_for_condition", condition: (ctx) => ctx.stepCount > 5 }` |
| `call_tool` | Call MCP tool | `{ type: "call_tool", tool: "done", params: { status: "completed" } }` |
| `spawn_child` | Spawn child agent | `{ type: "spawn_child", role: "worker", behavior: WORKER }` |
| `sleep` | Sleep for duration | `{ type: "sleep", ms: 100 }` |
| `conditional` | Conditional branching | `{ type: "conditional", if: fn, then: [...], else: [...] }` |
| `assert` | Runtime assertion | `{ type: "assert", condition: fn, message: "failed" }` |

### Done Status Values

| Status | Description |
|--------|-------------|
| `completed` | Work finished successfully |
| `failed` | Work failed with error |
| `blocked` | Waiting on external dependency |
| `deferred` | Work postponed for later |

## Pre-built Behaviors

### Workers

```typescript
import {
  SUCCESSFUL_WORKER,      // Writes file, commits, completes
  FAILING_WORKER,         // Starts then fails
  STUCK_WORKER,           // Waits forever (timeout testing)
  BLOCKED_WORKER,         // Completes with blocked status
  DEFERRED_WORKER,        // Defers work
  SIGNALING_WORKER,       // Emits progress signals
  MULTI_COMMIT_WORKER,    // Creates multiple commits
  HELP_EMITTING_WORKER,   // Emits HELP signal
  RESOLVER_WORKER,        // Resolves conflicts
} from "../test_fixtures";

// Factory functions
createWorker(steps, options)
createConflictingWorker(filePath, content, commitMessage)
createUniqueFileWorker(workerId, content)
createResolverWorker(filePath, resolvedContent, commitMessage)
```

### Coordinators

```typescript
import {
  PLANNING_COORDINATOR,       // Plans and spawns workers
  WAITING_COORDINATOR,        // Waits for workers
  CONDITIONAL_COORDINATOR,    // Conditional logic
  EVENT_HANDLING_COORDINATOR, // Handles events
  TASK_CREATING_COORDINATOR,  // Creates tasks
  SIMPLE_COORDINATOR,         // Minimal coordinator
} from "../test_fixtures";

createMultiWorkerCoordinator(workerCount)
```

### Integrators

```typescript
import {
  BASIC_INTEGRATOR,       // Simple merge processing
  CONFLICT_RESOLVER,      // Handles conflicts
  BATCH_INTEGRATOR,       // Batch merge processing
  VALIDATING_INTEGRATOR,  // Validates before merge
  CONTINUOUS_INTEGRATOR,  // Continuous processing
  FAILING_INTEGRATOR,     // Fails during merge
} from "../test_fixtures";
```

### Monitors

```typescript
import {
  HEALTH_CHECK_MONITOR,  // Health checking
  GUPP_MONITOR,          // Global Update Progress Protocol
  PROGRESS_MONITOR,      // Progress tracking
  TIMEOUT_MONITOR,       // Timeout detection
  RESOURCE_MONITOR,      // Resource monitoring
  PERSISTENT_MONITOR,    // Long-running monitor
} from "../test_fixtures";
```

## Execution Control

### Stepping

The harness uses deterministic stepping for reliable tests:

```typescript
// Step all simulators once
await harness.stepAll();

// Run until all simulators are idle
await harness.runUntilIdle();

// Wait for specific simulator
await harness.waitForSimulator(agentId);

// Wait for all simulators
await harness.waitForAll();

// Wait for custom condition
await harness.waitForCondition(() => harness.getSimulatorCount() >= 3);
```

### Options

```typescript
await harness.waitForSimulator(agentId, {
  timeoutMs: 5000,     // Max wait time
  maxIterations: 100,  // Max step iterations
});
```

## Assertions

### Agent Assertions

```typescript
harness.assertAgentTerminated(agentId);
harness.assertAgentState(agentId, "running" | "stopped" | "paused");
harness.assertSimulatorComplete(agentId);
harness.assertExecutedStep(agentId, "commit");
```

### Task Assertions

```typescript
harness.assertTaskStatus(taskId, "pending" | "assigned" | "in_progress" | "completed" | "failed");
```

### Message Assertions

```typescript
harness.assertMessagesReceived(agentId, minCount);
harness.assertMessageReceived(agentId, "pattern" | /regex/);
```

### Git Assertions

```typescript
harness.assertBranchExists("feature/foo");
harness.assertBranchMerged("feature/foo", "main");
harness.assertCleanWorkingTree();
harness.assertCommitCount("main", 5);
harness.assertFileExists("src/index.ts");
harness.assertFileContains("src/index.ts", "export");
```

### Merge Queue Assertions (requires `withMergeQueue: true`)

```typescript
harness.assertMergeRequestStatus(mrId, "pending" | "processing" | "merged" | "conflict");
harness.assertTaskMergeRequestStatus(taskId, status);
harness.assertMergeQueueDepth(streamId, expectedDepth);
harness.assertMergeRequestMerged(mrId);
harness.assertMergeRequestConflict(mrId, expectedFiles);
```

### Worktree Assertions (requires `withWorkspaces: true`)

```typescript
harness.assertWorktreeExists(worktreePath);
harness.assertAgentHasWorktree(agentId);
harness.assertWorktreeBranch(worktreePath, "feature/foo");
harness.assertWorktreeClean(worktreePath);
harness.assertWorktreeFileExists(worktreePath, "src/index.ts");
harness.assertWorktreeFileContains(worktreePath, "src/index.ts", "export");
```

## Repository Management

### Temporary Repositories

```typescript
const repo = await harness.createTempRepo();

// With initial files
const repo = await harness.createTempRepo({
  files: {
    "src/index.ts": "export const x = 1;",
    "package.json": '{ "name": "test" }',
  },
});

// Access repo
const repo = harness.getRepo();
repo.git("status");
repo.writeFile("foo.txt", "content");
repo.path; // Absolute path to repo
```

### Worktrees (requires `withWorkspaces: true`)

```typescript
const worktreePath = harness.createWorktreeForAgent(agentId, "feature/foo", {
  baseBranch: "main",
  streamId: "stream-1",
});

harness.getWorktreePath(agentId);
harness.removeWorktree(agentId);
```

## Merge Queue (requires `withMergeQueue: true`)

```typescript
// Submit merge request
const mrId = harness.submitMergeRequest({
  streamId: "stream-1",
  taskId: "task-1",
  agentId: "agent-1",
  branch: "feature/foo",
  targetBranch: "main",
});

// Process next request
harness.processNextMergeRequest("stream-1");

// Process with simulated conflict
harness.processNextMergeRequest("stream-1", {
  simulateConflict: true,
  conflictFiles: ["shared.ts"],
});

// Process all requests
harness.processAllMergeRequests("stream-1");

// Check queue depth
harness.getMergeQueueDepth("stream-1");
```

## Example: Multi-Worker Test

```typescript
it("should coordinate multiple workers", async () => {
  harness = await createTestHarness({ withMergeQueue: true });
  await harness.createTempRepo();

  // Spawn coordinator
  const coordinator = await harness.spawnSimulator({
    role: "coordinator",
    behavior: createMultiWorkerCoordinator(3),
  });

  // Run until all complete
  await harness.waitForAll({ maxIterations: 500 });

  // Verify all workers completed
  const workers = harness.getAllSimulators()
    .filter(s => s.role === "worker");

  expect(workers).toHaveLength(3);
  workers.forEach(w => {
    harness.assertSimulatorComplete(w.agentId);
  });

  // Verify all merge requests processed
  harness.assertMergeQueueDepth("default", 0);
});
```

## Running Harness Tests

```bash
# Run harness self-tests
npm test -- test_fixtures/harness/__tests__

# Run specific test file
npm test -- test_fixtures/harness/__tests__/test-harness-and-assertions.test.ts
```

## Best Practices

1. **Always call `cleanup()`** in `afterEach` to avoid resource leaks
2. **Use pre-built behaviors** when possible for consistency
3. **Use deterministic stepping** instead of timers for reliable tests
4. **Create custom behaviors** with factory functions for parameterization
5. **Check assertions in order** - agent state before task state before git state
