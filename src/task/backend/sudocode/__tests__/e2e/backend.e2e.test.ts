/**
 * E2E Tests for SudocodeTaskBackend
 *
 * Tests the full task lifecycle integration with sudocode issues,
 * including blocker workflows, multiple tasks per issue, and sync policies.
 *
 * Run with:
 *   npm run test:e2e:sudocode
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { spawn, execSync, ChildProcess } from "child_process";
import { mkdtempSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ServerClient } from "../../server-client.js";
import { SudocodeTaskBackend } from "../../backend.js";
import { createEventStore } from "../../../../../store/event-store.js";
import type { EventStore } from "../../../../../store/event-store.js";
import type { Issue } from "../../client.js";
import type { TaskChangeEvent } from "../../../types.js";

// Configuration
const TEST_PORT = 13580; // Different port from server-client tests
const SERVER_URL = `http://localhost:${TEST_PORT}`;
const WS_URL = `ws://localhost:${TEST_PORT}/ws`;
const TEST_TIMEOUT = 20000;
const SERVER_STARTUP_TIMEOUT = 15000;

// Global state
let serverProcess: ChildProcess | null = null;
let projectDir: string | null = null;
let projectId: string | null = null;
let eventStore: EventStore;
let client: ServerClient;
let backend: SudocodeTaskBackend;

// Track created issues for cleanup
const createdIssueIds: string[] = [];

/**
 * Normalize path to handle macOS symlinks (/var -> /private/var)
 */
function normalizePath(p: string): string {
  if (p.startsWith("/private/")) {
    return p.substring("/private".length);
  }
  return p;
}

/**
 * Wait for the server to be ready
 */
async function waitForServer(
  url: string,
  timeout: number = SERVER_STARTUP_TIMEOUT
): Promise<boolean> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 1000);

      const response = await fetch(`${url}/health`, {
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (response.ok) {
        return true;
      }
    } catch {
      // Server not ready yet
    }

    await new Promise((r) => setTimeout(r, 200));
  }

  return false;
}

/**
 * Get the project ID for our test project from the server (with retry)
 */
async function getProjectId(
  serverUrl: string,
  projectPath: string,
  maxRetries: number = 10
): Promise<string> {
  const normalizedPath = normalizePath(projectPath);

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await fetch(`${serverUrl}/api/projects`);
      const result = await response.json();

      if (!result.success || !Array.isArray(result.data)) {
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }

      const project = result.data.find((p: { path: string; id: string }) => {
        const normalizedProjectPath = normalizePath(p.path);
        return normalizedProjectPath === normalizedPath;
      });

      if (project) {
        return project.id;
      }
    } catch {
      // Retry
    }

    await new Promise((r) => setTimeout(r, 500));
  }

  throw new Error(`Project not found for path: ${projectPath} after ${maxRetries} retries`);
}

/**
 * Start the sudocode server
 */
async function startServer(): Promise<void> {
  // Kill any stale processes on the test port
  try {
    execSync(`lsof -t -i :${TEST_PORT} | xargs kill -9 2>/dev/null || true`, {
      stdio: "ignore",
    });
  } catch {
    // Ignore
  }

  // Create temporary project directory
  projectDir = mkdtempSync(join(tmpdir(), "sudocode-backend-e2e-"));

  // Initialize sudocode
  await new Promise<void>((resolve, reject) => {
    const initProcess = spawn("npx", ["sudocode", "init"], {
      cwd: projectDir!,
      stdio: "pipe",
    });

    initProcess.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`sudocode init failed with code ${code}`));
      }
    });

    initProcess.on("error", reject);
  });

  // Start the server
  serverProcess = spawn(
    "npx",
    ["sudocode", "server", "-p", String(TEST_PORT)],
    {
      cwd: projectDir,
      stdio: "pipe",
      env: { ...process.env, FORCE_COLOR: "0" },
    }
  );

  serverProcess.stdout?.on("data", (data) => {
    if (process.env.DEBUG_E2E) {
      console.log(`[server stdout] ${data}`);
    }
  });

  serverProcess.stderr?.on("data", (data) => {
    if (process.env.DEBUG_E2E) {
      console.error(`[server stderr] ${data}`);
    }
  });

  // Wait for server to be ready
  const ready = await waitForServer(SERVER_URL);
  if (!ready) {
    throw new Error(`Server failed to start within ${SERVER_STARTUP_TIMEOUT}ms`);
  }

  // Get project ID
  projectId = await getProjectId(SERVER_URL, projectDir);
}

/**
 * Stop the sudocode server
 */
async function stopServer(): Promise<void> {
  if (serverProcess) {
    serverProcess.kill("SIGTERM");

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        serverProcess?.kill("SIGKILL");
        resolve();
      }, 5000);

      serverProcess!.on("close", () => {
        clearTimeout(timeout);
        resolve();
      });
    });

    serverProcess = null;
  }

  if (projectDir && existsSync(projectDir)) {
    rmSync(projectDir, { recursive: true, force: true });
    projectDir = null;
  }
}

/**
 * Create a test issue via the API
 */
async function createTestIssue(
  title: string,
  content?: string
): Promise<Issue> {
  const response = await fetch(`${SERVER_URL}/api/issues`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Project-ID": projectId!,
    },
    body: JSON.stringify({
      title,
      content: content ?? `Test content for ${title}`,
      status: "open",
      priority: 2,
    }),
  });

  const result = await response.json();
  if (!result.success) {
    throw new Error(`Failed to create issue: ${result.message}`);
  }

  createdIssueIds.push(result.data.id);
  return result.data;
}

/**
 * Wait for condition with timeout
 */
async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeout: number = 5000
): Promise<void> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeout) {
    if (await condition()) {
      return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Condition not met within ${timeout}ms`);
}

describe("SudocodeTaskBackend E2E", () => {
  beforeAll(async () => {
    console.log("\n🚀 Starting sudocode server for Backend E2E tests...");
    await startServer();
    console.log(`✅ Server ready at ${SERVER_URL}\n`);
  }, SERVER_STARTUP_TIMEOUT + 10000);

  afterAll(async () => {
    console.log("\n🛑 Shutting down sudocode server...");
    await stopServer();
    console.log("✅ Cleanup complete\n");
  }, 15000);

  beforeEach(async () => {
    // Create a fresh EventStore for each test with a unique instance ID
    const instanceId = `e2e-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    eventStore = await createEventStore({
      instanceId,
      inMemory: true, // Use in-memory for tests
    });

    // Create ServerClient
    client = new ServerClient({
      serverUrl: SERVER_URL,
      wsUrl: WS_URL,
      projectId: projectId!,
    });

    // Wait for WebSocket connection
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("WebSocket connection timeout"));
      }, 5000);

      const checkReady = () => {
        if (client.isReady()) {
          clearTimeout(timeout);
          resolve();
        } else {
          setTimeout(checkReady, 50);
        }
      };
      checkReady();
    });

    // Create SudocodeTaskBackend
    backend = new SudocodeTaskBackend(eventStore, client, {
      syncStatus: true,
      autoCloseIssues: false,
    });
  });

  afterEach(() => {
    if (client) {
      client.close();
    }
  });

  describe("Basic Workflow", () => {
    it(
      "should complete full task lifecycle bound to issue",
      { timeout: TEST_TIMEOUT },
      async () => {
        // Create sudocode issue
        const issue = await createTestIssue("E2E Backend Task Lifecycle");

        // 1. Create task bound to issue
        const task = await backend.create({
          description: "Implement test feature",
          created_by: "test-agent",
          external_id: issue.id,
        });

        expect(task.external_id).toBe(issue.id);
        expect(task.status).toBe("pending");

        // 2. Assign task
        await backend.assign(task.id, "worker-1");
        const assignedTask = await backend.get(task.id);
        expect(assignedTask?.assigned_agent).toBe("worker-1");
        expect(assignedTask?.status).toBe("assigned");

        // 3. Start task
        await backend.start(task.id);
        const inProgressTask = await backend.get(task.id);
        expect(inProgressTask?.status).toBe("in_progress");

        // Verify issue status was updated (if syncStatus is true)
        await new Promise((r) => setTimeout(r, 200));
        const updatedIssue = await client.getIssue(issue.id);
        expect(updatedIssue?.status).toBe("in_progress");

        // 4. Complete task
        await backend.complete(task.id, { summary: "Feature implemented" });
        const completedTask = await backend.get(task.id);
        expect(completedTask?.status).toBe("completed");
      }
    );

    it(
      "should create task without external binding",
      { timeout: TEST_TIMEOUT },
      async () => {
        const task = await backend.create({
          description: "Internal task without issue binding",
          created_by: "test-agent",
        });

        expect(task.external_id).toBeUndefined();
        expect(task.status).toBe("pending");

        // Should still work through full lifecycle
        await backend.assign(task.id, "worker-1");
        await backend.start(task.id);
        await backend.complete(task.id);

        const completedTask = await backend.get(task.id);
        expect(completedTask?.status).toBe("completed");
      }
    );
  });

  describe("Multiple Tasks Per Issue", () => {
    it(
      "should support multiple tasks bound to same issue",
      { timeout: TEST_TIMEOUT },
      async () => {
        const issue = await createTestIssue("E2E Multi-Task Issue");

        // Create two tasks for same issue (parallel workers)
        const task1 = await backend.create({
          description: "Worker 1 attempt",
          created_by: "coordinator",
          external_id: issue.id,
        });

        const task2 = await backend.create({
          description: "Worker 2 attempt",
          created_by: "coordinator",
          external_id: issue.id,
        });

        // Both bound to same issue
        expect(task1.external_id).toBe(issue.id);
        expect(task2.external_id).toBe(issue.id);

        // Start both
        await backend.assign(task1.id, "worker-1");
        await backend.assign(task2.id, "worker-2");
        await backend.start(task1.id);
        await backend.start(task2.id);

        // Complete one, fail other
        await backend.complete(task1.id, { summary: "success" });
        await backend.fail(task2.id, { code: "TIMEOUT", message: "Timed out" });

        // Verify statuses
        const completedTask = await backend.get(task1.id);
        const failedTask = await backend.get(task2.id);
        expect(completedTask?.status).toBe("completed");
        expect(failedTask?.status).toBe("failed");

        // Issue should still be open (coordinator decides when to close)
        const finalIssue = await client.getIssue(issue.id);
        expect(finalIssue?.status).toBe("in_progress");
      }
    );
  });

  describe("Blocker Workflow", () => {
    it(
      "should handle blockers via sudocode relationships",
      { timeout: TEST_TIMEOUT },
      async () => {
        // Create two issues with blocking relationship
        const blockerIssue = await createTestIssue("E2E Blocker Task");
        const blockedIssue = await createTestIssue("E2E Blocked Task");

        // Create blocking relationship
        await client.createLink(blockerIssue.id, blockedIssue.id, "blocks");

        // Create tasks bound to these issues
        const blockerTask = await backend.create({
          description: "Blocker task",
          created_by: "coordinator",
          external_id: blockerIssue.id,
        });

        const blockedTask = await backend.create({
          description: "Blocked task",
          created_by: "coordinator",
          external_id: blockedIssue.id,
        });

        // Verify the blocking relationship exists via backend.getBlockers
        // (This doesn't depend on toExtendedTask's isBlocked computation)
        const blockers = await backend.getBlockers(blockedTask.id);
        expect(blockers.length).toBeGreaterThan(0);
        expect(blockers[0].id).toBe(blockerTask.id);

        // Blocked task should have isBlocked (via toExtendedTask computation)
        const enrichedBlocked = await backend.get(blockedTask.id);
        expect(enrichedBlocked?.isBlocked).toBe(true);

        // Blocker task should not be blocked
        const enrichedBlocker = await backend.get(blockerTask.id);
        expect(enrichedBlocker?.isBlocked).toBe(false);

        // listReady should exclude blocked task
        const ready = await backend.listReady();
        const readyIds = ready.map((t) => t.id);
        expect(readyIds).toContain(blockerTask.id);
        expect(readyIds).not.toContain(blockedTask.id);

        // Complete blocker task and close blocker issue
        await backend.assign(blockerTask.id, "worker-1");
        await backend.start(blockerTask.id);
        await backend.complete(blockerTask.id, { summary: "done" });
        await client.updateIssue(blockerIssue.id, { status: "closed" });

        // Wait for status to propagate
        await new Promise((r) => setTimeout(r, 500));

        // Now blocked task should be ready
        const readyAfter = await backend.listReady();
        const readyIdsAfter = readyAfter.map((t) => t.id);
        expect(readyIdsAfter).toContain(blockedTask.id);

        // isBlocked should now be false
        const unblockedTask = await backend.get(blockedTask.id);
        expect(unblockedTask?.isBlocked).toBe(false);
      }
    );

    it(
      "should use getBlockers and getBlocking methods",
      { timeout: TEST_TIMEOUT },
      async () => {
        const blockerIssue = await createTestIssue("E2E Blocker For Methods");
        const blockedIssue = await createTestIssue("E2E Blocked For Methods");

        await client.createLink(blockerIssue.id, blockedIssue.id, "blocks");

        const blockerTask = await backend.create({
          description: "Blocker",
          created_by: "test",
          external_id: blockerIssue.id,
        });

        const blockedTask = await backend.create({
          description: "Blocked",
          created_by: "test",
          external_id: blockedIssue.id,
        });

        // Wait for relationship to propagate
        await new Promise((r) => setTimeout(r, 300));

        // Test getBlockers
        const blockers = await backend.getBlockers(blockedTask.id);
        expect(blockers.map((t) => t.id)).toContain(blockerTask.id);

        // Test getBlocking
        const blocking = await backend.getBlocking(blockerTask.id);
        expect(blocking.map((t) => t.id)).toContain(blockedTask.id);
      }
    );
  });

  describe("Task Filtering", () => {
    it(
      "should filter tasks by status",
      { timeout: TEST_TIMEOUT },
      async () => {
        const issue1 = await createTestIssue("E2E Filter Issue 1");
        const issue2 = await createTestIssue("E2E Filter Issue 2");

        const task1 = await backend.create({
          description: "Task 1",
          created_by: "test",
          external_id: issue1.id,
        });

        const task2 = await backend.create({
          description: "Task 2",
          created_by: "test",
          external_id: issue2.id,
        });

        // Start task1
        await backend.assign(task1.id, "worker-1");
        await backend.start(task1.id);

        // Filter by status
        const pendingTasks = await backend.list({ status: "pending" });
        expect(pendingTasks.some((t) => t.id === task2.id)).toBe(true);
        expect(pendingTasks.some((t) => t.id === task1.id)).toBe(false);

        const inProgressTasks = await backend.list({ status: "in_progress" });
        expect(inProgressTasks.some((t) => t.id === task1.id)).toBe(true);
        expect(inProgressTasks.some((t) => t.id === task2.id)).toBe(false);
      }
    );

    it(
      "should filter tasks by assigned agent",
      { timeout: TEST_TIMEOUT },
      async () => {
        const task1 = await backend.create({
          description: "Task for Worker 1",
          created_by: "test",
        });

        const task2 = await backend.create({
          description: "Task for Worker 2",
          created_by: "test",
        });

        await backend.assign(task1.id, "worker-1");
        await backend.assign(task2.id, "worker-2");

        const worker1Tasks = await backend.list({ assigned_agent: "worker-1" });
        expect(worker1Tasks.length).toBe(1);
        expect(worker1Tasks[0].id).toBe(task1.id);

        const worker2Tasks = await backend.list({ assigned_agent: "worker-2" });
        expect(worker2Tasks.length).toBe(1);
        expect(worker2Tasks[0].id).toBe(task2.id);
      }
    );
  });

  describe("Subtask Hierarchy", () => {
    it(
      "should create and manage subtasks",
      { timeout: TEST_TIMEOUT },
      async () => {
        const parentIssue = await createTestIssue("E2E Parent Task Issue");

        const parentTask = await backend.create({
          description: "Parent task",
          created_by: "coordinator",
          external_id: parentIssue.id,
        });

        // Create subtasks
        const subtask1 = await backend.createSubtask(parentTask.id, {
          description: "Subtask 1",
          created_by: "coordinator",
        });

        const subtask2 = await backend.createSubtask(parentTask.id, {
          description: "Subtask 2",
          created_by: "coordinator",
        });

        expect(subtask1.parent_task).toBe(parentTask.id);
        expect(subtask2.parent_task).toBe(parentTask.id);

        // Get children
        const children = await backend.getChildren(parentTask.id);
        expect(children.length).toBe(2);
        expect(children.map((c) => c.id)).toContain(subtask1.id);
        expect(children.map((c) => c.id)).toContain(subtask2.id);

        // Get subtask status
        const status = await backend.getSubtaskStatus(parentTask.id);
        expect(status.total).toBe(2);
        expect(status.pending).toBe(2);
        expect(status.completed).toBe(0);
        expect(status.allCompleted).toBe(false);

        // Complete subtasks
        await backend.assign(subtask1.id, "worker-1");
        await backend.start(subtask1.id);
        await backend.complete(subtask1.id);

        await backend.assign(subtask2.id, "worker-2");
        await backend.start(subtask2.id);
        await backend.complete(subtask2.id);

        const finalStatus = await backend.getSubtaskStatus(parentTask.id);
        expect(finalStatus.completed).toBe(2);
        expect(finalStatus.allCompleted).toBe(true);
      }
    );
  });

  describe("Agent History", () => {
    it(
      "should track agent assignment history",
      { timeout: TEST_TIMEOUT },
      async () => {
        const task = await backend.create({
          description: "Task with history",
          created_by: "coordinator",
        });

        // First assignment
        await backend.assign(task.id, "worker-1");
        await backend.start(task.id);

        // Unassign and reassign
        await backend.unassign(task.id);
        await backend.assign(task.id, "worker-2");
        await backend.start(task.id);
        await backend.complete(task.id);

        // Check history
        const history = await backend.getAgentHistory(task.id);
        expect(history.length).toBeGreaterThanOrEqual(2);
        expect(history.some((h) => h.agent_id === "worker-1")).toBe(true);
        expect(history.some((h) => h.agent_id === "worker-2")).toBe(true);
      }
    );
  });

  describe("Event Subscriptions", () => {
    it(
      "should emit events on task changes",
      { timeout: TEST_TIMEOUT },
      async () => {
        const events: TaskChangeEvent[] = [];

        const unsubscribe = backend.onTaskChange((event) => {
          events.push(event);
        });

        try {
          const task = await backend.create({
            description: "Event test task",
            created_by: "test",
          });

          await backend.assign(task.id, "worker-1");
          await backend.start(task.id);
          await backend.complete(task.id);

          // Wait for events
          await new Promise((r) => setTimeout(r, 200));

          // Should have received events for create, assign, start, complete
          // Backend currently emits "updated" for all changes
          expect(events.length).toBeGreaterThanOrEqual(3);

          const eventTypes = events.map((e) => e.type);
          expect(eventTypes).toContain("updated");
        } finally {
          unsubscribe();
        }
      }
    );

    it(
      "should filter events by task ID",
      { timeout: TEST_TIMEOUT },
      async () => {
        const task1Events: TaskChangeEvent[] = [];

        const task1 = await backend.create({
          description: "Task 1 for events",
          created_by: "test",
        });

        const task2 = await backend.create({
          description: "Task 2 for events",
          created_by: "test",
        });

        const unsubscribe = backend.onTaskChange(task1.id, (event) => {
          task1Events.push(event);
        });

        try {
          await backend.assign(task1.id, "worker-1");
          await backend.assign(task2.id, "worker-2");
          await backend.start(task1.id);
          await backend.start(task2.id);

          await new Promise((r) => setTimeout(r, 200));

          // Should only have events for task1
          expect(task1Events.every((e) => e.taskId === task1.id)).toBe(true);
        } finally {
          unsubscribe();
        }
      }
    );
  });
});
