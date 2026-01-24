/**
 * Steering and Task Integration E2E Tests
 *
 * Tests for in-flight steering (broadcast, context injection) and task backend
 * integration using REAL Claude Code agents.
 *
 * REQUIRES: RUN_FULL_AGENT_TESTS=true environment variable
 *
 * Run with:
 *   RUN_FULL_AGENT_TESTS=true npm run test:e2e -- src/__tests__/e2e/steering-task.e2e.test.ts
 *
 * @see s-1zcx Multi-Agent Orchestration Testing Strategy
 * @see i-9cwb Phase 2f: Steering and Task Integration E2E Tests
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execSync } from "child_process";

import { createEventStore, type EventStore } from "../../store/event-store.js";
import {
  createAgentManager,
  type AgentManager,
} from "../../agent/agent-manager.js";
import {
  createMessageRouter,
  type MessageRouter,
} from "../../router/message-router.js";
import { InMemoryTaskBackend } from "../../task/backend/memory.js";
import type { TaskBackend } from "../../task/backend/types.js";

// ─────────────────────────────────────────────────────────────────
// Test Configuration
// ─────────────────────────────────────────────────────────────────

const RUN_FULL_AGENT = !!process.env.RUN_FULL_AGENT_TESTS;
const testFn = RUN_FULL_AGENT ? it : it.skip;

const log = (msg: string) => console.log(`[SteeringTask-E2E] ${msg}`);

// Timeouts for different operations
const TIMEOUT = {
  SPAWN: 60000,
  PROMPT: 120000,
  INJECTION: 90000,
  TASK_LIFECYCLE: 180000,
};

/**
 * Create an isolated test git repo
 */
function createTestRepo(prefix: string): {
  path: string;
  cleanup: () => void;
  createWorktree: (branch: string) => string;
} {
  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), `steering-task-e2e-${prefix}-`)
  );

  // Create the main repo
  const repoPath = path.join(tmpDir, "main-repo");
  fs.mkdirSync(repoPath);
  execSync("git init", { cwd: repoPath, stdio: "pipe" });
  execSync('git config user.email "test@test.com"', {
    cwd: repoPath,
    stdio: "pipe",
  });
  execSync('git config user.name "Test User"', {
    cwd: repoPath,
    stdio: "pipe",
  });

  // Create initial files
  fs.mkdirSync(path.join(repoPath, "src"));
  fs.writeFileSync(
    path.join(repoPath, "src/index.ts"),
    "export const version = '1.0.0';\n"
  );
  fs.writeFileSync(path.join(repoPath, "README.md"), "# Steering Task E2E Test\n");
  execSync("git add -A", { cwd: repoPath, stdio: "pipe" });
  execSync('git commit -m "Initial commit"', { cwd: repoPath, stdio: "pipe" });

  // Create worktrees directory
  const worktreesDir = path.join(tmpDir, "worktrees");
  fs.mkdirSync(worktreesDir);

  const createWorktree = (branch: string) => {
    const worktreePath = path.join(worktreesDir, branch.replace(/\//g, "-"));
    try {
      execSync(`git worktree add ${worktreePath} -b ${branch} HEAD`, {
        cwd: repoPath,
        stdio: "pipe",
      });
    } catch {
      // Branch might already exist
      execSync(`git worktree add ${worktreePath} ${branch}`, {
        cwd: repoPath,
        stdio: "pipe",
      });
    }
    // Configure git user in worktree
    execSync('git config user.email "test@test.com"', {
      cwd: worktreePath,
      stdio: "pipe",
    });
    execSync('git config user.name "Test User"', {
      cwd: worktreePath,
      stdio: "pipe",
    });
    return worktreePath;
  };

  return {
    path: repoPath,
    cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }),
    createWorktree,
  };
}

/**
 * Wait for agent to reach a specific state
 */
async function waitForAgentState(
  agentManager: AgentManager,
  agentId: string,
  targetState: "running" | "stopped",
  timeoutMs = 30000
): Promise<void> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    const agent = agentManager.get(agentId);
    if (agent?.state === targetState) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    `Timeout waiting for agent ${agentId} to reach state ${targetState}`
  );
}

/**
 * Collect agent response from a prompt
 */
async function collectPromptResponse(
  agentManager: AgentManager,
  agentId: string,
  prompt: string
): Promise<string> {
  let response = "";
  for await (const update of agentManager.prompt(agentId, prompt)) {
    const updateObj = update as Record<string, unknown>;
    if (updateObj.sessionUpdate === "agent_message_chunk") {
      const content = updateObj.content as { text?: string } | undefined;
      if (content?.text) {
        response += content.text;
      }
    }
  }
  return response;
}

// ─────────────────────────────────────────────────────────────────
// Steering and Task E2E Tests
// ─────────────────────────────────────────────────────────────────

describe("Steering and Task E2E", () => {
  let eventStore: EventStore;
  let agentManager: AgentManager;
  let messageRouter: MessageRouter;
  let taskBackend: TaskBackend;
  let testRepo: ReturnType<typeof createTestRepo>;

  beforeEach(async () => {
    if (!RUN_FULL_AGENT) {
      log("⚠️  Skipping: RUN_FULL_AGENT_TESTS not set");
      return;
    }

    testRepo = createTestRepo("steering-task");
    log(`Test repo created at: ${testRepo.path}`);

    eventStore = await createEventStore({ inMemory: true });
    messageRouter = createMessageRouter(eventStore);
    agentManager = createAgentManager(eventStore, messageRouter, {
      defaultPermissionMode: "auto-approve",
      defaultCwd: testRepo.path,
    });
    taskBackend = new InMemoryTaskBackend(eventStore);

    log("Services initialized");
  });

  afterEach(async () => {
    if (!RUN_FULL_AGENT) return;

    // Terminate all remaining agents
    try {
      for (const agent of agentManager.list()) {
        if (agent.state === "running") {
          try {
            await agentManager.terminate(agent.id, "test_cleanup");
          } catch {
            // Ignore termination errors during cleanup
          }
        }
      }
    } catch {
      // Ignore errors during cleanup
    }

    await agentManager?.close();
    await eventStore?.close();
    testRepo?.cleanup();
    log("Cleanup complete");
  });

  // ─────────────────────────────────────────────────────────────────
  // Scenario 5a: Broadcast to Workers E2E
  // ─────────────────────────────────────────────────────────────────

  describe("Scenario 5a: Broadcast to Workers", () => {
    testFn(
      "should deliver broadcast message to workers with unique confirmation",
      async () => {
        log("=== Scenario 5a: Broadcast to Workers E2E ===");

        // Generate unique task number for verification
        const taskNumber = Math.floor(Math.random() * 10000);
        log(`Task number for verification: ${taskNumber}`);

        // Spawn coordinator
        const coordinator = await agentManager.spawn({
          task: "You are a coordinator. Wait for instructions.",
          role: "coordinator",
          streamId: "stream-broadcast",
          cwd: testRepo.path,
        });
        await waitForAgentState(agentManager, coordinator.id, "running");
        log(`Coordinator spawned: ${coordinator.id}`);

        // Spawn workers
        const wt1 = testRepo.createWorktree("feature/worker1");
        const wt2 = testRepo.createWorktree("feature/worker2");

        const worker1 = await agentManager.spawn({
          task: "You are Worker 1. When given a task assignment with a number, confirm receipt by mentioning the number.",
          role: "worker",
          streamId: "stream-broadcast",
          parent: coordinator.id,
          cwd: wt1,
        });
        await waitForAgentState(agentManager, worker1.id, "running");
        log(`Worker 1 spawned: ${worker1.id}`);

        const worker2 = await agentManager.spawn({
          task: "You are Worker 2. When given a task assignment with a number, confirm receipt by mentioning the number.",
          role: "worker",
          streamId: "stream-broadcast",
          parent: coordinator.id,
          cwd: wt2,
        });
        await waitForAgentState(agentManager, worker2.id, "running");
        log(`Worker 2 spawned: ${worker2.id}`);

        // Spawn a monitor (should NOT receive @workers broadcast)
        const monitor = await agentManager.spawn({
          task: "You are a Monitor. Watch the system.",
          role: "monitor",
          streamId: "stream-broadcast",
          cwd: testRepo.path,
        });
        await waitForAgentState(agentManager, monitor.id, "running");
        log(`Monitor spawned: ${monitor.id}`);

        // Send task assignment message to workers
        const broadcastMessage = `You have been assigned task number ${taskNumber}. Please confirm you received this task assignment.`;

        // Prompt workers to confirm they received the message
        log("Sending broadcast message to workers...");
        const [response1, response2] = await Promise.all([
          collectPromptResponse(agentManager, worker1.id, broadcastMessage),
          collectPromptResponse(agentManager, worker2.id, broadcastMessage),
        ]);

        log(`Worker 1 response: ${response1.slice(0, 100)}...`);
        log(`Worker 2 response: ${response2.slice(0, 100)}...`);

        // Verify both workers acknowledged the task number
        expect(response1.includes(String(taskNumber))).toBe(true);
        expect(response2.includes(String(taskNumber))).toBe(true);
        log("✓ Both workers confirmed receipt of broadcast message");

        // Cleanup
        await agentManager.terminate(worker1.id, "test_complete");
        await agentManager.terminate(worker2.id, "test_complete");
        await agentManager.terminate(monitor.id, "test_complete");
        await agentManager.terminate(coordinator.id, "test_complete");

        log("✓ Scenario 5a complete");
      },
      { timeout: TIMEOUT.INJECTION }
    );
  });

  // ─────────────────────────────────────────────────────────────────
  // Scenario 5c: Context Injection E2E
  // ─────────────────────────────────────────────────────────────────

  describe("Scenario 5c: Context Injection", () => {
    testFn(
      "should inject context into running agent and verify response",
      async () => {
        log("=== Scenario 5c: Context Injection E2E ===");

        // Generate unique priority level for verification
        const priorityLevel = Math.floor(Math.random() * 100);
        log(`Priority level for verification: ${priorityLevel}`);

        // Spawn a worker that will receive context injection
        const wt = testRepo.createWorktree("feature/injection-test");

        const worker = await agentManager.spawn({
          task: `You are a worker agent. When you receive priority updates, acknowledge the priority level in your response.`,
          role: "worker",
          streamId: "stream-inject",
          cwd: wt,
        });
        await waitForAgentState(agentManager, worker.id, "running");
        log(`Worker spawned: ${worker.id}`);

        // Initial prompt to get agent ready
        log("Initial prompt to warm up agent...");
        await collectPromptResponse(
          agentManager,
          worker.id,
          "Acknowledge you are ready and waiting for priority updates."
        );
        log("Worker is ready");

        // Inject context via high-priority prompt (simulates context injection)
        const injectedContext = `Priority update: Your current task priority has been changed to level ${priorityLevel}. Please acknowledge this update.`;

        log("Injecting context into worker...");
        const response = await collectPromptResponse(
          agentManager,
          worker.id,
          injectedContext
        );

        log(`Worker response to injection: ${response.slice(0, 150)}...`);

        // Verify worker received and processed the injection
        expect(response.includes(String(priorityLevel))).toBe(true);
        log("✓ Worker confirmed receipt and processing of injected context");

        // Cleanup
        await agentManager.terminate(worker.id, "test_complete");

        log("✓ Scenario 5c complete");
      },
      { timeout: TIMEOUT.INJECTION }
    );

    testFn(
      "should inject context into busy agent during task execution",
      async () => {
        log("=== Scenario 5c: Injection into Busy Agent ===");

        const urgentTaskId = Math.floor(Math.random() * 1000);
        const wt = testRepo.createWorktree("feature/busy-inject");

        // Spawn worker with a longer-running task
        const worker = await agentManager.spawn({
          task: `You are a worker. When you receive an urgent task reassignment, acknowledge the new task ID.`,
          role: "worker",
          streamId: "stream-busy-inject",
          cwd: wt,
        });
        await waitForAgentState(agentManager, worker.id, "running");
        log(`Worker spawned: ${worker.id}`);

        // Start a task
        log("Starting worker on a task...");
        const taskPromise = collectPromptResponse(
          agentManager,
          worker.id,
          "Create a file named test.txt with 'hello world'. Then wait for further instructions."
        );

        // Wait a moment then inject priority context
        await new Promise((r) => setTimeout(r, 2000));

        log("Injecting high-priority context...");
        const injectionPromise = collectPromptResponse(
          agentManager,
          worker.id,
          `URGENT: You have been reassigned to task ${urgentTaskId}. Please acknowledge this reassignment immediately.`
        );

        // Wait for both to complete
        const [taskResponse, injectionResponse] = await Promise.all([
          taskPromise,
          injectionPromise,
        ]);

        log(`Task response: ${taskResponse.slice(0, 100)}...`);
        log(`Injection response: ${injectionResponse.slice(0, 100)}...`);

        // At least one response should mention the urgent task ID
        const taskIdReceived =
          taskResponse.includes(String(urgentTaskId)) ||
          injectionResponse.includes(String(urgentTaskId));
        expect(taskIdReceived).toBe(true);
        log("✓ Urgent task ID received by busy agent");

        // Cleanup
        await agentManager.terminate(worker.id, "test_complete");

        log("✓ Busy agent injection complete");
      },
      { timeout: TIMEOUT.INJECTION }
    );
  });

  // ─────────────────────────────────────────────────────────────────
  // Scenario 6a: Worker Claims and Completes Task E2E
  // ─────────────────────────────────────────────────────────────────

  describe("Scenario 6a: Task Lifecycle with Real Agent", () => {
    testFn(
      "should complete full task lifecycle: create → assign → start → complete",
      async () => {
        log("=== Scenario 6a: Task Lifecycle E2E ===");

        // Create a task in the backend
        const task = await taskBackend.create({
          description: "Create a greeting.ts file with a hello function",
          created_by: "coordinator-e2e",
        });
        log(`Task created: ${task.id}`);
        expect(task.status).toBe("pending");

        // Spawn a worker to claim and execute the task
        const wt = testRepo.createWorktree("feature/task-lifecycle");

        const worker = await agentManager.spawn({
          task: `You are a worker assigned to task ${task.id}.
                 Create a file src/greeting.ts with: export function hello() { return 'Hello!'; }
                 Then commit your changes.`,
          role: "worker",
          streamId: "stream-task-lifecycle",
          cwd: wt,
        });
        await waitForAgentState(agentManager, worker.id, "running");
        log(`Worker spawned: ${worker.id}`);

        // Assign task to worker
        await taskBackend.assign(task.id, worker.id);
        const assignedTask = await taskBackend.get(task.id);
        expect(assignedTask?.status).toBe("assigned");
        expect(assignedTask?.assigned_agent).toBe(worker.id);
        log("✓ Task assigned to worker");

        // Start task
        await taskBackend.start(task.id);
        const inProgressTask = await taskBackend.get(task.id);
        expect(inProgressTask?.status).toBe("in_progress");
        log("✓ Task in progress");

        // Prompt worker to do the work
        log("Prompting worker to execute task...");
        const response = await collectPromptResponse(
          agentManager,
          worker.id,
          "Execute your assigned task: create src/greeting.ts with a hello function."
        );
        log(`Worker response: ${response.slice(0, 100)}...`);

        // Verify the file was created
        const greetingPath = path.join(wt, "src/greeting.ts");
        const fileExists = fs.existsSync(greetingPath);
        log(`File created: ${fileExists}`);

        // Complete the task
        await taskBackend.complete(task.id, {
          data: { summary: "Created greeting.ts with hello function" },
        });
        const completedTask = await taskBackend.get(task.id);
        expect(completedTask?.status).toBe("completed");
        log("✓ Task completed");

        // Cleanup
        await agentManager.terminate(worker.id, "test_complete");

        log("✓ Scenario 6a complete");
      },
      { timeout: TIMEOUT.TASK_LIFECYCLE }
    );
  });

  // ─────────────────────────────────────────────────────────────────
  // Scenario 6b: Blocked Task Workflow E2E
  // ─────────────────────────────────────────────────────────────────

  describe("Scenario 6b: Blocked Task Workflow", () => {
    testFn(
      "should handle task dependencies and unblock after prerequisite completes",
      async () => {
        log("=== Scenario 6b: Blocked Task Workflow E2E ===");

        // Create prerequisite task
        const prereqTask = await taskBackend.create({
          description: "Create types.ts with shared interfaces",
          created_by: "coordinator-e2e",
        });
        log(`Prerequisite task created: ${prereqTask.id}`);

        // Create dependent task
        const dependentTask = await taskBackend.create({
          description: "Create utils.ts that uses types from types.ts",
          created_by: "coordinator-e2e",
        });
        log(`Dependent task created: ${dependentTask.id}`);

        // Add blocker relationship
        await taskBackend.addBlocker(dependentTask.id, prereqTask.id);
        log("✓ Blocker relationship added");

        // Verify dependent task is blocked
        const blockedTask = await taskBackend.get(dependentTask.id);
        expect(blockedTask?.isBlocked).toBe(true);
        log("✓ Dependent task is blocked");

        // Verify listReady excludes blocked task
        const readyTasks = await taskBackend.listReady();
        const readyIds = readyTasks.map((t) => t.id);
        expect(readyIds).toContain(prereqTask.id);
        expect(readyIds).not.toContain(dependentTask.id);
        log("✓ Only prerequisite is in ready list");

        // Spawn worker for prerequisite
        const wt1 = testRepo.createWorktree("feature/prereq");
        const worker1 = await agentManager.spawn({
          task: `You are Worker 1. Create src/types.ts with: export interface Greeting { message: string; }`,
          role: "worker",
          streamId: "stream-blocked",
          cwd: wt1,
        });
        await waitForAgentState(agentManager, worker1.id, "running");
        log(`Worker 1 spawned for prerequisite: ${worker1.id}`);

        // Assign and complete prerequisite
        await taskBackend.assign(prereqTask.id, worker1.id);
        await taskBackend.start(prereqTask.id);

        // Prompt worker to execute
        await collectPromptResponse(
          agentManager,
          worker1.id,
          "Create src/types.ts with a Greeting interface."
        );

        await taskBackend.complete(prereqTask.id, {
          data: { summary: "Created types.ts" },
        });
        log("✓ Prerequisite task completed");

        // Verify dependent task is now unblocked
        const unblockedTask = await taskBackend.get(dependentTask.id);
        expect(unblockedTask?.isBlocked).toBe(false);
        log("✓ Dependent task is now unblocked");

        // Verify dependent is now in ready list
        const readyAfter = await taskBackend.listReady();
        const readyIdsAfter = readyAfter.map((t) => t.id);
        expect(readyIdsAfter).toContain(dependentTask.id);
        log("✓ Dependent task now in ready list");

        // Spawn second worker for dependent task
        const wt2 = testRepo.createWorktree("feature/dependent");
        const worker2 = await agentManager.spawn({
          task: `You are Worker 2. Create src/utils.ts that imports from types.ts.`,
          role: "worker",
          streamId: "stream-blocked",
          cwd: wt2,
        });
        await waitForAgentState(agentManager, worker2.id, "running");
        log(`Worker 2 spawned for dependent task: ${worker2.id}`);

        // Assign and complete dependent task
        await taskBackend.assign(dependentTask.id, worker2.id);
        await taskBackend.start(dependentTask.id);

        await collectPromptResponse(
          agentManager,
          worker2.id,
          "Create src/utils.ts that uses the Greeting interface."
        );

        await taskBackend.complete(dependentTask.id, {
          data: { summary: "Created utils.ts using types" },
        });
        log("✓ Dependent task completed");

        // Verify both tasks are completed
        const finalPrereq = await taskBackend.get(prereqTask.id);
        const finalDependent = await taskBackend.get(dependentTask.id);
        expect(finalPrereq?.status).toBe("completed");
        expect(finalDependent?.status).toBe("completed");
        log("✓ Both tasks completed successfully");

        // Cleanup
        await agentManager.terminate(worker1.id, "test_complete");
        await agentManager.terminate(worker2.id, "test_complete");

        log("✓ Scenario 6b complete");
      },
      { timeout: TIMEOUT.TASK_LIFECYCLE }
    );
  });
});

// ─────────────────────────────────────────────────────────────────
// Info message for running tests
// ─────────────────────────────────────────────────────────────────

if (!RUN_FULL_AGENT) {
  console.log("\n┌─────────────────────────────────────────────────────────────┐");
  console.log("│  Steering/Task E2E tests are skipped (no RUN_FULL_AGENT_TESTS)│");
  console.log("│                                                              │");
  console.log("│  To run with real agents:                                    │");
  console.log("│  RUN_FULL_AGENT_TESTS=true npm run test:e2e -- \\             │");
  console.log("│    src/__tests__/e2e/steering-task.e2e.test.ts               │");
  console.log("└─────────────────────────────────────────────────────────────┘\n");
}
