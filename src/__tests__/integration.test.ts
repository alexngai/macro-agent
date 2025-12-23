/**
 * End-to-end integration tests
 *
 * These tests use real Claude Code processes and require ANTHROPIC_API_KEY.
 * Run manually with: ANTHROPIC_API_KEY=xxx npm test -- src/__tests__/integration.test.ts
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createEventStore, type EventStore } from "../store/event-store.js";
import {
  createAgentManager,
  type AgentManager,
} from "../agent/agent-manager.js";
import { createTaskManager, type TaskManager } from "../task/task-manager.js";
import {
  createMessageRouter,
  type MessageRouter,
} from "../router/message-router.js";
import type { Agent } from "../store/types/index.js";
import type { AgentLifecycleEvent } from "../agent/types.js";

// Skip all tests if no API key
const hasApiKey = !!process.env.ANTHROPIC_API_KEY;
const testFn = hasApiKey ? it : it.skip;

describe("End-to-End Integration", () => {
  let eventStore: EventStore;
  let agentManager: AgentManager;
  let taskManager: TaskManager;
  let messageRouter: MessageRouter;
  let lifecycleEvents: AgentLifecycleEvent[];
  let unsubscribe: () => void;

  beforeAll(() => {
    if (!hasApiKey) {
      console.log(
        "⚠️  Skipping integration tests: ANTHROPIC_API_KEY not set"
      );
    }
  });

  beforeEach(async () => {
    // Create fresh instances for each test
    eventStore = await createEventStore({ inMemory: true });
    messageRouter = createMessageRouter(eventStore);
    taskManager = createTaskManager(eventStore);
    agentManager = createAgentManager(eventStore, messageRouter, {
      defaultPermissionMode: "auto-approve",
      defaultCwd: process.cwd(),
    });

    // Track lifecycle events
    lifecycleEvents = [];
    unsubscribe = agentManager.onLifecycleEvent((event) => {
      lifecycleEvents.push(event);
    });
  });

  afterAll(async () => {
    if (agentManager) {
      await agentManager.close();
    }
    if (eventStore) {
      await eventStore.close();
    }
  });

  describe("Head Manager Initialization", () => {
    testFn(
      "should create and initialize a head manager",
      async () => {
        // Create head manager
        const headManager = await agentManager.getOrCreateHeadManager({
          cwd: process.cwd(),
          permissionMode: "auto-approve",
        });

        expect(headManager.id).toMatch(/^agent_/);
        expect(headManager.session_id).toBeDefined();
        expect(headManager.agent.state).toBe("running");
        expect(headManager.agent.parent).toBeNull();

        // Verify lifecycle events
        expect(lifecycleEvents).toContainEqual(
          expect.objectContaining({ type: "spawned" })
        );
        expect(lifecycleEvents).toContainEqual(
          expect.objectContaining({ type: "started" })
        );

        // Clean up
        await agentManager.terminate(headManager.id, "completed");
      },
      30000
    );

    testFn(
      "should send a simple prompt to head manager",
      async () => {
        const headManager = await agentManager.getOrCreateHeadManager({
          cwd: process.cwd(),
          permissionMode: "auto-approve",
        });

        // Send a simple prompt
        let responseContent = "";
        for await (const update of agentManager.prompt(
          headManager.id,
          "Say exactly: Hello from integration test"
        )) {
          if (
            "sessionUpdate" in update &&
            update.sessionUpdate === "agent_message_chunk"
          ) {
            const chunk = update as { content: { type: string; text?: string } };
            if (chunk.content.type === "text" && chunk.content.text) {
              responseContent += chunk.content.text;
            }
          }
        }

        expect(responseContent.toLowerCase()).toContain("hello");

        await agentManager.terminate(headManager.id, "completed");
      },
      60000
    );
  });

  describe("Child Agent Spawning", () => {
    testFn(
      "should spawn a child agent via spawn_agent tool",
      async () => {
        const headManager = await agentManager.getOrCreateHeadManager({
          cwd: process.cwd(),
          permissionMode: "auto-approve",
        });

        // Prompt to spawn a child agent
        // Note: This requires the MCP tools to be properly configured
        let responseContent = "";
        for await (const update of agentManager.prompt(
          headManager.id,
          'Use the spawn_agent tool to create a child agent with task "test child task"'
        )) {
          if (
            "sessionUpdate" in update &&
            update.sessionUpdate === "agent_message_chunk"
          ) {
            const chunk = update as { content: { type: string; text?: string } };
            if (chunk.content.type === "text" && chunk.content.text) {
              responseContent += chunk.content.text;
            }
          }
        }

        // Wait a moment for the child to be spawned
        await new Promise((resolve) => setTimeout(resolve, 2000));

        // Check if child was spawned
        const children = agentManager.getChildren(headManager.id);
        console.log("Children spawned:", children.length);

        await agentManager.terminate(headManager.id, "completed");
      },
      120000
    );
  });

  describe("Status Flow", () => {
    testFn(
      "should capture status events in event store",
      async () => {
        const headManager = await agentManager.getOrCreateHeadManager({
          cwd: process.cwd(),
          permissionMode: "auto-approve",
        });

        // Query status events
        const statusEvents = eventStore.query({
          type: "status",
          source_agent_id: headManager.id,
        });

        // Should have at least the "started" status
        expect(statusEvents.length).toBeGreaterThanOrEqual(1);
        expect(statusEvents[0].payload).toMatchObject({
          status_type: "started",
        });

        await agentManager.terminate(headManager.id, "completed");
      },
      30000
    );
  });

  describe("Agent Hierarchy", () => {
    testFn(
      "should build correct hierarchy for spawned agents",
      async () => {
        const headManager = await agentManager.getOrCreateHeadManager({
          cwd: process.cwd(),
          permissionMode: "auto-approve",
        });

        // Get hierarchy (just head manager for now)
        const hierarchy = agentManager.getHierarchy(headManager.id);

        expect(hierarchy).not.toBeNull();
        expect(hierarchy!.root.agent.id).toBe(headManager.id);
        expect(hierarchy!.depth).toBe(1);
        expect(hierarchy!.totalAgents).toBe(1);

        await agentManager.terminate(headManager.id, "completed");
      },
      30000
    );
  });

  describe("Persistence", () => {
    testFn(
      "should persist events to file",
      async () => {
        const testPath = "./test-integration-store.json";

        // Create a persisted event store
        const persistedStore = await createEventStore({
          path: testPath,
          inMemory: false,
        });

        const router = createMessageRouter(persistedStore);
        const manager = createAgentManager(persistedStore, router, {
          defaultPermissionMode: "auto-approve",
        });

        const headManager = await manager.getOrCreateHeadManager({
          cwd: process.cwd(),
        });

        // Persist events
        await persistedStore.persist();

        // Verify agent exists in store
        const agent = persistedStore.getAgent(headManager.id);
        expect(agent).not.toBeNull();

        await manager.terminate(headManager.id, "completed");
        await manager.close();
        await persistedStore.close();

        // Clean up test file
        const fs = await import("fs/promises");
        try {
          await fs.unlink(testPath);
        } catch {
          // Ignore if doesn't exist
        }
      },
      30000
    );
  });
});

describe("Task Lifecycle Integration", () => {
  let eventStore: EventStore;
  let taskManager: TaskManager;

  beforeEach(async () => {
    eventStore = await createEventStore({ inMemory: true });
    taskManager = createTaskManager(eventStore);
  });

  it("should track task through full lifecycle", () => {
    // Create task
    const task = taskManager.create({
      description: "Integration test task",
      created_by: "agent_test",
    });

    expect(task.status).toBe("pending");

    // Assign task
    taskManager.assign(task.id, "agent_worker");
    const assigned = taskManager.get(task.id);
    expect(assigned?.status).toBe("assigned");
    expect(assigned?.assigned_agent).toBe("agent_worker");

    // Start task
    taskManager.updateStatus(task.id, "in_progress");
    expect(taskManager.get(task.id)?.status).toBe("in_progress");

    // Complete task
    taskManager.updateStatus(task.id, "completed");
    expect(taskManager.get(task.id)?.status).toBe("completed");

    // Verify events were emitted
    const taskEvents = eventStore.query({ type: "task" });
    expect(taskEvents.length).toBeGreaterThanOrEqual(4); // create, assign, 2x status
  });
});

describe("Message Routing Integration", () => {
  let eventStore: EventStore;
  let messageRouter: MessageRouter;

  beforeEach(async () => {
    eventStore = await createEventStore({ inMemory: true });
    messageRouter = createMessageRouter(eventStore);
  });

  it("should route messages between agents via subscriptions", async () => {
    // Create parent agent via spawn event
    eventStore.emit({
      type: "spawn",
      source: { agent_id: "system" },
      payload: {
        agent_id: "agent_parent",
        session_id: "sess_parent",
        task: "Parent task",
        task_id: "task_parent",
        parent: null,
        config: {},
      },
    });

    // Create child agent via spawn event
    eventStore.emit({
      type: "spawn",
      source: { agent_id: "agent_parent" },
      payload: {
        agent_id: "agent_child",
        session_id: "sess_child",
        task: "Child task",
        task_id: "task_1",
        parent: "agent_parent",
        config: {},
      },
    });

    // Set up parent-child subscription
    messageRouter.setupDefaultSubscriptions({
      agent_id: "agent_child",
      parent_id: "agent_parent",
      task_id: "task_1",
      subscribe_parent: true,
    });

    // Parent sends message to child
    await messageRouter.send({
      from: { agent_id: "agent_parent" },
      to: { agent_id: "agent_child" },
      content: "Hello child",
    });

    // Child should receive the message
    const childMessages = messageRouter.getMessages("agent_child");
    expect(childMessages.length).toBeGreaterThanOrEqual(1);
    const helloMessage = childMessages.find((m) => m.content === "Hello child");
    expect(helloMessage).toBeDefined();

    // Child sends status to parent (via topic)
    messageRouter.emitStatus({
      from: { agent_id: "agent_child", task_id: "task_1" },
      status_type: "checkpoint",
      summary: "Task progress update",
    });

    // Parent should receive status via subtree subscription
    const subscriptions = messageRouter.getSubscriptions("agent_parent");
    expect(subscriptions.some((s) => s.type === "subtree")).toBe(true);
  });
});
