/**
 * E2E Tests for UnifiedTaskToolProvider with real OpenTasks daemon
 *
 * Starts a real opentasks daemon, connects via IPCOpenTasksClient,
 * creates an OpenTasksTaskBackend, and exercises all 7 tools end-to-end.
 *
 * Requires: opentasks@0.0.3+ installed
 *
 * @module task/backend/__tests__/e2e/unified-tool-provider-opentasks.e2e.test
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { createEventStore, type EventStore } from "../../../../store/event-store.js";
import { OpenTasksTaskBackend } from "../../opentasks/backend.js";
import { IPCOpenTasksClient } from "../../opentasks/client.js";
import {
  UnifiedTaskToolProvider,
  type GetToolContext,
} from "../../unified-tool-provider.js";
import type { MCPToolDefinition } from "../../types.js";

// =============================================================================
// Helpers
// =============================================================================

const TEST_AGENT_ID = "agent_e2e_test";
const getContext: GetToolContext = () => ({ agent_id: TEST_AGENT_ID });

function findTool(
  tools: MCPToolDefinition[],
  name: string
): MCPToolDefinition {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool not found: ${name}`);
  return tool;
}

/**
 * Wait for a condition with timeout
 */
async function waitFor(
  condition: () => Promise<boolean> | boolean,
  timeoutMs = 5000,
  intervalMs = 100
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await condition()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
}

// =============================================================================
// Test Suite
// =============================================================================

describe("UnifiedTaskToolProvider E2E with real OpenTasks", () => {
  let tempDir: string;
  let locationPath: string;
  let daemon: any;
  let socketPath: string;
  let eventStore: EventStore;
  let otClient: IPCOpenTasksClient;
  let backend: OpenTasksTaskBackend;
  let provider: UnifiedTaskToolProvider;

  beforeAll(async () => {
    // Create temp directory for opentasks data
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "macro-e2e-opentasks-"));
    locationPath = path.join(tempDir, ".opentasks");
    fs.mkdirSync(locationPath, { recursive: true });

    const registryPath = path.join(tempDir, "registry.json");

    // Start a real opentasks daemon
    const opentasks = await import("opentasks");

    daemon = await opentasks.createDaemonWithStore({
      locationPath,
      version: "0.0.3",
      registryPath,
      shutdownTimeoutMs: 2000,
    });

    await daemon.start();
    socketPath = daemon.socketPath;

    // Create macro-agent event store (in-memory)
    eventStore = await createEventStore({ inMemory: true });

    // Create IPCOpenTasksClient pointing at the real daemon
    otClient = new IPCOpenTasksClient({
      socketPath,
      autoConnect: true,
      timeout: 10000,
    });
    await otClient.connect();

    // Create OpenTasks backend
    backend = new OpenTasksTaskBackend(eventStore, otClient, {
      socketPath,
      syncStatus: true,
      sourceLabel: "e2e-test",
    });

    // Create unified tool provider with all 7 tools
    provider = new UnifiedTaskToolProvider(backend, getContext, otClient);
  }, 30000);

  afterAll(async () => {
    // Teardown in reverse order
    try {
      otClient?.disconnect();
    } catch { /* ignore */ }
    try {
      await daemon?.stop();
    } catch { /* ignore */ }
    try {
      await eventStore?.close();
    } catch { /* ignore */ }
    try {
      if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  }, 15000);

  // ─────────────────────────────────────────────────────────────────────────────
  // Tool Exposure
  // ─────────────────────────────────────────────────────────────────────────────

  it("should expose all 8 tools with OpenTasks client", () => {
    const tools = provider.getTools();
    expect(tools).toHaveLength(8);
    expect(tools.map((t) => t.name)).toEqual([
      "create_task",
      "get_task",
      "list_tasks",
      "assign_task",
      "task",
      "link",
      "annotate",
      "list_providers",
    ]);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Core CRUD Tools (real backend → real daemon)
  // ─────────────────────────────────────────────────────────────────────────────

  describe("create_task → get_task roundtrip", () => {
    let createdTaskId: string;

    it("should create a task via create_task tool", async () => {
      const tool = findTool(provider.getTools(), "create_task");
      const result = (await tool.handler({
        description: "E2E test task",
      })) as { task_id: string; status: string; external_id?: string };

      expect(result.task_id).toMatch(/^task_/);
      expect(result.status).toBe("pending");
      createdTaskId = result.task_id;
    });

    it("should retrieve the task via get_task tool", async () => {
      const tool = findTool(provider.getTools(), "get_task");
      const result = (await tool.handler({
        task_id: createdTaskId,
      })) as { id: string; description: string; status: string };

      expect(result.id).toBe(createdTaskId);
      expect(result.description).toBe("E2E test task");
      expect(result.status).toBe("pending");
    });
  });

  describe("list_tasks", () => {
    it("should list tasks with filters", async () => {
      const createTool = findTool(provider.getTools(), "create_task");
      const listTool = findTool(provider.getTools(), "list_tasks");

      // Create a couple tasks
      await createTool.handler({ description: "List test A" });
      await createTool.handler({ description: "List test B" });

      const result = (await listTool.handler({})) as {
        tasks: Array<{ id: string; description: string }>;
        total: number;
      };

      expect(result.total).toBeGreaterThanOrEqual(2);
      expect(result.tasks.some((t) => t.description === "List test A")).toBe(true);
      expect(result.tasks.some((t) => t.description === "List test B")).toBe(true);
    });
  });

  describe("assign_task", () => {
    it("should assign a task to an agent", async () => {
      const createTool = findTool(provider.getTools(), "create_task");
      const assignTool = findTool(provider.getTools(), "assign_task");
      const getTool = findTool(provider.getTools(), "get_task");

      // Create
      const created = (await createTool.handler({
        description: "Assign test task",
      })) as { task_id: string };

      // Assign
      const assignResult = (await assignTool.handler({
        task_id: created.task_id,
        agent_id: "agent_worker_1",
      })) as { assigned_agent: string; assigned: boolean };

      expect(assignResult.assigned_agent).toBe("agent_worker_1");
      expect(assignResult.assigned).toBe(true);

      // Verify
      const task = (await getTool.handler({
        task_id: created.task_id,
      })) as { assigned_agent: string; status: string };

      expect(task.assigned_agent).toBe("agent_worker_1");
      expect(task.status).toBe("assigned");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // OpenTasks Graph Tools (real daemon)
  // ─────────────────────────────────────────────────────────────────────────────

  describe("task tool", () => {
    it("should transition a task through its lifecycle and sync to EventStore", async () => {
      const createTool = findTool(provider.getTools(), "create_task");
      const taskTool = findTool(provider.getTools(), "task");
      const getTool = findTool(provider.getTools(), "get_task");

      const created = (await createTool.handler({
        description: "Lifecycle test task",
      })) as { task_id: string; external_id?: string };

      const taskDetails = (await getTool.handler({
        task_id: created.task_id,
      })) as { external_id?: string; status: string };

      const externalId = taskDetails.external_id;
      expect(externalId).toBeDefined();
      expect(taskDetails.status).toBe("pending");

      // Start the task via opentasks daemon
      const startResult = await taskTool.handler({
        transition: { id: externalId, action: "start" },
      });
      expect(startResult).toBeDefined();

      // Verify EventStore was synced — get_task reads from EventStore
      const afterStart = (await getTool.handler({
        task_id: created.task_id,
      })) as { status: string };
      expect(afterStart.status).toBe("in_progress");

      // Complete the task via opentasks daemon
      const completeResult = await taskTool.handler({
        transition: { id: externalId, action: "complete" },
      });
      expect(completeResult).toBeDefined();

      // Verify EventStore was synced
      const afterComplete = (await getTool.handler({
        task_id: created.task_id,
      })) as { status: string };
      expect(afterComplete.status).toBe("completed");
    });

    it("should sync task assignment via task tool to EventStore", async () => {
      const createTool = findTool(provider.getTools(), "create_task");
      const taskTool = findTool(provider.getTools(), "task");
      const getTool = findTool(provider.getTools(), "get_task");

      const created = (await createTool.handler({
        description: "Assign sync test task",
      })) as { task_id: string };

      const taskDetails = (await getTool.handler({
        task_id: created.task_id,
      })) as { external_id: string };

      // Assign via task tool (opentasks daemon path)
      await taskTool.handler({
        assign: { id: taskDetails.external_id, assignee: "agent_worker_2" },
      });

      // Verify EventStore was synced
      const afterAssign = (await getTool.handler({
        task_id: created.task_id,
      })) as { assigned_agent: string };
      expect(afterAssign.assigned_agent).toBe("agent_worker_2");
    });

    it("should query ready tasks", async () => {
      const createTool = findTool(provider.getTools(), "create_task");
      const taskTool = findTool(provider.getTools(), "task");

      // Create a fresh task (should be ready since no blockers)
      await createTool.handler({ description: "Ready test task" });

      const readyResult = (await taskTool.handler({
        ready: {},
      })) as { type?: string; items?: unknown[] };

      expect(readyResult).toBeDefined();
    });

    it("should get valid actions for a task", async () => {
      const createTool = findTool(provider.getTools(), "create_task");
      const taskTool = findTool(provider.getTools(), "task");
      const getTool = findTool(provider.getTools(), "get_task");

      const created = (await createTool.handler({
        description: "Valid actions test",
      })) as { task_id: string };

      const taskDetails = (await getTool.handler({
        task_id: created.task_id,
      })) as { external_id?: string };

      const result = await taskTool.handler({
        validActions: { id: taskDetails.external_id! },
      });

      expect(result).toBeDefined();
    });
  });

  describe("link tool", () => {
    it("should create and remove edges between tasks", async () => {
      const createTool = findTool(provider.getTools(), "create_task");
      const linkTool = findTool(provider.getTools(), "link");
      const getTool = findTool(provider.getTools(), "get_task");

      // Create two tasks
      const blocker = (await createTool.handler({
        description: "Blocker task",
      })) as { task_id: string };
      const blocked = (await createTool.handler({
        description: "Blocked task",
      })) as { task_id: string };

      // Get external IDs
      const blockerDetails = (await getTool.handler({
        task_id: blocker.task_id,
      })) as { external_id: string };
      const blockedDetails = (await getTool.handler({
        task_id: blocked.task_id,
      })) as { external_id: string };

      // Create a "blocks" edge
      const createResult = (await linkTool.handler({
        from_id: blockerDetails.external_id,
        to_id: blockedDetails.external_id,
        type: "blocks",
      })) as { created: boolean };

      expect(createResult.created).toBe(true);

      // Remove the edge
      const removeResult = (await linkTool.handler({
        from_id: blockerDetails.external_id,
        to_id: blockedDetails.external_id,
        type: "blocks",
        remove: true,
      })) as { removed: boolean };

      expect(removeResult.removed).toBe(true);
    });
  });

  describe("annotate tool", () => {
    it("should create feedback on a task", async () => {
      const createTool = findTool(provider.getTools(), "create_task");
      const annotateTool = findTool(provider.getTools(), "annotate");
      const getTool = findTool(provider.getTools(), "get_task");

      // Create a task
      const created = (await createTool.handler({
        description: "Feedback target task",
      })) as { task_id: string };

      const details = (await getTool.handler({
        task_id: created.task_id,
      })) as { external_id: string };

      // Add a comment
      const annotateResult = (await annotateTool.handler({
        target_id: details.external_id,
        content: "E2E test feedback comment",
        feedback_type: "comment",
      })) as { feedback_id: string; created: boolean; type: string };

      expect(annotateResult.created).toBe(true);
      expect(annotateResult.type).toBe("comment");
      expect(annotateResult.feedback_id).toBeDefined();
    });

    it("should resolve feedback", async () => {
      const createTool = findTool(provider.getTools(), "create_task");
      const annotateTool = findTool(provider.getTools(), "annotate");
      const getTool = findTool(provider.getTools(), "get_task");

      const created = (await createTool.handler({
        description: "Resolve feedback target",
      })) as { task_id: string };

      const details = (await getTool.handler({
        task_id: created.task_id,
      })) as { external_id: string };

      // Create feedback
      const feedback = (await annotateTool.handler({
        target_id: details.external_id,
        content: "Feedback to resolve",
        feedback_type: "suggestion",
      })) as { feedback_id: string };

      // Resolve it
      const resolveResult = (await annotateTool.handler({
        target_id: details.external_id,
        resolve: feedback.feedback_id,
      })) as { resolved: boolean; feedback_id: string };

      expect(resolveResult.resolved).toBe(true);
      expect(resolveResult.feedback_id).toBe(feedback.feedback_id);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Full Workflow
  // ─────────────────────────────────────────────────────────────────────────────

  describe("full workflow", () => {
    it("should execute a complete task lifecycle: create → assign → link → annotate → transition", async () => {
      const tools = provider.getTools();
      const createTool = findTool(tools, "create_task");
      const getTool = findTool(tools, "get_task");
      const assignTool = findTool(tools, "assign_task");
      const linkTool = findTool(tools, "link");
      const annotateTool = findTool(tools, "annotate");
      const taskTool = findTool(tools, "task");

      // 1. Create parent and child tasks
      const parent = (await createTool.handler({
        description: "Full workflow parent task",
      })) as { task_id: string };

      const child = (await createTool.handler({
        description: "Full workflow child task",
        parent_task: parent.task_id,
      })) as { task_id: string };

      // 2. Get external IDs
      const parentDetails = (await getTool.handler({
        task_id: parent.task_id,
      })) as { external_id: string };

      const childDetails = (await getTool.handler({
        task_id: child.task_id,
      })) as { external_id: string };

      expect(parentDetails.external_id).toBeDefined();
      expect(childDetails.external_id).toBeDefined();

      // 3. Create a "blocks" link: parent blocks child
      const linkResult = (await linkTool.handler({
        from_id: parentDetails.external_id,
        to_id: childDetails.external_id,
        type: "blocks",
      })) as { created: boolean };

      expect(linkResult.created).toBe(true);

      // 4. Assign parent task
      const assignResult = (await assignTool.handler({
        task_id: parent.task_id,
        agent_id: TEST_AGENT_ID,
      })) as { assigned: boolean };

      expect(assignResult.assigned).toBe(true);

      // 5. Add feedback on the parent
      const feedbackResult = (await annotateTool.handler({
        target_id: parentDetails.external_id,
        content: "Starting work on this task",
        feedback_type: "comment",
      })) as { created: boolean; feedback_id: string };

      expect(feedbackResult.created).toBe(true);

      // 6. Start parent via task tool
      const startResult = (await taskTool.handler({
        transition: { id: parentDetails.external_id, action: "start" },
      })) as { success: boolean };

      expect(startResult).toBeDefined();

      // 7. Complete parent via task tool
      const completeResult = (await taskTool.handler({
        transition: { id: parentDetails.external_id, action: "complete" },
      })) as { success: boolean };

      expect(completeResult).toBeDefined();

      // 8. Verify parent is completed in EventStore (syncExternalTransition)
      const finalParent = (await getTool.handler({
        task_id: parent.task_id,
      })) as { status: string; external_id: string; assigned_agent: string };

      expect(finalParent).toBeDefined();
      expect(finalParent.external_id).toBe(parentDetails.external_id);
      expect(finalParent.status).toBe("completed");
      expect(finalParent.assigned_agent).toBe(TEST_AGENT_ID);
    });
  });
});
